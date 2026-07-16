#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
import { createCodexPlusPlusScriptedChatHarness } from "./lib/codexplusplus-scripted-chat-harness.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/test-anticodex-gate8-deterministic-rehearsal.mjs [options]

Options:
  --compact                 Print compact JSON output.
  --keep-run-root           Keep the temporary scripted harness directory.
  --report <path>           Write the signed rehearsal report to this path.
  --timeout-ms <ms>         Per scripted turn timeout (default: 180000).
  --interrupt-after-ms <ms> Controlled interruption delay (default: 20000).
  --help, -h                Show help without starting the harness.`);
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const compact = process.argv.includes("--compact");
const keepRunRoot = process.argv.includes("--keep-run-root");
const reportPath = resolve(argumentValue("--report")
  || join(root, "docs", "audits", "2026-07-15-gate8-deterministic-rehearsal.json"));
const launcherPath = argumentValue("--launcher") || undefined;
const appDir = argumentValue("--app-dir") || undefined;
const timeoutMs = positiveInteger(argumentValue("--timeout-ms"), 180_000);
const interruptAfterMs = positiveInteger(argumentValue("--interrupt-after-ms"), 20_000);
const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const artifactPath = resolve(
  process.env.LOCALAPPDATA || root,
  "Anti-Codex",
  "validation-artifacts",
  `gate8-deterministic-rehearsal-${runId}.zip`,
);
const checks = [];
const turns = [];
const hostTests = [];
const editRounds = [];
let harness = null;
let failure = null;
let fakeLogs = [];
let finalManifest = [];
let artifact = null;
let mainThreadId = null;
let compaction = null;
let interrupted = null;
let resumed = null;
let quota = null;
let quotaRequestCount = 0;
let processAfterCleanup = null;
const processBefore = getProcessSnapshot("");

function record(id, ok, detail = {}) {
  checks.push({ id, ok: ok === true, ...detail });
}

try {
  harness = await createCodexPlusPlusScriptedChatHarness({
    launcherPath,
    appDir,
    timeoutMs,
  });
  record("isolated_scripted_route_ready", harness.proxiedModelCount > 0, {
    providerUrl: harness.providerUrl,
    proxyBase: harness.proxyBase,
    model: harness.model,
  });
  writeFileSync(
    join(harness.paths.workspace, ".gate8-rehearsal-actions.mjs"),
    buildActionScript(runId),
    "utf8",
  );

  const createTurn = await harness.runInitial([
    "GATE8_REHEARSAL_CREATE",
    "请在当前目录创建一个可测试的小型 Node 项目。先说明动作，再实际执行命令；不要只描述结果。",
  ].join("\n"));
  turns.push(summarizeTurn("create", createTurn));
  mainThreadId = createTurn.threadId;
  recordTurn("create", createTurn, "GATE8_CREATE_COMPLETE", 2);
  requireSuccessfulTurn("create", createTurn, "GATE8_CREATE_COMPLETE");
  record("native_thread_created", Boolean(mainThreadId), { threadId: mainThreadId });
  const createArtifacts = targetManifest(harness.paths.workspace);
  const createTest = runHostTests(harness.paths.workspace, "after_create");
  hostTests.push(createTest);
  record("create_host_test_passed", createTest.passed, createTest);
  record("create_artifacts_exact", samePaths(createArtifacts, [
    "package.json",
    "README.md",
    "src/range.mjs",
    "test/range.test.mjs",
  ]), { artifacts: createArtifacts });
  editRounds.push({ id: "create", changedFiles: createArtifacts.map((entry) => entry.path) });

  const correctionTurn = await harness.runResume(mainThreadId, [
    "GATE8_REHEARSAL_CORRECT",
    "用户纠正：countTo 必须包含终点。请在同一个任务里修正实现和测试，并重新运行测试。",
  ].join("\n"));
  turns.push(summarizeTurn("correction", correctionTurn));
  recordTurn("correction", correctionTurn, "GATE8_CORRECT_COMPLETE", 2);
  requireSuccessfulTurn("correction", correctionTurn, "GATE8_CORRECT_COMPLETE");
  record("correction_same_thread", correctionTurn.threadId === mainThreadId, {
    expected: mainThreadId,
    actual: correctionTurn.threadId,
  });
  const correctedArtifacts = targetManifest(harness.paths.workspace);
  const correctionChanges = changedPaths(createArtifacts, correctedArtifacts);
  const correctionTest = runHostTests(harness.paths.workspace, "after_correction");
  hostTests.push(correctionTest);
  record("correction_host_test_passed", correctionTest.passed, correctionTest);
  record("correction_changed_target_only", sameStringSet(correctionChanges, [
    "README.md",
    "src/range.mjs",
    "test/range.test.mjs",
  ]), { changedFiles: correctionChanges });
  editRounds.push({ id: "correction", changedFiles: correctionChanges });

  const extendTurn = await harness.runResume(mainThreadId, [
    "GATE8_REHEARSAL_EXTEND",
    "继续同一个项目：增加汇总功能、对应测试并更新说明，仍然要先汇报动作再执行。",
  ].join("\n"));
  turns.push(summarizeTurn("extend", extendTurn));
  recordTurn("extend", extendTurn, "GATE8_EXTEND_COMPLETE", 2);
  requireSuccessfulTurn("extend", extendTurn, "GATE8_EXTEND_COMPLETE");
  record("extend_same_thread", extendTurn.threadId === mainThreadId, {
    expected: mainThreadId,
    actual: extendTurn.threadId,
  });
  const extendedArtifacts = targetManifest(harness.paths.workspace);
  const extensionChanges = changedPaths(correctedArtifacts, extendedArtifacts);
  const extensionTest = runHostTests(harness.paths.workspace, "after_extension");
  hostTests.push(extensionTest);
  record("extension_host_test_passed", extensionTest.passed, extensionTest);
  record("extension_added_expected_artifacts", sameStringSet(extensionChanges, [
    "README.md",
    "src/summarize.mjs",
    "test/summarize.test.mjs",
  ]), { changedFiles: extensionChanges });
  record("six_nonempty_hashed_artifacts", extendedArtifacts.length === 6
    && extendedArtifacts.every((entry) => entry.bytes > 0 && /^[a-f0-9]{64}$/.test(entry.sha256)), {
    artifacts: extendedArtifacts,
  });
  editRounds.push({ id: "extend", changedFiles: extensionChanges });

  const beforeAudit = targetManifest(harness.paths.workspace);
  const auditTurn = await harness.runResume(mainThreadId, [
    "GATE8_REHEARSAL_AUDIT",
    "现在只读审查并运行测试，不得修改任何项目文件。",
  ].join("\n"));
  turns.push(summarizeTurn("audit", auditTurn));
  recordTurn("audit", auditTurn, "GATE8_AUDIT_COMPLETE", 2);
  requireSuccessfulTurn("audit", auditTurn, "GATE8_AUDIT_COMPLETE");
  record("audit_same_thread", auditTurn.threadId === mainThreadId, {
    expected: mainThreadId,
    actual: auditTurn.threadId,
  });
  const afterAudit = targetManifest(harness.paths.workspace);
  const auditTest = runHostTests(harness.paths.workspace, "after_read_only_audit");
  hostTests.push(auditTest);
  record("audit_host_test_passed", auditTest.passed, auditTest);
  record("audit_was_read_only", JSON.stringify(beforeAudit) === JSON.stringify(afterAudit), {
    before: beforeAudit,
    after: afterAudit,
  });

  const compactLogCountBefore = readFakeLogs(harness.paths.fakeLog).length;
  compaction = await harness.compactThread(mainThreadId);
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  const compactLogs = readFakeLogs(harness.paths.fakeLog);
  const compactProviderLogs = compactLogs.slice(compactLogCountBefore);
  const compactRequestCount = compactProviderLogs.length;
  record("native_app_server_used_isolated_codex_home", samePath(
    compaction.initialize?.codexHome,
    harness.paths.codexHome,
  ), {
    userAgent: compaction.initialize?.userAgent ?? null,
    expectedCodexHome: harness.paths.codexHome,
    actualCodexHome: compaction.initialize?.codexHome ?? null,
  });
  record("native_compaction_started_on_same_thread", compaction.resumed.threadId === mainThreadId
    && compaction.before.threadId === mainThreadId
    && compaction.compaction.threadId === mainThreadId, {
    expectedThreadId: mainThreadId,
    resumed: compaction.resumed,
    before: compaction.before,
    compactionThreadId: compaction.compaction.threadId,
  });
  record("native_context_compaction_item_completed", compaction.compaction.item?.type === "contextCompaction"
    && Boolean(compaction.compaction.item?.id)
    && compaction.compaction.turn?.status === "completed"
    && compaction.compaction.turn?.error == null, {
    compaction: compaction.compaction,
  });
  record("native_compaction_persisted_in_history", compaction.after.threadId === mainThreadId
    && compaction.after.turnCount === compaction.before.turnCount + 1
    && compaction.after.contextCompactionCount === compaction.before.contextCompactionCount + 1, {
    before: compaction.before,
    after: compaction.after,
  });
  record("native_compaction_used_one_tool_free_chat_request", compactRequestCount === 1
    && compactProviderLogs[0]?.response_mode === "GATE8_REHEARSAL_NATIVE_COMPACTION"
    && compactProviderLogs[0]?.stream === true
    && compactProviderLogs[0]?.tool_names?.length === 0, {
    compactRequestCount,
    compactLog: compactProviderLogs[0] ?? null,
  });

  interrupted = await harness.runResume(mainThreadId, [
    "GATE8_REHEARSAL_INTERRUPT",
    "执行一次不可重复动作后进入长等待；测试器会模拟客户端中断。",
  ].join("\n"), { timeoutMs: interruptAfterMs, killTreeOnTimeout: false });
  turns.push(summarizeTurn("interrupted", interrupted));
  const countPath = join(harness.paths.workspace, ".gate8-action-count.txt");
  const countBeforeResume = readInteger(countPath);
  record("client_interrupted_after_exactly_one_action", interrupted.timedOut === true
    && interrupted.threadId === mainThreadId
    && countBeforeResume === 1, {
    timedOut: interrupted.timedOut,
    threadId: interrupted.threadId,
    countBeforeResume,
    commands: interrupted.commands,
  });
  if (!interrupted.timedOut || countBeforeResume !== 1) {
    throw new Error("Controlled interruption did not occur after exactly one completed action.");
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  resumed = await harness.runResume(mainThreadId, [
    "GATE8_REHEARSAL_RESUME",
    "继续同一个任务。不要重放已完成的一次性动作，只创建续跑完成证据。",
  ].join("\n"));
  turns.push(summarizeTurn("resumed", resumed));
  recordTurn("resumed", resumed, "GATE8_RESUME_COMPLETE", 1);
  requireSuccessfulTurn("resumed", resumed, "GATE8_RESUME_COMPLETE");
  const countAfterResume = readInteger(countPath);
  const resumeText = readText(join(harness.paths.workspace, ".gate8-resume-complete.txt"));
  record("same_thread_resumed_without_replay", resumed.threadId === mainThreadId
    && countAfterResume === 1
    && resumeText === `GATE8_RESUMED_${runId}\n`
    && !/409\s+Conflict|stale Anti-Codex request/i.test(`${resumed.stdoutTail}\n${resumed.stderrTail}`), {
    expectedThreadId: mainThreadId,
    actualThreadId: resumed.threadId,
    countAfterResume,
    resumeText,
  });

  const quotaLogCountBefore = readFakeLogs(harness.paths.fakeLog)
    .filter((entry) => entry.response_mode === "GATE8_REHEARSAL_QUOTA").length;
  quota = await harness.runInitial([
    "GATE8_REHEARSAL_QUOTA",
    "这是确定性额度耗尽探针；必须立即失败，不得伪造完成。",
  ].join("\n"), { timeoutMs: 30_000 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const quotaLogs = readFakeLogs(harness.paths.fakeLog)
    .filter((entry) => entry.response_mode === "GATE8_REHEARSAL_QUOTA");
  quotaRequestCount = quotaLogs.length - quotaLogCountBefore;
  const quotaText = `${quota.stdoutTail}\n${quota.stderrTail}`;
  record("quota_failed_terminally_without_retry", quota.exitCode !== 0
    && quota.timedOut === false
    && quotaRequestCount === 1
    && /429|quota[_ ]?exhausted|usage limit/i.test(quotaText), {
    exitCode: quota.exitCode,
    timedOut: quota.timedOut,
    quotaRequestCount,
    outputTail: quotaText.slice(-3_000),
  });

  fakeLogs = readFakeLogs(harness.paths.fakeLog);
  record("scripted_provider_only", fakeLogs.length > 0
    && fakeLogs.every((entry) => String(entry.path ?? "").startsWith("/v1/")), {
    requestCount: fakeLogs.length,
    responseModes: countModes(fakeLogs),
  });
  record("three_real_edit_rounds", editRounds.length === 3
    && editRounds.every((round) => round.changedFiles.length > 0), { editRounds });
  record("four_dialogue_turns_in_one_thread", turns.slice(0, 4).every((turn) => turn.threadId === mainThreadId), {
    threadIds: turns.slice(0, 4).map((turn) => turn.threadId),
  });
  record("all_host_tests_passed", hostTests.length === 4 && hostTests.every((test) => test.passed), {
    hostTests,
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
    gate: "Gate 8 deterministic rehearsal: copied native Codex plus CodexPlusPlus third-party Chat route",
    ok: failure === null && failedIds.length === 0,
    failedIds,
    formalGateAdvanced: false,
    modelTraffic: "loopback scripted Chat provider only",
    requestedRealTraffic: false,
    usedRealTraffic: false,
    antigravityTraffic: false,
    adapterInvolved: false,
    model: harness?.model ?? "gate2-chat-model",
    runId,
    failure,
    resultBasedVerification: {
      threadId: mainThreadId,
      dialogueTurns: turns.slice(0, 4).length,
      editRounds,
      hostTests,
      quotaRequestCount,
      compaction,
      artifact,
    },
    continuity: {
      interrupted: interrupted ? {
        timedOut: interrupted.timedOut,
        threadId: interrupted.threadId,
      } : null,
      resumed: resumed ? {
        exitCode: resumed.exitCode,
        threadId: resumed.threadId,
      } : null,
      nativeCompactionCovered: compaction?.compaction?.item?.type === "contextCompaction"
        && compaction?.after?.contextCompactionCount === compaction?.before?.contextCompactionCount + 1,
      visibleNativeCompactionCovered: false,
      nativeCompactionReason: "The copied native Codex app-server performed thread/compact/start and persisted a contextCompaction item. The separate visible real-Antigravity /compact acceptance remains part of formal Gate 8.",
      compaction,
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
    checks,
    note: "This rehearsal proves Codex host long-task behavior and native app-server compaction through upstream CodexPlusPlus and a loopback scripted Chat provider. It does not exercise Antigravity Cascade, the thin Antigravity Chat adapter, visible /compact, or real model inference, and it cannot complete formal Gate 8.",
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(compact ? {
    ok: report.ok,
    failedIds,
    failure,
    threadId: mainThreadId,
    editRounds: editRounds.length,
    hostTestsPassed: hostTests.filter((entry) => entry.passed).length,
    quotaRequestCount,
    nativeCompactionCovered: report.continuity.nativeCompactionCovered,
    artifact,
    reportPath,
  } : report, null, compact ? 0 : 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function recordTurn(name, turn, finalMarker, expectedCommands) {
  const text = `${turn.messages.join("\n")}\n${turn.stdoutTail}`;
  record(`${name}_turn_completed`, turn.exitCode === 0
    && turn.timedOut === false
    && text.includes(finalMarker), {
    exitCode: turn.exitCode,
    timedOut: turn.timedOut,
    threadId: turn.threadId,
    finalMarker,
    messages: turn.messages,
    stderrTail: turn.stderrTail,
  });
  record(`${name}_real_command_count`, turn.commands.length === expectedCommands
    && turn.commands.every((command) => command.status === "completed" && command.exitCode === 0), {
    expectedCommands,
    commands: turn.commands,
  });
  const progress = progressBeforeCommands(turn.events);
  record(`${name}_progress_before_every_command`, progress.ok, progress);
}

function requireSuccessfulTurn(name, turn, marker) {
  const output = `${turn.messages.join("\n")}\n${turn.stdoutTail}`;
  if (turn.exitCode === 0 && turn.timedOut === false && output.includes(marker)) return;
  throw new Error(`${name} turn failed before host verification: ${output.slice(-2_000)}`);
}

function summarizeTurn(name, turn) {
  return {
    name,
    exitCode: turn.exitCode,
    signal: turn.signal,
    timedOut: turn.timedOut,
    threadId: turn.threadId,
    commands: turn.commands,
    fileChanges: turn.fileChanges,
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

function targetManifest(workspace) {
  const targets = new Set([
    "package.json",
    "README.md",
    "src/range.mjs",
    "src/summarize.mjs",
    "test/range.test.mjs",
    "test/summarize.test.mjs",
  ]);
  return treeManifest(workspace)
    .filter((entry) => targets.has(entry.path))
    .map((entry) => ({
      ...entry,
      bytes: statSync(join(workspace, entry.path.replaceAll("/", "\\"))).size,
    }));
}

function changedPaths(before, after) {
  const previous = new Map(before.map((entry) => [entry.path, entry.sha256]));
  return after
    .filter((entry) => previous.get(entry.path) !== entry.sha256)
    .map((entry) => entry.path)
    .sort();
}

function samePaths(manifest, expected) {
  return sameStringSet(manifest.map((entry) => entry.path), expected)
    && manifest.every((entry) => entry.bytes > 0 && /^[a-f0-9]{64}$/.test(entry.sha256));
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function samePath(left, right) {
  if (!String(left ?? "").trim() || !String(right ?? "").trim()) return false;
  return resolve(String(left)).toLowerCase() === resolve(String(right)).toLowerCase();
}

function runHostTests(workspace, id) {
  const result = spawnSync(process.execPath, ["--test"], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  const stdout = String(result.stdout ?? "");
  const observedTests = Number(stdout.match(/(?:^|\n)[^\n]*tests\s+(\d+)/i)?.[1] ?? 0);
  return {
    id,
    passed: result.status === 0 && observedTests >= 1,
    exitCode: result.status,
    observedTests,
    stdoutTail: stdout.slice(-2_000),
    stderrTail: String(result.stderr ?? "").slice(-1_000),
  };
}

function readFakeLogs(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function countModes(logs) {
  const counts = {};
  for (const entry of logs) {
    const key = String(entry.response_mode ?? "UNKNOWN");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildActionScript(id) {
  const packageJson = `${JSON.stringify({
    name: "gate8-range-report",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`;
  const initialRange = [
    "export function countTo(end) {",
    "  if (!Number.isInteger(end) || end < 0) throw new TypeError(\"end must be a non-negative integer\");",
    "  return Array.from({ length: end }, (_, index) => index);",
    "}",
    "",
  ].join("\n");
  const correctedRange = initialRange.replace("length: end", "length: end + 1");
  const initialTest = [
    "import test from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { countTo } from \"../src/range.mjs\";",
    "",
    "test(\"countTo returns values below the endpoint\", () => {",
    "  assert.deepEqual(countTo(3), [0, 1, 2]);",
    "});",
    "",
  ].join("\n");
  const correctedTest = initialTest
    .replace("below the endpoint", "includes the endpoint")
    .replace("[0, 1, 2]", "[0, 1, 2, 3]");
  const summarizeSource = [
    "import { countTo } from \"./range.mjs\";",
    "",
    "export function summarize(end) {",
    "  const values = countTo(end);",
    "  return { values, total: values.reduce((sum, value) => sum + value, 0) };",
    "}",
    "",
  ].join("\n");
  const summarizeTest = [
    "import test from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { summarize } from \"../src/summarize.mjs\";",
    "",
    "test(\"summarize uses the corrected inclusive range\", () => {",
    "  assert.deepEqual(summarize(3), { values: [0, 1, 2, 3], total: 6 });",
    "});",
    "",
  ].join("\n");
  const readmeCreate = "# Range Report\n\nThe first version builds an exclusive integer range.\n";
  const readmeCorrected = "# Range Report\n\n`countTo(end)` includes the endpoint after the user correction.\n";
  const readmeExtended = `${readmeCorrected}\n\`summarize(end)\` returns the inclusive values and their total.\n`;

  return [
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    `const runId = ${JSON.stringify(id)};`,
    `const packageJson = ${JSON.stringify(packageJson)};`,
    `const initialRange = ${JSON.stringify(initialRange)};`,
    `const correctedRange = ${JSON.stringify(correctedRange)};`,
    `const initialTest = ${JSON.stringify(initialTest)};`,
    `const correctedTest = ${JSON.stringify(correctedTest)};`,
    `const summarizeSource = ${JSON.stringify(summarizeSource)};`,
    `const summarizeTest = ${JSON.stringify(summarizeTest)};`,
    `const readmeCreate = ${JSON.stringify(readmeCreate)};`,
    `const readmeCorrected = ${JSON.stringify(readmeCorrected)};`,
    `const readmeExtended = ${JSON.stringify(readmeExtended)};`,
    'const action = process.argv[2];',
    'if (action === "create") {',
    '  mkdirSync("src", { recursive: true });',
    '  mkdirSync("test", { recursive: true });',
    '  writeFileSync("package.json", packageJson, "utf8");',
    '  writeFileSync("src/range.mjs", initialRange, "utf8");',
    '  writeFileSync("test/range.test.mjs", initialTest, "utf8");',
    '  writeFileSync("README.md", readmeCreate, "utf8");',
    '  console.log("GATE8_CREATE_OK");',
    '} else if (action === "correct") {',
    '  writeFileSync("src/range.mjs", correctedRange, "utf8");',
    '  writeFileSync("test/range.test.mjs", correctedTest, "utf8");',
    '  writeFileSync("README.md", readmeCorrected, "utf8");',
    '  console.log("GATE8_CORRECT_OK");',
    '} else if (action === "extend") {',
    '  writeFileSync("src/summarize.mjs", summarizeSource, "utf8");',
    '  writeFileSync("test/summarize.test.mjs", summarizeTest, "utf8");',
    '  writeFileSync("README.md", readmeExtended, "utf8");',
    '  console.log("GATE8_EXTEND_OK");',
    '} else if (action === "audit") {',
    '  for (const path of ["package.json", "README.md", "src/range.mjs", "src/summarize.mjs", "test/range.test.mjs", "test/summarize.test.mjs"]) {',
    '    if (!existsSync(path) || readFileSync(path).length === 0) throw new Error("missing artifact: " + path);',
    '  }',
    '  console.log("GATE8_AUDIT_OK");',
    '} else if (action === "once") {',
    '  const countPath = ".gate8-action-count.txt";',
    '  const current = existsSync(countPath) ? Number(readFileSync(countPath, "utf8").trim()) || 0 : 0;',
    '  writeFileSync(countPath, String(current + 1) + "\\n", "utf8");',
    '  writeFileSync(".gate8-action-marker.txt", "GATE8_ACTION_" + runId + "\\n", "utf8");',
    '  console.log("GATE8_ONCE_OK");',
    '} else if (action === "resume") {',
    '  const count = Number(readFileSync(".gate8-action-count.txt", "utf8").trim());',
    '  if (count !== 1) throw new Error("completed action was replayed: " + count);',
    '  writeFileSync(".gate8-resume-complete.txt", "GATE8_RESUMED_" + runId + "\\n", "utf8");',
    '  console.log("GATE8_RESUME_OK");',
    '} else {',
    '  throw new Error("unknown rehearsal action: " + action);',
    '}',
    '',
  ].join("\n");
}

function readInteger(path) {
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(value) ? value : null;
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
