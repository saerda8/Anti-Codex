import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAntigravityCascadeClient,
  extractAvailableModelEntries,
} from "../provider/antigravity-cascade-client.mjs";
import { createAntigravityChatAdapter } from "../provider/antigravity-chat-adapter.mjs";
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

test("extracts in-progress planner text for incremental streaming", () => {
  assert.equal(typeof cascadeClientModule.extractAssistantTextAfter, "function");
  assert.equal(cascadeClientModule.extractAssistantTextAfter({
    trajectory: {
      steps: [{
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        status: "CORTEX_STEP_STATUS_IN_PROGRESS",
        plannerResponse: { response: "partial" },
      }],
    },
  }), "partial");
});

test("accepts only canonical loopback address forms with a valid port", () => {
  const cases = [
    ["127.0.0.1:43210", "127.0.0.1:43210"],
    ["localhost:43210", "127.0.0.1:43210"],
    ["http://127.0.0.1:43210", "127.0.0.1:43210"],
    ["https://localhost:43210/", "127.0.0.1:43210"],
    ["[::1]:43210", "[::1]:43210"],
    ["::1:43210", "[::1]:43210"],
    ["http://[::1]:43210/", "[::1]:43210"],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(
      cascadeClientModule.discoverAntigravityDesktopConnection({
        ANTIGRAVITY_LS_ADDRESS: input,
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
      }),
      {
        lsAddress: expected,
        agentApiAddress: expected,
        csrfToken: "csrf",
      },
      input,
    );
  }
});

test("rejects non-loopback and ambiguous explicit addresses before a CSRF-bearing request", async () => {
  const rejected = [
    "0.0.0.0:43210",
    "10.0.0.1:43210",
    "192.168.1.1:43210",
    "8.8.8.8:43210",
    "localhost.evil.test:43210",
    "127.0.0.1.evil.test:43210",
    "user@localhost:43210",
    "http://user@localhost:43210",
    "http://localhost:43210/path",
    "http://localhost:43210?next=evil.test",
    "http://localhost:43210/#fragment",
    "file://localhost:43210",
    "127.0.0.1",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:not-a-port",
  ];

  for (const address of rejected) {
    assert.throws(
      () => cascadeClientModule.discoverAntigravityDesktopConnection({
        ANTIGRAVITY_LS_ADDRESS: address,
        ANTIGRAVITY_CSRF_TOKEN: "must-not-leak",
      }),
      /loopback host with a valid port/i,
      address,
    );

    let requests = 0;
    const client = createAntigravityCascadeClient({
      connection: {
        lsAddress: address,
        agentApiAddress: address,
        csrfToken: "must-not-leak",
      },
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse(modelPayload());
      },
    });

    await assert.rejects(
      client.listModels(),
      /loopback host with a valid port/i,
      address,
    );
    assert.equal(requests, 0, address);
  }

  assert.throws(
    () => cascadeClientModule.discoverAntigravityDesktopConnection({
      ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:43210",
      ANTIGRAVITY_AGENTAPI_ADDRESS: "192.168.1.10:43211",
      ANTIGRAVITY_CSRF_TOKEN: "must-not-leak",
    }),
    /loopback host with a valid port/i,
  );
});

test("selects the language-server endpoint by protocol proof instead of port order", () => {
  const attempts = [];
  const selected = cascadeClientModule.selectAntigravityLanguageServerPort(
    [65001, 41001, 55001],
    (port) => {
      attempts.push(port);
      return port === 41001;
    },
  );
  assert.equal(selected, 41001);
  assert.deepEqual(attempts, [65001, 41001]);
});

test("reads only a bounded tail from desktop log files", async () => {
  const root = await mkdtemp(join(tmpdir(), "anticodex-antigravity-log-"));
  const file = join(root, "language_server.log");
  try {
    await writeFile(file, `${"old-line\n".repeat(100)}current-tail`, "utf8");
    const tail = cascadeClientModule.readBoundedLogTail(file, 64);
    assert.ok(Buffer.byteLength(tail, "utf8") <= 64);
    assert.match(tail, /current-tail$/);
    assert.doesNotMatch(tail, /^old-line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    { id: "gemini-pro-agent", model: "MODEL_PRO", displayName: "Gemini Pro", maxTokens: 272_000, internalModel: "MODEL_PRO" },
    { id: "gemini-flash-agent", model: "MODEL_FLASH", displayName: "Gemini Flash", maxTokens: 272_000, internalModel: "MODEL_FLASH" },
  ]);
  const readiness = await client.getReadiness();
  assert.equal(readiness.signedIn, true);
  assert.equal(readiness.planName, "Test Plan");
  assert.equal(readiness.tierName, "pro");
  assert.match(readiness.accountFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(service.calls.map((call) => call.method), ["GetAvailableModels", "GetUserStatus"]);
});

test("model normalization retains native capability fields", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse({
      response: {
        models: {
          "gemini-pro-agent": {
            model: "MODEL_PRO",
            displayName: "Gemini Pro",
            maxTokens: 1_048_576,
            supportsImages: true,
            supportsThinking: true,
            thinkingBudget: 8192,
            minThinkingBudget: 32,
          },
        },
        agentModelSorts: [{ groups: [{ modelIds: ["gemini-pro-agent"] }] }],
      },
    }),
  });
  const client = clientFor(service.fetch);

  assert.deepEqual(await client.listModels(), [{
    id: "gemini-pro-agent",
    model: "MODEL_PRO",
    displayName: "Gemini Pro",
    maxTokens: 1_048_576,
    supportsImages: true,
    supportsThinking: true,
    thinkingBudget: 8192,
    minThinkingBudget: 32,
    internalModel: "MODEL_PRO",
  }]);
});

test("rejects a selected model without a positive message-token limit before starting Cascade", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse({
      response: {
        models: {
          "gemini-pro-agent": {
            model: "MODEL_PRO",
            displayName: "Gemini Pro",
            maxTokens: 0,
          },
        },
        agentModelSorts: [{ groups: [{ modelIds: ["gemini-pro-agent"] }] }],
      },
    }),
    StartCascade: () => jsonResponse({ cascadeId: "must_not_start" }),
  });
  const client = clientFor(service.fetch);

  await assert.rejects(
    collect(client.start({ model: "gemini-pro-agent", userText: "hello", tools: [] })),
    /positive maxTokens/i,
  );
  assert.deepEqual(service.calls.map((call) => call.method), ["GetAvailableModels"]);
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
    { type: "ready" },
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
  assert.equal(send.body.cascadeConfig.plannerConfig.maxMessageTokens, 272_000);
  assert.equal(send.body.cascadeConfig.plannerConfig.toolConfig.runCommand.forceDisable, true);
  assert.equal(Object.hasOwn(start.body, "cwd"), false);
});

test("sends image inputs through the Cascade request image field", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_image" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: () => jsonResponse({}),
    GetCascadeTrajectory: () => jsonResponse(completedTrajectory("ok")),
  });
  const client = clientFor(service.fetch);
  await collect(client.start({
    model: "gemini-pro-agent",
    userText: "看图",
    userItems: [
      { text: "看图" },
      { image: { data: "AA==", mimeType: "image/png" } },
    ],
    tools: [],
  }));
  const send = service.calls.find((call) => call.method === "SendUserCascadeMessage");
  assert.deepEqual(send.body.items, [{ text: "看图" }]);
  assert.deepEqual(send.body.images, [{ base64Data: "AA==", mimeType: "image/png" }]);
});

test("emits planner text deltas while a Cascade is still running", async () => {
  let trajectoryCalls = 0;
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_incremental" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({});
    },
    GetCascadeTrajectory: () => {
      trajectoryCalls += 1;
      return jsonResponse(completedTrajectory(["A", "AB", "ABC"][Math.min(trajectoryCalls - 1, 2)], "CORTEX_STEP_STATUS_IN_PROGRESS"));
    },
  });
  const client = clientFor(service.fetch, { pollIntervalMs: 1, timeoutMs: 1000 });
  const events = await collect(client.start({ model: "gemini-pro-agent", userText: "hello", tools: [] }));
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["A", "B", "C"]);
});

test("native custom instructions reach final Cascade once while joined environment context stays untrusted", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_native_custom" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: () => jsonResponse({}),
    GetCascadeTrajectory: () => jsonResponse(completedTrajectory("done")),
  });
  const customInstructions = "Use concise Chinese replies.";
  const wrapper = `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${customInstructions}\n</INSTRUCTIONS>`;
  const environmentContext = "<environment_context>\n  <cwd>G:\\project</cwd>\n</environment_context>";
  const resumedEnvironmentContext = "<environment_context>\n  <cwd>G:\\project-resumed</cwd>\n</environment_context>";
  const adapter = createAntigravityChatAdapter({
    client: clientFor(service.fetch),
    nativeCustomInstructions: () => customInstructions,
  });

  await adapter.complete({
    model: "gemini-pro-agent",
    messages: [
      { role: "user", content: `${wrapper}\n${environmentContext}` },
      { role: "user", content: `${wrapper}\n${resumedEnvironmentContext}` },
      { role: "user", content: "current user text" },
    ],
  });

  const start = service.calls.find((call) => call.method === "StartCascade");
  const sections = start.body.customAgentSpec.customAgent.systemPromptSections;
  const native = sections.filter((section) => section.title === "Codex native custom instructions (AGENTS.md)");
  assert.equal(native.length, 1);
  assert.equal(native[0].content, customInstructions);
  assert.equal(native[0].metadata.contentTrust, undefined);
  const history = sections.find((section) => section.title === "Prior Chat Completions messages");
  assert.equal(history.metadata.contentTrust, "untrusted_transcript");
  assert.equal(history.content, [environmentContext, resumedEnvironmentContext]
    .map((content) => JSON.stringify({ role: "user", content }))
    .join("\n"));
  assert.equal(history.content.includes("# AGENTS.md instructions"), false);
  await adapter.close();
});

test("omits data-image payloads from text-rendered chat history", async () => {
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_image_history" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: () => jsonResponse({}),
    GetCascadeTrajectory: () => jsonResponse(completedTrajectory("continued")),
  });
  const client = clientFor(service.fetch);
  await collect(client.start({
    model: "gemini-pro-agent",
    userText: "continue",
    systemSections: [{
      kind: "chat_history",
      title: "Prior Chat Completions messages",
      messages: [{
        role: "tool",
        tool_call_id: "call_image",
        content: [
          { type: "text", text: "Rendered frame" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${"A".repeat(10_000)}` },
          },
        ],
      }],
    }],
    tools: [],
  }));

  const start = service.calls.find((call) => call.method === "StartCascade");
  const history = start.body.customAgentSpec.customAgent.systemPromptSections[0].content;
  assert.match(history, /Rendered frame/u);
  assert.match(history, /call_image/u);
  assert.match(history, /\[historical image omitted: image\/png\]/u);
  assert.doesNotMatch(history, /A{64}/u);
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
  const discoveredTools = [{ type: "function", function: { name: "mcp__node_repl__js", parameters: { type: "object", properties: { code: { type: "string" } } } } }];
  let updatedTools = null;
  bridge.updateTools = (tools) => { updatedTools = tools; };
  const completeCall = bridge.completeCall;
  bridge.completeCall = (...args) => {
    assert.deepEqual(updatedTools, discoveredTools, "new tool schemas must be registered before the old result resumes the model");
    return completeCall.apply(bridge, args);
  };
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
  const firstItem = await nextAfterReady(firstIterator);
  assert.equal(firstItem.done, false);
  await firstIterator.return();
  const firstEvents = [firstItem.value];
  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0].type, "tool_calls");
  const toolCompatibility = bridgeOptions.systemPromptSections.find((section) => section.title === "Anti-Codex Antigravity tool compatibility");
  assert.match(toolCompatibility.content, /Never call functions\.exec or functions\.apply_patch/);
  assert.deepEqual(firstEvents[0].calls, [{
    callId: "bridge_call_1",
    name: "read_file",
    arguments: { path: "a.txt" },
  }]);
  assert.equal(firstEvents[0].continuation.cascadeId, "cascade_tool");
  assert.equal(bridge.closed, false);
  assert.equal(bridgeOptions.systemPromptSections[0].content, "use tools");
  assert.ok(bridgeOptions.pendingCallTimeoutMs > 10 * 60 * 1000);
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
    { tools: discoveredTools },
  ));
  assert.deepEqual(bridge.completions, [{
    callId: "bridge_call_1",
    output: "EXACT\r\nRESULT",
    isError: false,
  }]);
  assert.deepEqual(secondEvents, [
    { type: "ready" },
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
  const first = await nextAfterReady(iterator);
  await iterator.return();

  assert.deepEqual(first.value.calls, [{
    callId: "bridge_alias_1",
    name: "shell_command",
    arguments: { command: "npm test" },
  }]);
});

test("captures queued MCP calls when Antigravity renders them as generic steps", async () => {
  const bridge = {
    ...fakeBridge(),
    tools: [{ name: "exec_command", description: "Run", inputSchema: { type: "object" } }],
    takeCalls() {
      return [{ callId: "bridge_generic_1", name: "exec_command", arguments: { cmd: "Get-Location" } }];
    },
  };
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_generic" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => abortableResponse(signal),
    GetCascadeTrajectory: () => jsonResponse({
      trajectory: {
        trajectoryId: "trajectory_generic",
        steps: [
          { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
          { type: "CORTEX_STEP_TYPE_GENERIC", status: "CORTEX_STEP_STATUS_RUNNING", metadata: {
            toolCall: { id: "generic_1", name: "exec_command", argumentsJson: "{\"cmd\":\"Get-Location\"}" },
          } },
        ],
      },
    }),
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, { createToolBridge: async () => bridge });
  const iterator = client.start({
    model: "gemini-pro-agent",
    userText: "run the command",
    systemSections: [],
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
  })[Symbol.asyncIterator]();
  const first = await nextAfterReady(iterator);
  assert.deepEqual(first.value.calls, [{
    callId: "bridge_generic_1",
    name: "exec_command",
    arguments: { cmd: "Get-Location" },
  }]);
  await iterator.return();
});

test("pairs parallel native calls by call identity instead of arrival order", async () => {
  let approvals = 0;
  const queued = [
    { callId: "bridge_b", nativeCallId: "rpc_b", name: "tool_b", arguments: { value: "B" } },
    { callId: "bridge_a", nativeCallId: "rpc_a", name: "tool_a", arguments: { value: "A" } },
  ];
  const bridge = {
    ...fakeBridge(),
    tools: [
      { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "B", inputSchema: { type: "object" } },
    ],
    async waitForCall() {
      assert.equal(approvals, 2, "all parallel interactions must be approved before awaiting calls");
      return queued.shift();
    },
  };
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_parallel_identity" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => abortableResponse(signal),
    GetCascadeTrajectory: () => jsonResponse({
      trajectory: {
        trajectoryId: "trajectory_parallel_identity",
        steps: [
          waitingToolStep("native_a", "tool_a", { value: "A" }, 1),
          waitingToolStep("native_b", "tool_b", { value: "B" }, 2),
        ],
      },
    }),
    HandleCascadeUserInteraction: () => {
      approvals += 1;
      return jsonResponse({});
    },
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, { createToolBridge: async () => bridge });
  const iterator = client.start({
    model: "gemini-pro-agent",
    userText: "run both",
    tools: [
      { type: "function", function: { name: "tool_a", parameters: { type: "object" } } },
      { type: "function", function: { name: "tool_b", parameters: { type: "object" } } },
    ],
  })[Symbol.asyncIterator]();

  const first = await nextAfterReady(iterator);
  await iterator.return();
  assert.deepEqual(first.value.calls, [
    { callId: "bridge_a", name: "tool_a", arguments: { value: "A" } },
    { callId: "bridge_b", name: "tool_b", arguments: { value: "B" } },
  ]);
});

test("exact native IDs disambiguate identical parallel calls", async () => {
  let approvals = 0;
  const queued = [
    { callId: "bridge_b", nativeCallId: "native_b", name: "same_tool", arguments: { value: 1 } },
    { callId: "bridge_a", nativeCallId: "native_a", name: "same_tool", arguments: { value: 1 } },
  ];
  const bridge = {
    ...fakeBridge(),
    tools: [{ name: "same_tool", description: "Same", inputSchema: { type: "object" } }],
    async waitForCall() {
      assert.equal(approvals, 2);
      return queued.shift();
    },
  };
  const service = fakeService({
    GetAvailableModels: () => jsonResponse(modelPayload()),
    StartCascade: () => jsonResponse({ cascadeId: "cascade_identical_parallel" }),
    SendUserCascadeMessage: () => jsonResponse({}),
    WaitForConversationFullyIdle: ({ signal }) => abortableResponse(signal),
    GetCascadeTrajectory: () => jsonResponse({
      trajectory: {
        trajectoryId: "trajectory_identical_parallel",
        steps: [
          waitingToolStep("native_a", "same_tool", { value: 1 }, 1),
          waitingToolStep("native_b", "same_tool", { value: 1 }, 2),
        ],
      },
    }),
    HandleCascadeUserInteraction: () => {
      approvals += 1;
      return jsonResponse({});
    },
    CancelCascadeInvocation: () => jsonResponse({}),
  });
  const client = clientFor(service.fetch, { createToolBridge: async () => bridge });
  const iterator = client.start({
    model: "gemini-pro-agent",
    userText: "run identical calls",
    tools: [{ type: "function", function: { name: "same_tool", parameters: { type: "object" } } }],
  })[Symbol.asyncIterator]();

  const first = await nextAfterReady(iterator);
  await iterator.return();
  assert.deepEqual(first.value.calls, [
    { callId: "bridge_a", name: "same_tool", arguments: { value: 1 } },
    { callId: "bridge_b", name: "same_tool", arguments: { value: 1 } },
  ]);
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
  const first = await nextAfterReady(firstIterator);
  await firstIterator.return();

  const resumed = await collect(client.resume(
    first.value.continuation,
    [{ callId: "bridge_call_1", output: "EXACT RESULT", isError: false }],
    {},
  ));

  assert.equal(resumeIdleCalls, 2);
  assert.equal(bridge.completions.length, 1);
  assert.deepEqual(resumed, [
    { type: "ready" },
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
  const first = await nextAfterReady(firstIterator);
  await firstIterator.return();

  const resumed = await collect(client.resume(
    first.value.continuation,
    [{ callId: "bridge_call_1", output: "EXACT RESULT", isError: false }],
    {},
  ));

  assert.equal(resumeIdleCalls, 5);
  assert.equal(bridge.completions.length, 1);
  assert.deepEqual(resumed, [
    { type: "ready" },
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

async function nextAfterReady(iterator) {
  const ready = await iterator.next();
  assert.equal(ready.done, false);
  assert.deepEqual(ready.value, { type: "ready" });
  return iterator.next();
}

function modelPayload() {
  return {
    response: {
      models: {
        "gemini-pro-agent": { model: "MODEL_PRO", displayName: "Gemini Pro", maxTokens: 272_000 },
        "gemini-flash-agent": { model: "MODEL_FLASH", displayName: "Gemini Flash", maxTokens: 272_000 },
        "tab-internal-preview": { model: "MODEL_TAB_INTERNAL", displayName: "tab-internal-preview" },
      },
      agentModelSorts: [{ groups: [{ modelIds: ["gemini-pro-agent", "gemini-flash-agent"] }] }],
    },
  };
}

function completedTrajectory(text, status = "CORTEX_STEP_STATUS_DONE") {
  return {
    trajectory: {
      trajectoryId: "trajectory_1",
      steps: [
        { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status,
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

function waitingToolStep(id, name, argumentsValue, stepIndex) {
  return {
    type: "CORTEX_STEP_TYPE_MCP_TOOL",
    status: "CORTEX_STEP_STATUS_WAITING",
    mcpTool: {
      toolCall: {
        id,
        name,
        argumentsJson: JSON.stringify(argumentsValue),
      },
    },
    metadata: {
      sourceTrajectoryStepInfo: {
        trajectoryId: "trajectory_parallel_identity",
        stepIndex,
      },
    },
    requestedInteraction: { interaction: { case: "mcp" } },
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
