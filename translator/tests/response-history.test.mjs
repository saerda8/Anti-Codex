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

test("response history persists each input context only once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-history-compact-"));
  const filePath = path.join(dir, "responses.json");
  try {
    const first = createResponseHistoryStore({ filePath });
    first.remember(
      {
        id: "resp_compact",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }],
      },
      { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "question" }] }] },
    );

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")).entries[0];
    assert.equal("inputItems" in persisted, false);
    assert.equal(persisted.inputItemCount, 1);
    assert.equal(persisted.contextItems.length, 2);

    const second = createResponseHistoryStore({ filePath });
    assert.equal(second.listInputItems("resp_compact", { limit: 100 }).data.length, 1);
    assert.equal(second.hydrate({ previous_response_id: "resp_compact", input: "next" }).input.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("response history reloads legacy duplicated input entries into the compact schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-history-legacy-"));
  const filePath = path.join(dir, "responses.json");
  try {
    const input = [{ type: "message", id: "legacy-user", role: "user", content: [{ type: "input_text", text: "legacy" }] }];
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      entries: [{ id: "resp_legacy", createdAt: 1, inputItems: input, contextItems: [...input, { type: "message", role: "assistant", content: [] }] }],
    }));

    const store = createResponseHistoryStore({ filePath });
    assert.equal(store.listInputItems("resp_legacy", { limit: 100 }).data.length, 1);
    store.remember({ id: "resp_new", output: [] }, { input: "new" });

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")).entries;
    assert.ok(persisted.every((entry) => !("inputItems" in entry)));
    assert.equal(persisted.find((entry) => entry.id === "resp_legacy").inputItemCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("response history falls back to copy replacement and removes the temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-history-replace-"));
  const filePath = path.join(dir, "responses.json");
  const fileSystem = Object.create(fs);
  let renameCalls = 0;
  fileSystem.renameSync = () => {
    renameCalls += 1;
    const error = new Error("simulated Windows replacement lock");
    error.code = "EPERM";
    throw error;
  };
  try {
    const store = createResponseHistoryStore({ filePath, fileSystem });
    store.remember({ id: "resp_replace", output: [] }, { input: "persist me" });

    assert.equal(renameCalls, 1);
    assert.equal(createResponseHistoryStore({ filePath }).has("resp_replace"), true);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    );
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

test("default response history keeps only the latest eight recovery points", () => {
  const store = createResponseHistoryStore();
  for (let index = 1; index <= 9; index += 1) {
    store.remember({ id: `r_default_${index}`, output: [] }, { input: `turn ${index}` });
  }
  assert.equal(store.has("r_default_1"), false);
  assert.equal(store.has("r_default_2"), true);
  assert.equal(store.has("r_default_9"), true);
});

test("response history retains the newest recovery point even when it exceeds the character budget", () => {
  const store = createResponseHistoryStore({
    maxEntries: 8,
    maxTotalChars: 10,
    measureEntryChars: () => 20,
  });
  store.remember({ id: "r_oversized_old", output: [] }, { input: "old" });
  assert.equal(store.has("r_oversized_old"), true);
  store.remember({ id: "r_oversized_new", output: [] }, { input: "new" });
  assert.equal(store.has("r_oversized_old"), false);
  assert.equal(store.has("r_oversized_new"), true);
});

test("prune measures each remembered entry once instead of rescanning the full store", () => {
  let measurements = 0;
  const store = createResponseHistoryStore({
    maxEntries: 2,
    maxTotalChars: 1_000_000,
    measureEntryChars(entry) {
      measurements += 1;
      return JSON.stringify(entry).length;
    },
  });

  store.remember({ id: "r_measure_1", output: [] }, { input: "one" });
  store.remember({ id: "r_measure_2", output: [] }, { input: "two" });
  store.remember({ id: "r_measure_3", output: [] }, { input: "three" });

  assert.equal(measurements, 3);
  assert.equal(store.has("r_measure_1"), false);
  assert.equal(store.has("r_measure_2"), true);
  assert.equal(store.has("r_measure_3"), true);
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

test("hydrate preserves conversation history across provider and protocol switches", () => {
  const store = createResponseHistoryStore();
  store.remember(
    {
      id: "resp_provider_switch",
      output: [{
        type: "message",
        id: "msg_openai_assistant",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "provider-a remembered marker BLUE-739", annotations: [] }],
      }],
    },
    {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "provider-a user marker" }] }],
      provider: "provider-a",
      providerProtocol: "openai-compatible",
      model: "provider-a-model",
    },
  );

  const anthropicHydrated = store.hydrate({
    previous_response_id: "resp_provider_switch",
    provider: "provider-b",
    providerProtocol: "anthropic",
    model: "provider-b-model",
    input: "provider-b follow-up",
  });

  assert.equal(anthropicHydrated.provider, "provider-b");
  assert.equal(anthropicHydrated.providerProtocol, "anthropic");
  assert.equal(anthropicHydrated.model, "provider-b-model");
  assert.equal(anthropicHydrated.input.length, 3);
  assert.equal(anthropicHydrated.input[0].content[0].text, "provider-a user marker");
  assert.equal(anthropicHydrated.input[1].content[0].text, "provider-a remembered marker BLUE-739");
  assert.equal(anthropicHydrated.input[2].content[0].text, "provider-b follow-up");

  const openAiHydrated = store.hydrate({
    previous_response_id: "resp_provider_switch",
    provider: "provider-c",
    providerProtocol: "openai-compatible",
    model: "provider-c-model",
    input: "provider-c follow-up",
  });

  assert.equal(openAiHydrated.provider, "provider-c");
  assert.equal(openAiHydrated.providerProtocol, "openai-compatible");
  assert.equal(openAiHydrated.model, "provider-c-model");
  assert.equal(openAiHydrated.input.length, 3);
  assert.equal(openAiHydrated.input[0].content[0].text, "provider-a user marker");
  assert.equal(openAiHydrated.input[1].content[0].text, "provider-a remembered marker BLUE-739");
  assert.equal(openAiHydrated.input[2].content[0].text, "provider-c follow-up");
});

test("hydrate preserves tool call order across provider and protocol switches", () => {
  const store = createResponseHistoryStore();
  store.remember(
    {
      id: "resp_openai_tool",
      output: [
        { type: "function_call", id: "fc_openai_1", call_id: "call_openai_1", name: "read_file", arguments: '{"path":"alpha.txt"}', status: "completed" },
      ],
    },
    {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "read alpha" }] }],
      provider: "provider-a",
      providerProtocol: "openai-compatible",
      model: "provider-a-model",
    },
  );

  const anthropicHydrated = store.hydrate({
    previous_response_id: "resp_openai_tool",
    provider: "provider-b",
    providerProtocol: "anthropic",
    model: "provider-b-model",
    input: [
      { type: "function_call_output", call_id: "call_openai_1", output: "alpha-marker" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "use alpha in anthropic mode" }] },
    ],
  });

  store.remember(
    {
      id: "resp_anthropic_tool",
      output: [
        { type: "function_call", id: "fc_anthropic_1", call_id: "call_anthropic_1", name: "write_file", arguments: '{"path":"beta.txt"}', status: "completed" },
      ],
    },
    anthropicHydrated,
  );

  const openAiHydrated = store.hydrate({
    previous_response_id: "resp_anthropic_tool",
    provider: "provider-c",
    providerProtocol: "openai-compatible",
    model: "provider-c-model",
    input: [
      { type: "function_call_output", call_id: "call_anthropic_1", output: "beta-marker" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue back in openai-compatible mode" }] },
    ],
  });

  assert.equal(anthropicHydrated.previous_response_id, "resp_openai_tool");
  assert.equal(anthropicHydrated.providerProtocol, "anthropic");
  assert.equal(openAiHydrated.previous_response_id, "resp_anthropic_tool");
  assert.equal(openAiHydrated.provider, "provider-c");
  assert.equal(openAiHydrated.providerProtocol, "openai-compatible");
  assert.deepEqual(
    openAiHydrated.input.map((item) => item.type === "message" ? `${item.role}:${item.content?.[0]?.text}` : `${item.type}:${item.call_id}`),
    [
      "user:read alpha",
      "function_call:call_openai_1",
      "function_call_output:call_openai_1",
      "user:use alpha in anthropic mode",
      "function_call:call_anthropic_1",
      "function_call_output:call_anthropic_1",
      "user:continue back in openai-compatible mode",
    ],
  );
});
