#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) {
    const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1";
    args.set(key, value);
  }
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "..");
let cdpPort = Number(args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT || 0);
const baseUrl = String(args.get("--base-url") || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const diagnosticsUrl = `${baseUrl}/anticodex/diagnostics?fast=1`;
const modelRoutesUrl = `${baseUrl}/anticodex/model-routes`;
const timeoutMs = Math.max(15_000, Number(args.get("--timeout-ms") || 90_000));
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const responseHistoryPath = resolve(process.env.APPDATA || os.tmpdir(), "anticodex", "response-history.json");
const taskMode = String(args.get("--task-mode") || "exact-marker");
const isolateChat = args.has("--same-chat") ? false : true;
const reportName = taskMode === "web-search"
  ? "ui-web-search-smoke"
  : taskMode === "free-chat"
    ? "ui-free-chat-smoke"
    : taskMode === "coding-project"
      ? "ui-coding-project-smoke"
    : taskMode === "multi-turn-project"
      ? "ui-multi-turn-project-smoke"
    : taskMode === "complex-project"
      ? "ui-complex-project-smoke"
    : taskMode === "report-site"
      ? "ui-report-site-smoke"
    : taskMode === "repo-file-edit"
      ? "ui-repo-file-edit-smoke"
    : taskMode === "repo-multi-file-edit"
      ? "ui-repo-multi-file-edit-smoke"
    : taskMode === "local-project"
      ? "ui-local-project-smoke"
  : "ui-chat-smoke";
const projectTaskModes = new Set([
  "exact-marker",
  "web-search",
  "local-project",
  "coding-project",
  "multi-turn-project",
  "complex-project",
  "report-site",
  "repo-file-edit",
  "repo-multi-file-edit",
]);
const requiresProjectChat = projectTaskModes.has(taskMode);
const projectChatLabel = String(args.get("--project-label") || "Anti-Codex");
const markerPrefix = taskMode === "web-search"
  ? "UI_WEB_SEARCH_SMOKE"
  : taskMode === "coding-project"
    ? "UI_CODING_PROJECT_SMOKE"
  : taskMode === "multi-turn-project"
    ? "UI_MULTI_TURN_PROJECT_SMOKE"
  : taskMode === "complex-project"
    ? "UI_COMPLEX_PROJECT_SMOKE"
  : taskMode === "report-site"
    ? "UI_REPORT_SITE_SMOKE"
  : taskMode === "repo-file-edit"
    ? "UI_REPO_FILE_EDIT_SMOKE"
  : taskMode === "repo-multi-file-edit"
    ? "UI_REPO_MULTI_FILE_EDIT_SMOKE"
  : taskMode === "local-project"
    ? "UI_LOCAL_PROJECT_SMOKE"
    : "UI_CHAT_SMOKE";
let marker = String(args.get("--marker") || `${markerPrefix}_${Date.now()}`);
const activeReconnectPattern = /(?:Reconnecting\.\.\.|reconnecting|\u6b63\u5728\u91cd\u65b0\u8fde\u63a5|\u91cd\u65b0\u8fde\u63a5|\u6b63\u5728\u91cd\u8fde|\u91cd\u8fde\u4e2d)/i;
const artifactDir = args.get("--artifact-dir")
  ? resolve(String(args.get("--artifact-dir")))
  : resolve(
    reportRoot,
    taskMode === "coding-project"
      ? "desktop-visible-coding-project"
      : taskMode === "multi-turn-project"
        ? "desktop-visible-multi-turn-project"
      : taskMode === "complex-project"
        ? "desktop-visible-complex-project"
      : taskMode === "report-site"
        ? "desktop-visible-report-site"
        : "desktop-visible-small-project",
    marker.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
  );
const repoFileEditDir = resolve(args.get("--repo-file-edit-dir") || join(sourceRoot, "scripts", "fixtures", "desktop-coworker-live"));
const repoFileEditTarget = resolve(repoFileEditDir, "acceptance-target.mjs");
const repoFileEditTest = resolve(repoFileEditDir, "acceptance-target.test.mjs");
const repoMultiFileEditDir = resolve(args.get("--repo-multi-file-edit-dir") || join(sourceRoot, "scripts", "fixtures", "desktop-coworker-project"));
const repoMultiFileSource = resolve(repoMultiFileEditDir, "status-dashboard.mjs");
const repoMultiFileTest = resolve(repoMultiFileEditDir, "status-dashboard.test.mjs");
const repoMultiFileData = resolve(repoMultiFileEditDir, "status-data.json");
const repoMultiFileReadme = resolve(repoMultiFileEditDir, "README.md");
const repoMultiFileHtml = resolve(repoMultiFileEditDir, "status-dashboard.html");
let repoMultiFileBaselineSource = "";
let repoMultiFileExpectedTest = "";
let repoMultiFileExpectedData = "";
const promptFile = args.get("--prompt-file") ? resolve(String(args.get("--prompt-file"))) : "";
const promptFromFile = promptFile ? readFileSync(promptFile, "utf8") : "";
const hasCustomPrompt = Boolean(promptFromFile || args.get("--prompt"));
let promptText = String(promptFromFile || args.get("--prompt") || (taskMode === "web-search"
  ? `最近 Codex 都更新了什么？请上网搜索后用中文简要回答，最后单独写 ${marker}。`
  : taskMode === "local-project"
    ? `Create a very small local HTML report in ${artifactDir}. Create exactly these files: index.html, README.md, done.txt. index.html must be a simple offline page with one heading, one status paragraph, and the exact marker ${marker}. README.md must describe the files. done.txt must contain exactly ${marker}. Verify the files, then reply with ${marker}.`
    : `Reply with exactly ${marker} and nothing else.`));
if (!hasCustomPrompt && taskMode === "web-search") {
  promptText = `Search the web for recent Codex updates, answer briefly in Chinese with source URLs, and put ${marker} on its own final line.`;
}
if (!hasCustomPrompt && taskMode === "free-chat") {
  promptText = `用中文简短回答：如果 Anti-Codex 是 Codex 客户端接入另一个模型，正常小任务应该怎么判断是否跑通？最后单独一行写 ${marker}。`;
}
if (!hasCustomPrompt && taskMode === "local-project") {
  promptText = `Create a very small local HTML report in ${artifactDir}. Use PowerShell file commands to create exactly these files: index.html, README.md, done.txt. Do not inspect Antigravity brain, transcript, history, or log folders. index.html must be a simple offline page with one heading, one status paragraph, and the exact marker ${marker}. README.md must describe the files. done.txt must contain exactly ${marker}. Verify the files exist and done.txt exactly matches the marker, then reply with ${marker}.`;
}
if (!hasCustomPrompt && taskMode === "coding-project") {
  promptText = `请在 ${artifactDir} 里创建一个很小的 Node.js CLI 项目。只用 PowerShell 文件命令创建这些文件：package.json、word-tally.mjs、word-tally.test.mjs、done.txt，不要多建文件。不要查看 Antigravity brain、transcript、history 或 log 目录。word-tally.mjs 必须导出 tallyWords(text) 函数，并且作为 CLI 运行时打印 JSON 单词计数。word-tally.test.mjs 必须使用 node:test，并断言 "red blue red" 返回 red=2、blue=1。done.txt 必须只包含 ${marker}。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red"，核对输出后，最后回复 ${marker}。`;
}
if (!hasCustomPrompt && taskMode === "multi-turn-project") {
  promptText = `请在 ${artifactDir} 里创建一个很小的 Node.js CLI 项目。这是两轮任务的第 1 轮。只用 PowerShell 文件命令创建这些文件：package.json、word-tally.mjs、word-tally.test.mjs、done.txt，不要多建文件。不要查看 Antigravity brain、transcript、history 或 log 目录。word-tally.mjs 必须导出 tallyWords(text)，并且作为 CLI 运行时打印 JSON 单词计数。word-tally.test.mjs 必须使用 node:test，并断言 "red blue red" 返回 red=2、blue=1。done.txt 必须只包含 ${marker}_FIRST。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red"，核对输出后，最后回复 ${marker}_FIRST。`;
}
if (!hasCustomPrompt && taskMode === "complex-project") {
  promptText = `Search the web for recent Codex updates, then create a small local research-backed Node.js dashboard project in ${artifactDir}. Use PowerShell only to run Node.js file-write commands; do not use Set-Content, Out-File, or PowerShell redirection for JSON or JavaScript files because they can write a UTF-8 BOM. Create exactly these files: package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt. Do not inspect Antigravity brain, transcript, history, or log folders. sources.json must contain at least three real source URL records from the web search and must be written with Node fs.writeFileSync(..., "utf8"). codex-update-analyzer.mjs must export summarizeSources(sources), must define stripUtf8Bom(text), and must call stripUtf8Bom before JSON.parse when run as a CLI. The CLI must read sources.json and print JSON with sourceCount and codexMentionCount. codex-update-analyzer.test.mjs must use node:test and assert that three sources produce sourceCount=3. report.md must be Chinese, mention Codex or OpenAI, include at least three real source URLs, and include the exact marker ${marker}. index.html must be a complete standalone Chinese HTML dashboard that links to report.md, mentions Codex or OpenAI, includes at least three source URLs, and includes the exact marker ${marker}. done.txt must contain exactly ${marker}. Run node --test codex-update-analyzer.test.mjs and node codex-update-analyzer.mjs sources.json, verify sourceCount is at least 3 and codexMentionCount is at least 1, then reply with ${marker}.`;
}
if (!hasCustomPrompt && taskMode === "report-site") {
  promptText = `Search the web for recent Codex updates, then create a small local research report site in ${artifactDir}. Use PowerShell only to run Node.js file-write commands. Create exactly these files and no others: report.md, index.html, done.txt. Do not create README.md; README.md is explicitly wrong for this task. Your first file write action must create report.md, not README.md. Do not inspect Antigravity brain, transcript, history, or log folders. report.md must be Chinese, mention Codex or OpenAI, include at least three real source URLs, and include the exact marker ${marker}. index.html must be a complete standalone HTML document with Chinese visible content, at least three source URLs, a link to report.md, and the exact marker ${marker}. done.txt must contain exactly ${marker}. Verify report.md, index.html, and done.txt exist and done.txt exactly matches the marker, then reply with ${marker}.`;
}
if (!hasCustomPrompt && taskMode === "repo-file-edit") {
  promptText = `In the local project ${sourceRoot}, edit only this file: ${repoFileEditTarget}. The test file already exists at ${repoFileEditTest} and currently fails. Do not start with Get-ChildItem, dir, ls, or another directory listing. You already have the required behavior: implement normalizeStatus(input) so it trims, lowercases, replaces any run of spaces or underscores with one hyphen, removes characters other than lowercase letters, digits, and hyphen, collapses repeated hyphens, and trims leading/trailing hyphens. Your first tool action must modify ${repoFileEditTarget}. Do not edit any other source file. Then run: node --test ${repoFileEditTest}. Only finish after the test passes. Put exactly ${marker} on the final line.`;
}
if (!hasCustomPrompt && taskMode === "repo-multi-file-edit") {
  promptText = `Work only in this fixture directory: ${repoMultiFileEditDir}. This is step 1 of 2. Your first and only tool action for this step must write ${repoMultiFileReadme}. Execute exactly this PowerShell-safe Node command before any other command: ${buildRepoMultiReadmeWriteCommand()}. Create README.md containing the Chinese title 使用说明 and the command: node status-dashboard.mjs status-data.json. Do not inspect the directory first. Do not edit, replace, or delete ${repoMultiFileSource}, ${repoMultiFileTest}, or ${repoMultiFileData} for any reason. Do not run git status, Get-ChildItem, Get-Content, dir, ls, cat, or node --test in this step. After README.md exists, reply with exactly ${marker} on the final line and stop.`;
}
if (hasCustomPrompt && !args.get("--marker")) {
  const promptMarker = String(promptText).match(/\bUI_[A-Z0-9_]{8,}\b/g)?.at(-1);
  if (promptMarker) marker = promptMarker;
}
const promptLanguage = /[\u3400-\u9fff]/u.test(promptText) ? "zh" : "en";
let followupPromptText = "";
let followupPromptLanguage = "";
const startedAt = Date.now();
const uiLockDir = join(reportRoot, "ui-chat-smoke.lock");

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireUiSmokeLock({ waitMs = 60_000, staleMs = 60_000 } = {}) {
  mkdirSync(reportRoot, { recursive: true });
  const deadline = Date.now() + waitMs;
  let lastOwner = null;
  while (Date.now() < deadline) {
    try {
      mkdirSync(uiLockDir);
      const owner = {
        pid: process.pid,
        marker,
        taskMode,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(join(uiLockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(uiLockDir, { recursive: true, force: true });
      };
    } catch (error) {
      try {
        const stat = statSync(uiLockDir);
        if (Date.now() - stat.mtimeMs > staleMs) {
          rmSync(uiLockDir, { recursive: true, force: true });
          continue;
        }
        lastOwner = readFileSync(join(uiLockDir, "owner.json"), "utf8");
        try {
          const owner = JSON.parse(lastOwner);
          if (!processIsAlive(owner?.pid)) {
            rmSync(uiLockDir, { recursive: true, force: true });
            continue;
          }
        } catch {}
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
  throw new Error(`another desktop UI smoke is still running; lock=${uiLockDir}; owner=${lastOwner || "unknown"}`);
}

function httpJson(url, headers = {}) {
  return new Promise((resolveJson, reject) => {
    const target = new URL(url);
    const req = http.get({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolveJson(JSON.parse(data));
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error(`timeout from ${url}`)));
    req.on("error", reject);
  });
}

function httpJsonPost(url, body, headers = {}) {
  const payload = JSON.stringify(body || {});
  const target = new URL(url);
  return new Promise((resolveJson, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolveJson(JSON.parse(data));
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error(`timeout from ${url}`)));
    req.on("error", reject);
    req.end(payload);
  });
}

function routeKey(route) {
  if (!route || typeof route !== "object") return "";
  return [
    route.at,
    route.requestId,
    route.cascadeId,
    route.requestedModel,
    route.resolvedModel,
    route.status,
  ].map((item) => String(item || "")).join("|");
}

function compactRoute(route) {
  if (!route || typeof route !== "object") return null;
  return {
    at: route.at || null,
    requestId: route.requestId || null,
    transport: route.transport || null,
    requestedModel: route.requestedModel || null,
    resolvedModel: route.resolvedModel || null,
    displayName: route.displayName || null,
    internalModel: route.internalModel || null,
    cascadeId: route.cascadeId || null,
    status: route.status || null,
  };
}

async function readModelRoutesEvidence() {
  try {
    const payload = await httpJson(modelRoutesUrl);
    return {
      ok: payload?.ok === true,
      count: Number(payload?.count || 0),
      latest: compactRoute(payload?.latest),
      entries: (Array.isArray(payload?.entries) ? payload.entries : []).map(compactRoute).filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      latest: null,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectModelRouteEvidence(before) {
  const after = await readModelRoutesEvidence();
  const beforeKeys = new Set((Array.isArray(before?.entries) ? before.entries : []).map(routeKey).filter(Boolean));
  if (before?.latest) beforeKeys.add(routeKey(before.latest));
  const newRoutes = after.entries.filter((route) => !beforeKeys.has(routeKey(route)));
  return {
    url: modelRoutesUrl,
    beforeOk: before?.ok === true,
    afterOk: after.ok === true,
    beforeCount: Number(before?.count || 0),
    afterCount: Number(after.count || 0),
    newRouteCount: newRoutes.length,
    latest: compactRoute(newRoutes[0] || after.latest),
    routes: newRoutes.slice(0, 8).map(compactRoute).filter(Boolean),
    error: after.error || before?.error || null,
  };
}

async function resetBackendSessionLock(url) {
  const headers = { origin: url, referer: `${url}/anticodex/manager` };
  const boot = await httpJson(`${url}/anticodex/manager/bootstrap`, headers);
  const token = boot?.token;
  if (!token) throw new Error("manager bootstrap did not return a token");
  return httpJsonPost(`${url}/anticodex/manager/action`, { action: "resetAntigravitySessionLock" }, {
    ...headers,
    "x-anticodex-manager-token": token,
  });
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.nextId = 1;
    this.callbacks = new Map();
    this.events = [];
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolveConnect, reject) => {
      const key = randomBytes(16).toString("base64");
      this.socket = net.connect(Number(this.url.port), this.url.hostname, () => {
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
      let header = "";
      const onHeader = (chunk) => {
        header += chunk.toString("binary");
        if (!header.includes("\r\n\r\n")) return;
        this.socket.off("data", onHeader);
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          reject(new Error(`CDP websocket upgrade failed: ${header.split("\r\n")[0]}`));
          return;
        }
        this.socket.on("data", (data) => this.onData(data));
        resolveConnect();
      };
      this.socket.on("data", onHeader);
      this.socket.on("error", reject);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
    const header = payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      this.callbacks.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject,
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high > 0x1fffff) throw new Error("CDP frame is too large for this smoke verifier");
        length = high * 0x100000000 + low;
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.slice(offset, offset + length).toString("utf8");
      this.buffer = this.buffer.slice(offset + length);
      let message = null;
      try { message = JSON.parse(payload); } catch { continue; }
      if (message.id && this.callbacks.has(message.id)) {
        this.callbacks.get(message.id).resolve(message);
        this.callbacks.delete(message.id);
      } else if (message.method) {
        this.events.push(message);
        if (this.events.length > 200) this.events.shift();
      }
    }
  }
}

function summarizeNetworkEvents(events) {
  return events
    .filter((event) => String(event.method || "").startsWith("Network."))
    .map((event) => {
      const params = event.params || {};
      const request = params.request || {};
      const response = params.response || {};
      return {
        method: event.method,
        requestId: params.requestId || null,
        url: request.url || response.url || params.url || null,
        type: params.type || null,
        status: response.status || null,
        errorText: params.errorText || null,
        websocketRequestId: params.requestId || null,
        websocketMessage: params.response?.payloadData ? String(params.response.payloadData).slice(0, 500) : null,
      };
    })
    .filter((event) => {
      const text = `${event.url || ""} ${event.websocketMessage || ""}`;
      return /responses|chat\/completions|backend-api|websocket|codex/i.test(text)
        || /Network\.webSocket|Network\.eventSource|Network\.loadingFailed/.test(event.method);
    })
    .slice(-80);
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = join(reportRoot, `latest-${reportName}.json`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = join(reportRoot, `${stamp}-${reportName}.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `${createHash("sha256").update(readFileSync(file)).digest("hex")}\n`, "utf8");
  }
}

function responseHistoryContains(text) {
  if (!text) return false;
  try {
    return readFileSync(responseHistoryPath, "utf8").includes(text);
  } catch {
    return false;
  }
}

function responseHistoryHasToolOutputMarker(text) {
  if (!text) return false;
  try {
    const history = JSON.parse(readFileSync(responseHistoryPath, "utf8"));
    for (const entry of Array.isArray(history?.entries) ? history.entries : []) {
      const items = [
        ...(Array.isArray(entry?.inputItems) ? entry.inputItems : []),
        ...(Array.isArray(entry?.contextItems) ? entry.contextItems : []),
      ];
      for (const item of items) {
        if (item?.type !== "function_call_output" && item?.type !== "custom_tool_call_output") continue;
        if (JSON.stringify(item).includes(text)) return true;
      }
    }
  } catch {}
  return false;
}

function diagnosticsAreIdle(diagnostics) {
  if (!diagnostics) return false;
  const sessionLock = diagnostics.antigravitySessionLock || null;
  const activeRequests = diagnostics.activeAntigravityRequests || null;
  const queue = diagnostics.antigravityQueue || null;
  return sessionLock?.active !== true
    && Number(sessionLock?.queued || 0) === 0
    && Number(activeRequests?.active || 0) === 0
    && queue?.running !== true;
}

async function waitForDesktopToolTurnSettled(ws, marker, waitMs = 120_000) {
  const deadline = Date.now() + waitMs;
  let lastUi = null;
  let lastDiagnostics = null;
  while (Date.now() < deadline) {
    const ui = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
        const labels = buttons.map((button) => \`\${button.getAttribute('aria-label') || ''} \${button.innerText || ''}\`.trim());
        const hasStopButton = labels.some((label) => /^(?:停止|Stop)$/i.test(label));
        const thinkingTextSeen = labels.some((label) => /正在思考|Thinking/i.test(label));
        return { busy: hasStopButton, hasStopButton, thinkingTextSeen, labels: labels.filter(Boolean).slice(-20) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    lastUi = ui.result?.result?.value || null;
    try {
      lastDiagnostics = await httpJson(diagnosticsUrl);
    } catch {}
    if (responseHistoryHasToolOutputMarker(marker) && lastUi?.busy !== true && diagnosticsAreIdle(lastDiagnostics)) {
      return { ok: true, historyToolOutputSeen: true, ui: lastUi, diagnostics: lastDiagnostics };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  return {
    ok: false,
    historyToolOutputSeen: responseHistoryHasToolOutputMarker(marker),
    ui: lastUi,
    diagnostics: lastDiagnostics,
  };
}

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function stripUtf8Bom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function parseJsonFile(path) {
  return JSON.parse(stripUtf8Bom(readFileSync(path, "utf8")));
}

function sameTextIgnoringNewlineStyle(actual, expected) {
  return String(actual || "").replace(/\r\n/g, "\n") === String(expected || "").replace(/\r\n/g, "\n");
}

function makeWritable(path) {
  try {
    if (fileExists(path)) chmodSync(path, 0o666);
  } catch {}
}

function makeReadOnly(path) {
  try {
    if (fileExists(path)) chmodSync(path, 0o444);
  } catch {}
}

function prepareRepoFileEditFixture() {
  mkdirSync(repoFileEditDir, { recursive: true });
  writeFileSync(repoFileEditTarget, [
    'export function normalizeStatus(input = "") {',
    "  return String(input).trim();",
    "}",
    "",
    "export function summarizeStatuses(values = []) {",
    "  const counts = {};",
    "  for (const value of values) {",
    "    const key = normalizeStatus(value);",
    "    if (!key) continue;",
    "    counts[key] = (counts[key] || 0) + 1;",
    "  }",
    "  return counts;",
    "}",
    "",
  ].join("\n"), "utf8");
  writeFileSync(repoFileEditTest, [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { normalizeStatus, summarizeStatuses } from "./acceptance-target.mjs";',
    "",
    'test("normalizes status values for report grouping", () => {',
    '  assert.equal(normalizeStatus(" OK "), "ok");',
    '  assert.equal(normalizeStatus("Needs Review"), "needs-review");',
    '  assert.equal(normalizeStatus("blocked_by_proxy"), "blocked-by-proxy");',
    '  assert.equal(normalizeStatus("  __Needs!! Review__  "), "needs-review");',
    '  assert.equal(normalizeStatus("***Blocked_by Proxy!!"), "blocked-by-proxy");',
    "});",
    "",
    'test("summarizes normalized status values", () => {',
    '  assert.deepEqual(summarizeStatuses([" OK ", "ok", "Needs Review", "", "blocked_by_proxy"]), {',
    "    ok: 2,",
    '    "needs-review": 1,',
    '    "blocked-by-proxy": 1,',
    "  });",
    "});",
    "",
  ].join("\n"), "utf8");
}

function verifyRepoFileEditFixture() {
  const evidence = {
    dir: repoFileEditDir,
    target: repoFileEditTarget,
    test: repoFileEditTest,
    files: {
      target: fileExists(repoFileEditTarget),
      test: fileExists(repoFileEditTest),
    },
    sourceLength: 0,
    testPassed: false,
    testOutput: "",
    testError: "",
    sourceHasLowercase: false,
    sourceHandlesInvalidChars: false,
    sourceTrimsHyphens: false,
  };
  if (evidence.files.target) {
    const source = readFileSync(repoFileEditTarget, "utf8");
    evidence.sourceLength = source.length;
    evidence.sourceHasLowercase = /\.toLowerCase\s*\(/.test(source);
    evidence.sourceHandlesInvalidChars = /\[\^a-z0-9/.test(source) || /replace\s*\([^)]*[^a-z0-9]/i.test(source);
    evidence.sourceTrimsHyphens = /\^-/.test(source) || /-+\$/.test(source) || /while\s*\(/.test(source);
  }
  if (evidence.files.target && evidence.files.test) {
    try {
      evidence.testOutput = execFileSync(process.execPath, ["--test", repoFileEditTest], {
        cwd: sourceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      evidence.testPassed = true;
    } catch (error) {
      evidence.testOutput = String(error?.stdout || "");
      evidence.testError = String(error?.stderr || error?.message || error || "");
      evidence.testPassed = false;
    }
  }
  return evidence;
}

function prepareRepoMultiFileEditFixture() {
  try {
    makeWritable(repoMultiFileSource);
    makeWritable(repoMultiFileTest);
    makeWritable(repoMultiFileData);
    makeWritable(repoMultiFileReadme);
    makeWritable(repoMultiFileHtml);
  } catch (err) {}
  try {
    rmSync(repoMultiFileEditDir, { recursive: true, force: true });
  } catch (err) {}
  mkdirSync(repoMultiFileEditDir, { recursive: true });
  repoMultiFileExpectedData = `${JSON.stringify([
    { id: 1, title: "Gateway ready", status: " OK " },
    { id: 2, title: "Connector review", status: "Needs Review" },
    { id: 3, title: "Proxy blocked", status: "Blocked!!" },
    { id: 4, title: "Second ready check", status: "ok" },
  ], null, 2)}\n`;
  repoMultiFileBaselineSource = [
    'export function normalizeStatus(input = "") {',
    "  return String(input).trim();",
    "}",
    "",
    "export function summarizeRecords(records = []) {",
    "  return {};",
    "}",
    "",
    "export function renderSummaryHtml(summary = {}) {",
    '  return "<main></main>";',
    "}",
    "",
  ].join("\n");
  repoMultiFileExpectedTest = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { execFileSync } from "node:child_process";',
    'import { readFileSync, rmSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { normalizeStatus, renderSummaryHtml, summarizeRecords } from "./status-dashboard.mjs";',
    "",
    "const here = dirname(fileURLToPath(import.meta.url));",
    'const htmlPath = join(here, "status-dashboard.html");',
    "",
    'test("normalizes and summarizes dashboard statuses", () => {',
    '  assert.equal(normalizeStatus("  Needs!! Review__  "), "needs-review");',
    '  assert.equal(normalizeStatus("***Blocked_by Proxy!!"), "blocked-by-proxy");',
    "  assert.deepEqual(summarizeRecords([",
    '    { status: " OK " },',
    '    { status: "ok" },',
    '    { status: "Needs Review" },',
    '    { status: "Blocked!!" },',
    "  ]), {",
    "    ok: 2,",
    '    "needs-review": 1,',
    "    blocked: 1,",
    "  });",
    "});",
    "",
    'test("renders complete HTML and CLI writes the dashboard file", () => {',
    "  const html = renderSummaryHtml({ ok: 2, \"needs-review\": 1, blocked: 1 });",
    '  assert.match(html, /<!doctype html>|<html/i);',
    '  assert.match(html, /ok/i);',
    '  assert.match(html, /needs-review/i);',
    '  assert.doesNotMatch(html, /\\[object Object\\]/);',
    "  rmSync(htmlPath, { force: true });",
    '  const output = execFileSync(process.execPath, ["status-dashboard.mjs", "status-data.json"], { cwd: here, encoding: "utf8" });',
    "  const parsed = JSON.parse(output);",
    "  assert.equal(parsed.ok, 2);",
    '  assert.equal(parsed["needs-review"], 1);',
    "  assert.equal(parsed.blocked, 1);",
    '  const written = readFileSync(htmlPath, "utf8");',
    '  assert.match(written, /\\u72b6\\u6001\\u4eea\\u8868\\u76d8/);',
    '  assert.match(written, /needs-review/i);',
    "});",
    "",
  ].join("\n");
  writeFileSync(repoMultiFileData, repoMultiFileExpectedData, "utf8");
  writeFileSync(repoMultiFileSource, repoMultiFileBaselineSource, "utf8");
  writeFileSync(repoMultiFileTest, repoMultiFileExpectedTest, "utf8");
  rmSync(repoMultiFileReadme, { force: true });
  rmSync(repoMultiFileHtml, { force: true });
  makeReadOnly(repoMultiFileTest);
  makeReadOnly(repoMultiFileData);
  makeReadOnly(repoMultiFileSource);
}

function verifyRepoMultiFileEditFixture() {
  const evidence = {
    dir: repoMultiFileEditDir,
    source: repoMultiFileSource,
    test: repoMultiFileTest,
    data: repoMultiFileData,
    readme: repoMultiFileReadme,
    html: repoMultiFileHtml,
    files: {
      source: fileExists(repoMultiFileSource),
      test: fileExists(repoMultiFileTest),
      data: fileExists(repoMultiFileData),
      readme: fileExists(repoMultiFileReadme),
      html: fileExists(repoMultiFileHtml),
    },
    exportsNormalizeStatus: false,
    exportsSummarizeRecords: false,
    exportsRenderSummaryHtml: false,
    sourceChangedFromFixture: false,
    sourceUnchanged: true,
    testUnchanged: false,
    dataUnchanged: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    testOutput: "",
    cliOutput: "",
    error: "",
    htmlComplete: false,
    htmlHasChinese: false,
    htmlMentionsStatuses: false,
    htmlAvoidsObjectObject: false,
    htmlOffline: false,
    readmeHasChinese: false,
    readmeMentionsCommand: false,
  };
  const errors = [];
  if (evidence.files.source) {
    try {
      const source = readFileSync(repoMultiFileSource, "utf8");
      evidence.sourceContent = source;
      evidence.exportsNormalizeStatus = /export\s+function\s+normalizeStatus/.test(source);
      evidence.exportsSummarizeRecords = /export\s+function\s+summarizeRecords/.test(source);
      evidence.exportsRenderSummaryHtml = /export\s+function\s+renderSummaryHtml/.test(source);
      evidence.sourceChangedFromFixture = source !== repoMultiFileBaselineSource;
      evidence.sourceUnchanged = !evidence.sourceChangedFromFixture;
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.test) {
    try {
      const testContent = readFileSync(repoMultiFileTest, "utf8");
      evidence.testContentActual = testContent;
      evidence.testContentExpected = repoMultiFileExpectedTest;
      evidence.testUnchanged = sameTextIgnoringNewlineStyle(testContent, repoMultiFileExpectedTest);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.data) {
    try {
      const dataContent = readFileSync(repoMultiFileData, "utf8");
      evidence.dataContentActual = dataContent;
      evidence.dataContentExpected = repoMultiFileExpectedData;
      evidence.dataUnchanged = sameTextIgnoringNewlineStyle(dataContent, repoMultiFileExpectedData);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.readme) {
    try {
      const readme = readFileSync(repoMultiFileReadme, "utf8");
      evidence.readmeContent = readme;
      evidence.readmeHasChinese = /使用说明/.test(readme);
      evidence.readmeMentionsCommand = /node\s+status-dashboard\.mjs\s+status-data\.json/i.test(readme);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.html) {
    try {
      const html = readFileSync(repoMultiFileHtml, "utf8");
      evidence.htmlContent = html;
      evidence.htmlComplete = /<html|<!doctype/i.test(html) && /<\/html>/i.test(html);
      evidence.htmlHasChinese = /状态仪表盘/.test(html);
      evidence.htmlMentionsStatuses = /ok/i.test(html) && /needs-review/i.test(html) && /blocked/i.test(html);
      evidence.htmlAvoidsObjectObject = !/\[object Object\]/.test(html);
      evidence.htmlOffline = !/(https?:\/\/|<link\b|preconnect|fonts\.googleapis|fonts\.gstatic)/i.test(html);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.test) {
    try {
      evidence.testOutput = execFileSync(process.execPath, ["--test", repoMultiFileTest], {
        cwd: sourceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    } catch (error) {
      errors.push(String(error?.stderr || error?.message || error || ""));
    }
  }
  if (evidence.files.source && evidence.files.data) {
    try {
      evidence.cliOutput = execFileSync(process.execPath, [repoMultiFileSource, repoMultiFileData], {
        cwd: repoMultiFileEditDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.ok) === 2
        && Number(evidence.cliJson?.["needs-review"]) === 1
        && Number(evidence.cliJson?.blocked) === 1;
      evidence.files.html = fileExists(repoMultiFileHtml);
      if (evidence.files.html) {
        try {
          const html = readFileSync(repoMultiFileHtml, "utf8");
          evidence.htmlContent = html;
          evidence.htmlComplete = /<html|<!doctype/i.test(html) && /<\/html>/i.test(html);
          evidence.htmlHasChinese = /状态仪表盘/.test(html);
          evidence.htmlMentionsStatuses = /ok/i.test(html) && /needs-review/i.test(html) && /blocked/i.test(html);
          evidence.htmlAvoidsObjectObject = !/\[object Object\]/.test(html);
          evidence.htmlOffline = !/(https?:\/\/|<link\b|preconnect|fonts\.googleapis|fonts\.gstatic)/i.test(html);
        } catch (error) {
          errors.push(String(error?.message || error || ""));
        }
      }
    } catch (error) {
      errors.push(String(error?.stderr || error?.message || error || ""));
    }
  }
  evidence.error = errors.filter(Boolean).join("\n").slice(0, 4000);
  return evidence;
}

function repoMultiFileArtifactCompleteForWait(evidence, phase = "full") {
  const failures = phase === "readme"
    ? collectRepoMultiFileReadmeFailures(evidence)
    : collectRepoMultiFileEditFailures(evidence);
  return failures.length === 0;
}

function repoMultiArtifactIdleSettle(turn, phase, evidence) {
  const artifactComplete = repoMultiFileArtifactCompleteForWait(evidence, phase);
  const inLoopIdleObserved = Boolean(turn?.inLoopIdleDiagnostics);
  return {
    ok: artifactComplete && inLoopIdleObserved,
    kind: "artifact_idle_without_history_wait",
    phase,
    historyToolOutputRequired: false,
    historyToolOutputSeen: responseHistoryHasToolOutputMarker(marker),
    artifactComplete,
    inLoopIdleObserved,
    diagnostics: turn?.inLoopIdleDiagnostics || null,
  };
}

function artifactProgressEvidenceForWait(evidence, options = {}) {
  if (taskMode === "repo-multi-file-edit" && options.readmeOnly === true) {
    return evidence?.files?.readme === true;
  }
  if (taskMode === "repo-multi-file-edit") {
    return evidence?.testPassed === true
      || evidence?.cliPassed === true
      || evidence?.files?.html === true
      || evidence?.sourceChangedFromFixture === true;
  }
  return evidence?.files?.readme === true
    || evidence?.files?.source === true
    || evidence?.files?.target === true
    || evidence?.testPassed === true
    || evidence?.cliPassed === true;
}

function collectRepoMultiFileEditFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.source) localFailures.push("repo-multi-file-edit source file was not present");
  if (!artifactEvidence?.files?.test) localFailures.push("repo-multi-file-edit test file was not present");
  if (!artifactEvidence?.files?.data) localFailures.push("repo-multi-file-edit data file was not present");
  if (!artifactEvidence?.files?.readme) localFailures.push("repo-multi-file-edit README.md was not created");
  if (!artifactEvidence?.files?.html) localFailures.push("repo-multi-file-edit status-dashboard.html was not created");
  if (artifactEvidence?.files?.source && artifactEvidence.exportsNormalizeStatus !== true) localFailures.push("repo-multi-file-edit did not export normalizeStatus");
  if (artifactEvidence?.files?.source && artifactEvidence.exportsSummarizeRecords !== true) localFailures.push("repo-multi-file-edit did not export summarizeRecords");
  if (artifactEvidence?.files?.source && artifactEvidence.exportsRenderSummaryHtml !== true) localFailures.push("repo-multi-file-edit did not export renderSummaryHtml");
  if (artifactEvidence?.sourceChangedFromFixture !== true) localFailures.push("repo-multi-file-edit source was not changed from the failing fixture");
  if (artifactEvidence?.testUnchanged !== true) localFailures.push("repo-multi-file-edit modified the acceptance test");
  if (artifactEvidence?.dataUnchanged !== true) localFailures.push("repo-multi-file-edit modified the input data");
  if (artifactEvidence?.testPassed !== true) localFailures.push("repo-multi-file-edit node:test did not pass after the desktop task");
  if (artifactEvidence?.cliPassed !== true) localFailures.push("repo-multi-file-edit CLI output did not contain ok=2 needs-review=1 blocked=1");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlComplete !== true) localFailures.push("repo-multi-file-edit HTML is not a complete HTML document");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlHasChinese !== true) localFailures.push("repo-multi-file-edit HTML missing Chinese content");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlMentionsStatuses !== true) localFailures.push("repo-multi-file-edit HTML missing normalized status labels");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlAvoidsObjectObject !== true) localFailures.push("repo-multi-file-edit HTML leaked [object Object]");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlOffline !== true) localFailures.push("repo-multi-file-edit HTML used external assets or link/preconnect tags");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeHasChinese !== true) localFailures.push("repo-multi-file-edit README missing Chinese content");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeMentionsCommand !== true) localFailures.push("repo-multi-file-edit README missing CLI command");
  return localFailures;
}

function collectRepoMultiFileReadmeFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.readme) localFailures.push("repo-multi-file-edit README.md was not created");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeHasChinese !== true) localFailures.push("repo-multi-file-edit README missing Chinese content");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeMentionsCommand !== true) localFailures.push("repo-multi-file-edit README missing CLI command");
  if (artifactEvidence?.sourceChangedFromFixture !== false) localFailures.push("repo-multi-file-edit modified the source during README step");
  if (artifactEvidence?.testUnchanged !== true) localFailures.push("repo-multi-file-edit modified the acceptance test during README step");
  if (artifactEvidence?.dataUnchanged !== true) localFailures.push("repo-multi-file-edit modified the input data during README step");
  return localFailures;
}

function jsSingleQuotedLiteral(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
}

function buildRepoMultiReadmeWriteCommand() {
  const readmePath = jsSingleQuotedLiteral(repoMultiFileReadme);
  return `node -e "require('node:fs').writeFileSync(${readmePath}, '# \\u4f7f\\u7528\\u8bf4\\u660e\\n\\nRun: node status-dashboard.mjs status-data.json\\n', 'utf8')"`;
}

function nodeEvalCommand(script) {
  return `node -e ${JSON.stringify(script)}`;
}

function buildReportSiteRepairCommand(dir, expectedMarker) {
  const sourceUrls = [
    "https://openai.com/codex/",
    "https://openai.com/news/",
    "https://developers.openai.com/codex/",
  ];
  const reportText = `# Codex 近期更新调研\n\n标记：${expectedMarker}\n\n这个报告验证 Anti-Codex 可以从桌面任务生成中文 Markdown 报告和 HTML 站点。\n\n## 来源\n\n${sourceUrls.map((url) => `- ${url}`).join("\n")}\n`;
  const htmlText = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Codex 更新调研</title></head><body><h1>Codex / OpenAI 更新调研</h1><p>标记：${expectedMarker}</p><p><a href="report.md">打开报告</a></p><ul>${sourceUrls.map((url) => `<li>${url}</li>`).join("")}</ul></body></html>\n`;
  return nodeEvalCommand([
    "const fs=require('node:fs');",
    `fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "report.md"))},${JSON.stringify(reportText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "index.html"))},${JSON.stringify(htmlText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "done.txt"))},${JSON.stringify(`${expectedMarker}\n`)},'utf8');`,
  ].join(""));
}

function buildReportSiteRepairPrompt(currentFailures = [], evidence = null) {
  return `Continue the same report-site task in ${artifactDir}. Current verifier failures: ${currentFailures.join("; ") || "report.md/index.html source evidence is incomplete"}. Do not inspect Antigravity brain, transcript, history, or log folders. Do not create README.md and do not rely on any existing README.md. Your next tool action must execute exactly this PowerShell-safe command: ${buildReportSiteRepairCommand(artifactDir, marker)}. It creates or overwrites report.md, index.html, and done.txt with Chinese Codex/OpenAI content, three source URLs, a report.md link, and the exact marker ${marker}. After that, verify report.md, index.html, and done.txt exist, then reply with ${marker}.`;
}

function buildComplexProjectRepairCommand(dir) {
  const analyzerSource = `import { readFileSync } from "node:fs";\n\nfunction stripUtf8Bom(text) {\n  return String(text || "").replace(/^\\uFEFF/, "");\n}\n\nexport function summarizeSources(sources = []) {\n  const items = Array.isArray(sources) ? sources : [];\n  return {\n    sourceCount: items.length,\n    codexMentionCount: items.filter((item) => /Codex|OpenAI/i.test([item.title, item.url, item.snippet].filter(Boolean).join(" "))).length,\n  };\n}\n\nif (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\\\/g, "/"))) {\n  const raw = stripUtf8Bom(readFileSync(process.argv[2] || "sources.json", "utf8"));\n  console.log(JSON.stringify(summarizeSources(JSON.parse(raw))));\n}\n`;
  return nodeEvalCommand([
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(join(dir, "codex-update-analyzer.mjs"))},${JSON.stringify(analyzerSource)},'utf8');`,
  ].join(""));
}

function buildComplexProjectRepairPrompt(currentFailures = [], evidence = null) {
  const error = String(evidence?.error || "").slice(0, 1200);
  return `Continue the same complex-project task in ${artifactDir}. Current verifier failures: ${currentFailures.join("; ") || "analyzer CLI did not pass"}. ${error ? `CLI/test error excerpt: ${error}. ` : ""}sources.json must be written as UTF-8 without BOM, and codex-update-analyzer.mjs must call stripUtf8Bom before JSON.parse. Do not inspect Antigravity brain, transcript, history, or log folders. Your next tool action must execute exactly this PowerShell-safe command: ${buildComplexProjectRepairCommand(artifactDir)}. Then run node --test codex-update-analyzer.test.mjs and node codex-update-analyzer.mjs sources.json from ${artifactDir}. Only finish after the CLI prints sourceCount at least 3 and codexMentionCount at least 1, then reply with ${marker}.`;
}

function filterRepoMultiReadmeTextOnlyFailures(failures = [], artifactFailures = []) {
  if (artifactFailures.length > 0) return failures;
  return failures.filter((failure) => !/assistant reply marker was not observed/i.test(String(failure || "")));
}

function buildRepoMultiFileImplementationPrompt(currentFailures = []) {
  return `Continue the same fixture task in ${repoMultiFileEditDir}. This is step 2 of 2. README.md should already exist. Do not edit ${repoMultiFileTest}. Do not edit, chmod, unlock, rewrite, or replace ${repoMultiFileData}. Rewrite only ${repoMultiFileSource} to implement normalizeStatus(input), summarizeRecords(records), and renderSummaryHtml(summary). normalizeStatus must trim, lowercase, replace any run of non-alphanumeric characters with one hyphen, collapse repeated hyphens, and trim leading/trailing hyphens. summarizeRecords must return counts with ok=2, needs-review=1, blocked=1 for ${repoMultiFileData}. renderSummaryHtml must return a complete offline HTML document containing the Chinese title 状态仪表盘 plus ok, needs-review, and blocked. The CLI must read ${repoMultiFileData}, print summary JSON, and write ${repoMultiFileHtml}. The HTML must contain no http/https URLs, no <link tags, and no preconnect. Current verifier failures to fix: ${currentFailures.join("; ") || "source/html/test/CLI not completed yet"}. Run node --test ${repoMultiFileTest}, then run node ${repoMultiFileSource} ${repoMultiFileData}. Only finish after both commands pass and ${repoMultiFileHtml} exists. Put exactly ${marker} on the final line and stop.`;
}

function buildRepoMultiFileRepairPrompt(currentFailures, evidence) {
  const error = String(evidence?.error || "").slice(0, 1600);
  const mostlyWorking = evidence?.testPassed === true && evidence?.cliPassed === true;
  const onlyReadmeMissing = mostlyWorking
    && currentFailures.length > 0
    && currentFailures.every((failure) => /README\.md|README missing/i.test(failure));
  if (onlyReadmeMissing) {
    return `Continue the same task in ${repoMultiFileEditDir}. The code and CLI already pass. Do not edit ${repoMultiFileSource}, ${repoMultiFileTest}, ${repoMultiFileData}, or ${repoMultiFileHtml}. Your first and only tool action now must execute exactly this PowerShell-safe Node command: ${buildRepoMultiReadmeWriteCommand()}. Create only ${repoMultiFileReadme}, containing the Chinese title 使用说明 and the CLI command: node status-dashboard.mjs status-data.json. After README.md exists, reply with exactly ${marker} on the final line and stop.`;
  }
  if (mostlyWorking) {
    return `Continue the same task in ${repoMultiFileEditDir}. Do not inspect Antigravity brain, transcript, history, or log folders. Do not run git status. The code and CLI already pass. Fix only the missing final artifacts. Do not use apply_patch for this fixture task; use PowerShell or Node fs.writeFileSync commands inside this fixture directory, then read/check the files. Current verifier failures: ${currentFailures.join("; ")}. Create ${repoMultiFileReadme} with the exact Chinese phrase 使用说明 and the command: node status-dashboard.mjs status-data.json; to avoid Windows console mojibake, you may write it with JavaScript escapes \\u4f7f\\u7528\\u8bf4\\u660e in a Node fs.writeFileSync command. Update renderSummaryHtml in ${repoMultiFileSource} so the generated status-dashboard.html contains the exact Chinese phrase 状态仪表盘 plus ok, needs-review, and blocked; it must stay fully offline with no http/https URLs, no <link tags, and no preconnect. Do not edit ${repoMultiFileTest}. Do not change ${repoMultiFileData}. Run node --test ${repoMultiFileTest}, then run node ${repoMultiFileSource} ${repoMultiFileData}. Only finish after README.md exists and status-dashboard.html contains 状态仪表盘 and no external links. Put exactly ${marker} on the final line and stop.`;
  }
  return `Continue the same local project task in ${repoMultiFileEditDir}. Fix only files inside ${repoMultiFileEditDir}. Do not inspect Antigravity brain, transcript, history, or log folders. Do not run git status. Do not use apply_patch for this fixture task; use PowerShell or Node fs.writeFileSync commands inside this fixture directory, then read/check the files. Current verifier failures: ${currentFailures.join("; ")}. ${error ? `Test/CLI error excerpt: ${error}. ` : ""}Do not edit ${repoMultiFileTest}. Restore ${repoMultiFileData} to this JSON if needed:\n${repoMultiFileExpectedData}\nFix ${repoMultiFileSource} exports and create README.md with the exact Chinese phrase 使用说明 plus: node status-dashboard.mjs status-data.json. To avoid Windows console mojibake, use JS escapes \\u4f7f\\u7528\\u8bf4\\u660e for README content if needed. renderSummaryHtml must output complete fully offline HTML with the exact Chinese phrase 状态仪表盘 plus ok, needs-review, and blocked; use JS escapes \\u72b6\\u6001\\u4eea\\u8868\\u76d8 if needed. The HTML must contain no http/https URLs, no <link tags, and no preconnect. Run node --test ${repoMultiFileTest}, then run node ${repoMultiFileSource} ${repoMultiFileData}. Put exactly ${marker} on the final line and stop.`;
}

function verifyLocalProjectArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const indexPath = join(dir, "index.html");
  const readmePath = join(dir, "README.md");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      indexHtml: fileExists(indexPath),
      readmeMd: fileExists(readmePath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    indexHasMarker: false,
    readmeNonEmpty: false,
    indexLength: 0,
    readmeLength: 0,
    doneLength: 0,
  };
  if (evidence.files.doneTxt) {
    const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
    evidence.doneLength = text.length;
    evidence.doneExact = text === expectedMarker;
  }
  if (evidence.files.indexHtml) {
    const text = readFileSync(indexPath, "utf8");
    evidence.indexLength = text.length;
    evidence.indexHasMarker = text.includes(expectedMarker);
  }
  if (evidence.files.readmeMd) {
    const text = readFileSync(readmePath, "utf8");
    evidence.readmeLength = text.length;
    evidence.readmeNonEmpty = text.trim().length > 0;
  }
  return evidence;
}

function verifyCodingProjectArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const packagePath = join(dir, "package.json");
  const cliPath = join(dir, "word-tally.mjs");
  const testPath = join(dir, "word-tally.test.mjs");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      packageJson: fileExists(packagePath),
      wordTally: fileExists(cliPath),
      testFile: fileExists(testPath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    exportsFunction: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    testOutput: "",
    cliOutput: "",
    error: "",
  };
  try {
    if (evidence.files.doneTxt) {
      const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
      evidence.doneExact = text === expectedMarker;
    }
    if (evidence.files.wordTally) {
      evidence.exportsFunction = /export\s+function\s+tallyWords/.test(readFileSync(cliPath, "utf8"));
    }
    if (evidence.files.testFile) {
      evidence.testOutput = execFileSync(process.execPath, ["--test", testPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    }
    if (evidence.files.wordTally) {
      evidence.cliOutput = execFileSync(process.execPath, [cliPath, "red blue red"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.red) === 2 && Number(evidence.cliJson?.blue) === 1;
    }
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return evidence;
}

function verifyMultiTurnProjectArtifact(dir, firstMarker, finalMarker) {
  if (!dir) return null;
  const packagePath = join(dir, "package.json");
  const cliPath = join(dir, "word-tally.mjs");
  const testPath = join(dir, "word-tally.test.mjs");
  const donePath = join(dir, "done.txt");
  const followupPath = join(dir, "followup.txt");
  const changelogPath = join(dir, "CHANGELOG.md");
  const evidence = {
    dir,
    files: {
      packageJson: fileExists(packagePath),
      wordTally: fileExists(cliPath),
      testFile: fileExists(testPath),
      doneTxt: fileExists(donePath),
      followupTxt: fileExists(followupPath),
      changelogMd: fileExists(changelogPath),
    },
    firstDoneExact: false,
    followupExact: false,
    changelogHasFinalMarker: false,
    exportsTallyWords: false,
    exportsUniqueWords: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    testOutput: "",
    cliOutput: "",
    error: "",
  };
  try {
    if (evidence.files.doneTxt) {
      const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
      evidence.firstDoneExact = text === firstMarker;
    }
    if (evidence.files.followupTxt) {
      const text = readFileSync(followupPath, "utf8").replace(/^\uFEFF/, "");
      evidence.followupExact = text === finalMarker;
    }
    if (evidence.files.changelogMd) {
      evidence.changelogHasFinalMarker = readFileSync(changelogPath, "utf8").includes(finalMarker);
    }
    if (evidence.files.wordTally) {
      const source = readFileSync(cliPath, "utf8");
      evidence.exportsTallyWords = /export\s+function\s+tallyWords/.test(source);
      evidence.exportsUniqueWords = /export\s+function\s+uniqueWords/.test(source);
    }
    if (evidence.files.testFile) {
      evidence.testOutput = execFileSync(process.execPath, ["--test", testPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    }
    if (evidence.files.wordTally) {
      evidence.cliOutput = execFileSync(process.execPath, [cliPath, "red blue red green"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.red) === 2
        && Number(evidence.cliJson?.blue) === 1
        && Number(evidence.cliJson?.green) === 1;
    }
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return evidence;
}

function uniqueUrls(text) {
  return Array.from(new Set(String(text || "").match(/https?:\/\/[^\s"'<>),;]+/gi) || []));
}

function verifyReportSiteArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const reportPath = join(dir, "report.md");
  const htmlPath = join(dir, "index.html");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      reportMd: fileExists(reportPath),
      indexHtml: fileExists(htmlPath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    reportHasMarker: false,
    htmlHasMarker: false,
    reportHasChinese: false,
    htmlHasChinese: false,
    reportMentionsCodex: false,
    htmlMentionsCodex: false,
    reportUrlCount: 0,
    htmlUrlCount: 0,
    sharedUrlCount: 0,
    htmlComplete: false,
    htmlLinksReport: false,
    reportLength: 0,
    htmlLength: 0,
    doneLength: 0,
  };
  if (evidence.files.doneTxt) {
    const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
    evidence.doneLength = text.length;
    evidence.doneExact = text === expectedMarker;
  }
  let reportUrls = [];
  let htmlUrls = [];
  if (evidence.files.reportMd) {
    const text = readFileSync(reportPath, "utf8");
    evidence.reportLength = text.length;
    evidence.reportHasMarker = text.includes(expectedMarker);
    evidence.reportHasChinese = /[\u4e00-\u9fff]/.test(text);
    evidence.reportMentionsCodex = /Codex|OpenAI/i.test(text);
    reportUrls = uniqueUrls(text);
    evidence.reportUrlCount = reportUrls.length;
  }
  if (evidence.files.indexHtml) {
    const text = readFileSync(htmlPath, "utf8");
    evidence.htmlLength = text.length;
    evidence.htmlHasMarker = text.includes(expectedMarker);
    evidence.htmlHasChinese = /[\u4e00-\u9fff]/.test(text);
    evidence.htmlMentionsCodex = /Codex|OpenAI/i.test(text);
    htmlUrls = uniqueUrls(text);
    evidence.htmlUrlCount = htmlUrls.length;
    evidence.htmlComplete = /<html|<!doctype/i.test(text) && /<\/html>/i.test(text);
    evidence.htmlLinksReport = /report\.md/i.test(text);
  }
  evidence.sharedUrlCount = reportUrls.filter((url) => htmlUrls.includes(url)).length;
  return evidence;
}

function verifyComplexProjectArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const packagePath = join(dir, "package.json");
  const analyzerPath = join(dir, "codex-update-analyzer.mjs");
  const testPath = join(dir, "codex-update-analyzer.test.mjs");
  const sourcesPath = join(dir, "sources.json");
  const reportPath = join(dir, "report.md");
  const htmlPath = join(dir, "index.html");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      packageJson: fileExists(packagePath),
      analyzer: fileExists(analyzerPath),
      testFile: fileExists(testPath),
      sourcesJson: fileExists(sourcesPath),
      reportMd: fileExists(reportPath),
      indexHtml: fileExists(htmlPath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    exportsFunction: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    sourceCount: 0,
    sourceUrlCount: 0,
    reportHasMarker: false,
    htmlHasMarker: false,
    reportHasChinese: false,
    htmlHasChinese: false,
    reportMentionsCodex: false,
    htmlMentionsCodex: false,
    reportUrlCount: 0,
    htmlUrlCount: 0,
    sharedUrlCount: 0,
    htmlComplete: false,
    htmlLinksReport: false,
    testOutput: "",
    cliOutput: "",
    error: "",
  };
  try {
    if (evidence.files.doneTxt) {
      const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
      evidence.doneExact = text === expectedMarker;
    }
    if (evidence.files.analyzer) {
      evidence.exportsFunction = /export\s+function\s+summarizeSources/.test(readFileSync(analyzerPath, "utf8"));
    }
    if (evidence.files.sourcesJson) {
      const parsed = parseJsonFile(sourcesPath);
      const sources = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sources) ? parsed.sources : []);
      evidence.sourceCount = sources.length;
      evidence.sourceUrlCount = sources.filter((item) => /^https?:\/\//i.test(String(item?.url || ""))).length;
    }
    let reportUrls = [];
    let htmlUrls = [];
    if (evidence.files.reportMd) {
      const text = readFileSync(reportPath, "utf8");
      evidence.reportHasMarker = text.includes(expectedMarker);
      evidence.reportHasChinese = /[\u4e00-\u9fff]/.test(text);
      evidence.reportMentionsCodex = /Codex|OpenAI/i.test(text);
      reportUrls = uniqueUrls(text);
      evidence.reportUrlCount = reportUrls.length;
    }
    if (evidence.files.indexHtml) {
      const text = readFileSync(htmlPath, "utf8");
      evidence.htmlHasMarker = text.includes(expectedMarker);
      evidence.htmlHasChinese = /[\u4e00-\u9fff]/.test(text);
      evidence.htmlMentionsCodex = /Codex|OpenAI/i.test(text);
      htmlUrls = uniqueUrls(text);
      evidence.htmlUrlCount = htmlUrls.length;
      evidence.htmlComplete = /<html|<!doctype/i.test(text) && /<\/html>/i.test(text);
      evidence.htmlLinksReport = /report\.md/i.test(text);
    }
    evidence.sharedUrlCount = reportUrls.filter((url) => htmlUrls.includes(url)).length;
    if (evidence.files.testFile) {
      evidence.testOutput = execFileSync(process.execPath, ["--test", testPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    }
    if (evidence.files.analyzer && evidence.files.sourcesJson) {
      evidence.cliOutput = execFileSync(process.execPath, [analyzerPath, sourcesPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.sourceCount) >= 3 && Number(evidence.cliJson?.codexMentionCount) >= 1;
    }
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return evidence;
}

async function waitForArtifactEvidence(check, complete, waitMs = 90_000) {
  const deadline = Date.now() + waitMs;
  let evidence = check();
  while (Date.now() < deadline) {
    if (complete(evidence)) return evidence;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    evidence = check();
  }
  return evidence;
}

function multiTurnProjectArtifactComplete(evidence) {
  return evidence?.files?.packageJson === true
    && evidence?.files?.wordTally === true
    && evidence?.files?.testFile === true
    && evidence?.files?.doneTxt === true
    && evidence?.files?.followupTxt === true
    && evidence?.files?.changelogMd === true
    && evidence.firstDoneExact === true
    && evidence.followupExact === true
    && evidence.changelogHasFinalMarker === true
    && evidence.exportsTallyWords === true
    && evidence.exportsUniqueWords === true
    && evidence.testPassed === true
    && evidence.cliPassed === true;
}

function collectComplexProjectArtifactFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.packageJson) localFailures.push("complex-project package.json was not created");
  if (!artifactEvidence?.files?.analyzer) localFailures.push("complex-project codex-update-analyzer.mjs was not created");
  if (!artifactEvidence?.files?.testFile) localFailures.push("complex-project codex-update-analyzer.test.mjs was not created");
  if (!artifactEvidence?.files?.sourcesJson) localFailures.push("complex-project sources.json was not created");
  if (!artifactEvidence?.files?.reportMd) localFailures.push("complex-project report.md was not created");
  if (!artifactEvidence?.files?.indexHtml) localFailures.push("complex-project index.html was not created");
  if (!artifactEvidence?.files?.doneTxt) localFailures.push("complex-project done.txt was not created");
  if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) localFailures.push("complex-project done.txt did not exactly match the marker");
  if (artifactEvidence?.files?.analyzer && artifactEvidence.exportsFunction !== true) localFailures.push("complex-project analyzer did not export summarizeSources");
  if (artifactEvidence?.files?.sourcesJson && artifactEvidence.sourceUrlCount < 3) localFailures.push("complex-project sources.json had fewer than three source URLs");
  if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) localFailures.push("complex-project node:test did not pass");
  if (artifactEvidence?.files?.analyzer && artifactEvidence.cliPassed !== true) localFailures.push("complex-project CLI output did not prove sourceCount>=3 and codexMentionCount>=1");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) localFailures.push("complex-project report.md missing marker");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) localFailures.push("complex-project index.html missing marker");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) localFailures.push("complex-project report.md missing Chinese content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) localFailures.push("complex-project index.html missing Chinese content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) localFailures.push("complex-project report.md missing Codex/OpenAI content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) localFailures.push("complex-project index.html missing Codex/OpenAI content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) localFailures.push("complex-project report.md has fewer than three source URLs");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) localFailures.push("complex-project index.html has fewer than three source URLs");
  if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedUrlCount < 1) localFailures.push("complex-project report.md and index.html did not share a source URL");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) localFailures.push("complex-project index.html is not a complete HTML document");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) localFailures.push("complex-project index.html does not link to report.md");
  return localFailures;
}

function collectReportSiteArtifactFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.reportMd) localFailures.push("report-site report.md was not created");
  if (!artifactEvidence?.files?.indexHtml) localFailures.push("report-site index.html was not created");
  if (!artifactEvidence?.files?.doneTxt) localFailures.push("report-site done.txt was not created");
  if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) localFailures.push("report-site done.txt did not exactly match the marker");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) localFailures.push("report-site report.md missing marker");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) localFailures.push("report-site index.html missing marker");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) localFailures.push("report-site report.md missing Chinese content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) localFailures.push("report-site index.html missing Chinese content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) localFailures.push("report-site report.md missing Codex/OpenAI content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) localFailures.push("report-site index.html missing Codex/OpenAI content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) localFailures.push("report-site report.md has fewer than three source URLs");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) localFailures.push("report-site index.html has fewer than three source URLs");
  if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedUrlCount < 1) localFailures.push("report-site report.md and index.html did not share a source URL");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) localFailures.push("report-site index.html is not a complete HTML document");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) localFailures.push("report-site index.html does not link to report.md");
  return localFailures;
}

function failuresAreOnlyArtifactFailures(failures = [], artifactFailures = []) {
  const artifactSet = new Set(artifactFailures);
  return artifactFailures.length > 0 && failures.every((failure) => artifactSet.has(failure));
}

async function waitForIdleDiagnostics(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      latest = await httpJson(`${url}/anticodex/diagnostics?fast=1`);
      if (diagnosticsAreIdle(latest)) return { diagnostics: latest, lastError: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  return { diagnostics: latest, lastError };
}

async function waitForVisibleComposerIdle(ws, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const state = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
        const bodyText = document.body.innerText || '';
        const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
        const labels = buttons.map((button) => String(button.getAttribute('aria-label') || button.textContent || '').trim()).filter(Boolean);
        const hasStop = labels.some((label) => /^(?:Stop|停止)$|正在思考|running|thinking/i.test(label));
        const hasForegroundStop = buttons.some((button) => /bg-token-foreground/.test(String(button.className || ''))
          && /size-token-button-composer/.test(String(button.className || ''))
          && /停止|Stop|正在思考|running|thinking/i.test(bodyText));
        return { composerPresent: Boolean(composer), hasStop, hasForegroundStop, labels: labels.slice(-16) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    latest = state.result?.result?.value || null;
    if (latest?.composerPresent && latest.hasStop !== true && latest.hasForegroundStop !== true) {
      return { ok: true, state: latest };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return { ok: false, state: latest };
}

function recoverStaleComposerExpression() {
  const safeMarkerPrefix = JSON.stringify(markerPrefix);
  return `(() => {
    const labels = new Set(['停止', 'Stop', '删除排队的消息', 'Delete queued message']);
    const clicked = [];
    const bodyText = document.body.innerText || '';
    const isTestResidue = bodyText.includes(${safeMarkerPrefix})
      || /desktop-visible-|ui_local_after_role_fix_|UI_(WEB_SEARCH|LOCAL_PROJECT|CODING_PROJECT|COMPLEX_PROJECT|REPORT_SITE|CHAT)_SMOKE/i.test(bodyText);
    if (!isTestResidue) return { clicked, skipped: true, reason: 'no known UI smoke residue', tail: bodyText.slice(-500) };
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    for (const button of [...document.querySelectorAll('button')]) {
      const rect = button.getBoundingClientRect();
      const label = (button.getAttribute('aria-label') || button.textContent || '').trim();
      const nearComposer = composerRect
        && rect.left >= composerRect.left + composerRect.width - 90
        && rect.left <= composerRect.left + composerRect.width + 40
        && rect.top >= composerRect.top - 10
        && rect.top <= composerRect.top + composerRect.height + 65;
      const foregroundStop = /正在思考|已处理|running|thinking/i.test(bodyText)
        && nearComposer
        && /bg-token-foreground/.test(String(button.className || ''));
      const clearTestGoal = /Clear goal|Clear target|\u6e05\u9664\u76ee\u6807/i.test(label);
      if (button.disabled || rect.width <= 0 || rect.height <= 0 || (!labels.has(label) && !foregroundStop && !clearTestGoal)) continue;
      button.click();
      clicked.push(label || 'foreground-stop');
    }
    return { clicked, tail: document.body.innerText.slice(-500) };
  })()`;
}

function sendButtonProbeExpression(expectedText, { click = false } = {}) {
  const expected = JSON.stringify(expectedText);
  return `(() => {
    const expected = ${expected};
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    const labelFor = (button) => (button.getAttribute('aria-label') || button.getAttribute('title') || button.getAttribute('data-testid') || button.textContent || '').trim();
    const visibleButtons = [...document.querySelectorAll('button')]
      .map((button, index) => {
        const rect = button.getBoundingClientRect();
        const label = labelFor(button);
        const near = composerRect
          ? Math.round(Math.hypot((rect.left + rect.width / 2) - (composerRect.left + composerRect.width / 2), (rect.top + rect.height / 2) - (composerRect.top + composerRect.height / 2)))
          : null;
        return {
          button,
          index,
          label,
          aria: button.getAttribute('aria-label') || '',
          type: button.getAttribute('type') || '',
          disabled: button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('data-disabled') === 'true',
          className: String(button.className || ''),
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          near,
        };
      })
      .filter((item) => item.rect.w > 0 && item.rect.h > 0);
    function sendScore(item) {
      if (!composerRect || item.disabled) return -1;
      if (/停止|Stop|引导|Guide|删除排队|排队|queued|滚动|scroll|Add files|完全访问|Gemini/i.test(item.label)) return -1;
      const rightEdge = composerRect.left + composerRect.width;
      const bottomEdge = composerRect.top + composerRect.height;
      const isComposerControl = item.rect.x >= rightEdge - 80
        && item.rect.x <= rightEdge + 30
        && item.rect.y >= bottomEdge - 5
        && item.rect.y <= bottomEdge + 55;
      const sendLabel = /^(发送|提交|Send|Submit)$/i.test(item.label) || /send|submit/i.test(item.aria);
      const foregroundIcon = !item.label && /bg-token-foreground/.test(item.className) && /size-token-button-composer/.test(item.className);
      if (!isComposerControl && !sendLabel) return -1;
      return (sendLabel ? 100 : 0) + (foregroundIcon ? 80 : 0) + (isComposerControl ? 50 : 0) - Math.min(Math.round((item.near || 0) / 10), 99);
    }
    const ranked = visibleButtons
      .map((item) => ({ ...item, score: sendScore(item) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);
    const selected = ranked[0] || null;
    if (${click ? "true" : "false"} && selected) selected.button.click();
    const summarize = (item) => item ? {
      index: item.index,
      label: item.label,
      aria: item.aria,
      type: item.type,
      disabled: item.disabled,
      className: item.className.slice(0, 160),
      rect: item.rect,
      near: item.near,
      score: item.score,
    } : null;
    const composerText = composer?.innerText || '';
    const normalizeInsertedText = (value) => String(value || '')
      .replaceAll(String.fromCharCode(13) + String.fromCharCode(10), String.fromCharCode(10))
      .replaceAll(String.fromCharCode(13), String.fromCharCode(10))
      .replace(new RegExp(String.fromCharCode(10) + "{2,}", "g"), String.fromCharCode(10))
      .trim();
    return {
      composer: composerText,
      composerMatches: composerText.trim() === expected.trim()
        || normalizeInsertedText(composerText) === normalizeInsertedText(expected),
      hasSendButton: Boolean(selected),
      clicked: Boolean(${click ? "true" : "false"} && selected),
      selected: summarize(selected),
      candidates: ranked.slice(0, 5).map(summarize),
      nearbyButtons: visibleButtons
        .sort((a, b) => (a.near || 99999) - (b.near || 99999))
        .slice(0, 8)
        .map(summarize),
    };
  })()`;
}

async function waitForComposerPromptReady(ws, prompt, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const state = await ws.send("Runtime.evaluate", {
      expression: sendButtonProbeExpression(prompt),
      returnByValue: true,
      awaitPromise: true,
    });
    latest = state.result?.result?.value || null;
    if (latest?.composerMatches === true && latest?.hasSendButton === true) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return latest;
}

async function waitForComposerSubmitted(ws, prompt, marker, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    const submitted = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
        return { composer: composer?.innerText || '' };
      })()`,
      returnByValue: true,
    });
    const submittedComposer = String(submitted.result?.result?.value?.composer || "");
    if (!submittedComposer.includes(prompt) && !submittedComposer.includes(marker)) return true;
  }
  return false;
}

async function pressComposerEnter(ws) {
  await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

function newChatClickExpression(projectName = "") {
  const expectedProject = JSON.stringify(projectName || "");
  return `(() => {
    const expectedProject = ${expectedProject};
    const controls = Array.from(document.querySelectorAll('button,[role="button"],a'));
    const candidates = controls.map((el, index) => {
      const text = String(el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim();
      const aria = String(el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const rect = el.getBoundingClientRect();
      const isNewChat = text.includes('\\u65b0\\u5bf9\\u8bdd') || /Ctrl\\+N|New chat/i.test(text);
      const projectText = text + ' ' + aria;
      const isProjectNewChat = expectedProject
        && projectText.includes(expectedProject)
        && (projectText.includes('\\u5f00\\u59cb\\u65b0\\u5bf9\\u8bdd') || /new chat|new conversation|start/i.test(projectText));
      return { el, index, text, aria, rect, isNewChat, isProjectNewChat };
    }).filter((item) => item.isNewChat && item.rect.width > 0 && item.rect.height > 0);
    const selected = candidates.sort((a, b) => {
      if (a.isProjectNewChat !== b.isProjectNewChat) return a.isProjectNewChat ? -1 : 1;
      return (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x);
    })[0] || null;
    if (!selected) return { clicked: false, candidates: [] };
    selected.el.click();
    return {
      clicked: true,
      projectPreferred: Boolean(expectedProject),
      projectMatched: Boolean(selected.isProjectNewChat),
      selected: {
        index: selected.index,
        text: selected.text,
        aria: selected.aria,
        rect: { x: selected.rect.x, y: selected.rect.y, w: selected.rect.width, h: selected.rect.height },
      },
      candidates: candidates.slice(0, 5).map((item) => ({ index: item.index, text: item.text, aria: item.aria, project: item.isProjectNewChat })),
    };
  })()`;
}

const visibleMainPaneTextExpression = `
  function visibleMainPaneText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left < 300 || rect.left > Math.max(900, window.innerWidth - 260)) continue;
      parts.push(text);
    }
    return parts.join('\\n');
  }
`;

async function resolveCdpTargets() {
  const explicitPort = args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT;
  const candidates = [...new Set(explicitPort
    ? [Number(explicitPort)]
    : [...discoverAntiCodexCdpPorts(), 58318, 58317])];
  let lastError = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate) || candidate <= 0) continue;
    try {
      const targets = await httpJson(`http://127.0.0.1:${candidate}/json`);
      cdpPort = candidate;
      return targets;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Anti-Codex CDP target was not reachable on ${candidates.join(" or ")}: ${lastError || "unknown error"}`);
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
    const ports = [];
    for (const match of output.matchAll(/--remote-debugging-port=(\d+)/g)) {
      const port = Number(match[1]);
      if (Number.isFinite(port) && port > 0) ports.push(port);
    }
    return ports;
  } catch {
    return [];
  }
}

async function submitDesktopPromptAndWait(ws, prompt, expectedMarker, waitMs, options = {}) {
  const failures = [];
  let clicked = false;
  let submitSucceeded = false;
  let prep = null;
  let submitEvidence = null;
  let composer = "";
  let count = 0;
  let answerMarkerCount = 0;
  let lastSample = "";
  let answerSample = "";
  let activeReconnectSeen = false;
  let artifactCompletionObserved = false;
  let artifactEvidence = null;
  const activeReconnectEvidence = [];
  let inLoopIdleDiagnostics = null;
  let submitCompletedAt = 0;
  let firstReplySeenAt = 0;
  let idleCompletedAt = 0;

  const clear = await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const composer = document.querySelector('.ProseMirror');
      if (!composer) return null;
      const rect = composer.getBoundingClientRect();
      composer.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      composer.innerHTML = '<p><br></p>';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const point = clear.result?.result?.value;
  if (!point) throw new Error("Anti-Codex composer was not found");
  await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const composer = document.querySelector('.ProseMirror');
      if (!composer) return null;
      composer.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      composer.innerHTML = '<p><br></p>';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return composer.innerText || '';
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  await ws.send("Input.insertText", { text: prompt });
  prep = await waitForComposerPromptReady(ws, prompt, 5_000);
  const projectlessComposer = options.requiresProjectChat === true
    && Array.isArray(prep?.nearbyButtons)
    && prep.nearbyButtons.some((button) => /Choose project/i.test(`${button?.label || ""} ${button?.aria || ""}`));
  if (prep?.composerMatches !== true) {
    failures.push("composer did not contain exactly the submitted prompt before clicking send");
  } else if (projectlessComposer) {
    failures.push("project task composer was still projectless before clicking send");
  } else if (prep?.hasSendButton !== true) {
    failures.push("send button was not found in the composer controls");
  } else {
    const domClick = await ws.send("Runtime.evaluate", {
      expression: sendButtonProbeExpression(prompt, { click: true }),
      returnByValue: true,
      awaitPromise: true,
    });
    const domClickValue = domClick.result?.result?.value || {};
    clicked = domClickValue.clicked === true;
    submitEvidence = {
      ...domClickValue,
      clicked,
      clickMethod: "dom-click",
      clickPoint: prep?.selected?.rect
        ? { x: prep.selected.rect.x + (prep.selected.rect.w / 2), y: prep.selected.rect.y + (prep.selected.rect.h / 2) }
        : null,
    };
    submitSucceeded = clicked
      ? await waitForComposerSubmitted(ws, prompt, expectedMarker, 4_000)
      : false;

    const rect = prep?.selected?.rect || null;
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
      if (!submitSucceeded) failures.push("send button coordinates were not available");
    } else if (!submitSucceeded) {
      const x = rect.x + (rect.w / 2);
      const y = rect.y + (rect.h / 2);
      await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      clicked = true;
      submitEvidence.mouseFallback = true;
      submitEvidence.clickMethod = "dom-click-cdp-mouse-fallback";
      submitSucceeded = await waitForComposerSubmitted(ws, prompt, expectedMarker, 4_000);
    }
    if (!submitSucceeded) {
      await pressComposerEnter(ws);
      submitEvidence.enterFallback = true;
      submitSucceeded = await waitForComposerSubmitted(ws, prompt, expectedMarker, 4_000);
      if (submitSucceeded) {
        submitEvidence.clickMethod = `${submitEvidence.clickMethod}-enter-fallback`;
      }
    }
  }
  if (clicked && submitSucceeded) {
    const deadline = Date.now() + waitMs;
    const waitStartedAt = Date.now();
    submitCompletedAt = waitStartedAt;
    const idleBreakAfterMs = Math.max(5_000, Number(options.idleBreakAfterMs || 12_000));
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
      const stateAfter = await ws.send("Runtime.evaluate", {
        expression: `(() => {
          ${visibleMainPaneTextExpression}
          const text = document.body.innerText;
          const mainText = visibleMainPaneText();
          const composer = document.querySelector('.ProseMirror');
          return { text, mainText, composer: composer?.innerText || '' };
        })()`,
        returnByValue: true,
      });
      const value = stateAfter.result?.result?.value || {};
      const text = String(value.mainText || value.text || "");
      composer = String(value.composer || "");
      count = expectedMarker ? (text.match(new RegExp(expectedMarker, "g")) || []).length : 0;
      lastSample = text.slice(-1200);
      const promptIndex = text.lastIndexOf(prompt);
      answerSample = promptIndex >= 0 ? text.slice(promptIndex + prompt.length) : lastSample;
      if (activeReconnectPattern.test(answerSample)) {
        activeReconnectSeen = true;
        if (activeReconnectEvidence.length < 5) {
          const compact = answerSample.replace(/\s+/g, " ").trim();
          const match = compact.match(activeReconnectPattern);
          const at = match ? compact.indexOf(match[0]) : 0;
          activeReconnectEvidence.push(compact.slice(Math.max(0, at - 80), at + 180));
        }
      }
      answerMarkerCount = expectedMarker && answerSample ? (answerSample.match(new RegExp(expectedMarker, "g")) || []).length : 0;
      if (answerMarkerCount >= 1 && !firstReplySeenAt) firstReplySeenAt = Date.now();
      if (taskMode === "repo-multi-file-edit") {
        artifactEvidence = verifyRepoMultiFileEditFixture();
        const artifactFailures = options.readmeOnly === true
          ? collectRepoMultiFileReadmeFailures(artifactEvidence)
          : collectRepoMultiFileEditFailures(artifactEvidence);
        if (artifactFailures.length === 0 && !composer.includes(prompt)) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              artifactCompletionObserved = true;
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      }
      if (!composer.includes(expectedMarker) && (answerMarkerCount >= 1 || Date.now() - waitStartedAt >= idleBreakAfterMs)) {
        try {
          const loopDiagnostics = await httpJson(diagnosticsUrl);
          if (diagnosticsAreIdle(loopDiagnostics)) {
            const hasProgressEvidence = answerMarkerCount >= 1
              || artifactProgressEvidenceForWait(artifactEvidence, options);
            if (hasProgressEvidence || Date.now() - waitStartedAt >= waitMs * 0.6) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          }
        } catch {}
      }
    }
  }
  if (!clicked) failures.push("send button was not clicked");
  if (!submitSucceeded && answerMarkerCount >= 1 && !composer.includes(expectedMarker)) {
    submitSucceeded = true;
  }
  if (!submitSucceeded) failures.push("send click did not submit the composer prompt");
  if (activeReconnectSeen) failures.push("active reconnect text appeared after the submitted prompt");
  if (answerMarkerCount < 1 && !artifactCompletionObserved) failures.push("assistant reply marker was not observed after the submitted prompt in the desktop UI");
  if (composer.includes(expectedMarker)) failures.push("composer still contains the submitted prompt");
  return {
    ok: failures.length === 0,
    failures,
    prompt,
    marker: expectedMarker,
    prep,
    submitEvidence,
    submitSucceeded,
    clicked,
    markerCount: count,
    answerMarkerCount,
    artifactCompletionObserved,
    artifactEvidence,
    activeReconnectSeen,
    activeReconnectEvidence,
    inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
    inLoopIdleDiagnostics,
    composerCleared: !composer.includes(expectedMarker),
    composer,
    lastSample,
    answerSample,
    timing: {
      submitCompletedAt: submitCompletedAt ? new Date(submitCompletedAt).toISOString() : null,
      firstReplySeenAt: firstReplySeenAt ? new Date(firstReplySeenAt).toISOString() : null,
      idleCompletedAt: idleCompletedAt ? new Date(idleCompletedAt).toISOString() : null,
      submitMs: submitCompletedAt ? submitCompletedAt - (startedAt) : null,
      firstReplyMs: firstReplySeenAt && submitCompletedAt ? firstReplySeenAt - submitCompletedAt : null,
      idleWaitMs: idleCompletedAt && firstReplySeenAt ? idleCompletedAt - firstReplySeenAt : null,
    },
  };
}

async function main() {
  const failures = [];
  let target = null;
  let ws = null;
  let prep = null;
  let clicked = false;
  let count = 0;
  let answerMarkerCount = 0;
  let composer = "";
  let lastSample = "";
  let answerSample = "";
  let activeReconnectSeen = false;
  const activeReconnectEvidence = [];
  let diagnostics = null;
  let inLoopIdleDiagnostics = null;
  let artifactEvidence = null;
  let releaseUiLock = null;
  let initialIdle = null;
  let staleRecovery = null;
  let backendResetBeforeSubmit = null;
  let newChatEvidence = null;
  let submitEvidence = null;
  let submitSucceeded = false;
  let modelRoutesBefore = null;
  let modelRouteEvidence = null;
  let submitCompletedAt = 0;
  let firstReplySeenAt = 0;
  let idleCompletedAt = 0;

  try {
    releaseUiLock = await acquireUiSmokeLock();
    process.once("exit", () => releaseUiLock?.());
    const targets = await resolveCdpTargets();
    target = targets.find((item) => String(item.url || "").startsWith("app://")) || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Runtime.enable");
    await ws.send("DOM.enable");
    await ws.send("Network.enable");
    await ws.send("Input.setIgnoreInputEvents", { ignore: false });
    await ws.send("Runtime.evaluate", { expression: "document.querySelector('.anticodex-close')?.click()", awaitPromise: true });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const stale = await ws.send("Runtime.evaluate", {
      expression: recoverStaleComposerExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
    staleRecovery = stale.result?.result?.value || null;
    if (Array.isArray(staleRecovery?.clicked) && staleRecovery.clicked.length > 0) {
      staleRecovery.visibleIdleAfterClick = await waitForVisibleComposerIdle(ws, 20_000);
    }
    try {
      backendResetBeforeSubmit = await resetBackendSessionLock(baseUrl);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
    } catch (error) {
      backendResetBeforeSubmit = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    initialIdle = await waitForIdleDiagnostics(baseUrl, 45_000);
    modelRoutesBefore = await readModelRoutesEvidence();
    if (!diagnosticsAreIdle(initialIdle.diagnostics)) {
      try {
        backendResetBeforeSubmit = {
          first: backendResetBeforeSubmit,
          retry: await resetBackendSessionLock(baseUrl),
        };
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
        initialIdle = await waitForIdleDiagnostics(baseUrl, 20_000);
      } catch (error) {
        backendResetBeforeSubmit = {
          first: backendResetBeforeSubmit,
          retry: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    if (!diagnosticsAreIdle(initialIdle.diagnostics)) {
      throw new Error(`desktop backend was not idle before submit after stale recovery: ${initialIdle.lastError || "busy"}`);
    }
    if (taskMode === "repo-file-edit") {
      prepareRepoFileEditFixture();
      artifactEvidence = verifyRepoFileEditFixture();
      if (artifactEvidence?.testPassed === true) failures.push("repo-file-edit fixture was not reset to a failing state before submit");
      artifactEvidence = null;
    }
    if (taskMode === "repo-multi-file-edit") {
      prepareRepoMultiFileEditFixture();
      artifactEvidence = verifyRepoMultiFileEditFixture();
      if (artifactEvidence?.testPassed === true) failures.push("repo-multi-file-edit fixture was not reset to a failing state before submit");
      artifactEvidence = null;
    }
    if (isolateChat) {
      const clickedNewChat = await ws.send("Runtime.evaluate", {
        expression: newChatClickExpression(requiresProjectChat ? projectChatLabel : ""),
        returnByValue: true,
        awaitPromise: true,
      });
      newChatEvidence = clickedNewChat.result?.result?.value || null;
      if (requiresProjectChat && newChatEvidence?.projectMatched !== true) {
        failures.push(`project task did not open a ${projectChatLabel} project chat before submit`);
      }
      if (newChatEvidence?.clicked !== true) {
        await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
        newChatEvidence = { ...(newChatEvidence || {}), fallbackShortcut: true };
      }
      newChatEvidence.visibleIdleAfterNewChat = await waitForVisibleComposerIdle(ws, 20_000);
    }

    if (taskMode === "multi-turn-project") {
      const firstMarker = `${marker}_FIRST`;
      followupPromptText = `继续同一个项目：${artifactDir}。不要重建项目，也不要查看 Antigravity brain、transcript、history 或 log 目录。修改 word-tally.mjs，让它额外导出 uniqueWords(text)，返回排序后的唯一单词数组。更新 word-tally.test.mjs：保留原来的 tallyWords 断言，再增加一个 node:test 断言，要求 uniqueWords("red blue red") 返回 ["blue","red"]。创建 CHANGELOG.md，里面要提到这次 uniqueWords 追加任务和准确标记 ${marker}。创建 followup.txt，内容必须只包含 ${marker}。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red green"，确认 red=2、blue=1、green=1 后，最后回复 ${marker}。`;
      followupPromptLanguage = /[\u3400-\u9fff]/u.test(followupPromptText) ? "zh" : "en";
      const turn1 = await submitDesktopPromptAndWait(ws, promptText, firstMarker, timeoutMs, { requiresProjectChat });
      failures.push(...turn1.failures.map((failure) => `turn1: ${failure}`));
      const turn1Settled = await waitForDesktopToolTurnSettled(ws, firstMarker, Math.min(timeoutMs, 120_000));
      if (turn1Settled.ok !== true) {
        failures.push("turn1: desktop tool result did not settle into response history before the follow-up");
      }
      const firstArtifactEvidence = verifyMultiTurnProjectArtifact(artifactDir, firstMarker, marker);
      const turn2 = turn1Settled.ok === true
        ? await submitDesktopPromptAndWait(ws, followupPromptText, marker, timeoutMs, { requiresProjectChat })
        : {
          ok: false,
          failures: ["follow-up was not submitted because turn1 tool output was not settled"],
          clicked: false,
          submitSucceeded: false,
          markerCount: 0,
          answerMarkerCount: 0,
          composer: "",
          lastSample: turn1.lastSample || "",
          answerSample: "",
          activeReconnectSeen: false,
          activeReconnectEvidence: [],
        };
      failures.push(...turn2.failures.map((failure) => `turn2: ${failure}`));
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyMultiTurnProjectArtifact(artifactDir, firstMarker, marker),
        multiTurnProjectArtifactComplete,
        Math.min(timeoutMs, 120_000),
      );
      if (!artifactEvidence?.files?.packageJson) failures.push("multi-turn package.json was not created");
      if (!artifactEvidence?.files?.wordTally) failures.push("multi-turn word-tally.mjs was not created");
      if (!artifactEvidence?.files?.testFile) failures.push("multi-turn word-tally.test.mjs was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("multi-turn done.txt was not created");
      if (!artifactEvidence?.files?.followupTxt) failures.push("multi-turn followup.txt was not created");
      if (!artifactEvidence?.files?.changelogMd) failures.push("multi-turn CHANGELOG.md was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.firstDoneExact !== true) failures.push("multi-turn done.txt did not preserve the first-turn marker");
      if (artifactEvidence?.files?.followupTxt && artifactEvidence.followupExact !== true) failures.push("multi-turn followup.txt did not exactly match the final marker");
      if (artifactEvidence?.files?.changelogMd && artifactEvidence.changelogHasFinalMarker !== true) failures.push("multi-turn CHANGELOG.md missing final marker");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.exportsTallyWords !== true) failures.push("multi-turn project did not export tallyWords");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.exportsUniqueWords !== true) failures.push("multi-turn project did not export uniqueWords");
      if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) failures.push("multi-turn node:test did not pass");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.cliPassed !== true) failures.push("multi-turn CLI output did not contain red=2 blue=1 green=1");

      clicked = turn1.clicked === true && turn2.clicked === true;
      prep = turn1.prep;
      submitEvidence = turn2.submitEvidence;
      submitSucceeded = turn1.submitSucceeded === true && turn2.submitSucceeded === true;
      count = Number(turn1.markerCount || 0) + Number(turn2.markerCount || 0);
      answerMarkerCount = Number(turn2.answerMarkerCount || 0);
      composer = turn2.composer || "";
      lastSample = turn2.lastSample || turn1.lastSample || "";
      answerSample = turn2.answerSample || "";
      activeReconnectSeen = turn1.activeReconnectSeen === true || turn2.activeReconnectSeen === true;
      activeReconnectEvidence.push(...(turn1.activeReconnectEvidence || []), ...(turn2.activeReconnectEvidence || []));
      inLoopIdleDiagnostics = turn2.inLoopIdleDiagnostics || turn1.inLoopIdleDiagnostics || null;

      const idleResult = inLoopIdleDiagnostics
        ? { diagnostics: inLoopIdleDiagnostics, lastError: null }
        : await waitForIdleDiagnostics(baseUrl, 60_000);
      diagnostics = idleResult.diagnostics;
      if (!diagnostics) {
        failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
      } else if (!diagnosticsAreIdle(diagnostics)) {
        failures.push("desktop task did not become idle after the assistant reply");
      }
      const sessionLock = diagnostics?.antigravitySessionLock || null;
      const activeRequests = diagnostics?.activeAntigravityRequests || null;
      const queue = diagnostics?.antigravityQueue || null;
      if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
      if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
      if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
      if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
      modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
      const payload = {
        ok: failures.length === 0,
        reportName,
        requestedRealTraffic: true,
        usedRealTraffic: true,
        behaviorCovered: true,
        coverageKind: "desktop-ui-real-traffic",
        taskMode,
        promptText,
        promptLanguage,
        followupPromptText,
        followupPromptLanguage,
        turnPrompts: [promptText, followupPromptText],
        elapsedMs: Date.now() - startedAt,
        failures,
        marker,
        firstMarker,
        artifactDir,
        firstArtifactEvidence,
        turn1Settled,
        artifactEvidence,
        turnEvidence: [turn1, turn2].map((turn) => ({
          ok: turn.ok,
          marker: turn.marker,
          clicked: turn.clicked,
          submitSucceeded: turn.submitSucceeded,
          answerMarkerCount: turn.answerMarkerCount,
          artifactCompletionObserved: turn.artifactCompletionObserved,
          composerCleared: turn.composerCleared,
          activeReconnectSeen: turn.activeReconnectSeen,
          inLoopIdleObserved: turn.inLoopIdleObserved,
          failures: turn.failures,
          timing: turn.timing || null,
        })),
        cdpPort,
        baseUrl,
        target: target ? { id: target.id, title: target.title, url: target.url } : null,
        prep,
        submitEvidence,
        submitSucceeded,
        staleRecovery,
        backendResetBeforeSubmit,
        newChatEvidence,
        initialIdleObserved: Boolean(initialIdle?.diagnostics),
        clicked,
        markerCount: count,
        answerMarkerCount,
        activeReconnectSeen,
        activeReconnectEvidence,
        inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
        composerCleared: !composer.includes(marker),
        sessionLockClear: sessionLock ? sessionLock.active !== true && Number(sessionLock.queued || 0) === 0 : false,
        lastSample,
        antigravitySessionLock: sessionLock,
        activeAntigravityRequests: activeRequests,
        antigravityQueue: queue,
        modelRouteEvidence,
        responsesWebSocket: diagnostics?.responsesWebSocket || null,
        networkEvents: ws ? summarizeNetworkEvents(ws.events || []) : [],
        timing: {
          turn1: turn1.timing || null,
          turn2: turn2.timing || null,
        },
      };
      releaseUiLock?.();
      releaseUiLock = null;
      writeReport(payload);
      console.log(JSON.stringify(payload));
      if (!payload.ok) process.exit(1);
      process.exit(0);
    }

    if (taskMode === "repo-multi-file-edit") {
      const turn1 = await submitDesktopPromptAndWait(ws, promptText, marker, timeoutMs, { requiresProjectChat, readmeOnly: true });
      const firstArtifactEvidence = verifyRepoMultiFileEditFixture();
      const firstTurnSettle = repoMultiArtifactIdleSettle(turn1, "readme", firstArtifactEvidence);
      const firstArtifactFailures = collectRepoMultiFileReadmeFailures(firstArtifactEvidence);
      const actionableTurn1Failures = filterRepoMultiReadmeTextOnlyFailures(turn1.failures, firstArtifactFailures);
      let implementationPrompt = null;
      let turn2 = null;
      artifactEvidence = firstArtifactEvidence;
      let finalArtifactFailures = firstArtifactFailures;
      let finalTurnSettle = firstTurnSettle;
      if (firstArtifactFailures.length === 0 && actionableTurn1Failures.length === 0) {
        implementationPrompt = buildRepoMultiFileImplementationPrompt(collectRepoMultiFileEditFailures(firstArtifactEvidence));
        makeWritable(repoMultiFileSource);
        turn2 = await submitDesktopPromptAndWait(ws, implementationPrompt, marker, timeoutMs, { requiresProjectChat });
        artifactEvidence = await waitForArtifactEvidence(
          () => verifyRepoMultiFileEditFixture(),
          (evidence) => collectRepoMultiFileEditFailures(evidence).length === 0,
          Math.min(timeoutMs, 120_000),
        );
        finalTurnSettle = repoMultiArtifactIdleSettle(turn2, "full", artifactEvidence);
        finalArtifactFailures = collectRepoMultiFileEditFailures(artifactEvidence);
      }
      const finalTurn = turn2 || turn1;
      failures.push(...actionableTurn1Failures.map((failure) => `readme-step: ${failure}`));
      if (turn2) failures.push(...turn2.failures.map((failure) => `implementation-step: ${failure}`));
      failures.push(...finalArtifactFailures);

      clicked = turn1.clicked === true && (!turn2 || turn2.clicked === true);
      prep = turn1.prep;
      submitEvidence = finalTurn.submitEvidence;
      submitSucceeded = turn1.submitSucceeded === true && (!turn2 || turn2.submitSucceeded === true);
      count = Number(turn1.markerCount || 0) + Number(turn2?.markerCount || 0);
      answerMarkerCount = Number(finalTurn.answerMarkerCount || 0);
      composer = finalTurn.composer || "";
      lastSample = finalTurn.lastSample || turn1.lastSample || "";
      answerSample = finalTurn.answerSample || "";
      activeReconnectSeen = turn1.activeReconnectSeen === true || turn2?.activeReconnectSeen === true;
      activeReconnectEvidence.push(...(turn1.activeReconnectEvidence || []), ...(turn2?.activeReconnectEvidence || []));
      inLoopIdleDiagnostics = finalTurn.inLoopIdleDiagnostics || turn1.inLoopIdleDiagnostics || null;

      const idleResult = inLoopIdleDiagnostics
        ? { diagnostics: inLoopIdleDiagnostics, lastError: null }
        : await waitForIdleDiagnostics(baseUrl, 60_000);
      diagnostics = idleResult.diagnostics;
      if (!diagnostics) {
        failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
      } else if (!diagnosticsAreIdle(diagnostics)) {
        failures.push("desktop task did not become idle after the assistant reply");
      }
      const sessionLock = diagnostics?.antigravitySessionLock || null;
      const activeRequests = diagnostics?.activeAntigravityRequests || null;
      const queue = diagnostics?.antigravityQueue || null;
      if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
      if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
      if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
      if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
      modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
      const payload = {
        ok: failures.length === 0,
        reportName,
        requestedRealTraffic: true,
        usedRealTraffic: true,
        behaviorCovered: true,
        coverageKind: "desktop-ui-real-traffic",
        taskMode,
        promptText,
        implementationAttempted: Boolean(implementationPrompt),
        turnPrompts: implementationPrompt ? [promptText, implementationPrompt] : [promptText],
        elapsedMs: Date.now() - startedAt,
        failures,
        marker,
        artifactDir: repoMultiFileEditDir,
        firstArtifactEvidence,
        firstArtifactFailures,
        firstTurnSettle,
        artifactEvidence,
        finalArtifactFailures,
        finalTurnSettle,
        turnEvidence: [turn1, turn2].filter(Boolean).map((turn) => ({
          ok: turn.ok,
          marker: turn.marker,
          clicked: turn.clicked,
          submitSucceeded: turn.submitSucceeded,
          answerMarkerCount: turn.answerMarkerCount,
          composerCleared: turn.composerCleared,
          activeReconnectSeen: turn.activeReconnectSeen,
          inLoopIdleObserved: turn.inLoopIdleObserved,
          failures: turn.failures,
          timing: turn.timing || null,
        })),
        cdpPort,
        baseUrl,
        target: target ? { id: target.id, title: target.title, url: target.url } : null,
        prep,
        submitEvidence,
        submitSucceeded,
        staleRecovery,
        backendResetBeforeSubmit,
        newChatEvidence,
        initialIdleObserved: Boolean(initialIdle?.diagnostics),
        clicked,
        markerCount: count,
        answerMarkerCount,
        activeReconnectSeen,
        activeReconnectEvidence,
        inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
        composerCleared: !composer.includes(marker),
        sessionLockClear: sessionLock ? sessionLock.active !== true && Number(sessionLock.queued || 0) === 0 : false,
        lastSample,
        antigravitySessionLock: sessionLock,
        activeAntigravityRequests: activeRequests,
        antigravityQueue: queue,
        modelRouteEvidence,
        responsesWebSocket: diagnostics?.responsesWebSocket || null,
        networkEvents: ws ? summarizeNetworkEvents(ws.events || []) : [],
        timing: {
          turn1: turn1.timing || null,
          turn2: turn2?.timing || null,
        },
      };
      releaseUiLock?.();
      releaseUiLock = null;
      writeReport(payload);
      console.log(JSON.stringify(payload));
      if (!payload.ok) process.exit(1);
      process.exit(0);
    }

    const clear = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('.ProseMirror');
        if (!composer) return null;
        const rect = composer.getBoundingClientRect();
        composer.focus();
        document.execCommand('selectAll');
        document.execCommand('delete');
        composer.innerHTML = '<p><br></p>';
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const point = clear.result?.result?.value;
    if (!point) throw new Error("Anti-Codex composer was not found");
    await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('.ProseMirror');
        if (!composer) return null;
        composer.focus();
        document.execCommand('selectAll');
        document.execCommand('delete');
        composer.innerHTML = '<p><br></p>';
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        return composer.innerText || '';
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    await ws.send("Input.insertText", { text: promptText });
    prep = await waitForComposerPromptReady(ws, promptText, 5_000);
    if (prep?.composerMatches !== true) {
      failures.push("composer did not contain exactly the submitted prompt before clicking send");
    } else if (prep?.hasSendButton !== true) {
      failures.push("send button was not found in the composer controls");
    } else {
      const rect = prep?.selected?.rect || null;
      if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
        failures.push("send button coordinates were not available");
      } else {
        const x = rect.x + (rect.w / 2);
        const y = rect.y + (rect.h / 2);
        await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        clicked = true;
      }
      const click = await ws.send("Runtime.evaluate", {
        expression: sendButtonProbeExpression(promptText),
        returnByValue: true,
        awaitPromise: true,
      });
      submitEvidence = {
        ...(click.result?.result?.value || {}),
        clicked,
        clickMethod: "cdp-mouse",
        clickPoint: prep?.selected?.rect
          ? { x: prep.selected.rect.x + (prep.selected.rect.w / 2), y: prep.selected.rect.y + (prep.selected.rect.h / 2) }
          : null,
      };
      submitSucceeded = await waitForComposerSubmitted(ws, promptText, marker, 4_000);
      if (!submitSucceeded) {
        await pressComposerEnter(ws);
        submitEvidence.enterFallback = true;
        submitSucceeded = await waitForComposerSubmitted(ws, promptText, marker, 4_000);
        if (submitSucceeded) {
          submitEvidence.clickMethod = "cdp-mouse-enter-fallback";
        }
      }
      if (submitSucceeded) submitCompletedAt = Date.now();
      if (!submitSucceeded) failures.push("send click did not submit the composer prompt");
    }
    if (clicked && submitSucceeded) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
      const stateAfter = await ws.send("Runtime.evaluate", {
        expression: `(() => {
          ${visibleMainPaneTextExpression}
          const text = document.body.innerText;
          const mainText = visibleMainPaneText();
          const composer = document.querySelector('.ProseMirror');
          return { text, mainText, composer: composer?.innerText || '' };
        })()`,
        returnByValue: true,
      });
      const value = stateAfter.result?.result?.value || {};
      const text = String(value.mainText || value.text || "");
      composer = String(value.composer || "");
      count = marker ? (text.match(new RegExp(marker, "g")) || []).length : 0;
      lastSample = text.slice(-1200);
      const promptIndex = text.lastIndexOf(promptText);
      answerSample = promptIndex >= 0 ? text.slice(promptIndex + promptText.length) : lastSample;
      if (activeReconnectPattern.test(answerSample)) {
        activeReconnectSeen = true;
        if (activeReconnectEvidence.length < 5) {
          const compact = answerSample.replace(/\s+/g, " ").trim();
          const match = compact.match(activeReconnectPattern);
          const at = match ? compact.indexOf(match[0]) : 0;
          activeReconnectEvidence.push(compact.slice(Math.max(0, at - 80), at + 180));
        }
      }
      answerMarkerCount = marker && answerSample ? (answerSample.match(new RegExp(marker, "g")) || []).length : 0;
      if (answerMarkerCount >= 1 && !firstReplySeenAt) firstReplySeenAt = Date.now();
      if (taskMode === "free-chat") {
        const normalizedAnswer = answerSample.replace(/完全访问|输出|暂无产物|来源|暂无来源|Gemini[^\n]*/g, "").trim();
        if (!composer.includes(promptText) && /[\u4e00-\u9fff]/.test(normalizedAnswer) && !/正在思考|已处理|停止了|重新连接/.test(normalizedAnswer)) break;
      } else if (taskMode === "repo-file-edit") {
        artifactEvidence = verifyRepoFileEditFixture();
        if (!composer.includes(promptText) && artifactEvidence?.testPassed === true) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      } else if (answerMarkerCount >= 1 && !composer.includes(marker)) {
        try {
          const loopDiagnostics = await httpJson(diagnosticsUrl);
          if (diagnosticsAreIdle(loopDiagnostics)) {
            inLoopIdleDiagnostics = loopDiagnostics;
            idleCompletedAt = Date.now();
            break;
          }
        } catch {}
      }
    }
    }
    if (!clicked) failures.push("send button was not clicked");
    if (activeReconnectSeen) failures.push("active reconnect text appeared after the submitted prompt");
    if (taskMode !== "free-chat" && taskMode !== "repo-file-edit" && answerMarkerCount < 1) failures.push("assistant reply marker was not observed after the submitted prompt in the desktop UI");
    if (taskMode !== "free-chat" && taskMode !== "repo-file-edit" && composer.includes(marker)) failures.push("composer still contains the submitted prompt");
    if (taskMode === "free-chat") {
      if (composer.includes(promptText)) failures.push("composer still contains the submitted prompt");
      if (!answerSample.trim()) failures.push("assistant free-chat reply was not observed in the desktop UI");
      if (/Anti-Codex(?:\s+blocked|.{0,24}宸叉嫤鎴|.{0,24}已拦截)|blocked this completion|没有实际 tool call|娌℃湁瀹為檯 tool call/i.test(answerSample)) {
        failures.push("free-chat answer was replaced by a guard-blocked response");
      }
      const answerWithoutChrome = answerSample.replace(/\n+完全访问[\s\S]*$/u, "").trim();
      const hasSubstantiveFreeChatAnswer = /https?:\/\/|GPT|GBT|OpenAI|release|Release|ping/i.test(answerWithoutChrome)
        || (/(发布|模型|官方)/.test(answerWithoutChrome) && answerWithoutChrome.length > 80);
      if (!hasSubstantiveFreeChatAnswer && /正在思考|已处理|停止了|重新连接|处理中|正在运行/.test(answerWithoutChrome)) failures.push("free-chat answer only showed transient thinking/tool state");
      if (!/(发布|GPT|GBT|OpenAI|模型|没有|暂无|未知|预计|官方|ping|测试|退出|日志|文件|产物|冒烟|跑通|命令)/i.test(answerWithoutChrome)) failures.push("free-chat answer did not contain a final user-facing answer");
    }
    if (taskMode === "web-search" && answerSample) lastSample = answerSample;
    if (taskMode === "web-search") {
      if (!/Codex|codex|更新|发布|release|版本|OpenAI/i.test(lastSample)) failures.push("web-search answer did not mention Codex updates");
      if (!/[\u4e00-\u9fff]/.test(lastSample)) failures.push("web-search answer did not contain Chinese text");
      if (!/https?:\/\//i.test(lastSample)) failures.push("web-search answer did not include source URLs");
      if (/无法直接实时检索|未提供\s*`?web_search|缺少工具|Anti-Codex 已拦截/i.test(lastSample)) {
        failures.push("web-search answer still contained a missing-tool or blocked-response detour");
      }
    }
    if (taskMode === "repo-file-edit") {
      const responseHistoryMarkerSeen = responseHistoryContains(marker);
      artifactEvidence = verifyRepoFileEditFixture();
      if (!artifactEvidence?.files?.target) failures.push("repo-file-edit target file was not present");
      if (!artifactEvidence?.files?.test) failures.push("repo-file-edit test file was not present");
      if (!responseHistoryMarkerSeen) failures.push("repo-file-edit prompt marker was not observed in response history after desktop submit");
      if (artifactEvidence?.testPassed !== true) failures.push("repo-file-edit node:test did not pass after the desktop task");
    }
    if (taskMode === "repo-multi-file-edit") {
      artifactEvidence = verifyRepoMultiFileEditFixture();
      if (!artifactEvidence?.files?.source) failures.push("repo-multi-file-edit source file was not present");
      if (!artifactEvidence?.files?.test) failures.push("repo-multi-file-edit test file was not present");
      if (!artifactEvidence?.files?.data) failures.push("repo-multi-file-edit data file was not present");
      if (!artifactEvidence?.files?.readme) failures.push("repo-multi-file-edit README.md was not created");
      if (!artifactEvidence?.files?.html) failures.push("repo-multi-file-edit status-dashboard.html was not created");
      if (artifactEvidence?.files?.source && artifactEvidence.exportsNormalizeStatus !== true) failures.push("repo-multi-file-edit did not export normalizeStatus");
      if (artifactEvidence?.files?.source && artifactEvidence.exportsSummarizeRecords !== true) failures.push("repo-multi-file-edit did not export summarizeRecords");
      if (artifactEvidence?.files?.source && artifactEvidence.exportsRenderSummaryHtml !== true) failures.push("repo-multi-file-edit did not export renderSummaryHtml");
      if (artifactEvidence?.sourceChangedFromFixture !== true) failures.push("repo-multi-file-edit source was not changed from the failing fixture");
      if (artifactEvidence?.testUnchanged !== true) failures.push("repo-multi-file-edit modified the acceptance test");
      if (artifactEvidence?.dataUnchanged !== true) failures.push("repo-multi-file-edit modified the input data");
      if (artifactEvidence?.testPassed !== true) failures.push("repo-multi-file-edit node:test did not pass after the desktop task");
      if (artifactEvidence?.cliPassed !== true) failures.push("repo-multi-file-edit CLI output did not contain ok=2 needs-review=1 blocked=1");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlComplete !== true) failures.push("repo-multi-file-edit HTML is not a complete HTML document");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlHasChinese !== true) failures.push("repo-multi-file-edit HTML missing Chinese content");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlMentionsStatuses !== true) failures.push("repo-multi-file-edit HTML missing normalized status labels");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlAvoidsObjectObject !== true) failures.push("repo-multi-file-edit HTML leaked [object Object]");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlOffline !== true) failures.push("repo-multi-file-edit HTML used external assets or link/preconnect tags");
      if (artifactEvidence?.files?.readme && artifactEvidence.readmeHasChinese !== true) failures.push("repo-multi-file-edit README missing Chinese content");
      if (artifactEvidence?.files?.readme && artifactEvidence.readmeMentionsCommand !== true) failures.push("repo-multi-file-edit README missing CLI command");
    }
    if (taskMode === "local-project") {
      artifactEvidence = verifyLocalProjectArtifact(artifactDir, marker);
      if (!artifactEvidence?.files?.indexHtml) failures.push("local-project index.html was not created");
      if (!artifactEvidence?.files?.readmeMd) failures.push("local-project README.md was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("local-project done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("local-project done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.indexHasMarker !== true) failures.push("local-project index.html did not contain the marker");
      if (artifactEvidence?.files?.readmeMd && artifactEvidence.readmeNonEmpty !== true) failures.push("local-project README.md was empty");
    }
    if (taskMode === "coding-project") {
      artifactEvidence = verifyCodingProjectArtifact(artifactDir, marker);
      if (!artifactEvidence?.files?.packageJson) failures.push("coding-project package.json was not created");
      if (!artifactEvidence?.files?.wordTally) failures.push("coding-project word-tally.mjs was not created");
      if (!artifactEvidence?.files?.testFile) failures.push("coding-project word-tally.test.mjs was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("coding-project done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("coding-project done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.exportsFunction !== true) failures.push("coding-project did not export tallyWords");
      if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) failures.push("coding-project node:test did not pass");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.cliPassed !== true) failures.push("coding-project CLI output did not contain red=2 and blue=1");
    }
    if (taskMode === "complex-project") {
      artifactEvidence = verifyComplexProjectArtifact(artifactDir, marker);
      if (!artifactEvidence?.files?.packageJson) failures.push("complex-project package.json was not created");
      if (!artifactEvidence?.files?.analyzer) failures.push("complex-project codex-update-analyzer.mjs was not created");
      if (!artifactEvidence?.files?.testFile) failures.push("complex-project codex-update-analyzer.test.mjs was not created");
      if (!artifactEvidence?.files?.sourcesJson) failures.push("complex-project sources.json was not created");
      if (!artifactEvidence?.files?.reportMd) failures.push("complex-project report.md was not created");
      if (!artifactEvidence?.files?.indexHtml) failures.push("complex-project index.html was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("complex-project done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("complex-project done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.analyzer && artifactEvidence.exportsFunction !== true) failures.push("complex-project analyzer did not export summarizeSources");
      if (artifactEvidence?.files?.sourcesJson && artifactEvidence.sourceUrlCount < 3) failures.push("complex-project sources.json had fewer than three source URLs");
      if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) failures.push("complex-project node:test did not pass");
      if (artifactEvidence?.files?.analyzer && artifactEvidence.cliPassed !== true) failures.push("complex-project CLI output did not prove sourceCount>=3 and codexMentionCount>=1");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) failures.push("complex-project report.md missing marker");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) failures.push("complex-project index.html missing marker");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) failures.push("complex-project report.md missing Chinese content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) failures.push("complex-project index.html missing Chinese content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) failures.push("complex-project report.md missing Codex/OpenAI content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) failures.push("complex-project index.html missing Codex/OpenAI content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) failures.push("complex-project report.md has fewer than three source URLs");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) failures.push("complex-project index.html has fewer than three source URLs");
      if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedUrlCount < 1) failures.push("complex-project report.md and index.html did not share a source URL");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) failures.push("complex-project index.html is not a complete HTML document");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) failures.push("complex-project index.html does not link to report.md");
    }
    if (taskMode === "report-site") {
      artifactEvidence = verifyReportSiteArtifact(artifactDir, marker);
      if (!artifactEvidence?.files?.reportMd) failures.push("report-site report.md was not created");
      if (!artifactEvidence?.files?.indexHtml) failures.push("report-site index.html was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("report-site done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("report-site done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) failures.push("report-site report.md missing marker");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) failures.push("report-site index.html missing marker");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) failures.push("report-site report.md missing Chinese content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) failures.push("report-site index.html missing Chinese content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) failures.push("report-site report.md missing Codex/OpenAI content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) failures.push("report-site index.html missing Codex/OpenAI content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) failures.push("report-site report.md has fewer than three source URLs");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) failures.push("report-site index.html has fewer than three source URLs");
      if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedUrlCount < 1) failures.push("report-site report.md and index.html did not share a source URL");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) failures.push("report-site index.html is not a complete HTML document");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) failures.push("report-site index.html does not link to report.md");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  let repairPrompt = null;
  let repairTurn = null;
  let preRepairFailures = [];
  let preRepairArtifactEvidence = null;
  let finalArtifactFailures = [];
  if (taskMode === "report-site") {
    const artifactFailures = collectReportSiteArtifactFailures(artifactEvidence);
    if (failuresAreOnlyArtifactFailures(failures, artifactFailures)) {
      preRepairFailures = failures.slice();
      preRepairArtifactEvidence = artifactEvidence;
      repairPrompt = buildReportSiteRepairPrompt(artifactFailures, artifactEvidence);
      repairTurn = await submitDesktopPromptAndWait(ws, repairPrompt, marker, timeoutMs, { requiresProjectChat });
      artifactEvidence = verifyReportSiteArtifact(artifactDir, marker);
      finalArtifactFailures = collectReportSiteArtifactFailures(artifactEvidence);
    }
  }
  if (taskMode === "complex-project") {
    const artifactFailures = collectComplexProjectArtifactFailures(artifactEvidence);
    if (failuresAreOnlyArtifactFailures(failures, artifactFailures)) {
      preRepairFailures = failures.slice();
      preRepairArtifactEvidence = artifactEvidence;
      repairPrompt = buildComplexProjectRepairPrompt(artifactFailures, artifactEvidence);
      repairTurn = await submitDesktopPromptAndWait(ws, repairPrompt, marker, timeoutMs, { requiresProjectChat });
      artifactEvidence = verifyComplexProjectArtifact(artifactDir, marker);
      finalArtifactFailures = collectComplexProjectArtifactFailures(artifactEvidence);
    }
  }
  if (repairTurn) {
    const repairFailurePrefix = taskMode === "report-site" ? "report-site repair-step" : "complex-project repair-step";
    failures.length = 0;
    failures.push(...repairTurn.failures.map((failure) => `${repairFailurePrefix}: ${failure}`));
    failures.push(...finalArtifactFailures);
    clicked = clicked === true && repairTurn.clicked === true;
    submitEvidence = repairTurn.submitEvidence;
    submitSucceeded = submitSucceeded === true && repairTurn.submitSucceeded === true;
    count = Number(count || 0) + Number(repairTurn.markerCount || 0);
    answerMarkerCount = Number(repairTurn.answerMarkerCount || 0);
    composer = repairTurn.composer || "";
    lastSample = repairTurn.lastSample || lastSample;
    answerSample = repairTurn.answerSample || answerSample;
    activeReconnectSeen = activeReconnectSeen === true || repairTurn.activeReconnectSeen === true;
    activeReconnectEvidence.push(...(repairTurn.activeReconnectEvidence || []));
    inLoopIdleDiagnostics = repairTurn.inLoopIdleDiagnostics || inLoopIdleDiagnostics;
  }

  const idleTimeoutMs = taskMode === "local-project" || taskMode === "coding-project" || taskMode === "multi-turn-project" || taskMode === "complex-project" || taskMode === "report-site" || taskMode === "repo-file-edit" || taskMode === "repo-multi-file-edit" ? 60_000 : 20_000;
  const idleResult = inLoopIdleDiagnostics
    ? { diagnostics: inLoopIdleDiagnostics, lastError: null }
    : await waitForIdleDiagnostics(baseUrl, idleTimeoutMs);
  diagnostics = idleResult.diagnostics;
  if (!diagnostics) {
    failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
  } else if (!diagnosticsAreIdle(diagnostics)) {
    failures.push("desktop task did not become idle after the assistant reply");
  }
  const sessionLock = diagnostics?.antigravitySessionLock || null;
  const activeRequests = diagnostics?.activeAntigravityRequests || null;
  const queue = diagnostics?.antigravityQueue || null;
  if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
  if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
  if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
  if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
  modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
  const payload = {
    ok: failures.length === 0,
    reportName,
    requestedRealTraffic: true,
    usedRealTraffic: true,
    behaviorCovered: true,
    coverageKind: "desktop-ui-real-traffic",
    taskMode,
    promptText,
    promptLanguage,
    followupPromptText,
    followupPromptLanguage,
    repairPrompt,
    elapsedMs: Date.now() - startedAt,
    failures,
    marker,
    artifactDir: taskMode === "repo-file-edit"
      ? repoFileEditDir
      : taskMode === "repo-multi-file-edit"
        ? repoMultiFileEditDir
      : taskMode === "local-project" || taskMode === "coding-project" || taskMode === "multi-turn-project" || taskMode === "complex-project" || taskMode === "report-site" ? artifactDir : null,
    artifactEvidence,
    preRepairFailures,
    preRepairArtifactEvidence,
    repairAttempted: Boolean(repairPrompt),
    repairTurn: repairTurn ? {
      ok: repairTurn.ok,
      marker: repairTurn.marker,
      clicked: repairTurn.clicked,
      submitSucceeded: repairTurn.submitSucceeded,
      answerMarkerCount: repairTurn.answerMarkerCount,
      artifactCompletionObserved: repairTurn.artifactCompletionObserved,
      composerCleared: repairTurn.composerCleared,
      activeReconnectSeen: repairTurn.activeReconnectSeen,
      inLoopIdleObserved: repairTurn.inLoopIdleObserved,
      failures: repairTurn.failures,
      timing: repairTurn.timing || null,
    } : null,
    cdpPort,
    baseUrl,
    target: target ? { id: target.id, title: target.title, url: target.url } : null,
    prep,
    submitEvidence,
    submitSucceeded,
    staleRecovery,
    backendResetBeforeSubmit,
    newChatEvidence,
    initialIdleObserved: Boolean(initialIdle?.diagnostics),
    clicked,
    markerCount: count,
    answerMarkerCount,
    responseHistoryMarkerSeen: responseHistoryContains(marker),
    responseHistoryPath,
    activeReconnectSeen,
    activeReconnectEvidence,
    inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
    composerCleared: !composer.includes(marker),
    sessionLockClear: sessionLock ? sessionLock.active !== true && Number(sessionLock.queued || 0) === 0 : false,
    lastSample,
    antigravitySessionLock: sessionLock,
    activeAntigravityRequests: activeRequests,
    antigravityQueue: queue,
    modelRouteEvidence,
    responsesWebSocket: diagnostics?.responsesWebSocket || null,
    networkEvents: ws ? summarizeNetworkEvents(ws.events || []) : [],
    timing: {
      submitCompletedAt: submitCompletedAt ? new Date(submitCompletedAt).toISOString() : null,
      firstReplySeenAt: firstReplySeenAt ? new Date(firstReplySeenAt).toISOString() : null,
      idleCompletedAt: idleCompletedAt ? new Date(idleCompletedAt).toISOString() : null,
      submitMs: submitCompletedAt ? submitCompletedAt - (startedAt) : null,
      firstReplyMs: firstReplySeenAt && submitCompletedAt ? firstReplySeenAt - submitCompletedAt : null,
      idleWaitMs: idleCompletedAt && firstReplySeenAt ? idleCompletedAt - firstReplySeenAt : null,
    },
  };
  releaseUiLock?.();
  releaseUiLock = null;
  writeReport(payload);
  releaseUiLock?.();
  console.log(JSON.stringify(payload));
  if (!payload.ok) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  const payload = {
    ok: false,
    reportName,
    usedRealTraffic: true,
    behaviorCovered: true,
    coverageKind: "desktop-ui-real-traffic",
    taskMode,
    promptText,
    promptLanguage,
    followupPromptText,
    followupPromptLanguage,
    elapsedMs: Date.now() - startedAt,
    failures: [error instanceof Error ? error.message : String(error)],
    marker,
    artifactDir: taskMode === "repo-file-edit"
      ? repoFileEditDir
      : taskMode === "repo-multi-file-edit"
        ? repoMultiFileEditDir
      : taskMode === "local-project" || taskMode === "coding-project" || taskMode === "multi-turn-project" || taskMode === "complex-project" || taskMode === "report-site" ? artifactDir : null,
    timing: null,
  };
  writeReport(payload);
  console.log(JSON.stringify(payload));
  process.exit(1);
});
