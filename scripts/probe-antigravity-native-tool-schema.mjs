import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import {
  antigravityModelOnlyToolConfig,
  discoverDesktopConnection,
  fetchAvailableAgentModels,
  requestHeaders,
  resolveAntigravityModel,
} from "../translator/antigravity-agentapi.mjs";

const SERVICE_PREFIX = "/exa.language_server_pb.LanguageServerService";
const cwd = process.argv[2] || process.cwd();
const modelId = process.env.ANTICODEX_PROBE_MODEL || "gemini-3.5-flash-low";
const timeoutMs = Number(process.env.ANTICODEX_PROBE_TIMEOUT_MS || 8000);

function normalizeAddress(value) {
  return String(value ?? "").replace(/^https?:\/\//, "").replace(/^localhost:/, "127.0.0.1:");
}

async function postService(connection, method, body, timeout = timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`http://${normalizeAddress(connection.lsAddress)}${SERVICE_PREFIX}/${method}`, {
      method: "POST",
      headers: requestHeaders(connection.csrfToken),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${method} failed (${response.status}): ${text.slice(0, 1000)}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCustomAgentSpec(variant, options = {}) {
  if (variant === "customizationMcpServer") {
    return {
      name: "Anti-Codex Native MCP Tool Probe",
      customTools: ["anticodex_probe_tool"],
      customizationConfig: {
        customizationServerUrl: options.customizationServerUrl,
        toolNames: ["anticodex_probe_tool"],
      },
    };
  }
  if (variant === "customizationToolNames") {
    return {
      name: "Anti-Codex Native Tool Customization Probe",
      customizationConfig: {
        toolNames: ["anticodex_probe_tool"],
      },
    };
  }
  if (variant === "customToolsSchemaObject") {
    return {
      name: "Anti-Codex Native Tool Schema Probe",
      customTools: [{
        name: "anticodex_probe_tool",
        description: "Probe-only tool that should not run.",
        inputSchema: {
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
          additionalProperties: false,
        },
      }],
    };
  }
  if (variant === "openAiToolsArray") {
    return {
      name: "Anti-Codex Native Tool Schema Probe",
      tools: [{
        type: "function",
        function: {
          name: "anticodex_probe_tool",
          description: "Probe-only tool that should not run.",
          parameters: {
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
            additionalProperties: false,
          },
        },
      }],
    };
  }
  return {
    name: "Anti-Codex Native Tool Name Probe",
    customTools: ["anticodex_probe_tool"],
  };
}

function buildSendBody(cascadeId, model, placement, variant, marker, options = {}) {
  const customAgentSpec = buildCustomAgentSpec(variant, options);
  const plannerConfig = {
    planModel: model.internalModel,
    toolConfig: antigravityModelOnlyToolConfig(),
  };
  const cascadeConfig = placement === "invalid.plannerConfig.customAgentSpec"
    ? { plannerConfig: { ...plannerConfig, customAgentSpec } }
    : placement === "invalid.cascadeConfig.customAgentSpec"
      ? { plannerConfig, customAgentSpec }
      : { plannerConfig };

  const body = {
    cascadeId,
    items: [{
      text: [
        `Native tool schema probe marker: ${marker}.`,
        "If a native tool named anticodex_probe_tool is truly available, request that tool with marker.",
        `If no native tool event is available, answer exactly NO_NATIVE_TOOL_EVENT ${marker}.`,
      ].join(" "),
    }],
    blocking: false,
    cascadeConfig,
  };
  if (placement === "send.customAgentSpec") body.customAgentSpec = customAgentSpec;
  return body;
}

function summarizeTrajectory(value, marker) {
  const steps = value?.trajectory?.steps ?? value?.steps ?? [];
  const stepTypes = steps.map((step) => String(step?.type ?? "")).filter(Boolean);
  const text = JSON.stringify(value).slice(0, 20000);
  const probeToolSteps = steps
    .filter((step) => JSON.stringify(step).includes("anticodex_probe_tool"))
    .map((step) => ({
      type: String(step?.type ?? ""),
      status: String(step?.status ?? ""),
      keys: Object.keys(step ?? {}).sort(),
    }));
  const errorMessages = steps
    .filter((step) => /ERROR/i.test(String(step?.type ?? "")))
    .map((step) => JSON.stringify(step).slice(0, 1000));
  const plannerResponses = steps
    .filter((step) => /PLANNER_RESPONSE/i.test(String(step?.type ?? "")))
    .map((step) => JSON.stringify(step).slice(0, 1000));
  const mcpToolDetails = steps
    .filter((step) => String(step?.type ?? "") === "CORTEX_STEP_TYPE_MCP_TOOL")
    .map((step) => ({
      status: String(step?.status ?? ""),
      mcpTool: step?.mcpTool ?? null,
      requestedInteraction: step?.requestedInteraction ?? null,
      metadata: step?.metadata ?? null,
      stepIndex: step?.stepIndex ?? step?.step_index ?? null,
      error: step?.error ?? step?.errorMessage ?? null,
      keys: Object.keys(step ?? {}).sort(),
    }));
  return {
    trajectoryId: value?.trajectory?.trajectoryId ?? value?.trajectory?.trajectory_id ?? value?.trajectoryId ?? value?.trajectory_id ?? null,
    stepCount: steps.length,
    stepTypes: Array.from(new Set(stepTypes)),
    containsMarker: text.includes(marker),
    containsProbeToolName: text.includes("anticodex_probe_tool"),
    containsNativeLookingToolStep: /TOOL|CUSTOM|EXECUTOR|CHOICE/i.test(stepTypes.join(" ")),
    containsProbeNativeToolStep: probeToolSteps.some((step) => /TOOL|CUSTOM|EXECUTOR|CHOICE/i.test(step.type)),
    probeToolSteps,
    errorMessages,
    plannerResponses,
    mcpToolDetails,
  };
}

async function cancelBestEffort(connection, cascadeId) {
  if (!cascadeId) return;
  try {
    await postService(connection, "CancelCascadeInvocation", { cascadeId }, 4000);
  } catch {
    // Probe cleanup only; preserve the probe result.
  }
}

async function createProbeMcpServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    requests.push({
      method: request.method,
      url: request.url,
      rpcMethod: body?.method ?? "",
      hasId: body?.id !== undefined,
    });

    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "POST required" }));
      return;
    }
    if (body?.id === undefined || body?.id === null) {
      response.writeHead(202);
      response.end();
      return;
    }

    let result = {};
    if (body.method === "initialize") {
      result = {
        protocolVersion: body?.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "anticodex-native-probe", version: "1.0.0" },
      };
    } else if (body.method === "tools/list") {
      result = {
        tools: [{
          name: "anticodex_probe_tool",
          description: "Returns a harmless marker to prove native tool transport.",
          inputSchema: {
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
            additionalProperties: false,
          },
        }],
      };
    } else if (body.method === "tools/call") {
      result = {
        content: [{
          type: "text",
          text: `ANTICODEX_NATIVE_MCP_RESULT ${String(body?.params?.arguments?.marker ?? "")}`,
        }],
        isError: false,
      };
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "anticodex-native-probe",
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runAttempt(connection, model, source, placement, variant) {
  let cascadeId = "";
  let mcpServer = null;
  let approvalAttempted = false;
  let approvalAccepted = false;
  let resumedTrajectorySummary = null;
  const marker = `ANTICODEX_NATIVE_TOOL_SCHEMA_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  try {
    if (variant === "customizationMcpServer") mcpServer = await createProbeMcpServer();
    const specOptions = { customizationServerUrl: mcpServer?.url };
    const startBody = {
      source,
      trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
      workspaceUris: [pathToFileURL(cwd).href],
    };
    if (placement === "start.customAgentSpec") {
      startBody.customAgentSpec = buildCustomAgentSpec(variant, specOptions);
    }
    const start = await postService(connection, "StartCascade", startBody);
    cascadeId = start?.cascadeId || "";
    if (!cascadeId) throw new Error("StartCascade returned no cascadeId");

    if (placement === "static.customAgentSpec") {
      await postService(connection, "SetOrVerifyStaticConfig", {
        cascadeId,
        customAgentSpec: buildCustomAgentSpec(variant, specOptions),
      }, 5000);
    }
    await postService(connection, "SendUserCascadeMessage", buildSendBody(cascadeId, model, placement, variant, marker, specOptions), 5000);
    await sleep(variant === "customizationMcpServer" ? 5000 : 1200);
    let trajectorySummary = null;
    try {
      const trajectory = await postService(connection, "GetCascadeTrajectory", { cascadeId }, 5000);
      trajectorySummary = summarizeTrajectory(trajectory, marker);
      const waitingMcp = trajectorySummary.mcpToolDetails?.find((detail) => detail.status === "CORTEX_STEP_STATUS_WAITING");
      const sourceInfo = waitingMcp?.metadata?.sourceTrajectoryStepInfo
        ?? waitingMcp?.metadata?.source_trajectory_step_info;
      if (process.env.ANTICODEX_PROBE_APPROVE_MCP === "1" && sourceInfo?.trajectoryId && Number.isInteger(Number(sourceInfo?.stepIndex))) {
        approvalAttempted = true;
        await postService(connection, "HandleCascadeUserInteraction", {
          cascadeId,
          interaction: {
            trajectoryId: sourceInfo.trajectoryId,
            stepIndex: Number(sourceInfo.stepIndex),
            permission: {
              allow: true,
              scope: 1,
            },
          },
        }, 5000);
        approvalAccepted = true;
        await sleep(5000);
        resumedTrajectorySummary = summarizeTrajectory(
          await postService(connection, "GetCascadeTrajectory", { cascadeId }, 5000),
          marker,
        );
      }
    } catch (error) {
      trajectorySummary = { error: error?.message || String(error) };
    }
    return {
      placement,
      source,
      variant,
      schemaLikeDefinition: variant !== "customToolsNames",
      accepted: true,
      rejected: false,
      rejectionLooksLikeCustomAgentGate: false,
      cascadeId,
      trajectorySummary,
      approvalAttempted,
      approvalAccepted,
      resumedTrajectorySummary,
      mcpServerEvidence: mcpServer ? {
        connected: mcpServer.requests.length > 0,
        rpcMethods: mcpServer.requests.map((request) => request.rpcMethod).filter(Boolean),
        toolListObserved: mcpServer.requests.some((request) => request.rpcMethod === "tools/list"),
        toolCallObserved: mcpServer.requests.some((request) => request.rpcMethod === "tools/call"),
        requests: mcpServer.requests,
      } : null,
      error: null,
    };
  } catch (error) {
    const message = error?.message || String(error);
    return {
      placement,
      source,
      variant,
      schemaLikeDefinition: variant !== "customToolsNames",
      accepted: false,
      rejected: true,
      rejectionLooksLikeCustomAgentGate: /CustomAgentSpec|customAgentSpec|custom agent|SDK executable|only allowed/i.test(message),
      cascadeId,
      approvalAttempted,
      approvalAccepted,
      resumedTrajectorySummary,
      mcpServerEvidence: mcpServer ? {
        connected: mcpServer.requests.length > 0,
        rpcMethods: mcpServer.requests.map((request) => request.rpcMethod).filter(Boolean),
        toolListObserved: mcpServer.requests.some((request) => request.rpcMethod === "tools/list"),
        toolCallObserved: mcpServer.requests.some((request) => request.rpcMethod === "tools/call"),
        requests: mcpServer.requests,
      } : null,
      error: message.slice(0, 1000),
    };
  } finally {
    await cancelBestEffort(connection, cascadeId);
    await mcpServer?.close();
  }
}

const result = {
  ok: false,
  transport: "desktop-cascade",
  model: modelId,
  attempts: [],
  acceptedPlacements: [],
  rejectedPlacements: [],
  customAgentGateObserved: false,
  schemaLikeRequestsAccepted: false,
  nativeToolEventEvidence: false,
  nativeMcpConnectionEvidence: false,
  nativeMcpToolCallEvidence: false,
};

try {
  const connection = discoverDesktopConnection();
  const modelsPayload = await fetchAvailableAgentModels({ connection, timeoutMs });
  const model = resolveAntigravityModel(modelsPayload, modelId);
  let attemptSpecs = [
    ["CORTEX_TRAJECTORY_SOURCE_CLI", "start.customAgentSpec", "customToolsNames"],
    ["CORTEX_TRAJECTORY_SOURCE_CLI", "send.customAgentSpec", "customToolsNames"],
    ["CORTEX_TRAJECTORY_SOURCE_CLI", "static.customAgentSpec", "customToolsNames"],
    ["CORTEX_TRAJECTORY_SOURCE_SDK", "start.customAgentSpec", "customToolsNames"],
    ["CORTEX_TRAJECTORY_SOURCE_SDK", "send.customAgentSpec", "customToolsNames"],
    ["CORTEX_TRAJECTORY_SOURCE_SDK", "static.customAgentSpec", "customToolsNames"],
    ["CORTEX_TRAJECTORY_SOURCE_SDK", "start.customAgentSpec", "customizationToolNames"],
    ["CORTEX_TRAJECTORY_SOURCE_CLI", "start.customAgentSpec", "customizationMcpServer"],
    ["CORTEX_TRAJECTORY_SOURCE_SDK", "start.customAgentSpec", "customizationMcpServer"],
    ["CORTEX_TRAJECTORY_SOURCE_SDK", "send.customAgentSpec", "customizationToolNames"],
    ["CORTEX_TRAJECTORY_SOURCE_CLI", "invalid.cascadeConfig.customAgentSpec", "customToolsSchemaObject"],
    ["CORTEX_TRAJECTORY_SOURCE_CLI", "invalid.plannerConfig.customAgentSpec", "openAiToolsArray"],
  ];
  if (process.env.ANTICODEX_PROBE_ONLY_MCP === "1") {
    attemptSpecs = attemptSpecs.filter(([, , variant]) => variant === "customizationMcpServer");
  }
  if (process.env.ANTICODEX_PROBE_SOURCE) {
    attemptSpecs = attemptSpecs.filter(([source]) => source === process.env.ANTICODEX_PROBE_SOURCE);
  }
  for (const [source, placement, variant] of attemptSpecs) {
    const attempt = await runAttempt(connection, model, source, placement, variant);
    result.attempts.push(attempt);
  }
  result.acceptedPlacements = result.attempts.filter((attempt) => attempt.accepted).map((attempt) => `${attempt.source}:${attempt.placement}:${attempt.variant}`);
  result.rejectedPlacements = result.attempts.filter((attempt) => attempt.rejected).map((attempt) => `${attempt.source}:${attempt.placement}:${attempt.variant}`);
  result.customAgentGateObserved = result.attempts.some((attempt) => attempt.rejectionLooksLikeCustomAgentGate);
  result.schemaLikeRequestsAccepted = result.attempts.some((attempt) => attempt.schemaLikeDefinition && attempt.accepted);
  result.nativeToolEventEvidence = result.attempts.some((attempt) => attempt.trajectorySummary?.containsProbeNativeToolStep === true);
  result.nativeMcpConnectionEvidence = result.attempts.some((attempt) => attempt.mcpServerEvidence?.connected === true);
  result.nativeMcpToolCallEvidence = result.attempts.some((attempt) => attempt.mcpServerEvidence?.toolCallObserved === true);
  result.ok = !result.nativeToolEventEvidence;
} catch (error) {
  result.error = error?.message || String(error);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
