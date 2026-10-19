/**
 * Native tool-call markup parser (generalized).
 *
 * Weak / free models frequently fail to populate the structured `tool_calls`
 * array and instead leak their native tool-call syntax into the assistant
 * `content` as plain text. A client agent then sees prose, finds no tool to
 * execute and silently ends its turn — the "process stopped mid-way" symptom.
 *
 * Recognised shapes:
 *
 *  1) Tag style (Laguna and several OpenAI-compatible free models):
 *       <tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value>…</tool_call>
 *     Multiple blocks and a missing closing tag (truncated stream) are tolerated.
 *
 *  2) Kimi native style (served through Kimchi / Cast AI):
 *       functions.NAME:ID {"k":"v"}functions.NAME2:ID2 {"k":"v"}
 *     Delegated to kimiToolParser.js so its behaviour stays byte-identical.
 *
 *  3) Mistral style:
 *       [TOOL_CALLS] [{"name":"NAME","arguments":{…}}]
 *
 * The parser is intentionally conservative: it only returns calls when the
 * markup is recognised, never throws for malformed input, and preserves the
 * original content.
 */

import {
  parseKimiToolCalls,
  splitKimiToolRegion,
  hasKimiToolMarkup,
} from "./kimiToolParser.js";

// Recursion / iteration guard for malformed payloads.
const MAX_CALLS = 64;

const TAG_OPEN = "<tool_call>";
const TAG_OPEN_RE = /<tool_call>/i;
const TAG_CLOSE_RE = /<\/tool_call>/i;
const ARG_PAIR_RE = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
const MISTRAL_MARKER_RE = /\[TOOL_CALLS\]/i;
// Fast pre-check for the markers TOOL_MARKUP_RE (stream.js) already knows about.
const MARKUP_RE = /<tool_call>|<\/tool_call>|<arg_key>|<arg_value>|<tool_calls>|<\/tool_calls>|<function_call>|<\/function_call>|<\|tool_call\|>|\[TOOL_CALLS\]|functions\./i;

// Bare tag words that can leak into a `<tool_call>` header (e.g. `</think>shell`
// or `<tool_calls>shell`). They are never a real tool name, so they are skipped
// when locating the name.
const MARKUP_WORDS = new Set([
  "think", "thinking", "reasoning",
  "tool", "tools", "tool_call", "tool_calls",
  "function", "functions", "function_call", "function_calls",
  "invoke", "parameter", "antml",
]);

/**
 * Cheap gate: does this string contain any known native tool-call marker?
 * @param {string|null|undefined} content
 * @returns {boolean}
 */
export function hasNativeToolMarkup(content) {
  return typeof content === "string" && content.length > 0 && MARKUP_RE.test(content);
}

/**
 * Parse one `<tool_call>…` block body into { name, arguments }.
 * Returns null when no tool name can be recovered.
 */
function parseTagBlock(body) {
  if (typeof body !== "string") return null;

  const argStart = body.search(/<arg_key>/i);
  const header = (argStart === -1 ? body : body.slice(0, argStart)).trim();
  // The tool name is the first identifier-ish token after discarding leaked
  // markup words. Some models emit a stray `</think>` (or `<tool_calls>`/
  // `<function_call>`) immediately before the name, which would otherwise be
  // read as the name itself — and a wrong name is worse than no recovery.
  const tokens = header.match(/[A-Za-z0-9_][A-Za-z0-9_.\-/]*/g) || [];
  const name = tokens.find((token) => !MARKUP_WORDS.has(token.toLowerCase())) || "";
  if (!name) return null;

  const args = {};
  const are = new RegExp(ARG_PAIR_RE.source, "gi");
  let am;
  while ((am = are.exec(body)) !== null) {
    args[am[1]] = am[2];
  }

  // Truncated stream: the block was cut before `</arg_value>`. Capture the tail
  // as the value rather than emitting an empty-argument call (which would make
  // the client run the tool with no arguments at all — strictly worse).
  if (Object.keys(args).length === 0 && argStart !== -1) {
    const lenient = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*)$/i.exec(body);
    if (lenient) {
      args[lenient[1]] = lenient[2].replace(/<\/arg_value>\s*$/i, "");
    }
  }

  return { name, arguments: args };
}

/**
 * Extract `<tool_call>` tag-style calls from a content string.
 */
function extractTagToolCalls(content) {
  const calls = [];
  // Splitting on the opening tag tolerates a missing closing tag on the last
  // block (truncated stream) and multiple concatenated blocks.
  const blocks = content.split(/<tool_call>/i).slice(1);
  for (const raw of blocks) {
    if (calls.length >= MAX_CALLS) break;
    const body = raw.split(TAG_CLOSE_RE)[0];
    const parsed = parseTagBlock(body);
    if (!parsed) continue;
    calls.push({
      id: `call_${parsed.name}_${calls.length}`,
      type: "function",
      function: {
        name: parsed.name,
        arguments: JSON.stringify(parsed.arguments),
      },
    });
  }
  return calls;
}

/**
 * Extract `[TOOL_CALLS] [{name, arguments}]` (Mistral style) calls.
 */
function extractMistralToolCalls(content) {
  const marker = content.search(MISTRAL_MARKER_RE);
  if (marker === -1) return [];

  const tail = content.slice(marker).replace(MISTRAL_MARKER_RE, "").trim();
  if (!tail.startsWith("[")) return [];

  let payload;
  try {
    payload = JSON.parse(tail);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const calls = [];
  for (const item of payload) {
    if (calls.length >= MAX_CALLS) break;
    const name = item?.name || item?.function?.name;
    if (!name) continue;
    const rawArgs = item?.arguments ?? item?.function?.arguments ?? {};
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
    calls.push({
      id: item?.id || `call_${name}_${calls.length}`,
      type: "function",
      function: { name, arguments: args },
    });
  }
  return calls;
}

/**
 * Extract every recognised native tool call from an assistant content string.
 * Returns [] when nothing is recognised or parsing fails.
 *
 * @param {string|null|undefined} content
 * @returns {Array<{id: string, type: string, function: {name: string, arguments: string}}>}
 */
export function extractNativeToolCalls(content) {
  return extractNativeToolCallsDetailed(content).calls;
}

/**
 * Extract native tool calls together with the markup style that produced them.
 *
 * The style matters downstream: `<tool_call>…` / `[TOOL_CALLS]` are explicit tool
 * syntax (no legitimate prose looks like that), while Kimi's
 * `functions.NAME {json}` is also what a model writes when merely *describing*
 * the syntax. Callers may therefore validate the name only for "kimi".
 *
 * @param {string|null|undefined} content
 * @returns {{calls: Array, style: "tag"|"kimi"|"mistral"|null}}
 */
function extractNativeToolCallsDetailed(content) {
  if (!hasNativeToolMarkup(content)) return { calls: [], style: null };

  const tagCalls = extractTagToolCalls(content);
  if (tagCalls.length > 0) return { calls: tagCalls, style: "tag" };

  if (hasKimiToolMarkup(content)) {
    const kimi = parseKimiToolCalls(content);
    if (kimi && kimi.length > 0) return { calls: kimi, style: "kimi" };
  }

  const mistral = extractMistralToolCalls(content);
  return { calls: mistral, style: mistral.length > 0 ? "mistral" : null };
}

/**
 * Index of the first native tool-call marker in `content` (or -1).
 */
function firstMarkupIndex(content) {
  const indices = [
    content.search(TAG_OPEN_RE),
    content.search(MISTRAL_MARKER_RE),
    hasKimiToolMarkup(content) ? content.indexOf("functions.") : -1,
  ].filter((i) => i >= 0);
  return indices.length > 0 ? Math.min(...indices) : -1;
}

/**
 * Normalize an assistant message that may contain leaked native tool markup.
 *
 * When markup is found the leading prose is kept as `content` and a structured
 * `tool_calls` array is attached, so the client agent can execute the tool.
 *
 * @param {{role?: string, content?: string, tool_calls?: array|null}} message
 * @returns {{message: object, hasTools: boolean, originalContent: string, style: string|null}}
 */
export function normalizeNativeToolCalls(message) {
  const originalContent = typeof message?.content === "string" ? message.content : "";

  // Respect already-structured tool_calls.
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return { message: { ...message }, hasTools: true, originalContent, style: "structured" };
  }

  const { calls, style } = extractNativeToolCallsDetailed(originalContent);
  if (calls.length === 0) {
    return { message: { ...message }, hasTools: false, originalContent, style: null };
  }

  const cut = firstMarkupIndex(originalContent);
  let prose;
  if (cut === -1) {
    prose = originalContent.trim();
  } else if (cut === originalContent.indexOf("functions.")) {
    // Kimi style: reuse its own splitter so content trimming stays byte-identical
    // to the Kimi-only behaviour this module generalizes.
    prose = splitKimiToolRegion(originalContent).prefix;
  } else {
    prose = originalContent.slice(0, cut).trim();
  }

  return {
    message: { ...message, content: prose, tool_calls: calls },
    hasTools: true,
    originalContent,
    style,
  };
}
