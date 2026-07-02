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

const requiredCapabilities = [
  "coding_project_files_tests_cli",
  "multi_turn_continuation",
  "research_report_with_sources",
  "complex_research_code_site",
  "repo_multi_file_edit",
];

const reportFiles = {
  desktopTaskSuite: "latest-desktop-task-suite.json",
  codingProject: "latest-ui-coding-project-smoke.json",
  multiTurnProject: "latest-ui-multi-turn-project-smoke.json",
  reportSite: "latest-ui-report-site-smoke.json",
  complexProject: "latest-ui-complex-project-smoke.json",
  repoMultiFileEdit: "latest-ui-repo-multi-file-edit-smoke.json",
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

function has(value, key) {
  return value && Object.prototype.hasOwnProperty.call(value, key);
}

function bool(value, key) {
  return !!(value && value[key] === true);
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

function requireResponseHistoryProof(responseHistory, failures) {
  if (responseHistory.assistantHasFinalMarker !== true) failures.push("response_history_final_marker_missing");
  if (responseHistory.markerToolOutputSeen !== true) failures.push("response_history_marker_tool_output_missing");
  if ((Number(responseHistory.visibleProgressCount) || 0) < 2) failures.push("visible_progress_too_shallow");
  if ((Number(responseHistory.distinctVisibleProgressCount) || 0) < 2) failures.push("visible_progress_not_distinct");
  if (firstPersonProgressCount(responseHistory) > 0) failures.push("first_person_visible_progress_present");
  if ((Number(responseHistory.taskToolCallCount) || 0) < 1) failures.push("task_tool_call_missing");
  if (responseHistory.taskToolOutputSeen !== true) failures.push("task_tool_output_missing");
  if (responseHistory.artifactGuardUsed === true) failures.push("artifact_guard_used");
  if (responseHistory.modelLedExecution !== true) failures.push("model_led_execution_missing");
  if (responseHistory.codexLikeProcessProof !== true) failures.push("codex_like_process_proof_missing");
}

function requireReportSiteProcessProof(report, responseHistory, failures) {
  const finalMarkerSeen = responseHistory.assistantHasFinalMarker === true || Number(report.answerMarkerCount || 0) > 0;
  const markerEvidenceSeen = responseHistory.markerToolOutputSeen === true || report.responseHistoryMarkerSeen === true;
  const toolOutputSeen = responseHistory.taskToolOutputSeen === true || report.responseHistoryMarkerSeen === true;
  if (!finalMarkerSeen) failures.push("response_history_final_marker_missing");
  if (!markerEvidenceSeen) failures.push("response_history_marker_tool_output_missing");
  if ((Number(responseHistory.visibleProgressCount) || 0) < 1) failures.push("visible_progress_too_shallow");
  if ((Number(responseHistory.distinctVisibleProgressCount) || 0) < 1) failures.push("visible_progress_not_distinct");
  if (firstPersonProgressCount(responseHistory) > 0) failures.push("first_person_visible_progress_present");
  if ((Number(responseHistory.taskToolCallCount) || 0) < 1) failures.push("task_tool_call_missing");
  if (!toolOutputSeen) failures.push("task_tool_output_missing");
  if (responseHistory.artifactGuardUsed === true) failures.push("artifact_guard_used");
  if (responseHistory.modelLedExecution !== true) failures.push("model_led_execution_missing");
  if (report.repairAttempted === true) failures.push("report_site_repair_attempted");
}

function responseHistoryEvidence(responseHistory) {
  return {
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
  };
}

function reportSiteProcessEvidence(report, responseHistory) {
  const finalMarkerSeen = responseHistory.assistantHasFinalMarker === true || Number(report.answerMarkerCount || 0) > 0;
  const markerEvidenceSeen = responseHistory.markerToolOutputSeen === true || report.responseHistoryMarkerSeen === true;
  const toolOutputSeen = responseHistory.taskToolOutputSeen === true || report.responseHistoryMarkerSeen === true;
  return {
    ...responseHistoryEvidence(responseHistory),
    visibleFinalMarkerSeen: finalMarkerSeen,
    responseHistoryMarkerSeen: report.responseHistoryMarkerSeen === true,
    effectiveMarkerToolOutputSeen: markerEvidenceSeen,
    effectiveTaskToolOutputSeen: toolOutputSeen,
    answerMarkerCount: Number(report.answerMarkerCount) || 0,
    repairAttempted: report.repairAttempted === true,
    reportSiteProcessProof: finalMarkerSeen
      && markerEvidenceSeen
      && (Number(responseHistory.visibleProgressCount) || 0) >= 1
      && (Number(responseHistory.distinctVisibleProgressCount) || 0) >= 1
      && firstPersonProgressCount(responseHistory) === 0
      && (Number(responseHistory.taskToolCallCount) || 0) >= 1
      && toolOutputSeen
      && responseHistory.artifactGuardUsed !== true
      && responseHistory.modelLedExecution === true
      && report.repairAttempted !== true,
  };
}

function baseTaskChecks(entry, expectedReportName, expectedTaskMode) {
  const failures = [...entry.failures];
  const report = entry.report || {};
  if (!entry.present) return { report, failures };
  if (!entry.parseable) return { report, failures };
  if (entry.fresh !== true) failures.push("latest_real_report_stale");
  if (report.ok !== true) failures.push("report_not_ok");
  if (report.reportName !== expectedReportName) failures.push("report_name_mismatch");
  if (report.taskMode !== expectedTaskMode) failures.push("task_mode_mismatch");
  if (report.requestedRealTraffic !== true) failures.push("real_traffic_not_requested");
  if (report.usedRealTraffic !== true) failures.push("real_traffic_not_used");
  if (Array.isArray(report.failures) && report.failures.length > 0) failures.push("report_has_failures");
  return { report, failures };
}

function capability(id, taskMode, file, expectedReportName, checks) {
  const entry = readReport(file);
  const { report, failures } = baseTaskChecks(entry, expectedReportName, taskMode);
  const evidence = checks(report, failures);
  return {
    id,
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
    evidence,
  };
}

const capabilities = [
  capability("coding_project_files_tests_cli", "coding-project", reportFiles.codingProject, "ui-coding-project-smoke", (report, failures) => {
    const artifact = report.artifactEvidence || {};
    const responseHistory = artifact.responseHistory || {};
    const files = artifact.files || {};
    for (const key of ["packageJson", "wordTally", "testFile", "doneTxt"]) {
      if (files[key] !== true) failures.push(`missing_file:${key}`);
    }
    for (const key of ["doneExact", "exportsFunction", "testPassed", "cliPassed"]) {
      if (artifact[key] !== true) failures.push(`missing_artifact_evidence:${key}`);
    }
    requireResponseHistoryProof(responseHistory, failures);
    return {
      files,
      doneExact: bool(artifact, "doneExact"),
      exportsFunction: bool(artifact, "exportsFunction"),
      testPassed: bool(artifact, "testPassed"),
      cliPassed: bool(artifact, "cliPassed"),
      cliJson: has(artifact, "cliJson") ? artifact.cliJson : null,
      ...responseHistoryEvidence(responseHistory),
    };
  }),
  capability("multi_turn_continuation", "multi-turn-project", reportFiles.multiTurnProject, "ui-multi-turn-project-smoke", (report, failures) => {
    const artifact = report.artifactEvidence || {};
    const responseHistory = artifact.responseHistory || {};
    const turns = Array.isArray(report.turnEvidence) ? report.turnEvidence : [];
    for (const key of ["firstDoneExact", "followupExact", "changelogHasFinalMarker", "exportsTallyWords", "exportsUniqueWords", "testPassed", "cliPassed"]) {
      if (artifact[key] !== true) failures.push(`missing_artifact_evidence:${key}`);
    }
    if (turns.length < 2) failures.push("turn_evidence_count_too_low");
    if (turns.some((turn) => !turn || turn.ok !== true)) failures.push("turn_evidence_not_ok");
    requireResponseHistoryProof(responseHistory, failures);
    return {
      turnCount: turns.length,
      okTurnCount: turns.filter((turn) => turn && turn.ok === true).length,
      firstDoneExact: bool(artifact, "firstDoneExact"),
      followupExact: bool(artifact, "followupExact"),
      changelogHasFinalMarker: bool(artifact, "changelogHasFinalMarker"),
      exportsUniqueWords: bool(artifact, "exportsUniqueWords"),
      testPassed: bool(artifact, "testPassed"),
      cliPassed: bool(artifact, "cliPassed"),
      ...responseHistoryEvidence(responseHistory),
    };
  }),
  capability("research_report_with_sources", "report-site", reportFiles.reportSite, "ui-report-site-smoke", (report, failures) => {
    const artifact = report.artifactEvidence || {};
    const responseHistory = artifact.responseHistory || {};
    const files = artifact.files || {};
    for (const key of ["reportMd", "indexHtml", "doneTxt"]) {
      if (files[key] !== true) failures.push(`missing_file:${key}`);
    }
    for (const key of ["doneExact", "reportHasMarker", "htmlHasMarker", "reportHasChinese", "htmlHasChinese", "reportMentionsCodex", "htmlMentionsCodex", "htmlComplete", "htmlLinksReport"]) {
      if (artifact[key] !== true) failures.push(`missing_artifact_evidence:${key}`);
    }
    if ((Number(artifact.reportUrlCount) || 0) < 3) failures.push("report_source_url_count_too_low");
    if ((Number(artifact.htmlUrlCount) || 0) < 3) failures.push("html_source_url_count_too_low");
    if ((Number(artifact.sharedUrlCount) || 0) < 1) failures.push("shared_url_count_too_low");
    requireReportSiteProcessProof(report, responseHistory, failures);
    return {
      files,
      reportUrlCount: Number(artifact.reportUrlCount) || 0,
      htmlUrlCount: Number(artifact.htmlUrlCount) || 0,
      sharedUrlCount: Number(artifact.sharedUrlCount) || 0,
      reportLength: Number(artifact.reportLength) || 0,
      htmlLength: Number(artifact.htmlLength) || 0,
      reportHasChinese: bool(artifact, "reportHasChinese"),
      htmlComplete: bool(artifact, "htmlComplete"),
      htmlLinksReport: bool(artifact, "htmlLinksReport"),
      ...reportSiteProcessEvidence(report, responseHistory),
    };
  }),
  capability("complex_research_code_site", "complex-project", reportFiles.complexProject, "ui-complex-project-smoke", (report, failures) => {
    const artifact = report.artifactEvidence || {};
    const responseHistory = artifact.responseHistory || {};
    const files = artifact.files || {};
    for (const key of ["packageJson", "analyzer", "testFile", "sourcesJson", "reportMd", "indexHtml", "doneTxt"]) {
      if (files[key] !== true) failures.push(`missing_file:${key}`);
    }
    for (const key of ["doneExact", "exportsFunction", "testPassed", "cliPassed", "reportHasChinese", "htmlHasChinese", "htmlComplete", "htmlLinksReport"]) {
      if (artifact[key] !== true) failures.push(`missing_artifact_evidence:${key}`);
    }
    if ((Number(artifact.sourceCount) || 0) < 3) failures.push("source_count_too_low");
    if ((Number(artifact.sharedUrlCount) || 0) < 3) failures.push("shared_url_count_too_low");
    requireResponseHistoryProof(responseHistory, failures);
    return {
      files,
      sourceCount: Number(artifact.sourceCount) || 0,
      sharedUrlCount: Number(artifact.sharedUrlCount) || 0,
      testPassed: bool(artifact, "testPassed"),
      cliPassed: bool(artifact, "cliPassed"),
      htmlComplete: bool(artifact, "htmlComplete"),
      htmlLinksReport: bool(artifact, "htmlLinksReport"),
      ...responseHistoryEvidence(responseHistory),
    };
  }),
  capability("repo_multi_file_edit", "repo-multi-file-edit", reportFiles.repoMultiFileEdit, "ui-repo-multi-file-edit-smoke", (report, failures) => {
    const artifact = report.artifactEvidence || {};
    const responseHistory = artifact.responseHistory || {};
    const files = artifact.files || {};
    const turns = Array.isArray(report.turnEvidence) ? report.turnEvidence : [];
    for (const key of ["source", "test", "data", "readme", "html"]) {
      if (files[key] !== true) failures.push(`missing_file:${key}`);
    }
    for (const key of ["exportsNormalizeStatus", "exportsSummarizeRecords", "exportsRenderSummaryHtml", "sourceChangedFromFixture", "testUnchanged", "dataUnchanged", "testPassed", "cliPassed", "htmlComplete", "htmlHasChinese", "readmeHasChinese"]) {
      if (artifact[key] !== true) failures.push(`missing_artifact_evidence:${key}`);
    }
    if (turns.length < 2) failures.push("turn_evidence_count_too_low");
    if (turns.some((turn) => !turn || turn.ok !== true)) failures.push("turn_evidence_not_ok");
    requireResponseHistoryProof(responseHistory, failures);
    return {
      files,
      turnCount: turns.length,
      okTurnCount: turns.filter((turn) => turn && turn.ok === true).length,
      sourceChangedFromFixture: bool(artifact, "sourceChangedFromFixture"),
      testUnchanged: bool(artifact, "testUnchanged"),
      dataUnchanged: bool(artifact, "dataUnchanged"),
      testPassed: bool(artifact, "testPassed"),
      cliPassed: bool(artifact, "cliPassed"),
      htmlComplete: bool(artifact, "htmlComplete"),
      readmeHasChinese: bool(artifact, "readmeHasChinese"),
      ...responseHistoryEvidence(responseHistory),
    };
  }),
];

const suiteEntry = readReport(reportFiles.desktopTaskSuite);
const suite = suiteEntry.report || {};
const missingCapabilities = capabilities.filter((item) => item.ok !== true).map((item) => item.id);
const staleCapabilities = capabilities.filter((item) => item.fresh !== true).map((item) => item.id);
const suiteFailures = [];
if (!suiteEntry.present) suiteFailures.push("desktop_task_suite_report_missing");
if (suiteEntry.present && !suiteEntry.parseable) suiteFailures.push("desktop_task_suite_report_unparseable");
if (suiteEntry.parseable) {
  if (suite.ok !== true) suiteFailures.push("desktop_task_suite_not_ok");
  if (suite.suiteProfile !== "agentic") suiteFailures.push("desktop_task_suite_profile_not_agentic");
  if (suite.realTaskEvidenceComplete !== true) suiteFailures.push("desktop_task_suite_evidence_incomplete");
  if (suite.realTaskEvidenceFresh !== true) suiteFailures.push("desktop_task_suite_evidence_not_fresh");
  if (suite.requestedRealTraffic !== false || suite.usedRealTraffic !== false || suite.dryRun !== true) suiteFailures.push("desktop_task_suite_not_no_traffic_dry_run");
}

const failures = [
  ...suiteFailures,
  ...capabilities.flatMap((item) => item.failures.map((failure) => `${item.id}:${failure}`)),
];

const payload = {
  ok: failures.length === 0,
  reportName: "agentic-capability-matrix",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "agentic-capability-matrix-report-only",
  reportRoot,
  maxAgeHours,
  requiredCapabilities,
  complete: missingCapabilities.length === 0,
  fresh: staleCapabilities.length === 0 && suiteEntry.fresh === true,
  suiteProfile: String(suite.suiteProfile || ""),
  desktopTaskSuiteFresh: suiteEntry.fresh === true,
  desktopTaskSuiteComplete: suite.realTaskEvidenceComplete === true,
  desktopTaskSuiteEvidenceFresh: suite.realTaskEvidenceFresh === true,
  capabilities,
  missingCapabilities,
  staleCapabilities,
  failures,
  elapsedMs: Date.now() - startedAt,
};

function writeReport(payloadToWrite) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-agentic-capability-matrix.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-agentic-capability-matrix.json`);
  const body = `${JSON.stringify({ ...payloadToWrite, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, body, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `${createHash("sha256").update(body).digest("hex")}\n`, "ascii");
  }
  return { latest, history };
}

const report = writeReport(payload);
console.log(JSON.stringify({ ...payload, report }));
if (!payload.ok) process.exit(1);
