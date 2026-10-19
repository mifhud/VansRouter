// Tests for the unusable-turn gate and its combo integration.
//
// Context: a provider can answer HTTP 200 and stream an empty turn (no content,
// no tool_calls). The client agent then stops mid-way. The combo must notice and
// retry the next model, without leaking the abandoned turn to the client.
import { describe, it, expect, vi } from "vitest";
import { gateTurn, classifyTurnLine } from "../../open-sse/services/turnGate.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function sseResponse(text, { status = 200, headers = {} } = {}) {
  const bytes = encoder.encode(text);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

async function readAll(response) {
  const reader = response.body.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function frame(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

describe("classifyTurnLine", () => {
  it("treats assistant content as usable", () => {
    expect(classifyTurnLine(`data: {"choices":[{"delta":{"content":"hi"}}]}`)).toBe("usable");
  });

  it("treats whitespace-only content as not usable", () => {
    expect(classifyTurnLine(`data: {"choices":[{"delta":{"content":"   "}}]}`)).toBe("hold");
  });

  it("treats a structured tool_calls delta as usable", () => {
    expect(
      classifyTurnLine(`data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"shell"}}]}}]}`)
    ).toBe("usable");
  });

  it("treats the assistant role frame and [DONE] as not usable", () => {
    expect(classifyTurnLine(`data: {"choices":[{"delta":{"role":"assistant"}}]}`)).toBe("hold");
    expect(classifyTurnLine("data: [DONE]")).toBe("hold");
  });

  it("does not count reasoning as usable on its own", () => {
    expect(classifyTurnLine(`data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}`)).toBe("hold");
    expect(classifyTurnLine(`data: {"choices":[{"delta":{"reasoning":"hmm"}}]}`)).toBe("hold");
  });

  it("handles Claude and Gemini shapes", () => {
    expect(classifyTurnLine(`data: {"type":"content_block_delta","delta":{"text":"hi"}}`)).toBe("usable");
    expect(classifyTurnLine(`data: {"type":"content_block_delta","delta":{"thinking":"hmm"}}`)).toBe("hold");
    expect(classifyTurnLine(`data: {"type":"content_block_stop"}`)).toBe("hold");
    expect(classifyTurnLine(`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}`)).toBe("usable");
  });

  it("commits bodies it does not understand rather than dropping them", () => {
    expect(classifyTurnLine(`data: {"something":"else"}`)).toBe("usable");
  });

  it("treats framing and unparseable data as not usable", () => {
    expect(classifyTurnLine("event: message_start")).toBe("hold");
    expect(classifyTurnLine("data: not-json-at-all")).toBe("hold");
  });
});

describe("gateTurn", () => {
  it("accepts a turn that carries content and replays it byte-for-byte", async () => {
    const text = frame({ role: "assistant", content: "hello" }) + frame({}, "stop") + "data: [DONE]\n\n";
    const gate = await gateTurn(sseResponse(text));
    expect(gate.usable).toBe(true);
    expect(gate.reason).toBe("usable");
    expect(await readAll(gate.response)).toBe(text);
  });

  it("rejects an empty turn (role frame + [DONE] only)", async () => {
    const text = frame({ role: "assistant" }) + frame({}, "stop") + "data: [DONE]\n\n";
    const gate = await gateTurn(sseResponse(text));
    expect(gate.usable).toBe(false);
    expect(gate.reason).toBe("empty-turn");
    // Nothing is lost: the caller can still hand this response to the client.
    expect(await readAll(gate.response)).toBe(text);
  });

  it("rejects a reasoning-only turn", async () => {
    const text =
      frame({ role: "assistant", reasoning_content: "thinking hard" }) +
      frame({}, "stop") +
      "data: [DONE]\n\n";
    const gate = await gateTurn(sseResponse(text));
    expect(gate.usable).toBe(false);
    expect(await readAll(gate.response)).toContain("thinking hard");
  });

  it("preserves frame framing (blank lines) and comment lines", async () => {
    const text = ": keep-alive\n\n" + frame({ content: "ok" }) + "data: [DONE]\n\n";
    const gate = await gateTurn(sseResponse(text));
    expect(gate.usable).toBe(true);
    expect(await readAll(gate.response)).toBe(text);
  });

  it("keeps the stream alive with its own heartbeats while frames are held", async () => {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const response = new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const gatePromise = gateTurn(response, { heartbeatMs: 15, maxWaitMs: 5000 });
    controller.enqueue(encoder.encode(frame({ role: "assistant" })));
    await new Promise((r) => setTimeout(r, 120));
    controller.enqueue(encoder.encode(frame({ content: "late answer" })));
    controller.close();

    const gate = await gatePromise;
    expect(gate.usable).toBe(true);
    const text = await readAll(gate.response);
    // The gate generated keep-alives because the upstream was silent while its
    // frames were held; without them the client link would look idle.
    expect(text.match(/: keep-alive/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("late answer");
  });

  it("otherwise-unknown JSON bodies are committed", async () => {
    const text = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] });
    const gate = await gateTurn(sseResponse(text));
    expect(gate.usable).toBe(true);
    expect(await readAll(gate.response)).toBe(text);
  });

  it("commits instead of buffering forever once the byte cap is exceeded", async () => {
    const gate = await gateTurn(
      sseResponse(frame({ role: "assistant" }) + frame({}, "stop")),
      { maxBytes: 16 }
    );
    expect(gate.usable).toBe(true);
    expect(gate.reason).toBe("byte-cap");
    expect(await readAll(gate.response)).toContain("chat.completion.chunk");
  });

  it("commits a still-open stream when the wait cap expires", async () => {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const response = new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const gate = await gateTurn(response, { maxWaitMs: 40 });
    expect(gate.usable).toBe(true);
    expect(gate.reason).toBe("wait-cap");
    controller.close();
    expect(await readAll(gate.response)).toBe("");
  });
});

describe("combo unusable-turn retry", () => {
  const bodyWithTools = {
    messages: [{ role: "user", content: "list files" }],
    tools: [{ type: "function", function: { name: "shell", parameters: {} } }],
  };

  it("falls through to the next model when the first returns an empty turn", async () => {
    const emptyTurn = frame({ role: "assistant" }) + frame({}, "stop") + "data: [DONE]\n\n";
    const goodTurn = frame({ role: "assistant", content: "done" }) + frame({}, "stop") + "data: [DONE]\n\n";

    const handleSingleModel = vi.fn(async (_body, model) =>
      model === "a/empty" ? sseResponse(emptyTurn) : sseResponse(goodTurn)
    );

    const res = await handleComboChat({
      body: bodyWithTools,
      models: ["a/empty", "b/good"],
      handleSingleModel,
      log,
      comboName: "retry-combo",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    const text = await readAll(res);
    expect(text).toContain("done");
    // The abandoned empty turn must not be mixed into the client stream.
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it("does not gate plain chat requests that declare no tools", async () => {
    const emptyTurn = frame({ role: "assistant" }) + frame({}, "stop") + "data: [DONE]\n\n";
    const handleSingleModel = vi.fn(async () => sseResponse(emptyTurn));

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["a/empty", "b/also-empty"],
      handleSingleModel,
      log,
      comboName: "plain-combo",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("returns the last unusable turn instead of looping forever when every model is empty", async () => {
    const emptyTurn = frame({ role: "assistant" }) + frame({}, "stop") + "data: [DONE]\n\n";
    const handleSingleModel = vi.fn(async () => sseResponse(emptyTurn));

    const res = await handleComboChat({
      body: bodyWithTools,
      models: ["a/empty", "b/empty", "c/empty"],
      handleSingleModel,
      log,
      comboName: "all-empty-combo",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(3);
    expect(res.ok).toBe(true);
    expect(await readAll(res)).toContain("[DONE]");
  });

  it("keeps the recovering model's selected-connection header", async () => {
    const emptyTurn = frame({ role: "assistant" }) + frame({}, "stop") + "data: [DONE]\n\n";
    const goodTurn = frame({ role: "assistant", content: "ok" }) + frame({}, "stop") + "data: [DONE]\n\n";

    const handleSingleModel = vi.fn(async (_body, model) =>
      model === "a/empty"
        ? sseResponse(emptyTurn, { headers: { "X-VansRoute-Selected-Connection-Id": "conn-empty" } })
        : sseResponse(goodTurn, { headers: { "X-VansRoute-Selected-Connection-Id": "conn-good" } })
    );

    const res = await handleComboChat({
      body: bodyWithTools,
      models: ["a/empty", "b/good"],
      handleSingleModel,
      log,
      comboName: "hdr-combo",
      comboStrategy: "fallback",
    });

    expect(res.headers.get("X-VansRoute-Selected-Connection-Id")).toBe("conn-good");
  });
});
