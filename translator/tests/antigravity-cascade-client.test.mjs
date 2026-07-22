import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createAntigravityCascadeClient,
  extractAvailableModelEntries,
} from "../provider/antigravity-cascade-client.mjs";
import * as cascadeClientModule from "../provider/antigravity-cascade-client.mjs";

test("extracts only loopback listening ports owned by the Antigravity process", () => {
  const netstat = [
    "  TCP    127.0.0.1:57882      0.0.0.0:0       LISTENING       33752",
    "  TCP    [::1]:57883          [::]:0          LISTENING       33752",
    "  TCP    0.0.0.0:57884        0.0.0.0:0       LISTENING       33752",
    "  TCP    10.0.0.5:57885       0.0.0.0:0       LISTENING       33752",
    "  TCP    127.0.0.1:57886      0.0.0.0:0       ESTABLISHED     33752",
    "  TCP    127.0.0.1:57887      0.0.0.0:0       LISTENING       100",
  ].join("\r\n");

  assert.equal(typeof cascadeClientModule.extractListeningPortsForProcess, "function");
  assert.deepEqual(cascadeClientModule.extractListeningPortsForProcess(netstat, 33752), [57882, 57883, 57884]);
});

test("discovers the current Antigravity connection from official desktop logs", () => {
  const mainLog = [
    "Spawning: language_server.exe --csrf_token stale-token --app_data_dir antigravity",
    "Spawning: language_server.exe --standalone --csrf_token current-token --app_data_dir antigravity --enable_sidecars",
  ].join("\n");
  const languageServerLog = [
    "I server.go:493] Language server listening on random port at 54518 for HTTPS (gRPC)",
    "I server.go:500] Language server listening on random port at 54519 for HTTP",
  ].join("\n");

  assert.equal(typeof cascadeClientModule.extractAntigravityConnectionFromLogs, "function");
  assert.deepEqual(
    cascadeClientModule.extractAntigravityConnectionFromLogs(mainLog, languageServerLog),
    {
      agentApiAddress: "127.0.0.1:54518",
      lsAddress: "127.0.0.1:54519",
      csrfToken: "current-token",
    },
  );
});

test("official desktop logs override an older Anti-Codex launch log", async () => {
  const source = await readFile(new URL("../provider/antigravity-cascade-client.mjs", import.meta.url), "utf8");
  const pathsStart = source.indexOf("const mainLogPaths = [");
  const pathsEnd = source.indexOf("].filter(Boolean);", pathsStart);
  const pathsBlock = source.slice(pathsStart, pathsEnd);

  assert.ok(pathsBlock.indexOf('join(stateRoot, "antigravity-desktop.out.log")') >= 0);
  assert.ok(pathsBlock.indexOf('join(appData, "Antigravity", "logs", "main.log")') >= 0);
  assert.ok(
    pathsBlock.indexOf('join(stateRoot, "antigravity-desktop.out.log")')
      < pathsBlock.indexOf('join(appData, "Antigravity", "logs", "main.log")'),
    "the current official desktop token must be parsed after the stale launcher log",
  );
});

test("discovers standard model metadata and account readiness through the local service", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    GetUserStatus: () => jsonResponse({
      userStatus: {
        email: "user@example.test",
        planStatus: { planInfo: { planName: "Test Plan" } },
        userTier: { name: "pro" },
      },
    }),
  });
  const client = clientFor(service.fetch);

  assert.deepEqual(extractAvailableModelEntries(modelPayload()).map((entry) => entry.id), [
    "gemini-pro-agent",
    "gemini-flash-agent",
  ]);
  assert.deepEqual(await client.listModels(), [
    { id: "gemini-pro-agent", displayName: "Gemini Pro", internalModel: "MODEL_PRO" },
    { id: "gemini-flash-agent", displayName: "Gemini Flash", internalModel: "MODEL_FLASH" },
  ]);
  const readiness = await client.getReadiness();
  assert.equal(readiness.signedIn, true);
  assert.equal(readiness.planName, "Test Plan");
  assert.equal(readiness.tierName, "pro");
  assert.match(readiness.accountFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(service.calls.map((call) => call.method), ["GetAvailableModels", "GetUserStatus"]);
});

test("starts a workspace-blind Cascade and returns one text terminal outcome", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_text" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: () => jsonResponse({}),
    GetCascadeTrajectory: () => jsonResponse(completedTrajectory("final text")),
  });
  const client = clientFor(service.fetch);
  const events = await collect(client.start({
    model: "gemini-pro-agent",
    userText: "current user text",
    systemSections: [
      { role: "system", title: "System", content: "trusted system" },
      {
        kind: "chat_history",
        role: "internal",
        title: "Prior Chat Completions messages",
        contentTrust: "untrusted_transcript",
        messages: [{ role: "user", content: "old" }],
      },
    ],
    tools: [],
  }));

  assert.deepEqual(events, [
    { type: "text_delta", delta: "final text" },
    { type: "done", result: { cascadeId: "cascade_text", model: "gemini-pro-agent" } },
  ]);
  const start = service.calls.find((call) => call.method === "StartCascade");
  assert.deepEqual(start.body.workspaceUris, []);
  assert.equal(start.body.customAgentSpec.customAgent.systemPromptSections.length, 3);
  assert.equal(start.body.customAgentSpec.customAgent.systemPromptSections[1].metadata.contentTrust, "untrusted_transcript");
  assert.equal(start.body.customAgentSpec.customAgent.systemPromptSections[1].content, "{\"role\":\"user\",\"content\":\"old\"}");
  const textOnly = start.body.customAgentSpec.customAgent.systemPromptSections[2];
  assert.equal(textOnly.title, "Anti-Codex Antigravity text-only compatibility");
  assert.match(textOnly.content, /No Chat tools are supplied/u);
  assert.match(textOnly.content, /execute_command/u);
  assert.match(textOnly.content, /private provider state/u);
  const send = service.calls.find((call) => call.method === "SendUserCascadeMessage");
  assert.deepEqual(send.body.items, [{ text: "current user text" }]);
  assert.equal(send.body.blocking, false);
  assert.equal(send.body.cascadeConfig.plannerConfig.planModel, "MODEL_PRO");
  assert.equal(send.body.cascadeConfig.plannerConfig.toolConfig.runCommand.forceDisable, true);
  assert.equal(Object.hasOwn(start.body, "cwd"), false);
});

test("gives Cascade startup a bounded 60 second default while preserving explicit overrides", async () => {
  assert.equal(cascadeClientModule.DEFAULT_START_TIMEOUT_MS, 60_000);

  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: ({ signal }) => abortableResponse(signal),
  });
  const client = clientFor(service.fetch, { startTimeoutMs: 10 });

  await assert.rejects(
    collect(client.start({
      model: "gemini-pro-agent",
      userText: "timeout override",
      tools: [],
    })),
    /StartCascade timed out after 10ms/u,
  );
});

test("classifies unsupported-location trajectories as non-retryable client errors", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_region_blocked" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => abortableResponse(signal),
    GetCascadeTrajectory: () => jsonResponse({
      trajectory: {
        steps: [{
          errorMessage: {
            error: {
              modelErrorMessage: "FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
            },
          },
        }],
      },
    }),
  });
  const client = clientFor(service.fetch);

  await assert.rejects(
    collect(client.start({
      model: "gemini-pro-agent",
      userText: "region probe",
      tools: [],
    })),
    (error) => error.statusCode === 400 && /location is not supported/i.test(error.message),
  );
});

test("captures a native MCP call and resumes the exact same Cascade with the exact result", async () => {
  let phase = "start";
  let resumeTrajectoryReads = 0;
  let bridgeOptions = null;
  const bridge = fakeBridge(() => { phase = "resume"; });
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_tool" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => phase === "resume"
      ? jsonResponse({})
      : abortableResponse(signal),
    GetCascadeTrajectory: () => {
      if (phase !== "resume") return jsonResponse(waitingToolTrajectory());
      resumeTrajectoryReads += 1;
      return resumeTrajectoryReads === 1
        ? jsonResponse(waitingToolTrajectory())
        : jsonResponse(completedTrajectory("tool accepted"));
    },
    HandleCascadeUserInteraction: () => jsonResponse({}),
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, {
    createToolBridge: async (options) => {
      bridgeOptions = options;
      return bridge;
    },
  });

  const firstIterator = client.start({
    model: "gemini-pro-agent",
    userText: "read a file",
    systemSections: [{ role: "system", title: "System", content: "use tools" }],
    tools: [{
      type: "function",
      function: { name: "read_file", description: "Read", parameters: { type: "object" } },
    }],
  })[Symbol.asyncIterator]();
  const firstItem = await firstIterator.next();
  assert.equal(firstItem.done, false);
  await firstIterator.return();
  const firstEvents = [firstItem.value];
  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0].type, "tool_calls");
  assert.deepEqual(firstEvents[0].calls, [{
    callId: "bridge_call_1",
    name: "read_file",
    arguments: { path: "a.txt" },
  }]);
  assert.equal(firstEvents[0].continuation.cascadeId, "cascade_tool");
  assert.equal(bridge.closed, false);
  assert.equal(bridgeOptions.systemPromptSections[0].content, "use tools");
  const compatibility = bridgeOptions.systemPromptSections.at(-1);
  assert.equal(compatibility.title, "Anti-Codex Antigravity tool compatibility");
  assert.match(compatibility.content, /first visible progress sentence of every turn must be Chinese/u);
  assert.match(compatibility.content, /never emit an English progress sentence before the first tool call/u);
  assert.match(compatibility.content, /\.gemini\/antigravity\/brain/u);
  assert.match(compatibility.content, /narrower command.*user workspace/u);
  const interaction = service.calls.find((call) => call.method === "HandleCascadeUserInteraction");
  assert.deepEqual(interaction.body, {
    cascadeId: "cascade_tool",
    interaction: { trajectoryId: "trajectory_1", stepIndex: 2, mcp: { confirm: true } },
  });

  const secondEvents = await collect(client.resume(
    firstEvents[0].continuation,
    [{ callId: "bridge_call_1", output: "EXACT\r\nRESULT", isError: false }],
    {},
  ));
  assert.deepEqual(bridge.completions, [{
    callId: "bridge_call_1",
    output: "EXACT\r\nRESULT",
    isError: false,
  }]);
  assert.deepEqual(secondEvents, [
    { type: "text_delta", delta: "tool accepted" },
    { type: "done", result: { cascadeId: "cascade_tool", model: "gemini-pro-agent" } },
  ]);
  assert.equal(bridge.closed, true);
  assert.equal(service.calls.filter((call) => call.method === "StartCascade").length, 1);
});

test("returns the canonical Codex name for an Antigravity native tool alias", async () => {
  const bridge = fakeBridge();
  bridge.tools.push({ name: "command", description: "Shell alias", inputSchema: { type: "object" } });
  bridge.waitForCall = async () => ({
    callId: "bridge_alias_1",
    name: "shell_command",
    nativeName: "command",
    arguments: { command: "npm test" },
  });
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_alias" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => abortableResponse(signal),
    GetCascadeTrajectory: () => jsonResponse({
      trajectory: {
        trajectoryId: "trajectory_alias",
        steps: [{
          type: "CORTEX_STEP_TYPE_MCP_TOOL",
          status: "CORTEX_STEP_STATUS_WAITING",
          mcpTool: {
            toolCall: {
              id: "native_alias_1",
              name: "command",
              argumentsJson: "{\"command\":\"npm test\"}",
            },
          },
        }],
      },
    }),
    HandleCascadeUserInteraction: () => jsonResponse({}),
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, { createToolBridge: async () => bridge });

  const iterator = client.start({
    model: "gemini-pro-agent",
    userText: "run tests",
    systemSections: [],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  })[Symbol.asyncIterator]();
  const first = await iterator.next();
  await iterator.return();

  assert.deepEqual(first.value.calls, [{
    callId: "bridge_alias_1",
    name: "shell_command",
    arguments: { command: "npm test" },
  }]);
});

test("retries a transient empty-trajectory idle race without replaying the tool result", async () => {
  let phase = "start";
  let resumeIdleCalls = 0;
  const bridge = fakeBridge(() => { phase = "resume"; });
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_idle_race" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => {
      if (phase !== "resume") return abortableResponse(signal);
      resumeIdleCalls += 1;
      return resumeIdleCalls === 1
        ? jsonResponse({ code: "internal", message: "internal: trajectory converted to zero chat messages" }, 500)
        : jsonResponse({});
    },
    GetCascadeTrajectory: () => jsonResponse(phase === "resume"
      ? completedTrajectory("continued after idle race")
      : waitingToolTrajectory()),
    HandleCascadeUserInteraction: () => jsonResponse({}),
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, {
    createToolBridge: async () => bridge,
    pollIntervalMs: 1,
  });

  const firstIterator = client.start({
    model: "gemini-pro-agent",
    userText: "use one tool",
    systemSections: [],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  })[Symbol.asyncIterator]();
  const first = await firstIterator.next();
  await firstIterator.return();

  const resumed = await collect(client.resume(
    first.value.continuation,
    [{ callId: "bridge_call_1", output: "EXACT RESULT", isError: false }],
    {},
  ));

  assert.equal(resumeIdleCalls, 2);
  assert.equal(bridge.completions.length, 1);
  assert.deepEqual(resumed, [
    { type: "text_delta", delta: "continued after idle race" },
    { type: "done", result: { cascadeId: "cascade_idle_race", model: "gemini-pro-agent" } },
  ]);
  assert.equal(service.calls.filter((call) => call.method === "StartCascade").length, 1);
  assert.equal(service.calls.filter((call) => call.method === "CancelCascadeInvocation").length, 0);
});

test("waits through successful stale idle snapshots after a tool result without replaying it", async () => {
  let phase = "start";
  let resumeIdleCalls = 0;
  let resumeTrajectoryReads = 0;
  const bridge = fakeBridge(() => { phase = "resume"; });
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_stale_idle" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => {
      if (phase !== "resume") return abortableResponse(signal);
      resumeIdleCalls += 1;
      return jsonResponse({});
    },
    GetCascadeTrajectory: () => {
      if (phase !== "resume") return jsonResponse(waitingToolTrajectory());
      resumeTrajectoryReads += 1;
      return resumeTrajectoryReads <= 8
        ? jsonResponse(waitingToolTrajectory())
        : jsonResponse(completedTrajectory("continued after stale idle snapshots"));
    },
    HandleCascadeUserInteraction: () => jsonResponse({}),
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, {
    createToolBridge: async () => bridge,
    pollIntervalMs: 1,
  });

  const firstIterator = client.start({
    model: "gemini-pro-agent",
    userText: "use one tool",
    systemSections: [],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  })[Symbol.asyncIterator]();
  const first = await firstIterator.next();
  await firstIterator.return();

  const resumed = await collect(client.resume(
    first.value.continuation,
    [{ callId: "bridge_call_1", output: "EXACT RESULT", isError: false }],
    {},
  ));

  assert.equal(resumeIdleCalls, 5);
  assert.equal(bridge.completions.length, 1);
  assert.deepEqual(resumed, [
    { type: "text_delta", delta: "continued after stale idle snapshots" },
    { type: "done", result: { cascadeId: "cascade_stale_idle", model: "gemini-pro-agent" } },
  ]);
  assert.equal(service.calls.filter((call) => call.method === "StartCascade").length, 1);
  assert.equal(service.calls.filter((call) => call.method === "CancelCascadeInvocation").length, 0);
});

test("abort propagates to the local service, cancels the Cascade and closes its bridge", async () => {
  const bridge = fakeBridge();
  let pollingStarted;
  const pollStarted = new Promise((resolve) => { pollingStarted = resolve; });
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_abort" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => abortableResponse(signal),
    GetCascadeTrajectory: ({ signal }) => {
      pollingStarted();
      return abortableResponse(signal);
    },
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, { createToolBridge: async () => bridge });
  const controller = new AbortController();
  const running = collect(client.start({
    model: "gemini-pro-agent",
    userText: "wait",
    systemSections: [],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    signal: controller.signal,
  }));
  await pollStarted;
  controller.abort(new DOMException("caller stopped", "AbortError"));
  await assert.rejects(running, { name: "AbortError" });
  await waitFor(() => service.calls.some((call) => call.method === "CancelCascadeInvocation"));
  assert.equal(bridge.closed, true);
});

test("read-only discovery retries once on a stale desktop port but task creation never does", async () => {
  let discoveries = 0;
  const calls = [];
  const client = createAntigravityCascadeClient({
    discoverConnection: () => ({
      lsAddress: `127.0.0.1:${++discoveries === 1 ? 41001 : 41002}`,
      csrfToken: "csrf",
    }),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes(":41001/")) throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      return jsonResponse(modelPayload());
    },
  });

  const models = await client.listModels();
  assert.equal(models.length, 2);
  assert.equal(discoveries, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /:41001\//);
  assert.match(calls[1], /:41002\//);
});

test("provider boundary imports no legacy task controller or home-grown Responses module", async () => {
  const paths = [
    "translator/provider/antigravity-chat-adapter.mjs",
    "translator/provider/antigravity-chat-server.mjs",
    "translator/provider/antigravity-cascade-client.mjs",
    "translator/provider/start-antigravity-chat-provider.mjs",
  ];
  for (const path of paths) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["']\.\.\/(?:adaptive-server|server|antigravity-upstream|codex-native-(?:harness-turn|protocol|sse|compact)|response-history)\.mjs["']/);
    assert.doesNotMatch(source, /internalDeterministicTasks|runInternalToolLoop|synthesizeDeterministicTask|buildVerificationRecoveryMessages/);
  }
});

function clientFor(fetchImpl, overrides = {}) {
  return createAntigravityCascadeClient({
    connection: {
      lsAddress: "127.0.0.1:9999",
      agentApiAddress: "127.0.0.1:9998",
      csrfToken: "csrf",
    },
    fetchImpl,
    pollIntervalMs: 1,
    timeoutMs: 1000,
    ...overrides,
  });
}

function modelPayload() {
  return {
    response: {
      models: {
        "gemini-pro-agent": { model: "MODEL_PRO", displayName: "Gemini Pro" },
        "gemini-flash-agent": { model: "MODEL_FLASH", displayName: "Gemini Flash" },
        "tab-internal-preview": { model: "MODEL_TAB_INTERNAL", displayName: "tab-internal-preview" },
      },
      agentModelSorts: [{ groups: [{ modelIds: ["gemini-pro-agent", "gemini-flash-agent"] }] }],
    },
  };
}

function completedTrajectory(text) {
  return {
    trajectory: {
      trajectoryId: "trajectory_1",
      steps: [
        { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status: "CORTEX_STEP_STATUS_DONE",
          plannerResponse: { response: text },
        },
      ],
    },
  };
}

function waitingToolTrajectory() {
  return {
    trajectory: {
      trajectoryId: "trajectory_1",
      steps: [
        { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
        {
          type: "CORTEX_STEP_TYPE_MCP_TOOL",
          status: "CORTEX_STEP_STATUS_WAITING",
          mcpTool: {
            toolCall: {
              id: "native_call_1",
              name: "read_file",
              argumentsJson: "{\"path\":\"a.txt\"}",
            },
          },
          metadata: { sourceTrajectoryStepInfo: { trajectoryId: "trajectory_1", stepIndex: 2 } },
          requestedInteraction: { interaction: { case: "mcp" } },
        },
      ],
    },
  };
}

function fakeService(handlers) {
  const calls = [];
  return {
    calls,
    async fetch(url, init = {}) {
      const method = new URL(url).pathname.split("/").at(-1);
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method, body });
      const handler = handlers[method];
      if (!handler) throw Object.assign(new Error(`Unexpected service method: ${method}`), { code: "UNEXPECTED_METHOD" });
      return handler({ body, signal: init.signal, calls });
    },
  };
}

function fakeBridge(onComplete = () => {}) {
  return {
    tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
    customAgentSpec: {
      customizationConfig: { customizationServerUrl: "http://127.0.0.1:43123", toolNames: ["read_file"] },
      customTools: ["read_file"],
    },
    completions: [],
    closed: false,
    async waitForCall() {
      return { callId: "bridge_call_1", name: "read_file", arguments: { path: "a.txt" } };
    },
    takeCalls() {
      return [];
    },
    completeCall(callId, output, options = {}) {
      this.completions.push({ callId, output, isError: options.isError === true });
      onComplete();
      return true;
    },
    async close() {
      this.closed = true;
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortableResponse(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
