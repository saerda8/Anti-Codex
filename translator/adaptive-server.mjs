#!/usr/bin/env node
/**
 * Adaptive Codex Translator v2
 *
 * ── Architecture ──────────────────────────────────────────────
 * Startup: probe upstream → provider profile (cached)
 * Request: Responses → Chat translation
 *          + inject internal tools for missing capabilities
 *          + dynamically assemble system prompt
 *          + filter hosted-only tools based on profile
 *          + intercept & execute internal tool calls locally
 *          + Chat → Responses SSE streaming
 * ───────────────────────────────────────────────────────────────
 *
 * Internal tools are defined in tools/registry.mjs.  They are
 * injected when the upstream provider lacks a required capability
 * (e.g. hosted web_search), and executed locally when the model
 * calls them — the result goes straight back as a tool message
 * without a round-trip to Codex.
 */

import http from "node:http";
import zlib from "node:zlib";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join as joinPath, relative as relativePath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { probeCapabilities } from "./probe.mjs";
import { toolsToInject, executeInternalTool, isInternalTool, getToolChoiceForRole } from "./tools/registry.mjs";
import { buildChatToolsWithRouting } from "./compat-rules.mjs";
import { localBackendApiResponse } from "./local-projection/index.mjs";
import {
    antigravityAccountSnapshot,
    antigravityNativeToolCapabilitySummary,
    fetchAvailableAgentModels,
    fetchAntigravityUserStatus,
} from "./antigravity-agentapi.mjs";
import { createAntigravityAccountTracker } from "./antigravity-account-tracker.mjs";
import { buildAntigravityModelCatalog, extractAvailableAgentModels } from "./antigravity-model-catalog.mjs";
import { createAntigravityReadinessMonitor } from "./antigravity-readiness.mjs";
import { createAntigravityFailureCircuit } from "./antigravity-failure-circuit.mjs";
import {
    antigravityPromptLimits,
    callAntigravityUpstream,
    isAntigravityNativeToolBridgeEnabled,
    isAntigravityAccountVerificationRequired,
    isAntigravityUpstreamMode,
    shouldRetryAntigravityFailure,
    streamAntigravityUpstream,
} from "./antigravity-upstream.mjs";
import { createAntigravityRequestRegistry } from "./antigravity-request-registry.mjs";
import { createAntigravityRequestQueue } from "./antigravity-request-queue.mjs";
import { createAntigravitySessionLock } from "./antigravity-session-lock.mjs";
import { createResponseHistoryStore } from "./response-history.mjs";
import { createAntigravityModelRouteAuditStore } from "./antigravity-model-route-audit.mjs";
import {
    buildUpstreamChatRequest,
    convertUpstreamChatResponse,
    normalizeUpstreamProfile,
    publicUpstreamProfile,
    testUpstreamConnection,
} from "./upstream-provider.mjs";

// ──────────────────────────────────────────────────── config ─────────────────

const HOST = process.env.TRANSLATOR_HOST || "127.0.0.1";
const LISTEN_HOST = process.env.TRANSLATOR_LISTEN_HOST || HOST;
const PORT = Number(process.env.TRANSLATOR_PORT || 8282);
const CDP_PORT = Number(process.env.DEEPCODEX_CDP_PORT || 58317);
const UPSTREAM = (process.env.UPSTREAM_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY || "";
const UPSTREAM_MODE = process.env.TRANSLATOR_UPSTREAM_MODE || "chat";
const UPSTREAM_PROTOCOL = process.env.UPSTREAM_PROTOCOL || "openai-compatible";
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || "";
const PROFILE_PATH = process.env.TRANSLATOR_PROFILE_PATH || "";
const ANTIGRAVITY_READINESS_INTERVAL_MS = Number(process.env.ANTIGRAVITY_READINESS_INTERVAL_MS || 15_000);
const ANTIGRAVITY_READINESS_TIMEOUT_MS = Number(process.env.ANTIGRAVITY_READINESS_TIMEOUT_MS || 8_000);
const ANTIGRAVITY_CIRCUIT_THRESHOLD = Number(process.env.ANTIGRAVITY_CIRCUIT_THRESHOLD || 3);
const ANTIGRAVITY_CIRCUIT_COOLDOWN_MS = Number(process.env.ANTIGRAVITY_CIRCUIT_COOLDOWN_MS || 15_000);
const ANTIGRAVITY_MAX_QUEUED_REQUESTS_RAW = Number(process.env.ANTIGRAVITY_MAX_QUEUED_REQUESTS || 32);
const ANTIGRAVITY_MAX_QUEUED_REQUESTS = Number.isFinite(ANTIGRAVITY_MAX_QUEUED_REQUESTS_RAW)
    ? Math.max(1, Math.floor(ANTIGRAVITY_MAX_QUEUED_REQUESTS_RAW))
    : 32;
const MAX_TOOL_LOOPS = Number(process.env.TRANSLATOR_MAX_TOOL_LOOPS || 12);
const MAX_FAKE_TOOL_CLAIM_REPLAYS = Number(process.env.TRANSLATOR_MAX_FAKE_TOOL_CLAIM_REPLAYS || 2);
const MAX_RESTORED_INPUT_ITEMS = Number(process.env.TRANSLATOR_MAX_RESTORED_INPUT_ITEMS || 220);
const MAX_RESTORED_TOOL_CALLS = Number(process.env.TRANSLATOR_MAX_RESTORED_TOOL_CALLS || 6);
const MAX_RESTORED_TOOL_OUTPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_TOOL_OUTPUT_CHARS || 4000);
const MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS || 1200);
const MAX_RESTORED_SOURCE_OUTPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_SOURCE_OUTPUT_CHARS || 1200);
const MAX_RESTORED_DOC_OUTPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_DOC_OUTPUT_CHARS || 900);
const DEBUG_UPSTREAM = process.env.DEEPCODEX_DEBUG_UPSTREAM === "1" || process.env.TRANSLATOR_DEBUG_UPSTREAM === "1";
const RESPONSES_PATHS = new Set(["/responses", "/v1/responses", "/codex/responses", "/responses/compact", "/v1/responses/compact"]);
const ANTICODEX_STATE_ROOT = process.env.DEEPCODEX_STATE_ROOT
    || (process.env.CODEX_HOME_DIR ? dirname(process.env.CODEX_HOME_DIR) : "")
    || (process.env.CODEX_HOME ? dirname(process.env.CODEX_HOME) : "");
const CODEX_HOME_DIR = process.env.CODEX_HOME_DIR || process.env.CODEX_HOME || "";
const ANTIGRAVITY_MODEL_CATALOG_PATH = process.env.ANTIGRAVITY_MODEL_CATALOG_PATH
    || (CODEX_HOME_DIR ? resolvePath(CODEX_HOME_DIR, "deepseek-model-catalog.json") : "");
const RESPONSE_HISTORY_PATH = process.env.ANTICODEX_RESPONSE_HISTORY_PATH
    || (ANTICODEX_STATE_ROOT ? resolvePath(ANTICODEX_STATE_ROOT, "response-history.json") : "");
const ANTIGRAVITY_MODEL_ROUTE_AUDIT_PATH = process.env.ANTICODEX_MODEL_ROUTE_AUDIT_PATH
    || (ANTICODEX_STATE_ROOT ? resolvePath(ANTICODEX_STATE_ROOT, "model-route-audit.json") : "");
const ANTICODEX_LIFECYCLE_STATUS_PATH = ANTICODEX_STATE_ROOT
    ? resolvePath(ANTICODEX_STATE_ROOT, "translator-lifecycle.json")
    : "";
const ANTICODEX_LIFECYCLE_LOG_PATH = ANTICODEX_STATE_ROOT
    ? resolvePath(ANTICODEX_STATE_ROOT, "translator-lifecycle.jsonl")
    : "";
const ANTICODEX_TRANSLATOR_BUSY_PATH = process.env.ANTICODEX_TRANSLATOR_BUSY_PATH
    || (ANTICODEX_STATE_ROOT ? resolvePath(ANTICODEX_STATE_ROOT, "translator-busy.json") : "");
const ANTICODEX_LIFECYCLE_LOG_MAX_BYTES = Number(process.env.ANTICODEX_LIFECYCLE_LOG_MAX_BYTES || 256 * 1024);
const ANTICODEX_LIFECYCLE_LOG_MAX_LINES = Number(process.env.ANTICODEX_LIFECYCLE_LOG_MAX_LINES || 200);
const REASONING_BLOB_PREFIX = "deepcodex.reasoning.hex.v1:";
const DEEPCODEX_DISPLAY_NAME = process.env.DEEPCODEX_DISPLAY_NAME || "娄老师说的对";
const TRANSLATOR_BRAND = process.env.ANTICODEX_TRANSLATOR_BRAND || "Anti-Codex";
const TRANSLATOR_DIR = dirname(fileURLToPath(import.meta.url));
const MANAGER_SCRIPTS_ROOT = resolvePath(TRANSLATOR_DIR, "..", "scripts");
const execFileAsync = promisify(execFile);
const MANAGER_ACTION_TOKEN = randomBytes(32).toString("base64url");
const MANAGER_ACTION_LOCKS = new Set();
const MANAGER_REPORT_STALE_MS_RAW = Number(process.env.ANTICODEX_MANAGER_REPORT_STALE_MS || 24 * 60 * 60 * 1000);
const MANAGER_REPORT_STALE_MS = Number.isFinite(MANAGER_REPORT_STALE_MS_RAW)
    ? Math.max(60 * 1000, MANAGER_REPORT_STALE_MS_RAW)
    : 24 * 60 * 60 * 1000;
let DEBUG_REQUEST_SEQ = 0;
const ACTIVE_ANTIGRAVITY_REQUESTS = createAntigravityRequestRegistry();
const ANTIGRAVITY_REQUEST_QUEUE = createAntigravityRequestQueue({
    maxQueued: ANTIGRAVITY_MAX_QUEUED_REQUESTS,
});
const ANTIGRAVITY_SESSION_LOCK = createAntigravitySessionLock({
    maxQueued: ANTIGRAVITY_MAX_QUEUED_REQUESTS,
});
const DIRECT_ANTIGRAVITY_REQUEST_QUEUE = {
    run: async (task, { signal } = {}) => task({ signal }),
};
const ANTIGRAVITY_FAILURE_CIRCUIT = createAntigravityFailureCircuit({
    threshold: ANTIGRAVITY_CIRCUIT_THRESHOLD,
    cooldownMs: ANTIGRAVITY_CIRCUIT_COOLDOWN_MS,
});
const RESPONSE_HISTORY = createResponseHistoryStore({ filePath: RESPONSE_HISTORY_PATH });
const ANTIGRAVITY_MODEL_ROUTE_AUDIT = createAntigravityModelRouteAuditStore({ filePath: ANTIGRAVITY_MODEL_ROUTE_AUDIT_PATH });
const RESPONSES_WEBSOCKET_AUDIT = {
    supported: false,
    fallbackStatus: 501,
    fallbackType: "unsupported_websocket",
    attempts: 0,
    lastAttempt: null,
    lastUpgrade: null,
    lastHttpPrewarm: null,
};
const ANTIGRAVITY_RETRY_AUDIT = {
    count: 0,
    latest: null,
};
const ANTIGRAVITY_TRAFFIC_STATUS = {
    state: "not_checked",
    type: null,
    diagnosis: null,
    status: null,
    retryable: null,
    message: "",
    suggestedAction: "",
    lastFailureAt: null,
    lastSuccessAt: null,
    lastFailureAtMs: 0,
    lastSuccessAtMs: 0,
};
let ANTIGRAVITY_BUSY_COUNT = 0;

function markAntigravityBusy(reason = "antigravity_request") {
    ANTIGRAVITY_BUSY_COUNT += 1;
    writeAntigravityBusyMarker(reason);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        ANTIGRAVITY_BUSY_COUNT = Math.max(0, ANTIGRAVITY_BUSY_COUNT - 1);
        if (ANTIGRAVITY_BUSY_COUNT > 0) writeAntigravityBusyMarker(reason);
        else clearAntigravityBusyMarker();
    };
}

function writeAntigravityBusyMarker(reason) {
    if (!ANTICODEX_TRANSLATOR_BUSY_PATH) return;
    try {
        mkdirSync(dirname(ANTICODEX_TRANSLATOR_BUSY_PATH), { recursive: true });
        const marker = `${JSON.stringify({
            active: ANTIGRAVITY_BUSY_COUNT,
            reason,
            pid: process.pid,
            updatedAt: new Date().toISOString(),
        }, null, 2)}\n`;
        const tempPath = `${ANTICODEX_TRANSLATOR_BUSY_PATH}.${process.pid}.tmp`;
        writeFileSync(tempPath, marker, "utf8");
        renameSync(tempPath, ANTICODEX_TRANSLATOR_BUSY_PATH);
    } catch {}
}

function clearAntigravityBusyMarker() {
    if (!ANTICODEX_TRANSLATOR_BUSY_PATH) return;
    try { unlinkSync(ANTICODEX_TRANSLATOR_BUSY_PATH); } catch {}
}

function antigravityBusySnapshot() {
    const snapshot = {
        active: ANTIGRAVITY_BUSY_COUNT,
        path: ANTICODEX_TRANSLATOR_BUSY_PATH || null,
        marker: null,
    };
    if (!ANTICODEX_TRANSLATOR_BUSY_PATH || !existsSync(ANTICODEX_TRANSLATOR_BUSY_PATH)) return snapshot;
    try {
        snapshot.marker = JSON.parse(readFileSync(ANTICODEX_TRANSLATOR_BUSY_PATH, "utf8"));
    } catch (error) {
        snapshot.marker = {
            unreadable: true,
            message: error?.message || String(error),
        };
    }
    return snapshot;
}

clearAntigravityBusyMarker();

const ANTIGRAVITY_ACCOUNT_TRACKER = createAntigravityAccountTracker({
    confirmationObservations: 2,
    onChange: async ({ modelsPayload }) => {
        const refresh = buildAntigravityModelRefresh(modelsPayload, loadAntigravityCatalog());
        PROFILE = refresh.profile;
        writeJsonAtomic(ANTIGRAVITY_MODEL_CATALOG_PATH, refresh.catalog);
        console.error(`[adaptive] Antigravity account changed; hot-refreshed ${refresh.modelCount} model(s).`);
    },
});

function activeUpstreamProfile(overrides = {}) {
    return normalizeUpstreamProfile({
        protocol: overrides.protocol || UPSTREAM_PROTOCOL,
        baseUrl: overrides.baseUrl || UPSTREAM,
        apiKey: overrides.apiKey ?? UPSTREAM_KEY,
        model: overrides.model || UPSTREAM_MODEL || PROFILE?.defaultModel || PROFILE?.model || "",
        extraHeaders: overrides.extraHeaders || {},
    });
}

function thirdPartyProfileForStartup() {
    const protocol = UPSTREAM_PROTOCOL === "anthropic" ? "anthropic" : "openai-compatible";
    const defaultModel = UPSTREAM_MODEL || (protocol === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o-mini");
    return {
        provider: protocol === "anthropic" ? "anthropic" : "openai-compatible",
        source: "anticodex-config",
        baseUrl: UPSTREAM,
        protocol,
        model: defaultModel,
        defaultModel,
        fastModel: defaultModel,
        models: [defaultModel],
        capabilities: {
            basicChat: true,
            stream: protocol !== "anthropic",
            toolCalls: true,
            thinking: false,
            vision: false,
            imageGeneration: false,
            hostedTools: false,
            internalWebTools: true,
            nativeStreaming: protocol !== "anthropic",
            streamToolCalls: false,
            streamReasoning: false,
        },
        toolStrategy: {
            web_search: "local.ddg_urllib",
            web_fetch: "local.http_fetch",
            web_time: "local.system_time",
        },
    };
}

function applyConfiguredUpstreamModel(profile) {
    const configuredModel = String(UPSTREAM_MODEL || "").trim();
    if (!configuredModel) return profile;
    const existingModels = Array.isArray(profile?.models) ? profile.models : [];
    const detectedModels = Array.isArray(profile?.detected?.models) ? profile.detected.models : [];
    const verifiedModels = detectedModels.length > 0 ? detectedModels : existingModels;
    const fallbackModels = new Set([
        profile?.defaults?.defaultModel,
        profile?.defaults?.fastModel,
        profile?.defaultModel,
        profile?.fastModel,
    ].map((model) => String(model || "").trim()).filter(Boolean));
    const models = [
        configuredModel,
        ...verifiedModels
            .map((model) => String(model || "").trim())
            .filter((model) => model && model !== configuredModel)
            .filter((model) => detectedModels.length > 0 || !fallbackModels.has(model)),
    ];
    return {
        ...profile,
        model: configuredModel,
        defaultModel: configuredModel,
        fastModel: models.find((model) => model !== configuredModel) || configuredModel,
        models,
    };
}
const ANTIGRAVITY_READINESS = isAntigravityUpstreamMode(UPSTREAM_MODE)
    ? createAntigravityReadinessMonitor({
        intervalMs: ANTIGRAVITY_READINESS_INTERVAL_MS,
        probe: async () => {
            const payload = await fetchAvailableAgentModels({ timeoutMs: ANTIGRAVITY_READINESS_TIMEOUT_MS });
            try {
                const accountPayload = await fetchAntigravityUserStatus({
                    timeoutMs: ANTIGRAVITY_READINESS_TIMEOUT_MS,
                });
                await ANTIGRAVITY_ACCOUNT_TRACKER.observe(
                    antigravityAccountSnapshot(accountPayload),
                    { modelsPayload: payload },
                );
            } catch {}
            return { models: antigravityVisibleModelIds(payload) };
        },
    })
    : null;

const CODEX_LOCAL_COMPACT_PROMPT = [
    "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
    "Include:",
    "- The latest user request and the active in-flight task, including short numeric instructions resolved from the immediate context",
    "- The exact files, commands, parameters, and outputs that were just changed or running when compaction happened",
    "- Current progress and key decisions made",
    "- Important context, constraints, or user preferences",
    "- What remains to be done (clear next steps)",
    "- A one-line continuation instruction that says exactly what the next LLM should do first",
    "- Any critical data, examples, or references needed to continue",
    "If there is an active task, explicitly state that the next LLM must not restart from project discovery and must continue from the last concrete action.",
    "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
].join("\n");

const CODEX_CONTEXT_SUMMARY_PREFIX = [
    "Another language model started to solve this problem and produced a summary of its thinking process.",
    "You also have access to the state of the tools that were used by that language model.",
    "Use this to build on the work that has already been done and avoid duplicating work.",
    "Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:",
].join(" ");

let PROFILE = null;

// ──────────────────────────────────────────────────── helpers ────────────────

const LOCAL_CORS_HEADERS = Object.freeze({
    "access-control-allow-origin": "*",
    "access-control-allow-private-network": "true",
});

function localCorsHeaders(extra = {}) {
    return { ...LOCAL_CORS_HEADERS, ...extra };
}

function redactUpstreamSecretText(value) {
    let text = String(value ?? "");
    if (UPSTREAM_KEY) text = text.split(UPSTREAM_KEY).join("[redacted]");
    return text
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
        .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&#\s]+/gi, "$1[redacted]");
}

function redactUpstreamFailure(value) {
    if (Array.isArray(value)) return value.map(redactUpstreamFailure);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUpstreamFailure(item)]));
    }
    return typeof value === "string" ? redactUpstreamSecretText(value) : value;
}

function fail(res, status, msg) {
    res.writeHead(status, localCorsHeaders({ "content-type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify({ error: { message: redactUpstreamSecretText(msg), type: "gateway_error" } }));
}

function failWithDetails(res, status, failure) {
    const rawDetail = failure && typeof failure === "object" ? failure : { message: String(failure || `HTTP ${status}`) };
    const detail = redactUpstreamFailure(rawDetail);
    const message = detail.message || `HTTP ${status}`;
    res.writeHead(status, localCorsHeaders({ "content-type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify({ error: { message, type: detail.type || "gateway_error", details: detail } }));
}

function cachedAntigravityModelCount() {
    return Array.isArray(PROFILE?.models) ? PROFILE.models.length : 0;
}

function isAntigravityQuotaOrLimitFailure(error) {
    const message = String(error?.message ?? error ?? "");
    const type = String(error?.type ?? "");
    const code = String(error?.code ?? error?.error?.code ?? "");
    const status = Number(error?.statusCode ?? error?.status ?? 0);
    if (type === "antigravity_quota_exceeded" || code === "quota_or_limit_reached") return true;
    if (status === 402) return true;
    if (/quota|usage\s+limit|daily\s+limit|rate\s+limit|too\s+many\s+requests|billing|payment|required\s+balance|limit\s+reached|limit\s+exceeded/i.test(message)) return true;
    return false;
}

function antigravityFailureDetails(error) {
    const message = String(error?.message ?? error ?? "Antigravity request failed.");
    if (error?.type === "antigravity_queue_full") {
        return {
            status: Number(error.statusCode) || 429,
            type: "antigravity_queue_full",
            retryable: true,
            message,
        };
    }
    if (error?.type === "antigravity_temporarily_unavailable" || error?.type === "antigravity_account_unavailable") {
        const accountVerification = isAntigravityAccountVerificationRequired(error);
        return {
            status: Number(error.statusCode) || (accountVerification ? 403 : 503),
            type: error.type,
            retryable: error.type === "antigravity_account_unavailable" ? false : error.retryable !== false,
            message,
            ...(accountVerification ? { diagnosis: "account_verification_required" } : {}),
            ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
        };
    }
    if (isAntigravityQuotaOrLimitFailure(error)) {
        return {
            status: Number(error?.statusCode) || Number(error?.status) || (/billing|payment|required\s+balance|402/i.test(message) ? 402 : 429),
            type: "antigravity_quota_exceeded",
            retryable: false,
            diagnosis: "quota_or_limit_reached",
            message,
            suggestedAction: "切换 Antigravity 账号，或等待额度/限额恢复后重试。",
        };
    }
    if (isAntigravityAccountVerificationRequired(error)) {
        return {
            status: 403,
            type: "antigravity_account_unavailable",
            retryable: false,
            diagnosis: "account_verification_required",
            message,
        };
    }
    const accountUnavailable = /no available models|open Antigravity,\s*sign in|account.+(?:unavailable|not ready)|authentication required/i.test(message);
    if (accountUnavailable) {
        return {
            status: 503,
            type: "antigravity_account_unavailable",
            retryable: false,
            message,
        };
    }
    if (shouldRetryAntigravityFailure(error)) {
        return {
            status: 503,
            type: "antigravity_temporarily_unavailable",
            retryable: true,
            message,
        };
    }
    return {
        status: Number(error?.statusCode) || 500,
        type: "antigravity_error",
        retryable: false,
        message,
    };
}

function antigravityTrafficSnapshot(status = ANTIGRAVITY_TRAFFIC_STATUS) {
    const state = status?.state || "not_checked";
    return {
        accountTrafficReady: state === "ready" ? true : state === "not_checked" ? null : false,
        accountTrafficState: state,
        accountTrafficType: status?.type || null,
        accountTrafficDiagnosis: status?.diagnosis || null,
        accountTrafficStatus: Number.isFinite(status?.status) ? status.status : null,
        accountTrafficRetryable: typeof status?.retryable === "boolean" ? status.retryable : null,
        accountTrafficMessage: status?.message || "",
        accountTrafficSuggestedAction: status?.suggestedAction || "",
        accountTrafficLastFailureAt: status?.lastFailureAt || null,
        accountTrafficLastSuccessAt: status?.lastSuccessAt || null,
    };
}

function antigravityErrorLooksTrafficRelated(error) {
    const message = String(error?.message ?? error ?? "");
    const type = String(error?.type ?? "");
    if (type.startsWith("antigravity_")) return true;
    if (isAntigravityAccountVerificationRequired(error)) return true;
    if (isAntigravityQuotaOrLimitFailure(error)) return true;
    if (/Antigravity|Cascade|GetAvailableModels|GetUserStatus|SendUserCascadeMessage|daily-cloudcode|cloudcode-pa|googleapis|googleapis\.com/i.test(message)) return true;
    if (/open Antigravity|sign in to Antigravity|account.+(?:unavailable|not ready)|no available models/i.test(message)) return true;
    return false;
}

function shouldRecordAntigravityTrafficFailure(error) {
    if (!error || error?.name === "AbortError" || error?.name === "AntigravityCircuitOpenError" || error?.type === "antigravity_queue_full") return false;
    return antigravityErrorLooksTrafficRelated(error) || shouldRetryAntigravityFailure(error);
}

function applyAntigravityTrafficSuccess(status, { startedAtMs = Date.now(), completedAtMs = Date.now() } = {}) {
    const latestFailureMs = Number(status.lastFailureAtMs) || 0;
    if (latestFailureMs > startedAtMs) return false;
    status.state = "ready";
    status.type = null;
    status.diagnosis = null;
    status.status = 200;
    status.retryable = false;
    status.message = "";
    status.suggestedAction = "";
    status.lastSuccessAt = new Date(completedAtMs).toISOString();
    status.lastSuccessAtMs = completedAtMs;
    return true;
}

function applyAntigravityTrafficFailure(status, error, { occurredAtMs = Date.now() } = {}) {
    const failure = antigravityFailureDetails(error);
    status.state = failure.diagnosis || failure.type || "antigravity_error";
    status.type = failure.type || null;
    status.diagnosis = failure.diagnosis || null;
    status.status = Number.isFinite(failure.status) ? failure.status : null;
    status.retryable = Boolean(failure.retryable);
    status.message = clipForLog(failure.message || "", 500);
    status.suggestedAction = failure.suggestedAction || "";
    status.lastFailureAt = new Date(occurredAtMs).toISOString();
    status.lastFailureAtMs = occurredAtMs;
    return failure;
}

function recordAntigravityTrafficSuccess(options = {}) {
    return applyAntigravityTrafficSuccess(ANTIGRAVITY_TRAFFIC_STATUS, options);
}

function recordAntigravityTrafficFailure(error, options = {}) {
    return applyAntigravityTrafficFailure(ANTIGRAVITY_TRAFFIC_STATUS, error, options);
}

function antigravityReadinessFailure(readiness) {
    if (readiness?.state !== "account_unavailable" || readiness?.ready === true) return null;
    if (cachedAntigravityModelCount() > 0) return null;
    return {
        status: 503,
        type: "antigravity_account_unavailable",
        retryable: false,
        message: readiness.message || "Open Antigravity, sign in, and confirm its proxy connection, then retry.",
    };
}

function healthTimestamp(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    return String(value);
}

function antigravityVisibleModelIds(payload) {
    return extractAvailableAgentModels(payload).map((model) => model.id);
}

function translatorHealthPayload({
    upstream = upstreamDisplayName(),
    profile = PROFILE?.provider || "unknown",
    internalTools = toolsToInject(PROFILE).map((tool) => tool.function.name),
    readiness = null,
    circuit = null,
    cachedModelCount = cachedAntigravityModelCount(),
    traffic = ANTIGRAVITY_TRAFFIC_STATUS,
} = {}) {
    const payload = {
        ok: true,
        upstream,
        profile,
        internalTools,
        upstreamProfile: currentUpstreamHealthProfile(),
    };
    const readinessModelCount = Number(readiness?.modelCount) || 0;
    const effectiveModelCount = Math.max(readinessModelCount, Number(cachedModelCount) || 0);
    const hasCachedModels = effectiveModelCount > readinessModelCount;
    const catalogFallbackStates = new Set(["account_unavailable", "transient_error", "unknown"]);
    const usingCachedModelCatalog = hasCachedModels && catalogFallbackStates.has(readiness?.state || "unknown");
    const accountReady = readiness?.ready === true || usingCachedModelCatalog;
    const accountState = usingCachedModelCatalog
        ? "model_catalog_ready"
        : (readiness?.state || "unknown");
    const accountMessage = usingCachedModelCatalog
        ? "Antigravity account detail is temporarily unavailable; using the cached model catalog."
        : (readiness?.message || "");
    const withReadiness = readiness ? {
        ...payload,
        accountReady,
        accountState,
        modelCount: effectiveModelCount,
        accountMessage,
        ...antigravityTrafficSnapshot(traffic),
        accountLastCheckedAt: healthTimestamp(readiness.lastCheckedAt),
        accountLastReadyAt: healthTimestamp(readiness.lastReadyAt),
        accountConsecutiveFailures: Number(readiness.consecutiveFailures) || 0,
    } : { ...payload, ...antigravityTrafficSnapshot(traffic) };
    if (!circuit) return withReadiness;
    return {
        ...withReadiness,
        antigravityCircuitState: circuit.state || "closed",
        antigravityCircuitRetryAfterMs: Number(circuit.retryAfterMs) || 0,
        antigravityCircuitConsecutiveFailures: Number(circuit.consecutiveFailures) || 0,
        antigravityCircuitLastFailure: circuit.lastFailureMessage || "",
    };
}

function antigravityCatalogSummary(catalog = loadAntigravityCatalog()) {
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    return {
        path: ANTIGRAVITY_MODEL_CATALOG_PATH || null,
        present: Boolean(catalog),
        count: models.length,
        defaultModel: PROFILE?.defaultModel || null,
        fastModel: PROFILE?.fastModel || null,
        ids: models.map((model) => String(model?.slug || "")).filter(Boolean),
        displayNames: models.map((model) => String(model?.display_name || "")).filter(Boolean),
    };
}

function antigravityAccountFallbackSnapshot(error, catalog = loadAntigravityCatalog()) {
    const failure = antigravityFailureDetails(error);
    return {
        object: "antigravity.account",
        signedIn: false,
        identityAvailable: false,
        fingerprint: "",
        planName: "",
        tierName: "",
        maxInputTokens: "",
        webSearchEnabled: false,
        browserEnabled: false,
        autoRunCommandsEnabled: false,
        status: "detail_unavailable",
        degraded: true,
        retryable: failure.retryable !== false,
        message: failure.message,
        failureType: failure.type,
        models: antigravityCatalogSummary(catalog),
    };
}

function listLocalDirectories(path) {
    if (!path) return [];
    try {
        return readdirSync(path, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

function countLocalJsonFiles(path) {
    if (!path) return 0;
    try {
        return readdirSync(path, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
            .length;
    } catch {
        return 0;
    }
}

function activeModelSummary(
    catalog = loadAntigravityCatalog(),
    profile = PROFILE,
    antigravity = isAntigravityUpstreamMode(UPSTREAM_MODE),
) {
    if (antigravity) {
        return antigravityCatalogSummary(catalog);
    }
    const models = visibleModelPayload(catalog, profile).data;
    return {
        path: null,
        present: true,
        count: models.length,
        defaultModel: profile?.defaultModel || models[0]?.id || null,
        fastModel: profile?.fastModel || null,
        ids: models.map((model) => String(model?.id || "")).filter(Boolean),
        displayNames: models.map((model) => String(model?.display_name || model?.id || "")).filter(Boolean),
        source: "upstream-profile",
    };
}

function computeSnapshotManifest(dirPath) {
    const manifest = {};
    if (!dirPath || !existsSync(dirPath)) return manifest;
    const walk = (currentPath, relPath) => {
        for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
            if (entry.name === ".anticodex-source-manifest.json") continue;
            const fullPath = resolvePath(currentPath, entry.name);
            const entryRelPath = relPath ? joinPath(relPath, entry.name) : entry.name;
            if (entry.isDirectory()) {
                manifest[entryRelPath] = { type: "directory", mtimeMs: statSync(fullPath).mtimeMs };
                walk(fullPath, entryRelPath);
            } else if (entry.isFile()) {
                const hash = createHash("sha256").update(readFileSync(fullPath)).digest("hex").slice(0, 16);
                manifest[entryRelPath] = { type: "file", hash, mtimeMs: statSync(fullPath).mtimeMs };
            }
        }
    };
    walk(dirPath, "");
    return manifest;
}

function defaultExtraSkillsRoots() {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const configured = process.env.ANTICODEX_EXTRA_SKILLS_ROOTS || (home ? resolvePath(home, ".agents", "skills") : "");
    return configured
        .split(process.platform === "win32" ? ";" : ":")
        .map((item) => item.trim())
        .filter(Boolean);
}

function computeStartupSnapshotSourceFingerprint(sharedCodexHome) {
    if (!sharedCodexHome || !existsSync(sharedCodexHome)) return null;
    const startupMappings = [
        { relPath: "skills", sharedPath: resolvePath(sharedCodexHome, "skills"), extraSharedPaths: defaultExtraSkillsRoots() },
        { relPath: "AGENTS.md", sharedPath: resolvePath(sharedCodexHome, "AGENTS.md") },
        { relPath: "DEFAULT_SKILL_ALLOWLIST.md", sharedPath: resolvePath(sharedCodexHome, "DEFAULT_SKILL_ALLOWLIST.md") },
        { relPath: "RTK.md", sharedPath: resolvePath(sharedCodexHome, "RTK.md") },
        { relPath: "MCP_WORKER_USAGE_GUIDE.md", sharedPath: resolvePath(sharedCodexHome, "MCP_WORKER_USAGE_GUIDE.md") },
        { relPath: joinPath("cache", "codex_app_directory"), sharedPath: resolvePath(sharedCodexHome, "cache", "codex_app_directory") },
        { relPath: joinPath("cache", "codex_apps_tools"), sharedPath: resolvePath(sharedCodexHome, "cache", "codex_apps_tools") },
    ];
    try {
        let maxMtime = 0;
        const fp = createHash("sha256");
        for (const { relPath, sharedPath, extraSharedPaths = [] } of startupMappings) {
            const sourcePaths = [sharedPath, ...extraSharedPaths].filter((item) => existsSync(item));
            if (sourcePaths.length === 0) continue;
            fp.update(relPath);
            for (const sourcePath of sourcePaths) {
                fp.update(sourcePath);
                const sourceStat = statSync(sourcePath);
                if (sourceStat.isFile()) {
                    fp.update("file");
                    fp.update(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"));
                    if (sourceStat.mtimeMs > maxMtime) maxMtime = sourceStat.mtimeMs;
                } else if (sourceStat.isDirectory()) {
                    const manifest = computeSnapshotManifest(sourcePath);
                    for (const [entryPath, entry] of Object.entries(manifest).sort()) {
                        fp.update(entryPath);
                        fp.update(entry.type);
                        if (entry.hash) fp.update(entry.hash);
                        if (entry.mtimeMs > maxMtime) maxMtime = entry.mtimeMs;
                    }
                }
            }
        }
        return {
            sourceFingerprint: fp.digest("hex").slice(0, 32),
            sourceMtimeMax: maxMtime > 0 ? new Date(maxMtime).toISOString() : null,
        };
    } catch {
        return null;
    }
}

function mcpServerNamesFromConfig(configPath) {
    if (!configPath || !existsSync(configPath)) return [];
    try {
        const text = readFileSync(configPath, "utf8");
        return [...text.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]/gm)]
            .map((match) => match[1])
            .filter((name) => name && !name.endsWith(".env") && !name.includes(".tools."));
    } catch {
        return [];
    }
}

function anticodexCodexHomeDir() {
    return process.env.CODEX_HOME_DIR || process.env.CODEX_HOME || (ANTICODEX_STATE_ROOT ? resolvePath(ANTICODEX_STATE_ROOT, "codex-home-deepseek-app") : "");
}

function localConnectorAllowlistConfigPath() {
    const codexHome = anticodexCodexHomeDir();
    return codexHome ? resolvePath(codexHome, "config.toml") : "";
}

function tomlQuotedString(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function parseLocalConnectorAllowlistFromText(text = "") {
    const ids = new Set();
    let inSection = false;
    for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.replace(/#.*/, "").trim();
        if (!line) continue;
        const section = line.match(/^\[([^\]]+)\]$/);
        if (section) {
            inSection = section[1] === "local_authorized_connectors" || section[1] === "anticodex.local_authorized_connectors";
            continue;
        }
        if (!inSection) continue;
        const array = line.match(/^connectors\s*=\s*\[(.*)\]\s*$/);
        if (array) {
            for (const match of array[1].matchAll(/"((?:\\"|[^"])*)"/g)) {
                ids.add(match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
            }
            continue;
        }
        const enabled = line.match(/^("?)([^"=]+)\1\s*=\s*true\s*$/i);
        if (enabled) ids.add(enabled[2].trim());
    }
    return [...ids].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function readPersistedLocalConnectorAllowlist() {
    const configPath = localConnectorAllowlistConfigPath();
    if (!configPath || !existsSync(configPath)) return [];
    try {
        return parseLocalConnectorAllowlistFromText(readFileSync(configPath, "utf8"));
    } catch {
        return [];
    }
}

function envLocalConnectorAllowlist() {
    return String(process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS || "")
        .split(/[,\r\n]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

function replaceLocalConnectorAllowlistSection(text = "", connectorIds = []) {
    const section = [
        "[local_authorized_connectors]",
        `connectors = [${connectorIds.map(tomlQuotedString).join(", ")}]`,
    ].join("\n");
    const withoutSection = String(text || "").replace(/(?:^|\r?\n)\[(?:local_authorized_connectors|anticodex\.local_authorized_connectors)\]\s*[\s\S]*?(?=\r?\n\[|\s*$)/g, "");
    const trimmed = withoutSection.replace(/\s+$/g, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}${section}\n`;
}

function writePersistedLocalConnectorAllowlist(connectorIds) {
    const configPath = localConnectorAllowlistConfigPath();
    if (!configPath) {
        const error = new Error("Anti-Codex config path is not available.");
        error.statusCode = 500;
        throw error;
    }
    const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    mkdirSync(dirname(configPath), { recursive: true });
    writeTextAtomic(configPath, replaceLocalConnectorAllowlistSection(existing, connectorIds));
    return configPath;
}

function localConnectorAllowlistPayload() {
    const directory = localBackendApiResponse("GET", "/backend-api/aip/connectors") || { connectors: [] };
    const wham = localBackendApiResponse("POST", "/backend-api/wham/apps") || { tools: [] };
    const connectors = projectionItems(directory, "connectors");
    const tools = projectionItems(wham, "tools");
    const toolsByConnector = new Map();
    for (const tool of tools) {
        const id = String(tool?.connector_id || "");
        if (!id) continue;
        toolsByConnector.set(id, (toolsByConnector.get(id) || 0) + 1);
    }
    const persisted = readPersistedLocalConnectorAllowlist();
    const env = envLocalConnectorAllowlist();
    const effective = new Set([...persisted, ...env]);
    const rows = connectors.map((connector) => {
        const id = String(connector?.id || connector?.connector_id || "");
        return {
            id,
            name: String(connector?.name || connector?.displayName || id || "App"),
            isAccessible: connector?.isAccessible === true,
            locallyAuthorized: connector?.locallyAllowlisted === true || connector?.localAuthorization === "anticodex-local-allowlist" || effective.has(id),
            locallyAllowlisted: connector?.locallyAllowlisted === true || connector?.localAuthorization === "anticodex-local-allowlist" || effective.has(id),
            localAuthorization: connector?.localAuthorization || (effective.has(id) ? "anticodex-local-allowlist" : ""),
            toolCount: toolsByConnector.get(id) || 0,
        };
    }).filter((connector) => connector.id);
    return {
        ok: true,
        configPath: localConnectorAllowlistConfigPath(),
        persisted,
        env,
        effective: [...effective].sort((a, b) => a.localeCompare(b)),
        connectors: rows,
        counts: {
            total: rows.length,
            persisted: persisted.length,
            env: env.length,
            locallyAuthorized: rows.filter((connector) => connector.locallyAuthorized).length,
            localAllowlisted: rows.filter((connector) => connector.locallyAllowlisted).length,
            accessible: rows.filter((connector) => connector.isAccessible).length,
            appTools: tools.length,
        },
        note: "Local allowlists are metadata previews only. They do not authorize connectors or make app tools callable.",
    };
}

function validateLocalConnectorIds(connectorIds) {
    if (!Array.isArray(connectorIds)) {
        const error = new Error("connectorIds must be an array.");
        error.statusCode = 400;
        throw error;
    }
    const known = new Set(projectionItems(localBackendApiResponse("GET", "/backend-api/aip/connectors"), "connectors")
        .map((connector) => String(connector?.id || connector?.connector_id || ""))
        .filter(Boolean));
    const normalized = [...new Set(connectorIds.map((id) => String(id || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    if (normalized.length > 50) {
        const error = new Error("At most 50 local connectors can be allowlisted at once.");
        error.statusCode = 400;
        throw error;
    }
    const unknown = normalized.filter((id) => !known.has(id));
    if (unknown.length > 0) {
        const error = new Error(`Unknown connector id(s): ${unknown.slice(0, 10).join(", ")}`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function projectionItems(payload, key = "") {
    if (Array.isArray(payload)) return payload;
    if (key && Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
}

function localFeatureSummary({ includeProjection = false } = {}) {
    const codexHome = process.env.CODEX_HOME_DIR || process.env.CODEX_HOME || (ANTICODEX_STATE_ROOT ? resolvePath(ANTICODEX_STATE_ROOT, "codex-home-deepseek-app") : "");
    const sharedCodexHome = process.env.DEEPCODEX_SHARED_CODEX_HOME || process.env.GLOBAL_CODEX_HOME || "";
    const skillsPath = codexHome ? resolvePath(codexHome, "skills") : "";
    const connectorCachePath = codexHome ? resolvePath(codexHome, "cache", "codex_app_directory") : "";
    const appToolsCachePath = codexHome ? resolvePath(codexHome, "cache", "codex_apps_tools") : "";
    const configPath = codexHome ? resolvePath(codexHome, "config.toml") : "";
    const snapshotMarkerPath = codexHome ? resolvePath(codexHome, ".anticodex-startup-snapshots-ready.json") : "";
    const skillNames = listLocalDirectories(skillsPath);
    const mcpNames = mcpServerNamesFromConfig(configPath);
    const requiredSkills = ["headroom", "context-save", "context-restore", "keep-codex-fast"];
    const snapshotMaxAgeHours = Math.max(1, Number(process.env.ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS) || 24);
    const snapshotMarker = readJsonIfPresent(snapshotMarkerPath);
    const snapshotUpdatedAtMs = Date.parse(String(snapshotMarker?.updatedAt || ""));
    const snapshotAgeHours = Number.isFinite(snapshotUpdatedAtMs)
        ? Math.max(0, (Date.now() - snapshotUpdatedAtMs) / 3_600_000)
        : null;
    const snapshotMarkerValid = snapshotMarker?.schema === "anticodex-startup-snapshots-ready-v1"
        && Number.isFinite(snapshotUpdatedAtMs);
    const snapshotSource = snapshotMarkerValid
        ? computeStartupSnapshotSourceFingerprint(snapshotMarker?.sharedCodexHome || sharedCodexHome)
        : null;
    const sourceFingerprintPresent = typeof snapshotMarker?.sourceFingerprint === "string"
        && snapshotMarker.sourceFingerprint.length > 0;
    const sourceFingerprintComparable = Boolean(snapshotSource?.sourceFingerprint);
    const sourceFingerprintMatches = sourceFingerprintComparable
        ? (sourceFingerprintPresent && snapshotMarker.sourceFingerprint === snapshotSource.sourceFingerprint)
        : null;
    const snapshotState = !snapshotMarker
        ? "missing"
        : (!snapshotMarkerValid
            ? "invalid"
            : (snapshotAgeHours > snapshotMaxAgeHours || sourceFingerprintMatches === false ? "stale" : "fresh"));
    const snapshotStaleReason = snapshotState !== "stale"
        ? null
        : (snapshotAgeHours > snapshotMaxAgeHours
            ? "age"
            : (sourceFingerprintMatches === false ? "source_changed" : "unknown"));
    const readableSkillNames = skillNames.filter((name) => existsSync(resolvePath(skillsPath, name, "SKILL.md")));
    const installedPlugins = includeProjection
        ? projectionItems(localBackendApiResponse("GET", "/backend-api/ps/plugins/installed"))
        : [];
    const connectors = includeProjection
        ? projectionItems(localBackendApiResponse("GET", "/backend-api/aip/connectors"), "connectors")
        : [];
    const appTools = includeProjection
        ? projectionItems(localBackendApiResponse("POST", "/backend-api/wham/apps"), "tools")
        : [];
    const authorizedConnectors = connectors.filter((connector) => connector?.isAccessible === true);
    const localAllowlistedConnectors = connectors.filter((connector) =>
        connector?.locallyAllowlisted === true || connector?.localAuthorization === "anticodex-local-allowlist");
    return {
        codexHome: codexHome || null,
        sharedCodexHome: sharedCodexHome || null,
        skills: {
            path: skillsPath || null,
            count: skillNames.length,
            requiredPresent: requiredSkills.filter((name) => skillNames.includes(name)),
            sample: skillNames.slice(0, 12),
        },
        mcp: {
            configPath: configPath || null,
            count: mcpNames.length,
            names: mcpNames.slice(0, 12),
        },
        snapshots: {
            connectorDirectoryFiles: countLocalJsonFiles(connectorCachePath),
            appToolsCacheFiles: countLocalJsonFiles(appToolsCachePath),
        },
        snapshotStatus: {
            present: Boolean(snapshotMarker),
            state: snapshotState,
            stale: snapshotState !== "fresh",
            updatedAt: snapshotMarkerValid ? snapshotMarker.updatedAt : null,
            ageHours: snapshotAgeHours,
            maxAgeHours: snapshotMaxAgeHours,
            sourceMtimeMax: snapshotMarker?.sourceMtimeMax || null,
            currentSourceMtimeMax: snapshotSource?.sourceMtimeMax || null,
            sourceFingerprintPresent,
            sourceFingerprintComparable,
            sourceFingerprintMatches,
            staleReason: snapshotStaleReason,
        },
        capabilityTiers: {
            skills: {
                inventoryCount: skillNames.length,
                readableCount: readableSkillNames.length,
                usableCount: readableSkillNames.length,
                mode: "instruction",
            },
            mcp: {
                configuredCount: mcpNames.length,
                callableCount: null,
                mode: "current-session-tool-list",
            },
            plugins: {
                inventoryCount: includeProjection ? installedPlugins.length : null,
                callableCount: 0,
                mode: "metadata-only",
            },
            connectors: {
                inventoryCount: includeProjection ? connectors.length : null,
                authorizedCount: includeProjection ? authorizedConnectors.length : null,
                remoteAuthorizedCount: includeProjection ? authorizedConnectors.length : null,
                localAllowlistedCount: includeProjection ? localAllowlistedConnectors.length : null,
                callableToolCount: includeProjection ? appTools.length : null,
                mode: includeProjection && authorizedConnectors.length > 0 ? "real-authorized" : "metadata-only",
            },
        },
    };
}

function diagnosticsPayload({
    health = translatorHealthPayload({
        readiness: ANTIGRAVITY_READINESS?.getSnapshot() ?? null,
        circuit: ANTIGRAVITY_FAILURE_CIRCUIT.snapshot(),
    }),
    routeAudit = ANTIGRAVITY_MODEL_ROUTE_AUDIT.snapshot(),
    catalog = loadAntigravityCatalog(),
    responsesWebSocket = responsesWebSocketAuditSnapshot(),
    nativeToolCapability = antigravityNativeToolCapabilitySummary({
        nativeBridgeEnabled: isAntigravityNativeToolBridgeEnabled(),
    }),
    lifecycle = latestLifecycleStatus(),
    updateStatus = readJsonIfPresent(ANTICODEX_STATE_ROOT
        ? resolvePath(ANTICODEX_STATE_ROOT, "update-status.json")
        : ""),
    postVerification = latestPostVerificationStatus(),
    installedChecks = latestInstalledCheckStatus(),
    shortcutRepair = latestShortcutRepairStatus(),
    sourcePreflight = latestSourcePreflightStatus(),
} = {}) {
    const latestRoutes = Array.isArray(routeAudit?.entries)
        ? routeAudit.entries.slice(0, 10)
        : [];
    const antigravity = health?.upstream === "antigravity-desktop" || isAntigravityUpstreamMode(UPSTREAM_MODE);
    const toolBridge = antigravityToolBridgeSummary(antigravity ? "antigravity" : UPSTREAM_MODE);
    const accountTracking = ANTIGRAVITY_ACCOUNT_TRACKER.getSnapshot();
    const longTasks = longTaskSummary({ postVerification, updateStatus });
    return {
        ok: true,
        object: "anticodex.diagnostics",
        generatedAt: new Date().toISOString(),
        process: {
            pid: process.pid,
            node: process.version,
            uptimeSec: Math.round(process.uptime()),
        },
        mode: {
            upstreamMode: UPSTREAM_MODE,
            upstream: upstreamDisplayName(),
            profile: PROFILE?.provider || "unknown",
            antigravity,
        },
        health,
        paths: {
            stateRoot: ANTICODEX_STATE_ROOT || null,
            codexHome: process.env.CODEX_HOME || process.env.CODEX_HOME_DIR || null,
            sharedCodexHome: process.env.DEEPCODEX_SHARED_CODEX_HOME || process.env.GLOBAL_CODEX_HOME || null,
            profile: PROFILE_PATH || null,
            modelCatalog: ANTIGRAVITY_MODEL_CATALOG_PATH || null,
            responseHistory: RESPONSE_HISTORY_PATH || null,
            modelRouteAudit: ANTIGRAVITY_MODEL_ROUTE_AUDIT_PATH || null,
        },
        models: activeModelSummary(catalog, PROFILE, antigravity),
        accountTracking: {
            identityAvailable: accountTracking.identityAvailable,
            changePending: Boolean(accountTracking.pendingFingerprint),
            pendingObservations: accountTracking.pendingObservations,
            requiredObservations: accountTracking.requiredObservations,
        },
        modelRoutes: {
            count: Number(routeAudit?.count) || latestRoutes.length,
            latest: routeAudit?.latest || null,
            recent: latestRoutes,
        },
        localFeatures: localFeatureSummary({ includeProjection: true }),
        toolBridge,
        nativeToolCapability,
        lifecycle,
        responsesWebSocket,
        updateStatus: updateStatus || {
            ok: false,
            updateNeeded: false,
            reason: "not_checked",
            sync: { available: false, launched: false, prompted: false },
            operation: { state: "idle", stage: "none" },
        },
        postVerification,
        longTasks,
        installedChecks,
        shortcutRepair,
        sourcePreflight,
        antigravityRetries: {
            count: ANTIGRAVITY_RETRY_AUDIT.count,
            latest: ANTIGRAVITY_RETRY_AUDIT.latest,
        },
        antigravityQueue: ANTIGRAVITY_REQUEST_QUEUE.snapshot(),
        antigravityBusy: antigravityBusySnapshot(),
        antigravitySessionLock: {
            ...ANTIGRAVITY_SESSION_LOCK.snapshot(),
            resetAction: "resetAntigravitySessionLock",
        },
        activeAntigravityRequests: ACTIVE_ANTIGRAVITY_REQUESTS.snapshot(),
        capabilities: {
            hostedTools: Boolean(PROFILE?.capabilities?.hostedTools),
            internalWebTools: Boolean(PROFILE?.capabilities?.internalWebTools),
            nativeStreaming: Boolean(PROFILE?.capabilities?.nativeStreaming),
            internalTools: Array.isArray(health?.internalTools) ? health.internalTools : [],
        },
        tools: {
            bridge: toolBridge.mode === "native-mcp-same-cascade"
                ? "native_mcp_same_cascade"
                : (toolBridge.mode === "codex-owned-tools-prompt-mediated" ? "codex_owned_prompt_tool_bridge" : "provider_native_or_compat"),
            antigravityMode: toolBridge.transport === "desktop-cascade",
            injectInternalTools: toolsToInject(PROFILE).length > 0,
            nativeAntigravityToolEvents: toolBridge.nativeAntigravityToolEvents,
            acceptsExternalToolDefinitions: toolBridge.acceptsExternalToolDefinitions,
            description: toolBridge.mode === "native-mcp-same-cascade"
                ? "Antigravity receives Codex tool schemas through a local native MCP customization server. Permission interactions are automatically approved before Codex executes the tool, results resume the same Cascade, and protocol failures before any Codex-visible event fall back to the prompt bridge."
                : (toolBridge.mode === "codex-owned-tools-prompt-mediated"
                    ? "The native MCP bridge was explicitly disabled. Anti-Codex keeps tool execution on the Codex side and sends the prompt-mediated compatibility protocol to Antigravity."
                    : "Tools are sent as native Chat function calls to the upstream."),
        },
        limits: {
            ...antigravityPromptLimits(),
            maxToolLoops: MAX_TOOL_LOOPS,
            restoredInputItems: MAX_RESTORED_INPUT_ITEMS,
            restoredToolCalls: MAX_RESTORED_TOOL_CALLS,
            restoredToolOutputChars: MAX_RESTORED_TOOL_OUTPUT_CHARS,
            maxQueuedAntigravityRequests: ANTIGRAVITY_MAX_QUEUED_REQUESTS,
        },
    };
}

function readJsonIfPresent(filePath) {
    if (!filePath || !existsSync(filePath)) return null;
    try {
        return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
        return null;
    }
}

function readJsonReportIfPresent(filePath) {
    if (!filePath || !existsSync(filePath)) {
        return { exists: false, parseable: false, value: null, error: "" };
    }
    try {
        return {
            exists: true,
            parseable: true,
            value: JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")),
            error: "",
        };
    } catch (error) {
        return {
            exists: true,
            parseable: false,
            value: null,
            error: String(error?.message || error || "JSON parse failed").replace(/[\r\n]+/g, " ").slice(0, 240),
        };
    }
}

function reportIntegrityForPath(filePath) {
    const sidecarPath = `${filePath}.sha256`;
    if (!filePath || !existsSync(filePath)) {
        return { signed: false, valid: null, hash: "", expected: "", sidecar: sidecarPath, error: "" };
    }
    if (!existsSync(sidecarPath)) {
        return { signed: false, valid: null, hash: "", expected: "", sidecar: sidecarPath, error: "missing_hash_sidecar" };
    }
    try {
        const sidecar = readFileSync(sidecarPath, "ascii").trim();
        const match = sidecar.match(/^(?:sha256:)?([a-fA-F0-9]{64})$/);
        if (!match) {
            return { signed: true, valid: false, hash: "", expected: shortSafeText(sidecar, ""), sidecar: sidecarPath, error: "invalid_hash_sidecar" };
        }
        const expected = match[1].toLowerCase();
        const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
        return {
            signed: true,
            valid: hash === expected,
            hash,
            expected,
            sidecar: sidecarPath,
            error: hash === expected ? "" : "hash_mismatch",
        };
    } catch (error) {
        return { signed: true, valid: false, hash: "", expected: "", sidecar: sidecarPath, error: shortSafeText(error?.message || error, "hash_check_failed") };
    }
}

function shortSafeText(value, fallback = "") {
    if (value == null) return fallback;
    return String(value).replace(/[\r\n]+/g, " ").slice(0, 240) || fallback;
}

function installedCheckSummary(report, expectedFast) {
    if (!report || typeof report !== "object") {
        return {
            present: false,
            ok: false,
            fast: expectedFast,
            noTraffic: null,
            reportName: expectedFast ? "installed-overall-fast" : "installed-overall",
            elapsedMs: null,
            modelCount: null,
            failureCount: 0,
            reportPath: "",
            historyPath: "",
        };
    }
    const failures = Array.isArray(report.failures) ? report.failures : [];
    const elapsedMs = Number(report.elapsedMs);
    const modelCount = Number(report.models?.count ?? report.health?.modelCount);
    return {
        present: true,
        ok: report.ok === true,
        fast: report.fast === true,
        noTraffic: report.noTraffic === true,
        reportName: shortSafeText(report.reportName, expectedFast ? "installed-overall-fast" : "installed-overall"),
        elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : null,
        modelCount: Number.isFinite(modelCount) ? Math.max(0, modelCount) : null,
        failureCount: failures.length,
        reportPath: shortSafeText(report.report?.latest, ""),
        historyPath: shortSafeText(report.report?.history, ""),
    };
}

function latestInstalledCheckStatus({
    full = readJsonIfPresent(ANTICODEX_STATE_ROOT
        ? resolvePath(ANTICODEX_STATE_ROOT, "reports", "latest-installed-overall.json")
        : ""),
    fast = readJsonIfPresent(ANTICODEX_STATE_ROOT
        ? resolvePath(ANTICODEX_STATE_ROOT, "reports", "latest-installed-overall-fast.json")
        : ""),
} = {}) {
    return {
        full: installedCheckSummary(full, false),
        fast: installedCheckSummary(fast, true),
    };
}

function shortcutRepairSummary(report) {
    if (!report || typeof report !== "object") {
        return {
            present: false,
            ok: false,
            reportName: "shortcut-repair",
            repairedAt: null,
            repairedCount: null,
            failureCount: 0,
            reportPath: "",
            historyPath: "",
        };
    }
    const failures = Array.isArray(report.failures) ? report.failures : [];
    const repairedCount = Number(report.repairedCount);
    return {
        present: true,
        ok: report.ok === true,
        reportName: shortSafeText(report.reportName, "shortcut-repair"),
        repairedAt: shortSafeText(report.repairedAt || report.generatedAt, ""),
        repairedCount: Number.isFinite(repairedCount) ? Math.max(0, repairedCount) : null,
        failureCount: failures.length,
        reportPath: shortSafeText(report.report?.latest, ""),
        historyPath: shortSafeText(report.report?.history, ""),
    };
}

function latestShortcutRepairStatus({
    report = readJsonIfPresent(ANTICODEX_STATE_ROOT
        ? resolvePath(ANTICODEX_STATE_ROOT, "reports", "latest-shortcut-repair.json")
        : ""),
} = {}) {
    return shortcutRepairSummary(report);
}

function sourcePreflightSummary(report) {
    if (!report || typeof report !== "object") {
        return {
            present: false,
            ok: false,
            reportName: "source-preflight",
            skipFullRegression: null,
            elapsedMs: null,
            failureCount: 0,
            warningCount: 0,
            javascriptSyntaxOk: null,
            powershellSyntaxOk: null,
            uiStateSelfTestOk: null,
            upstreamProfileStorageOk: null,
            publicDocumentationOk: null,
            translatorRegressionOk: null,
            diffWhitespaceOk: null,
            tests: "",
            pass: "",
            fail: "",
            skipped: "",
            reportPath: "",
            historyPath: "",
        };
    }
    const failures = Array.isArray(report.failures) ? report.failures : [];
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    const checks = report.checks && typeof report.checks === "object" ? report.checks : {};
    const regression = checks.translatorRegression && typeof checks.translatorRegression === "object" ? checks.translatorRegression : {};
    const elapsedMs = Number(report.elapsedMs);
    return {
        present: true,
        ok: report.ok === true,
        reportName: shortSafeText(report.reportName, "source-preflight"),
        skipFullRegression: report.skipFullRegression === true,
        elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : null,
        failureCount: failures.length,
        warningCount: warnings.length,
        javascriptSyntaxOk: checks.javascriptSyntax?.ok === true,
        powershellSyntaxOk: checks.powershellSyntax?.ok === true,
        uiStateSelfTestOk: checks.uiStateSelfTest?.ok === true,
        upstreamProfileStorageOk: checks.upstreamProfileStorage?.ok === true,
        publicDocumentationOk: checks.publicDocumentation?.ok === true,
        translatorRegressionOk: checks.translatorRegression?.ok === true,
        diffWhitespaceOk: checks.diffWhitespace?.ok === true,
        tests: shortSafeText(regression.tests, ""),
        pass: shortSafeText(regression.pass, ""),
        fail: shortSafeText(regression.fail, ""),
        skipped: shortSafeText(regression.skipped, ""),
        reportPath: shortSafeText(report.report?.latest, ""),
        historyPath: shortSafeText(report.report?.history, ""),
    };
}

function latestSourcePreflightStatus({
    report = readJsonIfPresent(ANTICODEX_STATE_ROOT
        ? resolvePath(ANTICODEX_STATE_ROOT, "reports", "latest-source-preflight.json")
        : ""),
} = {}) {
    return sourcePreflightSummary(report);
}

function safeErrorSummary(error) {
    if (!error) return { name: "Error", message: "" };
    return {
        name: shortSafeText(error.name || "Error", "Error"),
        message: shortSafeText(error.message || String(error), ""),
        code: shortSafeText(error.code || "", ""),
    };
}

function writeLifecycleEvent(type, details = {}) {
    if (!ANTICODEX_LIFECYCLE_STATUS_PATH) return;
    const event = {
        type: shortSafeText(type, "unknown"),
        at: new Date().toISOString(),
        pid: process.pid,
        host: HOST,
        listenHost: LISTEN_HOST,
        port: PORT,
        upstream: upstreamDisplayName(),
        details,
    };
    try {
        writeJsonAtomic(ANTICODEX_LIFECYCLE_STATUS_PATH, event);
        if (ANTICODEX_LIFECYCLE_LOG_PATH) {
            mkdirSync(dirname(ANTICODEX_LIFECYCLE_LOG_PATH), { recursive: true });
            appendFileSync(ANTICODEX_LIFECYCLE_LOG_PATH, `${JSON.stringify(event)}\n`, "utf8");
            trimLifecycleLog(ANTICODEX_LIFECYCLE_LOG_PATH);
        }
    } catch (error) {
        console.error(`[adaptive] Failed to write lifecycle event: ${error.message || error}`);
    }
}

function trimLifecycleLog(filePath) {
    if (!filePath || !existsSync(filePath)) return;
    try {
        const maxBytes = Number.isFinite(ANTICODEX_LIFECYCLE_LOG_MAX_BYTES) ? Math.max(4096, ANTICODEX_LIFECYCLE_LOG_MAX_BYTES) : 256 * 1024;
        const maxLines = Number.isFinite(ANTICODEX_LIFECYCLE_LOG_MAX_LINES) ? Math.max(20, ANTICODEX_LIFECYCLE_LOG_MAX_LINES) : 200;
        if (statSync(filePath).size <= maxBytes) return;
        const lines = readFileSync(filePath, "utf8").replace(/\s+$/g, "").split(/\r?\n/).slice(-maxLines);
        writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    } catch (error) {
        console.error(`[adaptive] Failed to trim lifecycle log: ${error.message || error}`);
    }
}

function latestLifecycleStatus(report = readJsonIfPresent(ANTICODEX_LIFECYCLE_STATUS_PATH)) {
    if (!report || typeof report !== "object") {
        return {
            present: false,
            type: "not_checked",
            at: "",
            pid: process.pid,
            port: PORT,
            message: "",
        };
    }
    const details = report.details && typeof report.details === "object" ? report.details : {};
    return {
        present: true,
        type: shortSafeText(report.type, "unknown"),
        at: shortSafeText(report.at, ""),
        pid: Number(report.pid) || process.pid,
        port: Number(report.port) || PORT,
        upstream: shortSafeText(report.upstream || upstreamDisplayName(), upstreamDisplayName()),
        errorName: shortSafeText(details.error?.name || details.name, ""),
        message: shortSafeText(details.error?.message || details.message, ""),
    };
}

function latestPostVerificationStatus(report = readJsonIfPresent(ANTICODEX_STATE_ROOT
    ? resolvePath(ANTICODEX_STATE_ROOT, "reports", "latest-post-verification.json")
    : "")) {
    if (!report || typeof report !== "object") {
        return {
            present: false,
            ok: false,
            state: "not_checked",
            usedRealTraffic: false,
            latestDiagnosis: "not_checked",
            latestDiagnosisDetail: "",
            latestSuggestedAction: "",
            attempts: 0,
            elapsedMs: null,
            openedAntigravity: false,
            failureCount: 0,
            overallOk: null,
            latestAttemptAt: "",
        };
    }
    const wait = report.wait && typeof report.wait === "object" ? report.wait : {};
    const latest = wait.latest && typeof wait.latest === "object" ? wait.latest : {};
    const recent = Array.isArray(wait.recent) ? wait.recent : [];
    const lastAttempt = recent.length > 0 ? recent[recent.length - 1] : null;
    const failures = Array.isArray(report.failures) ? report.failures : [];
    const attempts = Number(wait.attempts);
    const elapsedMs = Number(report.elapsedMs);
    const overall = report.overall && typeof report.overall === "object" ? report.overall : null;
    const reportPaths = report.report && typeof report.report === "object" ? report.report : {};
    return {
        present: true,
        ok: report.ok === true,
        state: shortSafeText(report.state, "unknown"),
        usedRealTraffic: report.usedRealTraffic === true,
        latestDiagnosis: shortSafeText(wait.latestDiagnosis || report.latestDiagnosis || latest.diagnosis, "unknown"),
        latestDiagnosisDetail: shortSafeText(latest.diagnosisDetail || report.latestDiagnosisDetail, ""),
        latestSuggestedAction: shortSafeText(wait.latestSuggestedAction || latest.suggestedAction, ""),
        attempts: Number.isFinite(attempts) ? Math.max(0, attempts) : 0,
        elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : null,
        openedAntigravity: report.openedAntigravity === true,
        failureCount: failures.length,
        overallOk: overall ? overall.ok === true : null,
        latestAttemptAt: shortSafeText(lastAttempt?.at, ""),
        updatedAt: shortSafeText(report.updatedAt || report.completedAt || lastAttempt?.at, ""),
        reportPath: shortSafeText(reportPaths.latest, ""),
        historyPath: shortSafeText(reportPaths.history, ""),
    };
}

function longTaskStateText(state) {
    const text = String(state || "");
    if (!text) return "unknown";
    if (/completed|success|ready/i.test(text)) return "completed";
    if (/failed|error|timeout|unready/i.test(text)) return "attention";
    if (/running|waiting|started|account_ready|provider_ready|syncing|building|verifying/i.test(text)) return "running";
    return text;
}

function longTaskItem({ id, label, state, stage = "", updatedAt = "", elapsedMs = null, reportPath = "", failureCount = 0, hint = "" }) {
    const normalized = longTaskStateText(state);
    return {
        id,
        label,
        state: normalized,
        rawState: shortSafeText(state || normalized, "unknown"),
        stage: shortSafeText(stage, ""),
        updatedAt: shortSafeText(updatedAt, ""),
        elapsedMs: Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : null,
        reportPath: shortSafeText(reportPath, ""),
        failureCount: Number.isFinite(Number(failureCount)) ? Math.max(0, Number(failureCount)) : 0,
        hint: shortSafeText(hint, ""),
    };
}

function longTaskSummary({ postVerification = latestPostVerificationStatus(), updateStatus = null } = {}) {
    const operation = updateStatus?.operation && typeof updateStatus.operation === "object" ? updateStatus.operation : {};
    const syncState = operation.state || (updateStatus?.sync?.launched ? "running" : "idle");
    const syncStage = operation.stage || updateStatus?.reason || "idle";
    const syncReport = updateStatus?.report?.latest || updateStatus?.reportPath || "";
    const postReport = postVerification?.reportPath || postVerification?.latestReportPath || "";
    const items = [
        longTaskItem({
            id: "syncHost",
            label: "同步 Codex 更新",
            state: syncState,
            stage: syncStage,
            updatedAt: operation.updatedAt || operation.completedAt || updateStatus?.checkedAt || "",
            elapsedMs: operation.elapsedMs,
            reportPath: syncReport,
            failureCount: Array.isArray(operation.failures) ? operation.failures.length : 0,
            hint: syncState === "idle" ? "没有正在运行的同步任务" : "同步会先构建候选版，验证通过才替换当前 Anti-Codex",
        }),
        longTaskItem({
            id: "postVerificationFull",
            label: "验证后完整检查",
            state: postVerification?.state || "not_checked",
            stage: postVerification?.latestDiagnosis || "",
            updatedAt: postVerification?.updatedAt || postVerification?.latestAttemptAt || "",
            elapsedMs: postVerification?.elapsedMs,
            reportPath: postReport,
            failureCount: postVerification?.failureCount || 0,
            hint: postVerification?.usedRealTraffic ? "会消耗真实 Antigravity 流量" : "尚未运行真实流量完整检查",
        }),
    ];
    const runningCount = items.filter((item) => item.state === "running").length;
    const attentionCount = items.filter((item) => item.state === "attention").length;
    return {
        ok: attentionCount === 0,
        runningCount,
        attentionCount,
        items,
    };
}

function recordAntigravityRetry(retry) {
    ANTIGRAVITY_RETRY_AUDIT.count += 1;
    ANTIGRAVITY_RETRY_AUDIT.latest = {
        at: new Date().toISOString(),
        attempt: Number(retry?.attempt) || 0,
        nextAttempt: Number(retry?.nextAttempt) || 0,
        maxAttempts: Number(retry?.maxAttempts) || 0,
        delayMs: Number(retry?.delayMs) || 0,
        streaming: retry?.streaming === true,
        reason: String(retry?.reason || "transient"),
    };
}

function antigravityToolBridgeSummary(upstreamMode = UPSTREAM_MODE) {
    const antigravity = isAntigravityUpstreamMode(upstreamMode);
    const nativeBridgeEnabled = antigravity && isAntigravityNativeToolBridgeEnabled();
    return {
        mode: antigravity
            ? (nativeBridgeEnabled ? "native-mcp-same-cascade" : "codex-owned-tools-prompt-mediated")
            : "provider-native-or-compat",
        transport: antigravity ? "desktop-cascade" : "upstream-provider",
        localAdapter: antigravity
            ? (nativeBridgeEnabled ? "native-mcp-same-cascade-with-prompt-fallback" : "codex-owned-tools-prompt-mediated-native-disabled")
            : null,
        nativeAntigravityToolEvents: nativeBridgeEnabled,
        nativeMcpDiscoveryVerified: antigravity,
        nativeBridgeDefaultEnabled: nativeBridgeEnabled,
        acceptsExternalToolDefinitions: true,
        verifier: antigravity
            ? (nativeBridgeEnabled ? "test-anticodex-native-tool-loop.ps1" : "test-anticodex-tool-loop.ps1")
            : null,
        nativeVerifier: antigravity ? "test-anticodex-native-tool-loop.ps1" : null,
    };
}

function safeHeaderValue(value) {
    if (Array.isArray(value)) return value.map(safeHeaderValue).filter(Boolean).join(", ");
    if (value == null) return "";
    return String(value).replace(/[\r\n]+/g, " ").slice(0, 240);
}

function responsesWebSocketAuditSnapshot() {
    return {
        supported: RESPONSES_WEBSOCKET_AUDIT.supported,
        fallbackStatus: RESPONSES_WEBSOCKET_AUDIT.fallbackStatus,
        fallbackType: RESPONSES_WEBSOCKET_AUDIT.fallbackType,
        attempts: RESPONSES_WEBSOCKET_AUDIT.attempts,
        lastAttempt: RESPONSES_WEBSOCKET_AUDIT.lastAttempt ? { ...RESPONSES_WEBSOCKET_AUDIT.lastAttempt } : null,
        lastUpgrade: RESPONSES_WEBSOCKET_AUDIT.lastUpgrade ? { ...RESPONSES_WEBSOCKET_AUDIT.lastUpgrade } : null,
        lastHttpPrewarm: RESPONSES_WEBSOCKET_AUDIT.lastHttpPrewarm ? { ...RESPONSES_WEBSOCKET_AUDIT.lastHttpPrewarm } : null,
    };
}

function recordResponsesWebSocketAttempt(req, {
    kind = "upgrade",
    status = 501,
    responseType = "unsupported_websocket",
    pathname = "",
} = {}) {
    const url = new URL(req?.url || pathname || "/", `http://${req?.headers?.host || `${HOST}:${PORT}`}`);
    const attempt = {
        at: new Date().toISOString(),
        kind,
        method: safeHeaderValue(req?.method || (kind === "upgrade" ? "GET" : "")),
        path: pathname || url.pathname,
        query: Boolean(url.search),
        host: safeHeaderValue(req?.headers?.host),
        upgrade: safeHeaderValue(req?.headers?.upgrade),
        connection: safeHeaderValue(req?.headers?.connection),
        secWebSocketVersion: safeHeaderValue(req?.headers?.["sec-websocket-version"]),
        secWebSocketProtocol: safeHeaderValue(req?.headers?.["sec-websocket-protocol"]),
        userAgent: safeHeaderValue(req?.headers?.["user-agent"]),
        remoteAddress: safeHeaderValue(req?.socket?.remoteAddress),
        status,
        responseType,
    };
    RESPONSES_WEBSOCKET_AUDIT.attempts += 1;
    RESPONSES_WEBSOCKET_AUDIT.lastAttempt = attempt;
    if (kind === "upgrade") RESPONSES_WEBSOCKET_AUDIT.lastUpgrade = attempt;
    if (kind === "http-prewarm") RESPONSES_WEBSOCKET_AUDIT.lastHttpPrewarm = attempt;
    return attempt;
}

function loadProfileFromFile() {
    if (!PROFILE_PATH || !existsSync(PROFILE_PATH)) return null;
    try {
        const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
        if (profile?.effective) {
            return {
                ...profile,
                ...profile.effective,
                defaults: profile.defaults,
                detected: profile.detected,
                effective: profile.effective,
                capabilities: profile.effective.capabilities || profile.capabilities || {},
                toolStrategy: profile.effective.toolStrategy || profile.toolStrategy || {},
                models: profile.effective.models || profile.models || [],
                defaultModel: profile.effective.defaultModel || profile.defaultModel,
                fastModel: profile.effective.fastModel || profile.fastModel,
            };
        }
        return profile;
    } catch (err) {
        console.error(`[adaptive] Failed to load profile ${PROFILE_PATH}: ${err.message || err}`);
        return null;
    }
}

function loadAntigravityCatalog() {
    if (!ANTIGRAVITY_MODEL_CATALOG_PATH || !existsSync(ANTIGRAVITY_MODEL_CATALOG_PATH)) return null;
    try {
        return JSON.parse(readFileSync(ANTIGRAVITY_MODEL_CATALOG_PATH, "utf8"));
    } catch (error) {
        console.error(`[adaptive] Failed to load Antigravity model catalog: ${error.message || error}`);
        return null;
    }
}

function antigravityProfileFromCatalog(catalog) {
    const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
    const models = catalogModels.map((model) => model?.slug).filter(Boolean);
    const defaultModel = models.includes("gemini-pro-agent") ? "gemini-pro-agent" : (models[0] || "gemini-pro-agent");
    const fastModel = models.includes("gemini-3.5-flash-low")
        ? "gemini-3.5-flash-low"
        : (models.find((model) => /flash/i.test(model)) || defaultModel);
    return {
        provider: "antigravity",
        defaultModel,
        fastModel,
        models: models.length ? models : [defaultModel, fastModel],
        capabilities: {
            vision: catalogModels.some((model) => model?.input_modalities?.includes("image")),
            hostedTools: false,
            internalWebTools: true,
            nativeStreaming: false,
        },
        toolStrategy: {
            web_search: "local.web_search_urllib",
            web_fetch: "local.web_fetch_urllib",
        },
    };
}

function buildAntigravityModelRefresh(payload, baseCatalog = null) {
    const availableModels = extractAvailableAgentModels(payload);
    if (!availableModels.length) {
        throw new Error("Antigravity returned an empty model list during model refresh.");
    }
    const catalog = buildAntigravityModelCatalog(baseCatalog || { models: [] }, availableModels);
    const profile = antigravityProfileFromCatalog(catalog);
    return {
        ok: true,
        catalog,
        profile,
        models: profile.models,
        defaultModel: profile.defaultModel,
        fastModel: profile.fastModel,
        modelCount: profile.models.length,
    };
}

function writeJsonAtomic(filePath, value) {
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, filePath);
}

function writeTextAtomic(filePath, value) {
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, String(value), "utf8");
    renameSync(temporaryPath, filePath);
}

async function refreshAntigravityModels(options = {}) {
    if (!isAntigravityUpstreamMode(UPSTREAM_MODE)) {
        const error = new Error("Antigravity model refresh is only available in Antigravity mode.");
        error.statusCode = 404;
        throw error;
    }
    const payload = await (options.fetchModels || fetchAvailableAgentModels)({
        timeoutMs: options.timeoutMs ?? ANTIGRAVITY_READINESS_TIMEOUT_MS,
    });
    const refresh = buildAntigravityModelRefresh(payload, options.baseCatalog ?? loadAntigravityCatalog());
    PROFILE = refresh.profile;
    writeJsonAtomic(options.catalogPath ?? ANTIGRAVITY_MODEL_CATALOG_PATH, refresh.catalog);
    try {
        await ANTIGRAVITY_READINESS?.check();
    } catch {}
    return {
        ok: true,
        object: "antigravity.model_refresh",
        modelCount: refresh.modelCount,
        models: refresh.models,
        defaultModel: refresh.defaultModel,
        fastModel: refresh.fastModel,
    };
}

function providerModelRefreshSnapshot(profile = activeUpstreamProfile()) {
    const model = profile.model || PROFILE?.defaultModel || UPSTREAM_MODEL || "";
    const seen = new Set();
    const models = [];
    const addModel = (value) => {
        const id = String(value || "").trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        models.push(id);
    };
    addModel(model);
    for (const candidate of [
        ...(Array.isArray(profile.models) ? profile.models : []),
        ...(Array.isArray(profile.capabilities?.providerModels) ? profile.capabilities.providerModels : []),
    ]) {
        addModel(candidate);
    }
    return {
        ok: true,
        object: "anticodex.provider_model_refresh",
        skipped: true,
        mode: "third-party",
        provider: profile.provider || profile.protocol || "third-party",
        protocol: profile.protocol || UPSTREAM_PROTOCOL || "",
        modelCount: models.length,
        models,
        defaultModel: model,
        fastModel: profile.fastModel || models.find((item) => item !== model) || model,
        message: "Third-party mode uses the configured provider model; no Antigravity model refresh was attempted.",
    };
}

async function refreshModelsForActiveUpstream(options = {}) {
    if (!isAntigravityUpstreamMode(UPSTREAM_MODE)) {
        return providerModelRefreshSnapshot(options.profile || activeUpstreamProfile());
    }
    return refreshAntigravityModels(options);
}

function jsonResponse(res, status, body) {
    res.writeHead(status, localCorsHeaders({ "content-type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify(body));
}

function htmlResponse(res, status, html) {
    res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(html);
}

function javascriptResponse(res, status, text) {
    res.writeHead(status, localCorsHeaders({
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
    }));
    res.end(text);
}

const MANAGER_ACTIONS = Object.freeze({
    accountSwitch: {
        label: "\u5207\u6362 Antigravity \u8d26\u53f7",
        script: "open-antigravity-account-switch.ps1",
        args: [],
        timeoutMs: 60_000,
    },
    accountProxy: {
        label: "账号/代理检查",
        script: "test-anticodex-account-proxy-readiness.ps1",
        args: ["-AllowUnready"],
        timeoutMs: 120_000,
    },
    syncReadiness: {
        label: "安装/同步检查",
        script: "test-anticodex-sync-readiness.ps1",
        args: ["-Fast", "-SkipAccountProxyProbe"],
        timeoutMs: 30_000,
    },
    repairShortcuts: {
        label: "修复快捷方式",
        script: "repair-anticodex-shortcuts.ps1",
        args: [],
        timeoutMs: 30_000,
    },
    updateCheck: {
        label: "检查 Codex 更新",
        script: "check-anticodex-update.ps1",
        args: [],
        timeoutMs: 30_000,
    },
    sourcePreflight: {
        label: "\u8fd0\u884c\u6e90\u7801\u9884\u68c0",
        script: "test-anticodex-source-preflight.ps1",
        args: ["-SkipFullRegression"],
        timeoutMs: 90_000,
    },
    upstreamConfig: {
        label: "配置第三方 API",
        virtual: true,
    },
    resetAntigravitySessionLock: {
        label: "\u91cd\u7f6e Antigravity \u4f1a\u8bdd\u9501",
        virtual: true,
    },
    syncHost: {
        label: "同步 Codex 更新",
        script: "sync-anticodex-launcher.ps1",
        args: [],
        timeoutMs: 10_000,
        background: true,
        singletonProcessPattern: "(sync-anticodex-launcher|sync-anticodex)\\.ps1",
        backgroundLockMaxMs: 30 * 60_000,
    },
    mcpSkills: {
        label: "检查 MCP/Skill",
        script: "test-anticodex-mcp-skills.ps1",
        args: [],
        timeoutMs: 120_000,
    },
    pluginCapabilities: {
        label: "检查插件/应用",
        script: "test-anticodex-plugin-capabilities.ps1",
        args: [],
        timeoutMs: 120_000,
    },
    refreshFeatures: {
        label: "刷新本地功能",
        script: "refresh-anticodex-local-features.ps1",
        args: [],
        timeoutMs: 10_000,
        background: true,
        singletonProcessPattern: "refresh-anticodex-local-features\\.ps1",
        backgroundLockMaxMs: 10 * 60_000,
    },
    stabilitySoak: {
        label: "\u7a33\u5b9a\u6027\u5de1\u68c0\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09",
        script: "test-anticodex-stability-soak.ps1",
        args: [],
        timeoutMs: 10_000,
        background: true,
        singletonProcessPattern: "test-anticodex-stability-soak\\.ps1",
        backgroundLockMaxMs: 20 * 60_000,
    },
    fastOverallNoTraffic: {
        label: "快速检查（不耗流量）",
        script: "test-anticodex-installed-overall.ps1",
        args: ["-EnsureRunning", "-NoTraffic", "-SkipAccountProxyProbe", "-Fast", "-SkipManagerActionProbe", "-SubcheckTimeoutSec", "30", "-FastMaxElapsedMs", "90000", "-IncludePostVerification", "false"],
        timeoutMs: 90_000,
    },
    overallNoTraffic: {
        label: "整体检查（不耗流量）",
        script: "test-anticodex-installed-overall.ps1",
        args: ["-EnsureRunning", "-NoTraffic", "-SkipAccountProxyProbe", "-SkipManagerActionProbe", "-SkipUiStateProbe"],
        timeoutMs: 240_000,
    },
    diagnosticsBundle: {
        label: "生成诊断包",
        script: "collect-anticodex-diagnostics.ps1",
        args: ["-NoPopup"],
        timeoutMs: 120_000,
    },
    viewLatestReports: {
        label: "查看最新报告",
        virtual: true,
    },
    postVerificationFull: {
        label: "验证后完整检查（耗真实流量）",
        script: "test-anticodex-post-verification.ps1",
        args: ["-OpenAntigravityOnVerification"],
        timeoutMs: 10_000,
        background: true,
        singletonProcessPattern: "test-anticodex-post-verification\\.ps1",
        backgroundLockMaxMs: 20 * 60_000,
    },
});

const CLEAN_MANAGER_ACTION_LABELS = Object.freeze({
    accountSwitch: "\u5207\u6362 Antigravity \u8d26\u53f7",
    accountProxy: "账号/代理检查",
    syncReadiness: "安装/同步检查",
    updateCheck: "检查 Codex 更新",
    sourcePreflight: "运行源码预检",
    syncHost: "同步 Codex 更新",
    mcpSkills: "检查 MCP/Skill",
    pluginCapabilities: "检查插件/应用",
    refreshFeatures: "刷新本地功能",
    stabilitySoak: "\u7a33\u5b9a\u6027\u5de1\u68c0\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09",
    fastOverallNoTraffic: "快速检查（不耗流量）",
    overallNoTraffic: "整体检查（不耗流量）",
    diagnosticsBundle: "生成诊断包",
    viewLatestReports: "查看最新报告",
    postVerificationFull: "验证后完整检查（耗真实流量）",
});

function managerActionLabel(actionName, action = MANAGER_ACTIONS[actionName]) {
    return CLEAN_MANAGER_ACTION_LABELS[actionName] || action?.label || actionName;
}

function powershellPath() {
    const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
    return resolvePath(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function parseJsonFromScriptOutput(text = "") {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch {}
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
    }
    return null;
}

function latestManagerReportItem(label, fileName) {
    const fullPath = ANTICODEX_STATE_ROOT ? resolvePath(ANTICODEX_STATE_ROOT, "reports", fileName) : "";
    const read = fullPath ? readJsonReportIfPresent(fullPath) : { exists: false, parseable: false, value: null, error: "" };
    const integrity = fullPath ? reportIntegrityForPath(fullPath) : { signed: false, valid: null, hash: "", expected: "", sidecar: "", error: "" };
    const report = read.value;
    const integrityInvalid = read.exists && integrity.signed && integrity.valid === false;
    const invalid = (read.exists && read.parseable === false) || integrityInvalid;
    const failures = Array.isArray(report?.failures) ? report.failures.filter(Boolean) : [];
    const checks = report?.checks && typeof report.checks === "object" ? report.checks : {};
    const publicDocumentation = checks.publicDocumentation && typeof checks.publicDocumentation === "object" ? checks.publicDocumentation : null;
    const endpointEvidence = report?.endpointEvidence && typeof report.endpointEvidence === "object" ? report.endpointEvidence : null;
    const capabilities = report?.capabilities && typeof report.capabilities === "object" ? report.capabilities : null;
    const connectorParity = capabilities?.connectorParity && typeof capabilities.connectorParity === "object" ? capabilities.connectorParity : null;
    const appToolParity = capabilities?.appToolParity && typeof capabilities.appToolParity === "object" ? capabilities.appToolParity : null;
    const appToolGetPostParity = capabilities?.appToolGetPostParity && typeof capabilities.appToolGetPostParity === "object" ? capabilities.appToolGetPostParity : null;
    const mcp = report?.mcp && typeof report.mcp === "object" ? report.mcp : null;
    const skills = report?.skills && typeof report.skills === "object" ? report.skills : null;
    const realAntigravityEvidence = report?.realAntigravityEvidence && typeof report.realAntigravityEvidence === "object" ? report.realAntigravityEvidence : null;
    const toolBridge = report?.toolBridge && typeof report.toolBridge === "object" ? report.toolBridge : null;
    const compatibilityTools = report?.compatibilityTools && typeof report.compatibilityTools === "object" ? report.compatibilityTools : null;
    const nativeToolCapability = report?.nativeToolCapability && typeof report.nativeToolCapability === "object" ? report.nativeToolCapability : null;
    const modelRoutingResults = Array.isArray(report?.results) ? report.results : [];
    const thinkingModels = Array.isArray(report?.models) && (typeof report?.expectedModelCount !== "undefined" || typeof report?.actualModelCount !== "undefined") ? report.models : [];
    const uiIdleSamples = Array.isArray(report?.samples) ? report.samples : [];
    const sync = report?.sync && typeof report.sync === "object" ? report.sync : null;
    const activeHost = report?.activeHost && typeof report.activeHost === "object" ? report.activeHost : null;
    const shortcutVerification = Array.isArray(sync?.shortcutVerification) ? sync.shortcutVerification : [];
    const managerBridge = sync?.managerBridge && typeof sync.managerBridge === "object" ? sync.managerBridge : null;
    const updateStatus = sync?.updateStatus && typeof sync.updateStatus === "object" ? sync.updateStatus : null;
    const updateGuardrails = updateStatus?.guardrails && typeof updateStatus.guardrails === "object" ? updateStatus.guardrails : null;
    const releaseGateFailures = Array.isArray(report?.gates)
        ? report.gates
            .filter((gate) => {
                const semanticFailures = Array.isArray(gate?.semanticFailures) ? gate.semanticFailures : [];
                return gate
                    && gate.satisfied !== true
                    && (gate.requiredForRelease === true || gate.requiredForShort === true || semanticFailures.length > 0 || (gate.present === true && (gate.error || gate.okField === false)));
            })
            .map((gate) => ({
                id: shortSafeText(gate.id, ""),
                group: shortSafeText(gate.group, ""),
                error: shortSafeText(gate.error, ""),
                semanticFailures: Array.isArray(gate.semanticFailures)
                    ? gate.semanticFailures.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 8)
                    : [],
            }))
            .slice(0, 12)
        : [];
    const multiTurnHistory = report?.multiTurnHistory && typeof report.multiTurnHistory === "object" ? report.multiTurnHistory : null;
    const toolHistory = multiTurnHistory?.toolHistory && typeof multiTurnHistory.toolHistory === "object" ? multiTurnHistory.toolHistory : null;
    let updatedAt = "";
    if (fullPath && existsSync(fullPath)) {
        try { updatedAt = statSync(fullPath).mtime.toISOString(); } catch {}
    }
    const ageMs = updatedAt ? Math.max(0, Date.now() - Date.parse(updatedAt)) : null;
    const stale = Number.isFinite(ageMs) && ageMs > MANAGER_REPORT_STALE_MS;
    return {
        label,
        fileName,
        exists: read.exists,
        parseable: read.parseable,
        invalid,
        integrity,
        ok: !invalid && report?.ok === true,
        skipped: typeof report?.skipped === "boolean" ? report.skipped : null,
        reason: shortSafeText(report?.reason || "", ""),
        behaviorCovered: typeof report?.behaviorCovered === "boolean" ? report.behaviorCovered : null,
        coverageKind: shortSafeText(report?.coverageKind || "", ""),
        usedRealTraffic: typeof report?.usedRealTraffic === "boolean" ? report.usedRealTraffic : null,
        requestedRealTraffic: typeof report?.requestedRealTraffic === "boolean" ? report.requestedRealTraffic : null,
        state: invalid ? (integrityInvalid ? "invalid_report_integrity" : "invalid_report") : shortSafeText(report?.state || report?.diagnosis || "", ""),
        missingReason: read.exists ? "" : "not_generated",
        parseError: invalid ? shortSafeText(integrityInvalid ? integrity.error : read.error, "report validation failed") : "",
        parseErrorType: invalid ? (integrityInvalid ? "integrity_hash" : "json_parse") : "",
        elapsedMs: Number.isFinite(Number(report?.elapsedMs)) ? Number(report.elapsedMs) : null,
        failureCount: invalid ? 1 : failures.length,
        firstFailure: invalid ? shortSafeText(integrityInvalid ? `report hash validation failed: ${integrity.error}` : `report parse failed: ${read.error}`, "report validation failed") : shortSafeText(failures[0] || "", ""),
        releaseReady: typeof report?.releaseReady === "boolean" ? report.releaseReady : null,
        shortReady: typeof report?.shortReady === "boolean" ? report.shortReady : null,
        missingRequired: Array.isArray(report?.missingRequired) ? report.missingRequired.map((item) => shortSafeText(item, "")).filter(Boolean) : [],
        missingShort: Array.isArray(report?.missingShort) ? report.missingShort.map((item) => shortSafeText(item, "")).filter(Boolean) : [],
        damagedReports: Array.isArray(report?.damagedReports) ? report.damagedReports.map((item) => shortSafeText(item, "")).filter(Boolean) : [],
        releaseGateFailures,
        latestPath: shortSafeText(report?.report?.latest || fullPath, ""),
        historyPath: shortSafeText(report?.report?.history || "", ""),
        modelThinkingEvidence: (typeof report?.expectedModelCount !== "undefined" || typeof report?.actualModelCount !== "undefined") ? {
            expectedModelCount: Number.isFinite(Number(report?.expectedModelCount)) ? Number(report.expectedModelCount) : null,
            actualModelCount: Number.isFinite(Number(report?.actualModelCount)) ? Number(report.actualModelCount) : null,
            modelCount: thinkingModels.length,
            supportsThinkingCount: thinkingModels.filter((item) => item?.supports_thinking === true).length,
            missingBudgetCount: thinkingModels.filter((item) => !Number.isFinite(Number(item?.thinking_budget)) || !Number.isFinite(Number(item?.min_thinking_budget)) || Number(item.thinking_budget) < Number(item.min_thinking_budget)).length,
            missingReasoningLevelCount: thinkingModels.filter((item) => !item?.reasoning_level).length,
            reasoningLevels: Array.from(new Set(thinkingModels.map((item) => item?.reasoning_level).filter(Boolean).map(String))).sort().slice(0, 8),
        } : null,
        uiIdleEvidence: (typeof report?.sampleCount !== "undefined" || uiIdleSamples.length) ? {
            durationSec: Number.isFinite(Number(report?.durationSec)) ? Number(report.durationSec) : null,
            intervalSec: Number.isFinite(Number(report?.intervalSec)) ? Number(report.intervalSec) : null,
            sampleCount: Number.isFinite(Number(report?.sampleCount)) ? Number(report.sampleCount) : uiIdleSamples.length,
            sampleEntryCount: uiIdleSamples.length,
            healthySampleCount: uiIdleSamples.filter((item) => item?.healthOk === true && item?.accountReady === true && item?.uiOk === true).length,
            reconnectTextCount: uiIdleSamples.filter((item) => item?.hasReconnectText === true).length,
            loginTextCount: uiIdleSamples.filter((item) => item?.hasLoginText === true).length,
            missingModelTextCount: uiIdleSamples.filter((item) => !item?.matchedModelText).length,
        } : null,
        syncReadinessEvidence: (sync || activeHost) ? {
            noTrafficReady: report?.reportName === "sync-readiness" && report?.noTraffic === true && report?.usedRealTraffic === false && report?.behaviorCovered === true && report?.coverageKind === "installed-no-traffic",
            fullMode: report?.fast === false && report?.skipIconPaletteProbe === false,
            activeHostReady: !!activeHost && activeHost.exists === true && activeHost.markerExists === true && activeHost.manifestValid === true && activeHost.exeExists === true,
            brandReady: activeHost?.productName === "Anti-Codex" && activeHost?.fileDescription === "Anti-Codex" && activeHost?.originalFilename === "Anti-Codex.exe",
            iconReady: activeHost?.hostIconExists === true && activeHost?.trayIconExists === true && activeHost?.appRootIconExists === true && activeHost?.hostIconPalette?.ok === true && activeHost?.trayIconPalette?.ok === true && activeHost?.appRootIconPalette?.ok === true && (!sync?.desktopShortcutIconPalette || sync.desktopShortcutIconPalette.ok === true),
            syncScriptsReady: !!sync && sync.scriptExists === true && sync.launcherExists === true && sync.rollbackScriptExists === true && sync.rollbackLauncherExists === true && sync.updateCheckExists === true && sync.validatorExists === true && sync.failureSafetyVerifierExists === true && sync.installerExists === true && sync.startScriptExists === true,
            updateReady: updateStatus?.ok === true && updateStatus?.updateNeeded === false && updateStatus?.drift?.state === "synced",
            guardrailsReady: updateGuardrails?.brandPreserved === true && updateGuardrails?.iconPreserved === true && updateGuardrails?.activeHostValid === true && Array.isArray(updateGuardrails?.failures) && updateGuardrails.failures.length === 0,
            shortcutCount: shortcutVerification.length,
            shortcutReadyCount: shortcutVerification.filter((item) => item?.ok === true && item?.exists === true && item?.displayNameMatches === true && item?.targetMatches === true && item?.launcherTargetMatches === true && item?.scriptMatches === true && item?.iconMatches === true && item?.forbiddenCodexBranding !== true).length,
            desktopShortcutCount: Array.isArray(sync?.desktopAntiCodexShortcuts) ? sync.desktopAntiCodexShortcuts.length : null,
            forbiddenDesktopHelperCount: Array.isArray(sync?.forbiddenDesktopHelperShortcuts) ? sync.forbiddenDesktopHelperShortcuts.length : null,
            managerBridgeReady: !!managerBridge && Number(managerBridge.processCount) === 1 && Number(managerBridge.staleProcessCount) === 0 && Array.isArray(managerBridge.processes) && managerBridge.processes.every((item) => item?.hasExpectedBaseUrl === true),
            cleanSyncState: sync?.hostSyncMarkerExists === false && sync?.staleCandidateExists === false && sync?.rollbackHostExists === true && sync?.rollbackMarkerExists === true,
        } : null,
        publicDocumentationOk: fileName === "latest-source-preflight.json" && !invalid && publicDocumentation ? publicDocumentation.ok === true : null,
        sourcePreflightEvidence: fileName === "latest-source-preflight.json" && !invalid && checks ? {
            javascriptSyntaxOk: checks.javascriptSyntax?.ok === true,
            powershellSyntaxOk: checks.powershellSyntax?.ok === true,
            uiStateSelfTestOk: checks.uiStateSelfTest?.ok === true,
            upstreamProfileStorageOk: checks.upstreamProfileStorage?.ok === true,
            publicDocumentationOk: checks.publicDocumentation?.ok === true,
            translatorRegressionOk: checks.translatorRegression?.ok === true,
            diffWhitespaceOk: checks.diffWhitespace?.ok === true,
            skipFullRegression: report?.skipFullRegression === true,
        } : null,
        publicDocumentationFailureCount: fileName === "latest-source-preflight.json" && !invalid && publicDocumentation && Array.isArray(publicDocumentation.failed) ? publicDocumentation.failed.length : null,
        localConnectorEvidence: endpointEvidence ? {
            chatgptInstallUrlsScrubbed: endpointEvidence.chatgptInstallUrlsScrubbed === true,
            linkEndpointsUnsupported: endpointEvidence.linkEndpointsUnsupported === true,
            allowlistedConnectorAccessible: endpointEvidence.allowlistedConnectorAccessible === true,
            allowlistedConnectorLocallyAllowlisted: endpointEvidence.allowlistedConnectorLocallyAllowlisted === true,
            upstreamRequestsDuringLocalEndpoints: Number.isFinite(Number(endpointEvidence.upstreamRequestsDuringLocalEndpoints)) ? Number(endpointEvidence.upstreamRequestsDuringLocalEndpoints) : null,
            hiddenConnectorAccessible: endpointEvidence.hiddenConnectorAccessible === true,
            exposedToolNames: Array.isArray(endpointEvidence.exposedToolNames) ? endpointEvidence.exposedToolNames.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 8) : [],
        } : null,
        modelRoutingEvidence: (typeof report?.skipRequests === "boolean" || modelRoutingResults.length) ? {
            mode: shortSafeText(report?.mode || "", ""),
            providerProtocol: shortSafeText(report?.providerProtocol || "", ""),
            providerModel: shortSafeText(report?.providerModel || "", ""),
            toolBridgeMode: shortSafeText(report?.toolBridge?.mode || "", ""),
            resultCount: modelRoutingResults.length,
            skippedRequestCount: modelRoutingResults.filter((item) => item?.skippedRequest === true).length,
            failedResultCount: modelRoutingResults.filter((item) => item?.ok !== true).length,
            resultErrorCount: modelRoutingResults.filter((item) => item?.error).length,
        } : null,
        toolBridgeEvidence: (toolBridge || compatibilityTools || nativeToolCapability) ? {
            mode: shortSafeText(toolBridge?.mode || "", ""),
            transport: shortSafeText(toolBridge?.transport || "", ""),
            localAdapter: shortSafeText(toolBridge?.localAdapter || "", ""),
            nativeAntigravityToolEvents: toolBridge?.nativeAntigravityToolEvents === true,
            nativeMcpDiscoveryVerified: toolBridge?.nativeMcpDiscoveryVerified === true,
            nativeBridgeDefaultEnabled: toolBridge?.nativeBridgeDefaultEnabled === true,
            acceptsExternalToolDefinitions: toolBridge?.acceptsExternalToolDefinitions === true,
            compatibilityBridge: shortSafeText(compatibilityTools?.bridge || "", ""),
            nativeMcpApprovalProtocolVerified: nativeToolCapability?.nativeMcpApprovalProtocolVerified === true,
            nativeMcpPermissionMode: shortSafeText(nativeToolCapability?.nativeMcpPermissionMode || "", ""),
            sameCascadeResumeProbeVerified: nativeToolCapability?.sameCascadeResumeProbeVerified === true,
            antigravityOwnedToolsDisabled: nativeToolCapability?.antigravityOwnedToolsDisabled === true,
            permissionPromptsDisabled: nativeToolCapability?.permissionPromptsDisabled === true,
            disabledToolCount: Number.isFinite(Number(nativeToolCapability?.disabledToolCount)) ? Number(nativeToolCapability.disabledToolCount) : null,
            codexToolBridge: shortSafeText(nativeToolCapability?.codexToolBridge || "", ""),
        } : null,
        mcpSkillEvidence: (mcp || skills) ? {
            mcpCount: Number.isFinite(Number(mcp?.count)) ? Number(mcp.count) : null,
            mcpSharedCount: Number.isFinite(Number(mcp?.sharedCount)) ? Number(mcp.sharedCount) : null,
            mcpMissingSharedCount: Array.isArray(mcp?.missingShared) ? mcp.missingShared.length : null,
            mcpExtraLocalCount: Array.isArray(mcp?.extraLocal) ? mcp.extraLocal.length : null,
            hasNodeRepl: mcp?.hasNodeRepl === true,
            mcpSmokePassed: mcp?.smoke?.passed === true,
            mcpRealCallPassed: mcp?.smoke?.realCall?.passed === true,
            skillCount: Number.isFinite(Number(skills?.count)) ? Number(skills.count) : null,
            skillSharedCount: Number.isFinite(Number(skills?.sharedCount)) ? Number(skills.sharedCount) : null,
            agentsSkillCount: Number.isFinite(Number(skills?.agentsCount)) ? Number(skills.agentsCount) : null,
            expectedSharedSkillCount: Number.isFinite(Number(skills?.expectedSharedCount)) ? Number(skills.expectedSharedCount) : null,
            missingSharedSkillCount: Array.isArray(skills?.missingShared) ? skills.missingShared.length : null,
            extraLocalSkillCount: Array.isArray(skills?.extraLocal) ? skills.extraLocal.length : null,
            skillSmokeReadable: skills?.smoke?.readable === true,
        } : null,
        optionalRealProviderEvidence: (typeof report?.firstMarkerObserved === "boolean" || typeof report?.secondMarkerObserved === "boolean" || typeof report?.historyContinuationObserved === "boolean") ? {
            firstMarkerObserved: report.firstMarkerObserved === true,
            secondMarkerObserved: report.secondMarkerObserved === true,
            historyContinuationObserved: report.historyContinuationObserved === true,
            secretsRedacted: report.secretsRedacted === true,
            turns: Number.isFinite(Number(report.turns)) ? Number(report.turns) : null,
        } : null,
        antigravityReturnEvidence: realAntigravityEvidence ? {
            requested: realAntigravityEvidence.requested === true,
            realAntigravityTurnUsed: realAntigravityEvidence.realAntigravityTurnUsed === true,
            returnedToAntigravityWithHistory: realAntigravityEvidence.returnedToAntigravityWithHistory === true,
            previousResponseIdMatched: realAntigravityEvidence.previousResponseIdMatched === true,
            markerCount: Number.isFinite(Number(realAntigravityEvidence.markerCount)) ? Number(realAntigravityEvidence.markerCount) : null,
            missingMarkerCount: Number.isFinite(Number(realAntigravityEvidence.missingMarkerCount)) ? Number(realAntigravityEvidence.missingMarkerCount) : null,
            routeTransport: shortSafeText(realAntigravityEvidence.routeTransport || "", ""),
            resolvedModel: shortSafeText(realAntigravityEvidence.resolvedModel || "", ""),
        } : null,
        pluginCapabilityEvidence: capabilities ? {
            nativeCodexWriteback: capabilities.nativeCodexWriteback === true,
            accessibleConnectorCount: Number.isFinite(Number(capabilities.accessibleConnectorCount)) ? Number(capabilities.accessibleConnectorCount) : null,
            appToolCount: Number.isFinite(Number(capabilities.appToolCount)) ? Number(capabilities.appToolCount) : null,
            appToolGetCount: Number.isFinite(Number(capabilities.appToolGetCount)) ? Number(capabilities.appToolGetCount) : null,
            unattributedAppToolCount: Number.isFinite(Number(capabilities.unattributedAppToolCount)) ? Number(capabilities.unattributedAppToolCount) : null,
            unauthorizedAppToolCount: Number.isFinite(Number(capabilities.unauthorizedAppToolCount)) ? Number(capabilities.unauthorizedAppToolCount) : null,
            connectorParityClean: connectorParity && Array.isArray(connectorParity.missingShared) ? connectorParity.missingShared.length === 0 : null,
            connectorParityMissingSharedCount: Array.isArray(connectorParity?.missingShared) ? connectorParity.missingShared.length : null,
            connectorParityMissingSharedSample: Array.isArray(connectorParity?.missingShared) ? connectorParity.missingShared.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 5) : [],
            connectorParityExtraLocalCount: Array.isArray(connectorParity?.extraLocal) ? connectorParity.extraLocal.length : null,
            connectorParityExtraLocalSample: Array.isArray(connectorParity?.extraLocal) ? connectorParity.extraLocal.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 5) : [],
            appToolParityClean: appToolParity && Array.isArray(appToolParity.missingShared) ? appToolParity.missingShared.length === 0 : null,
            appToolParityMissingSharedCount: Array.isArray(appToolParity?.missingShared) ? appToolParity.missingShared.length : null,
            appToolParityMissingSharedSample: Array.isArray(appToolParity?.missingShared) ? appToolParity.missingShared.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 5) : [],
            appToolParityExtraLocalCount: Array.isArray(appToolParity?.extraLocal) ? appToolParity.extraLocal.length : null,
            appToolParityExtraLocalSample: Array.isArray(appToolParity?.extraLocal) ? appToolParity.extraLocal.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 5) : [],
            appToolGetPostParityClean: appToolGetPostParity && Array.isArray(appToolGetPostParity.missingFromGet) && Array.isArray(appToolGetPostParity.extraFromGet)
                ? appToolGetPostParity.missingFromGet.length === 0 && appToolGetPostParity.extraFromGet.length === 0
                : null,
            appToolGetPostMissingFromGetCount: Array.isArray(appToolGetPostParity?.missingFromGet) ? appToolGetPostParity.missingFromGet.length : null,
            appToolGetPostMissingFromGetSample: Array.isArray(appToolGetPostParity?.missingFromGet) ? appToolGetPostParity.missingFromGet.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 5) : [],
            appToolGetPostExtraFromGetCount: Array.isArray(appToolGetPostParity?.extraFromGet) ? appToolGetPostParity.extraFromGet.length : null,
            appToolGetPostExtraFromGetSample: Array.isArray(appToolGetPostParity?.extraFromGet) ? appToolGetPostParity.extraFromGet.map((item) => shortSafeText(item, "")).filter(Boolean).slice(0, 5) : [],
        } : null,
        providerContinuity: multiTurnHistory ? {
            turns: Number.isFinite(Number(multiTurnHistory.turns)) ? Number(multiTurnHistory.turns) : null,
            providerModelUsedForEveryTurn: multiTurnHistory.providerModelUsedForEveryTurn === true,
            providerSwitchPreservesOpenAiToolPair: toolHistory?.providerSwitchPreservesOpenAiToolPair === true,
            protocolSwitchPreservesAnthropicToolPair: toolHistory?.protocolSwitchPreservesAnthropicToolPair === true,
            reverseProtocolSwitchPreservesOpenAiToolPair: toolHistory?.reverseProtocolSwitchPreservesOpenAiToolPair === true,
            seventhMarkerCount: Number.isFinite(Number(multiTurnHistory.seventhAfterProviderSwitchAllHistoryMarkerCount)) ? Number(multiTurnHistory.seventhAfterProviderSwitchAllHistoryMarkerCount) : null,
            eighthMarkerCount: Number.isFinite(Number(multiTurnHistory.eighthAfterProtocolSwitchAllHistoryMarkerCount)) ? Number(multiTurnHistory.eighthAfterProtocolSwitchAllHistoryMarkerCount) : null,
            ninthMarkerCount: Number.isFinite(Number(multiTurnHistory.ninthAfterReverseProtocolSwitchAllHistoryMarkerCount)) ? Number(multiTurnHistory.ninthAfterReverseProtocolSwitchAllHistoryMarkerCount) : null,
        } : null,
        updatedAt,
        ageMs,
        stale,
        staleAfterMs: MANAGER_REPORT_STALE_MS,
    };
}

function latestManagerReportsPayload() {
    const reports = [
        latestManagerReportItem("快速检查", "latest-installed-overall-fast.json"),
        latestManagerReportItem("整体检查", "latest-installed-overall.json"),
        latestManagerReportItem("验证后完整检查", "latest-post-verification.json"),
        latestManagerReportItem("普通聊天流式", "latest-codex-responses.json"),
        latestManagerReportItem("真实工作任务", "latest-real-work.json"),
        latestManagerReportItem("真实小工具任务", "latest-real-mini-tool.json"),
        latestManagerReportItem("原生工具链", "latest-native-tool-loop.json"),
        latestManagerReportItem("兼容工具链", "latest-tool-loop.json"),
        latestManagerReportItem("MCP 工具链", "latest-mcp-tool-loop.json"),
        latestManagerReportItem("MCP/Skill 检查", "latest-mcp-skills.json"),
        latestManagerReportItem("插件/应用检查", "latest-plugin-capabilities.json"),
        latestManagerReportItem("本地连接器检查", "latest-local-connectors.json"),
        latestManagerReportItem("安装/同步检查", "latest-sync-readiness.json"),
        latestManagerReportItem("模型路由检查", "latest-model-routing.json"),
        latestManagerReportItem("第三方连续性", "latest-third-party-provider.json"),
        latestManagerReportItem("Release Gate 汇总", "latest-release-gates.json"),
        latestManagerReportItem("冷启动恢复", "latest-cold-relaunch.json"),
        latestManagerReportItem("Manager 真实按钮", "latest-manager-real-buttons.json"),
        latestManagerReportItem("本地功能刷新", "latest-refresh-features.json"),
        latestManagerReportItem("压缩恢复", "latest-compaction-resume.json"),
        latestManagerReportItem("稳定性巡检", "latest-stability-soak.json"),
        latestManagerReportItem("源码预检", "latest-source-preflight.json"),
        latestManagerReportItem("账号/代理检查", "latest-account-proxy-readiness.json"),
        latestManagerReportItem("历史过期恢复", "latest-missing-history.json"),
        latestManagerReportItem("可选真实第三方", "latest-real-third-party-provider.json"),
        latestManagerReportItem("可选回切 Antigravity", "latest-provider-antigravity-return.json"),
    ];
    return {
        ok: true,
        reportRoot: ANTICODEX_STATE_ROOT ? resolvePath(ANTICODEX_STATE_ROOT, "reports") : "",
        reports,
        existingCount: reports.filter((item) => item.exists).length,
        missingCount: reports.filter((item) => !item.exists).length,
        invalidCount: reports.filter((item) => item.invalid || (item.exists && item.parseable === false)).length,
        staleCount: reports.filter((item) => item.exists && item.stale).length,
        staleAfterMs: MANAGER_REPORT_STALE_MS,
    };
}

function psSingleQuoted(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function psArgument(value) {
    const text = String(value);
    if (/^-[A-Za-z][A-Za-z0-9]*$/.test(text)) return text;
    return psSingleQuoted(text);
}

function managerScriptPath(action) {
    const scriptPath = resolvePath(MANAGER_SCRIPTS_ROOT, action.script);
    const relative = relativePath(MANAGER_SCRIPTS_ROOT, scriptPath);
    if (relative.startsWith("..") || isAbsolute(relative) || !existsSync(scriptPath)) {
        const error = new Error(`Missing Anti-Codex manager script: ${action.script}`);
        error.statusCode = 500;
        throw error;
    }
    return scriptPath;
}

function isTrustedManagerOriginValue(value, hostHeader = "") {
    if (!value) return false;
    if (String(value).toLowerCase() === "null") return false;
    try {
        const parsed = new URL(String(value));
        if (parsed.protocol === "app:") return true;
        const requestHost = String(hostHeader || `${HOST}:${PORT}`).toLowerCase();
        const originHost = parsed.host.toLowerCase();
        const localHosts = new Set([
            requestHost,
            `${HOST}:${PORT}`.toLowerCase(),
            `${LISTEN_HOST}:${PORT}`.toLowerCase(),
            `127.0.0.1:${PORT}`,
            `localhost:${PORT}`,
            `[::1]:${PORT}`,
        ]);
        return parsed.protocol === "http:" && localHosts.has(originHost);
    } catch {
        return false;
    }
}

function validateManagerSourceRequest(req, subject = "manager") {
    const hasOrigin = Boolean(req.headers.origin);
    const hasReferer = Boolean(req.headers.referer);
    if (!hasOrigin && !hasReferer) {
        return { ok: false, status: 403, message: `Anti-Codex ${subject} source is not trusted.` };
    }
    if (hasOrigin && !isTrustedManagerOriginValue(req.headers.origin, req.headers.host)) {
        return { ok: false, status: 403, message: `Anti-Codex ${subject} origin is not trusted.` };
    }
    if (hasReferer && !isTrustedManagerOriginValue(req.headers.referer, req.headers.host)) {
        return { ok: false, status: 403, message: `Anti-Codex ${subject} referrer is not trusted.` };
    }
    return { ok: true };
}

function validateManagerActionRequest(req) {
    const token = String(req.headers["x-anticodex-manager-token"] || "");
    if (token !== MANAGER_ACTION_TOKEN) {
        return { ok: false, status: 403, message: "Anti-Codex manager action token is missing or invalid." };
    }
    return validateManagerSourceRequest(req, "manager action");
}

function managerBootstrapPayload() {
    return {
        ok: true,
        token: MANAGER_ACTION_TOKEN,
        baseUrl: `http://${HOST}:${PORT}`,
        actions: Object.fromEntries(Object.entries(MANAGER_ACTIONS).map(([key, value]) => [key, {
            label: managerActionLabel(key, value),
            background: Boolean(value.background),
        }])),
    };
}

function visibleModelPayload(catalogOverride = undefined, profileOverride = PROFILE) {
    const models = profileOverride?.models || ["deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.5", "gpt-5.4-mini"];
    const catalog = catalogOverride === undefined ? loadAntigravityCatalog() : catalogOverride;
    const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
    const catalogById = new Map(catalogModels.map((model) => [String(model?.slug || ""), model]));
    return {
        object: "list",
        data: models.map((id) => {
            const model = catalogById.get(String(id));
            const displayName = String(model?.display_name || "");
            const thinkingBudget = Number(model?.antigravity_thinking_budget);
            const minThinkingBudget = Number(model?.antigravity_min_thinking_budget);
            return {
                id,
                object: "model",
                created: 1770000000,
                owned_by: "codex-adaptive",
                ...(displayName ? { display_name: displayName } : {}),
                ...(model?.default_reasoning_level ? { reasoning_level: model.default_reasoning_level } : {}),
                ...(typeof model?.antigravity_supports_thinking === "boolean"
                    ? { supports_thinking: model.antigravity_supports_thinking }
                    : {}),
                ...(Number.isFinite(thinkingBudget) ? { thinking_budget: thinkingBudget } : {}),
                ...(Number.isFinite(minThinkingBudget) ? { min_thinking_budget: minThinkingBudget } : {}),
            };
        }),
    };
}

async function managerPanelSnapshotPayload() {
    const whamApps = localBackendApiResponse("GET", "/backend-api/wham/apps") || { tools: [] };
    const pluginsList = localBackendApiResponse("GET", "/backend-api/plugins/list") || { plugins: [] };
    let savedUpstream = {};
    try { savedUpstream = await runUpstreamProfileScript("GetPublic"); } catch {}
    return {
        ok: true,
        baseUrl: `http://${HOST}:${PORT}`,
        responses: {
            "/anticodex/manager/bootstrap": managerBootstrapPayload(),
            "/health": translatorHealthPayload({
                readiness: ANTIGRAVITY_READINESS?.getSnapshot() ?? null,
                circuit: ANTIGRAVITY_FAILURE_CIRCUIT.snapshot(),
            }),
            "/models": visibleModelPayload(),
            "/anticodex/diagnostics": diagnosticsPayload(),
            "/backend-api/ps/plugins/installed": localBackendApiResponse("GET", "/backend-api/ps/plugins/installed"),
            "/backend-api/aip/connectors": localBackendApiResponse("GET", "/backend-api/aip/connectors"),
            "/backend-api/plugins/list": pluginsList,
            "/backend-api/wham/apps": whamApps,
            "/anticodex/local-connectors/allowlist": localConnectorAllowlistPayload(),
            "/anticodex/upstream-profile": {
                ok: true,
                active: isAntigravityUpstreamMode(UPSTREAM_MODE) ? "antigravity" : "third-party",
                runtime: isAntigravityUpstreamMode(UPSTREAM_MODE)
                    ? { mode: "antigravity" }
                    : publicUpstreamProfile(activeUpstreamProfile()),
                saved: savedUpstream,
            },
        },
        errors: {},
    };
}

async function managerActionRunningProcesses(action) {
    if (!action?.singletonProcessPattern) return [];
    const command = [
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        `$pattern = ${psSingleQuoted(action.singletonProcessPattern)}`,
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction SilentlyContinue",
        "| Where-Object { $_.ProcessId -ne $PID -and [string]$_.CommandLine -match $pattern }",
        "| Select-Object -First 5 @{Name='pid';Expression={$_.ProcessId}}, @{Name='commandLine';Expression={$_.CommandLine}}",
        "| ConvertTo-Json -Compress",
    ].join(" ");
    try {
        const { stdout } = await execFileAsync(powershellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
            cwd: MANAGER_SCRIPTS_ROOT,
            timeout: 5_000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        const parsed = parseJsonFromScriptOutput(stdout);
        if (!parsed) return [];
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return [];
    }
}

async function runManagerBridgeAction(actionName) {
    if (actionName === "refreshStatus") {
        return { ok: true, action: actionName, result: { ok: true } };
    }
    if (actionName === "upstreamConfig") {
        return { ok: true, action: actionName, result: { ok: true, virtual: true } };
    }
    if (actionName === "resetAntigravitySessionLock") {
        return { ok: true, action: actionName, result: resetAntigravitySessionLock("manager_action") };
    }
    if (actionName === "viewLatestReports") {
        return { ok: true, action: actionName, result: latestManagerReportsPayload() };
    }
    if (actionName === "refreshModels") {
        if (!isAntigravityUpstreamMode(UPSTREAM_MODE)) {
            const models = visibleModelPayload().data.map((model) => model.id);
            return {
                ok: true,
                action: actionName,
                result: {
                    ok: true,
                    upstream: "third-party",
                    modelCount: models.length,
                    models,
                },
            };
        }
                return { ok: true, action: actionName, result: await refreshModelsForActiveUpstream() };
    }
    return runManagerAction(actionName);
}

function isValidJsonpCallbackName(name) {
    return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(String(name || ""));
}

function managerActionScriptResponse(callbackName, payload) {
    return `;try{globalThis[${JSON.stringify(callbackName)}](${JSON.stringify(payload)});}catch(e){console.error(e);}`;
}

async function runManagerAction(actionName) {
    const action = MANAGER_ACTIONS[actionName];
    if (!action) {
        const error = new Error(`Unknown Anti-Codex manager action: ${actionName}`);
        error.statusCode = 404;
        throw error;
    }
    const label = managerActionLabel(actionName, action);
    const scriptPath = managerScriptPath(action);
    const command = [
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        `& ${psSingleQuoted(scriptPath)} ${action.args.map(psArgument).join(" ")}`,
    ].join("; ");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];
    if (action.background) {
        const lockKey = action.singletonProcessPattern || actionName;
        if (MANAGER_ACTION_LOCKS.has(lockKey)) {
            return {
                ok: true,
                action: actionName,
                label,
                background: true,
                alreadyRunning: true,
                runningPids: [],
                message: `${label} 已经在后台运行。`,
            };
        }
        MANAGER_ACTION_LOCKS.add(lockKey);
        try {
            const running = await managerActionRunningProcesses(action);
            if (running.length > 0) {
                MANAGER_ACTION_LOCKS.delete(lockKey);
                return {
                    ok: true,
                    action: actionName,
                    label,
                    background: true,
                    alreadyRunning: true,
                    runningPids: running.map((item) => Number(item?.pid)).filter(Number.isFinite),
                    message: `${label} 已经在后台运行。`,
                };
            }
            const child = spawn(powershellPath(), args, {
                cwd: MANAGER_SCRIPTS_ROOT,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            const clearLock = () => MANAGER_ACTION_LOCKS.delete(lockKey);
            child.once("exit", clearLock);
            child.once("error", clearLock);
            const lockTimer = setTimeout(clearLock, action.backgroundLockMaxMs || 30 * 60_000);
            lockTimer.unref?.();
            child.unref();
            return {
                ok: true,
                action: actionName,
                label,
                background: true,
                pid: child.pid,
                message: `${label} 已在后台开始。`,
            };
        } catch (error) {
            MANAGER_ACTION_LOCKS.delete(lockKey);
            throw error;
        }
    }
    try {
        const { stdout, stderr } = await execFileAsync(powershellPath(), args, {
            cwd: MANAGER_SCRIPTS_ROOT,
            timeout: action.timeoutMs,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        });
        const parsed = parseJsonFromScriptOutput(stdout);
        const aliases = actionName === "diagnosticsBundle" && parsed && typeof parsed === "object"
            ? { zipPath: parsed.zipPath || "", bundleRoot: parsed.bundleRoot || "" }
            : {};
        return {
            ok: true,
            action: actionName,
            label,
            result: parsed,
            stderr: String(stderr || "").trim(),
            ...aliases,
        };
    } catch (error) {
        return {
            ok: false,
            action: actionName,
            label,
            exitCode: error.code ?? null,
            timedOut: Boolean(error.killed && error.signal === "SIGTERM"),
            message: error.message,
            result: parseJsonFromScriptOutput(error.stdout),
            stderr: String(error.stderr || "").trim(),
        };
    }
}

function anticodexManagerHtml() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anti-Codex 管理</title>
<style>
:root{color-scheme:light dark;--bg:#171717;--surface:#1d1d1d;--raised:#232323;--hover:#2b2b2b;--muted:#9b9b9b;--text:#f3f3f3;--value:#d8d8d8;--pill:#d4d4d4;--line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.14);--hover-line:rgba(255,255,255,.2);--focus:#8c8c8c;--shadow:rgba(0,0,0,.32);--ok-bg:#173a2a;--ok-text:#a9e7c1;--warn-bg:#3d3016;--warn-text:#f0d797;--bad-bg:#432126;--bad-text:#ffc1c8;--danger:#4b2228;--danger-hover:#5b2830;--danger-line:#783740;--danger-hover-line:#914650;--danger-text:#ffd8dd;--danger-section:#21191b;--danger-section-line:rgba(120,55,64,.52)}
@media (prefers-color-scheme:light){:root{--bg:#f7f7f7;--surface:#fff;--raised:#f1f1f1;--hover:#e7e7e7;--muted:#666;--text:#1f1f1f;--value:#333;--pill:#3a3a3a;--line:rgba(0,0,0,.08);--line-strong:rgba(0,0,0,.14);--hover-line:rgba(0,0,0,.2);--focus:#555;--shadow:rgba(0,0,0,.06);--ok-bg:#e2f4e8;--ok-text:#23643d;--warn-bg:#fff4d6;--warn-text:#76520b;--bad-bg:#fae5e7;--bad-text:#9c2c3a;--danger:#6e2832;--danger-hover:#7a303b;--danger-line:#8e3d49;--danger-hover-line:#9d4a56;--danger-text:#fff4f5;--danger-section:#fbf1f2;--danger-section-line:rgba(122,48,59,.25)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 "Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px}body[data-manager-surface="codex"] main{min-height:100vh}h1{font-size:21px;line-height:1.3;letter-spacing:-.2px;margin:0 0 5px;font-weight:650}p{color:var(--muted);margin:0}button{min-height:40px;border:1px solid var(--line-strong);border-radius:8px;background:var(--raised);color:var(--text);padding:0 13px;font:600 12px/1.15 "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;transition:background .12s ease,border-color .12s ease,transform .12s ease}button:hover{background:var(--hover);border-color:var(--hover-line)}button:active{transform:translateY(1px)}button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}button.danger{background:var(--danger);border-color:var(--danger-line);color:var(--danger-text)}button.danger:hover{background:var(--danger-hover);border-color:var(--danger-hover-line)}button:disabled{opacity:.55;cursor:not-allowed;transform:none}
.top{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:16px;padding:2px}.action-stack{display:grid;gap:10px}.action-section{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:13px 14px 14px;box-shadow:0 10px 30px var(--shadow)}.action-section[data-tone="danger"]{background:var(--danger-section);border-color:var(--danger-section-line)}.action-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:10px}.action-head h2{font-size:13px;margin:0}.action-head p{font-size:11px;text-align:right}.action-list{display:flex;gap:7px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 10px 30px var(--shadow)}.card h2{font-size:13px;margin:0 0 10px}.kv{display:grid;grid-template-columns:140px 1fr;gap:7px 10px}.k{color:var(--muted)}.badge{display:inline-flex;border-radius:999px;padding:2px 9px;font-weight:650}.ok{background:var(--ok-bg);color:var(--ok-text)}.warn{background:var(--warn-bg);color:var(--warn-text)}.bad{background:var(--bad-bg);color:var(--bad-text)}.list{display:flex;gap:7px;flex-wrap:wrap}.pill{border:1px solid var(--line);border-radius:7px;padding:4px 8px;color:var(--pill);background:var(--raised)}pre{white-space:pre-wrap;word-break:break-word;margin:0;color:var(--value)}.wide{grid-column:1/-1}@media(max-width:760px){main{padding:14px}.grid{grid-template-columns:1fr}.kv{grid-template-columns:100px 1fr}.action-head{display:block}.action-head p{text-align:left;margin-top:3px}}
.allowlist-box{display:grid;gap:10px}.allowlist-input{width:100%;min-height:92px;resize:vertical;border:1px solid var(--line);border-radius:10px;background:var(--raised);color:var(--text);padding:10px 11px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.allowlist-hint{color:var(--muted);white-space:pre-wrap}
</style>
</head>
<body data-manager-surface="codex">
<main>
  <div class="top">
    <div>
      <h1>Anti-Codex 管理</h1>
      <p>这里直接读取 Anti-Codex 本地网关状态，不走 ChatGPT 登录，也不消耗模型流量。</p>
    </div>
  </div>
  <div class="action-stack">
    <section class="action-section" data-action-group="daily" data-tone="neutral">
      <div class="action-head"><h2>日常操作</h2><p>查看、刷新和本地诊断</p></div>
      <div class="action-list">
        <button id="refresh" data-manager-action="refreshStatus">刷新状态</button>
        <button id="refreshModels" data-manager-action="refreshModels">刷新模型</button>
        <button data-action="accountSwitch" data-manager-action="accountSwitch">切换 Antigravity 账号</button>
        <button data-action="accountProxy" data-manager-action="accountProxy">检查账号/代理</button>
        <button data-action="syncReadiness" data-manager-action="syncReadiness">检查安装/同步</button>
        <button data-action="repairShortcuts" data-manager-action="repairShortcuts">修复快捷方式</button>
        <button data-action="updateCheck" data-manager-action="updateCheck">检查更新</button>
        <button data-action="sourcePreflight" data-manager-action="sourcePreflight">运行源码预检</button>
        <button data-action="mcpSkills" data-manager-action="mcpSkills">检查 MCP/Skill</button>
        <button data-action="pluginCapabilities" data-manager-action="pluginCapabilities">检查插件/应用</button>
        <button data-action="diagnosticsBundle" data-manager-action="diagnosticsBundle">生成诊断包</button>
        <button data-action="viewLatestReports" data-manager-action="viewLatestReports">查看最新报告</button>
      </div>
    </section>
    <section class="action-section" data-action-group="high-impact" data-tone="danger">
      <div class="action-head"><h2>维护与高影响操作</h2><p>可能重启、写入或长时间运行</p></div>
      <div class="action-list">
        <button data-action="syncHost" data-manager-action="syncHost" class="danger">同步 Codex 更新</button>
        <button data-action="upstreamConfig" data-manager-action="upstreamConfig" class="danger">配置第三方 API</button>
        <button data-action="resetAntigravitySessionLock" data-manager-action="resetAntigravitySessionLock" class="danger">\u91cd\u7f6e Antigravity \u4f1a\u8bdd\u9501</button>
        <button data-action="refreshFeatures" data-manager-action="refreshFeatures" class="danger">刷新本地功能</button>
        <button data-action="stabilitySoak" data-manager-action="stabilitySoak" class="danger">\u7a33\u5b9a\u6027\u5de1\u68c0\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09</button>
        <button data-action="fastOverallNoTraffic" data-manager-action="fastOverallNoTraffic" class="danger">快速检查（不耗流量）</button>
        <button data-action="overallNoTraffic" data-manager-action="overallNoTraffic" class="danger">整体检查（不耗流量）</button>
        <button data-action="postVerificationFull" data-manager-action="postVerificationFull" class="danger">验证后完整检查（耗真实流量）</button>
      </div>
    </section>
  </div>
  <div id="error" class="card wide" style="display:none"></div>
  <section class="grid">
    <div class="card"><h2>运行状态</h2><div id="health" class="kv"></div></div>
    <div class="card"><h2>账号与代理</h2><div id="account" class="kv"></div></div>
    <div class="card"><h2>工具与队列</h2><div id="tools" class="kv"></div></div>
    <div class="card"><h2>插件与应用</h2><div id="plugins" class="kv"></div></div>
    <div class="card"><h2>同步状态</h2><div id="sync" class="kv"></div></div>
    <div class="card"><h2>后台任务</h2><div id="longTasks" class="kv"></div></div>
    <div class="card"><h2>本地检查</h2><div id="localChecks" class="kv"></div></div>
    <div class="card"><h2>完整检查</h2><div id="postVerification" class="kv"></div></div>
    <div class="card wide"><h2>\u672c\u5730\u8fde\u63a5\u5668\u5de5\u5177</h2><div id="connectorAllowlist" class="kv"></div><div class="allowlist-box"><textarea id="connectorAllowlistInput" class="allowlist-input" spellcheck="false" aria-label="\u672c\u5730\u5141\u8bb8\u7684 connector id"></textarea><button id="saveConnectorAllowlist">\u4fdd\u5b58\u672c\u5730\u5141\u8bb8\u5217\u8868</button><pre id="connectorAllowlistResult" class="allowlist-hint">\u672c\u5730\u7f13\u5b58\u9884\u89c8\uff0c\u4e0d\u6388\u6743\uff0c\u4e0d\u4ee3\u8868\u53ef\u8c03\u7528\u3002\u6bcf\u884c\u4e00\u4e2a connector id\uff1b\u4ec5\u672c\u5730 Anti-Codex \u751f\u6548\u3002</pre></div></div>
    <div class="card wide"><h2>模型列表</h2><div id="models" class="list"></div></div>
    <div class="card wide"><h2>检查结果</h2><pre id="actionResult">还没有运行检查。</pre></div>
    <div class="card wide"><h2>最近路由</h2><pre id="route">加载中...</pre></div>
  </section>
</main>
<script>
const managerActionToken=${JSON.stringify(MANAGER_ACTION_TOKEN)};
const $=id=>document.getElementById(id);
const HIGH_IMPACT_ACTION_IDS=new Set(["syncHost","upstreamConfig","resetAntigravitySessionLock","refreshFeatures","stabilitySoak","fastOverallNoTraffic","overallNoTraffic","postVerificationFull"]);
const HIGH_IMPACT_CONFIRMATION_MS=15000;
let pendingHighImpactAction="";
let pendingHighImpactUntil=0;
let pendingHighImpactButton=null;
const zhBool=v=>v===true?"是":v===false?"否":"未知";
const badge=v=>'<span class="badge '+(v===true||v==="ready"||v==="closed"?"ok":v?"warn":"bad")+'">'+String(v ?? "未知")+'</span>';
const kv=(id,rows)=>{$(id).innerHTML=rows.map(([k,v])=>'<div class="k">'+k+'</div><div>'+v+'</div>').join('')};
const diagnosis=v=>({ready:"就绪",account_verification_required:"需要账号验证",account_verification_with_missing_token:"账号验证后令牌未刷新",antigravity_account_unavailable:"Antigravity 账号不可用",antigravity_temporarily_unavailable:"Antigravity 或代理暂不可用",quota_or_limit_reached:"Antigravity 账号额度/限额已到",not_checked:"未检查"}[v]||v||"未知");
const postState=v=>({not_checked:"暂无记录",waiting_for_account:"等待账号/代理",account_ready:"账号已就绪",running_full_verification:"正在完整检查",completed:"已完成",verification_failed:"完整检查失败",waiting_timeout:"等待超时"}[v]||v||"未知");
const checkState=x=>!x?.present?"暂无记录":((x.ok?"通过":"失败")+" / "+(x.elapsedMs!=null?(x.elapsedMs+" ms"):"耗时未知"));
const syncState=v=>({up_to_date:"已同步",up_to_date_cached:"已同步",source_codex_changed:"发现新版 Codex",source_missing:"未找到原生 Codex",active_missing:"Anti-Codex 主体缺失",hash_mismatch:"需要同步",not_checked:"未检查"}[v]||v||"未知");
async function getJson(path,opts){const r=await fetch(path,{cache:"no-store",...opts});const t=await r.text();try{return JSON.parse(t)}catch{return {ok:false,error:t||r.statusText,status:r.status}}}
function resetHighImpactConfirmation(){
  if(pendingHighImpactButton?.isConnected){
    pendingHighImpactButton.textContent=pendingHighImpactButton.getAttribute("data-original-label")||pendingHighImpactButton.textContent;
    pendingHighImpactButton.removeAttribute("data-confirming-high-impact");
  }
  pendingHighImpactAction="";
  pendingHighImpactUntil=0;
  pendingHighImpactButton=null;
}
function requireHighImpactConfirmation(action,label,btn){
  if(!HIGH_IMPACT_ACTION_IDS.has(action)){
    resetHighImpactConfirmation();
    return false;
  }
  const now=Date.now();
  if(pendingHighImpactAction===action&&now<=pendingHighImpactUntil){
    resetHighImpactConfirmation();
    return false;
  }
  resetHighImpactConfirmation();
  pendingHighImpactAction=action;
  pendingHighImpactUntil=now+HIGH_IMPACT_CONFIRMATION_MS;
  pendingHighImpactButton=btn;
  btn.setAttribute("data-original-label",label);
  btn.setAttribute("data-confirming-high-impact","true");
  btn.textContent="确认："+label;
  $("actionResult").textContent=label+"：请再点一次确认执行。\\n这是高影响操作，可能写入配置、重启或运行较长时间。";
  setTimeout(()=>{if(pendingHighImpactAction===action&&Date.now()>pendingHighImpactUntil)resetHighImpactConfirmation();},HIGH_IMPACT_CONFIRMATION_MS+250);
  return true;
}
const asArray=(payload,key)=>Array.isArray(payload)?payload:Array.isArray(payload?.[key])?payload[key]:Array.isArray(payload?.items)?payload.items:Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.value)?payload.value:[];
const count=(payload,key)=>asArray(payload,key).length;
const hasItems=(value)=>Array.isArray(value)?value.length>0:Boolean(value);
function shortHash(value){const text=String(value||"");return text?text.slice(0,8):"未知"}
function syncVersion(updateStatus){
  const sourceVersion=updateStatus?.source?.packageVersion||"未知";
  const activeVersion=updateStatus?.updateNeeded===false?sourceVersion:"需同步";
  return {sourceVersion,activeVersion};
}
function syncSafetyText(updateStatus){
  if(updateStatus?.sync?.available!==true) return "同步入口不可用，请先运行安装/同步检查。";
  return updateStatus?.updateNeeded===true
    ?"点“同步 Codex 更新”会先构建候选版，验证通过才替换；失败不会覆盖当前 Anti-Codex。"
    :"当前已跟随本机 Codex；下次原生 Codex 更新后再点“同步 Codex 更新”。";
}
function longTaskStatusText(item){
  return ({running:"\\u6b63\\u5728\\u8fd0\\u884c",attention:"\\u9700\\u8981\\u5904\\u7406",completed:"\\u5df2\\u5b8c\\u6210",idle:"\\u7a7a\\u95f2",not_checked:"\\u6682\\u65e0\\u8bb0\\u5f55"}[item?.state]||item?.rawState||"\\u672a\\u77e5");
}
function longTaskRows(longTasks){
  const items=Array.isArray(longTasks?.items)?longTasks.items:[];
  const sync=items.find((item)=>item?.id==="syncHost")||{};
  const post=items.find((item)=>item?.id==="postVerificationFull")||{};
  return [
    ["\\u6b63\\u5728\\u8fd0\\u884c",longTasks?.runningCount??0],
    ["\\u9700\\u5904\\u7406",longTasks?.attentionCount??0],
    ["Codex \\u540c\\u6b65",longTaskStatusText(sync)],
    ["\\u540c\\u6b65\\u9636\\u6bb5",sync.stage||"\\u6682\\u65e0"],
    ["\\u5b8c\\u6574\\u9a8c\\u8bc1",longTaskStatusText(post)],
    ["\\u9a8c\\u8bc1\\u9636\\u6bb5",post.stage||"\\u6682\\u65e0"],
    ["\\u6700\\u8fd1\\u62a5\\u544a",post.reportPath||sync.reportPath||"\\u6682\\u65e0"],
    ["\\u8bf4\\u660e",post.hint||sync.hint||"\\u957f\\u4efb\\u52a1\\u72b6\\u6001\\u6765\\u81ea\\u672c\\u5730\\u62a5\\u544a\\uff0c\\u5237\\u65b0\\u72b6\\u6001\\u5373\\u53ef\\u67e5\\u770b"]
  ];
}
function reportSummaryLines(result){
  const r=result||{};
  const report=r.report||{};
  return [
    r.reportName?"\\u8bc1\\u636e\\uff1a"+r.reportName:"",
    report.latest?"\\u6700\\u65b0\\u62a5\\u544a\\uff1a"+report.latest:"",
    report.history?"\\u5386\\u53f2\\u62a5\\u544a\\uff1a"+report.history:""
  ].filter(Boolean);
}
function failureSummaryLine(result){
  const failures=Array.isArray(result?.failures)?result.failures.filter(Boolean):[];
  if(!failures.length) return "";
  return "\\u5931\\u8d25\\u9879\\uff1a"+failures.length+"\\n"+failures.slice(0,3).join("\\n");
}
function formatReportAge(ageMs){
  if(!Number.isFinite(Number(ageMs))) return "";
  const seconds=Math.max(0,Math.round(Number(ageMs)/1000));
  if(seconds<60) return seconds+" \\u79d2\\u524d";
  const minutes=Math.round(seconds/60);
  if(minutes<60) return minutes+" \\u5206\\u949f\\u524d";
  const hours=Math.round(minutes/60);
  if(hours<48) return hours+" \\u5c0f\\u65f6\\u524d";
  return Math.round(hours/24)+" \\u5929\\u524d";
}
function latestReportsSummary(result){
  const reports=Array.isArray(result?.reports)?result.reports:[];
  if(!reports.length) return "\\u8fd8\\u6ca1\\u6709\\u53ef\\u663e\\u793a\\u7684\\u9a8c\\u6536\\u62a5\\u544a\\u3002\\n\\u53ef\\u5148\\u8fd0\\u884c\\u201c\\u5feb\\u901f\\u603b\\u68c0\\u201d\\u6216\\u201c\\u7a33\\u5b9a\\u6027\\u5de1\\u68c0\\u201d\\u751f\\u6210\\u62a5\\u544a\\u3002";
  const lines=[
    "\\u62a5\\u544a\\u76ee\\u5f55\\uff1a"+(result.reportRoot||"\\u672a\\u77e5"),
    "\\u5df2\\u627e\\u5230\\uff1a"+(result.existingCount??reports.filter((item)=>item.exists).length)+" \\u4efd"
  ];
  if(result.staleCount){
    lines.push("\\u9700\\u91cd\\u8dd1\\uff1a"+result.staleCount+" \\u4efd\\u62a5\\u544a\\u5df2\\u8fc7\\u671f");
  }
  if(result.missingCount){
    lines.push("\\u672a\\u751f\\u6210\\uff1a"+result.missingCount+" \\u4efd");
  }
  if(result.invalidCount){
    lines.push("\\u635f\\u574f\\u62a5\\u544a\\uff1a"+result.invalidCount+" \\u4efd\\u65e0\\u6cd5\\u8bfb\\u53d6");
  }
  if(!(result.existingCount??reports.filter((item)=>item.exists).length)){
    lines.push("\\u63d0\\u793a\\uff1a\\u8bf7\\u5148\\u8fd0\\u884c\\u5feb\\u901f\\u603b\\u68c0\\u3001\\u5b8c\\u6574\\u603b\\u68c0\\u6216\\u7a33\\u5b9a\\u6027\\u5de1\\u68c0\\u3002");
  }
  for(const item of reports){
    const status=item.exists?((item.parseable===false||item.invalid)?"\\u62a5\\u544a\\u635f\\u574f":(item.stale?"\\u9700\\u91cd\\u8dd1":(item.ok?"\\u901a\\u8fc7":"\\u9700\\u5904\\u7406"))):"\\u672a\\u751f\\u6210";
    const elapsed=item.elapsedMs!=null?(" / "+item.elapsedMs+" ms"):"";
    lines.push(item.label+"\\uff1a"+status+elapsed);
    const age=formatReportAge(item.ageMs);
    if(item.exists&&age) lines.push("  \\u66f4\\u65b0\\uff1a"+age);
    if(item.firstFailure) lines.push("  \\u9996\\u4e2a\\u5931\\u8d25\\uff1a"+item.firstFailure);
    if(item.publicDocumentationOk!==null&&item.publicDocumentationOk!==undefined) lines.push("  \\u516c\\u5f00\\u6587\\u6863\\uff1a"+(item.publicDocumentationOk?"\\u901a\\u8fc7":"\\u9700\\u5904\\u7406"));
    if(item.sourcePreflightEvidence){
      const evidence=item.sourcePreflightEvidence;
      lines.push("  sourcePreflight: js="+(evidence.javascriptSyntaxOk?"true":"false")+" / ps="+(evidence.powershellSyntaxOk?"true":"false")+" / profile="+(evidence.upstreamProfileStorageOk?"true":"false")+" / docs="+(evidence.publicDocumentationOk?"true":"false"));
      lines.push("  sourcePreflight: ui="+(evidence.uiStateSelfTestOk?"true":"false")+" / regression="+(evidence.translatorRegressionOk?"true":"false")+" / diff="+(evidence.diffWhitespaceOk?"true":"false")+" / skipFull="+(evidence.skipFullRegression?"true":"false"));
    }
    if(item.skipped===true){
      lines.push("  skipped: "+(item.reason||"no reason")+" / requestedRealTraffic="+(item.requestedRealTraffic?"true":"false")+" / coverage="+(item.coverageKind||"unknown"));
    }
    if(item.releaseReady!==null&&item.releaseReady!==undefined){
      lines.push("  Release Gate: short="+(item.shortReady?"true":"false")+" / release="+(item.releaseReady?"true":"false"));
      if(Array.isArray(item.missingRequired)&&item.missingRequired.length) lines.push("  missingRequired: "+item.missingRequired.slice(0,6).join(", "));
      if(Array.isArray(item.missingShort)&&item.missingShort.length) lines.push("  missingShort: "+item.missingShort.slice(0,6).join(", "));
    }
    if(Array.isArray(item.releaseGateFailures)&&item.releaseGateFailures.length){
      const gateFailures=item.releaseGateFailures.slice(0,4).map((gate)=>{
        const details=Array.isArray(gate.semanticFailures)&&gate.semanticFailures.length?gate.semanticFailures.slice(0,4).join(", "):(gate.error||"unsatisfied");
        return gate.id+":"+details;
      });
      lines.push("  semanticFailures: "+gateFailures.join(" | "));
    }
    if(item.localConnectorEvidence){
      const evidence=item.localConnectorEvidence;
      lines.push("  \\u8fde\\u63a5\\u5668\\u8bc1\\u636e\\uff1aChatGPT URL "+(evidence.chatgptInstallUrlsScrubbed?"\\u5df2\\u6e05\\u7406":"\\u9700\\u5904\\u7406")+" / \\u4e0a\\u6e38\\u8bf7\\u6c42 "+(evidence.upstreamRequestsDuringLocalEndpoints??"\\u672a\\u77e5")+" / allowlist "+(evidence.allowlistedConnectorAccessible?"\\u88ab\\u5f53\\u6210\\u6388\\u6743":"\\u4e0d\\u7b49\\u4e8e\\u6388\\u6743"));
      if(Array.isArray(evidence.exposedToolNames)&&evidence.exposedToolNames.length) lines.push("  \\u53ef\\u89c1\\u5de5\\u5177\\uff1a"+evidence.exposedToolNames.join(", "));
    }
    if(item.modelRoutingEvidence){
      const evidence=item.modelRoutingEvidence;
      lines.push("  modelRouting: mode="+(evidence.mode||"unknown")+" / skipRequests="+(item.skipRequests?"true":"false")+" / results="+(evidence.skippedRequestCount??0)+"/"+(evidence.resultCount??0)+" / failed="+(evidence.failedResultCount??0));
      if(evidence.providerProtocol||evidence.providerModel||evidence.toolBridgeMode) lines.push("  modelRouting route: protocol="+(evidence.providerProtocol||"native")+" / providerModel="+(evidence.providerModel||"none")+" / toolBridge="+(evidence.toolBridgeMode||"unknown"));
    }
    if(item.modelThinkingEvidence){
      const evidence=item.modelThinkingEvidence;
      lines.push("  modelThinking: models="+(evidence.actualModelCount??"unknown")+"/"+(evidence.expectedModelCount??"unknown")+" / thinking="+(evidence.supportsThinkingCount??0)+"/"+(evidence.modelCount??0)+" / budgetMissing="+(evidence.missingBudgetCount??0));
      if(Array.isArray(evidence.reasoningLevels)&&evidence.reasoningLevels.length) lines.push("  modelThinking levels: "+evidence.reasoningLevels.join(", "));
    }
    if(item.uiIdleEvidence){
      const evidence=item.uiIdleEvidence;
      lines.push("  uiIdle: samples="+(evidence.healthySampleCount??0)+"/"+(evidence.sampleCount??0)+" / duration="+(evidence.durationSec??"unknown")+"s / reconnectText="+(evidence.reconnectTextCount??0)+" / loginText="+(evidence.loginTextCount??0));
    }
    if(item.syncReadinessEvidence){
      const evidence=item.syncReadinessEvidence;
      lines.push("  syncReadiness: noTraffic="+(evidence.noTrafficReady?"true":"check")+" / full="+(evidence.fullMode?"true":"check")+" / host="+(evidence.activeHostReady&&evidence.brandReady?"ok":"check")+" / icons="+(evidence.iconReady?"ok":"check")+" / update="+(evidence.updateReady?"synced":"check")+" / guardrails="+(evidence.guardrailsReady?"ok":"check"));
      lines.push("  syncReadiness shortcuts: "+(evidence.shortcutReadyCount??0)+"/"+(evidence.shortcutCount??0)+" / managerBridge="+(evidence.managerBridgeReady?"ok":"check")+" / clean="+(evidence.cleanSyncState?"true":"false"));
    }
    if(item.toolBridgeEvidence){
      const evidence=item.toolBridgeEvidence;
      lines.push("  toolBridge: mode="+(evidence.mode||"unknown")+" / transport="+(evidence.transport||"unknown")+" / adapter="+(evidence.localAdapter||"unknown"));
      lines.push("  toolBridge native: events="+(evidence.nativeAntigravityToolEvents?"true":"false")+" / discovery="+(evidence.nativeMcpDiscoveryVerified?"true":"false")+" / approval="+(evidence.nativeMcpApprovalProtocolVerified?"true":"false")+" / resume="+(evidence.sameCascadeResumeProbeVerified?"true":"false"));
    }
    if(item.mcpSkillEvidence){
      const evidence=item.mcpSkillEvidence;
      const mcpClean=evidence.mcpMissingSharedCount===0&&evidence.mcpExtraLocalCount===0&&evidence.hasNodeRepl===true;
      const skillClean=evidence.missingSharedSkillCount===0&&evidence.skillSmokeReadable===true;
      lines.push("  MCP/Skill \\u8bc1\\u636e\\uff1aMCP "+(evidence.mcpCount??"\\u672a\\u77e5")+"/"+(evidence.mcpSharedCount??"\\u672a\\u77e5")+" / skills "+(evidence.skillCount??"\\u672a\\u77e5")+"/"+(evidence.expectedSharedSkillCount??"\\u672a\\u77e5")+" / agents "+(evidence.agentsSkillCount??"\\u672a\\u77e5"));
      lines.push("  MCP/Skill parity: "+(mcpClean&&skillClean?"\\u5e72\\u51c0":"\\u9700\\u5904\\u7406")+" / smoke "+(evidence.mcpSmokePassed?"MCP ok":"MCP ?")+" / skill "+(evidence.skillSmokeReadable?"ok":"?"));
    }
    if(item.optionalRealProviderEvidence){
      const evidence=item.optionalRealProviderEvidence;
      lines.push("  realProvider: first="+(evidence.firstMarkerObserved?"true":"false")+" / second="+(evidence.secondMarkerObserved?"true":"false")+" / history="+(evidence.historyContinuationObserved?"true":"false")+" / turns="+(evidence.turns??"unknown"));
    }
    if(item.antigravityReturnEvidence){
      const evidence=item.antigravityReturnEvidence;
      lines.push("  antigravityReturn: history="+(evidence.returnedToAntigravityWithHistory?"true":"false")+" / previousId="+(evidence.previousResponseIdMatched?"true":"false")+" / markers="+(evidence.markerCount??"unknown")+" missing="+(evidence.missingMarkerCount??"unknown"));
      lines.push("  antigravityRoute: "+(evidence.routeTransport||"unknown")+" / "+(evidence.resolvedModel||"unknown"));
    }
    if(item.pluginCapabilityEvidence){
      const evidence=item.pluginCapabilityEvidence;
      const parityClean=evidence.connectorParityClean===true&&evidence.appToolParityClean===true&&evidence.appToolGetPostParityClean===true;
      lines.push("  \\u5e94\\u7528\\u5de5\\u5177\\u8bc1\\u636e\\uff1a\\u672a\\u6388\\u6743\\u5de5\\u5177 "+(evidence.unauthorizedAppToolCount??"\\u672a\\u77e5")+" / \\u65e0 connector_id "+(evidence.unattributedAppToolCount??"\\u672a\\u77e5")+" / parity "+(parityClean?"\\u5e72\\u51c0":"\\u9700\\u5904\\u7406"));
      if(!parityClean){
        const samples=[...(evidence.connectorParityMissingSharedSample||[]),...(evidence.appToolParityMissingSharedSample||[]),...(evidence.appToolGetPostMissingFromGetSample||[])].slice(0,5);
        lines.push("  parity drift: connectorMissing="+(evidence.connectorParityMissingSharedCount??"\\u672a\\u77e5")+" / appToolMissing="+(evidence.appToolParityMissingSharedCount??"\\u672a\\u77e5")+" / getPostMissing="+(evidence.appToolGetPostMissingFromGetCount??"\\u672a\\u77e5")+(samples.length?" / sample "+samples.join(", "):""));
      }
      lines.push("  \\u539f\\u751f Codex \\u5199\\u56de\\uff1a"+(evidence.nativeCodexWriteback?"\\u9700\\u5904\\u7406":"\\u65e0"));
    }
    if(item.providerContinuity){
      const continuity=item.providerContinuity;
      const markerCounts=[continuity.seventhMarkerCount,continuity.eighthMarkerCount,continuity.ninthMarkerCount].filter((value)=>value!==null&&value!==undefined).join("/");
      lines.push("  providerContinuity: turns="+(continuity.turns??"unknown")+" / markers="+(markerCounts||"unknown"));
      lines.push("  toolPairs: openai="+(continuity.providerSwitchPreservesOpenAiToolPair?"true":"false")+" / anthropic="+(continuity.protocolSwitchPreservesAnthropicToolPair?"true":"false")+" / reverse="+(continuity.reverseProtocolSwitchPreservesOpenAiToolPair?"true":"false"));
    }
    if(item.exists&&item.latestPath) lines.push("  \\u6587\\u4ef6\\uff1a"+item.latestPath);
  }
  return lines.join("\\n");
}
function ensureLatestReportsEvidenceLines(summary,payload){
  const text=String(summary||"");
  if(!text||text.includes("\\u516c\\u5f00\\u6587\\u6863\\uff1a")) return text;
  const candidates=[payload?.result,payload?.result?.result,payload].filter(Boolean);
  const reportPayload=candidates.find((item)=>Array.isArray(item?.reports))||{};
  const sourcePreflight=reportPayload.reports?.find((item)=>item?.fileName==="latest-source-preflight.json");
  const publicDocumentationOk=sourcePreflight?.publicDocumentationOk;
  const inferredOk=publicDocumentationOk===null||publicDocumentationOk===undefined
    ? (text.includes("\\u6e90\\u7801\\u9884\\u68c0\\uff1a\\u901a\\u8fc7")?true:null)
    : publicDocumentationOk===true;
  if(inferredOk===null) return text;
  const publicDocumentationLine="  \\u516c\\u5f00\\u6587\\u6863\\uff1a"+(inferredOk?"\\u901a\\u8fc7":"\\u9700\\u5904\\u7406");
  if(sourcePreflight?.latestPath){
    const fileLine="  \\u6587\\u4ef6\\uff1a"+sourcePreflight.latestPath;
    if(text.includes(fileLine)) return text.replace(fileLine,publicDocumentationLine+"\\n"+fileLine);
  }
  return text+"\\n"+publicDocumentationLine;
}
function actionText(payload){
  const r=payload?.result||{};
  if(payload?.action==="accountProxy"){
    const p=r.phaseSummary||{};
    return [
      "账号/代理检查："+diagnosis(r.detail||r.diagnosisDetail||r.diagnosis),
      "建议："+(r.suggestedAction||"查看 Antigravity 桌面端账号和代理状态。"),
      "阶段：账号 "+(p.accountOk?"正常":"不可用")+"    模型刷新 "+(p.refreshOk?"成功":"失败")+"    缓存模型 "+(p.modelCount??"未知")+"    真实请求 "+(p.realRequestOk?"成功":p.realRequestAttempted?"失败":"未执行"),
      r.failures?.length?("失败："+r.failures.join("\\n")):""
    ].filter(Boolean).join("\\n");
  }
  if(payload?.action==="syncReadiness"){
    const v=syncVersion(r.sync?.updateStatus);
    return "安装/同步检查："+(r.ok?"通过":"失败")+"\\n原生 Codex："+v.sourceVersion+"    Anti-Codex："+v.activeVersion+"\\n"+(r.failures?.length?r.failures.join("\\n"):"桌面图标、程序图标、回滚点和同步入口已验证。");
  }
  if(payload?.action==="repairShortcuts"){
    return "快捷方式修复："+(r.ok?"完成":"需要处理")+"\\n已修复："+(r.repairedCount??(r.shortcuts?.length??"未知"))+"\\n"+(r.failures?.length?r.failures.join("\\n"):"桌面和开始菜单快捷方式已重建。");
  }
  if(payload?.action==="updateCheck"){
    const v=syncVersion(r);
    return [
      "Codex 更新检查："+(r.updateNeeded?"发现新版":"已是最新"),
      "原生 Codex："+v.sourceVersion+"    Anti-Codex："+v.activeVersion,
      "状态："+syncState(r.reason),
      r.sync?.available?"同步入口：可用":"同步入口：不可用",
      syncSafetyText(r)
    ].join("\\n");
  }
  if(payload?.action==="sourcePreflight"){
    return [
      "\\u6e90\\u7801\\u9884\\u68c0\\uff1a"+(r.ok?"\\u901a\\u8fc7":"\\u9700\\u8981\\u5904\\u7406"),
      "\\u8017\\u65f6\\uff1a"+(r.elapsedMs??"\\u672a\\u77e5")+" ms",
      ...reportSummaryLines(r),
      failureSummaryLine(r)
    ].filter(Boolean).join("\\n");
  }
  if(payload?.action==="upstreamConfig"){
    return "\u7b2c\u4e09\u65b9 API \u914d\u7f6e\uff1a\u8bf7\u5728 Anti-Codex \u5185\u5d4c\u7ba1\u7406\u9762\u677f\u91cc\u6253\u5f00\u3002\n\u8fd9\u4e2a\u52a8\u4f5c\u4e0d\u4f1a\u8d70 ChatGPT \u767b\u5f55\uff0c\u4e0d\u4f1a\u6d88\u8017 Antigravity \u6a21\u578b\u6d41\u91cf\uff0c\u4e5f\u4e0d\u4f1a\u6e05\u7a7a\u804a\u5929\u8bb0\u5f55\u3002";
  }
  if(payload?.action==="resetAntigravitySessionLock"){
    const reset=r.result||r;
    return [
      "Antigravity \u4f1a\u8bdd\u9501\u5df2\u91cd\u7f6e\u3002",
      "\u5df2\u91ca\u653e\u6b63\u5728\u8fd0\u884c\u7684\u4f1a\u8bdd\uff1a"+(reset.activeReleased?"\u662f":"\u5426"),
      "\u5df2\u53d6\u6d88\u6392\u961f\u4f1a\u8bdd\uff1a"+(reset.queuedCancelled??0)
    ].join("\\n");
  }
  if(payload?.action==="syncHost"){
    if(payload.alreadyRunning){
      return "同步 Codex 更新已经在后台运行。\\n请等它完成后再点刷新状态；当前版本在候选验证失败时不会被替换。";
    }
    return (payload.ok?"已在后台开始同步 Codex 更新。":"启动同步失败。")+"\\n同步会先构建并验证候选版本；验证失败时当前 Anti-Codex 不会被替换。\\n"+(payload.message||"");
  }
  if(payload?.action==="mcpSkills"){
    return "MCP/Skill 检查："+(r.ok?"通过":"需要处理")+"\\nMCP："+(r.mcp?.count??"未知")+"    Skill："+(r.skills?.count??"未知")+"\\n"+(r.failures?.length?r.failures.join("\\n"):"本地 MCP、Skill 和插件缓存路径检查通过。");
  }
  if(payload?.action==="pluginCapabilities"){
    const c=r.capabilities||{};
    return [
      "插件/应用检查："+(r.ok?"通过":"需要处理"),
      "已安装插件："+(c.installedPluginCount??"未知")+"    插件列表："+(c.pluginListCount??"未知")+"    Skill 插件："+(c.pluginsWithSkills??"未知")+"    MCP 插件："+(c.pluginsWithMcpServers??"未知"),
      "连接器："+(c.connectorCount??"未知")+"    已授权连接器："+(c.accessibleConnectorCount??"未知")+"    应用工具："+(c.appToolCount??"未知"),
      c.appToolsNote?("说明："+c.appToolsNote):"",
      r.failures?.length?("失败："+r.failures.join("\\n")):""
    ].filter(Boolean).join("\\n");
  }
  if(payload?.action==="refreshFeatures"){
    if(payload?.background){
      return payload?.alreadyRunning
        ? "本地功能刷新：已在后台运行。\\n请稍后点“刷新状态”或 MCP/Skill、插件/应用按钮复核。"
        : "本地功能刷新：已开始后台执行。\\n界面不会等待长时复制；完成后用 MCP/Skill 和插件/应用按钮复核。";
    }
    const snapshotCount=Array.isArray(r.snapshots)?r.snapshots.length:(r.snapshots?.count??"未知");
    return [
      "本地功能刷新："+(r.ok?"完成":"需要处理"),
      "Skill："+(r.skills?.count??"未知")+"    快照："+snapshotCount+"    连接器缓存："+(r.connectors?.count??"未知"),
      r.failures?.length?("失败："+r.failures.join("\\n")):"Codex 的本地插件、Skill、MCP 相关快照已同步到 Anti-Codex。"
    ].filter(Boolean).join("\\n");
  }
  if(payload?.action==="stabilitySoak"){
    if(payload.alreadyRunning){
      return "\\u7a33\\u5b9a\\u6027\\u5de1\\u68c0\\u5df2\\u5728\\u540e\\u53f0\\u8fd0\\u884c\\u3002\\n\\u5b83\\u4f1a\\u6d88\\u8017\\u771f\\u5b9e Antigravity \\u6d41\\u91cf\\uff1b\\u8bf7\\u7a0d\\u540e\\u70b9\\u201c\\u67e5\\u770b\\u6700\\u65b0\\u62a5\\u544a\\u201d\\u786e\\u8ba4\\u7ed3\\u679c\\u3002";
    }
    return (payload.ok?"\\u5df2\\u5728\\u540e\\u53f0\\u5f00\\u59cb\\u7a33\\u5b9a\\u6027\\u5de1\\u68c0\\u3002":"\\u542f\\u52a8\\u7a33\\u5b9a\\u6027\\u5de1\\u68c0\\u5931\\u8d25\\u3002")+"\\n\\u8fd9\\u4f1a\\u6d88\\u8017\\u771f\\u5b9e Antigravity \\u6d41\\u91cf\\uff0c\\u5b8c\\u6210\\u540e\\u4f1a\\u5199\\u5165 latest-stability-soak.json\\u3002";
  }
  if(payload?.action==="fastOverallNoTraffic"){
    return [
      "\\u5feb\\u901f\\u68c0\\u67e5\\uff1a"+(r.ok?"\\u901a\\u8fc7":"\\u9700\\u8981\\u5904\\u7406"),
      "\\u8017\\u65f6\\uff1a"+(r.elapsedMs??"\\u672a\\u77e5")+" ms",
      ...reportSummaryLines(r),
      failureSummaryLine(r),
      (!r.failures?.length&&!r.reportName&&!r.report?.latest)?(payload?.message||payload?.stderr||"\\u5173\\u952e\\u72b6\\u6001\\u3001\\u754c\\u9762\\u3001\\u6a21\\u578b\\u83dc\\u5355\\u3001\\u63d2\\u4ef6/MCP \\u5feb\\u7167\\u548c\\u9694\\u79bb\\u6027\\u5feb\\u68c0\\u901a\\u8fc7\\u3002"):""
    ].filter(Boolean).join("\\n");
  }
  if(payload?.action==="overallNoTraffic"){
    return [
      "\\u6574\\u4f53\\u68c0\\u67e5\\uff1a"+(r.ok?"\\u901a\\u8fc7":"\\u9700\\u8981\\u5904\\u7406"),
      "\\u8017\\u65f6\\uff1a"+(r.elapsedMs??"\\u672a\\u77e5")+" ms",
      ...reportSummaryLines(r),
      failureSummaryLine(r),
      (!r.failures?.length&&!r.reportName&&!r.report?.latest)?"\\u672c\\u5730\\u754c\\u9762\\u3001\\u6a21\\u578b\\u83dc\\u5355\\u3001MCP/Skills\\u3001\\u63d2\\u4ef6\\u3001\\u540c\\u6b65\\u72b6\\u6001\\u548c\\u9694\\u79bb\\u6027\\u68c0\\u67e5\\u901a\\u8fc7\\u3002":""
    ].filter(Boolean).join("\\n");
  }
  if(payload?.action==="diagnosticsBundle"){
    const unwrapped=r?.result&&typeof r.result==="object"?r.result:r;
    return [
      "\\u8bca\\u65ad\\u5305\\uff1a"+((unwrapped.ok??r.ok)?"\\u5df2\\u751f\\u6210":"\\u5931\\u8d25"),
      unwrapped.zipPath?"ZIP\\uff1a"+unwrapped.zipPath:"",
      unwrapped.bundleRoot?"\\u76ee\\u5f55\\uff1a"+unwrapped.bundleRoot:"",
      failureSummaryLine(unwrapped),
      (!unwrapped.zipPath&&!unwrapped.bundleRoot&&!unwrapped.failures?.length)?(payload?.message||r.message||""):""
    ].filter(Boolean).join("\\n");
  }
  if(payload?.action==="viewLatestReports") return ensureLatestReportsEvidenceLines(latestReportsSummary(r),payload);
  if(payload?.action==="postVerificationFull"){
    if(payload.alreadyRunning){
      return "验证后完整检查已经在后台运行。\\n它会消耗真实 Antigravity 流量；请点刷新状态查看进度，不要重复启动。";
    }
    return (payload.ok?"已在后台开始验证后完整检查。":"启动完整检查失败。")+"\\n注意：此检查会在账号/代理恢复后消耗真实 Antigravity 流量。\\n"+(payload.message||"");
  }
  return JSON.stringify(payload,null,2);
}
function routeSummary(route){
  return {
    "\u8bf7\u6c42\u6a21\u578b": route?.requestedModel || "",
    "\u5b9e\u9645\u6a21\u578b": route?.resolvedModel || "",
    "\u663e\u793a\u540d": route?.displayName || "",
    "\u4f20\u8f93": route?.transport || "",
    "Provider": route?.provider || "",
    "\u534f\u8bae": route?.providerProtocol || "",
    "\u5185\u90e8\u6a21\u578b": route?.internalModel || "",
    "\u72b6\u6001": route?.status || "\u6682\u65e0\u8def\u7531\u8bb0\u5f55"
  };
}
function renderConnectorAllowlist(payload){
  const persisted=Array.isArray(payload?.persisted)?payload.persisted:[];
  const env=Array.isArray(payload?.env)?payload.env:[];
  const counts=payload?.counts||{};
  kv("connectorAllowlist",[
    ["\\u76ee\\u5f55",counts.total??0],
    ["\\u672c\\u5730\\u7f13\\u5b58\\u9884\\u89c8",counts.localAllowlisted??counts.locallyAuthorized??0],
    ["\\u771f\\u5b9e\\u53ef\\u8c03\\u7528\\u5de5\\u5177",counts.appTools??0],
    ["\\u914d\\u7f6e\\u6587\\u4ef6",payload?.configPath||"\\u672a\\u77e5"],
    ["\\u73af\\u5883\\u53d8\\u91cf",env.length?env.join(", "):"\\u672a\\u914d\\u7f6e"],
  ]);
  $("connectorAllowlistInput").value=persisted.join("\\n");
  $("connectorAllowlistResult").textContent="\\u672c\\u5730\\u7f13\\u5b58\\u9884\\u89c8\\uff0c\\u4e0d\\u6388\\u6743\\uff0c\\u4e0d\\u4ee3\\u8868\\u53ef\\u8c03\\u7528\\u3002\\n\\u6bcf\\u884c\\u4e00\\u4e2a connector id\\uff1b\\u672a\\u5217\\u5165\\u7684\\u8fde\\u63a5\\u5668\\u53ea\\u4fdd\\u7559\\u5143\\u6570\\u636e\\u3002";
}
async function load(){
  $("error").style.display="none";
  const [health,diag,account,routes,installedPlugins,pluginList,connectors,appTools,allowlist]=await Promise.all([
    getJson("/health"),
    getJson("/anticodex/diagnostics"),
    getJson("/anticodex/account"),
    getJson("/anticodex/model-routes"),
    getJson("/backend-api/ps/plugins/installed"),
    getJson("/backend-api/plugins/list"),
    getJson("/backend-api/aip/connectors"),
    getJson("/backend-api/wham/apps",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),
    getJson("/anticodex/local-connectors/allowlist"),
  ]);
  kv("health",[["网关",badge(health.ok)],["上游",health.upstream||"未知"],["模型数",health.modelCount??0],["熔断",badge(health.antigravityCircuitState)],["启动状态",diagnosis(diag.lifecycle?.type||"未知")],["最近启动",diag.lifecycle?.at||"未知"],["进程",diag.process?("#"+diag.process.pid+" / "+diag.process.uptimeSec+" 秒"):"未知"]]);
  kv("account",[["账号",badge(health.accountReady)],["流量",badge(health.accountTrafficReady)],["状态",diagnosis(health.accountTrafficDiagnosis||health.accountTrafficState||health.accountState)],["建议",health.accountTrafficSuggestedAction||"暂无"],["套餐",((account.planName||"未知")+" / "+(account.tierName||"未知"))],["代理边界","Anti-Codex 到 Antigravity 本机通信不走代理"]]);
  const q=diag.antigravityQueue||{};
  const lf=diag.localFeatures||{};
  kv("tools",[["模式",diag.toolBridge?.mode==="codex-owned-tools-prompt-mediated"?"Codex 负责工具，Antigravity 只负责模型":(diag.toolBridge?.mode||"未知")],["Skill",lf.skills?.count??"未知"],["MCP",lf.mcp?.count??"未知"],["快照",("连接器 "+(lf.snapshots?.connectorDirectoryFiles??"未知")+" / 应用工具 "+(lf.snapshots?.appToolsCacheFiles??"未知"))],["原生桥默认",zhBool(diag.toolBridge?.nativeBridgeDefaultEnabled)],["排队",String(q.queued??0)+" / "+String(q.maxQueued??0)],["运行中",zhBool(q.running)],["活跃请求",diag.activeAntigravityRequests?.active??0]]);
  const pluginRows=asArray(pluginList,"plugins");
  const installedRows=asArray(installedPlugins);
  const connectorRows=asArray(connectors,"connectors");
  const accessibleConnectors=connectorRows.filter(x=>x?.isAccessible===true).length;
  kv("plugins",[
    ["已安装插件",count(installedPlugins)],
    ["插件列表",pluginRows.length],
    ["Skill 插件",pluginRows.filter(x=>hasItems(x?.summary?.skills)).length],
    ["MCP 插件",pluginRows.filter(x=>hasItems(x?.summary?.mcpServers)).length],
    ["应用绑定",installedRows.filter(x=>hasItems(x?.apps)).length],
    ["连接器",connectorRows.length],
    ["已授权连接器",accessibleConnectors],
    ["\\u672c\\u5730\\u7f13\\u5b58\\u9884\\u89c8",allowlist?.counts?.localAllowlisted??allowlist?.counts?.locallyAuthorized??0],
    ["应用工具",count(appTools,"tools")],
    ["说明",accessibleConnectors>0?"只显示真实授权后可调用的应用工具":"未授权连接器不会伪装成可调用工具"],
  ]);
  const syncInfo=syncVersion(diag.updateStatus);
  kv("sync",[
    ["原生 Codex 版本",syncInfo.sourceVersion],
    ["Anti-Codex 版本",syncInfo.activeVersion],
    ["更新状态",syncState(diag.updateStatus?.reason)],
    ["需要同步",zhBool(diag.updateStatus?.updateNeeded)],
    ["同步入口",diag.updateStatus?.sync?.available?"可用":"未知"],
    ["回滚点",diag.updateStatus?.active?.root?"已保留上一个可用版本":"未知"],
    ["主程序校验",shortHash(diag.updateStatus?.active?.hostHash)+" / "+shortHash(diag.updateStatus?.source?.hostHash)],
    ["最近检查",diag.updateStatus?.checkedAt||"未知"],
    ["说明",syncSafetyText(diag.updateStatus)],
  ]);
  kv("longTasks",longTaskRows(diag.longTasks));
  const checks=diag.installedChecks||{};
  const shortcutRepair=diag.shortcutRepair||{};
  const sourcePreflight=diag.sourcePreflight||{};
  kv("localChecks",[
    ["上次源码预检",checkState(sourcePreflight)],
    ["上次快检",checkState(checks.fast)],
    ["上次完整无流量",checkState(checks.full)],
    ["上次快捷方式修复",shortcutRepair.present?(shortcutRepair.ok?"通过":"失败")+" / "+(shortcutRepair.repairedCount??"未知")+" 个":"暂无记录"],
    ["源码预检证据",sourcePreflight.reportName||"source-preflight"],
    ["快检证据",checks.fast?.reportName||"installed-overall-fast"],
    ["完整证据",checks.full?.reportName||"installed-overall"],
    ["说明","快检不会覆盖完整总检报告"],
  ]);
  const pv=diag.postVerification||{};
  kv("postVerification",[["状态",postState(pv.state)],["真实流量",zhBool(pv.usedRealTraffic)],["诊断",diagnosis(pv.latestDiagnosis)],["细节",pv.latestDiagnosisDetail||"无"],["尝试次数",pv.attempts??0],["耗时",pv.elapsedMs!=null?(pv.elapsedMs+" ms"):"未知"],["失败数",pv.failureCount??0]]);
  renderConnectorAllowlist(allowlist);
  const names=diag.models?.displayNames||diag.models?.ids||[];
  $("models").innerHTML=names.map(x=>'<span class="pill">'+String(x)+'</span>').join('');
  $("route").textContent=JSON.stringify(routeSummary(routes.latest),null,2);
}
$("refresh").onclick=load;
$("refreshModels").onclick=async()=>{ $("refreshModels").disabled=true; try{const r=await getJson("/anticodex/models/refresh",{method:"POST"}); if(!r.ok) throw new Error(r.message||r.error?.message||"刷新失败"); await load();}catch(e){$("error").style.display="block";$("error").textContent="刷新模型失败："+e.message} finally{$("refreshModels").disabled=false;} };
$("saveConnectorAllowlist").onclick=async()=>{const button=$("saveConnectorAllowlist");const ids=$("connectorAllowlistInput").value.split(/[\\r\\n,]+/).map(x=>x.trim()).filter(Boolean);button.disabled=true;$("connectorAllowlistResult").textContent="\\u6b63\\u5728\\u4fdd\\u5b58...";try{const r=await getJson("/anticodex/local-connectors/allowlist",{method:"POST",headers:{"content-type":"application/json","x-anticodex-manager-token":managerActionToken},body:JSON.stringify({connectorIds:ids})});if(r.ok===false)throw new Error(r.message||r.error||"save failed");renderConnectorAllowlist(r);$("connectorAllowlistResult").textContent="\\u5df2\\u4fdd\\u5b58\\u672c\\u5730\\u8fde\\u63a5\\u5668 allowlist\\u3002\\n\\u672c\\u5730\\u7f13\\u5b58\\u9884\\u89c8\\uff1a"+(r.counts?.localAllowlisted??r.counts?.locallyAuthorized??0)+"\\n\\u771f\\u5b9e\\u53ef\\u8c03\\u7528\\u5de5\\u5177\\uff1a"+(r.counts?.appTools??0)+"\\n\\u6ce8\\u610f\\uff1a\\u4e0d\\u6388\\u6743\\uff0c\\u4e0d\\u4ee3\\u8868\\u53ef\\u8c03\\u7528\\u3002";await load();}catch(e){$("connectorAllowlistResult").textContent="\\u4fdd\\u5b58\\u5931\\u8d25\\uff1a"+e.message}finally{button.disabled=false;}};
function setActionButtonsDisabled(disabled){document.querySelectorAll("button[data-action]").forEach(button=>{button.disabled=!!disabled;});}
document.querySelectorAll("button[data-action]").forEach(btn=>{btn.onclick=async()=>{const action=btn.getAttribute("data-action");const label=btn.getAttribute("data-original-label")||btn.textContent;if(requireHighImpactConfirmation(action,label,btn))return;setActionButtonsDisabled(true);$("actionResult").textContent="正在运行："+label+" ...";try{const r=await getJson("/anticodex/manager/action",{method:"POST",headers:{"content-type":"application/json","x-anticodex-manager-token":managerActionToken},body:JSON.stringify({action})});$("actionResult").textContent=actionText(r);await load();}catch(e){$("actionResult").textContent="运行失败："+e.message}finally{setActionButtonsDisabled(false);}}});
load().catch(e=>{$("error").style.display="block";$("error").textContent="加载失败："+e.message});
</script>
</body>
</html>`;
}

// ──────────────────────────────────────────────── model mapping ──────────────

const CODEX_TO_MODEL = {
    "gpt-5.5": null, "gpt-5.4": null, "gpt-5.3-codex": null, "o3": null, "o4-mini": null,
    "gpt-5.4-mini": null, "gpt-5.4-nano": null,
};
const ANTIGRAVITY_LEGACY_MODEL_IDS = new Set([
    "gemini-pro-agent",
    "gemini-pro",
    "gemini-flash-agent",
    "gemini-3-flash-agent",
    "gemini-3.5-flash-low",
]);
// Null means "resolve to profile default / fast".  Kept as map for future
// per-vendor overrides.

function resolveModel(model, preferFast = false) {
    const p = PROFILE || {};
    const aliases = p.codexModelAliases || p.defaults?.codexModelAliases || {};
    const alias = aliases?.[model];
    if (alias === "fast") return p.fastModel || p.defaultModel || "deepseek-v4-flash";
    if (alias === "default") return p.defaultModel || "deepseek-v4-pro";
    if (typeof alias === "string" && alias) return alias;
    if (CODEX_TO_MODEL[model] !== undefined) {
        return preferFast ? (p.fastModel || "deepseek-v4-flash") : (p.defaultModel || "deepseek-v4-pro");
    }
    const cleaned = String(model || "").replace(/\[1m\]|1m$/i, "");
    if (!isAntigravityUpstreamMode(UPSTREAM_MODE)) {
        const thirdPartyDefault = p.defaultModel || p.model || UPSTREAM_MODEL || "gpt-4o-mini";
        return ANTIGRAVITY_LEGACY_MODEL_IDS.has(cleaned) ? thirdPartyDefault : (cleaned || thirdPartyDefault);
    }
    return cleaned || p.defaultModel || "deepseek-v4-pro";
}

// ──────────────────────────────────────────── provider-aware system prompt ───

function buildSystemBlock(options = {}) {
    const p = PROFILE || {};
    const name = p.provider || "DeepSeek";
    const caps = p.capabilities || {};
    const lines = [];

    lines.push("Language rule:");
    lines.push("- If the user writes in Chinese or the conversation is predominantly Chinese, use Simplified Chinese for user-visible answers, exposed reasoning/status text, and progress narration.");
    lines.push("- Keep code identifiers, command names, file paths, API names, and quoted source text in their original language.");
    lines.push("");

    lines.push(`You are running through ${name}.`);

    const internalWebToolsConfigured = !caps.hostedTools && caps.internalWebTools !== false;
    const hasInternalWebTools = options.internalWebTools !== false && internalWebToolsConfigured;

    // Capability summary
    if (!caps.hostedTools && (hasInternalWebTools || !internalWebToolsConfigured)) {
        lines.push("This route does NOT support provider-hosted tools such as OpenAI web_search_preview.");
        if (hasInternalWebTools) {
            lines.push("For web search and URL fetching, use the translator-provided internal web_search and web_fetch tools below.");
            lines.push("Do not say web_search or web_fetch is unavailable merely because hosted tools are unsupported.");
        } else if (!internalWebToolsConfigured) {
            lines.push("No translator-provided web tools are configured. If a request needs web access, pause the workflow and ask the user to manually take over.");
        }
    }
    if (!caps.vision) {
        lines.push("This route does NOT support vision / image understanding.");
        lines.push("When a request needs unsupported non-web capabilities, pause the workflow and ask the user to manually take over. Give a concrete handoff instruction.");
    }

    // Internal tools available
    if (hasInternalWebTools) {
        const searchChoice = getToolChoiceForRole("web_search", PROFILE);
        const fetchChoice = getToolChoiceForRole("web_fetch", PROFILE);
        const searchDesc = searchChoice?.definition?.function?.description || "Search the web using the translator's local search backend.";
        const fetchDesc = fetchChoice?.definition?.function?.description || "Fetch a known URL using the translator's local fetch backend.";
        lines.push("");
        lines.push("The following internal tools are available (provided by the translator, executed locally):");
        lines.push(`- web_search(query, count?) — ${searchDesc}`);
        lines.push(`- web_fetch(url) — ${fetchDesc}`);
        lines.push("");
        lines.push("Internal web tool usage rules:");
        lines.push("- Use web_search for current facts, recent events, unknown public information, external docs, product/version checks, or anything likely to have changed.");
        lines.push("- Do not use web_search for purely local codebase facts, conversation memory, or information already present in the prompt.");
        lines.push("- Treat web_search as discovery only. After search returns candidate links, use web_fetch on the most relevant original/source pages before making specific claims.");
        lines.push("- Prefer primary sources and official docs. Avoid relying on search result snippets when an original page can be fetched.");
    lines.push("- If search/fetch fails or returns weak evidence, say that web access is unavailable or inconclusive instead of guessing.");
    lines.push("- Include source URLs in the answer whenever web tools materially affect the answer.");
    lines.push("- Only say web_search or web_fetch is unavailable after an actual web_search/web_fetch tool call returned a failure. Shell/exec_command network failure is not web_search failure.");
    }

    lines.push("");
    lines.push("Tool evidence honesty rule:");
    lines.push("- Never claim that you searched, fetched, opened, read, inspected, or ran something unless a corresponding tool call/result exists in this turn or the provided conversation history.");
    lines.push("- Do not say a search is running in the background. Tool execution is only real when the host/tool result is present.");
    lines.push("- For requests like 找一找, 搜索, 查案例, 看看 GitHub, use an available web_search/web_fetch/browser/shell tool before giving concrete external examples or URLs.");
    lines.push("- If no suitable tool is available or the tool fails, say plainly that you do not have actual search results in this turn and ask for a URL or permission/input as needed.");
    lines.push("- Do not invent URLs, repositories, examples, or source claims from memory when the user asked to search.");
    lines.push("- Never convert shell, curl, npm, browser, or exec_command network failures into \"web_search unavailable\" unless web_search itself was actually called and failed.");
    lines.push("- Do not claim you switched to a different execution/authentication mode (token, browser, SSH, API key, local bridge, etc.) unless the actual tool command, arguments, or output shows that mode was used. If you only intend to switch modes, say it as a plan and then call the matching tool.");
    lines.push("- Do not end a turn with a future-action promise such as \"now I will read\", \"next I will patch\", \"开始读文件\", \"准备打补丁\", or \"继续处理\" unless you emit the matching tool call in the same response.");
    lines.push("- If the next step is to read, inspect, run, edit, patch, write, or verify, call the appropriate tool now. If you cannot call the tool, say exactly why and do not claim the action is about to happen.");
    lines.push("- After a tool failure, either retry with a valid tool call in the same turn or give a final factual blocker. Do not reply only with a promise to retry later.");

    lines.push("");
    lines.push("Local file reading efficiency rule:");
    lines.push("- Do not read large source files or documents in full just to prove you inspected them.");
    lines.push("- Before reading a potentially large file, use wc, rg, grep, ls, or a targeted symbol search to locate relevant sections.");
    lines.push("- Prefer bounded reads such as sed -n on specific line ranges. Read the whole file only when it is clearly small or the user explicitly asks for the full file.");
    lines.push("- If a command output is clipped or too large, narrow the query instead of repeating the full read.");

    lines.push("");
    lines.push("Connector / app plugin rule:");
    lines.push("- Installed connector-type plugins are shared from the Codex public host.");
    lines.push("- Some connector plugins expose tools only after the connector has been activated and the host has synced app tools into the current session.");
    lines.push("- If a connector-type plugin is installed but its actual tools are absent from the current thread, do NOT inspect local plugin files, cache files, or guessed MCP registrations to answer.");
    lines.push("- In that case, treat it as: connector metadata exists, but connector tools are not active in this session yet.");
    lines.push("- Do not claim that DeepSeek or this route inherently lacks the connector unless the host explicitly says so.");
    lines.push("- Instead, tell the user the connector likely needs to be connected/reconnected in Codex Settings > Apps & Connectors and then retried in a fresh thread.");
    lines.push("- When an explicit app mention like [$name](app://connector_id) is already present and app tools are available, use them normally.");

    const localFeatures = localFeatureSummary();
    const skillCount = Number(localFeatures?.skills?.count) || 0;
    const mcpNames = Array.isArray(localFeatures?.mcp?.names) ? localFeatures.mcp.names : [];
    const connectorFiles = Number(localFeatures?.snapshots?.connectorDirectoryFiles) || 0;
    const appToolFiles = Number(localFeatures?.snapshots?.appToolsCacheFiles) || 0;
    lines.push("");
    lines.push("Anti-Codex local feature inventory:");
    lines.push(`- Local Skills copied into this Anti-Codex home: ${skillCount}. If a user task clearly matches a Skill and its SKILL.md is available in the host context, use that Skill's instructions before acting.`);
    lines.push(`- Local MCP servers configured in this Anti-Codex home: ${mcpNames.length}${mcpNames.length ? ` (${mcpNames.slice(0, 8).join(", ")})` : ""}. Use MCP tools only when the host exposes them in the current tool list; never invent an MCP call.`);
    lines.push(`- Connector/app snapshots visible locally: connectors ${connectorFiles}, app-tool cache ${appToolFiles}. Snapshot presence is metadata, not proof that a remote app tool is callable.`);

    lines.push("");
    lines.push("Workspace rule:");
    lines.push("- This Anti-Codex route uses its own workspace/state root.");
    lines.push("- Treat the current thread workspace as authoritative.");
    lines.push("- If the user explicitly chooses or creates a directory, do not override it with a guessed default path.");
    lines.push("- Do not assume the same recent-project roots or default workspace layout as standard Codex.");
    lines.push("- Keep workspace/path issues separate from plugin or connector activation issues.");

    lines.push("");
    lines.push("macOS permission-sensitive action rule:");
    lines.push("- When an action may trigger a macOS system prompt or authorization sheet, do not use a very short-lived command.");
    lines.push("- Typical sensitive actions include: starting a local listener/server on localhost or 127.0.0.1, launching a browser/system app, opening local files in external apps, or invoking local renderers that spawn browsers/encoders.");
    lines.push("- For these actions, prefer a stable long-lived process and keep the triggering process alive for at least 15 seconds before assuming failure or cleaning it up.");
    lines.push("- Do not immediately replace a just-started local server with another server on a different port unless the first attempt clearly failed.");
    lines.push("- If a permission prompt may be pending, tell the user to click Allow and wait instead of rapidly retrying with alternate commands.");

    lines.push("");
    lines.push("Windows Node command rule:");
    lines.push("- On Windows, never launch npm, npx, pnpm, or yarn through bare Start-Process -FilePath names.");
    lines.push("- Use npm.cmd, npx.cmd, pnpm.cmd, or yarn.cmd explicitly; for long-running tools prefer cmd.exe /d /s /c \"npx.cmd ...\".");
    lines.push("- Do not prepend C:\\Program Files\\nodejs to PATH to find these commands. Anti-Codex already provides command shims at the front of PATH.");
    lines.push("- If an existing command uses Start-Process -FilePath \"npx\" or \"npm\", rewrite it to the .cmd executable before running.");

    lines.push("");
    lines.push("Freeform patch tool rule:");
    lines.push("- apply_patch is a freeform patch tool, not a JSON command tool.");
    lines.push("- When using apply_patch through this DeepSeek route, call it with {\"content\":\"*** Begin Patch\\n...\\n*** End Patch\"}; the content value must be the complete patch body.");
    lines.push("- The patch body must use Codex apply_patch grammar exactly: after \"*** Begin Patch\", each file hunk starts with exactly one of \"*** Add File: <path>\", \"*** Delete File: <path>\", or \"*** Update File: <path>\".");
    lines.push("- Inside an update hunk, use \"@@\" or \"@@ <context>\" followed by unchanged lines prefixed with space, removed lines prefixed with \"-\", and added lines prefixed with \"+\".");
    lines.push("- Never use narrative hunk headers such as \"*** Update Projections\", ordinary unified-diff headers such as \"--- a/file\" or \"+++ b/file\", line-number replacement instructions, or Markdown prose inside the patch body.");
    lines.push("- Every apply_patch body must end with a final line exactly equal to \"*** End Patch\".");
    lines.push("- Never call apply_patch with {}, an empty content string, or explanatory text instead of a patch.");
    lines.push("- If an apply_patch call fails because the patch body is missing or invalid, immediately regenerate one valid full patch using the exact grammar above, or stop and explain the blocker.");
    lines.push("- Do not bypass apply_patch by writing or rewriting source files with shell commands merely because apply_patch formatting failed.");

    lines.push("");
    lines.push("Markdown formatting rule:");
    lines.push("- When showing a URL or local address, prefer plain text or inline code and do not wrap the URL in bold or other decorative Markdown.");

    const scopedLines = hasInternalWebTools
        ? lines
        : lines.filter((line) => !/(?:web_search|web_fetch|\bweb\b|\bsearch(?:ed|ing| results?)?\b|\bfetched\b|\bURLs?\b)/i.test(line));
    return scopedLines.join("\n");
}

// ──────────────────────────────────────────── Responses → Chat translation ───

function shouldNormalizeDeepSeek(body) {
    const provider = String(PROFILE?.provider || "").toLowerCase();
    const model = String(body?.model || "").toLowerCase();
    return provider === "deepseek" || model.includes("deepseek");
}

function normalizeUpstreamBody(body) {
    if (!body || typeof body !== "object") return body;
    if (!shouldNormalizeDeepSeek(body)) return body;
    let b = body;
    const aliases = PROFILE?.legacyAliases || PROFILE?.defaults?.legacyAliases || {};
    const rawAlias = aliases[String(body.model || "").trim().toLowerCase()];
    const alias = rawAlias
        ? { model: rawAlias.model === "fast" ? (PROFILE?.fastModel || "deepseek-v4-flash") : rawAlias.model === "default" ? (PROFILE?.defaultModel || "deepseek-v4-pro") : rawAlias.model, thinkingType: rawAlias.thinking }
        : { "deepseek-chat": { model: "deepseek-v4-flash", thinkingType: "disabled" }, "deepseek-reasoner": { model: "deepseek-v4-flash", thinkingType: "enabled" } }[String(body.model || "").trim().toLowerCase()];
    if (alias) { b = { ...body, model: alias.model }; if (!b.thinking || typeof b.thinking !== "object") b.thinking = { type: alias.thinkingType }; }
    if (!b.thinking || typeof b.thinking !== "object") b = { ...b, thinking: { type: "disabled" } };
    return b;
}

function clipForLog(value, limit = 500) {
    let text = "";
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value || "");
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function messageContentSummary(content) {
    if (typeof content === "string") return clipForLog(content);
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (!part || typeof part !== "object") return typeof part;
            const type = part.type || "part";
            if (typeof part.text === "string") return `${type}:${clipForLog(part.text, 160)}`;
            if (part.image_url || part.input_image || part.image) return `${type}:[image omitted]`;
            return type;
        }).join(" | ");
    }
    if (content === null || content === undefined) return "";
    return clipForLog(content);
}

function messageSummary(message) {
    if (!message || typeof message !== "object") return null;
    return {
        role: message.role || null,
        content: messageContentSummary(message.content),
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map(tc => tc?.function?.name || tc?.name || "unknown") : [],
        toolCallId: message.tool_call_id || null,
    };
}

function requestToolNames(tools) {
    return (tools || []).map((tool) => tool?.function?.name || tool?.name || "unknown");
}

function requestSummary(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const lastUser = [...messages].reverse().find(message => message?.role === "user");
    return {
        model: body?.model,
        stream: body?.stream,
        tool_choice: body?.tool_choice,
        thinking: body?.thinking?.type,
        tools_count: tools.length,
        tools: requestToolNames(tools),
        has_web_search: requestToolNames(tools).includes("web_search"),
        has_web_fetch: requestToolNames(tools).includes("web_fetch"),
        messages_count: messages.length,
        message_roles: messages.map(message => message?.role || "unknown"),
        message0: messageSummary(messages[0]),
        last_user: messageSummary(lastUser),
    };
}

function responseSummary(status, json, text = "") {
    const choice = json?.choices?.[0] || {};
    const msg = choice.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    return {
        status,
        finish_reason: choice.finish_reason || null,
        has_tool_calls: toolCalls.length > 0,
        tool_calls: toolCalls.map(tc => tc?.function?.name || tc?.name || "unknown"),
        content: messageContentSummary(msg.content),
        reasoning: typeof msg.reasoning_content === "string" ? clipForLog(msg.reasoning_content, 200) : "",
        usage: json?.usage || null,
        raw: json ? "" : clipForLog(text, 500),
    };
}

function usageDiagnostics(usage) {
    if (!usage || typeof usage !== "object") return null;
    const input = Number(usage.prompt_tokens || 0);
    const output = Number(usage.completion_tokens || 0);
    const hit = Number(
        usage.prompt_cache_hit_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.cache_hit_tokens ??
        0
    );
    const miss = Number(usage.prompt_cache_miss_tokens ?? usage.cache_miss_tokens ?? Math.max(0, input - hit));
    const flags = [];
    if (input > 200_000) flags.push("prompt_explosion");
    if (input > 0 && output === 0) flags.push("zero_completion");
    if (input > 0 && hit === 0 && input > 50_000) flags.push("cache_miss_large_prompt");
    return { input, output, total: Number(usage.total_tokens || input + output), cache_hit: hit, cache_miss: miss, flags };
}

function classifyUpstreamFailure(status, text = "", json = null) {
    const message = String(json?.error?.message || text || "");
    const antigravityAccountVerification = isAntigravityUpstreamMode(UPSTREAM_MODE) && isAntigravityAccountVerificationRequired(message);
    const transientStatus = status === 429 || status === 502 || status === 503 || status === 504;
    const transientText = /connection reset|econnreset|etimedout|timeout|temporarily unavailable|overloaded|rate limit|too many requests|bad gateway|service unavailable|gateway timeout|\beof\b/i.test(message);
    const protocolText = /invalid_request_error|messages with role 'tool'|tool_calls must be followed|content should be a string or a list|failed to deserialize|missing field|unsupported.*tool|invalid.*tool|schema/i.test(message);
    const authText = status === 401 || status === 403 || /unauthorized|authorization|invalid api key|incorrect api key|authentication|permission[ _-]denied|forbidden|rejected/i.test(message);
    const quotaText = /insufficient quota|billing|payment|required balance|402|quota/i.test(message);
    let type = "upstream_error";
    if (antigravityAccountVerification) type = "antigravity_account_unavailable";
    else if (protocolText) type = "protocol_or_translation_error";
    else if (authText) type = "auth_error";
    else if (quotaText || status === 402) type = "quota_or_billing_error";
    else if (transientStatus || transientText) type = "transient_upstream_error";
    return {
        type,
        status,
        retryable: type === "transient_upstream_error",
        ...(antigravityAccountVerification ? { diagnosis: "account_verification_required" } : {}),
        message: clipForLog(redactUpstreamSecretText(message || `Upstream ${status}`), 500),
        hint: type === "protocol_or_translation_error"
            ? "Check Responses↔Chat message/tool ordering and schema conversion."
            : type === "antigravity_account_unavailable"
                ? "Open Antigravity Desktop, complete account verification, then retry."
            : type === "transient_upstream_error"
                ? "Upstream/network transient failure; retry is safe only before partial tool output is emitted."
            : type === "quota_or_billing_error"
                ? "Antigravity 账号额度/限额可能已到。请切换 Antigravity 账号，或等待额度恢复后重试。"
                : "",
        raw_type: json?.error?.type || null,
        raw_code: json?.error?.code || null,
    };
}

function debugUpstreamRequest(label, body) {
    if (!DEBUG_UPSTREAM) return null;
    const id = `${Date.now().toString(36)}-${++DEBUG_REQUEST_SEQ}`;
    console.error(`[adaptive][upstream][${id}][${label}] request ${JSON.stringify(requestSummary(body))}`);
    return id;
}

function debugUpstreamResponse(id, status, json, text) {
    if (!DEBUG_UPSTREAM || !id) return;
    const safeJson = redactUpstreamFailure(json);
    const safeText = redactUpstreamSecretText(text);
    const summary = responseSummary(status, safeJson, safeText);
    if (json?.usage) summary.usage_diagnostics = usageDiagnostics(json.usage);
    if (status >= 400) summary.failure = classifyUpstreamFailure(status, safeText, safeJson);
    console.error(`[adaptive][upstream][${id}] response ${JSON.stringify(summary)}`);
}

function recordProviderModelRoute(entry = {}) {
    if (isAntigravityUpstreamMode(UPSTREAM_MODE)) return null;
    const profile = activeUpstreamProfile({ model: entry.resolvedModel || entry.requestedModel || "" });
    return ANTIGRAVITY_MODEL_ROUTE_AUDIT.record({
        requestId: entry.requestId || "",
        transport: "upstream-provider",
        provider: profile.provider || UPSTREAM_PROTOCOL || "third-party",
        providerProtocol: profile.protocol || UPSTREAM_PROTOCOL || "",
        requestedModel: entry.requestedModel || profile.model || "",
        resolvedModel: entry.resolvedModel || profile.model || entry.requestedModel || "",
        displayName: entry.displayName || entry.resolvedModel || profile.model || entry.requestedModel || "",
        status: entry.status || "success",
    });
}

async function postChatCompletion(body, label) {
    const normalized = normalizeUpstreamBody(body);
    const debugId = debugUpstreamRequest(label, normalized);
    const upstreamRequest = buildUpstreamChatRequest(activeUpstreamProfile({ model: normalized.model }), normalized);
    const res = await fetch(upstreamRequest.url, {
        method: "POST",
        headers: upstreamRequest.headers,
        body: JSON.stringify(upstreamRequest.body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (res.ok && json) json = convertUpstreamChatResponse(activeUpstreamProfile({ model: normalized.model }), json);
    if (res.ok && json) {
        recordProviderModelRoute({
            requestId: json.id,
            requestedModel: normalized.model,
            resolvedModel: json.model || normalized.model,
            status: "success",
        });
    }
    debugUpstreamResponse(debugId, res.status, json, text);
    return { res, text, json };
}

function redactUrlForHealth(value) {
    const raw = String(value || "");
    if (!raw) return "";
    try {
        const parsed = new URL(raw);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString().replace(/\/$/, "");
    } catch {
        return raw.replace(/[?#].*$/, "").replace(/\/$/, "");
    }
}

function summarizeConnectionStages(capabilities = {}) {
    const stages = Array.isArray(capabilities?.connectionStages) ? capabilities.connectionStages : [];
    if (!stages.length) return { present: false, failCount: 0, warnCount: 0, okCount: 0, stages: [] };
    const sanitized = sanitizedConnectionStages(stages);
    return {
        present: true,
        failCount: sanitized.filter((stage) => stage.status === "fail").length,
        warnCount: sanitized.filter((stage) => stage.status === "warn").length,
        okCount: sanitized.filter((stage) => stage.status === "ok").length,
        stages: sanitized,
    };
}

function currentUpstreamHealthProfile() {
    if (isAntigravityUpstreamMode(UPSTREAM_MODE)) {
        return {
            mode: "antigravity",
            model: PROFILE?.defaultModel || PROFILE?.model || "",
            provider: PROFILE?.provider || "antigravity",
        };
    }
    const saved = readJsonIfPresent(ANTICODEX_STATE_ROOT
        ? resolvePath(ANTICODEX_STATE_ROOT, "upstream-profile.json")
        : "") || {};
    const capabilities = saved?.mode === "third-party" && saved.capabilities
        ? saved.capabilities
        : (PROFILE?.capabilities || {});
    return {
        mode: "third-party",
        protocol: UPSTREAM_PROTOCOL,
        baseUrl: redactUrlForHealth(UPSTREAM),
        model: UPSTREAM_MODEL || PROFILE?.defaultModel || PROFILE?.model || "",
        provider: PROFILE?.provider || UPSTREAM_PROTOCOL,
        lastTestStatus: saved?.lastTestStatus || "",
        lastTestAt: saved?.lastTestAt || "",
        capabilitySummary: summarizeConnectionStages(capabilities),
    };
}

function upstreamProfileScriptPath() {
    const scriptPath = resolvePath(MANAGER_SCRIPTS_ROOT, "anticodex-upstream-profile.ps1");
    if (!existsSync(scriptPath)) {
        const error = new Error("Missing Anti-Codex upstream profile script.");
        error.statusCode = 500;
        throw error;
    }
    return scriptPath;
}

async function runUpstreamProfileScript(action, values = {}, options = {}) {
    const args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        upstreamProfileScriptPath(),
        "-Action",
        action,
    ];
    const addArg = (name, value) => {
        if (value === undefined || value === null) return;
        args.push("-" + name, String(value));
    };
    addArg("StateRoot", ANTICODEX_STATE_ROOT);
    addArg("Protocol", values.protocol);
    addArg("BaseUrl", values.baseUrl);
    addArg("Model", values.model);
    addArg("TestStatus", values.testStatus);
    addArg("CapabilitiesJson", values.capabilitiesJson);
    const { stdout } = await execFileAsync(powershellPath(), args, {
        cwd: MANAGER_SCRIPTS_ROOT,
        timeout: options.timeoutMs || 15_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
            ...process.env,
            ...(values.apiKey ? { ANTICODEX_UPSTREAM_API_KEY_INPUT: String(values.apiKey) } : {}),
        },
    });
    return parseJsonFromScriptOutput(stdout) || {};
}

function sanitizedConnectionStages(stages = []) {
    return stages.map((stage) => ({
        stage: String(stage?.stage || ""),
        status: String(stage?.status || ""),
        detail: String(stage?.detail || ""),
        ...(Array.isArray(stage?.models)
            ? { models: stage.models.map((model) => String(model || "")).filter(Boolean).slice(0, 200) }
            : {}),
    }));
}

function providerModelIdsFromConnectionStages(stages = [], configuredModel = "") {
    const ids = [];
    const seen = new Set();
    const add = (value) => {
        const id = String(value || "").trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    add(configuredModel);
    for (const stage of stages) {
        if (!Array.isArray(stage?.models)) continue;
        for (const model of stage.models) add(model);
    }
    return ids.slice(0, 200);
}

function hasPseudoToolMarkup(content) {
    const text = String(content || "");
    return /<[\s｜|]*DSML[\s｜|]*(tool_calls|invoke|parameter)\b/i.test(text)
        || /<(tool_calls|tool_call|invoke|parameter|tool_name|parameters)\b/i.test(text);
}

function stripPseudoToolMarkup(content) {
    return String(content || "")
        .replace(/<[\s｜|]*DSML[\s｜|]*tool_calls>[\s\S]*?<\/[\s｜|]*DSML[\s｜|]*tool_calls>/g, "")
        .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
        .trim();
}

function sanitizeMarkdownUrlFormatting(content) {
    return String(content || "")
        .replace(/\*\*([^\n*]{0,12})((?:https?:\/\/|localhost:|127\.0\.0\.1:)[^\s*<>()]+?\/?)\*\*/g, "$1$2")
        .replace(/`((?:https?:\/\/|localhost:|127\.0\.0\.1:)[^`\s]+?)\/\*\*`/g, "`$1/`");
}

function clipForPrompt(value, limit = 2000) {
    let text = "";
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value || "");
    }
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function unknownInputItemText(item) {
    if (!item || typeof item !== "object") return "";
    const type = String(item.type || "unknown");
    const safe = { ...item };
    for (const key of ["data", "image", "image_url", "screenshot", "screenshot_bytes", "encrypted_content"]) {
        if (safe[key]) safe[key] = `[${key} omitted]`;
    }
    return [
        `Previous Codex input item (${type}) was preserved by the translator as text because this route has no native mapping for that item type.`,
        clipForPrompt(safe),
    ].join("\n");
}

function parsePseudoToolCalls(content) {
    const text = String(content || "");
    if (!text.includes("tool_calls") && !text.includes("tool_call") && !text.includes("invoke")) return [];
    const calls = [];
    const invokeRe = /<[\s｜|]*DSML[\s｜|]*invoke\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[\s｜|]*DSML[\s｜|]*invoke>|<invoke\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/g;
    let match;
    while ((match = invokeRe.exec(text))) {
        const name = match[1] || match[3] || "";
        if (!name) continue;
        const body = match[2] || match[4] || "";
        const args = {};
        const paramRe = /<[\s｜|]*DSML[\s｜|]*parameter\b([^>]*)>([\s\S]*?)<\/[\s｜|]*DSML[\s｜|]*parameter>|<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/g;
        let param;
        while ((param = paramRe.exec(body))) {
            const attrs = param[1] || param[3] || "";
            const rawValue = param[2] || param[4] || "";
            const nameMatch = attrs.match(/\bname=["']([^"']+)["']/);
            if (!nameMatch) continue;
            let value = rawValue.trim();
            if (attrs.match(/\b(integer|number)=["']true["']/)) {
                const n = Number(value);
                args[nameMatch[1]] = Number.isFinite(n) ? n : value;
            } else if (attrs.match(/\b(boolean)=["']true["']/)) {
                args[nameMatch[1]] = value === "true";
            } else {
                args[nameMatch[1]] = value;
            }
        }
        calls.push({
            id: `pseudo_${Date.now()}_${calls.length}`,
            type: "function",
            parsed_arguments: args,
            function: { name, arguments: JSON.stringify(args) },
        });
    }
    const simpleToolCallRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/g;
    while ((match = simpleToolCallRe.exec(text))) {
        const body = match[1] || "";
        const name = (body.match(/<tool_name\b[^>]*>([\s\S]*?)<\/tool_name>/i)?.[1] || "").trim();
        if (!name) continue;
        const args = {};
        const parameters = body.match(/<parameters\b[^>]*>([\s\S]*?)<\/parameters>/i)?.[1] || "";
        const jsonish = parameters.trim();
        if (jsonish.startsWith("{")) {
            try {
                const parsed = JSON.parse(jsonish);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(args, parsed);
            } catch {
                // Fall through to tag parsing.
            }
        }
        const simpleParamRe = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
        let param;
        while ((param = simpleParamRe.exec(parameters))) {
            if (param[1] === "parameters") continue;
            args[param[1]] = param[2].trim();
        }
        calls.push({
            id: `pseudo_${Date.now()}_${calls.length}`,
            type: "function",
            parsed_arguments: args,
            function: { name, arguments: JSON.stringify(args) },
        });
    }
    return calls;
}

function schemaType(schema) {
    const type = schema?.type;
    if (Array.isArray(type)) return type.find(t => t !== "null") || type[0] || "";
    return typeof type === "string" ? type : "";
}

function validateSchemaValueType(value, type) {
    if (!type || type === "any") return true;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "string") return typeof value === "string";
    return true;
}

function coercePseudoArgumentValue(value, schema) {
    const type = schemaType(schema);
    if (type === "object" || type === "array") {
        if (typeof value === "string") {
            try {
                value = JSON.parse(value);
            } catch {
                return { ok: false, error: `expected ${type} JSON` };
            }
        }
        return validateSchemaValueType(value, type)
            ? { ok: true, value }
            : { ok: false, error: `expected ${type}` };
    }
    if (type === "integer" || type === "number") {
        const n = typeof value === "number" ? value : Number(String(value).trim());
        if (!Number.isFinite(n)) return { ok: false, error: `expected ${type}` };
        if (type === "integer" && !Number.isInteger(n)) return { ok: false, error: "expected integer" };
        return { ok: true, value: n };
    }
    if (type === "boolean") {
        if (typeof value === "boolean") return { ok: true, value };
        const normalized = String(value).trim().toLowerCase();
        if (normalized === "true") return { ok: true, value: true };
        if (normalized === "false") return { ok: true, value: false };
        return { ok: false, error: "expected boolean" };
    }
    if (type === "string") {
        return { ok: true, value: typeof value === "string" ? value : String(value) };
    }
    return { ok: true, value };
}

function coercePseudoArgumentsForRoute(args, route) {
    const schema = route?.parameters;
    if (!schema || typeof schema !== "object") return { ok: true, args };
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
        if (!Object.prototype.hasOwnProperty.call(args, name)) {
            return { ok: false, error: `missing required parameter "${name}"` };
        }
    }
    if (schema.additionalProperties === false) {
        for (const name of Object.keys(args)) {
            if (!Object.prototype.hasOwnProperty.call(properties, name)) {
                return { ok: false, error: `unexpected parameter "${name}"` };
            }
        }
    }
    const coerced = { ...args };
    for (const [name, propSchema] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(coerced, name)) continue;
        const result = coercePseudoArgumentValue(coerced[name], propSchema);
        if (!result.ok) return { ok: false, error: `parameter "${name}" ${result.error}` };
        coerced[name] = result.value;
    }
    return { ok: true, args: coerced };
}

function unavailableToolMessage(name) {
    return `Anti-Codex rejected an unavailable tool request "${name}". That tool is not available in this Codex session; retry with one of the exposed Codex tools or answer directly.`;
}

function invalidToolArgumentsMessage(name, reason) {
    return `Anti-Codex rejected tool request "${name}": ${reason}. Retry with the exact parameters from the exposed Codex tool schema.`;
}

function messageOutput(text) {
    return { type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function hasMessageContent(content) {
    if (typeof content === "string") return content.length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return content !== null && content !== undefined;
}

function normalizeChatContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content;
    if (content === null || content === undefined) return "";
    try { return JSON.stringify(content); } catch { return String(content); }
}

function sanitizeChatMessages(messages) {
    const sanitized = [];
    for (const message of messages || []) {
        if (!message || typeof message !== "object") continue;
        const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        if (message.role === "assistant") {
            if (hasTools) {
                sanitized.push({ ...message, content: normalizeChatContent(message.content) });
            } else if (hasMessageContent(message.content)) {
                sanitized.push({ ...message, content: normalizeChatContent(message.content) });
            }
            continue;
        }
        const content = normalizeChatContent(message.content);
        if (!hasMessageContent(content)) continue;
        sanitized.push({ ...message, content });
    }
    return sanitized;
}

function normalizeMessageRole(role) {
    if (role === "developer") return "system";
    if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
    return "system";
}

function missingToolResultMessage(toolCallId) {
    return {
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify({
            ok: false,
            error: "tool_call_interrupted",
            user_visible_guidance: "This tool call did not complete successfully in the previous turn. Continue without assuming a successful tool result.",
        }),
    };
}

function ensureToolCallResponses(messages) {
    const output = [];
    let pendingIds = [];
    let pendingSet = new Set();
    let buffered = [];

    const flushPending = () => {
        if (pendingIds.length === 0) return;
        for (const id of pendingIds) {
            if (!id || !pendingSet.has(id)) continue;
            output.push(missingToolResultMessage(id));
        }
        output.push(...buffered);
        pendingIds = [];
        pendingSet = new Set();
        buffered = [];
    };

    for (const message of messages || []) {
        if (!message || typeof message !== "object") continue;

        if (pendingIds.length > 0) {
            if (message.role === "tool" && message.tool_call_id && pendingSet.has(message.tool_call_id)) {
                output.push(message);
                pendingSet.delete(message.tool_call_id);
                if (pendingSet.size === 0) {
                    output.push(...buffered);
                    pendingIds = [];
                    pendingSet = new Set();
                    buffered = [];
                }
                continue;
            }

            if (message.role === "tool") {
                continue;
            }

            if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                flushPending();
            } else {
                buffered.push(message);
                continue;
            }
        }

        if (message.role === "tool") {
            continue;
        }

        output.push(message);

        if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            pendingIds = message.tool_calls.map(tc => tc?.id).filter(Boolean);
            pendingSet = new Set(pendingIds);
        }
    }

    flushPending();
    return output;
}

function responsesToChatBody(parsed, options = {}) {
    const messages = [];
    const caps = PROFILE?.capabilities || {};
    const noVision = caps.vision !== true;
    const extra = typeof options.extraSystem === "string" ? options.extraSystem.trim() : "";
    const allowTools = options.allowTools !== false && parsed.tool_choice !== "none";
    const injectInternalTools = options.injectInternalTools !== false && allowTools;
    const imageText = "[Image omitted: this route does not support image inspection. Ask the user to describe the image or paste extracted text.]";

    // System prompt
    if (parsed.instructions) messages.push({ role: "system", content: parsed.instructions });
    if (extra) messages.push({ role: "system", content: extra });

    const convertBlock = (c) => {
        if (!c) return null;
        if (c.type === "text" || (c.text && c.type !== "input_image")) return { type: "text", text: c.text || "" };
        if (c.type === "input_image" || c.type === "image" || c.type === "image_url" || c.image_url) {
            if (noVision) return { type: "text", text: imageText };
            const url = c.data ? `data:${c.media_type || "image/jpeg"};base64,${c.data}` : c.image_url || c.url;
            if (url) return { type: "image_url", image_url: { url } };
            return null;
        }
        return null;
    };

    // Input → messages
    const inputItems = repairRestoredInput(parsed.input);
    if (Array.isArray(inputItems)) {
        let pendingTC = null; let pendingIds = null; const deferred = [];
        let activeReasoning = "";
        const flushD = () => { if (deferred.length > 0) { messages.push(...deferred); deferred.length = 0; } };
        const ensureF = () => { if (pendingTC) { messages.push(pendingTC); pendingIds = new Set((pendingTC.tool_calls || []).map(tc => tc.id).filter(Boolean)); pendingTC = null; } };

        for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
            const item = inputItems[itemIndex];
            if (item.type === "function_call" || item.type === "custom_tool_call") {
                if (pendingIds?.size > 0) { flushD(); pendingIds = null; }
                if (!pendingTC) {
                    const last = messages[messages.length - 1];
                    if (last?.role === "assistant" && !last.tool_calls) { pendingTC = messages.pop(); pendingTC.tool_calls = []; pendingTC.content = pendingTC.content || null; }
                    else { pendingTC = { role: "assistant", content: null, tool_calls: [] }; }
                }
                if (activeReasoning && !pendingTC.reasoning_content) pendingTC.reasoning_content = activeReasoning;
                const argumentsText = item.type === "custom_tool_call"
                    ? JSON.stringify({ content: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? "") })
                    : item.arguments || "{}";
                pendingTC.tool_calls.push({ id: item.call_id || item.id || `call_${itemIndex}`, type: "function", function: { name: item.name, arguments: argumentsText } });
            } else {
                if (item.type === "message") { ensureF(); flushD(); activeReasoning = ""; const rawRole = item.role || "user"; const role = normalizeMessageRole(rawRole); let content; if (typeof item.content === "string") content = item.content; else if (Array.isArray(item.content)) { content = item.content.map(convertBlock).filter(Boolean); if (content.length > 0 && content.every(c => c.type === "text")) content = content.map(c => c.text).join("\n"); } if (rawRole && rawRole !== role) content = `[Previous Codex message had unsupported role "${rawRole}"; preserved as ${role}.]\n${content || ""}`; if (typeof content === "string" && role !== "user" && hasPseudoToolMarkup(content)) content = stripPseudoToolMarkup(content); messages.push({ role, content: content || null }); }
                else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") { ensureF(); activeReasoning = ""; const callId = item.call_id || item.id || ""; const tc = typeof item.output === "string" ? item.output : JSON.stringify(item.output); messages.push({ role: "tool", tool_call_id: callId, content: tc }); }
                else if (item.type === "context_compaction") { ensureF(); flushD(); activeReasoning = ""; const text = readableCompactionText(item); if (text) messages.push({ role: "user", content: `${CODEX_CONTEXT_SUMMARY_PREFIX}\n\n${text}` }); }
                else if (item.type === "reasoning") { activeReasoning = PROFILE?.capabilities?.reasoningReplay === false ? "" : readableReasoningText(item); }
                else {
                    ensureF();
                    flushD();
                    activeReasoning = "";
                    const text = unknownInputItemText(item);
                    if (text) messages.push({ role: "system", content: text });
                }
            }
        }
        ensureF(); flushD();
    } else if (typeof parsed.input === "string") {
        messages.push({ role: "user", content: parsed.input });
    }

    const body = { model: resolveModel(parsed.model), messages: ensureToolCallResponses(sanitizeChatMessages(messages)), stream: false, reasoning: parsed.reasoning };

    // Tools: use translation plan with routing metadata.
    //   – function tools forward normally.
    //   – custom/freeform tools (apply_patch) forward as callable schema + routing metadata.
    //   – namespace tools are flattened into collision-safe Chat function names with routing metadata.
    //   – hosted/account-bound tools (web_search, image_generation) are dropped; internal
    //     registry tools may be injected when upstream lacks hosted capabilities.
    const internalDefs = injectInternalTools ? toolsToInject(PROFILE) : [];
    const { tools: chatTools, routing } = buildChatToolsWithRouting(parsed, {
        compact: !allowTools,
        injectInternalTools,
        internalTools: internalDefs,
    });
    if (chatTools.length > 0) body.tools = chatTools;
    if (routing && Object.keys(routing).length > 0) body._routing = routing;

    if (parsed.tool_choice) {
        if (typeof parsed.tool_choice === "string") body.tool_choice = parsed.tool_choice;
        else if (parsed.tool_choice.type === "function" && parsed.tool_choice.function) {
            const requestedName = parsed.tool_choice.function.name;
            const routedName = routing?.[requestedName]?.chatName || requestedName;
            body.tool_choice = { type: "function", function: { name: routedName } };
        }
    } else if (options.preferInternalWebToolChoice === true) {
        const preferred = preferredInternalWebToolName(parsed);
        if (preferred && chatTools.some((tool) => tool?.function?.name === preferred)) {
            body.tool_choice = { type: "function", function: { name: preferred } };
        }
    }
    if (parsed.max_output_tokens) body.max_completion_tokens = parsed.max_output_tokens;
    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
    if (parsed.top_p !== undefined) body.top_p = parsed.top_p;

    return body;
}

function prepareCompactChatBody(chatBody) {
    return {
        ...chatBody,
        stream: false,
        tools: undefined,
        tool_choice: "none",
        messages: [
            { role: "system", content: CODEX_LOCAL_COMPACT_PROMPT },
            ...(chatBody.messages || []),
        ],
    };
}

function extractAssistantText(json) {
    const msg = json.choices?.[0]?.message || {};
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map(part => typeof part === "string" ? part : part?.text || "").join("");
    return "";
}

function compactFallbackTextFromRequest(original) {
    const req = originalRequestFromArg(original);
    const lines = [];
    const pushText = (label, value) => {
        const text = String(value || "").trim();
        if (text) lines.push(`${label}: ${text}`);
    };
    const textFromContent = (content) => {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(part => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
        }
        return "";
    };
    for (const item of Array.isArray(req.input) ? req.input : []) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "message") {
            pushText(`${item.role || "message"} message`, textFromContent(item.content));
        } else if (item.type === "function_call" || item.type === "custom_tool_call") {
            pushText("tool call", `${item.name || "unknown"} ${item.arguments || item.input || ""}`);
        } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
            pushText(`tool result ${item.call_id || ""}`.trim(), typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""));
        } else if (item.type === "context_compaction") {
            pushText("previous context summary", readableCompactionText(item));
        }
    }
    const text = lines.join("\n\n").trim();
    return text.length > 6000 ? `...[earlier compact input omitted]\n${text.slice(-6000)}` : text;
}

function normalizeCompactSummary(text, fallbackText = "") {
    let summary = String(text || "").trim();
    const fence = summary.match(/^```(?:json|markdown|text)?\s*([\s\S]*?)\s*```$/i);
    if (fence) summary = fence[1].trim();
    if (summary.startsWith("{") && summary.endsWith("}")) {
        try {
            const parsed = JSON.parse(summary);
            const nested = parsed.summary || parsed.context_compaction || parsed.content || parsed.text;
            if (typeof nested === "string" && nested.trim()) summary = nested.trim();
        } catch {}
    }
    const weak = /^(好的|好|已理解|明白|收到|ok|okay)[，。,.\s]*(我会|会|将|I'll|I will)?/i;
    if (!summary || weak.test(summary) || summary.length < 24) {
        const fallback = String(fallbackText || "").trim();
        if (fallback) {
            return [
                "上游模型没有返回可用的压缩摘要。以下内容从本次 compact 输入中恢复，用于继续当前任务；不要重新做项目发现，优先接着最后一个具体动作继续。",
                "",
                fallback,
            ].join("\n");
        }
        return [
            "Compact summary unavailable: the upstream model returned an acknowledgement or an underspecified summary.",
            "Continue using the remaining thread context and local workspace state; do not assume omitted details were intentionally discarded.",
        ].join("\n");
    }
    return summary;
}

function chatToCompactResponseFormat(json, model, original = null) {
    const summary = normalizeCompactSummary(extractAssistantText(json), compactFallbackTextFromRequest(original));
    return {
        id: json.id || `resp_${Date.now()}`,
        object: "response",
        created_at: json.created || Math.floor(Date.now() / 1000),
        model,
        status: "completed",
        output: [{ type: "context_compaction", summary }],
        usage: { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0, total_tokens: json.usage?.total_tokens || 0 },
    };
}

function responseId() { return `resp_${randomUUID().replaceAll("-", "")}`; }
function reasoningId() { return `rs_${randomUUID().replaceAll("-", "")}`; }
function messageId() { return `msg_${randomUUID().replaceAll("-", "")}`; }
function functionCallId() { return `fc_${randomUUID().replaceAll("-", "")}`; }

function encodeReasoningContent(content) {
    return REASONING_BLOB_PREFIX + Buffer.from(String(content || ""), "utf8").toString("hex");
}

function decodeReasoningContent(blob) {
    const text = String(blob || "");
    if (!text.startsWith(REASONING_BLOB_PREFIX)) return "";
    const hex = text.slice(REASONING_BLOB_PREFIX.length);
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return "";
    try { return Buffer.from(hex, "hex").toString("utf8"); } catch { return ""; }
}

function mapUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const input = Number(usage.prompt_tokens || 0);
    const output = Number(usage.completion_tokens || 0);
    const total = Number(usage.total_tokens || input + output);
    const cached = Number(
        usage.prompt_tokens_details?.cached_tokens ??
        usage.prompt_cache_hit_tokens ??
        usage.cache_hit_tokens ??
        0
    );
    return {
        input_tokens: input,
        input_tokens_details: {
            cached_tokens: cached,
        },
        output_tokens: output,
        output_tokens_details: {
            reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0),
        },
        total_tokens: total,
    };
}

function estimateInputTokens(parsed) {
    const text = clipForPrompt(parsed, 1_000_000);
    // Conservative local estimate: Codex only needs a stable shape here;
    // upstream-specific tokenization is not available inside the translator.
    return Math.max(1, Math.ceil(text.length / 4));
}

function inputTokensResponse(parsed) {
    const inputTokens = estimateInputTokens(parsed);
    return {
        object: "response.input_tokens",
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
    };
}

function emptyInputItemsResponse() {
    return {
        object: "list",
        data: [],
        first_id: null,
        last_id: null,
        has_more: false,
    };
}

function cancelledResponse(id) {
    return {
        id: id || responseId(),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "cancelled",
        error: null,
        incomplete_details: null,
        output: [],
        usage: null,
    };
}

function responseStatus(finishReason) {
    if (finishReason === "length" || finishReason === "content_filter") return "incomplete";
    return "completed";
}

function incompleteDetails(finishReason) {
    if (finishReason === "length") return { reason: "max_output_tokens" };
    if (finishReason === "content_filter") return { reason: "content_filter" };
    return null;
}

function originalRequestFromArg(original) {
    if (original && typeof original === "object") return original;
    return { model: original || "gpt-5.5" };
}

function readableCompactionText(item) {
    if (!item || typeof item !== "object") return "";
    for (const key of ["summary", "text", "content", "context_compaction"]) {
        const value = item[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (Array.isArray(value)) {
            const text = value.map(part => typeof part === "string" ? part : part?.text || "").join("\n").trim();
            if (text) return text;
        }
    }
    return "";
}

function isDamagedCompactionItem(item) {
    return item?.type === "context_compaction" && !item.encrypted_content && !readableCompactionText(item);
}

function damagedCompactionSummary() {
    return [
        "Anti-Codex detected a damaged previous context_compaction item with no summary/text/content.",
        "The exact earlier compressed history is unavailable, so noisy restored tool outputs, render logs, image payload records, and developer/system fragments after that damaged checkpoint were omitted before sending context to the model.",
        "Continue from the remaining user/assistant text and current local workspace state. If a concrete file, command, or artifact is missing, inspect the workspace directly instead of assuming the old tool output was reliable.",
    ].join("\n");
}

function clipRestoredToolOutput(item) {
    if (!item || typeof item !== "object" || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) return item;
    const originalOutput = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    const output = normalizeRestoredToolOutput(stripVolatileToolOutput(originalOutput));
    if (output.length <= MAX_RESTORED_TOOL_OUTPUT_CHARS) {
        return output === originalOutput ? item : { ...item, output };
    }
    return {
        ...item,
        output: [
            output.slice(0, MAX_RESTORED_TOOL_OUTPUT_CHARS),
            `...[older tool output clipped by Anti-Codex translator: ${output.length - MAX_RESTORED_TOOL_OUTPUT_CHARS} chars omitted]`,
        ].join("\n"),
    };
}

function normalizeRestoredToolOutput(output) {
    const text = String(output || "").trim();
    if (!text) {
        return "[Anti-Codex tool result: command completed with no stdout after removing transport noise.]";
    }
    if (isSuccessfulPatchOutput(text)) {
        return summarizeSuccessfulPatchOutput(text);
    }
    if (isImportantToolError(text)) return text;
    const limit = restoredOutputFoldLimit(text);
    if (!limit || text.length <= limit) return text;
    const headChars = Math.floor(limit * 0.62);
    const tailChars = limit - headChars;
    return [
        text.slice(0, headChars).trimEnd(),
        `\n...[Anti-Codex folded ${text.length - headChars - tailChars} chars from a long restored tool output to keep prompt cache stable. Re-read the exact file/range if more context is needed.]...\n`,
        text.slice(-tailChars).trimStart(),
    ].join("");
}

function restoredOutputFoldLimit(text) {
    if (looksLikeDocumentationDump(text)) return MAX_RESTORED_DOC_OUTPUT_CHARS;
    if (looksLikeSourceDump(text)) return MAX_RESTORED_SOURCE_OUTPUT_CHARS;
    return 0;
}

function isSuccessfulPatchOutput(text) {
    return /Success\. Updated the following files:/i.test(text) && !isImportantToolError(text.replace(/Success\. Updated the following files:/i, ""));
}

function summarizeSuccessfulPatchOutput(text) {
    const files = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[AMDR]\s+/.test(line))
        .slice(0, 12);
    const suffix = files.length ? `\n${files.join("\n")}` : "";
    return `[Anti-Codex tool result: patch applied successfully.${files.length ? " Updated files:" : ""}${suffix}]`;
}

function isImportantToolError(text) {
    return [
        /\b(error|exception|traceback|failed|failure|cannot|can't|syntaxerror|typeerror|referenceerror)\b/i,
        /\b(exit code|code \d+|ERR_|ENOENT|EACCES|EPERM|ECONNREFUSED|timeout)\b/i,
        /apply_patch verification failed/i,
        /\bTS\d{4}\b/,
    ].some(re => re.test(text));
}

function looksLikeSourceDump(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 25) return false;
    const numbered = lines.filter(line => /^\s*\d+[:\t ]/.test(line)).length;
    const codeish = lines.filter(line => /[{}();=<>]|\b(function|const|let|var|import|export|class|return|case|if|else)\b/.test(line)).length;
    return numbered >= 8 || codeish / lines.length > 0.35;
}

function looksLikeDocumentationDump(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (text.length < MAX_RESTORED_DOC_OUTPUT_CHARS) return false;
    const headings = lines.filter(line => /^\s{0,3}#{1,6}\s+\S/.test(line)).length;
    const bullets = lines.filter(line => /^\s{0,4}([-*+]|\d+\.)\s+\S/.test(line)).length;
    const markdownSignals = /```|^---$|\b(SKILL|README|Usage|Install|Examples?|Protocol|Reference|指南|用法|安装|示例|协议|参考)\b/im.test(text);
    return headings >= 2 || (markdownSignals && bullets + headings >= 4);
}

function clipRestoredToolCall(item) {
    if (!item || typeof item !== "object" || item.type !== "custom_tool_call") return item;
    const originalInput = typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? "");
    if (originalInput.length <= MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS) return item;
    return {
        ...item,
        input: [
            originalInput.slice(0, MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS),
            `...[older custom tool body clipped by Anti-Codex translator: ${originalInput.length - MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS} chars omitted; use paired tool result and current files as source of truth]`,
        ].join("\n"),
    };
}

function textFromMessageContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map(part => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
    }
    return "";
}

function stripVolatileToolOutput(output) {
    return String(output || "")
        .split(/\r?\n/)
        .filter(line => ![
            /^Chunk ID:\s*/i,
            /^Wall time:\s*/i,
            /^Process exited with code\s+/i,
            /^Process running with session ID\s+/i,
            /^Original token count:\s*/i,
            /^Output:\s*$/i,
            /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\./,
            /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\./,
            /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html/,
        ].some(re => re.test(line)))
        .join("\n")
        .trim();
}

function restoredToolCallText(item) {
    if (!item || typeof item !== "object") return "";
    const args = item.type === "custom_tool_call"
        ? item.input
        : item.arguments;
    return `${item.name || ""}\n${typeof args === "string" ? args : JSON.stringify(args || "")}`;
}

function isVolatileRestoredToolCall(item) {
    if (!item || typeof item !== "object" || (item.type !== "function_call" && item.type !== "custom_tool_call")) return false;
    if (item.name === "update_plan") return true;
    const text = restoredToolCallText(item);
    if (item.name === "write_stdin" && /\bsession_id\b|\byield_time_ms\b/.test(text)) return true;
    if (item.name === "exec_command" && commandLooksLikeStatusProbe(text)) return true;
    return [
        /\bStart-Sleep\b/i,
        /\bGet-Process\b/i,
        /\bGet-WmiObject\b/i,
        /\bProcessId=\d+/i,
        /\/api\/ps\b/i,
        /\bbench_result\.txt\b/i,
        /\bProcess running with session ID\b/i,
        /\bsession_id\b/i,
    ].some(re => re.test(text));
}

function isVolatileRestoredToolOutput(item) {
    if (!item || typeof item !== "object" || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) return false;
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    return [
        /Process running with session ID/i,
        /stdin is closed for this session/i,
        /Reconnecting\.\.\.\s*\d\/\d/i,
    ].some(re => re.test(output));
}

function isVolatileRestoredMessage(item) {
    if (!item || typeof item !== "object" || item.type !== "message") return false;
    const text = textFromMessageContent(item.content);
    if (completedResultsThenStatusDetour(text)) return true;
    return [
        /^<turn_aborted>/,
        /Reconnecting\.\.\.\s*\d\/\d/i,
        /stream disconnected before completion/i,
        /可能还在跑。*等/i,
        /等会话完成/i,
        /又超时了/i,
        /while \(Get-Process/i,
    ].some(re => re.test(text.trim()));
}

function parseRestoredCommandArgs(item) {
    if (!item || typeof item !== "object" || item.type !== "function_call" || item.name !== "exec_command") return "";
    const raw = item.arguments;
    if (typeof raw !== "string") return "";
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed?.cmd === "string" ? parsed.cmd : "";
    } catch {
        return raw;
    }
}

function commandLooksLikeListing(cmd) {
    return /\b(ls|find|dir|Get-ChildItem|gci)\b/i.test(cmd);
}

function commandLooksLikeRead(cmd) {
    return /\b(cat|type|Get-Content|sed|head|tail|rg)\b/i.test(cmd);
}

function commandLooksLikeWrite(cmd) {
    return /\b(apply_patch|cat\s*>|Set-Content|Out-File|Copy-Item|Move-Item|mkdir|New-Item|touch)\b/i.test(cmd);
}

function commandLooksLikeBuildOrInstall(cmd) {
    return /\b(npm|npx|pnpm|yarn|node|go|python|pip|uv|cargo|remotion|vite|hyperframes)\b/i.test(cmd);
}

function commandLooksLikeStatusProbe(cmd) {
    const text = String(cmd || "");
    return [
        /\b(netstat|lsof|ss)\b/i,
        /\b(Get-Process|tasklist|ps\b|pgrep|pidof|Get-Service|sc\s+query)\b/i,
        /\b(Measure-Object|Select-Object\s+-ExpandProperty\s+Count)\b/i,
        /\b(curl|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,120}\b(health|status|debug\/routes|\/api\/ps|\/version)\b/i,
        /\bfindstr\b[\s\S]{0,80}:\d{2,5}/i,
    ].some(re => re.test(text));
}

function parseExitCode(output) {
    const match = String(output || "").match(/Process exited with code\s+(-?\d+)/i);
    return match ? Number(match[1]) : null;
}

function parseJsonish(value) {
    if (value == null) return null;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text || !/^[{[]/.test(text)) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function quoteFactValue(value, max = 160) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function extractCleanOutputLines(output) {
    return stripVolatileToolOutput(output)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^Microsoft Windows \[/.test(line))
        .filter(line => !/^\(c\) Microsoft Corporation/i.test(line))
        .filter(line => !/^[A-Za-z0-9_.-]+@[^>]+>/.test(line));
}

function extractLikelyPathFacts(lines) {
    const facts = [];
    for (const line of lines) {
        const value = line.trim();
        if (!value || value.length > 240) continue;
        if (/^(Permission denied|File not found|cannot access|SyntaxError|ParserError|FINDSTR:)/i.test(value)) continue;
        const looksPath = /^(?:[A-Za-z]:\\|\/Users\/|\/home\/|\.\/|\.\.\/|[A-Za-z0-9_.-]+\/)[^\n]+/.test(value);
        const looksProjectName = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{2,80}$/.test(value);
        if (looksPath || looksProjectName) facts.push(value);
        if (facts.length >= 6) break;
    }
    return facts;
}

function summarizeToolCallArgs(call) {
    if (!call) return "";
    const parsed = parseJsonish(call.arguments ?? call.input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = ["app", "target", "targetId", "element", "path", "url", "query", "cmd", "action", "sessionId", "resourceId"];
        const parts = [];
        for (const key of keys) {
            const value = parsed[key];
            if (typeof value === "string" && value.trim()) parts.push(`${key}=${quoteFactValue(value, 70)}`);
            if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${String(value)}`);
            if (parts.length >= 3) break;
        }
        if (parts.length) return parts.join(", ");
    }
    if (typeof call.input === "string" && call.input.trim()) return quoteFactValue(call.input, 120);
    if (typeof call.arguments === "string" && call.arguments.trim()) return quoteFactValue(call.arguments, 120);
    return "";
}

function toolOutputLooksFailed(output, parsedOutput) {
    if (parsedOutput && typeof parsedOutput === "object") {
        if (parsedOutput.ok === false || parsedOutput.success === false) return true;
        if (typeof parsedOutput.error === "string" && parsedOutput.error.trim()) return true;
        if (parsedOutput.error && typeof parsedOutput.error === "object") return true;
        if (typeof parsedOutput.status === "string" && /fail|error|denied|unsupported/i.test(parsedOutput.status)) return true;
    }
    return /\b(error|failed|failure|denied|not permitted|unsupported|unavailable|timeout|timed out|exception)\b/i.test(String(output || ""));
}

function toolOutputLooksSuccessful(output, parsedOutput) {
    if (parsedOutput && typeof parsedOutput === "object") {
        if (parsedOutput.ok === true || parsedOutput.success === true || parsedOutput.closed === true) return true;
        if (Array.isArray(parsedOutput)) return true;
        if (Object.keys(parsedOutput).length && !toolOutputLooksFailed(output, parsedOutput)) return true;
    }
    const text = String(output || "").trim();
    return Boolean(text) && !toolOutputLooksFailed(text, parsedOutput);
}

function collectDurableToolFacts(input) {
    if (!Array.isArray(input)) return [];
    const calls = new Map();
    const toolCalls = new Map();
    const facts = new Map();
    function addFact(kind, fact) {
        const text = quoteFactValue(fact, 240);
        if (!text) return;
        if (!facts.has(kind)) facts.set(kind, []);
        const list = facts.get(kind);
        if (!list.includes(text) && list.length < 6) list.push(text);
    }

    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "function_call" && item.name === "exec_command") {
            const callId = item.call_id || item.id;
            if (callId) calls.set(callId, parseRestoredCommandArgs(item));
            if (callId) toolCalls.set(callId, { name: item.name, arguments: item.arguments, input: item.input, type: item.type });
            continue;
        }
        if (item.type === "function_call" || item.type === "custom_tool_call") {
            const callId = item.call_id || item.id;
            if (callId) toolCalls.set(callId, { name: item.name || item.type, arguments: item.arguments, input: item.input, type: item.type });
            continue;
        }
        if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") continue;
        const callId = item.call_id || item.id;
        const cmd = calls.get(callId) || "";
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        const toolCall = toolCalls.get(callId);
        const clean = stripVolatileToolOutput(output);
        const exitCode = parseExitCode(output);
        const ok = exitCode === 0;
        const failed = exitCode !== null && exitCode !== 0;
        const lines = extractCleanOutputLines(output);

        if (ok && commandLooksLikeListing(cmd)) {
            const pathFacts = extractLikelyPathFacts(lines);
            if (pathFacts.length) addFact("workspace", `Listing result from ${quoteFactValue(cmd, 90)}: ${pathFacts.slice(0, 6).join(", ")}`);
        }

        if (ok && commandLooksLikeRead(cmd)) {
            const first = lines.find(line => line && line.length <= 180);
            if (first) addFact("tool-state", `Read command succeeded: ${quoteFactValue(cmd, 120)}`);
        }

        if (ok && commandLooksLikeWrite(cmd)) {
            addFact("tool-state", `Write/change command succeeded: ${quoteFactValue(cmd, 120)}`);
        }

        if (ok && commandLooksLikeBuildOrInstall(cmd)) {
            const first = lines.find(line => line && line.length <= 180);
            addFact("tool-state", `Build/install command succeeded: ${quoteFactValue(cmd, 120)}${first ? ` -> ${quoteFactValue(first, 90)}` : ""}`);
        }

        if (failed && (commandLooksLikeBuildOrInstall(cmd) || commandLooksLikeRead(cmd) || commandLooksLikeListing(cmd))) {
            const failureLine = lines.find(line => /error|failed|cannot|not found|Permission denied|SyntaxError|ParserError|exit/i.test(line)) || lines[0] || `exit ${exitCode}`;
            addFact("tool-state", `Command failed, do not assume success: ${quoteFactValue(cmd, 100)} -> ${quoteFactValue(failureLine, 140)}`);
        }

        if (toolCall && toolCall.type === "function_call" && !["exec_command", "update_plan"].includes(toolCall.name)) {
            const parsedOutput = parseJsonish(item.output);
            const failedTool = exitCode !== null ? exitCode !== 0 : toolOutputLooksFailed(output, parsedOutput);
            const okTool = exitCode === 0 || (exitCode === null && toolOutputLooksSuccessful(output, parsedOutput));
            const name = quoteFactValue(toolCall.name || "tool", 80);
            const args = summarizeToolCallArgs(toolCall);
            if (okTool && !failedTool) {
                addFact("tool-state", `Tool ${name} succeeded${args ? ` (${args})` : ""}`);
            } else if (failedTool) {
                const failureLine = lines.find(line => /error|failed|cannot|not found|Permission denied|unsupported|timeout|denied/i.test(line)) || lines[0] || "failed";
                addFact("tool-state", `Tool ${name} failed, do not assume success${args ? ` (${args})` : ""}: ${quoteFactValue(failureLine, 120)}`);
            }
        }
    }

    return Array.from(facts.entries())
        .flatMap(([kind, values]) => values.map(value => `${kind}: ${value}`))
        .slice(0, 12);
}

function collectTaskLedgerFacts(input) {
    if (!Array.isArray(input)) return [];
    const facts = [];
    const push = (label, text) => {
        const value = quoteFactValue(text, 260);
        if (!value) return;
        const line = `${label}: ${value}`;
        if (!facts.includes(line)) facts.push(line);
    };
    const recentMessages = input
        .filter(item => item?.type === "message" && ["user", "assistant"].includes(item.role))
        .slice(-10);
    const userMessages = recentMessages.filter(item => item.role === "user").map(item => textFromMessageContent(item.content)).filter(Boolean);
    const assistantMessages = recentMessages.filter(item => item.role === "assistant").map(item => textFromMessageContent(item.content)).filter(Boolean);
    const meaningfulUser = userMessages
        .filter(text => !/^<turn_aborted>/.test(text.trim()))
        .filter(text => !/^(继续|好|嗯|可以|ok|OK|你倒是看啊|我操你妈|操你妈的)\s*[。.!！?？]*$/.test(text.trim()));
    const lastTask = meaningfulUser.at(-1);
    if (lastTask) push("current-user-task", lastTask);
    const lastAssistant = assistantMessages.at(-1);
    if (lastAssistant && assistantTextLooksLikeFutureToolPromise(lastAssistant)) {
        push("pending-next-action", lastAssistant);
    }
    const targetHints = [...userMessages, ...assistantMessages].join("\n").match(/(?:[A-Za-z]:\\[^\s"'，。；;]+|\/Users\/[^\s"'，。；;]+|(?:\.{1,2}[\\/])?deepcodex[\\/][^\s"'，。；;]+|(?:new-chat-\d+|qwen[-_\w]*|gemini[-_\w]*|remotion[-_\w]*))/g) || [];
    for (const hint of targetHints.slice(-6)) push("target-hint", hint);
    return facts.slice(0, 10);
}

function injectTaskLedgerFacts(input) {
    const isRestoredThread = Array.isArray(input) && input.some(item => item?.type === "context_compaction");
    if (!isRestoredThread) return input;
    const facts = collectTaskLedgerFacts(input);
    if (!facts.length) return input;
    const alreadyPresent = input.some(item => item?.type === "context_compaction" && /(?:Anti-Codex|DeepCodex) task ledger/.test(readableCompactionText(item)));
    if (alreadyPresent) return input;
    return [
        {
            type: "context_compaction",
            summary: [
                "Anti-Codex task ledger from recent explicit user/assistant text:",
                ...facts.map(fact => `- ${fact}`),
                "Preserve the task goal and pending next action across compaction. Do not replace the user's target with environment guesses.",
            ].join("\n"),
        },
        ...input,
    ];
}

function injectDurableToolFacts(input) {
    const facts = collectDurableToolFacts(input);
    if (!facts.length) return input;
    const alreadyPresent = input.some(item => item?.type === "context_compaction" && /(?:Anti-Codex|DeepCodex) durable environment facts/.test(readableCompactionText(item)));
    if (alreadyPresent) return input;
    return [
        {
            type: "context_compaction",
            summary: [
                "Anti-Codex durable environment facts from verified tool results:",
                ...facts.map(fact => `- ${fact}`),
                "Use these facts before guessing environment details. If a later probe contradicts them, verify with a tool call before changing course.",
            ].join("\n"),
        },
        ...input,
    ];
}

function dropVolatileRestoredItems(input) {
    if (!Array.isArray(input)) return input;
    const volatileIds = new Set();
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (isVolatileRestoredToolCall(item) || isVolatileRestoredToolOutput(item)) {
            const callId = item.call_id || item.id;
            if (callId) volatileIds.add(callId);
        }
    }

    let omitted = false;
    const filtered = [];
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        const callId = item.call_id || item.id;
        if ((item.type === "function_call" || item.type === "function_call_output" || item.type === "custom_tool_call" || item.type === "custom_tool_call_output") && callId && volatileIds.has(callId)) {
            omitted = true;
            continue;
        }
        if (isVolatileRestoredMessage(item)) {
            omitted = true;
            continue;
        }
        filtered.push(item);
    }

    if (!omitted) return input;
    return [
        {
            type: "context_compaction",
            summary: [
                "Anti-Codex omitted volatile restored polling/status transcripts before forwarding this turn upstream.",
                "Dropped items include interrupted-turn markers, reconnect messages, running-session polls, process-status checks, and transport wrapper lines that change every turn and harm prompt-cache stability.",
            ].join("\n"),
        },
        ...filtered,
    ];
}

function pruneRestoredToolTranscripts(input) {
    if (!Array.isArray(input) || MAX_RESTORED_TOOL_CALLS <= 0) return input;

    let activeTurnStart = -1;
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (item?.type === "message" && item.role === "user") {
            activeTurnStart = i;
            break;
        }
    }
    let activeToolStart = activeTurnStart + 1;
    for (let i = input.length - 1; i > activeTurnStart; i--) {
        const item = input[i];
        if (item?.type === "message" && item.role === "assistant") {
            activeToolStart = i + 1;
            break;
        }
    }

    const keepIds = new Set();
    for (let i = activeToolStart; i < input.length; i++) {
        const item = input[i];
        if (!item || typeof item !== "object") continue;
        if (item.type !== "function_call" && item.type !== "function_call_output" && item.type !== "custom_tool_call" && item.type !== "custom_tool_call_output") continue;
        const callId = item.call_id || item.id;
        if (callId) keepIds.add(callId);
    }

    let olderKept = 0;
    for (let i = activeTurnStart >= 0 ? activeTurnStart - 1 : activeToolStart - 1; i >= 0 && olderKept < MAX_RESTORED_TOOL_CALLS; i--) {
        const item = input[i];
        if (!item || typeof item !== "object") continue;
        if (item.type !== "function_call" && item.type !== "function_call_output" && item.type !== "custom_tool_call" && item.type !== "custom_tool_call_output") continue;
        const callId = item.call_id || item.id;
        if (callId && !keepIds.has(callId)) {
            keepIds.add(callId);
            olderKept += 1;
        }
    }

    if (keepIds.size === 0) return input;

    let omitted = false;
    const pruned = [];
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "function_call" || item.type === "function_call_output" || item.type === "custom_tool_call" || item.type === "custom_tool_call_output") {
            const callId = item.call_id || item.id;
            if (!callId || !keepIds.has(callId)) {
                omitted = true;
                continue;
            }
            pruned.push(clipRestoredToolOutput(clipRestoredToolCall(item)));
            continue;
        }
        pruned.push(item);
    }

    if (!omitted) return pruned;
    return [
        {
            type: "context_compaction",
            summary: [
                "Anti-Codex omitted older restored tool transcripts before forwarding this turn upstream.",
                "The latest compaction summary and recent tool results are preserved. For older exact stdout or command details, inspect the workspace or rerun the relevant command.",
            ].join("\n"),
        },
        ...pruned,
    ];
}

function repairRestoredInput(input) {
    if (!Array.isArray(input)) return input;
    input = dropVolatileRestoredItems(input);
    input = injectTaskLedgerFacts(input);
    input = injectDurableToolFacts(input);
    let lastDamaged = -1;
    let lastReadableCompact = -1;
    for (let i = 0; i < input.length; i++) {
        if (isDamagedCompactionItem(input[i])) lastDamaged = i;
        else if (input[i]?.type === "context_compaction" && readableCompactionText(input[i])) lastReadableCompact = i;
    }
    if (lastDamaged < 0 && input.length <= MAX_RESTORED_INPUT_ITEMS) return pruneRestoredToolTranscripts(input);

    const minStart = lastDamaged + 1;
    let activeTurnStart = -1;
    for (let i = input.length - 1; i >= minStart; i--) {
        const item = input[i];
        if (item?.type === "message" && item.role === "user") {
            activeTurnStart = i;
            break;
        }
    }
    const start = lastDamaged < 0 && activeTurnStart > 0
        ? Math.max(minStart, activeTurnStart - MAX_RESTORED_INPUT_ITEMS)
        : Math.max(minStart, input.length - MAX_RESTORED_INPUT_ITEMS);
    const repaired = lastDamaged >= 0
        ? [{ type: "context_compaction", summary: damagedCompactionSummary() }]
        : [];

    if (lastDamaged < 0 && lastReadableCompact >= 0 && lastReadableCompact < start) {
        repaired.push(input[lastReadableCompact]);
    }

    for (let i = start; i < input.length; i++) {
        const item = input[i];
        if (!item || typeof item !== "object") continue;
        if (lastDamaged < 0 && i === lastReadableCompact && repaired.includes(item)) continue;
        if (item.type === "message") {
            if (lastDamaged >= 0 && !["user", "assistant"].includes(item.role)) continue;
            repaired.push(item);
        } else if (item.type === "context_compaction" && readableCompactionText(item)) {
            repaired.push(item);
        } else if (lastDamaged < 0 && (item.type === "function_call" || item.type === "function_call_output" || item.type === "custom_tool_call" || item.type === "custom_tool_call_output" || item.type === "reasoning")) {
            repaired.push(item);
        }
    }
    return pruneRestoredToolTranscripts(repaired);
}

function readableReasoningText(item) {
    if (!item || typeof item !== "object") return "";
    const decoded = decodeReasoningContent(item.encrypted_content);
    if (decoded) return decoded;
    const summary = item.summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
    if (Array.isArray(summary)) {
        const text = summary.map(part => typeof part === "string" ? part : part?.text || "").join("\n").trim();
        if (text) return text;
    }
    return "";
}

function responseShell(original, { id = responseId(), created = Math.floor(Date.now() / 1000), model = null, status = "completed", output = [], usage = null, finishReason = null } = {}) {
    const originalRequest = originalRequestFromArg(original);
    return {
        id,
        object: "response",
        created_at: created,
        status,
        error: null,
        incomplete_details: incompleteDetails(finishReason),
        instructions: originalRequest.instructions ?? null,
        max_output_tokens: originalRequest.max_output_tokens ?? null,
        model: model || originalRequest.model || "gpt-5.5",
        output,
        parallel_tool_calls: originalRequest.parallel_tool_calls ?? true,
        previous_response_id: originalRequest.previous_response_id ?? null,
        reasoning: originalRequest.reasoning ?? { effort: null, summary: null },
        store: originalRequest.store ?? false,
        temperature: originalRequest.temperature ?? null,
        text: originalRequest.text ?? { format: { type: "text" } },
        tool_choice: originalRequest.tool_choice ?? "auto",
        tools: originalRequest.tools ?? [],
        top_p: originalRequest.top_p ?? null,
        truncation: originalRequest.truncation ?? "disabled",
        usage,
        user: originalRequest.user ?? null,
        metadata: originalRequest.metadata ?? {},
    };
}

function responseOutputHasToolCall(output) {
    return Array.isArray(output) && output.some(item => item?.type === "function_call" || item?.type === "custom_tool_call");
}

function assistantTextLooksLikeWebToolUnavailableClaim(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return false;
    const namesWebTool = /\bweb[_ -]?(?:search|fetch)\b/i.test(value);
    const namesSearchTool = /(?:搜索|检索|抓取|网页|联网|网络).{0,12}(?:工具|tool)/i.test(value);
    if (!namesWebTool && !namesSearchTool) return false;
    return /(?:不可用|不能用|无法使用|暂时不可用|没有可用|未启用|不可访问|失败|unavailable|not available|disabled|unsupported|not supported|failed)/i.test(value);
}

function assistantTextLooksLikeUnsupportedToolClaim(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    const compact = value.replace(/\s+/g, " ");
    const zhDone = /(?:已|已经|刚才|我(?:已经)?|这里|现在).{0,36}(?:读完|读取|读了|查看|看了|检查|搜到|搜索到|查到|找到|运行|执行|安装|启动|生成|创建|写入|修改|补丁|打上|渲染|导出|移动|复制|删除|下载|打开|跑起来|跑完)/i;
    const zhDoneVerbFirst = /(?:搜到|搜索到|查到|找到|看了|读了|跑完|装好|写好|改好|生成好).{0,80}(?:结果|案例|资料|文件|页面|仓库|showcase|GitHub|官方|内容|数据)/i;
    const enClaim = /\b(?:I\s+(?:have\s+)?(?:installed|started|ran|read|generated|moved|copied|searched|fetched|opened|wrote|patched|downloaded|rendered)|(?:installed|started|ran|read|generated|moved|copied|searched|fetched|opened|wrote|patched|downloaded|rendered)\b)/i;
    return assistantTextLooksLikeFutureToolPromise(compact) || zhDone.test(compact) || zhDoneVerbFirst.test(compact) || enClaim.test(compact);
}

function assistantTextLooksLikeFutureToolPromise(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    const compact = value.replace(/\s+/g, " ");
    const factualBlocker = /(?:需要|必须|请你|用户|否则|不能|无法|还没有|没有|缺少).{0,40}(?:安装|连接|启用|配置|授权|允许|打开|接入).{0,80}(?:否则|不能|无法|才(?:能|可以)|后(?:才|就))/i;
    const explicitSelfAction = /(?:现在|马上|接下来|继续|我来|开始|准备|直接).{0,36}(?:读|读取|查看|检查|搜|搜索|运行|执行|安装|启动|生成|创建|新建|写|写入|修改|补丁|打补丁|patch|渲染|导出|移动|复制|删除|下载|打开|跑|做|搭建|实现|落地|scaffold|skeleton)/i;
    if (factualBlocker.test(compact) && !explicitSelfAction.test(compact)) return false;
    const zhFuture = /(?:先|现在|马上|接下来|继续|我来|开始|准备|直接).{0,36}(?:读|读取|查看|检查|搜|搜索|运行|执行|安装|启动|生成|创建|新建|写|写入|修改|补丁|打补丁|patch|渲染|导出|移动|复制|删除|下载|打开|跑|做|搭建|实现|落地|scaffold|skeleton)/i;
    const zhCommandPromise = /(?:先|现在|马上|接下来|继续|我来|开始|准备|直接|然后|用|使用).{0,48}(?:npm|npx|pnpm|yarn|node|python|pip|powershell|cmd|bash|git|curl|remotion|vite|hyperframes|ffmpeg|magick|robocopy|copy-item|start-process)\b/i;
    const zhThenAction = /(?:确认|检查|看一下|看看|读一下|读完|看完).{0,48}(?:然后|再|后).{0,24}(?:启动|运行|执行|安装|生成|创建|新建|写入|修改|渲染|导出|复制|移动|打开|跑|做|搭建|实现|落地|scaffold|skeleton)/i;
    const danglingActionLeadIn = /(?:看(?:看|一下)?|读(?:取|一下)?|列(?:出|一下)?|检查|打开|运行|执行|启动|安装|创建|新建|写入|修改|搜索|查(?:看|一下)?).{0,48}[：:]\s*$/i;
    const enCommandPromise = /\b(?:I(?:'ll| will| am going to)?|let me|now|next|then|directly)\b.{0,60}\b(?:npm|npx|pnpm|yarn|node|python|pip|powershell|cmd|bash|git|curl|remotion|vite|hyperframes|ffmpeg|magick|robocopy)\b/i;
    const enActionPromise = /\b(?:I(?:'ll| will| am going to)|let me|now|next|then|continue|directly)\b.{0,80}\b(?:use|apply|retry|rerun|read|inspect|check|verify|confirm|get|find|locate|gather|collect|search|fetch|run|execute|install|start|generate|create|write|edit|modify|update|add|insert|wire|patch|render|export|move|copy|delete|download|open|build|implement|finish|fix|scaffold|see|look|examine|trace|follow)\b/i;
    const enDanglingActionLeadIn = /\b(?:let me|I(?:'ll| will| am going to)|now|next|then|continue|directly)\b.{0,120}\b(?:use|apply|retry|rerun|read|inspect|check|verify|confirm|get|find|locate|gather|collect|search|fetch|run|execute|install|start|generate|create|write|edit|modify|update|add|insert|wire|patch|render|export|move|copy|delete|download|open|build|implement|finish|fix|scaffold|see|look|examine|trace|follow)\b.{0,60}[：:]\s*(?:\\d+\\s*)?$/i;
    return zhFuture.test(compact) || zhCommandPromise.test(compact) || zhThenAction.test(compact) || danglingActionLeadIn.test(compact) || enCommandPromise.test(compact) || enActionPromise.test(compact) || enDanglingActionLeadIn.test(compact);
}

function completedResultsThenStatusDetour(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return false;
    const saysResultsReady = /(?:结果|搜索|检索|资料|信息|tool results?|results?).{0,24}(?:已|已经|跑完|完成|够了|就在上面|collected|ready|done|complete)/i.test(value)
        || /(?:已|已经).{0,20}(?:搜索|检索|收集).{0,20}(?:完成|完|到|好)/i.test(value);
    const saysFinalAnswer = /(?:最终|总结|回答|盘点|整理|答复|final|answer|summary)/i.test(value);
    const saysStatusDetour = /(?:确认|检查|看一下|verify|check).{0,36}(?:环境|工具链|连接|进程|端口|daemon|服务|窗口|状态|health|status|toolchain)/i.test(value);
    return saysResultsReady && saysFinalAnswer && saysStatusDetour;
}

function brandTranslatorText(text) {
    return String(text || "").replaceAll("DeepCodex", TRANSLATOR_BRAND);
}

function detourBlockedMessage() {
    return brandTranslatorText([
        "Anti-Codex 已拦截这轮回复：模型已经声明结果足够并应进入最终回答，但又发起了状态/环境确认工具调用。",
        "实际要求：除非用户明确要求诊断工具链、进程、端口或窗口，否则不要把辅助环境检查升级成主任务。",
        "请继续时基于已有工具结果直接回答用户的主问题；如果证据不足，只说明缺什么证据。",
    ].join("\n"));
}

function blockedToolClaimMessage() {
    return brandTranslatorText([
        "Anti-Codex 已拦截这轮回复：这次模型只是在文字里说自己要执行或已经执行，但没有真的读文件、运行命令、安装依赖、启动服务、生成文件、移动文件或搜索网页。",
        "实际状态：本轮没有实际 tool call，所以 Anti-Codex 没把它当作已完成。",
        "下一步：Anti-Codex 会要求模型重新发起真实工具调用；如果当前路由缺少工具，必须明确说出缺少什么。",
    ].join("\n"));
}

function webToolUnavailableClaimMessage() {
    return brandTranslatorText([
        "Anti-Codex 已拦截这轮回复：模型声称 web_search/web_fetch 不可用，但本轮或已恢复历史里没有对应的 web_search/web_fetch 失败结果。",
        "实际状态：shell、curl、npm、browser 或 exec_command 的网络失败，不能等同于 web_search/web_fetch 不可用。",
        "下一步：必须真实调用 web_search/web_fetch，或只说明具体哪个已执行工具失败；不能伪造 web_search 结果。",
    ].join("\n"));
}

function fakeToolClaimRelayPrompt() {
    return [
        blockedToolClaimMessage(),
        "",
        "这不是最终回答。继续当前任务：如果需要读文件、运行命令、安装依赖、启动服务、生成文件、移动文件或搜索网页，必须现在调用可用工具。",
        "不要再次只用自然语言承诺“我来执行/我直接用命令/我已经完成”。",
        "如果当前路由确实没有所需工具，明确说明哪个工具不可用以及下一步需要用户做什么。",
    ].join("\n");
}

function webToolUnavailableRelayPrompt() {
    return [
        webToolUnavailableClaimMessage(),
        "",
        "这不是最终回答。继续当前任务：如果用户请求搜索/查资料/找案例，必须现在调用 web_search 或 web_fetch。",
        "如果你只运行过 shell/exec_command 并且它访问外网失败，只能说 shell/exec_command 网络访问失败；不要说 web_search 不可用。",
    ].join("\n");
}

function requestHasToolEvidence(originalRequest) {
    const input = Array.isArray(originalRequest?.input) ? originalRequest.input : [];
    return input.some(item => item?.type === "function_call_output" || item?.type === "custom_tool_call_output" || item?.role === "tool");
}

function requestHasToolOutputFor(originalRequest, names = []) {
    const wanted = new Set(names);
    const input = Array.isArray(originalRequest?.input) ? originalRequest.input : [];
    const callNames = new Map();
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if ((item.type === "function_call" || item.type === "custom_tool_call") && item.name) {
            const callId = item.call_id || item.id;
            if (callId) callNames.set(callId, item.name);
        }
        if (item.type === "message" && item.role === "assistant" && Array.isArray(item.tool_calls)) {
            for (const tc of item.tool_calls) {
                const callId = tc?.id || tc?.call_id;
                const name = tc?.function?.name || tc?.name;
                if (callId && name) callNames.set(callId, name);
            }
        }
    }
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output" && item.role !== "tool") continue;
        const directName = item.name || item.tool_name;
        if (directName && wanted.has(directName)) return true;
        const callId = item.call_id || item.tool_call_id || item.id;
        if (callId && wanted.has(callNames.get(callId))) return true;
    }
    return false;
}

function messagesHaveToolEvidence(messages) {
    return Array.isArray(messages) && messages.some(message => message?.role === "tool");
}

function messagesHaveToolOutputFor(messages, names = []) {
    const wanted = new Set(names);
    const callNames = new Map();
    for (const message of messages || []) {
        if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
        for (const tc of message.tool_calls) {
            const callId = tc?.id || tc?.call_id;
            const name = tc?.function?.name || tc?.name;
            if (callId && name) callNames.set(callId, name);
        }
    }
    for (const message of messages || []) {
        if (message?.role !== "tool") continue;
        const directName = message.name || message.tool_name;
        if (directName && wanted.has(directName)) return true;
        const callId = message.tool_call_id || message.call_id || message.id;
        if (callId && wanted.has(callNames.get(callId))) return true;
    }
    return false;
}

function assistantTextLooksLikeLongContextMarkerEcho(text) {
    const value = String(text || "");
    return /\bLONGCTX_HEAD_\d+\b/.test(value) && /\bLONGCTX_TAIL_\d+\b/.test(value);
}

function compactionRecallRequiredTerms(summaries) {
    const combined = summaries.join("\n");
    const phrases = [];
    const patterns = [
        /(?:next action|immediate next action|continuation instruction)\s*[:：-]\s*([^\n\r]+)/ig,
        /(?:下一步|下一动作|继续动作|后续动作)\s*[:：-]\s*([^\n\r]+)/ig,
    ];
    for (const pattern of patterns) {
        for (const match of combined.matchAll(pattern)) {
            const phrase = String(match[1] || "").replace(/[`*_#>-]/g, " ").trim();
            if (phrase) phrases.push(phrase);
        }
    }
    const lines = combined.split(/\r?\n/);
    const cleanLine = (line) => String(line || "")
        .replace(/^[\s>*#-]+/, "")
        .replace(/^\d+[.)]\s*/, "")
        .replace(/[`*_]/g, " ")
        .trim();
    const nextNonEmptyLine = (index) => {
        for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
            const line = cleanLine(lines[index + offset]);
            if (line && !/^(?:next steps?|continuation instruction|constraints?)\s*[:：]?\s*$/i.test(line)) return line;
        }
        return "";
    };
    for (let index = 0; index < lines.length; index += 1) {
        const line = cleanLine(lines[index]);
        if (!line) continue;
        const inline = line.match(/(?:next action|immediate next action|continuation instruction|下一步|下一动作|继续动作|后续动作)\s*[:：-]\s*(.+)$/i);
        if (inline?.[1]?.trim()) {
            phrases.push(inline[1].trim());
            continue;
        }
        if (/(?:next action|immediate next action|continuation instruction|下一步|下一动作|继续动作|后续动作)\s*[:：-]?\s*$/i.test(line)
            || /^next steps?\s*[:：-]?\s*$/i.test(line)) {
            const next = nextNonEmptyLine(index);
            if (next) phrases.push(next);
        }
    }
    const terms = [];
    for (const phrase of phrases) {
        for (const term of phrase.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) {
            if (["the", "and", "for", "with", "from", "this", "that", "next", "action"].includes(term)) continue;
            if (!terms.includes(term) && terms.length < 8) terms.push(term);
        }
    }
    return terms;
}

function assistantTextLooksLikeCompactionRecall(text, originalRequest) {
    const input = Array.isArray(originalRequest?.input) ? originalRequest.input : [];
    const summaries = input
        .filter(item => item?.type === "context_compaction")
        .map(readableCompactionText)
        .filter(Boolean);
    if (!summaries.length) return false;

    const value = String(text || "");
    if (hasPseudoToolMarkup(value)) return false;
    if (assistantTextLooksLikeWebToolUnavailableClaim(value) || assistantTextLooksLikeHonestNoEvidenceBlocker(value)) return false;
    if (/(?:缺少|未暴露|未激活|不可用|不能|无法|unavailable|missing|disabled|unsupported).{0,80}(?:工具|tool|connector)/i.test(value)
        || /(?:工具|tool|connector).{0,80}(?:缺少|未暴露|未激活|不可用|不能|无法|unavailable|missing|disabled|unsupported)/i.test(value)
        || /(?:cannot|can't|unable to|无法|不能).{0,40}(?:verify|continue|恢复|继续)/i.test(value)) return false;
    const userText = input
        .filter(item => item?.type === "message" && item.role === "user")
        .map(item => textFromMessageContent(item.content))
        .filter(Boolean)
        .at(-1) || "";
    const asksForRecall = /(?:recall|remember|what was|exact|marker|next action|active task|compacted context|saved compact|回忆|记得|标记|下一动作|当前任务|压缩摘要)/i.test(userText);
    const summary = summaries.join("\n").toLowerCase();
    const markers = summaries.join("\n").match(/\b[A-Z][A-Z0-9_:-]{7,}\b/g) || [];
    const requiredTerms = compactionRecallRequiredTerms(summaries);
    if (asksForRecall && markers.some(marker => value.includes(marker))) {
        const normalizedValue = value.toLowerCase();
        if (requiredTerms.length && !requiredTerms.every(term => normalizedValue.includes(term))) return false;
        return true;
    }
    if (assistantTextLooksLikeFutureToolPromise(value)) return false;

    const tokens = value.toLowerCase().match(/[a-z0-9_:-]{3,}/g) || [];
    if (tokens.length < 2) return false;
    const matched = tokens.filter(token => summary.includes(token));
    return matched.length / tokens.length >= 0.8;
}

function deterministicCompactionRecall(originalRequest) {
    const input = Array.isArray(originalRequest?.input) ? originalRequest.input : [];
    const summary = input
        .filter(item => item?.type === "context_compaction")
        .map(readableCompactionText)
        .filter(Boolean)
        .at(-1);
    if (!summary) return "";
    const userText = input
        .filter(item => item?.type === "message" && item.role === "user")
        .map(item => textFromMessageContent(item.content))
        .filter(Boolean)
        .at(-1) || "";
    return /(?:recall|remember|resume|what was|marker|next action|compacted context|saved compact|回忆|记得|恢复|标记|下一动作|当前任务|压缩摘要)/i.test(userText)
        ? summary
        : "";
}

function shouldBlockAssistantToolClaim(text, { hasToolEvidence = false, hasToolCall = false, hasWebToolEvidence = false, isCompactionRecall = false } = {}) {
    if (hasToolCall) return false;
    if (assistantTextLooksLikeLongContextMarkerEcho(text)) return false;
    if (isCompactionRecall) return false;
    if (!assistantTextLooksLikeWebToolUnavailableClaim(text) && assistantTextLooksLikeHonestNoEvidenceBlocker(text)) return false;
    if (assistantTextLooksLikeWebToolUnavailableClaim(text) && !hasWebToolEvidence) return true;
    if (!assistantTextLooksLikeUnsupportedToolClaim(text)) return false;
    // Once the turn already has real tool evidence, completion summaries like
    // "已经读取/已经写入" are legitimate. Still block future-action promises
    // that would otherwise end a turn without actually calling the tool.
    if (hasToolEvidence && !assistantTextLooksLikeFutureToolPromise(text)) return false;
    return true;
}

function assistantTextLooksLikeHonestNoEvidenceBlocker(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return false;
    return /(?:没有|无|尚未|还没|未).{0,16}(?:实际|真实).{0,20}(?:搜索|检索|查看|读取|执行|运行|工具|结果|证据)/i.test(value)
        || /(?:shell|命令|exec_command).{0,24}(?:网络|联网|访问外网).{0,24}(?:失败|不可用|不通)/i.test(value);
}

function blockedToolClaimMessageFor(text, context = {}) {
    if (assistantTextLooksLikeWebToolUnavailableClaim(text) && !context.hasWebToolEvidence) {
        return webToolUnavailableClaimMessage();
    }
    return blockedToolClaimMessage();
}

function fakeToolClaimRelayPromptFor(text, context = {}) {
    if (assistantTextLooksLikeWebToolUnavailableClaim(text) && !context.hasWebToolEvidence) {
        return [
            webToolUnavailableClaimMessage(),
            "",
            "This is not the final answer. web_search and web_fetch are exposed in [CODEX_TOOLS].",
            "Call the appropriate web tool now by emitting only the exact XML-like tool request. Do not claim the tool is unavailable unless its returned tool result reports a failure.",
        ].join("\n");
    }
    return [
        blockedToolClaimMessage(),
        "",
        "This is not the final answer. Continue the current task now.",
        "If the task requires a tool, emit the exact XML-like tool request described in [CODEX_TOOLS], with no prose before it.",
        "Do not merely promise to run, read, fetch, search, patch, or inspect something. If no suitable tool is exposed, state the specific missing tool plainly.",
    ].join("\n");
}

function emptyAssistantRelayPrompt() {
    return brandTranslatorText([
        "Anti-Codex 已拦截空回复：上一轮模型没有返回消息，也没有返回 tool call。",
        "",
        "这不是最终回答。请继续当前任务：如果需要读文件、运行命令、安装依赖、启动服务、生成文件、移动文件或搜索网页，必须现在调用可用工具。",
        "如果已经没有可做动作，请用自然语言给出明确结论，不能空完成。",
    ].join("\n"));
}

function emptyAssistantBlockedMessage() {
    return brandTranslatorText([
        "Anti-Codex 已拦截空回复：模型没有返回任何可显示内容，也没有发起 tool call。",
        "实际状态：本轮没有完成新的读取、执行、修改或总结。",
        "下一步：请重新发送明确任务，或让模型基于已有结果给出结论。",
    ].join("\n"));
}

function guardAssistantToolClaims(output, originalRequest = null, options = {}) {
    if (responseOutputHasToolCall(output)) return output;
    const request = originalRequestFromArg(originalRequest);
    const hasPriorToolEvidence = options.hasInternalToolEvidence === true
        || options.hasInternalWebEvidence === true
        || requestHasToolEvidence(request);
    const hasWebToolEvidence = options.hasInternalWebEvidence === true
        || requestHasToolOutputFor(request, ["web_search", "web_fetch"]);
    let changed = false;
    const guarded = output.map(item => {
        if (item?.type !== "message" || !Array.isArray(item.content)) return item;
        const nextContent = item.content.map(part => {
            const isCompactionRecall = part?.type === "output_text" && assistantTextLooksLikeCompactionRecall(part.text, request);
            if (part?.type !== "output_text" || !shouldBlockAssistantToolClaim(part.text, { hasToolEvidence: hasPriorToolEvidence, hasWebToolEvidence, isCompactionRecall })) return part;
            changed = true;
            return { ...part, text: blockedToolClaimMessageFor(part.text, { hasWebToolEvidence }) };
        });
        return nextContent === item.content ? item : { ...item, content: nextContent };
    });
    return changed ? guarded : output;
}

function outputTextParts(output) {
    return (output || [])
        .filter(item => item?.type === "message" && Array.isArray(item.content))
        .flatMap(item => item.content)
        .filter(part => part?.type === "output_text")
        .map(part => part.text || "")
        .filter(Boolean);
}

function outputToolCalls(output) {
    return (output || []).filter(item => item?.type === "function_call" || item?.type === "custom_tool_call");
}

function toolCallLooksLikeStatusProbe(item) {
    if (!item || item.type !== "function_call") return false;
    if (item.name !== "exec_command") return false;
    return commandLooksLikeStatusProbe(parseRestoredCommandArgs(item));
}

function guardCompletionStatusDetours(output) {
    const toolCalls = outputToolCalls(output);
    if (!toolCalls.length) return output;
    const text = outputTextParts(output).join("\n");
    if (!completedResultsThenStatusDetour(text)) return output;
    const statusProbeCalls = toolCalls.filter(toolCallLooksLikeStatusProbe);
    if (!statusProbeCalls.length || statusProbeCalls.length !== toolCalls.length) return output;
    return [{
        type: "message",
        id: messageId(),
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: detourBlockedMessage(), annotations: [] }],
    }];
}

function chatToResponsesFormat(json, original, routing = null, options = {}) {
    const originalRequest = originalRequestFromArg(original);
    const choice = json.choices?.[0] || {};
    const msg = choice.message || {};
    const output = [];
    const rawContent = typeof msg.content === "string" ? msg.content : "";
    const pseudoCalls = parsePseudoToolCalls(rawContent);
    const pseudoExternalCalls = pseudoCalls.filter(tc => !isInternalTool(tc?.function?.name));
    const content = sanitizeMarkdownUrlFormatting(pseudoCalls.length > 0 ? stripPseudoToolMarkup(rawContent) : msg.content);
    if (msg.reasoning_content) output.push({ type: "reasoning", id: reasoningId(), status: "completed", summary: [], encrypted_content: encodeReasoningContent(msg.reasoning_content) });
    if (content) output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: content, annotations: [] }] });
    if (msg.tool_calls) for (const tc of msg.tool_calls) {
        const upstreamName = tc.function?.name || "";
        // Reverse-map upstream Chat tool name → original Codex callable name using routing metadata
        const route = routing?.[upstreamName];
        if (options.strictTools && !route) {
            output.push(messageOutput(unavailableToolMessage(upstreamName)));
            continue;
        }
        const codexName = route?.codexName || upstreamName;
        const isCustom = route?.type === "custom";
        let args = tc.function?.arguments || "{}";
        if (options.strictTools && route) {
            try {
                const parsedArgs = JSON.parse(args || "{}");
                const objectArgs = parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs) ? parsedArgs : {};
                const coerced = coercePseudoArgumentsForRoute(objectArgs, route);
                if (!coerced.ok) {
                    output.push(messageOutput(invalidToolArgumentsMessage(codexName, coerced.error)));
                    continue;
                }
                args = JSON.stringify(coerced.args);
            } catch {
                output.push(messageOutput(invalidToolArgumentsMessage(codexName, "arguments must be valid JSON")));
                continue;
            }
        }
        if (customArgumentsAreInvalid(args, route)) {
            output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidCustomToolMessage(codexName), annotations: [] }] });
            continue;
        }
        // Unwrap custom tool arguments from the {content: "..."} wrapper
        if (isCustom && args) {
            try {
                const parsed = JSON.parse(args);
                if (typeof parsed.content === "string") args = parsed.content;
            } catch { /* not json, use as-is */ }
        }
        if (isCustom) {
            output.push({ type: "custom_tool_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: codexName, input: args });
        } else {
            output.push({ type: "function_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: codexName, arguments: args });
        }
    }
    for (const tc of pseudoExternalCalls) {
        const upstreamName = tc.function?.name || "";
        const route = routing?.[upstreamName];
        if (options.strictTools && !route) {
            output.push(messageOutput(unavailableToolMessage(upstreamName)));
            continue;
        }
        const codexName = route?.codexName || upstreamName;
        const isCustom = route?.type === "custom";
        let args = tc.function?.arguments || "{}";
        if (options.strictTools && route) {
            try {
                const parsedArgs = JSON.parse(args || "{}");
                const objectArgs = parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs) ? parsedArgs : {};
                const coerced = coercePseudoArgumentsForRoute(objectArgs, route);
                if (!coerced.ok) {
                    output.push(messageOutput(invalidToolArgumentsMessage(codexName, coerced.error)));
                    continue;
                }
                args = JSON.stringify(coerced.args);
            } catch {
                output.push(messageOutput(invalidToolArgumentsMessage(codexName, "arguments must be valid JSON")));
                continue;
            }
        }
        if (customArgumentsAreInvalid(args, route)) {
            output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidCustomToolMessage(codexName), annotations: [] }] });
            continue;
        }
        args = unwrapCustomArguments(args, route);
        if (isCustom) {
            output.push({ type: "custom_tool_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: codexName, input: args });
        } else {
            output.push({ type: "function_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: codexName, arguments: args });
        }
    }
    if (pseudoCalls.length > 0 && output.length === 0) {
        output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: "Internal tool request was intercepted but could not be completed in this turn. Please retry with a narrower request or a specific URL.", annotations: [] }] });
    }
    const finishReason = choice.finish_reason;
    const compactRecall = deterministicCompactionRecall(originalRequest);
    const outputText = outputTextParts(output).join("\n");
    const outputToGuard = compactRecall && !assistantTextLooksLikeCompactionRecall(outputText, originalRequest)
        ? [messageOutput(compactRecall)]
        : output;
    const guardedOutput = guardAssistantToolClaims(guardCompletionStatusDetours(outputToGuard), originalRequest, {
        hasInternalToolEvidence: json?._internalToolEvidence === true,
        hasInternalWebEvidence: json?._internalWebEvidence === true,
    });
    return responseShell(originalRequest, {
        id: json.id || responseId(),
        created: json.created || Math.floor(Date.now() / 1000),
        model: json.model || originalRequest.model || "gpt-5.5",
        status: responseStatus(finishReason),
        output: guardedOutput,
        usage: mapUsage(json.usage),
        finishReason,
    });
}

// ──────────────────────────────────────────── internal tool loop ─────────────

async function callUpstreamWithInternalTools(body, dependencies = {}) {
    const working = { ...body, stream: false, messages: [...(body.messages || [])] };
    const explicitWebEvidence = body?._internalWebEvidence || "";
    delete working._internalWebEvidence;
    const callOnce = dependencies.callOnce ?? (async (nextBody, label) => {
        const { res, text, json } = await postChatCompletion(nextBody, label);
        return res.ok
            ? { ok: true, status: res.status, json }
            : { ok: false, status: res.status, json, text };
    });
    const executedInternalCalls = new Set();
    let fakeToolClaimReplays = 0;
    let emptyAssistantReplays = 0;

    const markInternalEvidence = (json) => {
        if (!json || typeof json !== "object") return json;
        if (messagesHaveToolEvidence(working.messages)) json._internalToolEvidence = true;
        if (Boolean(explicitWebEvidence) || messagesHaveToolOutputFor(working.messages, ["web_search", "web_fetch"])) {
            json._internalWebEvidence = true;
        }
        return json;
    };

    const toolLoopReasonText = (reason) => {
        if (reason === "repeated_internal_tool_call") return "模型重复请求了同一个内部工具";
        if (reason === "internal_tool_loop_limit") return "内部工具调用次数已达到上限";
        return "内部工具调用已停止";
    };

    const toolResultSummary = () => {
        const results = (working.messages || [])
            .filter(message => message?.role === "tool")
            .slice(-4)
            .map((message, index) => {
                const content = clipForLog(message.content || "", 1200);
                return `工具结果 ${index + 1} (${message.tool_call_id || "unknown"}): ${content}`;
            })
            .join("\n\n");
        return results || "没有可用的工具结果。";
    };

    const finalizeWithoutTools = async (reason) => {
        const reasonText = toolLoopReasonText(reason);
        const finalBody = {
            ...working,
            tools: undefined,
            tool_choice: "none",
            messages: [
                { role: "system", content: `Internal web tool use has been stopped: ${reasonText}. You must now answer the user directly from the existing tool messages. Do not call web_search, web_fetch, or emit DSML/tool markup. If the evidence is insufficient, say what is missing in natural language.` },
                ...(working.messages || []),
                { role: "user", content: `工具调用已结束。请直接根据上面的 tool 结果回答我，不要再次请求 web_search/web_fetch，也不要输出 DSML/tool_calls 标记。如果证据不足，请用自然语言说明缺少什么。` },
            ],
            stream: false,
        };
        const finalResult = await callOnce(finalBody, "internal-finalize");
        const { status, json } = finalResult;
        if (finalResult.ok && json) {
            const content = extractAssistantText(json);
            const pseudoCalls = parsePseudoToolCalls(content);
            const msg = json.choices?.[0]?.message || {};
            const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (pseudoCalls.length === 0 && toolCalls.length === 0 && String(content || "").trim()) {
                return { ok: true, status, json: markInternalEvidence(json) };
            }
        }
        const fallback = [
            `${reasonText}，${TRANSLATOR_BRAND} 已停止继续调用工具，避免陷入重复循环。`,
            "",
            "已有工具结果摘要：",
            toolResultSummary(),
            "",
            "模型没有基于这些结果完成最终总结。请重试一个更具体的问题，或直接提供要抓取的 URL。",
        ].join("\n");
        return { ok: true, status: 200, json: markInternalEvidence(makeTextCompletion(working.model, fallback)) };
    };

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const upstreamResult = await callOnce(working, `internal-loop-${loop + 1}`);
        const { status, json, text } = upstreamResult;
        if (!upstreamResult.ok) return { ok: false, status, json, text };

        const msg = json.choices?.[0]?.message || {};
        const standardExternalCalls = (msg.tool_calls || []).filter(tc => !isInternalTool(tc?.function?.name));
        const pseudoCalls = parsePseudoToolCalls(msg.content);
        const pseudoInternalCalls = pseudoCalls.filter(tc => isInternalTool(tc?.function?.name));
        const pseudoExternalCalls = pseudoCalls.filter(tc => !isInternalTool(tc?.function?.name));
        const internalCalls = [
            ...(msg.tool_calls || []).filter(tc => isInternalTool(tc?.function?.name)),
            ...pseudoInternalCalls,
        ];
        if (internalCalls.length === 0) {
            const hasExternalCalls = standardExternalCalls.length > 0 || pseudoExternalCalls.length > 0;
            const assistantText = extractAssistantText(json);
            const hasToolEvidence = messagesHaveToolEvidence(working.messages);
            const hasWebToolEvidence = Boolean(explicitWebEvidence)
                || messagesHaveToolOutputFor(working.messages, ["web_search", "web_fetch"]);
            if (!hasExternalCalls && !String(assistantText || "").trim()) {
                if (emptyAssistantReplays < 1) {
                    emptyAssistantReplays += 1;
                    working.messages.push({ role: "user", content: emptyAssistantRelayPrompt() });
                    continue;
                }
                return { ok: true, status: 200, json: markInternalEvidence(makeTextCompletion(working.model, emptyAssistantBlockedMessage())) };
            }
            const shouldRelayFakeClaim = shouldBlockAssistantToolClaim(assistantText, {
                hasToolEvidence,
                hasWebToolEvidence,
                hasToolCall: hasExternalCalls,
            });
            if (shouldRelayFakeClaim) {
                if (fakeToolClaimReplays < MAX_FAKE_TOOL_CLAIM_REPLAYS) {
                    fakeToolClaimReplays += 1;
                    working.messages.push({ role: "assistant", content: assistantText || "" });
                    working.messages.push({ role: "user", content: fakeToolClaimRelayPromptFor(assistantText, { hasWebToolEvidence }) });
                    continue;
                }
                if (hasWebToolEvidence) {
                    return {
                        ok: true,
                        status: 200,
                        json: markInternalEvidence(makeTextCompletion(
                            working.model,
                            `Web access completed, but the model did not produce a reliable summary. Actual web tool evidence:\n\n${toolResultSummary()}`,
                        )),
                    };
                }
                return { ok: true, status: 200, json: markInternalEvidence(makeTextCompletion(working.model, blockedToolClaimMessageFor(assistantText, { hasWebToolEvidence }))) };
            }
            if (pseudoExternalCalls.length > 0) {
                const next = structuredClone(json);
                next.choices[0].message = {
                    ...msg,
                    content: null,
                    tool_calls: [...standardExternalCalls, ...pseudoExternalCalls],
                };
                return { ok: true, status, json: markInternalEvidence(next) };
            }
            return { ok: true, status, json: markInternalEvidence(json) };
        }

        const repeated = internalCalls.some(tc => {
            const key = `${tc.function?.name || ""}:${tc.function?.arguments || "{}"}`;
            return executedInternalCalls.has(key);
        });
        if (repeated) {
            return finalizeWithoutTools("repeated_internal_tool_call");
        }

        // Execute internal tools
        const assistantContent = pseudoCalls.length > 0 ? stripPseudoToolMarkup(msg.content) : msg.content;
        working.messages.push({ role: "assistant", content: assistantContent || null, ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}), tool_calls: internalCalls });
        for (const tc of internalCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
            const key = `${tc.function?.name || ""}:${tc.function?.arguments || "{}"}`;
            let result;
            try {
                result = await executeInternalTool(tc.function.name, args);
            } catch (error) {
                result = JSON.stringify({
                    ok: false,
                    error: error?.message || String(error || "internal tool failed"),
                    user_visible_guidance: "Internal tool execution failed in the translator. Continue with the partial evidence already available, or ask the user for a narrower request / specific URL.",
                });
            }
            executedInternalCalls.add(key);
            working.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        const forcedToolName = working.tool_choice?.function?.name || working.tool_choice?.name || "";
        if (forcedToolName && internalCalls.some(tc => tc?.function?.name === forcedToolName)) {
            working.tool_choice = "auto";
        }
    }

    return finalizeWithoutTools("internal_tool_loop_limit");
}

async function callAntigravityWithInternalTools(chatBody, dependencies = {}) {
    const endBusy = markAntigravityBusy("internal_tool_loop");
    const sharedQueue = dependencies.queue ?? ANTIGRAVITY_REQUEST_QUEUE;
    const hasInjectedCall = typeof dependencies.callQueued === "function";
    const callQueued = dependencies.callQueued ?? ((nextBody, nextDependencies) => callQueuedAntigravityUpstream(
        nextBody,
        { ...nextDependencies, queue: DIRECT_ANTIGRAVITY_REQUEST_QUEUE },
    ));
    try {
        const runToolLoop = async ({ signal } = {}) => {
            const loopDependencies = {
                ...dependencies,
                signal: dependencies.signal ?? signal,
            };
            const preparedBody = await seedExplicitInternalWebFetch(chatBody);
            const result = await callUpstreamWithInternalTools(preparedBody, {
                callOnce: async (nextBody) => {
                    try {
                        const json = await callQueued(nextBody, loopDependencies);
                        return { ok: true, status: 200, json };
                    } catch (error) {
                        const failure = antigravityFailureDetails(error);
                        return {
                            ok: false,
                            status: failure.status,
                            text: failure.message,
                            json: { error: failure },
                        };
                    }
                },
            });
            return { preparedBody, result };
        };
        const { preparedBody, result } = hasInjectedCall
            ? await runToolLoop()
            : await sharedQueue.run(runToolLoop, { signal: dependencies.signal });
        if (!result.ok) {
            const error = new Error(result.text || result.json?.error?.message || "Antigravity internal tool loop failed.");
            error.statusCode = result.status;
            error.type = result.json?.error?.type;
            throw error;
        }
        if (preparedBody?._internalWebEvidence) {
            const assistantText = extractAssistantText(result.json);
            if (shouldBlockAssistantToolClaim(assistantText, { hasToolEvidence: false, hasWebToolEvidence: false })) {
                const fallback = makeTextCompletion(
                    preparedBody.model,
                    `The requested web fetch completed, but the model did not produce a reliable summary. Actual fetched evidence:\n\n${clipForLog(preparedBody._internalWebEvidence, 4000)}`,
                );
                fallback._internalWebEvidence = true;
                return fallback;
            }
            result.json._internalWebEvidence = true;
        }
        return result.json;
    } finally {
        endBusy();
    }
}

async function seedExplicitInternalWebFetch(chatBody) {
    if (!chatBodyHasInternalTools(chatBody)) return chatBody;
    const messages = Array.isArray(chatBody?.messages) ? chatBody.messages : [];
    const latestUser = [...messages].reverse().find((message) => message?.role === "user");
    const text = typeof latestUser?.content === "string"
        ? latestUser.content
        : JSON.stringify(latestUser?.content ?? "");
    if (!/(?:web_fetch|fetch|open|read|browse|抓取|打开|读取|访问|看看)/i.test(text)) return chatBody;
    const url = text.match(/https?:\/\/[^\s<>"')\]}]+/i)?.[0]?.replace(/[.,;:!?，。；：！？]+$/, "");
    if (!url) return chatBody;

    const callId = `call_${randomUUID().replaceAll("-", "")}`;
    let result;
    try {
        result = await executeInternalTool("web_fetch", { url });
    } catch (error) {
        result = JSON.stringify({ ok: false, error: error?.message || String(error || "web_fetch failed") });
    }
    try {
        const parsed = JSON.parse(result);
        console.error(`[adaptive][web-fetch] explicit URL prefetch ${parsed?.ok === false ? "failed" : "completed"}`);
    } catch {
        console.error("[adaptive][web-fetch] explicit URL prefetch completed");
    }
    return {
        ...chatBody,
        _internalWebEvidence: result,
        messages: [
            ...messages,
            {
                role: "assistant",
                content: null,
                tool_calls: [{ id: callId, type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }],
            },
            { role: "tool", tool_call_id: callId, content: result },
            {
                role: "user",
                content: "The requested web_fetch call is complete. Answer the original user request now using the tool result above. Do not call web_fetch again and do not describe a future tool action.",
            },
        ],
    };
}

function makeTextCompletion(model, content) {
    return { id: `chatcmpl_${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

async function callUpstreamOnce(body) {
    const { res, text, json } = await postChatCompletion({ ...body, stream: false }, "once");
    return res.ok ? { ok: true, status: res.status, json } : { ok: false, status: res.status, json, text };
}

function canUseNativeStreaming(parsed, chatBody, compact) {
    if (compact) return false;
    if (parsed.stream === false) return false;
    if (UPSTREAM_PROTOCOL === "anthropic") return false;
    if (process.env.TRANSLATOR_NATIVE_STREAMING !== "1") return false;
    if (PROFILE?.capabilities?.nativeStreaming === false) return false;
    if (PROFILE?.capabilities?.internalWebTools !== false && toolsToInject(PROFILE).length > 0) return false;
    if (Array.isArray(chatBody.tools) && chatBody.tools.length > 0) return false;
    return true;
}

const INTERNAL_WEB_INTENT_RE = /(?:联网|上网|网上|网页|网站|网址|链接|官网|搜索|搜一下|查找|查一下|查资料|检索|新闻|最新消息|实时信息|今天.{0,8}(?:消息|新闻|情况)|web\s*(?:search|fetch)|search\s+(?:the\s+)?web|look\s+up|browse|fetch\s+(?:this|the)?\s*(?:url|page)|latest\s+(?:news|information|version|release)|current\s+(?:news|information|status))/i;

function recentUserTextForInternalWeb(request) {
    const chunks = [];
    const appendContent = (content) => {
        if (typeof content === "string") chunks.push(content);
        else if (Array.isArray(content)) {
            for (const part of content) appendContent(part?.text ?? part?.input_text ?? part?.content ?? part);
        }
    };
    if (typeof request?.input === "string") chunks.push(request.input);
    else if (Array.isArray(request?.input)) {
        for (const item of request.input) {
            if (item?.role === "user" || item?.type === "message") appendContent(item?.content);
        }
    }
    if (Array.isArray(request?.messages)) {
        for (const message of request.messages) {
            if (message?.role === "user") appendContent(message.content);
        }
    }
    return chunks.slice(-3).join("\n");
}

function preferredInternalWebToolName(request) {
    const choiceName = request?.tool_choice?.function?.name || request?.tool_choice?.name || "";
    if (choiceName === "web_search" || choiceName === "web_fetch") return choiceName;
    const text = recentUserTextForInternalWeb(request);
    if (!text.trim()) return "";
    if (/https?:\/\/\S+/i.test(text)) return "web_fetch";
    return INTERNAL_WEB_INTENT_RE.test(text) ? "web_search" : "";
}

function chatBodyWithInternalTools(body, options = {}) {
    const internal = toolsToInject(PROFILE);
    if (!internal.length) return body;
    const existing = Array.isArray(body?.tools) ? body.tools : [];
    const names = new Set(existing.map((tool) => tool?.function?.name).filter(Boolean));
    const next = {
        ...body,
        tools: [...existing, ...internal.filter((tool) => !names.has(tool?.function?.name))],
    };
    const preferred = options.preferInternalWebToolChoice === true ? preferredInternalWebToolName(body) : "";
    if (preferred && (!body?.tool_choice || body.tool_choice === "auto")
        && next.tools.some((tool) => tool?.function?.name === preferred)) {
        next.tool_choice = { type: "function", function: { name: preferred } };
    }
    return next;
}

function requestNeedsInternalWebTools(request) {
    return Boolean(preferredInternalWebToolName(request));
}

function chatBodyHasInternalTools(body) {
    return Array.isArray(body?.tools) && body.tools.some((tool) => isInternalTool(tool?.function?.name));
}

// ──────────────────────────────────────────────────── compaction ─────────────

const SESSIONS = new Map();
const WINDOW_MS = 30_000;

function shouldInjectEndTurn(req, body) {
    const sid = req.headers?.["session_id"];
    if (typeof sid !== "string" || !sid) return false;
    const wg = (() => { const v = req.headers?.["x-codex-window-id"]; if (typeof v !== "string" || !v) return null; const n = Number.parseInt(v.split(":").pop(), 10); return Number.isFinite(n) ? n : null; })();
    if (wg === null) return false;
    const now = Date.now();
    let e = SESSIONS.get(sid);
    if (!e) { e = { ts: null, gen: null }; SESSIONS.set(sid, e); }
    const isC = (req?.path || "").endsWith("/compact");
    if (isC) { e.ts = now; e.gen = wg; return false; }
    const r = e.ts !== null && now - e.ts < WINDOW_MS && e.gen !== null && wg > e.gen;
    e.ts = null; e.gen = wg;
    return r;
}

// ──────────────────────────────────────────────────── SSE ────────────────────

function pipeSSE(res, fmt) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
    const sse = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    const inProg = { ...fmt, status: "in_progress", output: [] };
    sse("response.created", { type: "response.created", response: inProg });
    sse("response.in_progress", { type: "response.in_progress", response: inProg });
    emitResponseOutputEvents(sse, fmt);
    sse("response.completed", { type: "response.completed", response: fmt });
    res.end();
}

function emitResponseOutputEvents(sse, fmt, options = {}) {
    const chunkSize = options.chunkSize ?? 40;
    let idx = options.startIndex ?? 0;
    for (const item of fmt.output || []) {
        if (item.type === "message") {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", content: [] } });
            if (item.content) for (let ci = 0; ci < item.content.length; ci++) {
                const p = item.content[ci];
                sse("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: idx, content_index: ci, part: { type: "output_text", text: "" } });
                const t = p.text || "";
                for (let i = 0; i < t.length; i += chunkSize) sse("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: idx, content_index: ci, delta: t.slice(i, i + chunkSize) });
                sse("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: idx, content_index: ci, text: t });
                sse("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: idx, content_index: ci, part: p });
            }
            sse("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        } else if (item.type === "function_call") {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", arguments: "" } });
            const a = item.arguments || "{}";
            sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: idx, item_id: item.id, call_id: item.call_id, name: item.name, delta: a });
            sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: idx, item_id: item.id, call_id: item.call_id, name: item.name, arguments: a });
            sse("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        } else if (item.type === "custom_tool_call") {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", input: "" } });
            sse("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        } else {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress" } });
            sse("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        }
        idx++;
    }
}

function responseHasPendingToolCalls(response) {
    return Array.isArray(response?.output) && response.output.some((item) => {
        const type = String(item?.type ?? "");
        return type === "function_call" || type === "custom_tool_call" || type.endsWith("_tool_call");
    });
}

function chatBodyNeedsAntigravitySessionLock(chatBody) {
    return Array.isArray(chatBody?.tools) && chatBody.tools.length > 0;
}

async function acquireAntigravitySessionLease(parsed, chatBody, signal) {
    if (!chatBodyNeedsAntigravitySessionLock(chatBody)) return null;
    return ANTIGRAVITY_SESSION_LOCK.acquire({
        previousResponseId: parsed?.previous_response_id,
        signal,
    });
}

function settleAntigravitySessionLease(lease, response) {
    if (!lease) return;
    if (responseHasPendingToolCalls(response) && response?.id) {
        lease.continueWith(response.id);
        return;
    }
    lease.release();
}

function releaseAntigravitySessionLease(lease) {
    try { lease?.release?.(); } catch {}
}

function resetAntigravitySessionLock(reason = "manager_action") {
    const before = ANTIGRAVITY_SESSION_LOCK.snapshot();
    const result = ANTIGRAVITY_SESSION_LOCK.reset({ reason });
    const after = ANTIGRAVITY_SESSION_LOCK.snapshot();
    return { ok: true, before, result, after };
}

async function callQueuedAntigravityUpstream(chatBody, dependencies = {}) {
    const endBusy = markAntigravityBusy("queued_upstream");
    const circuit = dependencies.circuit ?? ANTIGRAVITY_FAILURE_CIRCUIT;
    const queue = dependencies.queue ?? ANTIGRAVITY_REQUEST_QUEUE;
    const routeAudit = dependencies.routeAudit ?? ANTIGRAVITY_MODEL_ROUTE_AUDIT;
    const startedAtMs = Date.now();
    circuit.beforeRequest();
    try {
        const completion = await queue.run(({ signal }) => callAntigravityUpstream(chatBody, {
            onModelRouted: (route) => routeAudit.record(route),
            onRetry: dependencies.onRetry ?? recordAntigravityRetry,
            signal: dependencies.signal ?? signal,
            onCascadeStarted: dependencies.onCascadeStarted,
            disableRetry: dependencies.disableRetry,
        }), { signal: dependencies.signal });
        circuit.recordSuccess();
        recordAntigravityTrafficSuccess({ startedAtMs });
        return completion;
    } catch (error) {
        if (error?.name !== "AbortError" && error?.name !== "AntigravityCircuitOpenError" && error?.type !== "antigravity_queue_full") circuit.recordFailure(error);
        if (shouldRecordAntigravityTrafficFailure(error)) recordAntigravityTrafficFailure(error);
        throw error;
    } finally {
        endBusy();
    }
}

async function pipeAntigravityInternalToolsAsSSE(req, res, chatBody, parsed, routing = null, dependencies = {}) {
    const registry = dependencies.registry ?? ACTIVE_ANTIGRAVITY_REQUESTS;
    const sessionLease = dependencies.sessionLease ?? null;
    const id = responseId();
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const model = parsed.model || chatBody.model || "gemini-pro-agent";
    const inProgress = responseShell(parsed, { id, created, model, status: "in_progress", output: [] });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    registry.register(id, { controller });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
    sse("response.created", { type: "response.created", response: inProgress });
    sse("response.in_progress", { type: "response.in_progress", response: inProgress });
    const startedAtMs = Date.now();
    try {
        const completion = await callAntigravityWithInternalTools(chatBody, {
            ...dependencies,
            signal: controller.signal,
            onCascadeStarted: (cascade) => { void registry.attachCascade(id, cascade); },
        });
        completion.id = id;
        completion.created = created;
        const fmt = chatToResponsesFormat(completion, parsed, routing, { strictTools: true });
        if (shouldInjectEndTurn(req, parsed)) fmt.end_turn = false;
        RESPONSE_HISTORY.remember(fmt, parsed);
        settleAntigravitySessionLease(sessionLease, fmt);
        recordAntigravityTrafficSuccess({ startedAtMs });
        emitResponseOutputEvents(sse, fmt);
        sse("response.completed", { type: "response.completed", response: fmt });
    } catch (error) {
        releaseAntigravitySessionLease(sessionLease);
        if (controller.signal.aborted || error?.name === "AbortError") {
            const cancelled = cancelledResponse(id);
            sse("response.cancelled", { type: "response.cancelled", response: cancelled });
        } else {
            const failure = shouldRecordAntigravityTrafficFailure(error)
                ? recordAntigravityTrafficFailure(error)
                : antigravityFailureDetails(error);
            const failed = {
                ...responseShell(parsed, { id, created, model, status: "failed", output: [] }),
                error: {
                    type: failure.type,
                    diagnosis: failure.diagnosis || null,
                    status: failure.status || null,
                    message: failure.message,
                    retryable: failure.retryable,
                },
            };
            sse("response.failed", { type: "response.failed", response: failed });
        }
    } finally {
        registry.finish(id);
        res.end();
    }
}

async function pipeAntigravityResponseAsSSE(req, res, chatBody, parsed, routing = null, dependencies = {}) {
    const registry = dependencies.registry ?? ACTIVE_ANTIGRAVITY_REQUESTS;
    const sessionLease = dependencies.sessionLease ?? null;
    const streamUpstream = dependencies.streamUpstream ?? streamAntigravityUpstream;
    const queue = dependencies.queue ?? ANTIGRAVITY_REQUEST_QUEUE;
    const circuit = dependencies.circuit ?? ANTIGRAVITY_FAILURE_CIRCUIT;
    const routeAudit = dependencies.routeAudit ?? ANTIGRAVITY_MODEL_ROUTE_AUDIT;
    const id = responseId();
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const model = parsed.model || chatBody.model || "gemini-pro-agent";
    const inProgress = responseShell(parsed, { id, created, model, status: "in_progress", output: [] });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const streamedMessageId = messageId();
    let streamedText = "";
    let messageOpened = false;
    let textWasRevised = false;
    let completion = null;
    const toolCapable = Array.isArray(chatBody?.tools) && chatBody.tools.length > 0;

    const openMessage = () => {
        if (messageOpened) return;
        messageOpened = true;
        sse("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: streamedMessageId, role: "assistant", status: "in_progress", content: [] },
        });
        sse("response.content_part.added", {
            type: "response.content_part.added",
            item_id: streamedMessageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        });
    };

    const emitTextDelta = (delta) => {
        if (!delta) return;
        openMessage();
        streamedText += delta;
        sse("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: streamedMessageId,
            output_index: 0,
            content_index: 0,
            delta,
        });
    };

    registry.register(id, { controller });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
    sse("response.created", { type: "response.created", response: inProgress });
    sse("response.in_progress", { type: "response.in_progress", response: inProgress });

    const startedAtMs = Date.now();
    const endBusy = markAntigravityBusy("streaming_response");
    try {
        circuit.beforeRequest();
        let workingChatBody = chatBody;
        let fakeToolClaimStreamReplays = 0;
        let fmt = null;
        while (true) {
            streamedText = "";
            textWasRevised = false;
            completion = null;
            await queue.run(async () => {
                for await (const event of streamUpstream(workingChatBody, {
                    responseId: id,
                    created,
                    signal: controller.signal,
                    onCascadeStarted: (cascade) => { void registry.attachCascade(id, cascade); },
                    onModelRouted: (route) => routeAudit.record(route),
                    onRetry: dependencies.onRetry ?? recordAntigravityRetry,
                })) {
                    if (controller.signal.aborted) {
                        throw controller.signal.reason ?? new DOMException("Anti-Codex response was cancelled.", "AbortError");
                    }
                    if (event?.type === "text_delta") {
                        const delta = String(event.delta ?? "");
                        if (toolCapable) streamedText += delta;
                        else if (textWasRevised) streamedText += delta;
                        else emitTextDelta(delta);
                    } else if (event?.type === "text_replace") {
                        streamedText = String(event.text ?? "");
                        textWasRevised = true;
                    } else if (event?.type === "done") {
                        completion = event.completion;
                    }
                }
            }, { signal: controller.signal });
            if (!completion) throw new Error("Antigravity stream ended without a completed response.");
            completion.id = id;
            completion.created = created;
            fmt = chatToResponsesFormat(completion, parsed, routing, { strictTools: true });
            const assistantText = extractAssistantText(completion);
            const hasWebToolEvidence = requestHasToolOutputFor(parsed, ["web_search", "web_fetch"]);
            const shouldReplayFakeClaim = toolCapable
                && !responseOutputHasToolCall(fmt.output)
                && fakeToolClaimStreamReplays < MAX_FAKE_TOOL_CLAIM_REPLAYS
                && shouldBlockAssistantToolClaim(assistantText, {
                    hasToolEvidence: requestHasToolEvidence(parsed),
                    hasToolCall: false,
                    hasWebToolEvidence,
                });
            if (!shouldReplayFakeClaim) break;
            fakeToolClaimStreamReplays += 1;
            workingChatBody = {
                ...workingChatBody,
                messages: [
                    ...(workingChatBody.messages || []),
                    { role: "assistant", content: assistantText || "" },
                    { role: "user", content: fakeToolClaimRelayPromptFor(assistantText, { hasWebToolEvidence }) },
                ],
            };
        }
        if (!fmt) throw new Error("Antigravity stream ended without a formatted response.");
        circuit.recordSuccess();
        recordAntigravityTrafficSuccess({ startedAtMs });
        if (controller.signal.aborted) {
            throw controller.signal.reason ?? new DOMException("Anti-Codex response was cancelled.", "AbortError");
        }
        if (shouldInjectEndTurn(req, parsed)) fmt.end_turn = false;
        RESPONSE_HISTORY.remember(fmt, parsed);
        settleAntigravitySessionLease(sessionLease, fmt);

        const finalMessage = fmt.output.find((item) => item?.type === "message");
        if (finalMessage) {
            const finalText = finalMessage.content?.find((part) => part?.type === "output_text")?.text ?? "";
            if (!textWasRevised && finalText.startsWith(streamedText)) emitTextDelta(finalText.slice(streamedText.length));
            openMessage();
            finalMessage.id = streamedMessageId;
            sse("response.output_text.done", {
                type: "response.output_text.done",
                item_id: streamedMessageId,
                output_index: 0,
                content_index: 0,
                text: finalText,
            });
            sse("response.content_part.done", {
                type: "response.content_part.done",
                item_id: streamedMessageId,
                output_index: 0,
                content_index: 0,
                part: finalMessage.content[0],
            });
            sse("response.output_item.done", {
                type: "response.output_item.done",
                output_index: 0,
                item: finalMessage,
            });
        }

        const remainingOutput = fmt.output.filter((item) => item !== finalMessage);
        if (remainingOutput.length > 0) {
            emitResponseOutputEvents(sse, { ...fmt, output: remainingOutput }, { startIndex: finalMessage ? 1 : 0 });
        }
        sse("response.completed", { type: "response.completed", response: fmt });
    } catch (error) {
        releaseAntigravitySessionLease(sessionLease);
        if (controller.signal.aborted || error?.name === "AbortError") {
            const cancelled = cancelledResponse(id);
            sse("response.cancelled", { type: "response.cancelled", response: cancelled });
        } else {
            if (error?.name !== "AntigravityCircuitOpenError" && error?.type !== "antigravity_queue_full") circuit.recordFailure(error);
            const failure = shouldRecordAntigravityTrafficFailure(error)
                ? recordAntigravityTrafficFailure(error)
                : antigravityFailureDetails(error);
            const failed = {
                ...responseShell(parsed, { id, created, model, status: "failed", output: [] }),
                error: {
                    type: failure.type,
                    diagnosis: failure.diagnosis || null,
                    status: failure.status || null,
                    message: failure.message,
                    retryable: failure.retryable,
                },
            };
            sse("response.failed", { type: "response.failed", response: failed });
        }
    } finally {
        endBusy();
        registry.finish(id);
        res.end();
    }
}

function translatedToolParts(tc, routing = null) {
    const upstreamName = tc.function?.name || tc.name || "";
    const route = routing?.[upstreamName];
    const codexName = route?.codexName || upstreamName;
    const isCustom = route?.type === "custom";
    let args = tc.function?.arguments ?? tc.arguments ?? "";
    if (isCustom && args) {
        try {
            const parsed = JSON.parse(args);
            if (typeof parsed.content === "string") args = parsed.content;
        } catch {}
    }
    return { name: codexName, arguments: args, callId: tc.id || tc.call_id || `call_${randomUUID().replaceAll("-", "")}` };
}

function invalidCustomToolMessage(name) {
    const tool = name || "custom/freeform tool";
    return [
        `${tool} requires a complete freeform patch/tool body, not empty JSON.`,
        "Regenerate a valid patch body and call the tool with {\"content\":\"*** Begin Patch\\n...\\n*** End Patch\"}.",
        "For apply_patch, each file hunk must start with exactly one of \"*** Add File:\", \"*** Delete File:\", or \"*** Update File:\" and the final line must be exactly \"*** End Patch\".",
        "Do not use narrative headers, ordinary unified diff headers (---/+++), or line-number replacement prose inside the patch body.",
        "Do not bypass this by writing source files with shell commands just because the freeform tool call was malformed.",
    ].join("\n");
}

function customArgumentsAreInvalid(args, route) {
    if (route?.type !== "custom") return false;
    const text = String(args ?? "").trim();
    if (!text) return true;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") return false;
        if (Object.keys(parsed).length === 0) return true;
        if (Object.prototype.hasOwnProperty.call(parsed, "content")) {
            return typeof parsed.content !== "string" || parsed.content.trim().length === 0;
        }
        return true;
    } catch {
        return false;
    }
}

function unwrapCustomArguments(args, route) {
    if (route?.type !== "custom" || !args) return args || "";
    try {
        const parsed = JSON.parse(args);
        if (typeof parsed.content === "string") return parsed.content;
    } catch {}
    return args;
}

class ChatToResponsesStreamMapper {
    constructor(original, model, routing = null, options = {}) {
        this.original = originalRequestFromArg(original);
        this.model = model || this.original.model || "gpt-5.5";
        this.routing = routing;
        this.bufferTextDeltas = options.bufferTextDeltas ?? (Array.isArray(this.original?.tools) && this.original.tools.length > 0);
        this.responseId = responseId();
        this.messageId = messageId();
        this.created = Math.floor(Date.now() / 1000);
        this.started = false;
        this.completed = false;
        this.nextOutputIndex = 0;
        this.text = "";
        this.textOutputIndex = null;
        this.textOutputOpened = false;
        this.reasoning = null;
        this.toolCalls = new Map();
        this.usage = null;
    }

    allocateOutputIndex() { return this.nextOutputIndex++; }

    currentResponse(status, output = [], usage = null, finishReason = null) {
        return responseShell(this.original, {
            id: this.responseId,
            created: this.created,
            model: this.model,
            status,
            output,
            usage,
            finishReason,
        });
    }

    pushChunk(chunk) {
        const events = [];
        if (!this.started) {
            this.started = true;
            events.push(["response.created", { type: "response.created", response: this.currentResponse("in_progress", [], null) }]);
            events.push(["response.in_progress", { type: "response.in_progress", response: this.currentResponse("in_progress", [], null) }]);
        }

        if (chunk.usage) this.usage = mapUsage(chunk.usage);
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
            const delta = choice?.delta || {};
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                events.push(...this.pushReasoningDelta(delta.reasoning_content));
            }
            if (Array.isArray(delta.tool_calls)) {
                delta.tool_calls.forEach((tc, i) => events.push(...this.pushToolCallDelta(tc, i)));
            }
            if (typeof delta.content === "string" && delta.content.length > 0) {
                events.push(...this.pushTextDelta(delta.content));
            }
            if (choice?.finish_reason && !this.completed) {
                events.push(...this.complete(choice.finish_reason));
            }
        }
        return events;
    }

    pushReasoningDelta(delta) {
        const events = [];
        if (!this.reasoning) {
            this.reasoning = { id: reasoningId(), outputIndex: this.allocateOutputIndex(), content: "", done: false };
            events.push(["response.output_item.added", {
                type: "response.output_item.added",
                output_index: this.reasoning.outputIndex,
                item: { id: this.reasoning.id, type: "reasoning", status: "in_progress", summary: [] },
            }]);
        }
        this.reasoning.content += delta;
        return events;
    }

    openTextOutput(events) {
        if (this.textOutputIndex === null) this.textOutputIndex = this.allocateOutputIndex();
        if (this.textOutputOpened) return;
        this.textOutputOpened = true;
        events.push(["response.output_item.added", {
            type: "response.output_item.added",
            output_index: this.textOutputIndex,
            item: { type: "message", id: this.messageId, role: "assistant", status: "in_progress", content: [] },
        }]);
        events.push(["response.content_part.added", {
            type: "response.content_part.added",
            item_id: this.messageId,
            output_index: this.textOutputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        }]);
    }

    pushTextDelta(delta) {
        const events = [];
        if (this.textOutputIndex === null) this.textOutputIndex = this.allocateOutputIndex();
        this.text += delta;
        if (this.bufferTextDeltas) return events;
        this.openTextOutput(events);
        events.push(["response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: this.messageId,
            content_index: 0,
            delta,
        }]);
        return events;
    }

    pushToolCallDelta(delta, fallbackIndex) {
        const index = Number.isInteger(delta?.index) ? delta.index : fallbackIndex;
        let tc = this.toolCalls.get(index);
        if (!tc) {
            tc = { itemId: functionCallId(), callId: delta?.id || `call_${randomUUID().replaceAll("-", "")}`, name: null, arguments: "", emitted: 0, outputIndex: this.allocateOutputIndex(), opened: false };
            this.toolCalls.set(index, tc);
        }
        if (!tc.opened && delta?.id) tc.callId = delta.id;
        const fn = delta?.function || {};
        if (typeof fn.name === "string" && fn.name.length > 0) {
            tc.upstreamName = fn.name;
            tc.route = this.routing?.[fn.name] || null;
            tc.name = translatedToolParts({ id: tc.callId, function: { name: fn.name, arguments: "" } }, this.routing).name;
        }
        if (typeof fn.arguments === "string") tc.arguments += fn.arguments;

        const events = [];
        const isCustom = tc.route?.type === "custom";
        if (!tc.opened && tc.name && !isCustom) {
            tc.opened = true;
            const item = { id: tc.itemId, type: "function_call", status: "in_progress", call_id: tc.callId, name: tc.name, arguments: "" };
            events.push(["response.output_item.added", {
                type: "response.output_item.added",
                output_index: tc.outputIndex,
                item,
            }]);
        }
        if (tc.route?.type !== "custom" && tc.opened && tc.emitted < tc.arguments.length) {
            const argDelta = tc.arguments.slice(tc.emitted);
            tc.emitted = tc.arguments.length;
            events.push(["response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                item_id: tc.itemId,
                output_index: tc.outputIndex,
                call_id: tc.callId,
                name: tc.name,
                delta: argDelta,
            }]);
        }
        return events;
    }

    completedItems() {
        const items = [];
        if (this.reasoning) {
            items.push([this.reasoning.outputIndex, { id: this.reasoning.id, type: "reasoning", status: "completed", summary: [], encrypted_content: encodeReasoningContent(this.reasoning.content) }]);
        }
        if (this.textOutputIndex !== null) {
            const hasWebToolEvidence = requestHasToolOutputFor(this.original, ["web_search", "web_fetch"]);
            const text = shouldBlockAssistantToolClaim(this.text, {
                hasToolEvidence: requestHasToolEvidence(this.original),
                hasToolCall: this.toolCalls.size > 0,
                hasWebToolEvidence,
            })
                ? blockedToolClaimMessageFor(this.text, { hasWebToolEvidence })
                : sanitizeMarkdownUrlFormatting(this.text);
            items.push([this.textOutputIndex, { type: "message", id: this.messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]);
        }
        for (const tc of this.toolCalls.values()) {
            if (!tc.name) continue;
            if (customArgumentsAreInvalid(tc.arguments, tc.route)) {
                items.push([tc.outputIndex, { type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidCustomToolMessage(tc.name), annotations: [] }] }]);
                continue;
            }
            const args = unwrapCustomArguments(tc.arguments, tc.route);
            const item = tc.route?.type === "custom"
                ? { id: tc.itemId, type: "custom_tool_call", status: "completed", call_id: tc.callId, name: tc.name, input: args }
                : { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: args };
            items.push([tc.outputIndex, item]);
        }
        return items.sort((a, b) => a[0] - b[0]);
    }

    complete(finishReason = "stop") {
        if (this.completed) return [];
        this.completed = true;
        const events = [];
        if (this.reasoning && !this.reasoning.done) {
            this.reasoning.done = true;
            events.push(["response.output_item.done", {
                type: "response.output_item.done",
                output_index: this.reasoning.outputIndex,
                item: { id: this.reasoning.id, type: "reasoning", status: "completed", summary: [], encrypted_content: encodeReasoningContent(this.reasoning.content) },
            }]);
        }
        if (this.textOutputIndex !== null) {
            const hasWebToolEvidence = requestHasToolOutputFor(this.original, ["web_search", "web_fetch"]);
            const text = shouldBlockAssistantToolClaim(this.text, {
                hasToolEvidence: requestHasToolEvidence(this.original),
                hasToolCall: this.toolCalls.size > 0,
                hasWebToolEvidence,
            })
                ? blockedToolClaimMessageFor(this.text, { hasWebToolEvidence })
                : sanitizeMarkdownUrlFormatting(this.text);
            const item = { type: "message", id: this.messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
            this.openTextOutput(events);
            if (this.bufferTextDeltas && text) {
                events.push(["response.output_text.delta", { type: "response.output_text.delta", item_id: this.messageId, output_index: this.textOutputIndex, content_index: 0, delta: text }]);
            }
            events.push(["response.output_text.done", { type: "response.output_text.done", item_id: this.messageId, output_index: this.textOutputIndex, content_index: 0, text }]);
            events.push(["response.content_part.done", { type: "response.content_part.done", item_id: this.messageId, output_index: this.textOutputIndex, content_index: 0, part: item.content[0] }]);
            events.push(["response.output_item.done", { type: "response.output_item.done", output_index: this.textOutputIndex, item }]);
        }
        for (const tc of this.toolCalls.values()) {
            if (!tc.name) continue;
            if (customArgumentsAreInvalid(tc.arguments, tc.route)) {
                const item = { type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidCustomToolMessage(tc.name), annotations: [] }] };
                if (!tc.opened) {
                    tc.opened = true;
                    events.push(["response.output_item.added", { type: "response.output_item.added", output_index: tc.outputIndex, item: { ...item, status: "in_progress" } }]);
                }
                events.push(["response.output_item.done", { type: "response.output_item.done", output_index: tc.outputIndex, item }]);
                continue;
            }
            const args = unwrapCustomArguments(tc.arguments, tc.route);
            const isCustom = tc.route?.type === "custom";
            const item = isCustom
                ? { id: tc.itemId, type: "custom_tool_call", status: "completed", call_id: tc.callId, name: tc.name, input: args }
                : { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: args };
            if (!isCustom) {
                events.push(["response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: tc.itemId, output_index: tc.outputIndex, call_id: tc.callId, name: tc.name, arguments: args }]);
            } else if (!tc.opened) {
                tc.opened = true;
                events.push(["response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: tc.outputIndex,
                    item: { id: tc.itemId, type: "custom_tool_call", status: "in_progress", call_id: tc.callId, name: tc.name, input: "" },
                }]);
            }
            events.push(["response.output_item.done", { type: "response.output_item.done", output_index: tc.outputIndex, item }]);
        }
        const output = this.completedItems().map(([, item]) => item);
        events.push(["response.completed", { type: "response.completed", response: this.currentResponse(responseStatus(finishReason), output, this.usage, finishReason) }]);
        return events;
    }
}

async function pipeStreamingChatAsResponses(req, res, body, model, parsed, routing = null) {
    const upstreamBody = normalizeUpstreamBody({ ...body, stream: true });
    const debugId = debugUpstreamRequest("native-stream", upstreamBody);
    const upstreamRequest = buildUpstreamChatRequest(activeUpstreamProfile({ model: upstreamBody.model }), upstreamBody);
    const controller = new AbortController();
    let responseEnded = false;
    const abortStreaming = () => {
        if (responseEnded || controller.signal.aborted) return;
        controller.abort(new DOMException("Anti-Codex streaming client disconnected.", "AbortError"));
    };
    const cleanupStreamingListeners = () => {
        responseEnded = true;
        req.off?.("aborted", abortStreaming);
        req.off?.("close", abortStreaming);
        res.off?.("close", abortStreaming);
    };
    req.on?.("aborted", abortStreaming);
    req.on?.("close", abortStreaming);
    res.on?.("close", abortStreaming);
    let upstream;
    try {
        upstream = await fetch(upstreamRequest.url, {
            method: "POST",
            headers: upstreamRequest.headers,
            body: JSON.stringify(upstreamRequest.body),
            signal: controller.signal,
        });
    } catch (error) {
        cleanupStreamingListeners();
        throw error;
    }
    debugUpstreamResponse(debugId, upstream.status, null, upstream.ok ? "streaming response opened" : "");

    if (!upstream.ok) {
        const text = await upstream.text();
        debugUpstreamResponse(debugId, upstream.status, null, text);
        cleanupStreamingListeners();
        return fail(res, upstream.status, text ? text.slice(0, 500) : `Upstream ${upstream.status}`);
    }
    recordProviderModelRoute({
        requestId: `stream_${Date.now()}`,
        requestedModel: upstreamBody.model,
        resolvedModel: upstreamBody.model,
        status: "streaming",
    });

    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
    const sse = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    const mapper = new ChatToResponsesStreamMapper(parsed, model, routing);
    let endTurnChecked = false;
    const emit = (ev, payload) => {
        if (ev === "response.completed" && !endTurnChecked) {
            endTurnChecked = true;
            if (shouldInjectEndTurn(req, parsed)) payload.response.end_turn = false;
            RESPONSE_HISTORY.remember(payload.response, parsed);
        }
        sse(ev, payload);
    };

    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for await (const chunk of upstream.body) {
            if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Anti-Codex streaming client disconnected.", "AbortError");
            buffer += decoder.decode(chunk, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() || "";
            for (const frame of frames) {
                const dataLines = frame.split("\n").filter(line => line.startsWith("data:"));
                for (const line of dataLines) {
                    const data = line.slice(5).trim();
                    if (!data || data === "[DONE]") continue;
                    let json = null;
                    try { json = JSON.parse(data); } catch { continue; }
                    for (const [ev, payload] of mapper.pushChunk(json)) emit(ev, payload);
                }
            }
        }
        if (!mapper.completed) {
            for (const [ev, payload] of mapper.complete("stop")) emit(ev, payload);
        }
    } finally {
        cleanupStreamingListeners();
    }
    res.end();
}

// ──────────────────────────────────────────────────── body ───────────────────

async function readRaw(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let raw = Buffer.concat(chunks);
    const enc = (req.headers["content-encoding"] || "").toLowerCase();
    try {
        if (enc === "zstd") {
            if (typeof zlib.zstdDecompressSync !== "function") {
                const error = new Error("This Node.js runtime does not support zstd request decompression. Install Node.js 23+ or use the bundled/recommended runtime.");
                error.statusCode = 415;
                throw error;
            }
            raw = zlib.zstdDecompressSync(raw);
        } else if (enc === "gzip") raw = zlib.gunzipSync(raw);
        else if (enc === "deflate") raw = zlib.inflateSync(raw);
        else if (enc === "br") raw = zlib.brotliDecompressSync(raw);
    } catch (error) {
        if (!error.statusCode) error.statusCode = 400;
        error.message = `Failed to decode request body (${enc || "identity"}): ${error.message || error}`;
        throw error;
    }
    return raw;
}

// ──────────────────────────────────────────────────── server ─────────────────

async function startup() {
    if (isAntigravityUpstreamMode(UPSTREAM_MODE)) {
        PROFILE = antigravityProfileFromCatalog(loadAntigravityCatalog());
        console.error(`[adaptive] Profile: antigravity / ${PROFILE.defaultModel} (${PROFILE.models.length} models)`);
        try {
            await ANTIGRAVITY_READINESS?.check();
            writeLifecycleEvent("startup_ready", { message: "Antigravity readiness check completed." });
        } catch (error) {
            writeLifecycleEvent("startup_readiness_degraded", { error: safeErrorSummary(error) });
            console.error(`[adaptive] Antigravity readiness check failed during startup: ${error.message || error}`);
        } finally {
            ANTIGRAVITY_READINESS?.start();
        }
        return;
    }
    if (!UPSTREAM_KEY) { console.error("[adaptive] UPSTREAM_API_KEY not set."); return; }
    try {
        PROFILE = UPSTREAM_PROTOCOL === "anthropic"
            ? thirdPartyProfileForStartup()
            : applyConfiguredUpstreamModel(
                UPSTREAM_MODEL
                    ? await probeCapabilities(UPSTREAM, UPSTREAM_KEY)
                    : (loadProfileFromFile() || await probeCapabilities(UPSTREAM, UPSTREAM_KEY)),
            );
        const internal = toolsToInject(PROFILE);
        console.error(`[adaptive] Profile: ${PROFILE.provider} / ${PROFILE.defaultModel}`);
        console.error(`[adaptive]   vision=${PROFILE.capabilities.vision} hosted=${PROFILE.capabilities.hostedTools}`);
        console.error(`[adaptive]   internal tools to inject: ${internal.map(t => t.function.name).join(", ") || "none"}`);
    } catch (e) { console.error(`[adaptive] Probe failed: ${e.message}`); }
}

function isLocalTranslatorAddress(remoteAddress, host = HOST) {
    const normalized = String(remoteAddress || "").replace(/^::ffff:/, "");
    return normalized === "127.0.0.1" || normalized === "::1" || normalized === host;
}

function unsupportedResponsesWebSocketResponse() {
    return {
        status: 501,
        body: {
            error: {
                message: "Responses websocket is not supported by this local translator; use HTTP fallback.",
                type: "unsupported_websocket",
            },
        },
    };
}

function isResponsesWebSocketPath(pathname) {
    return pathname === "/responses" || pathname === "/v1/responses" || pathname === "/codex/responses";
}

function unsupportedResponsesWebSocketHttpResponse(status = 501) {
    const body = JSON.stringify(unsupportedResponsesWebSocketResponse().body);
    const reason = status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Not Implemented";
    return [
        `HTTP/1.1 ${status} ${reason}`,
        "content-type: application/json; charset=utf-8",
        "cache-control: no-cache",
        "connection: close",
        `content-length: ${Buffer.byteLength(body)}`,
        "",
        body,
    ].join("\r\n");
}

function upstreamDisplayName() {
    return isAntigravityUpstreamMode(UPSTREAM_MODE) ? "antigravity-desktop" : UPSTREAM;
}

const server = http.createServer(async (req, res) => {
    if (!isLocalTranslatorAddress(req.socket.remoteAddress)) {
        return fail(res, 403, "Anti-Codex translator only accepts requests from this computer.");
    }
    if (req.method === "OPTIONS") {
        res.writeHead(204, localCorsHeaders({
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "authorization,content-type,content-encoding,x-anticodex-manager-token",
        }));
        return res.end();
    }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
        return jsonResponse(res, 200, translatorHealthPayload({
            readiness: ANTIGRAVITY_READINESS?.getSnapshot() ?? null,
            circuit: ANTIGRAVITY_FAILURE_CIRCUIT.snapshot(),
        }));
    }

    const localBackend = localBackendApiResponse(req.method, url.pathname);
    if (localBackend) {
        return jsonResponse(res, 200, localBackend);
    }

    if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
        return jsonResponse(res, 200, visibleModelPayload());
    }

    if (req.method === "GET" && url.pathname === "/anticodex/model-routes") {
        return jsonResponse(res, 200, ANTIGRAVITY_MODEL_ROUTE_AUDIT.snapshot());
    }

    if (req.method === "GET" && url.pathname === "/anticodex/upstream-profile") {
        try {
            const saved = await runUpstreamProfileScript("GetPublic");
            return jsonResponse(res, 200, {
                ok: true,
                active: isAntigravityUpstreamMode(UPSTREAM_MODE) ? "antigravity" : "third-party",
                runtime: isAntigravityUpstreamMode(UPSTREAM_MODE)
                    ? { mode: "antigravity" }
                    : publicUpstreamProfile(activeUpstreamProfile()),
                saved,
            });
        } catch (error) {
            return fail(res, error.statusCode || 500, error.message);
        }
    }

    if (req.method === "POST" && url.pathname === "/anticodex/upstream-test") {
        const validation = validateManagerActionRequest(req);
        if (!validation.ok) return fail(res, validation.status, validation.message);
        try {
            const raw = await readRaw(req);
            const body = JSON.parse(raw.toString("utf8") || "{}");
            let apiKey = String(body.apiKey || "");
            if (!apiKey) {
                const savedRuntime = await runUpstreamProfileScript("GetRuntime");
                apiKey = String(savedRuntime.apiKey || "");
            }
            const profile = activeUpstreamProfile({
                protocol: body.protocol,
                baseUrl: body.baseUrl,
                apiKey,
                model: body.model,
            });
            const stages = await testUpstreamConnection(profile, { timeoutMs: Number(body.timeoutMs || 10_000) });
            const ok = stages.length > 0 && stages.every((stage) => stage.status !== "fail");
            return jsonResponse(res, 200, { ok, stages: sanitizedConnectionStages(stages) });
        } catch (error) {
            return jsonResponse(res, 200, {
                ok: false,
                stages: [{ stage: "配置验证", status: "fail", detail: error.message || "配置无效" }],
            });
        }
    }

    if (req.method === "POST" && url.pathname === "/anticodex/upstream-profile") {
        const validation = validateManagerActionRequest(req);
        if (!validation.ok) return fail(res, validation.status, validation.message);
        try {
            const raw = await readRaw(req);
            const body = JSON.parse(raw.toString("utf8") || "{}");
            if (body.mode === "antigravity") {
                const saved = await runUpstreamProfileScript("UseAntigravity");
                return jsonResponse(res, 200, { ok: true, saved, restartRequired: true });
            }
            let apiKey = String(body.apiKey || "");
            if (!apiKey) {
                const savedRuntime = await runUpstreamProfileScript("GetRuntime");
                apiKey = String(savedRuntime.apiKey || "");
            }
            const profile = activeUpstreamProfile({
                protocol: body.protocol,
                baseUrl: body.baseUrl,
                apiKey,
                model: body.model,
            });
            const stages = await testUpstreamConnection(profile, { timeoutMs: Number(body.timeoutMs || 10_000) });
            const testStatus = stages.length && stages.every((stage) => stage.status !== "fail") ? "success" : "pending";
            if (testStatus !== "success") {
                const error = new Error("请先完成“测试连通”，确认接口可用后再保存。");
                error.statusCode = 400;
                throw error;
            }
            const capabilities = {
                ...(body.capabilities || {}),
                connectionStages: sanitizedConnectionStages(stages),
                providerModels: providerModelIdsFromConnectionStages(stages, body.model),
            };
            const saved = await runUpstreamProfileScript("SaveThirdParty", {
                protocol: body.protocol,
                baseUrl: body.baseUrl,
                model: body.model,
                apiKey: body.apiKey,
                testStatus,
                capabilitiesJson: JSON.stringify(capabilities),
            });
            return jsonResponse(res, 200, { ok: true, saved, restartRequired: true });
        } catch (error) {
            return fail(res, error.statusCode || 400, error.message);
        }
    }

    if (req.method === "POST" && url.pathname === "/anticodex/upstream-apply") {
        const validation = validateManagerActionRequest(req);
        if (!validation.ok) return fail(res, validation.status, validation.message);
        try {
            const scriptPath = managerScriptPath({ script: "apply-anticodex-upstream.ps1" });
            const child = spawn(powershellPath(), [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath,
            ], {
                cwd: MANAGER_SCRIPTS_ROOT,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
                env: process.env,
            });
            child.unref();
            return jsonResponse(res, 200, { ok: true, restarting: true, pid: child.pid });
        } catch (error) {
            return fail(res, 500, error.message);
        }
    }

    if (req.method === "GET" && url.pathname === "/anticodex/local-connectors/allowlist") {
        const guard = validateManagerSourceRequest(req, "local connector allowlist");
        if (!guard.ok) return fail(res, guard.status, guard.message);
        return jsonResponse(res, 200, localConnectorAllowlistPayload());
    }

    if (req.method === "POST" && url.pathname === "/anticodex/local-connectors/allowlist") {
        const guard = validateManagerActionRequest(req);
        if (!guard.ok) return fail(res, guard.status, guard.message);
        try {
            const raw = await readRaw(req);
            let parsed = {};
            if (raw.length > 0) {
                try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            }
            const connectorIds = validateLocalConnectorIds(parsed.connectorIds);
            const configPath = writePersistedLocalConnectorAllowlist(connectorIds);
            return jsonResponse(res, 200, {
                ...localConnectorAllowlistPayload(),
                saved: true,
                configPath,
            });
        } catch (error) {
            return fail(res, error.statusCode || 500, error.message);
        }
    }

    if (req.method === "GET" && (url.pathname === "/anticodex/manager" || url.pathname === "/anticodex/manager/")) {
        return htmlResponse(res, 200, anticodexManagerHtml());
    }

    if (req.method === "GET" && url.pathname === "/anticodex/manager/inject.js") {
        try {
            return javascriptResponse(res, 200, readFileSync(resolvePath(MANAGER_SCRIPTS_ROOT, "anticodex-manager-inject.js"), "utf8"));
        } catch (error) {
            return fail(res, 500, error.message);
        }
    }

    if (req.method === "GET" && url.pathname === "/anticodex/manager/bootstrap") {
        const guard = validateManagerSourceRequest(req, "manager bootstrap");
        if (!guard.ok) return fail(res, guard.status, guard.message);
        return jsonResponse(res, 200, managerBootstrapPayload());
    }

    if (req.method === "GET" && url.pathname === "/anticodex/manager/action-script") {
        const callbackName = url.searchParams.get("callback") || "";
        if (!isValidJsonpCallbackName(callbackName)) {
            return fail(res, 400, "Invalid Anti-Codex manager action callback.");
        }
        if (url.searchParams.get("token") !== MANAGER_ACTION_TOKEN) {
            return fail(res, 403, "Anti-Codex manager action token is missing or invalid.");
        }
        const guard = validateManagerSourceRequest(req, "manager action");
        if (!guard.ok) return fail(res, guard.status, guard.message);
        try {
            const action = String(url.searchParams.get("action") || "");
            const payload = await runManagerBridgeAction(action);
            return javascriptResponse(res, 200, managerActionScriptResponse(callbackName, payload));
        } catch (error) {
            const payload = {
                ok: false,
                action: String(url.searchParams.get("action") || ""),
                message: error.message,
                statusCode: error.statusCode || 500,
            };
            return javascriptResponse(res, 200, managerActionScriptResponse(callbackName, payload));
        }
    }

    if (req.method === "POST" && url.pathname === "/anticodex/manager/action") {
        try {
            const guard = validateManagerActionRequest(req);
            if (!guard.ok) return fail(res, guard.status, guard.message);
            const raw = await readRaw(req);
            let parsed = {};
            if (raw.length > 0) {
                try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            }
            return jsonResponse(res, 200, await runManagerBridgeAction(String(parsed.action || "")));
        } catch (error) {
            return fail(res, error.statusCode || 500, error.message);
        }
    }

    if (req.method === "GET" && url.pathname === "/anticodex/diagnostics") {
        return jsonResponse(res, 200, diagnosticsPayload());
    }

    if (req.method === "GET" && url.pathname === "/anticodex/account") {
        try {
            const payload = await fetchAntigravityUserStatus({
                timeoutMs: ANTIGRAVITY_READINESS_TIMEOUT_MS,
            });
            return jsonResponse(res, 200, antigravityAccountSnapshot(payload));
        } catch (error) {
            return jsonResponse(res, 200, antigravityAccountFallbackSnapshot(error));
        }
    }

    if (req.method === "POST" && url.pathname === "/anticodex/models/refresh") {
        try {
            return jsonResponse(res, 200, await refreshModelsForActiveUpstream());
        } catch (error) {
            const failure = antigravityFailureDetails(error);
            return failWithDetails(res, error.statusCode || failure.status, failure);
        }
    }

    if (req.method === "GET" && isResponsesWebSocketPath(url.pathname)) {
        const unsupported = unsupportedResponsesWebSocketResponse();
        recordResponsesWebSocketAttempt(req, {
            kind: "http-prewarm",
            status: unsupported.status,
            responseType: unsupported.body.error.type,
            pathname: url.pathname,
        });
        return jsonResponse(res, unsupported.status, unsupported.body);
    }

    if (req.method === "POST" && (url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions")) {
        try {
            const raw = await readRaw(req);
            let parsed;
            try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            if (isAntigravityUpstreamMode(UPSTREAM_MODE)) {
                const readinessFailure = antigravityReadinessFailure(ANTIGRAVITY_READINESS?.getSnapshot());
                if (readinessFailure) {
                    recordAntigravityTrafficFailure(readinessFailure);
                    return failWithDetails(res, readinessFailure.status, readinessFailure);
                }
                const chatBody = requestNeedsInternalWebTools(parsed)
                    ? chatBodyWithInternalTools(parsed, { preferInternalWebToolChoice: true })
                    : parsed;
                const startedAtMs = Date.now();
                const completion = await callAntigravityWithInternalTools(chatBody);
                recordAntigravityTrafficSuccess({ startedAtMs });
                return jsonResponse(res, 200, completion);
            }
            const upstreamResp = await postChatCompletion(parsed, "chat-compat");
            if (!upstreamResp.res.ok) {
                const failure = classifyUpstreamFailure(upstreamResp.res.status, upstreamResp.text, upstreamResp.json);
                console.error(`[adaptive][chat-compat] upstream failure ${JSON.stringify(failure)}`);
                return failWithDetails(res, upstreamResp.res.status, failure);
            }
            res.writeHead(upstreamResp.res.status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
            return res.end(JSON.stringify(upstreamResp.json));
        } catch (e) {
            if (e?.type === "response_history_missing") {
                return failWithDetails(res, e.statusCode || 410, {
                    type: e.type,
                    status: e.statusCode || 410,
                    retryable: false,
                    message: e.message,
                    previous_response_id: e.previous_response_id || null,
                });
            }
            if (isAntigravityUpstreamMode(UPSTREAM_MODE)) {
                const failure = shouldRecordAntigravityTrafficFailure(e)
                    ? recordAntigravityTrafficFailure(e)
                    : antigravityFailureDetails(e);
                return failWithDetails(res, failure.status, failure);
            }
            return fail(res, e.statusCode || 500, e.message);
        }
    }

    if (req.method === "POST" && (url.pathname === "/responses/input_tokens" || url.pathname === "/v1/responses/input_tokens")) {
        try {
            const raw = await readRaw(req);
            let parsed = {};
            if (raw.length > 0) {
                try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
            return res.end(JSON.stringify(inputTokensResponse(parsed)));
        } catch (e) {
            return fail(res, e.statusCode || 500, e.message);
        }
    }

    const responseItemMatch = url.pathname.match(/^\/(?:v1\/)?responses\/([^/]+)\/input_items$/);
    if (req.method === "GET" && responseItemMatch) {
        const items = RESPONSE_HISTORY.listInputItems(responseItemMatch[1], {
            after: url.searchParams.get("after") || "",
            limit: url.searchParams.get("limit") || undefined,
            order: url.searchParams.get("order") || "desc",
        });
        return jsonResponse(res, 200, items);
    }

    const responseCancelMatch = url.pathname.match(/^\/(?:v1\/)?responses\/([^/]+)\/cancel$/);
    if (req.method === "POST" && responseCancelMatch) {
        const id = responseCancelMatch[1];
        const result = await ACTIVE_ANTIGRAVITY_REQUESTS.cancel(id);
        if (!result.found) return fail(res, 404, `Active response not found: ${id}`);
        return jsonResponse(res, 200, cancelledResponse(id));
    }

    if (req.method === "POST" && RESPONSES_PATHS.has(url.pathname)) {
        try {
            req.path = url.pathname;
            const raw = await readRaw(req);
            let parsed;
            try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            if (!parsed || typeof parsed !== "object") return fail(res, 400, "Empty body");
            parsed = RESPONSE_HISTORY.hydrate(parsed);

            const compact = url.pathname.endsWith("/compact");
            if (compact) { parsed.stream = false; parsed.store = false; }
            const antigravityMode = isAntigravityUpstreamMode(UPSTREAM_MODE);
            if (antigravityMode) {
                const readinessFailure = antigravityReadinessFailure(ANTIGRAVITY_READINESS?.getSnapshot());
                if (readinessFailure) {
                    recordAntigravityTrafficFailure(readinessFailure);
                    return failWithDetails(res, readinessFailure.status, readinessFailure);
                }
            }

            const internalWebNeeded = !compact && requestNeedsInternalWebTools(parsed);
            const systemBlock = compact ? "" : buildSystemBlock({ internalWebTools: internalWebNeeded });
            const chatBody = responsesToChatBody(parsed, {
                extraSystem: systemBlock,
                allowTools: !compact,
                injectInternalTools: internalWebNeeded,
                preferInternalWebToolChoice: internalWebNeeded,
            });
            chatBody.model = resolveModel(parsed.model);

            // Extract routing metadata from chatBody (must not be sent upstream)
            const routing = chatBody._routing || null;
            delete chatBody._routing;

            if (antigravityMode) {
                if (compact) {
                    const completion = await callQueuedAntigravityUpstream(prepareCompactChatBody(chatBody));
                    const fmt = chatToCompactResponseFormat(completion, parsed.model || "gpt-5.5", parsed);
                    shouldInjectEndTurn(req, parsed);
                    RESPONSE_HISTORY.remember(fmt, parsed);
                    return jsonResponse(res, 200, fmt);
                }
                let sessionLease = null;
                try {
                    sessionLease = await acquireAntigravitySessionLease(parsed, chatBody, req.signal);
                } catch (error) {
                    const failure = antigravityFailureDetails(error);
                    return failWithDetails(res, failure.status, failure);
                }
                if (parsed.stream !== false) {
                    if (chatBodyHasInternalTools(chatBody)) {
                        return pipeAntigravityInternalToolsAsSSE(req, res, chatBody, parsed, routing, { sessionLease });
                    }
                    return pipeAntigravityResponseAsSSE(req, res, chatBody, parsed, routing, { sessionLease });
                }
                try {
                    const startedAtMs = Date.now();
                    const completion = await callAntigravityWithInternalTools(chatBody);
                    const fmt = chatToResponsesFormat(completion, parsed, routing, { strictTools: true });
                    if (shouldInjectEndTurn(req, parsed)) fmt.end_turn = false;
                    RESPONSE_HISTORY.remember(fmt, parsed);
                    settleAntigravitySessionLease(sessionLease, fmt);
                    recordAntigravityTrafficSuccess({ startedAtMs });
                    return jsonResponse(res, 200, fmt);
                } catch (error) {
                    releaseAntigravitySessionLease(sessionLease);
                    throw error;
                }
            }

            if (compact) {
                const upstreamResp = await callUpstreamOnce(prepareCompactChatBody(chatBody));
                if (!upstreamResp.ok) return failWithDetails(res, upstreamResp.status, classifyUpstreamFailure(upstreamResp.status, upstreamResp.text, upstreamResp.json));
                const fmt = chatToCompactResponseFormat(upstreamResp.json, parsed.model || "gpt-5.5", parsed);
                shouldInjectEndTurn(req, parsed);
                RESPONSE_HISTORY.remember(fmt, parsed);
                res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
                return res.end(JSON.stringify(fmt));
            }

            if (canUseNativeStreaming(parsed, chatBody, compact)) {
                return pipeStreamingChatAsResponses(req, res, chatBody, parsed.model || "gpt-5.5", parsed, routing);
            }

            const upstreamResp = await callUpstreamWithInternalTools(chatBody);
            if (!upstreamResp.ok) return failWithDetails(res, upstreamResp.status, classifyUpstreamFailure(upstreamResp.status, upstreamResp.text, upstreamResp.json));

            const fmt = chatToResponsesFormat(upstreamResp.json, parsed, routing);
            if (shouldInjectEndTurn(req, parsed)) fmt.end_turn = false;
            RESPONSE_HISTORY.remember(fmt, parsed);

            pipeSSE(res, fmt);
        } catch (e) {
            if (e?.type === "response_history_missing") {
                return failWithDetails(res, e.statusCode || 410, {
                    type: e.type,
                    status: e.statusCode || 410,
                    retryable: false,
                    message: e.message,
                    previous_response_id: e.previous_response_id || null,
                });
            }
            if (isAntigravityUpstreamMode(UPSTREAM_MODE)) {
                const failure = shouldRecordAntigravityTrafficFailure(e)
                    ? recordAntigravityTrafficFailure(e)
                    : antigravityFailureDetails(e);
                failWithDetails(res, failure.status, failure);
            } else {
                fail(res, e.statusCode || 500, e.message);
            }
        }
        return;
    }

    console.error(`[adaptive] 404 local route ${req.method} ${url.pathname}`);
    fail(res, 404, `Not found: ${req.method} ${url.pathname}`);
});

server.on("upgrade", (req, socket) => {
    try {
        if (!isLocalTranslatorAddress(req.socket.remoteAddress)) {
            socket.write(unsupportedResponsesWebSocketHttpResponse(403));
            socket.end();
            return;
        }
        const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
        if (isResponsesWebSocketPath(url.pathname)) {
            recordResponsesWebSocketAttempt(req, {
                kind: "upgrade",
                status: 501,
                responseType: "unsupported_websocket",
                pathname: url.pathname,
            });
            socket.write(unsupportedResponsesWebSocketHttpResponse());
            socket.end();
            return;
        }
        const body = JSON.stringify({ error: { message: `Not found: websocket ${url.pathname}`, type: "not_found" } });
        socket.write([
            "HTTP/1.1 404 Not Found",
            "content-type: application/json; charset=utf-8",
            "connection: close",
            `content-length: ${Buffer.byteLength(body)}`,
            "",
            body,
        ].join("\r\n"));
        socket.end();
    } catch {
        try { socket.destroy(); } catch {}
    }
});

function isMainModule() {
    const entry = process.argv[1] ? resolvePath(process.argv[1]) : "";
    return entry && entry === fileURLToPath(import.meta.url);
}

if (process.env.NODE_ENV !== "test" && isMainModule()) {
    let shutdownStarted = false;
    const shutdown = async (signal) => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        console.error(`[adaptive] ${signal} received; cancelling active Antigravity requests.`);
        writeLifecycleEvent("shutdown", { signal });
        ANTIGRAVITY_READINESS?.stop();
        try { server.close(); } catch {}
        await Promise.race([
            Promise.all([
                ACTIVE_ANTIGRAVITY_REQUESTS.cancelAll(),
                Promise.resolve(ANTIGRAVITY_REQUEST_QUEUE.cancelAll()),
                Promise.resolve(ANTIGRAVITY_SESSION_LOCK.cancelAll()),
            ]),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        process.exit(0);
    };
    process.on("uncaughtException", (error) => {
        writeLifecycleEvent("uncaught_exception", { error: safeErrorSummary(error) });
        console.error(`[adaptive] uncaught exception: ${error.stack || error.message || error}`);
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        writeLifecycleEvent("unhandled_rejection", { error: safeErrorSummary(reason) });
        console.error(`[adaptive] unhandled rejection: ${reason?.stack || reason?.message || reason}`);
    });
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
    server.on("error", (error) => {
        writeLifecycleEvent("server_error", { error: safeErrorSummary(error) });
        console.error(`[adaptive] server error: ${error.message || error}`);
    });
    server.listen(PORT, LISTEN_HOST, () => {
        console.error(`[adaptive] http://${HOST}:${PORT} -> ${upstreamDisplayName()}`);
        writeLifecycleEvent("listening", { message: "Anti-Codex local gateway is listening." });
        void startup().catch((error) => {
            writeLifecycleEvent("startup_failed", { error: safeErrorSummary(error) });
            console.error(`[adaptive] startup failed: ${error.stack || error.message || error}`);
        });
    });
}

export { HOST, LISTEN_HOST, CDP_PORT, antigravityProfileFromCatalog, buildAntigravityModelRefresh, refreshAntigravityModels, providerModelRefreshSnapshot, refreshModelsForActiveUpstream, antigravityAccountFallbackSnapshot, antigravityFailureDetails, antigravityTrafficSnapshot, shouldRecordAntigravityTrafficFailure, applyAntigravityTrafficSuccess, applyAntigravityTrafficFailure, antigravityReadinessFailure, antigravityVisibleModelIds, translatorHealthPayload, diagnosticsPayload, visibleModelPayload, buildSystemBlock, hasPseudoToolMarkup, stripPseudoToolMarkup, sanitizeMarkdownUrlFormatting, parsePseudoToolCalls, responsesToChatBody, callUpstreamWithInternalTools, callAntigravityWithInternalTools, chatBodyWithInternalTools, requestNeedsInternalWebTools, chatBodyHasInternalTools, ChatToResponsesStreamMapper, chatToResponsesFormat, chatToCompactResponseFormat, prepareCompactChatBody, normalizeCompactSummary, canUseNativeStreaming, inputTokensResponse, unknownInputItemText, usageDiagnostics, classifyUpstreamFailure, localBackendApiResponse, isLocalTranslatorAddress, isResponsesWebSocketPath, unsupportedResponsesWebSocketResponse, unsupportedResponsesWebSocketHttpResponse, responsesWebSocketAuditSnapshot, recordResponsesWebSocketAttempt, upstreamDisplayName, pipeAntigravityResponseAsSSE, pipeAntigravityInternalToolsAsSSE, MAX_TOOL_LOOPS };
