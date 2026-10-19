import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, hasZeroCompletionWithContent, fixZeroCompletionUsage, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, trace, isDebugEnabled } from "./debugLog.js";
import { extractToolNames, fuzzyMatchToolName } from "../translator/concerns/toolCall.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// Native tool-call markup some models emit as *plain text* instead of structured
// tool_calls (e.g. `<tool_call>shell<arg_key>cmd</arg_key><arg_value>…`). A client
// agent never executes this — it just sees prose and its turn ends. Detect it so
// the dashboard shows the provider/model responsible.
const TOOL_MARKUP_RE = /<tool_call>|<\/tool_call>|<arg_key>|<arg_value>|<tool_calls>|<\/tool_calls>|<function_call>|<\/function_call>|<\|tool_call\|>|\[TOOL_CALLS\]/i;

/**
 * Build an OpenAI-style SSE chunk that exposes structured tool_calls.
 *
 * @param {Array} toolCalls - OpenAI tool_calls array
 * @param {string} messageId - Chat completion id prefix/suffix
 * @param {string} modelName - Model name to include in the chunk
 * @returns {object}
 */
export function buildOpenAIToolCallsChunk(toolCalls, messageId, modelName) {
  const id = messageId?.startsWith("chatcmpl-") ? messageId : `chatcmpl-${messageId || Date.now()}`;
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName || null,
    choices: [{
      index: 0,
      delta: { tool_calls: toolCalls },
      finish_reason: "tool_calls",
    }],
  };
}

/**
 * Emit a synthetic OpenAI tool_calls chunk. Used for native tool-call markup
 * (Kimi, Laguna tag-style, Mistral) that leaked into `content` as text instead
 * of being emitted as structured calls. Returns true when a chunk was emitted;
 * no-op when sourceFormat is not OpenAI.
 */
export function emitSyntheticToolCallsChunk(controller, toolCalls, state, modelName, sourceFormat, reqLogger) {
  if (!toolCalls || toolCalls.length === 0) return false;
  if (sourceFormat !== FORMATS.OPENAI) return false;

  const chunk = buildOpenAIToolCallsChunk(toolCalls, state?.messageId, modelName);
  const output = formatSSE(chunk, FORMATS.OPENAI);
  reqLogger?.appendConvertedChunk?.(output);
  controller.enqueue(sharedEncoder.encode(output));
  return true;
}

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

// Upper bound on the deferred response.completed wait: a chat->responses stream
// that saw finish_reason without usage must not hold the client's terminal event
// forever when the upstream stalls with no usage trailer and no [DONE].
const PENDING_COMPLETION_FLUSH_MS = 3000;

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    normalizeToolCalls = null,
    credentials = null
  } = options;

  let buffer = "";
  let usage = null;

  // Cache valid tool names from request body — used to correct malformed tool
  // names that weak models (e.g. Kimi served via kimchi) emit in the response
  // (e.g. "functionsread" instead of "read"). Computed once per stream.
  const validToolNames = body?.tools ? extractToolNames(body.tools) : null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, model,
        // Format the upstream speaks. A response translator reached directly
        // (target === its registered source) can defer its terminal event until
        // the final flush; as the second hop of a pivot it must not. Undefined
        // means "unknown" → do not defer.
        targetFormat }
    : null;
  if (state) state.sessionId = credentials?._clientSessionId || null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Completion tracking for truncation diagnostics: did the provider announce a
  // natural stop (finish_reason / terminal event), and did it produce structured
  // tool_calls (vs. leaking tool markup as text)?
  let finishSeen = false;
  let stopReason = null;
  let sawStructuredToolCalls = false;

  // Track native tool-call markup (Kimi, Laguna tag-style, Mistral) that leaks
  // into streaming content as plain text. When detected, a synthetic tool_calls
  // chunk is emitted before [DONE] so the client agent executes the tool instead
  // of silently ending its turn. Only applies when a normalizer is injected.
  const canNormalizeToolCalls = typeof normalizeToolCalls === "function";
  let leakedToolCalls = null;
  let leakedToolCallsEmitted = false;
  let recoveredToolCallCount = 0;
  // Validate recovered calls against the tools the request actually declared.
  //
  // Only the Kimi style (`functions.NAME {json}`) is ambiguous: a model writes
  // that same syntax when it merely *describes* tool calling, so its name must
  // match a declared tool (after fuzzy correction, like structured deltas) or it
  // is not a real call. Tag-style (`<tool_call>…`) and Mistral (`[TOOL_CALLS]`)
  // markup is explicit tool syntax — recovering it even when the model drifted
  // from the declared schema is strictly better than leaving the agent stalled,
  // which is the exact failure this exists to fix.
  //
  // With no tool list the parser stays permissive, matching the historical
  // Kimi-only behaviour.
  const acceptRecoveredCalls = (calls, style) => {
    if (!Array.isArray(calls) || calls.length === 0) return [];
    const hasDeclaredTools = Array.isArray(validToolNames) && validToolNames.length > 0;
    if (!hasDeclaredTools) return calls;

    const accepted = [];
    for (const call of calls) {
      const name = call?.function?.name;
      if (typeof name !== "string") continue;
      const corrected = fuzzyMatchToolName(name, validToolNames);
      const isDeclared = Boolean(corrected) && validToolNames.includes(corrected);
      if (style === "kimi" && !isDeclared) continue;
      if (isDeclared && corrected !== name) call.function.name = corrected;
      accepted.push(call);
    }
    return accepted;
  };
  const mergeLeakedToolCalls = (calls, style) => {
    const accepted = acceptRecoveredCalls(calls, style);
    if (accepted.length === 0) return accepted;
    const byId = new Map((leakedToolCalls || []).map((c) => [c.id, c]));
    for (const call of accepted) byId.set(call.id, call);
    leakedToolCalls = [...byId.values()];
    return accepted;
  };
  // Emit the recovered calls as a synthetic OpenAI tool_calls chunk (at most
  // once per stream) so the client executes the tool instead of ending its turn.
  const emitRecoveredToolCalls = (controller, calls) => {
    if (!calls || calls.length === 0) return false;
    const emitted = emitSyntheticToolCallsChunk(controller, calls, state, model, FORMATS.OPENAI, reqLogger);
    if (emitted) {
      sseEmittedCount++;
      leakedToolCallsEmitted = true;
      recoveredToolCallCount = calls.length;
    }
    return emitted;
  };

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;
  let completionFlushTimer = null;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
    if (finalized) return;
    finalized = true;

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    } else if (hasZeroCompletionWithContent(finalUsage, totalContentLength)) {
      // Provider reported completion_tokens: 0 despite real streamed content.
      finalUsage = fixZeroCompletionUsage(finalUsage, totalContentLength);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    // Lifecycle summary — the single line that tells you how a stream ended.
    trace("DONE", `${provider}/${model} | mode=${isPassthrough ? "passthrough" : "translate"} | frames=${sseEmittedCount} | contentChars=${totalContentLength} | thinkingChars=${accumulatedThinking.length} | finishSeen=${finishSeen}${stopReason ? ` (${stopReason})` : ""} | toolCalls=${sawStructuredToolCalls || recoveredToolCallCount > 0} | usage=${hasValidUsage(finalUsage) ? `${finalUsage.prompt_tokens ?? "?"}/${finalUsage.completion_tokens ?? "?"}` : "none"}`);

    if (leakedToolCallsEmitted) {
      trace("DONE", `recovered ${recoveredToolCallCount} leaked tool call(s) from native markup — emitted as structured tool_calls | ${provider}/${model}`);
    }
    if (!finishSeen && (sseEmittedCount > 0 || totalContentLength > 0)) {
      trace("DONE", `WARN truncated — upstream ended with no finish_reason/terminal after ${sseEmittedCount} frames (${totalContentLength} chars); client may hang waiting for completion`);
    }
    if (!sawStructuredToolCalls && !leakedToolCallsEmitted && accumulatedContent && TOOL_MARKUP_RE.test(accumulatedContent)) {
      const match = accumulatedContent.match(TOOL_MARKUP_RE);
      trace("DONE", `WARN tool-call markup leaked as text (${match?.[0]}) — model did not emit structured tool_calls; client will not execute it | ${provider}/${model}`);
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt);
    }
  };

  // Emit the deferred response.completed now — at [DONE], or when the watchdog
  // below gives up on a usage trailer that never arrives.
  const flushPendingCompletion = (controller) => {
    const completed = translateResponse(targetFormat, sourceFormat, null, state);
    for (const item of completed || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(item, sourceFormat);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
    }
    finalizeStream();
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        // Always count lines (cheap) so the flush summary is meaningful in production.
        if (trimmed) {
          sseLineCount++;
          if (isDebugEnabled && trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;
          let responsesTerminal = false;

          // Skip upstream [DONE] — the flush handler emits a single [DONE]
          // at stream end. Forwarding it here causes a duplicate. Do NOT set
          // streamDoneSent here: that would suppress the flush handler's own
          // [DONE] emission, leaving the client with no terminator at all.
          if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") {
            continue;
          }

          if (trimmed.startsWith("data:")) {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Fuzzy-correct malformed tool names (e.g. "functionsread" → "read")
              // that weak models emit in delta.tool_calls[].function.name.
              if (validToolNames && validToolNames.length > 0 && Array.isArray(parsed.choices)) {
                for (const choice of parsed.choices) {
                  const delta = choice?.delta;
                  if (Array.isArray(delta?.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                      if (tc.function?.name) {
                        const corrected = fuzzyMatchToolName(tc.function.name, validToolNames);
                        if (corrected !== tc.function.name) {
                          tc.function.name = corrected;
                          fieldsInjected = true;
                        }
                      }
                    }
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                  // Strip empty legacy function_call objects that cause client
                  // loops — some providers (e.g. Shiteru) send a final chunk with
                  // `function_call: {name: "", arguments: ""}` alongside
                  // finish_reason: "stop". Clients interpret any function_call
                  // presence as a pending tool invocation and wait for arguments
                  // that never arrive, causing an infinite loop.
                  if (choice.delta?.function_call) {
                    const fc = choice.delta.function_call;
                    if ((!fc.name || fc.name === "") && (!fc.arguments || fc.arguments === "")) {
                      delete choice.delta.function_call;
                      fieldsInjected = true;
                    }
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              // `reasoning_content` is the OpenAI-standard field; `reasoning` is
              // what OpenRouter and several free providers emit. Both must be
              // counted (and passed through) or such turns look empty.
              const reasoning = delta?.reasoning_content || delta?.reasoning;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }
              // Repair native tool-call markup (Kimi, Laguna tag-style, Mistral)
              // that leaks into `content` instead of a structured tool_calls
              // array. Raw markup becomes leading prose only; the recovered calls
              // are emitted as a synthetic tool_calls chunk at finish/flush time.
              if (canNormalizeToolCalls && delta && typeof content === "string") {
                const { message: normalized, hasTools, style } = normalizeToolCalls({
                  role: "assistant",
                  content,
                });
                // Strip the markup only when a call is actually recovered — if
                // nothing is accepted, keep the text so no output is destroyed.
                if (hasTools && mergeLeakedToolCalls(normalized.tool_calls, style).length > 0) {
                  const kept = normalized.content || "";
                  totalContentLength -= content.length - kept.length;
                  accumulatedContent = accumulatedContent.slice(0, accumulatedContent.length - content.length) + kept;
                  if (kept) delta.content = kept;
                  else delete delta.content;
                  fieldsInjected = true; // force re-serialization with stripped content
                }
              }
              // If markup was recovered and this chunk carries finish_reason, the
              // upstream "stop" would tell the client the turn ended as plain
              // text before the tool call arrives — some clients finalize on the
              // first finish_reason and then drop the recovered call. Emit the
              // synthetic tool_calls chunk instead, forwarding the upstream chunk
              // only when it also carries usage (which must not be lost).
              //
              // Markup often arrives split across many tiny frames (the observed
              // production case: 173 chars over 96 chunks), so per-chunk parsing
              // never sees a complete block. Re-parse the accumulated content here
              // to recover it before the client sees the finish.
              if (!leakedToolCallsEmitted && parsed.choices?.some((choice) => choice?.finish_reason)) {
                let calls = leakedToolCalls;
                if ((!calls || calls.length === 0) && canNormalizeToolCalls && accumulatedContent) {
                  const { hasTools, message: normalized, style } = normalizeToolCalls({
                    role: "assistant",
                    content: accumulatedContent,
                  });
                  if (hasTools) calls = acceptRecoveredCalls(normalized.tool_calls, style);
                }
                if (calls && calls.length > 0) {
                  emitRecoveredToolCalls(controller, calls);
                  if (!parsed.usage) continue;
                  for (const choice of parsed.choices) choice.finish_reason = "tool_calls";
                  fieldsInjected = true;
                }
              }
              // Tool-call-only responses (e.g. agentic coding tools with large
              // tool arrays) produce real output entirely via delta.tool_calls,
              // with content/reasoning empty. Count function name + streamed
              // argument chunk length so totalContentLength isn't stuck at 0
              // and the zero-completion / estimation fallbacks below can fire.
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  if (typeof tc?.function?.name === "string") totalContentLength += tc.function.name.length;
                  if (typeof tc?.function?.arguments === "string") totalContentLength += tc.function.arguments.length;
                }
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);
              if (responsesTerminal) { finishSeen = true; stopReason = stopReason || (currentOpenAIResponsesEvent || "responses-terminal"); }
              if (Array.isArray(parsed.choices)) {
                for (const c of parsed.choices) {
                  if (Array.isArray(c?.delta?.tool_calls) && c.delta.tool_calls.length > 0) sawStructuredToolCalls = true;
                }
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk) { finishSeen = true; stopReason = String(isFinishChunk); }
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && hasZeroCompletionWithContent(parsed.usage, totalContentLength)) {
                // Provider reported completion_tokens: 0 (e.g. Shiteru "estimated"
                // finish chunk on a large prompt) despite real streamed content.
                // Keep the provider's prompt_tokens, patch only the output side.
                const fixed = fixZeroCompletionUsage(parsed.usage, totalContentLength);
                parsed.usage = filterUsageForFormat(fixed, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = fixed;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          sseEmittedCount++;
          // Responses clients (codex CLI) close on response.completed instead of [DONE]
          if (responsesTerminal) finalizeStream();
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // Natural-completion + structured-tool-call tracking (diagnostics only).
        if (parsed.choices?.[0]?.finish_reason) { finishSeen = true; stopReason = String(parsed.choices[0].finish_reason); }
        else if (parsed.delta?.stop_reason) { finishSeen = true; stopReason = String(parsed.delta.stop_reason); }
        else if (parsed.candidates?.[0]?.finishReason) { finishSeen = true; stopReason = String(parsed.candidates[0].finishReason); }
        else if (parsed.done) { finishSeen = true; stopReason = stopReason || "done"; }
        if (openAIResponsesTerminalSeen) { finishSeen = true; stopReason = stopReason || "responses-terminal"; }
        if (Array.isArray(parsed.choices)) {
          for (const c of parsed.choices) {
            if (Array.isArray(c?.delta?.tool_calls) && c.delta.tool_calls.length > 0) sawStructuredToolCalls = true;
          }
        }
        if (parsed.content_block?.type === "tool_use" || parsed.delta?.type === "input_json_delta") sawStructuredToolCalls = true;
        if (Array.isArray(parsed.content)) {
          for (const blk of parsed.content) if (blk?.type === "tool_use") sawStructuredToolCalls = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // A direct Chat-to-Responses translation can defer response.completed
          // while waiting for a usage trailer. [DONE] ends that opportunity even
          // if the upstream keeps the HTTP connection open, so finish now.
          if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
              state.completionPending && !state.completedSent) {
            flushPendingCompletion(controller);
          }

          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        // Claude format - tool_use input streamed as partial_json deltas.
        // Tool-call-only turns would otherwise leave totalContentLength at 0.
        if (typeof parsed.delta?.partial_json === "string") {
          totalContentLength += parsed.delta.partial_json.length;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - tool calls (name + streamed argument chunks). Without
        // this, tool-call-only turns leave totalContentLength at 0 and the
        // zero-completion/estimation usage fallbacks never fire.
        if (Array.isArray(parsed.choices?.[0]?.delta?.tool_calls)) {
          for (const tc of parsed.choices[0].delta.tool_calls) {
            if (typeof tc?.function?.name === "string") totalContentLength += tc.function.name.length;
            if (typeof tc?.function?.arguments === "string") totalContentLength += tc.function.arguments.length;
          }
        }

        // Detect and repair native tool-call markup that leaks into the content
        // stream instead of being emitted as structured tool_calls (Kimi,
        // Laguna tag-style, Mistral, …). Raw markup is replaced by any leading
        // prose so the client never sees the native token soup.
        if (canNormalizeToolCalls && parsed.choices?.[0]?.delta?.content) {
          const originalDelta = parsed.choices[0].delta.content;
          const { message: normalized, hasTools, style } = normalizeToolCalls({
            role: "assistant",
            content: originalDelta,
          });
          // Strip the markup only when a call is actually recovered — if nothing
          // is accepted, keep the text so no output is destroyed.
          if (hasTools && mergeLeakedToolCalls(normalized.tool_calls, style).length > 0) {
            parsed.choices[0].delta.content = normalized.content || undefined;
            if (!parsed.choices[0].delta.content) {
              delete parsed.choices[0].delta.content;
            }
            // Adjust accumulated content to reflect the stripped markup.
            totalContentLength -= originalDelta.length;
            accumulatedContent = accumulatedContent.slice(0, accumulatedContent.length - originalDelta.length);
            if (normalized.content) {
              totalContentLength += normalized.content.length;
              accumulatedContent += normalized.content;
            }
          }
        }
        // OpenAI format - reasoning (reasoning_content is the OpenAI-standard
        // field; `reasoning` is what OpenRouter and several free providers emit).
        const reasoningDelta = parsed.choices?.[0]?.delta?.reasoning_content || parsed.choices?.[0]?.delta?.reasoning;
        if (reasoningDelta) {
          totalContentLength += reasoningDelta.length;
          accumulatedThinking += reasoningDelta;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          // Responses clients (codex) close on response.completed instead of [DONE]
          if (openAIResponsesTerminalSeen) finalizeStream();
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;

            // Diagnostics: did the translated output actually carry structured tool calls?
            if (Array.isArray(item.choices)) {
              for (const c of item.choices) {
                if (Array.isArray(c?.delta?.tool_calls) && c.delta.tool_calls.length > 0) sawStructuredToolCalls = true;
                if (Array.isArray(c?.message?.tool_calls) && c.message.tool_calls.length > 0) sawStructuredToolCalls = true;
                if (Array.isArray(c?.delta?.content)) {
                  for (const blk of c.delta.content) if (blk?.type === "tool_use" || blk?.type === "tool_call") sawStructuredToolCalls = true;
                }
              }
            }
            if (item.content_block?.type === "tool_use") sawStructuredToolCalls = true;
            if (item.delta?.stop_reason && !finishSeen) { finishSeen = true; stopReason = String(item.delta.stop_reason); }

            // If native tool calls were detected in this chunk stream and
            // this is the finish chunk, replace it with a structured tool_calls
            // chunk so the client sees the correct finish_reason.
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (leakedToolCalls && isFinishChunk && sourceFormat === FORMATS.OPENAI) {
              emitRecoveredToolCalls(controller, leakedToolCalls);
              continue;
            }

            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && hasZeroCompletionWithContent(item.usage, totalContentLength)) {
              // Provider reported zero completion tokens despite real streamed
              // content (e.g. Shiteru-style "estimated" usage on large prompts).
              // Patch just the output side, keep the provider's prompt_tokens.
              const fixed = fixZeroCompletionUsage(item.usage, totalContentLength);
              item.usage = filterUsageForFormat(fixed, sourceFormat);
              state.usage = fixed;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }

        // The completion deferral can outlive the upstream: a broken chat upstream
        // may stall after finish_reason with no usage trailer and no [DONE], holding
        // the connection open. Bound the wait so the client still gets a terminal event.
        if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
            state?.completionPending && !state?.completedSent && !completionFlushTimer) {
          completionFlushTimer = setTimeout(() => {
            completionFlushTimer = null;
            if (state?.completedSent) return;
            try { flushPendingCompletion(controller); } catch { /* controller already closed */ }
          }, PENDING_COMPLETION_FLUSH_MS);
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      trace("SSE", `flush | provider=${provider} | model=${model} | mode=${mode} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | contentChars=${totalContentLength} | finishSeen=${finishSeen} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }

          // Gemini-family clients (Antigravity, Vertex, Gemini) reject the
          // OpenAI [DONE] sentinel with 400 syntax errors — and their chunks are
          // not OpenAI-shaped, so markup recovery below does not apply to them.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";

          // Emit recovered native tool calls (Kimi / Laguna tag-style / Mistral
          // markup that leaked into `content`) before terminating the stream, so
          // the client agent executes the tool instead of ending its turn.
          if (!leakedToolCallsEmitted && !isGeminiFamily) {
            let calls = leakedToolCalls;
            if ((!calls || calls.length === 0) && canNormalizeToolCalls && accumulatedContent) {
              const { hasTools, message: normalized, style } = normalizeToolCalls({ role: "assistant", content: accumulatedContent });
              if (hasTools) calls = acceptRecoveredCalls(normalized.tool_calls, style);
            }
            emitRecoveredToolCalls(controller, calls);
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          finalizeStream();
          return;
        }

        if (buffer.trim()) {
          // Same parse as the transform loop: without targetFormat this only
          // accepts "data: " lines, so an NDJSON provider (Ollama) lost whatever
          // arrived without its closing newline.
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          // parseSSELine turns the SSE sentinel "data: [DONE]" into { done: true },
          // which must not be translated. An Ollama chunk also carries done:true,
          // but it is the real final chunk — it holds finish_reason and the token
          // counts — so it has to go through.
          const isDoneSentinel = parsed?.done && targetFormat !== FORMATS.OLLAMA;
          if (parsed && !isDoneSentinel) {
            // Same accumulation the transform loop does, so finalizeStream() can
            // log a tail chunk's tokens instead of falling back to null.
            const extracted = extractUsage(parsed);
            if (extracted) state.usage = mergeUsage(state.usage, extracted);

            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Fallback: if native tool-call markup leaked into the accumulated
        // content but no finish chunk triggered emission, synthesize a final
        // tool_calls chunk now. This covers fragmented markup (split across
        // chunk boundaries) and responses that never sent a finish chunk.
        if (!leakedToolCallsEmitted && canNormalizeToolCalls && sourceFormat === FORMATS.OPENAI) {
          let calls = leakedToolCalls;
          if (!calls || calls.length === 0) {
            const { hasTools, message: normalized, style } = normalizeToolCalls({
              role: "assistant",
              content: accumulatedContent,
            });
            if (hasTools) calls = acceptRecoveredCalls(normalized.tool_calls, style);
          }
          emitRecoveredToolCalls(controller, calls);
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          trace("SSE", `WARN Responses stream ended without terminal event — synthesizing response.failed | ${provider}/${model}`);
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        finalizeStream();
      } catch (error) {
        console.log("Error in flush:", error);
        finalizeStream();
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, normalizeToolCalls = null, credentials = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    normalizeToolCalls,
    credentials
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, normalizeToolCalls = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    normalizeToolCalls
  });
}
