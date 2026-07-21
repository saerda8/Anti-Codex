import test from "node:test";
import assert from "node:assert/strict";

import {
  ChatAdapterError,
  createAntigravityChatAdapter,
} from "../provider/antigravity-chat-adapter.mjs";

test("exposes only anonymized Antigravity account readiness", async () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const client = fakeClient({
    readiness: {
      signedIn: true,
      accountFingerprint: fingerprint,
      planName: "Pro",
    },
  });
  const adapter = createAdapter(client);

  assert.deepEqual(await adapter.account(), {
    object: "antigravity.account",
    provider: "antigravity",
    signedIn: true,
    identityAvailable: true,
    fingerprint,
    planName: "Pro",
    tierName: "",
  });
  assert.doesNotMatch(JSON.stringify(await adapter.account()), /@/);
  await adapter.close();
});

test("maps Chat messages into structured Cascade input without task semantics", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "text_delta", delta: "完成" },
      { type: "done", usage: { prompt_tokens: 11, completion_tokens: 2 } },
    ],
  });
  const adapter = createAdapter(client);

  const completion = await adapter.complete({
    model: "gemini-pro-agent",
    messages: [
      { role: "system", content: "system rule" },
      { role: "developer", content: "developer rule" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: [{ type: "text", text: "current question" }] },
    ],
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read one file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    }],
  });

  assert.equal(client.starts.length, 1);
  const request = client.starts[0];
  assert.equal(request.model, "gemini-pro-agent");
  assert.equal(request.userText, "current question");
  assert.deepEqual(request.systemSections.slice(0, 2).map(({ role, content }) => ({ role, content })), [
    { role: "system", content: "system rule" },
    { role: "developer", content: "developer rule" },
  ]);
  const transcript = request.systemSections.find((section) => section.kind === "chat_history");
  assert.ok(transcript);
  assert.deepEqual(transcript.messages, [
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
  ]);
  assert.deepEqual(request.tools, [{
    type: "function",
    function: {
      name: "read_file",
      description: "Read one file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  }]);
  assert.equal(request.systemSections.some((section) => section.kind === "structured_output"), false);
  assert.equal(Object.hasOwn(request, "cwd"), false);
  assert.equal(completion.choices[0].message.content, "完成");
  assert.equal(completion.choices[0].finish_reason, "stop");
  await adapter.close();
});

test("passes the model selected by the native Codex UI to Antigravity", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "text_delta", delta: "continued" },
      { type: "done" },
    ],
  });
  const adapter = createAntigravityChatAdapter({
    client,
    idFactory: sequentialId(),
    now: () => 1_700_000_000_000,
  });

  const completion = await adapter.complete(baseBody({
    model: "gemini-3-flash-agent",
    messages: [{ role: "user", content: "continue with the model selected in the UI" }],
  }));

  assert.equal(client.starts.length, 1);
  assert.equal(client.starts[0].model, "gemini-3-flash-agent");
  assert.equal(completion.model, "gemini-3-flash-agent");
  await adapter.close();
});

test("Codex structured title requests stay text-only and carry the JSON schema", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "text_delta", delta: '{"title":"修复库存脚本","description":"修复库存统计并运行现有测试"}' },
      { type: "done" },
    ],
  });
  const adapter = createAdapter(client);
  const schema = {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 36 },
      description: { type: "string" },
    },
    required: ["title", "description"],
    additionalProperties: false,
  };

  await adapter.complete(baseBody({
    messages: [{
      role: "user",
      content: [
        "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
        "Do NOT respond to the user, answer questions, or attempt to solve the problem; just write a title that can represent the user's query.",
        "User prompt:",
        "修复 inventory.mjs 并运行测试",
      ].join("\n"),
    }],
    tools: [{
      type: "function",
      function: { name: "shell_command", parameters: { type: "object" } },
    }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "task_title", strict: true, schema },
    },
  }));

  assert.equal(client.starts.length, 1);
  const request = client.starts[0];
  assert.deepEqual(request.tools, []);
  assert.equal(request.toolChoice, "none");
  assert.equal(request.parallelToolCalls, false);
  const structuredOutput = request.systemSections.find((section) => section.kind === "structured_output");
  assert.ok(structuredOutput);
  assert.match(structuredOutput.content, /exactly one JSON object/i);
  assert.match(structuredOutput.content, /"title"/);
  assert.match(structuredOutput.content, /"description"/);
  await adapter.close();
});

test("Codex title helpers restore their structured contract when Chat response_format is absent", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "text_delta", delta: "Title: 修复库存脚本\nDescription: 修复库存统计并运行现有测试" },
      { type: "done" },
    ],
  });
  const adapter = createAdapter(client);

  const completion = await adapter.complete(baseBody({
    messages: [{
      role: "user",
      content: [
        "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
        "Generate a concise UI title (up to 36 characters) for this task.",
        "Fill the structured title field with plain text.",
        "Fill the structured description field with a compact, search-oriented summary (up to 100 characters).",
        "Do NOT respond to the user, answer questions, or attempt to solve the problem; just write a title that can represent the user's query.",
        "User prompt:",
        "修复 inventory.mjs 并运行测试",
      ].join("\n"),
    }],
    tools: [{
      type: "function",
      function: { name: "shell_command", parameters: { type: "object" } },
    }],
  }));

  assert.equal(client.starts.length, 1);
  const request = client.starts[0];
  assert.deepEqual(request.tools, []);
  assert.equal(request.toolChoice, "none");
  assert.equal(request.parallelToolCalls, false);
  const structuredOutput = request.systemSections.find((section) => section.kind === "structured_output");
  assert.ok(structuredOutput);
  assert.match(structuredOutput.content, /"title"/);
  assert.match(structuredOutput.content, /"description"/);
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), {
    title: "修复库存脚本",
    description: "修复库存统计并运行现有测试",
  });
  await adapter.close();
});

test("Codex task suggestion helpers stay structured and text-only", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "text_delta", delta: '{"suggestions":[]}' },
      { type: "done" },
    ],
  });
  const adapter = createAdapter(client);
  const suggestionProperties = {
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    prompt: { type: "string", minLength: 1 },
    appId: { type: "string" },
  };

  await adapter.complete(baseBody({
    messages: [{
      role: "user",
      content: [
        "# Overview",
        "",
        "Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: C:\\fixture",
        "",
        "Return 0 to 3 fresh suggestions.",
      ].join("\n"),
    }],
    tools: [{
      type: "function",
      function: { name: "shell_command", parameters: { type: "object" } },
    }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "task_suggestions",
        strict: true,
        schema: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                properties: suggestionProperties,
                required: Object.keys(suggestionProperties),
                additionalProperties: false,
              },
            },
          },
          required: ["suggestions"],
          additionalProperties: false,
        },
      },
    },
  }));

  assert.equal(client.starts.length, 1);
  const request = client.starts[0];
  assert.deepEqual(request.tools, []);
  assert.equal(request.toolChoice, "none");
  assert.equal(request.parallelToolCalls, false);
  assert.ok(request.systemSections.some((section) => section.kind === "structured_output"));
  await adapter.close();
});

test("Codex task suggestion helpers restore their structured contract when Chat response_format is absent", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "text_delta", delta: "No useful project suggestions are available." },
      { type: "done" },
    ],
  });
  const adapter = createAdapter(client);

  const completion = await adapter.complete(baseBody({
    messages: [{
      role: "user",
      content: [
        "# Overview",
        "",
        "Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: C:\\fixture",
        "",
        "Return 0 to 3 fresh suggestions.",
        "",
        "# Response format",
        "",
        "Each suggestion must include:",
        "- title: a concrete title",
        "- description: a compact description",
        "- prompt: the user message to send",
        "- appId: the single most relevant app id",
        "- write the prompt as something that should launch as a new Codex task in this project",
      ].join("\n"),
    }],
    tools: [{
      type: "function",
      function: { name: "shell_command", parameters: { type: "object" } },
    }],
  }));

  assert.equal(client.starts.length, 1);
  const request = client.starts[0];
  assert.deepEqual(request.tools, []);
  assert.equal(request.toolChoice, "none");
  assert.equal(request.parallelToolCalls, false);
  const structuredOutput = request.systemSections.find((section) => section.kind === "structured_output");
  assert.ok(structuredOutput);
  assert.match(structuredOutput.content, /"suggestions"/);
  assert.match(structuredOutput.content, /"prompt"/);
  assert.match(structuredOutput.content, /"appId"/);
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { suggestions: [] });
  await adapter.close();
});

test("streams role, reasoning, text and exactly one terminal chunk in order", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "reasoning_delta", delta: "检查" },
      { type: "text_delta", delta: "结" },
      { type: "text_delta", delta: "果" },
      { type: "done" },
    ],
  });
  const adapter = createAdapter(client);
  const chunks = await collect(adapter.stream(baseBody()));

  assert.deepEqual(chunks.map((chunk) => chunk.choices[0]), [
    { index: 0, delta: { role: "assistant" }, finish_reason: null },
    { index: 0, delta: { reasoning_content: "检查" }, finish_reason: null },
    { index: 0, delta: { content: "结" }, finish_reason: null },
    { index: 0, delta: { content: "果" }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: "stop" },
  ]);
  assert.equal(chunks.filter((chunk) => chunk.choices[0].finish_reason !== null).length, 1);
  await adapter.close();
});

test("returns stable structured tool calls and resumes the same opaque Cascade with exact results", async () => {
  const continuation = { cascadeId: "cascade-1" };
  const client = fakeClient({
    startEvents: [
      { type: "tool_calls", calls: [{ callId: "call_read", name: "read_file", arguments: { path: "a.txt" } }], continuation },
    ],
    resumeEvents: [
      { type: "text_delta", delta: "file contents accepted" },
      { type: "done" },
    ],
  });
  const adapter = createAdapter(client);

  const first = await adapter.complete(baseBody({
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }));
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(first.choices[0].message.tool_calls, [{
    id: "call_read",
    type: "function",
    function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
  }]);

  const second = await adapter.complete(baseBody({
    messages: [
      { role: "user", content: "read it" },
      { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: "call_read", content: "EXACT\r\nRESULT" },
    ],
  }));
  assert.equal(second.choices[0].message.content, "file contents accepted");
  assert.equal(client.resumes.length, 1);
  assert.equal(client.resumes[0].continuation, continuation);
  assert.deepEqual(client.resumes[0].results, [{
    callId: "call_read",
    output: "EXACT\r\nRESULT",
    isError: false,
  }]);
  assert.equal(adapter.sessionCount, 0);
  await adapter.close();
});

test("parallel tool continuation requires every result from one pending Cascade", async () => {
  const client = fakeClient({
    startEvents: [{
      type: "tool_calls",
      calls: [
        { callId: "call_a", name: "a", arguments: { n: 1 } },
        { callId: "call_b", name: "b", arguments: { n: 2 } },
      ],
      continuation: { cascadeId: "parallel" },
    }],
    resumeEvents: [{ type: "text_delta", delta: "both" }, { type: "done" }],
  });
  const adapter = createAdapter(client);
  const first = await adapter.complete(baseBody({
    tools: [
      { type: "function", function: { name: "a", parameters: { type: "object" } } },
      { type: "function", function: { name: "b", parameters: { type: "object" } } },
    ],
  }));

  await assert.rejects(
    adapter.complete(baseBody({ messages: [
      { role: "user", content: "run both" },
      { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: "call_a", content: "A" },
    ] })),
    (error) => error instanceof ChatAdapterError
      && error.statusCode === 409
      && error.code === "incomplete_tool_results",
  );
  assert.equal(adapter.sessionCount, 1);

  const completed = await adapter.complete(baseBody({ messages: [
    { role: "user", content: "run both" },
    { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
    { role: "tool", tool_call_id: "call_b", content: "B" },
    { role: "tool", tool_call_id: "call_a", content: "A" },
  ] }));
  assert.equal(completed.choices[0].message.content, "both");
  assert.deepEqual(client.resumes[0].results, [
    { callId: "call_a", output: "A", isError: false },
    { callId: "call_b", output: "B", isError: false },
  ]);
  await adapter.close();
});

test("malformed Cascade tool arguments fail closed and cancel the opaque continuation", async () => {
  const continuation = { cascadeId: "malformed-arguments" };
  const client = fakeClient({
    startEvents: [{
      type: "tool_calls",
      calls: [{ callId: "call_bad", name: "shell_command", arguments: "not-an-object" }],
      continuation,
    }],
  });
  const adapter = createAdapter(client);

  await assert.rejects(
    adapter.complete(baseBody()),
    (error) => error instanceof ChatAdapterError
      && error.statusCode === 502
      && error.code === "invalid_cascade_tool_arguments",
  );
  assert.deepEqual(client.cancels, [continuation]);
  assert.equal(adapter.sessionCount, 0);
  await adapter.close();
});

test("failed host tool output is preserved exactly for the same Cascade recovery", async () => {
  const continuation = { cascadeId: "tool-failure" };
  const exactFailure = "process exited with code 7\r\nstderr: missing fixture";
  const client = fakeClient({
    startEvents: [{
      type: "tool_calls",
      calls: [{ callId: "call_fail", name: "shell_command", arguments: { command: "exit 7" } }],
      continuation,
    }],
    resumeEvents: [{ type: "text_delta", delta: "recovered" }, { type: "done" }],
  });
  const adapter = createAdapter(client);
  const first = await adapter.complete(baseBody());
  const completed = await adapter.complete(baseBody({ messages: [
    { role: "user", content: "run it" },
    { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
    { role: "tool", tool_call_id: "call_fail", content: exactFailure },
  ] }));

  assert.equal(completed.choices[0].message.content, "recovered");
  assert.deepEqual(client.resumes[0].results, [{
    callId: "call_fail",
    output: exactFailure,
    isError: false,
  }]);
  assert.equal(client.starts.length, 1);
  assert.equal(client.resumes.length, 1);
  await adapter.close();
});

test("unknown or reused tool call IDs fail closed without starting a new Cascade", async () => {
  const client = fakeClient({ startEvents: [{ type: "text_delta", delta: "unused" }, { type: "done" }] });
  const adapter = createAdapter(client);
  const continuationBody = baseBody({ messages: [
    { role: "assistant", content: null, tool_calls: [{
      id: "missing",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    }] },
    { role: "tool", tool_call_id: "missing", content: "data" },
  ] });

  await assert.rejects(
    adapter.complete(continuationBody),
    (error) => error instanceof ChatAdapterError
      && error.statusCode === 409
      && error.code === "cascade_session_missing",
  );
  assert.equal(client.starts.length, 0);
  assert.equal(client.resumes.length, 0);
  await adapter.close();
});

test("adapter restart continues from complete Chat tool history without replaying the tool", async () => {
  const client = fakeClient({
    startEvents: [
      { type: "text_delta", delta: "continued after restart" },
      { type: "done" },
    ],
  });
  const adapter = createAdapter(client);
  const completion = await adapter.complete(baseBody({
    messages: [
      { role: "system", content: "system rule" },
      { role: "user", content: "run the command once" },
      { role: "assistant", content: null, tool_calls: [{
        id: "call_completed_before_restart",
        type: "function",
        function: { name: "shell_command", arguments: "{\"command\":\"npm test\"}" },
      }] },
      { role: "tool", tool_call_id: "call_completed_before_restart", content: "tests passed" },
    ],
    tools: [{
      type: "function",
      function: { name: "shell_command", parameters: { type: "object" } },
    }],
  }));

  assert.equal(completion.choices[0].message.content, "continued after restart");
  assert.equal(client.resumes.length, 0);
  assert.equal(client.starts.length, 1);
  const request = client.starts[0];
  assert.match(request.userText, /continue.*completed.*tool result/i);
  const protocol = request.systemSections.find((section) => section.kind === "tool_restart_continuation");
  assert.match(protocol.content, /must not be requested again/i);
  const transcript = request.systemSections.find((section) => section.kind === "chat_history");
  assert.deepEqual(transcript.messages, [
    { role: "user", content: "run the command once" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_completed_before_restart",
        type: "function",
        function: { name: "shell_command", arguments: "{\"command\":\"npm test\"}" },
      }],
    },
    { role: "tool", content: "tests passed", tool_call_id: "call_completed_before_restart" },
  ]);
  await adapter.close();
});

test("duplicate same-process tool continuations share and replay one Cascade resume", async () => {
  const releaseResume = deferred();
  const client = fakeClient({
    startEvents: [{
      type: "tool_calls",
      calls: [{ callId: "call_once", name: "shell_command", arguments: { command: "node once.mjs" } }],
      continuation: { cascadeId: "same-process-once" },
    }],
    resumeEvents: async function* () {
      await releaseResume.promise;
      yield { type: "text_delta", delta: "continued exactly once" };
      yield { type: "done" };
    },
  });
  const adapter = createAdapter(client);
  const first = await adapter.complete(baseBody({
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }));
  const continuationBody = baseBody({
    messages: [
      { role: "user", content: "run once" },
      { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: "call_once", content: "exit 0" },
    ],
  });

  const owner = adapter.complete(continuationBody);
  await waitUntil(() => client.resumes.length === 1);
  const duplicate = adapter.complete(continuationBody);
  releaseResume.resolve();
  const [ownerResult, duplicateResult] = await Promise.all([owner, duplicate]);
  const replay = await adapter.complete(continuationBody);

  assert.equal(ownerResult.choices[0].message.content, "continued exactly once");
  assert.equal(duplicateResult.choices[0].message.content, "continued exactly once");
  assert.equal(replay.choices[0].message.content, "continued exactly once");
  assert.equal(client.starts.length, 1);
  assert.equal(client.resumes.length, 1);
  assert.equal(adapter.sessionCount, 0);
  await adapter.close();
});

test("a resumed tool chain replaces its claimed slot without cancelling or restarting itself", async () => {
  const client = fakeClient({
    startEvents: [{
      type: "tool_calls",
      calls: [{ callId: "call_first", name: "shell_command", arguments: { command: "node first.mjs" } }],
      continuation: { cascadeId: "chain-first" },
    }],
    resumeEvents: [{
      type: "tool_calls",
      calls: [{ callId: "call_second", name: "shell_command", arguments: { command: "node second.mjs" } }],
      continuation: { cascadeId: "chain-second" },
    }],
  });
  const adapter = createAntigravityChatAdapter({
    client,
    maxSessions: 1,
    idFactory: sequentialId(),
    now: () => 1_700_000_000_000,
  });
  const first = await adapter.complete(baseBody({
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }));
  const continuationBody = baseBody({ messages: [
    { role: "user", content: "run both in order" },
    { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
    { role: "tool", tool_call_id: "call_first", content: "first complete" },
  ] });

  const second = await adapter.complete(continuationBody);
  const replay = await adapter.complete(continuationBody);

  assert.equal(second.choices[0].message.tool_calls[0].id, "call_second");
  assert.equal(replay.choices[0].message.tool_calls[0].id, "call_second");
  assert.equal(client.starts.length, 1);
  assert.equal(client.resumes.length, 1);
  assert.deepEqual(client.cancels, []);
  assert.equal(adapter.sessionCount, 1);
  await adapter.close();
});

test("session TTL and max-size eviction cancel retained Cascades", async () => {
  const timers = manualTimers();
  const client = fakeClient({
    startEventsFactory: (index) => [{
      type: "tool_calls",
      calls: [{ callId: `call_${index}`, name: "read_file", arguments: {} }],
      continuation: { cascadeId: `cascade_${index}` },
    }],
  });
  const adapter = createAntigravityChatAdapter({
    client,
    maxSessions: 1,
    sessionTtlMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    idFactory: sequentialId(),
    now: () => 1_700_000_000_000,
  });

  await adapter.complete(baseBody());
  await adapter.complete(baseBody());
  assert.equal(adapter.sessionCount, 1);
  assert.deepEqual(client.cancels.map((item) => item.cascadeId), ["cascade_1"]);
  await timers.fireAll();
  assert.equal(adapter.sessionCount, 0);
  assert.deepEqual(client.cancels.map((item) => item.cascadeId), ["cascade_1", "cascade_2"]);
  await adapter.close();
});

test("maps authentication, quota, network and timeout failures without retrying", async () => {
  for (const [input, expected] of [
    [Object.assign(new Error("login required"), { statusCode: 401 }), [401, "authentication_error"]],
    [Object.assign(new Error("RESOURCE_EXHAUSTED"), { statusCode: 429 }), [429, "quota_exceeded"]],
    [Object.assign(new Error("User location is not supported for the API use."), { statusCode: 400 }), [400, "unsupported_location"]],
    [Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }), [502, "upstream_network_error"]],
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), [504, "upstream_timeout"]],
  ]) {
    const client = fakeClient({ startError: input });
    const adapter = createAdapter(client);
    await assert.rejects(
      adapter.complete(baseBody()),
      (error) => error instanceof ChatAdapterError
        && error.statusCode === expected[0]
        && error.code === expected[1],
    );
    assert.equal(client.starts.length, 1);
    await adapter.close();
  }
});

test("aborted requests reach the Cascade client and emit no terminal chunk", async () => {
  const observed = { aborted: false };
  const client = fakeClient({
    startEvents: async function* ({ signal }) {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          observed.aborted = true;
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      yield { type: "done" };
    },
  });
  const adapter = createAdapter(client);
  const controller = new AbortController();
  const iterator = adapter.stream(baseBody(), { signal: controller.signal });
  const first = await iterator.next();
  assert.equal(first.value.choices[0].delta.role, "assistant");
  const pending = iterator.next();
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(observed.aborted, true);
  await adapter.close();
});

function baseBody(overrides = {}) {
  return {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "do the task" }],
    ...overrides,
  };
}

function createAdapter(client) {
  return createAntigravityChatAdapter({
    client,
    idFactory: sequentialId(),
    now: () => 1_700_000_000_000,
  });
}

function fakeClient(options = {}) {
  let startIndex = 0;
  return {
    starts: [],
    resumes: [],
    cancels: [],
    async listModels() {
      return [{ id: "gemini-pro-agent", displayName: "Gemini Pro" }];
    },
    async getReadiness() {
      return options.readiness ?? {
        signedIn: false,
        accountFingerprint: "",
        planName: "",
      };
    },
    start(request) {
      this.starts.push(request);
      startIndex += 1;
      if (options.startError) return throwingIterable(options.startError);
      const events = typeof options.startEventsFactory === "function"
        ? options.startEventsFactory(startIndex)
        : options.startEvents;
      return asIterable(events, request);
    },
    resume(continuation, results, request) {
      this.resumes.push({ continuation, results, request });
      if (options.resumeError) return throwingIterable(options.resumeError);
      return asIterable(options.resumeEvents, request);
    },
    async cancel(continuation) {
      this.cancels.push(continuation);
    },
  };
}

function asIterable(events, request) {
  if (typeof events === "function") return events(request);
  return (async function* () {
    for (const event of events ?? []) yield event;
  }());
}

function throwingIterable(error) {
  return (async function* () {
    throw error;
  }());
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function sequentialId() {
  let value = 0;
  return () => `chatcmpl_test_${++value}`;
}

function manualTimers() {
  const active = new Set();
  return {
    setTimer(callback) {
      const timer = { callback };
      active.add(timer);
      return timer;
    },
    clearTimer(timer) {
      active.delete(timer);
    },
    async fireAll() {
      for (const timer of [...active]) {
        active.delete(timer);
        await timer.callback();
      }
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error("condition did not become true before timeout");
}
