#!/usr/bin/env node
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ownerProcessIsAlive } from "./lib/anticodex-owner-process.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") || process.env.DEEPCODEX_CDP_PORT || 58317);
const baseUrl = String(args.get("--base-url") || process.env.ANTICODEX_MANAGER_API || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const supervisorPid = Number(process.env.ANTICODEX_SUPERVISOR_PID || 0);
const MCP_SKILLS_MANAGER_HTTP_TIMEOUT_MS = 430000;
const ALLOWED_MANAGER_BRIDGE_REQUESTS = new Map([
  ["/anticodex/manager/bootstrap", new Set(["GET"])],
  ["/health", new Set(["GET"])],
  ["/models", new Set(["GET"])],
  ["/anticodex/diagnostics", new Set(["GET"])],
  ["/anticodex/account", new Set(["GET"])],
  ["/anticodex/upstream-profile", new Set(["GET", "POST"])],
  ["/anticodex/model-routes", new Set(["GET"])],
  ["/anticodex/upstream-test", new Set(["POST"])],
  ["/anticodex/local-connectors/allowlist", new Set(["GET", "POST"])],
  ["/backend-api/ps/plugins/installed", new Set(["GET"])],
  ["/backend-api/aip/connectors", new Set(["GET"])],
  ["/backend-api/plugins/list", new Set(["GET"])],
  ["/backend-api/wham/apps", new Set(["GET"])],
]);
const MANAGER_BRIDGE_REQUEST_BODY_LIMIT = 1024 * 1024;
const MANAGER_ACTION_HTTP_TIMEOUT_MS = 300000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const triStateText = (value) => value === true ? "true" : (value === false ? "false" : "unknown");

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body ? Buffer.from(options.body) : null;
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || "GET",
      timeout: options.timeout || 120000,
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
    request.on("timeout", () => request.destroy(new Error(`Timed out: ${url}`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.onEvent = null;
    this.onClose = null;
    this.failureNotified = false;
  }
  async open() {
    const key = crypto.randomBytes(16).toString("base64");
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    this.socket.on("close", () => this.handleFailure(new Error("WebSocket closed.")));
    this.socket.on("error", (error) => this.handleFailure(error));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Timed out opening ${this.url.href}`);
        this.socket?.destroy(error);
        reject(error);
      }, 5000);
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
        else resolve();
      };
      this.socket.on("data", onHandshake);
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }
  handleFailure(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.failureNotified) return;
    this.failureNotified = true;
    this.onClose?.(error);
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
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message);
      } else if (message.method) {
        this.onEvent?.(message);
      }
    }
  }
  sendText(text) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new Error("WebSocket is closed.");
    }
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
  call(id, method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendText(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    this.onClose = null;
    this.handleFailure(new Error("WebSocket closed by Manager bridge."));
    this.socket?.destroy();
  }
}

export function managerBridgeFailureRequiresReconnect(error) {
  const message = String(error?.message || error || "");
  return /target crashed|websocket[^\n]*closed|socket[^\n]*closed|econnreset|econnrefused|epipe|detached|connection[^\n]*closed|write after end/i.test(message);
}

export class ManagerBridgeRecoveryController {
  constructor(options = {}) {
    if (typeof options.openSession !== "function") throw new TypeError("openSession must be a function.");
    if (typeof options.pollSession !== "function") throw new TypeError("pollSession must be a function.");
    this.openSession = options.openSession;
    this.pollSession = options.pollSession;
    this.deliverRequest = options.deliverRequest ?? (async () => {});
    this.sleep = options.sleep ?? sleep;
    this.isOwnerAlive = options.isOwnerAlive ?? (() => true);
    this.logger = options.logger ?? console;
    this.maxConsecutivePollFailures = Math.max(1, Number(options.maxConsecutivePollFailures) || 3);
    this.backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length > 0
      ? options.backoffMs.map((value) => Math.max(0, Number(value) || 0))
      : [250, 500, 1_000, 2_000, 5_000];
    this.currentSession = null;
    this.reconnectPromise = null;
    this.pollPromise = null;
    this.consecutivePollFailures = 0;
    this.stopped = false;
  }

  status() {
    return {
      connected: this.currentSession !== null,
      consecutivePollFailures: this.consecutivePollFailures,
      polling: this.pollPromise !== null,
      reconnecting: this.reconnectPromise !== null,
    };
  }

  async start() {
    this.stopped = false;
    return this.requestReconnect("startup");
  }

  detachCurrentSession() {
    const session = this.currentSession;
    this.currentSession = null;
    if (!session) return;
    try { session.setFailureHandler?.(null); } catch {}
    try { session.close?.(); } catch {}
  }

  async requestReconnect(reason = "unknown") {
    if (this.stopped || !this.isOwnerAlive()) return null;
    if (this.reconnectPromise) return this.reconnectPromise;
    const reconnect = (async () => {
      this.detachCurrentSession();
      let attempt = 0;
      while (!this.stopped && this.isOwnerAlive()) {
        try {
          const session = await this.openSession();
          if (!session) throw new Error("No Anti-Codex page target found.");
          if (this.stopped || !this.isOwnerAlive()) {
            try { session.close?.(); } catch {}
            return null;
          }
          session.setFailureHandler?.((error) => {
            void this.notifySessionFailure(session, error);
          });
          this.currentSession = session;
          this.consecutivePollFailures = 0;
          this.logger.log?.(JSON.stringify({
            event: "manager-bridge-connected",
            reason,
            attempt: attempt + 1,
            target: session.target
              ? { id: session.target.id, title: session.target.title, url: session.target.url }
              : undefined,
          }));
          return session;
        } catch (error) {
          if (this.stopped || !this.isOwnerAlive()) return null;
          const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)];
          attempt += 1;
          this.logger.error?.(`[anticodex-manager-bridge] reconnect failed (${reason}, attempt ${attempt}): ${error.message}`);
          await this.sleep(delay);
        }
      }
      return null;
    })();
    this.reconnectPromise = reconnect;
    try {
      return await reconnect;
    } finally {
      if (this.reconnectPromise === reconnect) this.reconnectPromise = null;
    }
  }

  async notifySessionFailure(session, error) {
    if (this.stopped || session !== this.currentSession) return null;
    this.logger.error?.(`[anticodex-manager-bridge] session failed: ${error?.message || error}`);
    return this.requestReconnect(error?.message || "session failure");
  }

  async pollOnce() {
    if (this.stopped || !this.isOwnerAlive()) return [];
    if (this.pollPromise) return this.pollPromise;
    const poll = (async () => {
      if (!this.currentSession) await this.requestReconnect("poll without session");
      const session = this.currentSession;
      if (!session) return [];
      try {
        const queued = await this.pollSession(session);
        if (session === this.currentSession) this.consecutivePollFailures = 0;
        if (Array.isArray(queued)) {
          for (const request of queued) {
            if (this.stopped || !this.isOwnerAlive()) break;
            await this.deliverRequest(request, this.currentSession ?? session);
          }
        }
        return Array.isArray(queued) ? queued : [];
      } catch (error) {
        if (session !== this.currentSession) return [];
        this.consecutivePollFailures += 1;
        this.logger.error?.(`[anticodex-manager-bridge] poll failed (${this.consecutivePollFailures}/${this.maxConsecutivePollFailures}): ${error.message}`);
        if (
          managerBridgeFailureRequiresReconnect(error)
          || this.consecutivePollFailures >= this.maxConsecutivePollFailures
        ) {
          await this.requestReconnect(error.message || "poll failure");
        }
        return [];
      }
    })();
    this.pollPromise = poll;
    try {
      return await poll;
    } finally {
      if (this.pollPromise === poll) this.pollPromise = null;
    }
  }

  async run(options = {}) {
    const intervalMs = Math.max(0, Number(options.intervalMs) || 250);
    while (!this.stopped && this.isOwnerAlive()) {
      await this.pollOnce();
      if (!this.stopped && this.isOwnerAlive()) await this.sleep(intervalMs);
    }
    this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.detachCurrentSession();
  }
}

export class ManagerActionExecutionLedger {
  constructor() {
    this.entries = new Map();
  }

  runOnce(requestId, execute) {
    const id = String(requestId || "");
    if (!id) throw new TypeError("A Manager requestId is required.");
    if (typeof execute !== "function") throw new TypeError("A Manager action executor is required.");
    if (this.entries.has(id)) return this.entries.get(id);
    const execution = Promise.resolve().then(execute);
    this.entries.set(id, execution);
    execution.catch(() => {
      if (this.entries.get(id) === execution) this.entries.delete(id);
    });
    return execution;
  }

  acknowledge(requestId) {
    return this.entries.delete(String(requestId || ""));
  }

  has(requestId) {
    return this.entries.has(String(requestId || ""));
  }
}

export function createManagerBridgeSource() {
  return `
(() => {
  globalThis.__ANTICODEX_MANAGER_BRIDGE_READY__ = true;
  globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__ ||= {};
  globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ ||= [];
  globalThis.__ANTICODEX_ACK_MANAGER_ACTION__ = (id, payload) => {
    const entry = globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__?.[id];
    globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ =
      (globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ || []).filter((request) => request?.id !== id);
    if (!entry) return;
    delete globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id];
    entry.resolve(payload);
  };
  globalThis.__ANTICODEX_RESOLVE_MANAGER_ACTION__ = globalThis.__ANTICODEX_ACK_MANAGER_ACTION__;
  globalThis.__ANTICODEX_RUN_MANAGER_ACTION__ = (action) => new Promise((resolve) => {
    const id = Date.now() + ":" + Math.random().toString(36).slice(2);
    globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve };
    globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__.push({ id, action, leaseCount: 0 });
  });
  globalThis.__ANTICODEX_RUN_MANAGER_REQUEST__ = (path, options = {}) => new Promise((resolve) => {
    const id = Date.now() + ":" + Math.random().toString(36).slice(2);
    globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve };
    globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__.push({
      id,
      kind: "manager-request",
      path,
      options,
      leaseCount: 0,
    });
  });
})()`;
}

export function createManagerQueuePollSource(bridgeSource = createManagerBridgeSource()) {
  return `
(() => {
  if (
    typeof globalThis.__ANTICODEX_RUN_MANAGER_ACTION__ !== "function" ||
    typeof globalThis.__ANTICODEX_RUN_MANAGER_REQUEST__ !== "function" ||
    typeof globalThis.__ANTICODEX_ACK_MANAGER_ACTION__ !== "function"
  ) {
    ${bridgeSource}
  }
  const queue = globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ || [];
  return queue.map((request) => {
    request.leaseCount = Number(request.leaseCount || 0) + 1;
    request.leasedAt = Date.now();
    return { ...request };
  });
})()`;
}

export async function deliverManagerPayloadWithReconnect(
  controller,
  initialSession,
  expression,
  options = {},
) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
  const logger = options.logger ?? controller?.logger ?? console;
  let deliverySession = controller?.currentSession ?? initialSession;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!deliverySession) {
      deliverySession = await controller?.requestReconnect("manager payload delivery without session");
    }
    if (!deliverySession) {
      lastError = new Error("Manager bridge renderer is unavailable for delivery.");
    } else {
      try {
        await deliverySession.evaluate(expression);
        if (attempt > 1) {
          logger.log?.(JSON.stringify({
            event: "manager-delivery-recovered",
            attempt,
            maxAttempts,
          }));
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }

    if (attempt >= maxAttempts) break;
    logger.error?.(JSON.stringify({
      event: "manager-delivery-retry",
      attempt,
      maxAttempts,
      error: lastError?.message || String(lastError),
    }));
    const failedSession = deliverySession;
    deliverySession = controller?.currentSession;
    if (failedSession && failedSession === controller?.currentSession) {
      deliverySession = await controller.notifySessionFailure(failedSession, lastError);
    }
    deliverySession ||= controller?.currentSession;
  }

  logger.error?.(JSON.stringify({
    event: "manager-delivery-exhausted",
    attempts: maxAttempts,
    error: lastError?.message || String(lastError),
  }));
  throw new Error(`Manager payload delivery failed after ${maxAttempts} attempts.`, { cause: lastError });
}

async function cdpTargets() {
  return httpJson(`http://127.0.0.1:${port}/json`, { timeout: 3000 });
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

async function managerSnapshot() {
  const responses = {};
  const errors = {};
  const trustedHeaders = {
    origin: baseUrl,
    referer: `${baseUrl}/anticodex/manager`,
  };
  for (const path of [
    "/anticodex/manager/bootstrap",
    "/health",
    "/models",
    "/anticodex/diagnostics",
    "/anticodex/upstream-profile",
    "/anticodex/model-routes",
    "/anticodex/local-connectors/allowlist",
    "/backend-api/ps/plugins/installed",
    "/backend-api/aip/connectors",
    "/backend-api/plugins/list",
  ]) {
    try { responses[path] = await httpJson(`${baseUrl}${path}`, { timeout: 10000, headers: trustedHeaders }); }
    catch (error) { errors[path] = error.message; }
  }
  try { responses["/backend-api/wham/apps"] = await httpJson(`${baseUrl}/backend-api/wham/apps`, {
    method: "POST",
    timeout: 10000,
    headers: { ...trustedHeaders, "content-type": "application/json" },
    body: "{}",
  }); }
  catch (error) { errors["/backend-api/wham/apps"] = error.message; }
  responses["/backend-api/ps/plugins/installed"] ||= { plugins: [] };
  responses["/backend-api/aip/connectors"] ||= { connectors: [] };
  responses["/backend-api/plugins/list"] ||= { plugins: [] };
  responses["/backend-api/wham/apps"] ||= { tools: [] };
  return { ok: Boolean(responses["/health"]), baseUrl, responses, errors };
}

async function bootstrapManagerActionToken() {
  const bootstrap = await httpJson(`${baseUrl}/anticodex/manager/bootstrap`, {
    timeout: 10000,
    headers: {
      origin: baseUrl,
      referer: `${baseUrl}/anticodex/manager`,
    },
  });
  if (!bootstrap?.token) throw new Error("Anti-Codex manager bootstrap did not return an action token.");
  return bootstrap.token;
}

async function postManagerJsonWithToken(path, body, timeout) {
  const postOnce = (token) => httpJson(`${baseUrl}${path}`, {
    method: "POST",
    timeout,
    headers: {
      "content-type": "application/json",
      "x-anticodex-manager-token": token,
      origin: baseUrl,
      referer: `${baseUrl}/anticodex/manager`,
    },
    body,
  });
  try {
    return await postOnce(await bootstrapManagerActionToken());
  } catch (error) {
    if (error?.statusCode !== 403) throw error;
    return postOnce(await bootstrapManagerActionToken());
  }
}

async function runManagerRequest(pathValue, options = {}) {
  const path = String(pathValue || "");
  const method = String(options?.method || "GET").toUpperCase();
  if (!ALLOWED_MANAGER_BRIDGE_REQUESTS.get(path)?.has(method)) {
    throw new Error(`Manager bridge request is not allowed: ${method} ${path}`);
  }
  const timeout = Math.min(180000, Math.max(1000, Number(options?.timeoutMs) || 10000));
  if (method === "GET") {
    const effectiveMethod = path === "/backend-api/wham/apps" && method === "GET" ? "POST" : method;
    return httpJson(`${baseUrl}${path}`, {
      method: effectiveMethod,
      timeout,
      headers: {
        origin: baseUrl,
        referer: `${baseUrl}/anticodex/manager`,
        ...(effectiveMethod === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(effectiveMethod === "POST" ? { body: "{}" } : {}),
    });
  }
  const body = typeof options?.body === "string" ? options.body : JSON.stringify(options?.body ?? {});
  if (Buffer.byteLength(body) > MANAGER_BRIDGE_REQUEST_BODY_LIMIT) {
    throw new Error("Manager bridge request body is too large.");
  }
  return postManagerJsonWithToken(path, body, timeout);
}

async function runAction(action) {
  if (action === "refreshStatus") return { ok: true, action, result: { ok: true }, snapshot: await managerSnapshot() };
  return postManagerJsonWithToken(
    "/anticodex/manager/action",
    JSON.stringify({ action }),
    managerActionHttpTimeoutMs(action),
  );
}

function managerActionHttpTimeoutMs(action) {
  return action === "mcpSkills" ? MCP_SKILLS_MANAGER_HTTP_TIMEOUT_MS : MANAGER_ACTION_HTTP_TIMEOUT_MS;
}

function reportSummaryLines(result) {
  const r = result || {};
  const report = r.report || {};
  return [
    r.reportName ? `\u8bc1\u636e\uff1a${r.reportName}` : "",
    report.latest ? `\u6700\u65b0\u62a5\u544a\uff1a${report.latest}` : "",
    report.history ? `\u5386\u53f2\u62a5\u544a\uff1a${report.history}` : "",
  ].filter(Boolean);
}

function failureSummaryLine(result) {
  const failures = Array.isArray(result?.failures) ? result.failures.filter(Boolean) : [];
  if (!failures.length) return "";
  return `\u5931\u8d25\u9879\uff1a${failures.length}\n${failures.slice(0, 3).join("\n")}`;
}

function localGatewayGuidanceLine(result) {
  const failures = Array.isArray(result?.failures) ? result.failures.filter(Boolean) : [];
  const text = failures.join("\n").toLowerCase();
  if (!text.includes("/health") && !text.includes("endpoint failed") && !text.includes("gateway offline") && !text.includes("failed to fetch") && !text.includes("timeout") && !text.includes("connection refused") && !text.includes("econnrefused") && !text.includes("无法连接")) return "";
  return "guidance: local Anti-Codex gateway is offline; start or restore the local gateway, then rerun plugin/app capability check.";
}

function sourceSnapshotLine(result) {
  const evidence = result?.sourceSnapshot && typeof result.sourceSnapshot === "object" ? result.sourceSnapshot : null;
  if (!evidence) return "";
  const fileCount = evidence.fileCount ?? "\u672a\u77e5";
  const fingerprint = evidence.fingerprint ? String(evidence.fingerprint).slice(0, 12) : "\u7f3a\u5931";
  const cache = evidence.cacheHitCount != null || evidence.cacheMissCount != null ? ` / cache=${evidence.cacheHitCount ?? "\u672a\u77e5"}/${evidence.cacheMissCount ?? "\u672a\u77e5"}` : "";
  const reused = evidence.reusedFromPreviousReport === true ? " / reused=true" : "";
  const skipped = evidence.refreshSkippedReason ? ` / reason=${evidence.refreshSkippedReason}` : "";
  return `sourceSnapshot: files=${fileCount} / fingerprint=${fingerprint}${cache}${reused}${skipped}`;
}

function formatReportAge(ageMs) {
  const numericAge = Number(ageMs);
  if (!Number.isFinite(numericAge)) return "";
  const seconds = Math.max(0, Math.round(numericAge / 1000));
  if (seconds < 60) return `${seconds} \u79d2\u524d`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} \u5206\u949f\u524d`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} \u5c0f\u65f6\u524d`;
  return `${Math.round(hours / 24)} \u5929\u524d`;
}

function latestReportsSummary(result) {
  const reports = Array.isArray(result?.reports) ? result.reports : [];
  if (!reports.length) return "\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u62a5\u544a\u3002";

  const lines = [
    `\u62a5\u544a\u76ee\u5f55\uff1a${result.reportRoot || "\u672a\u77e5"}`,
    `\u5df2\u627e\u5230\uff1a${result.existingCount ?? reports.filter((item) => item.exists).length} \u4efd / \u7f3a\u5931\uff1a${result.missingCount ?? reports.filter((item) => !item.exists && item.deferred !== true).length} \u4efd / \u635f\u574f\uff1a${result.invalidCount ?? 0} \u4efd`,
  ];

  for (const item of reports) {
    const passed = item.effectiveOk ?? item.ok;
    const status = !item.exists
      ? (item.deferred ? "\u53ef\u9009\u672a\u8fd0\u884c" : "\u672a\u751f\u6210")
      : (item.invalid
        ? "\u62a5\u544a\u635f\u574f"
        : (item.stale && !item.deferred
          ? "\u9700\u91cd\u8dd1"
          : (passed ? "\u901a\u8fc7" : (item.deferred ? "\u53ef\u9009\u672a\u901a\u8fc7" : "\u9700\u5904\u7406"))));
    const age = formatReportAge(item.ageMs);
    lines.push("");
    lines.push(`${item.label || item.fileName || "\u672a\u547d\u540d"}\uff1a${status}${age ? ` / ${age}` : ""}`);

    if (item.fileName === "latest-release-gates.json" && item.exists && !item.invalid) {
      lines.push(`  \u8fdb\u5ea6\uff1a\u58f3 ${item.shellProgress ?? "?"}% / CodexPlusPlus ${item.codexPlusPlusProgress ?? "?"}% / Antigravity \u8584\u9002\u914d ${item.antigravityAdapterProgress ?? "?"}% / \u6574\u4f53 ${item.overallProgress ?? "?"}%`);
      lines.push(`  \u95e8\u7981\uff1a\u5df2\u5b8c\u6210 ${Array.isArray(item.completedGates) && item.completedGates.length ? item.completedGates.join(", ") : "\u65e0"} / \u5f53\u524d ${item.currentGate || "\u672a\u77e5"}`);
      if (Array.isArray(item.missingRequired) && item.missingRequired.length) {
        lines.push(`  \u5f85\u5b8c\u6210\uff1a${item.missingRequired.join(", ")}`);
      }
    }

    if (item.fileName === "latest-source-preflight.json" && typeof item.publicDocumentationOk === "boolean") {
      lines.push(`  \u516c\u5f00\u6587\u6863\uff1a${item.publicDocumentationOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
    }
    if (item.firstFailure) lines.push(`  \u9996\u4e2a\u95ee\u9898\uff1a${item.firstFailure}`);
    else if (item.reason) lines.push(`  \u8bf4\u660e\uff1a${item.reason}`);
    if (item.exists && item.latestPath) lines.push(`  \u6587\u4ef6\uff1a${item.latestPath}`);
  }
  return lines.join("\n");
}


function managerSummary(action, payload) {
  const result = payload?.result || payload || {};
  const unwrappedResult = result?.result && typeof result.result === "object" ? result.result : result;
  if (action === "refreshStatus") return `\u72b6\u6001\u5237\u65b0\uff1a${result.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`;
  if (action === "refreshModels") return `\u6a21\u578b\u5237\u65b0\uff1a${result.ok ? "\u5b8c\u6210" : "\u5931\u8d25"}\n\u6a21\u578b\u6570\uff1a${result.modelCount ?? result.models?.length ?? "\u672a\u77e5"}`;
  if (action === "accountSwitch") return [
    "\u5df2\u6253\u5f00 Antigravity \u684c\u9762\u7aef\u3002",
    "\u8bf7\u5728 Antigravity \u4e2d\u5207\u6362\u8d26\u53f7\uff0c\u5b8c\u6210\u540e\u56de\u5230 Anti-Codex \u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002",
    result.nextAction === "refreshModels" ? "\u4e0b\u4e00\u6b65\uff1a\u5237\u65b0\u6a21\u578b" : "",
  ].filter(Boolean).join("\n");
  if (action === "updateCheck") {
    const remoteState = unwrappedResult.components?.remoteState || "not_checked";
    const remoteTag = unwrappedResult.components?.remoteTag || "\u672a\u77e5";
    const remoteLine = remoteState === "current"
      ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u9879\u76ee\u5df2\u8ddf\u8fdb\uff09`
      : remoteState === "newer_available"
        ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u5f85\u9002\u914d\u9a8c\u8bc1\uff09`
        : remoteState === "project_ahead"
          ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u9879\u76ee\u7248\u672c\u9886\u5148\uff09`
          : remoteState === "failed" ? "\u8fdc\u7aef\u4e0a\u6e38\uff1a\u68c0\u67e5\u5931\u8d25" : "\u8fdc\u7aef\u4e0a\u6e38\uff1a\u672a\u68c0\u67e5";
    return [
      `\u66f4\u65b0\u68c0\u67e5\uff1a${unwrappedResult.ok !== true ? "\u68c0\u67e5\u4e0d\u53ef\u7528" : (unwrappedResult.updateNeeded ? "\u9700\u8981\u540c\u6b65" : "\u65e0\u9700\u540c\u6b65")}`,
      `Codex\uff1a\u672c\u673a\u5b98\u65b9 ${unwrappedResult.source?.packageVersion || "\u672a\u68c0\u67e5"} / Anti-Codex ${unwrappedResult.active?.packageVersion || "\u672a\u5b89\u88c5"}`,
      `CodexPlusPlus\uff1a\u9879\u76ee\u56fa\u5b9a ${unwrappedResult.components?.sourceVersion || "\u672a\u68c0\u67e5"} / \u5df2\u5b89\u88c5 ${unwrappedResult.components?.activeVersion || "\u672a\u5b89\u88c5"}`,
      remoteLine,
    ].join("\n");
  }
  if (action === "syncReadiness") return [
    `\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "repairShortcuts") return [
    `\u5feb\u6377\u65b9\u5f0f\u4fee\u590d\uff1a${result.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`,
    `\u5df2\u4fee\u590d\uff1a${result.repairedCount ?? result.shortcuts?.length ?? "\u672a\u77e5"}`,
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "mcpSkills") return [
    `MCP/Skill \u6e05\u5355\u53ef\u89c1\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    `MCP ${result.mcp?.count ?? "\u672a\u77e5"} / Skill ${result.skills?.count ?? "\u672a\u77e5"}`,
    `\u771f\u5b9e\u5de5\u5177\u8c03\u7528\uff1anode_repl ${result.mcp?.smoke?.realCall?.passed ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}\uff0cworker list ${Array.isArray(result.mcp?.smoke?.realList) ? result.mcp.smoke.realList.filter((entry) => entry && entry.passed === true).length : "\u672a\u77e5"}/${Array.isArray(result.mcp?.smoke?.realList) ? result.mcp.smoke.realList.length : "\u672a\u77e5"}\uff0cSkill \u6587\u4ef6 ${result.skills?.smoke?.readable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
  ].join("\n");
  if (action === "pluginCapabilities") {
    const capabilities = result.capabilities || {};
    const appTools = capabilities.appToolCount ?? 0;
    const accessibleConnectors = capabilities.accessibleConnectorCount ?? 0;
    const callableState = capabilities.smoke?.callableState || capabilities.callableState || "";
    const smokeChecked = capabilities.smoke?.checked === true;
    const capabilityState = capabilities.capabilityState || "";
    const callableSummary = appTools > 0
      ? `\u5e94\u7528\u5de5\u5177 ${appTools} / callable=${smokeChecked && callableState ? callableState : "unknown"}`
      : accessibleConnectors > 0
        ? `\u5df2\u6388\u6743\u8fde\u63a5\u5668 ${accessibleConnectors} \u4f46\u672a\u53d1\u73b0\u53ef\u8c03\u7528\u5e94\u7528\u5de5\u5177 / callable=${callableState || "unknown"}`
        : `\u65e0\u6388\u6743\u8fde\u63a5\u5668\uff0cmetadata-only \u4e0d\u4f2a\u88c5\u53ef\u8c03\u7528 / state=${capabilityState || "unknown"} / callable=${callableState || "unknown"}`;
    return [
      `\u63d2\u4ef6/\u5e94\u7528\u6e05\u5355\u53ef\u89c1\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      `\u5df2\u5b89\u88c5\u63d2\u4ef6 ${capabilities.installedPluginCount ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668 ${capabilities.connectorCount ?? "\u672a\u77e5"}`,
      `\u77ed\u9884\u7b97\uff1a${result.shortBudgetMode ? "\u662f" : "\u5426"} / state=${capabilityState || "unknown"}`,
      sourceSnapshotLine(result),
      `\u6295\u5f71 smoke\uff1a${capabilities.smoke?.endpointProjectionReadable ? "\u7aef\u70b9\u53ef\u8bfb" : "\u7aef\u70b9\u672a\u8bfb\u5230"}\uff0c\u7f13\u5b58 ${capabilities.smoke?.connectorCache?.sampleReadable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
      `\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a${callableSummary}`,
      capabilities.appToolsNote ? `\u8bf4\u660e\uff1a${capabilities.appToolsNote}` : "",
      localGatewayGuidanceLine(result),
      failureSummaryLine(result),
    ].filter(Boolean).join("\n");
  }
  if (action === "refreshFeatures" && payload?.background) return payload?.alreadyRunning ? "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u8bf7\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u6216 MCP/Skill\u3001\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002" : "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5f00\u59cb\u540e\u53f0\u6267\u884c\u3002\n\u754c\u9762\u4e0d\u4f1a\u7b49\u5f85\u957f\u65f6\u590d\u5236\uff1b\u5b8c\u6210\u540e\u7528 MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002";
  const recoveryActionIds = Array.isArray(result.recoveryActions) ? result.recoveryActions.map((action) => action?.id).filter(Boolean).slice(0, 3) : [];
  if (action === "refreshFeatures") return [
    `\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a${result.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`,
    `Skill ${result.skills?.count ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668\u7f13\u5b58 ${result.connectors?.count ?? "\u672a\u77e5"}`,
    sourceSnapshotLine(result),
    recoveryActionIds.length ? `recoveryActions: ${recoveryActionIds.join(", ")}` : "",
    "\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a\u5237\u65b0\u540e\u4ecd\u9700\u5355\u72ec smoke \u9a8c\u8bc1",
  ].filter(Boolean).join("\n");
  if (action === "stabilitySoak") {
    if (payload.alreadyRunning) return "\u7a33\u5b9a\u6027\u5de1\u68c0\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
    return `${payload.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u7a33\u5b9a\u6027\u5de1\u68c0\u3002" : "\u542f\u52a8\u7a33\u5b9a\u6027\u5de1\u68c0\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-stability-soak.json\u3002`;
  }
  if (action === "coldRelaunch") {
    if (payload.alreadyRunning) return "\u51b7\u542f\u52a8\u9a8c\u8bc1\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u91cd\u542f Anti-Codex\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
    return `${payload.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u51b7\u542f\u52a8\u9a8c\u8bc1\u3002" : "\u542f\u52a8\u51b7\u542f\u52a8\u9a8c\u8bc1\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u91cd\u542f Anti-Codex\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-cold-relaunch.json\u3002`;
  }
  if (action === "syncHost") return payload?.alreadyRunning ? "\u540c\u6b65\u5df2\u5728\u540e\u53f0\u8fd0\u884c" : "\u5df2\u5f00\u59cb\u540e\u53f0\u540c\u6b65 Codex \u66f4\u65b0";
  if (action === "diagnosticsBundle") {
    const longTasks = unwrappedResult.diagnosticsSummary?.longTasks;
    const otherRunningCount = longTasks?.otherRunningItems?.length;
    return [
      `\u8bca\u65ad\u5305\uff1a${unwrappedResult.ok ?? result.ok ? "\u5df2\u751f\u6210" : "\u5931\u8d25"}`,
      unwrappedResult.zipPath ? `ZIP\uff1a${unwrappedResult.zipPath}` : "",
      unwrappedResult.bundleRoot ? `\u76ee\u5f55\uff1a${unwrappedResult.bundleRoot}` : "",
      longTasks ? `\u957f\u4efb\u52a1\uff1a\u8fd0\u884c ${longTasks.runningCount ?? 0} / \u9700\u5904\u7406 ${longTasks.attentionCount ?? 0} / \u5176\u4ed6\u8fd0\u884c ${otherRunningCount ?? 0}` : "",
      failureSummaryLine(unwrappedResult),
      (!unwrappedResult.zipPath && !unwrappedResult.bundleRoot && !unwrappedResult.failures?.length) ? (payload?.message || result.message || "") : "",
    ].filter(Boolean).join("\n");
  }
  if (action === "viewLatestReports") return latestReportsSummary(result);
  if (action === "fastOverallNoTraffic") return [
    `\u5feb\u901f\u68c0\u67e5\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    `\u8017\u65f6\uff1a${result.elapsedMs ?? "\u672a\u77e5"} ms`,
    ...reportSummaryLines(result),
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "overallNoTraffic") return [
    `\u6574\u4f53\u68c0\u67e5\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    `\u8017\u65f6\uff1a${result.elapsedMs ?? "\u672a\u77e5"} ms`,
    ...reportSummaryLines(result),
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "postVerificationFull") return "\u5df2\u5f00\u59cb\u540e\u53f0\u5b8c\u6574\u9a8c\u8bc1";
  return JSON.stringify(result, null, 2);
}

if (args.has("--self-test")) {
  const selfSource = readFileSync(new URL(import.meta.url), "utf8");
  assert.match(selfSource, /error\.statusCode = response\.statusCode/);
  assert.match(selfSource, /async function postManagerJsonWithToken\(path, body, timeout\)[\s\S]*?return await postOnce\(await bootstrapManagerActionToken\(\)\);/);
  assert.match(selfSource, /error\?\.statusCode !== 403/);
  assert.match(selfSource, /return postOnce\(await bootstrapManagerActionToken\(\)\)/);
  assert.match(selfSource, /return postManagerJsonWithToken\([\s\S]*?"\/anticodex\/manager\/action"/);
  assert.ok(managerActionHttpTimeoutMs("overallNoTraffic") > 240000);
  assert.equal(managerActionHttpTimeoutMs("mcpSkills"), MCP_SKILLS_MANAGER_HTTP_TIMEOUT_MS);

  const summary = latestReportsSummary({
    reportRoot: "C:\\tmp\\anticodex\\reports",
    existingCount: 2,
    missingCount: 1,
    invalidCount: 0,
    reports: [{
      label: "\u53d1\u5e03\u95e8\u7981",
      fileName: "latest-release-gates.json",
      exists: true,
      parseable: true,
      ok: false,
      effectiveOk: false,
      shellProgress: 88,
      codexPlusPlusProgress: 94,
      antigravityAdapterProgress: 94,
      overallProgress: 90,
      completedGates: ["gate1", "gate2", "gate3", "gate4", "gate5", "gate6"],
      currentGate: "gate7",
      missingRequired: ["gate7", "gate8"],
      latestPath: "latest-release-gates.json",
    }, {
      label: "\u6e90\u7801\u9884\u68c0",
      fileName: "latest-source-preflight.json",
      exists: true,
      parseable: true,
      ok: true,
      effectiveOk: true,
      publicDocumentationOk: true,
      latestPath: "latest-source-preflight.json",
    }, {
      label: "\u7a33\u5b9a\u6027\u5de1\u68c0",
      fileName: "latest-stability-soak.json",
      exists: false,
      deferred: true,
      ok: false,
    }],
  });

  assert.match(summary, /\u8fdb\u5ea6\uff1a\u58f3 88% \/ CodexPlusPlus 94% \/ Antigravity \u8584\u9002\u914d 94% \/ \u6574\u4f53 90%/);
  assert.match(summary, /\u95e8\u7981\uff1a\u5df2\u5b8c\u6210 gate1, gate2, gate3, gate4, gate5, gate6 \/ \u5f53\u524d gate7/);
  assert.match(summary, /\u5f85\u5b8c\u6210\uff1agate7, gate8/);
  assert.match(summary, /\u516c\u5f00\u6587\u6863\uff1a\u901a\u8fc7/);
  assert.match(summary, /\u7a33\u5b9a\u6027\u5de1\u68c0\uff1a\u53ef\u9009\u672a\u8fd0\u884c/);
  assert.doesNotMatch(summary, /secondAccount|goalReadiness|antigravityCli/);
  console.log(JSON.stringify({ ok: true, selfTest: true }));
  process.exit(0);
}


async function main() {
  if (!ownerProcessIsAlive(supervisorPid)) return;

  const bridgeSource = createManagerBridgeSource();
  const managerQueuePollSource = createManagerQueuePollSource(bridgeSource);

  async function openBridgeSession() {
    const target = pickTarget(await cdpTargets());
    if (!target) throw new Error("No Anti-Codex page target found.");
    const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    let failureHandler = null;
    let id = 1;
    ws.onClose = (error) => failureHandler?.(error);
    ws.onEvent = (message) => {
      if (/targetCrashed|detachedFromTarget/i.test(String(message?.method || ""))) {
        failureHandler?.(new Error(message.method));
      }
    };
    try {
      await ws.open();
      await ws.call(id++, "Runtime.enable");
      await ws.call(id++, "Page.addScriptToEvaluateOnNewDocument", { source: bridgeSource });
      await ws.call(id++, "Runtime.evaluate", {
        expression: bridgeSource,
        awaitPromise: false,
        allowUnsafeEvalBlockedByCSP: true,
      });
      if (ws.failureNotified || ws.socket?.destroyed) throw new Error("WebSocket closed during Manager bridge injection.");
    } catch (error) {
      ws.close();
      throw error;
    }
    return {
      target,
      setFailureHandler(handler) {
        failureHandler = typeof handler === "function" ? handler : null;
        if (failureHandler && (ws.failureNotified || ws.socket?.destroyed)) {
          queueMicrotask(() => failureHandler?.(new Error("WebSocket closed.")));
        }
      },
      evaluate(expression, timeout = 30000) {
        return ws.call(id++, "Runtime.evaluate", {
          expression,
          awaitPromise: false,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true,
        }, timeout);
      },
      close() {
        failureHandler = null;
        ws.close();
      },
    };
  }

  let controller = null;
  const executionLedger = new ManagerActionExecutionLedger();

  async function deliver(request, session) {
    const requestId = String(request.id || "");
    const action = String(request.action || "");
    const isManagerRequest = request.kind === "manager-request";
    console.log(JSON.stringify({
      event: isManagerRequest ? "manager-request-received" : "manager-action-received",
      ...(isManagerRequest ? { path: String(request.path || "") } : { action }),
      requestId: requestId.slice(0, 32),
    }));
    const payload = await executionLedger.runOnce(requestId, async () => {
      let completedPayload;
      try {
        if (isManagerRequest) {
          completedPayload = {
            ok: true,
            kind: "manager-request",
            path: String(request.path || ""),
            value: await runManagerRequest(request.path, request.options),
          };
        } else {
          completedPayload = await runAction(action);
          completedPayload.action ||= action;
          completedPayload.snapshot = await managerSnapshot();
          completedPayload.managerSummary = managerSummary(action, completedPayload);
        }
      } catch (error) {
        completedPayload = isManagerRequest
          ? { ok: false, kind: "manager-request", path: String(request.path || ""), message: error.message }
          : { ok: false, action, message: error.message, managerSummary: `\u8fd0\u884c\u5931\u8d25\uff1a${error.message}`, snapshot: await managerSnapshot().catch(() => null) };
      }
      return completedPayload;
    });
    const deliveryExpression = `(() => {
      const payload = ${JSON.stringify(payload)};
      const action = ${JSON.stringify(action)};
      const isManagerRequest = payload.kind === "manager-request";
      const deliveredAction = payload.action || action;
      if (!isManagerRequest) payload.action = deliveredAction;
      if (payload.snapshot) globalThis.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
      const suppressRefreshStatusResult = deliveredAction === "refreshStatus" && globalThis.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ === true;
      if (!isManagerRequest && !suppressRefreshStatusResult) globalThis.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = payload;
      let result = document.querySelector('[data-anticodex-result="action"]');
      if (!isManagerRequest && !suppressRefreshStatusResult && !result && typeof globalThis.__ANTICODEX_OPEN_MANAGER__ === "function") {
        document.querySelector("#anticodex-manager-overlay")?.remove();
        globalThis.__ANTICODEX_OPEN_MANAGER__();
        result = document.querySelector('[data-anticodex-result="action"]');
      }
      const runningAction = result?.getAttribute('data-anticodex-running') || "";
      const isCurrentAction = !runningAction || runningAction === deliveredAction;
      if (!isManagerRequest && isCurrentAction && result && payload.managerSummary && !suppressRefreshStatusResult) result.textContent = payload.managerSummary;
      if (!isManagerRequest && isCurrentAction && !suppressRefreshStatusResult) globalThis.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
      if (!isManagerRequest && isCurrentAction && !suppressRefreshStatusResult) for (const button of document.querySelectorAll('button[data-action]')) button.disabled = false;
      globalThis.__ANTICODEX_ACK_MANAGER_ACTION__?.(${JSON.stringify(requestId)}, payload);
      })()`;
    await deliverManagerPayloadWithReconnect(controller, session, deliveryExpression);
    executionLedger.acknowledge(requestId);
    console.log(JSON.stringify({
      event: isManagerRequest ? "manager-request-resolved" : "manager-action-resolved",
      ...(isManagerRequest ? { path: String(request.path || "") } : { action }),
      ok: payload.ok !== false,
    }));
  }

  controller = new ManagerBridgeRecoveryController({
    openSession: openBridgeSession,
    pollSession: async (session) => {
      const message = await session.evaluate(managerQueuePollSource, 5000);
      const queued = message.result?.result?.value || [];
      if (Array.isArray(queued) && queued.length > 0) {
        console.log(JSON.stringify({ event: "manager-action-queue", count: queued.length }));
      }
      return Array.isArray(queued) ? queued : [];
    },
    deliverRequest: deliver,
    isOwnerAlive: () => ownerProcessIsAlive(supervisorPid),
  });
  const initialSession = await controller.start();
  if (!initialSession) return;
  console.log(JSON.stringify({
    ok: true,
    port,
    baseUrl,
    target: {
      id: initialSession.target?.id,
      title: initialSession.target?.title,
      url: initialSession.target?.url,
    },
  }));
  await controller.run({ intervalMs: 250 });
}

const invokedAsMain = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsMain) {
  main().catch((error) => {
    console.error(`[anticodex-manager-bridge] ${error.stack || error.message || error}`);
    process.exit(1);
  });
}
