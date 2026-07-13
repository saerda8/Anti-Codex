import test from "node:test";
import assert from "node:assert/strict";

import {
  messageCloseEvents,
  reasoningCloseEvents,
  responsesSseEvents,
  sseEvent,
} from "../codex-native-sse.mjs";

// Equivalent ports of CC Switch codex_responses_sse.rs fixtures
// (MIT, Copyright 2025 Jason Young).

function parseEvent(frame) {
  const [eventLine, dataLine] = frame.trimEnd().split("\n");
  return {
    event: eventLine.slice("event: ".length),
    data: JSON.parse(dataLine.slice("data: ".length)),
  };
}

test("native Responses SSE uses exact event and data framing", () => {
  assert.equal(
    sseEvent("response.created", { a: 1 }),
    "event: response.created\ndata: {\"a\":1}\n\n",
  );
});

test("native Responses SSE closes message and reasoning items in protocol order", () => {
  const message = messageCloseEvents(2, "resp_1_msg", "hi");
  assert.deepEqual(message.events.map((frame) => parseEvent(frame).event), [
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
  ]);
  assert.equal(message.item.status, "completed");
  assert.equal(message.item.content[0].text, "hi");

  const reasoning = reasoningCloseEvents(0, "rs_1", "because");
  assert.deepEqual(reasoning.events.map((frame) => parseEvent(frame).event), [
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assert.equal(Object.hasOwn(reasoning.item, "status"), false);
  assert.equal(reasoning.item.summary[0].text, "because");
});

test("native Responses SSE emits complete lifecycle for text and function calls", () => {
  const response = {
    id: "resp_1",
    object: "response",
    created_at: 123,
    status: "completed",
    model: "gemini-3.5-flash-low",
    output: [
      {
        id: "resp_1_msg",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
      {
        id: "fc_call_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "shell_command",
        arguments: "{\"command\":\"pwd\"}",
      },
    ],
    usage: null,
  };
  const parsed = responsesSseEvents(response, { chunkSize: 3 }).map(parseEvent);
  const names = parsed.map((entry) => entry.event);

  assert.deepEqual(names.slice(0, 2), ["response.created", "response.in_progress"]);
  assert.ok(names.includes("response.output_text.delta"));
  assert.ok(names.includes("response.function_call_arguments.delta"));
  assert.ok(names.includes("response.function_call_arguments.done"));
  assert.equal(names.at(-1), "response.completed");
  assert.equal(parsed.at(-1).data.response.status, "completed");
});

test("native Responses SSE emits custom freeform input deltas", () => {
  const response = {
    id: "resp_custom",
    object: "response",
    created_at: 123,
    status: "completed",
    model: "gemini-3.5-flash-low",
    output: [{
      id: "ctc_call_patch",
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
    }],
    usage: null,
  };
  const parsed = responsesSseEvents(response).map(parseEvent);
  const names = parsed.map((entry) => entry.event);

  assert.ok(names.includes("response.custom_tool_call_input.delta"));
  assert.ok(names.includes("response.custom_tool_call_input.done"));
  assert.equal(names.at(-1), "response.completed");
});

test("native Responses SSE failure terminates with response.failed only", () => {
  const failed = {
    id: "resp_failed",
    object: "response",
    created_at: 123,
    status: "failed",
    model: "gemini-3.5-flash-low",
    output: [],
    error: { message: "upstream failed", type: "upstream_error", code: null, param: null },
    usage: null,
  };
  const names = responsesSseEvents(failed).map((frame) => parseEvent(frame).event);

  assert.equal(names.at(-1), "response.failed");
  assert.equal(names.includes("response.completed"), false);
});
