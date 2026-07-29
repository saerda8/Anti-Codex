#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { readNativeCodexRequestSnapshot } from "./lib/anticodex-native-request-activity.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const flagEnabled = (name) => args.has(name) && String(args.get(name) ?? "true").toLowerCase() !== "false";
const MANAGER_ACTION_GROUPS = Object.freeze({
  status: Object.freeze(["refreshStatus"]),
  modelSources: Object.freeze(["refreshModels", "accountSwitch", "upstreamConfig"]),
  updates: Object.freeze(["updateCheck", "syncHost"]),
  troubleshooting: Object.freeze(["repairShortcuts", "diagnosticsBundle", "viewLatestReports"]),
  advanced: Object.freeze([
    "accountProxy", "syncReadiness", "sourcePreflight", "mcpSkills",
    "pluginCapabilities", "refreshFeatures", "fastOverallNoTraffic",
    "overallNoTraffic", "stabilitySoak", "coldRelaunch", "postVerificationFull",
  ]),
});
const MANAGER_HIGH_IMPACT_ACTION_IDS = Object.freeze([
  "syncHost",
  "refreshFeatures",
  "stabilitySoak",
  "coldRelaunch",
  "fastOverallNoTraffic",
  "overallNoTraffic",
  "postVerificationFull",
]);
const MANAGER_HIGH_IMPACT_ACTION_SET = new Set(MANAGER_HIGH_IMPACT_ACTION_IDS);
const MANAGER_ALL_ACTION_IDS = Object.freeze(Object.values(MANAGER_ACTION_GROUPS).flat());
if (new Set(MANAGER_ALL_ACTION_IDS).size !== MANAGER_ALL_ACTION_IDS.length) {
  throw new Error("Manager action groups contain duplicate action IDs");
}
function managerActionLayoutFailures(layout) {
  const failures = [];
  const groups = layout?.groups || [];
  const buttons = layout?.buttons || [];
  const expectedGroupNames = Object.keys(MANAGER_ACTION_GROUPS);
  const unexpectedGroups = groups.filter((group) => !expectedGroupNames.includes(group.id)).map((group) => group.id);
  if (unexpectedGroups.length > 0) failures.push(`unexpected action groups: ${JSON.stringify(unexpectedGroups)}`);
  for (const groupName of expectedGroupNames) {
    const matches = groups.filter((group) => group.id === groupName);
    if (matches.length !== 1) failures.push(`${groupName} group count is ${matches.length}, expected 1`);
    else if (JSON.stringify(matches[0].actionIds) !== JSON.stringify(MANAGER_ACTION_GROUPS[groupName])) {
      failures.push(`${groupName} actions are incorrect: ${JSON.stringify(matches[0].actionIds)}`);
    }
  }
  const expectedGroupByAction = new Map(Object.entries(MANAGER_ACTION_GROUPS)
    .flatMap(([group, actionIds]) => actionIds.map((actionId) => [actionId, group])));
  for (const actionId of MANAGER_ALL_ACTION_IDS) {
    const matches = buttons.filter((button) => button.action === actionId);
    if (matches.length !== 1) failures.push(`${actionId} button count is ${matches.length}, expected 1`);
  }
  for (const button of buttons) {
    const expectedGroup = expectedGroupByAction.get(button.action);
    if (!expectedGroup) failures.push(`unexpected action button ${button.action}`);
    else if (!button.groupId) failures.push(`${button.action} is outside an action group`);
    else if (button.groupId !== expectedGroup) failures.push(`${button.action} is in ${button.groupId}, expected ${expectedGroup}`);
  }
  return failures;
}
const explicitPorts = args.get("--ports") || args.get("--port") || "";
const ports = explicitPorts
  ? String(explicitPorts).split(",").map((value) => Number(value.trim())).filter(Number.isFinite)
  : [...new Set([...discoverAntiCodexCdpPorts(), 18318, 58318, 58317])];
const baseUrl = String(args.get("--base-url") || process.env.ANTICODEX_MANAGER_API || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const simulatePendingReopen = args.has("--verify-pending-reopen");
const defaultAction = String(args.get("--action") || (simulatePendingReopen ? "refreshFeatures" : "updateCheck"));
const actions = String(args.get("--actions") || defaultAction).split(",").map((value) => value.trim()).filter(Boolean);
const action = actions[0] || defaultAction;
const verificationMode = String(args.get("--verification-mode") || "");
const uiOnlyMatrix = flagEnabled("--ui-only-matrix");
const uiOnlyBatchMode = uiOnlyMatrix || flagEnabled("--ui-only-batch");
const uiOnlyMode = verificationMode === "ui-only" || uiOnlyBatchMode;
const closeOnly = args.has("--close-only") && String(args.get("--close-only") ?? "true").toLowerCase() !== "false";
const profileEntryOnly = args.has("--profile-entry-only") && String(args.get("--profile-entry-only") ?? "true").toLowerCase() !== "false";
const upstreamConfigOnly = args.has("--upstream-config-only") && String(args.get("--upstream-config-only") ?? "true").toLowerCase() !== "false";
const defaultTimeoutMs = action === "fastOverallNoTraffic" ? 90000 : 15000;
const timeoutMs = Number(args.get("--timeout-ms") || defaultTimeoutMs);
const compact = args.has("--compact");
const evidenceReportRoot = path.resolve(args.get("--report-root")
  || path.join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const antiCodexHome = path.resolve(args.get("--codex-home")
  || process.env.ANTICODEX_CODEX_HOME
  || path.join(process.env.APPDATA || os.tmpdir(), "anticodex", "codex-home-deepseek-app"));
const managerBridgeLogPath = path.resolve(args.get("--manager-bridge-log")
  || path.join(process.env.APPDATA || os.tmpdir(), "anticodex", "fixed-route-logs", "manager-bridge.log"));
const fixedRouteHealthUrl = String(args.get("--fixed-route-health-url")
  || process.env.ANTICODEX_FIXED_ROUTE_HEALTH_URL
  || "http://127.0.0.1:18487/anticodex/fixed-route/health");
// Hidden or fully occluded Electron windows can take about five seconds to
// acknowledge a CDP mouse event even though the renderer remains responsive.
const CDP_INPUT_EVENT_TIMEOUT_MS = 12_000;
let managerInjectSource = readFileSync(new URL("./anticodex-manager-inject.js", import.meta.url), "utf8");
if (simulatePendingReopen) {
  managerInjectSource = managerInjectSource.replace("const ACTION_UI_TIMEOUT_MS = 5000;", "const ACTION_UI_TIMEOUT_MS = 120;");
}
if (uiOnlyMode) {
  managerInjectSource = managerInjectSource
    .replace("const ACCOUNT_SWITCH_POLL_INTERVAL_MS = 3000;", "const ACCOUNT_SWITCH_POLL_INTERVAL_MS = 25;")
    .replace("const ACCOUNT_SWITCH_TIMEOUT_MS = 120000;", "const ACCOUNT_SWITCH_TIMEOUT_MS = 150;");
}
if (uiOnlyMode && !uiOnlyBatchMode) {
  let accountSwitchCapturePatchCount = 0;
  managerInjectSource = managerInjectSource.replace(
    /  async function captureAccountSwitchState\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function accountSwitchChanged/,
    () => {
      accountSwitchCapturePatchCount += 1;
      return `  async function captureAccountSwitchState() {
    return {
      accountFingerprint: "ui-only-account-fingerprint",
      modelFingerprint: "ui-only-model-fingerprint",
    };
  }

  function accountSwitchChanged`;
    },
  );
  if (accountSwitchCapturePatchCount !== 1) {
    throw new Error("Manager verifier failed to isolate account-switch state capture");
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const managerButtonLockPath = path.join(os.tmpdir(), "anticodex-manager-button.lock");
let managerActionToken = "";
const MANAGER_BOOTSTRAP_MAX_ATTEMPTS = 5;

async function acquireManagerButtonLock() {
  const deadline = Date.now() + Math.max(10000, timeoutMs + 5000);
  do {
    try {
      const fd = openSync(managerButtonLockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() }));
      return { fd, path: managerButtonLockPath, released: false };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - statSync(managerButtonLockPath).mtimeMs;
        if (ageMs > 120000) unlinkSync(managerButtonLockPath);
      } catch {}
      await sleep(100);
    }
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for Manager button verifier lock: ${managerButtonLockPath}`);
}

function releaseManagerButtonLock(lock) {
  if (!lock || lock.released) return;
  lock.released = true;
  try { closeSync(lock.fd); } catch {}
  try { unlinkSync(lock.path); } catch {}
}

function asciiJson(value, spaces = 0) {
  return JSON.stringify(value, null, spaces).replace(/[^\x00-\x7F]/gu, (char) => {
    const code = char.codePointAt(0);
    if (code <= 0xFFFF) return `\\u${code.toString(16).padStart(4, "0")}`;
    const normalized = code - 0x10000;
    const high = 0xD800 + (normalized >> 10);
    const low = 0xDC00 + (normalized & 0x3FF);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
  });
}

function shortText(value, maxLength = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function compactManagerButtonRecord(record) {
  const result = record?.result || {};
  const actionActualMouse = result.actionActualMouse || result.initial?.actionActualMouse || result.initial?.actualMouse || null;
  return {
    ok: record?.ok === true,
    action: result.action,
    version: result.version,
    lastAction: result.lastAction,
    lastOk: result.lastOk,
    lastPending: result.lastPending,
    pendingCount: result.pendingCount,
    queueLength: result.queueLength,
    disabled: result.disabled,
    lastUiOnly: result.lastUiOnly,
    actionCenterHitsButton: result.actionCenterHitsButton ?? result.initial?.actionCenterHitsButton,
    actionActualMouseOk: actionActualMouse?.ok,
    actionActualMouseRequiredConfirmation: actionActualMouse?.requiredConfirmation,
    actionActualMouseExpectedClickCount: actionActualMouse?.expectedClickCount,
    actionActualMouseClickCount: actionActualMouse?.clickCount,
    actionActualMouseConfirmationArmed: actionActualMouse?.confirmationArmed,
    actionActualMouseConfirmationCleared: actionActualMouse?.confirmationCleared,
    actionActualMouseInputEventCount: actionActualMouse?.inputEventCount,
    actionActualMouseError: actionActualMouse?.error || null,
    actionActualMousePoints: Array.isArray(actionActualMouse?.points)
      ? actionActualMouse.points.map((point) => ({
        phase: point.phase,
        x: point.x,
        y: point.y,
        label: point.label,
        hitAction: point.hitAction,
      }))
      : [],
    closeHitAreaOk: result.closeHitAreaOk ?? result.initial?.closeHitAreaOk,
    closeActualMouseOk: result.closeActualMouseOk ?? result.initial?.closeActualMouseOk,
    managerOpenedNewPage: record?.managerOpenedNewPage,
    text: shortText(result.text),
    lastSummary: shortText(result.lastSummary),
    error: result.error || result.initial?.error || actionActualMouse?.error || null,
  };
}

function compactManagerButtonOutput(output) {
  if (!compact) return output;
  if (output?.results && typeof output.results === "object") {
    const results = {};
    for (const [name, record] of Object.entries(output.results)) {
      results[name] = compactManagerButtonRecord(record);
    }
    return {
      ok: output.ok,
      mode: output.mode,
      port: output.port,
      target: output.target ? { id: output.target.id, title: output.target.title, url: output.target.url } : null,
      actions: output.actions,
      actionGroups: output.actionGroups,
      actionLayout: output.actionLayout,
      actionLayoutFailures: output.actionLayoutFailures,
      zeroSideEffects: output.zeroSideEffects,
      usedRealTraffic: output.usedRealTraffic,
      isolationEvidence: output.isolationEvidence,
      results,
      durationMs: output.durationMs,
    };
  }
  return {
    ok: output?.ok,
    port: output?.port,
    target: output?.target ? { id: output.target.id, title: output.target.title, url: output.target.url } : null,
    result: compactManagerButtonRecord(output),
    managerOpenedNewPage: output?.managerOpenedNewPage,
    pageTargetCountBeforeManagerOpen: output?.pageTargetCountBeforeManagerOpen,
    pageTargetCountAfterManagerOpen: output?.pageTargetCountAfterManagerOpen,
  };
}

const RUNNING_TEXT = "\u6b63\u5728\u8fd0\u884c";
const FAILURE_TEXT = "\u8fd0\u884c\u5931\u8d25";
const REFRESHED_TEXT = "\u72b6\u6001\u5df2\u5237\u65b0";
const READ_FAILED_TEXT = "\u8bfb\u53d6\u5931\u8d25";
const FINISHED_HINTS = [
  "Codex",
  "MCP",
  "Skill",
  "\u5df2\u63d0\u4ea4",
  "\u5df2\u751f\u6210",
  "\u5df2\u662f\u6700\u65b0",
  "\u53d1\u73b0\u65b0\u7248",
  "\u901a\u8fc7",
  "\u5b8c\u6210",
  "\u8fd8\u6ca1\u6709",
  "\u9700\u8981\u5904\u7406",
  "\u9700\u8981\u91cd\u8f7d",
];

function isRunningText(text) {
  return text.includes(RUNNING_TEXT) || text.includes("\u4ecd\u5728\u8fd0\u884c") || text.includes("\u6536\u5c3e");
}

function isFailureText(text) {
  return text.includes(FAILURE_TEXT) || text.includes("\u9700\u8981\u5904\u7406") || /timed out|bridge failed|Action bridge failed/i.test(text);
}

function isActionFailureText(actionName, text) {
  if (actionName === "viewLatestReports") {
    return text.includes(FAILURE_TEXT) || /timed out|bridge failed|Action bridge failed/i.test(text);
  }
  return isFailureText(text);
}

function isUiOnlySmokeText(text) {
  const value = String(text || "");
  return value.includes("ui-only manager button smoke") || value.includes("ui-only-manager-button");
}

function isFinishedText(text) {
  return Boolean(text)
    && !text.includes(REFRESHED_TEXT)
    && !text.includes(READ_FAILED_TEXT)
    && !text.includes("\u4ecd\u5728\u8fd0\u884c")
    && !text.includes("\u6536\u5c3e")
    && FINISHED_HINTS.some((hint) => text.includes(hint));
}

function writeTextAtomic(targetPath, text) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, text, "utf8");
  renameSync(temporaryPath, targetPath);
}

function writeSignedJsonReport(reportName, payload) {
  const checkedAt = new Date().toISOString();
  const stamp = checkedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const latest = path.resolve(evidenceReportRoot, `latest-${reportName}.json`);
  const history = path.resolve(evidenceReportRoot, `${stamp}-${reportName}-${crypto.randomBytes(4).toString("hex")}.json`);
  const stamped = {
    ...payload,
    generatedAt: checkedAt,
    checkedAt,
    report: { latest, history },
  };
  const body = `${JSON.stringify(stamped, null, 2)}\n`;
  const sidecar = `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
  for (const reportPath of [history, latest]) {
    writeTextAtomic(reportPath, body);
    writeTextAtomic(`${reportPath}.sha256`, sidecar);
  }
  return stamped;
}

function emitEvidenceReport(reportName, payload) {
  const stamped = writeSignedJsonReport(reportName, payload);
  console.log(asciiJson(stamped, compact ? 0 : 2));
  return stamped;
}

async function nativeRequestSnapshotSafe() {
  try {
    const snapshot = await readNativeCodexRequestSnapshot({ codexHome: antiCodexHome });
    return {
      available: snapshot.databasePresent === true,
      databasePresent: snapshot.databasePresent === true,
      requestCount: Number(snapshot.requestCount || 0),
      latestRequestRowId: Number(snapshot.latestRequestRowId || 0),
      latestRowId: Number(snapshot.latestRowId || 0),
    };
  } catch (error) {
    return { available: false, error: error?.message || String(error) };
  }
}

function managerBridgeLogCounts(source) {
  const text = String(source ?? "");
  const requests = [...text.matchAll(/"event":"manager-request-received"(?=[^\r\n]*"path":"(?<path>[^"]*)")/g)];
  return {
    actionReceivedCount: (text.match(/"event":"manager-action-received"/g) || []).length,
    requestReceivedCount: requests.length,
    nonHealthRequestReceivedCount: requests.filter((match) => match.groups.path !== "/health").length,
  };
}

function managerBridgeLogSnapshot() {
  if (!existsSync(managerBridgeLogPath)) return { available: false, path: managerBridgeLogPath };
  try {
    const source = readFileSync(managerBridgeLogPath, "utf8");
    return {
      available: true,
      path: managerBridgeLogPath,
      byteLength: Buffer.byteLength(source),
      ...managerBridgeLogCounts(source),
    };
  } catch (error) {
    return { available: false, path: managerBridgeLogPath, error: error?.message || String(error) };
  }
}

function nonNegativeDelta(after, before, key) {
  const next = Number(after?.[key]);
  const previous = Number(before?.[key]);
  if (!Number.isFinite(next) || !Number.isFinite(previous)) return null;
  return Math.max(0, next - previous);
}

function isUiOnlyActionFinished(actionName, state) {
  const text = String(state?.text || state?.lastSummary || "");
  const settled = state?.disabled !== true
    && Number(state?.pendingCount || 0) === 0
    && Number(state?.queueLength || 0) === 0
    && !isRunningText(text)
    && !isActionFailureText(actionName, text);
  if (!settled) return false;
  if (actionName === "accountSwitch") {
    return text.includes("\u672a\u68c0\u6d4b\u5230\u53ef\u8bc1\u660e\u7684\u8d26\u53f7\u6216\u6a21\u578b\u53d8\u5316");
  }
  return Boolean(text)
    && state?.lastAction === actionName
    && state?.lastOk !== false
    && state?.lastUiOnly === true;
}

function hasLatestReportFieldEvidence(text) {
  const value = String(text || "");
  if (!value.includes("\u6e90\u7801\u9884\u68c0")) return true;
  return value.includes("\u516c\u5f00\u6587\u6863\uff1a\u901a\u8fc7")
    || value.includes("\u516c\u5f00\u6587\u6863\uff1a\u9700\u5904\u7406")
    || (value.includes("\u5386\u53f2\u8fc7\u671f\u6062\u590d\uff1a\u901a\u8fc7") && value.includes("latest-missing-history.json"));
}

function discoverAntiCodexCdpPorts() {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessName -eq 'Anti-Codex.exe' -and $_.CommandLine -match '--remote-debugging-port=' } | ForEach-Object { $_.CommandLine }",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    const discovered = [];
    for (const match of output.matchAll(/--remote-debugging-port=(\d+)/g)) {
      const port = Number(match[1]);
      if (Number.isFinite(port) && port > 0) discovered.push(port);
    }
    return discovered;
  } catch {
    return [];
  }
}

function hasActionSpecificResult(actionName, text) {
  if (actionName === "fastOverallNoTraffic") return text.includes("\u5feb\u901f\u68c0\u67e5") && text.includes("\u8017\u65f6");
  if (actionName === "syncReadiness") return text.includes("\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5") && text.includes("\u901a\u8fc7");
  if (actionName === "updateCheck") return text.includes("\u66f4\u65b0\u68c0\u67e5")
    && text.includes("CodexPlusPlus")
    && (text.includes("\u65e0\u9700\u540c\u6b65") || text.includes("\u9700\u8981\u540c\u6b65") || text.includes("\u68c0\u67e5\u4e0d\u53ef\u7528"));
  if (actionName === "sourcePreflight") return text.includes("\u6e90\u7801\u9884\u68c0") && text.includes("\u8017\u65f6");
  if (actionName === "pluginCapabilities") return text.includes("\u6e05\u5355\u53ef\u89c1") && text.includes("\u53ef\u8c03\u7528\u9a8c\u8bc1");
  if (actionName === "mcpSkills") return text.includes("MCP/Skill") && text.includes("\u6e05\u5355\u53ef\u89c1") && text.includes("\u771f\u5b9e\u5de5\u5177\u8c03\u7528");
  if (actionName === "refreshFeatures") return text.includes("\u672c\u5730\u529f\u80fd\u5237\u65b0") && text.includes("\u53ef\u8c03\u7528\u9a8c\u8bc1") && text.includes("sourceSnapshot: files=");
  if (actionName === "diagnosticsBundle") return text.includes("\u8bca\u65ad\u5305") && (text.includes("ZIP") || text.includes("\u76ee\u5f55"));
  if (actionName === "viewLatestReports") return text.includes("\u62a5\u544a") && (text.includes("\u5df2\u627e\u5230") || text.includes("\u8fd8\u6ca1\u6709")) && hasLatestReportFieldEvidence(text);
  return true;
}

function uiOnlyPayloadForAction(actionName) {
  const payloadByAction = {
    sourcePreflight: {
      ok: true,
      action: actionName,
      uiOnly: true,
      result: { ok: true, elapsedMs: 1, reportName: "ui-only-manager-button" },
    },
    mcpSkills: {
      ok: true,
      action: actionName,
      uiOnly: true,
      result: {
        ok: true,
        mcp: { count: 1, smoke: { realCall: { passed: true } } },
        skills: { count: 1, smoke: { readable: true } },
      },
    },
    pluginCapabilities: {
      ok: true,
      action: actionName,
      uiOnly: true,
      result: {
        ok: true,
        capabilities: {
          installedPluginCount: 0,
          connectorCount: 0,
          appToolCount: 0,
          smoke: {
            endpointProjectionReadable: true,
            connectorCache: { sampleReadable: true },
          },
          appToolsNote: "ui-only manager button smoke",
        },
      },
    },
    refreshFeatures: {
      ok: true,
      action: actionName,
      uiOnly: true,
      result: {
        ok: true,
        skills: { count: 3 },
        connectors: { count: 2 },
        sourceSnapshot: { fingerprint: "abcdef0123456789", fileCount: 42 },
      },
    },
    updateCheck: {
      ok: true,
      action: actionName,
      uiOnly: true,
      result: {
        ok: true,
        updateNeeded: false,
        source: { packageVersion: "26.ui-only" },
        active: { packageVersion: "26.ui-only" },
        components: { sourceVersion: "1.2.ui-only", activeVersion: "1.2.ui-only", remoteState: "current", remoteTag: "v1.2.ui-only" },
      },
    },
  };
  return payloadByAction[actionName] || { ok: true, action: actionName, uiOnly: true, result: { ok: true } };
}

function uiOnlyPayloadMap() {
  return Object.fromEntries(MANAGER_ALL_ACTION_IDS.map((actionName) => [actionName, uiOnlyPayloadForAction(actionName)]));
}

function uiOnlyBridgeSource(actionName, enabled = uiOnlyMode) {
  if (!enabled) return "";
  const payload = uiOnlyPayloadForAction(actionName);
  return `
  if (window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__?.active === true) {
    // The batch-scoped action and request shims were installed before Manager opened.
  } else {
  clearInterval(window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_RESTORE_TIMER__);
  delete window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_RESTORE_TIMER__;
  if (!window.__ANTICODEX_RUN_MANAGER_ACTION__?.__ANTICODEX_MANAGER_BUTTON_UI_ONLY__) {
    window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__ = window.__ANTICODEX_RUN_MANAGER_ACTION__;
  }
  window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_CALLS__ ||= [];
  window.__ANTICODEX_RUN_MANAGER_ACTION__ = (requestedAction) => {
    window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_CALLS__.push({ action: requestedAction, at: Date.now() });
    return Promise.resolve({
      ...${JSON.stringify(payload)},
      action: requestedAction,
    });
  };
  window.__ANTICODEX_RUN_MANAGER_ACTION__.__ANTICODEX_MANAGER_BUTTON_UI_ONLY__ = true;
  }
`;
}

function uiOnlyBatchBridgeSource(enabled = uiOnlyBatchMode) {
  if (!enabled) return "";
  const payloads = uiOnlyPayloadMap();
  return `
(() => {
  if (window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__?.active === true) return;
  const snapshotResponses = window.__ANTICODEX_MANAGER_SNAPSHOT__?.responses || {};
  const fallbackResponses = {
    "/anticodex/manager/bootstrap": { ok: true, token: "ui-only-manager-token" },
    "/health": { ok: true, upstream: "ui-only", accountReady: true, accountState: "ready" },
    "/models": { object: "list", data: [] },
    "/anticodex/account": { ok: true, identityAvailable: false, fingerprint: "" },
    "/anticodex/diagnostics": { ok: true, localFeatures: { mcp: { count: 1 }, skills: { count: 1 } } },
    "/backend-api/ps/plugins/installed": { plugins: [] },
    "/backend-api/aip/connectors": { connectors: [] },
    "/backend-api/plugins/list": { plugins: [] },
    "/backend-api/wham/apps": { tools: [] },
    "/anticodex/local-connectors/allowlist": { persisted: [], env: [], counts: {} },
    "/anticodex/upstream-profile": { active: "third-party", runtime: { protocol: "openai-compatible", model: "ui-only-model" } },
    "/anticodex/model-routes": { latest: null },
  };
  const state = {
    active: true,
    originalActionBridge: window.__ANTICODEX_RUN_MANAGER_ACTION__,
    originalRequestBridge: window.__ANTICODEX_RUN_MANAGER_REQUEST__,
    originalBridgeReady: window.__ANTICODEX_MANAGER_BRIDGE_READY__,
    baselineQueueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : 0,
    baselinePromiseCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
    actionCalls: [],
    requestCalls: [],
  };
  const payloads = ${JSON.stringify(payloads)};
  const actionShim = (requestedAction) => {
    state.actionCalls.push({ action: requestedAction, at: Date.now() });
    const payload = payloads[requestedAction] || { ok: true, action: requestedAction, uiOnly: true, result: { ok: true } };
    return Promise.resolve({ ...payload, action: requestedAction, uiOnly: true });
  };
  actionShim.__ANTICODEX_MANAGER_BUTTON_UI_ONLY__ = true;
  actionShim.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH__ = true;
  const requestShim = (requestedPath, options = {}) => {
    state.requestCalls.push({ path: requestedPath, method: String(options.method || "GET").toUpperCase(), at: Date.now() });
    const value = Object.prototype.hasOwnProperty.call(snapshotResponses, requestedPath)
      ? snapshotResponses[requestedPath]
      : (fallbackResponses[requestedPath] ?? {});
    return Promise.resolve({ kind: "manager-request", path: requestedPath, ok: true, value });
  };
  requestShim.__ANTICODEX_MANAGER_BUTTON_UI_ONLY__ = true;
  requestShim.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH__ = true;
  window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__ = state;
  window.__ANTICODEX_RUN_MANAGER_ACTION__ = actionShim;
  window.__ANTICODEX_RUN_MANAGER_REQUEST__ = requestShim;
  window.__ANTICODEX_MANAGER_BRIDGE_READY__ = true;
})()
`;
}

function uiOnlyBatchEvidenceSource() {
  return `(() => {
    const state = window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__;
    if (!state) return window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_LAST_EVIDENCE__ || { installed: false };
    return {
      installed: true,
      active: state.active === true,
      actionCalls: [...state.actionCalls],
      requestCalls: [...state.requestCalls],
      baselineQueueLength: state.baselineQueueLength,
      currentQueueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : 0,
      baselinePromiseCount: state.baselinePromiseCount,
      currentPromiseCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
      actionShimActive: window.__ANTICODEX_RUN_MANAGER_ACTION__?.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH__ === true,
      requestShimActive: window.__ANTICODEX_RUN_MANAGER_REQUEST__?.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH__ === true,
    };
  })()`;
}

function cleanupUiOnlyBatchBridgeSource(enabled = uiOnlyBatchMode) {
  if (!enabled) return "";
  return `
(() => {
  const state = window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__;
  if (!state) return window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_LAST_EVIDENCE__ || { restored: false, missing: true };
  const evidence = {
    installed: true,
    actionCalls: [...state.actionCalls],
    requestCalls: [...state.requestCalls],
    baselineQueueLength: state.baselineQueueLength,
    currentQueueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : 0,
    baselinePromiseCount: state.baselinePromiseCount,
    currentPromiseCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
  };
  window.__ANTICODEX_RUN_MANAGER_ACTION__ = state.originalActionBridge;
  window.__ANTICODEX_RUN_MANAGER_REQUEST__ = state.originalRequestBridge;
  window.__ANTICODEX_MANAGER_BRIDGE_READY__ = state.originalBridgeReady;
  state.active = false;
  evidence.actionBridgeRestored = window.__ANTICODEX_RUN_MANAGER_ACTION__ === state.originalActionBridge;
  evidence.requestBridgeRestored = window.__ANTICODEX_RUN_MANAGER_REQUEST__ === state.originalRequestBridge;
  evidence.bridgeReadyRestored = window.__ANTICODEX_MANAGER_BRIDGE_READY__ === state.originalBridgeReady;
  evidence.restored = evidence.actionBridgeRestored && evidence.requestBridgeRestored && evidence.bridgeReadyRestored;
  window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_LAST_EVIDENCE__ = evidence;
  delete window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__;
  return evidence;
})()
`;
}

function realBridgeSource(enabled = !uiOnlyMode) {
  if (!enabled) return "";
  const restoreDelayMs = Math.max(120000, timeoutMs + 60000);
  return `
  if (window.__ANTICODEX_RUN_MANAGER_ACTION__?.__ANTICODEX_MANAGER_BUTTON_UI_ONLY__
      && window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__) {
    window.__ANTICODEX_RUN_MANAGER_ACTION__ = window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__;
  }
  delete window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__;
  if (!Object.prototype.hasOwnProperty.call(window, "__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__")) {
    window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__ = window.__ANTICODEX_RUN_MANAGER_ACTION__;
  }
  if (!Object.prototype.hasOwnProperty.call(window, "__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__")) {
    window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__ = window.__ANTICODEX_MANAGER_BRIDGE_READY__;
  }
  clearTimeout(window.__ANTICODEX_MANAGER_BUTTON_BRIDGE_RESTORE_TIMER__);
  window.__ANTICODEX_RESTORE_MANAGER_BUTTON_ACTION_BRIDGE__ = () => {
    const pending = window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__ || {};
    for (const entry of Object.values(pending)) {
      try {
        entry?.resolve?.({
          ok: false,
          action: entry?.action || "",
          message: "Manager verifier restored the live action bridge before the test action completed",
        });
      } catch {}
    }
    if (Object.prototype.hasOwnProperty.call(window, "__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__")) {
      window.__ANTICODEX_RUN_MANAGER_ACTION__ = window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__;
      if (typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ !== "function") {
        delete window.__ANTICODEX_RUN_MANAGER_ACTION__;
      }
    }
    if (Object.prototype.hasOwnProperty.call(window, "__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__")) {
      window.__ANTICODEX_MANAGER_BRIDGE_READY__ = window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__;
      if (typeof window.__ANTICODEX_MANAGER_BRIDGE_READY__ !== "boolean") {
        delete window.__ANTICODEX_MANAGER_BRIDGE_READY__;
      }
    }
    clearTimeout(window.__ANTICODEX_MANAGER_BUTTON_BRIDGE_RESTORE_TIMER__);
    delete window.__ANTICODEX_MANAGER_BUTTON_BRIDGE_RESTORE_TIMER__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__;
    delete window.__ANTICODEX_RESOLVE_MANAGER_BUTTON_ACTION__;
    delete window.__ANTICODEX_RESTORE_MANAGER_BUTTON_ACTION_BRIDGE__;
  };
  window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__ = {};
  window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__ = [];
  window.__ANTICODEX_RESOLVE_MANAGER_BUTTON_ACTION__ = (id, payload) => {
    const entry = window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__?.[id];
    if (!entry) return;
    delete window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__[id];
    entry.resolve(payload);
  };
  const testActionBridge = (requestedAction) => new Promise((resolve) => {
    const requestId = Date.now() + ":" + Math.random().toString(36).slice(2);
    window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__[requestId] = { resolve, action: requestedAction };
    window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__.push({ id: requestId, action: requestedAction });
  });
  testActionBridge.__ANTICODEX_MANAGER_BUTTON_TEST_BRIDGE__ = true;
  window.__ANTICODEX_RUN_MANAGER_ACTION__ = testActionBridge;
  window.__ANTICODEX_MANAGER_BRIDGE_READY__ = true;
  window.__ANTICODEX_MANAGER_BUTTON_BRIDGE_RESTORE_TIMER__ = setTimeout(() => {
    window.__ANTICODEX_RESTORE_MANAGER_BUTTON_ACTION_BRIDGE__?.();
  }, ${restoreDelayMs});
`;
}

function cleanupRealBridgeSource(enabled = true) {
  if (!enabled) return "";
  return `
  clearTimeout(window.__ANTICODEX_MANAGER_BUTTON_BRIDGE_RESTORE_TIMER__);
  if (typeof window.__ANTICODEX_RESTORE_MANAGER_BUTTON_ACTION_BRIDGE__ === "function") {
    window.__ANTICODEX_RESTORE_MANAGER_BUTTON_ACTION_BRIDGE__();
  } else {
    const verifierStatePresent = window.__ANTICODEX_RUN_MANAGER_ACTION__?.__ANTICODEX_MANAGER_BUTTON_TEST_BRIDGE__ === true
      || Array.isArray(window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__)
      || typeof window.__ANTICODEX_RESOLVE_MANAGER_BUTTON_ACTION__ === "function";
    if (Object.prototype.hasOwnProperty.call(window, "__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__")) {
      window.__ANTICODEX_RUN_MANAGER_ACTION__ = window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__;
      if (typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ !== "function") {
        delete window.__ANTICODEX_RUN_MANAGER_ACTION__;
      }
    } else if (verifierStatePresent) {
      delete window.__ANTICODEX_RUN_MANAGER_ACTION__;
      window.__ANTICODEX_MANAGER_BRIDGE_READY__ = false;
    }
    if (Object.prototype.hasOwnProperty.call(window, "__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__")) {
      window.__ANTICODEX_MANAGER_BRIDGE_READY__ = window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__;
      if (typeof window.__ANTICODEX_MANAGER_BRIDGE_READY__ !== "boolean") {
        delete window.__ANTICODEX_MANAGER_BRIDGE_READY__;
      }
    }
    delete window.__ANTICODEX_MANAGER_BUTTON_BRIDGE_RESTORE_TIMER__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_BRIDGE_READY__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__;
    delete window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__;
    delete window.__ANTICODEX_RESOLVE_MANAGER_BUTTON_ACTION__;
    delete window.__ANTICODEX_RESTORE_MANAGER_BUTTON_ACTION_BRIDGE__;
  }
`;
}

function cleanupUiOnlyBridgeSource(enabled = uiOnlyMode, actionName = action) {
  if (!enabled) return "";
  return `
  if (window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__?.active === true) {
    // Batch cleanup owns bridge restoration after every action and request is observed.
  } else {
  const uiOnlyActionName = ${JSON.stringify(actionName)};
  function restoreUiOnlyBridge() {
    clearInterval(window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_RESTORE_TIMER__);
    delete window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_RESTORE_TIMER__;
    if (window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__) {
      window.__ANTICODEX_RUN_MANAGER_ACTION__ = window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__;
      delete window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__;
    }
    const lastActionResult = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    const lastSummary = String(lastActionResult?.managerSummary || "");
    if (lastActionResult?.uiOnly === true || lastSummary.includes("ui-only manager button smoke")) {
      delete window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
      const result = document.querySelector('[data-anticodex-result="action"]');
      if (result && result.textContent.includes("ui-only manager button smoke")) result.textContent = "";
    }
    delete window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_CALLS__;
  }
  function managerActionStillActive() {
    const overlay = document.querySelector("#anticodex-manager-overlay");
    const calls = window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_CALLS__ || [];
    const actionReachedSafeBridge = calls.some((entry) => entry?.action === uiOnlyActionName);
    if (!overlay) return !actionReachedSafeBridge;
    const busy = overlay.querySelector('.anticodex-actions')?.getAttribute('data-anticodex-busy') === 'true';
    const disabled = Boolean(overlay.querySelector('button[data-action]:disabled'));
    const running = Boolean(overlay.querySelector('[data-anticodex-result="action"][data-anticodex-running]'));
    return busy || disabled || running;
  }
  if (managerActionStillActive()) {
    clearInterval(window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_RESTORE_TIMER__);
    window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_RESTORE_TIMER__ = setInterval(() => {
      if (!managerActionStillActive()) restoreUiOnlyBridge();
    }, 50);
  } else {
    restoreUiOnlyBridge();
  }
  }
`;
}

function managerSummaryFromActionPayload(actionName, payload) {
  const result = payload?.result || payload || {};
  const unwrapped = result?.result && typeof result.result === "object" ? result.result : result;
  if (actionName === "refreshStatus") return `\u5237\u65b0\u72b6\u6001\uff1a${result.ok === false ? "\u9700\u8981\u5904\u7406" : "\u5b8c\u6210"}`;
  if (actionName === "updateCheck") {
    const remoteState = unwrapped.components?.remoteState || "not_checked";
    const remoteTag = unwrapped.components?.remoteTag || "\u672a\u77e5";
    const remoteLine = remoteState === "current"
      ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u9879\u76ee\u5df2\u8ddf\u8fdb\uff09`
      : remoteState === "newer_available"
        ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u5f85\u9002\u914d\u9a8c\u8bc1\uff09`
        : remoteState === "project_ahead"
          ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u9879\u76ee\u7248\u672c\u9886\u5148\uff09`
          : remoteState === "failed" ? "\u8fdc\u7aef\u4e0a\u6e38\uff1a\u68c0\u67e5\u5931\u8d25" : "\u8fdc\u7aef\u4e0a\u6e38\uff1a\u672a\u68c0\u67e5";
    return [
      `\u66f4\u65b0\u68c0\u67e5\uff1a${unwrapped.ok !== true ? "\u68c0\u67e5\u4e0d\u53ef\u7528" : (unwrapped.updateNeeded ? "\u9700\u8981\u540c\u6b65" : "\u65e0\u9700\u540c\u6b65")}`,
      `Codex\uff1a\u672c\u673a\u5b98\u65b9 ${unwrapped.source?.packageVersion || "\u672a\u68c0\u67e5"} / Anti-Codex ${unwrapped.active?.packageVersion || "\u672a\u5b89\u88c5"}`,
      `CodexPlusPlus\uff1a\u9879\u76ee\u56fa\u5b9a ${unwrapped.components?.sourceVersion || "\u672a\u68c0\u67e5"} / \u5df2\u5b89\u88c5 ${unwrapped.components?.activeVersion || "\u672a\u5b89\u88c5"}`,
      remoteLine,
    ].join("\n");
  }
  if (actionName === "mcpSkills") {
    const realCallPassed = result.mcp?.smoke?.realCall?.passed === true
      || result.mcp?.realCallPassed === true
      || result.mcp?.realCall?.passed === true;
    return [
      `MCP/Skill \u6e05\u5355\u53ef\u89c1\uff1a${result.ok === false ? "\u9700\u8981\u5904\u7406" : "\u901a\u8fc7"}`,
      `MCP ${result.mcp?.count ?? "\u672a\u77e5"} / Skill ${result.skills?.count ?? "\u672a\u77e5"}`,
      `\u771f\u5b9e\u5de5\u5177\u8c03\u7528\uff1a${realCallPassed ? "node_repl \u901a\u8fc7" : "\u5f85\u590d\u6838"}`,
    ].join("\n");
  }
  if (actionName === "pluginCapabilities") {
    const capabilities = result.capabilities || {};
    const note = capabilities.appToolsNote ? `\n\u8bf4\u660e\uff1a${capabilities.appToolsNote}` : "";
    return [
      `\u63d2\u4ef6/\u5e94\u7528\u6e05\u5355\u53ef\u89c1\uff1a${result.ok === false ? "\u9700\u8981\u5904\u7406" : "\u901a\u8fc7"}`,
      `\u5df2\u5b89\u88c5\u63d2\u4ef6 ${capabilities.installedPluginCount ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668 ${capabilities.connectorCount ?? "\u672a\u77e5"}`,
      `\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a${capabilities.callableState || "checked"}`,
    ].join("\n") + note;
  }
  if (actionName === "diagnosticsBundle") {
    const unwrapped = result?.result && typeof result.result === "object" ? result.result : result;
    return [
      `\u8bca\u65ad\u5305\uff1a${(unwrapped.ok ?? payload?.ok) === false ? "\u5931\u8d25" : "\u5df2\u751f\u6210"}`,
      unwrapped.zipPath ? `ZIP\uff1a${unwrapped.zipPath}` : "",
      unwrapped.bundleRoot ? `\u76ee\u5f55\uff1a${unwrapped.bundleRoot}` : "",
      (!unwrapped.zipPath && !unwrapped.bundleRoot && payload?.ok !== false) ? "\u76ee\u5f55\uff1a\u672a\u8fd4\u56de" : "",
    ].filter(Boolean).join("\n");
  }
  if (actionName === "viewLatestReports") {
    const reports = Array.isArray(result.reports) ? result.reports : [];
    const activeReports = reports.filter((item) => item?.deferred !== true);
    const deferredReports = reports.filter((item) => item?.deferred === true);
    const activeStaleCount = activeReports.filter((item) => item.exists && item.stale).length;
    const activeMissingCount = activeReports.filter((item) => !item.exists).length;
    const lines = reports.length ? [
      `\u62a5\u544a\u76ee\u5f55\uff1a${result.reportRoot || "\u672a\u77e5"}`,
      `\u5df2\u627e\u5230\uff1a${result.existingCount ?? reports.filter((item) => item.exists).length} \u4efd`,
    ] : ["\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u9a8c\u6536\u62a5\u544a\u3002"];
    if (activeStaleCount) lines.push(`\u9700\u91cd\u8dd1\uff1a${activeStaleCount} \u4efd\u62a5\u544a\u5df2\u8fc7\u671f`);
    if (activeMissingCount) lines.push(`\u672a\u751f\u6210\uff1a${activeMissingCount} \u4efd`);
    if (deferredReports.length) lines.push(`\u5df2\u5ef6\u671f/\u53ef\u9009\uff1a${deferredReports.length} \u4efd`);
    for (const item of reports.slice(0, 80)) {
      const passed = item.effectiveOk !== null && item.effectiveOk !== undefined ? item.effectiveOk : item.ok;
      const status = item.exists
        ? ((item.parseable === false || item.invalid) ? "\u62a5\u544a\u635f\u574f" : (item.deferred === true && (item.stale || !passed) ? "\u5df2\u5ef6\u671f" : (item.stale ? "\u9700\u91cd\u8dd1" : (passed ? "\u901a\u8fc7" : "\u9700\u5904\u7406"))))
        : (item.deferred === true ? "\u5df2\u5ef6\u671f" : "\u672a\u751f\u6210");
      lines.push(`${item.label}\uff1a${status}`);
      if (item.publicDocumentationOk !== null && item.publicDocumentationOk !== undefined) {
        lines.push(`  \u516c\u5f00\u6587\u6863\uff1a${item.publicDocumentationOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
      }
      if (item.sourcePreflightEvidence?.publicDocumentationOk !== undefined) {
        lines.push(`  \u516c\u5f00\u6587\u6863\uff1a${item.sourcePreflightEvidence.publicDocumentationOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
      }
      if (item.missingHistoryEvidence) {
        lines.push(`  \u5386\u53f2\u8fc7\u671f\u6062\u590d\uff1a${item.missingHistoryEvidence.status === 410 ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
        lines.push("  \u6587\u4ef6\uff1alatest-missing-history.json");
      }
      if (item.modelRoutingEvidence) {
        const evidence = item.modelRoutingEvidence;
        if ((Array.isArray(evidence.requestAvailableModels) && evidence.requestAvailableModels.length)
          || (Array.isArray(evidence.availabilityUnavailableModels) && evidence.availabilityUnavailableModels.length)
          || Number(evidence.availabilityUnavailableCount) > 0) {
          const available = Array.isArray(evidence.requestAvailableModels) && evidence.requestAvailableModels.length ? evidence.requestAvailableModels.join(", ") : "none";
          const unavailable = Array.isArray(evidence.availabilityUnavailableModels) && evidence.availabilityUnavailableModels.length ? evidence.availabilityUnavailableModels.join(", ") : "none";
          lines.push(`  modelRouting availability: available=${available} / unavailable=${unavailable}`);
        }
      }
    }
    return lines.join("\n");
  }
  if (payload?.message) return String(payload.message);
  return `${actionName}: ${payload?.ok === false ? "failed" : "ok"}`;
}

if (args.has("--report-io-self-test")) {
  emitEvidenceReport("manager-report-io-self-test", {
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    processIdentity: { verifierPid: process.pid },
    sessionIdentity: { kind: "offline-report-io-self-test" },
  });
  process.exit(0);
}

if (args.has("--self-test")) {
  assert.equal(hasActionSpecificResult("fastOverallNoTraffic", "\u901a\u8fc7"), false);
  assert.equal(hasActionSpecificResult("fastOverallNoTraffic", "\u5feb\u901f\u68c0\u67e5\uff1a\u901a\u8fc7\n\u8017\u65f6\uff1a23000 ms"), true);
  assert.equal(isRunningText("\u68c0\u67e5\u5b89\u88c5/\u540c\u6b65\uff1a\u4ecd\u5728\u8fd0\u884c\u6216\u672c\u673a\u811a\u672c\u6b63\u5728\u6536\u5c3e\u3002"), true);
  assert.equal(hasActionSpecificResult("syncReadiness", "\u68c0\u67e5\u5b89\u88c5/\u540c\u6b65\uff1a\u4ecd\u5728\u8fd0\u884c\u6216\u672c\u673a\u811a\u672c\u6b63\u5728\u6536\u5c3e\u3002"), false);
  assert.equal(hasActionSpecificResult("syncReadiness", "\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5\uff1a\u901a\u8fc7"), true);
  assert.equal(hasActionSpecificResult("updateCheck", "Codex \u66f4\u65b0\u68c0\u67e5\uff1a\u5df2\u63d0\u4ea4\u540e\u53f0\u6267\u884c\u3002"), false);
  assert.equal(hasActionSpecificResult("updateCheck", "\u66f4\u65b0\u68c0\u67e5\uff1a\u65e0\u9700\u540c\u6b65\nCodexPlusPlus\uff1a\u9879\u76ee\u56fa\u5b9a 1.2.43 / \u5df2\u5b89\u88c5 1.2.43"), true);
  assert.equal(hasActionSpecificResult("updateCheck", "\u66f4\u65b0\u68c0\u67e5\uff1a\u9700\u8981\u540c\u6b65\nCodexPlusPlus\uff1a\u9879\u76ee\u56fa\u5b9a 1.2.43 / \u5df2\u5b89\u88c5 1.2.39"), true);
  assert.equal(hasActionSpecificResult("sourcePreflight", "\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7"), false);
  assert.equal(hasActionSpecificResult("sourcePreflight", "\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7\n\u8017\u65f6\uff1a21000 ms"), true);
  assert.equal(isFinishedText("\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u9a8c\u6536\u62a5\u544a\u3002"), true);
  assert.equal(hasActionSpecificResult("viewLatestReports", "\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u9a8c\u6536\u62a5\u544a\u3002"), true);
  assert.equal(hasActionSpecificResult("viewLatestReports", "\u62a5\u544a\u76ee\u5f55\uff1aC:\\tmp\n\u5df2\u627e\u5230\uff1a1 \u4efd\n\u635f\u574f\u62a5\u544a\uff1a1 \u4efd\u65e0\u6cd5\u8bfb\u53d6\n\u5feb\u901f\u68c0\u67e5\uff1a\u62a5\u544a\u635f\u574f"), true);
  assert.equal(hasActionSpecificResult("viewLatestReports", "\u62a5\u544a\u76ee\u5f55\uff1aC:\\tmp\n\u5df2\u627e\u5230\uff1a1 \u4efd\n\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7"), false);
  assert.equal(hasActionSpecificResult("viewLatestReports", "\u62a5\u544a\u76ee\u5f55\uff1aC:\\tmp\n\u5df2\u627e\u5230\uff1a1 \u4efd\n\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7\n  \u516c\u5f00\u6587\u6863\uff1a\u901a\u8fc7"), true);
  assert.equal(hasActionSpecificResult("viewLatestReports", "\u62a5\u544a\u76ee\u5f55\uff1aC:\\tmp\n\u5df2\u627e\u5230\uff1a1 \u4efd\n\u6e90\u7801\u9884\u68c0\uff1a\u9700\u5904\u7406\n  \u516c\u5f00\u6587\u6863\uff1a\u9700\u5904\u7406"), true);
  assert.equal(hasActionSpecificResult("viewLatestReports", "\u62a5\u544a\u76ee\u5f55\uff1aC:\\tmp\n\u5df2\u627e\u5230\uff1a2 \u4efd\n\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7\n\u5386\u53f2\u8fc7\u671f\u6062\u590d\uff1a\u901a\u8fc7\n  \u6587\u4ef6\uff1aC:\\tmp\\latest-missing-history.json"), true);
  assert.equal(isActionFailureText("viewLatestReports", "\u62a5\u544a\u76ee\u5f55\uff1aC:\\tmp\n\u5df2\u627e\u5230\uff1a1 \u4efd\n\u9a8c\u6536\uff1a\u9700\u8981\u5904\u7406"), false);
  assert.equal(hasActionSpecificResult("viewLatestReports", managerSummaryFromActionPayload("viewLatestReports", { ok: true, result: { reportRoot: "C:\\tmp", existingCount: 1, reports: [{ label: "\u6e90\u7801\u9884\u68c0", exists: true, ok: true, sourcePreflightEvidence: { publicDocumentationOk: true } }] } })), true);
  assert.ok(managerSummaryFromActionPayload("viewLatestReports", { ok: true, result: { reportRoot: "C:\\tmp", existingCount: 1, reports: [{ label: "\u6a21\u578b\u53ef\u7528\u6027", exists: true, ok: true, modelRoutingEvidence: { requestAvailableModels: ["gemini-3.5-flash-low"], availabilityUnavailableModels: ["claude-sonnet-4-6", "gpt-oss-120b-medium"] } }] } }).includes("claude-sonnet-4-6"));
  const deferredLatestReportsSummary = managerSummaryFromActionPayload("viewLatestReports", {
    ok: true,
    result: {
      reportRoot: "C:\\tmp",
      existingCount: 1,
      reports: [{ label: "\u72ec\u7acb Antigravity CLI \u51c6\u5907", exists: true, ok: true, stale: true, deferred: true }],
    },
  });
  assert.match(deferredLatestReportsSummary, /\u5df2\u5ef6\u671f\/\u53ef\u9009\uff1a1 \u4efd/);
  assert.match(deferredLatestReportsSummary, /\u72ec\u7acb Antigravity CLI \u51c6\u5907\uff1a\u5df2\u5ef6\u671f/);
  assert.doesNotMatch(deferredLatestReportsSummary, /\u9700\u91cd\u8dd1/);
  assert.equal(hasActionSpecificResult("diagnosticsBundle", "\u8bca\u65ad\u5305\uff1a\u5931\u8d25"), false);
  assert.equal(hasActionSpecificResult("diagnosticsBundle", "\u8bca\u65ad\u5305\uff1aZIP \u5df2\u751f\u6210"), true);
  assert.equal(hasActionSpecificResult("diagnosticsBundle", managerSummaryFromActionPayload("diagnosticsBundle", { ok: true, result: { ok: true } })), true);
  assert.equal(isUiOnlySmokeText("\u8bf4\u660e\uff1aui-only manager button smoke"), true);
  assert.ok(uiOnlyBridgeSource("mcpSkills", true).includes("__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__"));
  let realActionCalls = 0;
  let realRequestCalls = 0;
  const batchContext = {
    Date,
    Promise,
    __ANTICODEX_MANAGER_BRIDGE_READY__: true,
    __ANTICODEX_MANAGER_ACTION_QUEUE__: [],
    __ANTICODEX_MANAGER_ACTION_PROMISES__: {},
    __ANTICODEX_MANAGER_SNAPSHOT__: { responses: { "/models": { object: "list", data: [{ id: "snapshot-model" }] } } },
    __ANTICODEX_RUN_MANAGER_ACTION__: async () => { realActionCalls += 1; },
    __ANTICODEX_RUN_MANAGER_REQUEST__: async () => { realRequestCalls += 1; },
  };
  batchContext.window = batchContext;
  batchContext.globalThis = batchContext;
  vm.runInNewContext(uiOnlyBatchBridgeSource(true), batchContext);
  const batchAction = await batchContext.__ANTICODEX_RUN_MANAGER_ACTION__("updateCheck");
  const batchRequest = await batchContext.__ANTICODEX_RUN_MANAGER_REQUEST__("/models", { method: "GET" });
  assert.equal(batchAction.action, "updateCheck");
  assert.equal(batchAction.uiOnly, true);
  assert.equal(batchRequest.kind, "manager-request");
  assert.equal(batchRequest.path, "/models");
  assert.equal(batchRequest.value.data[0].id, "snapshot-model");
  assert.equal(realActionCalls, 0);
  assert.equal(realRequestCalls, 0);
  const batchBeforeCleanup = vm.runInNewContext(uiOnlyBatchEvidenceSource(), batchContext);
  assert.equal(batchBeforeCleanup.actionCalls.length, 1);
  assert.equal(batchBeforeCleanup.requestCalls.length, 1);
  const batchCleanup = vm.runInNewContext(cleanupUiOnlyBatchBridgeSource(true), batchContext);
  assert.equal(batchCleanup.restored, true);
  assert.equal(batchContext.__ANTICODEX_RUN_MANAGER_ACTION__?.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH__, undefined);
  assert.equal(batchContext.__ANTICODEX_RUN_MANAGER_REQUEST__?.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH__, undefined);
  console.log(JSON.stringify({ ok: true, selfTest: true }));
  process.exit(0);
}

const managerButtonLock = await acquireManagerButtonLock();
process.once("exit", () => releaseManagerButtonLock(managerButtonLock));

function getJson(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${response.statusCode} ${response.statusMessage}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Timed out fetching ${url}`)));
    request.on("error", reject);
  });
}

function firstPid(value) {
  if (Array.isArray(value)) return Number(value[0] || 0);
  return Number(value || 0);
}

function pidIsAlive(pid) {
  if (!(Number(pid) > 0)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function collectEvidenceIdentity(target, port) {
  const health = await getJson(fixedRouteHealthUrl, 3000).catch(() => null);
  const originalCodexPid = Number(args.get("--expected-original-codex-pid") || 0);
  return {
    processIdentity: {
      supervisorPid: Number(health?.pid || 0),
      codexPlusPlusPid: firstPid(health?.processes?.codexPlusPlus),
      antiCodexMainPid: firstPid(health?.processes?.copiedClient),
      originalCodexPid,
      originalCodexAlive: pidIsAlive(originalCodexPid),
    },
    sessionIdentity: {
      cdpPort: Number(port || 0),
      targetId: String(target?.id || ""),
      targetUrl: String(target?.url || ""),
    },
  };
}

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body ? Buffer.from(options.body) : null;
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || "GET",
      timeout: options.timeout || 30000,
      headers: { ...(options.headers || {}), ...(body ? { "content-length": body.length } : {}) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(json?.error?.message || text || `HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolve(json);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Timed out fetching ${url}`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function getManagerActionToken() {
  if (managerActionToken) return managerActionToken;
  return await bootstrapManagerActionToken();
}

function managerBootstrapRetryBudgetMs() {
  return Math.max(15000, Math.min(60000, timeoutMs));
}

function managerBootstrapRequestTimeoutMs() {
  return Math.max(5000, Math.min(30000, Math.ceil(managerBootstrapRetryBudgetMs() / MANAGER_BOOTSTRAP_MAX_ATTEMPTS)));
}

async function bootstrapManagerActionToken() {
  const deadline = Date.now() + managerBootstrapRetryBudgetMs();
  let lastError = null;
  for (let attempt = 1; attempt <= MANAGER_BOOTSTRAP_MAX_ATTEMPTS && Date.now() < deadline; attempt += 1) {
    try {
      const bootstrap = await httpJson(`${baseUrl}/anticodex/manager/bootstrap`, {
        timeout: Math.min(managerBootstrapRequestTimeoutMs(), Math.max(1000, deadline - Date.now())),
        headers: {
          "origin": baseUrl,
          "referer": `${baseUrl}/anticodex/manager`,
        },
      });
      managerActionToken = String(bootstrap?.token || "");
      if (!managerActionToken) throw new Error("Manager bootstrap did not return an action token");
      return managerActionToken;
    } catch (error) {
      lastError = error;
      if (attempt >= MANAGER_BOOTSTRAP_MAX_ATTEMPTS || Date.now() >= deadline) break;
      await sleep(Math.min(1000, 250 * attempt));
    }
  }
  throw new Error(`Manager bootstrap failed after ${MANAGER_BOOTSTRAP_MAX_ATTEMPTS} attempts: ${lastError?.message || "unknown error"}`);
}

async function postManagerAction(actionName, options = {}) {
  const token = options.refreshToken === true ? await bootstrapManagerActionToken() : await getManagerActionToken();
  try {
    return await httpJson(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      timeout: Math.max(30000, timeoutMs + 5000),
      headers: {
        "content-type": "application/json",
        "origin": baseUrl,
        "referer": `${baseUrl}/anticodex/manager`,
        "x-anticodex-manager-token": token,
      },
      body: JSON.stringify({ action: actionName }),
    });
  } catch (error) {
    if (error?.statusCode !== 403 || options.refreshToken === true) throw error;
    managerActionToken = "";
    return await postManagerAction(actionName, { refreshToken: true });
  }
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.executionContexts = new Map();
  }

  async open() {
    const key = crypto.randomBytes(16).toString("base64");
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening ${this.url.href}`)), 5000);
      this.socket.once("connect", () => {
        this.socket.write([
          `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
          `Host: ${this.url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      const onHandshake = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const split = this.buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = this.buffer.slice(0, split).toString("utf8");
        this.buffer = this.buffer.slice(split + 4);
        this.socket.off("data", onHandshake);
        this.socket.on("data", (data) => this.onData(data));
        clearTimeout(timer);
        if (!/^HTTP\/1.1 101\b/.test(header)) reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
        else {
          this.parseFrames();
          resolve();
        }
      };
      this.socket.on("data", onHandshake);
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = this.buffer.readUInt32BE(offset + 4);
        offset += 8;
      }
      const maskLength = (second & 0x80) !== 0 ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      let payload = this.buffer.slice(offset + maskLength, offset + maskLength + length);
      if (maskLength) {
        const mask = this.buffer.slice(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + maskLength + length);
      if ((first & 0x0f) !== 0x1) continue;
      const message = JSON.parse(payload.toString("utf8"));
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params?.context;
        if (context?.id) this.executionContexts.set(context.id, context);
      } else if (message.method === "Runtime.executionContextDestroyed") {
        const contextId = message.params?.executionContextId;
        if (contextId) this.executionContexts.delete(contextId);
      } else if (message.method === "Runtime.executionContextsCleared") {
        this.executionContexts.clear();
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message);
    }
  }

  send(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length <= 0xFFFF) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  call(id, method, params = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket?.end(); } catch {}
    try { this.socket?.destroy(); } catch {}
  }

  findDefaultContextId(frameId) {
    for (const context of this.executionContexts.values()) {
      if (context.auxData?.isDefault && (!frameId || context.auxData?.frameId === frameId)) {
        return context.id;
      }
    }
    return null;
  }

  findDefaultContextIds(frameId) {
    const ids = [];
    for (const context of this.executionContexts.values()) {
      if (context.auxData?.isDefault && (!frameId || context.auxData?.frameId === frameId)) {
        ids.push(context.id);
      }
    }
    return ids;
  }
}

async function waitForDefaultContext(ws, frameId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const contextId = ws.findDefaultContextId(frameId);
    if (contextId) return contextId;
    await sleep(50);
  } while (Date.now() < deadline);
  return null;
}

async function pickVisiblePageContextId(ws, frameId, nextId) {
  const ids = ws.findDefaultContextIds(frameId);
  for (const contextId of ids) {
    try {
      const probe = await ws.call(nextId(), "Runtime.evaluate", {
        contextId,
        expression: `(() => ({
          title: document.title || "",
          href: location.href || "",
          text: document.body ? document.body.innerText.slice(0, 800) : ""
        }))()`,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      }, 5000);
      const value = probe.result?.value || {};
      const haystack = `${value.title || ""}\n${value.href || ""}\n${value.text || ""}`;
      if (/Anti-Codex|app:\/\/-|新对话|进入项目工作|Gemini|管理/.test(haystack)) return contextId;
    } catch {}
  }
  return ids[0] || null;
}

function isAvatarOverlayTarget(target) {
  return String(target?.url || "").toLowerCase().includes("avatar-overlay");
}

function pickTarget(targets) {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl && !isAvatarOverlayTarget(target));
  return pages.find((target) => /^app:\/\/-\/index\.html(?:[?#]|$)/i.test(String(target.url || "")))
    || pages.find((target) => target.title === "Anti-Codex")
    || pages.find((target) => `${target.title || ""} ${target.url || ""}`.toLowerCase().includes("codex"))
    || pages[0]
    || null;
}

async function findTarget() {
  for (const port of ports) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`);
      const target = pickTarget(targets);
      if (target) return { port, target };
    } catch {}
  }
  throw new Error(`No Anti-Codex CDP target found on ${ports.join(", ")}`);
}

const { port, target } = await findTarget();
const evidenceIdentity = await collectEvidenceIdentity(target, port);
let uiOnlyTrafficBefore = null;
let uiOnlyManagerLogBefore = null;
const pageTargetsBeforeManagerOpen = await getJson(`http://127.0.0.1:${port}/json`).catch(() => []);
if (profileEntryOnly) {
  const profileEntry = await verifyProfileManagerEntryActualMouseWithFreshCdp().catch((error) => ({
    ok: false,
    phase: "profile-entry-exception",
    error: error?.message || String(error),
  }));
  releaseManagerButtonLock(managerButtonLock);
  emitEvidenceReport("manager-profile-entry", {
    ok: profileEntry.ok === true,
    port,
    target: { id: target.id, title: target.title, url: target.url },
    ...evidenceIdentity,
    profileEntry,
  });
  process.exit(profileEntry.ok ? 0 : 1);
}
const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
await ws.open();
let id = 1;
await ws.call(id++, "Runtime.enable");
await ws.call(id++, "Page.enable");
const frameTree = await ws.call(id++, "Page.getFrameTree");
const mainFrameId = frameTree.frameTree?.frame?.id || null;
await waitForDefaultContext(ws, mainFrameId, 5000);
const pageContextId = await pickVisiblePageContextId(ws, mainFrameId, () => id++);
const runtimeParams = (expression, params = {}) => ({
  expression,
  ...params,
  ...(pageContextId ? { contextId: pageContextId } : {}),
});

await ws.call(id++, "Runtime.evaluate", runtimeParams(`(() => {
  document.getElementById("anticodex-manager-overlay")?.remove();
  document.getElementById("anticodex-manager-button")?.remove();
  delete window.__ANTICODEX_MANAGER_VERSION__;
  delete window.__ANTICODEX_MANAGER_INSTALLED__;
  delete window.__ANTICODEX_OPEN_MANAGER__;
  delete window.__ANTICODEX_REFRESH_MANAGER_PANEL__;
  delete window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
  ${realBridgeSource(!uiOnlyMode && !upstreamConfigOnly && !closeOnly)}
})()`, {
  awaitPromise: false,
  allowUnsafeEvalBlockedByCSP: true,
}), 10000);
await ws.call(id++, "Runtime.evaluate", runtimeParams(managerInjectSource, {
  awaitPromise: false,
  returnByValue: true,
  allowUnsafeEvalBlockedByCSP: true,
}), 10000);
if (uiOnlyBatchMode) {
  await ws.call(id++, "Runtime.evaluate", runtimeParams(uiOnlyBatchBridgeSource(true), {
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  }), 10000);
  const preexistingManagerWork = await waitForRealManagerQueueDrain();
  if (!preexistingManagerWork.ok) {
    await evaluate(cleanupUiOnlyBatchBridgeSource(true), 5000).catch(() => {});
    throw new Error(preexistingManagerWork.error || "Pre-existing Manager bridge work did not drain before UI-only verification");
  }
  await evaluate(`(() => {
    const state = window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__;
    if (!state) return { ok: false };
    state.baselineQueueLength = Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : 0;
    state.baselinePromiseCount = Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length;
    return { ok: true, baselineQueueLength: state.baselineQueueLength, baselinePromiseCount: state.baselinePromiseCount };
  })()`, 5000);
  uiOnlyManagerLogBefore = await waitForManagerBridgeLogStable();
  uiOnlyTrafficBefore = await nativeRequestSnapshotSafe();
}

if (simulatePendingReopen) {
  await ws.call(id++, "Runtime.evaluate", runtimeParams(`(() => {
    const originalAction = window.__ANTICODEX_RUN_MANAGER_ACTION__;
    window.__ANTICODEX_PENDING_REOPEN_TEST__ = { calls: 0, action: ${JSON.stringify(action)} };
    window.__ANTICODEX_RUN_MANAGER_ACTION__ = (requestedAction) => {
      if (requestedAction !== ${JSON.stringify(action)}) {
        return typeof originalAction === "function" ? originalAction(requestedAction) : Promise.resolve({ ok: true, action: requestedAction });
      }
      window.__ANTICODEX_PENDING_REOPEN_TEST__.calls += 1;
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: true,
          action: requestedAction,
          result: {
            ok: true,
            skills: { count: 100 },
            connectors: { count: 1494 },
          },
        }), 1200);
      });
    };
  })()`, {
    awaitPromise: false,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  }), 10000);
}

async function evaluate(expression, timeout = 8000) {
  const message = await ws.call(id++, "Runtime.evaluate", runtimeParams(expression, {
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  }), timeout);
  return message.result?.result?.value || {};
}

async function waitForRealManagerQueueDrain(waitMs = 10000) {
  const deadline = Date.now() + Math.max(1000, Number(waitMs) || 10000);
  let latest = null;
  do {
    latest = await evaluate(`(() => ({
      queueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : 0,
      promiseCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
    }))()`, 2500).catch((error) => ({ error: error?.message || String(error) }));
    if (Number(latest.queueLength || 0) === 0 && Number(latest.promiseCount || 0) === 0) return { ok: true, ...latest };
    await sleep(100);
  } while (Date.now() < deadline);
  return { ok: false, ...(latest || {}), error: latest?.error || "Pre-existing Manager bridge work did not drain" };
}

async function waitForManagerBridgeLogStable(waitMs = 3000) {
  const deadline = Date.now() + Math.max(500, Number(waitMs) || 3000);
  let previous = managerBridgeLogSnapshot();
  do {
    await sleep(100);
    const current = managerBridgeLogSnapshot();
    if (current.available === true
        && previous.available === true
        && current.byteLength === previous.byteLength
        && current.actionReceivedCount === previous.actionReceivedCount
        && current.requestReceivedCount === previous.requestReceivedCount
        && current.nonHealthRequestReceivedCount === previous.nonHealthRequestReceivedCount) {
      return current;
    }
    previous = current;
  } while (Date.now() < deadline);
  return previous;
}

async function waitForUiOnlyBatchIdle(waitMs = 30000) {
  const deadline = Date.now() + Math.max(1000, Number(waitMs) || 30000);
  let latest = null;
  do {
    latest = await evaluate(`(() => {
      const overlay = document.querySelector("#anticodex-manager-overlay");
      return {
        overlayPresent: Boolean(overlay),
        busy: overlay?.querySelector('.anticodex-actions')?.getAttribute('data-anticodex-busy') === 'true',
        disabledCount: overlay?.querySelectorAll('button[data-action]:disabled').length || 0,
        running: Boolean(overlay?.querySelector('[data-anticodex-result="action"][data-anticodex-running]')),
        queueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : 0,
        promiseCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
        baselineQueueLength: window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__?.baselineQueueLength ?? 0,
        baselinePromiseCount: window.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__?.baselinePromiseCount ?? 0,
      };
    })()`, 2500).catch((error) => ({ error: error?.message || String(error) }));
    const queueStable = Number(latest.queueLength || 0) === Number(latest.baselineQueueLength || 0)
      && Number(latest.promiseCount || 0) === Number(latest.baselinePromiseCount || 0);
    if (!latest.busy && Number(latest.disabledCount || 0) === 0 && !latest.running && queueStable) {
      return { ok: true, ...latest };
    }
    await sleep(100);
  } while (Date.now() < deadline);
  return { ok: false, ...(latest || {}), error: latest?.error || "Manager UI-only batch did not become idle" };
}

async function cleanupInjectedBridges() {
  await evaluate(`(() => {
    ${cleanupUiOnlyBridgeSource()}
    ${cleanupRealBridgeSource()}
    return true;
  })()`, 2500).catch(() => {});
}

async function verifyProfileManagerEntryActualMouseWithFreshCdp() {
  const socket = new LocalWebSocket(target.webSocketDebuggerUrl);
  await socket.open();
  let nextId = 700000;
  const call = (method, params = {}, timeout = 5000) => socket.call(nextId++, method, params, timeout);
  try {
    await call("Runtime.enable");
    await call("Page.enable");
    const frameTree = await call("Page.getFrameTree");
    const frameId = frameTree.frameTree?.frame?.id || null;
    await waitForDefaultContext(socket, frameId, 5000);
    const contextId = await pickVisiblePageContextId(socket, frameId, () => nextId++);
    const evaluateFresh = async (expression) => {
      const response = await call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
        ...(contextId ? { contextId } : {}),
      });
      return response.result?.result?.value || {};
    };

    await call("Page.bringToFront");
    await evaluateFresh(`(() => {
      window.focus();
      return { focused: document.hasFocus(), visibility: document.visibilityState };
    })()`);
    await sleep(150);
    for (const type of ["keyDown", "keyUp"]) {
      await call("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    const existingManagerOverlay = await evaluateFresh(`(() => {
      const overlay = document.querySelector('#anticodex-manager-overlay');
      if (!overlay) return { open: false };
      const close = overlay.querySelector('[data-anticodex-close="true"]');
      const rect = close?.getBoundingClientRect?.();
      if (!close || !rect || rect.width <= 0 || rect.height <= 0) return { open: true, closeReady: false };
      return {
        open: true,
        closeReady: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`);
    if (existingManagerOverlay.open) {
      if (!existingManagerOverlay.closeReady) {
        return { ok: false, phase: "profile-existing-manager", error: "existing Manager overlay close button missing" };
      }
      for (const event of [
        { type: "mouseMoved", button: "none", buttons: 0 },
        { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
        { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
      ]) {
        await call("Input.dispatchMouseEvent", {
          ...event,
          x: existingManagerOverlay.x,
          y: existingManagerOverlay.y,
        }, CDP_INPUT_EVENT_TIMEOUT_MS);
      }
      const closeDeadline = Date.now() + 2000;
      let existingManagerClosed = false;
      do {
        existingManagerClosed = (await evaluateFresh(`(() => ({
          closed: !document.querySelector('#anticodex-manager-overlay'),
        }))()`)).closed === true;
        if (!existingManagerClosed) await sleep(50);
      } while (!existingManagerClosed && Date.now() < closeDeadline);
      if (!existingManagerClosed) {
        return { ok: false, phase: "profile-existing-manager", error: "existing Manager overlay did not close" };
      }
    }
    const trigger = await evaluateFresh(`(() => {
      const settings = Array.from(document.querySelectorAll('button'))
        .find((node) => node.getAttribute?.("aria-label") === "\\u6253\\u5f00\\u4e2a\\u4eba\\u8d44\\u6599\\u83dc\\u5355");
      const rect = settings?.getBoundingClientRect?.();
      if (!settings || !rect || rect.width <= 0 || rect.height <= 0) return { ok: false };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        ok: true,
        x,
        y,
        text: String(settings.innerText || settings.textContent || "").trim(),
        aria: settings.getAttribute("aria-label") || "",
        hitTag: hit?.tagName || "",
        hitText: String(hit?.innerText || hit?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        hitAria: hit?.getAttribute?.("aria-label") || "",
        hitMatchesTrigger: hit === settings || hit?.closest?.('button') === settings,
        pointerEvents: getComputedStyle(hit || settings).pointerEvents,
        viewport: { width: innerWidth, height: innerHeight },
      };
    })()`);
    if (!trigger.ok) return { ok: false, phase: "profile-trigger", error: "profile menu trigger missing" };

    for (const event of [
      { type: "mouseMoved", button: "none", buttons: 0 },
      { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
    ]) {
      await call("Input.dispatchMouseEvent", { ...event, x: trigger.x, y: trigger.y }, CDP_INPUT_EVENT_TIMEOUT_MS);
    }
    let state = { items: [] };
    const menuDeadline = Date.now() + 2000;
    do {
      await sleep(100);
      state = await evaluateFresh(`(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"],[data-radix-collection-item]'))
        .filter((node) => {
          const rect = node.getBoundingClientRect?.();
          const style = getComputedStyle(node);
          return rect && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        })
        .map((node) => ({
          text: String(node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim(),
          role: node.getAttribute("role") || "",
          tag: node.tagName,
        }))
        .filter((item) => item.text);
      return { items };
    })()`);
    } while ((state.items?.length || 0) === 0 && Date.now() < menuDeadline);
    for (const type of ["keyDown", "keyUp"]) {
      await call("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }

    const profileEntry = state.items?.find((item) => item.text === "\u7ba1\u7406" || item.text === "Manager" || item.text === "Anti-Codex \u7ba1\u7406");
    const forbiddenEnglishVisible = state.items?.some((item) => item.text === "Manager") === true;
    return {
      ok: profileEntry?.text === "\u7ba1\u7406" && !forbiddenEnglishVisible,
      phase: "profile-entry-actual-mouse",
      profileEntryText: profileEntry?.text || "",
      forbiddenEnglishVisible,
      triggerText: trigger.text,
      triggerAria: trigger.aria,
      triggerHitTag: trigger.hitTag,
      triggerHitText: trigger.hitText,
      triggerHitAria: trigger.hitAria,
      triggerHitMatches: trigger.hitMatchesTrigger,
      triggerPointerEvents: trigger.pointerEvents,
      triggerViewport: trigger.viewport,
      actualMouseOpened: state.items?.length > 0,
      items: (state.items || []).slice(-40),
    };
  } finally {
    socket.close();
  }
}

async function verifyCloseButtonActualMouseClick() {
  try {
    await ws.call(id++, "Page.bringToFront", {}, 5000);
    await evaluate(`(() => { window.focus(); return { focused: document.hasFocus(), visibility: document.visibilityState }; })()`, 2500);
  } catch (error) {
    return { ok: false, phase: "bring-to-front", error: error?.message || String(error) };
  }
  const pointSpecs = [
    { name: "upper-center", yFraction: 0.2 },
    { name: "center", yFraction: 0.5 },
    { name: "lower-center", yFraction: 0.8 },
  ];
  const probes = [];
  for (let i = 0; i < pointSpecs.length; i++) {
    const pointSpec = pointSpecs[i];
    const probe = await evaluate(`(async () => {
      if (typeof window.__ANTICODEX_OPEN_MANAGER__ !== "function") return { ok: false, error: "open manager missing" };
      if (!document.querySelector("#anticodex-manager-overlay")) await window.__ANTICODEX_OPEN_MANAGER__();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const overlay = document.querySelector("#anticodex-manager-overlay");
      const closeButton = overlay?.querySelector('[data-anticodex-close="true"]');
      const rect = closeButton?.getBoundingClientRect?.();
      if (!overlay || !closeButton || !rect) return { ok: false, error: "close button missing" };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height * ${JSON.stringify(pointSpec.yFraction)};
      const target = document.elementFromPoint(x, y);
      const hasTextNode = Array.from(closeButton.childNodes || []).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      return {
        ok: !!target?.closest?.('[data-anticodex-close="true"]') && !hasTextNode,
        error: hasTextNode ? "close button still has a text-node hit layer" : "",
        name: ${JSON.stringify(pointSpec.name)},
        x,
        y,
        target: target?.tagName || "",
        targetClass: target?.className || "",
        text: closeButton.textContent || closeButton.getAttribute("aria-label") || "",
        hasTextNode,
        webkitAppRegion: getComputedStyle(closeButton).webkitAppRegion || "",
      };
    })()`, 3500);
    if (!probe.ok) return { ok: false, phase: "preclick", probes: [...probes, probe], failedProbe: probe };
    const mouseEvents = [
      { type: "mouseMoved", button: "none", buttons: 0 },
      { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
    ];
    for (const mouseEvent of mouseEvents) {
      try {
        await ws.call(id++, "Input.dispatchMouseEvent", { ...mouseEvent, x: probe.x, y: probe.y }, CDP_INPUT_EVENT_TIMEOUT_MS);
      } catch (error) {
        return {
          ok: false,
          phase: `actual-click-${mouseEvent.type}`,
          probes,
          failedProbe: probe,
          error: `${pointSpec.name} ${mouseEvent.type}: ${error?.message || String(error)}`,
        };
      }
    }
    const closeDeadline = Date.now() + 3000;
    let closed = { closed: false };
    do {
      await sleep(50);
      closed = await evaluate(`(() => ({ closed: !document.querySelector("#anticodex-manager-overlay") }))()`, 2500);
    } while (closed.closed !== true && Date.now() < closeDeadline);
    const result = { ...probe, closed: closed.closed === true };
    probes.push(result);
    if (!result.closed) {
      return { ok: false, phase: "actual-click", probes, failedProbe: result, error: `close button ${pointSpec.name} actual mouse click did not close overlay` };
    }
    if (i < pointSpecs.length - 1) {
      const reopened = await evaluate(`(async () => {
        await window.__ANTICODEX_OPEN_MANAGER__?.();
        return { reopened: !!document.querySelector("#anticodex-manager-overlay") };
      })()`, 3500);
      if (!reopened.reopened) return { ok: false, phase: "reopen", probes, error: "manager did not reopen after close probe" };
    }
  }
  return { ok: true, phase: "actual-click", probes, reopened: true, finalOverlayClosed: true };
}

async function readManagerActionClickPoint(actionName) {
  return evaluate(`(async () => {
    const actionName = ${JSON.stringify(actionName)};
    const overlay = document.querySelector("#anticodex-manager-overlay");
    const button = Array.from(overlay?.querySelectorAll("button[data-action]") || [])
      .find((candidate) => candidate.dataset.action === actionName) || null;
    if (!button) return { ok: false, present: false, action: actionName, error: "Manager action button missing" };
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const hitButton = hit?.closest?.("button[data-action]") || null;
    const style = getComputedStyle(button);
    const visible = rect.width > 0
      && rect.height > 0
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < innerHeight
      && rect.left < innerWidth
      && style.visibility !== "hidden"
      && style.display !== "none"
      && style.pointerEvents !== "none";
    return {
      ok: visible && hitButton === button,
      present: true,
      action: actionName,
      x,
      y,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      label: String(button.textContent || "").trim(),
      hitAction: hitButton?.dataset?.action || "",
      confirming: button.getAttribute("data-confirming-high-impact") === "true",
      disabled: button.disabled === true,
      visible,
    };
  })()`, 3500);
}

async function readManagerActionLayout() {
  return evaluate(`(() => {
    const overlay = document.querySelector("#anticodex-manager-overlay");
    const groups = Array.from(overlay?.querySelectorAll("[data-action-group]") || []).map((group) => ({
      id: group.getAttribute("data-action-group"),
      actionIds: Array.from(group.querySelectorAll("button[data-action]")).map((button) => button.getAttribute("data-action")),
    }));
    const buttons = Array.from(overlay?.querySelectorAll("button[data-action]") || []).map((button) => ({
      action: button.getAttribute("data-action"),
      groupId: button.closest("[data-action-group]")?.getAttribute("data-action-group") || "",
    }));
    return { groups, buttons };
  })()`, 3500);
}

async function dispatchManagerActionActualMouse(actionName) {
  const requiredConfirmation = MANAGER_HIGH_IMPACT_ACTION_SET.has(actionName);
  const expectedClickCount = requiredConfirmation ? 2 : 1;
  const points = [];
  let clickCount = 0;
  let inputEventCount = 0;
  let confirmationArmed = false;
  let confirmationCleared = !requiredConfirmation;
  const evidence = () => ({
    action: actionName,
    requiredConfirmation,
    expectedClickCount,
    clickCount,
    inputEventCount,
    confirmationArmed,
    confirmationCleared,
    points,
  });
  try {
    await ws.call(id++, "Page.bringToFront", {}, 5000);
    await evaluate(`(() => { window.focus(); return document.hasFocus(); })()`, 2500);
    const click = async (point, phase) => {
      if (!point?.ok || point?.disabled || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        throw new Error(`${phase} Manager action point is not clickable`);
      }
      points.push({ phase, ...point });
      for (const mouseEvent of [
        { type: "mouseMoved", button: "none", buttons: 0 },
        { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
        { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
      ]) {
        await ws.call(id++, "Input.dispatchMouseEvent", {
          ...mouseEvent,
          x: point.x,
          y: point.y,
        }, CDP_INPUT_EVENT_TIMEOUT_MS);
        inputEventCount += 1;
      }
      clickCount += 1;
    };

    const firstPoint = await readManagerActionClickPoint(actionName);
    await click(firstPoint, "first");

    let afterFirst = null;
    const confirmationDeadline = Date.now() + (requiredConfirmation ? 3000 : 500);
    do {
      afterFirst = await readManagerActionClickPoint(actionName);
      confirmationArmed = afterFirst?.confirming === true;
      if (confirmationArmed || !requiredConfirmation) break;
      await sleep(50);
    } while (Date.now() < confirmationDeadline);

    if (requiredConfirmation && !confirmationArmed) {
      return { ok: false, ...evidence(), error: "high-impact Manager action did not arm confirmation" };
    }
    if (!requiredConfirmation && confirmationArmed) {
      return { ok: false, ...evidence(), error: "daily Manager action unexpectedly armed high-impact confirmation" };
    }

    if (requiredConfirmation) {
      const secondPoint = await readManagerActionClickPoint(actionName);
      if (secondPoint?.confirming !== true) {
        return { ok: false, ...evidence(), error: "high-impact confirmation cleared before the second click" };
      }
      await click(secondPoint, "second");
      const clearedDeadline = Date.now() + 3000;
      do {
        const afterSecond = await readManagerActionClickPoint(actionName);
        confirmationCleared = afterSecond?.present === true && afterSecond.confirming !== true;
        if (confirmationCleared) break;
        await sleep(50);
      } while (Date.now() < clearedDeadline);
      if (!confirmationCleared) {
        return { ok: false, ...evidence(), error: "high-impact confirmation did not clear after the second click" };
      }
    }

    const actualMouse = evidence();
    return {
      ok: clickCount === expectedClickCount
        && inputEventCount === expectedClickCount * 3
        && confirmationCleared,
      ...actualMouse,
    };
  } catch (error) {
    return { ok: false, ...evidence(), error: error?.message || String(error) };
  }
}

async function verifyUpstreamConfigActualMouseClick() {
  const trustedHeaders = {
    origin: baseUrl,
    referer: `${baseUrl}/anticodex/manager`,
  };
  const publicProfileSignature = (profile) => JSON.stringify({
    active: profile?.active || "",
    runtime: profile?.runtime || null,
    saved: profile?.saved || null,
  });
  const beforeProfile = await httpJson(`${baseUrl}/anticodex/upstream-profile`, { headers: trustedHeaders });
  const beforeSignature = publicProfileSignature(beforeProfile);
  const dispatchActualClick = async (point) => {
    for (const event of [
      { type: "mouseMoved", button: "none", buttons: 0 },
      { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
    ]) {
      await ws.call(id++, "Input.dispatchMouseEvent", { ...event, x: point.x, y: point.y }, CDP_INPUT_EVENT_TIMEOUT_MS);
    }
  };
  const dispatchKeyInput = async (key, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"]) {
      await ws.call(id++, "Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      }, CDP_INPUT_EVENT_TIMEOUT_MS);
    }
  };
  const actionPoint = async () => evaluate(`(() => {
    const button = document.querySelector('#anticodex-manager-overlay button[data-action="upstreamConfig"]');
    const rect = button?.getBoundingClientRect?.();
    const x = rect ? rect.left + rect.width / 2 : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const hit = document.elementFromPoint(x, y);
    return {
      ok: !!button && !!rect && (hit === button || hit?.closest?.('button') === button),
      x,
      y,
      label: String(button?.textContent || '').trim(),
    };
  })()`, 3500);

  await ws.call(id++, "Page.bringToFront", {}, 5000);
  const opened = await evaluate(`(async () => {
    document.querySelector('#anticodex-manager-overlay')?.remove();
    await window.__ANTICODEX_OPEN_MANAGER__?.();
    const overlay = document.querySelector('#anticodex-manager-overlay');
    return {
      ok: !!overlay,
      aria: overlay?.getAttribute('aria-label') || '',
      version: window.__ANTICODEX_MANAGER_VERSION__ || '',
    };
  })()`, 5000);
  if (!opened.ok) return { ok: false, phase: "open", opened, usedRealTraffic: false };

  const first = await actionPoint();
  if (!first.ok) return { ok: false, phase: "first-hit", opened, first, usedRealTraffic: false };
  const firstClickStartedAt = Date.now();
  await dispatchActualClick(first);
  const firstClickDurationMs = Date.now() - firstClickStartedAt;
  let form = {};
  const formDeadline = Date.now() + Math.max(8000, timeoutMs);
  do {
    form = await evaluate(`(() => {
      const result = document.querySelector('#anticodex-manager-overlay [data-anticodex-result="action"]');
      const labels = Array.from(result?.querySelectorAll('label > span') || []).map((node) => String(node.textContent || '').trim());
      const protocolLabel = Array.from(result?.querySelectorAll('label') || []).find((label) =>
        String(label.querySelector(':scope > span')?.textContent || '').trim() === '\u534f\u8bae'
      );
      const select = protocolLabel?.querySelector('select') || null;
      return {
        ok: labels.includes('API key') && !!select,
        labels,
        protocolOptions: Array.from(select?.options || []).map((option) => String(option.textContent || '').trim()),
        buttons: Array.from(result?.querySelectorAll('button') || []).map((button) => ({
          label: String(button.textContent || '').trim(),
          disabled: button.disabled,
        })),
        hasImpactWarning: !!result?.querySelector('.anticodex-warn'),
        embedded: !!result?.closest('#anticodex-manager-overlay'),
        actionLabel: String(document.querySelector('#anticodex-manager-overlay button[data-action="upstreamConfig"]')?.textContent || '').trim(),
        confirming: document.querySelector('#anticodex-manager-overlay button[data-action="upstreamConfig"]')?.getAttribute('data-confirming-high-impact') || '',
        resultText: String(result?.textContent || '').trim().slice(0, 500),
        snapshotOk: window.__ANTICODEX_MANAGER_SNAPSHOT__?.ok === true,
        snapshotResponseCount: Object.keys(window.__ANTICODEX_MANAGER_SNAPSHOT__?.responses || {}).length,
        snapshotInFlight: window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__ === true,
      };
    })()`, 3500);
    if (form.ok) break;
    await sleep(100);
  } while (Date.now() < formDeadline);

  const readProtocolSelect = async () => evaluate(`(() => {
    const result = document.querySelector('#anticodex-manager-overlay [data-anticodex-result="action"]');
    const protocolLabel = Array.from(result?.querySelectorAll('label') || []).find((label) =>
      String(label.querySelector(':scope > span')?.textContent || '').trim() === '\u534f\u8bae'
    );
    const select = protocolLabel?.querySelector('select') || null;
    select?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    const rect = select?.getBoundingClientRect?.();
    const x = rect ? rect.left + rect.width / 2 : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const hit = document.elementFromPoint(x, y);
    return {
      ok: !!select && !!rect && rect.width > 0 && rect.height > 0 && (hit === select || hit?.closest?.('select') === select),
      x,
      y,
      value: String(select?.value || ''),
      selectedIndex: Number(select?.selectedIndex ?? -1),
      optionValues: Array.from(select?.options || []).map((option) => String(option.value || '')),
    };
  })()`, 3500);
  const protocolBefore = await readProtocolSelect();
  const alternateIndex = protocolBefore.selectedIndex === 0 ? 1 : 0;
  let protocolAlternate = {};
  let protocolRestored = {};
  if (protocolBefore.ok && protocolBefore.optionValues?.length === 2 && alternateIndex >= 0) {
    await dispatchActualClick(protocolBefore);
    const alternateKey = alternateIndex > protocolBefore.selectedIndex ? "ArrowDown" : "ArrowUp";
    await dispatchKeyInput(alternateKey, alternateKey === "ArrowDown" ? 40 : 38);
    await dispatchKeyInput("Enter", 13);
    await sleep(150);
    protocolAlternate = await readProtocolSelect();

    if (protocolAlternate.ok) {
      await dispatchActualClick(protocolAlternate);
      const restoreKey = protocolBefore.selectedIndex > protocolAlternate.selectedIndex ? "ArrowDown" : "ArrowUp";
      await dispatchKeyInput(restoreKey, restoreKey === "ArrowDown" ? 40 : 38);
      await dispatchKeyInput("Enter", 13);
      await sleep(150);
      protocolRestored = await readProtocolSelect();
    }
  }
  const protocolInteraction = {
    ok: protocolBefore.ok === true
      && protocolAlternate.ok === true
      && protocolRestored.ok === true
      && protocolAlternate.selectedIndex === alternateIndex
      && protocolAlternate.value !== protocolBefore.value
      && protocolRestored.selectedIndex === protocolBefore.selectedIndex
      && protocolRestored.value === protocolBefore.value,
    selectedAlternate: protocolAlternate.selectedIndex === alternateIndex && protocolAlternate.value !== protocolBefore.value,
    restoredOriginal: protocolRestored.selectedIndex === protocolBefore.selectedIndex && protocolRestored.value === protocolBefore.value,
    actualMouseClickCount: 2,
    keyEventCount: 8,
    before: protocolBefore,
    alternate: protocolAlternate,
    restored: protocolRestored,
  };

  const closePoint = await evaluate(`(() => {
    const button = document.querySelector('#anticodex-manager-overlay [data-anticodex-close="true"]');
    button?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    const rect = button?.getBoundingClientRect?.();
    const x = rect ? rect.left + rect.width / 2 : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const hit = document.elementFromPoint(x, y);
    return {
      ok: !!button && !!rect && (hit === button || hit?.closest?.('[data-anticodex-close="true"]') === button),
      x,
      y,
      hasTextNode: Array.from(button?.childNodes || []).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()),
    };
  })()`, 3500);
  if (closePoint.ok) await dispatchActualClick(closePoint);
  await sleep(150);
  const closed = await evaluate(`(() => ({ closed: !document.querySelector('#anticodex-manager-overlay') }))()`, 2500);
  const afterProfile = await httpJson(`${baseUrl}/anticodex/upstream-profile`, { headers: trustedHeaders });
  const profileUnchanged = beforeSignature === publicProfileSignature(afterProfile);
  const pageTargetsAfter = await getJson(`http://127.0.0.1:${port}/json`).catch(() => []);
  const buttonState = Object.fromEntries((form.buttons || []).map((button) => [button.label, button.disabled]));
  const actualMouse = {
    ok: form.ok === true && form.confirming === "",
    action: "upstreamConfig",
    requiredConfirmation: false,
    expectedClickCount: 1,
    clickCount: 1,
    inputEventCount: 3,
    confirmationArmed: false,
    confirmationCleared: true,
    points: [
      { phase: "first", ...first, hitAction: "upstreamConfig" },
    ],
  };
  const ok = form.ok === true
    && form.embedded === true
    && form.hasImpactWarning === false
    && form.protocolOptions?.join("|") === "Chat Completions|Responses"
    && ["\u534f\u8bae", "\u63a5\u53e3\u5730\u5740\uff08\u53ef\u586b base URL \u6216\u5b8c\u6574\u63a5\u53e3\uff09", "\u6a21\u578b\u540d", "API key"].every((label) => form.labels?.includes(label))
    && buttonState["\u6d4b\u8bd5\u8fde\u901a"] === false
    && buttonState["\u4fdd\u5b58\u914d\u7f6e"] === true
    && !("\u4fdd\u5b58\u5e76\u5207\u6362" in buttonState)
    && !("\u6062\u590d Antigravity" in buttonState)
    && !form.labels?.includes("Antigravity \u6a21\u578b")
    && actualMouse.ok === true
    && protocolInteraction.selectedAlternate === true
    && protocolInteraction.restoredOriginal === true
    && profileUnchanged
    && closePoint.ok === true
    && closePoint.hasTextNode === false
    && closed.closed === true
    && pageTargetsAfter.filter((item) => item?.type === "page").length === pageTargetsBeforeManagerOpen.filter((item) => item?.type === "page").length;
  return {
    ok,
    phase: "upstream-config-actual-mouse",
    opened,
    firstClickLabel: first.label,
    firstClickDurationMs,
    form,
    actualMouse,
    protocolInteraction,
    profileUnchanged,
    closeActualMouse: closePoint.ok === true && closed.closed === true,
    closeHasTextNode: closePoint.hasTextNode === true,
    pageTargetCountBefore: pageTargetsBeforeManagerOpen.filter((item) => item?.type === "page").length,
    pageTargetCountAfter: pageTargetsAfter.filter((item) => item?.type === "page").length,
    usedRealTraffic: false,
  };
}

async function drainManagerActionQueue() {
  const drainedPayloads = {};
  const queued = await evaluate(`(() => {
    const queue = Array.isArray(window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__)
      ? window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__.splice(0)
      : [];
    return { items: queue };
  })()`, 2500).catch(() => ({ items: [] }));
  for (const item of queued.items || []) {
    let payload;
    try {
      payload = await postManagerAction(item.action);
    } catch (error) {
      payload = { ok: false, action: item.action, message: error?.message || String(error) };
    }
    drainedPayloads[item.action] = payload;
    const managerSummary = managerSummaryFromActionPayload(item.action, payload);
    await evaluate(`(() => {
      window.__ANTICODEX_RESOLVE_MANAGER_BUTTON_ACTION__?.(${JSON.stringify(item.id)}, ${JSON.stringify(payload)});
      window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
        ...${JSON.stringify(payload)},
        action: ${JSON.stringify(item.action)},
        managerSummary: ${JSON.stringify(managerSummary)},
        pending: false,
      };
      const result = document.querySelector('[data-anticodex-result="action"]');
      if (result) {
        result.removeAttribute('data-anticodex-running');
        result.textContent = ${JSON.stringify(managerSummary)};
      }
      document.querySelector('.anticodex-actions')?.removeAttribute('data-anticodex-busy');
      for (const button of document.querySelectorAll('button[data-action]')) button.disabled = false;
      return true;
    })()`, 2500).catch(() => {});
  }
  return drainedPayloads;
}

async function runManagerActionBatch(actions) {
  const startedAt = Date.now();
  const results = {};
  const batchCloseActualMouse = await verifyCloseButtonActualMouseClick().catch((error) => ({
    ok: false,
    error: error?.message || String(error),
    phase: "actual-click-exception",
  }));
  for (const actionName of actions) {
    const safeActionName = JSON.stringify(actionName);
    const closeActualMouse = batchCloseActualMouse;
    if (!closeActualMouse.ok) {
      results[actionName] = { ok: false, error: "close button actual mouse click failed", closeActualMouse };
      continue;
    }
    const initial = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (typeof window.__ANTICODEX_OPEN_MANAGER__ !== "function") return { ok: false, error: "open manager missing" };
  if (!document.querySelector("#anticodex-manager-overlay")) await window.__ANTICODEX_OPEN_MANAGER__();
  const overlay = document.querySelector("#anticodex-manager-overlay");
  const button = overlay?.querySelector('button[data-action=' + ${safeActionName} + ']') || null;
  const result = overlay?.querySelector('[data-anticodex-result="action"]') || null;
  if (!overlay || !button || !result) return { ok: false, error: "Manager action control missing" };
  button.closest("details")?.setAttribute("open", "");
  button.scrollIntoView({ block: "center", inline: "nearest" });
  await sleep(20);
  const closeButton = overlay.querySelector('[data-anticodex-close="true"]');
  const closeRect = closeButton?.getBoundingClientRect();
  const closeCenterX = closeRect ? closeRect.left + closeRect.width / 2 : 0;
  const closeCenterY = closeRect ? closeRect.top + closeRect.height / 2 : 0;
  const closeUpperCenterY = closeRect ? closeRect.top + closeRect.height * 0.25 : 0;
  const closeLowerCenterY = closeRect ? closeRect.top + closeRect.height * 0.75 : 0;
  const closeCenterTarget = closeRect ? document.elementFromPoint(closeCenterX, closeCenterY) : null;
  const closeUpperCenterTarget = closeRect ? document.elementFromPoint(closeCenterX, closeUpperCenterY) : null;
  const closeLowerCenterTarget = closeRect ? document.elementFromPoint(closeCenterX, closeLowerCenterY) : null;
  const closeCenterHitsButton = !!closeCenterTarget?.closest?.('[data-anticodex-close="true"]');
  const closeUpperCenterHitsButton = !!closeUpperCenterTarget?.closest?.('[data-anticodex-close="true"]');
  const closeLowerCenterHitsButton = !!closeLowerCenterTarget?.closest?.('[data-anticodex-close="true"]');
    if (!closeCenterHitsButton || !closeUpperCenterHitsButton || !closeLowerCenterHitsButton) {
      return {
        ok: false,
        error: "close button hit area is not centered on the visible button",
        closeCenterHitsButton,
        closeUpperCenterHitsButton,
        closeLowerCenterHitsButton,
      };
    }
    const closeHitAreaOk = closeCenterHitsButton && closeUpperCenterHitsButton && closeLowerCenterHitsButton;
    const closeHitResults = [
      { name: "center", hit: closeCenterHitsButton },
      { name: "upper-center", hit: closeUpperCenterHitsButton },
      { name: "lower-center", hit: closeLowerCenterHitsButton },
    ];
  const rect = button.getBoundingClientRect();
  const actionCenterX = rect.left + rect.width / 2;
  const actionCenterY = rect.top + rect.height / 2;
  const actionCenterTarget = document.elementFromPoint(actionCenterX, actionCenterY);
  const actionCenterHitsButton = !!actionCenterTarget?.closest?.('button[data-action=' + ${safeActionName} + ']');
  if (!actionCenterHitsButton) return { ok: false, error: "action button center point does not hit the requested button" };
  ${realBridgeSource(!uiOnlyMode && !upstreamConfigOnly && !closeOnly)}
  if (!${JSON.stringify(uiOnlyMode)}) {
    delete window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    if (result) result.textContent = ${JSON.stringify(REFRESHED_TEXT)};
  }
  ${uiOnlyBridgeSource(actionName)}
  return {
    ok: true,
      closeCenterHitsButton,
      closeUpperCenterHitsButton,
      closeLowerCenterHitsButton,
      closeHitAreaOk,
      closeHitResults,
      actionCenterHitsButton,
      actionCenterX,
      actionCenterY,
      label: button.textContent || "",
      initialText: result.textContent || "",
  };
})()
`, 12000);
    const actualMouse = initial.ok
      ? await dispatchManagerActionActualMouse(actionName)
      : { ok: false, action: actionName, error: initial.error || "Manager action setup failed" };
    initial.actualMouse = actualMouse;
    if (!actualMouse.ok) initial.ok = false;
    initial.closeActualMouseOk = closeActualMouse.ok;
    initial.closeActualMouse = closeActualMouse;

    let latest = initial;
    const deadline = Date.now() + timeoutMs;
    let drainedPayloads = uiOnlyMode ? {} : await drainManagerActionQueue();
    while (initial.ok && Date.now() < deadline) {
      await sleep(100);
      if (!uiOnlyMode) drainedPayloads = { ...drainedPayloads, ...(await drainManagerActionQueue()) };
      latest = await evaluate(`(() => {
        const overlay = document.querySelector("#anticodex-manager-overlay");
        const button = overlay?.querySelector('button[data-action=' + ${safeActionName} + ']') || null;
        const result = overlay?.querySelector('[data-anticodex-result="action"]') || null;
        const lastActionResult = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ || null;
        return {
          selectedContextId: ${JSON.stringify(pageContextId)},
          version: window.__ANTICODEX_MANAGER_VERSION__,
          bridgeReady: window.__ANTICODEX_MANAGER_BRIDGE_READY__ === true,
          overlayPresent: Boolean(overlay),
          buttonPresent: Boolean(button),
          resultPresent: Boolean(result),
          disabled: button?.disabled === true,
          queueLength: Array.isArray(window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__.length : null,
          pendingCount: Object.keys(window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__ || {}).length,
          lastAction: lastActionResult?.action || "",
          lastOk: lastActionResult?.ok,
          lastPending: lastActionResult?.pending,
          lastUiOnly: lastActionResult?.uiOnly === true,
          lastSummary: lastActionResult?.managerSummary || "",
          text: result?.textContent || lastActionResult?.managerSummary || "",
        };
      })()`, Math.max(250, Math.min(2500, deadline - Date.now())));
      const drainedPayload = drainedPayloads[actionName] || null;
      if (drainedPayload) {
        const drainedSummary = managerSummaryFromActionPayload(actionName, drainedPayload);
        latest = {
          ...latest,
          disabled: false,
          queueLength: 0,
          pendingCount: 0,
          lastAction: actionName,
          lastOk: drainedPayload.ok !== false,
          lastPending: false,
          lastUiOnly: drainedPayload.uiOnly === true,
          lastSummary: drainedSummary,
          text: drainedSummary,
        };
      }
      const text = latest.text || latest.lastSummary || "";
      const settled = latest.lastAction === actionName
        && latest.lastPending !== true
        && Number(latest.pendingCount || 0) === 0
        && Number(latest.queueLength || 0) === 0
        && latest.disabled !== true;
      const terminalFailure = settled
        && (latest.lastOk === false || isActionFailureText(actionName, text));
      const visibleFinished = !latest.disabled
        && !isRunningText(text)
        && !isActionFailureText(actionName, text)
        && isFinishedText(text)
        && (uiOnlyMode || !isUiOnlySmokeText(text))
        && hasActionSpecificResult(actionName, text);
      const uiOnlyFinished = uiOnlyMode && isUiOnlyActionFinished(actionName, { ...latest, text });
      const isFastMode = !uiOnlyMode && actionName === "mcpSkills" && timeoutMs <= 15000;
      if (terminalFailure || drainedPayload?.ok === false) {
        break;
      } else if (uiOnlyFinished) {
        break;
      } else if (isFastMode) {
        const started = latest.disabled || isRunningText(text);
        const settledAndOk = settled && !isRunningText(text) && isFinishedText(text) && hasActionSpecificResult(actionName, text);
        if (started || settledAndOk) break;
      } else {
        if (settled && visibleFinished) break;
      }
    }
    const drainedPayload = drainedPayloads[actionName] || null;
    if (drainedPayload) {
      const drainedSummary = managerSummaryFromActionPayload(actionName, drainedPayload);
      latest = {
        ...latest,
        disabled: false,
        queueLength: 0,
        pendingCount: 0,
        lastAction: actionName,
        lastOk: drainedPayload.ok !== false,
        lastPending: false,
        lastUiOnly: drainedPayload.uiOnly === true,
        lastSummary: drainedSummary,
        text: drainedSummary,
      };
    }
    const text = latest.text || latest.lastSummary || "";
    const settled = latest.lastAction === actionName
      && latest.lastPending !== true
      && Number(latest.pendingCount || 0) === 0
      && Number(latest.queueLength || 0) === 0
      && latest.disabled !== true;
    const visibleFinished = !latest.disabled
      && !isRunningText(text)
      && !isActionFailureText(actionName, text)
      && isFinishedText(text)
      && (uiOnlyMode || !isUiOnlySmokeText(text))
      && hasActionSpecificResult(actionName, text);
    const uiOnlyFinished = uiOnlyMode && isUiOnlyActionFinished(actionName, { ...latest, text });
    const isFastMode = !uiOnlyMode && actionName === "mcpSkills" && timeoutMs <= 15000;
    const pageTargetsAfterManagerOpen = await getJson(`http://127.0.0.1:${port}/json`).catch(() => []);
    const pageTargetCountBeforeManagerOpen = pageTargetsBeforeManagerOpen.filter((item) => item?.type === "page").length;
    const pageTargetCountAfterManagerOpen = pageTargetsAfterManagerOpen.filter((item) => item?.type === "page").length;
    const managerOpenedNewPage = pageTargetCountAfterManagerOpen > pageTargetCountBeforeManagerOpen;
    const ok = initial.ok === true
      && (uiOnlyFinished || isFastMode || settled)
      && initial.closeCenterHitsButton === true
      && initial.closeUpperCenterHitsButton === true
      && initial.closeLowerCenterHitsButton === true
      && initial.actionCenterHitsButton === true
      && initial.actualMouse?.ok === true
      && managerOpenedNewPage === false
      && (uiOnlyFinished ? true : isFastMode ? !isActionFailureText(actionName, text) : (latest.lastOk !== false && visibleFinished));
    results[actionName] = {
      ok,
      port,
      target: { id: target.id, title: target.title, url: target.url },
      result: { ...latest, lastUiOnly: uiOnlyMode || latest.lastUiOnly === true, action: actionName, label: initial.label, initialText: initial.initialText, text, initial },
      managerOpenedNewPage,
      pageTargetCountBeforeManagerOpen,
      pageTargetCountAfterManagerOpen,
    };
    await evaluate(`(() => {
      ${cleanupUiOnlyBridgeSource(true, actionName)}
      return true;
    })()`, 2000);
  }
  return {
    ok: actions.every((actionName) => results[actionName]?.ok === true),
    port,
    target: { id: target.id, title: target.title, url: target.url },
    actions,
    results,
    durationMs: Date.now() - startedAt,
  };
}

if (uiOnlyMatrix) {
  const startedAt = Date.now();
  const genericActions = MANAGER_ALL_ACTION_IDS.filter((actionName) => actionName !== "upstreamConfig");
  const output = await runManagerActionBatch(genericActions);
  const actionLayout = await readManagerActionLayout();
  const actionLayoutFailures = managerActionLayoutFailures(actionLayout);
  const upstreamConfig = await verifyUpstreamConfigActualMouseClick().catch((error) => ({
    ok: false,
    phase: "upstream-config-exception",
    error: error?.message || String(error),
    usedRealTraffic: false,
  }));
  output.results.upstreamConfig = {
    ok: upstreamConfig.ok === true,
    port,
    target: { id: target.id, title: target.title, url: target.url },
    result: {
      action: "upstreamConfig",
      lastAction: "upstreamConfig",
      lastOk: upstreamConfig.ok === true,
      lastPending: false,
      pendingCount: 0,
      queueLength: 0,
      disabled: false,
      lastUiOnly: true,
      actionActualMouse: upstreamConfig.actualMouse,
      text: upstreamConfig.ok ? "upstreamConfig UI-only form verified" : (upstreamConfig.error || upstreamConfig.phase || "upstreamConfig verification failed"),
    },
    managerOpenedNewPage: Number(upstreamConfig.pageTargetCountAfter || 0) > Number(upstreamConfig.pageTargetCountBefore || 0),
    pageTargetCountBeforeManagerOpen: upstreamConfig.pageTargetCountBefore,
    pageTargetCountAfterManagerOpen: upstreamConfig.pageTargetCountAfter,
  };
  output.actionLayout = actionLayout;
  output.actionLayoutFailures = actionLayoutFailures;
  output.ok = output.ok === true && upstreamConfig.ok === true && actionLayoutFailures.length === 0;
  output.mode = "ui-only-matrix";
  output.actions = [...MANAGER_ALL_ACTION_IDS];
  output.actionGroups = Object.fromEntries(
    Object.entries(MANAGER_ACTION_GROUPS).map(([group, actionIds]) => [group, [...actionIds]]),
  );
  const batchBeforeRestore = await evaluate(uiOnlyBatchEvidenceSource(), 5000).catch((error) => ({
    installed: false,
    error: error?.message || String(error),
  }));
  const batchIdle = await waitForUiOnlyBatchIdle();
  const batchRestore = batchIdle.ok
    ? await evaluate(cleanupUiOnlyBatchBridgeSource(true), 5000).catch((error) => ({
      restored: false,
      error: error?.message || String(error),
    }))
    : { restored: false, safeBridgeRetained: true, error: batchIdle.error };
  await cleanupInjectedBridges();
  const uiOnlyTrafficAfter = await nativeRequestSnapshotSafe();
  const uiOnlyManagerLogAfter = await waitForManagerBridgeLogStable();
  const nativeRequestDelta = nonNegativeDelta(uiOnlyTrafficAfter, uiOnlyTrafficBefore, "requestCount");
  const managerActionDelta = nonNegativeDelta(uiOnlyManagerLogAfter, uiOnlyManagerLogBefore, "actionReceivedCount");
  const managerRequestDelta = nonNegativeDelta(uiOnlyManagerLogAfter, uiOnlyManagerLogBefore, "requestReceivedCount");
  const managerNonHealthRequestDelta = nonNegativeDelta(
    uiOnlyManagerLogAfter,
    uiOnlyManagerLogBefore,
    "nonHealthRequestReceivedCount",
  );
  const stubbedActionNames = [...new Set((batchBeforeRestore.actionCalls || []).map((entry) => String(entry?.action || "")).filter(Boolean))];
  const missingStubbedActions = genericActions.filter((actionName) => !stubbedActionNames.includes(actionName));
  const requestPaths = [...new Set((batchBeforeRestore.requestCalls || []).map((entry) => String(entry?.path || "")).filter(Boolean))];
  const queueUnchanged = Number(batchBeforeRestore.currentQueueLength) === Number(batchBeforeRestore.baselineQueueLength)
    && Number(batchBeforeRestore.currentPromiseCount) === Number(batchBeforeRestore.baselinePromiseCount);
  output.usedRealTraffic = nativeRequestDelta === null ? null : nativeRequestDelta > 0;
  output.zeroSideEffects = batchBeforeRestore.installed === true
    && batchBeforeRestore.actionShimActive === true
    && batchBeforeRestore.requestShimActive === true
    && batchIdle.ok === true
    && batchRestore.restored === true
    && queueUnchanged
    && missingStubbedActions.length === 0
    && requestPaths.includes("/anticodex/account")
    && requestPaths.includes("/models")
    && managerActionDelta === 0
    && managerNonHealthRequestDelta === 0
    && nativeRequestDelta === 0;
  output.isolationEvidence = {
    batchBeforeRestore,
    batchIdle,
    batchRestore,
    stubbedActionNames,
    missingStubbedActions,
    requestPaths,
    queueUnchanged,
    traffic: {
      before: uiOnlyTrafficBefore,
      after: uiOnlyTrafficAfter,
      requestDelta: nativeRequestDelta,
    },
    managerBridgeLog: {
      before: uiOnlyManagerLogBefore,
      after: uiOnlyManagerLogAfter,
      actionReceivedDelta: managerActionDelta,
      requestReceivedDelta: managerRequestDelta,
      nonHealthRequestReceivedDelta: managerNonHealthRequestDelta,
    },
  };
  output.ok = output.ok === true && output.zeroSideEffects === true && output.usedRealTraffic === false;
  output.durationMs = Date.now() - startedAt;
  ws.close();
  releaseManagerButtonLock(managerButtonLock);
  emitEvidenceReport("manager-ui-only-button-matrix", {
    ...compactManagerButtonOutput(output),
    ...evidenceIdentity,
  });
  process.exit(output.ok ? 0 : 1);
}

if (upstreamConfigOnly) {
  const upstreamConfig = await verifyUpstreamConfigActualMouseClick().catch((error) => ({
    ok: false,
    phase: "upstream-config-exception",
    error: error?.message || String(error),
    usedRealTraffic: false,
  }));
  await cleanupInjectedBridges();
  ws.close();
  releaseManagerButtonLock(managerButtonLock);
  emitEvidenceReport("manager-upstream-protocol", {
    ok: upstreamConfig.ok === true,
    port,
    target: { id: target.id, title: target.title, url: target.url },
    ...evidenceIdentity,
    upstreamConfig,
  });
  process.exit(upstreamConfig.ok ? 0 : 1);
}

if (closeOnly) {
  const closeActualMouse = await verifyCloseButtonActualMouseClick().catch((error) => ({
    ok: false,
    phase: "actual-click-exception",
    error: error?.message || String(error),
  }));
  await cleanupInjectedBridges();
  ws.close();
  releaseManagerButtonLock(managerButtonLock);
  emitEvidenceReport("manager-close-actual-mouse", {
    ok: closeActualMouse.ok === true,
    port,
    target: { id: target.id, title: target.title, url: target.url },
    ...evidenceIdentity,
    closeActualMouse,
    finalOverlayClosed: closeActualMouse.finalOverlayClosed === true
  });
  process.exit(closeActualMouse.ok ? 0 : 1);
}

if (actions.length > 1) {
  const output = await runManagerActionBatch(actions);
  if (uiOnlyBatchMode) {
    const batchBeforeRestore = await evaluate(uiOnlyBatchEvidenceSource(), 5000).catch((error) => ({ installed: false, error: error?.message || String(error) }));
    const batchIdle = await waitForUiOnlyBatchIdle();
    const batchRestore = batchIdle.ok
      ? await evaluate(cleanupUiOnlyBatchBridgeSource(true), 5000).catch((error) => ({ restored: false, error: error?.message || String(error) }))
      : { restored: false, safeBridgeRetained: true, error: batchIdle.error };
    const trafficAfter = await nativeRequestSnapshotSafe();
    const managerLogAfter = await waitForManagerBridgeLogStable();
    const nativeRequestDelta = nonNegativeDelta(trafficAfter, uiOnlyTrafficBefore, "requestCount");
    const managerActionDelta = nonNegativeDelta(managerLogAfter, uiOnlyManagerLogBefore, "actionReceivedCount");
    const managerRequestDelta = nonNegativeDelta(managerLogAfter, uiOnlyManagerLogBefore, "requestReceivedCount");
    const managerNonHealthRequestDelta = nonNegativeDelta(
      managerLogAfter,
      uiOnlyManagerLogBefore,
      "nonHealthRequestReceivedCount",
    );
    const stubbedActionNames = [...new Set((batchBeforeRestore.actionCalls || []).map((entry) => String(entry?.action || "")).filter(Boolean))];
    const missingStubbedActions = actions.filter((actionName) => !stubbedActionNames.includes(actionName));
    const queueUnchanged = Number(batchBeforeRestore.currentQueueLength) === Number(batchBeforeRestore.baselineQueueLength)
      && Number(batchBeforeRestore.currentPromiseCount) === Number(batchBeforeRestore.baselinePromiseCount);
    output.usedRealTraffic = nativeRequestDelta === null ? null : nativeRequestDelta > 0;
    output.zeroSideEffects = batchBeforeRestore.installed === true
      && batchBeforeRestore.actionShimActive === true
      && batchBeforeRestore.requestShimActive === true
      && batchIdle.ok === true
      && batchRestore.restored === true
      && queueUnchanged
      && missingStubbedActions.length === 0
      && managerActionDelta === 0
      && managerNonHealthRequestDelta === 0
      && nativeRequestDelta === 0;
    output.isolationEvidence = {
      batchBeforeRestore,
      batchIdle,
      batchRestore,
      stubbedActionNames,
      missingStubbedActions,
      queueUnchanged,
      traffic: { before: uiOnlyTrafficBefore, after: trafficAfter, requestDelta: nativeRequestDelta },
      managerBridgeLog: {
        before: uiOnlyManagerLogBefore,
        after: managerLogAfter,
        actionReceivedDelta: managerActionDelta,
        requestReceivedDelta: managerRequestDelta,
        nonHealthRequestReceivedDelta: managerNonHealthRequestDelta,
      },
    };
    output.ok = output.ok === true && output.zeroSideEffects === true && output.usedRealTraffic === false;
  }
  await cleanupInjectedBridges();
  ws.close();
  releaseManagerButtonLock(managerButtonLock);
  console.log(asciiJson(compactManagerButtonOutput(output), compact ? 0 : 2));
  if (!output.ok) process.exit(1);
  process.exit(0);
}

const closeActualMouse = await verifyCloseButtonActualMouseClick().catch((error) => ({
  ok: false,
  phase: "actual-click-exception",
  error: error?.message || String(error),
}));
if (!closeActualMouse.ok) {
  await cleanupInjectedBridges();
  ws.close();
  releaseManagerButtonLock(managerButtonLock);
  console.log(asciiJson({ ok: false, port, target: { id: target.id, title: target.title, url: target.url }, closeActualMouse }, compact ? 0 : 2));
  process.exit(1);
}

const safeAction = JSON.stringify(action);
const simulatePendingReopenBridge = simulatePendingReopen ? `
  {
    const originalAction = window.__ANTICODEX_RUN_MANAGER_ACTION__;
    window.__ANTICODEX_PENDING_REOPEN_TEST__ = { calls: 0, action: ${safeAction} };
    window.__ANTICODEX_RUN_MANAGER_ACTION__ = (requestedAction) => {
      if (requestedAction !== ${safeAction}) {
        return typeof originalAction === "function" ? originalAction(requestedAction) : Promise.resolve({ ok: true, action: requestedAction });
      }
      window.__ANTICODEX_PENDING_REOPEN_TEST__.calls += 1;
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: true,
          action: requestedAction,
          result: {
            ok: true,
            skills: { count: 100 },
            connectors: { count: 1494 },
          },
        }), 1200);
      });
    };
  }
` : "";
const initial = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  document.querySelector("#anticodex-manager-overlay")?.remove();
  if (typeof window.__ANTICODEX_OPEN_MANAGER__ !== "function") {
    return { ok: false, error: "open manager missing", selectedContextId: ${JSON.stringify(pageContextId)} };
  }
  const openPromise = window.__ANTICODEX_OPEN_MANAGER__();
  const deadline = Date.now() + 10000;
  let overlay = null;
  let button = null;
  let result = null;
  do {
    overlay = document.querySelector("#anticodex-manager-overlay");
    button = overlay?.querySelector('button[data-action=' + ${safeAction} + ']') || null;
    result = overlay?.querySelector('[data-anticodex-result="action"]') || null;
    if (button && typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ === "function") break;
    await Promise.race([
      Promise.resolve(openPromise).catch(() => undefined),
      sleep(100),
    ]);
  } while (Date.now() < deadline);
  await Promise.resolve(openPromise).catch(() => undefined);
  overlay = document.querySelector("#anticodex-manager-overlay");
  button = overlay?.querySelector('button[data-action=' + ${safeAction} + ']') || null;
  result = overlay?.querySelector('[data-anticodex-result="action"]') || null;
  if (!overlay) return { ok: false, error: "overlay missing", selectedContextId: ${JSON.stringify(pageContextId)} };
  if (!button) {
    return {
      ok: false,
      error: "button missing",
      selectedContextId: ${JSON.stringify(pageContextId)},
      action: ${safeAction},
      actionCount: overlay.querySelectorAll("button[data-action]").length,
      text: overlay.textContent || "",
    };
  }
  if (typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ !== "function") {
    return { ok: false, error: "bridge missing", selectedContextId: ${JSON.stringify(pageContextId)}, text: overlay.textContent || "" };
  }
  button.closest("details")?.setAttribute("open", "");
  const closeButton = overlay.querySelector('[data-anticodex-close="true"]');
  const closeRect = closeButton?.getBoundingClientRect();
  const closeProbePoints = closeRect ? [
    [closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2, "center"],
    [closeRect.left + 8, closeRect.top + 8, "top-left"],
    [closeRect.right - 8, closeRect.top + 8, "top-right"],
    [closeRect.left + 8, closeRect.bottom - 8, "bottom-left"],
    [closeRect.right - 8, closeRect.bottom - 8, "bottom-right"],
  ] : [];
  const closeHitResults = closeProbePoints.map(([x, y, name]) => {
    const target = document.elementFromPoint(x, y);
    return { name, hit: !!target?.closest?.('[data-anticodex-close="true"]'), target: target?.tagName || "", text: target?.textContent || "" };
  });
  const closeHitAreaOk = closeHitResults.length === 5 && closeHitResults.every((item) => item.hit);
  if (!closeHitAreaOk) {
    return {
      ok: false,
      error: "close button visual hit area is misaligned",
      selectedContextId: ${JSON.stringify(pageContextId)},
      closeHitResults,
    };
  }
  button.scrollIntoView({ block: "center", inline: "nearest" });
  await sleep(20);
  const rect = button.getBoundingClientRect();
  const actionCenterX = rect.left + rect.width / 2;
  const actionCenterY = rect.top + rect.height / 2;
  const actionCenterTarget = document.elementFromPoint(actionCenterX, actionCenterY);
  const actionCenterHitsButton = !!actionCenterTarget?.closest?.('button[data-action=' + ${safeAction} + ']');
  if (!actionCenterHitsButton) {
    return {
      ok: false,
      error: "action button center point does not hit the requested button",
      selectedContextId: ${JSON.stringify(pageContextId)},
      action: ${safeAction},
      actionCenterX,
      actionCenterY,
      actionCenterTarget: actionCenterTarget?.tagName || "",
      actionCenterTargetText: actionCenterTarget?.textContent || "",
    };
  }
  ${realBridgeSource(!uiOnlyMode && !upstreamConfigOnly && !closeOnly)}
  ${simulatePendingReopenBridge}
  if (!${JSON.stringify(uiOnlyMode)}) {
    delete window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    if (result) result.textContent = ${JSON.stringify(REFRESHED_TEXT)};
  }
  ${uiOnlyBridgeSource(action)}
  return {
    ok: true,
    selectedContextId: ${JSON.stringify(pageContextId)},
    version: window.__ANTICODEX_MANAGER_VERSION__,
    bridgeReady: window.__ANTICODEX_MANAGER_BRIDGE_READY__ === true,
    label: button.textContent || "",
    actionCenterHitsButton,
    closeHitAreaOk,
    closeHitResults,
    disabled: button.disabled === true,
    disabledCount: Array.from(overlay.querySelectorAll("button[data-action]")).filter((item) => item.disabled).length,
    actionCount: overlay.querySelectorAll("button[data-action]").length,
    busyAttr: overlay.querySelector(".anticodex-actions")?.getAttribute("data-anticodex-busy") || "",
    runningMarker: result?.getAttribute("data-anticodex-running") || "",
    queueLength: Array.isArray(window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__.length : null,
    pendingCount: Object.keys(window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__ || {}).length,
    text: result?.textContent || "",
  };
})()
`, 12000);
const actionActualMouse = initial.ok
  ? await dispatchManagerActionActualMouse(action)
  : { ok: false, action, error: initial.error || "Manager action setup failed" };
initial.actionActualMouse = actionActualMouse;
if (!actionActualMouse.ok) initial.ok = false;
const pageTargetsAfterManagerOpen = await getJson(`http://127.0.0.1:${port}/json`).catch(() => []);
initial.closeActualMouseOk = closeActualMouse.ok === true;
initial.closeActualMouse = closeActualMouse;
const managerOpenedNewPage = pageTargetsAfterManagerOpen.some((item) => {
  if (item?.type !== "page") return false;
  const haystack = `${item.url || ""}\n${item.title || ""}`;
  return /\/anticodex\/manager(?:\/open)?(?:[?#]|$)|anticodex-manager-open/i.test(haystack);
});

if (simulatePendingReopen) {
  await sleep(350);
  const pendingAndClose = await evaluate(`(() => {
    const overlay = document.querySelector("#anticodex-manager-overlay");
    const result = overlay?.querySelector('[data-anticodex-result="action"]');
    const pendingActions = window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ || {};
    const closeButton = overlay?.querySelector('[data-anticodex-close="true"]');
    const closeRect = closeButton?.getBoundingClientRect();
    const closeCenterX = closeRect ? closeRect.left + closeRect.width / 2 : 0;
    const closeCenterY = closeRect ? closeRect.top + closeRect.height / 2 : 0;
    const closeCenterTarget = closeRect ? document.elementFromPoint(closeCenterX, closeCenterY) : null;
    const closeCenterHitsButton = !!closeCenterTarget?.closest?.('[data-anticodex-close="true"]');
    if (closeCenterHitsButton) {
      closeCenterTarget.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: closeCenterX,
        clientY: closeCenterY,
      }));
    }
    return {
      pendingText: result?.textContent || "",
      pendingRecord: window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ || null,
      pendingStartedAt: Number(pendingActions[${safeAction}] || 0),
      closeCenterHitsButton,
    };
  })()`, 2500);
  await sleep(100);
  const closed = await evaluate(`(() => ({ overlayClosed: !document.querySelector("#anticodex-manager-overlay") }))()`, 1000);
  await evaluate(`(() => {
    if (typeof window.__ANTICODEX_OPEN_MANAGER__ === "function") window.__ANTICODEX_OPEN_MANAGER__();
    return { openCalled: true };
  })()`, 1000);
  await sleep(300);
  const reopened = await evaluate(`(() => {
    const overlay = document.querySelector("#anticodex-manager-overlay");
    const result = overlay?.querySelector('[data-anticodex-result="action"]');
    return {
      reopenedOverlayPresent: Boolean(overlay),
      reopenedText: result?.textContent || "",
    };
  })()`, 2500);
  await sleep(1500);
  const late = await evaluate(`(() => {
    const overlay = document.querySelector("#anticodex-manager-overlay");
    const result = overlay?.querySelector('[data-anticodex-result="action"]');
    return {
      lateText: result?.textContent || window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__?.managerSummary || "",
      lateRecord: window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ || null,
      calls: window.__ANTICODEX_PENDING_REOPEN_TEST__?.calls || 0,
    };
  })()`, 2500);
  const pendingReopen = { ...pendingAndClose, ...closed, ...reopened, ...late };
  await cleanupInjectedBridges();
  ws.close();
  releaseManagerButtonLock(managerButtonLock);
  const actionStarted = Boolean(initial.ok)
    && (initial.busyAttr === "true"
      || initial.runningMarker === action
      || initial.disabledCount >= initial.actionCount
      || isRunningText(initial.text || ""));
  const ok = Boolean(initial.ok)
    && actionStarted
    && initial.actionCenterHitsButton === true
    && initial.closeHitAreaOk === true
    && managerOpenedNewPage === false
    && pendingReopen.pendingRecord?.pending === true
    && pendingReopen.pendingRecord?.action === action
    && pendingReopen.pendingStartedAt > 0
    && pendingReopen.closeCenterHitsButton === true
    && pendingReopen.overlayClosed === true
    && pendingReopen.reopenedOverlayPresent === true
    && pendingReopen.reopenedText.includes("\u5df2\u63d0\u4ea4")
    && pendingReopen.lateRecord?.pending === false
    && pendingReopen.lateRecord?.action === action
    && pendingReopen.lateText === pendingReopen.lateRecord?.managerSummary
    && hasActionSpecificResult(action, pendingReopen.lateText)
    && pendingReopen.calls === 1;
  const summarizeRecord = (record) => record ? {
    ok: record.ok,
    action: record.action,
    pending: record.pending,
    managerSummary: record.managerSummary,
  } : null;
  const compactPendingReopen = {
    ...pendingReopen,
    pendingRecord: summarizeRecord(pendingReopen.pendingRecord),
    lateRecord: summarizeRecord(pendingReopen.lateRecord),
  };
  console.log(asciiJson({
    ok,
    port,
    target: { id: target.id, title: target.title, url: target.url },
    result: { action, label: initial.label, initial, pendingReopen: compactPendingReopen },
    managerOpenedNewPage,
    pageTargetCountBeforeManagerOpen: pageTargetsBeforeManagerOpen.filter((item) => item?.type === "page").length,
    pageTargetCountAfterManagerOpen: pageTargetsAfterManagerOpen.filter((item) => item?.type === "page").length,
  }, compact ? 0 : 2));
  if (!ok) process.exit(1);
  process.exit(0);
}

let latest = initial;
let actionSnapshot = null;
const deadline = Date.now() + timeoutMs;
let drainedPayloads = await drainManagerActionQueue();
const initialUiOnlyFinished = uiOnlyMode
  && !isRunningText(initial.text || "")
  && !isFailureText(initial.text || "")
  && isFinishedText(initial.text || "")
  && hasActionSpecificResult(action, initial.text || "");
function remainingActionTimeoutMs() {
  const remaining = deadline - Date.now();
  return Math.max(250, Math.min(2500, remaining));
}
while (initial.ok && Date.now() < deadline) {
  await sleep(Math.min(500, Math.max(50, deadline - Date.now())));
  if (Date.now() >= deadline) break;
  drainedPayloads = { ...drainedPayloads, ...(await drainManagerActionQueue()) };
  latest = await evaluate(`(() => {
    const overlay = document.querySelector("#anticodex-manager-overlay");
    const button = overlay?.querySelector('button[data-action=' + ${safeAction} + ']');
    const result = overlay?.querySelector('[data-anticodex-result="action"]');
    const lastActionResult = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ || null;
    return {
      selectedContextId: ${JSON.stringify(pageContextId)},
      version: window.__ANTICODEX_MANAGER_VERSION__,
      bridgeReady: window.__ANTICODEX_MANAGER_BRIDGE_READY__ === true,
      overlayPresent: Boolean(overlay),
      buttonPresent: Boolean(button),
      resultPresent: Boolean(result),
      disabled: button?.disabled === true,
      runningMarker: result?.getAttribute("data-anticodex-running") || "",
      queueLength: Array.isArray(window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__.length : null,
      pendingCount: Object.keys(window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__ || {}).length,
      lastAction: lastActionResult?.action || "",
      lastOk: lastActionResult?.ok,
      lastUiOnly: lastActionResult?.uiOnly === true,
      lastSummary: lastActionResult?.managerSummary || "",
      text: result?.textContent || lastActionResult?.managerSummary || "",
    };
  })()`, remainingActionTimeoutMs());
  const latestText = latest.lastSummary || latest.text || "";
  if (latest.lastAction === action && hasActionSpecificResult(action, latestText)) {
    actionSnapshot = {
      ...latest,
      text: latestText,
    };
  }
  const actionSettled = latest.lastAction === action
    && Number(latest.pendingCount || 0) === 0
    && Number(latest.queueLength || 0) === 0;
  const terminalFailure = actionSettled
    && (latest.lastOk === false || isFailureText(latestText));
  const visibleFinished = !latest.disabled
    && !isRunningText(latestText)
    && !isFailureText(latestText)
    && isFinishedText(latestText)
    && (uiOnlyMode || !isUiOnlySmokeText(latestText))
    && hasActionSpecificResult(action, latestText);
  const uiOnlyFinished = uiOnlyMode
    && !latest.disabled
    && !isRunningText(latestText)
    && !isFailureText(latestText)
    && isFinishedText(latestText)
    && hasActionSpecificResult(action, latestText);
  const isFastMode = !uiOnlyMode && action === "mcpSkills" && timeoutMs <= 15000;
  const drainedPayload = drainedPayloads[action];
  const drainedText = drainedPayload ? managerSummaryFromActionPayload(action, drainedPayload) : "";
  const drainedFinished = drainedPayload?.ok !== false
    && !isRunningText(drainedText)
    && !isFailureText(drainedText)
    && isFinishedText(drainedText)
    && (uiOnlyMode || !isUiOnlySmokeText(drainedText))
    && hasActionSpecificResult(action, drainedText);
  if (terminalFailure || drainedPayload?.ok === false) {
    break;
  } else if (uiOnlyFinished) {
    break;
  } else if (drainedFinished) {
    latest = {
      ...latest,
      lastAction: action,
      lastOk: drainedPayload.ok,
      lastUiOnly: drainedPayload.uiOnly === true,
      lastSummary: drainedText,
      text: drainedText,
    };
    break;
  } else if (isFastMode) {
    const started = latest.disabled || latest.runningMarker === action || isRunningText(latestText);
    const settledAndOk = actionSettled && !latest.disabled && !isRunningText(latestText) && isFinishedText(latestText) && hasActionSpecificResult(action, latestText);
    if (started || settledAndOk) break;
  } else {
    if (actionSettled && visibleFinished) break;
  }
}
await cleanupInjectedBridges();
ws.close();
releaseManagerButtonLock(managerButtonLock);

const drainedPayload = drainedPayloads[action];
const drainedText = drainedPayload ? managerSummaryFromActionPayload(action, drainedPayload) : "";
if (actionSnapshot && latest.lastAction !== action) {
  latest = {
    ...latest,
    ...actionSnapshot,
  };
}
const fallbackActionText = actionSnapshot?.text || latest.lastSummary || latest.text || "";
const text = drainedPayload?.ok !== false && drainedText && hasActionSpecificResult(action, drainedText)
  ? drainedText
  : fallbackActionText;
const uiOnlyFinished = uiOnlyMode
  && !latest.disabled
  && !isRunningText(text)
  && !isFailureText(text)
  && isFinishedText(text)
  && hasActionSpecificResult(action, text);
const actionStarted = Boolean(initial.ok)
  && ((uiOnlyMode && initialUiOnlyFinished)
    || uiOnlyFinished
    || latest.lastAction === action
    || Boolean(drainedPayload)
    || initial.busyAttr === "true"
    || initial.runningMarker === action
    || initial.disabledCount >= initial.actionCount
    || isRunningText(initial.text || ""));
const isFastMode = !uiOnlyMode && action === "mcpSkills" && timeoutMs <= 15000;
const visibleFinished = !latest.disabled
  && !isRunningText(text)
  && !isFailureText(text)
  && isFinishedText(text)
  && (uiOnlyMode || !isUiOnlySmokeText(text))
  && hasActionSpecificResult(action, text);
const explicitActionSuccess = visibleFinished
  && (latest.lastAction === action || Boolean(drainedPayload))
  && latest.lastOk !== false
  && drainedPayload?.ok !== false;
const ok = Boolean(initial.ok)
  && actionStarted
  && initial.closeHitAreaOk === true
  && initial.closeActualMouseOk === true
  && managerOpenedNewPage === false
  && ((uiOnlyMode && initialUiOnlyFinished) || uiOnlyFinished
    ? true
    : isFastMode
    ? !isFailureText(text)
    : (explicitActionSuccess
      || (latest.lastAction === action
        && Number(latest.pendingCount || 0) === 0
        && Number(latest.queueLength || 0) === 0
        && latest.lastOk !== false
        && visibleFinished))
  );

const output = {
  ok,
  port,
  target: { id: target.id, title: target.title, url: target.url },
  result: { ...latest, lastUiOnly: uiOnlyMode || latest.lastUiOnly === true, action, label: initial.label, initialText: initial.text, text, initial },
  managerOpenedNewPage,
  pageTargetCountBeforeManagerOpen: pageTargetsBeforeManagerOpen.filter((item) => item?.type === "page").length,
  pageTargetCountAfterManagerOpen: pageTargetsAfterManagerOpen.filter((item) => item?.type === "page").length,
};
console.log(asciiJson(compactManagerButtonOutput(output), compact ? 0 : 2));
if (!ok) process.exit(1);
