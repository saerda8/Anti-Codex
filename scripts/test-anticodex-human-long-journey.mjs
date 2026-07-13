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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-human-long-journey.mjs [options]

Options:
  --allow-real-traffic  Run real desktop journeys (default: dry-run)
  --journey <ids>       Comma-separated journey ids (default: all)
  --model <id>          Antigravity model (default: gemini-3.5-flash-low)
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
const allJourneyIds = ["messy-inventory-four-turn", "interrupted-migration-three-turn"];
const requestedJourneyIds = String(args.get("--journey") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const journeyIds = requestedJourneyIds.length > 0 ? [...new Set(requestedJourneyIds)] : allJourneyIds;
const unknownJourneyIds = journeyIds.filter((id) => !allJourneyIds.includes(id));
if (unknownJourneyIds.length > 0) throw new Error(`unknown journey id(s): ${unknownJourneyIds.join(", ")}`);

function compactText(value, max = 1800) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-ui-human-long-journey.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-ui-human-long-journey.json`);
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

function commandLooksLikeLaunch(command = "") {
  const value = String(command || "");
  return /(?:^|[;{}()\r\n|&]\s*|=\s*)Start-Process\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*|=\s*)Invoke-Item\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)(?:cmd(?:\.exe)?\s+\/[dc]\s+)?start(?:\.exe)?\s+/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)explorer(?:\.exe)?\s+/i.test(value);
}

function markerHistoryEvidence(marker) {
  let history = null;
  try { history = JSON.parse(readFileSync(responseHistoryPath, "utf8").replace(/^\uFEFF/, "")); } catch {}
  const entries = (Array.isArray(history?.entries) ? history.entries : [])
    .filter((entry) => JSON.stringify(entry).includes(marker));
  const latestEntry = entries.at(-1);
  const allItems = latestEntry ? [...(latestEntry.inputItems || []), ...(latestEntry.contextItems || [])] : [];
  let currentUserIndex = -1;
  for (let index = 0; index < allItems.length; index += 1) {
    const item = allItems[index];
    if (item?.type !== "message" || item?.role !== "user") continue;
    if (responseItemText(item.content).includes(marker)) currentUserIndex = index;
  }
  const items = allItems.slice(currentUserIndex + 1);
  const shellCommands = [];
  const assistantTexts = [];
  const preCommandTexts = [];
  const toolOutputs = [];
  let firstToolIndex = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (firstToolIndex < 0) firstToolIndex = index;
      const raw = String(item.arguments || item.input || "");
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      const command = String(parsed?.command || parsed?.cmd || parsed?.script || raw);
      if (command) shellCommands.push(command);
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      toolOutputs.push(responseItemText(item.output || item.content));
    }
    if (item.type === "message" && item.role === "assistant") {
      const text = responseItemText(item.content);
      assistantTexts.push(text);
      if (firstToolIndex < 0 || index < firstToolIndex) preCommandTexts.push(text);
    }
  }
  const combined = [...assistantTexts, ...toolOutputs].join("\n");
  return {
    entryCount: entries.length,
    shellCommands,
    toolOutputSeen: toolOutputs.length > 0,
    assistantFinalMarkerSeen: assistantTexts.some((text) => text.trim().endsWith(marker)),
    chinesePreCommandSeen: preCommandTexts.some((text) => /[\u3400-\u9fff]/u.test(text)),
    parseErrorSeen: /(?:parse error|invalid xml|xml parse|malformed tool)/i.test(combined),
    launchCommandCount: shellCommands.filter(commandLooksLikeLaunch).length,
    verificationCommandCount: shellCommands.filter((command) => /(?:node\s+--test|npm\s+test|inventory\.mjs|migrate\.mjs)/i.test(command)).length,
  };
}

function writePrompt(promptRoot, name, lines) {
  mkdirSync(promptRoot, { recursive: true });
  const path = resolve(promptRoot, `${name}.txt`);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function runUiTurn({ journeyId, turnId, marker, promptPath, artifactDir, sameChat, forceResetSameChat = false, requiredFile = "", requiredContains = [] }) {
  const childArgs = [
    uiSmokeScript,
    "--task-mode", "exact-marker",
    "--timeout-ms", String(timeoutMs),
    "--marker", marker,
    "--prompt-file", promptPath,
    "--report-name", `ui-human-long-${journeyId}-${turnId}`,
    "--model", model,
    "--artifact-dir", artifactDir,
  ];
  if (sameChat) childArgs.push("--same-chat");
  if (forceResetSameChat) childArgs.push("--force-reset-same-chat");
  if (requiredFile) childArgs.push("--required-file", requiredFile);
  if (requiredContains.length > 0) childArgs.push("--required-file-contains", requiredContains.join("|"));
  const child = spawnSync(process.execPath, childArgs, {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: timeoutMs + 180_000,
    windowsHide: true,
  });
  const payload = parseJsonOutput(child.stdout);
  const history = markerHistoryEvidence(marker);
  return {
    turnId,
    marker,
    ok: child.status === 0 && payload?.ok === true && payload?.usedRealTraffic === true,
    status: child.status,
    timedOut: child.error?.code === "ETIMEDOUT",
    error: child.error ? String(child.error.message || child.error) : "",
    stderr: compactText(child.stderr),
    report: payload?.report || null,
    elapsedMs: payload?.elapsedMs || null,
    failures: payload?.failures || [],
    usedRealTraffic: payload?.usedRealTraffic === true,
    history,
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeHashes(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[relative(root, path).replaceAll("\\", "/")] = sha256File(path);
    }
  };
  visit(root);
  return result;
}

function fileNames(root) {
  const names = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) names.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  if (existsSync(root)) visit(root);
  return names.sort();
}

function spawnNode(cwd, nodeArgs, timeout = 30_000) {
  return spawnSync(process.execPath, nodeArgs, { cwd, encoding: "utf8", timeout, windowsHide: true });
}

function checkTurn(turn, failures) {
  if (!turn.ok) failures.push(`${turn.turnId} desktop turn failed: ${compactText(turn.failures.length ? turn.failures : turn.stderr || turn.error)}`);
  if (!turn.usedRealTraffic) failures.push(`${turn.turnId} did not use real traffic`);
  if (!turn.history.assistantFinalMarkerSeen) failures.push(`${turn.turnId} final marker missing from assistant history`);
  if (!turn.history.toolOutputSeen) failures.push(`${turn.turnId} has no real tool output`);
  if (turn.history.parseErrorSeen) failures.push(`${turn.turnId} contains a tool parse error`);
}

function createInventoryFixture(root) {
  mkdirSync(resolve(root, "data"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ type: "module", scripts: { test: "node --test inventory.test.mjs" } }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "inventory-contract.json"), `${JSON.stringify({ statuses: ["active", "backorder"], skuCase: "upper", negativeQuantity: "reject", duplicateRule: "latest-updatedAt-wins" }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "data", "inventory.json"), `${JSON.stringify([
    { sku: " a-1 ", qty: "2", status: "ACTIVE", updatedAt: "2026-07-01T09:00:00Z" },
    { sku: "A-1", qty: 3, status: "active", updatedAt: "2026-07-02T09:00:00Z" },
    { sku: "b-2", qty: "0", status: "BACKORDER", updatedAt: "2026-07-03T09:00:00Z" },
    { sku: "c-3", qty: "bad", status: "active", updatedAt: "2026-07-04T09:00:00Z" },
    { sku: " ", qty: 1, status: "active", updatedAt: "2026-07-05T09:00:00Z" },
  ], null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "inventory.mjs"), [
    "export function normalizeRecord(record) {",
    "  return record;",
    "}",
    "",
    "export function summarizeRecords(records) {",
    "  return { recordCount: records.length, totalQuantity: 0, backorderCount: 0 };",
    "}",
    "",
    "throw new Error('TODO: inventory CLI is not implemented');",
    "",
  ].join("\n"), "utf8");
  writeFileSync(resolve(root, "inventory.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { normalizeRecord, summarizeRecords } from './inventory.mjs';",
    "",
    "test('normalizes one inventory record', () => {",
    "  assert.deepEqual(normalizeRecord({ sku: ' a-1 ', qty: '2', status: 'ACTIVE', updatedAt: '2026-07-01T09:00:00Z' }),",
    "    { sku: 'A-1', qty: 2, status: 'active', updatedAt: '2026-07-01T09:00:00Z' });",
    "});",
    "",
    "test('summarizes normalized records', () => {",
    "  assert.deepEqual(summarizeRecords([{ sku: 'A-1', qty: 2, status: 'active' }, { sku: 'B-2', qty: 0, status: 'backorder' }]),",
    "    { recordCount: 2, totalQuantity: 2, backorderCount: 1 });",
    "});",
    "",
  ].join("\n"), "utf8");
  writeFileSync(resolve(root, "work-notes.txt"), "Existing project. Fix in place; do not scaffold a replacement.\n", "utf8");
}

const allowedInventoryFiles = new Set([
  "README.md",
  "data/inventory.json",
  "index.html",
  "inventory-contract.json",
  "inventory.mjs",
  "inventory.test.mjs",
  "package.json",
  "report.md",
  "summary.json",
  "work-notes.txt",
]);

function inspectInventory(root, marker = "") {
  const packagePath = resolve(root, "package.json");
  const contractPath = resolve(root, "inventory-contract.json");
  const dataPath = resolve(root, "data", "inventory.json");
  const test = spawnNode(root, ["--test", "inventory.test.mjs"]);
  const outputPath = resolve(root, "summary.json");
  if (existsSync(outputPath)) unlinkSync(outputPath);
  const dryRun = spawnNode(root, ["inventory.mjs", "--input", "data/inventory.json", "--output", "summary.json", "--dry-run"]);
  const dryJson = parseJsonOutput(dryRun.stdout);
  const dryRunDidNotWrite = !existsSync(outputPath);
  const regular = spawnNode(root, ["inventory.mjs", "--input", "data/inventory.json", "--output", "summary.json"]);
  const regularJson = parseJsonOutput(regular.stdout);
  const writtenJson = readJson(outputPath);
  const expected = { inputCount: 5, acceptedCount: 2, rejectedCount: 2, duplicateCount: 1, totalQuantity: 3, backorderCount: 1 };
  const summaryMatches = [dryJson, regularJson, writtenJson].every((value) => value && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue));
  const moduleUrl = pathToFileURL(resolve(root, "inventory.mjs")).href;
  const hiddenCode = `import * as m from ${JSON.stringify(moduleUrl)};
const input=${JSON.stringify(readJson(dataPath))};
if(typeof m.normalizeRecord!=="function"||typeof m.dedupeLatest!=="function"||typeof m.summarizeRecords!=="function")process.exit(2);
const normalized=[];let rejected=0;for(const row of input){try{const value=m.normalizeRecord(row);if(value&&value.sku&&Number.isFinite(value.qty)&&value.qty>=0)normalized.push(value);else rejected++;}catch{rejected++;}}
const deduped=m.dedupeLatest(normalized);const summary=m.summarizeRecords(deduped);
if(summary.totalQuantity!==3||summary.backorderCount!==1)process.exit(3);
if(JSON.stringify(deduped.map(x=>x.sku))!==JSON.stringify(["A-1","B-2"]))process.exit(4);`;
  const hidden = spawnNode(root, ["--input-type=module", "-e", hiddenCode]);
  const testText = existsSync(resolve(root, "inventory.test.mjs")) ? readFileSync(resolve(root, "inventory.test.mjs"), "utf8") : "";
  const readme = existsSync(resolve(root, "README.md")) ? readFileSync(resolve(root, "README.md"), "utf8") : "";
  const report = existsSync(resolve(root, "report.md")) ? readFileSync(resolve(root, "report.md"), "utf8") : "";
  const html = existsSync(resolve(root, "index.html")) ? readFileSync(resolve(root, "index.html"), "utf8") : "";
  const reportReady = Boolean(marker)
    && report.includes(marker)
    && html.includes(marker)
    && /[\u3400-\u9fff]/u.test(readme)
    && /[\u3400-\u9fff]/u.test(report)
    && /<html[\s>]/i.test(html)
    && /<\/html>/i.test(html)
    && ["5", "2", "2", "1", "3"].every((value) => report.includes(value) && html.includes(value));
  const actualFiles = fileNames(root);
  return {
    testPassed: test.status === 0,
    dryRunPassed: dryRun.status === 0,
    regularRunPassed: regular.status === 0,
    dryRunDidNotWrite,
    summaryMatches,
    hiddenVerifierPassed: hidden.status === 0,
    businessTestCoverage: /dedupeLatest|dry-run|acceptedCount|duplicateCount/.test(testText),
    reportReady,
    packageHash: sha256File(packagePath),
    contractHash: sha256File(contractPath),
    dataHash: sha256File(dataPath),
    actualFiles,
    unexpectedFiles: actualFiles.filter((path) => !allowedInventoryFiles.has(path)),
    diagnostics: {
      test: compactText(test.stderr || test.stdout),
      dryRun: compactText(dryRun.stderr || dryRun.stdout),
      regular: compactText(regular.stderr || regular.stdout),
      hidden: compactText(hidden.stderr || hidden.stdout),
    },
  };
}

function runInventoryJourney(matrixRoot) {
  const id = "messy-inventory-four-turn";
  const root = resolve(matrixRoot, id);
  const promptRoot = resolve(matrixRoot, "prompts", id);
  mkdirSync(root, { recursive: true });
  createInventoryFixture(root);
  const protectedBefore = {
    packageHash: sha256File(resolve(root, "package.json")),
    contractHash: sha256File(resolve(root, "inventory-contract.json")),
    dataHash: sha256File(resolve(root, "data", "inventory.json")),
  };
  const turns = [];
  const failures = [];
  let recoveryTurnCount = 0;

  const marker1 = `UI_HUMAN_LONG_INVENTORY_T1_${runId}`;
  let turn1 = runUiTurn({
    journeyId: id,
    turnId: "turn-1-repair-existing-tests",
    marker: marker1,
    artifactDir: root,
    sameChat: false,
    requiredFile: resolve(root, "inventory.mjs"),
    requiredContains: ["normalizeRecord", "summarizeRecords"],
    promptPath: writePrompt(promptRoot, "turn-1", [
      "这个目录是别人做到一半留下的，不要新建另一套项目，也不要先问我问题。",
      `工作目录：${root}`,
      "先阅读 package.json、inventory.mjs、inventory.test.mjs 和 inventory-contract.json，修复现有 inventory.mjs，让现有测试通过。",
      "package.json、inventory-contract.json、data/inventory.json 和 work-notes.txt 都是保护文件，不能修改、覆盖或删除；不要降低测试标准。",
      "实际运行 node --test inventory.test.mjs。命令前先用一句中文说明你要验证什么，不能只回复说完成了。",
      `测试真正通过后，最后一行写 ${marker1}。`,
    ]),
  });
  turns.push(turn1);
  let firstTest = spawnNode(root, ["--test", "inventory.test.mjs"]);
  if (!turn1.ok || firstTest.status !== 0) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_INVENTORY_T1_REPAIR_${runId}`;
    turn1 = runUiTurn({
      journeyId: id,
      turnId: "turn-1-repair-after-result-check",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn1.ok,
      requiredFile: resolve(root, "inventory.mjs"),
      requiredContains: ["normalizeRecord", "summarizeRecords"],
      promptPath: writePrompt(promptRoot, "turn-1-repair", [
        "继续当前任务。宿主实际运行现有测试仍失败，上一轮不能算完成。",
        `真实测试尾部：${compactText(firstTest.stderr || firstTest.stdout, 500)}`,
        "只读取当前 inventory.mjs 和 inventory.test.mjs 各一次，然后修复 inventory.mjs；不要改测试、package.json、契约、输入或 work-notes.txt。补丁失败时改用 shell_command 和 Node fs.writeFileSync 全量写回当前文件，不要重复套用旧内容。",
        "重新运行 node --test inventory.test.mjs，以退出码 0 为准。",
        `通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn1);
    firstTest = spawnNode(root, ["--test", "inventory.test.mjs"]);
  }
  checkTurn(turn1, failures);
  if (firstTest.status !== 0) failures.push(`inventory first-turn test still failed after recovery: ${compactText(firstTest.stderr || firstTest.stdout)}`);

  const marker2 = `UI_HUMAN_LONG_INVENTORY_T2_${runId}`;
  let turn2 = runUiTurn({
    journeyId: id,
    turnId: "turn-2-business-correction",
    marker: marker2,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "summary.json"),
    requiredContains: ["inputCount", "acceptedCount", "duplicateCount"],
    promptPath: writePrompt(promptRoot, "turn-2", [
      "我补充真实业务规则，继续改当前项目，别推倒第一轮已经正确的部分。",
      "空 SKU、非法数量和负数数量要拒绝；同 SKU 按 updatedAt 最新记录保留；SKU 大写，状态小写，最终按 SKU 排序。",
      "导出 normalizeRecord、dedupeLatest、summarizeRecords。CLI 支持 --input、--output、--dry-run。dry-run 只能向标准输出打印 JSON，不能写输出文件；普通运行既打印同一份 JSON，也写 summary.json。",
      "对现有 data/inventory.json，结果必须是 inputCount=5、acceptedCount=2、rejectedCount=2、duplicateCount=1、totalQuantity=3、backorderCount=1。",
      "保留旧测试并增加必要测试，运行 node --test、dry-run 和普通运行。继续保护 package.json、inventory-contract.json、data/inventory.json、work-notes.txt。",
      `全部真实结果通过后，最后一行写 ${marker2}。`,
    ]),
  });
  turns.push(turn2);
  let afterBusiness = inspectInventory(root);
  const businessPasses = (result) => result.testPassed
    && result.dryRunPassed
    && result.regularRunPassed
    && result.dryRunDidNotWrite
    && result.summaryMatches
    && result.hiddenVerifierPassed
    && result.businessTestCoverage;
  for (let attempt = 1; attempt <= 2 && (!turn2.ok || !businessPasses(afterBusiness)); attempt += 1) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_INVENTORY_T2_REPAIR_${attempt}_${runId}`;
    const businessAlreadyReady = businessPasses(afterBusiness);
    turn2 = runUiTurn({
      journeyId: id,
      turnId: `turn-2-repair-after-host-validation-${attempt}`,
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn2.ok,
      requiredFile: businessAlreadyReady ? "" : resolve(root, "inventory.test.mjs"),
      requiredContains: businessAlreadyReady ? [] : ["dedupeLatest", "dry-run", "acceptedCount", "duplicateCount"],
      promptPath: writePrompt(promptRoot, `turn-2-repair-${attempt}`, [
        businessAlreadyReady
          ? `继续当前同一个项目，这是第 ${attempt} 次宿主收尾复核。宿主已确认测试、CLI、六项指标、隐藏函数和新增规则覆盖全部通过；这个回合禁止修改任何文件。`
          : `继续当前同一个项目，这是第 ${attempt} 次宿主结果修复。上一轮业务结果没有通过，不能只解释原因。`,
        `测试结果：${afterBusiness.testPassed ? "通过" : "失败"}；dry-run：${afterBusiness.dryRunPassed ? "通过" : "失败"}；普通运行：${afterBusiness.regularRunPassed ? "通过" : "失败"}；六项指标：${afterBusiness.summaryMatches ? "一致" : "不一致"}；隐藏函数验收：${afterBusiness.hiddenVerifierPassed ? "通过" : "失败"}；新增规则测试：${afterBusiness.businessTestCoverage ? "已覆盖" : "未覆盖"}。`,
        `关键错误：${compactText(afterBusiness.diagnostics.test || afterBusiness.diagnostics.regular || afterBusiness.diagnostics.hidden, 700)}`,
        businessAlreadyReady
          ? "只运行 node --test inventory.test.mjs、CLI --dry-run，并读取已有 summary.json；不要重复命令，不要运行会写文件的普通模式。"
          : "先用 Get-Content -Raw 各读取一次当前 inventory.mjs 和 inventory.test.mjs。不要再按旧文件内容打补丁；若 apply_patch 上下文不匹配，立即改用 shell_command 配合 Node fs.writeFileSync 全量写回这两个允许修改的文件。",
        businessAlreadyReady
          ? "package.json、业务代码、测试、契约、输入、摘要和 work-notes.txt 全都不能修改。"
          : "inventory.test.mjs 必须新增 dedupeLatest、dry-run、acceptedCount、duplicateCount 的真实断言，不能只改 package.json 或创建无关文件。保留所有旧测试语义。",
        businessAlreadyReady
          ? "根据真实复核结果直接收尾，不要继续检查或解释计划。"
          : "修到 node --test、dry-run、普通运行都通过，且六项指标精确为 5/2/2/1/3/1。package.json、契约、输入和 work-notes.txt 都不能改。",
        `实际复核通过后，最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn2);
    afterBusiness = inspectInventory(root);
  }
  checkTurn(turn2, failures);
  if (!afterBusiness.testPassed || !afterBusiness.dryRunPassed || !afterBusiness.regularRunPassed) failures.push("inventory tests or CLI did not execute successfully after business correction");
  if (!afterBusiness.dryRunDidNotWrite) failures.push("inventory dry-run wrote summary.json");
  if (!afterBusiness.summaryMatches || !afterBusiness.hiddenVerifierPassed) failures.push(`inventory host result mismatch: ${compactText(afterBusiness.diagnostics.hidden || afterBusiness.diagnostics.regular)}`);
  if (!afterBusiness.businessTestCoverage) failures.push("inventory corrected business rules are not covered by the project test file");

  const marker3 = `UI_HUMAN_LONG_INVENTORY_T3_${runId}`;
  let turn3 = runUiTurn({
    journeyId: id,
    turnId: "turn-3-deliver-report",
    marker: marker3,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "index.html"),
    requiredContains: [marker3, "库存"],
    promptPath: writePrompt(promptRoot, "turn-3", [
      "功能结果可以了，现在把同一个项目交付完整，但不要改业务输入和契约。",
      "新增中文 README.md、report.md、index.html。报告必须写清实际跑出来的 5 条输入、2 条接收、2 条拒绝、1 条去重、总数量 3、缺货 1。",
      "index.html 必须是完整离线 HTML，不引用网络资源，并展示同样指标；report.md 和 index.html 都要包含准确标记。",
      "重新运行测试、dry-run、普通运行并读取 summary.json，不准根据自己写的文字猜结果。",
      `报告标记是 ${marker3}。所有结果复核后，最后一行写 ${marker3}。`,
    ]),
  });
  turns.push(turn3);
  let afterReport = inspectInventory(root, marker3);
  for (let attempt = 1; attempt <= 2 && (!turn3.ok || !afterReport.reportReady || !afterReport.summaryMatches || !afterReport.hiddenVerifierPassed); attempt += 1) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_INVENTORY_T3_REPAIR_${attempt}_${runId}`;
    const reportAlreadyReady = afterReport.reportReady && afterReport.summaryMatches && afterReport.hiddenVerifierPassed;
    turn3 = runUiTurn({
      journeyId: id,
      turnId: `turn-3-repair-report-from-real-results-${attempt}`,
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn3.ok,
      requiredFile: reportAlreadyReady ? "" : resolve(root, "index.html"),
      requiredContains: reportAlreadyReady ? [] : [marker3, "库存"],
      promptPath: writePrompt(promptRoot, `turn-3-repair-${attempt}`, [
        reportAlreadyReady
          ? "继续当前交付。宿主已确认 README.md、report.md、index.html 和六项指标正确；这个回合禁止修改任何文件，只做最终复核和收尾回复。"
          : "继续当前交付。宿主检查发现报告文件或实际指标没有通过，不要重写业务代码。",
        reportAlreadyReady
          ? "只运行 node --test、CLI dry-run，并读取已有 summary.json；不要重复执行同一命令。"
          : "先运行测试、dry-run 和普通运行并读取 summary.json。只允许修 README.md、report.md、index.html；两份报告都必须使用实际六项指标 5/2/2/1/3/1，并保留原报告标记。",
        `原报告标记：${marker3}。package.json、业务代码、测试、契约和输入都不能修改。`,
        `宿主结果全部一致后，最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn3);
    afterReport = inspectInventory(root, marker3);
  }
  checkTurn(turn3, failures);
  if (!afterReport.reportReady) failures.push("inventory Chinese Markdown/HTML report did not match host-observed metrics and marker");
  if (!afterReport.summaryMatches || !afterReport.hiddenVerifierPassed) failures.push("inventory result regressed while writing the report");

  const beforeNoopHashes = treeHashes(root);
  const marker4 = `UI_HUMAN_LONG_INVENTORY_T4_${runId}`;
  turns.push(runUiTurn({
    journeyId: id,
    turnId: "turn-4-read-only-reverification",
    marker: marker4,
    artifactDir: root,
    sameChat: true,
    promptPath: writePrompt(promptRoot, "turn-4", [
      "先别继续加东西，我只要交付前复核。这个回合禁止修改、创建、删除任何文件，也不要启动或打开任何软件。",
      `仍在目录 ${root}。只运行现有 node --test inventory.test.mjs，再运行 CLI 的 --dry-run，并读取已有 summary.json 对比六个指标。`,
      "如果都一致就直接结束；不要重写文件、不要格式化、不要重复执行同一命令。命令前先说一句中文说明。",
      `复核结果真的通过后，最后一行写 ${marker4}。`,
    ]),
  }));
  checkTurn(turns.at(-1), failures);
  const afterNoopHashes = treeHashes(root);
  const noopHistory = turns.at(-1).history;
  if (JSON.stringify(afterNoopHashes) !== JSON.stringify(beforeNoopHashes)) failures.push("read-only reverification changed project files");
  if (noopHistory.launchCommandCount !== 0) failures.push("read-only reverification launched a process or program");
  if (noopHistory.verificationCommandCount < 1) failures.push("read-only reverification did not run a verification command");
  if (noopHistory.verificationCommandCount > 3) failures.push(`read-only reverification repeated verification commands ${noopHistory.verificationCommandCount} times`);
  if (!noopHistory.chinesePreCommandSeen) failures.push("read-only reverification had no Chinese pre-command explanation");

  const final = inspectInventory(root, marker3);
  if (final.packageHash !== protectedBefore.packageHash) failures.push("package.json was modified");
  if (final.contractHash !== protectedBefore.contractHash) failures.push("inventory-contract.json was modified");
  if (final.dataHash !== protectedBefore.dataHash) failures.push("data/inventory.json was modified");
  if (final.unexpectedFiles.length > 0) failures.push(`inventory project contains unexpected files: ${final.unexpectedFiles.join(", ")}`);
  const artifactEvidence = {
    protectedFilesUnchanged: final.packageHash === protectedBefore.packageHash && final.contractHash === protectedBefore.contractHash && final.dataHash === protectedBefore.dataHash,
    testsPassed: final.testPassed,
    dryRunPassed: final.dryRunPassed,
    dryRunDidNotWrite: final.dryRunDidNotWrite,
    regularRunPassed: final.regularRunPassed,
    summaryMatches: final.summaryMatches,
    hiddenVerifierPassed: final.hiddenVerifierPassed,
    businessTestCoverage: final.businessTestCoverage,
    reportReady: final.reportReady,
    noopHashesUnchanged: JSON.stringify(afterNoopHashes) === JSON.stringify(beforeNoopHashes),
    noopLaunchCommandCount: noopHistory.launchCommandCount,
    noopVerificationCommandCount: noopHistory.verificationCommandCount,
    unexpectedFiles: final.unexpectedFiles,
    actualFiles: final.actualFiles,
  };
  return {
    id,
    ok: failures.length === 0,
    failures,
    turnCount: turns.length,
    passedTurnCount: turns.filter((turn) => turn.ok).length,
    recoveryTurnCount,
    usedRealTraffic: turns.every((turn) => turn.usedRealTraffic),
    turns,
    artifactEvidence,
  };
}

function createMigrationFixture(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ type: "module", scripts: { test: "node --test migrate.test.mjs" } }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "migration-contract.json"), `${JSON.stringify({ duplicateRule: "last-line-wins", idCase: "upper", emailCase: "lower", outputOrder: "id-ascending", malformedPolicy: "reject-exact-line" }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "records.ndjson"), [
    JSON.stringify({ id: "B2", email: " B@EXAMPLE.COM ", active: true }),
    "{bad json",
    JSON.stringify({ id: "A1", email: "A@EXAMPLE.COM", active: true }),
    JSON.stringify({ id: "B2", email: "latest@example.com", active: false }),
    "",
  ].join("\n"), "utf8");
  writeFileSync(resolve(root, "migrate.mjs"), "throw new Error('TODO: interrupted migration implementation');\n", "utf8");
  writeFileSync(resolve(root, "migrate.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { parseRecords, migrateRecords } from './migrate.mjs';",
    "",
    "test('parses malformed NDJSON without hiding it', () => {",
    "  const parsed = parseRecords('{\"id\":\"A1\",\"email\":\"A@EXAMPLE.COM\",\"active\":true}\\n{bad json\\n');",
    "  assert.equal(parsed.valid.length, 1);",
    "  assert.deepEqual(parsed.rejected, ['{bad json']);",
    "});",
    "",
    "test('normalizes and keeps the last duplicate', () => {",
    "  const result = migrateRecords([{ id: 'b2', email: 'old@EXAMPLE.COM', active: true }, { id: 'B2', email: 'NEW@example.com', active: false }]);",
    "  assert.deepEqual(result.records, [{ id: 'B2', email: 'new@example.com', active: false }]);",
    "  assert.equal(result.duplicateCount, 1);",
    "});",
    "",
  ].join("\n"), "utf8");
}

const allowedMigrationFiles = new Set([
  "migrate.mjs",
  "migrate.test.mjs",
  "migration-contract.json",
  "migration-summary.json",
  "normalized.json",
  "package.json",
  "records.ndjson",
  "rejects.ndjson",
]);

function inspectMigration(root) {
  const inputPath = resolve(root, "records.ndjson");
  const contractPath = resolve(root, "migration-contract.json");
  const outputPath = resolve(root, "normalized.json");
  const rejectsPath = resolve(root, "rejects.ndjson");
  const summaryPath = resolve(root, "migration-summary.json");
  const test = spawnNode(root, ["--test", "migrate.test.mjs"]);
  const firstRun = spawnNode(root, ["migrate.mjs", "--input", "records.ndjson", "--output", "normalized.json", "--rejects", "rejects.ndjson", "--summary", "migration-summary.json"]);
  const firstHashes = [outputPath, rejectsPath, summaryPath].map((path) => existsSync(path) ? sha256File(path) : "");
  const secondRun = spawnNode(root, ["migrate.mjs", "--input", "records.ndjson", "--output", "normalized.json", "--rejects", "rejects.ndjson", "--summary", "migration-summary.json"]);
  const secondHashes = [outputPath, rejectsPath, summaryPath].map((path) => existsSync(path) ? sha256File(path) : "");
  const output = readJson(outputPath);
  const summary = readJson(summaryPath);
  const rejects = existsSync(rejectsPath) ? readFileSync(rejectsPath, "utf8") : "";
  const expectedOutput = [
    { id: "A1", email: "a@example.com", active: true },
    { id: "B2", email: "latest@example.com", active: false },
  ];
  const expectedSummary = { inputCount: 4, outputCount: 2, rejectedCount: 1, duplicateCount: 1 };
  const actualFiles = fileNames(root);
  return {
    testPassed: test.status === 0,
    firstRunPassed: firstRun.status === 0,
    secondRunPassed: secondRun.status === 0,
    outputMatches: JSON.stringify(output) === JSON.stringify(expectedOutput),
    summaryMatches: summary && Object.entries(expectedSummary).every(([key, value]) => summary[key] === value),
    rejectsExact: rejects === "{bad json",
    idempotent: JSON.stringify(firstHashes) === JSON.stringify(secondHashes) && firstHashes.every(Boolean),
    staleTempAbsent: !existsSync(resolve(root, ".normalized.json.tmp")),
    inputHash: sha256File(inputPath),
    contractHash: sha256File(contractPath),
    actualFiles,
    unexpectedFiles: actualFiles.filter((path) => !allowedMigrationFiles.has(path)),
    diagnostics: {
      test: compactText(test.stderr || test.stdout),
      firstRun: compactText(firstRun.stderr || firstRun.stdout),
      secondRun: compactText(secondRun.stderr || secondRun.stdout),
    },
  };
}

function runMigrationJourney(matrixRoot) {
  const id = "interrupted-migration-three-turn";
  const root = resolve(matrixRoot, id);
  const promptRoot = resolve(matrixRoot, "prompts", id);
  createMigrationFixture(root);
  const protectedBefore = {
    inputHash: sha256File(resolve(root, "records.ndjson")),
    contractHash: sha256File(resolve(root, "migration-contract.json")),
  };
  const turns = [];
  const failures = [];
  let recoveryTurnCount = 0;

  const marker1 = `UI_HUMAN_LONG_MIGRATION_T1_${runId}`;
  let turn1 = runUiTurn({
    journeyId: id,
    turnId: "turn-1-recover-broken-migrator",
    marker: marker1,
    artifactDir: root,
    sameChat: false,
    requiredFile: resolve(root, "normalized.json"),
    requiredContains: ["A1", "B2"],
    promptPath: writePrompt(promptRoot, "turn-1", [
      "这是一个中断后留下的数据迁移目录，不要另起项目。",
      `目录：${root}`,
      "阅读 migration-contract.json、records.ndjson、migrate.mjs、migrate.test.mjs。修复 migrate.mjs，导出 parseRecords 和 migrateRecords，并让现有测试通过。",
      "CLI 读取 NDJSON，把 ID 大写、邮箱小写去空格、重复 ID 保留最后一行，输出按 ID 排序的 normalized.json，同时写 migration-summary.json。坏 JSON 不能让整个任务崩掉。",
      "records.ndjson、migration-contract.json 和现有测试第一轮都不能改。实际运行测试和 CLI，再读取输出核对。",
      `结果正确后，最后一行写 ${marker1}。`,
    ]),
  });
  turns.push(turn1);
  let firstTest = spawnNode(root, ["--test", "migrate.test.mjs"]);
  let firstOutput = readJson(resolve(root, "normalized.json"));
  const expectedOutput = [{ id: "A1", email: "a@example.com", active: true }, { id: "B2", email: "latest@example.com", active: false }];
  if (!turn1.ok || firstTest.status !== 0 || JSON.stringify(firstOutput) !== JSON.stringify(expectedOutput)) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_MIGRATION_T1_REPAIR_${runId}`;
    turn1 = runUiTurn({
      journeyId: id,
      turnId: "turn-1-repair-after-result-check",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn1.ok,
      requiredFile: resolve(root, "normalized.json"),
      requiredContains: ["A1", "B2"],
      promptPath: writePrompt(promptRoot, "turn-1-repair", [
        "继续当前迁移。宿主实际测试或 normalized.json 没通过，上一轮不能算完成。",
        `测试尾部：${compactText(firstTest.stderr || firstTest.stdout, 500)}`,
        "只读取当前 migrate.mjs、migrate.test.mjs 各一次。修复 migrate.mjs，不修改测试、输入和契约；补丁上下文失败时用 shell_command 配合 Node fs.writeFileSync 全量写回 migrate.mjs。",
        "运行测试和 CLI，normalized.json 必须只含排序后的 A1、B2，B2 使用最后一行邮箱。",
        `通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn1);
    firstTest = spawnNode(root, ["--test", "migrate.test.mjs"]);
    firstOutput = readJson(resolve(root, "normalized.json"));
  }
  checkTurn(turn1, failures);
  if (firstTest.status !== 0 || JSON.stringify(firstOutput) !== JSON.stringify(expectedOutput)) failures.push("migration first-turn tests or normalized output still failed after recovery");

  const marker2 = `UI_HUMAN_LONG_MIGRATION_T2_${runId}`;
  let turn2 = runUiTurn({
    journeyId: id,
    turnId: "turn-2-add-idempotent-rejects",
    marker: marker2,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "rejects.ndjson"),
    requiredContains: ["{bad json"],
    promptPath: writePrompt(promptRoot, "turn-2", [
      "刚才漏了审计要求，继续当前迁移，不要重写输入。",
      "增加 --rejects 和 --summary 参数。rejects.ndjson 必须逐字保留坏行 `{bad json`，不能加解释文字、引号或额外换行。",
      "写 normalized.json、rejects.ndjson、migration-summary.json 时要可重复运行；连续执行两次不能追加、不能重复记录，三份结果字节必须稳定。",
      "summary 必须是 inputCount=4、outputCount=2、rejectedCount=1、duplicateCount=1。可扩充测试，但不能删旧断言。",
      "运行测试和 CLI 两次，并实际比较三份文件。保护 records.ndjson 和 migration-contract.json。",
      `验证通过后，最后一行写 ${marker2}。`,
    ]),
  });
  turns.push(turn2);
  let afterIdempotency = inspectMigration(root);
  const migrationPasses = (result) => result.testPassed
    && result.firstRunPassed
    && result.secondRunPassed
    && result.outputMatches
    && result.summaryMatches
    && result.rejectsExact
    && result.idempotent;
  if (!turn2.ok || !migrationPasses(afterIdempotency)) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_MIGRATION_T2_REPAIR_${runId}`;
    turn2 = runUiTurn({
      journeyId: id,
      turnId: "turn-2-repair-after-host-validation",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn2.ok,
      requiredFile: resolve(root, "rejects.ndjson"),
      requiredContains: ["{bad json"],
      promptPath: writePrompt(promptRoot, "turn-2-repair", [
        "继续当前迁移。宿主连续运行两次后，审计输出仍未通过，不能只回复解释。",
        `测试=${afterIdempotency.testPassed}，首次 CLI=${afterIdempotency.firstRunPassed}，第二次 CLI=${afterIdempotency.secondRunPassed}，输出=${afterIdempotency.outputMatches}，摘要=${afterIdempotency.summaryMatches}，坏行精确=${afterIdempotency.rejectsExact}，幂等=${afterIdempotency.idempotent}。`,
        `关键错误：${compactText(afterIdempotency.diagnostics.test || afterIdempotency.diagnostics.firstRun, 700)}`,
        "读取当前 migrate.mjs 和测试各一次；只修允许文件。apply_patch 失败就用 shell_command 和 Node fs.writeFileSync 全量写回，不要反复猜旧上下文。",
        "实际运行测试和 CLI 两次；normalized.json、rejects.ndjson、migration-summary.json 三份字节必须稳定。",
        `通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn2);
    afterIdempotency = inspectMigration(root);
  }
  checkTurn(turn2, failures);
  if (!afterIdempotency.testPassed || !afterIdempotency.firstRunPassed || !afterIdempotency.secondRunPassed) failures.push("migration tests or repeated CLI run failed");
  if (!afterIdempotency.outputMatches || !afterIdempotency.summaryMatches || !afterIdempotency.rejectsExact) failures.push("migration host-observed files do not match the contract");
  if (!afterIdempotency.idempotent) failures.push("migration outputs are not byte-stable across two runs");

  writeFileSync(resolve(root, ".normalized.json.tmp"), "[{\"id\":\"PARTIAL\"}]", "utf8");
  if (existsSync(resolve(root, "normalized.json"))) unlinkSync(resolve(root, "normalized.json"));
  writeFileSync(resolve(root, "migration-summary.json"), "{\"state\":\"interrupted\"}\n", "utf8");
  const marker3 = `UI_HUMAN_LONG_MIGRATION_T3_${runId}`;
  let turn3 = runUiTurn({
    journeyId: id,
    turnId: "turn-3-resume-interrupted-state",
    marker: marker3,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "normalized.json"),
    requiredContains: ["A1", "latest@example.com"],
    promptPath: writePrompt(promptRoot, "turn-3", [
      "刚才进程被打断了：normalized.json 不见了，migration-summary.json 是半成品，目录里还有 .normalized.json.tmp。请在当前项目恢复，不要让我手工清理。",
      "先检查现场，再让迁移脚本从 records.ndjson 安全重建三份最终输出，并清理这个已知的临时文件。不能把临时文件当成正确数据。",
      "恢复后连续运行两次，测试必须通过，三份结果必须稳定；records.ndjson、migration-contract.json 仍然不能修改。不要启动或打开任何桌面软件。",
      `确认最终 normalized.json 只有 A1 和 B2、rejects.ndjson 仍逐字等于坏行后，最后一行写 ${marker3}。`,
    ]),
  });
  turns.push(turn3);
  let final = inspectMigration(root);
  if (!turn3.ok || !migrationPasses(final) || !final.staleTempAbsent) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_MIGRATION_T3_REPAIR_${runId}`;
    turn3 = runUiTurn({
      journeyId: id,
      turnId: "turn-3-repair-interrupted-state",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn3.ok,
      requiredFile: resolve(root, "normalized.json"),
      requiredContains: ["A1", "latest@example.com"],
      promptPath: writePrompt(promptRoot, "turn-3-repair", [
        "继续恢复现场。宿主检查显示中断恢复仍未完成。",
        `输出=${final.outputMatches}，摘要=${final.summaryMatches}，坏行=${final.rejectsExact}，幂等=${final.idempotent}，临时文件已清理=${final.staleTempAbsent}。`,
        "从受保护输入重新运行迁移并清理 .normalized.json.tmp；不要启动软件，不要修改输入和契约。连续运行两次后再读回三份结果。",
        `全部通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn3);
    final = inspectMigration(root);
  }
  checkTurn(turn3, failures);
  if (!final.testPassed || !final.firstRunPassed || !final.secondRunPassed) failures.push("migration recovery did not leave tests and repeated CLI green");
  if (!final.outputMatches || !final.summaryMatches || !final.rejectsExact || !final.idempotent) failures.push("migration recovery result failed hidden host validation");
  if (!final.staleTempAbsent) failures.push("migration recovery left the known stale temp file");
  if (final.inputHash !== protectedBefore.inputHash) failures.push("records.ndjson was modified");
  if (final.contractHash !== protectedBefore.contractHash) failures.push("migration-contract.json was modified");
  if (final.unexpectedFiles.length > 0) failures.push(`migration project contains unexpected files: ${final.unexpectedFiles.join(", ")}`);
  if (turn3.history.launchCommandCount !== 0) failures.push("interrupted-state recovery launched a desktop program");

  const artifactEvidence = {
    protectedFilesUnchanged: final.inputHash === protectedBefore.inputHash && final.contractHash === protectedBefore.contractHash,
    testsPassed: final.testPassed,
    firstRunPassed: final.firstRunPassed,
    secondRunPassed: final.secondRunPassed,
    outputMatches: final.outputMatches,
    summaryMatches: final.summaryMatches,
    rejectsExact: final.rejectsExact,
    idempotent: final.idempotent,
    staleTempAbsent: final.staleTempAbsent,
    recoveryLaunchCommandCount: turn3.history.launchCommandCount,
    unexpectedFiles: final.unexpectedFiles,
    actualFiles: final.actualFiles,
  };
  return {
    id,
    ok: failures.length === 0,
    failures,
    turnCount: turns.length,
    passedTurnCount: turns.filter((turn) => turn.ok).length,
    recoveryTurnCount,
    usedRealTraffic: turns.every((turn) => turn.usedRealTraffic),
    turns,
    artifactEvidence,
  };
}

if (!allowRealTraffic) {
  console.log(JSON.stringify({
    ok: true,
    reportName: "ui-human-long-journey",
    requestedRealTraffic: false,
    usedRealTraffic: false,
    skipped: true,
    requiresExplicitUserApproval: true,
    approvalReason: "real_traffic_required",
    journeyIds,
    commandPreview: `node scripts/test-anticodex-human-long-journey.mjs --allow-real-traffic --model ${model}${requestedJourneyIds.length > 0 ? ` --journey ${journeyIds.join(",")}` : ""}`,
  }));
  process.exit(0);
}

const tempRoot = resolve(os.tmpdir());
const matrixRoot = resolve(tempRoot, `anticodex-human-long-${runId}-${process.pid}`);
if (!matrixRoot.startsWith(`${tempRoot}${sep}`) || !basename(matrixRoot).startsWith("anticodex-human-long-")) {
  throw new Error("human-long fixture path escaped the temporary root");
}
mkdirSync(matrixRoot, { recursive: true });

const runners = new Map([
  ["messy-inventory-four-turn", runInventoryJourney],
  ["interrupted-migration-three-turn", runMigrationJourney],
]);
const journeys = [];
for (const journeyId of journeyIds) {
  try {
    journeys.push(runners.get(journeyId)(matrixRoot));
  } catch (error) {
    journeys.push({
      id: journeyId,
      ok: false,
      failures: [error instanceof Error ? error.message : String(error)],
      turnCount: 0,
      passedTurnCount: 0,
      usedRealTraffic: false,
      turns: [],
      artifactEvidence: null,
    });
  }
}

const failures = journeys.flatMap((journey) => journey.failures.map((failure) => `${journey.id}: ${failure}`));
const ok = failures.length === 0 && journeys.length === journeyIds.length;
let cleanup = { removed: false, kept: true, reason: ok ? "keep_artifacts" : "failure_evidence" };
if (ok && !keepArtifacts) {
  rmSync(matrixRoot, { recursive: true, force: true });
  cleanup = { removed: true, kept: false, reason: "successful_fixture_cleanup" };
}

const payload = writeReport({
  ok,
  reportName: "ui-human-long-journey",
  requestedRealTraffic: true,
  usedRealTraffic: journeys.every((journey) => journey.usedRealTraffic),
  behaviorCovered: true,
  coverageKind: "desktop-ui-real-human-long-journey",
  model,
  elapsedMs: Date.now() - startedAt,
  failures,
  journeyIds,
  journeyCount: journeys.length,
  passedJourneyCount: journeys.filter((journey) => journey.ok).length,
  totalTurnCount: journeys.reduce((sum, journey) => sum + journey.turnCount, 0),
  passedTurnCount: journeys.reduce((sum, journey) => sum + journey.passedTurnCount, 0),
  resultValidatedJourneyCount: journeys.filter((journey) => journey.ok && journey.artifactEvidence).length,
  journeys,
  fixtureRoot: matrixRoot,
  cleanup,
});

console.log(JSON.stringify(payload));
process.exit(ok ? 0 : 1);
