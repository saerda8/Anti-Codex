#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function argValue(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const defaultReportRoot = process.env.APPDATA
  ? resolve(process.env.APPDATA, "anticodex", "reports")
  : resolve(process.cwd(), ".anticodex-reports");
const reportRoot = resolve(argValue("--report-root", defaultReportRoot));
const maxAgeHours = Number(argValue("--max-age-hours", "24"));
const maxAgeMs = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
const startedAt = Date.now();

const taskReportExpectations = {
  "exact-marker": ["latest-ui-chat-smoke.json", "ui-chat-smoke"],
  "free-chat": ["latest-ui-free-chat-smoke.json", "ui-free-chat-smoke"],
  "web-search": ["latest-ui-web-search-smoke.json", "ui-web-search-smoke"],
  "local-project": ["latest-ui-local-project-smoke.json", "ui-local-project-smoke"],
  "coding-project": ["latest-ui-coding-project-smoke.json", "ui-coding-project-smoke"],
  "multi-turn-project": ["latest-ui-multi-turn-project-smoke.json", "ui-multi-turn-project-smoke"],
  "report-site": ["latest-ui-report-site-smoke.json", "ui-report-site-smoke"],
  "complex-project": ["latest-ui-complex-project-smoke.json", "ui-complex-project-smoke"],
  "repo-file-edit": ["latest-ui-repo-file-edit-smoke.json", "ui-repo-file-edit-smoke"],
  "repo-multi-file-edit": ["latest-ui-repo-multi-file-edit-smoke.json", "ui-repo-multi-file-edit-smoke"],
};

const requiredProfiles = {
  core: ["exact-marker", "local-project", "repo-file-edit", "repo-multi-file-edit"],
  agentic: ["coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit"],
  extended: ["exact-marker", "local-project", "repo-file-edit", "repo-multi-file-edit", "web-search", "coding-project", "multi-turn-project", "report-site", "complex-project"],
  all: ["exact-marker", "free-chat", "web-search", "local-project", "coding-project", "multi-turn-project", "complex-project", "report-site", "repo-file-edit", "repo-multi-file-edit"],
};

function readReport(taskMode) {
  const [file, expectedReportName] = taskReportExpectations[taskMode];
  const path = resolve(reportRoot, file);
  if (!existsSync(path)) {
    return { taskMode, file, expectedReportName, present: false, parseable: false, ok: false, fresh: false, requestedRealTraffic: false, usedRealTraffic: false, failures: ["report_missing"] };
  }
  const ageMs = Date.now() - statSync(path).mtimeMs;
  try {
    const report = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    const failures = [];
    if (ageMs > maxAgeMs) failures.push("report_stale");
    if (report.ok !== true) failures.push("report_not_ok");
    if (report.reportName !== expectedReportName) failures.push("report_name_mismatch");
    if (report.taskMode !== taskMode) failures.push("task_mode_mismatch");
    if (report.requestedRealTraffic !== true) failures.push("real_traffic_not_requested");
    if (report.usedRealTraffic !== true) failures.push("real_traffic_not_used");
    if (Array.isArray(report.failures) && report.failures.length > 0) failures.push("report_has_failures");
    return {
      taskMode,
      file,
      expectedReportName,
      reportName: String(report.reportName || ""),
      present: true,
      parseable: true,
      ok: failures.length === 0,
      fresh: ageMs <= maxAgeMs,
      requestedRealTraffic: report.requestedRealTraffic === true,
      usedRealTraffic: report.usedRealTraffic === true,
      ageMs,
      maxAgeMs,
      failures,
    };
  } catch (error) {
    return { taskMode, file, expectedReportName, present: true, parseable: false, ok: false, fresh: false, requestedRealTraffic: false, usedRealTraffic: false, failures: [`report_unparseable:${error.message}`] };
  }
}

const taskEvidence = Object.fromEntries(Object.keys(taskReportExpectations).map((taskMode) => [taskMode, readReport(taskMode)]));

function profileStatus(profile, tasks) {
  const entries = tasks.map((taskMode) => taskEvidence[taskMode]);
  const missingTasks = entries.filter((entry) => !entry.present).map((entry) => entry.taskMode);
  const staleTasks = entries.filter((entry) => entry.present && entry.fresh !== true).map((entry) => entry.taskMode);
  const failedTasks = entries.filter((entry) => entry.present && entry.ok !== true).map((entry) => entry.taskMode);
  const refreshTasks = [...new Set([...missingTasks, ...staleTasks, ...failedTasks])];
  return {
    profile,
    selectedTasks: tasks,
    taskCount: tasks.length,
    okTaskCount: entries.filter((entry) => entry.ok === true).length,
    complete: missingTasks.length === 0,
    fresh: staleTasks.length === 0,
    allOk: refreshTasks.length === 0,
    missingTasks,
    staleTasks,
    failedTasks,
    refreshTasks,
    approvalRequiredForRefresh: refreshTasks.length > 0,
    refreshCommand: `node scripts\\test-anticodex-desktop-task-suite.mjs --suite-profile ${profile} --allow-real-traffic`,
  };
}

const profiles = Object.entries(requiredProfiles).map(([profile, tasks]) => profileStatus(profile, tasks));
const nextProfilesNeedingRealTraffic = profiles.filter((profile) => profile.approvalRequiredForRefresh).map((profile) => profile.profile);
const completeProfiles = profiles.filter((profile) => profile.allOk).map((profile) => profile.profile);

const payload = {
  ok: true,
  reportName: "real-task-coverage-roadmap",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "real-task-coverage-roadmap-report-only",
  reportRoot,
  maxAgeHours,
  requiredProfiles: Object.keys(requiredProfiles),
  taskModes: Object.keys(taskReportExpectations),
  profiles,
  taskEvidence: Object.values(taskEvidence),
  completeProfiles,
  nextProfilesNeedingRealTraffic,
  approvalRequiredForRefresh: nextProfilesNeedingRealTraffic.length > 0,
  realTrafficApprovalReason: "explicit_user_approval_required_for_desktop_task_refresh",
  recommendedNoTrafficNextStep: nextProfilesNeedingRealTraffic.length > 0
    ? "ask_user_to_approve_selected_real_task_refresh"
    : "keep_monitoring_report_freshness",
  elapsedMs: Date.now() - startedAt,
};

mkdirSync(reportRoot, { recursive: true });
const latest = resolve(reportRoot, "latest-real-task-coverage-roadmap.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const history = resolve(reportRoot, `${stamp}-real-task-coverage-roadmap.json`);
payload.report = { latest, history };

const json = JSON.stringify(payload, null, 2);
const hash = createHash("sha256").update(json).digest("hex");
const signed = `${json}\n`;
function atomicWrite(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
  writeFileSync(`${path}.sha256`, `${createHash("sha256").update(content).digest("hex")}\n`, "ascii");
}

atomicWrite(latest, signed);
atomicWrite(history, signed);
payload.integrity = { hash };
console.log(JSON.stringify(payload));
