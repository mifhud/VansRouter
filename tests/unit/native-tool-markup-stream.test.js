// Streaming integration tests for native tool-call markup recovery.
//
// Regression cover for the production bug where `laguna` leaked
//   <tool_call>shell<arg_key>cmd</arg_key><arg_value>…</arg_value></tool_call>
// into `delta.content`, the client saw prose instead of a tool call, and the
// agent silently ended its turn ("stopped mid-way").
import { describe, it, expect } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  createPassthroughStreamWithLogger,
  createSSETransformStreamWithLogger,
} from "../../open-sse/utils/stream.js";
import { normalizeNativeToolCalls } from "../../open-sse/utils/nativeToolParser.js";

const encoder = new TextEncoder();

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunk(delta, finish = null) {
  return sse({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "poolside/laguna-s-2.1:free",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

async function runStream(transform, frames) {
  const writer = transform.writable.getWriter();
  const decoder = new TextDecoder();
  const out = [];
  const collected = transform.readable.pipeTo(
    new WritableStream({
      write(c) {
        out.push(decoder.decode(c, { stream: true }));
      },
    })
  );
  for (const frame of frames) await writer.write(encoder.encode(frame));
  await writer.close();
  await collected;
  return out.join("");
}

function parseDataLines(output) {
  return output
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

describe("passthrough: native tool-call markup recovery", () => {
  it("turns a leaked <tool_call> block into structured tool_calls", async () => {
    const stream = createPassthroughStreamWithLogger(
      "test",
      null,
      "poolside/laguna-s-2.1:free",
      null,
      null,
      null,
      null,
      normalizeNativeToolCalls
    );

    const output = await runStream(stream, [
      chunk({
        role: "assistant",
        content:
          "Let me check the stack.\n<tool_call>shell<arg_key>cmd</arg_key><arg_value>docker compose ps</arg_value><arg_key>description</arg_key><arg_value>list</arg_value></tool_call>",
      }),
      chunk({}, "stop"),
    ]);

    const chunks = parseDataLines(output);
    const toolChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk).toBeDefined();
    expect(toolChunk.choices[0].finish_reason).toBe("tool_calls");
    const call = toolChunk.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("shell");
    expect(JSON.parse(call.function.arguments)).toEqual({
      cmd: "docker compose ps",
      description: "list",
    });

    // The native token soup must not reach the client as content.
    expect(output).not.toContain("<arg_key>");
    expect(output).not.toContain("<arg_value>");
    expect(output).toContain("Let me check the stack.");
  });

  it("recovers markup split across chunk boundaries at flush", async () => {
    const stream = createPassthroughStreamWithLogger(
      "test",
      null,
      "poolside/laguna-s-2.1:free",
      null,
      null,
      null,
      null,
      normalizeNativeToolCalls
    );

    const output = await runStream(stream, [
      chunk({ role: "assistant", content: "<tool_ca" }),
      chunk({ content: 'll>read<arg_key>path</arg_key><arg_value>/tmp/a</arg_value></tool_call>' }),
      chunk({}, "stop"),
    ]);

    const chunks = parseDataLines(output);
    const toolChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk).toBeDefined();
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("read");
    expect(JSON.parse(toolChunk.choices[0].delta.tool_calls[0].function.arguments)).toEqual({
      path: "/tmp/a",
    });
  });

  it("passes OpenRouter's `reasoning` field through instead of dropping the turn", async () => {
    const stream = createPassthroughStreamWithLogger(
      "test",
      null,
      "poolside/laguna-s-2.1:free",
      null,
      null,
      null,
      null,
      normalizeNativeToolCalls
    );

    const output = await runStream(stream, [
      chunk({ role: "assistant", reasoning: "step 1: think" }),
      chunk({ content: "answer" }),
      chunk({}, "stop"),
    ]);

    expect(output).toContain("step 1: think");
    expect(output).toContain("answer");
  });
});

describe("passthrough: recovered calls must reference declared tools", () => {
  const body = { tools: [{ type: "function", function: { name: "shell" } }] };

  async function runWithBody(b, frames) {
    const stream = createPassthroughStreamWithLogger(
      "test",
      null,
      "poolside/laguna-s-2.1:free",
      null,
      b,
      null,
      null,
      normalizeNativeToolCalls
    );
    const out = await runStream(stream, frames);
    return parseDataLines(out).find((c) => c.choices?.[0]?.delta?.tool_calls);
  }

  it("recovers a call whose name is declared", async () => {
    const toolChunk = await runWithBody(body, [
      chunk({
        role: "assistant",
        content: "<tool_call>shell<arg_key>cmd</arg_key><arg_value>ls</arg_value></tool_call>",
      }),
      chunk({}, "stop"),
    ]);
    expect(toolChunk).toBeDefined();
  });

  it("fuzzy-corrects a mangled declared name", async () => {
    const toolChunk = await runWithBody(body, [
      chunk({ role: "assistant", content: 'functionsfunctions.shell:0 {"cmd":"ls"}' }),
      chunk({}, "stop"),
    ]);
    expect(toolChunk).toBeDefined();
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("shell");
  });

  it("does NOT invent a tool call for an undeclared tool name", async () => {
    const stream = createPassthroughStreamWithLogger(
      "test",
      null,
      "poolside/laguna-s-2.1:free",
      null,
      body,
      null,
      null,
      normalizeNativeToolCalls
    );
    const out = await runStream(stream, [
      chunk({
        role: "assistant",
        content: "<tool_call>dangerous<arg_key>cmd</arg_key><arg_value>rm -rf /</arg_value></tool_call>",
      }),
      chunk({}, "stop"),
    ]);
    const chunks = parseDataLines(out);
    expect(chunks.find((c) => c.choices?.[0]?.delta?.tool_calls)).toBeUndefined();
    // …and the model's text is preserved rather than silently deleted.
    expect(out).toContain("dangerous");
  });
});

describe("translate: native tool-call markup recovery", () => {
  it("emits a synthetic tool_calls chunk for tagged markup", async () => {
    const stream = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "test",
      null,
      null,
      "poolside/laguna-s-2.1:free",
      null,
      null,
      null,
      null,
      normalizeNativeToolCalls
    );

    const output = await runStream(stream, [
      chunk({
        role: "assistant",
        content:
          "<tool_call>shell<arg_key>cmd</arg_key><arg_value>bash scripts/diagnose.sh 2>&1</arg_value></tool_call>",
      }),
      chunk({}, "stop"),
    ]);

    const chunks = parseDataLines(output);
    const toolChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk).toBeDefined();
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("shell");
    expect(output).not.toContain("<tool_call>");
  });

  it("still handles Kimi markup through the same general path", async () => {
    const stream = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "test",
      null,
      null,
      "kimchi/kimi-k2.7",
      null,
      null,
      null,
      null,
      normalizeNativeToolCalls
    );

    const output = await runStream(stream, [
      chunk({ role: "assistant", content: 'functions.bash:0 {"command":"free -h"}' }),
      chunk({}, "stop"),
    ]);

    const chunks = parseDataLines(output);
    const toolChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk).toBeDefined();
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("bash");
  });
});
