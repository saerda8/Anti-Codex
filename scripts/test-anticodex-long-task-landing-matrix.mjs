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

const requiredLongTasks = [
  {
    taskMode: "coding-project",
    capabilityId: "coding_project_files_tests_cli",
    file: "latest-ui-coding-project-smoke.json",
    reportName: "ui-coding-project-smoke",
    expectedWorkProduct: "tested Node CLI project",
    requiredArtifactKeys: ["doneExact", "exportsFunction", "testPassed", "cliPassed"],
    requiredFiles: ["packageJson", "wordTally", "testFile", "doneTxt"],
    requiredResponseHistoryKeys: ["assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  },
  {
    taskMode: "multi-turn-project",
    capabilityId: "multi_turn_continuation",
    file: "latest-ui-multi-turn-project-smoke.json",
    reportName: "ui-multi-turn-project-smoke",
    expectedWorkProduct: "two-turn project continuation with tests",
    requiredArtifactKeys: ["firstDoneExact", "followupExact", "changelogHasFinalMarker", "testPassed", "cliPassed"],
    requiredFiles: ["packageJson", "wordTally", "testFile", "doneTxt", "followupTxt", "changelogMd"],
    minTurnCount: 2,
    requiredResponseHistoryKeys: ["assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  },
  {
    taskMode: "report-site",
    capabilityId: "research_report_with_sources",
    file: "latest-ui-report-site-smoke.json",
    reportName: "ui-report-site-smoke",
    expectedWorkProduct: "sourced report plus linked HTML page",
    requiredArtifactKeys: ["doneExact", "reportHasMarker", "htmlHasMarker", "reportHasChinese", "htmlHasChinese", "htmlComplete", "htmlLinksReport"],
    requiredFiles: ["reportMd", "indexHtml", "doneTxt"],
    minReportUrlCount: 3,
    minHtmlUrlCount: 3,
    minSharedUrlCount: 1,
    requiredResponseHistoryKeys: ["assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  },
  {
    taskMode: "complex-project",
    capabilityId: "complex_research_code_site",
    file: "latest-ui-complex-project-smoke.json",
    reportName: "ui-complex-project-smoke",
    expectedWorkProduct: "research-backed tested dashboard project",
    requiredArtifactKeys: ["doneExact", "exportsFunction", "testPassed", "cliPassed", "reportHasChinese", "htmlHasChinese", "htmlComplete", "htmlLinksReport"],
    requiredFiles: ["packageJson", "analyzer", "testFile", "sourcesJson", "reportMd", "indexHtml", "doneTxt"],
    minSharedUrlCount: 3,
    requiredResponseHistoryKeys: ["assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  },
  {
    taskMode: "repo-multi-file-edit",
    capabilityId: "repo_multi_file_edit",
    file: "latest-ui-repo-multi-file-edit-smoke.json",
    reportName: "ui-repo-multi-file-edit-smoke",
    expectedWorkProduct: "multi-file repo edit with tests, CLI output, README, and HTML",
    requiredArtifactKeys: ["exportsNormalizeStatus", "exportsSummarizeRecords", "exportsRenderSummaryHtml", "sourceChangedFromFixture", "testUnchanged", "dataUnchanged", "testPassed", "cliPassed", "htmlComplete", "htmlHasChinese", "readmeHasChinese"],
    requiredFiles: ["source", "test", "data", "readme", "html"],
    minTurnCount: 2,
    requiredResponseHistoryKeys: ["assistantHasFinalMarker", "markerToolOutputSeen", "visibleProgressCount", "distinctVisibleProgressCount", "taskToolCallCount", "taskToolOutputSeen", "modelLedExecution", "codexLikeProcessProof"],
  },
];

function readJsonReport(file) {
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

function bool(value) {
  return value === true;
}

function artifactPasses(value) {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return false;
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

const agenticEntry = readJsonReport("latest-agentic-capability-matrix.json");
const agentic = agenticEntry.report || {};
const agenticCapabilities = Array.isArray(agentic.capabilities) ? agentic.capabilities : [];
const roadmapEntry = readJsonReport("latest-real-task-coverage-roadmap.json");
const roadmap = roadmapEntry.report || {};
const roadmapArtifactProofs = Array.isArray(roadmap.taskArtifactProofs) ? roadmap.taskArtifactProofs : [];
const roadmapResultProofs = Array.isArray(roadmap.taskResultProofs) ? roadmap.taskResultProofs : [];

function taskResult(spec) {
  const entry = readJsonReport(spec.file);
  const report = entry.report || {};
  const artifact = report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence : {};
  const responseHistory = artifact.responseHistory && typeof artifact.responseHistory === "object" ? artifact.responseHistory : {};
  const files = artifact.files && typeof artifact.files === "object" ? artifact.files : {};
  const turnEvidence = Array.isArray(report.turnEvidence) ? report.turnEvidence : [];
  const capability = agenticCapabilities.find((item) => String(item?.id || "") === spec.capabilityId);
  const artifactProof = roadmapArtifactProofs.find((item) => String(item?.taskMode || "") === spec.taskMode);
  const resultProof = roadmapResultProofs.find((item) => String(item?.taskMode || "") === spec.taskMode);
  const failures = [...entry.failures];

  if (entry.present && entry.parseable) {
    if (report.ok !== true) failures.push("report_not_ok");
    if (report.reportName !== spec.reportName) failures.push("report_name_mismatch");
    if (report.taskMode !== spec.taskMode) failures.push("task_mode_mismatch");
    if (report.requestedRealTraffic !== true) failures.push("real_traffic_not_requested");
    if (report.usedRealTraffic !== true) failures.push("real_traffic_not_used");
    if (Array.isArray(report.failures) && report.failures.length > 0) failures.push("report_has_failures");
  }

  for (const key of spec.requiredArtifactKeys) {
    if (!artifactPasses(artifact[key])) failures.push(`artifact_key_missing:${key}`);
  }
  for (const key of spec.requiredFiles) {
    if (files[key] !== true) failures.push(`file_evidence_missing:${key}`);
  }
  if (Number(spec.minTurnCount || 0) > 0) {
    if (turnEvidence.length < spec.minTurnCount) failures.push("turn_count_too_low");
    if (turnEvidence.some((turn) => !turn || turn.ok !== true)) failures.push("turn_evidence_not_ok");
  }
  if (Number(spec.minSharedUrlCount || 0) > 0) {
    const sharedUrlCount = Number(artifact.sharedUrlCount || artifact.sourceCount || 0);
    if (sharedUrlCount < spec.minSharedUrlCount) failures.push("shared_url_count_too_low");
  }
  if (Number(spec.minReportUrlCount || 0) > 0) {
    if ((Number(artifact.reportUrlCount) || 0) < spec.minReportUrlCount) failures.push("report_source_url_count_too_low");
  }
  if (Number(spec.minHtmlUrlCount || 0) > 0) {
    if ((Number(artifact.htmlUrlCount) || 0) < spec.minHtmlUrlCount) failures.push("html_source_url_count_too_low");
  }
  for (const key of spec.requiredResponseHistoryKeys || []) {
    if (!artifactPasses(responseHistory[key])) failures.push(`response_history_key_missing:${key}`);
  }
  if (firstPersonProgressCount(responseHistory) > 0) failures.push("first_person_visible_progress_present");
  if (!capability || capability.ok !== true) failures.push("agentic_capability_missing_or_not_ok");
  if (!artifactProof || artifactProof.artifactProofComplete !== true) failures.push("roadmap_artifact_proof_missing");
  if (!resultProof || resultProof.resultProofComplete !== true) failures.push("roadmap_result_proof_missing");

  return {
    taskMode: spec.taskMode,
    capabilityId: spec.capabilityId,
    file: spec.file,
    reportName: String(report.reportName || ""),
    expectedWorkProduct: spec.expectedWorkProduct,
    present: entry.present,
    parseable: entry.parseable,
    fresh: entry.fresh,
    requestedRealTraffic: report.requestedRealTraffic === true,
    usedRealTraffic: report.usedRealTraffic === true,
    reportOk: report.ok === true,
    artifactEvidenceKeys: Object.keys(artifact).sort(),
    fileEvidenceKeys: Object.keys(files).filter((key) => files[key] === true).sort(),
    requiredArtifactKeys: spec.requiredArtifactKeys,
    requiredFiles: spec.requiredFiles,
    requiredResponseHistoryKeys: spec.requiredResponseHistoryKeys || [],
    responseHistoryEvidence: {
      assistantHasFinalMarker: responseHistory.assistantHasFinalMarker === true,
      markerToolOutputSeen: responseHistory.markerToolOutputSeen === true,
      visibleProgressCount: Number(responseHistory.visibleProgressCount) || 0,
      distinctVisibleProgressCount: Number(responseHistory.distinctVisibleProgressCount) || 0,
      repeatedVisibleProgressCount: Number(responseHistory.repeatedVisibleProgressCount) || 0,
      firstPersonProgressCount: firstPersonProgressCount(responseHistory),
      firstPersonProgressSamples: Array.isArray(responseHistory.firstPersonProgressSamples) ? responseHistory.firstPersonProgressSamples.slice(0, 5) : [],
      taskToolCallCount: Number(responseHistory.taskToolCallCount) || 0,
      taskToolOutputSeen: responseHistory.taskToolOutputSeen === true,
      artifactGuardUsed: responseHistory.artifactGuardUsed === true,
      modelLedExecution: responseHistory.modelLedExecution === true,
      codexLikeProcessProof: responseHistory.codexLikeProcessProof === true,
    },
    turnCount: turnEvidence.length,
    reportUrlCount: Number(artifact.reportUrlCount || 0),
    htmlUrlCount: Number(artifact.htmlUrlCount || 0),
    sharedUrlCount: Number(artifact.sharedUrlCount || artifact.sourceCount || 0),
    capabilityOk: capability?.ok === true,
    artifactProofComplete: artifactProof?.artifactProofComplete === true,
    resultProofComplete: resultProof?.resultProofComplete === true,
    ok: failures.length === 0,
    failures,
  };
}

const taskResults = requiredLongTasks.map(taskResult);
const failedLongTaskModes = taskResults.filter((item) => item.ok !== true).map((item) => item.taskMode);
const pendingRealTaskModes = asStrings(roadmap.uniqueRefreshTasks);
const pendingRealTaskScenarios = Array.isArray(roadmap.pendingRealTaskScenarios)
  ? roadmap.pendingRealTaskScenarios.map((item) => ({
    taskMode: String(item?.taskMode || ""),
    workType: String(item?.workType || ""),
    realTrafficRequired: item?.realTrafficRequired === true,
    acceptanceEvidence: asStrings(item?.acceptanceEvidence),
    expectedResultPresent: typeof item?.expectedResult === "string" && item.expectedResult.trim().length > 0,
  }))
  : [];

const failures = [
  ...(agenticEntry.present ? [] : ["agentic_capability_matrix_missing"]),
  ...(agenticEntry.present && agenticEntry.parseable ? [] : agenticEntry.present ? ["agentic_capability_matrix_unparseable"] : []),
  ...(agentic.ok === true ? [] : ["agentic_capability_matrix_not_ok"]),
  ...(agentic.complete === true ? [] : ["agentic_capability_matrix_incomplete"]),
  ...(roadmapEntry.present ? [] : ["real_task_coverage_roadmap_missing"]),
  ...(roadmapEntry.present && roadmapEntry.parseable ? [] : roadmapEntry.present ? ["real_task_coverage_roadmap_unparseable"] : []),
  ...taskResults.flatMap((item) => item.failures.map((failure) => `${item.taskMode}:${failure}`)),
];

const payload = {
  ok: failures.length === 0,
  reportName: "long-task-landing-matrix",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "long-task-landing-matrix-report-only",
  reportRoot,
  maxAgeHours,
  longTaskLandingComplete: failedLongTaskModes.length === 0,
  codexClientCopy: true,
  antigravityModelTextOnly: true,
  requiredLongTaskModes: requiredLongTasks.map((item) => item.taskMode),
  longTaskCount: taskResults.length,
  landedLongTaskCount: taskResults.filter((item) => item.ok === true).length,
  failedLongTaskModes,
  taskResults,
  agenticCapabilityMatrixPresent: agenticEntry.present,
  agenticCapabilityMatrixComplete: agentic.complete === true,
  realTaskCoverageRoadmapPresent: roadmapEntry.present,
  realTaskCoverageRoadmapCompleteProfiles: asStrings(roadmap.completeProfiles),
  broaderRealTrafficStillRequired: pendingRealTaskModes.length > 0 || roadmap.approvalRequiredForRefresh === true,
  pendingRealTaskModes,
  pendingRealTaskScenarios,
  minimalRefreshCommand: String(roadmap.minimalRefreshCommand || ""),
  minimalRefreshCommandArgs: asStrings(roadmap.minimalRefreshCommandArgs),
  failures,
  elapsedMs: Date.now() - startedAt,
};

mkdirSync(reportRoot, { recursive: true });
const latest = resolve(reportRoot, "latest-long-task-landing-matrix.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
const history = resolve(reportRoot, `${stamp}-long-task-landing-matrix.json`);
const body = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
for (const file of [latest, history]) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, body, "utf8");
  renameSync(temp, file);
  writeFileSync(`${file}.sha256`, `${createHash("sha256").update(body).digest("hex")}\n`, "ascii");
}

console.log(JSON.stringify({ ...payload, report: { latest, history } }));
if (!payload.ok) process.exit(1);
