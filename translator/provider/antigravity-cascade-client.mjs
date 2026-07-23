import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import {
  createAntigravityNativeMcpBridge,
  withAntigravitySystemPromptSections,
} from "../antigravity-native-mcp-bridge.mjs";
import { DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS } from "../antigravity-contract.mjs";
import { extractAvailableAgentModels } from "../antigravity-model-catalog.mjs";

const SERVICE_PREFIX = "/exa.language_server_pb.LanguageServerService";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_START_TIMEOUT_MS = 60 * 1000;
const MAX_TRANSIENT_IDLE_RETRIES = 10;
const TOOL_COMPATIBILITY_SECTION = Object.freeze({
  title: "Anti-Codex Antigravity tool compatibility",
  content: [
    "Before every tool call, emit one short user-visible progress sentence in the current user's language.",
    "For a Chinese user, the first visible progress sentence of every turn must be Chinese. Immediately before every tool call, emit a Chinese progress sentence; never emit an English progress sentence before the first tool call in a Chinese turn.",
    "Use only Codex tool results and paths inside the user workspace. Never read private provider state such as .gemini/antigravity/brain, .system_generated, transcripts, histories, logs, or provider-saved output files.",
    "If a tool result is too long, truncated, or mentions provider-saved output, rerun a narrower command inside the user workspace instead of reading the provider file.",
    "Do not run git status or inspect parent directories unless the user explicitly requests it and the current directory is a Git repository.",
  ].join("\n"),
  metadata: { isInternal: true },
});
const TEXT_ONLY_COMPATIBILITY_SECTION = Object.freeze({
  title: "Anti-Codex Antigravity text-only compatibility",
  content: [
    "No Chat tools are supplied for this request. Return text or reasoning only.",
    "Do not request execute_command, shell commands, MCP calls, or any native provider tool.",
    "Do not mention, inspect, or rely on private provider state, scratch directories, brain data, transcripts, histories, or logs.",
  ].join("\n"),
  metadata: { isInternal: true },
});

export function createAntigravityCascadeClient(options = {}) {
  const explicitConnection = options.connection ?? null;
  const discoverConnection = options.discoverConnection ?? discoverAntigravityDesktopConnection;
  const fetchImpl = options.fetchImpl ?? fetch;
  const createToolBridge = options.createToolBridge ?? createAntigravityNativeMcpBridge;
  const defaultTimeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, 500);
  let cachedConnection = explicitConnection;

  const connection = () => {
    if (!cachedConnection) cachedConnection = discoverConnection(options.env ?? process.env);
    return cachedConnection;
  };

  async function listModels(requestOptions = {}) {
    const payload = await discoveryServiceCall("GetAvailableModels", {}, {
      signal: requestOptions.signal,
      timeoutMs: requestOptions.timeoutMs ?? options.modelTimeoutMs ?? 10000,
    });
    return extractAvailableModelEntries(payload).map(normalizeModelEntry);
  }

  async function getReadiness(requestOptions = {}) {
    const payload = await discoveryServiceCall("GetUserStatus", {}, {
      signal: requestOptions.signal,
      timeoutMs: requestOptions.timeoutMs ?? options.statusTimeoutMs ?? 10000,
    });
    const status = payload?.userStatus ?? payload?.user_status ?? {};
    const email = String(status.email ?? "").trim().toLowerCase();
    const planStatus = status.planStatus ?? status.plan_status ?? {};
    const planInfo = planStatus.planInfo ?? planStatus.plan_info ?? {};
    const tier = status.userTier ?? status.user_tier ?? {};
    return {
      signedIn: Boolean(email),
      accountFingerprint: email
        ? `sha256:${createHash("sha256").update(email, "utf8").digest("hex")}`
        : "",
      planName: String(planInfo.planName ?? planInfo.plan_name ?? ""),
      tierName: String(tier.name ?? ""),
    };
  }

  async function discoveryServiceCall(method, body, requestOptions) {
    const firstConnection = connection();
    try {
      return await serviceCall(firstConnection, method, body, { fetchImpl, ...requestOptions });
    } catch (error) {
      if (explicitConnection || requestOptions.signal?.aborted || !isConnectionError(error)) throw error;
      cachedConnection = null;
      const rediscovered = connection();
      return serviceCall(rediscovered, method, body, { fetchImpl, ...requestOptions });
    }
  }

  async function* start(request = {}) {
    const signal = request.signal;
    throwIfAborted(signal);
    const timeoutMs = positiveInteger(request.timeoutMs, defaultTimeoutMs);
    const modelEntries = await listModels({ signal, timeoutMs: request.modelTimeoutMs });
    const model = resolveModel(modelEntries, request.model);
    const activeConnection = connection();
    const systemPromptSections = withToolCompatibilitySection(
      renderSystemPromptSections(request.systemSections),
      request.tools,
    );
    let bridge = null;
    let continuation = null;

    try {
      if (Array.isArray(request.tools) && request.tools.length > 0) {
        bridge = await createToolBridge({
          tools: request.tools,
          systemPromptSections,
          signal,
          pendingCallTimeoutMs: positiveInteger(
            request.toolContinuationTimeoutMs ?? options.toolContinuationTimeoutMs,
            DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS,
          ),
        });
      }
      const customAgentSpec = withAntigravitySystemPromptSections(
        bridge?.customAgentSpec ?? {},
        systemPromptSections,
      );
      const startBody = {
        source: "CORTEX_TRAJECTORY_SOURCE_CLI",
        trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
        workspaceUris: [],
        ...(Object.keys(customAgentSpec).length ? { customAgentSpec } : {}),
      };
      const started = await serviceCall(activeConnection, "StartCascade", startBody, {
        fetchImpl,
        signal,
        timeoutMs: request.startTimeoutMs ?? options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      });
      const cascadeId = String(started?.cascadeId ?? started?.cascade_id ?? "");
      if (!cascadeId) throw new AntigravityCascadeError("Antigravity did not create a Cascade.", { statusCode: 503 });

      continuation = {
        connection: activeConnection,
        cascadeId,
        bridge,
        model,
        pendingCalls: [],
        resumeAfterStepIndex: -1,
        lastAssistantText: "",
        seenToolEvents: new Set(),
        retained: false,
      };
      await serviceCall(activeConnection, "SendUserCascadeMessage", {
        cascadeId,
        items: [{ text: requiredText(request.userText, "current user text") }],
        blocking: false,
        cascadeConfig: {
          conversationHistoryConfig: { enabled: false, maxConversations: 0 },
          plannerConfig: {
            planModel: model.internalModel,
            toolConfig: modelOnlyToolConfig(),
          },
        },
      }, { fetchImpl, signal, timeoutMs });

      yield* observeCascade(continuation, {
        fetchImpl,
        signal,
        timeoutMs,
        pollIntervalMs: request.pollIntervalMs ?? pollIntervalMs,
        interactionTimeoutMs: request.interactionTimeoutMs ?? options.interactionTimeoutMs,
        toolCallTimeoutMs: request.toolCallTimeoutMs ?? options.toolCallTimeoutMs,
      });
    } catch (error) {
      if (continuation) await cancel(continuation).catch(() => {});
      else await bridge?.close?.().catch(() => {});
      throw error;
    } finally {
      if (!continuation?.retained && continuation) await continuation.bridge?.close?.().catch(() => {});
    }
  }

  async function* resume(continuation, results = [], request = {}) {
    validateContinuation(continuation);
    const signal = request.signal;
    throwIfAborted(signal);
    const timeoutMs = positiveInteger(request.timeoutMs, defaultTimeoutMs);
    const resultMap = new Map(results.map((result) => [String(result?.callId ?? ""), result]));
    const expected = continuation.pendingCalls ?? [];
    if (resultMap.size !== expected.length || expected.some((call) => !resultMap.has(call.callId))) {
      throw new AntigravityCascadeError("Every pending Cascade tool result is required.", { statusCode: 409 });
    }

    try {
      for (const call of expected) {
        const result = resultMap.get(call.callId);
        const completed = continuation.bridge.completeCall(call.callId, result.output, {
          isError: result.isError === true,
        });
        if (!completed) {
          throw new AntigravityCascadeError(`Native MCP call is no longer pending: ${call.callId}`, { statusCode: 409 });
        }
      }
      continuation.pendingCalls = [];
      continuation.retained = false;
      yield* observeCascade(continuation, {
        fetchImpl,
        signal,
        timeoutMs,
        pollIntervalMs: request.pollIntervalMs ?? pollIntervalMs,
        interactionTimeoutMs: request.interactionTimeoutMs ?? options.interactionTimeoutMs,
        toolCallTimeoutMs: request.toolCallTimeoutMs ?? options.toolCallTimeoutMs,
      });
    } catch (error) {
      await cancel(continuation).catch(() => {});
      throw error;
    } finally {
      if (!continuation.retained) await continuation.bridge?.close?.().catch(() => {});
    }
  }

  async function cancel(continuation) {
    if (!continuation?.connection || !continuation?.cascadeId) return;
    try {
      await serviceCall(continuation.connection, "CancelCascadeInvocation", {
        cascadeId: continuation.cascadeId,
      }, { fetchImpl, timeoutMs: options.cancelTimeoutMs ?? 5000 });
    } finally {
      await continuation.bridge?.close?.().catch(() => {});
    }
  }

  return { listModels, getReadiness, start, resume, cancel };
}

async function* observeCascade(continuation, options) {
  const { connection, cascadeId, bridge, model } = continuation;
  const startedAt = Date.now();
  let idleController = null;
  const onAbort = () => idleController?.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let idle = false;
  let idleError = null;
  let idlePromise = null;
  let transientIdleRetries = 0;
  const startIdleWatch = () => {
    idle = false;
    idleError = null;
    idleController = new AbortController();
    idlePromise = serviceCall(connection, "WaitForConversationFullyIdle", {
      conversationId: cascadeId,
      inactivityTimeoutSeconds: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
      stabilizationDurationSeconds: 1,
      returnOnExecutorError: true,
    }, {
      fetchImpl: options.fetchImpl,
      signal: idleController.signal,
      timeoutMs: options.timeoutMs,
    }).then(
      () => { idle = true; },
      (error) => {
        idle = true;
        idleError = error;
      },
    );
  };
  startIdleWatch();

  try {
    while (true) {
      throwIfAborted(options.signal);
      if (Date.now() - startedAt > options.timeoutMs) {
        throw new AntigravityCascadeError(`Antigravity timed out after ${options.timeoutMs}ms.`, {
          statusCode: 504,
          name: "TimeoutError",
        });
      }
      const trajectory = await serviceCall(connection, "GetCascadeTrajectory", { cascadeId }, {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        timeoutMs: Math.min(options.timeoutMs, 15000),
      });
      const trajectoryError = extractTrajectoryError(trajectory);
      if (trajectoryError) throw classifyTrajectoryError(trajectoryError);

      const pending = extractPendingMcpCalls(trajectory, bridge?.tools?.map((tool) => tool.name) ?? [])
        .filter((call) => !continuation.seenToolEvents?.has(call.trajectoryKey));
      if (pending.length > 0) {
        if (!bridge) {
          throw new AntigravityCascadeError("Cascade requested a tool without a native MCP bridge.", { statusCode: 502 });
        }
        const text = extractNewAssistantText(trajectory, continuation);
        if (text) {
          continuation.lastAssistantText = text;
          yield { type: "text_delta", delta: text };
        }
        const calls = await captureNativeCalls({
          connection,
          cascadeId,
          bridge,
          pending,
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          interactionTimeoutMs: options.interactionTimeoutMs ?? 15000,
          toolCallTimeoutMs: options.toolCallTimeoutMs ?? options.timeoutMs,
        });
        continuation.seenToolEvents ??= new Set();
        for (const call of pending) continuation.seenToolEvents.add(call.trajectoryKey);
        continuation.pendingCalls = calls;
        continuation.resumeAfterStepIndex = Math.max(...pending.map((call) => call.stepArrayIndex));
        continuation.retained = true;
        if (!idleController.signal.aborted) idleController.abort();
        yield { type: "tool_calls", calls, continuation };
        return true;
      }

      if (idle) {
        if (idleError
          && isTransientEmptyTrajectoryIdleError(idleError)
          && transientIdleRetries < MAX_TRANSIENT_IDLE_RETRIES) {
          transientIdleRetries += 1;
          // Retry only the idempotent idle watcher; the completed tool result is never replayed.
          await sleep(Math.min(options.pollIntervalMs, 500), options.signal);
          startIdleWatch();
          continue;
        }
        if (idleError) throw idleError;
        const finalTrajectory = await serviceCall(connection, "GetCascadeTrajectory", { cascadeId }, {
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          timeoutMs: Math.min(options.timeoutMs, 15000),
        });
        const finalError = extractTrajectoryError(finalTrajectory);
        if (finalError) throw classifyTrajectoryError(finalError);
        const finalPending = extractPendingMcpCalls(
          finalTrajectory,
          bridge?.tools?.map((tool) => tool.name) ?? [],
        ).filter((call) => !continuation.seenToolEvents?.has(call.trajectoryKey));
        if (finalPending.length > 0) continue;
        const text = extractNewAssistantText(finalTrajectory, continuation);
        if (text) {
          continuation.lastAssistantText = text;
          yield { type: "text_delta", delta: text };
        }
        if (!text
          && continuation.resumeAfterStepIndex >= 0
          && transientIdleRetries < MAX_TRANSIENT_IDLE_RETRIES) {
          transientIdleRetries += 1;
          // A successful idle response can still race the trajectory update after a native tool result.
          await sleep(Math.min(options.pollIntervalMs, 500), options.signal);
          startIdleWatch();
          continue;
        }
        continuation.retained = false;
        yield { type: "done", result: { cascadeId, model: model.id } };
        return false;
      }
      await sleep(Math.min(options.pollIntervalMs, Math.max(1, options.timeoutMs - (Date.now() - startedAt))), options.signal);
    }
  } finally {
    if (idleController && !idleController.signal.aborted) idleController.abort();
    options.signal?.removeEventListener("abort", onAbort);
    await idlePromise;
  }
}

function isTransientEmptyTrajectoryIdleError(error) {
  return /trajectory converted to zero chat messages/i.test(String(error?.message ?? error));
}

async function captureNativeCalls(options) {
  for (const pending of options.pending) {
    if (!pending.interaction) continue;
    await serviceCall(options.connection, "HandleCascadeUserInteraction", {
      cascadeId: options.cascadeId,
      interaction: {
        trajectoryId: pending.interaction.trajectoryId,
        stepIndex: pending.interaction.stepIndex,
        ...approvalFor(pending.requestedInteraction),
      },
    }, {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      timeoutMs: options.interactionTimeoutMs,
    });
  }

  const nativeCalls = [];
  for (let index = 0; index < options.pending.length; index += 1) {
    nativeCalls.push(await options.bridge.waitForCall({
      timeoutMs: options.toolCallTimeoutMs,
      signal: options.signal,
    }));
  }

  const calls = [];
  for (const pending of options.pending) {
    const exactIndexes = nativeCalls.flatMap((nativeCall, index) => (
      nativeCallIdMatches(nativeCall, pending) ? [index] : []
    ));
    const matchingIndexes = exactIndexes.length > 0
      ? exactIndexes
      : nativeCalls.flatMap((nativeCall, index) => (
          nativeCallSignatureMatches(nativeCall, pending) ? [index] : []
        ));
    if (matchingIndexes.length !== 1) {
      throw new AntigravityCascadeError(
        `Native MCP call identity mismatch for ${pending.name}.`,
        { statusCode: 502 },
      );
    }
    const [nativeCall] = nativeCalls.splice(matchingIndexes[0], 1);
    const nativeName = nativeCall?.nativeName ?? nativeCall?.name;
    if (!nativeCall?.callId || nativeName !== pending.name) {
      throw new AntigravityCascadeError(
        `Native MCP call mismatch: expected ${pending.name}, received ${nativeName ?? "missing"}.`,
        { statusCode: 502 },
      );
    }
    calls.push({
      callId: String(nativeCall.callId),
      name: nativeCall.name,
      arguments: nativeCall.arguments ?? pending.arguments,
    });
  }
  return calls;
}

function nativeCallIdMatches(nativeCall, pending) {
  const pendingId = String(pending?.nativeCallId ?? "");
  const nativeId = String(nativeCall?.nativeCallId ?? "");
  return Boolean(pendingId && nativeId && pendingId === nativeId);
}

function nativeCallSignatureMatches(nativeCall, pending) {
  const nativeName = String(nativeCall?.nativeName ?? nativeCall?.name ?? "");
  if (nativeName !== pending?.name) return false;
  try {
    return JSON.stringify(nativeCall?.arguments ?? {}) === JSON.stringify(pending?.arguments ?? {});
  } catch {
    return false;
  }
}

function approvalFor(requestedInteraction) {
  const requestedCase = requestedInteraction?.interaction?.case ?? "";
  return requestedInteraction?.permission || requestedCase === "permission"
    ? { permission: { allow: true, scope: 1 } }
    : { mcp: { confirm: true } };
}

function extractPendingMcpCalls(payload, allowedNames = []) {
  const allowed = new Set(allowedNames.map(String));
  const steps = payload?.trajectory?.steps ?? payload?.steps ?? [];
  const trajectoryId = String(payload?.trajectory?.trajectoryId ?? payload?.trajectory?.trajectory_id ?? "");
  return steps.flatMap((step, stepArrayIndex) => {
    if (step?.type !== "CORTEX_STEP_TYPE_MCP_TOOL") return [];
    if (step?.status && step.status !== "CORTEX_STEP_STATUS_WAITING") return [];
    const toolCall = step?.mcpTool?.toolCall ?? step?.mcp_tool?.tool_call;
    const name = String(toolCall?.name ?? "");
    if (!name || (allowed.size && !allowed.has(name))) return [];
    let args;
    try {
      args = JSON.parse(toolCall?.argumentsJson ?? toolCall?.originalArgumentsJson ?? "{}");
    } catch {
      throw new AntigravityCascadeError(`Native MCP arguments are not valid JSON for ${name}.`, { statusCode: 502 });
    }
    const source = step?.metadata?.sourceTrajectoryStepInfo
      ?? step?.metadata?.source_trajectory_step_info
      ?? {};
    const sourceTrajectoryId = String(source?.trajectoryId ?? source?.trajectory_id ?? trajectoryId);
    const sourceStepIndex = Number(source?.stepIndex ?? source?.step_index ?? stepArrayIndex);
    return [{
      nativeCallId: String(toolCall?.id ?? ""),
      name,
      arguments: args,
      stepArrayIndex,
      trajectoryKey: `${sourceTrajectoryId || trajectoryId}:${sourceStepIndex}:${String(toolCall?.id ?? "")}:${name}`,
      interaction: sourceTrajectoryId && Number.isInteger(sourceStepIndex)
        ? { trajectoryId: sourceTrajectoryId, stepIndex: sourceStepIndex }
        : null,
      requestedInteraction: step?.requestedInteraction ?? step?.requested_interaction,
    }];
  });
}

function extractAssistantTextAfter(payload, minimumStepIndex = -1) {
  const steps = payload?.trajectory?.steps ?? payload?.steps ?? [];
  for (let index = steps.length - 1; index > minimumStepIndex; index -= 1) {
    const step = steps[index];
    if (step?.type !== "CORTEX_STEP_TYPE_PLANNER_RESPONSE") continue;
    if (step?.status && step.status !== "CORTEX_STEP_STATUS_DONE") continue;
    const text = step?.plannerResponse?.modifiedResponse ?? step?.plannerResponse?.response;
    if (typeof text === "string" && text) return text;
  }
  return "";
}

function extractNewAssistantText(payload, continuation) {
  const afterBoundary = extractAssistantTextAfter(payload, continuation.resumeAfterStepIndex);
  if (afterBoundary) return afterBoundary;
  const latest = extractAssistantTextAfter(payload, -1);
  return latest && latest !== continuation.lastAssistantText ? latest : "";
}

function extractTrajectoryError(payload) {
  const steps = payload?.trajectory?.steps ?? payload?.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    const details = step?.errorMessage?.error ?? step?.error ?? {};
    const message = [
      step?.errorMessage,
      step?.plannerResponse?.errorMessage,
      details?.shortError,
      details?.modelErrorMessage,
      details?.userErrorMessage,
      details?.message,
    ].find((candidate) => typeof candidate === "string" && candidate.trim());
    if (message) return message.trim();
  }
  return "";
}

function classifyTrajectoryError(message) {
  const statusCode = /(?:user\s+)?location is not supported|unsupported (?:user\s+)?location/i.test(message)
    ? 400
    : /(?:RESOURCE_EXHAUSTED|quota|usage limit|rate limit)/i.test(message)
      ? 429
      : /(?:login|sign[ -]?in|unauthori[sz]ed|forbidden)/i.test(message)
        ? 401
        : 503;
  return new AntigravityCascadeError(message, { statusCode });
}

function renderSystemPromptSections(sections = []) {
  return sections.flatMap((section) => {
    let content = String(section?.content ?? "");
    if (section?.kind === "chat_history") {
      content = (section.messages ?? []).map((message) => JSON.stringify(message)).join("\n");
    }
    if (!content) return [];
    return [{
      title: String(section?.title ?? "Codex instructions"),
      content,
      metadata: {
        isInternal: true,
        ...(section?.contentTrust ? { contentTrust: section.contentTrust } : {}),
      },
    }];
  });
}

function withToolCompatibilitySection(sections, tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    if (sections.some((section) => section?.title === TEXT_ONLY_COMPATIBILITY_SECTION.title)) return sections;
    return [...sections, TEXT_ONLY_COMPATIBILITY_SECTION];
  }
  if (sections.some((section) => section?.title === TOOL_COMPATIBILITY_SECTION.title)) return sections;
  return [...sections, TOOL_COMPATIBILITY_SECTION];
}

export function extractAvailableModelEntries(payload) {
  return extractAvailableAgentModels(payload);
}

function normalizeModelEntry(entry) {
  return {
    ...entry,
    id: String(entry.id),
    displayName: String(entry.displayName ?? entry.display_name ?? entry.id),
    internalModel: String(entry.model ?? ""),
  };
}

function resolveModel(entries, requestedModel) {
  const requested = String(requestedModel ?? "").trim().toLowerCase();
  const model = entries.find((entry) => [entry.id, entry.displayName, entry.internalModel]
    .some((value) => String(value).toLowerCase() === requested));
  if (!model || !model.internalModel) {
    throw new AntigravityCascadeError(`Antigravity model is unavailable: ${requestedModel}`, { statusCode: 400 });
  }
  return model;
}

export function discoverAntigravityDesktopConnection(env = process.env) {
  if (env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      lsAddress: normalizeAddress(env.ANTIGRAVITY_LS_ADDRESS),
      agentApiAddress: normalizeAddress(env.ANTIGRAVITY_AGENTAPI_ADDRESS || env.ANTIGRAVITY_LS_ADDRESS),
      csrfToken: env.ANTIGRAVITY_CSRF_TOKEN,
    };
  }
  if (platform() !== "win32") {
    throw new AntigravityCascadeError("Antigravity Desktop discovery is currently supported on Windows only.", { statusCode: 503 });
  }
  const loggedConnection = discoverAntigravityDesktopConnectionFromFiles(env);
  if (loggedConnection) return loggedConnection;
  const script = [
    "$filter = \"Name='language_server.exe' OR Name='language_server_windows_x64.exe'\"",
    "$rows = Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {",
    "  [pscustomobject]@{ processId = $_.ProcessId; commandLine = $_.CommandLine }",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Compress",
  ].join("; ");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  }).trim();
  const netstat = execFileSync(join(env.SystemRoot || process.env.SystemRoot || "C:\\Windows", "System32", "netstat.exe"), [
    "-ano",
    "-p",
    "tcp",
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    timeout: 10000,
  });
  const parsed = output ? JSON.parse(output) : [];
  const rows = (Array.isArray(parsed) ? parsed : [parsed])
    .filter((row) => /--app_data_dir\s+antigravity(?:\s|$)/i.test(row?.commandLine ?? ""))
    .sort((left, right) => Number(right.processId ?? 0) - Number(left.processId ?? 0));
  for (const row of rows) {
    const csrfToken = String(row.commandLine ?? "").match(/--csrf_token\s+([^\s]+)/)?.[1];
    const ports = extractListeningPortsForProcess(netstat, row.processId);
    const lsPort = csrfToken
      ? selectAntigravityLanguageServerPort(
          ports,
          (candidate) => probeAntigravityLanguageServerPort(candidate, csrfToken, env),
        )
      : 0;
    if (csrfToken && lsPort) {
      return {
        agentApiAddress: `127.0.0.1:${lsPort}`,
        lsAddress: `127.0.0.1:${lsPort}`,
        csrfToken,
      };
    }
  }
  throw new AntigravityCascadeError("Antigravity Desktop is not ready or signed in.", { statusCode: 503 });
}

export function extractAntigravityConnectionFromLogs(mainLog, languageServerLog) {
  let csrfToken = "";
  for (const line of String(mainLog ?? "").split(/\r?\n/)) {
    if (!/\bSpawning:\s+.*language_server(?:\.exe)?\b/i.test(line)
      || !/--app_data_dir\s+antigravity(?:\s|$)/i.test(line)) {
      continue;
    }
    const match = line.match(/--csrf_token\s+([^\s]+)/i);
    if (match?.[1]) csrfToken = match[1];
  }

  let httpsPort = 0;
  let httpPort = 0;
  for (const line of String(languageServerLog ?? "").split(/\r?\n/)) {
    const httpsMatch = line.match(/listening on random port at\s+(\d+)\s+for HTTPS\b/i);
    const httpMatch = line.match(/listening on random port at\s+(\d+)\s+for HTTP\b/i);
    if (httpsMatch?.[1]) httpsPort = Number(httpsMatch[1]);
    if (httpMatch?.[1]) httpPort = Number(httpMatch[1]);
  }
  if (!csrfToken || !Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null;
  const agentPort = Number.isInteger(httpsPort) && httpsPort > 0 && httpsPort <= 65535
    ? httpsPort
    : httpPort;
  return {
    agentApiAddress: `127.0.0.1:${agentPort}`,
    lsAddress: `127.0.0.1:${httpPort}`,
    csrfToken,
  };
}

function discoverAntigravityDesktopConnectionFromFiles(env) {
  const appData = String(env.APPDATA || process.env.APPDATA || "").trim();
  if (!appData) return null;
  const stateRoot = String(env.DEEPCODEX_STATE_ROOT || join(appData, "anticodex")).trim();
  const mainLogPaths = [
    join(stateRoot, "antigravity-desktop.out.log"),
    join(appData, "Antigravity", "logs", "main.log"),
    env.ANTIGRAVITY_MAIN_LOG_PATH,
  ].filter(Boolean);
  const languageServerLogPaths = [
    join(appData, "Antigravity", "logs", "language_server.log"),
    env.ANTIGRAVITY_LANGUAGE_SERVER_LOG_PATH,
  ].filter(Boolean);
  const readLogs = (paths) => paths.map((file) => {
    try { return readBoundedLogTail(file); } catch { return ""; }
  }).filter(Boolean).join("\n");
  return extractAntigravityConnectionFromLogs(readLogs(mainLogPaths), readLogs(languageServerLogPaths));
}

export function readBoundedLogTail(file, maxBytes = 1024 * 1024) {
  const limit = positiveInteger(maxBytes, 1024 * 1024);
  const handle = openSync(file, "r");
  try {
    const size = fstatSync(handle).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(handle, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    closeSync(handle);
  }
}

export function selectAntigravityLanguageServerPort(ports, probe) {
  for (const port of ports ?? []) {
    if (probe(port) === true) return port;
  }
  return 0;
}

function probeAntigravityLanguageServerPort(port, csrfToken, env) {
  const curl = join(env.SystemRoot || process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe");
  try {
    const status = execFileSync(curl, [
      "--silent",
      "--show-error",
      "--max-time",
      "2",
      "--output",
      "NUL",
      "--write-out",
      "%{http_code}",
      "--request",
      "POST",
      `http://127.0.0.1:${port}${SERVICE_PREFIX}/GetUserStatus`,
      "--header",
      "content-type: application/json",
      "--header",
      "connect-protocol-version: 1",
      "--header",
      `x-codeium-csrf-token: ${csrfToken}`,
      "--data",
      "{}",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    }).trim();
    return status === "200";
  } catch {
    return false;
  }
}

export function extractListeningPortsForProcess(netstatOutput, processId) {
  const expectedProcessId = Number(processId);
  const ports = new Set();
  for (const line of String(netstatOutput ?? "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5
      || fields[0]?.toUpperCase() !== "TCP"
      || fields[3]?.toUpperCase() !== "LISTENING"
      || Number(fields[4]) !== expectedProcessId) {
      continue;
    }
    const address = fields[1]?.match(/^(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)$/i);
    const port = Number(address?.[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

async function serviceCall(connection, method, body, options) {
  const controller = new AbortController();
  const timeoutReason = new DOMException(`${method} timed out after ${options.timeoutMs}ms.`, "TimeoutError");
  const timer = setTimeout(() => controller.abort(timeoutReason), options.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await options.fetchImpl(
      `http://${normalizeAddress(connection.lsAddress)}${SERVICE_PREFIX}/${method}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-codeium-csrf-token": connection.csrfToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new AntigravityCascadeError(`${method} failed (${response.status}): ${text.slice(0, 500)}`, {
        statusCode: response.status,
      });
    }
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function modelOnlyToolConfig() {
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

function validateContinuation(value) {
  if (!value?.connection || !value?.cascadeId || !value?.bridge || !Array.isArray(value?.pendingCalls)) {
    throw new AntigravityCascadeError("Opaque Cascade continuation is incomplete.", { statusCode: 409 });
  }
}

function requiredText(value, label) {
  const text = String(value ?? "");
  if (!text) throw new AntigravityCascadeError(`${label} is required.`, { statusCode: 400 });
  return text;
}

function normalizeAddress(value) {
  const match = String(value ?? "").trim().match(
    /^(?:https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|::1):([0-9]+)(?:\/+)?$/i,
  );
  const port = Number(match?.[2]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AntigravityCascadeError(
      "Antigravity address must use a loopback host with a valid port.",
      { statusCode: 400 },
    );
  }
  const host = match[1].toLowerCase();
  const normalizedHost = host === "localhost"
    ? "127.0.0.1"
    : host === "::1"
      ? "[::1]"
      : host;
  return `${normalizedHost}:${port}`;
}

function isConnectionError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? "");
  return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
    || /fetch failed|connection (?:refused|reset)|socket hang up/i.test(String(error?.message ?? ""));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class AntigravityCascadeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name ?? "AntigravityCascadeError";
    this.statusCode = options.statusCode;
  }
}
