#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCodexPlusPlusAntigravityHarness,
  fetchOldRouteFingerprint,
  getProcessSnapshot,
  runProcess,
  sameProcessRows,
  sha256,
  treeManifest,
} from "./lib/codexplusplus-antigravity-harness.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const launcherPath = resolveRequired(args.get("--launcher"), "--launcher");
const candidateRoot = resolve(args.get("--candidate-root")
  ?? join(process.env.LOCALAPPDATA ?? "", "Anti-Codex", "update-candidate"));
const model = args.get("--model") ?? "gemini-3.5-flash-low";
const turnTimeoutMs = positiveInteger(args.get("--turn-timeout-ms"), 900_000);
const reportPath = resolve(args.get("--report")
  ?? join(repoRoot, "docs", "audits", "2026-07-15-gate5-real-task-matrix.json"));
const runLabel = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const artifactPath = resolve(args.get("--artifact") ?? join(
  process.env.LOCALAPPDATA ?? repoRoot,
  "Anti-Codex",
  "validation-artifacts",
  `gate5-event-report-${runLabel}.zip`,
));
const candidateAppDir = join(candidateRoot, "codex-patched-app");
const checks = [];
const turns = [];
const startedAt = new Date();
let harness = null;
let baselineProcesses = null;
let routeBefore = null;
let routeAfter = null;
let failure = null;
let artifact = null;
let projectRoot = null;

function addCheck(id, ok, evidence = null) {
  checks.push({ id, ok: Boolean(ok), evidence });
}

function recordTurn(name, run) {
  const summary = {
    name,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    threadId: run.threadId,
    commands: run.commands,
    fileChanges: run.fileChanges,
    messages: run.messages,
    stdoutTail: run.stdoutTail,
    stderrTail: run.stderrTail,
  };
  turns.push(summary);
  addCheck(`${name}_transport`, runIsHealthy(run), {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    nonZeroCommands: run.commands.filter((command) => command.exitCode !== 0),
    incompleteFileChanges: run.fileChanges.filter((change) => change.status !== "completed"),
  });
  return summary;
}

function runIsHealthy(run) {
  return run.exitCode === 0
    && !run.timedOut
    && !run.spawnError
    && !/409\s+Conflict|stale Anti-Codex request/i.test(`${run.stdoutTail}\n${run.stderrTail}`);
}

function hasChineseProgressBeforeTool(run) {
  const firstToolIndex = run.events.findIndex((event) => (
    ["command_execution", "file_change"].includes(event.item?.type)
  ));
  if (firstToolIndex < 0) return false;
  return run.events.slice(0, firstToolIndex).some((event) => (
    event.type === "item.completed"
    && event.item?.type === "agent_message"
    && /[\u3400-\u9fff]/u.test(String(event.item.text ?? ""))
  ));
}

async function runNodeTests(workspace) {
  const result = await runProcess(process.execPath, ["--test"], {
    cwd: workspace,
    env: process.env,
    timeoutMs: 180_000,
  });
  return {
    ok: result.code === 0 && !result.timedOut && !result.spawnError,
    exitCode: result.code,
    timedOut: result.timedOut,
    stdoutTail: tail(result.stdout, 5_000),
    stderrTail: tail(result.stderr, 3_000),
  };
}

async function runAcceptance(workspace, acceptanceRoot) {
  mkdirSync(acceptanceRoot, { recursive: true });
  const validPath = join(acceptanceRoot, "valid.jsonl");
  const invalidPath = join(acceptanceRoot, "invalid.jsonl");
  writeFileSync(validPath, [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", level: "info", service: "api", message: "boot", durationMs: 10 }),
    JSON.stringify({ timestamp: "2026-01-02T00:00:00.000Z", level: "warn", service: "worker", message: "slow", durationMs: 20 }),
    "",
    JSON.stringify({ timestamp: "2026-01-03T00:00:00.000Z", level: "error", service: "api", message: "failed", durationMs: 35 }),
    JSON.stringify({ timestamp: "2026-01-04T00:00:00.000Z", level: "info", service: "api", message: "recovered" }),
    "",
  ].join("\n"), "utf8");
  writeFileSync(invalidPath, [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", level: "info", service: "api", message: "ok" }),
    JSON.stringify({ level: "error", service: "api", message: "missing timestamp" }),
    "",
  ].join("\n"), "utf8");
  const cliPath = join(workspace, "src", "cli.mjs");
  const valid = await runProcess(process.execPath, [
    cliPath,
    validPath,
    "--format", "json",
    "--service", "api",
    "--since", "2026-01-01T00:00:00.000Z",
  ], { cwd: workspace, env: process.env, timeoutMs: 60_000 });
  let parsed = null;
  try { parsed = JSON.parse(valid.stdout); } catch {}
  const validShape = valid.code === 0
    && parsed?.total === 3
    && parsed?.byLevel?.error === 1
    && parsed?.byLevel?.info === 2
    && Object.keys(parsed?.byLevel ?? {}).join(",") === "error,info"
    && parsed?.byService?.api === 3
    && Object.keys(parsed?.byService ?? {}).join(",") === "api"
    && parsed?.averageDurationMs === 22.5
    && Array.isArray(parsed?.errors)
    && parsed.errors.length === 1
    && parsed.errors[0]?.message === "failed";
  const invalid = await runProcess(process.execPath, [cliPath, invalidPath, "--format", "json"], {
    cwd: workspace,
    env: process.env,
    timeoutMs: 60_000,
  });
  const invalidShape = invalid.code === 2
    && !String(invalid.stdout).trim()
    && /line\s+2/i.test(invalid.stderr);
  return {
    ok: validShape && invalidShape,
    valid: {
      ok: validShape,
      exitCode: valid.code,
      parsed,
      stdoutTail: tail(valid.stdout, 3_000),
      stderrTail: tail(valid.stderr, 2_000),
    },
    invalid: {
      ok: invalidShape,
      exitCode: invalid.code,
      stdoutTail: tail(invalid.stdout, 2_000),
      stderrTail: tail(invalid.stderr, 2_000),
    },
  };
}

function requiredProjectFiles(manifest) {
  const paths = new Set(manifest.map((entry) => entry.path));
  const required = [
    "package.json",
    "README.md",
    "src/cli.mjs",
    "src/read-events.mjs",
    "src/validate-event.mjs",
    "src/summarize.mjs",
    "src/filter.mjs",
    "src/format-json.mjs",
    "src/format-text.mjs",
    "src/errors.mjs",
    "test/read-events.test.mjs",
    "test/summarize.test.mjs",
    "test/cli.test.mjs",
  ];
  return { required, missing: required.filter((path) => !paths.has(path)) };
}

function resolveProjectRoot(workspace) {
  const candidates = [workspace, join(workspace, "event-report")]
    .filter((path) => existsSync(join(path, "package.json")));
  if (candidates.length !== 1) {
    throw new Error(`Expected one event-report project root, found ${candidates.length}.`);
  }
  return candidates[0];
}

function duplicateCommandEvidence(turnRows) {
  for (const turn of turnRows) {
    const counts = new Map();
    for (const command of turn.commands) {
      const key = String(command.command ?? "").trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    turn.commandCounts = [...counts.entries()]
      .map(([command, count]) => ({ command, count }))
      .sort((left, right) => right.count - left.count);
  }
  return turnRows
    .flatMap((turn) => turn.commandCounts.map((entry) => ({ turn: turn.name, ...entry })))
    .sort((left, right) => right.count - left.count);
}

function commandScopeViolations(turnRows) {
  const violations = [];
  const rules = [
    [/(?:^|[\\/])\.gemini[\\/]antigravity[\\/]brain(?:[\\/]|$)/i, "private_antigravity_history"],
    [/(?:^|[\\/])anticodex[\\/](?:reports|codex-home[^\\/]*|response-history\.json)(?:[\\/]|$)/i, "private_anticodex_runtime"],
    [/g:[\\/]trae-project[\\/]anti-codex[\\/]deepcodex(?:[\\/]|$)/i, "host_product_source"],
    [/(?:^|[\s'"`])\.\.[\\/]/i, "parent_directory_escape"],
  ];
  for (const turn of turnRows) {
    for (const entry of turn.commands) {
      const command = String(entry.command ?? "");
      for (const [pattern, reason] of rules) {
        if (pattern.test(command)) {
          violations.push({ turn: turn.name, reason, command: command.slice(0, 1_000) });
        }
      }
    }
  }
  return violations;
}

function desktopLaunchCommands(turnRows) {
  return turnRows.flatMap((turn) => turn.commands
    .filter((entry) => /\bStart-Process\b|\b(?:Anti-Codex|ChatGPT|codex-plus-plus)\.exe\b/i.test(String(entry.command ?? "")))
    .map((entry) => ({ turn: turn.name, command: entry.command })));
}

function archiveWorkspace(workspace, target) {
  mkdirSync(dirname(target), { recursive: true });
  const result = spawnSync("tar.exe", ["-a", "-c", "-f", target, "-C", workspace, "."], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.status !== 0 || !existsSync(target)) {
    return {
      ok: false,
      exitCode: result.status,
      stderr: tail(result.stderr, 2_000),
      path: target,
    };
  }
  const bytes = readFileSync(target);
  return { ok: true, path: target, bytes: bytes.length, sha256: sha256(bytes) };
}

async function main() {
  try {
    baselineProcesses = getProcessSnapshot(candidateAppDir);
    addCheck("candidate_not_already_running", baselineProcesses.candidateProcesses.length === 0, {
      processes: baselineProcesses.candidateProcesses,
    });
    if (baselineProcesses.candidateProcesses.length) throw new Error("Candidate process already running.");
    routeBefore = await fetchOldRouteFingerprint();
    addCheck("old_route_baseline_captured", true, routeBefore);

    harness = await createCodexPlusPlusAntigravityHarness({
      launcherPath,
      candidateRoot,
      model,
      timeoutMs: turnTimeoutMs,
    });
    addCheck("new_route_ready", harness.availableModelCount > 0 && harness.proxiedModelCount > 0, {
      model,
      availableModelCount: harness.availableModelCount,
      proxiedModelCount: harness.proxiedModelCount,
      selectedModel: harness.selectedModel,
      providerUrl: harness.providerUrl,
    });

    const simple = await harness.runInitial([
      "这是持续会话的第一轮。只运行一次 node --version，不要读取或写入任何文件，也不要调用其他工具。",
      "调用命令前先用一句中文说明你要做什么；命令结束后简短报告真实输出。",
    ].join(""));
    recordTurn("simple_command", simple);
    addCheck("simple_command_exactly_once", (
      simple.commands.length === 1
      && /node(?:\.exe)?\s+--version/i.test(simple.commands[0].command)
      && simple.commands[0].status === "completed"
      && simple.commands[0].exitCode === 0
      && simple.fileChanges.length === 0
      && treeManifest(harness.paths.workspace).length === 0
    ), { commands: simple.commands, fileChanges: simple.fileChanges });
    addCheck("simple_command_has_chinese_progress", hasChineseProgressBeforeTool(simple), {
      messages: simple.messages,
    });
    const sessionId = simple.threadId;
    addCheck("persistent_session_created", Boolean(sessionId), { sessionId });
    if (!sessionId) throw new Error("Codex did not return a persistent session ID.");

    const build = await harness.runResume(sessionId, [
      "继续同一个任务。请在当前目录创建一个依赖为零的 Node 20 ESM 项目 event-report，用来读取 JSONL 事件日志并生成摘要。",
      "每条非空行必须是对象，字段为 timestamp、level(info/warn/error)、service、message，durationMs 可选且必须为非负数。",
      "CLI 固定为 node src/cli.mjs <file> [--format json|text] [--level <level>]。无效 JSON 或字段要 stderr 输出 line N: 原因、退出码 2、stdout 为空。",
      "JSON 摘要固定包含 total、byLevel、byService、averageDurationMs、errors；errors 只列 error 的 timestamp/service/message。",
      "至少创建 package.json、README.md、src/cli.mjs、src/read-events.mjs、src/validate-event.mjs、src/summarize.mjs、src/filter.mjs、src/format-json.mjs、src/format-text.mjs、src/errors.mjs、test/read-events.test.mjs、test/summarize.test.mjs、test/cli.test.mjs。",
      "请写真实测试并运行 node --test，失败就根据真实输出修复。每次调用工具前先用一句中文说明下一步；不要启动桌面软件。",
    ].join(""), { timeoutMs: turnTimeoutMs });
    recordTurn("project_build", build);
    addCheck("project_build_has_chinese_progress", hasChineseProgressBeforeTool(build), {
      messages: build.messages,
    });
    projectRoot = resolveProjectRoot(harness.paths.workspace);
    const projectLayout = relative(harness.paths.workspace, projectRoot).replaceAll("\\", "/") || ".";
    addCheck("project_root_resolved", true, { layout: projectLayout });
    const workspaceBuildManifest = treeManifest(harness.paths.workspace);
    const unexpectedOutsideProject = projectLayout === "."
      ? []
      : workspaceBuildManifest.filter((entry) => !entry.path.startsWith(`${projectLayout}/`));
    addCheck("project_layout_has_no_unrelated_files", unexpectedOutsideProject.length === 0, {
      layout: projectLayout,
      unexpectedOutsideProject,
    });
    let buildTests = await runNodeTests(projectRoot);
    if (!buildTests.ok) {
      const repair = await harness.runResume(sessionId, [
        "宿主刚运行 node --test 失败。请根据下面真实输出定位并修复，只改当前项目，修完重新运行测试。调用工具前先中文说明。",
        `项目根目录：${projectLayout}`,
        `stdout:\n${buildTests.stdoutTail}\nstderr:\n${buildTests.stderrTail}`,
      ].join("\n"), { timeoutMs: turnTimeoutMs });
      recordTurn("project_build_repair", repair);
      buildTests = await runNodeTests(projectRoot);
    }
    addCheck("project_build_tests_pass", buildTests.ok, buildTests);
    const buildManifest = treeManifest(projectRoot);
    const required = requiredProjectFiles(buildManifest);
    addCheck("project_has_required_multifile_artifacts", buildManifest.length >= 13 && required.missing.length === 0, {
      fileCount: buildManifest.length,
      missing: required.missing,
      files: buildManifest,
    });

    const correction = await harness.runResume(sessionId, [
      "现在按用户纠正继续修改，不要重建项目：新增 --service <name> 与 --since <ISO>，两个过滤都在统计前生效，since 为包含边界；空行忽略。",
      "averageDurationMs 只统计有 durationMs 的记录并四舍五入到两位；byLevel 与 byService 只包含过滤后实际出现的键，不补零值键，键必须按字母升序；补齐测试和 README，运行 node --test。",
      "保持无依赖和原有 CLI 兼容。每次工具前先中文说明，完成后给出真实测试结果。",
    ].join(""), { timeoutMs: turnTimeoutMs });
    recordTurn("user_correction", correction);
    addCheck("user_correction_has_chinese_progress", hasChineseProgressBeforeTool(correction), {
      messages: correction.messages,
    });
    let correctionTests = await runNodeTests(projectRoot);
    let acceptance = await runAcceptance(projectRoot, harness.paths.acceptance);
    if (!correctionTests.ok || !acceptance.ok) {
      const repair = await harness.runResume(sessionId, [
        "宿主验收发现纠正项仍未全部通过。请只根据以下真实结果修复当前项目，禁止改验收输入；修复后运行 node --test。",
        `项目根目录：${projectLayout}`,
        `tests=${JSON.stringify(correctionTests)}`,
        `acceptance=${JSON.stringify(acceptance)}`,
      ].join("\n"), { timeoutMs: turnTimeoutMs });
      recordTurn("user_correction_repair", repair);
      correctionTests = await runNodeTests(projectRoot);
      acceptance = await runAcceptance(projectRoot, harness.paths.acceptance);
    }
    addCheck("corrected_project_tests_pass", correctionTests.ok, correctionTests);
    addCheck("host_acceptance_pass", acceptance.ok, acceptance);

    const beforeReadOnly = treeManifest(harness.paths.workspace);
    const readOnly = await harness.runResume(sessionId, [
      "最后做只读审查：查看当前实现并运行 node --test，检查是否还存在明显缺口。禁止编辑、创建、删除或格式化任何文件。",
      "发现缺口只报告，不执行修复。调用命令前先用一句中文说明；结论必须基于真实命令输出。",
    ].join(""), { timeoutMs: turnTimeoutMs });
    recordTurn("read_only_audit", readOnly);
    const afterReadOnly = treeManifest(harness.paths.workspace);
    addCheck("read_only_audit_zero_file_changes", (
      JSON.stringify(beforeReadOnly) === JSON.stringify(afterReadOnly)
      && readOnly.fileChanges.length === 0
      && readOnly.commands.length >= 1
    ), {
      before: beforeReadOnly,
      after: afterReadOnly,
      commands: readOnly.commands,
      fileChanges: readOnly.fileChanges,
    });
    addCheck("read_only_audit_has_chinese_progress", hasChineseProgressBeforeTool(readOnly), {
      messages: readOnly.messages,
    });
    const finalTests = await runNodeTests(projectRoot);
    addCheck("final_tests_pass", finalTests.ok, finalTests);

    const duplicates = duplicateCommandEvidence(turns);
    const loopViolations = duplicates.filter((entry) => {
      const maximum = /\bnpm\s+test\b|\bnode(?:\.exe)?\b[^\r\n]*\s--test\b/i.test(entry.command) ? 6 : 3;
      return entry.count > maximum;
    });
    addCheck("no_unbounded_duplicate_command_loop", loopViolations.length === 0, {
      violations: loopViolations,
      commandCounts: duplicates,
    });
    const scopeViolations = commandScopeViolations(turns);
    addCheck("commands_stay_inside_project_scope", scopeViolations.length === 0, { violations: scopeViolations });
    const launches = desktopLaunchCommands(turns);
    addCheck("headless_task_started_no_desktop_apps", launches.length === 0, { launches });
    addCheck("provider_turn_ownership", (
      harness.counters.start === turns.length
      && harness.counters.resume >= turns.length
      && harness.counters.cancel === 0
    ), {
      userTurns: turns.length,
      counters: { ...harness.counters },
    });

    artifact = archiveWorkspace(harness.paths.workspace, artifactPath);
    addCheck("verified_project_archived", artifact.ok, artifact);
    routeAfter = await fetchOldRouteFingerprint();
    addCheck("old_mixed_route_received_zero_requests", JSON.stringify(routeBefore) === JSON.stringify(routeAfter), {
      before: routeBefore,
      after: routeAfter,
    });
    const processesDuring = getProcessSnapshot(candidateAppDir);
    addCheck("original_codex_processes_unchanged", sameProcessRows(
      baselineProcesses.originalCodex,
      processesDuring.originalCodex,
    ), { before: baselineProcesses.originalCodex, after: processesDuring.originalCodex });
    addCheck("active_anticodex_root_unchanged", sameProcessRows(
      baselineProcesses.antiCodexRoots,
      processesDuring.antiCodexRoots,
    ), { before: baselineProcesses.antiCodexRoots, after: processesDuring.antiCodexRoots });
  } catch (error) {
    failure = {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    };
  } finally {
    const finalManifest = harness?.paths?.workspace && existsSync(harness.paths.workspace)
      ? treeManifest(harness.paths.workspace)
      : [];
    const counters = harness ? { ...harness.counters } : null;
    const observed = harness?.observed ?? null;
    await harness?.close?.({ removeRoot: true }).catch((error) => {
      addCheck("harness_cleanup", false, { error: error.message });
    });
    const cleanupSnapshot = baselineProcesses ? getProcessSnapshot(candidateAppDir) : null;
    if (cleanupSnapshot) {
      addCheck("cleanup_candidate_processes", cleanupSnapshot.candidateProcesses.length === 0, {
        remaining: cleanupSnapshot.candidateProcesses,
      });
      addCheck("original_codex_unchanged_after_cleanup", sameProcessRows(
        baselineProcesses.originalCodex,
        cleanupSnapshot.originalCodex,
      ), { before: baselineProcesses.originalCodex, after: cleanupSnapshot.originalCodex });
      addCheck("active_anticodex_unchanged_after_cleanup", sameProcessRows(
        baselineProcesses.antiCodexRoots,
        cleanupSnapshot.antiCodexRoots,
      ), { before: baselineProcesses.antiCodexRoots, after: cleanupSnapshot.antiCodexRoots });
    }
    if (routeBefore && !routeAfter) {
      try {
        routeAfter = await fetchOldRouteFingerprint();
        addCheck("old_route_unchanged_after_failure", JSON.stringify(routeBefore) === JSON.stringify(routeAfter), {
          before: routeBefore,
          after: routeAfter,
        });
      } catch (error) {
        addCheck("old_route_after_failure_captured", false, { error: error.message });
      }
    }

    const report = {
      schemaVersion: 1,
      generatedAtUtc: new Date().toISOString(),
      startedAtUtc: startedAt.toISOString(),
      ok: failure === null && checks.every((check) => check.ok),
      gate: "Gate 5 real Gemini persistent product task matrix",
      launchMode: "headless copied native Codex with persistent isolated session",
      model,
      launcherPath,
      candidateRoot,
      projectLayout: projectRoot && harness?.paths?.workspace
        ? (relative(harness.paths.workspace, projectRoot).replaceAll("\\", "/") || ".")
        : null,
      artifact,
      route: { before: routeBefore, after: routeAfter },
      counters,
      observed,
      finalManifest,
      turns,
      checks,
      failure,
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: report.ok,
      report: reportPath,
      artifact: artifact?.path ?? null,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).map((check) => check.id),
      turns: turns.map((turn) => turn.name),
      failure: failure?.message ?? null,
    })}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!key.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "end"}.`);
    }
    result.set(key, value);
    index += 1;
  }
  return result;
}

function resolveRequired(value, key) {
  if (!String(value ?? "").trim()) throw new Error(`${key} is required.`);
  return resolve(String(value));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tail(value, maximum) {
  const text = String(value ?? "");
  return text.length > maximum ? text.slice(-maximum) : text;
}

await main();
