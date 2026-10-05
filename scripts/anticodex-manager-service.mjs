import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
    buildCodexPlusPlusProbeRequest,
    testCodexPlusPlusUpstreamConnection,
} from "../translator/provider/codexplusplus-upstream-probe.mjs";
import { localBackendApiResponse } from "../translator/local-projection/index.mjs";
import {
    finishConnectorAuth,
    listConnectorAuth,
    startConnectorAuth,
} from "../translator/local-connectors/oauth-gateway.mjs";
import { createAntigravityAccountManager } from "./anticodex-antigravity-accounts.mjs";
import { createAntigravityAccountDriver } from "./anticodex-antigravity-accounts-driver.mjs";
import { createAntigravityOfficialLogin } from "./anticodex-antigravity-login.mjs";
import {
    promptPolicyPayload,
    readNativeCustomInstructions,
    saveNativeCustomInstructions,
    savePromptPolicy,
} from "../translator/provider/anticodex-prompt-policy.mjs";
import {
    THIRD_PARTY_MODEL_SLOT,
    THIRD_PARTY_RELAY_ID,
    thirdPartyNativeModel,
} from "./lib/anticodex-fixed-route.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACTIVE_FOREGROUND_ACTIONS = new Map();
const ACTIVE_BACKGROUND_ACTION_LOCKS = new Set();
const ACTIVE_BACKGROUND_ACTIONS = new Map();
const MANAGER_REPORT_STALE_MS_RAW = Number(process.env.ANTICODEX_MANAGER_REPORT_STALE_MS || 24 * 60 * 60 * 1000);
const MANAGER_REPORT_STALE_MS = Number.isFinite(MANAGER_REPORT_STALE_MS_RAW)
  ? Math.max(60 * 1000, MANAGER_REPORT_STALE_MS_RAW)
  : 24 * 60 * 60 * 1000;
const STARTUP_SNAPSHOT_SCHEMA = "anticodex-startup-snapshots-ready-v1";
const SNAPSHOT_SOURCE_CHECK_CACHE = new Map();
const SNAPSHOT_SOURCE_CHECK_MAX_AGE_MS = 5 * 60 * 1000;
const SNAPSHOT_SOURCE_CHECK_FAILURE_MAX_AGE_MS = 15 * 1000;
const UPSTREAM_TEST_EVIDENCE_TTL_MS = 2 * 60 * 1000;

const MANAGER_ACTIONS = Object.freeze({
    refreshStatus: {
        label: "刷新状态",
        virtual: true,
    },
    refreshModels: {
        label: "刷新模型",
        virtual: true,
    },
    accountSwitch: {
        label: "切换 Antigravity 账号",
        script: "open-antigravity-account-switch.ps1",
        args: [],
        timeoutMs: 60000,
    },
    accountProxy: {
        label: "账号/代理检查",
        script: "test-anticodex-account-proxy-readiness.ps1",
        args: ["-AllowUnready", "-NoRealRequest"],
        timeoutMs: 120000,
        foregroundSingleton: true,
    },
    syncReadiness: {
        label: "安装/同步检查",
        script: "test-anticodex-sync-readiness.ps1",
        args: ["-Fast", "-SkipAccountProxyProbe"],
        timeoutMs: 30000,
    },
    repairShortcuts: {
        label: "修复快捷方式",
        script: "repair-anticodex-shortcuts.ps1",
        args: [],
        timeoutMs: 30000,
    },
    updateCheck: {
        label: "检查全部更新",
        script: "check-anticodex-update.ps1",
        args: ["-CheckRemoteComponents"],
        timeoutMs: 30000,
    },
    sourcePreflight: {
        label: "运行源码预检",
        script: "test-anticodex-source-preflight.ps1",
        args: ["-SkipFullRegression"],
        timeoutMs: 90000,
        foregroundSingleton: true,
    },
    syncHost: {
        label: "一键更新",
        script: "sync-anticodex-launcher.ps1",
        args: [],
        timeoutMs: 10000,
        foregroundSingleton: true,
    },
    mcpSkills: {
        label: "检查 MCP/Skill",
        script: "test-anticodex-mcp-skills.ps1",
        args: ["-TimeoutSec", "300"],
        timeoutMs: 360000,
        foregroundSingleton: true,
    },
    pluginCapabilities: {
        label: "检查插件/应用",
        script: "test-anticodex-plugin-capabilities.ps1",
        args: ["-TimeoutSec", "120"],
        timeoutMs: 180000,
        foregroundSingleton: true,
    },
    refreshFeatures: {
        label: "刷新本地功能",
        script: "refresh-anticodex-local-features.ps1",
        args: [],
        timeoutMs: 300000,
        foregroundSingleton: true,
    },
    stabilitySoak: {
        label: "稳定性巡检（耗真实流量）",
        script: "test-anticodex-stability-soak.ps1",
        args: [],
        timeoutMs: 10000,
        background: true,
        backgroundMutex: "real-provider-traffic",
        singletonProcessPattern: "test-anticodex-stability-soak\\.ps1",
        backgroundLockMaxMs: 20 * 60000,
    },
    coldRelaunch: {
        label: "冷启动验证（重启 Anti-Codex）",
        script: "test-anticodex-cold-relaunch.ps1",
        args: ["-ConfirmRelaunch"],
        timeoutMs: 10000,
        background: true,
        singletonProcessPattern: "test-anticodex-cold-relaunch\\.ps1",
        backgroundLockMaxMs: 10 * 60000,
    },
    fastOverallNoTraffic: {
        label: "快速检查（不耗流量）",
        script: "test-anticodex-installed-overall.ps1",
        args: ["-EnsureRunning", "-NoTraffic", "-SkipAccountProxyProbe", "-Fast", "-SkipManagerActionProbe", "-SubcheckTimeoutSec", "30", "-FastMaxElapsedMs", "90000", "-IncludePostVerification", "false"],
        timeoutMs: 90000,
        foregroundSingleton: true,
    },
    overallNoTraffic: {
        label: "整体检查（不耗流量）",
        script: "test-anticodex-installed-overall.ps1",
        args: ["-EnsureRunning", "-NoTraffic", "-SkipAccountProxyProbe", "-SkipManagerActionProbe", "-SkipUiStateProbe"],
        timeoutMs: 240000,
        foregroundSingleton: true,
    },
    diagnosticsBundle: {
        label: "生成诊断包",
        script: "collect-anticodex-diagnostics.ps1",
        args: ["-NoPopup"],
        timeoutMs: 120000,
        foregroundSingleton: true,
    },
    viewLatestReports: {
        label: "查看最新报告",
        virtual: true,
    },
    postVerificationFull: {
        label: "验证后完整检查（耗真实流量）",
        script: "test-anticodex-post-verification.ps1",
        args: ["-OpenAntigravityOnVerification"],
        timeoutMs: 10000,
        background: true,
        backgroundMutex: "real-provider-traffic",
        singletonProcessPattern: "test-anticodex-post-verification\\.ps1",
        backgroundLockMaxMs: 20 * 60000,
    },
});

const MANAGER_ACTION_GROUPS = Object.freeze({
  status: Object.freeze(["refreshStatus"]),
  modelSources: Object.freeze(["refreshModels", "accountSwitch"]),
  updates: Object.freeze(["updateCheck", "syncHost"]),
  troubleshooting: Object.freeze(["repairShortcuts", "diagnosticsBundle", "viewLatestReports"]),
  advanced: Object.freeze([
    "accountProxy", "syncReadiness", "sourcePreflight", "mcpSkills",
    "pluginCapabilities", "refreshFeatures", "fastOverallNoTraffic",
    "overallNoTraffic", "stabilitySoak", "coldRelaunch", "postVerificationFull",
  ]),
});

const HIGH_IMPACT_MANAGER_ACTION_IDS = Object.freeze([
  "syncHost",
  "refreshFeatures",
  "stabilitySoak",
  "coldRelaunch",
  "fastOverallNoTraffic",
  "overallNoTraffic",
  "postVerificationFull",
]);

// PowerShell arg formatting helpers
function psSingleQuoted(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function psArgument(value) {
    const text = String(value);
    if (/^-[A-Za-z][A-Za-z0-9]*$/.test(text)) return text;
    return psSingleQuoted(text);
}

function powershellPath() {
    const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
    return path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function managerScriptPath(action, scriptsRoot) {
    const scriptPath = path.resolve(scriptsRoot, action.script);
    const rel = path.relative(scriptsRoot, scriptPath);
    if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(scriptPath)) {
        throw { statusCode: 404, message: `Missing Anti-Codex manager script: ${action.script}` };
    }
    return scriptPath;
}

// Loopback detection
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function getHostname(hostHeader) {
  if (!hostHeader) return "";
  const host = String(hostHeader).trim().toLowerCase();
  const match = host.match(/^\[([^\]]+)\](?::\d+)?$/) || host.match(/^([^:]+)(?::\d+)?$/);
  return match ? match[1] : host;
}

function isLoopbackHost(hostHeader) {
  return LOOPBACK_HOSTNAMES.has(getHostname(hostHeader));
}

function isTrustedOrigin(originOrReferer) {
  if (!originOrReferer) return false;
  if (String(originOrReferer).toLowerCase() === "null") return false;
  try {
    const url = new URL(originOrReferer);
    if (url.protocol === "app:") return true;
    if (url.protocol === "http:") {
      return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
    }
  } catch {}
  return false;
}

function isTrustedManagerSource(originOrReferer, hostHeader) {
  if (!originOrReferer || !isLoopbackHost(hostHeader)) return false;
  try {
    const url = new URL(originOrReferer);
    if (url.protocol === "app:") {
      return url.hostname === "-";
    }
    if (url.protocol !== "http:") return false;
    const requestHost = String(hostHeader || "").trim().toLowerCase();
    return requestHost !== "" && url.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

// Global request origin/host validation
function validateLoopbackAndTrusted(req, res) {
  const hostHeader = req.headers.host;
  if (!isLoopbackHost(hostHeader)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Host must be a loopback address" }));
    return false;
  }
  const origin = req.headers.origin;
  if (origin && !isTrustedOrigin(origin)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Origin must be trusted loopback or app" }));
    return false;
  }
  const referer = req.headers.referer;
  if (referer && !isTrustedOrigin(referer)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Referer must be trusted loopback or app" }));
    return false;
  }
  return true;
}

function validateManagerSourceRequest(req, res, subject = "manager") {
  const hasOrigin = Boolean(req.headers.origin);
  const hasReferer = Boolean(req.headers.referer);
  if (!hasOrigin && !hasReferer) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, status: 403, message: `Anti-Codex ${subject} source is not trusted.` }));
    return false;
  }
  if (!validateLoopbackAndTrusted(req, res)) return false;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if ((origin && !isTrustedManagerSource(origin, req.headers.host))
      || (referer && !isTrustedManagerSource(referer, req.headers.host))) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, status: 403, message: `Anti-Codex ${subject} must come from the copied client or this Manager origin.` }));
    return false;
  }
  return true;
}

function validateManagerActionRequest(req, res, expectedToken) {
  const token = req.headers["x-anticodex-manager-token"] || "";
  if (token !== expectedToken) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, status: 403, message: "Anti-Codex manager action token is missing or invalid." }));
    return false;
  }
  return validateManagerSourceRequest(req, res, "manager action");
}

function respondToPreflight(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isTrustedManagerSource(origin, req.headers.host)) {
    return jsonResponse(res, 403, { ok: false, error: "Origin must be the copied client or this Manager origin" }, req);
  }
  res.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-anticodex-manager-token",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "vary": "Origin",
    "x-content-type-options": "nosniff",
  });
  res.end();
}

function readRequestBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        reject(new Error("Request body limit exceeded"));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

function jsonResponse(res, status, data, req = null) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  if (req && req.headers.origin && isTrustedOrigin(req.headers.origin)) {
    headers["access-control-allow-origin"] = req.headers.origin;
    headers["access-control-allow-credentials"] = "true";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function javascriptResponse(res, status, text) {
  res.writeHead(status, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(text);
}

// JSONP Callback check
function isValidJsonpCallbackName(name) {
    return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(String(name || ""));
}

function managerActionScriptResponse(callbackName, payload) {
    return `;try{globalThis[${JSON.stringify(callbackName)}](${JSON.stringify(payload)});}catch(e){console.error(e);}`;
}

// Running processes check for singletons
async function managerActionRunningProcesses(action, scriptsRoot) {
    if (!action?.singletonProcessPattern) return [];
    const command = [
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        `$pattern = ${psSingleQuoted(action.singletonProcessPattern)}`,
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction Stop",
        "| Where-Object { $_.ProcessId -ne $PID -and [string]$_.CommandLine -match $pattern }",
        "| Select-Object -First 5 @{Name='pid';Expression={$_.ProcessId}}, @{Name='commandLine';Expression={$_.CommandLine}}",
        "| ConvertTo-Json -Compress",
    ].join(" ");
    try {
        const { stdout } = await execFileAsync(powershellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
            cwd: scriptsRoot,
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        const trimmed = String(stdout || "").trim();
        if (!trimmed) return [];
        let parsed = JSON.parse(trimmed);
        if (!parsed) return [];
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
        throw error;
    }
}

// Run action
async function runManagerAction(actionName, stateRoot, scriptsRoot, runtime = {}) {
    const action = MANAGER_ACTIONS[actionName];
    if (!action) {
        throw { statusCode: 404, message: `Unknown Anti-Codex manager action: ${actionName}` };
    }
    const label = action.label || actionName;
    const scriptPath = managerScriptPath(action, scriptsRoot);

    const scriptArgs = [...(action.args || [])];
    if (["mcpSkills", "pluginCapabilities", "refreshFeatures"].includes(actionName)) {
        const codexHome = process.env.CODEX_HOME_DIR || process.env.CODEX_HOME || (stateRoot ? path.resolve(stateRoot, "codex-home-deepseek-app") : "");
        let marker = null;
        try {
            const markerPath = path.resolve(codexHome, ".anticodex-startup-snapshots-ready.json");
            if (fs.existsSync(markerPath)) {
                marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
            }
        } catch {}
        const agentsSkillsPath = marker?.extraSkillsRootInfo?.agentsSkillsPath || marker?.agentsSkillsPath;
        if (agentsSkillsPath) scriptArgs.push("-AgentsSkillsPath", agentsSkillsPath);
    }

    const command = [
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        `& ${psSingleQuoted(scriptPath)} ${scriptArgs.map(psArgument).join(" ")}`,
    ].join("; ");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];

    if (action.background) {
        const lockKey = action.backgroundMutex || action.singletonProcessPattern || actionName;
        const conflictPayload = (task = {}, running = []) => {
            const conflictingAction = task.actionName || actionName;
            const conflictingLabel = task.label || MANAGER_ACTIONS[conflictingAction]?.label || conflictingAction;
            return {
                ok: true,
                action: actionName,
                label,
                background: true,
                alreadyRunning: true,
                conflictingAction,
                conflictingLabel,
                runningPids: running.length > 0
                  ? running.map((item) => Number(item?.pid)).filter(Number.isFinite)
                  : (Number.isFinite(Number(task.pid)) ? [Number(task.pid)] : []),
                backgroundStartedAt: task.backgroundStartedAt || "",
                message: conflictingAction === actionName
                  ? `${conflictingLabel} 已经在后台运行。`
                  : `${conflictingLabel} 正在后台运行，不能同时启动${label}。`,
            };
        };
        if (ACTIVE_BACKGROUND_ACTION_LOCKS.has(lockKey)) {
            return conflictPayload(ACTIVE_BACKGROUND_ACTIONS.get(lockKey));
        }
        ACTIVE_BACKGROUND_ACTION_LOCKS.add(lockKey);
        const lockTask = { actionName, label, pid: null, backgroundStartedAt: "" };
        ACTIVE_BACKGROUND_ACTIONS.set(lockKey, lockTask);
        try {
            const conflictCandidates = action.backgroundMutex
              ? Object.entries(MANAGER_ACTIONS).filter(([, candidate]) => candidate.backgroundMutex === action.backgroundMutex)
              : [[actionName, action]];
            for (const [candidateName, candidate] of conflictCandidates) {
              let running;
              try {
                running = await (runtime.findRunningProcesses || managerActionRunningProcesses)(candidate, scriptsRoot);
              } catch {
                if (!action.backgroundMutex) continue;
                throw {
                  statusCode: 503,
                  message: `无法确认是否已有耗真实流量的后台任务，暂不启动${label}。请稍后重试。`,
                };
              }
              if (running.length === 0) continue;
              if (ACTIVE_BACKGROUND_ACTIONS.get(lockKey) === lockTask) ACTIVE_BACKGROUND_ACTIONS.delete(lockKey);
              ACTIVE_BACKGROUND_ACTION_LOCKS.delete(lockKey);
              return conflictPayload({ actionName: candidateName, label: candidate.label }, running);
            }
            const child = (runtime.spawn || spawn)(powershellPath(), args, {
                cwd: scriptsRoot,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            const backgroundStartedAt = new Date().toISOString();
            Object.assign(lockTask, { pid: child.pid, backgroundStartedAt });
            let lockTimer = null;
            const clearLock = () => {
                if (ACTIVE_BACKGROUND_ACTIONS.get(lockKey) !== lockTask) return;
                ACTIVE_BACKGROUND_ACTION_LOCKS.delete(lockKey);
                ACTIVE_BACKGROUND_ACTIONS.delete(lockKey);
                if (lockTimer) (runtime.clearTimeout || clearTimeout)(lockTimer);
                lockTimer = null;
            };
            child.once("exit", clearLock);
            child.once("error", clearLock);
            lockTimer = (runtime.setTimeout || setTimeout)(() => {
                lockTimer = null;
                clearLock();
            }, action.backgroundLockMaxMs || 30 * 60000);
            lockTimer.unref?.();
            child.unref();
            return {
                ok: true,
                action: actionName,
                label,
                background: true,
                pid: child.pid,
                backgroundStartedAt,
                message: `${label} 已在后台开始。`,
            };
        } catch (error) {
            ACTIVE_BACKGROUND_ACTION_LOCKS.delete(lockKey);
            if (ACTIVE_BACKGROUND_ACTIONS.get(lockKey) === lockTask) ACTIVE_BACKGROUND_ACTIONS.delete(lockKey);
            throw error;
        }
    }

    const foregroundLockKey = action.foregroundSingleton ? (action.script ? `${actionName}:${action.script}` : actionName) : "";
    if (foregroundLockKey) {
        const existing = ACTIVE_FOREGROUND_ACTIONS.get(foregroundLockKey);
        if (existing) {
            return {
                ok: true,
                action: actionName,
                label,
                alreadyRunning: true,
                foreground: true,
                foregroundStartedAt: existing.foregroundStartedAt || "",
                message: `${label} 已经在运行。`,
            };
        }
        ACTIVE_FOREGROUND_ACTIONS.set(foregroundLockKey, { actionName, label, foregroundStartedAt: new Date().toISOString() });
    }

    try {
        const { stdout, stderr } = await execFileAsync(powershellPath(), args, {
            cwd: scriptsRoot,
            timeout: action.timeoutMs,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        });
        let parsed = null;
        const trimmed = String(stdout || "").trim();
        if (trimmed) {
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                const start = trimmed.indexOf("{");
                const end = trimmed.lastIndexOf("}");
                if (start >= 0 && end > start) {
                    try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch {}
                }
            }
        }
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
        let parsedResult = null;
        try {
            const trimmed = String(error.stdout || "").trim();
            parsedResult = JSON.parse(trimmed);
        } catch {}
        return {
            ok: false,
            action: actionName,
            label,
            exitCode: error.code ?? null,
            timedOut: Boolean(error.killed && error.signal === "SIGTERM"),
            message: error.message,
            result: parsedResult,
            stderr: String(error.stderr || "").trim(),
        };
    } finally {
        if (foregroundLockKey) ACTIVE_FOREGROUND_ACTIONS.delete(foregroundLockKey);
    }
}

async function runManagerBridgeAction(actionName, stateRoot, scriptsRoot, callbacks = {}) {
    if (actionName === "refreshStatus") {
        if (typeof callbacks.refreshStatus !== "function") {
            throw { statusCode: 503, message: "Anti-Codex status refresh is not ready." };
        }
        const result = await callbacks.refreshStatus();
        return { ok: result?.ok !== false, action: actionName, result };
    }
    if (actionName === "viewLatestReports") {
        return { ok: true, action: actionName, result: latestManagerReportsPayload(stateRoot) };
    }
    if (actionName === "refreshModels") {
        if (typeof callbacks.refreshModels !== "function") {
            throw { statusCode: 503, message: "Anti-Codex model refresh is not ready." };
        }
        const result = await callbacks.refreshModels();
        return {
            ok: result?.ok !== false,
            action: actionName,
            result,
        };
    }
    return runManagerAction(actionName, stateRoot, scriptsRoot, callbacks.managerActionRuntime);
}

// Reports helpers
const REPORT_SUMMARY_PASSTHROUGH_FIELDS = Object.freeze([
  "architecture",
  "approvalPlan",
  "codexPlusPlusProgress",
  "completedGates",
  "coverageKind",
  "currentGate",
  "damagedReports",
  "gates",
  "missingOptional",
  "missingRequired",
  "missingShort",
  "nextActions",
  "nextActionsAvailableCount",
  "nextActionsHiddenCount",
  "overallProgress",
  "optionalRealProviderEvidence",
  "optionalRealTrafficFailures",
  "optionalRealTrafficReady",
  "releaseBlockedOnlyByRequiredRealTraffic",
  "releaseGateFailureReasons",
  "releaseGateFailures",
  "releaseGateGroups",
  "releaseGateSelectedReports",
  "releaseReady",
  "requestedRealTraffic",
  "requiredRealTrafficBlockedGates",
  "shellProgress",
  "shortReady",
  "skipRequests",
  "skipped",
  "strictOptionalRealTraffic",
  "antigravityAdapterProgress",
]);

function readJsonIfPresent(fullPath) {
  try {
    if (!fullPath || !fs.existsSync(fullPath)) return null;
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    return null;
  }
}

function snapshotExtraSkillsRoots(marker) {
  const roots = Array.isArray(marker?.extraSkillsRoots)
    ? marker.extraSkillsRoots
    : [marker?.agentsSkillsPath];
  return [...new Set(roots.map((item) => String(item || "").trim()).filter(Boolean))];
}

function snapshotSourceCheckKey(codexHome, marker) {
  return JSON.stringify([
    path.resolve(codexHome || "."),
    String(marker?.updatedAt || ""),
    String(marker?.sourceFingerprint || ""),
    String(marker?.sharedCodexHome || ""),
    snapshotExtraSkillsRoots(marker),
  ]);
}

function cachedSnapshotSourceCheck(codexHome, marker) {
  const key = snapshotSourceCheckKey(codexHome, marker);
  const cached = SNAPSHOT_SOURCE_CHECK_CACHE.get(key);
  if (!cached || cached.promise) return null;
  if (Number(cached.expiresAt) <= Date.now()) {
    SNAPSHOT_SOURCE_CHECK_CACHE.delete(key);
    return null;
  }
  return cached.result || null;
}

async function verifySnapshotSource(codexHome, marker) {
  const key = snapshotSourceCheckKey(codexHome, marker);
  const existing = SNAPSHOT_SOURCE_CHECK_CACHE.get(key);
  if (existing?.promise) return existing.promise;

  const promise = (async () => {
    const verifiedAt = new Date().toISOString();
    try {
      const sharedCodexHome = String(marker?.sharedCodexHome || "");
      if (!sharedCodexHome || !fs.existsSync(sharedCodexHome)) {
        throw new Error("Shared Codex home is unavailable.");
      }
      const extraSkillsRoots = snapshotExtraSkillsRoots(marker);
      const env = { ...process.env };
      if (extraSkillsRoots.length > 0) env.ANTICODEX_EXTRA_SKILLS_ROOTS = extraSkillsRoots.join(path.delimiter);
      const scriptPath = path.resolve(__dirname, "sync-shared-codex-plugin-host.mjs");
      const { stdout } = await execFileAsync(process.execPath, [
        scriptPath,
        codexHome,
        sharedCodexHome,
        "--print-startup-source-fingerprint",
      ], {
        env,
        timeout: 45000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(String(stdout || ""));
      if (!parsed?.sourceFingerprint) throw new Error("Source fingerprint is missing.");
      const result = {
        ok: true,
        sourceFingerprint: String(parsed.sourceFingerprint),
        sourceMtimeMax: parsed.sourceMtimeMax || null,
        verifiedAt,
      };
      const matches = result.sourceFingerprint === String(marker?.sourceFingerprint || "");
      SNAPSHOT_SOURCE_CHECK_CACHE.set(key, {
        result,
        expiresAt: matches ? Date.now() + SNAPSHOT_SOURCE_CHECK_MAX_AGE_MS : Number.POSITIVE_INFINITY,
      });
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: String(error?.message || error || "Snapshot source verification failed.").slice(0, 500),
        verifiedAt,
      };
      SNAPSHOT_SOURCE_CHECK_CACHE.set(key, {
        result,
        expiresAt: Date.now() + SNAPSHOT_SOURCE_CHECK_FAILURE_MAX_AGE_MS,
      });
      return result;
    }
  })();
  SNAPSHOT_SOURCE_CHECK_CACHE.set(key, { promise });
  return promise;
}

function reportTimestampMs(report, fullPath) {
  for (const candidate of [report?.generatedAt, report?.completedAt, report?.createdAt, report?.timestamp]) {
    const parsed = Date.parse(String(candidate || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  try {
    return fs.statSync(fullPath).mtimeMs;
  } catch {
    return null;
  }
}

function latestManagerReportItem(stateRoot, label, fileName, options = {}) {
  const fullPath = stateRoot ? path.join(stateRoot, "reports", fileName) : "";
  let exists = false;
  let parseable = false;
  let value = null;
  let parseError = "";
  try {
    if (fullPath && fs.existsSync(fullPath)) {
      exists = true;
      value = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      parseable = true;
    }
  } catch (error) {
    parseError = String(error?.message || error || "report parse failed").slice(0, 500);
  }

  const invalid = exists && !parseable;
  const failures = Array.isArray(value?.failures) ? value.failures.filter(Boolean) : [];
  const timestampMs = exists ? reportTimestampMs(parseable ? value : null, fullPath) : null;
  const ageMs = Number.isFinite(timestampMs) ? Math.max(0, Date.now() - timestampMs) : null;
  const rawOk = !exists ? null : (!invalid && value?.ok === true);
  const releaseGateReport = fileName === "latest-release-gates.json";
  const effectiveOk = !exists
    ? null
    : releaseGateReport
    ? rawOk && value?.releaseReady === true && (!Array.isArray(value?.damagedReports) || value.damagedReports.length === 0)
    : rawOk;
  const publicDocumentationOk = typeof value?.publicDocumentationOk === "boolean"
    ? value.publicDocumentationOk
    : (typeof value?.checks?.publicDocumentation?.ok === "boolean" ? value.checks.publicDocumentation.ok : null);

  const item = {
    label,
    fileName,
    latestPath: fullPath,
    deferred: options.deferred === true,
    exists,
    parseable,
    invalid,
    ok: rawOk,
    effectiveOk,
    state: invalid ? "invalid_report" : String(value?.state || value?.status || ""),
    reason: String(value?.reason || "").slice(0, 500),
    elapsedMs: Number.isFinite(Number(value?.elapsedMs)) ? Number(value.elapsedMs) : null,
    ageMs,
    reportedAt: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : "",
    stale: Number.isFinite(ageMs) && ageMs > MANAGER_REPORT_STALE_MS,
    firstFailure: invalid ? parseError : String(failures[0] || "").slice(0, 500),
    publicDocumentationOk,
  };
  for (const field of REPORT_SUMMARY_PASSTHROUGH_FIELDS) {
    if (value && Object.hasOwn(value, field)) item[field] = value[field];
  }
  Object.defineProperty(item, "value", { value, enumerable: false });
  return item;
}

function latestManagerReportsPayload(stateRoot) {
  const reportFiles = [
    ["发布门禁", "latest-release-gates.json"],
    ["可见客户端集成", "latest-gate5-visible-integration.json"],
    ["边缘与恢复", "latest-gate6-edge-matrix.json"],
    ["旧架构清理", "latest-legacy-zero-hit.json"],
    ["账号与代理", "latest-account-proxy-readiness.json", true],
    ["快捷方式修复", "latest-shortcut-repair.json", true],
    ["源码预检", "latest-source-preflight.json"],
    ["安装与同步", "latest-sync-readiness.json"],
    ["快速安装态检查", "latest-installed-overall-fast.json", true],
    ["安装态检查", "latest-installed-overall.json"],
    ["最终长任务", "latest-gate8-final-long-task.json"],
    ["诊断", "latest-diagnostics.json"],
    ["模型可用性", "latest-model-availability.json", true],
    ["MCP 与技能", "latest-mcp-skills.json", true],
    ["插件与应用", "latest-plugin-capabilities.json", true],
    ["本地连接器", "latest-local-connectors.json", true],
    ["后台进程", "latest-worker-process-hygiene.json", true],
    ["本地功能刷新", "latest-refresh-features.json", true],
    ["冷启动恢复", "latest-cold-relaunch.json", true],
    ["稳定性巡检", "latest-stability-soak.json", true],
    ["验证后完整检查", "latest-post-verification.json", true],
  ];
  const reports = reportFiles.map(([label, file, deferred]) => latestManagerReportItem(stateRoot, label, file, { deferred }));
  return {
    ok: true,
    reportRoot: stateRoot ? path.join(stateRoot, "reports") : "",
    reports,
    existingCount: reports.filter((item) => item.exists).length,
    missingCount: reports.filter((item) => !item.exists && item.deferred !== true).length,
    invalidCount: reports.filter((item) => item.invalid).length,
    staleCount: reports.filter((item) => item.exists && item.stale && item.deferred !== true).length,
    deferredCount: reports.filter((item) => item.deferred === true).length,
    staleAfterMs: MANAGER_REPORT_STALE_MS,
  };
}

// Upstream scripts & conn probe helpers
async function runUpstreamProfileScript(action, values = {}, stateRoot = "", scriptsRoot = "") {
    const args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve(scriptsRoot, "anticodex-upstream-profile.ps1"),
        "-Action",
        action,
    ];
    const addArg = (name, val) => {
        if (val === undefined || val === null) return;
        args.push("-" + name, String(val));
    };
    addArg("StateRoot", stateRoot);
    addArg("Protocol", values.protocol);
    addArg("BaseUrl", values.baseUrl);
    addArg("Model", values.model);
    addArg("ContextWindow", values.contextWindow);
    addArg("TestStatus", values.testStatus);
    addArg("CapabilitiesJson", values.capabilitiesJson);
    const { stdout } = await execFileAsync(powershellPath(), args, {
        cwd: scriptsRoot,
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
            ...process.env,
            ...(values.apiKey ? { ANTICODEX_UPSTREAM_API_KEY_INPUT: String(values.apiKey) } : {}),
        },
    });
    const trimmed = String(stdout || "").trim();
    if (!trimmed) return {};
    try {
        return JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
        }
    }
    return {};
}

function uniqueModelIds(values = []) {
    const output = [];
    const seen = new Set();
    for (const value of values) {
        const model = String(value || "").trim();
        if (!model || seen.has(model)) continue;
        seen.add(model);
        output.push(model);
    }
    return output;
}

function thirdPartyRelayProtocol(protocol) {
    const value = String(protocol || "").trim().toLowerCase();
    if (value === "responses") return "responses";
    if (value === "openai-compatible") return "chatCompletions";
    throw new Error("Third-party protocol must be openai-compatible or responses.");
}

function writeJsonAtomic(filePath, value) {
    writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(filePath, value) {
    const parent = path.dirname(filePath);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporary, Buffer.isBuffer(value) ? value : String(value), Buffer.isBuffer(value) ? undefined : "utf8");
        fs.renameSync(temporary, filePath);
    } finally {
        try { fs.rmSync(temporary, { force: true }); } catch {}
    }
}

function captureFileSnapshots(filePaths) {
    return [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].map((filePath) => ({
        filePath,
        existed: fs.existsSync(filePath),
        contents: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
    }));
}

function restoreFileSnapshots(snapshots) {
    const errors = [];
    for (const snapshot of [...snapshots].reverse()) {
        try {
            if (snapshot.existed) writeTextAtomic(snapshot.filePath, snapshot.contents);
            else fs.rmSync(snapshot.filePath, { force: true });
        } catch (error) {
            errors.push(`${snapshot.filePath}: ${error.message}`);
        }
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
}

function prepareThirdPartyNativeCatalog(catalogPath, providerModels, contextWindow) {
    const resolvedPath = path.resolve(String(catalogPath || ""));
    if (!fs.existsSync(resolvedPath)) {
        throw new Error("The unified native model catalog is unavailable for third-party setup.");
    }
    const catalog = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    if (!Array.isArray(catalog.models)) {
        throw new Error("The unified native model catalog must contain a models array.");
    }
    const models = catalog.models;
    const directPrefix = `${THIRD_PARTY_MODEL_SLOT}/`;
    const template = models.find((entry) => String(entry?.slug || "") === THIRD_PARTY_MODEL_SLOT)
        || models.find((entry) => String(entry?.slug || "").startsWith(directPrefix));
    if (!template) {
        throw new Error("The native third-party model template is unavailable for third-party setup.");
    }
    const nextModels = models
        .filter((entry) => !String(entry?.slug || "").startsWith(directPrefix))
        .map((entry) => {
            const slug = String(entry?.slug || "");
            if (slug === THIRD_PARTY_MODEL_SLOT) {
                return {
                    ...entry,
                    context_window: contextWindow,
                    max_context_window: contextWindow,
                    effective_context_window_percent: 90,
                };
            }
            return entry;
        });
    const nativeModels = providerModels.map((model) => ({
        ...template,
        slug: thirdPartyNativeModel(model),
        display_name: `第三方 · ${model}`,
        description: `第三方 API 模型 ${model}`,
        visibility: "list",
        supported_in_api: true,
        upgrade: null,
        availability_nux: null,
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 90,
    }));
    const genericIndex = nextModels.findIndex((entry) => String(entry?.slug || "") === THIRD_PARTY_MODEL_SLOT);
    nextModels.splice(genericIndex < 0 ? nextModels.length : genericIndex, 0, ...nativeModels);
    catalog.models = nextModels.map((entry, priority) => ({ ...entry, priority }));
    return {
        catalog,
        catalogPath: resolvedPath,
        modelIds: catalog.models.map((entry) => String(entry?.slug || "").trim()).filter(Boolean),
    };
}

export function saveThirdPartyCodexPlusPlusSettings(options = {}) {
    const settingsValue = String(options.settingsPath || "").trim();
    const catalogValue = String(options.nativeCatalogPath || "").trim();
    if (!settingsValue) throw new Error("CodexPlusPlus settings path is required.");
    if (!catalogValue) throw new Error("Unified native model catalog path is required.");
    const settingsPath = path.resolve(settingsValue);
    const catalogPath = path.resolve(catalogValue);
    if (!fs.existsSync(settingsPath) || !fs.statSync(settingsPath).isFile()) {
        throw new Error("CodexPlusPlus settings are unavailable for third-party setup.");
    }
    if (!fs.existsSync(catalogPath) || !fs.statSync(catalogPath).isFile()) {
        throw new Error("The unified native model catalog is unavailable for third-party setup.");
    }
    const thirdParty = options.thirdParty;
    if (!thirdParty || typeof thirdParty !== "object" || Array.isArray(thirdParty)) {
        throw new Error("Third-party settings are required.");
    }
    const baseUrl = String(thirdParty.baseUrl || "").trim().replace(/\/+$/, "");
    const model = String(thirdParty.model || "").trim();
    const apiKey = String(thirdParty.apiKey || "");
    if (!baseUrl || !model || !apiKey.trim()) {
        throw new Error("Third-party base URL, model, and API key are required.");
    }
    let parsedBaseUrl;
    try { parsedBaseUrl = new URL(baseUrl); }
    catch { throw new Error("Third-party base URL must be a valid HTTP or HTTPS URL."); }
    if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
        throw new Error("Third-party base URL must be a valid HTTP or HTTPS URL.");
    }
    const protocol = thirdPartyRelayProtocol(thirdParty.protocol);
    const contextWindow = Number(thirdParty.contextWindow);
    if (!Number.isInteger(contextWindow) || contextWindow < 16000 || contextWindow > 4000000) {
        throw new Error("Third-party context window must be an integer between 16000 and 4000000.");
    }
    if (thirdParty.providerModels != null && !Array.isArray(thirdParty.providerModels)) {
        throw new Error("Third-party provider models must be an array.");
    }
    const providerModelValues = [model, ...(thirdParty.providerModels || [])];
    if (providerModelValues.some((entry) => typeof entry !== "string"
        || !entry.trim()
        || entry.length > 200
        || /[\r\n]/.test(entry))) {
        throw new Error("Third-party provider model IDs must be non-empty single-line strings up to 200 characters.");
    }
    const providerModels = uniqueModelIds(providerModelValues);
    const modelList = uniqueModelIds([
        THIRD_PARTY_MODEL_SLOT,
        ...providerModels.map((entry) => thirdPartyNativeModel(entry)),
    ]).join("\n");

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!Array.isArray(settings.relayProfiles)) {
        throw new Error("CodexPlusPlus settings must contain relayProfiles.");
    }
    const thirdPartyProfiles = settings.relayProfiles.filter(
        (profile) => String(profile?.id || "") === THIRD_PARTY_RELAY_ID,
    );
    if (thirdPartyProfiles.length !== 1) {
        throw new Error("CodexPlusPlus settings must contain exactly one resident third-party relay profile.");
    }
    settings.relayProfiles = settings.relayProfiles.map((profile) => (
        String(profile?.id || "") === THIRD_PARTY_RELAY_ID
            ? {
                ...profile,
                upstreamBaseUrl: baseUrl,
                apiKey,
                protocol,
                testModel: model,
                contextWindow: String(contextWindow),
                autoCompactLimit: String(Math.floor(contextWindow * 0.9)),
                authContents: `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`,
                modelList,
            }
            : profile
    ));
    const preparedNativeCatalog = prepareThirdPartyNativeCatalog(catalogPath, providerModels, contextWindow);
    const snapshots = captureFileSnapshots([settingsPath, preparedNativeCatalog.catalogPath]);
    try {
        writeJsonAtomic(settingsPath, settings);
        writeJsonAtomic(preparedNativeCatalog.catalogPath, preparedNativeCatalog.catalog);
    } catch (error) {
        try { restoreFileSnapshots(snapshots); }
        catch (rollbackError) { error.message += ` Rollback failed: ${rollbackError.message}`; }
        throw error;
    }
    return {
        ok: true,
        saved: true,
        model,
        providerModels,
        catalogModelIds: preparedNativeCatalog.modelIds,
    };
}

function antigravityModelsFromCatalog(stateRoot = "") {
    const catalogPath = path.join(stateRoot, "codex-home-deepseek-app", "antigravity-model-catalog.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
        return (Array.isArray(parsed?.models) ? parsed.models : [])
            .filter((entry) => entry?.visibility !== "hide")
            .slice(0, 256)
            .map((entry) => ({
                id: String(entry?.slug || entry?.id || "").trim().slice(0, 200),
                label: String(entry?.display_name || entry?.displayName || entry?.slug || entry?.id || "").trim().slice(0, 200),
            }))
            .filter((entry) => entry.id);
    } catch {
        return [];
    }
}

async function fixedRouteHealthSnapshot(fixedHealthUrl) {
    try {
        const res = await fetch(fixedHealthUrl, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(1500),
        });
        const body = await res.json();
        const provider = ["antigravity", "third-party"].includes(String(body?.provider || ""))
            ? String(body.provider)
            : "";
        const state = String(body?.state || "unknown");
        const ready = res.ok && body?.ok === true && state === "ready" && Boolean(provider);
        const relayProtocol = ["chatCompletions", "responses"].includes(String(body?.route?.relayProtocol || ""))
            ? String(body.route.relayProtocol)
            : "";
        const catalogModelCount = Number(body?.catalogModelCount);
        return {
            ready,
            state,
            provider,
            model: String(body?.model || ""),
            pid: Number.isInteger(Number(body?.pid)) ? Number(body.pid) : null,
            readyAt: String(body?.readyAt || ""),
            adapterPort: validLoopbackPort(body?.ports?.adapter),
            relayProtocol,
            catalogModelCount: Number.isInteger(catalogModelCount) && catalogModelCount >= 0 ? catalogModelCount : 0,
        };
    } catch {
        return {
            ready: false,
            state: "offline",
            provider: "",
            model: "",
            pid: null,
            readyAt: "",
            adapterPort: null,
            relayProtocol: "",
            catalogModelCount: 0,
        };
    }
}

function validLoopbackPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function unavailableAccountSnapshot(state = "unavailable", provider = "antigravity") {
    return {
        ok: false,
        provider,
        state,
        signedIn: false,
        identityAvailable: false,
        fingerprint: "",
        planName: "",
        tierName: "",
    };
}

async function fixedRouteAccountSnapshot(fixedRoute, options = {}) {
    const forceAntigravity = options.forceAntigravity === true;
    const authToken = String(options.authToken || "");
    if (fixedRoute?.provider === "third-party" && !forceAntigravity) {
        return {
            ok: true,
            provider: "third-party",
            state: "not_applicable",
            signedIn: null,
            identityAvailable: null,
            fingerprint: "",
            planName: "",
            tierName: "",
        };
    }
    if ((!forceAntigravity && fixedRoute?.provider !== "antigravity")
        || fixedRoute.ready !== true || !fixedRoute.adapterPort) {
        return unavailableAccountSnapshot();
    }
    try {
        const response = await fetch(`http://127.0.0.1:${fixedRoute.adapterPort}/v1/account`, {
            headers: {
                accept: "application/json",
                ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
            },
            signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) return unavailableAccountSnapshot("adapter_unavailable");
        const body = await response.json();
        const fingerprint = /^sha256:[a-f0-9]{64}$/i.test(String(body?.fingerprint || ""))
            ? String(body.fingerprint).toLowerCase()
            : "";
        const signedIn = body?.signedIn === true;
        const identityAvailable = signedIn && body?.identityAvailable === true && Boolean(fingerprint);
        return {
            ok: true,
            provider: "antigravity",
            state: signedIn && identityAvailable ? "ready" : "account_unavailable",
            signedIn,
            identityAvailable,
            fingerprint,
            planName: String(body?.planName || ""),
            tierName: String(body?.tierName || ""),
        };
    } catch {
        return unavailableAccountSnapshot("adapter_unavailable");
    }
}

function isAntigravityUpstreamMode(mode) {
  return String(mode ?? "").toLowerCase() === "antigravity";
}

function activeUpstreamMode(fixedRoute) {
    if (fixedRoute?.ready === true) {
        return fixedRoute.provider === "antigravity" ? "antigravity" : "third-party";
    }
    const mode = process.env.TRANSLATOR_UPSTREAM_MODE || "chat";
    return isAntigravityUpstreamMode(mode) ? "antigravity" : "third-party";
}

function normalizeUpstreamProfile(profile = {}) {
  const protocol = String(profile.protocol ?? "").trim();
  const baseUrl = String(profile.baseUrl ?? "").trim().replace(/\/$/, "");
  const apiKey = String(profile.apiKey ?? "");
  const model = String(profile.model ?? "").trim();
  const extraHeaders = { ...(profile.extraHeaders ?? {}) };
  return { protocol, baseUrl, apiKey, model, extraHeaders };
}

function maskSecret(val) {
  if (!val) return "";
  const str = String(val);
  if (str.length <= 8) return "*".repeat(str.length);
  return str.slice(0, 4) + "*".repeat(str.length - 8) + str.slice(-4);
}

function publicUpstreamProfile(profile) {
  const p = normalizeUpstreamProfile(profile);
  if (p.apiKey) {
    p.apiKey = maskSecret(p.apiKey);
  }
  for (const [k, v] of Object.entries(p.extraHeaders)) {
    if (typeof v === "string" && v.length > 8) {
      p.extraHeaders[k] = maskSecret(v);
    }
  }
  return p;
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

function managerUpstreamTimeoutMs(value) {
    const timeoutMs = Number(value);
    return Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000
        ? timeoutMs
        : 10000;
}

function upstreamConnectionFailureType(stage = {}) {
    const detail = String(stage?.detail || "").toLowerCase();
    if (/auth/.test(detail)) return "auth";
    if (/quota_or_billing|insufficient quota|quota|billing|payment|required balance/.test(detail)) return "quota_or_billing";
    if (/model_not_found/.test(detail)) return "model_not_found";
    if (/rate_limit/.test(detail)) return "rate_limit";
    if (/timeout/.test(detail)) return "timeout";
    if (/invalid_url/.test(detail)) return "invalid_url";
    if (/tls/.test(detail)) return "tls";
    if (/network/.test(detail)) return "network";
    if (/protocol_mismatch|protocol_or_translation_error/.test(detail)) return "protocol_mismatch";
    if (/not_found/.test(detail)) return "not_found";
    return "unknown";
}

function upstreamConnectionGuidance(type) {
    return ({
        auth: { title: "认证失败", suggestedAction: "检查 API key、组织/项目权限，重新测试后再保存。", retryable: false },
        quota_or_billing: { title: "余额或额度不足", suggestedAction: "检查第三方 API 账号 of balance/billing/quota, retry.", retryable: false },
        model_not_found: { title: "模型不可用", suggestedAction: "Confirm model availability under key.", retryable: false },
        rate_limit: { title: "请求被限速", suggestedAction: "Retry later.", retryable: true },
        timeout: { title: "连接超时", suggestedAction: "Check connection/proxy.", retryable: true },
        invalid_url: { title: "地址格式不对", suggestedAction: "Must use valid base URL.", retryable: false },
        tls: { title: "证书或 TLS 错误", suggestedAction: "Check TLS/certificates.", retryable: false },
        network: { title: "网络连不上", suggestedAction: "Check firewall/DNS/proxy.", retryable: true },
        protocol_mismatch: { title: "接口协议不匹配", suggestedAction: "Confirm endpoint protocol matches.", retryable: false },
        not_found: { title: "接口路径不存在", suggestedAction: "Check URL suffixes.", retryable: false },
    })[type] || { title: "连接测试失败", suggestedAction: "Check upstream details.", retryable: false };
}

function upstreamConnectionSummary(stages = []) {
    const sanitized = sanitizedConnectionStages(stages);
    const failed = sanitized.find((stage) => stage.status === "fail");
    if (!failed) {
        return {
            status: "ok",
            type: "ready",
            title: "连接可用",
            suggestedAction: "可以保存配置；之后可在聊天输入框的模型菜单选择。",
            retryable: false,
            failedStage: "",
        };
    }
    const type = upstreamConnectionFailureType(failed);
    const guidance = upstreamConnectionGuidance(type);
    return {
        status: failed.status,
        type,
        title: guidance.title,
        suggestedAction: guidance.suggestedAction,
        retryable: guidance.retryable,
        failedStage: failed.stage || "",
    };
}

// Local connector allowlist helpers
function localConnectorAllowlistConfigPath(stateRoot) {
    const codexHome = process.env.CODEX_HOME_DIR || process.env.CODEX_HOME || (stateRoot ? path.resolve(stateRoot, "codex-home-deepseek-app") : "");
    return codexHome ? path.resolve(codexHome, "config.toml") : "";
}

function tomlQuotedString(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function parseLocalConnectorAllowlistFromText(text = "") {
    const ids = new Set();
    let inSection = false;
    for (const rawLine of text.split(/\r?\n/)) {
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
            for (const match of array[1].matchAll(/"([^"]+)"/g)) ids.add(match[1]);
            continue;
        }
        const enabled = line.match(/^("?)([^"=]+)\1\s*=\s*true\s*$/i);
        if (enabled) ids.add(enabled[2].trim());
    }
    return [...ids].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function readPersistedLocalConnectorAllowlist(stateRoot) {
    const configPath = localConnectorAllowlistConfigPath(stateRoot);
    if (!configPath || !fs.existsSync(configPath)) return [];
    try {
        return parseLocalConnectorAllowlistFromText(fs.readFileSync(configPath, "utf8"));
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

function writePersistedLocalConnectorAllowlist(connectorIds, stateRoot) {
    const configPath = localConnectorAllowlistConfigPath(stateRoot);
    if (!configPath) {
        throw { statusCode: 500, message: "Anti-Codex config path is not available." };
    }
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, replaceLocalConnectorAllowlistSection(existing, connectorIds), "utf8");
    return configPath;
}

function localConnectorAllowlistPayload(stateRoot) {
    const directory = localBackendApiResponse("GET", "/backend-api/aip/connectors") || { connectors: [] };
    const wham = localBackendApiResponse("POST", "/backend-api/wham/apps") || { tools: [] };
    const connectors = directory.connectors || [];
    const tools = wham.tools || [];
    const toolsByConnector = new Map();
    for (const tool of tools) {
        const id = String(tool?.connector_id || "");
        if (!id) continue;
        toolsByConnector.set(id, (toolsByConnector.get(id) || 0) + 1);
    }
    const persisted = readPersistedLocalConnectorAllowlist(stateRoot);
    const envList = envLocalConnectorAllowlist();
    const effective = new Set([...persisted, ...envList]);
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
        configPath: localConnectorAllowlistConfigPath(stateRoot),
        persisted,
        env: envList,
        effective: [...effective].sort((a, b) => a.localeCompare(b)),
        connectors: rows,
        counts: {
            total: rows.length,
            persisted: persisted.length,
            env: envList.length,
            locallyAuthorized: rows.filter((connector) => connector.locallyAuthorized).length,
            localAllowlisted: rows.filter((connector) => connector.locallyAllowlisted).length,
            accessible: rows.filter((connector) => connector.isAccessible).length,
            appTools: tools.length,
        },
        note: "Local allowlists are metadata previews only. They do not authorize connectors or make app tools callable.",
    };
}

function validateLocalConnectorIds(connectorIds, stateRoot) {
    if (!Array.isArray(connectorIds)) {
        throw { statusCode: 400, message: "connectorIds must be an array." };
    }
    const directory = localBackendApiResponse("GET", "/backend-api/aip/connectors") || { connectors: [] };
    const known = new Set((directory.connectors || [])
        .map((connector) => String(connector?.id || connector?.connector_id || ""))
        .filter(Boolean));
    const normalized = [...new Set(connectorIds.map((id) => String(id || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    if (normalized.length > 50) {
        throw { statusCode: 400, message: "At most 50 local connectors can be allowlisted at once." };
    }
    const unknown = normalized.filter((id) => !known.has(id));
    if (unknown.length > 0) {
        throw { statusCode: 400, message: `Unknown connector id(s): ${unknown.slice(0, 10).join(", ")}` };
    }
    return normalized;
}

// Diagnostics helper
async function diagnosticsPayload(stateRoot, fast, fixedHealthUrl, adapterAuthToken = "", options = {}) {
    const fixedRoute = await fixedRouteHealthSnapshot(fixedHealthUrl);
    const account = await fixedRouteAccountSnapshot(fixedRoute, { authToken: adapterAuthToken });
    const fixedStatus = readJsonIfPresent(stateRoot ? path.join(stateRoot, "fixed-route-status.json") : "");
    const updateStatusPath = stateRoot ? path.join(stateRoot, "update-status.json") : "";
    const updateStatusExists = Boolean(updateStatusPath && fs.existsSync(updateStatusPath));
    const persistedUpdateStatus = readJsonIfPresent(updateStatusPath);
    const updateStatusParseable = Boolean(persistedUpdateStatus && typeof persistedUpdateStatus === "object" && !Array.isArray(persistedUpdateStatus));
    const updateStatus = updateStatusParseable ? persistedUpdateStatus : {
        ok: false,
        updateNeeded: null,
        reason: "not_checked",
        sync: { available: false },
    };
    const codexHome = process.env.CODEX_HOME_DIR || process.env.CODEX_HOME || (stateRoot ? path.join(stateRoot, "codex-home-deepseek-app") : "");
    const snapshotMarker = readJsonIfPresent(codexHome ? path.join(codexHome, ".anticodex-startup-snapshots-ready.json") : "");
    const snapshotTimestamp = Date.parse(String(snapshotMarker?.updatedAt || ""));
    const snapshotAgeMs = Number.isFinite(snapshotTimestamp) ? Math.max(0, Date.now() - snapshotTimestamp) : null;
    const snapshotMaxAgeHours = Math.max(1, Number(process.env.ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS) || 24);
    const snapshotMarkerValid = snapshotMarker?.schema === STARTUP_SNAPSHOT_SCHEMA
      && Number.isFinite(snapshotTimestamp)
      && typeof snapshotMarker?.sourceFingerprint === "string"
      && snapshotMarker.sourceFingerprint.length > 0
      && typeof snapshotMarker?.sharedCodexHome === "string"
      && snapshotMarker.sharedCodexHome.length > 0;
    const snapshotAgeHours = Number.isFinite(snapshotAgeMs) ? snapshotAgeMs / 3600000 : null;
    let snapshotSourceCheck = snapshotMarkerValid && snapshotAgeHours <= snapshotMaxAgeHours
      ? cachedSnapshotSourceCheck(codexHome, snapshotMarker)
      : null;
    if (snapshotMarkerValid && snapshotAgeHours <= snapshotMaxAgeHours && options.verifySnapshotFreshness === true) {
      snapshotSourceCheck = await verifySnapshotSource(codexHome, snapshotMarker);
    }
    const sourceFingerprintMatches = snapshotSourceCheck?.ok === true
      ? snapshotSourceCheck.sourceFingerprint === snapshotMarker.sourceFingerprint
      : null;
    const snapshotState = !snapshotMarker
      ? "missing"
      : (!snapshotMarkerValid
          ? "invalid"
          : (snapshotAgeHours > snapshotMaxAgeHours
              ? "stale"
              : (snapshotSourceCheck?.ok === false
                  ? "check_failed"
                  : (!snapshotSourceCheck
                      ? "unverified"
                      : (sourceFingerprintMatches ? "fresh" : "stale")))));
    const snapshotStaleReason = snapshotState === "stale"
      ? (snapshotAgeHours > snapshotMaxAgeHours ? "age" : "source_changed")
      : (snapshotState === "invalid"
          ? "invalid_marker"
          : (snapshotState === "missing" ? "missing" : (snapshotState === "unverified" ? "unverified" : (snapshotState === "check_failed" ? "check_failed" : null))));
    const sourcePreflight = latestManagerReportItem(stateRoot, "Source preflight", "latest-source-preflight.json");
    const syncReadiness = latestManagerReportItem(stateRoot, "Sync readiness", "latest-sync-readiness.json");
    const installedFull = latestManagerReportItem(stateRoot, "Installed overall", "latest-installed-overall.json");
    const installedFast = latestManagerReportItem(stateRoot, "Installed overall fast", "latest-installed-overall-fast.json", { deferred: true });
    const releaseGates = latestManagerReportItem(stateRoot, "Release gates", "latest-release-gates.json");
    const operation = updateStatus?.operation || {};
    const originalFailure = operation?.originalFailure || {};
    const operationState = String(operation.state || "").toLowerCase();
    const operationReportedAt = String(operation.completedAt || operation.updatedAt || operation.startedAt || "");
    const updateCheckReportedAt = String(updateStatus?.checkedAt || "");
    const updateCheckTerminal = updateStatusParseable
      && Number.isFinite(Date.parse(updateCheckReportedAt))
      && typeof updateStatus.ok === "boolean";
    const updateCheckOk = updateCheckTerminal ? updateStatus.ok === true : null;
    const managerActionResults = {
        updateCheck: {
            latestPath: updateStatusPath,
            exists: updateStatusExists,
            parseable: updateStatusParseable,
            invalid: updateStatusExists && !updateStatusParseable,
            ok: updateCheckOk,
            effectiveOk: updateCheckOk,
            state: updateCheckTerminal ? "completed" : (updateStatusExists ? "unknown" : "missing"),
            reason: updateCheckTerminal ? String(updateStatus.reason || "") : (updateStatusExists ? "update_status_unavailable" : "not_checked"),
            firstFailure: updateCheckTerminal && !updateCheckOk ? String(updateStatus.reason || "") : "",
            reportedAt: updateCheckTerminal ? new Date(updateCheckReportedAt).toISOString() : "",
        },
        accountProxy: latestManagerReportItem(stateRoot, "Account and proxy readiness", "latest-account-proxy-readiness.json", { deferred: true }),
        syncReadiness,
        repairShortcuts: latestManagerReportItem(stateRoot, "Shortcut repair", "latest-shortcut-repair.json", { deferred: true }),
        sourcePreflight,
        mcpSkills: latestManagerReportItem(stateRoot, "MCP and skills", "latest-mcp-skills.json", { deferred: true }),
        pluginCapabilities: latestManagerReportItem(stateRoot, "Plugin capabilities", "latest-plugin-capabilities.json", { deferred: true }),
        refreshFeatures: latestManagerReportItem(stateRoot, "Local feature refresh", "latest-refresh-features.json", { deferred: true }),
        fastOverallNoTraffic: installedFast,
        overallNoTraffic: installedFull,
        stabilitySoak: latestManagerReportItem(stateRoot, "Stability soak", "latest-stability-soak.json", { deferred: true }),
        coldRelaunch: latestManagerReportItem(stateRoot, "Cold relaunch", "latest-cold-relaunch.json", { deferred: true }),
        postVerificationFull: latestManagerReportItem(stateRoot, "Post verification", "latest-post-verification.json", { deferred: true }),
        syncHost: {
            exists: Boolean(operationState && operationState !== "idle" && operationState !== "none"),
            ok: ["succeeded", "success", "completed"].includes(operationState)
              ? true
              : (["failed", "failure", "rolled_back"].includes(operationState) ? false : null),
            effectiveOk: ["succeeded", "success", "completed"].includes(operationState),
            state: operationState,
            reason: String(operation.message || "").slice(0, 500),
            firstFailure: ["failed", "failure", "rolled_back"].includes(operationState)
              ? String(originalFailure.message || originalFailure.error || operation.failureCode || operation.message || "").slice(0, 500)
              : "",
            reportedAt: Number.isFinite(Date.parse(operationReportedAt)) ? new Date(operationReportedAt).toISOString() : "",
        },
    };
    const backgroundItems = [...ACTIVE_BACKGROUND_ACTIONS.values()].map((item) => ({
        id: item.actionName,
        label: item.label,
        pid: Number.isFinite(Number(item.pid)) ? Number(item.pid) : null,
        state: "running",
        stage: "manager_background",
        startedAt: item.backgroundStartedAt || "",
    }));
    const foregroundItems = [...ACTIVE_FOREGROUND_ACTIONS.values()].map((item) => ({
        id: item.actionName,
        label: MANAGER_ACTIONS[item.actionName]?.label || item.actionName,
        state: "running",
        stage: "manager_foreground",
        startedAt: item.foregroundStartedAt || "",
    }));
    const longTaskItems = [...backgroundItems, ...foregroundItems];
    // Persisted supervisor status is historical evidence only. A hard process-job
    // teardown cannot update that file, so live diagnostics must fail closed on
    // the health endpoint instead of reviving a stale `ready` route.
    const provider = fixedRoute.provider;
    const model = fixedRoute.model;
    const routeReady = fixedRoute.ready === true;

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
            upstreamMode: provider || "offline",
            upstream: provider === "antigravity" ? "Antigravity Desktop Cascade" : (provider === "third-party" ? "CodexPlusPlus third-party" : "offline"),
            profile: provider || "",
            antigravity: provider === "antigravity",
        },
        health: {
            ok: routeReady,
            state: fixedRoute.state,
            provider,
            model,
            pid: fixedRoute.pid,
            readyAt: fixedRoute.readyAt,
        },
        fixedRoute,
        paths: {
            stateRoot: stateRoot || null,
            codexHome: codexHome || null,
            fixedRouteStatus: stateRoot ? path.join(stateRoot, "fixed-route-status.json") : null,
            updateStatus: stateRoot ? path.join(stateRoot, "update-status.json") : null,
            reports: stateRoot ? path.join(stateRoot, "reports") : null,
        },
        models: { active: model ? [model] : [], provider: provider ? [provider] : [] },
        accountTracking: {
            state: account.state,
            signedIn: account.signedIn,
            identityAvailable: account.identityAvailable,
            fingerprint: account.fingerprint,
            planName: account.planName,
            tierName: account.tierName,
            changePending: false,
            pendingObservations: 0,
            requiredObservations: 0,
        },
        modelRoutes: {
            count: routeReady ? 1 : 0,
            latest: routeReady ? { provider, model, state: fixedRoute.state, readyAt: fixedRoute.readyAt } : null,
            recent: [],
        },
        localFeatures: {
            skipped: false,
            source: "isolated-startup-snapshot-marker",
            snapshotStatus: {
                present: Boolean(snapshotMarker),
                state: snapshotState,
                stale: snapshotState !== "fresh",
                staleReason: snapshotStaleReason,
                updatedAt: snapshotMarkerValid ? snapshotMarker.updatedAt : null,
                ageHours: snapshotAgeHours,
                maxAgeHours: snapshotMaxAgeHours,
                sourceMtimeMax: snapshotMarker?.sourceMtimeMax || null,
                currentSourceMtimeMax: snapshotSourceCheck?.sourceMtimeMax || null,
                sourceFingerprintPresent: typeof snapshotMarker?.sourceFingerprint === "string" && snapshotMarker.sourceFingerprint.length > 0,
                sourceFingerprintComparable: snapshotSourceCheck?.ok === true,
                sourceFingerprintMatches,
                verifiedAt: snapshotSourceCheck?.verifiedAt || null,
                verificationError: snapshotSourceCheck?.ok === false ? snapshotSourceCheck.error : null,
            },
        },
        toolBridge: { mode: "codex-native-harness", active: routeReady, owner: "codex" },
        nativeToolCapability: { owner: "codex", adapterExecutesTools: false, transport: "codex-native" },
        lifecycle: {
            state: fixedRoute.state || "offline",
            live: routeReady,
            persistedState: String(fixedStatus?.state || ""),
            persistedProvider: String(fixedStatus?.provider || ""),
            persistedModel: String(fixedStatus?.model || ""),
            persistedPid: Number.isInteger(Number(fixedStatus?.pid)) ? Number(fixedStatus.pid) : null,
        },
        updateStatus,
        managerActionResults,
        postVerification: {
            present: releaseGates.exists,
            ok: releaseGates.effectiveOk,
            elapsedMs: releaseGates.elapsedMs,
            state: releaseGates.value?.currentGate || (releaseGates.exists ? "reported" : "not_checked"),
        },
        longTasks: {
            items: longTaskItems,
            state: longTaskItems.length ? "running" : "idle",
            runningCount: longTaskItems.length,
            attentionCount: 0,
        },
        installedChecks: { fast: installedFast, full: installedFull },
        shortcutRepair: { present: false, ok: null, state: "not_reported" },
        sourcePreflight,
        syncReadinessEvidence: fast ? null : syncReadiness.value?.syncReadinessEvidence || syncReadiness.value || null,
        capabilities: {
            hostedTools: false,
            internalWebTools: false,
            nativeStreaming: routeReady,
        },
        tools: {
            owner: "codex-native-harness",
            bridge: "codex-native",
            antigravityMode: provider === "antigravity",
            adapterExecutesTools: false,
        }
    };
}

function managerActionButtonHtml(actionId) {
  const action = MANAGER_ACTIONS[actionId];
  if (!action) throw new Error(`Unknown Manager page action: ${actionId}`);
  const danger = HIGH_IMPACT_MANAGER_ACTION_IDS.includes(actionId);
  return `<button${danger ? ' class="danger"' : ""} data-action="${actionId}" data-manager-action="${actionId}">${action.label}</button>`;
}

const managerHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anti-Codex 管理</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f8; --surface:#fff; --text:#18181b; --muted:#666; --border:#d8d8dc; --button:#f1f1f3; --danger:#a61b29; --danger-bg:#fff5f5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#18181b; --surface:#222225; --text:#f4f4f5; --muted:#aaa; --border:#3d3d42; --button:#2c2c31; --danger:#ff8a94; --danger-bg:#351d21; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width:min(1040px,calc(100% - 32px)); margin:24px auto 40px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; padding-bottom:16px; border-bottom:1px solid var(--border); }
  h1 { margin:0; font-size:22px; font-weight:650; }
  .notice { margin:0; color:var(--muted); text-align:right; }
  .hint { margin:8px 0 0; color:var(--muted); }
  section, details { padding:20px 0; border-bottom:1px solid var(--border); }
  h2, summary { margin:0 0 12px; font-size:15px; font-weight:600; }
  summary { cursor:pointer; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:8px; }
  button { min-height:40px; padding:8px 12px; border:1px solid var(--border); border-radius:6px; background:var(--button); color:var(--text); text-align:left; cursor:pointer; }
  button:hover { border-color:#6b7280; }
  button:disabled { cursor:wait; opacity:.58; }
  button.danger { border-color:color-mix(in srgb,var(--danger) 45%,var(--border)); background:var(--danger-bg); color:var(--danger); }
  pre { min-height:96px; max-height:360px; margin:0; padding:12px; overflow:auto; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); white-space:pre-wrap; word-break:break-word; }
  @media (max-width:640px) { header { align-items:flex-start; flex-direction:column; } .notice { text-align:left; } .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Anti-Codex 管理</h1>
    <p class="notice">只管理本机 Anti-Codex。标有真实流量或重启的操作会再次确认。</p>
  </header>
  <section data-action-group="status">
    <h2>当前状态</h2>
    <div class="grid">${MANAGER_ACTION_GROUPS.status.map((id) => managerActionButtonHtml(id)).join("")}</div>
  </section>
  <section data-action-group="modelSources">
    <h2>账号与模型来源</h2>
    <div class="grid">${MANAGER_ACTION_GROUPS.modelSources.map((id) => managerActionButtonHtml(id)).join("")}</div>
    <p class="hint">第三方 API 配置仅在客户端内的“管理”页面提供；此备用页面不读取或显示密钥。</p>
  </section>
  <section data-action-group="updates">
    <h2>Codex 更新</h2>
    <div class="grid">${MANAGER_ACTION_GROUPS.updates.map((id) => managerActionButtonHtml(id)).join("")}</div>
  </section>
  <section data-action-group="troubleshooting">
    <h2>故障排查</h2>
    <div class="grid">${MANAGER_ACTION_GROUPS.troubleshooting.map((id) => managerActionButtonHtml(id)).join("")}</div>
  </section>
  <details data-action-group="advanced">
    <summary>高级诊断</summary>
    <div class="grid">${MANAGER_ACTION_GROUPS.advanced.map((id) => managerActionButtonHtml(id)).join("")}</div>
  </details>
  <section>
    <h2>执行结果</h2>
    <pre id="actionResult" aria-live="polite">尚未执行操作。</pre>
  </section>
</main>
<script>
let managerActionToken = "";
let managerActions = {};
const highImpactActions = new Set(${JSON.stringify(HIGH_IMPACT_MANAGER_ACTION_IDS)});
const FALLBACK_BACKGROUND_POLL_INTERVAL_MS = 2000;
const FALLBACK_BACKGROUND_POLL_TIMEOUT_MS = 32 * 60 * 1000;
function confirmHighImpactAction(action, label) {
  return !highImpactActions.has(action) || window.confirm("确认执行“" + label + "”？此操作可能写入配置、消耗真实流量或重启 Anti-Codex。");
}
function fallbackDelay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function fallbackBackgroundReport(payload, action, startedAt) {
  const report = payload?.result?.diagnostics?.managerActionResults?.[action];
  const reportedAt = Date.parse(String(report?.reportedAt || ""));
  if (!report || report.exists === false || !Number.isFinite(reportedAt) || reportedAt < Number(startedAt || 0)) return null;
  const state = String(report.state || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const ok = report.effectiveOk === true || report.ok === true
    ? true
    : (report.effectiveOk === false || report.ok === false ? false : null);
  const terminalStates = {
    postVerificationFull: new Set(["completed", "verification_failed", "waiting_timeout"]),
    syncHost: new Set(["succeeded", "success", "completed", "failed", "failure", "rolled_back"]),
  };
  const statelessTerminalActions = new Set(["stabilitySoak", "coldRelaunch"]);
  if (state && state !== "invalid_report" && !terminalStates[action]?.has(state)) return null;
  if (!state && (!statelessTerminalActions.has(action) || ok === null)) return null;
  return { ...report, ok };
}
function fallbackManagerActionSummary(action, payload) {
  const label = managerActions[action]?.label || payload?.label || action || "管理操作";
  const layers = [];
  const seen = new Set();
  let current = payload;
  while (current && typeof current === "object" && !seen.has(current) && layers.length < 4) {
    layers.push(current);
    seen.add(current);
    current = current.result && typeof current.result === "object" ? current.result : null;
  }
  const verdicts = layers.flatMap((item) => [item.ok, item.effectiveOk]).filter((value) => typeof value === "boolean");
  const ok = verdicts.includes(false) ? false : (verdicts.includes(true) ? true : null);
  const detail = layers.slice().reverse().map((item) => (
    item.firstFailure || item.reason || item.message || (typeof item.error === "string" ? item.error : "")
  )).find(Boolean) || "";
  const reportPath = layers.slice().reverse().map((item) => (
    item.latestPath || item.report?.latest || item.zipPath || item.bundleRoot || ""
  )).find(Boolean) || "";
  return [
    label + "：" + (ok === true ? "已完成" : (ok === false ? "未通过" : "结果未知")),
    detail ? "说明：" + detail : "",
    reportPath ? "报告：" + reportPath : "",
  ].filter(Boolean).join("\\n");
}
async function bootstrap() {
  const response = await fetch("/anticodex/manager/bootstrap", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.token) throw new Error(payload.message || payload.error || "无法取得管理令牌");
  managerActionToken = payload.token;
  managerActions = payload.actions || {};
}
async function postFallbackManagerAction(action) {
  if (!managerActionToken) await bootstrap();
  const response = await fetch("/anticodex/manager/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-anticodex-manager-token": managerActionToken },
    body: JSON.stringify({ action })
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (response.status === 403) managerActionToken = "";
  if (!response.ok || payload?.ok === false) throw new Error(payload?.message || payload?.error || "操作失败");
  return payload;
}
async function waitForFallbackBackgroundAction(action, startedAt, result) {
  const deadline = Date.now() + FALLBACK_BACKGROUND_POLL_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const payload = await postFallbackManagerAction("refreshStatus");
      const report = fallbackBackgroundReport(payload, action, startedAt);
      if (report) return { state: "reported", report };
      const items = payload?.result?.diagnostics?.longTasks?.items || [];
      const running = items.some((item) => String(item?.id || "") === action && String(item?.state || "").toLowerCase() === "running");
      result.textContent = running
        ? "后台任务仍在运行，正在等待真实报告……"
        : "后台进程已结束，正在等待真实报告……";
      lastError = null;
    } catch (error) {
      lastError = error;
      managerActionToken = "";
      result.textContent = "连接暂时中断，正在等待管理服务恢复……";
      try { await bootstrap(); } catch {}
    }
    await fallbackDelay(FALLBACK_BACKGROUND_POLL_INTERVAL_MS);
  }
  return {
    state: "unknown",
    message: "结果未知：等待超时，仍未发现本次新报告。后台任务可能仍在运行。",
    connectionError: lastError ? String(lastError.message || lastError) : "",
  };
}
async function runFallbackManagerAction(button) {
  const action = button.dataset.managerAction;
  if (!confirmHighImpactAction(action, button.textContent.trim())) return;
  const actionStartedAt = Date.now();
  const result = document.getElementById("actionResult");
  const buttons = [...document.querySelectorAll("button[data-manager-action]")];
  buttons.forEach((item) => { item.disabled = true; });
  result.textContent = "正在执行：" + button.textContent.trim();
  try {
    const payload = await postFallbackManagerAction(action);
    if (payload?.background === true || payload?.result?.background === true) {
      result.textContent = payload.message || "后台任务已启动，正在等待真实报告……";
      const outcome = await waitForFallbackBackgroundAction(action, actionStartedAt, result);
      if (outcome.state === "reported") {
        result.textContent = fallbackManagerActionSummary(action, { ok: outcome.report.ok, result: outcome.report });
      } else {
        result.textContent = outcome.message;
      }
    } else {
      result.textContent = fallbackManagerActionSummary(action, payload);
    }
  } catch (error) {
    result.textContent = "执行失败：" + error.message;
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
}
document.querySelectorAll("button[data-manager-action]").forEach((button) => {
  button.addEventListener("click", () => { void runFallbackManagerAction(button); });
});
bootstrap().catch((error) => { document.getElementById("actionResult").textContent = "初始化失败：" + error.message; });
</script>
</body>
</html>
`;

export function createAntiCodexManagerService(options = {}) {
  const listenHost = options.host || "127.0.0.1";
  const listenPort = options.port !== undefined ? Number(options.port) : 8484;
  if (!LOOPBACK_HOSTNAMES.has(String(listenHost).toLowerCase())) {
    throw new Error("Anti-Codex Manager must listen on an explicit loopback address.");
  }
  const managerActionToken = crypto.randomBytes(32).toString("base64url");
  const upstreamTestEvidenceSalt = crypto.randomBytes(32);
  let upstreamTestEvidence = null;
  let upstreamTestGeneration = 0;
  const upstreamTestFingerprint = (profile, contextWindow) => {
    const request = buildCodexPlusPlusProbeRequest(profile);
    return crypto.createHmac("sha256", upstreamTestEvidenceSalt).update(JSON.stringify([
      request.protocol,
      request.url,
      request.body.model,
      String(contextWindow ?? "").trim(),
      request.apiKey,
    ])).digest("hex");
  };
  let resolvedPort = listenPort;
  const stateRoot = options.stateRoot ? path.resolve(options.stateRoot) : (process.env.DEEPCODEX_STATE_ROOT || path.join(process.env.APPDATA || "", "anticodex"));
  const codexHome = options.codexHome ? path.resolve(options.codexHome) : path.join(stateRoot, "codex-home-deepseek-app");
  const codexHomeRelative = path.relative(stateRoot, codexHome);
  if (codexHomeRelative === ".." || codexHomeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(codexHomeRelative)) {
    throw new Error("Anti-Codex custom instructions must stay inside the isolated state root.");
  }
  const fixedHealthUrl = options.fixedHealthUrl || process.env.ANTICODEX_FIXED_ROUTE_HEALTH_URL || "http://127.0.0.1:18487/anticodex/fixed-route/health";
  const scriptsRoot = __dirname;
  const adapterAuthToken = String(options.adapterAuthToken || "");
  const managerActionRuntime = options.managerActionRuntime;
  const refreshModels = options.refreshModels;
  let accountDriver;
  const officialLogin = createAntigravityOfficialLogin({
    scriptsRoot,
    stopDesktop: () => accountDriver.beginChange({ acknowledgeRestart: true }),
  });
  if (!options.accountManager) accountDriver = createAntigravityAccountDriver({ scriptsRoot, ...officialLogin });
  const accountManager = options.accountManager || createAntigravityAccountManager({ stateRoot, driver: accountDriver });
  let accountJob = null;
  const refreshStatus = async () => ({
    ok: true,
    diagnostics: await diagnosticsPayload(stateRoot, false, fixedHealthUrl, adapterAuthToken),
    reports: latestManagerReportsPayload(stateRoot),
  });
  const thirdPartySavePaths = [
    path.join(stateRoot, "upstream-profile.json"),
    path.join(stateRoot, "upstream-profile.key"),
    path.join(stateRoot, "codexplusplus", "settings.json"),
    path.join(stateRoot, "codex-home-deepseek-app", "anticodex-model-catalog.json"),
  ];

  const server = http.createServer(async (req, res) => {
    if (!validateLoopbackAndTrusted(req, res)) {
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      return respondToPreflight(req, res);
    }
    if (req.method === "POST" && accountJob?.status === "running") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      return jsonResponse(res, 409, { ok: false, message: "账号操作正在运行，请等待完成。" }, req);
    }

    if (req.method === "GET" && pathname === "/health") {
      const fixedRoute = await fixedRouteHealthSnapshot(fixedHealthUrl);
      const account = await fixedRouteAccountSnapshot(fixedRoute, { authToken: adapterAuthToken });
      const upstreamMode = fixedRoute.provider === "third-party"
        ? "third-party"
        : fixedRoute.provider === "antigravity"
          ? "antigravity"
          : "unknown";
      const upstreamProtocol = upstreamMode === "third-party"
        ? (fixedRoute.relayProtocol === "responses" ? "responses" : "openai-compatible")
        : "";
      const routeReady = fixedRoute.ready === true;
      return jsonResponse(res, routeReady ? 200 : 503, {
        schema: "anticodex-manager-service-v1",
        ok: routeReady,
        role: "launcher-management-only",
        upstream: fixedRoute.provider === "antigravity" ? "antigravity-desktop" : (fixedRoute.provider === "third-party" ? "codexplusplus-third-party" : "offline"),
        state: fixedRoute.state,
        routeReady,
        provider: fixedRoute.provider,
        model: fixedRoute.model,
        modelCount: Number(fixedRoute.catalogModelCount ?? 0),
        upstreamProfile: {
          mode: upstreamMode,
          protocol: upstreamProtocol,
          model: fixedRoute.model || "",
        },
        accountReady: fixedRoute.provider === "antigravity" ? account.signedIn === true && account.identityAvailable === true : null,
        accountMessage: account.message || account.state || "",
        accountState: account.state,
        accountTrafficReady: null,
        accountTrafficModel: fixedRoute.provider === "antigravity" ? fixedRoute.model : "",
        accountTrafficSuggestedAction: fixedRoute.provider === "antigravity"
          ? "Run a bounded model request to verify current quota."
          : "",
        fixedRoute,
      }, req);
    }

    if (req.method === "GET" && pathname === "/anticodex/account") {
      const fixedRoute = await fixedRouteHealthSnapshot(fixedHealthUrl);
      const account = await fixedRouteAccountSnapshot(fixedRoute, { authToken: adapterAuthToken });
      return jsonResponse(res, account.ok ? 200 : 503, account, req);
    }

    if (req.method === "GET" && pathname === "/anticodex/accounts") {
      if (!validateManagerSourceRequest(req, res, "account management")) return;
      try {
        return jsonResponse(res, 200, { ok: true, ...await accountManager.list(), job: accountJob }, req);
      } catch (error) {
        return jsonResponse(res, 500, { ok: false, message: error.message }, req);
      }
    }

    if (req.method === "POST" && pathname === "/anticodex/accounts/action") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      try {
        const body = JSON.parse((await readRequestBody(req)).toString("utf8") || "{}");
        const methods = { capture: "captureCurrent", activate: "activate", refresh: "refresh", remove: "remove", rename: "rename", login: "login" };
        const action = String(body.action || "");
        if (!Object.hasOwn(methods, action)) return jsonResponse(res, 400, { ok: false, message: "不支持的账号操作。" }, req);
        if (accountJob?.status === "running" || ACTIVE_FOREGROUND_ACTIONS.size || ACTIVE_BACKGROUND_ACTION_LOCKS.size) {
          return jsonResponse(res, 409, { ok: false, message: "已有管理操作正在运行，请等待完成。" }, req);
        }
        const args = {};
        if (["activate", "refresh", "remove", "rename"].includes(action) && typeof body.id === "string") args.id = body.id;
        if (["capture", "rename", "login"].includes(action) && typeof body.label === "string") args.label = body.label;
        if (["activate", "refresh", "login"].includes(action)) args.acknowledgeRestart = body.acknowledgeRestart === true;
        if (action === "refresh" && body.all === true) args.all = true;
        const job = { id: crypto.randomUUID(), action, status: "running", startedAt: new Date().toISOString(), message: action === "login" ? "请在官方登录页完成登录；完成后将保存账号。" : "正在处理账号操作..." };
        args.onProgress = (message) => {
          if (accountJob === job && job.status === "running" && typeof message === "string") job.message = message.slice(0, 240);
        };
        accountJob = job;
        void Promise.resolve().then(() => accountManager[methods[action]](args)).then(() => {
          job.status = "completed";
          job.message = ["activate", "login"].includes(action) ? "账号已启用，Antigravity 已打开并完成登录核验。" : "账号操作已完成。";
        }, (error) => {
          job.status = "failed";
          job.message = error.message || "账号操作失败，请检查当前官方登录状态。";
        }).finally(() => { job.finishedAt = new Date().toISOString(); });
        return jsonResponse(res, 202, { ok: true, job }, req);
      } catch (error) {
        return jsonResponse(res, 400, { ok: false, message: error.message }, req);
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/manager/bootstrap") {
      if (!validateManagerSourceRequest(req, res, "manager bootstrap")) return;
      return jsonResponse(res, 200, {
        ok: true,
        token: managerActionToken,
        baseUrl: `http://${listenHost}:${resolvedPort}`,
        actions: Object.fromEntries(Object.entries(MANAGER_ACTIONS).map(([key, value]) => [key, {
          label: value.label,
          background: Boolean(value.background),
        }])),
      }, req);
    }

    if (req.method === "GET" && pathname === "/anticodex/prompt-policy") {
      if (!validateManagerSourceRequest(req, res, "prompt policy")) return;
      return jsonResponse(res, 200, promptPolicyPayload(stateRoot, codexHome), req);
    }

    if (req.method === "POST" && pathname === "/anticodex/prompt-policy") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      let snapshots = [];
      try {
        const raw = await readRequestBody(req);
        const value = JSON.parse(raw.toString("utf8") || "{}");
        const hasNativeContent = Object.hasOwn(value, "nativeCustomInstructions");
        if (hasNativeContent) readNativeCustomInstructions(codexHome);
        snapshots = captureFileSnapshots([
          path.join(stateRoot, "prompt-policy.json"),
          ...(hasNativeContent ? [path.join(codexHome, "AGENTS.md")] : []),
        ]);
        const policy = savePromptPolicy(stateRoot, value);
        if (hasNativeContent) saveNativeCustomInstructions(codexHome, value.nativeCustomInstructions?.content);
        const payload = promptPolicyPayload(stateRoot, codexHome);
        return jsonResponse(res, 200, {
          ok: true,
          policy,
          nativeCustomInstructions: payload.nativeCustomInstructions,
          message: "提示词设置已保存；从下一次新模型请求开始生效。",
        }, req);
      } catch (error) {
        try { restoreFileSnapshots(snapshots); } catch (restoreError) {
          error.message += `；回滚失败：${restoreError.message}`;
        }
        return jsonResponse(res, 400, { ok: false, message: error.message }, req);
      }
    }

    if (req.method === "POST" && pathname === "/anticodex/manager/action") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      let body;
      try {
        const raw = await readRequestBody(req);
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, error: "Invalid JSON or request body size limit exceeded" }, req);
      }
      try {
        const action = String(body.action || "");
        const payload = await runManagerBridgeAction(action, stateRoot, scriptsRoot, { refreshModels, refreshStatus, managerActionRuntime });
        return jsonResponse(res, 200, payload, req);
      } catch (err) {
        return jsonResponse(res, err.statusCode || 500, { ok: false, message: err.message }, req);
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/manager/action-script") {
      const callbackName = url.searchParams.get("callback") || "";
      if (!isValidJsonpCallbackName(callbackName)) {
        return jsonResponse(res, 400, { ok: false, error: "Invalid Anti-Codex manager action callback." }, req);
      }
      if (url.searchParams.get("token") !== managerActionToken) {
        return jsonResponse(res, 403, { ok: false, error: "Anti-Codex manager action token is missing or invalid." }, req);
      }
      if (!validateManagerSourceRequest(req, res, "manager action")) return;
      if (accountJob?.status === "running") return jsonResponse(res, 409, { ok: false, message: "账号操作正在运行，请等待完成。" }, req);
      try {
        const action = String(url.searchParams.get("action") || "");
        const payload = await runManagerBridgeAction(action, stateRoot, scriptsRoot, { refreshModels, refreshStatus, managerActionRuntime });
        return javascriptResponse(res, 200, managerActionScriptResponse(callbackName, payload));
      } catch (err) {
        const payload = {
          ok: false,
          action: String(url.searchParams.get("action") || ""),
          message: err.message,
          statusCode: err.statusCode || 500,
        };
        return javascriptResponse(res, 200, managerActionScriptResponse(callbackName, payload));
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/manager") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(managerHtml);
      return;
    }

    if (req.method === "GET" && (pathname === "/models" || pathname === "/v1/models")) {
      let proxyPort = 18484;
      let localProxyKey = "anticodex-local-proxy-key";
      let routeProvider = "";
      try {
        const statusPath = path.join(stateRoot, "fixed-route-status.json");
        if (fs.existsSync(statusPath)) {
          const statusData = JSON.parse(fs.readFileSync(statusPath, "utf8"));
          routeProvider = String(statusData?.provider || "").trim().toLowerCase();
          if (statusData && statusData.ports && statusData.ports.proxy) {
            proxyPort = statusData.ports.proxy;
          }
        }
      } catch {}
      if (routeProvider === "third-party") {
        try {
          const catalogPath = path.join(stateRoot, "codex-home-deepseek-app", "anticodex-model-catalog.json");
          const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
          const data = (Array.isArray(catalog?.models) ? catalog.models : [])
            .filter((entry) => String(entry?.visibility || "").toLowerCase() !== "hide")
            .map((entry) => ({
              id: String(entry?.slug || "").trim(),
              object: "model",
              owned_by: "anticodex",
              display_name: String(entry?.display_name || entry?.slug || "").trim(),
            }))
            .filter((entry) => entry.id);
          if (data.length > 0) {
            return jsonResponse(res, 200, { object: "list", data, source: "isolated-unified-catalog" }, req);
          }
        } catch {}
      }
      try {
        const authPath = path.join(stateRoot, "codex-home-deepseek-app", "auth.json");
        if (fs.existsSync(authPath)) {
          const authData = JSON.parse(fs.readFileSync(authPath, "utf8"));
          if (authData && authData.OPENAI_API_KEY) {
            localProxyKey = authData.OPENAI_API_KEY;
          }
        }
      } catch {}

      try {
        const fetchRes = await fetch(`http://127.0.0.1:${proxyPort}/models`, {
          headers: { authorization: `Bearer ${localProxyKey}` },
          signal: AbortSignal.timeout(2000),
        });
        if (fetchRes.ok) {
          const body = await fetchRes.json();
          return jsonResponse(res, 200, body, req);
        } else {
          return jsonResponse(res, 200, {
            object: "list",
            data: [],
            source: "fixed-route-proxy",
            error: `HTTP ${fetchRes.status}: ${fetchRes.statusText}`
          }, req);
        }
      } catch (err) {
        return jsonResponse(res, 200, {
          object: "list",
          data: [],
          source: "fixed-route-proxy",
          error: err.message || "Connection failed"
        }, req);
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/upstream-profile") {
      try {
        const [saved, fixedRoute] = await Promise.all([
          runUpstreamProfileScript("GetPublic", {}, stateRoot, scriptsRoot),
          fixedRouteHealthSnapshot(fixedHealthUrl),
        ]);
        const antigravityModels = antigravityModelsFromCatalog(stateRoot);
        if (fixedRoute.provider === "antigravity" && fixedRoute.model
            && !antigravityModels.some((entry) => entry.id === fixedRoute.model)) {
          antigravityModels.unshift({ id: fixedRoute.model, label: fixedRoute.model });
        }
        return jsonResponse(res, 200, {
          ok: true,
          active: activeUpstreamMode(fixedRoute),
          runtime: { mode: activeUpstreamMode(fixedRoute), provider: fixedRoute.provider, model: fixedRoute.model },
          saved,
          fixedRoute,
          antigravityModels,
        }, req);
      } catch (error) {
        return jsonResponse(res, error.statusCode || 500, { ok: false, message: error.message }, req);
      }
    }

    if (req.method === "POST" && pathname === "/anticodex/upstream-test") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      const testGeneration = ++upstreamTestGeneration;
      upstreamTestEvidence = null;
      try {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw.toString("utf8") || "{}");
        let apiKey = String(body.apiKey || "");
        if (!apiKey) {
          const savedRuntime = await runUpstreamProfileScript("GetRuntime", {}, stateRoot, scriptsRoot);
          apiKey = String(savedRuntime.apiKey || "");
        }
        const profile = {
          protocol: body.protocol,
          baseUrl: body.baseUrl,
          apiKey,
          model: body.model,
        };
        const stages = await testCodexPlusPlusUpstreamConnection(profile, {
          timeoutMs: managerUpstreamTimeoutMs(body.timeoutMs),
          discoverModels: true,
        });
        const ok = stages.length > 0 && stages.every((stage) => stage.status !== "fail");
        const sanitizedStages = sanitizedConnectionStages(stages);
        if (ok && testGeneration === upstreamTestGeneration) {
          upstreamTestEvidence = {
            fingerprint: upstreamTestFingerprint(profile, body.contextWindow),
            stages: sanitizedStages,
            expiresAt: Date.now() + UPSTREAM_TEST_EVIDENCE_TTL_MS,
          };
        }
        return jsonResponse(res, 200, { ok, stages: sanitizedStages, summary: upstreamConnectionSummary(sanitizedStages) }, req);
      } catch (error) {
        return jsonResponse(res, 200, {
          ok: false,
          summary: upstreamConnectionSummary([{ stage: "配置验证", status: "fail", detail: error.message || "配置无效" }]),
          stages: [{ stage: "配置验证", status: "fail", detail: error.message || "配置无效" }],
        }, req);
      }
    }

    if (req.method === "POST" && pathname === "/anticodex/upstream-profile") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      upstreamTestGeneration += 1;
      const testEvidence = upstreamTestEvidence;
      upstreamTestEvidence = null;
      let saveSnapshots = null;
      try {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw.toString("utf8") || "{}");
        if (body.mode === "antigravity") {
          return jsonResponse(res, 400, {
            ok: false,
            message: "模型切换请在聊天输入框的模型菜单中完成；Manager 只保存第三方配置。",
          }, req);
        }
        let apiKey = String(body.apiKey || "");
        if (!apiKey) {
          const savedRuntime = await runUpstreamProfileScript("GetRuntime", {}, stateRoot, scriptsRoot);
          apiKey = String(savedRuntime.apiKey || "");
        }
        const profile = {
          protocol: body.protocol,
          baseUrl: body.baseUrl,
          apiKey,
          model: body.model,
        };
        const testEvidenceFresh = testEvidence && testEvidence.expiresAt >= Date.now();
        const testEvidenceMatches = testEvidenceFresh
          && testEvidence.fingerprint === upstreamTestFingerprint(profile, body.contextWindow);
        if (!testEvidenceMatches) {
          return jsonResponse(res, 400, { ok: false, message: "请先完成“测试连通”，确认接口可用后再保存。" }, req);
        }
        const stages = testEvidence.stages;
        const testStatus = "success";
        const capabilities = {
          connectionStages: sanitizedConnectionStages(stages),
          providerModels: providerModelIdsFromConnectionStages(stages, body.model),
        };
        saveSnapshots = captureFileSnapshots(thirdPartySavePaths);
        const savedProfile = await runUpstreamProfileScript("SaveThirdParty", {
          protocol: body.protocol,
          baseUrl: body.baseUrl,
          model: body.model,
          contextWindow: body.contextWindow,
          apiKey,
          testStatus,
          capabilitiesJson: JSON.stringify(capabilities),
        }, stateRoot, scriptsRoot);
        const saved = saveThirdPartyCodexPlusPlusSettings({
          settingsPath: thirdPartySavePaths[2],
          nativeCatalogPath: thirdPartySavePaths[3],
          thirdParty: {
            protocol: savedProfile.protocol,
            baseUrl: savedProfile.baseUrl,
            model: savedProfile.model,
            apiKey,
            contextWindow: savedProfile.contextWindow,
            providerModels: savedProfile.capabilities?.providerModels || capabilities.providerModels,
          },
        });
        saveSnapshots = null;
        return jsonResponse(res, 200, {
          ...saved,
          message: "配置已保存，可在聊天输入框的模型菜单选择第三方模型。",
        }, req);
      } catch (error) {
        if (saveSnapshots) {
          try { restoreFileSnapshots(saveSnapshots); }
          catch (rollbackError) { error.message += ` Rollback failed: ${rollbackError.message}`; }
        }
        return jsonResponse(res, error.statusCode || 400, { ok: false, message: error.message }, req);
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/diagnostics") {
      const fast = url.searchParams.get("fast") === "1";
      return jsonResponse(res, 200, await diagnosticsPayload(stateRoot, fast, fixedHealthUrl, adapterAuthToken, {
        verifySnapshotFreshness: url.searchParams.get("snapshotFreshness") === "refresh",
      }), req);
    }

    if (req.method === "GET" && pathname === "/anticodex/model-routes") {
      return jsonResponse(res, 200, { count: 0, latest: null, entries: [] }, req);
    }

    if (req.method === "GET" && pathname === "/anticodex/local-connectors/allowlist") {
      if (!validateManagerSourceRequest(req, res, "local connector allowlist")) return;
      return jsonResponse(res, 200, localConnectorAllowlistPayload(stateRoot), req);
    }

    if (req.method === "POST" && pathname === "/anticodex/local-connectors/allowlist") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      try {
        const raw = await readRequestBody(req);
        let parsed = {};
        if (raw.length > 0) {
          parsed = JSON.parse(raw.toString("utf8"));
        }
        const connectorIds = validateLocalConnectorIds(parsed.connectorIds, stateRoot);
        const configPath = writePersistedLocalConnectorAllowlist(connectorIds, stateRoot);
        return jsonResponse(res, 200, {
          ...localConnectorAllowlistPayload(stateRoot),
          saved: true,
          configPath,
        }, req);
      } catch (error) {
        return jsonResponse(res, error.statusCode || 500, { ok: false, message: error.message }, req);
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/connectors/auth") {
      if (!validateManagerSourceRequest(req, res, "connector auth status")) return;
      return jsonResponse(res, 200, {
        ok: true,
        connectors: listConnectorAuth({
          stateRoot,
          codexHome,
          sharedCodexHome: process.env.DEEPCODEX_SHARED_CODEX_HOME || process.env.GLOBAL_CODEX_HOME || path.join(process.env.USERPROFILE || "", ".codex"),
        }),
      }, req);
    }

    if (req.method === "POST" && pathname === "/anticodex/connectors/auth/start") {
      if (!validateManagerActionRequest(req, res, managerActionToken)) return;
      try {
        const raw = await readRequestBody(req);
        const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
        const host = String(req.headers.host || `127.0.0.1:${resolvedPort}`);
        const redirectUri = `http://${host}/anticodex/connectors/oauth/callback`;
        const result = await startConnectorAuth({
          stateRoot,
          codexHome,
          sharedCodexHome: process.env.DEEPCODEX_SHARED_CODEX_HOME || process.env.GLOBAL_CODEX_HOME || path.join(process.env.USERPROFILE || "", ".codex"),
        }, String(body.connectorId || ""), redirectUri);
        return jsonResponse(res, 200, { ok: true, ...result }, req);
      } catch (error) {
        return jsonResponse(res, 400, { ok: false, error: error.message }, req);
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/connectors/oauth/callback") {
      try {
        const result = await finishConnectorAuth({ stateRoot, codexHome }, Object.fromEntries(url.searchParams.entries()));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Anti-Codex</title><p>Anti-Codex 授权成功，可以关闭此窗口。</p><script>window.close()</script>`);
        return result;
      } catch (error) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Anti-Codex</title><p>授权失败：${String(error.message).replace(/[&<>]/g, "")}</p>`);
        return null;
      }
    }

    const compatJson = localBackendApiResponse(req.method, pathname);
    if (compatJson !== null) {
      return jsonResponse(res, 200, compatJson, req);
    }

    return jsonResponse(res, 404, { ok: false, error: "Not Found" }, req);
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, listenHost, () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            resolvedPort = addr.port;
          }
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  };
}

// CLI entry point
function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = args[i + 1];
      if (value && !value.startsWith("--")) {
        result[key] = value;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

if (process.argv[1] && (process.argv[1].endsWith("anticodex-manager-service.mjs") || process.argv[1].endsWith("anticodex-manager-service"))) {
  const cliOptions = parseArgs(process.argv.slice(2));
  if (cliOptions.port) cliOptions.port = parseInt(cliOptions.port, 10);
  const service = createAntiCodexManagerService(cliOptions);
  service.listen().then(() => {
    console.log(`Anti-Codex Manager Service listening on ${cliOptions.host || "127.0.0.1"}:${cliOptions.port || 8484}`);
  }).catch((err) => {
    console.error("Failed to start service:", err);
    process.exit(1);
  });
}
