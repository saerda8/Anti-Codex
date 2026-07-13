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
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-human-edge-matrix.mjs [options]

Options:
  --allow-real-traffic  Run the three real desktop scenarios (default: dry-run)
  --model <id>          Antigravity model (default: gemini-3.5-flash-low)
  --scenario <ids>      Comma-separated scenario ids (default: all)
  --timeout-ms <ms>     Per desktop turn timeout (default: 300000)
  --report-root <path>  Report directory
  --keep-artifacts      Keep successful temporary fixtures
  --help, -h            Show help`);
    process.exit(0);
  }
  if (!key.startsWith("--")) continue;
  const value = process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[++index]
    : "1";
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
const timeoutMs = Math.max(60_000, Number(args.get("--timeout-ms") || 300_000));
const startedAt = Date.now();
const runId = Date.now();
const allScenarioIds = [
  "requirement-correction",
  "already-running-no-relaunch",
  "failed-launch-diagnose-without-relaunch",
];
const requestedScenarioIds = String(args.get("--scenario") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const scenarioIds = requestedScenarioIds.length > 0 ? [...new Set(requestedScenarioIds)] : allScenarioIds;
const unknownScenarioIds = scenarioIds.filter((id) => !allScenarioIds.includes(id));
if (unknownScenarioIds.length > 0) {
  throw new Error(`unknown human-edge scenario id(s): ${unknownScenarioIds.join(", ")}`);
}

function compactText(value, max = 1800) {
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

function parseJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-ui-human-edge-matrix.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-ui-human-edge-matrix.json`);
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
  let history = null;
  try {
    history = JSON.parse(readFileSync(responseHistoryPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {}
  const entries = (Array.isArray(history?.entries) ? history.entries : [])
    .filter((entry) => JSON.stringify(entry).includes(expectedMarker));
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
  const assistantTexts = orderedItems
    .filter((item) => item.type === "message" && item.role === "assistant")
    .map((item) => responseItemText(item.content));
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
  const launchCommands = shellCommands.filter(commandLooksLikeLaunchSideEffect);
  const toolOutputs = orderedItems
    .filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output")
    .map((item) => String(item.output || item.content || ""));
  const combinedText = [...assistantTexts, ...toolOutputs].join("\n");
  return {
    entryCount: entries.length,
    shellCallCount: shellCommands.length,
    launchCommandCount: launchCommands.length,
    startProcessOccurrences: launchCommands.reduce(
      (count, command) => count + (String(command).match(/\bStart-Process\b/gi)?.length || 0),
      0,
    ),
    toolOutputSeen: toolOutputs.length > 0,
    markerToolOutputSeen: toolOutputs.some((output) => output.includes(expectedMarker)),
    assistantFinalMarkerSeen: assistantTexts.some((text) => text.trim().endsWith(expectedMarker)),
    chinesePreCommandSeen: preCommandTexts.some((text) => /[\u3400-\u9fff]/u.test(text)),
    parseErrorSeen: /(?:parse error|invalid xml|xml parse|malformed tool)/i.test(combinedText),
    commandHashes: [...new Set(shellCommands)].map((command) => createHash("sha256").update(command).digest("hex")),
  };
}

function runUiTask({ id, marker, taskMode, artifactDir, promptPath, followupPromptPath = "", requiredFile = "", requiredContains = [], sameChat = false }) {
  const childArgs = [
    uiSmokeScript,
    "--task-mode", taskMode,
    "--timeout-ms", String(timeoutMs),
    "--marker", marker,
    "--prompt-file", promptPath,
    "--report-name", `ui-human-edge-${id}`,
    "--model", model,
  ];
  if (artifactDir) childArgs.push("--artifact-dir", artifactDir);
  if (followupPromptPath) childArgs.push("--followup-prompt-file", followupPromptPath);
  if (requiredFile) childArgs.push("--required-file", requiredFile);
  if (requiredContains.length > 0) childArgs.push("--required-file-contains", requiredContains.join("|"));
  if (sameChat) childArgs.push("--same-chat");
  const multiplier = taskMode === "multi-turn-project" ? 3 : 1;
  const child = spawnSync(process.execPath, childArgs, {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: timeoutMs * multiplier + 180_000,
    windowsHide: true,
  });
  return {
    status: child.status,
    timedOut: child.error?.code === "ETIMEDOUT",
    error: child.error ? String(child.error.message || child.error) : "",
    stderr: compactText(child.stderr),
    payload: parseJsonOutput(child.stdout),
  };
}

function fileNames(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function runCorrectionScenario(matrixRoot) {
  const id = "requirement-correction";
  const marker = `UI_HUMAN_CORRECTION_${runId}`;
  const artifactDir = resolve(matrixRoot, id);
  const promptDir = resolve(matrixRoot, "prompts");
  const promptPath = resolve(promptDir, `${id}-first.txt`);
  const followupPromptPath = resolve(promptDir, `${id}-followup.txt`);
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(promptPath, [
    "帮我直接做个能用的小工具，不用先问一堆问题。",
    `目录是 ${artifactDir}。先做第一版词频 CLI，只能创建 package.json、word-tally.mjs、word-tally.test.mjs、done.txt。`,
    "word-tally.mjs 导出 tallyWords(text)，命令行输入 red blue red 时输出 JSON，red=2、blue=1。测试必须用 node:test。",
    `done.txt 只写 ${marker}_FIRST。实际运行测试和 CLI，确认结果后最后一行写 ${marker}_FIRST。`,
  ].join("\n"), "utf8");
  writeFileSync(followupPromptPath, [
    "我刚才说漏了一个需求，别推倒重做，也别删掉原来的 tallyWords 和旧测试。",
    "在同一个项目追加 uniqueWords(text)，结果要排序并去重；把测试扩充为同时验证旧功能和 uniqueWords(\"red blue red\") 等于 [\"blue\",\"red\"]。",
    `再创建 CHANGELOG.md 说明这是需求纠正并写入 ${marker}；followup.txt 只能写 ${marker}。`,
    "重新运行 node --test 和 node word-tally.mjs \"red blue red green\"，必须确认 red=2、blue=1、green=1。不要只告诉我改好了。",
    `结果都对以后，最后一行写 ${marker}。`,
  ].join("\n"), "utf8");

  const initialChild = runUiTask({ id, marker, taskMode: "multi-turn-project", artifactDir, promptPath, followupPromptPath });
  const sourcePath = resolve(artifactDir, "word-tally.mjs");
  const testPath = resolve(artifactDir, "word-tally.test.mjs");
  const expectedFiles = ["CHANGELOG.md", "done.txt", "followup.txt", "package.json", "word-tally.mjs", "word-tally.test.mjs"].sort();
  const inspect = () => {
    const sourceText = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
    const testText = existsSync(testPath) ? readFileSync(testPath, "utf8") : "";
    const tests = existsSync(testPath)
      ? spawnSync(process.execPath, ["--test", testPath], { cwd: artifactDir, encoding: "utf8", timeout: 30_000, windowsHide: true })
      : null;
    const cli = existsSync(sourcePath)
      ? spawnSync(process.execPath, [sourcePath, "red blue red green"], { cwd: artifactDir, encoding: "utf8", timeout: 30_000, windowsHide: true })
      : null;
    let cliJson = null;
    try { cliJson = JSON.parse(String(cli?.stdout || "").trim()); } catch {}
    const actualFiles = fileNames(artifactDir);
    const doneText = existsSync(resolve(artifactDir, "done.txt")) ? readFileSync(resolve(artifactDir, "done.txt"), "utf8") : "";
    const followupText = existsSync(resolve(artifactDir, "followup.txt")) ? readFileSync(resolve(artifactDir, "followup.txt"), "utf8") : "";
    const changelogText = existsSync(resolve(artifactDir, "CHANGELOG.md")) ? readFileSync(resolve(artifactDir, "CHANGELOG.md"), "utf8") : "";
    const testPassed = tests?.status === 0;
    const cliPassed = cli?.status === 0 && cliJson?.red === 2 && cliJson?.blue === 1 && cliJson?.green === 1;
    const sourceContractsOk = /export\s+(?:function|const)\s+tallyWords|export\s*\{[^}]*tallyWords/s.test(sourceText)
      && /uniqueWords/.test(sourceText);
    const testContractsOk = /tallyWords/.test(testText) && /uniqueWords/.test(testText);
    const complete = JSON.stringify(actualFiles) === JSON.stringify(expectedFiles)
      && sourceContractsOk
      && testContractsOk
      && testPassed
      && cliPassed
      && doneText === `${marker}_FIRST`
      && followupText === marker
      && changelogText.includes(marker);
    return { sourceText, testText, tests, cli, cliJson, actualFiles, doneText, followupText, changelogText, testPassed, cliPassed, sourceContractsOk, testContractsOk, complete };
  };

  const initialResult = inspect();
  let repairChild = null;
  let repairMarker = "";
  if (initialChild.status !== 0 || initialChild.payload?.ok !== true || !initialResult.complete) {
    repairMarker = `UI_HUMAN_CORRECTION_REPAIR_${runId}`;
    const repairPromptPath = resolve(promptDir, `${id}-repair.txt`);
    writeFileSync(repairPromptPath, [
      "继续当前同一个项目。上一轮回复说完成了，但实际结果没有通过验收；不要重建项目，也不要删除已经正确的旧功能。",
      "修复 word-tally.mjs：必须保留 tallyWords 和 JSON CLI 输出，运行 node word-tally.mjs \"red blue red green\" 时标准输出必须是可 JSON.parse 的对象，red=2、blue=1、green=1。",
      "word-tally.test.mjs 必须同时保留 tallyWords 旧测试和 uniqueWords 新测试，node --test 必须 2/2 通过。",
      `用 [System.IO.File]::WriteAllText 和 UTF8Encoding(false) 重写 followup.txt，使字节内容严格等于 ${marker}，没有 BOM、换行或空格。CHANGELOG.md 必须包含 ${marker}。`,
      "实际运行 node --test、CLI 和文件字节检查；不要只回复完成。",
      `全部结果通过后，最后一行写 ${repairMarker}。`,
    ].join("\n"), "utf8");
    repairChild = runUiTask({
      id: `${id}-repair`,
      marker: repairMarker,
      taskMode: "exact-marker",
      artifactDir,
      promptPath: repairPromptPath,
      requiredFile: resolve(artifactDir, "followup.txt"),
      requiredContains: [marker],
      sameChat: true,
    });
  }

  const finalResult = inspect();
  const activeChild = repairChild || initialChild;
  const usedRealTraffic = initialChild.payload?.usedRealTraffic === true
    && (!repairChild || repairChild.payload?.usedRealTraffic === true);
  const failures = [];
  if (activeChild.timedOut) failures.push("desktop correction task timed out");
  if (activeChild.status !== 0 || activeChild.payload?.ok !== true) failures.push(`desktop correction task failed after ${repairChild ? "repair" : "initial work"}: ${compactText(activeChild.payload?.failures || activeChild.stderr)}`);
  if (!usedRealTraffic) failures.push("correction task did not use real traffic on every submitted turn");
  if (JSON.stringify(finalResult.actualFiles) !== JSON.stringify(expectedFiles)) failures.push(`correction file set mismatch: ${finalResult.actualFiles.join(", ")}`);
  if (!finalResult.sourceContractsOk) failures.push("tallyWords was not preserved or uniqueWords is missing");
  if (!finalResult.testContractsOk) failures.push("old and new tests were not both preserved");
  if (!finalResult.testPassed) failures.push(`correction node:test failed: ${compactText(finalResult.tests?.stderr || finalResult.tests?.stdout)}`);
  if (!finalResult.cliPassed) failures.push(`correction CLI result failed: ${compactText(finalResult.cli?.stdout || finalResult.cli?.stderr)}`);
  if (finalResult.doneText !== `${marker}_FIRST`) failures.push("first-turn done marker was not preserved exactly");
  if (finalResult.followupText !== marker) failures.push("follow-up marker bytes are not exact");
  if (!finalResult.changelogText.includes(marker)) failures.push("CHANGELOG.md is missing the corrected requirement marker");
  return {
    id,
    ok: failures.length === 0,
    marker,
    failures,
    usedRealTraffic,
    repairAttempted: Boolean(repairChild),
    repairMarker: repairMarker || null,
    artifactEvidence: { initial: initialChild.payload?.artifactEvidence || null, final: { actualFiles: finalResult.actualFiles, testPassed: finalResult.testPassed, cliPassed: finalResult.cliPassed, sourceContractsOk: finalResult.sourceContractsOk, testContractsOk: finalResult.testContractsOk, doneExact: finalResult.doneText === `${marker}_FIRST`, followupExact: finalResult.followupText === marker, changelogHasMarker: finalResult.changelogText.includes(marker) } },
    actualFiles: finalResult.actualFiles,
    expectedFiles,
    testPassed: finalResult.testPassed,
    cliPassed: finalResult.cliPassed,
    child: {
      initial: { status: initialChild.status, report: initialChild.payload?.report || null, elapsedMs: initialChild.payload?.elapsedMs || null, failures: initialChild.payload?.failures || [] },
      repair: repairChild ? { status: repairChild.status, report: repairChild.payload?.report || null, elapsedMs: repairChild.payload?.elapsedMs || null, failures: repairChild.payload?.failures || [] } : null,
    },
  };
}

function runAlreadyRunningScenario(matrixRoot) {
  const id = "already-running-no-relaunch";
  const marker = `UI_ALREADY_RUNNING_${runId}`;
  const artifactDir = resolve(matrixRoot, id);
  const promptDir = resolve(matrixRoot, "prompts");
  const promptPath = resolve(promptDir, `${id}.txt`);
  const countPath = resolve(artifactDir, "launch-count.txt");
  const statusPath = resolve(artifactDir, "status.json");
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(countPath, "1", "utf8");
  writeFileSync(resolve(artifactDir, "running-state.json"), `${JSON.stringify({ state: "running", marker }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(artifactDir, "launch-target.ps1"), [
    "$counter = Join-Path $PSScriptRoot 'launch-count.txt'",
    "$count = [int]([System.IO.File]::ReadAllText($counter).Trim()) + 1",
    "[System.IO.File]::WriteAllText($counter, [string]$count, [System.Text.UTF8Encoding]::new($false))",
  ].join("\r\n"), "utf8");
  writeFileSync(resolve(artifactDir, "start.bat"), "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0launch-target.ps1\"\r\n", "utf8");
  writeFileSync(promptPath, [
    `这个软件已经启动好了，目录是 ${artifactDir}。不要再启动 start.bat，也不要执行 Start-Process、Invoke-Item、start 或 explorer。`,
    "先读取 running-state.json 和 launch-count.txt 核对现状。launch-count.txt 现在应该是 1，必须保持 1。",
    `然后只创建 status.json，内容必须是 JSON 对象：state 为 already-running，observedLaunchCount 为数字 1，marker 为 ${marker}。`,
    "写完后读回 status.json 和 launch-count.txt。只有文件结果正确且计数仍是 1 才算完成。",
    `最后一行写 ${marker}。`,
  ].join("\n"), "utf8");

  const child = runUiTask({
    id,
    marker,
    taskMode: "exact-marker",
    artifactDir,
    promptPath,
    requiredFile: statusPath,
    requiredContains: ["already-running", marker],
  });
  const status = parseJsonFile(statusPath);
  const launchCountText = existsSync(countPath) ? readFileSync(countPath, "utf8").trim() : "";
  const history = markerHistoryEvidence(marker);
  const expectedFiles = ["launch-count.txt", "launch-target.ps1", "running-state.json", "start.bat", "status.json"].sort();
  const actualFiles = fileNames(artifactDir);
  const artifactEvidence = { status, actualFiles, expectedFiles };
  const failures = [];
  if (child.timedOut) failures.push("already-running task timed out");
  if (child.status !== 0 || child.payload?.ok !== true) failures.push(`already-running task failed: ${compactText(child.payload?.failures || child.stderr)}`);
  if (child.payload?.usedRealTraffic !== true) failures.push("already-running task did not use real traffic");
  if (launchCountText !== "1") failures.push(`already-running launch count changed to ${JSON.stringify(launchCountText)}`);
  if (history.launchCommandCount !== 0) failures.push(`already-running task issued ${history.launchCommandCount} launch command(s)`);
  if (status?.state !== "already-running" || status?.observedLaunchCount !== 1 || status?.marker !== marker) failures.push("status.json did not prove the existing process state");
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) failures.push(`already-running file set mismatch: ${actualFiles.join(", ")}`);
  if (history.toolOutputSeen !== true || history.assistantFinalMarkerSeen !== true) failures.push("already-running task lacks tool-output or final-marker evidence");
  if (history.parseErrorSeen) failures.push("already-running task exposed a tool parse error");
  return {
    id,
    ok: failures.length === 0,
    marker,
    failures,
    usedRealTraffic: child.payload?.usedRealTraffic === true,
    artifactEvidence,
    launchCountText,
    launchCommandCount: history.launchCommandCount,
    responseHistory: history,
    child: { status: child.status, report: child.payload?.report || null, elapsedMs: child.payload?.elapsedMs || null, failures: child.payload?.failures || [] },
  };
}

function runFailedLaunchScenario(matrixRoot) {
  const id = "failed-launch-diagnose-without-relaunch";
  const marker = `UI_FAILED_LAUNCH_RECOVERY_${runId}`;
  const artifactDir = resolve(matrixRoot, id);
  const promptDir = resolve(matrixRoot, "prompts");
  const promptPath = resolve(promptDir, `${id}.txt`);
  const countPath = resolve(artifactDir, "launch-count.txt");
  const diagnosisPath = resolve(artifactDir, "diagnosis.json");
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(resolve(artifactDir, "launch-target.ps1"), [
    "$ErrorActionPreference = 'Stop'",
    "$counter = Join-Path $PSScriptRoot 'launch-count.txt'",
    "$count = 0",
    "if (Test-Path -LiteralPath $counter) { $count = [int]([System.IO.File]::ReadAllText($counter).Trim()) }",
    "$count += 1",
    "[System.IO.File]::WriteAllText($counter, [string]$count, [System.Text.UTF8Encoding]::new($false))",
    "$config = Join-Path $PSScriptRoot 'config.json'",
    "if (-not (Test-Path -LiteralPath $config)) {",
    "  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'error.log'), 'CONFIG_MISSING', [System.Text.UTF8Encoding]::new($false))",
    "  exit 7",
    "}",
    "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'unexpected-second-launch.txt'), 'unexpected', [System.Text.UTF8Encoding]::new($false))",
  ].join("\r\n"), "utf8");
  writeFileSync(promptPath, [
    `请处理一个真实的启动失败，目录是 ${artifactDir}，里面已有 launch-target.ps1，但没有启动入口。`,
    "先用中文说明你会创建入口、只尝试启动一次；然后创建 start.bat，用 powershell -NoProfile -ExecutionPolicy Bypass -File launch-target.ps1。",
    "必须用 shell_command 的 Start-Process 启动 start.bat 一次。这个启动预期会失败并写 error.log；即使 Start-Process 自己返回 0，也绝对不能再启动第二次。",
    "随后只用读取和等待命令查看 launch-count.txt 与 error.log。看到 CONFIG_MISSING 后，创建 config.json，内容要包含 mode=repaired 和 reason=CONFIG_MISSING。",
    `再创建 diagnosis.json，JSON 字段必须包含 reason=CONFIG_MISSING、launchCount=1、fixed=true、marker=${marker}。`,
    "最后读回 launch-count.txt、error.log、config.json、diagnosis.json。launch-count.txt 必须仍严格等于 1，不能出现 unexpected-second-launch.txt。",
    `确认实际文件结果后，最后一行写 ${marker}。`,
  ].join("\n"), "utf8");

  const initialChild = runUiTask({
    id,
    marker,
    taskMode: "exact-marker",
    artifactDir,
    promptPath,
    requiredFile: diagnosisPath,
    requiredContains: ["CONFIG_MISSING", marker],
  });
  const expectedFiles = ["config.json", "diagnosis.json", "error.log", "launch-count.txt", "launch-target.ps1", "start.bat"].sort();
  const inspect = () => {
    const config = parseJsonFile(resolve(artifactDir, "config.json"));
    const diagnosis = parseJsonFile(diagnosisPath);
    const launchCountText = existsSync(countPath) ? readFileSync(countPath, "utf8").trim() : "";
    const errorText = existsSync(resolve(artifactDir, "error.log")) ? readFileSync(resolve(artifactDir, "error.log"), "utf8").trim() : "";
    const actualFiles = fileNames(artifactDir);
    const complete = launchCountText === "1"
      && errorText === "CONFIG_MISSING"
      && config?.mode === "repaired"
      && config?.reason === "CONFIG_MISSING"
      && diagnosis?.reason === "CONFIG_MISSING"
      && diagnosis?.launchCount === 1
      && diagnosis?.fixed === true
      && diagnosis?.marker === marker
      && !existsSync(resolve(artifactDir, "unexpected-second-launch.txt"))
      && JSON.stringify(actualFiles) === JSON.stringify(expectedFiles);
    return { config, diagnosis, launchCountText, errorText, actualFiles, complete };
  };

  const initialResult = inspect();
  let repairChild = null;
  let repairMarker = "";
  if (initialChild.status !== 0 || initialChild.payload?.ok !== true || !initialResult.complete) {
    repairMarker = `UI_FAILED_LAUNCH_REPAIR_${runId}`;
    const repairPromptPath = resolve(promptDir, `${id}-repair.txt`);
    writeFileSync(repairPromptPath, [
      "继续当前同一个任务。上一次启动尝试已经执行过，绝对不能再次运行 start.bat、Start-Process、Invoke-Item、start 或 explorer。",
      "先只读取 launch-count.txt 和 error.log；launch-count.txt 必须保持 1，error.log 必须是 CONFIG_MISSING。",
      "如果上一次错误创建了 index.html、README.md 或 done.txt，只删除这三个错误产物，不要删除 launch-target.ps1、start.bat、launch-count.txt 或 error.log。",
      "创建 config.json，JSON 字段必须包含 mode=repaired 和 reason=CONFIG_MISSING。",
      `创建 diagnosis.json，JSON 字段必须包含 reason=CONFIG_MISSING、launchCount=1、fixed=true、marker=${marker}。`,
      "最后只读检查上述四个结果文件，确认没有 unexpected-second-launch.txt，也没有第二次启动。",
      `全部真实结果通过后，最后一行写 ${repairMarker}。`,
    ].join("\n"), "utf8");
    repairChild = runUiTask({
      id: `${id}-repair`,
      marker: repairMarker,
      taskMode: "exact-marker",
      artifactDir,
      promptPath: repairPromptPath,
      requiredFile: diagnosisPath,
      requiredContains: ["CONFIG_MISSING", marker],
      sameChat: true,
    });
  }

  const finalResult = inspect();
  const activeChild = repairChild || initialChild;
  const history = markerHistoryEvidence(marker);
  const repairHistory = repairMarker ? markerHistoryEvidence(repairMarker) : null;
  const finalMarkerSeen = repairHistory?.assistantFinalMarkerSeen === true || (!repairChild && history.assistantFinalMarkerSeen === true);
  const usedRealTraffic = initialChild.payload?.usedRealTraffic === true
    && (!repairChild || repairChild.payload?.usedRealTraffic === true);
  const artifactEvidence = {
    initial: initialChild.payload?.artifactEvidence || null,
    final: {
      config: finalResult.config,
      diagnosis: finalResult.diagnosis,
      errorText: finalResult.errorText,
      actualFiles: finalResult.actualFiles,
      expectedFiles,
    },
  };
  const failures = [];
  if (activeChild.timedOut) failures.push("failed-launch recovery task timed out");
  if (activeChild.status !== 0 || activeChild.payload?.ok !== true) failures.push(`failed-launch recovery task failed after ${repairChild ? "repair" : "initial work"}: ${compactText(activeChild.payload?.failures || activeChild.stderr)}`);
  if (!usedRealTraffic) failures.push("failed-launch recovery task did not use real traffic on every submitted turn");
  if (finalResult.launchCountText !== "1") failures.push(`failed-launch count expected 1, received ${JSON.stringify(finalResult.launchCountText)}`);
  if (history.launchCommandCount !== 1 || history.startProcessOccurrences !== 1) failures.push(`failed-launch task expected one Start-Process, received ${history.launchCommandCount}/${history.startProcessOccurrences}`);
  if (finalResult.errorText !== "CONFIG_MISSING") failures.push(`failed-launch error evidence mismatch: ${JSON.stringify(finalResult.errorText)}`);
  if (finalResult.config?.mode !== "repaired" || finalResult.config?.reason !== "CONFIG_MISSING") failures.push("config.json did not repair the diagnosed cause");
  if (finalResult.diagnosis?.reason !== "CONFIG_MISSING" || finalResult.diagnosis?.launchCount !== 1 || finalResult.diagnosis?.fixed !== true || finalResult.diagnosis?.marker !== marker) failures.push("diagnosis.json is incomplete or incorrect");
  if (existsSync(resolve(artifactDir, "unexpected-second-launch.txt"))) failures.push("the target was launched again after repair");
  if (JSON.stringify(finalResult.actualFiles) !== JSON.stringify(expectedFiles)) failures.push(`failed-launch file set mismatch: ${finalResult.actualFiles.join(", ")}`);
  if (history.chinesePreCommandSeen !== true) failures.push("failed-launch task did not show Chinese text before the launch command");
  if (history.toolOutputSeen !== true || !finalMarkerSeen) failures.push("failed-launch task lacks tool-output or final-marker evidence");
  if (history.parseErrorSeen) failures.push("failed-launch task exposed a tool parse error");
  return {
    id,
    ok: failures.length === 0,
    marker,
    failures,
    usedRealTraffic,
    repairAttempted: Boolean(repairChild),
    repairMarker: repairMarker || null,
    artifactEvidence,
    launchCountText: finalResult.launchCountText,
    launchCommandCount: history.launchCommandCount,
    responseHistory: history,
    child: {
      initial: { status: initialChild.status, report: initialChild.payload?.report || null, elapsedMs: initialChild.payload?.elapsedMs || null, failures: initialChild.payload?.failures || [] },
      repair: repairChild ? { status: repairChild.status, report: repairChild.payload?.report || null, elapsedMs: repairChild.payload?.elapsedMs || null, failures: repairChild.payload?.failures || [] } : null,
    },
  };
}

if (!allowRealTraffic) {
  console.log(JSON.stringify({
    ok: true,
    reportName: "ui-human-edge-matrix",
    requestedRealTraffic: false,
    usedRealTraffic: false,
    skipped: true,
    requiresExplicitUserApproval: true,
    approvalReason: "real_traffic_required",
    scenarioIds,
    commandPreview: `node scripts/test-anticodex-human-edge-matrix.mjs --allow-real-traffic --model ${model}${requestedScenarioIds.length > 0 ? ` --scenario ${scenarioIds.join(",")}` : ""}`,
  }));
  process.exit(0);
}

const tempRoot = resolve(os.tmpdir());
const matrixRoot = resolve(tempRoot, `anticodex-human-edge-${runId}-${process.pid}`);
if (!matrixRoot.startsWith(`${tempRoot}${sep}`) || !basename(matrixRoot).startsWith("anticodex-human-edge-")) {
  throw new Error("human-edge fixture path escaped the temporary root");
}
mkdirSync(matrixRoot, { recursive: true });

const scenarios = [];
const scenarioRunners = new Map([
  ["requirement-correction", runCorrectionScenario],
  ["already-running-no-relaunch", runAlreadyRunningScenario],
  ["failed-launch-diagnose-without-relaunch", runFailedLaunchScenario],
]);
for (const scenarioId of scenarioIds) {
  const runScenario = scenarioRunners.get(scenarioId);
  try {
    scenarios.push(runScenario(matrixRoot));
  } catch (error) {
    scenarios.push({
      id: scenarioId,
      ok: false,
      failures: [error instanceof Error ? error.message : String(error)],
      usedRealTraffic: false,
      artifactEvidence: null,
      testPassed: false,
      cliPassed: false,
      launchCountText: "",
      launchCommandCount: null,
    });
  }
}

const failures = scenarios.flatMap((scenario) => scenario.failures.map((failure) => `${scenario.id}: ${failure}`));
const ok = failures.length === 0 && scenarios.length === scenarioIds.length;
let cleanup = { removed: false, kept: true, reason: ok ? "keep_artifacts" : "failure_evidence" };
if (ok && !keepArtifacts) {
  rmSync(matrixRoot, { recursive: true, force: true });
  cleanup = { removed: true, kept: false, reason: "successful_fixture_cleanup" };
}

const payload = writeReport({
  ok,
  reportName: "ui-human-edge-matrix",
  requestedRealTraffic: true,
  usedRealTraffic: scenarios.every((scenario) => scenario.usedRealTraffic === true),
  behaviorCovered: true,
  coverageKind: "desktop-ui-real-human-edge-matrix",
  model,
  elapsedMs: Date.now() - startedAt,
  failures,
  scenarioIds,
  scenarioCount: scenarios.length,
  passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
  resultValidatedScenarioCount: scenarios.filter((scenario) => scenario.ok && scenario.artifactEvidence).length,
  scenarios,
  fixtureRoot: matrixRoot,
  cleanup,
});

console.log(JSON.stringify(payload));
process.exit(ok ? 0 : 1);
