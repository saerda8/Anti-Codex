import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createAntigravityRequestRegistry } from "../antigravity-request-registry.mjs";
import { pipeAntigravityResponseAsSSE } from "../adaptive-server.mjs";

test("Antigravity response publishes its id before the upstream turn completes", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  let resolveTurn;
  const turn = new Promise((resolve) => { resolveTurn = resolve; });

  const running = pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "hello" }] },
    { model: "gemini-pro-agent", stream: true, input: "hello" },
    null,
    {
      registry,
      streamUpstream: async function* (_body, options) {
        const completion = await turn;
        yield {
          type: "done",
          completion: { ...completion, id: options.responseId, created: options.created },
        };
      },
    },
  );

  await response.waitForEvent("response.created");
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);

  resolveTurn({
    object: "chat.completion",
    model: "gemini-pro-agent",
    choices: [{ message: { role: "assistant", content: "hello back" }, finish_reason: "stop" }],
    usage: {},
  });
  await running;

  const created = response.event("response.created").data.response;
  const completed = response.event("response.completed").data.response;
  assert.equal(completed.id, created.id);
  assert.equal(response.event("response.output_text.delta").data.delta, "hello back");
});

test("Antigravity response forwards a real text delta before the upstream stream completes", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  let releaseDone;
  const doneGate = new Promise((resolve) => { releaseDone = resolve; });

  const running = pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "stream" }] },
    { model: "gemini-pro-agent", stream: true, input: "stream" },
    null,
    {
      registry,
      callUpstream: async () => {
        throw new Error("blocking upstream must not be used for streamed responses");
      },
      streamUpstream: async function* (_body, options) {
        yield { type: "text_delta", delta: "live " };
        await doneGate;
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "live answer" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  const delta = await Promise.race([
    response.waitForEvent("response.output_text.delta"),
    running.then(() => null),
  ]);
  assert.ok(delta, "stream ended before publishing a text delta");
  assert.equal(delta.data.delta, "live ");
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);

  releaseDone();
  await running;

  assert.equal(
    response.event("response.output_text.done").data.text,
    "live answer",
  );
  assert.equal(
    response.event("response.completed").data.response.output[0].content[0].text,
    "live answer",
  );
});

test("Antigravity streamed response keeps the SSE connection active before first text", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "silent first" }] },
    { model: "gemini-pro-agent", stream: true, input: "silent first" },
    null,
    {
      registry,
      streamKeepAliveMs: 10,
      streamIdleTimeoutMs: 250,
      streamUpstream: async function* (_body, options) {
        await new Promise((resolve) => setTimeout(resolve, 35));
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "late answer" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  assert.ok(
    response.rawChunks.some((chunk) => chunk.startsWith(": anticodex-keepalive ")),
    "SSE keepalive comment should be emitted while upstream is silent",
  );
  assert.equal(response.event("response.completed").data.response.output[0].content[0].text, "late answer");
});

test("Antigravity streamed response records model route metadata", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  const records = [];

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-3.5-flash-low", messages: [{ role: "user", content: "stream route" }] },
    { model: "gemini-3.5-flash-low", stream: true, input: "stream route" },
    null,
    {
      registry,
      routeAudit: { record: (entry) => records.push(entry) },
      streamUpstream: async function* (_body, options) {
        options.onModelRouted({
          requestId: options.responseId,
          requestedModel: "gemini-3.5-flash-low",
          resolvedModel: "gemini-3.5-flash-low",
          displayName: "Gemini 3.5 Flash (Low)",
          internalModel: "MODEL_PLACEHOLDER_M20",
          cascadeId: "cascade_stream_route",
          status: "success",
        });
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-3.5-flash-low",
            choices: [{ message: { role: "assistant", content: "route ok" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].requestId, response.event("response.created").data.response.id);
  assert.equal(records[0].resolvedModel, "gemini-3.5-flash-low");
  assert.equal(records[0].internalModel, "MODEL_PLACEHOLDER_M20");
});

test("Antigravity response stops appending deltas after a text revision", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "revise" }] },
    { model: "gemini-pro-agent", stream: true, input: "revise" },
    null,
    {
      registry,
      streamUpstream: async function* (_body, options) {
        yield { type: "text_delta", delta: "Hello" };
        yield { type: "text_replace", text: "Hi" };
        yield { type: "text_delta", delta: " there" };
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  assert.deepEqual(
    response.events
      .filter((event) => event.name === "response.output_text.delta")
      .map((event) => event.data.delta),
    ["Hello"],
  );
  assert.equal(response.event("response.output_text.done").data.text, "Hi there");
});

test("Antigravity streamed tool markup becomes a Codex function_call without leaking markup", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    {
      model: "gemini-pro-agent",
      tools: [{
        type: "function",
        function: { name: "exec_command", parameters: { type: "object" } },
      }],
      messages: [{ role: "user", content: "list files" }],
    },
    { model: "gemini-pro-agent", stream: true, input: "list files" },
    {
      exec_command: {
        type: "function",
        codexName: "exec_command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      registry,
      streamUpstream: async function* (_body, options) {
        const markup = '<tool_calls><invoke name="exec_command"><parameter name="command">pwd</parameter></invoke></tool_calls>';
        yield { type: "text_delta", delta: markup.slice(0, 30) };
        yield { type: "text_delta", delta: markup.slice(30) };
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: markup }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  assert.equal(response.events.some((event) => event.name === "response.output_text.delta"), false);
  const toolItem = response.event("response.output_item.done").data.item;
  assert.equal(toolItem.type, "function_call");
  assert.equal(toolItem.name, "exec_command");
  assert.match(toolItem.arguments, /pwd/);
  assert.equal(response.event("response.completed").data.response.output[0].type, "function_call");
});

test("Antigravity streamed parallel tool markup becomes two distinct Codex function_calls", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    {
      model: "gemini-pro-agent",
      tools: [
        { type: "function", function: { name: "marker_tool", parameters: { type: "object" } } },
        { type: "function", function: { name: "echo_tool", parameters: { type: "object" } } },
      ],
      messages: [{ role: "user", content: "call both tools" }],
    },
    { model: "gemini-pro-agent", stream: true, input: "call both tools", parallel_tool_calls: true },
    {
      marker_tool: {
        type: "function",
        codexName: "marker_tool",
        parameters: {
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
        },
      },
      echo_tool: {
        type: "function",
        codexName: "echo_tool",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    },
    {
      registry,
      streamUpstream: async function* (_body, options) {
        const markup = [
          "<tool_calls>",
          '<invoke name="marker_tool"><parameter name="marker">PARALLEL_STREAM_1</parameter></invoke>',
          '<invoke name="echo_tool"><parameter name="text">PARALLEL_STREAM_2</parameter></invoke>',
          "</tool_calls>",
        ].join("");
        yield { type: "text_delta", delta: markup.slice(0, 47) };
        yield { type: "text_delta", delta: markup.slice(47, 121) };
        yield { type: "text_delta", delta: markup.slice(121) };
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: markup }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  assert.equal(response.events.some((event) => event.name === "response.output_text.delta"), false);
  const toolItems = response.events
    .filter((event) => event.name === "response.output_item.done")
    .map((event) => event.data.item);
  assert.equal(toolItems.length, 2);
  assert.deepEqual(toolItems.map((item) => item.name), ["marker_tool", "echo_tool"]);
  assert.equal(new Set(toolItems.map((item) => item.call_id)).size, 2);
  assert.match(toolItems[0].arguments, /PARALLEL_STREAM_1/);
  assert.match(toolItems[1].arguments, /PARALLEL_STREAM_2/);

  const completedOutput = response.event("response.completed").data.response.output;
  assert.equal(completedOutput.length, 2);
  assert.deepEqual(completedOutput.map((item) => item.name), ["marker_tool", "echo_tool"]);
});

test("Antigravity streamed namespace tool markup is routed back to the Codex subtool name", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    {
      model: "gemini-pro-agent",
      tools: [{
        type: "function",
        function: { name: "mcp__node_repl__js", parameters: { type: "object" } },
      }],
      messages: [{ role: "user", content: "run javascript" }],
    },
    { model: "gemini-pro-agent", stream: true, input: "run javascript" },
    {
      mcp__node_repl__js: {
        type: "function",
        codexName: "js",
        chatName: "mcp__node_repl__js",
        namespace: "mcp__node_repl__",
      },
    },
    {
      registry,
      streamUpstream: async function* (_body, options) {
        const markup = '<tool_calls><invoke name="mcp__node_repl__js"><parameter name="code">1 + 1</parameter></invoke></tool_calls>';
        yield { type: "text_delta", delta: markup };
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: markup }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  const toolItem = response.event("response.output_item.done").data.item;
  assert.equal(toolItem.type, "function_call");
  assert.equal(toolItem.name, "js");
  assert.match(toolItem.arguments, /1 \+ 1/);
});

test("Antigravity streamed custom tool markup becomes a Codex custom_tool_call", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  const patch = "*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch";

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    {
      model: "gemini-pro-agent",
      tools: [{
        type: "function",
        function: {
          name: "apply_patch",
          parameters: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
        },
      }],
      messages: [{ role: "user", content: "write a patch" }],
    },
    { model: "gemini-pro-agent", stream: true, input: "write a patch" },
    {
      apply_patch: {
        type: "custom",
        codexName: "apply_patch",
        chatName: "apply_patch",
        namespace: null,
      },
    },
    {
      registry,
      streamUpstream: async function* (_body, options) {
        const markup = `<tool_calls><invoke name="apply_patch"><parameter name="content">${patch}</parameter></invoke></tool_calls>`;
        yield { type: "text_delta", delta: markup };
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: markup }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  assert.equal(response.events.some((event) => event.name === "response.output_text.delta"), false);
  const toolItem = response.event("response.output_item.done").data.item;
  assert.equal(toolItem.type, "custom_tool_call");
  assert.equal(toolItem.name, "apply_patch");
  assert.equal(toolItem.input, patch);
  assert.equal(response.event("response.completed").data.response.output[0].type, "custom_tool_call");
});

test("cancelling an active Antigravity response aborts the turn and emits response.cancelled", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  let observedSignal = null;

  const running = pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "wait" }] },
    { model: "gemini-pro-agent", stream: true, input: "wait" },
    null,
    {
      registry,
      streamUpstream: async function* (_body, options) {
        observedSignal = options.signal;
        options.onCascadeStarted?.({ cascadeId: "cascade_1", connection: {} });
        await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    },
  );

  await response.waitForEvent("response.created");
  const responseId = response.event("response.created").data.response.id;
  const cancellation = await registry.cancel(responseId);
  await running;

  assert.equal(cancellation.cancelled, true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(response.event("response.cancelled").data.response.id, responseId);
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);
});

test("closing an Antigravity streaming client aborts the upstream turn", async () => {
  const request = new FakeRequest();
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  let observedSignal = null;

  const running = pipeAntigravityResponseAsSSE(
    request,
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "wait" }] },
    { model: "gemini-pro-agent", stream: true, input: "wait" },
    null,
    {
      registry,
      streamUpstream: async function* (_body, options) {
        observedSignal = options.signal;
        await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    },
  );

  await response.waitForEvent("response.created");
  response.emit("close");
  await running;

  assert.equal(observedSignal.aborted, true);
  assert.equal(registry.snapshot().active, 0);
  assert.equal(response.event("response.cancelled").data.response.id, response.event("response.created").data.response.id);
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);
});

test("closing a tool-capable Antigravity streaming client lets the upstream turn finish", async () => {
  const request = new FakeRequest();
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  let observedSignal = null;
  let releaseDone;
  const doneGate = new Promise((resolve) => { releaseDone = resolve; });

  const running = pipeAntigravityResponseAsSSE(
    request,
    response,
    {
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "write a file" }],
      tools: [{ type: "function", function: { name: "shell", parameters: { type: "object", properties: {} } } }],
    },
    { model: "gemini-pro-agent", stream: true, input: "write a file" },
    null,
    {
      registry,
      streamUpstream: async function* (_body, options) {
        observedSignal = options.signal;
        await doneGate;
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  await response.waitForEvent("response.created");
  response.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(observedSignal.aborted, false);
  releaseDone();
  await running;

  assert.equal(observedSignal.aborted, false);
  assert.equal(registry.snapshot().active, 0);
  assert.equal(response.events.some((event) => event.name === "response.cancelled"), false);
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);
});

test("Antigravity stream idle timeout fails locally even if upstream ignores abort", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  let observedSignal = null;

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "hang" }] },
    { model: "gemini-pro-agent", stream: true, input: "hang" },
    null,
    {
      registry,
      streamIdleTimeoutMs: 25,
      streamUpstream: async function* (_body, options) {
        observedSignal = options.signal;
        await new Promise(() => {});
        yield { type: "text_delta", delta: "unreachable" };
      },
    },
  );

  const failed = response.event("response.failed").data.response;
  assert.equal(failed.error.type, "antigravity_stream_idle_timeout");
  assert.equal(observedSignal.aborted, true);
  assert.equal(registry.snapshot().active, 0);
  assert.equal(response.ended, true);
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);
  assert.equal(response.events.some((event) => event.name === "response.cancelled"), false);
});

test("cancellation wins if the upstream turn resolves during the cancel race", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "race" }] },
    { model: "gemini-pro-agent", stream: true, input: "race" },
    null,
    {
      registry,
      streamUpstream: async function* (_body, options) {
        await registry.cancel(options.responseId);
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "too late" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );

  assert.ok(response.event("response.cancelled"));
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);
  assert.equal(response.events.some((event) => event.name === "response.output_text.delta"), false);
});

test("signed-out Antigravity streams fail with a stable account error type", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "hello" }] },
    { model: "gemini-pro-agent", stream: true, input: "hello" },
    null,
    {
      registry,
      streamUpstream: async function* () {
        throw new Error(
          "Antigravity has no available models. Open Antigravity, sign in, and confirm its proxy connection, then retry.",
        );
      },
    },
  );

  const failed = response.event("response.failed").data.response;
  assert.equal(failed.error.type, "antigravity_account_unavailable");
  assert.equal(failed.error.retryable, false);
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);
});

test("open Antigravity failure circuit fails a stream without entering upstream", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  let upstreamStarted = false;
  const circuitError = new Error("Antigravity temporarily unavailable: recent proxy/network failures are cooling down for 12000ms.");
  circuitError.name = "AntigravityCircuitOpenError";
  circuitError.statusCode = 503;
  circuitError.type = "antigravity_temporarily_unavailable";
  circuitError.retryable = true;
  circuitError.retryAfterMs = 12000;

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "hello" }] },
    { model: "gemini-pro-agent", stream: true, input: "hello" },
    null,
    {
      registry,
      circuit: {
        beforeRequest: () => { throw circuitError; },
        recordSuccess: () => assert.fail("circuit-open request must not record success"),
        recordFailure: () => assert.fail("circuit-open request must not double-count itself"),
      },
      streamUpstream: async function* () {
        upstreamStarted = true;
        yield { type: "text_delta", delta: "must not run" };
      },
    },
  );

  assert.equal(upstreamStarted, false);
  const failed = response.event("response.failed").data.response;
  assert.equal(failed.error.type, "antigravity_temporarily_unavailable");
  assert.equal(failed.error.retryable, true);
  assert.equal(response.events.some((event) => event.name === "response.completed"), false);
});

test("Antigravity streamed responses wait for the shared request queue", async () => {
  const first = new FakeResponse();
  const second = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  const queue = createManualQueue();
  const started = [];

  const firstRun = pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    first,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "first" }] },
    { model: "gemini-pro-agent", stream: true, input: "first" },
    null,
    {
      registry,
      queue,
      streamUpstream: async function* (_body, options) {
        started.push(options.responseId);
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "first done" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );
  await first.waitForEvent("response.created");
  const firstId = first.event("response.created").data.response.id;

  const secondRun = pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    second,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "second" }] },
    { model: "gemini-pro-agent", stream: true, input: "second" },
    null,
    {
      registry,
      queue,
      streamUpstream: async function* (_body, options) {
        started.push(options.responseId);
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "second done" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );
  await second.waitForEvent("response.created");

  assert.deepEqual(started, [], "queued streams must not enter upstream before the queue releases them");

  queue.releaseNext();
  await firstRun;
  assert.deepEqual(started, [firstId]);
  assert.equal(first.event("response.completed").data.response.output[0].content[0].text, "first done");
  assert.equal(second.events.some((event) => event.name === "response.completed"), false);

  queue.releaseNext();
  await secondRun;
  const secondId = second.event("response.created").data.response.id;
  assert.deepEqual(started, [firstId, secondId]);
  assert.equal(second.event("response.completed").data.response.output[0].content[0].text, "second done");
});

test("Antigravity queued streamed response can be cancelled before entering upstream", async () => {
  const first = new FakeResponse();
  const second = new FakeResponse();
  const registry = createAntigravityRequestRegistry();
  const queue = createManualQueue();
  const started = [];

  const firstRun = pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    first,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "hold" }] },
    { model: "gemini-pro-agent", stream: true, input: "hold" },
    null,
    {
      registry,
      queue,
      streamUpstream: async function* (_body, options) {
        started.push(options.responseId);
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "hold done" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );
  await first.waitForEvent("response.created");

  const secondRun = pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    second,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "cancel queued" }] },
    { model: "gemini-pro-agent", stream: true, input: "cancel queued" },
    null,
    {
      registry,
      queue,
      streamUpstream: async function* (_body, options) {
        started.push(options.responseId);
        yield {
          type: "done",
          completion: {
            id: options.responseId,
            created: options.created,
            object: "chat.completion",
            model: "gemini-pro-agent",
            choices: [{ message: { role: "assistant", content: "must not run" }, finish_reason: "stop" }],
            usage: {},
          },
        };
      },
    },
  );
  await second.waitForEvent("response.created");
  const secondId = second.event("response.created").data.response.id;

  await registry.cancel(secondId);
  queue.releaseNext();
  await firstRun;
  queue.releaseNext();
  await secondRun;

  assert.equal(started.length, 1);
  assert.equal(second.event("response.cancelled").data.response.id, secondId);
  assert.equal(second.events.some((event) => event.name === "response.completed"), false);
});

test("Antigravity streamed response has a total timeout even while events keep arriving", async () => {
  const response = new FakeResponse();
  const registry = createAntigravityRequestRegistry();

  await pipeAntigravityResponseAsSSE(
    { headers: {}, path: "/responses" },
    response,
    { model: "gemini-pro-agent", messages: [{ role: "user", content: "never finish" }] },
    { model: "gemini-pro-agent", stream: true, input: "never finish" },
    null,
    {
      registry,
      streamIdleTimeoutMs: 5_000,
      streamTotalTimeoutMs: 50,
      streamUpstream: async function* () {
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield { type: "text_delta", delta: "." };
        }
      },
    },
  );

  const failed = response.event("response.failed").data.response;
  assert.equal(failed.error.type, "antigravity_stream_total_timeout");
  assert.equal(registry.snapshot().active, 0);
  assert.equal(response.ended, true);
});

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.path = "/responses";
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.events = [];
    this.rawChunks = [];
    this.waiters = new Map();
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.rawChunks.push(String(chunk));
    const match = String(chunk).match(/^event: ([^\n]+)\ndata: (.+)\n\n$/s);
    if (!match) return true;
    const event = { name: match[1], data: JSON.parse(match[2]) };
    this.events.push(event);
    const waiter = this.waiters.get(event.name);
    if (waiter) {
      this.waiters.delete(event.name);
      waiter(event);
    }
    return true;
  }

  end() {
    this.ended = true;
  }

  event(name) {
    return this.events.find((event) => event.name === name);
  }

  waitForEvent(name) {
    const existing = this.event(name);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.set(name, resolve));
  }
}

function createManualQueue() {
  const pending = [];
  return {
    run(task, options = {}) {
      return new Promise((resolve, reject) => {
        pending.push({ task, signal: options.signal, resolve, reject });
      });
    },
    releaseNext() {
      const item = pending.shift();
      if (!item) throw new Error("No queued task to release.");
      if (item.signal?.aborted) {
        item.reject(item.signal.reason ?? new DOMException("Anti-Codex response was cancelled.", "AbortError"));
        return;
      }
      Promise.resolve()
        .then(() => item.task({ signal: item.signal }))
        .then(item.resolve, item.reject);
    },
  };
}
