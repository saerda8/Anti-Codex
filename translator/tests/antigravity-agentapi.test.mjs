import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  antigravityAccountSnapshot,
  antigravityCliArgs,
  antigravityCliIsolationEnv,
  antigravityNativeToolCapabilitySummary,
  antigravityModelOnlyToolConfig,
  createDesktopConnectionCache,
  defaultAntigravityCliCommand,
  discoverProjectId,
  extractAssistantText,
  extractPendingNativeToolCalls,
  buildAntigravityMcpApprovalInteraction,
  buildAntigravityToolApprovalInteraction,
  handleAntigravityCascadeUserInteraction,
  extractAvailableAgentModelEntries,
  extractCliAssistantText,
  extractCreatedConversationId,
  extractConversationId,
  extractProtobufStrings,
  fetchAntigravityUserStatus,
  requestHeaders,
  resolveAntigravityModel,
  resumeAntigravityNativeTurnStreamed,
  runAntigravityNativeTurn,
  runAntigravityNativeTurnStreamed,
  windowsAntigravityCliInvocation,
} from "../antigravity-agentapi.mjs";

test("antigravity account snapshot exposes a stable fingerprint without account PII", () => {
  const snapshot = antigravityAccountSnapshot({
    userStatus: {
      name: "Example User",
      email: "Example.User@Example.com ",
      planStatus: {
        planInfo: {
          planName: "Antigravity Pro",
          maxNumChatInputTokens: "1000000",
          cascadeWebSearchEnabled: true,
          cascadeCanAutoRunCommands: false,
          browserEnabled: true,
        },
      },
      userTier: { name: "Pro" },
    },
  });

  assert.equal(snapshot.signedIn, true);
  assert.equal(snapshot.identityAvailable, true);
  assert.match(snapshot.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.planName, "Antigravity Pro");
  assert.equal(snapshot.tierName, "Pro");
  assert.equal(snapshot.maxInputTokens, "1000000");
  assert.equal(snapshot.webSearchEnabled, true);
  assert.equal(snapshot.browserEnabled, true);
  assert.equal(snapshot.autoRunCommandsEnabled, false);
  assert.equal(JSON.stringify(snapshot).includes("Example.User"), false);
  assert.equal(JSON.stringify(snapshot).includes("Example User"), false);
});

test("antigravity account snapshot does not invent identity proof when signed out", () => {
  const snapshot = antigravityAccountSnapshot({ userStatus: {} });
  assert.equal(snapshot.signedIn, false);
  assert.equal(snapshot.identityAvailable, false);
  assert.equal(snapshot.fingerprint, "");
});

test("fetchAntigravityUserStatus calls the desktop GetUserStatus service", async () => {
  const requests = [];
  const payload = await fetchAntigravityUserStatus({
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl: async (url, init) => {
      requests.push({
        method: String(url).split("/").at(-1),
        body: JSON.parse(init.body),
      });
      return jsonResponse({ userStatus: { email: "user@example.com" } });
    },
  });

  assert.equal(payload.userStatus.email, "user@example.com");
  assert.deepEqual(requests, [{ method: "GetUserStatus", body: {} }]);
});

test("desktop connection cache avoids repeated Windows process discovery", () => {
  let discoveries = 0;
  const cache = createDesktopConnectionCache({
    discover: () => {
      discoveries += 1;
      return {
        lsAddress: `127.0.0.1:${9000 + discoveries}`,
        agentApiAddress: `127.0.0.1:${9000 + discoveries}`,
        csrfToken: `token-${discoveries}`,
      };
    },
  });

  const first = cache.get();
  assert.equal(cache.get(), first);
  assert.equal(discoveries, 1);

  cache.invalidate(first);
  const second = cache.get();
  assert.notEqual(second, first);
  assert.equal(discoveries, 2);
});

test("extractConversationId reads agentapi new-conversation response", () => {
  assert.equal(
    extractConversationId({
      response: {
        newConversation: {
          conversationId: "conversation-1",
        },
      },
    }),
    "conversation-1",
  );
});

test("extractAssistantText returns the latest completed planner response", () => {
  const result = extractAssistantText({
    trajectory: {
      steps: [
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status: "CORTEX_STEP_STATUS_DONE",
          plannerResponse: { response: "older" },
        },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status: "CORTEX_STEP_STATUS_DONE",
          plannerResponse: { response: "raw", modifiedResponse: "latest" },
        },
      ],
    },
  });

  assert.equal(result, "latest");
});

test("extractAssistantText ignores planner responses before the latest user message", () => {
  const result = extractAssistantText({
    trajectory: {
      steps: [
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status: "CORTEX_STEP_STATUS_DONE",
          plannerResponse: { response: "startup welcome" },
        },
        {
          type: "CORTEX_STEP_TYPE_USER_MESSAGE",
          userMessage: { text: "Reply exactly CURRENT_MARKER" },
        },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status: "CORTEX_STEP_STATUS_DONE",
          plannerResponse: { response: "CURRENT_MARKER" },
        },
      ],
    },
  });

  assert.equal(result, "CURRENT_MARKER");
});

test("extractAssistantText can prefer the response matching the current prompt marker", () => {
  const result = extractAssistantText({
    trajectory: {
      steps: [
        {
          type: "CORTEX_STEP_TYPE_USER_MESSAGE",
          userMessage: { text: "Reply exactly CURRENT_MARKER_12345" },
        },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status: "CORTEX_STEP_STATUS_DONE",
          plannerResponse: { response: "CURRENT_MARKER_12345" },
        },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          status: "CORTEX_STEP_STATUS_DONE",
          plannerResponse: { response: "Hello, I am ready to help." },
        },
      ],
    },
  }, { prompt: "Reply exactly CURRENT_MARKER_12345" });

  assert.equal(result, "CURRENT_MARKER_12345");
});

test("requestHeaders creates Connect JSON headers without exposing token elsewhere", () => {
  assert.deepEqual(requestHeaders("secret-token"), {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    "x-codeium-csrf-token": "secret-token",
  });
});

test("antigravityModelOnlyToolConfig disables Antigravity-owned tools and permission prompts", () => {
  const config = antigravityModelOnlyToolConfig();

  assert.equal(config.listDir.forceDisable, true);
  assert.equal(config.runCommand.forceDisable, true);
  assert.equal(config.viewFile.forceDisable, true);
  assert.equal(config.writeToFile.forceDisable, true);
  assert.equal(config.mcp.forceDisable, true);
  assert.equal(config.antigravityBrowser.enabled, false);
  assert.equal(config.askPermission.enabled, false);
  assert.equal(config.invokeSubagent.enabled, false);
});

test("antigravity native tool capability summary reports the model-only default", () => {
  const summary = antigravityNativeToolCapabilitySummary({ env: {} });

  assert.equal(summary.transport, "cli");
  assert.match(summary.requestEnvelope, /model-only Antigravity text turn/);
  assert.equal(summary.modelField, "planModel");
  assert.equal(summary.toolConfigField, "toolConfig");
  assert.equal(summary.externalToolDefinitionsField, "StartCascade.customAgentSpec.customizationConfig.customizationServerUrl");
  assert.equal(summary.acceptsExternalToolDefinitions, false);
  assert.equal(summary.schemaLikeRequestAcceptance, "disabled-by-default-model-only");
  assert.equal(summary.externalToolDefinitionsUsable, false);
  assert.equal(summary.nativeBridgeDefaultEnabled, false);
  assert.equal(summary.nativeAntigravityToolEvents, false);
  assert.equal(summary.nativeMcpDiscoveryVerified, false);
  assert.equal(summary.nativeMcpToolCallStatus, "available-explicit-fallback");
  assert.equal(summary.nativeMcpApprovalProtocolVerified, false);
  assert.equal(summary.nativeMcpPermissionMode, "disabled-with-native-bridge");
  assert.equal(summary.sameCascadeResumeProbeVerified, false);
  assert.equal(summary.antigravityOwnedToolsDisabled, true);
  assert.equal(summary.permissionPromptsDisabled, true);
  assert.equal(summary.codexToolBridge, "codex-owned-tools-model-only");
  assert.ok(summary.disabledToolCount >= 10);
  assert.ok(summary.disabledToolKeys.includes("askPermission"));
  assert.match(summary.reason, /model text only/i);
});

test("antigravity native tool capability summary reports explicit native opt-in", () => {
  const summary = antigravityNativeToolCapabilitySummary({ nativeBridgeEnabled: true, transport: "desktop-cascade" });

  assert.equal(summary.transport, "desktop-cascade");
  assert.equal(summary.nativeBridgeDefaultEnabled, true);
  assert.equal(summary.nativeAntigravityToolEvents, true);
  assert.equal(summary.nativeMcpToolCallStatus, "verified-tools-call-after-automatic-permission");
  assert.equal(summary.codexToolBridge, "native-mcp-same-cascade-with-prompt-fallback");
  assert.match(summary.reason, /automatically approved/i);
});

test("extractPendingNativeToolCalls reads structured waiting MCP steps and filters names", () => {
  const trajectory = {
    trajectory: {
      trajectoryId: "trajectory-1",
      steps: [{
        type: "CORTEX_STEP_TYPE_MCP_TOOL",
        status: "CORTEX_STEP_STATUS_WAITING",
        metadata: {
          sourceTrajectoryStepInfo: {
            trajectoryId: "trajectory-source-1",
            stepIndex: 7,
          },
        },
        mcpTool: {
          toolCall: {
            id: "native-1",
            name: "read_file",
            argumentsJson: "{\"path\":\"README.md\"}",
          },
        },
        requestedInteraction: {
          permission: {
            resource: { action: "mcp", target: "_custom/read_file" },
          },
        },
      }],
    },
  };
  assert.deepEqual(extractPendingNativeToolCalls(trajectory, ["read_file"]), [{
    callId: "native-1",
    name: "read_file",
    arguments: { path: "README.md" },
    interaction: {
      trajectoryId: "trajectory-source-1",
      stepIndex: 7,
    },
    requestedInteraction: {
      permission: {
        resource: { action: "mcp", target: "_custom/read_file" },
      },
    },
  }]);
  assert.deepEqual(extractPendingNativeToolCalls(trajectory, ["other"]), []);
});

test("buildAntigravityMcpApprovalInteraction uses the desktop native MCP interaction shape", () => {
  assert.deepEqual(buildAntigravityMcpApprovalInteraction({
    interaction: { trajectoryId: "trajectory-1", stepIndex: 4 },
  }), {
    trajectoryId: "trajectory-1",
    stepIndex: 4,
    mcp: { confirm: true },
  });
  assert.deepEqual(buildAntigravityMcpApprovalInteraction({
    interaction: { trajectoryId: "trajectory-1", stepIndex: 4 },
  }, false), {
    trajectoryId: "trajectory-1",
    stepIndex: 4,
    mcp: { confirm: false },
  });
  assert.throws(() => buildAntigravityMcpApprovalInteraction({}), /trajectoryId/);
});

test("buildAntigravityToolApprovalInteraction follows the requested permission interaction for custom MCP tools", () => {
  assert.deepEqual(buildAntigravityToolApprovalInteraction({
    interaction: { trajectoryId: "trajectory-1", stepIndex: 4 },
    requestedInteraction: {
      permission: {
        resource: { action: "mcp", target: "_custom/read_file" },
      },
    },
  }), {
    trajectoryId: "trajectory-1",
    stepIndex: 4,
    permission: {
      allow: true,
      scope: 1,
    },
  });
});

test("handleAntigravityCascadeUserInteraction posts the proven desktop request envelope", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response("{}", { status: 200 });
  };
  await handleAntigravityCascadeUserInteraction({
    lsAddress: "127.0.0.1:9999",
    csrfToken: "token",
  }, "cascade-1", {
    trajectoryId: "trajectory-1",
    stepIndex: 2,
    mcp: { confirm: true },
  }, { fetchImpl });

  assert.match(captured.url, /HandleCascadeUserInteraction$/);
  assert.deepEqual(JSON.parse(captured.init.body), {
    cascadeId: "cascade-1",
    interaction: {
      trajectoryId: "trajectory-1",
      stepIndex: 2,
      mcp: { confirm: true },
    },
  });
});

test("resolveAntigravityModel maps Codex aliases to current desktop models", () => {
  const payload = {
    response: {
      models: {
        "gemini-3.5-flash-low": {
          displayName: "Gemini 3.5 Flash (Medium)",
          model: "MODEL_PLACEHOLDER_M20",
        },
        "gemini-pro-agent": {
          displayName: "Gemini 3.1 Pro (High)",
          model: "MODEL_PLACEHOLDER_M16",
        },
      },
      agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low", "gemini-pro-agent"] }] }],
    },
  };

  assert.deepEqual(extractAvailableAgentModelEntries(payload).map((model) => model.id), [
    "gemini-3.5-flash-low",
    "gemini-pro-agent",
  ]);
  assert.equal(resolveAntigravityModel(payload, "gpt-5.5").id, "gemini-pro-agent");
  const flash = resolveAntigravityModel(payload, "gemini-3.5-flash-low");
  assert.equal(flash.internalModel, "MODEL_PLACEHOLDER_M20");
  assert.equal(flash.displayName, "Gemini 3.5 Flash (Low)");
});

test("resolveAntigravityModel explains when the desktop account is not ready", () => {
  assert.throws(
    () => resolveAntigravityModel({ response: {} }, "gemini-pro-agent"),
    /Open Antigravity, sign in, and confirm its proxy connection/,
  );
});

test("runAntigravityNativeTurn sends Cascade messages with the internal planModel", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: {
            "gemini-3.5-flash-low": {
              displayName: "Gemini 3.5 Flash (Medium)",
              model: "MODEL_PLACEHOLDER_M20",
            },
          },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-1" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_DONE",
            plannerResponse: { response: "原生通道成功" },
          }],
        },
      });
    }
    return jsonResponse({}, 404);
  };

  const result = await runAntigravityNativeTurn("只回复：原生通道成功", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    model: "gemini-3.5-flash-low",
    fetchImpl,
  });

  assert.equal(result.text, "原生通道成功");
  const send = requests.find((request) => request.method === "SendUserCascadeMessage");
  assert.equal(send.body.cascadeConfig.plannerConfig.planModel, "MODEL_PLACEHOLDER_M20");
  assert.equal(send.body.cascadeConfig.plannerConfig.toolConfig.listDir.forceDisable, true);
  assert.equal(send.body.cascadeConfig.plannerConfig.toolConfig.askPermission.enabled, false);
  const cancelReqs = requests.filter((r) => r.method === "CancelCascadeInvocation");
  assert.equal(cancelReqs.length, 0, "No CancelCascadeInvocation on successful completion");
});

test("defaultAntigravityCliCommand honors the configured standalone CLI", () => {
  assert.deepEqual(defaultAntigravityCliCommand({
    ANTIGRAVITY_CLI_BIN: "C:\\tools\\antigravity.exe",
  }), {
    command: "C:\\tools\\antigravity.exe",
    argsPrefix: [],
  });
});

test("antigravityCliIsolationEnv builds an Anti-Codex-owned CLI profile boundary", () => {
  const env = antigravityCliIsolationEnv({
    ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT: "G:\\AntiCodexProfiles\\ag-account-b",
  });

  assert.equal(env.HOME, "G:\\AntiCodexProfiles\\ag-account-b");
  assert.equal(env.USERPROFILE, "G:\\AntiCodexProfiles\\ag-account-b");
  assert.equal(env.GEMINI_DIR, "G:\\AntiCodexProfiles\\ag-account-b\\.gemini");
  assert.equal(env.ANTIGRAVITY_CLI_CONVERSATIONS_DIR, "G:\\AntiCodexProfiles\\ag-account-b\\.gemini\\antigravity-cli\\conversations");
});

test("antigravityCliIsolationEnv allows explicit home and conversation overrides", () => {
  const env = antigravityCliIsolationEnv({
    ANTICODEX_ANTIGRAVITY_CLI_HOME: "G:\\anti-home",
    ANTICODEX_ANTIGRAVITY_CLI_USERPROFILE: "G:\\anti-user",
    ANTICODEX_ANTIGRAVITY_CLI_GEMINI_DIR: "G:\\anti-gemini",
    ANTICODEX_ANTIGRAVITY_CLI_CONVERSATIONS_DIR: "G:\\anti-conversations",
  });

  assert.equal(env.HOME, "G:\\anti-home");
  assert.equal(env.USERPROFILE, "G:\\anti-user");
  assert.equal(env.GEMINI_DIR, "G:\\anti-gemini");
  assert.equal(env.ANTIGRAVITY_CLI_CONVERSATIONS_DIR, "G:\\anti-conversations");
});

test("antigravityCliArgs keeps every flag before the positional prompt", () => {
  assert.deepEqual(antigravityCliArgs({
    model: "gemini-3.5-flash-low",
    prompt: "hello",
    timeoutMs: 120000,
    logPath: "C:\\temp\\anti.log",
  }), [
    "--log-file", "C:\\temp\\anti.log",
    "--model", "gemini-3.5-flash-low",
    "--print-timeout", "120s",
    "--print",
    "hello",
  ]);
});

test("windowsAntigravityCliInvocation avoids the PowerShell native command wrapper", () => {
  const invocation = windowsAntigravityCliInvocation({
    cliCommand: "C:\\tools\\antigravity.exe",
    model: "gemini-3.5-flash-low",
    timeoutMs: 120000,
    logPath: "C:\\temp\\anti.log",
    prompt: "hello",
  });

  assert.equal(invocation.command, "C:\\tools\\antigravity.exe");
  assert.deepEqual(invocation.args, [
    "--log-file", "C:\\temp\\anti.log",
    "--model", "gemini-3.5-flash-low",
    "--print-timeout", "120s",
    "--print",
    "hello",
  ]);
  assert.deepEqual(invocation.env, {});
});

test("discoverProjectId reads the isolated Gemini directory from the CLI environment", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-ag-cli-profile-"));
  try {
    const workspace = join(root, "workspace");
    const projects = join(root, ".gemini", "config", "projects");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "project.json"), JSON.stringify({
      id: "anti-codex-account-b-project",
      projectResources: {
        resources: [{
          gitFolder: {
            folderUri: `file:///${workspace.replace(/\\/g, "/")}`,
          },
        }],
      },
    }), "utf8");

    assert.equal(discoverProjectId(workspace, { GEMINI_DIR: join(root, ".gemini") }), "anti-codex-account-b-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractCreatedConversationId reads the standalone CLI log", () => {
  assert.equal(
    extractCreatedConversationId([
      "Starting backend",
      "Created conversation 53966e07-1699-439d-847b-e5b3bca9f560",
    ].join("\n")),
    "53966e07-1699-439d-847b-e5b3bca9f560",
  );
});

test("extractCliAssistantText reads the assistant response from protobuf strings", () => {
  const payload = Buffer.concat([
    protobufString("sessionID"),
    protobufString("req_vrtx_011CbwQWZoQ1z7Z2LmYWoJeg"),
    protobufString("zqUqarH0M6_sz7IPtuD8uA0"),
    protobufString("53966e07-1699-439d-847b-e5b3bca9f560"),
    protobufString("中文回复正常"),
    protobufString("bot-a56c9d46-d4d1-4007-bad8-da7770437dfe"),
    protobufString("中文回复正常"),
  ]);

  assert.deepEqual(extractProtobufStrings(payload), [
    "sessionID",
    "req_vrtx_011CbwQWZoQ1z7Z2LmYWoJeg",
    "zqUqarH0M6_sz7IPtuD8uA0",
    "53966e07-1699-439d-847b-e5b3bca9f560",
    "中文回复正常",
    "bot-a56c9d46-d4d1-4007-bad8-da7770437dfe",
    "中文回复正常",
  ]);
  assert.equal(extractCliAssistantText(payload), "中文回复正常");
});

test("runAntigravityNativeTurn calls onCascadeStarted with cascadeId and connection", async () => {
  const requests = [];
  let cascadeStartedArgs = null;

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-cb-1" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: { steps: [{ type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_DONE", plannerResponse: { response: "ok" } }] },
      });
    }
    return jsonResponse({}, 404);
  };

  const result = await runAntigravityNativeTurn("test", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    onCascadeStarted: (args) => { cascadeStartedArgs = args; },
  });

  assert.equal(result.text, "ok");
  assert.ok(cascadeStartedArgs, "onCascadeStarted must be called");
  assert.equal(cascadeStartedArgs.cascadeId, "cascade-cb-1");
  assert.deepEqual(cascadeStartedArgs.connection, { lsAddress: "127.0.0.1:1", csrfToken: "secret" });
  const startIndex = requests.findIndex((r) => r.method === "StartCascade");
  const sendIndex = requests.findIndex((r) => r.method === "SendUserCascadeMessage");
  assert.ok(startIndex >= 0 && sendIndex >= 0, "StartCascade and SendUserCascadeMessage must exist");
  assert.ok(startIndex < sendIndex, "onCascadeStarted fires after StartCascade before SendUserCascadeMessage");
});

test("runAntigravityNativeTurn cancels cascade on external abort", async () => {
  const requests = [];
  const abortController = new AbortController();

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-abort-1" });
    if (method === "SendUserCascadeMessage") {
      if (init.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      await new Promise((resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        }
        setTimeout(() => abortController.abort(), 5);
      });
      return jsonResponse({});
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };

  await assert.rejects(
    runAntigravityNativeTurn("test", {
      cwd: process.cwd(),
      connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
      fetchImpl,
      signal: abortController.signal,
    }),
    { name: "AbortError" },
  );

  const cancelReqs = requests.filter((r) => r.method === "CancelCascadeInvocation");
  assert.equal(cancelReqs.length, 1, "CancelCascadeInvocation must be called exactly once on external abort");
  assert.equal(cancelReqs[0].body.cascadeId, "cascade-abort-1");
});

test("runAntigravityNativeTurn cancels cascade on SendUserCascadeMessage timeout", async () => {
  const requests = [];

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-timeout-1" });
    if (method === "SendUserCascadeMessage") {
      if (init.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      await new Promise((resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        }
      });
      return jsonResponse({});
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };

  await assert.rejects(
    runAntigravityNativeTurn("test", {
      cwd: process.cwd(),
      connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
      fetchImpl,
      timeoutMs: 50,
    }),
  );

  const cancelReqs = requests.filter((r) => r.method === "CancelCascadeInvocation");
  assert.equal(cancelReqs.length, 1, "CancelCascadeInvocation must be called on timeout");
  assert.equal(cancelReqs[0].body.cascadeId, "cascade-timeout-1");
});

function protobufString(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([0x0a]), encodeVarint(bytes.length), bytes]);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForAbort(signal) {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  await new Promise((resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted", "AbortError")),
      { once: true },
    );
  });
}

test("runAntigravityNativeTurnStreamed - normal completion, blocking:false, multiple increments, no duplicates", async () => {
  const requests = [];
  let trajCallCount = 0;
  let releaseIdle;
  const idle = new Promise((resolve) => { releaseIdle = resolve; });

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-stream-1" });
    if (method === "SendUserCascadeMessage") {
      assert.equal(body.blocking, false, "SendUserCascadeMessage must be non-blocking");
      assert.equal(body.cascadeConfig.plannerConfig.toolConfig.listDir.forceDisable, true);
      assert.equal(body.cascadeConfig.plannerConfig.toolConfig.askPermission.enabled, false);
      return jsonResponse({});
    }
    if (method === "WaitForConversationFullyIdle") {
      await idle;
      return jsonResponse({});
    }
    if (method === "GetCascadeTrajectory") {
      trajCallCount++;
      if (trajCallCount === 1) {
        return jsonResponse({
          trajectory: {
            steps: [{
              type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
              status: "CORTEX_STEP_STATUS_PLANNING",
              plannerResponse: { response: "Hello" }
            }]
          }
        });
      }
      if (trajCallCount === 2) {
        // Duplicate text - should not yield anything new
        return jsonResponse({
          trajectory: {
            steps: [{
              type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
              status: "CORTEX_STEP_STATUS_PLANNING",
              plannerResponse: { response: "Hello" }
            }]
          }
        });
      }
      if (trajCallCount === 3) {
        return jsonResponse({
          trajectory: {
            steps: [{
              type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
              status: "CORTEX_STEP_STATUS_PLANNING",
              plannerResponse: { response: "Hello World" }
            }]
          }
        });
      }
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_DONE",
            plannerResponse: { response: "Hello World!" }
          }]
        }
      });
    }
    return jsonResponse({}, 404);
  };

  const generator = runAntigravityNativeTurnStreamed("test prompt", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
  });

  const events = [];
  const consume = (async () => {
    for await (const event of generator) events.push(event);
  })();

  await waitFor(() => events.some((event) => event.type === "text_delta" && event.text === "Hello World!"));
  assert.equal(events.some((event) => event.type === "done"), false);
  releaseIdle();
  await consume;

  // Verify yielded events
  assert.deepEqual(events, [
    { type: "text_delta", delta: "Hello", text: "Hello" },
    { type: "text_delta", delta: " World", text: "Hello World" },
    { type: "text_delta", delta: "!", text: "Hello World!" },
    {
      type: "done",
      result: {
        cascadeId: "cascade-stream-1",
        text: "Hello World!",
        trajectory: events[3].result.trajectory,
        model: "gemini-3.5-flash-low",
        displayName: "Flash (Low)",
        internalModel: "MODEL_M20"
      }
    }
  ]);

  const cancelReqs = requests.filter((r) => r.method === "CancelCascadeInvocation");
  assert.equal(cancelReqs.length, 0, "No cancellation on normal completion");
});

test("runAntigravityNativeTurnStreamed refreshes final DONE text after idle", async () => {
  const requests = [];
  let trajCallCount = 0;
  let releaseIdle;
  const idle = new Promise((resolve) => { releaseIdle = resolve; });

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-stream-final" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") {
      await idle;
      return jsonResponse({});
    }
    if (method === "GetCascadeTrajectory") {
      trajCallCount++;
      if (trajCallCount === 1) {
        releaseIdle();
        return jsonResponse({
          trajectory: {
            steps: [{
              type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
              status: "CORTEX_STEP_STATUS_PLANNING",
              plannerResponse: { response: "The stream connection is active and working successfully!" },
            }],
          },
        });
      }
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_DONE",
            plannerResponse: { response: "STREAM_OK" },
          }],
        },
      });
    }
    return jsonResponse({}, 404);
  };

  const events = [];
  for await (const event of runAntigravityNativeTurnStreamed("test prompt", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
  })) {
    events.push(event);
  }

  assert.deepEqual(events.map((event) => event.type), ["text_delta", "text_replace", "done"]);
  assert.equal(events[1].text, "STREAM_OK");
  assert.equal(events[2].result.text, "STREAM_OK");
  assert.equal(trajCallCount, 2);
});

test("runAntigravityNativeTurnStreamed - text revision yielding text_replace", async () => {
  const requests = [];
  let trajCallCount = 0;
  let releaseIdle;
  const idle = new Promise((resolve) => { releaseIdle = resolve; });

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-stream-2" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") {
      await idle;
      return jsonResponse({});
    }
    if (method === "GetCascadeTrajectory") {
      trajCallCount++;
      if (trajCallCount === 1) {
        return jsonResponse({
          trajectory: {
            steps: [{
              type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
              status: "CORTEX_STEP_STATUS_PLANNING",
              plannerResponse: { response: "Hello" }
            }]
          }
        });
      }
      if (trajCallCount === 2) {
        // Text is revised to something that is not a prefix of "Hello"
        return jsonResponse({
          trajectory: {
            steps: [{
              type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
              status: "CORTEX_STEP_STATUS_PLANNING",
              plannerResponse: { response: "Hi" }
            }]
          }
        });
      }
      releaseIdle();
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_DONE",
            plannerResponse: { response: "Hi there!" }
          }]
        }
      });
    }
    return jsonResponse({}, 404);
  };

  const generator = runAntigravityNativeTurnStreamed("test prompt", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
  });

  const events = [];
  for await (const event of generator) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: "text_delta", delta: "Hello", text: "Hello" },
    { type: "text_replace", text: "Hi" },
    { type: "text_delta", delta: " there!", text: "Hi there!" },
    {
      type: "done",
      result: {
        cascadeId: "cascade-stream-2",
        text: "Hi there!",
        trajectory: events[3].result.trajectory,
        model: "gemini-3.5-flash-low",
        displayName: "Flash (Low)",
        internalModel: "MODEL_M20"
      }
    }
  ]);
});

test("runAntigravityNativeTurnStreamed - external cancellation via AbortController", async () => {
  const requests = [];
  const abortController = new AbortController();
  let trajCallCount = 0;

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-stream-3" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") {
      await waitForAbort(init.signal);
    }
    if (method === "GetCascadeTrajectory") {
      trajCallCount++;
      if (trajCallCount === 1) {
        return jsonResponse({
          trajectory: {
            steps: [{
              type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
              status: "CORTEX_STEP_STATUS_PLANNING",
              plannerResponse: { response: "Hello" }
            }]
          }
        });
      }
      abortController.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };

  const generator = runAntigravityNativeTurnStreamed("test prompt", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
    signal: abortController.signal,
  });

  const events = [];
  try {
    for await (const event of generator) {
      events.push(event);
    }
    assert.fail("Should have failed with AbortError");
  } catch (err) {
    assert.equal(err.name, "AbortError");
  }

  assert.deepEqual(events, [
    { type: "text_delta", delta: "Hello", text: "Hello" }
  ]);

  const cancelReqs = requests.filter((r) => r.method === "CancelCascadeInvocation");
  assert.equal(cancelReqs.length, 1, "CancelCascadeInvocation must be called exactly once on abort");
  assert.equal(cancelReqs[0].body.cascadeId, "cascade-stream-3");
});

test("runAntigravityNativeTurnStreamed - timeout throws and cancels cascade", async () => {
  const requests = [];

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-stream-4" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") {
      await waitForAbort(init.signal);
    }
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_PLANNING",
            plannerResponse: { response: "Hello" }
          }]
        }
      });
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };

  const generator = runAntigravityNativeTurnStreamed("test prompt", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 50,
    timeoutMs: 10,
  });

  const events = [];
  try {
    for await (const event of generator) {
      events.push(event);
    }
    assert.fail("Should have timed out");
  } catch (err) {
    assert.match(err.message, /timed out/);
  }

  const cancelReqs = requests.filter((r) => r.method === "CancelCascadeInvocation");
  assert.equal(cancelReqs.length, 1, "CancelCascadeInvocation must be called on timeout");
  assert.equal(cancelReqs[0].body.cascadeId, "cascade-stream-4");
});

test("runAntigravityNativeTurnStreamed - trajectory error fails immediately", async () => {
  const requests = [];

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-stream-5" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") {
      await waitForAbort(init.signal);
    }
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_ERROR",
            plannerResponse: { errorMessage: "Failed to generate plan" }
          }]
        }
      });
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };

  const generator = runAntigravityNativeTurnStreamed("test prompt", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
  });

  try {
    for await (const event of generator) {
      // should fail immediately
    }
    assert.fail("Should have failed due to trajectory error");
  } catch (err) {
    assert.equal(err.message, "Failed to generate plan");
  }

  const cancelReqs = requests.filter((r) => r.method === "CancelCascadeInvocation");
  assert.equal(cancelReqs.length, 1, "CancelCascadeInvocation must be called on trajectory error");
  assert.equal(cancelReqs[0].body.cascadeId, "cascade-stream-5");
});

test("runAntigravityNativeTurnStreamed - invokes onCascadeStarted", async () => {
  let cascadeStartedArgs = null;

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-3.5-flash-low": { displayName: "Flash", model: "MODEL_M20" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-low"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-cb-stream" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") return jsonResponse({});
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_DONE",
            plannerResponse: { response: "ok" }
          }]
        }
      });
    }
    return jsonResponse({}, 404);
  };

  const generator = runAntigravityNativeTurnStreamed("test prompt", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
    onCascadeStarted: (args) => { cascadeStartedArgs = args; },
  });

  for await (const event of generator) {
    // consume all
  }

  assert.ok(cascadeStartedArgs);
  assert.equal(cascadeStartedArgs.cascadeId, "cascade-cb-stream");
  assert.deepEqual(cascadeStartedArgs.connection, { lsAddress: "127.0.0.1:1", csrfToken: "secret" });
});

test("runAntigravityNativeTurnStreamed forwards a native MCP tool call and cancels the waiting cascade", async () => {
  const requests = [];
  const nativeToolBridge = {
    tools: [{ name: "read_file" }],
    takeCalls: () => [],
  };
  const customAgentSpec = {
    customTools: ["read_file"],
    customizationConfig: { customizationServerUrl: "http://127.0.0.1:9999", toolNames: ["read_file"] },
  };
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    requests.push({ method, body: JSON.parse(init.body) });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-pro-agent": { displayName: "Pro", model: "MODEL_M16" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-pro-agent"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-native-tool" });
    if (method === "SendUserCascadeMessage") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") await waitForAbort(init.signal);
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_MCP_TOOL",
            status: "CORTEX_STEP_STATUS_WAITING",
            mcpTool: {
              toolCall: {
                id: "call_native_1",
                name: "read_file",
                argumentsJson: "{\"path\":\"README.md\"}",
              },
            },
          }],
        },
      });
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };

  const events = [];
  for await (const event of runAntigravityNativeTurnStreamed("use read_file", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
    nativeToolBridge,
    customAgentSpec,
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [{
    type: "tool_call",
    calls: [{ callId: "call_native_1", name: "read_file", arguments: { path: "README.md" } }],
    cascadeId: "cascade-native-tool",
  }]);
  assert.deepEqual(requests.find((request) => request.method === "StartCascade").body.customAgentSpec, customAgentSpec);
  assert.equal(requests.filter((request) => request.method === "CancelCascadeInvocation").length, 1);
});

test("runAntigravityNativeTurnStreamed auto-approves a waiting MCP request before yielding it to Codex", async () => {
  const requests = [];
  let bridgeWaits = 0;
  const nativeToolBridge = {
    tools: [{ name: "read_file" }],
    takeCalls: () => [],
    waitForCall: async () => {
      bridgeWaits += 1;
      return {
        callId: "bridge_call_1",
        name: "read_file",
        arguments: { path: "README.md" },
      };
    },
  };
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    requests.push({ method, body: JSON.parse(init.body) });
    if (method === "GetAvailableModels") {
      return jsonResponse({
        response: {
          models: { "gemini-pro-agent": { displayName: "Pro", model: "MODEL_M16" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-pro-agent"] }] }],
        },
      });
    }
    if (method === "StartCascade") return jsonResponse({ cascadeId: "cascade-native-tool" });
    if (method === "SendUserCascadeMessage" || method === "HandleCascadeUserInteraction") return jsonResponse({});
    if (method === "WaitForConversationFullyIdle") await waitForAbort(init.signal);
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: {
          trajectoryId: "trajectory-1",
          steps: [{
            type: "CORTEX_STEP_TYPE_MCP_TOOL",
            status: "CORTEX_STEP_STATUS_WAITING",
            metadata: {
              sourceTrajectoryStepInfo: {
                trajectoryId: "trajectory-source-1",
                stepIndex: 7,
              },
            },
            mcpTool: {
              toolCall: {
                id: "call_native_1",
                name: "read_file",
                argumentsJson: "{\"path\":\"README.md\"}",
              },
            },
            requestedInteraction: {
              permission: {
                resource: { action: "mcp", target: "_custom/read_file" },
              },
            },
          }],
        },
      });
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };

  const events = [];
  for await (const event of runAntigravityNativeTurnStreamed("use read_file", {
    cwd: process.cwd(),
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    fetchImpl,
    pollIntervalMs: 1,
    nativeToolBridge,
    customAgentSpec: {},
    retainOnToolCall: true,
  })) {
    events.push(event);
  }

  assert.equal(bridgeWaits, 1);
  const approval = requests.find((request) => request.method === "HandleCascadeUserInteraction");
  assert.deepEqual(approval?.body, {
    cascadeId: "cascade-native-tool",
    interaction: {
      trajectoryId: "trajectory-source-1",
      stepIndex: 7,
      permission: { allow: true, scope: 1 },
    },
  });
  assert.equal(events[0].calls[0].callId, "call_native_1");
  assert.equal(events[0].calls[0].bridgeCallId, "bridge_call_1");
  assert.equal(events[0].calls[0].approvalHandled, true);
});

test("resumeAntigravityNativeTurnStreamed completes a pre-approved MCP call without a second approval", async () => {
  const requests = [];
  const completions = [];
  const nativeToolBridge = {
    tools: [{ name: "read_file" }],
    waitForCall: async () => {
      throw new Error("pre-approved continuation must not wait for another MCP call");
    },
    completeCall: (callId, output, options) => {
      completions.push({ callId, output, options });
      return true;
    },
  };
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    requests.push({ method, body: JSON.parse(init.body) });
    if (method === "WaitForConversationFullyIdle") return jsonResponse({});
    if (method === "GetCascadeTrajectory") {
      return jsonResponse({
        trajectory: {
          steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            status: "CORTEX_STEP_STATUS_DONE",
            plannerResponse: { response: "done" },
          }],
        },
      });
    }
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };
  const session = {
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    cascadeId: "cascade-native-tool",
    nativeToolBridge,
    pendingCalls: [{
      callId: "call_native_1",
      bridgeCallId: "bridge_call_1",
      approvalHandled: true,
      name: "read_file",
      arguments: { path: "README.md" },
    }],
    prompt: "use read_file",
    model: "gemini-pro-agent",
    displayName: "Pro",
    internalModel: "MODEL_M16",
  };

  const events = [];
  for await (const event of resumeAntigravityNativeTurnStreamed(session, [{
    callId: "call_native_1",
    output: "file contents",
    isError: false,
  }], { fetchImpl, pollIntervalMs: 1, timeoutMs: 1000 })) {
    events.push(event);
  }

  assert.deepEqual(completions, [{
    callId: "bridge_call_1",
    output: "file contents",
    options: { isError: false },
  }]);
  assert.equal(requests.some((request) => request.method === "HandleCascadeUserInteraction"), false);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).result.text, "done");
});

test("resumeAntigravityNativeTurnStreamed can preserve the Cascade for upstream retry", async () => {
  const requests = [];
  const nativeToolBridge = {
    tools: [{ name: "read_file" }],
    waitForCall: async () => {
      throw new Error("pre-approved continuation must not wait for another MCP call");
    },
    completeCall: () => true,
  };
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    requests.push({ method, body: JSON.parse(init.body) });
    if (method === "WaitForConversationFullyIdle") return jsonResponse({});
    if (method === "GetCascadeTrajectory") throw new Error("ECONNRESET before visible event");
    if (method === "CancelCascadeInvocation") return jsonResponse({});
    return jsonResponse({}, 404);
  };
  const session = {
    connection: { lsAddress: "127.0.0.1:1", csrfToken: "secret" },
    cascadeId: "cascade-preserved-for-retry",
    nativeToolBridge,
    pendingCalls: [{
      callId: "call_native_retry",
      bridgeCallId: "bridge_call_retry",
      approvalHandled: true,
      name: "read_file",
      arguments: { path: "README.md" },
    }],
    prompt: "use read_file",
    model: "gemini-pro-agent",
    displayName: "Pro",
    internalModel: "MODEL_M16",
  };

  await assert.rejects(async () => {
    for await (const _event of resumeAntigravityNativeTurnStreamed(session, [{
      callId: "call_native_retry",
      output: "file contents",
      isError: false,
    }], { fetchImpl, pollIntervalMs: 1, timeoutMs: 1000, cancelOnError: false })) {}
  }, /ECONNRESET before visible event/);

  assert.equal(requests.some((request) => request.method === "CancelCascadeInvocation"), false);
});
