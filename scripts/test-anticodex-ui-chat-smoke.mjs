#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) {
    const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1";
    args.set(key, value);
  }
}

let cdpPort = Number(args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT || 58318);
const baseUrl = String(args.get("--base-url") || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const timeoutMs = Math.max(15_000, Number(args.get("--timeout-ms") || 90_000));
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const taskMode = String(args.get("--task-mode") || "exact-marker");
const isolateChat = args.has("--same-chat") ? false : true;
const reportName = taskMode === "web-search"
  ? "ui-web-search-smoke"
  : taskMode === "free-chat"
    ? "ui-free-chat-smoke"
    : taskMode === "coding-project"
      ? "ui-coding-project-smoke"
    : taskMode === "report-site"
      ? "ui-report-site-smoke"
    : taskMode === "local-project"
      ? "ui-local-project-smoke"
      : "ui-chat-smoke";
const markerPrefix = taskMode === "web-search"
  ? "UI_WEB_SEARCH_SMOKE"
  : taskMode === "coding-project"
    ? "UI_CODING_PROJECT_SMOKE"
  : taskMode === "report-site"
    ? "UI_REPORT_SITE_SMOKE"
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
      : taskMode === "report-site"
        ? "desktop-visible-report-site"
        : "desktop-visible-small-project",
    marker.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
  );
let promptText = String(args.get("--prompt") || (taskMode === "web-search"
  ? `最近 Codex 都更新了什么？请上网搜索后用中文简要回答，最后单独写 ${marker}。`
  : taskMode === "local-project"
    ? `Create a very small local HTML report in ${artifactDir}. Create exactly these files: index.html, README.md, done.txt. index.html must be a simple offline page with one heading, one status paragraph, and the exact marker ${marker}. README.md must describe the files. done.txt must contain exactly ${marker}. Verify the files, then reply with ${marker}.`
    : `Reply with exactly ${marker} and nothing else.`));
if (!args.get("--prompt") && taskMode === "web-search") {
  promptText = `Search the web for recent Codex updates, answer briefly in Chinese with source URLs, and put ${marker} on its own final line.`;
}
if (!args.get("--prompt") && taskMode === "local-project") {
  promptText = `Create a very small local HTML report in ${artifactDir}. Use PowerShell file commands to create exactly these files: index.html, README.md, done.txt. Do not inspect Antigravity brain, transcript, history, or log folders. index.html must be a simple offline page with one heading, one status paragraph, and the exact marker ${marker}. README.md must describe the files. done.txt must contain exactly ${marker}. Verify the files exist and done.txt exactly matches the marker, then reply with ${marker}.`;
}
if (!args.get("--prompt") && taskMode === "coding-project") {
  promptText = `Create a tiny Node.js CLI project in ${artifactDir}. Use PowerShell file commands to create exactly these files: package.json, word-tally.mjs, word-tally.test.mjs, done.txt. Do not inspect Antigravity brain, transcript, history, or log folders. word-tally.mjs must export a tallyWords(text) function and when run as a CLI print JSON word counts. word-tally.test.mjs must use node:test and assert that "red blue red" returns red=2 and blue=1. done.txt must contain exactly ${marker}. Run node --test word-tally.test.mjs and node word-tally.mjs "red blue red", verify the outputs, then reply with ${marker}.`;
}
if (!args.get("--prompt") && taskMode === "report-site") {
  promptText = `Search the web for recent Codex updates, then create a small local research report site in ${artifactDir}. Use PowerShell file commands to create exactly these files: report.md, index.html, done.txt. Do not inspect Antigravity brain, transcript, history, or log folders. report.md must be Chinese, mention Codex or OpenAI, include at least three real source URLs, and include the exact marker ${marker}. index.html must be a complete standalone HTML document with Chinese visible content, at least three source URLs, a link to report.md, and the exact marker ${marker}. done.txt must contain exactly ${marker}. Verify the files exist and done.txt exactly matches the marker, then reply with ${marker}.`;
}
if (args.get("--prompt") && !args.get("--marker")) {
  const promptMarker = String(promptText).match(/\bUI_[A-Z0-9_]{8,}\b/g)?.at(-1);
  if (promptMarker) marker = promptMarker;
}
const startedAt = Date.now();
const uiLockDir = join(reportRoot, "ui-chat-smoke.lock");

async function acquireUiSmokeLock({ waitMs = 60_000, staleMs = 10 * 60_000 } = {}) {
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
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
  throw new Error(`another desktop UI smoke is still running; lock=${uiLockDir}; owner=${lastOwner || "unknown"}`);
}

function httpJson(url) {
  return new Promise((resolveJson, reject) => {
    const req = http.get(url, (res) => {
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

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.nextId = 1;
    this.callbacks = new Map();
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
      }
    }
  }
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

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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

async function waitForIdleDiagnostics(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      latest = await httpJson(`${url}/anticodex/diagnostics`);
      if (diagnosticsAreIdle(latest)) return { diagnostics: latest, lastError: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  return { diagnostics: latest, lastError };
}

function recoverStaleComposerExpression() {
  const safeMarkerPrefix = JSON.stringify(markerPrefix);
  return `(() => {
    const labels = new Set(['停止', 'Stop', '删除排队的消息', 'Delete queued message']);
    const clicked = [];
    const bodyText = document.body.innerText || '';
    const isTestResidue = bodyText.includes(${safeMarkerPrefix})
      || /desktop-visible-|ui_local_after_role_fix_|UI_(WEB_SEARCH|LOCAL_PROJECT|CODING_PROJECT|REPORT_SITE|CHAT)_SMOKE/i.test(bodyText);
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
    return {
      composer: composer?.innerText || '',
      composerMatches: (composer?.innerText || '').trim() === expected.trim(),
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

async function resolveCdpTargets() {
  const explicitPort = args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT;
  const candidates = explicitPort
    ? [Number(explicitPort)]
    : [58318, 58317];
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

async function main() {
  const failures = [];
  let target = null;
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
  let submitEvidence = null;
  let submitSucceeded = false;

  try {
    releaseUiLock = await acquireUiSmokeLock();
    process.once("exit", () => releaseUiLock?.());
    const targets = await resolveCdpTargets();
    target = targets.find((item) => String(item.url || "").startsWith("app://")) || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Runtime.enable");
    await ws.send("DOM.enable");
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
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
    }
    initialIdle = await waitForIdleDiagnostics(baseUrl, 45_000);
    if (!diagnosticsAreIdle(initialIdle.diagnostics)) {
      throw new Error(`desktop backend was not idle before submit after stale recovery: ${initialIdle.lastError || "busy"}`);
    }
    if (isolateChat) {
      await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
      await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
      await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
      await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
    const state = await ws.send("Runtime.evaluate", {
      expression: sendButtonProbeExpression(promptText),
      returnByValue: true,
    });
    prep = state.result?.result?.value || null;
    if (prep?.composerMatches !== true) {
      failures.push("composer did not contain exactly the submitted prompt before clicking send");
    } else if (prep?.hasSendButton !== true) {
      failures.push("send button was not found in the composer controls");
    } else {
      const click = await ws.send("Runtime.evaluate", {
        expression: sendButtonProbeExpression(promptText, { click: true }),
        returnByValue: true,
        awaitPromise: true,
      });
      submitEvidence = click.result?.result?.value || null;
      clicked = submitEvidence?.clicked === true;
      const submitDeadline = Date.now() + 4_000;
      while (Date.now() < submitDeadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
        const submitted = await ws.send("Runtime.evaluate", {
          expression: `(() => {
            const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
            return { composer: composer?.innerText || '' };
          })()`,
          returnByValue: true,
        });
        const submittedComposer = String(submitted.result?.result?.value?.composer || "");
        if (!submittedComposer.includes(promptText) && !submittedComposer.includes(marker)) {
          submitSucceeded = true;
          break;
        }
      }
      if (!submitSucceeded) failures.push("send click did not submit the composer prompt");
    }
    if (clicked) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
      const stateAfter = await ws.send("Runtime.evaluate", {
        expression: `(() => {
          const text = document.body.innerText;
          const composer = document.querySelector('.ProseMirror');
          return { text, composer: composer?.innerText || '' };
        })()`,
        returnByValue: true,
      });
      const value = stateAfter.result?.result?.value || {};
      const text = String(value.text || "");
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
      if (taskMode === "free-chat") {
        const normalizedAnswer = answerSample.replace(/完全访问|输出|暂无产物|来源|暂无来源|Gemini[^\n]*/g, "").trim();
        if (!composer.includes(promptText) && /[\u4e00-\u9fff]/.test(normalizedAnswer) && !/正在思考|已处理|停止了|重新连接/.test(normalizedAnswer)) break;
      } else if (answerMarkerCount >= 1 && !composer.includes(marker)) {
        try {
          const loopDiagnostics = await httpJson(`${baseUrl}/anticodex/diagnostics`);
          if (diagnosticsAreIdle(loopDiagnostics)) {
            inLoopIdleDiagnostics = loopDiagnostics;
            break;
          }
        } catch {}
      }
    }
    }
    if (!clicked) failures.push("send button was not clicked");
    if (activeReconnectSeen) failures.push("active reconnect text appeared after the submitted prompt");
    if (taskMode !== "free-chat" && answerMarkerCount < 1) failures.push("assistant reply marker was not observed after the submitted prompt in the desktop UI");
    if (taskMode !== "free-chat" && composer.includes(marker)) failures.push("composer still contains the submitted prompt");
    if (taskMode === "free-chat") {
      if (composer.includes(promptText)) failures.push("composer still contains the submitted prompt");
      if (!answerSample.trim()) failures.push("assistant free-chat reply was not observed in the desktop UI");
      const hasSubstantiveFreeChatAnswer = /https?:\/\/|GPT|GBT|OpenAI|release|Release/i.test(answerSample)
        || (/(发布|模型|官方)/.test(answerSample) && answerSample.length > 80);
      if (!hasSubstantiveFreeChatAnswer && /正在思考|已处理|停止了|重新连接|处理中|正在运行|暂无产物|暂无来源/.test(answerSample)) failures.push("free-chat answer only showed transient thinking/tool state");
      if (!/(发布|GPT|GBT|OpenAI|模型|没有|暂无|未知|预计|官方)/.test(answerSample)) failures.push("free-chat answer did not contain a final user-facing answer");
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

  const idleTimeoutMs = taskMode === "local-project" || taskMode === "coding-project" || taskMode === "report-site" ? 60_000 : 20_000;
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
  const payload = {
    ok: failures.length === 0,
    reportName,
    requestedRealTraffic: true,
    usedRealTraffic: true,
    behaviorCovered: true,
    coverageKind: "desktop-ui-real-traffic",
    taskMode,
    promptText,
    elapsedMs: Date.now() - startedAt,
    failures,
    marker,
    artifactDir: taskMode === "local-project" || taskMode === "coding-project" || taskMode === "report-site" ? artifactDir : null,
    artifactEvidence,
    cdpPort,
    baseUrl,
    target: target ? { id: target.id, title: target.title, url: target.url } : null,
    prep,
    submitEvidence,
    submitSucceeded,
    staleRecovery,
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
    responsesWebSocket: diagnostics?.responsesWebSocket || null,
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
    elapsedMs: Date.now() - startedAt,
    failures: [error instanceof Error ? error.message : String(error)],
    marker,
    artifactDir: taskMode === "local-project" || taskMode === "coding-project" || taskMode === "report-site" ? artifactDir : null,
  };
  writeReport(payload);
  console.log(JSON.stringify(payload));
  process.exit(1);
});
