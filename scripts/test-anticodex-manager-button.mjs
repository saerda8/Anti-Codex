#!/usr/bin/env node
import crypto from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const ports = String(args.get("--ports") || args.get("--port") || "58318,58317").split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
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
  "\u5df2\u662f\u6700\u65b0",
  "\u53d1\u73b0\u65b0\u7248",
  "\u901a\u8fc7",
  "\u5b8c\u6210",
  "\u9700\u8981\u5904\u7406",
];

function isRunningText(text) {
  return text.includes(RUNNING_TEXT) || text.includes("\u4ecd\u5728\u8fd0\u884c") || text.includes("\u6536\u5c3e");
}

function isFailureText(text) {
  return text.includes(FAILURE_TEXT) || /timed out|bridge failed|Action bridge failed/i.test(text);
}

function isFinishedText(text) {
  return Boolean(text)
    && !text.includes(REFRESHED_TEXT)
    && !text.includes(READ_FAILED_TEXT)
    && !text.includes("\u4ecd\u5728\u8fd0\u884c")
    && !text.includes("\u6536\u5c3e")
    && FINISHED_HINTS.some((hint) => text.includes(hint));
}

function hasActionSpecificResult(actionName, text) {
  if (actionName === "fastOverallNoTraffic") return text.includes("\u5feb\u901f\u68c0\u67e5") && text.includes("\u8017\u65f6");
  if (actionName === "syncReadiness") return text.includes("\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5") && text.includes("\u901a\u8fc7");
  if (actionName === "updateCheck") return text.includes("Codex \u66f4\u65b0\u68c0\u67e5") && (text.includes("\u5df2\u662f\u6700\u65b0") || text.includes("\u53d1\u73b0\u65b0\u7248"));
  if (actionName === "sourcePreflight") return text.includes("\u6e90\u7801\u9884\u68c0") && text.includes("\u8017\u65f6");
  if (actionName === "pluginCapabilities") return text.includes("\u6e05\u5355\u53ef\u89c1") && text.includes("\u53ef\u8c03\u7528\u9a8c\u8bc1");
  if (actionName === "mcpSkills") return text.includes("MCP/Skill") && text.includes("\u6e05\u5355\u53ef\u89c1") && text.includes("\u771f\u5b9e\u5de5\u5177\u8c03\u7528");
  if (actionName === "refreshFeatures") return text.includes("\u672c\u5730\u529f\u80fd\u5237\u65b0") && text.includes("\u53ef\u8c03\u7528\u9a8c\u8bc1");
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
  };
  const payload = payloadByAction[actionName] || { ok: true, action: actionName, uiOnly: true, result: { ok: true } };
  return `
  window.__ANTICODEX_MANAGER_BUTTON_REAL_BRIDGE__ = window.__ANTICODEX_RUN_MANAGER_ACTION__;
  window.__ANTICODEX_RUN_MANAGER_ACTION__ = (requestedAction) => Promise.resolve({
    ...${JSON.stringify(payload)},
    action: requestedAction,
  });
`;
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
  const rect = button.getBoundingClientRect();
  const actionCenterX = rect.left + rect.width / 2;
  const actionCenterY = rect.top + rect.height / 2;
  const actionCenterTarget = document.elementFromPoint(actionCenterX, actionCenterY);
  const actionCenterHitsButton = !!actionCenterTarget?.closest?.('button[data-action=' + ${safeActionName} + ']');
  if (!actionCenterHitsButton) return { ok: false, error: "action button center point does not hit the requested button" };
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
    actionCenterHitsButton,
    label: button.textContent || "",
    initialText: result.textContent || "",
  };
})()
`, 12000);

    let latest = initial;
    const deadline = Date.now() + Math.min(timeoutMs, 12000);
    while (initial.ok && Date.now() < deadline) {
      await sleep(100);
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
          queueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : null,
          pendingCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
          lastAction: lastActionResult?.action || "",
          lastOk: lastActionResult?.ok,
          lastPending: lastActionResult?.pending,
          lastUiOnly: lastActionResult?.uiOnly === true,
          lastSummary: lastActionResult?.managerSummary || "",
          text: result?.textContent || lastActionResult?.managerSummary || "",
        };
      })()`, Math.max(250, Math.min(2500, deadline - Date.now())));
      const text = latest.text || latest.lastSummary || "";
      const settled = latest.lastAction === actionName
        && latest.lastPending !== true
        && Number(latest.pendingCount || 0) === 0
        && Number(latest.queueLength || 0) === 0
        && latest.disabled !== true;
      const uiOnlyFinished = uiOnlyMode
        && !latest.disabled
        && !isRunningText(text)
        && !isFailureText(text)
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
        if (settled && !isRunningText(text) && isFinishedText(text) && hasActionSpecificResult(actionName, text)) break;
      }
    }
    const text = latest.text || latest.lastSummary || "";
    const settled = latest.lastAction === actionName
      && latest.lastPending !== true
      && Number(latest.pendingCount || 0) === 0
      && Number(latest.queueLength || 0) === 0
      && latest.disabled !== true;
    const uiOnlyFinished = uiOnlyMode
      && !latest.disabled
      && !isRunningText(text)
      && !isFailureText(text)
      && isFinishedText(text)
      && hasActionSpecificResult(actionName, text);
    const isFastMode = !uiOnlyMode && actionName === "mcpSkills" && timeoutMs <= 15000;
    const ok = initial.ok === true
      && (uiOnlyFinished || isFastMode || settled)
      && initial.closeCenterHitsButton === true
      && initial.closeUpperCenterHitsButton === true
      && initial.closeLowerCenterHitsButton === true
      && initial.actionCenterHitsButton === true
      && (uiOnlyFinished ? true : isFastMode ? !isFailureText(text) : (latest.lastOk !== false
        && !isRunningText(text)
        && !isFailureText(text)
        && isFinishedText(text)
        && hasActionSpecificResult(actionName, text)));
    results[actionName] = {
      ok,
      port,
      target: { id: target.id, title: target.title, url: target.url },
      result: { ...latest, lastUiOnly: uiOnlyMode || latest.lastUiOnly === true, action: actionName, label: initial.label, initialText: initial.initialText, text, initial },
    };
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
  ${simulatePendingReopenBridge}
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
    queueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : null,
    pendingCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
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
      queueLength: Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__) ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length : null,
      pendingCount: Object.keys(window.__ANTICODEX_MANAGER_ACTION_PROMISES__ || {}).length,
      lastAction: lastActionResult?.action || "",
      lastUiOnly: lastActionResult?.uiOnly === true,
      lastSummary: lastActionResult?.managerSummary || "",
      text: result?.textContent || lastActionResult?.managerSummary || "",
    };
  })()`, remainingActionTimeoutMs());
  const latestText = latest.text || "";
  const actionSettled = latest.lastAction === action
    && Number(latest.pendingCount || 0) === 0
    && Number(latest.queueLength || 0) === 0;
  const uiOnlyFinished = uiOnlyMode
    && !latest.disabled
    && !isRunningText(latestText)
    && !isFailureText(latestText)
    && isFinishedText(latestText)
    && hasActionSpecificResult(action, latestText);
  const isFastMode = !uiOnlyMode && action === "mcpSkills" && timeoutMs <= 15000;
  if (uiOnlyFinished) {
    break;
  } else if (isFastMode) {
    const started = latest.disabled || latest.runningMarker === action || isRunningText(latestText);
    const settledAndOk = actionSettled && !latest.disabled && !isRunningText(latestText) && isFinishedText(latestText) && hasActionSpecificResult(action, latestText);
    if (started || settledAndOk) break;
  } else {
    if (actionSettled && !latest.disabled && !isRunningText(latestText) && isFinishedText(latestText) && hasActionSpecificResult(action, latestText)) break;
  }
}
ws.close();
releaseManagerButtonLock(managerButtonLock);

const text = latest.text || "";
const uiOnlyFinished = uiOnlyMode
  && !latest.disabled
  && !isRunningText(text)
  && !isFailureText(text)
  && isFinishedText(text)
  && hasActionSpecificResult(action, text);
const actionStarted = Boolean(initial.ok)
  && (initialUiOnlyFinished
    || uiOnlyFinished
    || initial.busyAttr === "true"
    || initial.runningMarker === action
    || initial.disabledCount >= initial.actionCount
    || isRunningText(initial.text || ""));
const isFastMode = !uiOnlyMode && action === "mcpSkills" && timeoutMs <= 15000;
const ok = Boolean(initial.ok)
  && actionStarted
  && initial.closeHitAreaOk === true
  && managerOpenedNewPage === false
  && (initialUiOnlyFinished || uiOnlyFinished
    ? true
    : isFastMode
    ? !isFailureText(text)
    : (latest.lastAction === action
      && Number(latest.pendingCount || 0) === 0
      && Number(latest.queueLength || 0) === 0
      && !latest.disabled
      && !isRunningText(text)
      && !isFailureText(text)
      && isFinishedText(text)
      && hasActionSpecificResult(action, text))
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
