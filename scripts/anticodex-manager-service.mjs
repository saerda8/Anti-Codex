import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { testCodexPlusPlusUpstreamConnection } from "../translator/provider/codexplusplus-upstream-probe.mjs";
import { localBackendApiResponse } from "../translator/local-projection/index.mjs";
import {
    ANTIGRAVITY_MODEL_SLOT,
    ANTIGRAVITY_RELAY_ID,
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
        args: ["-AllowUnready"],
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
        args: [],
        timeoutMs: 30000,
    },
    sourcePreflight: {
        label: "运行源码预检",
        script: "test-anticodex-source-preflight.ps1",
        args: ["-SkipFullRegression"],
        timeoutMs: 90000,
        foregroundSingleton: true,
    },
    upstreamConfig: {
        label: "配置第三方 API",
        virtual: true,
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
        timeoutMs: 10000,
        background: true,
        singletonProcessPattern: "refresh-anticodex-local-features\\.ps1",
        backgroundLockMaxMs: 10 * 60000,
    },
    stabilitySoak: {
        label: "稳定性巡检（耗真实流量）",
        script: "test-anticodex-stability-soak.ps1",
        args: [],
        timeoutMs: 10000,
        background: true,
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
        singletonProcessPattern: "test-anticodex-post-verification\\.ps1",
        backgroundLockMaxMs: 20 * 60000,
    },
});

const DAILY_MANAGER_ACTION_IDS = Object.freeze([
  "refreshStatus",
  "refreshModels",
  "accountSwitch",
  "accountProxy",
  "syncReadiness",
  "repairShortcuts",
  "updateCheck",
  "sourcePreflight",
  "mcpSkills",
  "pluginCapabilities",
  "diagnosticsBundle",
  "viewLatestReports",
]);

const HIGH_IMPACT_MANAGER_ACTION_IDS = Object.freeze([
  "syncHost",
  "upstreamConfig",
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
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction SilentlyContinue",
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
    } catch {
        return [];
    }
}

// Run action
async function runManagerAction(actionName, stateRoot, scriptsRoot) {
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
        const lockKey = action.singletonProcessPattern || actionName;
        if (ACTIVE_BACKGROUND_ACTION_LOCKS.has(lockKey)) {
            const task = ACTIVE_BACKGROUND_ACTIONS.get(lockKey) || {};
            return {
                ok: true,
                action: actionName,
                label,
                background: true,
                alreadyRunning: true,
                runningPids: Number.isFinite(Number(task.pid)) ? [Number(task.pid)] : [],
                backgroundStartedAt: task.backgroundStartedAt || "",
                message: `${label} 已经在后台运行。`,
            };
        }
        ACTIVE_BACKGROUND_ACTION_LOCKS.add(lockKey);
        try {
            const running = await managerActionRunningProcesses(action, scriptsRoot);
            if (running.length > 0) {
                ACTIVE_BACKGROUND_ACTION_LOCKS.delete(lockKey);
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
                cwd: scriptsRoot,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            const backgroundStartedAt = new Date().toISOString();
            ACTIVE_BACKGROUND_ACTIONS.set(lockKey, { actionName, label, pid: child.pid, backgroundStartedAt });
            const clearLock = () => {
                ACTIVE_BACKGROUND_ACTION_LOCKS.delete(lockKey);
                ACTIVE_BACKGROUND_ACTIONS.delete(lockKey);
            };
            child.once("exit", clearLock);
            child.once("error", clearLock);
            const lockTimer = setTimeout(clearLock, action.backgroundLockMaxMs || 30 * 60000);
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
            ACTIVE_BACKGROUND_ACTIONS.delete(lockKey);
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
        return { ok: true, action: actionName, result: { ok: true } };
    }
    if (actionName === "upstreamConfig") {
        return { ok: true, action: actionName, result: { ok: true, virtual: true } };
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
    return runManagerAction(actionName, stateRoot, scriptsRoot);
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
  const timestampMs = parseable ? reportTimestampMs(value, fullPath) : null;
  const ageMs = Number.isFinite(timestampMs) ? Math.max(0, Date.now() - timestampMs) : null;
  const rawOk = !invalid && value?.ok === true;
  const releaseGateReport = fileName === "latest-release-gates.json";
  const effectiveOk = releaseGateReport
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
    ["源码预检", "latest-source-preflight.json"],
    ["安装与同步", "latest-sync-readiness.json"],
    ["安装态检查", "latest-installed-overall.json"],
    ["最终长任务", "latest-gate8-final-long-task.json"],
    ["诊断", "latest-diagnostics.json"],
    ["模型可用性", "latest-model-availability.json", true],
    ["MCP 与技能", "latest-mcp-skills.json", true],
    ["插件与应用", "latest-plugin-capabilities.json", true],
    ["本地连接器", "latest-local-connectors.json", true],
    ["后台进程", "latest-worker-process-hygiene.json", true],
    ["冷启动恢复", "latest-cold-relaunch.json", true],
    ["稳定性巡检", "latest-stability-soak.json", true],
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
    addArg("AntigravityModel", values.antigravityModel);
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
    const parent = path.dirname(filePath);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        fs.renameSync(temporary, filePath);
    } finally {
        try { fs.rmSync(temporary, { force: true }); } catch {}
    }
}

function prepareThirdPartyNativeCatalog(catalogPath, model, contextWindow) {
    const resolvedPath = path.resolve(String(catalogPath || ""));
    if (!fs.existsSync(resolvedPath)) {
        throw new Error("The native model catalog is unavailable for an in-place switch.");
    }
    const catalog = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const exactSlug = thirdPartyNativeModel(model);
    const directPrefix = `${THIRD_PARTY_MODEL_SLOT}/`;
    const template = models.find((entry) => String(entry?.slug || "") === exactSlug)
        || models.find((entry) => String(entry?.slug || "") === THIRD_PARTY_MODEL_SLOT)
        || models.find((entry) => String(entry?.slug || "").startsWith(directPrefix));
    if (!template) {
        throw new Error("The native third-party model template is unavailable for an in-place switch.");
    }
    const nextModels = models
        .filter((entry) => String(entry?.slug || "") !== exactSlug)
        .map((entry) => {
            const slug = String(entry?.slug || "");
            if (slug.startsWith(directPrefix)) return { ...entry, visibility: "hide" };
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
    const nativeModel = {
        ...template,
        slug: exactSlug,
        display_name: `第三方 · ${model}`,
        description: `第三方 API 模型 ${model}`,
        visibility: "list",
        supported_in_api: true,
        upgrade: null,
        availability_nux: null,
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 90,
    };
    const genericIndex = nextModels.findIndex((entry) => String(entry?.slug || "") === THIRD_PARTY_MODEL_SLOT);
    nextModels.splice(genericIndex < 0 ? nextModels.length : genericIndex, 0, nativeModel);
    catalog.models = nextModels.map((entry, priority) => ({ ...entry, priority }));
    return {
        catalog,
        catalogPath: resolvedPath,
        modelIds: catalog.models.map((entry) => String(entry?.slug || "").trim()).filter(Boolean),
    };
}

export function hotSwitchCodexPlusPlusSettings(options = {}) {
    const settingsPath = path.resolve(String(options.settingsPath || ""));
    if (!fs.existsSync(settingsPath)) {
        throw new Error("CodexPlusPlus settings are unavailable for an in-place switch.");
    }
    const mode = String(options.mode || "").trim().toLowerCase();
    if (mode !== "antigravity" && mode !== "third-party") {
        throw new Error("Anti-Codex mode must be antigravity or third-party.");
    }
    const adapterPort = validLoopbackPort(options.adapterPort);
    if (!adapterPort) throw new Error("The Antigravity adapter port is unavailable.");
    const originalSettingsSource = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(originalSettingsSource);
    const profiles = Array.isArray(settings.relayProfiles) ? settings.relayProfiles : [];
    const byId = new Map(profiles.map((profile) => [String(profile?.id || ""), profile]));
    const antigravityModel = String(options.antigravityModel || "gemini-3-flash-agent").trim();
    const antigravityModels = uniqueModelIds([
        ANTIGRAVITY_MODEL_SLOT,
        antigravityModel,
        ...(Array.isArray(options.antigravityModels) ? options.antigravityModels : []),
    ]);
    const existingAntigravityProfile = byId.get(ANTIGRAVITY_RELAY_ID) || {};
    const antigravityApiKey = String(existingAntigravityProfile.apiKey || "");
    if (!antigravityApiKey) {
        throw new Error("The authenticated Antigravity adapter profile is unavailable for an in-place switch.");
    }
    const antigravityProfile = {
        ...existingAntigravityProfile,
        id: ANTIGRAVITY_RELAY_ID,
        name: "Anti-Codex Antigravity",
        upstreamBaseUrl: `http://127.0.0.1:${adapterPort}/v1`,
        apiKey: antigravityApiKey,
        protocol: "chatCompletions",
        relayMode: "pureApi",
        testModel: antigravityModel,
        useCommonConfig: false,
        modelList: antigravityModels.join("\n"),
    };
    byId.set(ANTIGRAVITY_RELAY_ID, antigravityProfile);

    const thirdParty = options.thirdParty && typeof options.thirdParty === "object"
        ? options.thirdParty
        : null;
    if (thirdParty?.baseUrl || thirdParty?.model || thirdParty?.apiKey) {
        const baseUrl = String(thirdParty.baseUrl || "").trim().replace(/\/$/, "");
        const model = String(thirdParty.model || "").trim();
        const apiKey = String(thirdParty.apiKey || "");
        if (!baseUrl || !model || !apiKey) {
            throw new Error("Saved third-party route is incomplete for an in-place switch.");
        }
        const modelIds = uniqueModelIds([
            THIRD_PARTY_MODEL_SLOT,
            thirdPartyNativeModel(model),
            ...(Array.isArray(thirdParty.providerModels)
                ? thirdParty.providerModels
                    .map((entry) => String(entry || "").trim())
                    .filter(Boolean)
                    .map((entry) => thirdPartyNativeModel(entry))
                : []),
        ]);
        byId.set(THIRD_PARTY_RELAY_ID, {
            ...(byId.get(THIRD_PARTY_RELAY_ID) || {}),
            id: THIRD_PARTY_RELAY_ID,
            name: "Anti-Codex third-party API",
            upstreamBaseUrl: baseUrl,
            apiKey,
            protocol: thirdPartyRelayProtocol(thirdParty.protocol),
            relayMode: "pureApi",
            testModel: model,
            contextWindow: String(Number(thirdParty.contextWindow || 272000)),
            autoCompactLimit: String(Math.floor(Number(thirdParty.contextWindow || 272000) * 0.9)),
            authContents: `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`,
            useCommonConfig: false,
            modelList: modelIds.join("\n"),
        });
    }
    const thirdPartyProfile = byId.get(THIRD_PARTY_RELAY_ID);
    if (mode === "third-party" && !thirdPartyProfile) {
        throw new Error("No saved third-party relay is available for an in-place switch.");
    }

    const orderedProfiles = [
        byId.get(ANTIGRAVITY_RELAY_ID),
        byId.get(THIRD_PARTY_RELAY_ID),
        ...profiles.filter((profile) => ![ANTIGRAVITY_RELAY_ID, THIRD_PARTY_RELAY_ID].includes(String(profile?.id || ""))),
    ].filter(Boolean);
    let nativeCatalogModelIds =
        Array.isArray(options.nativeCatalogModels)
            ? options.nativeCatalogModels.map((entry) => String(entry || "").trim()).filter(Boolean)
            : [];
    let preparedNativeCatalog = null;
    if (mode === "third-party" && options.nativeCatalogPath) {
        preparedNativeCatalog = prepareThirdPartyNativeCatalog(
            options.nativeCatalogPath,
            thirdPartyProfile.testModel,
            Number(thirdPartyProfile.contextWindow || 272000),
        );
        nativeCatalogModelIds = preparedNativeCatalog.modelIds;
    }
    const nativeCatalogModels = new Set(nativeCatalogModelIds);

    settings.relayProfiles = orderedProfiles;
    settings.activeRelayId = mode === "antigravity" ? ANTIGRAVITY_RELAY_ID : THIRD_PARTY_RELAY_ID;
    settings.relayTestModel = mode === "antigravity" ? antigravityModel : thirdPartyProfile.testModel;
    writeJsonAtomic(settingsPath, settings);
    if (preparedNativeCatalog) {
        try {
            writeJsonAtomic(preparedNativeCatalog.catalogPath, preparedNativeCatalog.catalog);
        } catch (error) {
            try {
                writeJsonAtomic(settingsPath, JSON.parse(originalSettingsSource));
            } catch (rollbackError) {
                error.message += ` Settings rollback failed: ${rollbackError.message}`;
            }
            throw error;
        }
    }
    let nativeModel;
    if (mode === "antigravity") {
        nativeModel = nativeCatalogModels.size === 0 || nativeCatalogModels.has(antigravityModel)
            ? { slug: antigravityModel, label: antigravityModel }
            : { slug: ANTIGRAVITY_MODEL_SLOT, label: "Antigravity（当前模型）" };
    } else {
        const exact = thirdPartyNativeModel(thirdPartyProfile.testModel);
        nativeModel = nativeCatalogModels.has(exact)
            ? { slug: exact, label: `第三方 · ${thirdPartyProfile.testModel}` }
            : { slug: THIRD_PARTY_MODEL_SLOT, label: "第三方 API（当前模型）" };
    }
    return {
        ok: true,
        hotSwitch: true,
        restartRequired: false,
        mode,
        model: settings.relayTestModel,
        activeRelayId: settings.activeRelayId,
        nativeModel,
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

function nativeModelSlugsFromCatalog(stateRoot = "") {
    const catalogPath = path.join(stateRoot, "codex-home-deepseek-app", "anticodex-model-catalog.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
        return uniqueModelIds(
            (Array.isArray(parsed?.models) ? parsed.models : []).map((entry) => entry?.slug),
        );
    } catch {
        return [];
    }
}

function savedThirdPartyForHotSwitch(runtimeProfile = {}) {
    const providerModels = Array.isArray(runtimeProfile?.capabilities?.providerModels)
        ? runtimeProfile.capabilities.providerModels
        : [];
    if (!runtimeProfile.baseUrl && !runtimeProfile.model && !runtimeProfile.apiKey) return null;
    return {
        protocol: runtimeProfile.protocol,
        baseUrl: runtimeProfile.baseUrl,
        model: runtimeProfile.model,
        apiKey: runtimeProfile.apiKey,
        contextWindow: runtimeProfile.contextWindow,
        providerModels,
    };
}

async function applySavedProfileHotSwitch(mode, options = {}) {
    const { stateRoot, scriptsRoot, fixedHealthUrl } = options;
    const [runtimeProfile, fixedRoute] = await Promise.all([
        runUpstreamProfileScript("GetRuntime", {}, stateRoot, scriptsRoot),
        fixedRouteHealthSnapshot(fixedHealthUrl),
    ]);
    if (fixedRoute.ready !== true || !fixedRoute.adapterPort) {
        throw new Error("Anti-Codex fixed route is not ready for an in-place model switch.");
    }
    return hotSwitchCodexPlusPlusSettings({
        settingsPath: path.join(stateRoot, "codexplusplus", "settings.json"),
        mode,
        adapterPort: fixedRoute.adapterPort,
        antigravityModel: runtimeProfile.antigravityModel,
        antigravityModels: antigravityModelsFromCatalog(stateRoot).map((entry) => entry.id),
        thirdParty: savedThirdPartyForHotSwitch(runtimeProfile),
        nativeCatalogPath: path.join(stateRoot, "codex-home-deepseek-app", "anticodex-model-catalog.json"),
        nativeCatalogModels: nativeModelSlugsFromCatalog(stateRoot),
    });
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

async function ensureAntigravityDesktopReady(options = {}) {
    const { fixedRoute, scriptsRoot, stateRoot, adapterAuthToken } = options;
    if (fixedRoute?.ready !== true || !fixedRoute.adapterPort) {
        throw new Error("Anti-Codex 固定线路未就绪，不能切换到 Antigravity。");
    }
    let account = await fixedRouteAccountSnapshot(fixedRoute, {
        forceAntigravity: true,
        authToken: adapterAuthToken,
    });
    if (account.signedIn === true && account.identityAvailable === true) return account;

    const desktopHelper = managerScriptPath({ script: "antigravity-desktop.ps1" }, scriptsRoot);
    const command = [
        `$helper = ${psSingleQuoted(desktopHelper)}`,
        `. $helper`,
        "$desktop = Get-AntigravityMainProcess",
        "if (-not $desktop) {",
        "  $desktopPath = Resolve-AntigravityDesktopPath",
        "  if (-not $desktopPath) { throw 'Antigravity Desktop is not installed.' }",
        `  $desktop = Start-AntigravityDesktop -ExecutablePath $desktopPath -StateRoot ${psSingleQuoted(stateRoot)}`,
        "  $stable = Wait-AntigravityDesktopStable -ExecutablePath $desktopPath -TimeoutSeconds 30 -StableSeconds 3",
        "  if (-not $stable.Stable) { throw 'Antigravity Desktop did not become stable.' }",
        "}",
    ].join("\n");
    await execFileAsync(powershellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
        cwd: scriptsRoot,
        timeout: 45_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });

    const deadline = Date.now() + 30_000;
    do {
        account = await fixedRouteAccountSnapshot(fixedRoute, {
            forceAntigravity: true,
            authToken: adapterAuthToken,
        });
        if (account.signedIn === true && account.identityAvailable === true) return account;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    } while (Date.now() < deadline);
    throw new Error("Antigravity Desktop 已启动，但登录状态尚未就绪，模型没有切换。");
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
            suggestedAction: "可以保存并切换；这不会走 ChatGPT 登录，也不会清空聊天记录。",
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
async function diagnosticsPayload(stateRoot, fast, fixedHealthUrl, adapterAuthToken = "") {
    const fixedRoute = await fixedRouteHealthSnapshot(fixedHealthUrl);
    const account = await fixedRouteAccountSnapshot(fixedRoute, { authToken: adapterAuthToken });
    const fixedStatus = readJsonIfPresent(stateRoot ? path.join(stateRoot, "fixed-route-status.json") : "");
    const updateStatus = readJsonIfPresent(stateRoot ? path.join(stateRoot, "update-status.json") : "") || {
        ok: false,
        updateNeeded: null,
        reason: "not_checked",
        sync: { available: false },
    };
    const codexHome = process.env.CODEX_HOME_DIR || process.env.CODEX_HOME || (stateRoot ? path.join(stateRoot, "codex-home-deepseek-app") : "");
    const snapshotMarker = readJsonIfPresent(codexHome ? path.join(codexHome, ".anticodex-startup-snapshots-ready.json") : "");
    const snapshotTimestamp = Date.parse(String(snapshotMarker?.updatedAt || ""));
    const snapshotAgeMs = Number.isFinite(snapshotTimestamp) ? Math.max(0, Date.now() - snapshotTimestamp) : null;
    const sourcePreflight = latestManagerReportItem(stateRoot, "Source preflight", "latest-source-preflight.json");
    const syncReadiness = latestManagerReportItem(stateRoot, "Sync readiness", "latest-sync-readiness.json");
    const installedFull = latestManagerReportItem(stateRoot, "Installed overall", "latest-installed-overall.json");
    const installedFast = latestManagerReportItem(stateRoot, "Installed overall fast", "latest-installed-overall-fast.json", { deferred: true });
    const releaseGates = latestManagerReportItem(stateRoot, "Release gates", "latest-release-gates.json");
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
                state: snapshotMarker ? "fresh" : "missing",
                stale: false,
                ageHours: Number.isFinite(snapshotAgeMs) ? snapshotAgeMs / 3600000 : null,
                maxAgeHours: 24,
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

function managerActionButtonHtml(actionId, danger = false) {
  const action = MANAGER_ACTIONS[actionId];
  if (!action) throw new Error(`Unknown Manager page action: ${actionId}`);
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
  section { padding:20px 0; border-bottom:1px solid var(--border); }
  h2 { margin:0 0 12px; font-size:15px; }
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
  <section data-action-group="daily">
    <h2>日常操作</h2>
    <div class="grid">${DAILY_MANAGER_ACTION_IDS.map((id) => managerActionButtonHtml(id)).join("")}</div>
  </section>
  <section data-action-group="high-impact">
    <h2>高影响操作</h2>
    <div class="grid">${HIGH_IMPACT_MANAGER_ACTION_IDS.map((id) => managerActionButtonHtml(id, true)).join("")}</div>
  </section>
  <section>
    <h2>执行结果</h2>
    <pre id="actionResult" aria-live="polite">尚未执行操作。</pre>
  </section>
</main>
<script>
let managerActionToken = "";
const highImpactActions = new Set(${JSON.stringify(HIGH_IMPACT_MANAGER_ACTION_IDS)});
function confirmHighImpactAction(action, label) {
  return !highImpactActions.has(action) || window.confirm("确认执行“" + label + "”？此操作可能写入配置、消耗真实流量或重启 Anti-Codex。");
}
async function bootstrap() {
  const response = await fetch("/anticodex/manager/bootstrap", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.token) throw new Error(payload.message || payload.error || "无法取得管理令牌");
  managerActionToken = payload.token;
}
async function runManagerAction(button) {
  const action = button.dataset.managerAction;
  if (!confirmHighImpactAction(action, button.textContent.trim())) return;
  const result = document.getElementById("actionResult");
  const buttons = [...document.querySelectorAll("button[data-manager-action]")];
  buttons.forEach((item) => { item.disabled = true; });
  result.textContent = "正在执行：" + button.textContent.trim();
  try {
    if (!managerActionToken) await bootstrap();
    const response = await fetch("/anticodex/manager/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anticodex-manager-token": managerActionToken },
      body: JSON.stringify({ action })
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.message || payload.error || "操作失败");
    result.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    result.textContent = "执行失败：" + error.message;
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
}
document.querySelectorAll("button[data-manager-action]").forEach((button) => {
  button.addEventListener("click", () => { void runManagerAction(button); });
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
  let resolvedPort = listenPort;
  const stateRoot = options.stateRoot ? path.resolve(options.stateRoot) : (process.env.DEEPCODEX_STATE_ROOT || path.join(process.env.APPDATA || "", "anticodex"));
  const fixedHealthUrl = options.fixedHealthUrl || process.env.ANTICODEX_FIXED_ROUTE_HEALTH_URL || "http://127.0.0.1:18487/anticodex/fixed-route/health";
  const scriptsRoot = __dirname;
  const adapterAuthToken = String(options.adapterAuthToken || "");
  const refreshModels = options.refreshModels;
  const ensureAntigravityReady = options.ensureAntigravityReady
    ?? ((context) => ensureAntigravityDesktopReady(context));

  const server = http.createServer(async (req, res) => {
    if (!validateLoopbackAndTrusted(req, res)) {
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      return respondToPreflight(req, res);
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
        const payload = await runManagerBridgeAction(action, stateRoot, scriptsRoot, { refreshModels });
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
      try {
        const action = String(url.searchParams.get("action") || "");
        const payload = await runManagerBridgeAction(action, stateRoot, scriptsRoot, { refreshModels });
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
      try {
        const statusPath = path.join(stateRoot, "fixed-route-status.json");
        if (fs.existsSync(statusPath)) {
          const statusData = JSON.parse(fs.readFileSync(statusPath, "utf8"));
          if (statusData && statusData.ports && statusData.ports.proxy) {
            proxyPort = statusData.ports.proxy;
          }
        }
      } catch {}
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
        const stages = await testCodexPlusPlusUpstreamConnection(profile, { timeoutMs: Number(body.timeoutMs || 10000) });
        const ok = stages.length > 0 && stages.every((stage) => stage.status !== "fail");
        const sanitizedStages = sanitizedConnectionStages(stages);
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
      try {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw.toString("utf8") || "{}");
        if (body.mode === "antigravity") {
          const antigravityModel = String(body.antigravityModel || "").trim();
          const availableModels = antigravityModelsFromCatalog(stateRoot);
          if (antigravityModel && availableModels.length > 0
              && !availableModels.some((entry) => entry.id === antigravityModel)) {
            return jsonResponse(res, 400, { ok: false, message: "所选 Antigravity 模型不在当前模型目录中。" }, req);
          }
          const fixedRoute = await fixedRouteHealthSnapshot(fixedHealthUrl);
          const account = await ensureAntigravityReady({
            fixedRoute,
            scriptsRoot,
            stateRoot,
            adapterAuthToken,
          });
          const saved = await runUpstreamProfileScript("UseAntigravity", { antigravityModel }, stateRoot, scriptsRoot);
          const switched = await applySavedProfileHotSwitch("antigravity", {
            stateRoot,
            scriptsRoot,
            fixedHealthUrl,
          });
          return jsonResponse(res, 200, {
            ok: true,
            saved,
            accountReady: account?.signedIn === true && account?.identityAvailable === true,
            ...switched,
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
        const stages = await testCodexPlusPlusUpstreamConnection(profile, { timeoutMs: Number(body.timeoutMs || 10000) });
        const testStatus = stages.length && stages.every((stage) => stage.status !== "fail") ? "success" : "pending";
        if (testStatus !== "success") {
          return jsonResponse(res, 400, { ok: false, message: "请先完成“测试连通”，确认接口可用后再保存。" }, req);
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
          contextWindow: body.contextWindow,
          apiKey,
          testStatus,
          capabilitiesJson: JSON.stringify(capabilities),
        }, stateRoot, scriptsRoot);
        const switched = await applySavedProfileHotSwitch("third-party", {
          stateRoot,
          scriptsRoot,
          fixedHealthUrl,
        });
        return jsonResponse(res, 200, { ok: true, saved, ...switched }, req);
      } catch (error) {
        return jsonResponse(res, error.statusCode || 400, { ok: false, message: error.message }, req);
      }
    }

    if (req.method === "GET" && pathname === "/anticodex/diagnostics") {
      const fast = url.searchParams.get("fast") === "1";
      return jsonResponse(res, 200, await diagnosticsPayload(stateRoot, fast, fixedHealthUrl, adapterAuthToken), req);
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
