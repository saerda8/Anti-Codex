#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditCodexPlusPlusLogSegment,
  detectNativeCompactionEvidence,
} from "./lib/anticodex-gate8-evidence.mjs";
import { markerScopedHistoryEntries } from "./lib/native-codex-rollout-history.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-native-compaction-resume.mjs [options]

Options:
  --allow-real-traffic       Run native Codex compaction and one resumed turn.
  --thread-id <id>           Existing Anti-Codex thread id.
  --rollout-file <path>      Existing thread rollout JSONL file.
  --title-contains <text>    Visible task title used to select the task before compacting.
  --expected-marker <text>   Marker that must be visible in the selected historical task.
  --artifact-dir <path>      Existing long-project directory.
  --model <id>               Antigravity model.
  --timeout-ms <ms>          Compaction/follow-up timeout (default: 300000).
  --min-long-context-bytes <n> Minimum observed request body before /compact (default: 65536).
  --cpp-log-offset <bytes>   Log offset before the long journey.
  --existing-compaction-offset <bytes> Reuse compaction already written after this rollout offset.
  --report-root <path>       Anti-Codex report directory.`);
    process.exit(0);
  }
  if (!key.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "..");
const stateRoot = resolve(process.env.ANTICODEX_STATE_ROOT || join(process.env.APPDATA || os.tmpdir(), "anticodex"));
const reportRoot = resolve(args.get("--report-root") || join(stateRoot, "reports"));
const cppLogPath = resolve(stateRoot, "codexplusplus", "codex-plus.log");
const uiSmokeScript = resolve(scriptRoot, "test-anticodex-ui-chat-smoke.mjs");
const threadId = String(args.get("--thread-id") || "").trim();
const rolloutFile = resolve(String(args.get("--rollout-file") || ""));
const titleContains = String(args.get("--title-contains") || "").trim();
const expectedMarker = String(args.get("--expected-marker") || "").trim();
const artifactDir = resolve(String(args.get("--artifact-dir") || ""));
const model = String(args.get("--model") || "gemini-3.5-flash-low").trim();
const timeoutMs = Math.max(60_000, Number(args.get("--timeout-ms") || 300_000));
const minLongContextBytes = Math.max(65_536, Number(args.get("--min-long-context-bytes") || 65_536));
const cppLogOffset = Math.max(0, Number(args.get("--cpp-log-offset") || 0));
const existingCompactionOffsetValue = args.get("--existing-compaction-offset");
const existingCompactionOffset = existingCompactionOffsetValue === undefined
  ? null
  : Number(existingCompactionOffsetValue);
const allowRealTraffic = args.has("--allow-real-traffic");
const startedAt = Date.now();
const runId = Date.now();

if (!allowRealTraffic) {
  console.log(JSON.stringify({
    ok: true,
    reportName: "compaction-resume",
    requestedRealTraffic: false,
    usedRealTraffic: false,
    skipped: true,
    requiresExplicitUserApproval: true,
    approvalReason: "real_traffic_required",
  }));
  process.exit(0);
}

if (!threadId) throw new Error("--thread-id is required");
if (!existsSync(rolloutFile)) throw new Error(`rollout file is missing: ${rolloutFile}`);
if (!titleContains) throw new Error("--title-contains is required for real native compaction");
if (!expectedMarker) throw new Error("--expected-marker is required to prove the selected historical task");
if (!existsSync(artifactDir)) throw new Error(`artifact directory is missing: ${artifactDir}`);
if (existingCompactionOffset !== null
  && (!Number.isInteger(existingCompactionOffset) || existingCompactionOffset < 0)) {
  throw new Error("--existing-compaction-offset must be a non-negative integer");
}
if (existingCompactionOffset !== null && existingCompactionOffset > statSync(rolloutFile).size) {
  throw new Error("--existing-compaction-offset is beyond the current rollout size");
}

function parseLastJson(text = "") {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compactText(value, max = 1400) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const latest = resolve(reportRoot, "latest-compaction-resume.json");
  const history = resolve(reportRoot, `${stamp}-compaction-resume.json`);
  const body = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const path of [latest, history]) {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, body, "utf8");
    renameSync(temporary, path);
    writeFileSync(`${path}.sha256`, `sha256:${sha256(body)}\n`, "ascii");
  }
  return { ...payload, report: { latest, history } };
}

function readRecordsSince(path, offset) {
  const body = readFileSync(path);
  const effectiveOffset = body.length >= offset ? offset : 0;
  return body.subarray(effectiveOffset).toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function cppLogAuditSince(offset) {
  if (!existsSync(cppLogPath)) return auditCodexPlusPlusLogSegment("");
  const body = readFileSync(cppLogPath);
  const effectiveOffset = body.length >= offset ? offset : 0;
  return auditCodexPlusPlusLogSegment(body.subarray(effectiveOffset).toString("utf8"));
}

function maxContextRequestBytes(offset) {
  if (!existsSync(cppLogPath)) return 0;
  const body = readFileSync(cppLogPath);
  const effectiveOffset = body.length >= offset ? offset : 0;
  let maximum = 0;
  for (const line of body.subarray(effectiveOffset).toString("utf8").split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      if (record?.event === "helper.request"
        && record?.detail?.method === "POST"
        && record?.detail?.path === "/v1/responses") {
        maximum = Math.max(maximum, Number(record?.detail?.body_bytes || 0));
      }
    } catch {}
  }
  return maximum;
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("CDP websocket open timed out")), 10_000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); rejectOpen(new Error("CDP websocket failed")); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

async function cdpTarget() {
  const response = await fetch("http://127.0.0.1:18318/json", { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Anti-Codex CDP target list returned HTTP ${response.status}`);
  const targets = await response.json();
  const target = targets.find((entry) => String(entry?.url || "").startsWith("app://")) || targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex app CDP target is missing");
  return target;
}

async function waitForIdleComposer(cdp, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror');
        const buttons = Array.from(document.querySelectorAll('button'));
        const active = buttons.some((button) => /stop|cancel|停止|取消/i.test([button.innerText, button.textContent, button.getAttribute('aria-label'), button.title].filter(Boolean).join(' ')));
        const body = String(document.body?.innerText || '');
        return { exists: Boolean(composer), text: String(composer?.innerText || composer?.textContent || '').trim(), active, reconnect: /正在重新连接|reconnecting/i.test(body) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    last = result?.result?.value || null;
    if (last?.exists && !last.active && !last.reconnect) return { ok: true, ...last };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return { ok: false, ...last };
}

async function openTaskByTitle(cdp, needle) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const wanted = ${JSON.stringify(needle)};
      const visible = (el) => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; };
      const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"],[role="treeitem"],[tabindex]'))
        .filter(visible)
        .map((el) => ({el,text:String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()}))
        .filter((item) => item.text.includes(wanted));
      const selected = candidates.sort((a,b) => { const ar=a.el.getBoundingClientRect(); const br=b.el.getBoundingClientRect(); return ar.width*ar.height-br.width*br.height; })[0];
      if(!selected) return {found:false,wanted};
      const r=selected.el.getBoundingClientRect(); return {found:true,text:selected.text.slice(0,240),rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const evidence = result?.result?.value || null;
  if (evidence?.found !== true) throw new Error(`task title was not found before compacting: ${needle}`);
  const x = Number(evidence.rect.x) + Number(evidence.rect.w) / 2;
  const y = Number(evidence.rect.y) + Number(evidence.rect.h) / 2;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { ...evidence, actualMouseClick: true };
}

async function waitForTaskMarker(cdp, marker, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  let evidence = null;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const marker = ${JSON.stringify(marker)};
        const surfaceTexts = Array.from(document.querySelectorAll('main,[role="main"]')).map((el) => String(el.innerText || el.textContent || ''));
        const bodyText = String(document.body?.innerText || '');
        return { marker, surfaceSeen:surfaceTexts.some((text) => text.includes(marker)), bodySeen:bodyText.includes(marker), surfaceTails:surfaceTexts.map((text) => text.slice(-600)) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    evidence = result?.result?.value || null;
    if (evidence?.surfaceSeen === true) return { ok: true, ...evidence };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return { ok: false, ...evidence };
}

async function submitCompactCommand(cdp) {
  const focus = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const c=document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror'); if(!c)return false; c.focus(); return true; })()`,
    returnByValue: true,
  });
  if (focus?.result?.value !== true) throw new Error("visible task composer was missing before /compact");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp.send("Input.insertText", { text: "/compact" });

  const menuDeadline = Date.now() + 5_000;
  let menuState = null;
  while (Date.now() < menuDeadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (el) => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; };
        const composer = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror');
        const candidates = Array.from(document.querySelectorAll('button'))
          .filter(visible)
          .map((el) => { const r=el.getBoundingClientRect(); return { text:String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim(), rect:{x:r.x,y:r.y,w:r.width,h:r.height} }; })
          .filter((item) => /^(?:compact|压缩)(?:\\s|$)/i.test(item.text));
        return { composerText:String(composer?.innerText||composer?.textContent||'').trim(), candidates };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    menuState = result?.result?.value || null;
    if (menuState?.candidates?.length > 0) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  const selected = menuState?.candidates?.[0];
  if (!selected) {
    throw new Error(`native /compact command was not available in the selected historical task: ${compactText(JSON.stringify(menuState))}`);
  }

  const x = Number(selected.rect.x) + Number(selected.rect.w) / 2;
  const y = Number(selected.rect.y) + Number(selected.rect.h) / 2;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  const submitDeadline = Date.now() + 15_000;
  let submittedState = null;
  while (Date.now() < submitDeadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror');
        const text = String(composer?.innerText||composer?.textContent||'').trim();
        const active = Array.from(document.querySelectorAll('button')).some((button) => /stop|cancel|停止|取消/i.test([button.innerText,button.textContent,button.getAttribute('aria-label'),button.title].filter(Boolean).join(' ')));
        return { exists:Boolean(composer), text, active };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    submittedState = result?.result?.value || null;
    if (submittedState?.text !== "/compact") {
      return {
        composerBefore: menuState.composerText,
        menuCandidates: menuState.candidates,
        selected,
        actualMouseClick: true,
        composerAfter: submittedState,
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`native /compact menu click did not clear the composer: ${compactText(JSON.stringify(submittedState))}`);
}

async function waitForCompaction(path, offset, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let evidence = detectNativeCompactionEvidence([]);
  while (Date.now() < deadline) {
    evidence = detectNativeCompactionEvidence(readRecordsSince(path, offset));
    if (evidence.observed) return evidence;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  return evidence;
}

const failures = [];
const rolloutOffset = existingCompactionOffset ?? statSync(rolloutFile).size;
const compactLogOffset = existsSync(cppLogPath) ? statSync(cppLogPath).size : 0;
const longContextBytes = maxContextRequestBytes(cppLogOffset);
let cdp = null;
let titleEvidence = null;
let selectedTaskEvidence = null;
let idleBeforeCompaction = null;
let commandSubmitEvidence = null;
let compactionEvidence = existingCompactionOffset === null
  ? detectNativeCompactionEvidence([])
  : detectNativeCompactionEvidence(readRecordsSince(rolloutFile, existingCompactionOffset));
const reusedExistingCompaction = existingCompactionOffset !== null && compactionEvidence.observed;
let idleAfterCompaction = null;
let followup = null;
let followupMarker = "";

try {
  if (longContextBytes < minLongContextBytes) {
    throw new Error(`observed long-context request body ${longContextBytes} bytes is below required ${minLongContextBytes} bytes`);
  }
  const target = await cdpTarget();
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Input.setIgnoreInputEvents", { ignore: false });
  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.anticodex-close')?.click()", awaitPromise: true });
  titleEvidence = await openTaskByTitle(cdp, titleContains);
  selectedTaskEvidence = await waitForTaskMarker(cdp, expectedMarker);
  if (!selectedTaskEvidence.ok) {
    throw new Error(`selected historical task did not contain the expected marker ${expectedMarker}`);
  }
  idleBeforeCompaction = await waitForIdleComposer(cdp, 30_000);
  if (!idleBeforeCompaction.ok) throw new Error("visible task composer was not idle before /compact");
  if (existingCompactionOffset !== null && !compactionEvidence.observed) {
    throw new Error("existing compaction evidence was not found after the supplied rollout offset");
  }
  if (reusedExistingCompaction) {
    commandSubmitEvidence = {
      reusedExistingCompaction: true,
      existingCompactionOffset,
      actualMouseClick: false,
    };
    idleAfterCompaction = idleBeforeCompaction;
  } else {
    commandSubmitEvidence = await submitCompactCommand(cdp);
    compactionEvidence = await waitForCompaction(rolloutFile, rolloutOffset, timeoutMs);
    if (!compactionEvidence.observed) failures.push("native Codex contextCompaction item was not written to the same rollout");
    idleAfterCompaction = await waitForIdleComposer(cdp, timeoutMs);
  }
  if (!idleAfterCompaction.ok) failures.push("visible task did not return to idle after native compaction");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  cdp?.close();
}

if (compactionEvidence.observed && idleAfterCompaction?.ok === true) {
  followupMarker = `UI_GATE8_COMPACT_RESUME_${runId}`;
  const promptPath = resolve(reportRoot, `gate8-compact-followup-${runId}.txt`);
  mkdirSync(reportRoot, { recursive: true });
  writeFileSync(promptPath, [
    "原生 Codex 刚刚压缩了当前任务上下文。继续这个同一个任务，不要新建项目，也不要询问目录。",
    "禁止修改、创建或删除文件。只运行一次现有测试，并只读核对已有 summary.json 的六项指标仍为 5/2/2/1/3/1。",
    "命令前先用一句中文说明这是压缩后的同任务续跑验证，不要重复执行命令。",
    `确认测试和现有结果后，最后一行写 ${followupMarker}。`,
  ].join("\n"), "utf8");
  const child = spawnSync(process.execPath, [
    uiSmokeScript,
    "--task-mode", "exact-marker",
    "--same-chat",
    "--timeout-ms", String(timeoutMs),
    "--marker", followupMarker,
    "--prompt-file", promptPath,
    "--report-name", "ui-gate8-native-compaction-resume",
    "--model", model,
    "--artifact-dir", artifactDir,
    "--result-driven-completion",
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs + 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const payload = parseLastJson(child.stdout);
  const markerEntries = markerScopedHistoryEntries(followupMarker);
  const sameThread = markerEntries.some((entry) => entry?.id === `rollout:${threadId}` && resolve(entry.file || "") === rolloutFile);
  followup = {
    ok: child.status === 0 && payload?.ok === true && payload?.usedRealTraffic === true && sameThread,
    status: child.status,
    sameThread,
    threadId,
    marker: followupMarker,
    report: payload?.report || null,
    activeReconnectSeen: payload?.activeReconnectSeen === true,
    failures: payload?.failures || (child.stderr ? [compactText(child.stderr)] : []),
  };
  if (!followup.ok) failures.push(`post-compaction same-task follow-up failed: ${compactText(JSON.stringify(followup))}`);
}

const requestAudit = cppLogAuditSince(compactLogOffset);
const usedRealTraffic = requestAudit.upstreamRequestCount > 0;
const commandWasSubmitted = commandSubmitEvidence?.actualMouseClick === true;
if (commandWasSubmitted || reusedExistingCompaction) {
  if (!usedRealTraffic) failures.push("native compaction did not reach the fixed model route");
  if (requestAudit.allUpstreamChatCompletions !== true) failures.push("native compaction left the fixed Chat Completions route");
  if (requestAudit.staleConflictCount !== 0) failures.push(`native compaction logged ${requestAudit.staleConflictCount} stale conflict(s)`);
}
const payload = writeReport({
  ok: failures.length === 0,
  reportName: "compaction-resume",
  requestedRealTraffic: true,
  usedRealTraffic,
  blockedBeforeTraffic: !commandWasSubmitted && !reusedExistingCompaction,
  behaviorCovered: failures.length === 0,
  coverageKind: "native-codex-visible-thread-compaction-resume",
  failures,
  model,
  threadId,
  rolloutFile,
  titleContains,
  expectedMarker,
  titleEvidence,
  selectedTaskEvidence,
  idleBeforeCompaction,
  commandSubmitEvidence,
  reusedExistingCompaction,
  existingCompactionOffset,
  artifactDir,
  longContextChars: longContextBytes,
  longContextBytes,
  requiredLongContextBytes: minLongContextBytes,
  nativeCompactionObserved: compactionEvidence.observed === true,
  compactionItemCount: compactionEvidence.itemCount,
  compact_summary_length: compactionEvidence.summaryLength,
  compactionItemTypes: compactionEvidence.itemTypes,
  rolloutOffset,
  idleAfterCompaction,
  followup,
  followupMarker,
  requestAudit,
  cppLogOffset,
  elapsedMs: Date.now() - startedAt,
});

console.log(JSON.stringify(payload));
process.exit(payload.ok ? 0 : 1);
