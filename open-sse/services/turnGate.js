/**
 * Unusable-turn gate.
 *
 * A provider can answer HTTP 200 and stream a response that carries no usable
 * assistant output: empty deltas, or tool markup that could not be recovered.
 * The client agent then receives an empty turn and silently stops mid-way — the
 * "process stopped mid-way" symptom.
 *
 * The combo handler still owns the Response object at that point (nothing has
 * been written to the client yet), so it can peek the body and fall through to
 * the next model instead of committing an unusable turn.
 *
 * How it decides:
 *   - A turn is usable once a frame carries assistant content, a structured
 *     tool call or an unrecognised body shape.
 *   - Reasoning/thinking frames are held (not usable on their own: an agent
 *     cannot act on thinking that never turns into a tool call). They are
 *     released in order the moment the turn commits, so frames are never
 *     reordered.
 *   - SSE comment frames (`: keep-alive`) are forwarded immediately — comments
 *     are inert to an SSE parser, so this cannot reorder anything. While frames
 *     are held, the gate emits its own keep-alive every
 *     TURN_GATE_HEARTBEAT_MS so the client link never looks idle (Nginx
 *     proxy_read_timeout is 60s by default, Cloudflare edges cut at ~100s).
 *   - Everything else is held until a usable frame appears, the body ends, or a
 *     cap is hit.
 *
 * The gate never throws and never loses bytes: whatever it held is replayed on
 * the returned Response, so a rejected turn can still be returned as a last
 * resort.
 */

import { TURN_GATE_MAX_BYTES, TURN_GATE_MAX_WAIT_MS, TURN_GATE_HEARTBEAT_MS } from "../config/runtimeConfig.js";

const encoder = new TextEncoder();

const KEEPALIVE = ": keep-alive\n\n";

const VERDICT = {
  USABLE: "usable",
  PASS: "pass",     // forward immediately (inert frame only), not usable on its own
  HOLD: "hold",     // buffer until the verdict is known
};

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Classify a parsed response object into a turn verdict.
 * @returns {"usable"|"pass"|"hold"}
 */
function classifyObject(parsed) {
  if (!parsed || typeof parsed !== "object") return VERDICT.HOLD;

  // OpenAI chat completions (the dominant client format).
  if (Array.isArray(parsed.choices)) {
    for (const choice of parsed.choices) {
      const delta = choice?.delta;
      if (delta) {
        if (hasText(delta.content)) return VERDICT.USABLE;
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return VERDICT.USABLE;
        if (delta.function_call && (hasText(delta.function_call.name) || hasText(delta.function_call.arguments))) {
          return VERDICT.USABLE;
        }
      }
      const message = choice?.message;
      if (message) {
        if (hasText(message.content)) return VERDICT.USABLE;
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return VERDICT.USABLE;
      }
    }
    return VERDICT.HOLD;
  }

  // Anthropic / Claude messages.
  if (typeof parsed.type === "string") {
    if (parsed.type === "content_block_delta") {
      const delta = parsed.delta || {};
      if (hasText(delta.text) || hasText(delta.partial_json)) return VERDICT.USABLE;
      return VERDICT.HOLD;
    }
    if (parsed.type === "content_block_start") {
      return parsed.content_block?.type === "tool_use" ? VERDICT.USABLE : VERDICT.HOLD;
    }
    // OpenAI Responses API (codex).
    if (parsed.type.startsWith("response.")) {
      if (hasText(parsed.delta) || hasText(parsed.arguments) || hasText(parsed.arguments_delta)) return VERDICT.USABLE;
      return VERDICT.HOLD;
    }
    // message_start / message_stop / ping / error / … — not usable on their own,
    // and not worth passing through before the turn is committed.
    return VERDICT.HOLD;
  }

  // Gemini.
  if (Array.isArray(parsed.candidates)) {
    for (const candidate of parsed.candidates) {
      for (const part of candidate?.content?.parts || []) {
        if (hasText(part?.text) || part?.functionCall) return VERDICT.USABLE;
      }
    }
    return VERDICT.HOLD;
  }

  // Unrecognised body: never risk discarding output we do not understand.
  return VERDICT.USABLE;
}

/**
 * Classify a single complete SSE line into a turn verdict.
 * Exported for tests — this is the decision table the whole gate rests on.
 * @returns {"usable"|"pass"|"hold"}
 */
export function classifyTurnLine(line) {
  // Non-data framing lines (event:, id:, retry:) belong with the following data
  // line, so they are held rather than passed through out of order.
  if (!line.startsWith("data:")) return VERDICT.HOLD;

  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return VERDICT.HOLD;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Unparseable payload carries no usable assistant output.
    return VERDICT.HOLD;
  }
  return classifyObject(parsed);
}

/**
 * Classify a trailing chunk that has no SSE framing (a non-streaming JSON body
 * arrives as one buffer with no newline).
 * @returns {"usable"|"pass"|"hold"}
 */
function classifyTurnBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return VERDICT.HOLD;
  if (/^(data:|event:|id:|retry:)/.test(trimmed)) return classifyTurnLine(trimmed);

  try {
    return classifyObject(JSON.parse(trimmed));
  } catch {
    return VERDICT.HOLD;
  }
}

/**
 * Gate a streaming response: decide whether it carries usable assistant output.
 *
 * @param {Response} response
 * @param {{ maxBytes?: number, maxWaitMs?: number }} [options]
 * @returns {Promise<{ usable: boolean, reason: string, response: Response }>}
 *   `response` always carries the (possibly empty) turn, ready to hand to the
 *   client, whether or not the caller decides to retry.
 */
export async function gateTurn(response, { maxBytes = TURN_GATE_MAX_BYTES, maxWaitMs = TURN_GATE_MAX_WAIT_MS, heartbeatMs = TURN_GATE_HEARTBEAT_MS } = {}) {
  const body = response?.body;
  if (!body || body.locked) return { usable: true, reason: "no-body", response };

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  let outController = null;
  const out = new ReadableStream({
    start(controller) {
      outController = controller;
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  let lastSendAt = Date.now();
  const send = (text) => {
    if (!text || !outController) return;
    try {
      outController.enqueue(encoder.encode(text));
      lastSendAt = Date.now();
    } catch {
      // Downstream already closed — nothing to do.
    }
  };

  const held = [];
  let heldBytes = 0;
  let remainder = "";
  let pendingRead = null;
  let usable = false;
  let reason = "empty-turn";
  let eof = false;
  const deadline = Date.now() + (maxWaitMs > 0 ? maxWaitMs : 0);

  // Hold-safe keep-alive: while frames are buffered the client link would
  // otherwise look idle for the whole hold. Comments are inert to an SSE parser.
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => {
        if (Date.now() - lastSendAt < heartbeatMs) return;
        send(KEEPALIVE);
      }, heartbeatMs)
    : null;
  heartbeatTimer?.unref?.();

  const nextChunk = () => (pendingRead ??= reader.read());

  try {
    while (true) {
      const timeLeft = deadline - Date.now();
      if (maxWaitMs > 0 && timeLeft <= 0) {
        usable = true;
        reason = "wait-cap";
        break;
      }

      let timer = null;
      const winner = await Promise.race([
        nextChunk().then((value) => ({ value })),
        maxWaitMs > 0
          ? new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), timeLeft); })
          : new Promise(() => {}),
      ]);
      if (timer) clearTimeout(timer);

      if (winner.timeout) {
        usable = true;
        reason = "wait-cap";
        break;
      }

      pendingRead = null;
      const { done, value } = winner.value;
      if (done) {
        eof = true;
        break;
      }

      remainder += decoder.decode(value, { stream: true });

      let newlineAt;
      while ((newlineAt = remainder.indexOf("\n")) !== -1) {
        const withTerminator = remainder.slice(0, newlineAt + 1);
        remainder = remainder.slice(newlineAt + 1);
        const line = withTerminator.replace(/\r?\n$/, "");
        // Blank lines terminate the preceding data frame — they must be kept or
        // the client's SSE parser never dispatches an event.
        if (!line) {
          held.push(withTerminator);
          heldBytes += withTerminator.length;
          continue;
        }

        if (line.startsWith(":")) {
          // Keep-alive comment: forward now, it is ignored by SSE parsers.
          send(withTerminator);
          continue;
        }

        const verdict = classifyTurnLine(line);
        if (verdict === VERDICT.USABLE) {
          // Keep the deciding frame in the replay buffer too — it must be
          // emitted in order, ahead of any bytes still sitting in `remainder`.
          held.push(withTerminator);
          heldBytes += withTerminator.length;
          usable = true;
          reason = "usable";
          break;
        }
        // Comment lines are handled above, so a PASS verdict never reaches this
        // branch today; kept so an inert-frame verdict stays correctly routed.
        if (verdict === VERDICT.PASS) {
          send(withTerminator);
          continue;
        }
        held.push(withTerminator);
        heldBytes += withTerminator.length;
      }

      // A trailing newline-less frame (e.g. a non-SSE JSON body) is classified
      // at EOF, not here.
      if (usable) break;
      if (heldBytes > maxBytes) {
        usable = true;
        reason = "byte-cap";
        break;
      }
    }
  } catch {
    // Upstream read failure: commit whatever we have rather than looping.
    usable = true;
    reason = "read-error";
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  // Final partial line (no trailing newline) — only meaningful when the verdict
  // is still open (e.g. a non-streaming JSON body).
  if (remainder) {
    const tail = remainder;
    remainder = "";
    const verdict = tail.startsWith(":") ? VERDICT.PASS : classifyTurnBody(tail);
    if (verdict === VERDICT.USABLE) {
      usable = true;
      reason = "usable";
    }
    if (verdict === VERDICT.PASS) {
      send(tail);
    } else {
      held.push(tail);
      heldBytes += tail.length;
    }
  }
  if (eof && !usable) reason = "empty-turn";

  // Commit: replay everything we held, in order, followed by any bytes we had
  // already decoded but not yet line-processed.
  send(held.join(""));
  send(remainder);
  remainder = "";

  const pumpRest = async () => {
    try {
      while (true) {
        const pending = pendingRead ?? reader.read();
        pendingRead = null;
        const { done, value } = await pending;
        if (done) break;
        if (outController && outController.desiredSize !== null && outController.desiredSize <= 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (outController) outController.enqueue(value);
      }
      outController?.close();
    } catch {
      try {
        outController?.close();
      } catch {
        // Already closed.
      }
    }
  };
  void pumpRest();

  const gated = new Response(out, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });

  return { usable, reason, response: gated };
}
