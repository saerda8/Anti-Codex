import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createResponseHistoryStore } from "../response-history.mjs";

test("response history hydrates previous_response_id with prior input and output", () => {
  const store = createResponseHistoryStore();
  store.remember(
    {
      id: "resp_1",
      output: [{
        type: "message",
        id: "msg_assistant",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "记住代号 BLUE-739", annotations: [] }],
      }],
    },
    {
      input: "请记住代号 BLUE-739",
    },
  );

  const hydrated = store.hydrate({
    previous_response_id: "resp_1",
    input: "代号是什么？",
  });

  assert.equal(Array.isArray(hydrated.input), true);
  assert.equal(hydrated.input.length, 3);
  assert.equal(hydrated.input[0].role, "user");
  assert.equal(hydrated.input[1].role, "assistant");
  assert.equal(hydrated.input[2].role, "user");
});

test("response history lists the effective input items used by a response", () => {
  const store = createResponseHistoryStore();
  store.remember(
    { id: "resp_2", output: [] },
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "two" }] },
      ],
    },
  );

  const listed = store.listInputItems("resp_2", { order: "asc", limit: 100 });
  assert.equal(listed.object, "list");
  assert.equal(listed.data.length, 2);
  assert.ok(listed.data.every((item) => typeof item.id === "string" && item.id.length > 0));
  assert.equal(listed.first_id, listed.data[0].id);
  assert.equal(listed.last_id, listed.data[1].id);
  assert.equal(listed.has_more, false);
});

test("response history persists bounded entries and reloads them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-history-"));
  const filePath = path.join(dir, "responses.json");
  try {
    const first = createResponseHistoryStore({ filePath, maxEntries: 2 });
    for (const id of ["resp_a", "resp_b", "resp_c"]) {
      first.remember({ id, output: [] }, { input: id });
    }

    const second = createResponseHistoryStore({ filePath, maxEntries: 2 });
    assert.equal(second.has("resp_a"), false);
    assert.equal(second.has("resp_b"), true);
    assert.equal(second.has("resp_c"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("response history returns an empty list for an unknown response id", () => {
  const store = createResponseHistoryStore();
  assert.deepEqual(store.listInputItems("missing"), {
    object: "list",
    data: [],
    first_id: null,
    last_id: null,
    has_more: false,
  });
});

// ─── additional hydration and tool call contracts ───────────────────────────

test("hydrate preserves request unchanged when previous_response_id is null or undefined", () => {
  const store = createResponseHistoryStore();
  const withNull = store.hydrate({ previous_response_id: null, input: "hello" });
  assert.equal(withNull.input, "hello");
  assert.equal(withNull.previous_response_id, null);

  const withUndefined = store.hydrate({ input: "hello" });
  assert.equal(withUndefined.input, "hello");
  assert.equal(withUndefined.previous_response_id, undefined);
});

test("hydrate prepends contextItems that include tool calls from previous response", () => {
  const store = createResponseHistoryStore();
  store.remember(
    {
      id: "resp_tool_ctx",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_exec_1", name: "exec_command", arguments: '{"cmd":"pwd"}', status: "completed" },
        { type: "function_call_output", call_id: "call_exec_1", output: "/tmp/project" },
      ],
    },
    {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] }],
    },
  );

  const hydrated = store.hydrate({
    previous_response_id: "resp_tool_ctx",
    input: "what now",
  });

  assert.equal(Array.isArray(hydrated.input), true);
  // contextItems = inputItems + outputItems → includes both user message and tool calls
  const toolCallItems = hydrated.input.filter(item => item.type === "function_call");
  assert.equal(toolCallItems.length, 1);
  assert.equal(toolCallItems[0].call_id, "call_exec_1");
  const toolResultItems = hydrated.input.filter(item => item.type === "function_call_output");
  assert.equal(toolResultItems.length, 1);
  assert.equal(toolResultItems[0].call_id, "call_exec_1");
  // Last item should be the new user input
  assert.equal(hydrated.input.at(-1).role, "user");
});

test("remember silently ignores response with empty or missing id", () => {
  const store = createResponseHistoryStore();
  store.remember({ id: "", output: [] }, { input: "empty-id" });
  store.remember({ output: [] }, { input: "no-id-field" });
  store.remember(null, { input: "null-response" });
  assert.equal(store.has(""), false);
  assert.equal(store.listInputItems("").data.length, 0);
});

test("listInputItems supports after cursor pagination", () => {
  const store = createResponseHistoryStore();
  const items = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "third" }] },
  ];
  store.remember({ id: "resp_pages", output: [] }, { input: items });

  const page1 = store.listInputItems("resp_pages", { order: "asc", limit: 1 });
  assert.equal(page1.data.length, 1);
  assert.equal(page1.has_more, true);
  assert.equal(page1.data[0].content[0].text, "first");

  const page2 = store.listInputItems("resp_pages", { order: "asc", limit: 1, after: page1.last_id });
  assert.equal(page2.data.length, 1);
  assert.equal(page2.has_more, true);
  assert.equal(page2.data[0].content[0].text, "second");

  const page3 = store.listInputItems("resp_pages", { order: "asc", limit: 1, after: page2.last_id });
  assert.equal(page3.data.length, 1);
  assert.equal(page3.has_more, false);
  assert.equal(page3.data[0].content[0].text, "third");
});

test("listInputItems respects desc order", () => {
  const store = createResponseHistoryStore();
  const items = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "alpha" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "omega" }] },
  ];
  store.remember({ id: "resp_desc", output: [] }, { input: items });

  const desc = store.listInputItems("resp_desc", { order: "desc", limit: 10 });
  assert.equal(desc.data[0].content[0].text, "omega");
  assert.equal(desc.data[1].content[0].text, "alpha");
});

test("prune evicts oldest entries when maxEntries is exceeded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-prune-entries-"));
  const filePath = path.join(dir, "responses.json");
  try {
    const store = createResponseHistoryStore({ filePath, maxEntries: 2 });
    store.remember({ id: "r_old", output: [] }, { input: "old" });
    store.remember({ id: "r_mid", output: [] }, { input: "mid" });
    store.remember({ id: "r_new", output: [] }, { input: "new" });
    assert.equal(store.has("r_old"), false);
    assert.equal(store.has("r_mid"), true);
    assert.equal(store.has("r_new"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hydrate throws an explicit expired-history error when previous_response_id has been pruned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-prune-hydrate-"));
  const filePath = path.join(dir, "responses.json");
  try {
    const store = createResponseHistoryStore({ filePath, maxEntries: 1 });
    store.remember({ id: "r_first", output: [] }, { input: "first" });
    store.remember({ id: "r_second", output: [] }, { input: "second" });
    assert.throws(
      () => store.hydrate({ previous_response_id: "r_first", input: "third" }),
      (error) => {
        assert.equal(error.statusCode, 410);
        assert.equal(error.type, "response_history_missing");
        assert.equal(error.previous_response_id, "r_first");
        assert.match(error.message, /expired or is unavailable/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remember handles empty and null input without crashing", () => {
  const store = createResponseHistoryStore();
  store.remember({ id: "r_empty_input", output: [] }, { input: [] });
  assert.equal(store.has("r_empty_input"), true);
  assert.equal(store.listInputItems("r_empty_input").data.length, 0);

  store.remember({ id: "r_null_input", output: [] }, { input: null });
  assert.equal(store.has("r_null_input"), true);
  assert.equal(store.listInputItems("r_null_input").data.length, 0);

  store.remember({ id: "r_no_request_input", output: [] }, {});
  assert.equal(store.has("r_no_request_input"), true);
  assert.equal(store.listInputItems("r_no_request_input").data.length, 0);
});

// ─── model-name independence contract ────────────────────────────────────

test("hydrate preserves conversation history when model name differs from previous request", () => {
  const store = createResponseHistoryStore();
  store.remember(
    {
      id: "resp_model_neutral",
      output: [{
        type: "message",
        id: "msg_prev_assistant",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "前序回答", annotations: [] }],
      }],
    },
    {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "前序问题" }] }],
    },
  );

  const hydrated = store.hydrate({
    previous_response_id: "resp_model_neutral",
    model: "my-custom-model-v2",
    input: "后续问题",
  });

  // Model name from the new request is preserved (pass-through contract)
  assert.equal(hydrated.model, "my-custom-model-v2");

  // All history context items are present alongside the new input
  assert.equal(Array.isArray(hydrated.input), true);
  assert.equal(hydrated.input.length, 3, "should have 2 context items + 1 new input");
  assert.equal(hydrated.input[0].content[0].text, "前序问题");
  assert.equal(hydrated.input[1].content[0].text, "前序回答");
  assert.equal(hydrated.input[2].content[0].text, "后续问题");

  // previous_response_id still refers to the same entry
  assert.equal(hydrated.previous_response_id, "resp_model_neutral");
});
