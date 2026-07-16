#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  createCodexPlusPlusAntigravityHarness,
  fetchOldRouteFingerprint,
  getProcessSnapshot,
  sameProcessRows,
  sha256,
  treeManifest,
} from "./lib/codexplusplus-antigravity-harness.mjs";

const root = resolve(import.meta.dirname, "..");
const compact = process.argv.includes("--compact");
const launcherPath = resolveRequired(argumentValue("--launcher"), "--launcher");
const candidateRoot = resolve(argumentValue("--candidate-root")
  || join(process.env.LOCALAPPDATA || "", "Anti-Codex", "update-candidate"));
const candidateAppDir = join(candidateRoot, "codex-patched-app");
const model = argumentValue("--model") || "gemini-3.5-flash-low";
const crashAfterMs = positiveInteger(argumentValue("--crash-after-ms"), 45_000);
const resumeTimeoutMs = positiveInteger(argumentValue("--resume-timeout-ms"), 300_000);
const reportPath = resolve(root, "docs", "audits", "2026-07-15-gate6-client-restart-resume.json");
const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const completeMarker = `CLIENT_RESTART_RESUME_OK_${runId}`;
const artifactPath = resolve(
  process.env.LOCALAPPDATA || root,
  "Anti-Codex",
  "validation-artifacts",
  `gate6-client-restart-${runId}.zip`,
);
const checks = [];
let harness = null;
let initial = null;
let resumed = null;
let failure = null;
let routeBefore = null;
let routeAfter = null;
let archive = null;
let countBeforeResume = null;
let countAfterResume = null;
let markerHashBeforeResume = null;
let markerHashAfterResume = null;
const baseline = getProcessSnapshot(candidateAppDir);

function record(id, ok, detail = {}) {
  checks.push({ id, ok: ok === true, ...detail });
}

try {
  record("candidate_not_running", baseline.candidateProcesses.length === 0, {
    processes: baseline.candidateProcesses,
  });
  if (baseline.candidateProcesses.length) throw new Error("A copied candidate process is already running.");
  routeBefore = await fetchOldRouteFingerprint();
  record("old_route_baseline_captured", true, routeBefore);

  harness = await createCodexPlusPlusAntigravityHarness({
    launcherPath,
    candidateRoot,
    model,
    timeoutMs: resumeTimeoutMs,
  });
  record("headless_route_ready", harness.launchMode === "headless copied native Codex"
    && harness.availableModelCount > 0
    && harness.proxiedModelCount > 0, {
    launchMode: harness.launchMode,
    providerUrl: harness.providerUrl,
    availableModelCount: harness.availableModelCount,
    proxiedModelCount: harness.proxiedModelCount,
  });

  const onceScript = join(harness.paths.workspace, "once-action.mjs");
  writeFileSync(onceScript, [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'const countPath = "action-count.txt";',
    'const current = existsSync(countPath) ? Number(readFileSync(countPath, "utf8").trim()) || 0 : 0;',
    'writeFileSync(countPath, `${current + 1}\\n`, "utf8");',
    `writeFileSync("action-marker.txt", "ACTION_ONCE_${runId}\\n", "utf8");`,
    'process.stdout.write(`execution-count=${current + 1}\\n`);',
    "",
  ].join("\n"), "utf8");

  initial = await harness.runInitial([
    "这是客户端中断与同任务续跑验收。严格按顺序执行，不要并行，也不要启动桌面程序。",
    "先用一句中文说明，然后只运行一次 `node once-action.mjs`，不得再次运行这条命令。",
    "确认第一条命令结束后，再运行 `node -e \"setTimeout(() => {}, 120000)\"`，必须前台等待，不得改成后台进程。",
    "长命令结束前不要创建 resume-complete.txt。",
  ].join("\n"), { timeoutMs: crashAfterMs });

  const countPath = join(harness.paths.workspace, "action-count.txt");
  const markerPath = join(harness.paths.workspace, "action-marker.txt");
  countBeforeResume = readInteger(countPath);
  markerHashBeforeResume = existsSync(markerPath) ? sha256(readFileSync(markerPath)) : null;
  record("client_was_interrupted_after_completed_action", initial.timedOut === true
    && Boolean(initial.threadId)
    && countBeforeResume === 1
    && markerHashBeforeResume !== null, {
    crashAfterMs,
    timedOut: initial.timedOut,
    exitCode: initial.exitCode,
    signal: initial.signal,
    threadId: initial.threadId,
    countBeforeResume,
    commands: initial.commands,
    messages: initial.messages,
  });
  if (!initial.threadId || countBeforeResume !== 1) {
    throw new Error("The interrupted turn did not persist one completed action and a resumable thread ID.");
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  resumed = await harness.runResume(initial.threadId, [
    "刚才的客户端进程在长等待命令期间被测试器中断。现在继续同一个任务。",
    "不要再次运行 once-action.mjs，也不要再次运行长等待命令；已完成动作必须保持一次。",
    `只创建 resume-complete.txt，内容必须精确为 ${completeMarker} 加换行，然后运行一个快速只读命令确认 action-count.txt 仍为 1。`,
    "调用工具前先用一句中文说明。",
  ].join("\n"), { timeoutMs: resumeTimeoutMs });

  countAfterResume = readInteger(countPath);
  markerHashAfterResume = existsSync(markerPath) ? sha256(readFileSync(markerPath)) : null;
  const completePath = join(harness.paths.workspace, "resume-complete.txt");
  const completeText = existsSync(completePath) ? readFileSync(completePath, "utf8") : "";
  const resumeTransportText = `${resumed.stdoutTail}\n${resumed.stderrTail}`;
  record("same_task_resumed_in_fresh_client", resumed.exitCode === 0
    && resumed.timedOut === false
    && resumed.threadId === initial.threadId
    && !/409\s+Conflict|stale Anti-Codex request/i.test(resumeTransportText), {
    initialThreadId: initial.threadId,
    resumedThreadId: resumed.threadId,
    exitCode: resumed.exitCode,
    timedOut: resumed.timedOut,
    stderrTail: resumed.stderrTail,
  });
  record("completed_action_not_replayed", countAfterResume === 1
    && markerHashAfterResume === markerHashBeforeResume, {
    countBeforeResume,
    countAfterResume,
    markerHashBeforeResume,
    markerHashAfterResume,
  });
  record("resumed_task_created_exact_result", completeText === `${completeMarker}\n`, {
    expected: `${completeMarker}\n`,
    actual: completeText,
  });

  routeAfter = await fetchOldRouteFingerprint();
  record("old_route_received_zero_requests", JSON.stringify(routeBefore) === JSON.stringify(routeAfter), {
    before: routeBefore,
    after: routeAfter,
  });
  const during = getProcessSnapshot(candidateAppDir);
  record("desktop_roots_unchanged", sameProcessRows(baseline.originalCodex, during.originalCodex)
    && sameProcessRows(baseline.antiCodexRoots, during.antiCodexRoots), {
    before: baseline,
    after: during,
  });
  archive = archiveWorkspace(harness.paths.workspace, artifactPath);
  record("restart_workspace_archived", archive.ok, archive);
} catch (error) {
  failure = {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error),
    stack: String(error?.stack ?? ""),
  };
} finally {
  const finalManifest = harness?.paths?.workspace && existsSync(harness.paths.workspace)
    ? treeManifest(harness.paths.workspace)
    : [];
  const counters = harness ? { ...harness.counters } : null;
  await harness?.close?.({ removeRoot: true }).catch((error) => {
    record("harness_cleanup", false, { error: String(error?.message ?? error) });
  });
  const cleanup = getProcessSnapshot(candidateAppDir);
  record("candidate_cleanup_complete", cleanup.candidateProcesses.length === 0, {
    remaining: cleanup.candidateProcesses,
  });
  record("desktop_roots_unchanged_after_cleanup", sameProcessRows(baseline.originalCodex, cleanup.originalCodex)
    && sameProcessRows(baseline.antiCodexRoots, cleanup.antiCodexRoots), {
    before: baseline,
    after: cleanup,
  });
  if (routeBefore && !routeAfter) {
    try {
      routeAfter = await fetchOldRouteFingerprint();
      record("old_route_unchanged_after_failure", JSON.stringify(routeBefore) === JSON.stringify(routeAfter), {
        before: routeBefore,
        after: routeAfter,
      });
    } catch (error) {
      record("old_route_after_failure_captured", false, { error: String(error?.message ?? error) });
    }
  }

  const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
  const report = {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    gate: "Gate 6 copied-client crash/restart and same-task resume preparatory evidence",
    ok: failure === null && failedIds.length === 0,
    failedIds,
    formalGateAdvanced: false,
    launchMode: "headless copied native Codex",
    model,
    runId,
    failure,
    thread: {
      initialId: initial?.threadId ?? null,
      resumedId: resumed?.threadId ?? null,
      initialTimedOut: initial?.timedOut ?? null,
      resumeExitCode: resumed?.exitCode ?? null,
    },
    exactlyOnce: {
      countBeforeResume,
      countAfterResume,
      markerHashBeforeResume,
      markerHashAfterResume,
    },
    counters,
    artifact: archive,
    finalManifest,
    turns: {
      initial: summarizeTurn(initial),
      resumed: summarizeTurn(resumed),
    },
    checks,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(compact ? {
    ok: report.ok,
    failedIds,
    failure,
    thread: report.thread,
    exactlyOnce: report.exactlyOnce,
    counters,
    artifact: archive,
    reportPath,
  } : report, null, compact ? 0 : 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function summarizeTurn(turn) {
  if (!turn) return null;
  return {
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
      path: target,
      exitCode: result.status,
      stderr: String(result.stderr ?? "").slice(-2_000),
    };
  }
  const bytes = readFileSync(target);
  return { ok: true, path: target, bytes: bytes.length, sha256: sha256(bytes) };
}

function readInteger(path) {
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(value) ? value : null;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRequired(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return resolve(text);
}
