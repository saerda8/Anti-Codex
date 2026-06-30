#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) continue;
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1";
  args.set(key, value);
}

const allowRealTraffic = args.has("--allow-real-traffic");
const dryRun = !allowRealTraffic;
const startedAt = Date.now();
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(args.get("--source-root") || join(scriptRoot, ".."));
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const uiSmokeScript = resolve(sourceRoot, "scripts", "test-anticodex-ui-chat-smoke.mjs");
const defaultTasks = ["exact-marker", "local-project", "repo-file-edit", "repo-multi-file-edit"];
const selectedTasks = String(args.get("--tasks") || defaultTasks.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const keepArtifacts = args.has("--keep-artifacts");
const taskReportExpectations = {
  "exact-marker": {
    file: "latest-ui-chat-smoke.json",
    expectedReportName: "ui-chat-smoke",
    expectedTaskMode: "exact-marker",
  },
  "local-project": {
    file: "latest-ui-local-project-smoke.json",
    expectedReportName: "ui-local-project-smoke",
    expectedTaskMode: "local-project",
  },
  "repo-file-edit": {
    file: "latest-ui-repo-file-edit-smoke.json",
    expectedReportName: "ui-repo-file-edit-smoke",
    expectedTaskMode: "repo-file-edit",
  },
  "repo-multi-file-edit": {
    file: "latest-ui-repo-multi-file-edit-smoke.json",
    expectedReportName: "ui-repo-multi-file-edit-smoke",
    expectedTaskMode: "repo-multi-file-edit",
  },
};
const perTaskReports = Object.fromEntries(
  Object.entries(taskReportExpectations).map(([taskMode, expectation]) => [taskMode, expectation.file]),
);

function timeoutForTask(taskMode) {
  if (args.has("--timeout-ms")) return Math.max(15_000, Number(args.get("--timeout-ms") || 0));
  if (taskMode === "repo-multi-file-edit") return 360_000;
  if (taskMode === "repo-file-edit") return 240_000;
  if (taskMode === "local-project") return 180_000;
  return 120_000;
}

function taskCommand(taskMode) {
  return [
    process.execPath,
    uiSmokeScript,
    "--task-mode",
    taskMode,
    "--timeout-ms",
    String(timeoutForTask(taskMode)),
  ];
}

function reportPathForTask(taskMode) {
  const name = perTaskReports[taskMode];
  return name ? resolve(reportRoot, name) : "";
}

function compactText(value, max = 4000) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...<truncated>` : text;
}

function parseChildPayload(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonLine = trimmed.split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));
    return jsonLine ? JSON.parse(jsonLine) : null;
  }
}

function auditLatestRealTaskEvidence() {
  const evidence = {};
  const failures = [];
  for (const taskMode of selectedTasks) {
    const expectation = taskReportExpectations[taskMode];
    if (!expectation) {
      failures.push(`${taskMode}_latest_real_report_expectation_missing`);
      evidence[taskMode] = {
        taskMode,
        ok: false,
        failure: "latest_real_report_expectation_missing",
      };
      continue;
    }

    const reportPath = resolve(reportRoot, expectation.file);
    const item = {
      taskMode,
      reportPath,
      expectedReportName: expectation.expectedReportName,
      expectedTaskMode: expectation.expectedTaskMode,
      present: existsSync(reportPath),
      parseable: false,
      ok: false,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      reportName: "",
      actualTaskMode: "",
      coverageKind: "",
      markerPresent: false,
      elapsedMs: null,
      mtime: null,
      failures: [],
    };
    if (!item.present) {
      item.failures.push("latest_real_report_missing");
    } else {
      try {
        const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
        item.parseable = true;
        item.ok = parsed.ok === true;
        item.requestedRealTraffic = parsed.requestedRealTraffic === true;
        item.usedRealTraffic = parsed.usedRealTraffic === true;
        item.reportName = String(parsed.reportName || "");
        item.actualTaskMode = String(parsed.taskMode || "");
        item.coverageKind = String(parsed.coverageKind || "");
        item.markerPresent = typeof parsed.marker === "string" && parsed.marker.length > 0;
        item.elapsedMs = Number.isFinite(Number(parsed.elapsedMs)) ? Number(parsed.elapsedMs) : null;
        item.mtime = statSync(reportPath).mtime.toISOString();
        if (!item.ok) item.failures.push("latest_real_report_not_ok");
        if (!item.requestedRealTraffic) item.failures.push("latest_real_report_not_requested_real_traffic");
        if (!item.usedRealTraffic) item.failures.push("latest_real_report_not_used_real_traffic");
        if (item.reportName !== expectation.expectedReportName) item.failures.push("latest_real_report_name_mismatch");
        if (item.actualTaskMode !== expectation.expectedTaskMode) item.failures.push("latest_real_report_task_mode_mismatch");
      } catch (error) {
        item.failures.push(`latest_real_report_unparseable:${error.message}`);
      }
    }
    if (item.failures.length > 0) {
      failures.push(...item.failures.map((failure) => `${taskMode}_${failure}`));
    }
    evidence[taskMode] = item;
  }
  return {
    complete: failures.length === 0,
    failures,
    evidence,
  };
}

function gitStatusForFixturePaths() {
  const child = spawnSync("git", [
    "status",
    "--porcelain",
    "--",
    "scripts/fixtures/desktop-coworker-live",
    "scripts/fixtures/desktop-coworker-project",
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  if (child.status !== 0) return { ok: false, output: compactText(child.stderr || child.stdout) };
  return { ok: true, output: String(child.stdout || "").trim() };
}

function cleanupFixtureArtifacts() {
  if (keepArtifacts) return { skipped: true, reason: "keep-artifacts" };
  const restored = spawnSync("git", [
    "restore",
    "--",
    "scripts/fixtures/desktop-coworker-live/acceptance-target.mjs",
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  const generated = [
    "scripts/fixtures/desktop-coworker-project/README.md",
    "scripts/fixtures/desktop-coworker-project/status-dashboard.html",
    "scripts/fixtures/desktop-coworker-project/status-dashboard.mjs",
    "scripts/fixtures/desktop-coworker-project/status-dashboard.test.mjs",
    "scripts/fixtures/desktop-coworker-project/status-data.json",
  ];
  const removed = [];
  for (const file of generated) {
    const path = resolve(sourceRoot, file);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(file);
  }
  return {
    skipped: false,
    gitRestoreOk: restored.status === 0,
    gitRestoreOutput: compactText(restored.stderr || restored.stdout),
    removed,
  };
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-desktop-task-suite.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-desktop-task-suite.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `${createHash("sha256").update(json).digest("hex")}\n`, "ascii");
  }
  return { latest, history };
}

function runTask(taskMode) {
  const command = taskCommand(taskMode);
  if (dryRun) {
    return {
      taskMode,
      ok: true,
      skipped: true,
      command: command.map((part) => String(part)),
      reportPath: reportPathForTask(taskMode),
    };
  }
  const before = gitStatusForFixturePaths();
  if (!before.ok || (before.output && !args.has("--allow-dirty-fixtures"))) {
    return {
      taskMode,
      ok: false,
      skipped: false,
      command: command.map((part) => String(part)),
      reportPath: reportPathForTask(taskMode),
      failure: "fixture_paths_not_clean_before_task",
      fixtureStatus: before,
    };
  }
  const started = Date.now();
  const child = spawnSync(process.execPath, command.slice(1), {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: timeoutForTask(taskMode) + 60_000,
    windowsHide: true,
  });
  const parsed = parseChildPayload(child.stdout);
  const cleanup = taskMode.startsWith("repo-") ? cleanupFixtureArtifacts() : null;
  return {
    taskMode,
    ok: child.status === 0 && parsed?.ok === true,
    skipped: false,
    command: command.map((part) => String(part)),
    reportPath: reportPathForTask(taskMode),
    exitCode: child.status,
    signal: child.signal,
    elapsedMs: Date.now() - started,
    reportName: parsed?.reportName || "",
    marker: parsed?.marker || "",
    failures: Array.isArray(parsed?.failures) ? parsed.failures : [],
    stdout: child.status === 0 ? "" : compactText(child.stdout),
    stderr: compactText(child.stderr),
    cleanup,
  };
}

const tasks = [];
for (const task of selectedTasks) {
  tasks.push(runTask(task));
}

const failures = [];
if (!existsSync(uiSmokeScript)) failures.push("ui_smoke_script_missing");
for (const task of tasks) {
  if (task.ok !== true) failures.push(`${task.taskMode}_failed`);
}
const realTaskAudit = auditLatestRealTaskEvidence();

const payload = {
  ok: failures.length === 0,
  reportName: "desktop-task-suite",
  requestedRealTraffic: allowRealTraffic,
  usedRealTraffic: allowRealTraffic && !dryRun,
  mode: dryRun ? "dry-run" : "real-traffic",
  dryRun,
  behaviorCovered: true,
  coverageKind: dryRun ? "desktop-task-suite-dry-run" : "desktop-task-suite-real-traffic",
  sourceRoot,
  reportRoot,
  selectedTasks,
  perTaskReports,
  tasks,
  latestRealTaskEvidence: realTaskAudit.evidence,
  realTaskEvidenceComplete: realTaskAudit.complete,
  realTaskEvidenceFailures: realTaskAudit.failures,
  failures,
  elapsedMs: Date.now() - startedAt,
};

const report = writeReport(payload);
console.log(JSON.stringify({ ...payload, report }));
if (!payload.ok) process.exit(1);
