#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";

const port = Number(process.argv[2] || process.env.DEEPCODEX_CDP_PORT || 58317);
const scriptPath = process.argv[3] || new URL("./deepcodex-plugin-unlock-inject.js", import.meta.url).pathname;
const isManagerScript = scriptPath.toLowerCase().endsWith("anticodex-manager-inject.js");
const managerWatchMode = isManagerScript && (
  process.env.DEEPCODEX_CDP_MANAGER_WATCH === "1" || process.argv.includes("--watch")
);
const attempts = Number(process.env.DEEPCODEX_CDP_ATTEMPTS || (managerWatchMode ? 999999 : 40));
const delayMs = Number(process.env.DEEPCODEX_CDP_DELAY_MS || 500);
const MANAGER_FETCH_TIMEOUT_MS = Number(process.env.ANTICODEX_MANAGER_FETCH_TIMEOUT_MS || 2500);
const stablePasses = Number(process.env.DEEPCODEX_CDP_STABLE_PASSES || 1);
const stableDelayMs = Number(process.env.DEEPCODEX_CDP_STABLE_DELAY_MS || 3000);
const managerHeartbeatMs = Number(process.env.DEEPCODEX_CDP_MANAGER_HEARTBEAT_MS || 1000);
const managerDisconnectMs = Number(process.env.DEEPCODEX_CDP_MANAGER_DISCONNECT_MS || 30000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 3000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${response.statusCode} ${response.statusMessage}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Timed out fetching ${url}.`));
    });
    request.on("error", reject);
  });
}

function pickTarget(targets) {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pages.find((target) => `${target.title || ""} ${target.url || ""}`.toLowerCase().includes("codex")) || pages[0] || null;
}

function localManagerUrlCandidates(portNumber = 8484) {
  const scored = [{ score: 0, url: `http://127.0.0.1:${portNumber}` }];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry?.family !== "IPv4" || entry.internal || !entry.address) continue;
      const address = entry.address;
      if (/^169\.254\./.test(address)) continue;
      if (/^198\.(1[89]|[2-9]\d)\./.test(address)) continue;
      const score = /^192\.168\./.test(address)
        ? 10
        : /^10\./.test(address)
          ? 20
          : /^172\.(1[6-9]|2\d|3[01])\./.test(address)
            ? 30
            : 80;
      scored.push({ score, url: `http://${address}:${portNumber}` });
    }
  }
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.url);
}

async function fetchManagerJson(baseUrl, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANAGER_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new Error(`${response.status} ${response.statusText}: invalid JSON`);
    }
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.executionContexts = new Map();
    this.closed = false;
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async open() {
    const key = crypto.randomBytes(16).toString("base64");
    const path = `${this.url.pathname}${this.url.search}`;
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    this.socket.once("close", () => this.signalClosed());
    this.socket.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening ${this.url.href}.`)), 5000);
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
      this.socket.off("data", this.onData);
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
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        length = high * 2 ** 32 + low;
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
      const opcode = first & 0x0f;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode !== 0x1) continue;
      this.handleMessage(payload.toString("utf8"));
    }
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (message.method === "Runtime.executionContextCreated") {
      const context = message.params?.context;
      if (context?.id) this.executionContexts.set(context.id, context);
    } else if (message.method === "Runtime.executionContextDestroyed") {
      const contextId = message.params?.executionContextId;
      if (contextId) this.executionContexts.delete(contextId);
    } else if (message.method === "Runtime.executionContextsCleared") {
      this.executionContexts.clear();
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message);
  }

  sendText(text) {
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

  call(id, method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response id ${id} (${method}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendText(JSON.stringify({ id, method, params }));
    });
  }

  signalClosed() {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
  }

  waitForClose() {
    return this.closedPromise;
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
    this.signalClosed();
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
      const value = probe.result?.result?.value || {};
      const haystack = `${value.title || ""}\n${value.href || ""}\n${value.text || ""}`;
      if (/Anti-Codex|app:\/\/-|新对话|进入项目工作|Gemini|管理/.test(haystack)) {
        return contextId;
      }
    } catch {}
  }
  return ids[0] || null;
}

async function injectOnce() {
  const targets = await json(`http://127.0.0.1:${port}/json`);
  const target = pickTarget(targets);
  if (!target) throw new Error("No Codex page target found.");
  let source = fs.readFileSync(scriptPath, "utf8");
  const isManagerInject = scriptPath.toLowerCase().endsWith("anticodex-manager-inject.js");
  if (isManagerInject) {
    const managerApi = String(process.env.ANTICODEX_MANAGER_API || process.env.TRANSLATOR_URL || "").replace(/\/$/, "");
    const managerPort = Number(process.env.TRANSLATOR_PORT || 8484);
    const loopbackManagerApi = `http://127.0.0.1:${managerPort}`;
    const candidates = [
      loopbackManagerApi,
      managerApi,
      process.env.TRANSLATOR_HOST && process.env.TRANSLATOR_PORT ? `http://${process.env.TRANSLATOR_HOST}:${process.env.TRANSLATOR_PORT}` : "",
      ...localManagerUrlCandidates(managerPort),
    ].filter(Boolean).map((value) => String(value).replace(/\/$/, ""));
    const snapshot = { ok: false, baseUrl: managerApi || candidates[0] || "http://127.0.0.1:8484", responses: {}, errors: {} };
    for (const baseUrl of [...new Set(candidates)]) {
      const candidateResponses = {};
      const candidateErrors = {};
      try {
        for (const path of [
          "/anticodex/manager/bootstrap",
          "/health",
          "/models",
          "/anticodex/diagnostics",
          "/backend-api/ps/plugins/installed",
          "/backend-api/aip/connectors",
        ]) {
          try {
            candidateResponses[path] = await fetchManagerJson(baseUrl, path);
          } catch (err) {
            candidateErrors[path] = String(err?.message || err);
          }
        }
        snapshot.ok = candidateResponses["/health"]?.ok === true;
        if (snapshot.ok) {
          snapshot.baseUrl = baseUrl;
          snapshot.responses = candidateResponses;
          snapshot.errors = candidateErrors;
          break;
        }
      } catch {}
      snapshot.errors[baseUrl] = candidateErrors;
    }
    source = [
      `globalThis.__ANTICODEX_MANAGER_API__ = ${JSON.stringify(managerApi || candidates[0] || "http://127.0.0.1:8484")};`,
      `globalThis.__ANTICODEX_MANAGER_API_CANDIDATES__ = ${JSON.stringify([...new Set(candidates)])};`,
      `globalThis.__ANTICODEX_MANAGER_SNAPSHOT__ = ${JSON.stringify(snapshot)};`,
      source,
    ].join("\n");
  }
  const newDocumentSource = isManagerInject
    ? [
        "(() => {",
        "  const installAntiCodexManager = () => {",
        source,
        "  };",
        "  if (document.readyState === \"loading\") {",
        "    document.addEventListener(\"DOMContentLoaded\", installAntiCodexManager, { once: true });",
        "  } else {",
        "    installAntiCodexManager();",
        "  }",
        "})();",
      ].join("\n")
    : source;
  const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
  await ws.open();
  let id = 1;
  await ws.call(id++, "Runtime.enable");
  await ws.call(id++, "Page.enable");
  const frameTree = await ws.call(id++, "Page.getFrameTree");
  const mainFrameId = frameTree.result?.frameTree?.frame?.id || null;
  await waitForDefaultContext(ws, mainFrameId, 5000);
  const pageContextId = await pickVisiblePageContextId(ws, mainFrameId, () => id++);
  if (!pageContextId) {
    ws.close();
    throw new Error("No default page execution context found for CDP injection.");
  }
  const runtimeParams = (expression, params = {}) => {
    return {
      expression,
      ...params,
      contextId: pageContextId,
    };
  };
  await ws.call(id++, "Page.addScriptToEvaluateOnNewDocument", { source: newDocumentSource });
  const evaluation = await ws.call(id++, "Runtime.evaluate", runtimeParams(source, {
    awaitPromise: false,
    allowUnsafeEvalBlockedByCSP: true,
  }));
  const exceptionDetails = evaluation.result?.exceptionDetails;
  if (exceptionDetails) {
    const detail = exceptionDetails.exception?.description || exceptionDetails.text || "unknown runtime exception";
    const label = isManagerInject ? "Manager injection failed" : "CDP injection failed";
    ws.close();
    throw new Error(`${label}: ${detail}`);
  }
  if (isManagerInject) {
      const verification = await ws.call(id++, "Runtime.evaluate", runtimeParams(`Boolean(
        window.__ANTICODEX_MANAGER_VERSION__ &&
        typeof window.__ANTICODEX_OPEN_MANAGER__ === "function"
      )`, {
      returnByValue: true,
      awaitPromise: false,
    }));
    if (verification.result?.result?.value !== true) {
      ws.close();
      throw new Error("Manager injection verification failed.");
    }
  }
  let maintenance = null;
  if (managerWatchMode) {
    const maintainManager = async () => {
      let consecutiveFailures = 0;
      while (!ws.closed) {
        await sleep(Math.max(250, managerHeartbeatMs));
        if (ws.closed) break;
        try {
          const heartbeat = await ws.call(id++, "Runtime.evaluate", runtimeParams(`Boolean(
              window.__ANTICODEX_MANAGER_VERSION__ &&
              typeof window.__ANTICODEX_OPEN_MANAGER__ === "function"
            )`, {
            returnByValue: true,
            awaitPromise: false,
          }));
          if (heartbeat.result?.result?.value !== true) {
            await ws.call(id++, "Runtime.evaluate", runtimeParams(newDocumentSource, {
              awaitPromise: false,
              allowUnsafeEvalBlockedByCSP: true,
            }));
          }
          consecutiveFailures = 0;
        } catch {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            ws.close();
            break;
          }
        }
      }
    };
    maintenance = maintainManager();
  } else {
    ws.close();
  }
  return { target, connection: managerWatchMode ? ws : null, maintenance };
}

let lastError;
let lastTarget;
let successfulPasses = 0;
let watcherAnnounced = false;
let managerDisconnectedSince = 0;
for (let i = 0; i < attempts; i++) {
  try {
    const injected = await injectOnce();
    managerDisconnectedSince = 0;
    lastTarget = injected.target;
    successfulPasses += 1;
    if (managerWatchMode && injected.connection) {
      if (!watcherAnnounced) {
        console.log(JSON.stringify({
          ok: true,
          port,
          watching: true,
          mode: "poll",
          target: { id: lastTarget.id, title: lastTarget.title, url: lastTarget.url },
        }));
        watcherAnnounced = true;
      }
      await injected.connection.waitForClose();
      await injected.maintenance;
      successfulPasses = 0;
      await sleep(Math.max(500, managerHeartbeatMs));
      continue;
    }
    if (successfulPasses >= Math.max(1, stablePasses)) {
      console.log(JSON.stringify({
        ok: true,
        port,
        stablePasses: successfulPasses,
        target: { id: lastTarget.id, title: lastTarget.title, url: lastTarget.url },
      }));
      process.exit(0);
    }
    await sleep(Math.max(0, stableDelayMs));
  } catch (err) {
    lastError = err;
    successfulPasses = 0;
    if (managerWatchMode) {
      if (!managerDisconnectedSince) managerDisconnectedSince = Date.now();
      if (Date.now() - managerDisconnectedSince >= Math.max(5000, managerDisconnectMs)) {
        console.error(`[deepcodex-cdp-inject] manager watcher disconnected timeout: ${lastError?.message || lastError}`);
        process.exit(0);
      }
    }
    await sleep(delayMs);
  }
}

console.error(`[deepcodex-cdp-inject] failed: ${lastError?.stack || lastError}`);
process.exit(1);
