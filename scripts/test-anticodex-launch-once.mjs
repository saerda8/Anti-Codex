#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markerScopedHistoryEntries } from "./lib/native-codex-rollout-history.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-launch-once.mjs [options]

Options:
  --allow-real-traffic  Run the real Anti-Codex desktop task (default: dry-run)
  --model <id>          Required Antigravity model (default: gemini-3.5-flash-low)
  --timeout-ms <ms>     Desktop task timeout (default: 240000)
  --report-root <path>  Report directory
  --keep-artifacts      Keep the successful temporary fixture
  --help, -h            Show help`);
    process.exit(0);
  }
  if (!key.startsWith("--")) continue;
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1";
  args.set(key, value);
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "..");
const uiSmokeScript = resolve(scriptRoot, "test-anticodex-ui-chat-smoke.mjs");
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const responseHistoryPath = resolve(process.env.APPDATA || os.tmpdir(), "anticodex", "response-history.json");
const allowRealTraffic = args.has("--allow-real-traffic");
const keepArtifacts = args.has("--keep-artifacts");
const model = String(args.get("--model") || "gemini-3.5-flash-low").trim();
const timeoutMs = Math.max(30_000, Number(args.get("--timeout-ms") || 240_000));
const marker = `UI_LAUNCH_ONCE_${Date.now()}`;

function compactText(value, max = 1600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  return null;
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-ui-launch-once-smoke.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-ui-launch-once-smoke.json`);
  const finalPayload = { ...payload, report: { latest, history } };
  const json = `${JSON.stringify(finalPayload, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `${createHash("sha256").update(json).digest("hex")}\n`, "ascii");
  }
  return finalPayload;
}

function responseItemText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content?.text || content?.output_text || content?.input_text || "");
  return content.map((part) => String(part?.text || part?.output_text || part?.input_text || "")).join("\n");
}

function commandLooksLikeLaunchSideEffect(command = "") {
  const value = String(command || "");
  return /(?:^|[;{}()\r\n|&]\s*|=\s*)Start-Process\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*|=\s*)Invoke-Item\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)(?:cmd(?:\.exe)?\s+\/[dc]\s+)?start(?:\.exe)?\s+/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)explorer(?:\.exe)?\s+/i.test(value);
}

function markerHistoryEvidence(expectedMarker) {
  const entries = markerScopedHistoryEntries(expectedMarker, { responseHistoryPath });
  const orderedItems = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const item of [...(entry.inputItems || []), ...(entry.contextItems || [])]) {
      if (!item || typeof item !== "object") continue;
      const key = item.id
        || (item.call_id ? `${item.type || "item"}:${item.call_id}` : `${item.type || "item"}:${JSON.stringify(item)}`);
      if (seen.has(key)) continue;
      seen.add(key);
      orderedItems.push(item);
    }
  }

  const firstToolIndex = orderedItems.findIndex((item) => /(?:function|custom)_call$/.test(String(item.type || "")));
  const assistantItems = orderedItems.filter((item) => item.type === "message" && item.role === "assistant");
  const assistantTexts = assistantItems.map((item) => responseItemText(item.content));
  const preCommandTexts = orderedItems
    .slice(0, firstToolIndex >= 0 ? firstToolIndex : orderedItems.length)
    .filter((item) => item.type === "message" && item.role === "assistant")
    .map((item) => responseItemText(item.content));
  const shellCommands = [];
  for (const item of orderedItems) {
    if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
    if (!/^(?:shell_command|exec_command)$/i.test(String(item.name || ""))) continue;
    let parsed = null;
    try {
      parsed = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
    } catch {}
    const command = String(parsed?.command || parsed?.cmd || item.input || "").trim();
    if (command) shellCommands.push(command);
  }
  const uniqueShellCommands = [...new Set(shellCommands)];
  const launchCommands = shellCommands.filter(commandLooksLikeLaunchSideEffect);
  const startProcessOccurrences = launchCommands.reduce(
    (total, command) => total + (command.match(/\bStart-Process\b/gi)?.length || 0),
    0,
  );
  const toolOutputs = orderedItems
    .filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output")
    .map((item) => String(item.output || item.content || ""));
  const combinedEvidenceText = [...assistantTexts, ...toolOutputs].join("\n");
  return {
    entryCount: entries.length,
    assistantTexts,
    shellCallCount: shellCommands.length,
    uniqueShellCallCount: uniqueShellCommands.length,
    duplicateShellCommandCount: shellCommands.length - uniqueShellCommands.length,
    launchCommandCount: launchCommands.length,
    startProcessOccurrences,
    toolOutputSeen: toolOutputs.length > 0,
    markerToolOutputSeen: toolOutputs.some((output) => output.includes(expectedMarker)),
    assistantFinalMarkerSeen: assistantTexts.some((text) => text.trim().endsWith(expectedMarker)),
    chinesePreCommandSeen: preCommandTexts.some((text) => /[\u3400-\u9fff]/.test(text) && /(?:创建|启动|检查|验证)/.test(text)),
    parseErrorSeen: /(?:parse error|invalid xml|xml parse|malformed tool)/i.test(combinedEvidenceText),
    commandHashes: uniqueShellCommands.map((command) => createHash("sha256").update(command).digest("hex")),
  };
}

if (!allowRealTraffic) {
  console.log(JSON.stringify({
    ok: true,
    reportName: "ui-launch-once-smoke",
    requestedRealTraffic: false,
    usedRealTraffic: false,
    skipped: true,
    requiresExplicitUserApproval: true,
    approvalReason: "real_traffic_required",
    commandPreview: `node scripts/test-anticodex-launch-once.mjs --allow-real-traffic --model ${model}`,
  }));
  process.exit(0);
}

const startedAt = Date.now();
const fixtureDir = resolve(os.tmpdir(), `anticodex-launch-once-${Date.now()}-${process.pid}`);
const targetPath = join(fixtureDir, "launch-target.ps1");
const promptPath = join(fixtureDir, "prompt.txt");
const startBatchPath = join(fixtureDir, "start.bat");
const countPath = join(fixtureDir, "launch-count.txt");
const proofPath = join(fixtureDir, "launch-proof.txt");
mkdirSync(fixtureDir, { recursive: true });

const targetScript = [
  "$ErrorActionPreference = 'Stop'",
  "$counterPath = Join-Path $PSScriptRoot 'launch-count.txt'",
  "$count = 0",
  "if (Test-Path -LiteralPath $counterPath) {",
  "  $raw = [System.IO.File]::ReadAllText($counterPath, [System.Text.Encoding]::UTF8).Trim()",
  "  if ($raw -match '^\\d+$') { $count = [int]$raw }",
  "}",
  "$count += 1",
  "[System.IO.File]::WriteAllText($counterPath, [string]$count, [System.Text.UTF8Encoding]::new($false))",
  `[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'launch-proof.txt'), '${marker}', [System.Text.UTF8Encoding]::new($false))`,
  "",
].join("\r\n");
writeFileSync(targetPath, targetScript, "utf8");

const prompt = [
  `请完成一个非常简单但必须真实执行的桌面任务。工作目录是 ${fixtureDir}，里面已有 launch-target.ps1。`,
  "",
  "1. 先用一句简短中文说明：你将创建启动入口、只启动一次、随后检查结果。",
  "2. 在该目录新建 start.bat，让它用 powershell -NoProfile -ExecutionPolicy Bypass -File launch-target.ps1 启动已有脚本。",
  "3. 创建后必须使用 shell_command，并用 Start-Process 启动 start.bat。启动动作只允许执行一次。",
  "4. 第一次启动命令即使输出为空，只要 exit code 是 0，也视为已经执行，绝对不能再次 Start-Process。",
  "5. 随后用只读命令等待并读取 launch-count.txt 与 launch-proof.txt。launch-count.txt 必须严格等于 1，launch-proof.txt 必须严格等于最终标记。",
  "6. 如果验证失败，只能检查脚本、进程或错误，不能重复启动。",
  `验证成功后最后一行只回复 ${marker}。`,
  "",
].join("\n");
writeFileSync(promptPath, prompt, "utf8");

const childArgs = [
  uiSmokeScript,
  "--task-mode", "exact-marker",
  "--timeout-ms", String(timeoutMs),
  "--marker", marker,
  "--prompt-file", promptPath,
  "--required-file", startBatchPath,
  "--required-file-contains", "launch-target.ps1",
  "--model", model,
];
const child = spawnSync(process.execPath, childArgs, {
  cwd: sourceRoot,
  encoding: "utf8",
  timeout: timeoutMs + 120_000,
  windowsHide: true,
});
const childPayload = parseJsonOutput(child.stdout);

const fileNames = readdirSync(fixtureDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
const expectedFileNames = ["launch-count.txt", "launch-proof.txt", "launch-target.ps1", "prompt.txt", "start.bat"].sort();
const countText = existsSync(countPath) ? readFileSync(countPath, "utf8").trim() : "";
const proofText = existsSync(proofPath) ? readFileSync(proofPath, "utf8").trim() : "";
const startBatchText = existsSync(startBatchPath) ? readFileSync(startBatchPath, "utf8") : "";
const historyEvidence = markerHistoryEvidence(marker);
const unexpectedGenericArtifacts = ["index.html", "README.md", "done.txt"].filter((name) => existsSync(join(fixtureDir, name)));
const failures = [];
if (child.error?.code === "ETIMEDOUT") failures.push("desktop launch-once task timed out");
if (child.status !== 0) failures.push(`desktop launch-once child exited ${child.status ?? "unknown"}: ${compactText(child.stderr || child.stdout)}`);
if (childPayload?.ok !== true) failures.push(`desktop launch-once UI verifier failed: ${compactText((childPayload?.failures || []).join("; ")) || "missing child report"}`);
if (childPayload?.usedRealTraffic !== true) failures.push("desktop launch-once task did not use real model traffic");
if (!existsSync(startBatchPath) || !/launch-target\.ps1/i.test(startBatchText)) failures.push("start.bat was not created with launch-target.ps1");
if (countText !== "1") failures.push(`launch-count.txt expected 1, received ${JSON.stringify(countText)}`);
if (proofText !== marker) failures.push("launch-proof.txt did not exactly match the marker");
if (JSON.stringify(fileNames) !== JSON.stringify(expectedFileNames)) failures.push(`fixture files were not exact: ${fileNames.join(", ")}`);
if (unexpectedGenericArtifacts.length > 0) failures.push(`generic artifacts leaked into launch task: ${unexpectedGenericArtifacts.join(", ")}`);
if (historyEvidence.startProcessOccurrences !== 1) failures.push(`expected exactly one Start-Process occurrence, received ${historyEvidence.startProcessOccurrences}`);
if (historyEvidence.duplicateShellCommandCount !== 0) failures.push("the desktop task repeated an identical shell command");
if (historyEvidence.toolOutputSeen !== true || historyEvidence.markerToolOutputSeen !== true) failures.push("marker-scoped tool output was not observed");
if (historyEvidence.chinesePreCommandSeen !== true) failures.push("Chinese pre-command launch explanation was not observed");
if (historyEvidence.assistantFinalMarkerSeen !== true) failures.push("assistant final marker was not observed");
if (historyEvidence.parseErrorSeen === true) failures.push("a tool or XML parse error appeared in the completed task");

const ok = failures.length === 0;
let cleanup = { removed: false, kept: true, reason: ok ? "keep_artifacts" : "failure_evidence" };
if (ok && !keepArtifacts) {
  rmSync(fixtureDir, { recursive: true, force: true });
  cleanup = { removed: true, kept: false, reason: "successful_fixture_cleanup" };
}

const payload = writeReport({
  ok,
  reportName: "ui-launch-once-smoke",
  requestedRealTraffic: true,
  usedRealTraffic: childPayload?.usedRealTraffic === true,
  behaviorCovered: true,
  coverageKind: "desktop-ui-real-launch-once",
  marker,
  model,
  elapsedMs: Date.now() - startedAt,
  failures,
  fixtureDir,
  cleanup,
  child: {
    status: child.status,
    signal: child.signal,
    timedOut: child.error?.code === "ETIMEDOUT",
    reportName: childPayload?.reportName || "",
    report: childPayload?.report || null,
    submitSucceeded: childPayload?.submitSucceeded === true,
    modelRouteObserved: childPayload?.modelRouteObserved === true,
    modelRequestPayloadObserved: childPayload?.modelRequestPayloadObserved === true,
    failures: childPayload?.failures || [],
  },
  artifacts: {
    fileNames,
    expectedFileNames,
    exactFileSet: JSON.stringify(fileNames) === JSON.stringify(expectedFileNames),
    countText,
    proofMatches: proofText === marker,
    startBatchReferencesTarget: /launch-target\.ps1/i.test(startBatchText),
    unexpectedGenericArtifacts,
  },
  historyEvidence,
});

console.log(JSON.stringify(payload));
process.exit(ok ? 0 : 1);
