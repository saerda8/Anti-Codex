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

const taskReports = {
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

const taskScenarioCatalog = {
  "exact-marker": { workType: "chat-contract", acceptanceEvidence: ["assistant-reply-marker", "latest-ui-chat-smoke-report"], expectedResult: "Assistant returns exact marker in chat reply" },
  "free-chat": { workType: "open-ended-chat", acceptanceEvidence: ["assistant-reply-marker", "latest-ui-free-chat-smoke-report"], expectedResult: "Assistant replies in a free-form conversation" },
  "web-search": { workType: "web-research-answer", acceptanceEvidence: ["assistant-reply-marker", "source-url-answer", "latest-ui-web-search-smoke-report"], expectedResult: "Assistant returns a sourced web answer" },
  "local-project": { workType: "local-artifact-creation", acceptanceEvidence: ["index-html", "readme-md", "done-marker"], expectedResult: "Assistant creates local artifacts" },
  "coding-project": { workType: "new-node-cli-project", acceptanceEvidence: ["package-json", "node-test-passed", "cli-output-verified"], expectedResult: "Assistant creates a tested CLI project" },
  "multi-turn-project": { workType: "multi-turn-project-continuation", acceptanceEvidence: ["first-turn-marker", "followup-marker", "node-test-passed"], expectedResult: "Assistant continues a task across turns" },
  "report-site": { workType: "web-backed-report-site", acceptanceEvidence: ["report-md", "index-html", "source-urls"], expectedResult: "Assistant produces a sourced report and linked site" },
  "complex-project": { workType: "web-backed-tested-dashboard-project", acceptanceEvidence: ["sources-json", "node-test-passed", "report-md", "index-html"], expectedResult: "Assistant combines research, code, tests, and site output" },
  "repo-file-edit": { workType: "single-file-repo-test-fix", acceptanceEvidence: ["target-source-changed", "acceptance-test-passed"], expectedResult: "Assistant edits a repo file so tests pass" },
  "repo-multi-file-edit": { workType: "two-step-multi-file-repo-task", acceptanceEvidence: ["readme-created", "source-changed", "test-passed", "offline-html"], expectedResult: "Assistant completes a multi-file repo task" },
};

const parityGroups = [
  { id: "conversation", taskModes: ["exact-marker", "free-chat"] },
  { id: "research", taskModes: ["web-search", "report-site"] },
  { id: "projectCreation", taskModes: ["local-project", "coding-project", "complex-project"] },
  { id: "codingAndRepoEditing", taskModes: ["repo-file-edit", "repo-multi-file-edit"] },
  { id: "multiTurnAgentic", taskModes: ["multi-turn-project"] },
  { id: "toolUse", taskModes: ["tool-loop", "mcp-tool-loop", "custom-tool-loop"] },
];

const toolReports = {
  "tool-loop": ["latest-tool-loop.json", "tool-loop"],
  "mcp-tool-loop": ["latest-mcp-tool-loop.json", "mcp-tool-loop"],
  "custom-tool-loop": ["latest-custom-tool-loop.json", "custom-tool-loop"],
};

function readReport(file) {
  const path = resolve(reportRoot, file);
  if (!existsSync(path)) return { file, path, present: false, parseable: false, fresh: false, report: null, failures: ["report_missing"] };
  const ageMs = Date.now() - statSync(path).mtimeMs;
  try {
    const report = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return {
      file,
      path,
      present: true,
      parseable: true,
      fresh: ageMs <= maxAgeMs,
      ageMs,
      maxAgeMs,
      report,
      failures: ageMs <= maxAgeMs ? [] : ["report_stale"],
    };
  } catch (error) {
    return { file, path, present: true, parseable: false, fresh: false, report: null, failures: [`report_unparseable:${error.message}`] };
  }
}

function asStrings(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function scenario(taskMode) {
  const entry = taskScenarioCatalog[taskMode] || {};
  return {
    taskMode,
    workType: String(entry.workType || ""),
    realTrafficRequired: true,
    acceptanceEvidence: asStrings(entry.acceptanceEvidence),
    expectedResult: String(entry.expectedResult || ""),
    expectedResultPresent: Boolean(entry.expectedResult),
  };
}

function taskEvidence(taskMode, roadmap) {
  const [file, expectedReportName] = taskReports[taskMode] || ["", ""];
  const entry = readReport(file);
  const report = entry.report || {};
  const proof = (Array.isArray(roadmap.taskResultProofs) ? roadmap.taskResultProofs : []).find((item) => String(item?.taskMode || "") === taskMode);
  const artifactProof = (Array.isArray(roadmap.taskArtifactProofs) ? roadmap.taskArtifactProofs : []).find((item) => String(item?.taskMode || "") === taskMode);
  const failures = [...entry.failures];
  if (entry.present && entry.parseable) {
    if (report.ok !== true) failures.push("report_not_ok");
    if (report.reportName !== expectedReportName) failures.push("report_name_mismatch");
    if (report.taskMode !== taskMode) failures.push("task_mode_mismatch");
    if (report.requestedRealTraffic !== true) failures.push("real_traffic_not_requested");
    if (report.usedRealTraffic !== true) failures.push("real_traffic_not_used");
    if (Array.isArray(report.failures) && report.failures.length) failures.push("report_has_failures");
  }
  if (!proof || proof.resultProofComplete !== true) failures.push("result_proof_missing");
  if (artifactProof && artifactProof.artifactProofComplete !== true) failures.push("artifact_proof_incomplete");
  return {
    taskMode,
    file,
    reportName: String(report.reportName || ""),
    present: entry.present,
    parseable: entry.parseable,
    fresh: entry.fresh,
    requestedRealTraffic: report.requestedRealTraffic === true,
    usedRealTraffic: report.usedRealTraffic === true,
    resultProofComplete: proof?.resultProofComplete === true,
    artifactProofComplete: artifactProof ? artifactProof.artifactProofComplete === true : null,
    ok: failures.length === 0,
    failures,
    scenario: scenario(taskMode),
  };
}

function toolEvidence(taskMode) {
  const [file, expectedReportName] = toolReports[taskMode] || ["", ""];
  const entry = readReport(file);
  const report = entry.report || {};
  const failures = entry.failures.filter((failure) => failure !== "report_stale");
  if (entry.present && entry.parseable) {
    if (report.ok !== true) failures.push("report_not_ok");
    if (report.reportName !== expectedReportName) failures.push("report_name_mismatch");
    if (report.requestedRealTraffic !== true) failures.push("real_traffic_not_requested");
    if (report.usedRealTraffic !== true) failures.push("real_traffic_not_used");
    if (Array.isArray(report.failures) && report.failures.length) failures.push("report_has_failures");
  }
  return {
    taskMode,
    file,
    reportName: String(report.reportName || ""),
    present: entry.present,
    parseable: entry.parseable,
    fresh: entry.fresh,
    requestedRealTraffic: report.requestedRealTraffic === true,
    usedRealTraffic: report.usedRealTraffic === true,
    ok: failures.length === 0,
    failures,
  };
}

const roadmapEntry = readReport("latest-real-task-coverage-roadmap.json");
const roadmap = roadmapEntry.report || {};
const agenticEntry = readReport("latest-agentic-capability-matrix.json");
const agentic = agenticEntry.report || {};
const pendingRefreshTaskModes = asStrings(roadmap.uniqueRefreshTasks);
const pendingRealTaskScenarios = (Array.isArray(roadmap.pendingRealTaskScenarios)
  ? roadmap.pendingRealTaskScenarios
  : pendingRefreshTaskModes.map(scenario)).map((item) => ({
  taskMode: String(item?.taskMode || ""),
  workType: String(item?.workType || ""),
  realTrafficRequired: item?.realTrafficRequired === true,
  acceptanceEvidence: asStrings(item?.acceptanceEvidence),
  expectedResult: String(item?.expectedResult || ""),
  expectedResultPresent: item?.expectedResultPresent === true || String(item?.expectedResult || "").trim().length > 0,
}));
const minimalRefreshCommandArgs = asStrings(roadmap.minimalRefreshCommandArgs);
const matrixGroups = parityGroups.map((group) => {
  const entries = group.id === "toolUse"
    ? group.taskModes.map(toolEvidence)
    : group.taskModes.map((taskMode) => taskEvidence(taskMode, roadmap));
  return {
    ...group,
    evidence: entries,
    taskCount: entries.length,
    provenTaskCount: entries.filter((item) => item.ok).length,
    pendingRefreshTaskModes: entries.map((item) => item.taskMode).filter((taskMode) => pendingRefreshTaskModes.includes(taskMode)),
    complete: entries.every((item) => item.ok),
  };
});

const pendingGroups = matrixGroups.filter((group) => !group.complete).map((group) => group.id);
const provenTaskModes = matrixGroups.flatMap((group) => group.evidence.filter((item) => item.ok).map((item) => item.taskMode));
const nativeCodexParityComplete = pendingGroups.length === 0 && pendingRefreshTaskModes.length === 0 && roadmap.approvalRequiredForRefresh !== true;
const realTrafficStillRequired = nativeCodexParityComplete !== true;

const payload = {
  ok: true,
  reportName: "native-codex-parity-task-matrix",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "native-codex-parity-task-matrix-report-only",
  reportRoot,
  maxAgeHours,
  nativeCodexParityComplete,
  realTrafficStillRequired,
  parityGroups: matrixGroups,
  parityGroupIds: matrixGroups.map((group) => group.id),
  taskModes: Object.keys(taskReports),
  toolTaskModes: Object.keys(toolReports),
  provenTaskModes,
  provenTaskCount: provenTaskModes.length,
  pendingGroups,
  pendingRefreshTaskModes,
  missingTaskModes: matrixGroups.flatMap((group) => group.evidence.filter((item) => !item.present).map((item) => item.taskMode)),
  failedTaskModes: matrixGroups.flatMap((group) => group.evidence.filter((item) => item.present && !item.ok && !pendingRefreshTaskModes.includes(item.taskMode)).map((item) => item.taskMode)),
  pendingRealTaskScenarios,
  minimalRefreshCommand: String(roadmap.minimalRefreshCommand || ""),
  minimalRefreshCommandArgs,
  refreshApprovalSummary: roadmap.refreshApprovalSummary || null,
  roadmapPresent: roadmapEntry.present,
  roadmapFresh: roadmapEntry.fresh,
  roadmapApprovalRequiredForRefresh: roadmap.approvalRequiredForRefresh === true,
  agenticCapabilityMatrixPresent: agenticEntry.present,
  agenticCapabilityMatrixFresh: agenticEntry.fresh,
  agenticCapabilityMatrixComplete: agentic.complete === true,
  codexOwnedTools: true,
  antigravityModelTextOnly: true,
  failures: [],
  elapsedMs: Date.now() - startedAt,
};

mkdirSync(reportRoot, { recursive: true });
const latest = resolve(reportRoot, "latest-native-codex-parity-task-matrix.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
const history = resolve(reportRoot, `${stamp}-native-codex-parity-task-matrix.json`);
const body = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
for (const file of [latest, history]) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, body, "utf8");
  renameSync(temp, file);
  writeFileSync(`${file}.sha256`, `${createHash("sha256").update(body).digest("hex")}\n`, "ascii");
}

console.log(JSON.stringify({ ...payload, report: { latest, history } }));
