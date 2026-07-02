import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { normalizeAntigravityDisplayName } from "./antigravity-model-catalog.mjs";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SERVICE_PREFIX = "/exa.language_server_pb.LanguageServerService";

export function requestHeaders(csrfToken) {
  return {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    "x-codeium-csrf-token": csrfToken,
  };
}

export function antigravityModelOnlyToolConfig() {
  return {
    mquery: { forceDisable: true },
    code: { forceDisable: true },
    intent: { forceDisable: true },
    grep: { forceDisable: true },
    find: { forceDisable: true },
    runCommand: { forceDisable: true },
    viewFile: { forceDisable: true },
    searchWeb: { forceDisable: true },
    memory: { forceDisable: true },
    mcp: { forceDisable: true },
    listDir: { forceDisable: true },
    trajectorySearch: { forceDisable: true },
    codeSearch: { forceDisable: true },
    internalSearch: { forceDisable: true },
    generateImage: { forceDisable: true },
    writeToFile: { forceDisable: true },
    readKnowledgeBaseItem: { enabled: false },
    antigravityBrowser: { enabled: false },
    notebookEdit: { enabled: false },
    invokeSubagent: { enabled: false },
    askQuestion: { enabled: false },
    askPermission: { enabled: false },
    skillSearch: { enabled: false },
  };
}

export function antigravityNativeToolCapabilitySummary(options = {}) {
  const nativeBridgeEnabled = parseBooleanFlag(
    options.nativeBridgeEnabled
      ?? options.env?.ANTICODEX_NATIVE_TOOL_BRIDGE
      ?? process.env.ANTICODEX_NATIVE_TOOL_BRIDGE,
    false,
  );
  const transport = String(options.transport ?? options.env?.ANTICODEX_ANTIGRAVITY_TRANSPORT ?? process.env.ANTICODEX_ANTIGRAVITY_TRANSPORT ?? "desktop-cascade").toLowerCase();
  const toolConfig = antigravityModelOnlyToolConfig();
  const disabledKeys = Object.entries(toolConfig)
    .filter(([, value]) => value?.forceDisable === true || value?.enabled === false)
    .map(([key]) => key)
    .sort();
  return {
    transport,
    requestEnvelope: nativeBridgeEnabled
      ? "StartCascade.customAgentSpec + SendUserCascadeMessage.cascadeConfig.plannerConfig"
      : "model-only Antigravity text turn; Codex owns tools",
    modelField: "planModel",
    toolConfigField: "toolConfig",
    externalToolDefinitionsField: "StartCascade.customAgentSpec.customizationConfig.customizationServerUrl",
    acceptsExternalToolDefinitions: nativeBridgeEnabled,
    schemaLikeRequestAcceptance: nativeBridgeEnabled ? "verified-native-mcp-initialize-and-tools-list" : "disabled-by-default-model-only",
    externalToolDefinitionsUsable: nativeBridgeEnabled,
    nativeBridgeDefaultEnabled: nativeBridgeEnabled,
    nativeAntigravityToolEvents: nativeBridgeEnabled,
    nativeMcpDiscoveryVerified: nativeBridgeEnabled,
    nativeMcpToolCallStatus: nativeBridgeEnabled
      ? "verified-tools-call-after-automatic-permission"
      : "available-explicit-fallback",
    nativeMcpApprovalProtocolVerified: nativeBridgeEnabled,
    nativeMcpPermissionMode: nativeBridgeEnabled
      ? "automatic-before-codex-execution"
      : "disabled-with-native-bridge",
    sameCascadeResumeProbeVerified: nativeBridgeEnabled,
    antigravityOwnedToolsDisabled: true,
    disabledToolCount: disabledKeys.length,
    disabledToolKeys: disabledKeys,
    permissionPromptsDisabled: toolConfig.askPermission?.enabled === false,
    codexToolBridge: nativeBridgeEnabled
      ? "native-mcp-same-cascade-with-prompt-fallback"
      : "codex-owned-tools-model-only",
    reason: nativeBridgeEnabled
      ? "StartCascade accepts a local MCP customization server. A live harmless probe verified MCP initialize/tools/list, the structured waiting event, tools/call, and same-Cascade continuation. External MCP permission interactions are automatically approved as soon as the waiting event appears, before Codex executes the tool; protocol failures before any Codex-visible event fall back to the prompt bridge."
      : "The native MCP bridge is disabled by default. Anti-Codex/Codex owns tools, MCP, files, task state, and verification; Antigravity supplies model text only.",
  };
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return value !== 0;
  return /^(?:1|true|yes|on|enabled)$/i.test(String(value).trim());
}

export function extractConversationId(value) {
  return value?.response?.newConversation?.conversationId
    ?? value?.response?.new_conversation?.conversation_id
    ?? value?.conversationId
    ?? value?.conversation_id
    ?? "";
}

function plannerResponseText(step) {
  const text = step?.plannerResponse?.modifiedResponse ?? step?.plannerResponse?.response;
  return typeof text === "string" ? text.trim() : "";
}

function promptMarkers(prompt) {
  return [...String(prompt ?? "").matchAll(/\b[A-Z][A-Z0-9_]{5,}\b/g)]
    .map((match) => match[0])
    .filter((marker, index, all) => all.indexOf(marker) === index);
}

function isAntigravityReadinessText(text) {
  return /(?:environment|workspace|session).{0,40}ready|please let me know what (?:task|project)|initialized|I am Antigravity|I am ready to help|Anti-Codex.*ready/i.test(text);
}

export function extractAssistantText(value, options = {}) {
  const steps = value?.trajectory?.steps ?? value?.steps ?? [];
  const completed = [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type !== "CORTEX_STEP_TYPE_PLANNER_RESPONSE") continue;
    if (step?.status && step.status !== "CORTEX_STEP_STATUS_DONE" && !options.allowIncomplete) continue;
    const text = plannerResponseText(step);
    if (text) completed.push(text);
  }
  const markers = promptMarkers(options.prompt);
  if (markers.length) {
    const matching = completed.find((text) => markers.some((marker) => text.includes(marker)));
    if (matching) return matching;
  }
  return completed.find((text) => !isAntigravityReadinessText(text)) ?? completed[0] ?? "";
}

export function extractPendingNativeToolCalls(value, allowedNames = []) {
  const allowed = new Set((allowedNames ?? []).map(String).filter(Boolean));
  const steps = value?.trajectory?.steps ?? value?.steps ?? [];
  const trajectoryId = String(
    value?.trajectory?.trajectoryId
      ?? value?.trajectory?.trajectory_id
      ?? value?.trajectoryId
      ?? value?.trajectory_id
      ?? "",
  );
  return steps.flatMap((step, stepArrayIndex) => {
    if (step?.type !== "CORTEX_STEP_TYPE_MCP_TOOL") return [];
    if (step?.status && step.status !== "CORTEX_STEP_STATUS_WAITING") return [];
    const toolCall = step?.mcpTool?.toolCall;
    const name = String(toolCall?.name ?? "");
    if (!name || (allowed.size > 0 && !allowed.has(name))) return [];
    const source = step?.metadata?.sourceTrajectoryStepInfo
      ?? step?.metadata?.source_trajectory_step_info
      ?? step?.sourceTrajectoryStepInfo
      ?? step?.source_trajectory_step_info
      ?? {};
    const sourceTrajectoryId = String(
      source?.trajectoryId
        ?? source?.trajectory_id
        ?? trajectoryId,
    );
    const rawStepIndex = source?.stepIndex
      ?? source?.step_index
      ?? step?.stepIndex
      ?? step?.step_index
      ?? stepArrayIndex;
    const sourceStepIndex = Number.isInteger(Number(rawStepIndex))
      ? Number(rawStepIndex)
      : stepArrayIndex;
    let args = {};
    try {
      args = JSON.parse(toolCall?.argumentsJson ?? toolCall?.originalArgumentsJson ?? "{}");
    } catch {
      args = { _raw: String(toolCall?.argumentsJson ?? toolCall?.originalArgumentsJson ?? "") };
    }
    const interaction = sourceTrajectoryId
      ? {
          trajectoryId: sourceTrajectoryId,
          stepIndex: sourceStepIndex,
        }
      : null;
    return [{
      callId: String(toolCall?.id ?? `call_${randomUUID().replaceAll("-", "")}`),
      name,
      arguments: args,
      ...(interaction ? { interaction } : {}),
      ...(step?.requestedInteraction ? { requestedInteraction: step.requestedInteraction } : {}),
    }];
  });
}

export function buildAntigravityToolApprovalInteraction(call, confirm = true) {
  const trajectoryId = String(call?.interaction?.trajectoryId ?? call?.trajectoryId ?? "");
  const stepIndex = Number(call?.interaction?.stepIndex ?? call?.stepIndex);
  if (!trajectoryId) throw new Error("Antigravity MCP interaction is missing trajectoryId.");
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new Error("Antigravity MCP interaction is missing a valid stepIndex.");
  }
  const requested = call?.requestedInteraction ?? {};
  const requestedCase = requested?.interaction?.case ?? "";
  const response = requested?.permission || requestedCase === "permission"
    ? { permission: { allow: confirm === true, scope: 1 } }
    : { mcp: { confirm: confirm === true } };
  return {
    trajectoryId,
    stepIndex,
    ...response,
  };
}

export const buildAntigravityMcpApprovalInteraction = buildAntigravityToolApprovalInteraction;

export async function handleAntigravityCascadeUserInteraction(connection, cascadeId, interaction, options = {}) {
  if (!cascadeId) throw new Error("Antigravity cascadeId is required.");
  return postService(
    connection,
    "HandleCascadeUserInteraction",
    { cascadeId, interaction },
    options.timeoutMs ?? 15000,
    options.fetchImpl,
    options.signal,
  );
}

export async function* resumeAntigravityNativeTurnStreamed(session, toolResults = [], options = {}) {
  const {
    connection,
    cascadeId,
    nativeToolBridge,
    pendingCalls = [],
    prompt = "",
    model = "",
    displayName = "",
    internalModel = "",
  } = session ?? {};
  if (!connection || !cascadeId || !nativeToolBridge) {
    throw new Error("Antigravity native continuation is incomplete.");
  }
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const startedAt = Date.now();
  const resultsById = new Map(toolResults.map((result) => [String(result?.callId ?? ""), result]));

  try {
    for (const call of pendingCalls) {
      const result = resultsById.get(String(call?.callId ?? ""));
      if (!result) throw new Error(`Missing Codex tool result for Antigravity call ${call?.callId ?? "unknown"}.`);
      let bridgeCallId = String(call?.bridgeCallId ?? "");
      if (call?.approvalHandled !== true && call?.interaction) {
        await handleAntigravityCascadeUserInteraction(
          connection,
          cascadeId,
          buildAntigravityToolApprovalInteraction(call, true),
          { timeoutMs: options.interactionTimeoutMs ?? 15000, fetchImpl: options.fetchImpl, signal },
        );
        const nativeCall = await nativeToolBridge.waitForCall({
          timeoutMs: options.toolCallTimeoutMs ?? timeoutMs,
          signal,
        });
        bridgeCallId = String(nativeCall?.callId ?? "");
      }
      if (!bridgeCallId && !call?.interaction) {
        bridgeCallId = String(call?.callId ?? "");
      }
      if (!bridgeCallId || !nativeToolBridge.completeCall(bridgeCallId, result.output, { isError: result.isError === true })) {
        throw new Error(`Antigravity native MCP call disappeared before completion: ${bridgeCallId || call?.callId || "unknown"}`);
      }
    }

    let fullyIdle = false;
    let idleError = null;
    let idleController = null;
    let idlePromise = null;
    let followUpSent = false;
    const startIdleWatch = () => {
      fullyIdle = false;
      idleError = null;
      idleController = new AbortController();
      idlePromise = postService(connection, "WaitForConversationFullyIdle", {
        conversationId: cascadeId,
        inactivityTimeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
        stabilizationDurationSeconds: 1,
        returnOnExecutorError: true,
      }, timeoutMs, options.fetchImpl, idleController.signal).then(
        () => { fullyIdle = true; },
        (error) => {
          fullyIdle = true;
          idleError = error;
        },
      );
    };
    startIdleWatch();

    try {
      while (true) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        if (Date.now() - startedAt > timeoutMs) throw new Error(`Antigravity timed out after ${timeoutMs}ms.`);
        const trajectory = await postService(
          connection,
          "GetCascadeTrajectory",
          { cascadeId },
          options.trajectoryTimeoutMs ?? 15000,
          options.fetchImpl,
          signal,
        );
        const errorDetail = latestCascadeError(trajectory);
        if (errorDetail) throw new Error(errorDetail);
        const calls = extractPendingNativeToolCalls(
          trajectory,
          nativeToolBridge.tools?.map((tool) => tool.name) ?? [],
        );
        if (calls.length > 0) {
          yield {
            type: "tool_call",
            calls,
            cascadeId,
            continuation: {
              ...session,
              pendingCalls: calls,
            },
          };
          return;
        }
        if (fullyIdle) {
          if (idleError) throw idleError;
          await idlePromise;
          if (options.followUpPrompt && !followUpSent) {
            followUpSent = true;
            await postService(connection, "SendUserCascadeMessage", {
              cascadeId,
              items: [{ text: String(options.followUpPrompt) }],
              blocking: false,
              cascadeConfig: {
                plannerConfig: {
                  planModel: internalModel,
                  toolConfig: antigravityModelOnlyToolConfig(),
                },
              },
            }, timeoutMs, options.fetchImpl, signal);
            startIdleWatch();
            continue;
          }
          const text = extractAssistantText(trajectory, { prompt });
          yield {
            type: "done",
            result: { cascadeId, text, trajectory, model, displayName, internalModel },
          };
          return;
        }
        await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - startedAt))), signal);
      }
    } finally {
      if (idleController && !idleController.signal.aborted) idleController.abort();
    }
  } catch (error) {
    if (options.cancelOnError !== false) {
      await cancelCascadeBestEffort(connection, cascadeId, options.fetchImpl);
    }
    throw error;
  }
}

export function discoverDesktopConnection(env = process.env) {
  if (env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      lsAddress: normalizeAddress(env.ANTIGRAVITY_LS_ADDRESS),
      agentApiAddress: normalizeAddress(env.ANTIGRAVITY_AGENTAPI_ADDRESS || env.ANTIGRAVITY_LS_ADDRESS),
      csrfToken: env.ANTIGRAVITY_CSRF_TOKEN,
    };
  }
  if (platform() !== "win32") {
    throw new Error("Anti-Codex MVP currently supports Antigravity Desktop discovery on Windows only.");
  }

  const script = [
    "$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'language_server.exe' -or $_.Name -eq 'language_server_windows_x64.exe' }",
    "$conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue",
    "$rows = foreach ($p in $procs) {",
    "  $ports = @($conns | Where-Object { $_.OwningProcess -eq $p.ProcessId -and $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1') } | Select-Object -ExpandProperty LocalPort)",
    "  [pscustomobject]@{ processId = $p.ProcessId; commandLine = $p.CommandLine; ports = $ports }",
    "}",
    "$rows | ConvertTo-Json -Depth 5",
  ].join("; ");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  }).trim();
  const parsed = output ? JSON.parse(output) : [];
  const rows = (Array.isArray(parsed) ? parsed : [parsed])
    .filter((row) => /--app_data_dir\s+antigravity(?:\s|$)/i.test(row?.commandLine ?? ""))
    .sort((a, b) => Number(b.processId ?? 0) - Number(a.processId ?? 0));
  for (const row of rows) {
    const csrfToken = String(row.commandLine ?? "").match(/--csrf_token\s+([^\s]+)/)?.[1];
    const ports = Array.isArray(row.ports) ? row.ports.map(Number).filter(Boolean).sort((a, b) => a - b) : [];
    if (csrfToken && ports.length) {
      return {
        agentApiAddress: `127.0.0.1:${ports[0]}`,
        lsAddress: `127.0.0.1:${ports.at(-1)}`,
        csrfToken,
      };
    }
  }
  throw new Error("Antigravity Desktop is not ready. Open Antigravity, sign in, then retry.");
}

export function createDesktopConnectionCache({ discover = discoverDesktopConnection } = {}) {
  let cached = null;
  return {
    get(env = process.env) {
      if (!cached) cached = discover(env);
      return cached;
    },
    invalidate(connection = null) {
      if (!connection || cached === connection) cached = null;
    },
  };
}

const DESKTOP_CONNECTION_CACHE = createDesktopConnectionCache();

function antigravityGeminiDir(env = process.env) {
  if (env.GEMINI_DIR) return env.GEMINI_DIR;
  const home = env.USERPROFILE || env.HOME || homedir();
  return join(home, ".gemini");
}

export function antigravityCliIsolationEnv(env = process.env) {
  const profileRoot = env.ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT
    || env.ANTICODEX_ANTIGRAVITY_CLI_HOME
    || "";
  const strictWindowsAppData = env.ANTICODEX_ANTIGRAVITY_CLI_ISOLATE_WINDOWS_APPDATA === "1";
  const next = {};
  if (profileRoot) {
    next.HOME = profileRoot;
    next.USERPROFILE = profileRoot;
    next.GEMINI_DIR = env.ANTICODEX_ANTIGRAVITY_CLI_GEMINI_DIR || join(profileRoot, ".gemini");
    next.ANTIGRAVITY_CLI_CONVERSATIONS_DIR = env.ANTIGRAVITY_CLI_CONVERSATIONS_DIR
      || join(next.GEMINI_DIR, "antigravity-cli", "conversations");
    if (strictWindowsAppData) {
      next.APPDATA = env.ANTICODEX_ANTIGRAVITY_CLI_APPDATA || join(profileRoot, "AppData", "Roaming");
      next.LOCALAPPDATA = env.ANTICODEX_ANTIGRAVITY_CLI_LOCALAPPDATA || join(profileRoot, "AppData", "Local");
    }
  }
  if (env.ANTICODEX_ANTIGRAVITY_CLI_HOME) next.HOME = env.ANTICODEX_ANTIGRAVITY_CLI_HOME;
  if (env.ANTICODEX_ANTIGRAVITY_CLI_USERPROFILE) next.USERPROFILE = env.ANTICODEX_ANTIGRAVITY_CLI_USERPROFILE;
  if (env.ANTICODEX_ANTIGRAVITY_CLI_APPDATA) next.APPDATA = env.ANTICODEX_ANTIGRAVITY_CLI_APPDATA;
  if (env.ANTICODEX_ANTIGRAVITY_CLI_LOCALAPPDATA) next.LOCALAPPDATA = env.ANTICODEX_ANTIGRAVITY_CLI_LOCALAPPDATA;
  if (env.ANTICODEX_ANTIGRAVITY_CLI_GEMINI_DIR) {
    next.GEMINI_DIR = env.ANTICODEX_ANTIGRAVITY_CLI_GEMINI_DIR;
    next.ANTIGRAVITY_CLI_CONVERSATIONS_DIR = env.ANTIGRAVITY_CLI_CONVERSATIONS_DIR
      || join(next.GEMINI_DIR, "antigravity-cli", "conversations");
  }
  if (env.ANTICODEX_ANTIGRAVITY_CLI_CONVERSATIONS_DIR) {
    next.ANTIGRAVITY_CLI_CONVERSATIONS_DIR = env.ANTICODEX_ANTIGRAVITY_CLI_CONVERSATIONS_DIR;
  }
  if (env.ANTIGRAVITY_CLI_CONVERSATIONS_DIR) {
    next.ANTIGRAVITY_CLI_CONVERSATIONS_DIR = env.ANTIGRAVITY_CLI_CONVERSATIONS_DIR;
  }
  return next;
}

export function defaultAgentApiCommand(env = process.env) {
  if (env.ANTIGRAVITY_AGENTAPI_BIN) return { command: env.ANTIGRAVITY_AGENTAPI_BIN, argsPrefix: [] };
  if (platform() === "win32") {
    const command = join(homedir(), "AppData", "Local", "Programs", "antigravity", "resources", "bin", "language_server.exe");
    if (existsSync(command)) return { command, argsPrefix: ["agentapi"] };
  }
  return { command: "agentapi", argsPrefix: [] };
}

export function defaultAntigravityCliCommand(env = process.env) {
  if (env.ANTIGRAVITY_CLI_BIN) return { command: env.ANTIGRAVITY_CLI_BIN, argsPrefix: [] };
  if (platform() === "win32") {
    const command = join(homedir(), "bin", "antigravity.exe");
    if (existsSync(command)) return { command, argsPrefix: [] };
  }
  return { command: platform() === "win32" ? "antigravity.exe" : "antigravity", argsPrefix: [] };
}

export function extractCreatedConversationId(logText) {
  const matches = [...String(logText ?? "").matchAll(/Created conversation\s+([0-9a-f-]{36})/gi)];
  return matches.at(-1)?.[1] ?? "";
}

export function extractProtobufStrings(payload) {
  const output = [];
  walkProtobuf(Buffer.from(payload ?? []), 0, output);
  return output;
}

export function extractCliAssistantText(payload) {
  const candidates = extractProtobufStrings(payload)
    .map((value) => value.trim())
    .filter(isAssistantTextCandidate);
  if (!candidates.length) return "";
  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  return candidates
    .map((value, index) => ({ value, index, count: counts.get(value) ?? 1 }))
    .sort((a, b) => b.count - a.count || b.value.length - a.value.length || b.index - a.index)[0].value;
}

export function antigravityCliQuotaErrorFromText(value) {
  const text = String(value ?? "");
  if (!/(?:RESOURCE_EXHAUSTED|Individual\s+quota\s+reached|quota\s+(?:reached|exceeded)|usage\s+limit\s+reached|limit\s+reached)/i.test(text)) {
    return null;
  }
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /(?:RESOURCE_EXHAUSTED|Individual\s+quota\s+reached|quota\s+(?:reached|exceeded)|usage\s+limit\s+reached|limit\s+reached)/i.test(item));
  const message = line || "Antigravity quota or usage limit reached.";
  const error = new Error(message);
  error.type = "antigravity_quota_exceeded";
  error.statusCode = 429;
  error.retryable = false;
  error.diagnosis = "quota_or_limit_reached";
  return error;
}

export function antigravityCliArgs({ model, prompt, timeoutMs, logPath }) {
  return [
    "--log-file", logPath,
    "--model", model,
    "--print-timeout", `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
    "--print",
    prompt,
  ];
}

export function windowsAntigravityCliInvocation({
  cliCommand,
  argsPrefix = [],
  model,
  timeoutMs,
  logPath,
  prompt,
}) {
  return {
    command: cliCommand,
    args: [...argsPrefix, ...antigravityCliArgs({ model, prompt, timeoutMs, logPath })],
    env: {},
  };
}

export async function fetchAvailableAgentModels(options = {}) {
  const explicitConnection = options.connection ?? null;
  const connectionCache = options.connectionCache ?? DESKTOP_CONNECTION_CACHE;
  let connection = explicitConnection ?? connectionCache.get(options.env);
  try {
    return await postService(
      connection,
      "GetAvailableModels",
      {},
      options.timeoutMs ?? 10000,
      options.fetchImpl,
      options.signal,
    );
  } catch (error) {
    if (explicitConnection || options.signal?.aborted) throw error;
    connectionCache.invalidate(connection);
    connection = connectionCache.get(options.env);
    return postService(
      connection,
      "GetAvailableModels",
      {},
      options.timeoutMs ?? 10000,
      options.fetchImpl,
      options.signal,
    );
  }
}

export async function fetchAntigravityUserStatus(options = {}) {
  const explicitConnection = options.connection ?? null;
  const connectionCache = options.connectionCache ?? DESKTOP_CONNECTION_CACHE;
  let connection = explicitConnection ?? connectionCache.get(options.env);
  try {
    return await postService(
      connection,
      "GetUserStatus",
      {},
      options.timeoutMs ?? 10000,
      options.fetchImpl,
      options.signal,
    );
  } catch (error) {
    if (explicitConnection || options.signal?.aborted) throw error;
    connectionCache.invalidate(connection);
    connection = connectionCache.get(options.env);
    return postService(
      connection,
      "GetUserStatus",
      {},
      options.timeoutMs ?? 10000,
      options.fetchImpl,
      options.signal,
    );
  }
}

export function antigravityAccountSnapshot(payload) {
  const status = payload?.userStatus ?? payload?.user_status ?? {};
  const email = String(status.email ?? "").trim().toLowerCase();
  const planStatus = status.planStatus ?? status.plan_status ?? {};
  const planInfo = planStatus.planInfo ?? planStatus.plan_info ?? {};
  const tier = status.userTier ?? status.user_tier ?? {};
  const fingerprint = email
    ? `sha256:${createHash("sha256").update(email, "utf8").digest("hex")}`
    : "";

  return {
    object: "antigravity.account",
    signedIn: Boolean(email),
    identityAvailable: Boolean(fingerprint),
    fingerprint,
    planName: String(planInfo.planName ?? planInfo.plan_name ?? ""),
    tierName: String(tier.name ?? ""),
    maxInputTokens: String(planInfo.maxNumChatInputTokens ?? planInfo.max_num_chat_input_tokens ?? ""),
    webSearchEnabled: planInfo.cascadeWebSearchEnabled === true
      || planInfo.cascade_web_search_enabled === true,
    browserEnabled: planInfo.browserEnabled === true
      || planInfo.browser_enabled === true,
    autoRunCommandsEnabled: planInfo.cascadeCanAutoRunCommands === true
      || planInfo.cascade_can_auto_run_commands === true,
  };
}

export function extractAvailableAgentModelEntries(payload) {
  const response = payload?.response ?? {};
  const models = response.models ?? {};
  const ids = [];
  for (const sort of response.agentModelSorts ?? []) {
    for (const group of sort.groups ?? []) {
      for (const id of group.modelIds ?? []) {
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
  }
  for (const id of Object.keys(models)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids
    .map((id) => ({ id, ...(models[id] ?? {}) }))
    .filter((model) => model.id);
}

export function resolveAntigravityModel(payload, requestedModel) {
  const entries = extractAvailableAgentModelEntries(payload);
  if (!entries.length) {
    throw new Error(
      "Antigravity has no available models. Open Antigravity, sign in, and confirm its proxy connection, then retry.",
    );
  }
  const requested = String(requestedModel ?? "").trim();
  const aliases = new Map([
    ["gpt-5.5", "gemini-pro-agent"],
    ["gpt-5.4", "gemini-pro-agent"],
    ["gpt-5.4-mini", "gemini-3.5-flash-low"],
    ["gpt-5.3-codex", "gemini-pro-agent"],
    ["antigravity-pro", "gemini-pro-agent"],
    ["antigravity-flash", "gemini-3.5-flash-low"],
  ]);
  const wanted = aliases.get(requested.toLowerCase()) ?? requested;
  const normalizedWanted = wanted.toLowerCase();
  const match = entries.find((model) => {
    return [
      model.id,
      model.model,
      model.displayName,
      model.display_name,
    ].some((value) => String(value ?? "").toLowerCase() === normalizedWanted);
  }) ?? entries.find((model) => model.id === "gemini-pro-agent")
    ?? entries.find((model) => /gemini.*pro/i.test(model.displayName ?? model.id))
    ?? entries[0];

  const internalModel = match.model;
  if (!internalModel) {
    throw new Error(`Antigravity model ${match.id} does not expose an internal model enum.`);
  }
  return {
    id: match.id,
    displayName: normalizeAntigravityDisplayName(match.id, match.displayName ?? match.id),
    internalModel,
    raw: match,
  };
}

export function discoverProjectId(cwd, env = process.env) {
  if (env.ANTIGRAVITY_PROJECT_ID) return env.ANTIGRAVITY_PROJECT_ID;
  const projectsDir = join(antigravityGeminiDir(env), "config", "projects");
  if (!existsSync(projectsDir)) return "";
  const target = normalizePath(cwd);
  const projects = readdirSync(projectsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(projectsDir, name);
      try {
        return { config: JSON.parse(readFileSync(path, "utf8")), mtimeMs: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ config }) => config?.id && config.id !== "outside-of-project");
  const matching = projects
    .filter(({ config }) => (config?.projectResources?.resources ?? []).some((resource) => {
      const uri = resource?.gitFolder?.folderUri;
      if (!uri) return false;
      const folder = normalizePath(decodeFileUri(uri));
      return target === folder || target.startsWith(`${folder}/`);
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matching[0]?.config?.id ?? projects.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.config?.id ?? "";
}

export async function runAntigravityTextTurn(prompt, options = {}) {
  if (!prompt || typeof prompt !== "string") throw new Error("Antigravity prompt is required.");
  const cwd = resolveCwd(options.cwd ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandSpec = options.commandSpec ?? defaultAntigravityCliCommand(options.env);
  const model = options.model ?? "gemini-pro-agent";
  const logPath = join(tmpdir(), `anticodex-antigravity-${randomUUID()}.log`);
  const promptPath = join(tmpdir(), `anticodex-antigravity-${randomUUID()}.txt`);
  writeFileSync(promptPath, prompt, "utf8");
  const invocation = platform() === "win32"
    ? windowsAntigravityCliInvocation({
        cliCommand: commandSpec.command,
        argsPrefix: commandSpec.argsPrefix,
        model,
        timeoutMs,
        logPath,
        prompt,
      })
    : {
        command: commandSpec.command,
        args: [...commandSpec.argsPrefix, ...antigravityCliArgs({ model, prompt, timeoutMs, logPath })],
        env: {},
      };
  const result = await runProcess(invocation.command, invocation.args, {
    cwd,
    timeoutMs: timeoutMs + 5000,
    env: {
      ...process.env,
      ...options.env,
      ...antigravityCliIsolationEnv({ ...process.env, ...options.env }),
      ...invocation.env,
    },
    captureStdout: false,
  });
  try {
    const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const quotaError = antigravityCliQuotaErrorFromText(`${result.stderr || ""}\n${result.stdout || ""}\n${logText}`);
    if (!result.ok) {
      if (quotaError) throw quotaError;
      const detail = result.timedOut ? `Antigravity timed out after ${timeoutMs}ms.` : "";
      throw new Error(result.stderr || result.stdout || detail || "Antigravity CLI request failed.");
    }
    const stdout = result.stdout.trim();
    const conversationId = extractCreatedConversationId(logText);
    if (stdout) return { conversationId, text: stdout, trajectory: null };
    if (quotaError) throw quotaError;
    if (!conversationId) throw new Error("Antigravity CLI completed without a conversation id.");
    const text = await readCliConversationText(conversationId, {
      ...process.env,
      ...options.env,
      ...antigravityCliIsolationEnv({ ...process.env, ...options.env }),
    });
    if (!text) throw new Error("Antigravity completed without a readable assistant response.");
    return { conversationId, text, trajectory: null };
  } finally {
    rmSync(logPath, { force: true });
    rmSync(promptPath, { force: true });
  }
}

export async function runAntigravityNativeTurn(prompt, options = {}) {
  if (!prompt || typeof prompt !== "string") throw new Error("Antigravity prompt is required.");
  const cwd = resolveCwd(options.cwd ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const explicitConnection = options.connection ?? null;
  let connection = explicitConnection ?? DESKTOP_CONNECTION_CACHE.get(options.env);
  const { signal, onCascadeStarted } = options;

  if (signal?.aborted) {
    throw new DOMException(signal.reason?.message ?? 'The operation was aborted', 'AbortError');
  }

  const modelsPayload = await fetchAvailableAgentModels({
    ...(explicitConnection ? { connection: explicitConnection } : {}),
    timeoutMs: options.modelTimeoutMs ?? 10000,
    fetchImpl: options.fetchImpl,
    signal,
  });
  if (!explicitConnection) connection = DESKTOP_CONNECTION_CACHE.get(options.env);
  const model = resolveAntigravityModel(modelsPayload, options.model ?? "gemini-pro-agent");
  const startBody = {
    source: "CORTEX_TRAJECTORY_SOURCE_CLI",
    trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
    workspaceUris: [pathToFileURL(cwd).href],
  };
  if (options.customAgentSpec) startBody.customAgentSpec = options.customAgentSpec;
  const start = await postService(connection, "StartCascade", startBody, options.startTimeoutMs ?? 15000, options.fetchImpl, signal);
  const cascadeId = start?.cascadeId;
  if (!cascadeId) throw new Error("Antigravity did not create a cascade conversation.");

  if (typeof onCascadeStarted === 'function') {
    onCascadeStarted({ cascadeId, connection });
  }

  let didCancel = false;

  const onAbort = () => {
    if (!didCancel) {
      didCancel = true;
      cancelCascadeBestEffort(connection, cascadeId, options.fetchImpl);
    }
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    try {
      await postService(connection, "SendUserCascadeMessage", {
        cascadeId,
        items: [{ text: prompt }],
        blocking: true,
        cascadeConfig: {
          plannerConfig: {
            planModel: model.internalModel,
            toolConfig: antigravityModelOnlyToolConfig(),
          },
        },
      }, timeoutMs, options.fetchImpl, signal);
    } catch (error) {
      if (!didCancel) {
        await cancelCascadeBestEffort(connection, cascadeId, options.fetchImpl);
      }
      throw error;
    }

    const trajectory = await postService(connection, "GetCascadeTrajectory", { cascadeId }, options.trajectoryTimeoutMs ?? 15000, options.fetchImpl, signal);
    const text = extractAssistantText(trajectory, { prompt });
    if (!text) {
      const detail = latestCascadeError(trajectory);
      throw new Error(detail || "Antigravity completed without a readable assistant response.");
    }
    return {
      conversationId: cascadeId,
      cascadeId,
      text,
      trajectory,
      model: model.id,
      displayName: model.displayName,
      internalModel: model.internalModel,
    };
  } finally {
    if (signal && !signal.aborted) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export async function cancelAntigravityCascade(connection, cascadeId, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  await postService(connection, "CancelCascadeInvocation", { cascadeId }, options.timeoutMs ?? 5000, fetchImpl);
}

async function postService(connection, method, body, timeoutMs, fetchImpl = fetch, externalSignal = null) {
  const controller = new AbortController();

  function onExternalAbort() {
    controller.abort(externalSignal.reason);
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://${normalizeAddress(connection.lsAddress)}${SERVICE_PREFIX}/${method}`, {
      method: "POST",
      headers: requestHeaders(connection.csrfToken),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} failed (${response.status}): ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function cancelCascadeBestEffort(connection, cascadeId, fetchImpl) {
  try {
    await postService(connection, "CancelCascadeInvocation", { cascadeId }, 5000, fetchImpl);
  } catch {
    // Cancellation is best effort; preserve the original request error.
  }
}

function latestCascadeError(value) {
  const steps = value?.trajectory?.steps ?? value?.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    const message = step?.error?.message ?? step?.errorMessage ?? step?.plannerResponse?.errorMessage;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "";
}

async function readCliConversationText(conversationId, env = process.env) {
  const root = env.ANTIGRAVITY_CLI_CONVERSATIONS_DIR
    || join(homedir(), ".gemini", "antigravity-cli", "conversations");
  const dbPath = join(root, `${conversationId}.db`);
  if (!existsSync(dbPath)) throw new Error(`Antigravity conversation database was not found: ${conversationId}`);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      "select step_payload from steps where step_type = 15 and status = 3 order by idx desc",
    ).all();
    for (const row of rows) {
      const text = extractCliAssistantText(row.step_payload);
      if (text) return text;
    }
    return "";
  } finally {
    db.close();
  }
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: options.captureStdout === false
        ? ["ignore", "ignore", "pipe"]
        : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr, timedOut });
    });
  });
}

function resolveCwd(cwd) {
  const absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
  if (!existsSync(absolute)) throw new Error(`Workspace does not exist: ${absolute}`);
  return absolute;
}

function normalizeAddress(value) {
  return String(value ?? "").replace(/^https?:\/\//, "").replace(/^localhost:/, "127.0.0.1:");
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function decodeFileUri(uri) {
  return decodeURIComponent(String(uri).replace(/^file:\/\/\//, "").replace(/^file:\/\//, ""));
}

function walkProtobuf(buffer, depth, output) {
  if (depth > 8 || !buffer.length) return;
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    if (!key) return;
    offset = key.next;
    const wireType = key.value & 7;
    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      if (!value) return;
      offset = value.next;
      continue;
    }
    if (wireType === 1) {
      offset += 8;
      continue;
    }
    if (wireType === 5) {
      offset += 4;
      continue;
    }
    if (wireType !== 2) return;
    const length = readVarint(buffer, offset);
    if (!length) return;
    offset = length.next;
    if (length.value < 0 || offset + length.value > buffer.length) return;
    const part = buffer.subarray(offset, offset + length.value);
    offset += length.value;
    const text = part.toString("utf8");
    if (text && !text.includes("\uFFFD") && isPrintableText(text)) output.push(text);
    walkProtobuf(part, depth + 1, output);
  }
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  for (let index = offset; index < buffer.length && index < offset + 10; index += 1) {
    const byte = buffer[index];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value: Number(value), next: index + 1 };
    shift += 7n;
  }
  return null;
}

function isPrintableText(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
}

function isAssistantTextCandidate(value) {
  if (!value || value === "sessionID") return false;
  if (/^(?:req_|bot-)/i.test(value)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return false;
  if (/^[A-Z][A-Z0-9_]{6,120}$/.test(value) && value.includes("_")) return true;
  if (/^[A-Za-z0-9_-]{20,32}$/.test(value) && !/\s/.test(value)) return false;
  if (/^-?\d+$/.test(value)) return false;
  if (value.length > 80 && /^[A-Za-z0-9+/=]+$/.test(value)) return false;
  return true;
}

export async function* runAntigravityNativeTurnStreamed(prompt, options = {}) {
  if (!prompt || typeof prompt !== "string") throw new Error("Antigravity prompt is required.");
  const cwd = resolveCwd(options.cwd ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const explicitConnection = options.connection ?? null;
  let connection = explicitConnection ?? DESKTOP_CONNECTION_CACHE.get(options.env);
  const { signal, onCascadeStarted } = options;

  if (signal?.aborted) {
    throw new DOMException(signal.reason?.message ?? 'The operation was aborted', 'AbortError');
  }

  let cascadeId = null;
  let completedNormally = false;
  let didCancel = false;
  const idleController = new AbortController();

  const cancelAndClean = () => {
    if (didCancel) return;
    didCancel = true;
    if (cascadeId) {
      cancelCascadeBestEffort(connection, cascadeId, options.fetchImpl);
    }
  };

  const onAbort = () => {
    if (!idleController.signal.aborted) idleController.abort(signal?.reason);
    cancelAndClean();
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const startTime = Date.now();

  try {
    const modelsPayload = await fetchAvailableAgentModels({
      ...(explicitConnection ? { connection: explicitConnection } : {}),
      timeoutMs: options.modelTimeoutMs ?? 10000,
      fetchImpl: options.fetchImpl,
      signal,
    });
    if (!explicitConnection) connection = DESKTOP_CONNECTION_CACHE.get(options.env);
    const model = resolveAntigravityModel(modelsPayload, options.model ?? "gemini-pro-agent");

    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Antigravity timed out after ${timeoutMs}ms.`);
    }

    const startBody = {
      source: "CORTEX_TRAJECTORY_SOURCE_CLI",
      trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
      workspaceUris: [pathToFileURL(cwd).href],
    };
    if (options.customAgentSpec) startBody.customAgentSpec = options.customAgentSpec;
    const start = await postService(connection, "StartCascade", startBody, options.startTimeoutMs ?? 15000, options.fetchImpl, signal);

    cascadeId = start?.cascadeId;
    if (!cascadeId) throw new Error("Antigravity did not create a cascade conversation.");

    if (typeof onCascadeStarted === 'function') {
      onCascadeStarted({ cascadeId, connection });
    }

    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Antigravity timed out after ${timeoutMs}ms.`);
    }

    await postService(connection, "SendUserCascadeMessage", {
      cascadeId,
      items: [{ text: prompt }],
      blocking: false,
      cascadeConfig: {
        plannerConfig: {
          planModel: model.internalModel,
          toolConfig: antigravityModelOnlyToolConfig(),
        },
      },
    }, timeoutMs, options.fetchImpl, signal);

    let prevText = "";
    let latestTrajectory = null;
    let fullyIdle = false;
    let idleError = null;
    const idlePromise = postService(connection, "WaitForConversationFullyIdle", {
      conversationId: cascadeId,
      inactivityTimeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
      stabilizationDurationSeconds: 1,
      returnOnExecutorError: true,
    }, timeoutMs, options.fetchImpl, idleController.signal).then(
      () => { fullyIdle = true; },
      (error) => {
        fullyIdle = true;
        idleError = error;
      },
    );

    while (true) {
      if (signal?.aborted) {
        throw new DOMException(signal.reason?.message ?? 'The operation was aborted', 'AbortError');
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        throw new Error(`Antigravity timed out after ${timeoutMs}ms.`);
      }

      const trajectory = await postService(
        connection,
        "GetCascadeTrajectory",
        { cascadeId },
        options.trajectoryTimeoutMs ?? 15000,
        options.fetchImpl,
        signal
      );
      latestTrajectory = trajectory;

      const errorDetail = latestCascadeError(trajectory);
      if (errorDetail) {
        throw new Error(errorDetail);
      }

      const allowedNativeToolNames = options.nativeToolBridge?.tools?.map((tool) => tool.name) ?? [];
      const waitingNativeToolCalls = extractPendingNativeToolCalls(trajectory, allowedNativeToolNames);
      const nativeToolCalls = waitingNativeToolCalls.length > 0
        ? await approveAndCaptureNativeToolCalls({
            connection,
            cascadeId,
            calls: waitingNativeToolCalls,
            nativeToolBridge: options.nativeToolBridge,
            timeoutMs,
            interactionTimeoutMs: options.interactionTimeoutMs,
            toolCallTimeoutMs: options.toolCallTimeoutMs,
            fetchImpl: options.fetchImpl,
            signal,
          })
        : (options.nativeToolBridge?.takeCalls?.() ?? []);
      if (nativeToolCalls.length > 0) {
        if (options.retainOnToolCall === true) completedNormally = true;
        yield {
          type: "tool_call",
          calls: nativeToolCalls,
          cascadeId,
          ...(options.retainOnToolCall === true ? {
            continuation: {
              connection,
              cascadeId,
              nativeToolBridge: options.nativeToolBridge,
              pendingCalls: nativeToolCalls,
              prompt,
              model: model.id,
              displayName: model.displayName,
              internalModel: model.internalModel,
            },
          } : {}),
        };
        return;
      }

      const steps = trajectory?.trajectory?.steps ?? trajectory?.steps ?? [];
      let latestPlannerStep = null;
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        if (steps[index]?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
          latestPlannerStep = steps[index];
          break;
        }
      }

      const currText = extractAssistantText(trajectory, { prompt, allowIncomplete: true });

      if (currText !== prevText) {
        let commonLength = 0;
        const minLen = Math.min(prevText.length, currText.length);
        while (commonLength < minLen && prevText[commonLength] === currText[commonLength]) {
          commonLength++;
        }

        if (commonLength === prevText.length) {
          const delta = currText.slice(commonLength);
          if (delta) {
            yield { type: 'text_delta', delta, text: currText };
          }
        } else {
          yield { type: 'text_replace', text: currText };
        }
        prevText = currText;
      }

      if (fullyIdle) {
        if (idleError) throw idleError;
        const finalTrajectory = await postService(
          connection,
          "GetCascadeTrajectory",
          { cascadeId },
          options.trajectoryTimeoutMs ?? 15000,
          options.fetchImpl,
          signal
        );
        const finalError = latestCascadeError(finalTrajectory);
        if (finalError) throw new Error(finalError);
        latestTrajectory = finalTrajectory;
        const finalText = extractAssistantText(finalTrajectory, { prompt }) || currText;
        if (finalText !== prevText) {
          let commonLength = 0;
          const minLen = Math.min(prevText.length, finalText.length);
          while (commonLength < minLen && prevText[commonLength] === finalText[commonLength]) {
            commonLength++;
          }
          if (commonLength === prevText.length) {
            const delta = finalText.slice(commonLength);
            if (delta) yield { type: 'text_delta', delta, text: finalText };
          } else {
            yield { type: 'text_replace', text: finalText };
          }
          prevText = finalText;
        }
        completedNormally = true;
        yield {
          type: 'done',
          result: {
            cascadeId,
            text: finalText,
            trajectory: latestTrajectory,
            model: model.id,
            displayName: model.displayName,
            internalModel: model.internalModel,
          },
        };
        break;
      }

      const sleepRemaining = timeoutMs - (Date.now() - startTime);
      if (sleepRemaining <= 0) {
        throw new Error(`Antigravity timed out after ${timeoutMs}ms.`);
      }
      await sleep(Math.min(pollIntervalMs, sleepRemaining), signal);
    }
    await idlePromise;
  } finally {
    if (!idleController.signal.aborted) idleController.abort();
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    if (!completedNormally) {
      cancelAndClean();
    }
  }
}

async function approveAndCaptureNativeToolCalls(options) {
  const calls = [];
  for (const call of options.calls ?? []) {
    if (!call?.interaction) {
      calls.push(call);
      continue;
    }
    await handleAntigravityCascadeUserInteraction(
      options.connection,
      options.cascadeId,
      buildAntigravityToolApprovalInteraction(call, true),
      {
        timeoutMs: options.interactionTimeoutMs ?? 15000,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      },
    );
    const nativeCall = await options.nativeToolBridge.waitForCall({
      timeoutMs: options.toolCallTimeoutMs ?? options.timeoutMs,
      signal: options.signal,
    });
    if (nativeCall?.name && nativeCall.name !== call.name) {
      throw new Error(`Antigravity native MCP call mismatch: expected ${call.name}, received ${nativeCall.name}.`);
    }
    calls.push({
      ...call,
      arguments: nativeCall?.arguments ?? call.arguments,
      bridgeCallId: String(nativeCall?.callId ?? ""),
      approvalHandled: true,
    });
  }
  return calls;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  let timer;
  const onAbort = () => {
    clearTimeout(timer);
    reject(new DOMException(signal?.reason?.message ?? 'The operation was aborted', 'AbortError'));
  };
  if (signal?.aborted) {
    return reject(new DOMException(signal.reason?.message ?? 'The operation was aborted', 'AbortError'));
  }
  timer = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
});
