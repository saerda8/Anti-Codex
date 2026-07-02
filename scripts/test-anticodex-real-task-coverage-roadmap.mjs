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

const taskArtifactRequirements = {
  "local-project": ["doneExact", "indexHasMarker", "readmeNonEmpty"],
  "coding-project": ["doneExact", "exportsFunction", "testPassed", "cliPassed"],
  "multi-turn-project": ["firstDoneExact", "followupExact", "changelogHasFinalMarker", "testPassed", "cliPassed"],
  "report-site": ["doneExact", "reportHasMarker", "htmlHasMarker", "reportHasChinese", "htmlHasChinese", "htmlComplete", "htmlLinksReport"],
  "complex-project": ["doneExact", "exportsFunction", "testPassed", "cliPassed", "sourceUrlCount", "reportUrlCount", "htmlUrlCount", "htmlComplete", "htmlLinksReport"],
  "repo-file-edit": ["testPassed", "sourceHasLowercase", "sourceHandlesInvalidChars", "sourceTrimsHyphens"],
  "repo-multi-file-edit": [
    "exportsNormalizeStatus",
    "exportsSummarizeRecords",
    "exportsRenderSummaryHtml",
    "sourceChangedFromFixture",
    "testUnchanged",
    "dataUnchanged",
    "testPassed",
    "cliPassed",
    "htmlComplete",
    "htmlHasChinese",
    "htmlMentionsStatuses",
    "readmeHasChinese",
    "readmeMentionsCommand",
  ],
};

const taskResultRequirements = {
  "exact-marker": ["answerMarkerCount", "responseHistoryMarkerSeen", "lastSample"],
  "free-chat": ["answerMarkerCount", "responseHistoryMarkerSeen", "lastSample"],
  "web-search": ["answerMarkerCount", "sourceUrlCount", "lastSample"],
  "local-project": ["artifactEvidence", "doneExact", "indexHasMarker"],
  "coding-project": ["artifactEvidence", "testPassed", "cliPassed", "assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "firstPersonProgressClean", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  "multi-turn-project": ["artifactEvidence", "followupExact", "testPassed", "cliPassed", "assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "firstPersonProgressClean", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  "report-site": ["artifactEvidence", "reportHasChinese", "htmlComplete", "assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "firstPersonProgressClean", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  "complex-project": ["artifactEvidence", "sourceUrlCount", "testPassed", "cliPassed", "htmlComplete", "assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "firstPersonProgressClean", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  "repo-file-edit": ["artifactEvidence", "testPassed", "sourceHasLowercase"],
  "repo-multi-file-edit": ["artifactEvidence", "sourceChangedFromFixture", "testPassed", "cliPassed", "htmlComplete", "assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "firstPersonProgressClean", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
};

const taskScenarioCatalog = {
  "exact-marker": {
    taskMode: "exact-marker",
    workType: "chat-contract",
    realTrafficRequired: true,
    acceptanceEvidence: ["assistant-reply-marker", "latest-ui-chat-smoke-report"],
    expectedResult: "Assistant returns exact marker in chat reply",
  },
  "free-chat": {
    taskMode: "free-chat",
    workType: "open-ended-chat",
    realTrafficRequired: true,
    acceptanceEvidence: ["assistant-reply-marker", "latest-ui-free-chat-smoke-report"],
    expectedResult: "Assistant replies with marker in free-form conversation",
  },
  "web-search": {
    taskMode: "web-search",
    workType: "web-research-answer",
    realTrafficRequired: true,
    acceptanceEvidence: ["assistant-reply-marker", "source-url-answer", "latest-ui-web-search-smoke-report"],
    expectedResult: "Assistant returns answer with source URLs after web search",
  },
  "local-project": {
    taskMode: "local-project",
    workType: "local-artifact-creation",
    realTrafficRequired: true,
    acceptanceEvidence: ["index-html", "readme-md", "done-marker"],
    expectedResult: "Assistant creates local index.html, readme, and marks done",
  },
  "coding-project": {
    taskMode: "coding-project",
    workType: "new-node-cli-project",
    realTrafficRequired: true,
    acceptanceEvidence: ["package-json", "node-test-passed", "cli-output-verified", "done-marker"],
    expectedResult: "Assistant scaffolds Node CLI project with passing tests and CLI output",
  },
  "multi-turn-project": {
    taskMode: "multi-turn-project",
    workType: "multi-turn-project-continuation",
    realTrafficRequired: true,
    acceptanceEvidence: ["first-turn-marker", "followup-marker", "changelog-marker", "node-test-passed"],
    expectedResult: "Assistant completes two-turn project with changelog and passing tests",
  },
  "report-site": {
    taskMode: "report-site",
    workType: "web-backed-report-site",
    realTrafficRequired: true,
    acceptanceEvidence: ["report-md", "index-html", "three-source-urls", "done-marker"],
    expectedResult: "Assistant produces report.md with source URLs and linked index.html",
  },
  "complex-project": {
    taskMode: "complex-project",
    workType: "web-backed-tested-dashboard-project",
    realTrafficRequired: true,
    acceptanceEvidence: ["sources-json", "analyzer-test-passed", "cli-output-verified", "report-md", "index-html"],
    expectedResult: "Assistant builds dashboard with sources, analyzer tests, CLI, and HTML report",
  },
  "repo-file-edit": {
    taskMode: "repo-file-edit",
    workType: "single-file-repo-test-fix",
    realTrafficRequired: true,
    acceptanceEvidence: ["target-source-changed", "acceptance-test-passed", "fixture-cleanup"],
    expectedResult: "Assistant edits single repo file so acceptance test passes and fixture is clean",
  },
  "repo-multi-file-edit": {
    taskMode: "repo-multi-file-edit",
    workType: "two-step-multi-file-repo-task",
    realTrafficRequired: true,
    acceptanceEvidence: ["readme-created", "source-changed", "test-passed", "cli-output-verified", "offline-html"],
    expectedResult: "Assistant creates readme, edits source, and verifies with test, CLI, and offline HTML",
  },
};

const requiredProfiles = {
  core: ["exact-marker", "local-project", "repo-file-edit", "repo-multi-file-edit"],
  agentic: ["coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit"],
  extended: ["exact-marker", "local-project", "repo-file-edit", "repo-multi-file-edit", "web-search", "coding-project", "multi-turn-project", "report-site", "complex-project"],
  all: ["exact-marker", "free-chat", "web-search", "local-project", "coding-project", "multi-turn-project", "complex-project", "report-site", "repo-file-edit", "repo-multi-file-edit"],
};

function artifactValuePasses(value) {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") return value.length > 0;
  return false;
}

function urlCountFromText(value) {
  const matches = String(value || "").match(/https?:\/\/[^\s)"'<>]+/g);
  return matches ? matches.length : 0;
}

function firstPersonProgressCount(responseHistory = {}) {
  const explicit = Number(responseHistory.firstPersonProgressCount || 0);
  const textCount = String(responseHistory.assistantText || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => /^我(?:先|在|已|已经|执行|创建|修改|生成|写入|读取|读回|运行|调用|准备|开始|完成|把|清理|检查|核对)/.test(line))
    .length;
  return Math.max(Number.isFinite(explicit) ? explicit : 0, textCount);
}

function artifactProofFor(taskMode, report) {
  const artifactEvidence = report && report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence : {};
  const artifactEvidenceKeys = Object.keys(artifactEvidence).sort();
  const requiredArtifactProofKeys = taskArtifactRequirements[taskMode] || [];
  const satisfiedArtifactProofKeys = requiredArtifactProofKeys.filter((key) => artifactValuePasses(artifactEvidence[key]));
  const missingArtifactProofKeys = requiredArtifactProofKeys.filter((key) => !satisfiedArtifactProofKeys.includes(key));
  return {
    artifactEvidenceKeys,
    requiredArtifactProofKeys,
    satisfiedArtifactProofKeys,
    missingArtifactProofKeys,
    artifactProofCount: satisfiedArtifactProofKeys.length,
    artifactProofRequired: requiredArtifactProofKeys.length > 0,
    artifactProofComplete: missingArtifactProofKeys.length === 0,
  };
}

function resultProofFor(taskMode, report) {
  const artifactEvidence = report && report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence : {};
  const responseHistory = artifactEvidence.responseHistory && typeof artifactEvidence.responseHistory === "object" ? artifactEvidence.responseHistory : {};
  const isReportSite = taskMode === "report-site";
  const answerMarkerCount = Number(report?.answerMarkerCount || 0);
  const taskToolCallCount = Number(responseHistory.taskToolCallCount || 0);
  const visibleProgressCount = Number(responseHistory.visibleProgressCount || 0);
  const distinctVisibleProgressCount = Number(responseHistory.distinctVisibleProgressCount || 0);
  const firstPersonCount = firstPersonProgressCount(responseHistory);
  const assistantHasFinalMarker = responseHistory.assistantHasFinalMarker === true
    || (isReportSite && answerMarkerCount > 0);
  const markerToolOutputSeen = responseHistory.markerToolOutputSeen === true
    || (isReportSite && report?.responseHistoryMarkerSeen === true);
  const taskToolOutputSeen = responseHistory.taskToolOutputSeen === true
    || (isReportSite && report?.responseHistoryMarkerSeen === true);
  const codexLikeProcessProof = responseHistory.codexLikeProcessProof === true
    || (isReportSite
      && report?.repairAttempted !== true
      && assistantHasFinalMarker
      && markerToolOutputSeen
      && taskToolOutputSeen
      && taskToolCallCount > 0
      && visibleProgressCount > 0
      && distinctVisibleProgressCount > 0
      && firstPersonCount === 0
      && responseHistory.modelLedExecution === true);
  const resultEvidence = {
    answerMarkerCount,
    markerCount: Number(report?.markerCount || 0),
    responseHistoryMarkerSeen: report?.responseHistoryMarkerSeen === true,
    lastSample: String(report?.lastSample || ""),
    sourceUrlCount: Number(artifactEvidence.sourceUrlCount || 0) || urlCountFromText(report?.lastSample),
    artifactEvidence: Object.keys(artifactEvidence).length,
    doneExact: artifactEvidence.doneExact === true,
    indexHasMarker: artifactEvidence.indexHasMarker === true,
    followupExact: artifactEvidence.followupExact === true,
    reportHasChinese: artifactEvidence.reportHasChinese === true,
    htmlComplete: artifactEvidence.htmlComplete === true,
    sourceChangedFromFixture: artifactEvidence.sourceChangedFromFixture === true,
    sourceHasLowercase: artifactEvidence.sourceHasLowercase === true,
    testPassed: artifactEvidence.testPassed === true,
    cliPassed: artifactEvidence.cliPassed === true,
    assistantHasFinalMarker,
    markerToolOutputSeen,
    visibleProgressCount,
    distinctVisibleProgressCount,
    repeatedVisibleProgressCount: Number(responseHistory.repeatedVisibleProgressCount || 0),
    firstPersonProgressClean: firstPersonCount === 0,
    firstPersonProgressCount: firstPersonCount,
    firstPersonProgressSamples: Array.isArray(responseHistory.firstPersonProgressSamples) ? responseHistory.firstPersonProgressSamples.slice(0, 5).join(" | ") : "",
    taskToolCallCount,
    taskToolOutputSeen,
    artifactGuardUsed: responseHistory.artifactGuardUsed === true,
    modelLedExecution: responseHistory.modelLedExecution === true,
    codexLikeProcessProof,
  };
  const resultEvidenceKeys = Object.keys(resultEvidence).filter((key) => artifactValuePasses(resultEvidence[key])).sort();
  const requiredResultProofKeys = taskResultRequirements[taskMode] || [];
  const satisfiedResultProofKeys = requiredResultProofKeys.filter((key) => resultEvidenceKeys.includes(key));
  const missingResultProofKeys = requiredResultProofKeys.filter((key) => !satisfiedResultProofKeys.includes(key));
  return {
    resultEvidenceKeys,
    requiredResultProofKeys,
    satisfiedResultProofKeys,
    missingResultProofKeys,
    resultProofCount: satisfiedResultProofKeys.length,
    resultProofRequired: requiredResultProofKeys.length > 0,
    resultProofComplete: missingResultProofKeys.length === 0,
  };
}

function readReport(taskMode) {
  const [file, expectedReportName] = taskReportExpectations[taskMode];
  const path = resolve(reportRoot, file);
  if (!existsSync(path)) {
    return { taskMode, file, expectedReportName, ...artifactProofFor(taskMode, null), ...resultProofFor(taskMode, null), present: false, parseable: false, ok: false, fresh: false, requestedRealTraffic: false, usedRealTraffic: false, failures: ["report_missing"] };
  }
  const ageMs = Date.now() - statSync(path).mtimeMs;
  try {
    const report = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    const failures = [];
    const artifactProof = artifactProofFor(taskMode, report);
    const resultProof = resultProofFor(taskMode, report);
    if (ageMs > maxAgeMs) failures.push("report_stale");
    if (report.ok !== true) failures.push("report_not_ok");
    if (report.reportName !== expectedReportName) failures.push("report_name_mismatch");
    if (report.taskMode !== taskMode) failures.push("task_mode_mismatch");
    if (report.requestedRealTraffic !== true) failures.push("real_traffic_not_requested");
    if (report.usedRealTraffic !== true) failures.push("real_traffic_not_used");
    if (artifactProof.artifactProofRequired && !artifactProof.artifactProofComplete) failures.push("artifact_proof_missing");
    if (resultProof.resultProofRequired && !resultProof.resultProofComplete) failures.push("result_proof_missing");
    if (Array.isArray(report.failures) && report.failures.length > 0) failures.push("report_has_failures");
    return {
      taskMode,
      file,
      expectedReportName,
      reportName: String(report.reportName || ""),
      ...artifactProof,
      ...resultProof,
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
    return { taskMode, file, expectedReportName, ...artifactProofFor(taskMode, null), ...resultProofFor(taskMode, null), present: true, parseable: false, ok: false, fresh: false, requestedRealTraffic: false, usedRealTraffic: false, failures: [`report_unparseable:${error.message}`] };
  }
}

const taskEvidence = Object.fromEntries(Object.keys(taskReportExpectations).map((taskMode) => [taskMode, readReport(taskMode)]));

function profileStatus(profile, tasks) {
  const entries = tasks.map((taskMode) => taskEvidence[taskMode]);
  const missingTasks = entries.filter((entry) => !entry.present).map((entry) => entry.taskMode);
  const staleTasks = entries.filter((entry) => entry.present && entry.fresh !== true).map((entry) => entry.taskMode);
  const failedTasks = entries.filter((entry) => entry.present && entry.ok !== true).map((entry) => entry.taskMode);
  const artifactProofEntries = entries.filter((entry) => entry.artifactProofRequired);
  const resultProofEntries = entries.filter((entry) => entry.resultProofRequired);
  const missingArtifactProofTasks = artifactProofEntries.filter((entry) => entry.artifactProofComplete !== true).map((entry) => entry.taskMode);
  const missingResultProofTasks = resultProofEntries.filter((entry) => entry.resultProofComplete !== true).map((entry) => entry.taskMode);
  const refreshTasks = [...new Set([...missingTasks, ...staleTasks, ...failedTasks])];
  return {
    profile,
    selectedTasks: tasks,
    taskCount: tasks.length,
    okTaskCount: entries.filter((entry) => entry.ok === true).length,
    artifactProofRequiredCount: artifactProofEntries.length,
    artifactProofCompleteCount: artifactProofEntries.filter((entry) => entry.artifactProofComplete === true).length,
    missingArtifactProofTasks,
    profileArtifactProofComplete: missingArtifactProofTasks.length === 0,
    resultProofRequiredCount: resultProofEntries.length,
    resultProofCompleteCount: resultProofEntries.filter((entry) => entry.resultProofComplete === true).length,
    missingResultProofTasks,
    profileResultProofComplete: missingResultProofTasks.length === 0,
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

function quoteCommandPart(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

const profiles = Object.entries(requiredProfiles).map(([profile, tasks]) => profileStatus(profile, tasks));
const nextProfilesNeedingRealTraffic = profiles.filter((profile) => profile.approvalRequiredForRefresh).map((profile) => profile.profile);
const completeProfiles = profiles.filter((profile) => profile.allOk).map((profile) => profile.profile);
const uniqueRefreshTasks = [...new Set(profiles.flatMap((profile) => profile.refreshTasks))];
const taskArtifactProofs = Object.values(taskEvidence)
  .filter((entry) => entry.artifactProofRequired)
  .map((entry) => ({
    taskMode: entry.taskMode,
    file: entry.file,
    artifactEvidenceKeys: entry.artifactEvidenceKeys,
    requiredArtifactProofKeys: entry.requiredArtifactProofKeys,
    satisfiedArtifactProofKeys: entry.satisfiedArtifactProofKeys,
    missingArtifactProofKeys: entry.missingArtifactProofKeys,
    artifactProofCount: entry.artifactProofCount,
    artifactProofComplete: entry.artifactProofComplete,
  }));
const missingArtifactProofTasks = taskArtifactProofs
  .filter((entry) => entry.artifactProofComplete !== true)
  .map((entry) => entry.taskMode);
const taskResultProofs = Object.values(taskEvidence)
  .filter((entry) => entry.resultProofRequired)
  .map((entry) => ({
    taskMode: entry.taskMode,
    file: entry.file,
    resultEvidenceKeys: entry.resultEvidenceKeys,
    requiredResultProofKeys: entry.requiredResultProofKeys,
    satisfiedResultProofKeys: entry.satisfiedResultProofKeys,
    missingResultProofKeys: entry.missingResultProofKeys,
    resultProofCount: entry.resultProofCount,
    resultProofComplete: entry.resultProofComplete,
  }));
const missingResultProofTasks = taskResultProofs
  .filter((entry) => entry.resultProofComplete !== true)
  .map((entry) => entry.taskMode);
const pendingRealTaskScenarios = uniqueRefreshTasks.map((taskMode) => ({
  ...(taskScenarioCatalog[taskMode] || { taskMode, workType: "unknown", realTrafficRequired: true, acceptanceEvidence: [], expectedResult: "" }),
  realTrafficRequired: true,
}));
const minimalRefreshCommandParts = [
  process.execPath,
  "scripts\\test-anticodex-desktop-task-suite.mjs",
  "--suite-profile",
  "all",
];
if (uniqueRefreshTasks.length > 0) {
  minimalRefreshCommandParts.push("--tasks", uniqueRefreshTasks.join(","));
}
minimalRefreshCommandParts.push("--allow-real-traffic");
const minimalRefreshCommandArgs = uniqueRefreshTasks.length > 0
  ? [...minimalRefreshCommandParts]
  : [];
const minimalRefreshCommand = uniqueRefreshTasks.length > 0
  ? minimalRefreshCommandParts.map(quoteCommandPart).join(" ")
  : "";
const refreshApprovalSummary = {
  requiresExplicitUserApproval: uniqueRefreshTasks.length > 0,
  approvalReason: uniqueRefreshTasks.length > 0 ? "explicit_user_approval_required_for_desktop_task_refresh" : "",
  taskCount: uniqueRefreshTasks.length,
  refreshTaskModes: uniqueRefreshTasks,
  nextProfilesNeedingRealTraffic,
};

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
  taskArtifactRequirements,
  taskArtifactProofs,
  missingArtifactProofTasks,
  missingArtifactProofTaskCount: missingArtifactProofTasks.length,
  taskResultRequirements,
  taskResultProofs,
  missingResultProofTasks,
  missingResultProofTaskCount: missingResultProofTasks.length,
  completeProfiles,
  nextProfilesNeedingRealTraffic,
  uniqueRefreshTasks,
  pendingRealTaskScenarios,
  minimalRefreshCommand,
  minimalRefreshCommandArgs,
  minimalRefreshCommandRequiresRealTraffic: uniqueRefreshTasks.length > 0,
  refreshApprovalSummary,
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
