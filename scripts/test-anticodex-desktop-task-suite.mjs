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
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-desktop-task-suite.mjs [options]

Options:
  --allow-real-traffic     Run tasks with real traffic (default: dry-run)
  --suite-profile <name>   Profile: core, agentic, extended, all (default: core)
  --tasks <list>           Comma-separated task modes to run
  --source-root <path>     Root of source tree
  --report-root <path>     Directory for report output
  --timeout-ms <ms>        Override per-task timeout
  --max-real-evidence-age-hours <h>  Max age for real evidence (default: 24)
  --no-write-report        Print JSON without writing latest/history reports
  --keep-artifacts         Do not clean fixture artifacts after repo tasks
  --allow-dirty-fixtures   Skip dirty-fixture check before tasks
  --help, -h               Show this help message`);
    process.exit(0);
  }
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
const suiteProfile = String(args.get("--suite-profile") || "core").toLowerCase();
const coreTasks = ["exact-marker", "local-project", "repo-file-edit", "repo-multi-file-edit"];
const agenticTasks = ["coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit"];
const extendedTasks = ["exact-marker", "local-project", "repo-file-edit", "repo-multi-file-edit", "web-search", "coding-project", "multi-turn-project", "report-site", "complex-project"];
const allTasks = ["exact-marker", "free-chat", "web-search", "local-project", "coding-project", "multi-turn-project", "complex-project", "report-site", "repo-file-edit", "repo-multi-file-edit"];
const defaultTasks = suiteProfile === "all"
  ? allTasks
  : suiteProfile === "agentic"
    ? agenticTasks
  : suiteProfile === "extended"
    ? extendedTasks
    : coreTasks;
const selectedTasks = String(args.get("--tasks") || defaultTasks.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const noWriteReport = args.has("--no-write-report");
const keepArtifacts = args.has("--keep-artifacts");
const realTrafficApprovalReason = "real_traffic_required";
const maxRealEvidenceAgeHours = Math.max(1, Number(args.get("--max-real-evidence-age-hours") || 24));
const maxRealEvidenceAgeMs = maxRealEvidenceAgeHours * 60 * 60 * 1000;
const taskReportExpectations = {
  "exact-marker": {
    file: "latest-ui-chat-smoke.json",
    expectedReportName: "ui-chat-smoke",
    expectedTaskMode: "exact-marker",
  },
  "free-chat": {
    file: "latest-ui-free-chat-smoke.json",
    expectedReportName: "ui-free-chat-smoke",
    expectedTaskMode: "free-chat",
  },
  "web-search": {
    file: "latest-ui-web-search-smoke.json",
    expectedReportName: "ui-web-search-smoke",
    expectedTaskMode: "web-search",
  },
  "local-project": {
    file: "latest-ui-local-project-smoke.json",
    expectedReportName: "ui-local-project-smoke",
    expectedTaskMode: "local-project",
  },
  "coding-project": {
    file: "latest-ui-coding-project-smoke.json",
    expectedReportName: "ui-coding-project-smoke",
    expectedTaskMode: "coding-project",
  },
  "multi-turn-project": {
    file: "latest-ui-multi-turn-project-smoke.json",
    expectedReportName: "ui-multi-turn-project-smoke",
    expectedTaskMode: "multi-turn-project",
  },
  "report-site": {
    file: "latest-ui-report-site-smoke.json",
    expectedReportName: "ui-report-site-smoke",
    expectedTaskMode: "report-site",
  },
  "complex-project": {
    file: "latest-ui-complex-project-smoke.json",
    expectedReportName: "ui-complex-project-smoke",
    expectedTaskMode: "complex-project",
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
const taskScenarioCatalog = {
  "exact-marker": {
    taskMode: "exact-marker",
    workType: "chat-contract",
    profileCoverage: ["core", "extended", "all"],
    requiresWeb: false,
    mutatesRepoFixture: false,
    expectedEvidence: ["assistant-reply-marker", "latest-ui-chat-smoke-report"],
    reportFile: perTaskReports["exact-marker"],
  },
  "free-chat": {
    taskMode: "free-chat",
    workType: "open-ended-chat",
    profileCoverage: ["all"],
    requiresWeb: false,
    mutatesRepoFixture: false,
    expectedEvidence: ["assistant-reply-marker", "latest-ui-free-chat-smoke-report"],
    reportFile: perTaskReports["free-chat"],
  },
  "web-search": {
    taskMode: "web-search",
    workType: "web-research-answer",
    profileCoverage: ["extended", "all"],
    requiresWeb: true,
    mutatesRepoFixture: false,
    expectedEvidence: ["assistant-reply-marker", "source-url-answer", "latest-ui-web-search-smoke-report"],
    reportFile: perTaskReports["web-search"],
  },
  "local-project": {
    taskMode: "local-project",
    workType: "local-artifact-creation",
    profileCoverage: ["core", "extended", "all"],
    requiresWeb: false,
    mutatesRepoFixture: false,
    expectedEvidence: ["index-html", "readme-md", "done-marker"],
    reportFile: perTaskReports["local-project"],
  },
  "coding-project": {
    taskMode: "coding-project",
    workType: "new-node-cli-project",
    profileCoverage: ["agentic", "extended", "all"],
    requiresWeb: false,
    mutatesRepoFixture: false,
    expectedEvidence: ["package-json", "node-test-passed", "cli-output-verified", "done-marker"],
    reportFile: perTaskReports["coding-project"],
  },
  "multi-turn-project": {
    taskMode: "multi-turn-project",
    workType: "multi-turn-project-continuation",
    profileCoverage: ["agentic", "extended", "all"],
    requiresWeb: false,
    mutatesRepoFixture: false,
    expectedEvidence: ["first-turn-marker", "followup-marker", "changelog-marker", "node-test-passed"],
    reportFile: perTaskReports["multi-turn-project"],
  },
  "report-site": {
    taskMode: "report-site",
    workType: "web-backed-report-site",
    profileCoverage: ["agentic", "extended", "all"],
    requiresWeb: true,
    mutatesRepoFixture: false,
    expectedEvidence: ["report-md", "index-html", "three-source-urls", "done-marker"],
    reportFile: perTaskReports["report-site"],
  },
  "complex-project": {
    taskMode: "complex-project",
    workType: "web-backed-tested-dashboard-project",
    profileCoverage: ["agentic", "extended", "all"],
    requiresWeb: true,
    mutatesRepoFixture: false,
    expectedEvidence: ["sources-json", "analyzer-test-passed", "cli-output-verified", "report-md", "index-html"],
    reportFile: perTaskReports["complex-project"],
  },
  "repo-file-edit": {
    taskMode: "repo-file-edit",
    workType: "single-file-repo-test-fix",
    profileCoverage: ["core", "extended", "all"],
    requiresWeb: false,
    mutatesRepoFixture: true,
    expectedEvidence: ["target-source-changed", "acceptance-test-passed", "fixture-cleanup"],
    reportFile: perTaskReports["repo-file-edit"],
  },
  "repo-multi-file-edit": {
    taskMode: "repo-multi-file-edit",
    workType: "two-step-multi-file-repo-task",
    profileCoverage: ["core", "agentic", "extended", "all"],
    requiresWeb: false,
    mutatesRepoFixture: true,
    expectedEvidence: ["readme-created", "source-changed", "test-passed", "cli-output-verified", "offline-html"],
    reportFile: perTaskReports["repo-multi-file-edit"],
  },
};

function timeoutForTask(taskMode) {
  if (args.has("--timeout-ms")) return Math.max(15_000, Number(args.get("--timeout-ms") || 0));
  if (taskMode === "repo-multi-file-edit") return 360_000;
  if (taskMode === "repo-file-edit") return 240_000;
  if (taskMode === "multi-turn-project") return 240_000;
  if (taskMode === "complex-project") return 240_000;
  if (taskMode === "local-project" || taskMode === "coding-project" || taskMode === "report-site" || taskMode === "web-search") return 180_000;
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
  const hardFailures = [];
  const freshnessFailures = [];
  for (const taskMode of selectedTasks) {
    const expectation = taskReportExpectations[taskMode];
    if (!expectation) {
      hardFailures.push(`${taskMode}_latest_real_report_expectation_missing`);
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
      ageMs: null,
      maxAgeMs: maxRealEvidenceAgeMs,
      fresh: false,
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
        const reportStat = statSync(reportPath);
        item.mtime = reportStat.mtime.toISOString();
        item.ageMs = Math.max(0, Date.now() - reportStat.mtimeMs);
        item.fresh = item.ageMs <= maxRealEvidenceAgeMs;
        if (!item.ok) item.failures.push("latest_real_report_not_ok");
        if (!item.requestedRealTraffic) item.failures.push("latest_real_report_not_requested_real_traffic");
        if (!item.usedRealTraffic) item.failures.push("latest_real_report_not_used_real_traffic");
        if (item.reportName !== expectation.expectedReportName) item.failures.push("latest_real_report_name_mismatch");
        if (item.actualTaskMode !== expectation.expectedTaskMode) item.failures.push("latest_real_report_task_mode_mismatch");
        if (!item.fresh) item.failures.push("latest_real_report_stale");
      } catch (error) {
        item.failures.push(`latest_real_report_unparseable:${error.message}`);
      }
    }
    if (item.failures.length > 0) {
      for (const failure of item.failures) {
        const scopedFailure = `${taskMode}_${failure}`;
        if (failure === "latest_real_report_stale") freshnessFailures.push(scopedFailure);
        else hardFailures.push(scopedFailure);
      }
    }
    evidence[taskMode] = item;
  }
  return {
    complete: hardFailures.length === 0,
    fresh: freshnessFailures.length === 0,
    failures: [...hardFailures, ...freshnessFailures],
    hardFailures,
    freshnessFailures,
    evidence,
  };
}

function taskModesFromFailures(failures) {
  const modes = [];
  const seen = new Set();
  for (const failure of failures) {
    const text = String(failure || "");
    const marker = "_latest_real_report_";
    const index = text.indexOf(marker);
    if (index <= 0) continue;
    const taskMode = text.slice(0, index);
    if (!taskMode || seen.has(taskMode)) continue;
    seen.add(taskMode);
    modes.push(taskMode);
  }
  return modes;
}

function quoteCommandPart(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

function buildRealTaskEvidenceRefreshPlan(realTaskAudit) {
  const hardFailureTaskModes = taskModesFromFailures(realTaskAudit.hardFailures);
  const staleTaskModes = taskModesFromFailures(realTaskAudit.freshnessFailures);
  const refreshTaskModes = [...new Set([...hardFailureTaskModes, ...staleTaskModes])];
  const canUseSuiteProfile = refreshTaskModes.length === selectedTasks.length
    && refreshTaskModes.every((taskMode) => selectedTasks.includes(taskMode))
    && !args.has("--tasks");
  const command = [
    process.execPath,
    resolve(sourceRoot, "scripts", "test-anticodex-desktop-task-suite.mjs"),
    "--suite-profile",
    suiteProfile,
  ];
  if (!canUseSuiteProfile && refreshTaskModes.length > 0) {
    command.push("--tasks", refreshTaskModes.join(","));
  }
  command.push("--allow-real-traffic");
  const requiresApproval = refreshTaskModes.length > 0;
  return {
    needed: refreshTaskModes.length > 0,
    requiresExplicitUserApproval: requiresApproval,
    approvalReason: requiresApproval ? realTrafficApprovalReason : "",
    commandPreview: command.map(quoteCommandPart).join(" "),
    commandArgs: [...command],
    approvalSummary: {
      requiresExplicitUserApproval: requiresApproval,
      approvalReason: requiresApproval ? realTrafficApprovalReason : "",
      taskCount: refreshTaskModes.length,
      refreshTaskModes,
      hardFailureTaskModes,
      staleTaskModes,
    },
    refreshTaskModes,
    hardFailureTaskModes,
    staleTaskModes,
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
const realTaskEvidenceRefreshPlan = buildRealTaskEvidenceRefreshPlan(realTaskAudit);

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
  suiteProfile,
  selectedTasks,
  perTaskReports,
  taskScenarioCatalog,
  selectedTaskScenarios: Object.fromEntries(selectedTasks.map((taskMode) => [taskMode, taskScenarioCatalog[taskMode] || null])),
  tasks,
  maxRealEvidenceAgeHours,
  latestRealTaskEvidence: realTaskAudit.evidence,
  realTaskEvidenceComplete: realTaskAudit.complete,
  realTaskEvidenceFresh: realTaskAudit.fresh,
  realTaskEvidenceFailures: realTaskAudit.failures,
  realTaskEvidenceHardFailures: realTaskAudit.hardFailures,
  realTaskEvidenceFreshnessFailures: realTaskAudit.freshnessFailures,
  realTaskEvidenceRefreshPlan,
  failures,
  elapsedMs: Date.now() - startedAt,
};

if (noWriteReport) {
  console.log(JSON.stringify({
    ...payload,
    report: {
      skipped: true,
      noWriteReport: true,
      latest: "",
      history: "",
    },
  }));
} else {
  const report = writeReport(payload);
  console.log(JSON.stringify({ ...payload, report }));
}
if (!payload.ok) process.exit(1);
