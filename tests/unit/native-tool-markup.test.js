// Tests for the generalized native tool-call markup parser.
//
// Weak / free models leak their native tool syntax into assistant `content`
// instead of populating `tool_calls`. The samples below are real payloads
// captured from the `laguna` provider (poolside/laguna-s-2.1:free) in the
// production requestDetails table.
import { describe, it, expect } from "vitest";
import {
  normalizeNativeToolCalls,
  extractNativeToolCalls,
  hasNativeToolMarkup,
} from "../../open-sse/utils/nativeToolParser.js";

describe("hasNativeToolMarkup", () => {
  it("detects tag-style markup", () => {
    expect(hasNativeToolMarkup("<tool_call>shell<arg_key>cmd</arg_key>")).toBe(true);
  });

  it("detects Kimi markup", () => {
    expect(hasNativeToolMarkup('functions.bash:0 {"command":"ls"}')).toBe(true);
  });

  it("detects Mistral markup", () => {
    expect(hasNativeToolMarkup('[TOOL_CALLS] [{"name":"bash"}]')).toBe(true);
  });

  it("is false for plain prose", () => {
    expect(hasNativeToolMarkup("Just a normal answer.")).toBe(false);
  });

  it("is false for non-strings", () => {
    expect(hasNativeToolMarkup(null)).toBe(false);
    expect(hasNativeToolMarkup(undefined)).toBe(false);
    expect(hasNativeToolMarkup(42)).toBe(false);
  });
});

describe("extractNativeToolCalls — tag style", () => {
  it("parses a single-argument tool call", () => {
    const calls = extractNativeToolCalls(
      "<tool_call>read<arg_key>path</arg_key><arg_value>/etc/hosts</arg_value></tool_call>"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("read");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: "/etc/hosts" });
  });

  it("parses a multi-argument shell tool call verbatim", () => {
    const calls = extractNativeToolCalls(
      "<tool_call>shell<arg_key>cmd</arg_key><arg_value>docker compose logs warp1 2>&1 | tail -40</arg_value><arg_key>description</arg_key><arg_value>logs</arg_value></tool_call>"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("shell");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      cmd: "docker compose logs warp1 2>&1 | tail -40",
      description: "logs",
    });
  });

  it("parses two concatenated tool calls", () => {
    const calls = extractNativeToolCalls(
      "<tool_call>shell<arg_key>cmd</arg_key><arg_value>a</arg_value></tool_call>" +
        "<tool_call>read<arg_key>path</arg_key><arg_value>b</arg_value></tool_call>"
    );
    expect(calls.map((c) => c.function.name)).toEqual(["shell", "read"]);
    expect(calls[0].id).not.toBe(calls[1].id);
  });

  it("tolerates a missing closing tag (truncated stream)", () => {
    const calls = extractNativeToolCalls(
      "<tool_call>shell<arg_key>cmd</arg_key><arg_value>unterminated"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("shell");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ cmd: "unterminated" });
  });

  it("ignores a stray leaked closing fragment", () => {
    expect(extractNativeToolCalls("fungsi</arg_value>")).toEqual([]);
  });

  it("skips a leaked `</think>` before the tool name (real Laguna variant)", () => {
    const calls = extractNativeToolCalls(
      "</think><tool_call>shell<arg_key>cmd</arg_key><arg_value>ls</arg_value></tool_call>"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("shell");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ cmd: "ls" });
  });

  it("skips a leaked tag word inside the block header", () => {
    const calls = extractNativeToolCalls(
      "<tool_call></think>read<arg_key>path</arg_key><arg_value>/tmp/a</arg_value></tool_call>"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("read");
  });

  it("returns [] for plain prose", () => {
    expect(extractNativeToolCalls("Nothing to see here.")).toEqual([]);
  });
});

describe("extractNativeToolCalls — Kimi style", () => {
  it("still parses Kimi native markup", () => {
    const calls = extractNativeToolCalls('functions.bash:0 {"command":"free -h"}');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "free -h" });
  });
});

describe("extractNativeToolCalls — Mistral style", () => {
  it("parses a [TOOL_CALLS] JSON array", () => {
    const calls = extractNativeToolCalls(
      '[TOOL_CALLS] [{"name":"bash","arguments":{"command":"ls"}}]'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "ls" });
  });
});

describe("normalizeNativeToolCalls", () => {
  it("moves tag markup into tool_calls and keeps leading prose", () => {
    const message = {
      role: "assistant",
      content: "Let me inspect the compose stack.\n<tool_call>shell<arg_key>cmd</arg_key><arg_value>docker compose ps</arg_value></tool_call>",
      tool_calls: null,
    };
    const { message: normalized, hasTools, originalContent } = normalizeNativeToolCalls(message);
    expect(hasTools).toBe(true);
    expect(normalized.content).toBe("Let me inspect the compose stack.");
    expect(normalized.tool_calls).toHaveLength(1);
    expect(normalized.tool_calls[0].function.name).toBe("shell");
    expect(originalContent).toBe(message.content);
  });

  it("sets content to empty string when markup starts immediately", () => {
    const { message: normalized, hasTools } = normalizeNativeToolCalls({
      role: "assistant",
      content: "<tool_call>read<arg_key>path</arg_key><arg_value>/tmp/x</arg_value></tool_call>",
    });
    expect(hasTools).toBe(true);
    expect(normalized.content).toBe("");
  });

  it("leaves an already-structured message untouched", () => {
    const message = {
      role: "assistant",
      content: "done",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
    };
    const { hasTools, message: normalized } = normalizeNativeToolCalls(message);
    expect(hasTools).toBe(true);
    expect(normalized.tool_calls).toBe(message.tool_calls);
    expect(normalized.content).toBe("done");
  });

  it("reports hasTools=false and preserves content when nothing matches", () => {
    const message = { role: "assistant", content: "plain answer" };
    const { hasTools, message: normalized } = normalizeNativeToolCalls(message);
    expect(hasTools).toBe(false);
    expect(normalized.content).toBe("plain answer");
    expect(normalized.tool_calls).toBeUndefined();
  });

  it("survives null / malformed messages", () => {
    expect(normalizeNativeToolCalls(null).hasTools).toBe(false);
    expect(normalizeNativeToolCalls({}).hasTools).toBe(false);
    expect(normalizeNativeToolCalls({ content: null }).hasTools).toBe(false);
  });
});
