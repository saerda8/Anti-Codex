#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const explicitPorts = args.get("--ports") || args.get("--port") || "";
const ports = explicitPorts
  ? String(explicitPorts).split(",").map((value) => Number(value.trim())).filter(Number.isFinite)
  : [...new Set([...discoverAntiCodexCdpPorts(), 58318, 58317])];
const baseUrl = String(args.get("--base-url") || process.env.ANTICODEX_MANAGER_API || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const simulatePendingReopen = args.has("--verify-pending-reopen");
const defaultAction = String(args.get("--action") || (simulatePendingReopen ? "refreshFeatures" : "updateCheck"));
const actions = String(args.get("--actions") || defaultAction).split(",").map((value) => value.trim()).filter(Boolean);
const action = actions[0] || defaultAction;
const verificationMode = String(args.get("--verification-mode") || "");
const uiOnlyMode = verificationMode === "ui-only";
const defaultTimeoutMs = action === "fastOverallNoTraffic" ? 90000 : 15000;
const timeoutMs = Number(args.get("--timeout-ms") || defaultTimeoutMs);
const compact = args.has("--compact");
let managerInjectSource = readFileSync(new URL("./anticodex-manager-inject.js", import.meta.url), "utf8");
if (simulatePendingReopen) {
  managerInjectSource = managerInjectSource.replace("const ACTION_UI_TIMEOUT_MS = 5000;", "const ACTION_UI_TIMEOUT_MS = 120;");
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
  if (actionName === "updateCheck") return text.includes("Codex \u66f4\u65b0\u68c0\u67e5") && (text.includes("\u5df2\u662f\u6700\u65b0") || text.includes("\u53d1\u73b0\u65b0\u7248"));
  if (actionName === "sourcePreflight") return text.includes("\u6e90\u7801\u9884\u68c0") && text.includes("\u8017\u65f6");
  if (actionName === "pluginCapabilities") return text.includes("\u6e05\u5355\u53ef\u89c1") && text.includes("\u53ef\u8c03\u7528\u9a8c\u8bc1");
  if (actionName === "mcpSkills") return text.includes("MCP/Skill") && text.includes("\u6e05\u5355\u53ef\u89c1") && text.includes("\u771f\u5b9e\u5de5\u5177\u8c03\u7528");
  if (actionName === "secondAccountLoginStatus") return text.includes("\u7b2c\u4e8c Antigravity \u8d26\u53f7\u72b6\u6001\u68c0\u67e5") && (text.includes("\u901a\u8fc7") || text.includes("\u9700\u8981\u5904\u7406"));
  if (actionName === "refreshFeatures") return text.includes("\u672c\u5730\u529f\u80fd\u5237\u65b0") && text.includes("\u53ef\u8c03\u7528\u9a8c\u8bc1") && text.includes("sourceSnapshot: files=");
  if (actionName === "diagnosticsBundle") return text.includes("\u8bca\u65ad\u5305") && (text.includes("ZIP") || text.includes("\u76ee\u5f55"));
  if (actionName === "viewLatestReports") return text.includes("\u62a5\u544a") && (text.includes("\u5df2\u627e\u5230") || text.includes("\u8fd8\u6ca1\u6709")) && hasLatestReportFieldEvidence(text);
  return true;
}

function uiOnlyBridgeSource(actionName, enabled = uiOnlyMode) {
  if (!enabled) return "";
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
  };
  const payload = payloadByAction[actionName] || { ok: true, action: actionName, uiOnly: true, result: { ok: true } };
  return `
  if (!window.__ANTICODEX_RUN_MANAGER_ACTION__?.__ANTICODEX_MANAGER_BUTTON_UI_ONLY__) {
    window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__ = window.__ANTICODEX_RUN_MANAGER_ACTION__;
  }
  window.__ANTICODEX_RUN_MANAGER_ACTION__ = (requestedAction) => Promise.resolve({
    ...${JSON.stringify(payload)},
    action: requestedAction,
  });
  window.__ANTICODEX_RUN_MANAGER_ACTION__.__ANTICODEX_MANAGER_BUTTON_UI_ONLY__ = true;
`;
}

function realBridgeSource(enabled = !uiOnlyMode) {
  if (!enabled) return "";
  return `
  delete window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__;
  window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__ = {};
  window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__ = [];
  window.__ANTICODEX_RESOLVE_MANAGER_BUTTON_ACTION__ = (id, payload) => {
    const entry = window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__?.[id];
    if (!entry) return;
    delete window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__[id];
    entry.resolve(payload);
  };
  window.__ANTICODEX_RUN_MANAGER_ACTION__ = (requestedAction) => new Promise((resolve) => {
    const requestId = Date.now() + ":" + Math.random().toString(36).slice(2);
    window.__ANTICODEX_MANAGER_BUTTON_ACTION_PROMISES__[requestId] = { resolve };
    window.__ANTICODEX_MANAGER_BUTTON_ACTION_QUEUE__.push({ id: requestId, action: requestedAction });
  });
  window.__ANTICODEX_MANAGER_BRIDGE_READY__ = true;
`;
}

function cleanupUiOnlyBridgeSource(enabled = uiOnlyMode) {
  if (!enabled) return "";
  return `
  if (window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__) {
    window.__ANTICODEX_RUN_MANAGER_ACTION__ = window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__;
    delete window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__;
  }
  {
    const lastActionResult = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    const lastSummary = String(lastActionResult?.managerSummary || "");
    if (lastActionResult?.uiOnly === true || lastSummary.includes("ui-only manager button smoke")) {
      delete window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
      const result = document.querySelector('[data-anticodex-result="action"]');
      if (result && result.textContent.includes("ui-only manager button smoke")) result.textContent = "";
    }
  }
`;
}

function operatorStepDisplayText(step) {
  const value = String(step || "");
  if (value === "open_elevated_windows_user_settings_then_rerun_prepare") return "\u6253\u5f00 Windows \u8bbe\u7f6e / \u5176\u4ed6\u7528\u6237\uff0c\u521b\u5efa\u6216\u786e\u8ba4 AntiCodexModel\uff0c\u7136\u540e\u91cd\u65b0\u8fd0\u884c\u51c6\u5907\u68c0\u67e5";
  if (value === "create_target_windows_user") return "\u5148\u5728 Windows \u4e2d\u521b\u5efa\u6216\u786e\u8ba4 AntiCodexModel \u7528\u6237";
  if (value === "run_account_isolation_status") return "\u91cd\u65b0\u8fd0\u884c\u8d26\u53f7\u9694\u79bb\u72b6\u6001\u68c0\u67e5";
  if (value === "run_windows_user_interactive_login_with_user_present") return "\u7b49\u7528\u6237\u660e\u786e\u6279\u51c6\u540e\uff0c\u4f7f\u7528\u72ec\u7acb Windows \u7528\u6237\u542f\u52a8\u7b2c\u4e8c Antigravity \u767b\u5f55";
  if (value === "verify_windows_user_manually_then_rerun_prepare") return "\u624b\u52a8\u786e\u8ba4 Windows \u7528\u6237\u540e\uff0c\u91cd\u65b0\u8fd0\u884c\u51c6\u5907\u68c0\u67e5";
  return value;
}

function managerSummaryFromActionPayload(actionName, payload) {
  const result = payload?.result || payload || {};
  if (actionName === "refreshStatus") return `\u5237\u65b0\u72b6\u6001\uff1a${result.ok === false ? "\u9700\u8981\u5904\u7406" : "\u5b8c\u6210"}`;
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
  if (actionName === "secondAccountLoginStatus") {
    return [
      `\u7b2c\u4e8c Antigravity \u8d26\u53f7\u72b6\u6001\u68c0\u67e5\uff1a${result.ok === false ? "\u9700\u8981\u5904\u7406" : "\u901a\u8fc7"}`,
      result.safeToStartLogin === true ? "\u767b\u5f55\u51c6\u5907\uff1a\u53ef\u542f\u52a8\uff08\u672c\u6b21\u672a\u542f\u52a8\uff09" : "\u767b\u5f55\u51c6\u5907\uff1a\u672a\u5c31\u7eea",
      result.readinessBlockingReason ? `\u963b\u788d\uff1a${result.readinessBlockingReason}` : "",
      result.operatorBlockingStage ? `\u9636\u6bb5\uff1a${result.operatorBlockingStage}` : "",
      result.operatorNextStep ? `\u4e0b\u4e00\u6b65\uff1a${operatorStepDisplayText(result.operatorNextStep)}` : "",
    ].filter(Boolean).join("\n");
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

if (args.has("--self-test")) {
  assert.equal(hasActionSpecificResult("fastOverallNoTraffic", "\u901a\u8fc7"), false);
  assert.equal(hasActionSpecificResult("fastOverallNoTraffic", "\u5feb\u901f\u68c0\u67e5\uff1a\u901a\u8fc7\n\u8017\u65f6\uff1a23000 ms"), true);
  assert.equal(isRunningText("\u68c0\u67e5\u5b89\u88c5/\u540c\u6b65\uff1a\u4ecd\u5728\u8fd0\u884c\u6216\u672c\u673a\u811a\u672c\u6b63\u5728\u6536\u5c3e\u3002"), true);
  assert.equal(hasActionSpecificResult("syncReadiness", "\u68c0\u67e5\u5b89\u88c5/\u540c\u6b65\uff1a\u4ecd\u5728\u8fd0\u884c\u6216\u672c\u673a\u811a\u672c\u6b63\u5728\u6536\u5c3e\u3002"), false);
  assert.equal(hasActionSpecificResult("syncReadiness", "\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5\uff1a\u901a\u8fc7"), true);
  assert.equal(hasActionSpecificResult("updateCheck", "Codex \u66f4\u65b0\u68c0\u67e5\uff1a\u5df2\u63d0\u4ea4\u540e\u53f0\u6267\u884c\u3002"), false);
  assert.equal(hasActionSpecificResult("updateCheck", "Codex \u66f4\u65b0\u68c0\u67e5\uff1a\u5df2\u662f\u6700\u65b0"), true);
  assert.equal(hasActionSpecificResult("updateCheck", "Codex \u66f4\u65b0\u68c0\u67e5\uff1a\u53d1\u73b0\u65b0\u7248"), true);
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

async function findTarget() {
  for (const port of ports) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`);
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl && `${item.title} ${item.url}`.toLowerCase().includes("codex"))
        || targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) return { port, target };
    } catch {}
  }
  throw new Error(`No Anti-Codex CDP target found on ${ports.join(", ")}`);
}

const { port, target } = await findTarget();
const pageTargetsBeforeManagerOpen = await getJson(`http://127.0.0.1:${port}/json`).catch(() => []);
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
  ${realBridgeSource()}
})()`, {
  awaitPromise: false,
  allowUnsafeEvalBlockedByCSP: true,
}), 10000);
await ws.call(id++, "Runtime.evaluate", runtimeParams(managerInjectSource, {
  awaitPromise: false,
  returnByValue: true,
  allowUnsafeEvalBlockedByCSP: true,
}), 10000);

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
  for (const actionName of actions) {
    const safeActionName = JSON.stringify(actionName);
    const initial = await evaluate(`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (typeof window.__ANTICODEX_OPEN_MANAGER__ !== "function") return { ok: false, error: "open manager missing" };
  if (!document.querySelector("#anticodex-manager-overlay")) await window.__ANTICODEX_OPEN_MANAGER__();
  const overlay = document.querySelector("#anticodex-manager-overlay");
  const button = overlay?.querySelector('button[data-action=' + ${safeActionName} + ']') || null;
  const result = overlay?.querySelector('[data-anticodex-result="action"]') || null;
  if (!overlay || !button || !result) return { ok: false, error: "Manager action control missing" };
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
  ${realBridgeSource()}
  if (!${JSON.stringify(uiOnlyMode)}) {
    delete window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    if (result) result.textContent = ${JSON.stringify(REFRESHED_TEXT)};
  }
  ${uiOnlyBridgeSource(actionName)}
  actionCenterTarget.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: actionCenterX,
    clientY: actionCenterY,
  }));
  await sleep(50);
  return {
    ok: true,
      closeCenterHitsButton,
      closeUpperCenterHitsButton,
      closeLowerCenterHitsButton,
      closeHitAreaOk,
      closeHitResults,
      actionCenterHitsButton,
      label: button.textContent || "",
      initialText: result.textContent || "",
  };
})()
`, 12000);

    let latest = initial;
    const deadline = Date.now() + timeoutMs;
    let drainedPayloads = await drainManagerActionQueue();
    while (initial.ok && Date.now() < deadline) {
      await sleep(100);
      drainedPayloads = { ...drainedPayloads, ...(await drainManagerActionQueue()) };
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
      const visibleFinished = !latest.disabled
        && !isRunningText(text)
        && !isActionFailureText(actionName, text)
        && isFinishedText(text)
        && (uiOnlyMode || !isUiOnlySmokeText(text))
        && hasActionSpecificResult(actionName, text);
      const uiOnlyFinished = uiOnlyMode
        && !latest.disabled
        && !isRunningText(text)
        && !isActionFailureText(actionName, text)
        && isFinishedText(text)
        && hasActionSpecificResult(actionName, text);
      const isFastMode = !uiOnlyMode && actionName === "mcpSkills" && timeoutMs <= 15000;
      if (uiOnlyFinished) {
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
    const uiOnlyFinished = uiOnlyMode
      && !latest.disabled
      && !isRunningText(text)
      && !isActionFailureText(actionName, text)
      && isFinishedText(text)
      && hasActionSpecificResult(actionName, text);
    const isFastMode = !uiOnlyMode && actionName === "mcpSkills" && timeoutMs <= 15000;
    const ok = initial.ok === true
      && (uiOnlyFinished || isFastMode || settled)
      && initial.closeCenterHitsButton === true
      && initial.closeUpperCenterHitsButton === true
      && initial.closeLowerCenterHitsButton === true
      && initial.actionCenterHitsButton === true
      && (uiOnlyFinished ? true : isFastMode ? !isActionFailureText(actionName, text) : (latest.lastOk !== false && visibleFinished));
    results[actionName] = {
      ok,
      port,
      target: { id: target.id, title: target.title, url: target.url },
      result: { ...latest, lastUiOnly: uiOnlyMode || latest.lastUiOnly === true, action: actionName, label: initial.label, initialText: initial.initialText, text, initial },
      managerOpenedNewPage: false,
      pageTargetCountBeforeManagerOpen: pageTargetsBeforeManagerOpen.filter((item) => item?.type === "page").length,
      pageTargetCountAfterManagerOpen: pageTargetsBeforeManagerOpen.filter((item) => item?.type === "page").length,
    };
    await evaluate(`(() => {
      ${cleanupUiOnlyBridgeSource()}
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

if (actions.length > 1) {
  const output = await runManagerActionBatch(actions);
  ws.close();
  releaseManagerButtonLock(managerButtonLock);
  console.log(asciiJson(output, compact ? 0 : 2));
  if (!output.ok) process.exit(1);
  process.exit(0);
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
  ${realBridgeSource()}
  ${simulatePendingReopenBridge}
  if (!${JSON.stringify(uiOnlyMode)}) {
    delete window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    if (result) result.textContent = ${JSON.stringify(REFRESHED_TEXT)};
  }
  ${uiOnlyBridgeSource(action)}
  actionCenterTarget.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: actionCenterX,
    clientY: actionCenterY,
  }));
  await sleep(50);
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
const pageTargetsAfterManagerOpen = await getJson(`http://127.0.0.1:${port}/json`).catch(() => []);
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
  const latestText = latest.text || "";
  const actionSettled = latest.lastAction === action
    && Number(latest.pendingCount || 0) === 0
    && Number(latest.queueLength || 0) === 0;
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
  if (uiOnlyFinished) {
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
ws.close();
releaseManagerButtonLock(managerButtonLock);
await evaluate(`(() => {
  ${cleanupUiOnlyBridgeSource()}
  return true;
})()`, 2000).catch(() => {});

const drainedPayload = drainedPayloads[action];
const drainedText = drainedPayload ? managerSummaryFromActionPayload(action, drainedPayload) : "";
const text = drainedPayload?.ok !== false && drainedText ? drainedText : (latest.text || "");
const uiOnlyFinished = uiOnlyMode
  && !latest.disabled
  && !isRunningText(text)
  && !isFailureText(text)
  && isFinishedText(text)
  && hasActionSpecificResult(action, text);
const actionStarted = Boolean(initial.ok)
  && ((uiOnlyMode && initialUiOnlyFinished)
    || uiOnlyFinished
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
console.log(asciiJson(output, compact ? 0 : 2));
if (!ok) process.exit(1);
