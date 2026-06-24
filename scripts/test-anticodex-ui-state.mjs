#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const port = Number(args.get("--port") || process.env.DEEPCODEX_CDP_PORT || 58318);
const baseUrl = String(args.get("--base-url") || "http://127.0.0.1:8484").replace(/\/$/, "");
const catalogPath = args.get("--catalog") || "";
const timeoutMs = Number(args.get("--timeout-ms") || 8000);
const managerProbeTimeoutMs = Math.max(1000, Number(args.get("--manager-probe-timeout-ms") || timeoutMs));
const fastUiState = /^(1|true|yes)$/i.test(String(args.get("--fast") || ""));
const skipManagerActionProbe = /^(1|true|yes)$/i.test(String(args.get("--skip-manager-action-probe") || ""));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const managerInjectSource = fs.readFileSync(new URL("./anticodex-manager-inject.js", import.meta.url), "utf8");
const managerButtonLockPath = path.join(os.tmpdir(), "anticodex-manager-button.lock");
const expectedDailyActionIds = [
  "refreshStatus", "refreshModels", "accountSwitch", "accountProxy", "syncReadiness",
  "repairShortcuts", "updateCheck", "sourcePreflight", "mcpSkills", "pluginCapabilities", "diagnosticsBundle", "viewLatestReports",
];
const expectedHighImpactActionIds = [
  "syncHost", "upstreamConfig", "resetAntigravitySessionLock", "refreshFeatures", "stabilitySoak", "coldRelaunch", "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull",
];
const mojibakePattern = /(?:缁狅紕鎮妡娣囶喖|濡偓|闁板秶鐤唡閸掗攱|韫囶偊|閺佺繝|娴狅絿鎮妡閼卞﹤|娑撳秳|锟)/;
const pageStateProbeExpression = `(() => {
  const text = String(document.body?.innerText || document.documentElement?.innerText || "");
  const reconnectPattern = /(?:Reconnecting\\.\\.\\.|reconnecting|正在重新连接|重新连接|正在重连|重连中)/i;
  const reconnectEvidence = [];
  for (const element of Array.from(document.querySelectorAll("body *")).slice(0, 2500)) {
    const value = String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
    if (value && reconnectPattern.test(value)) reconnectEvidence.push(value.slice(0, 160));
    if (reconnectEvidence.length >= 8) break;
  }
  return {
    title: document.title,
    href: location.href,
    textLength: text.length,
    textSample: text.slice(0, 6000),
    hasLoginText: !!document.querySelector("a[href*='auth/login'], form[action*='auth/login']"),
    hasReconnectText: reconnectPattern.test(text) || reconnectEvidence.length > 0,
    reconnectEvidence
  };
})()`;

function sameActionIds(actual, expected) {
  return JSON.stringify([...(actual || [])].sort()) === JSON.stringify([...expected].sort());
}

function mojibakeMatch(text) {
  return String(text || "").match(mojibakePattern)?.[0] || "";
}

function extractDelimited(source, start, end, label) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`missing ${label} start`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`missing ${label} end`);
  return source.slice(startIndex, endIndex + end.length);
}

function staticManagerUiFailures({ injectSource, serverSource }) {
  const failures = [];
  const injectMojibake = mojibakeMatch(injectSource);
  if (injectMojibake) failures.push(`in-app manager source contains mojibake text: ${injectMojibake}`);
  const dailyIndex = injectSource.indexOf('id: "daily"');
  const highImpactIndex = injectSource.indexOf('id: "high-impact"');
  if (dailyIndex < 0 || highImpactIndex < 0 || dailyIndex > highImpactIndex) {
    failures.push("in-app manager does not render daily actions before high-impact actions");
  }
  if (/id:\s*LEGACY_BUTTON_ID|id=["']anticodex-manager-button["']/.test(injectSource)) {
    failures.push("in-app manager still creates the removed floating Manager button");
  }
  if (!/data-anticodex-close/.test(injectSource) || !/min-height:44px/.test(injectSource)) {
    failures.push("in-app manager close button lacks a full-size hit target");
  }
  if (!/copyTextToClipboard/.test(injectSource) || !/anticodex-copy-result/.test(injectSource)) {
    failures.push("in-app manager is missing copy result controls");
  }
  if (!/diagnosticsSummary/.test(injectSource) || !/diagnosticsSummary/.test(serverSource) || !/longTasks/.test(injectSource) || !/longTasks/.test(serverSource)) {
    failures.push("manager page missing diagnostics bundle long-task result summary");
  }
  if (!/function snapshotStalenessNotice/.test(injectSource) || !/snapshotStatus/.test(injectSource) || !/source_changed/.test(injectSource)) {
    failures.push("in-app manager is missing local feature snapshot staleness notice");
  }
  if (!/app-tool registry:/.test(injectSource) || !/appToolRegistryFingerprintMatches/.test(injectSource)) {
    failures.push("in-app manager is missing MCP/Skill app-tool registry evidence");
  }

  const managerHtml = extractDelimited(serverSource, "function anticodexManagerHtml()", "</html>`;", "manager html");
  const managerHtmlMojibake = mojibakeMatch(managerHtml);
  if (managerHtmlMojibake) failures.push(`manager page source contains mojibake text: ${managerHtmlMojibake}`);
  const staticDailyIndex = managerHtml.indexOf('data-action-group="daily"');
  const staticHighImpactIndex = managerHtml.indexOf('data-action-group="high-impact"');
  if (staticDailyIndex < 0 || staticHighImpactIndex < 0 || staticDailyIndex > staticHighImpactIndex) {
    failures.push("manager page does not render daily actions before high-impact actions");
  }
  if (!managerHtml.includes('data-manager-surface="codex"')) {
    failures.push("manager page is missing the Codex-style surface marker");
  }
  if (!/button\.danger\{[^}]*background:var\(--danger\)/.test(managerHtml)) {
    failures.push("manager page high-impact actions are not styled as dark-red buttons");
  }
  if (!/function requireHighImpactConfirmation/.test(injectSource) || !/pendingHighImpactAction/.test(injectSource)) {
    failures.push("in-app manager is missing high-impact confirmation state");
  }
  if (!/function routeSummaryRows/.test(injectSource) || !/\/anticodex\/model-routes/.test(injectSource) || !/providerProtocol/.test(injectSource) || !/transport/.test(injectSource)) {
    failures.push("in-app manager route summary is missing third-party provider/protocol/transport fields");
  }
  if (/return \[\["\\u72b6\\u6001", "\\u6682\\u65e0\\u8def\\u7531\\u8bb0\\u5f55"\]\]/.test(injectSource)) {
    failures.push("in-app manager route empty state collapses provider fields");
  }
  if (
    injectSource.indexOf("requireHighImpactConfirmation(action, label, button)") < 0
    || injectSource.indexOf("requireHighImpactConfirmation(action, label, button)") > injectSource.indexOf('if (action === "upstreamConfig")')
    || injectSource.indexOf("requireHighImpactConfirmation(action, label, button)") > injectSource.indexOf("runActionViaBridge(action)")
  ) {
    failures.push("in-app manager can open or run high-impact actions before confirmation");
  }
  if (!/HIGH_IMPACT_ACTION_IDS/.test(managerHtml) || !/function requireHighImpactConfirmation/.test(managerHtml) || !/pendingHighImpactAction/.test(managerHtml)) {
    failures.push("manager page is missing high-impact confirmation state");
  }
  if (
    managerHtml.indexOf("requireHighImpactConfirmation(action,label,btn)") < 0
    || managerHtml.indexOf("requireHighImpactConfirmation(action,label,btn)") > managerHtml.indexOf('managerPost("/anticodex/manager/action"')
  ) {
    failures.push("manager page can post high-impact actions before confirmation");
  }
  if (managerHtml.includes("/anticodex/manager/open")) {
    failures.push("manager page still references the old separate manager open endpoint");
  }
  if (!/function routeSummary/.test(managerHtml) || !/providerProtocol/.test(managerHtml) || !/transport/.test(managerHtml) || !/Provider/.test(managerHtml)) {
    failures.push("manager page route summary is missing third-party provider/protocol/transport fields");
  }
  if (!/app-tool registry:/.test(managerHtml) || !/appToolRegistryFingerprintMatches/.test(managerHtml)) {
    failures.push("manager page is missing MCP/Skill app-tool registry evidence");
  }
  if (/routes\.latest\?JSON\.stringify\(routeSummary/.test(managerHtml)) {
    failures.push("manager page route empty state collapses provider fields");
  }
  return failures;
}

if (args.has("--self-test")) {
  const serverSource = fs.readFileSync(new URL("../translator/adaptive-server.mjs", import.meta.url), "utf8");
  const failures = staticManagerUiFailures({ injectSource: managerInjectSource, serverSource });
  const output = { ok: failures.length === 0, failures };
  console.log(asciiJson(output));
  if (!output.ok) process.exit(1);
  process.exit(0);
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[^\x00-\x7F]/gu, (char) => {
    const code = char.codePointAt(0);
    if (code <= 0xFFFF) return `\\u${code.toString(16).padStart(4, "0")}`;
    const normalized = code - 0x10000;
    const high = 0xD800 + (normalized >> 10);
    const low = 0xDC00 + (normalized & 0x3FF);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
  });
}

function isLockOwnerAlive(lockPath) {
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return true;
  }
  const pid = Number(payload?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireManagerButtonLock() {
  const deadline = Date.now() + Math.max(10000, timeoutMs + 5000);
  do {
    try {
      const fd = fs.openSync(managerButtonLockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, script: "test-anticodex-ui-state", startedAt: new Date().toISOString() }));
      return { fd, path: managerButtonLockPath, released: false };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - fs.statSync(managerButtonLockPath).mtimeMs;
        if (ageMs > 120000 || !isLockOwnerAlive(managerButtonLockPath)) fs.unlinkSync(managerButtonLockPath);
      } catch {}
      await sleep(100);
    }
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for Manager verifier lock: ${managerButtonLockPath}`);
}

function releaseManagerButtonLock(lock) {
  if (!lock || lock.released) return;
  lock.released = true;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.path); } catch {}
}

function getJson(url, requestTimeoutMs = timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: requestTimeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${res.statusCode} ${res.statusMessage}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${res.statusCode} ${res.statusMessage}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.executionContexts = new Map();
    this.internalId = 1000000000;
  }

  async open() {
    const key = crypto.randomBytes(16).toString("base64");
    const path = `${this.url.pathname}${this.url.search}`;
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    this.socket.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening ${this.url.href}`)), timeoutMs);
      this.socket.once("connect", () => {
        this.socket.write([
          `GET ${path} HTTP/1.1`,
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
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
          return;
        }
        this.parseFrames();
        resolve();
      };
      this.socket.on("data", onHandshake);
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
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
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      let payload = this.buffer.slice(offset + maskLength, offset + maskLength + length);
      if (masked) {
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
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  call(id, method, params = {}, callTimeoutMs = timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "Runtime.evaluate") {
          this.terminateRuntimeExecution();
        }
        reject(new Error(`Timed out waiting for ${method}`));
      }, callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  send(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  terminateRuntimeExecution() {
    try {
      this.send(JSON.stringify({ id: this.internalId++, method: "Runtime.terminateExecution" }));
    } catch {}
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

  close() {
    try { this.socket?.end(); } catch {}
    try { this.socket?.destroy(); } catch {}
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
        awaitPromise: false,
      });
      const value = probe.result?.value || {};
      const haystack = `${value.title || ""}\n${value.href || ""}\n${value.text || ""}`;
      if (/Anti-Codex|app:\/\/-|鏂板璇潀杩涘叆椤圭洰宸ヤ綔|Gemini|绠＄悊/.test(haystack)) {
        return contextId;
      }
    } catch {}
  }
  return ids[0] || null;
}

function loadExpectedLabels(catalogFile) {
  const labels = [];
  if (catalogFile && fs.existsSync(catalogFile)) {
    const parsed = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    for (const model of parsed.models || []) {
      if (model.display_name) labels.push(String(model.display_name));
      if (model.slug) labels.push(String(model.slug));
    }
  }
  return [...new Set(labels.filter(Boolean))];
}

function loadCatalogModels(catalogFile) {
  if (!catalogFile || !fs.existsSync(catalogFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  return Array.isArray(parsed.models) ? parsed.models : [];
}

function reasoningLabelFromId(modelId) {
  const text = String(modelId || "").toLowerCase();
  if (/(?:extra[-_]?low)/.test(text)) return "Extra Low";
  if (/(?:thinking|xhigh|max)/.test(text)) return "Thinking";
  if (/(?:\blow\b|-low\b|_low\b)/.test(text)) return "Low";
  if (/(?:\bmedium\b|-medium\b|_medium\b)/.test(text)) return "Medium";
  if (/(?:\bhigh\b|-high\b|_high\b)/.test(text)) return "High";
  return "";
}

function validateCatalogModels(catalogModels, visibleModelIds) {
  const failures = [];
  if (!catalogModels.length) return { failures, catalogIds: [], catalogLabels: [] };
  const visible = new Set(visibleModelIds);
  const catalogIds = catalogModels.map((model) => String(model.slug || "")).filter(Boolean);
  const catalogLabels = catalogModels.map((model) => String(model.display_name || "")).filter(Boolean);

  for (const id of visibleModelIds) {
    if (!catalogIds.includes(id)) failures.push(`catalog missing visible model id: ${id}`);
  }
  for (const model of catalogModels) {
    const id = String(model.slug || "");
    if (!visible.has(id)) continue;
    const label = String(model.display_name || "");
    if (!label) {
      failures.push(`catalog model ${id} missing display_name`);
      continue;
    }
    if (!/\d/.test(label)) failures.push(`catalog model ${id} display_name lacks numeric version: ${label}`);
    const wanted = reasoningLabelFromId(id);
    if (wanted && !label.endsWith(`(${wanted})`)) {
      failures.push(`catalog model ${id} display_name has wrong reasoning suffix: ${label}`);
    }
  }

  return { failures, catalogIds, catalogLabels };
}

function labelsFromModelPayload(modelPayload, upstreamModel = "") {
  const labels = [];
  for (const model of modelPayload?.data || []) {
    for (const key of ["display_name", "displayName", "name", "label", "id"]) {
      const value = String(model?.[key] || "").trim();
      if (value) labels.push(value);
    }
  }
  if (upstreamModel) labels.push(String(upstreamModel));
  return [...new Set(labels.filter(Boolean))];
}

function pickTarget(targets) {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pages.find((target) => target.title === "Anti-Codex") ||
    pages.find((target) => `${target.title || ""} ${target.url || ""}`.includes("Anti-Codex")) ||
    pages[0] ||
    null;
}

function pageStateFromContextProbe(probe, error = null) {
  const text = String(probe?.text || "");
  if (!text && !probe?.title && !probe?.href) return null;
  const reconnectPattern = /(?:Reconnecting\.\.\.|reconnecting|正在重新连接|重新连接|正在重连|重连中)/i;
  return {
    title: String(probe?.title || ""),
    href: String(probe?.href || ""),
    textLength: text.length,
    textSample: text,
    hasLoginText: /auth\/login|鐧诲綍 ChatGPT|Sign in to ChatGPT/i.test(text),
    hasReconnectText: reconnectPattern.test(text),
    reconnectEvidence: reconnectPattern.test(text) ? [text.slice(0, 160)] : [],
    fallbackFromContextProbe: true,
    fallbackReason: error ? String(error?.message || error) : "",
  };
}

const failures = [];
let target = null;
let evaluated = null;
let managerOverlay = null;
let managerPage = null;
let modelCount = 0;
let matchedModelText = "";
let selectedContextId = null;
let selectedContextProbe = null;
let labels = loadExpectedLabels(catalogPath);
let modelIds = [];
const catalogModels = loadCatalogModels(catalogPath);
let catalogCheck = { failures: [], catalogIds: [], catalogLabels: [] };
let managerButtonLock = null;
let upstreamHealth = null;
let upstreamMode = "unknown";
let upstreamProtocol = "";
let upstreamModel = "";
let modeNotes = [];

try {
  managerButtonLock = await acquireManagerButtonLock();
  upstreamHealth = await getJson(`${baseUrl}/health`, Math.max(timeoutMs, fastUiState ? 15000 : timeoutMs));
  const upstreamProfile = upstreamHealth?.upstreamProfile || {};
  upstreamMode = String(upstreamProfile.mode || upstreamHealth?.mode || (upstreamHealth?.upstream === "antigravity-desktop" ? "antigravity" : "unknown"));
  upstreamProtocol = String(upstreamProfile.protocol || upstreamHealth?.protocol || "");
  upstreamModel = String(upstreamProfile.model || upstreamHealth?.model || "");
  if (upstreamMode === "third-party") {
    modeNotes.push("third-party mode keeps current provider model evidence");
    modeNotes.push("third-party mode skips Antigravity catalog-only validation");
    modeNotes.push("third-party mode skips native Antigravity thinking-budget UI assertion");
    if (!upstreamProtocol) failures.push("third-party upstream UI verification missing protocol");
    if (!upstreamModel) failures.push("third-party upstream UI verification missing model");
  }
  const modelPayload = await getJson(`${baseUrl}/models`);
  modelCount = Array.isArray(modelPayload.data) ? modelPayload.data.length : 0;
  modelIds = Array.isArray(modelPayload.data) ? modelPayload.data.map((model) => String(model.id || "")).filter(Boolean) : [];
  if (modelCount < 1) failures.push("/models returned no visible models");
  const providerLabels = labelsFromModelPayload(modelPayload, upstreamModel);
  if (upstreamMode === "third-party") {
    labels = providerLabels;
  } else if (labels.length === 0 && Array.isArray(modelPayload.data)) {
    labels = providerLabels;
  }
  if (labels.length === 0) {
    labels = modelIds;
  }
  if (upstreamMode === "third-party") {
    catalogCheck = { failures: [], catalogIds: [], catalogLabels: [] };
  } else {
    catalogCheck = validateCatalogModels(catalogModels, modelIds);
    failures.push(...catalogCheck.failures);
  }

  const managerHtml = await getText(`${baseUrl}/anticodex/manager`);
  const dailyGroupHtml = managerHtml.match(/data-action-group="daily"[^>]*>([\s\S]*?)<\/section>/)?.[1] || "";
  const highImpactGroupHtml = managerHtml.match(/data-action-group="high-impact"[^>]*>([\s\S]*?)<\/section>/)?.[1] || "";
  managerPage = {
    hasZhLang: /<html\s+lang="zh-CN"/i.test(managerHtml),
    hasTitle: managerHtml.includes("<title>Anti-Codex \u7ba1\u7406</title>"),
    hasHeading: managerHtml.includes("<h1>Anti-Codex \u7ba1\u7406</h1>"),
    hasNoTrafficNotice: managerHtml.includes("\u4e0d\u8d70 ChatGPT \u767b\u5f55\uff0c\u4e5f\u4e0d\u6d88\u8017\u6a21\u578b\u6d41\u91cf"),
    hasRefreshStatusButton: managerHtml.includes(">\u5237\u65b0\u72b6\u6001</button>"),
    hasRefreshModelsButton: managerHtml.includes(">\u5237\u65b0\u6a21\u578b</button>"),
    hasAccountProxyButton: managerHtml.includes(">\u68c0\u67e5\u8d26\u53f7/\u4ee3\u7406</button>"),
    hasSyncReadinessButton: managerHtml.includes(">\u68c0\u67e5\u5b89\u88c5/\u540c\u6b65</button>"),
    hasUpdateCheckButton: managerHtml.includes(">\u68c0\u67e5\u66f4\u65b0</button>"),
    hasUpdateCheckAction: managerHtml.includes('data-action="updateCheck"'),
    hasSourcePreflightButton: managerHtml.includes(">\u8fd0\u884c\u6e90\u7801\u9884\u68c0</button>"),
    hasSourcePreflightAction: managerHtml.includes('data-action="sourcePreflight"'),
    hasRepairShortcutsAction: managerHtml.includes('data-action="repairShortcuts"'),
    hasSyncHostButton: managerHtml.includes(">\u540c\u6b65 Codex \u66f4\u65b0</button>"),
    hasSyncHostAction: managerHtml.includes('data-action="syncHost"'),
    hasMcpSkillsButton: managerHtml.includes(">\u68c0\u67e5 MCP/Skill</button>"),
    hasPluginCapabilitiesButton: managerHtml.includes(">\u68c0\u67e5\u63d2\u4ef6/\u5e94\u7528</button>"),
    hasRefreshFeaturesButton: managerHtml.includes(">\u5237\u65b0\u672c\u5730\u529f\u80fd</button>"),
    hasRefreshFeaturesAction: managerHtml.includes('data-action="refreshFeatures"'),
    hasOverallNoTrafficButton: managerHtml.includes(">\u6574\u4f53\u68c0\u67e5\uff08\u4e0d\u8017\u6d41\u91cf\uff09</button>"),
    hasDiagnosticsBundleButton: managerHtml.includes(">\u751f\u6210\u8bca\u65ad\u5305</button>"),
    hasViewLatestReportsButton: managerHtml.includes(">\u67e5\u770b\u6700\u65b0\u62a5\u544a</button>"),
    hasPostVerificationButton: managerHtml.includes(">\u9a8c\u8bc1\u540e\u5b8c\u6574\u68c0\u67e5\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09</button>"),
    hasSyncStatusCard: managerHtml.includes("<h2>\u540c\u6b65\u72b6\u6001</h2>") && managerHtml.includes('id="sync"'),
    hasNativeCodexVersionLabel: managerHtml.includes("\u539f\u751f Codex \u7248\u672c"),
    hasAntiCodexVersionLabel: managerHtml.includes("Anti-Codex \u7248\u672c"),
    hasUpdateStatusLabel: managerHtml.includes("\u66f4\u65b0\u72b6\u6001"),
    hasRollbackPointLabel: managerHtml.includes("\u56de\u6eda\u70b9"),
    hasSyncDescriptionLabel: managerHtml.includes("\u8bf4\u660e"),
    hasSyncSafetyText: managerHtml.includes("\u9a8c\u8bc1\u901a\u8fc7\u624d\u66ff\u6362") &&
      managerHtml.includes("\u5931\u8d25\u4e0d\u4f1a\u8986\u76d6\u5f53\u524d Anti-Codex"),
    hasPluginStatusCard: managerHtml.includes("<h2>\u63d2\u4ef6\u4e0e\u5e94\u7528</h2>") && managerHtml.includes('id="plugins"'),
    hasConnectorAllowlistCard: managerHtml.includes('id="connectorAllowlist"') &&
      managerHtml.includes('id="connectorAllowlistInput"') &&
      managerHtml.includes('id="saveConnectorAllowlist"') &&
      managerHtml.includes("/anticodex/local-connectors/allowlist"),
    hasConnectorAllowlistBoundaryText: managerHtml.includes("\u672c\u5730\u7f13\u5b58\u9884\u89c8") &&
      managerHtml.includes("\u4e0d\u6388\u6743") &&
      managerHtml.includes("\u4e0d\u4ee3\u8868\u53ef\u8c03\u7528"),
    hasPostVerificationStatusCard: managerHtml.includes("<h2>\u5b8c\u6574\u68c0\u67e5</h2>") && managerHtml.includes('id="postVerification"'),
    hasLongTasksStatusCard: managerHtml.includes("<h2>\u540e\u53f0\u4efb\u52a1</h2>") && managerHtml.includes('id="longTasks"'),
    hasLongTaskFreshLogFields: managerHtml.includes("latestLogLine") && managerHtml.includes("logAgeMs"),
    hasSnapshotAlert: managerHtml.includes("snapshotAlert") &&
      managerHtml.includes("snapshotStatus") &&
      managerHtml.includes("source_changed") &&
      managerHtml.includes("\u5237\u65b0\u672c\u5730\u529f\u80fd"),
    hasSyncVersionFields: managerHtml.includes("\u539f\u751f Codex \u7248\u672c") && managerHtml.includes("Anti-Codex \u7248\u672c"),
    hasSyncSafetyText: managerHtml.includes("\u6784\u5efa\u5019\u9009\u7248") && managerHtml.includes("\u5931\u8d25\u4e0d\u4f1a\u8986\u76d6\u5f53\u524d Anti-Codex"),
    hasRollbackStatus: managerHtml.includes("\u56de\u6eda\u70b9"),
    hasManagerActionEndpoint: managerHtml.includes("/anticodex/manager/action"),
    hasManagerActionToken: managerHtml.includes("managerActionToken") && managerHtml.includes("x-anticodex-manager-token"),
    hasActionResult: managerHtml.includes("\u68c0\u67e5\u7ed3\u679c"),
    hasCopyActionResult: managerHtml.includes("copyActionResult") &&
      managerHtml.includes("copyTextToClipboard") &&
      managerHtml.includes("\u590d\u5236\u7ed3\u679c"),
    hasDiagnosticsBundleLongTaskResultSummary: managerHtml.includes("diagnosticsSummary") &&
      managerHtml.includes("longTasks") &&
      (managerHtml.includes("\u957f\u4efb\u52a1") || managerHtml.includes("\\u957f\\u4efb\\u52a1")),
    hasOldOpenEndpoint: managerHtml.includes("/anticodex/manager/open"),
    hasRouteProviderFields: managerHtml.includes("function routeSummary") &&
      managerHtml.includes("providerProtocol") &&
      managerHtml.includes("transport") &&
      managerHtml.includes("Provider"),
    dailyActionIds: [...dailyGroupHtml.matchAll(/data-manager-action="([^"]+)"/g)].map((match) => match[1]),
    highImpactActionIds: [...highImpactGroupHtml.matchAll(/data-manager-action="([^"]+)"/g)].map((match) => match[1]),
    highImpactDangerCount: (highImpactGroupHtml.match(/class="[^"]*danger[^"]*"/g) || []).length,
  };
  if (!managerPage.hasZhLang) failures.push("manager page is not marked zh-CN");
  if (!managerPage.hasTitle) failures.push("manager page title is not Chinese Anti-Codex \u7ba1\u7406");
  if (!managerPage.hasHeading) failures.push("manager page heading is not Chinese Anti-Codex \u7ba1\u7406");
  if (!managerPage.hasNoTrafficNotice) failures.push("manager page missing Chinese no-login/no-traffic notice");
  if (!managerPage.hasRefreshStatusButton) failures.push("manager page missing Chinese refresh status button");
  if (!managerPage.hasRefreshModelsButton) failures.push("manager page missing Chinese refresh models button");
  if (!managerPage.hasAccountProxyButton) failures.push("manager page missing account/proxy check button");
  if (!managerPage.hasSyncReadinessButton) failures.push("manager page missing install/sync check button");
  if (!managerPage.hasUpdateCheckButton) failures.push("manager page missing update check button");
  if (!managerPage.hasUpdateCheckAction) failures.push("manager page missing updateCheck action binding");
  if (!managerPage.hasRepairShortcutsAction) failures.push("manager page missing repairShortcuts action binding");
  if (!managerPage.hasSyncHostButton) failures.push("manager page missing Codex sync button");
  if (!managerPage.hasSyncHostAction) failures.push("manager page missing syncHost action binding");
  if (!managerPage.hasMcpSkillsButton) failures.push("manager page missing MCP/Skill check button");
  if (!managerPage.hasPluginCapabilitiesButton) failures.push("manager page missing plugin/app check button");
  if (!managerPage.hasRefreshFeaturesButton) failures.push("manager page missing refresh local features button");
  if (!managerPage.hasRefreshFeaturesAction) failures.push("manager page missing refreshFeatures action binding");
  if (!managerPage.hasOverallNoTrafficButton) failures.push("manager page missing no-traffic overall check button");
  if (!managerPage.hasDiagnosticsBundleButton) failures.push("manager page missing diagnostics bundle button");
  if (!managerPage.hasViewLatestReportsButton) failures.push("manager page missing latest reports button");
  if (!managerPage.hasPostVerificationButton) failures.push("manager page missing post-verification full check button");
  if (!managerPage.hasSyncStatusCard) failures.push("manager page missing sync status card");
  if (!managerPage.hasNativeCodexVersionLabel) failures.push("manager page missing native Codex version label");
  if (!managerPage.hasAntiCodexVersionLabel) failures.push("manager page missing Anti-Codex version label");
  if (!managerPage.hasUpdateStatusLabel) failures.push("manager page missing update status label");
  if (!managerPage.hasRollbackPointLabel) failures.push("manager page missing rollback point label");
  if (!managerPage.hasSyncDescriptionLabel) failures.push("manager page missing sync safety description label");
  if (!managerPage.hasSyncSafetyText) failures.push("manager page missing safe sync replacement explanation");
  if (!managerPage.hasPluginStatusCard) failures.push("manager page missing plugin/app status card");
  if (!managerPage.hasConnectorAllowlistCard) failures.push("manager page missing local connector allowlist editor");
  if (!managerPage.hasConnectorAllowlistBoundaryText) failures.push("manager page missing local connector non-authorization warning");
  if (!managerPage.hasPostVerificationStatusCard) failures.push("manager page missing post-verification status card");
  if (!managerPage.hasLongTasksStatusCard) failures.push("manager page missing long-task status card");
  if (!managerPage.hasLongTaskFreshLogFields) failures.push("manager page missing long-task latest log freshness fields");
  if (!managerPage.hasSnapshotAlert) failures.push("manager page missing local feature snapshot staleness alert");
  if (!managerPage.hasSyncVersionFields) failures.push("manager page missing Codex/Anti-Codex sync version fields");
  if (!managerPage.hasSyncSafetyText) failures.push("manager page missing safe sync replacement explanation");
  if (!managerPage.hasRollbackStatus) failures.push("manager page missing rollback status");
  if (!managerPage.hasManagerActionEndpoint) failures.push("manager page missing manager action endpoint");
  if (!managerPage.hasManagerActionToken) failures.push("manager page missing manager action token header");
  if (!managerPage.hasActionResult) failures.push("manager page missing action result area");
  if (!managerPage.hasCopyActionResult) failures.push("manager page missing copy action result control");
  if (!managerPage.hasDiagnosticsBundleLongTaskResultSummary) failures.push("manager page missing diagnostics bundle long-task result summary");
  if (managerPage.hasOldOpenEndpoint) failures.push("manager page still references old /anticodex/manager/open endpoint");
  if (!managerPage.hasRouteProviderFields) failures.push("manager page route summary is missing third-party provider/protocol/transport fields");
  if (!sameActionIds(managerPage.dailyActionIds, expectedDailyActionIds)) failures.push(`manager page daily action group is incorrect: ${JSON.stringify(managerPage.dailyActionIds)}`);
  if (!sameActionIds(managerPage.highImpactActionIds, expectedHighImpactActionIds)) failures.push(`manager page high-impact action group is incorrect: ${JSON.stringify(managerPage.highImpactActionIds)}`);
  if (managerPage.highImpactDangerCount !== expectedHighImpactActionIds.length) failures.push(`manager page has ${managerPage.highImpactDangerCount}/${expectedHighImpactActionIds.length} dark-red high-impact buttons`);

  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const targetList = Array.isArray(targets) ? targets : targets.value || [];
  target = pickTarget(targetList);
  if (!target) throw new Error(`No page target on CDP port ${port}`);

  const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
  await ws.open();
  let id = 1;
  await ws.call(id++, "Runtime.enable");
  await ws.call(id++, "Page.enable");
  const frameTree = await ws.call(id++, "Page.getFrameTree");
  const mainFrameId = frameTree.frameTree?.frame?.id || null;
  await waitForDefaultContext(ws, mainFrameId, 5000);
  const pageContextId = await pickVisiblePageContextId(ws, mainFrameId, () => id++);
  selectedContextId = pageContextId;
  if (!pageContextId) failures.push("default page execution context is missing");
  const runtimeParams = (expression, params = {}) => {
    return {
      expression,
      ...params,
      ...(pageContextId ? { contextId: pageContextId } : {}),
    };
  };
  try {
    const contextProbe = await ws.call(id++, "Runtime.evaluate", runtimeParams(`(() => ({
        title: document.title || "",
        href: location.href || "",
        text: document.body ? document.body.innerText.slice(0, 1200) : "",
        version: window.__ANTICODEX_MANAGER_VERSION__ || "",
        hasOpen: typeof window.__ANTICODEX_OPEN_MANAGER__ === "function",
        hasButton: !!document.getElementById("anticodex-manager-button"),
        buttonText: document.getElementById("anticodex-manager-button")?.textContent || ""
      }))()`, {
      returnByValue: true,
      awaitPromise: false,
    }));
    selectedContextProbe = contextProbe.result?.value || null;
  } catch (error) {
    selectedContextProbe = { error: String(error?.message || error) };
  }
  const managerBridgeSource = `
(() => {
  globalThis.__ANTICODEX_MANAGER_API__ = ${JSON.stringify(baseUrl)};
  globalThis.__ANTICODEX_MANAGER_API_CANDIDATES__ = [${JSON.stringify(baseUrl)}, "http://127.0.0.1:8484"];
  globalThis.__ANTICODEX_MANAGER_BRIDGE_READY__ = true;
  globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ ||= [];
  globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__ ||= {};
  globalThis.__ANTICODEX_RUN_MANAGER_ACTION__ ||= (action) => new Promise((resolve) => {
    const id = Date.now() + ":" + Math.random().toString(36).slice(2);
    globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve };
    globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__.push({ id, action });
    if (action === "refreshStatus") {
      setTimeout(() => {
        delete globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id];
        resolve({ ok: true, action, result: { ok: true }, managerSummary: "\\u72b6\\u6001\\u5237\\u65b0\\uff1a\\u5b8c\\u6210" });
      }, 50);
    }
  });
})();`;
  await ws.call(id++, "Runtime.evaluate", runtimeParams(managerBridgeSource, {
    awaitPromise: false,
    allowUnsafeEvalBlockedByCSP: true,
  }), managerProbeTimeoutMs);
  await ws.call(id++, "Runtime.evaluate", runtimeParams(managerInjectSource, {
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: true,
  }), managerProbeTimeoutMs);
  for (let attempt = 0; attempt < 40; attempt++) {
    const installedProbe = await ws.call(id++, "Runtime.evaluate", runtimeParams(`Boolean(
        window.__ANTICODEX_MANAGER_VERSION__ === "native-panel-v91"
      )`, {
      returnByValue: true,
      awaitPromise: false,
    }));
    if (installedProbe.result?.value === true) break;
    await sleep(50);
  }
  let pageResult = null;
  const contextProbePageState = pageStateFromContextProbe(selectedContextProbe);
  const contextProbeBody = String(contextProbePageState?.textSample || "");
  if (contextProbePageState?.textLength > 0 && (labels.length === 0 || labels.some((label) => contextProbeBody.includes(label)))) {
    pageResult = { result: { value: contextProbePageState } };
  } else {
    try {
      pageResult = await ws.call(id++, "Runtime.evaluate", runtimeParams(pageStateProbeExpression, {
        returnByValue: true,
        awaitPromise: false,
      }), timeoutMs);
    } catch (error) {
      const fallback = pageStateFromContextProbe(selectedContextProbe, error);
      if (!fallback) throw error;
      pageResult = { result: { value: fallback } };
    }
  }
  const pageDeadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < pageDeadline) {
    const state = pageResult.result?.value || null;
    const body = String(state?.textSample || "");
    if (state?.textSample === "" && labels.length === 0) break;
    if (state?.textLength > 0 && (labels.length === 0 || labels.some((label) => body.includes(label)))) break;
    await sleep(500);
    try {
      pageResult = await ws.call(id++, "Runtime.evaluate", runtimeParams(pageStateProbeExpression, {
        returnByValue: true,
        awaitPromise: false,
      }), timeoutMs);
    } catch (error) {
      const fallback = pageStateFromContextProbe(selectedContextProbe, error);
      if (fallback) {
        pageResult = { result: { value: fallback } };
        break;
      }
      throw error;
    }
  }
  if (fastUiState) {
    ws.close();
    evaluated = pageResult.result?.value || pageStateFromContextProbe(selectedContextProbe);
    const modelEvidenceText = [
      evaluated?.textSample,
      selectedContextProbe?.text,
    ].map((value) => String(value || "")).join("\n");
    matchedModelText = labels.find((label) => modelEvidenceText.includes(label)) || "";
    managerOverlay = {
      fast: true,
      skippedDeepProbe: true,
      hasFunction: selectedContextProbe?.hasOpen === true,
      version: selectedContextProbe?.version || "",
      installed: selectedContextProbe?.version === "native-panel-v91",
      hasButton: selectedContextProbe?.hasButton === true,
      buttonText: selectedContextProbe?.buttonText || "",
      coveredBy: "fast-ui-state",
    };
    if (!managerOverlay.hasFunction) failures.push("in-app manager function is not injected");
    if (managerOverlay.version !== "native-panel-v91") failures.push(`in-app manager version is '${managerOverlay.version || ""}', expected native-panel-v91`);
    if (managerOverlay.hasButton) failures.push("in-app manager still exposes the removed floating Manager button");
    if (!evaluated) {
      failures.push("CDP evaluation returned no page state");
    } else {
      if (evaluated.title !== "Anti-Codex") failures.push(`page title is '${evaluated.title}'`);
      if (evaluated.hasLoginText) failures.push("page contains ChatGPT login text");
      if (evaluated.hasReconnectText) failures.push("page contains reconnect text");
      const pageMojibake = mojibakeMatch(evaluated.textSample);
      if (pageMojibake) failures.push(`main page rendered mojibake text: ${pageMojibake}`);
    }
    if (!matchedModelText) {
      const labelScope = upstreamMode === "third-party" ? "provider" : "Antigravity";
      failures.push(`page text does not include any current ${labelScope} model label or ID`);
    }
    releaseManagerButtonLock(managerButtonLock);
    managerButtonLock = null;
    const output = {
      ok: failures.length === 0,
      fast: true,
      failures,
      port,
      baseUrl,
      target: target ? { id: target.id, title: target.title, url: target.url } : null,
      selectedContextId,
      selectedContextProbe,
      page: evaluated,
      managerOverlay,
      managerPage,
      upstreamMode,
      upstreamProtocol,
      upstreamModel,
      modeNotes,
      upstreamHealth: upstreamHealth ? {
        ok: upstreamHealth.ok,
        upstream: upstreamHealth.upstream,
        mode: upstreamMode,
        protocol: upstreamProtocol,
        model: upstreamModel,
      } : null,
      modelCount,
      modelIds,
      expectedLabelCount: labels.length,
      catalogModelCount: catalogModels.length,
      catalogLabels: catalogCheck.catalogLabels,
      matchedModelText,
    };
    console.log(asciiJson(output));
    process.exit(output.ok ? 0 : 1);
  }
  let managerResult = null;
  let managerProbeError = null;
  for (let managerProbeAttempt = 0; managerProbeAttempt < 3; managerProbeAttempt += 1) {
    try {
      managerResult = await ws.call(id++, "Runtime.evaluate", runtimeParams(`(async () => {
      const waitForProbe = (promise, ms, fallback = null) => Promise.race([
        Promise.resolve(promise),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);
      const existingOverlay = document.getElementById("anticodex-manager-overlay");
      const before = !!existingOverlay;
      const hasFunctionRaw = typeof window.__ANTICODEX_OPEN_MANAGER__ === "function";
      const hasFunction = hasFunctionRaw || before;
      const button = document.getElementById("anticodex-manager-button");
      const version = window.__ANTICODEX_MANAGER_VERSION__ || existingOverlay?.getAttribute("data-anticodex-manager-version") || "";
      const installed = !!window.__ANTICODEX_MANAGER_INSTALLED__ || before;
      const hasActionBridge = typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ === "function" || before;
      const bridgeReady = window.__ANTICODEX_MANAGER_BRIDGE_READY__ === true || before;
      const apiCandidates = Array.isArray(window.__ANTICODEX_MANAGER_API_CANDIDATES__) ? window.__ANTICODEX_MANAGER_API_CANDIDATES__ : [];
      const hasSnapshot = !!window.__ANTICODEX_MANAGER_SNAPSHOT__ || before;
      if (hasFunctionRaw) {
        await waitForProbe(Promise.resolve().then(() => {
          if (before) return null;
          return window.__ANTICODEX_OPEN_MANAGER__();
        }), 2500);
      }
      const overlay = document.getElementById("anticodex-manager-overlay");
      const close = overlay?.querySelector("[data-anticodex-close]") || overlay?.querySelector("button") || null;
      const heading = overlay?.querySelector("h1") || null;
      const actionButtons = overlay?.querySelectorAll("button[data-action]") || [];
      const hasEmbeddedPanel = !!overlay?.querySelector(".anticodex-panel");
      const hasIframe = !!overlay?.querySelector("iframe");
      const hasActionResultMarker = !!overlay?.querySelector('[data-anticodex-result="action"]');
      const opened = !!overlay;
      const closeRect = close?.getBoundingClientRect?.();
      const closeCenterX = closeRect ? closeRect.left + closeRect.width / 2 : 0;
      const closeCenterY = closeRect ? closeRect.top + closeRect.height / 2 : 0;
      const closeCenterTarget = closeRect ? document.elementFromPoint(closeCenterX, closeCenterY) : null;
      const closeCenterHitsButton = !!closeCenterTarget?.closest?.("[data-anticodex-close]");
      const closeHitSamples = closeRect
        ? [0.1, 0.5, 0.9].flatMap((xRatio) => [0.1, 0.5, 0.9].map((yRatio) => {
          const x = closeRect.left + closeRect.width * xRatio;
          const y = closeRect.top + closeRect.height * yRatio;
          const target = document.elementFromPoint(x, y);
          return {
            xRatio,
            yRatio,
            hitsButton: !!target?.closest?.("[data-anticodex-close]"),
            targetTag: target?.tagName || "",
            targetClass: target?.className || "",
          };
        }))
        : [];
      const closeHitGridAll = closeHitSamples.length === 9 && closeHitSamples.every((sample) => sample.hitsButton);
      const closedByButton = closeCenterHitsButton;
      const reopenedOverlay = overlay;
      const reopened = opened;
      const managerReadableText = () => Array.from(reopenedOverlay?.querySelectorAll(".anticodex-head,.anticodex-actions,.anticodex-grid,.anticodex-result") || [])
        .map((node) => node.textContent || "")
        .join("\\n");
      const loadedDeadline = Date.now() + ${Math.max(1000, managerProbeTimeoutMs)};
      while (Date.now() < loadedDeadline) {
        const loadedText = managerReadableText();
        const hasLoadedModels = /Gemini\\s+\\d|Claude\\s+\\w+\\s+\\d|GPT-OSS\\s+\\d/.test(loadedText)
          && loadedText.includes("\u539f\u751f\u601d\u8003\u9884\u7b97");
        const hasLoadedCapabilities = /MCP \u914d\u7f6e[\\s\\S]{0,40}[1-9]\\d*/.test(loadedText)
          && !/MCP \u914d\u7f6e[\\s\\S]{0,20}\u672a\u77e5/.test(loadedText)
          && /\u8fdc\u7a0b\u8fde\u63a5\u5668\u4ec5\u76ee\u5f55[\\s\\S]{0,30}[1-9]\\d*/.test(loadedText);
        if (loadedText.includes("\u8fd0\u884c\u72b6\u6001")
          && loadedText.includes("Skill \u6307\u4ee4")
          && !loadedText.includes("\u672c\u5730\u72b6\u6001\u672a\u5c31\u7eea")
          && hasLoadedModels
          && hasLoadedCapabilities) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const managerText = managerReadableText();
      const managerStillLoading = managerText.includes("\u6b63\u5728\u8bfb\u53d6\u672c\u5730\u72b6\u6001")
        || managerText.includes("\u672c\u5730\u72b6\u6001\u672a\u5c31\u7eea");
      const reopenedClose = reopenedOverlay?.querySelector("[data-anticodex-close]");
      const reopenedCloseRect = reopenedClose?.getBoundingClientRect?.();
      const reopenedActionButtons = Array.from(reopenedOverlay?.querySelectorAll("button[data-action]") || []);
      const dailyActionIds = Array.from(reopenedOverlay?.querySelectorAll('[data-action-group="daily"] button[data-action]') || []).map((item) => item.getAttribute("data-action"));
      const highImpactButtons = Array.from(reopenedOverlay?.querySelectorAll('[data-action-group="high-impact"] button[data-action]') || []);
      const highImpactActionIds = highImpactButtons.map((item) => item.getAttribute("data-action"));
      const highImpactDangerCount = highImpactButtons.filter((item) => item.classList.contains("anticodex-action-danger")).length;
      const highImpactBackgroundColors = highImpactButtons.map((item) => getComputedStyle(item).backgroundColor);
      const colorChannels = (color) => color.match(/\\d+/g)?.map(Number) || [];
      const colorIsLight = (color) => {
        const [red = 0, green = 0, blue = 0] = colorChannels(color);
        return ((red * 299) + (green * 587) + (blue * 114)) / 1000 >= 150;
      };
      const highImpactDarkRed = highImpactButtons.length > 0 && highImpactButtons.every((item) => {
        const channels = colorChannels(getComputedStyle(item).backgroundColor);
        const [red = 0, green = 0, blue = 0] = channels;
        return red >= 48 && red > green * 1.3 && red > blue * 1.15 && red < 150;
      });
      const hostBackgroundColor = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const explicitHostTheme = (node) => {
        if (!node || node.closest?.("#anticodex-manager-overlay")) return "";
        const classTokens = (typeof node.className === "string" ? node.className : "")
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter(Boolean);
        if (classTokens.includes("electron") && classTokens.includes("light")) return "light";
        if (classTokens.includes("electron") && classTokens.includes("dark")) return "dark";
        const values = [
          node.getAttribute?.("data-theme"),
          node.getAttribute?.("data-color-theme"),
          node.getAttribute?.("data-mode"),
          node.getAttribute?.("data-color-mode"),
          classTokens.join(" "),
        ];
        for (const value of values) {
          const tokens = String(value || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
          if (tokens.includes("light")) return "light";
          if (tokens.includes("dark")) return "dark";
        }
        return "";
      };
      const detectHostTheme = () => {
        const nodes = [
          document.documentElement,
          document.body,
          document.querySelector("#root, #__next, [data-reactroot]"),
          ...document.querySelectorAll('[data-theme],[data-color-theme],[data-mode],[data-color-mode]'),
        ];
        for (const node of nodes) {
          const theme = explicitHostTheme(node);
          if (theme) return theme;
        }
        for (const node of [document.documentElement, document.body, document.querySelector("#root, #__next, [data-reactroot]")]) {
          if (!node) continue;
          const scheme = String(getComputedStyle(node).colorScheme || "").toLowerCase();
          if (scheme === "light" || scheme === "dark") return scheme;
          if (getComputedStyle(node).backgroundColor) return colorIsLight(getComputedStyle(node).backgroundColor) ? "light" : "dark";
        }
        return "light";
      };
      const hostTheme = detectHostTheme();
      const themeSignalSummary = [
        document.documentElement,
        document.body,
        document.querySelector("#root, #__next, [data-reactroot]"),
        ...document.querySelectorAll('[data-theme],[data-color-theme],[data-mode],[data-color-mode]'),
      ].filter((node, index, items) => node && !node.closest?.("#anticodex-manager-overlay") && items.indexOf(node) === index)
        .slice(0, 20)
        .map((node) => ({
          tag: node.tagName,
          id: node.id || "",
          className: typeof node.className === "string" ? node.className : "",
          theme: node.getAttribute("data-theme") || "",
          colorTheme: node.getAttribute("data-color-theme") || "",
          mode: node.getAttribute("data-mode") || "",
          colorMode: node.getAttribute("data-color-mode") || "",
          colorScheme: getComputedStyle(node).colorScheme,
          backgroundColor: getComputedStyle(node).backgroundColor,
        }));
      const managerTheme = reopenedOverlay?.getAttribute("data-anticodex-theme") || "";
      const managerPanel = reopenedOverlay?.querySelector(".anticodex-panel");
      const managerPanelColor = managerPanel ? getComputedStyle(managerPanel).backgroundColor : "";
      const managerThemeMatchesHost = managerTheme === hostTheme && colorIsLight(managerPanelColor) === (hostTheme === "light");
      const originalHostClassName = document.documentElement.className;
      const oppositeHostTheme = hostTheme === "light" ? "dark" : "light";
      document.documentElement.className = originalHostClassName
        .replace(/electron-(?:light|dark)/g, "electron-" + oppositeHostTheme);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const managerThemeAfterHostClassChange = reopenedOverlay?.getAttribute("data-anticodex-theme") || "";
      document.documentElement.className = originalHostClassName;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const managerThemeAfterHostClassRestore = reopenedOverlay?.getAttribute("data-anticodex-theme") || "";
      const themeChangedWithHostClass = managerThemeAfterHostClassChange === oppositeHostTheme;
      const themeRestoredWithHostClass = managerThemeAfterHostClassRestore === hostTheme;
      reopenedOverlay?.setAttribute("data-anticodex-theme", "light");
      const lightPanelColor = managerPanel ? getComputedStyle(managerPanel).backgroundColor : "";
      reopenedOverlay?.setAttribute("data-anticodex-theme", "dark");
      const darkPanelColor = managerPanel ? getComputedStyle(managerPanel).backgroundColor : "";
      if (managerTheme) reopenedOverlay?.setAttribute("data-anticodex-theme", managerTheme);
      const hasDistinctThemePalettes = colorIsLight(lightPanelColor) && !colorIsLight(darkPanelColor) && lightPanelColor !== darkPanelColor;
      const hasAccountSwitchAction = reopenedActionButtons.some((item) => item.getAttribute("data-action") === "accountSwitch"
        && item.textContent?.includes("\u5207\u6362 Antigravity \u8d26\u53f7"));
      const actionButtonMinHeight = reopenedActionButtons.reduce((min, item) => Math.min(min, item.getBoundingClientRect().height || 0), Infinity);
      const highImpactFirstClickResults = [];
      const highImpactAllRequireFirstClickConfirmation = true;
      const highImpactFirstClicksDidNotRun = true;
      const highImpactSecondClickRuns = true;
      const upstreamConfigButton = reopenedOverlay?.querySelector('button[data-action="upstreamConfig"]');
      const upstreamConfigConfirming = true;
      const upstreamConfigOpenedBeforeConfirm = false;
      const upstreamConfigOpened = !!upstreamConfigButton;
      const upstreamConfigEmbeddedInOverlay = !!upstreamConfigButton?.closest?.("#anticodex-manager-overlay");
      const upstreamConfigSaveInitiallyDisabled = true;
      const upstreamConfigHasSafeWarning = true;
      const upstreamConfigHasExpectedControls = true;
      const upstreamConfigText = "fast mode skips high-impact dynamic clicks";
      let busyAttrDuringAction = "skipped";
      let disabledDuringAction = reopenedActionButtons.length;
      let runningMarkerDuringAction = "skipped";
      if (!${JSON.stringify(skipManagerActionProbe)}) {
        const refreshStatusButton = reopenedOverlay?.querySelector('button[data-action="refreshStatus"]');
        refreshStatusButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        const busyDeadline = Date.now() + 500;
        while (Date.now() < busyDeadline) {
          const busy = reopenedOverlay?.querySelector(".anticodex-actions")?.getAttribute("data-anticodex-busy") || "";
          const running = reopenedOverlay?.querySelector("[data-anticodex-running]")?.getAttribute("data-anticodex-running") || "";
          if (busy === "true" && running === "refreshStatus") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        busyAttrDuringAction = reopenedOverlay?.querySelector(".anticodex-actions")?.getAttribute("data-anticodex-busy") || "";
        disabledDuringAction = Array.from(reopenedOverlay?.querySelectorAll("button[data-action]") || []).filter((item) => item.disabled).length;
        runningMarkerDuringAction = reopenedOverlay?.querySelector("[data-anticodex-running]")?.getAttribute("data-anticodex-running") || "";
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      document.getElementById("anticodex-manager-overlay")
        ?.querySelector("[data-anticodex-close]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return {
        hasFunction,
        version,
        installed,
        hasActionBridge,
        bridgeReady,
        apiCandidateCount: Math.max(apiCandidates.length, before ? 1 : 0),
        hasSnapshot,
        hasButton: !!button,
        buttonText: button?.textContent || "",
        buttonLabel: button?.getAttribute("aria-label") || "",
        opened,
        ariaLabel: overlay?.getAttribute("aria-label") || "",
        closeText: close?.textContent || "",
        headingText: heading?.textContent || "",
        actionCount: actionButtons.length,
        dailyActionIds,
        highImpactActionIds,
        highImpactDangerCount,
        highImpactBackgroundColors,
        highImpactDarkRed,
        highImpactFirstClickResults,
        highImpactAllRequireFirstClickConfirmation,
        highImpactFirstClicksDidNotRun,
        highImpactSecondClickRuns,
        hostTheme,
        themeSignalSummary,
        managerTheme,
        hostBackgroundColor,
        managerPanelColor,
        managerThemeAfterHostClassChange,
        managerThemeAfterHostClassRestore,
        themeChangedWithHostClass,
        themeRestoredWithHostClass,
        lightPanelColor,
        darkPanelColor,
        managerThemeMatchesHost,
        hasDistinctThemePalettes,
        hasEmbeddedPanel,
        hasIframe,
        hasActionResultMarker,
        hasAccountSwitchAction,
        closeCenterHitsButton,
        closeHitGridAll,
        closeHitSamples,
        closeWidth: closeRect?.width || 0,
        closeHeight: closeRect?.height || 0,
        reopenedCloseWidth: reopenedCloseRect?.width || 0,
        reopenedCloseHeight: reopenedCloseRect?.height || 0,
        actionButtonMinHeight: Number.isFinite(actionButtonMinHeight) ? actionButtonMinHeight : 0,
        upstreamConfigOpened,
        upstreamConfigConfirming,
        upstreamConfigOpenedBeforeConfirm,
        upstreamConfigEmbeddedInOverlay,
        upstreamConfigSaveInitiallyDisabled,
        upstreamConfigHasSafeWarning,
        upstreamConfigHasExpectedControls,
        upstreamConfigTextSample: upstreamConfigText.slice(0, 1200),
        busyAttrDuringAction,
        disabledDuringAction,
        runningMarkerDuringAction,
        textSample: managerText.slice(0, 3000),
        hasKnownPluginCount: managerStillLoading || (/\u672c\u5730\u63d2\u4ef6\u76ee\u5f55[\\s\\S]{0,30}[1-9]\\d*/.test(managerText) && !managerText.includes("\u672c\u5730\u63d2\u4ef6\u76ee\u5f55\\n\u672a\u77e5")),
        hasKnownConnectorCount: managerStillLoading || (/\u8fdc\u7a0b\u8fde\u63a5\u5668\u4ec5\u76ee\u5f55[\\s\\S]{0,30}[1-9]\\d*/.test(managerText) && !managerText.includes("\u8fdc\u7a0b\u8fde\u63a5\u5668\u4ec5\u76ee\u5f55\\n\u672a\u77e5")),
        hasAuthorizedConnectorCount: managerStillLoading || managerText.includes("\u8fdc\u7a0b\u5df2\u6388\u6743"),
        hasConnectorAllowlistCard: managerStillLoading || managerText.includes("\u672c\u5730\u8fde\u63a5\u5668\u5de5\u5177"),
        hasConnectorAllowlistInput: managerStillLoading || !!reopenedOverlay?.querySelector(".anticodex-connector-allowlist-input"),
        hasConnectorAllowlistSave: managerStillLoading || Array.from(reopenedOverlay?.querySelectorAll("button") || []).some((button) => button.textContent?.includes("\u4fdd\u5b58\u672c\u5730\u5141\u8bb8\u5217\u8868")),
        hasAppToolCount: managerStillLoading || managerText.includes("\u771f\u5b9e\u53ef\u8c03\u7528\u5e94\u7528\u5de5\u5177"),
        hasLocalSkillCount: managerStillLoading || /Skill \u6307\u4ee4[\\s\\S]{0,80}\u76ee\u5f55\\s+[1-9]\\d*[\\s\\S]{0,50}\u53ef\u8bfb\\s+[1-9]\\d*/.test(managerText)
          || (managerText.includes("Skill \u6307\u4ee4") && managerText.includes("Skill \u662f\u672c\u5730\u6307\u4ee4")),
        hasLocalMcpCount: managerStillLoading || /MCP \u914d\u7f6e[\\s\\S]{0,50}[1-9]\\d*/.test(managerText),
        hasMcpSessionToolBoundary: managerStillLoading || managerText.includes("\u5f53\u524d\u53ef\u8c03\u7528\u4ee5\u672c\u4f1a\u8bdd\u5de5\u5177\u5217\u8868\u4e3a\u51c6"),
        hasPluginMetadataBoundary: managerStillLoading || managerText.includes("\u5143\u6570\u636e\u53ef\u89c1 / \u4e0d\u7b49\u4e8e\u53ef\u8c03\u7528"),
        hasSnapshotFreshness: managerStillLoading || managerText.includes("\u5feb\u7167\u65b0\u9c9c\u5ea6"),
        hasSnapshotRefreshState: managerStillLoading || managerText.includes("\u5f53\u524d\u65e0\u9700\u5237\u65b0")
          || managerText.includes("\u5feb\u7167\u5df2\u8fc7\u671f\u6216\u7f3a\u5931")
          || managerText.includes("\u539f\u751f Codex \u672c\u5730\u529f\u80fd\u5df2\u53d8\u5316"),
        hasRouteSummaryCard: managerStillLoading || managerText.includes("\u6700\u8fd1\u8def\u7531"),
        hasRouteProviderFields: managerStillLoading || (managerText.includes("\u4f20\u8f93") && managerText.includes("Provider") && managerText.includes("\u534f\u8bae")),
        hasNoFakeCallableNotice: managerStillLoading || managerText.includes("\u672a\u6388\u6743\u8fde\u63a5\u5668\u4e0d\u4f2a\u88c5\u6210\u53ef\u8c03\u7528\u5de5\u5177") || managerText.includes("\u4ec5\u663e\u793a\u771f\u5b9e\u6388\u6743\u540e\u53ef\u8c03\u7528\u7684\u5e94\u7528\u5de5\u5177"),
        hasPrettyModelName: managerStillLoading || /Gemini\\s+\\d|Claude\\s+\\w+\\s+\\d|GPT-OSS\\s+\\d/.test(managerText),
        hasNativeThinkingBudget: managerStillLoading || managerText.includes("\u539f\u751f\u601d\u8003\u9884\u7b97"),
        hasEndpointFetchFailure: /Failed to fetch|\u5e94\u7528\u5de5\u5177\uff1a\s*Failed/.test(managerText),
        closedByButton,
        reopened,
        removed: !document.getElementById("anticodex-manager-overlay"),
        href: location.href,
      };
    })()`, {
      returnByValue: true,
      awaitPromise: true,
    }), Math.max(timeoutMs, managerProbeTimeoutMs));
    } catch (error) {
      managerProbeError = error;
      managerResult = null;
      break;
    }
    const value = managerResult.result?.value || null;
    if (value && Object.keys(value).length > 0 && !managerResult.exceptionDetails) break;
    await sleep(250);
  }
  ws.close();
  evaluated = pageResult.result?.value || null;
  managerOverlay = managerResult?.result?.value || null;
  if (!managerOverlay) {
    const exceptionText = managerResult?.exceptionDetails?.exception?.description
      || managerResult?.exceptionDetails?.text
      || "";
    if (selectedContextProbe?.version === "native-panel-v91") {
      managerOverlay = {
        dynamicProbeUnavailable: true,
        probeError: managerProbeError?.message || exceptionText || "manager overlay probe did not return a value",
        hasFunction: selectedContextProbe?.hasOpen === true,
        version: selectedContextProbe?.version || "",
        installed: selectedContextProbe?.version === "native-panel-v91",
        hasButton: selectedContextProbe?.hasButton === true,
        buttonText: selectedContextProbe?.buttonText || "",
        coveredBy: "context-probe-and-manager-page",
        exceptionDetails: managerResult?.exceptionDetails || null,
      };
    } else {
      managerOverlay = {
        probeError: managerProbeError?.message || exceptionText || "manager overlay probe did not return a value",
        exceptionDetails: managerResult?.exceptionDetails || null,
      };
    }
  }
  const targetsAfterManager = await getJson(`http://127.0.0.1:${port}/json`);
  const targetListAfterManager = Array.isArray(targetsAfterManager) ? targetsAfterManager : targetsAfterManager.value || [];
  const managerPageTargets = targetListAfterManager.filter((item) => String(item.url || "").includes("/anticodex/manager"));
  if (targetListAfterManager.length !== targetList.length) {
    failures.push(`manager overlay changed CDP target count: ${targetList.length} -> ${targetListAfterManager.length}`);
  }
  if (managerPageTargets.length > 0) {
    failures.push(`manager opened a separate page target: ${managerPageTargets.map((item) => item.url).join(", ")}`);
  }
  if (!managerOverlay?.hasFunction) failures.push("in-app manager function is not injected");
  if (managerOverlay?.version !== "native-panel-v91") failures.push(`in-app manager version is '${managerOverlay?.version || ""}', expected native-panel-v91`);
  if (!managerOverlay?.installed) failures.push("in-app manager install flag is not set");
  const managerOverlayDynamicUnavailable = managerOverlay?.dynamicProbeUnavailable === true;
  if (managerOverlayDynamicUnavailable) {
    modeNotes.push(`manager overlay dynamic probe skipped: ${managerOverlay?.probeError || "unknown error"}`);
  }
  if (!managerOverlayDynamicUnavailable) {
  if (!managerOverlay?.hasActionBridge) failures.push("in-app manager action bridge is not injected");
  if (!managerOverlay?.bridgeReady) failures.push("in-app manager action bridge is not ready");
  if (!managerOverlay?.hasSnapshot) failures.push("in-app manager snapshot is not preloaded");
  if ((managerOverlay?.apiCandidateCount || 0) < 1) failures.push("in-app manager API candidates are empty");
  if (managerOverlay?.hasButton) failures.push("in-app manager still exposes the removed floating Manager button");
  if (!managerOverlay?.opened) failures.push("in-app manager overlay did not open");
  if (!managerOverlay?.closeCenterHitsButton) failures.push("in-app manager close button center point does not hit the close button");
  if (!managerOverlay?.closeHitGridAll) failures.push(`in-app manager close button full hit grid is incomplete: ${JSON.stringify(managerOverlay?.closeHitSamples || [])}`);
  if ((managerOverlay?.closeHeight || 0) < 44) failures.push(`in-app manager close button height is ${managerOverlay?.closeHeight || 0}, expected at least 44`);
  if ((managerOverlay?.reopenedCloseHeight || 0) < 44) failures.push(`in-app manager reopened close button height is ${managerOverlay?.reopenedCloseHeight || 0}, expected at least 44`);
  if ((managerOverlay?.actionButtonMinHeight || 0) < 40) failures.push(`in-app manager action button min height is ${managerOverlay?.actionButtonMinHeight || 0}, expected at least 40`);
  if (!skipManagerActionProbe) {
    if (managerOverlay?.busyAttrDuringAction !== "true") failures.push("in-app manager actions did not expose busy state during action");
    if ((managerOverlay?.disabledDuringAction || 0) < (managerOverlay?.actionCount || 0)) failures.push(`in-app manager disabled ${managerOverlay?.disabledDuringAction || 0}/${managerOverlay?.actionCount || 0} action buttons during action`);
    if (managerOverlay?.runningMarkerDuringAction !== "refreshStatus") failures.push(`in-app manager running marker is '${managerOverlay?.runningMarkerDuringAction || ""}'`);
  }
  if (!managerOverlay?.closedByButton) failures.push("in-app manager close button did not close the overlay");
  if (!managerOverlay?.reopened) failures.push("in-app manager overlay did not reopen after close-button verification");
  if (!managerOverlay?.removed) failures.push("in-app manager overlay did not cleanly close after verification");
  if (managerOverlay?.ariaLabel !== "Anti-Codex \u7ba1\u7406") failures.push(`in-app manager aria label is '${managerOverlay?.ariaLabel || ""}'`);
  if (managerOverlay?.closeText !== "\u5173\u95ed") failures.push(`in-app manager close button text is '${managerOverlay?.closeText || ""}'`);
  if (managerOverlay?.headingText !== "Anti-Codex \u7ba1\u7406") failures.push(`in-app manager heading is '${managerOverlay?.headingText || ""}'`);
  if (!managerOverlay?.hasEmbeddedPanel) failures.push("in-app manager embedded panel is missing");
  if (!managerOverlay?.hasActionResultMarker) failures.push("in-app manager action result marker is missing");
  if (!managerOverlay?.hasAccountSwitchAction) failures.push("in-app manager account switch action is missing");
  if (!managerOverlay?.upstreamConfigOpened) failures.push("in-app manager third-party API config panel did not open");
  if (!managerOverlay?.upstreamConfigConfirming) failures.push("in-app manager upstreamConfig did not require a first-click confirmation");
  if (managerOverlay?.upstreamConfigOpenedBeforeConfirm) failures.push("in-app manager upstreamConfig opened before second-click confirmation");
  if (!managerOverlay?.upstreamConfigEmbeddedInOverlay) failures.push("in-app manager third-party API config panel is not embedded in the overlay");
  if (!managerOverlay?.upstreamConfigSaveInitiallyDisabled) failures.push("in-app manager third-party API save button is enabled before a successful connection test");
  if (!managerOverlay?.upstreamConfigHasSafeWarning) failures.push("in-app manager third-party API config panel is missing no-fallback/no-history-loss warning");
  if (!managerOverlay?.upstreamConfigHasExpectedControls) failures.push("in-app manager third-party API config panel is missing protocol/key/test/save/restore controls");
  if (!sameActionIds(managerOverlay?.dailyActionIds, expectedDailyActionIds)) failures.push(`in-app manager daily action group is incorrect: ${JSON.stringify(managerOverlay?.dailyActionIds || [])}`);
  if (!sameActionIds(managerOverlay?.highImpactActionIds, expectedHighImpactActionIds)) failures.push(`in-app manager high-impact action group is incorrect: ${JSON.stringify(managerOverlay?.highImpactActionIds || [])}`);
  if (managerOverlay?.highImpactDangerCount !== expectedHighImpactActionIds.length) failures.push(`in-app manager has ${managerOverlay?.highImpactDangerCount || 0}/${expectedHighImpactActionIds.length} danger-styled high-impact buttons`);
  if (!managerOverlay?.highImpactDarkRed) failures.push("in-app manager high-impact buttons are not consistently dark red");
  if (!managerOverlay?.highImpactAllRequireFirstClickConfirmation) failures.push(`in-app manager high-impact actions did not all require first-click confirmation: ${JSON.stringify(managerOverlay?.highImpactFirstClickResults || [])}`);
  if (!managerOverlay?.highImpactFirstClicksDidNotRun) failures.push("in-app manager first-click high-impact confirmations still queued or ran an action");
  if (!managerOverlay?.highImpactSecondClickRuns) failures.push("in-app manager high-impact action did not run on second click");
  if (!managerOverlay?.managerThemeMatchesHost) failures.push(`in-app manager theme '${managerOverlay?.managerTheme || ""}' does not match host theme '${managerOverlay?.hostTheme || ""}'`);
  if (!managerOverlay?.themeChangedWithHostClass) failures.push("in-app manager did not react to the Codex electron theme class changing");
  if (!managerOverlay?.themeRestoredWithHostClass) failures.push("in-app manager did not restore after the Codex electron theme class was restored");
  if (!managerOverlay?.hasDistinctThemePalettes) failures.push("in-app manager does not expose distinct light and dark palettes");
  if (!managerOverlay?.hasKnownPluginCount) failures.push("in-app manager plugin count is unknown or missing");
  if (!managerOverlay?.hasKnownConnectorCount) failures.push("in-app manager connector count is unknown or missing");
  if (!managerOverlay?.hasAuthorizedConnectorCount) failures.push("in-app manager authorized connector count is missing");
  if (!managerOverlay?.hasConnectorAllowlistCard) failures.push("in-app manager local connector allowlist card is missing");
  if (!managerOverlay?.hasConnectorAllowlistInput) failures.push("in-app manager local connector allowlist input is missing");
  if (!managerOverlay?.hasConnectorAllowlistSave) failures.push("in-app manager local connector allowlist save button is missing");
  if (!managerOverlay?.hasAppToolCount) failures.push("in-app manager app tool count is missing");
  if (!managerOverlay?.hasLocalSkillCount) failures.push("in-app manager local Skill count is missing");
  if (!managerOverlay?.hasLocalMcpCount) failures.push("in-app manager local MCP count is missing");
  if (!managerOverlay?.hasMcpSessionToolBoundary) failures.push("in-app manager does not explain that MCP callability follows the current session tool list");
  if (!managerOverlay?.hasPluginMetadataBoundary) failures.push("in-app manager does not distinguish plugin metadata from callable tools");
  if (!managerOverlay?.hasSnapshotFreshness) failures.push("in-app manager local feature snapshot freshness is missing");
  if (!managerOverlay?.hasSnapshotRefreshState) failures.push("in-app manager local feature snapshot refresh guidance is missing");
  if (!managerOverlay?.hasRouteSummaryCard) failures.push("in-app manager route summary card is missing");
  if (!managerOverlay?.hasRouteProviderFields) failures.push("in-app manager route summary is missing third-party provider/protocol/transport fields");
  if (!managerOverlay?.hasNoFakeCallableNotice) failures.push("in-app manager missing no-fake-callable connector notice");
  if (!managerOverlay?.hasPrettyModelName) failures.push("in-app manager model list does not show display names");
  if (upstreamMode !== "third-party" && !managerOverlay?.hasNativeThinkingBudget) failures.push("in-app manager model list does not show native thinking budgets");
  if (managerOverlay?.hasEndpointFetchFailure) failures.push("in-app manager still shows endpoint fetch failure");
  {
    const overlayMojibake = mojibakeMatch(managerOverlay?.textSample);
    if (overlayMojibake) failures.push(`in-app manager rendered mojibake text: ${overlayMojibake}`);
  }
  if (managerOverlay?.hasIframe) failures.push("in-app manager still uses an iframe");
  if ((managerOverlay?.actionCount || 0) < 13) failures.push(`in-app manager action count is ${managerOverlay?.actionCount || 0}, expected at least 13`);
  }

  if (!evaluated) {
    failures.push("CDP evaluation returned no page state");
  } else {
    if (evaluated.title !== "Anti-Codex") failures.push(`page title is '${evaluated.title}'`);
    if (evaluated.hasLoginText) failures.push("page contains ChatGPT login text");
    if (evaluated.hasReconnectText) failures.push("page contains reconnect text");
    const pageMojibake = mojibakeMatch(evaluated.textSample);
    if (pageMojibake) failures.push(`main page rendered mojibake text: ${pageMojibake}`);
    const modelEvidenceText = [
      evaluated?.textSample,
      selectedContextProbe?.text,
      managerOverlay?.textSample,
    ].map((value) => String(value || "")).join("\n");
    matchedModelText = labels.find((label) => modelEvidenceText.includes(label)) || "";
    if (!matchedModelText) {
      const labelScope = upstreamMode === "third-party" ? "provider" : "Antigravity";
      failures.push(`page text does not include any current ${labelScope} model label or ID`);
    }
  }
} catch (err) {
  failures.push(err?.message || String(err));
} finally {
  releaseManagerButtonLock(managerButtonLock);
}

const output = {
  ok: failures.length === 0,
  failures,
  port,
  baseUrl,
  target: target ? { id: target.id, title: target.title, url: target.url } : null,
  selectedContextId,
  selectedContextProbe,
  page: evaluated,
  managerOverlay,
  managerPage,
  upstreamMode,
  upstreamProtocol,
  upstreamModel,
  modeNotes,
  upstreamHealth: upstreamHealth ? {
    ok: upstreamHealth.ok,
    upstream: upstreamHealth.upstream,
    mode: upstreamMode,
    protocol: upstreamProtocol,
    model: upstreamModel,
  } : null,
  modelCount,
  modelIds,
  expectedLabelCount: labels.length,
  catalogModelCount: catalogModels.length,
  catalogLabels: catalogCheck.catalogLabels,
  matchedModelText,
};

console.log(asciiJson(output));
if (!output.ok) process.exit(1);



