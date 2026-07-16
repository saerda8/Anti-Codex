#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  archiveDirectory,
  getProcessSnapshot,
  sameProcessRows,
  sha256,
  treeManifest,
} from "./lib/codexplusplus-antigravity-harness.mjs";
import { failedLaunchEvidenceProvesSingleAttempt } from "./lib/anticodex-gate8-evidence.mjs";
import { createCodexPlusPlusScriptedChatHarness } from "./lib/codexplusplus-scripted-chat-harness.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/test-anticodex-gate8-diverse-result-matrix.mjs [options]

Options:
  --compact                 Print compact JSON output.
  --keep-run-root           Keep the temporary scripted harness directory.
  --report <path>           Write the signed matrix report to this path.
  --timeout-ms <ms>         Per scripted turn timeout (default: 180000).
  --interrupt-after-ms <ms> Controlled interruption delay (default: 15000).
  --help, -h                Show help without starting the harness.`);
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const compact = process.argv.includes("--compact");
const keepRunRoot = process.argv.includes("--keep-run-root");
const reportPath = resolve(argumentValue("--report")
  || join(root, "docs", "audits", "2026-07-15-gate8-diverse-result-matrix.json"));
const timeoutMs = positiveInteger(argumentValue("--timeout-ms"), 180_000);
const interruptAfterMs = positiveInteger(argumentValue("--interrupt-after-ms"), 15_000);
const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const artifactPath = resolve(
  process.env.LOCALAPPDATA || root,
  "Anti-Codex",
  "validation-artifacts",
  `gate8-diverse-result-matrix-${runId}.zip`,
);
const expectedSummary = {
  inputCount: 5,
  acceptedCount: 2,
  rejectedCount: 2,
  duplicateCount: 1,
  totalQuantity: 3,
  backorderCount: 1,
};
const checks = [];
const turns = [];
let harness = null;
let failure = null;
let artifact = null;
let fakeLogs = [];
let finalManifest = [];
let inventoryThreadId = null;
let compaction = null;
let interrupted = null;
let resumed = null;
let processAfterCleanup = null;
const processBefore = getProcessSnapshot("");

function record(id, ok, detail = {}) {
  checks.push({ id, ok: ok === true, ...detail });
}

try {
  harness = await createCodexPlusPlusScriptedChatHarness({ timeoutMs });
  record("isolated_scripted_route_ready", harness.proxiedModelCount > 0, {
    providerUrl: harness.providerUrl,
    proxyBase: harness.proxyBase,
    model: harness.model,
  });
  const inventoryDir = join(harness.paths.workspace, "inventory-project");
  const processDir = join(harness.paths.workspace, "process-edge");
  createInventoryFixture(inventoryDir);
  createProcessFixture(processDir);
  writeFileSync(
    join(harness.paths.workspace, ".gate8-diverse-actions.mjs"),
    buildActionScript(runId),
    "utf8",
  );

  const inventoryProtectedBefore = protectedInventoryHashes(inventoryDir);
  const initialInventoryManifest = projectManifest(inventoryDir);
  const initialTest = runNode(inventoryDir, ["--test", "inventory.test.mjs"]);
  record("inventory_fixture_starts_red", initialTest.exitCode !== 0, initialTest);

  const repairTurn = await harness.runInitial([
    "GATE8_MATRIX_INVENTORY_REPAIR",
    "这是别人做到一半的现有库存项目。只修 inventory-project/inventory.mjs，让现有测试通过；保护输入、契约、说明和 package.json。命令前先用中文说明动作。",
  ].join("\n"));
  inventoryThreadId = repairTurn.threadId;
  turns.push(summarizeTurn("inventory-repair", repairTurn));
  recordSuccessfulTurn("inventory_repair", repairTurn, "GATE8_MATRIX_INVENTORY_REPAIR_COMPLETE", 2);
  const afterRepairManifest = projectManifest(inventoryDir);
  const repairTest = runNode(inventoryDir, ["--test", "inventory.test.mjs"]);
  record("inventory_existing_tests_repaired", repairTest.exitCode === 0, repairTest);
  record("inventory_first_turn_changed_only_implementation", sameStringSet(
    changedPaths(initialInventoryManifest, afterRepairManifest),
    ["inventory.mjs"],
  ), {
    changedFiles: changedPaths(initialInventoryManifest, afterRepairManifest),
  });
  record("inventory_protected_files_unchanged_after_repair", sameObject(
    inventoryProtectedBefore,
    protectedInventoryHashes(inventoryDir),
  ), {
    before: inventoryProtectedBefore,
    after: protectedInventoryHashes(inventoryDir),
  });

  const correctionTurn = await harness.runResume(inventoryThreadId, [
    "GATE8_MATRIX_INVENTORY_CORRECT",
    "用户中途改口：补齐拒绝、去重、状态规范化和 CLI 规则。继续当前项目，不要推倒已正确部分；实际跑测试与 CLI，最终指标必须是 5/2/2/1/3/1。",
  ].join("\n"));
  turns.push(summarizeTurn("inventory-correction", correctionTurn));
  recordSuccessfulTurn("inventory_correction", correctionTurn, "GATE8_MATRIX_INVENTORY_CORRECT_COMPLETE", 2);
  record("inventory_correction_same_thread", correctionTurn.threadId === inventoryThreadId, {
    expected: inventoryThreadId,
    actual: correctionTurn.threadId,
  });
  const afterCorrection = inspectInventory(inventoryDir);
  record("inventory_business_result_exact", afterCorrection.ok, afterCorrection);
  record("inventory_protected_files_unchanged_after_correction", sameObject(
    inventoryProtectedBefore,
    protectedInventoryHashes(inventoryDir),
  ), {
    before: inventoryProtectedBefore,
    after: protectedInventoryHashes(inventoryDir),
  });

  compaction = await harness.compactThread(inventoryThreadId);
  record("inventory_native_compaction_same_thread", compaction.compaction.threadId === inventoryThreadId
    && compaction.compaction.item?.type === "contextCompaction"
    && compaction.compaction.turn?.status === "completed", {
    threadId: inventoryThreadId,
    compaction: compaction.compaction,
  });
  record("inventory_native_compaction_persisted", compaction.after.turnCount === compaction.before.turnCount + 1
    && compaction.after.contextCompactionCount === compaction.before.contextCompactionCount + 1, {
    before: compaction.before,
    after: compaction.after,
  });

  const reportTurn = await harness.runResume(inventoryThreadId, [
    "GATE8_MATRIX_INVENTORY_REPORT",
    "继续同一任务。根据实际 summary.json 生成中文 README、Markdown 报告和完整离线 HTML；不能根据回复猜数字，必须重新验证测试、CLI、编码和报告内容。",
  ].join("\n"));
  turns.push(summarizeTurn("inventory-report", reportTurn));
  recordSuccessfulTurn("inventory_report", reportTurn, "GATE8_MATRIX_INVENTORY_REPORT_COMPLETE", 2);
  record("inventory_report_same_thread_after_compaction", reportTurn.threadId === inventoryThreadId, {
    expected: inventoryThreadId,
    actual: reportTurn.threadId,
  });
  const afterReport = inspectInventory(inventoryDir, { requireReports: true });
  record("inventory_reports_match_host_results", afterReport.ok, afterReport);
  record("inventory_utf8_and_offline_html", afterReport.utf8NoBom === true
    && afterReport.chineseReports === true
    && afterReport.offlineHtml === true, {
    utf8NoBom: afterReport.utf8NoBom,
    chineseReports: afterReport.chineseReports,
    offlineHtml: afterReport.offlineHtml,
  });

  writeFileSync(join(inventoryDir, ".inventory-write.tmp"), "{\"partial\":true}\n", "utf8");
  writeFileSync(join(inventoryDir, "summary.json"), "{\"state\":\"interrupted\"}\n", "utf8");
  interrupted = await harness.runResume(inventoryThreadId, [
    "GATE8_MATRIX_INVENTORY_RECOVER",
    "刚才客户端中断，目录里有半成品摘要和临时文件。只执行一次恢复，清理临时文件并从保护输入重建结果；不要重复执行已经成功的恢复动作。",
  ].join("\n"), {
    timeoutMs: interruptAfterMs,
    killTreeOnTimeout: false,
  });
  turns.push(summarizeTurn("inventory-interrupted-recovery", interrupted));
  const recoveryCountBeforeResume = readInteger(join(inventoryDir, ".recovery-count"));
  record("inventory_client_interrupted_after_one_recovery", interrupted.timedOut === true
    && interrupted.threadId === inventoryThreadId
    && recoveryCountBeforeResume === 1, {
    timedOut: interrupted.timedOut,
    threadId: interrupted.threadId,
    recoveryCountBeforeResume,
    commands: interrupted.commands,
  });
  if (!interrupted.timedOut || recoveryCountBeforeResume !== 1) {
    throw new Error("Inventory recovery did not reach exactly one completed action before interruption.");
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  resumed = await harness.runResume(inventoryThreadId, [
    "GATE8_MATRIX_INVENTORY_RESUME",
    "继续同一个任务。不要重放恢复动作，只核对恢复后的文件、测试和指标，并写一份续跑完成证据。",
  ].join("\n"));
  turns.push(summarizeTurn("inventory-resumed", resumed));
  recordSuccessfulTurn("inventory_resume", resumed, "GATE8_MATRIX_INVENTORY_RESUME_COMPLETE", 1);
  const finalInventory = inspectInventory(inventoryDir, { requireReports: true });
  const recoveryCountAfterResume = readInteger(join(inventoryDir, ".recovery-count"));
  record("inventory_resume_no_replay", resumed.threadId === inventoryThreadId
    && recoveryCountAfterResume === 1
    && readText(join(inventoryDir, ".resume-complete")) === `MATRIX_RESUMED_${runId}\n`
    && !existsSync(join(inventoryDir, ".inventory-write.tmp")), {
    threadId: resumed.threadId,
    recoveryCountAfterResume,
    resumeEvidence: readText(join(inventoryDir, ".resume-complete")),
    staleTempExists: existsSync(join(inventoryDir, ".inventory-write.tmp")),
  });
  record("inventory_final_result_still_exact", finalInventory.ok, finalInventory);
  record("inventory_final_file_set_exact", sameStringSet(
    projectManifest(inventoryDir).map((entry) => entry.path),
    [
      ".recovery-count",
      ".resume-complete",
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
    ],
  ), {
    files: projectManifest(inventoryDir).map((entry) => entry.path),
  });
  record("inventory_all_protected_hashes_preserved", sameObject(
    inventoryProtectedBefore,
    protectedInventoryHashes(inventoryDir),
  ), {
    before: inventoryProtectedBefore,
    after: protectedInventoryHashes(inventoryDir),
  });

  const alreadyRunningTurn = await harness.runInitial([
    "GATE8_MATRIX_ALREADY_RUNNING",
    "process-edge 里的服务已经运行，启动计数是 1。请先读状态，只写审计结果；绝对不要再次启动软件。",
  ].join("\n"));
  turns.push(summarizeTurn("already-running", alreadyRunningTurn));
  recordSuccessfulTurn("already_running", alreadyRunningTurn, "GATE8_MATRIX_ALREADY_RUNNING_COMPLETE", 1);
  const alreadyStatus = readJson(join(processDir, "already-running-status.json"));
  record("already_running_did_not_relaunch", readInteger(join(processDir, "launch-count.txt")) === 1
    && alreadyStatus?.state === "already-running"
    && alreadyStatus?.observedLaunchCount === 1
    && alreadyRunningTurn.commands.every((command) => !/start-service/i.test(command.command)), {
    launchCount: readInteger(join(processDir, "launch-count.txt")),
    status: alreadyStatus,
    commands: alreadyRunningTurn.commands,
  });

  const failedLaunchTurn = await harness.runInitial([
    "GATE8_MATRIX_FAILED_LAUNCH",
    "尝试启动 process-edge 服务一次。若明确失败，读取真实错误并写诊断；已经失败后不得反复启动。命令前先用中文说明。",
  ].join("\n"));
  turns.push(summarizeTurn("failed-launch", failedLaunchTurn));
  record("failed_launch_turn_completed_after_diagnosis", failedLaunchTurn.exitCode === 0
    && failedLaunchTurn.timedOut === false
    && `${failedLaunchTurn.messages.join("\n")}\n${failedLaunchTurn.stdoutTail}`.includes("GATE8_MATRIX_FAILED_LAUNCH_COMPLETE"), {
    exitCode: failedLaunchTurn.exitCode,
    timedOut: failedLaunchTurn.timedOut,
    messages: failedLaunchTurn.messages,
  });
  const failedDiagnosis = readJson(join(processDir, "failed-launch-diagnosis.json"));
  record("failed_launch_executed_once_then_stopped", failedLaunchEvidenceProvesSingleAttempt({
    failedLaunchCount: readInteger(join(processDir, "failed-launch-count.txt")),
    commands: failedLaunchTurn.commands,
    diagnosis: failedDiagnosis,
  }), {
    failedLaunchCount: readInteger(join(processDir, "failed-launch-count.txt")),
    commands: failedLaunchTurn.commands,
    diagnosis: failedDiagnosis,
  });
  const failedProgress = progressBeforeCommands(failedLaunchTurn.events);
  record("failed_launch_reported_progress_before_commands", failedProgress.ok, failedProgress);

  fakeLogs = readFakeLogs(harness.paths.fakeLog);
  record("all_provider_requests_stayed_loopback", fakeLogs.length > 0
    && fakeLogs.every((entry) => String(entry.path ?? "").startsWith("/v1/")), {
    requestCount: fakeLogs.length,
    responseModes: countModes(fakeLogs),
  });
  record("diverse_modes_all_observed", [
    "GATE8_MATRIX_INVENTORY_REPAIR",
    "GATE8_MATRIX_INVENTORY_CORRECT",
    "GATE8_MATRIX_INVENTORY_REPORT",
    "GATE8_REHEARSAL_NATIVE_COMPACTION",
    "GATE8_MATRIX_INVENTORY_RECOVER",
    "GATE8_MATRIX_INVENTORY_RECOVER_PENDING",
    "GATE8_MATRIX_INVENTORY_RESUME",
    "GATE8_MATRIX_ALREADY_RUNNING",
    "GATE8_MATRIX_FAILED_LAUNCH",
  ].every((mode) => Number(countModes(fakeLogs)[mode] ?? 0) >= 1), {
    responseModes: countModes(fakeLogs),
  });
  finalManifest = treeManifest(harness.paths.workspace);
  artifact = archiveDirectory(harness.paths.workspace, artifactPath);
  record("workspace_archived", artifact.ok, artifact);
} catch (error) {
  failure = {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error),
    stack: String(error?.stack ?? ""),
  };
} finally {
  if (harness?.paths?.fakeLog && fakeLogs.length === 0) fakeLogs = readFakeLogs(harness.paths.fakeLog);
  if (harness?.paths?.workspace && finalManifest.length === 0 && existsSync(harness.paths.workspace)) {
    finalManifest = treeManifest(harness.paths.workspace);
  }
  if (!artifact && harness?.paths?.workspace && existsSync(harness.paths.workspace)) {
    artifact = archiveDirectory(harness.paths.workspace, artifactPath);
    record("failure_workspace_archived", artifact.ok, artifact);
  }
  await harness?.close?.({ removeRoot: !keepRunRoot }).catch((error) => {
    record("harness_cleanup", false, { error: String(error?.message ?? error) });
  });
  processAfterCleanup = getProcessSnapshot("");
  record("original_codex_processes_unchanged", sameProcessRows(
    processBefore.originalCodex,
    processAfterCleanup.originalCodex,
  ), {
    before: processBefore.originalCodex,
    after: processAfterCleanup.originalCodex,
  });
  record("visible_anticodex_processes_unchanged", sameProcessRows(
    processBefore.antiCodexRoots,
    processAfterCleanup.antiCodexRoots,
  ), {
    before: processBefore.antiCodexRoots,
    after: processAfterCleanup.antiCodexRoots,
  });

  const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
  const report = {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    gate: "Gate 8 supporting diverse result matrix",
    ok: failure === null && failedIds.length === 0,
    failedIds,
    formalGateAdvanced: false,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    antigravityTraffic: false,
    adapterInvolved: false,
    resultBasedVerification: true,
    modelTraffic: "loopback scripted Chat provider only",
    model: harness?.model ?? "gate2-chat-model",
    runId,
    failure,
    scenarios: {
      existingProjectRepair: {
        threadId: inventoryThreadId,
        userCorrection: true,
        nativeCompaction: compaction,
        interrupted: interrupted ? {
          timedOut: interrupted.timedOut,
          threadId: interrupted.threadId,
        } : null,
        resumed: resumed ? {
          exitCode: resumed.exitCode,
          threadId: resumed.threadId,
        } : null,
      },
      alreadyRunningNoRelaunch: true,
      failedLaunchDiagnoseWithoutRetry: true,
    },
    providerEvidence: {
      requestCount: fakeLogs.length,
      responseModes: countModes(fakeLogs),
      log: fakeLogs,
    },
    processes: {
      before: processBefore,
      afterCleanup: processAfterCleanup,
    },
    turns,
    finalManifest,
    artifact,
    checks,
    note: "This matrix proves copied-Codex host behavior and CodexPlusPlus translation for distinct result shapes. It uses a loopback scripted provider and therefore supports, but cannot replace, the visible real-Antigravity Gate 8 run.",
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(compact ? {
    ok: report.ok,
    failedIds,
    failure,
    checkCount: checks.length,
    inventoryThreadId,
    nativeCompaction: compaction?.compaction?.item?.type === "contextCompaction",
    artifact,
    reportPath,
  } : report, null, compact ? 0 : 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function createInventoryFixture(directory) {
  mkdirSync(join(directory, "data"), { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    name: "inventory-repair-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test inventory.test.mjs" },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "inventory-contract.json"), `${JSON.stringify({
    requiredSummaryKeys: Object.keys(expectedSummary),
    protectedInputs: ["data/inventory.json"],
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "data", "inventory.json"), `${JSON.stringify([
    { sku: " a-1 ", qty: 1, status: "ACTIVE", updatedAt: "2026-07-01T09:00:00Z" },
    { sku: "A-1", qty: 3, status: "active", updatedAt: "2026-07-02T09:00:00Z" },
    { sku: "B-2", qty: 0, status: "BACKORDER", updatedAt: "2026-07-03T09:00:00Z" },
    { sku: "", qty: 4, status: "active", updatedAt: "2026-07-04T09:00:00Z" },
    { sku: "C-3", qty: -1, status: "active", updatedAt: "2026-07-05T09:00:00Z" },
  ], null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "work-notes.txt"), "保护文件：保留现有项目结构，不得重写输入。\n", "utf8");
  writeFileSync(join(directory, "inventory.mjs"), [
    "export function normalizeRecord(record) { return record; }",
    "export function dedupeLatest(records) { return records; }",
    "export function summarizeRecords(records) { return { acceptedCount: records.length, totalQuantity: 0 }; }",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(directory, "inventory.test.mjs"), inventoryBaselineTestSource(), "utf8");
}

function createProcessFixture(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "launch-count.txt"), "1\n", "utf8");
  writeFileSync(join(directory, "service-state.json"), "{\"state\":\"running\",\"pid\":4242}\n", "utf8");
  writeFileSync(join(directory, "failed-launch-count.txt"), "0\n", "utf8");
  writeFileSync(join(directory, "start-service.mjs"), [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const countPath = new URL('./failed-launch-count.txt', import.meta.url);",
    "const count = Number(readFileSync(countPath, 'utf8').trim() || 0) + 1;",
    "writeFileSync(countPath, String(count) + '\\n', 'utf8');",
    "writeFileSync(new URL('./last-error.txt', import.meta.url), 'CONFIG_MISSING\\n', 'utf8');",
    "console.error('MATRIX_CONFIG_MISSING');",
    "process.exit(17);",
    "",
  ].join("\n"), "utf8");
}

function buildActionScript(id) {
  const baselineSource = inventoryBaselineImplementationSource();
  const correctedSource = inventoryCorrectedImplementationSource();
  const correctedTest = inventoryCorrectedTestSource();
  return [
    "import { execFileSync } from 'node:child_process';",
    "import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "const operation = process.argv[2] || '';",
    "const inventory = new URL('./inventory-project/', import.meta.url);",
    "const processEdge = new URL('./process-edge/', import.meta.url);",
    "const path = (base, name) => new URL(name, base);",
    `const expected = ${JSON.stringify(expectedSummary)};`,
    "const exactSummary = value => value && Object.keys(expected).every(key => value[key] === expected[key]) && Object.keys(value).length === Object.keys(expected).length;",
    "const run = args => execFileSync(process.execPath, args, { cwd: inventory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    "if (operation === 'inventory-repair') {",
    `  writeFileSync(path(inventory, 'inventory.mjs'), ${JSON.stringify(baselineSource)}, 'utf8');`,
    "  console.log('MATRIX_INVENTORY_REPAIR_OK');",
    "} else if (operation === 'inventory-correct') {",
    `  writeFileSync(path(inventory, 'inventory.mjs'), ${JSON.stringify(correctedSource)}, 'utf8');`,
    `  writeFileSync(path(inventory, 'inventory.test.mjs'), ${JSON.stringify(correctedTest)}, 'utf8');`,
    "  console.log('MATRIX_INVENTORY_CORRECT_OK');",
    "} else if (operation === 'inventory-report') {",
    "  const summary = JSON.parse(readFileSync(path(inventory, 'summary.json'), 'utf8'));",
    "  if (!exactSummary(summary)) throw new Error('summary mismatch before report');",
    "  const metrics = `输入 ${summary.inputCount}，接收 ${summary.acceptedCount}，拒绝 ${summary.rejectedCount}，去重 ${summary.duplicateCount}，总数量 ${summary.totalQuantity}，缺货 ${summary.backorderCount}`;",
    "  writeFileSync(path(inventory, 'README.md'), `# 库存项目使用说明\\n\\n运行：node inventory.mjs --input data/inventory.json --output summary.json\\n\\n${metrics}\\n`, 'utf8');",
    "  writeFileSync(path(inventory, 'report.md'), `# 库存处理报告\\n\\n${metrics}\\n`, 'utf8');",
    "  writeFileSync(path(inventory, 'index.html'), `<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>库存处理报告</title></head><body><h1>库存处理报告</h1><p>${metrics}</p></body></html>\\n`, 'utf8');",
    "  console.log('MATRIX_INVENTORY_REPORT_OK');",
    "} else if (operation === 'verify-inventory') {",
    "  run(['--test', 'inventory.test.mjs']);",
    "  const output = JSON.parse(run(['inventory.mjs', '--input', 'data/inventory.json', '--output', 'summary.json']).trim());",
    "  const written = JSON.parse(readFileSync(path(inventory, 'summary.json'), 'utf8'));",
    "  if (!exactSummary(output) || !exactSummary(written)) throw new Error('inventory verification mismatch');",
    "  for (const name of ['README.md', 'report.md', 'index.html']) {",
    "    const bytes = readFileSync(path(inventory, name));",
    "    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`${name} has BOM`);",
    "    if (!bytes.toString('utf8').includes('库存')) throw new Error(`${name} missing Chinese text`);",
    "  }",
    "  console.log('MATRIX_INVENTORY_REPORT_VERIFY_OK');",
    "} else if (operation === 'recover-inventory') {",
    "  const countPath = path(inventory, '.recovery-count');",
    "  const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8').trim()) : 0;",
    "  if (count !== 0) { console.error('duplicate recovery'); process.exit(42); }",
    "  writeFileSync(countPath, '1\\n', 'utf8');",
    "  rmSync(path(inventory, '.inventory-write.tmp'), { force: true });",
    "  const output = JSON.parse(run(['inventory.mjs', '--input', 'data/inventory.json', '--output', 'summary.json']).trim());",
    "  if (!exactSummary(output)) throw new Error('recovery summary mismatch');",
    "  console.log('MATRIX_INVENTORY_RECOVER_OK');",
    "} else if (operation === 'audit-inventory-resume') {",
    "  if (readFileSync(path(inventory, '.recovery-count'), 'utf8').trim() !== '1') throw new Error('recovery replayed');",
    "  if (existsSync(path(inventory, '.inventory-write.tmp'))) throw new Error('stale temp remains');",
    "  run(['--test', 'inventory.test.mjs']);",
    "  if (!exactSummary(JSON.parse(readFileSync(path(inventory, 'summary.json'), 'utf8')))) throw new Error('resume summary mismatch');",
    `  writeFileSync(path(inventory, '.resume-complete'), 'MATRIX_RESUMED_${id}\\n', 'utf8');`,
    "  console.log('MATRIX_INVENTORY_RESUME_OK');",
    "} else if (operation === 'audit-already-running') {",
    "  const state = JSON.parse(readFileSync(path(processEdge, 'service-state.json'), 'utf8'));",
    "  const count = Number(readFileSync(path(processEdge, 'launch-count.txt'), 'utf8').trim());",
    "  if (state.state !== 'running' || count !== 1) throw new Error('service is not already running');",
    "  writeFileSync(path(processEdge, 'already-running-status.json'), JSON.stringify({ state: 'already-running', observedLaunchCount: count }) + '\\n', 'utf8');",
    "  console.log('MATRIX_ALREADY_RUNNING_AUDITED');",
    "} else if (operation === 'diagnose-failed-launch') {",
    "  const attempts = Number(readFileSync(path(processEdge, 'failed-launch-count.txt'), 'utf8').trim());",
    "  const reason = readFileSync(path(processEdge, 'last-error.txt'), 'utf8').trim();",
    "  if (attempts !== 1 || reason !== 'CONFIG_MISSING') throw new Error('unexpected launch evidence');",
    "  writeFileSync(path(processEdge, 'failed-launch-diagnosis.json'), JSON.stringify({ state: 'failed', reason, attempts }) + '\\n', 'utf8');",
    "  console.log('MATRIX_FAILURE_DIAGNOSED');",
    "} else {",
    "  throw new Error(`unknown operation: ${operation}`);",
    "}",
    "",
  ].join("\n");
}

function inventoryBaselineImplementationSource() {
  return [
    "export function normalizeRecord(record) {",
    "  const sku = String(record?.sku ?? '').trim().toUpperCase();",
    "  const qty = Number(record?.qty);",
    "  if (!sku || !Number.isFinite(qty) || qty < 0) return null;",
    "  return { sku, qty, status: String(record?.status ?? '').trim().toLowerCase(), updatedAt: String(record?.updatedAt ?? '') };",
    "}",
    "export function dedupeLatest(records) {",
    "  const latest = new Map();",
    "  for (const record of records) {",
    "    const current = latest.get(record.sku);",
    "    if (!current || record.updatedAt >= current.updatedAt) latest.set(record.sku, record);",
    "  }",
    "  return [...latest.values()].sort((a, b) => a.sku.localeCompare(b.sku));",
    "}",
    "export function summarizeRecords(records) {",
    "  const normalized = records.map(normalizeRecord).filter(Boolean);",
    "  const accepted = dedupeLatest(normalized);",
    "  return { acceptedCount: accepted.length, totalQuantity: accepted.reduce((sum, item) => sum + item.qty, 0) };",
    "}",
    "",
  ].join("\n");
}

function inventoryCorrectedImplementationSource() {
  return [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "export function normalizeRecord(record) {",
    "  const sku = String(record?.sku ?? '').trim().toUpperCase();",
    "  const qty = Number(record?.qty);",
    "  if (!sku || !Number.isFinite(qty) || qty < 0) return null;",
    "  return { sku, qty, status: String(record?.status ?? '').trim().toLowerCase(), updatedAt: String(record?.updatedAt ?? '') };",
    "}",
    "export function dedupeLatest(records) {",
    "  const latest = new Map();",
    "  for (const record of records) {",
    "    const current = latest.get(record.sku);",
    "    if (!current || record.updatedAt >= current.updatedAt) latest.set(record.sku, record);",
    "  }",
    "  return [...latest.values()].sort((a, b) => a.sku.localeCompare(b.sku));",
    "}",
    "export function summarizeRecords(records) {",
    "  const normalized = records.map(normalizeRecord);",
    "  const valid = normalized.filter(Boolean);",
    "  const accepted = dedupeLatest(valid);",
    "  return {",
    "    inputCount: records.length,",
    "    acceptedCount: accepted.length,",
    "    rejectedCount: normalized.length - valid.length,",
    "    duplicateCount: valid.length - accepted.length,",
    "    totalQuantity: accepted.reduce((sum, item) => sum + item.qty, 0),",
    "    backorderCount: accepted.filter(item => item.status === 'backorder').length,",
    "  };",
    "}",
    "function args(argv) {",
    "  const result = { dryRun: false };",
    "  for (let index = 0; index < argv.length; index += 1) {",
    "    if (argv[index] === '--dry-run') result.dryRun = true;",
    "    else if (argv[index] === '--input') result.input = argv[++index];",
    "    else if (argv[index] === '--output') result.output = argv[++index];",
    "  }",
    "  return result;",
    "}",
    "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
    "  const options = args(process.argv.slice(2));",
    "  if (!options.input) throw new Error('--input is required');",
    "  const summary = summarizeRecords(JSON.parse(readFileSync(options.input, 'utf8')));",
    "  const text = JSON.stringify(summary);",
    "  if (!options.dryRun) {",
    "    if (!options.output) throw new Error('--output is required');",
    "    writeFileSync(options.output, text + '\\n', 'utf8');",
    "  }",
    "  process.stdout.write(text + '\\n');",
    "}",
    "",
  ].join("\n");
}

function inventoryBaselineTestSource() {
  return [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { dedupeLatest, normalizeRecord, summarizeRecords } from './inventory.mjs';",
    "const records = [",
    "  { sku: ' a-1 ', qty: 1, status: 'ACTIVE', updatedAt: '2026-07-01T00:00:00Z' },",
    "  { sku: 'A-1', qty: 3, status: 'active', updatedAt: '2026-07-02T00:00:00Z' },",
    "  { sku: 'B-2', qty: 0, status: 'BACKORDER', updatedAt: '2026-07-03T00:00:00Z' },",
    "];",
    "test('normalizes records', () => assert.deepEqual(normalizeRecord(records[0]), { sku: 'A-1', qty: 1, status: 'active', updatedAt: '2026-07-01T00:00:00Z' }));",
    "test('keeps latest duplicate', () => assert.equal(dedupeLatest(records.map(normalizeRecord))[0].qty, 3));",
    "test('summarizes baseline', () => assert.deepEqual(summarizeRecords(records), { acceptedCount: 2, totalQuantity: 3 }));",
    "",
  ].join("\n");
}

function inventoryCorrectedTestSource() {
  return [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "import { dedupeLatest, normalizeRecord, summarizeRecords } from './inventory.mjs';",
    `const expected = ${JSON.stringify(expectedSummary)};`,
    "const records = JSON.parse(readFileSync(new URL('./data/inventory.json', import.meta.url), 'utf8'));",
    "test('rejects invalid records', () => { assert.equal(normalizeRecord({ sku: '', qty: 1 }), null); assert.equal(normalizeRecord({ sku: 'X', qty: -1 }), null); });",
    "test('keeps latest duplicate and sorts', () => assert.deepEqual(dedupeLatest(records.map(normalizeRecord).filter(Boolean)).map(item => [item.sku, item.qty]), [['A-1', 3], ['B-2', 0]]));",
    "test('summarizes exact business metrics', () => assert.deepEqual(summarizeRecords(records), expected));",
    "test('dry-run prints exact JSON without writing', () => {",
    "  const output = new URL('./dry-run-test-output.json', import.meta.url);",
    "  const run = spawnSync(process.execPath, ['inventory.mjs', '--input', 'data/inventory.json', '--output', output.pathname, '--dry-run'], { cwd: new URL('.', import.meta.url), encoding: 'utf8' });",
    "  assert.equal(run.status, 0); assert.deepEqual(JSON.parse(run.stdout), expected);",
    "  assert.throws(() => readFileSync(output, 'utf8'));",
    "});",
    "",
  ].join("\n");
}

function inspectInventory(directory, options = {}) {
  rmSync(join(directory, "dry-run-output.json"), { force: true });
  const test = runNode(directory, ["--test", "inventory.test.mjs"]);
  const dryRun = runNode(directory, [
    "inventory.mjs",
    "--input", "data/inventory.json",
    "--output", "dry-run-output.json",
    "--dry-run",
  ]);
  const dryRunDidNotWrite = !existsSync(join(directory, "dry-run-output.json"));
  const regular = runNode(directory, [
    "inventory.mjs",
    "--input", "data/inventory.json",
    "--output", "summary.json",
  ]);
  const firstHash = existsSync(join(directory, "summary.json")) ? sha256(readFileSync(join(directory, "summary.json"))) : "";
  const second = runNode(directory, [
    "inventory.mjs",
    "--input", "data/inventory.json",
    "--output", "summary.json",
  ]);
  const secondHash = existsSync(join(directory, "summary.json")) ? sha256(readFileSync(join(directory, "summary.json"))) : "";
  const dryRunJson = parseJson(dryRun.stdout);
  const regularJson = parseJson(regular.stdout);
  const writtenJson = readJson(join(directory, "summary.json"));
  const reportNames = ["README.md", "report.md", "index.html"];
  const reportTexts = reportNames.map((name) => readText(join(directory, name)));
  const utf8NoBom = reportNames.every((name) => {
    const path = join(directory, name);
    if (!existsSync(path)) return false;
    const bytes = readFileSync(path);
    return !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  });
  const metrics = ["输入 5", "接收 2", "拒绝 2", "去重 1", "总数量 3", "缺货 1"];
  const reportsReady = reportTexts.every((text) => metrics.every((metric) => text.includes(metric)));
  const chineseReports = reportTexts.every((text) => /[\u3400-\u9fff]/u.test(text));
  const html = reportTexts[2] ?? "";
  const offlineHtml = /<!doctype html>/i.test(html)
    && /<html/i.test(html)
    && !/https?:\/\//i.test(html)
    && !/<link\b|preconnect/i.test(html);
  const coreOk = test.exitCode === 0
    && dryRun.exitCode === 0
    && regular.exitCode === 0
    && second.exitCode === 0
    && dryRunDidNotWrite
    && sameObject(dryRunJson, expectedSummary)
    && sameObject(regularJson, expectedSummary)
    && sameObject(writtenJson, expectedSummary)
    && firstHash === secondHash;
  return {
    ok: coreOk && (!options.requireReports || (reportsReady && chineseReports && utf8NoBom && offlineHtml)),
    testPassed: test.exitCode === 0,
    dryRunPassed: dryRun.exitCode === 0,
    regularRunPassed: regular.exitCode === 0 && second.exitCode === 0,
    dryRunDidNotWrite,
    dryRunJson,
    regularJson,
    writtenJson,
    idempotent: Boolean(firstHash) && firstHash === secondHash,
    reportsReady,
    chineseReports,
    utf8NoBom,
    offlineHtml,
    diagnostics: {
      test: test.stderrTail || test.stdoutTail,
      dryRun: dryRun.stderrTail || dryRun.stdoutTail,
      regular: regular.stderrTail || regular.stdoutTail,
    },
  };
}

function protectedInventoryHashes(directory) {
  return Object.fromEntries([
    "package.json",
    "inventory-contract.json",
    "data/inventory.json",
    "work-notes.txt",
  ].map((path) => [path, sha256(readFileSync(join(directory, path)))]));
}

function projectManifest(directory) {
  return treeManifest(directory).map((entry) => ({
    ...entry,
    bytes: statSync(join(directory, entry.path.replaceAll("/", "\\"))).size,
  }));
}

function changedPaths(before, after) {
  const previous = new Map(before.map((entry) => [entry.path, entry.sha256]));
  return after
    .filter((entry) => previous.get(entry.path) !== entry.sha256)
    .map((entry) => entry.path)
    .sort();
}

function recordSuccessfulTurn(id, turn, marker, expectedCommandCount) {
  const text = `${turn.messages.join("\n")}\n${turn.stdoutTail}`;
  record(`${id}_turn_completed`, turn.exitCode === 0
    && turn.timedOut === false
    && turn.threadId
    && text.includes(marker), {
    exitCode: turn.exitCode,
    timedOut: turn.timedOut,
    threadId: turn.threadId,
    marker,
    messages: turn.messages,
    stderrTail: turn.stderrTail,
  });
  record(`${id}_command_results`, turn.commands.length === expectedCommandCount
    && turn.commands.every((command) => command.status === "completed" && command.exitCode === 0), {
    expectedCommandCount,
    commands: turn.commands,
  });
  const progress = progressBeforeCommands(turn.events);
  record(`${id}_progress_before_commands`, progress.ok, progress);
}

function summarizeTurn(name, turn) {
  return {
    name,
    exitCode: turn.exitCode,
    signal: turn.signal,
    timedOut: turn.timedOut,
    threadId: turn.threadId,
    commands: turn.commands,
    messages: turn.messages,
    stdoutTail: turn.stdoutTail,
    stderrTail: turn.stderrTail,
  };
}

function progressBeforeCommands(events) {
  const commandIndexes = [];
  const messageIndexes = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "item.completed") continue;
    if (event.item?.type === "command_execution") commandIndexes.push(index);
    if (event.item?.type === "agent_message" && String(event.item?.text ?? "").trim()) messageIndexes.push(index);
  }
  const missing = [];
  let previousCommand = -1;
  for (const commandIndex of commandIndexes) {
    if (!messageIndexes.some((messageIndex) => messageIndex > previousCommand && messageIndex < commandIndex)) {
      missing.push(commandIndex);
    }
    previousCommand = commandIndex;
  }
  return {
    ok: commandIndexes.length > 0 && missing.length === 0,
    commandCount: commandIndexes.length,
    progressMessageCount: messageIndexes.length,
    missingBeforeCommandIndexes: missing,
  };
}

function runNode(cwd, args) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 45_000,
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    stdoutTail: String(result.stdout ?? "").slice(-2_000),
    stderrTail: String(result.stderr ?? "").slice(-2_000),
  };
}

function readFakeLogs(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { parseError: line }; }
    });
}

function countModes(logs) {
  const result = {};
  for (const entry of logs) {
    const mode = String(entry.response_mode ?? "UNKNOWN");
    result[mode] = (result[mode] ?? 0) + 1;
  }
  return result;
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readInteger(path) {
  const value = Number(readText(path).trim());
  return Number.isInteger(value) ? value : null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

function parseJson(value) {
  try { return JSON.parse(String(value ?? "").trim()); } catch { return null; }
}

function sameObject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}


function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
