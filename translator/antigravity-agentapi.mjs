import { createHash } from "node:crypto";

import {
  extractAvailableAgentModels,
  normalizeAntigravityDisplayName,
} from "./antigravity-model-catalog.mjs";
import { discoverAntigravityDesktopConnection } from "./provider/antigravity-cascade-client.mjs";

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

export function discoverDesktopConnection(env = process.env) {
  return discoverAntigravityDesktopConnection(env);
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

export async function fetchAvailableAgentModels(options = {}) {
  return queryDesktopService("GetAvailableModels", {}, options);
}

export async function fetchAntigravityUserStatus(options = {}) {
  return queryDesktopService("GetUserStatus", {}, options);
}

export function antigravityAccountSnapshot(payload) {
  const status = payload?.userStatus ?? payload?.user_status ?? {};
  const email = String(status.email ?? "").trim().toLowerCase();
  const planStatus = status.planStatus ?? status.plan_status ?? {};
  const planInfo = planStatus.planInfo ?? planStatus.plan_info ?? {};
  const tier = status.userTier ?? status.user_tier ?? {};
  return {
    object: "antigravity.account",
    signedIn: Boolean(email),
    identityAvailable: Boolean(email),
    fingerprint: email ? `sha256:${createHash("sha256").update(email, "utf8").digest("hex")}` : "",
    planName: String(planInfo.planName ?? planInfo.plan_name ?? ""),
    tierName: String(tier.name ?? ""),
    maxInputTokens: String(planInfo.maxNumChatInputTokens ?? planInfo.max_num_chat_input_tokens ?? ""),
    webSearchEnabled: planInfo.cascadeWebSearchEnabled === true || planInfo.cascade_web_search_enabled === true,
    browserEnabled: planInfo.browserEnabled === true || planInfo.browser_enabled === true,
    autoRunCommandsEnabled: planInfo.cascadeCanAutoRunCommands === true || planInfo.cascade_can_auto_run_commands === true,
  };
}

export function extractAvailableAgentModelEntries(payload) {
  return extractAvailableAgentModels(payload);
}

export function resolveAntigravityModel(payload, requestedModel) {
  const entries = extractAvailableAgentModelEntries(payload);
  if (entries.length === 0) {
    throw new Error("Antigravity has no available models. Open Antigravity and confirm the signed-in account, then retry.");
  }
  const requested = String(requestedModel ?? "").trim().toLowerCase();
  const match = (requested && entries.find((model) => [
    model.id,
    model.model,
    model.displayName,
    model.display_name,
  ].some((value) => String(value ?? "").toLowerCase() === requested)))
    || entries.find((model) => model.id === "gemini-pro-agent")
    || entries[0];
  if (!match.model) throw new Error(`Antigravity model ${match.id} does not expose an internal model enum.`);
  return {
    id: match.id,
    displayName: normalizeAntigravityDisplayName(match.id, match.displayName ?? match.display_name ?? match.id),
    internalModel: match.model,
    raw: match,
  };
}

async function queryDesktopService(method, body, options) {
  const explicitConnection = options.connection ?? null;
  const cache = options.connectionCache ?? DESKTOP_CONNECTION_CACHE;
  let connection = explicitConnection ?? cache.get(options.env);
  try {
    return await postService(connection, method, body, options);
  } catch (error) {
    if (explicitConnection || options.signal?.aborted || !isConnectionError(error)) throw error;
    cache.invalidate(connection);
    connection = cache.get(options.env);
    return postService(connection, method, body, options);
  }
}

async function postService(connection, method, body, options) {
  const controller = new AbortController();
  const externalSignal = options.signal ?? null;
  const onAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `http://${normalizeAddress(connection.lsAddress)}${SERVICE_PREFIX}/${method}`,
      {
        method: "POST",
        headers: requestHeaders(connection.csrfToken),
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${method} failed (${response.status}): ${text.slice(0, 500)}`);
      error.statusCode = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

function isConnectionError(error) {
  if (error?.name === "AbortError" || Number.isFinite(error?.statusCode)) return false;
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket|network/i.test(String(error?.message ?? error));
}

function normalizeAddress(value) {
  return String(value ?? "").replace(/^https?:\/\//, "").replace(/^localhost:/, "127.0.0.1:");
}
