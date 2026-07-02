#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) continue;
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1";
  args.set(key, value);
}

const startedAt = Date.now();
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const EXPECTED_REAL_TASK_MODES = ["web-search", "free-chat"];

function readReport(fileName) {
  const path = resolve(reportRoot, fileName);
  if (!existsSync(path)) return { fileName, path, present: false, parseable: false, report: null };
  try {
    return { fileName, path, present: true, parseable: true, report: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { fileName, path, present: true, parseable: false, report: null, error: String(error?.message || error || "JSON parse failed") };
  }
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function asObjectArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

const approvalReport = readReport("latest-real-approval-plan.json");
const goalReport = readReport("latest-goal-readiness.json");
const roadmapReport = readReport("latest-real-task-coverage-roadmap.json");
const sequenceReport = readReport("latest-required-real-traffic-sequence.json");
const approvedSequenceReport = readReport("latest-approved-real-run-sequence.json");
const releaseReport = readReport("latest-release-gates.json");
const accountReport = readReport("latest-antigravity-account-isolation-status.json");

const approval = approvalReport.report || {};
const goal = goalReport.report || {};
const roadmap = roadmapReport.report || {};
const sequence = sequenceReport.report || {};
const approvedSequence = approvedSequenceReport.report || {};
const release = releaseReport.report || {};
const account = accountReport.report || {};

const pendingRealTaskScenarios = asObjectArray(approval.realTaskRefresh?.pendingRealTaskScenarios).map((item) => ({
  taskMode: String(item.taskMode || ""),
  workType: String(item.workType || ""),
  realTrafficRequired: item.realTrafficRequired === true,
  acceptanceEvidence: asStringArray(item.acceptanceEvidence),
  expectedResultPresent: item.expectedResultPresent === true,
})).filter((item) => item.taskMode);

const uniqueRefreshTasks = asStringArray(approval.realTaskRefresh?.uniqueRefreshTasks);
const realTaskRefreshNeeded = approval.realTaskRefresh?.needed === true;
const missingTaskScenarios = uniqueRefreshTasks.filter((taskMode) => !pendingRealTaskScenarios.some((item) => item.taskMode === taskMode));
const requiredReleaseGateIds = asStringArray(sequence.requiredGateIds);
const completedRequiredGateIds = asStringArray(sequence.completedRequiredGateIds);
const requiredReleaseComplete = sequence.requiredReleaseComplete === true;
const requiredActionIds = asStringArray(sequence.requiredActionIds);
const requiredCommands = asStringArray(sequence.commands);
const readyToRequestSecondAccountLoginApproval = approvedSequence.readyToRequestSecondAccountLoginApproval === true;
const readyToRequestPostLoginProofApproval = approvedSequence.readyToRequestPostLoginProofApproval === true;
const readyToRequestUserApproval = approvedSequence.readyToRequestUserApproval === true;
const approvedSequenceAccountReadinessBlockingReason = String(approvedSequence.accountReadinessBlockingReason || "");
const approvedSequenceOperatorNextAction = String(approvedSequence.operatorNextAction || "");
const approvedSequenceBlockingStages = asStringArray(approvedSequence.blockingStages);
if (approvedSequenceBlockingStages.length === 0 && approvedSequenceAccountReadinessBlockingReason) {
  approvedSequenceBlockingStages.push(approvedSequenceAccountReadinessBlockingReason);
}
const selfCycleGateIds = new Set(["realApprovalPlan", "goalReadiness", "requiredRealTrafficSequence", "goalRealRunReadiness", "approvedRealRunSequence"]);
const requiredReleaseMissing = asStringArray(release.missingRequired).filter((gateId) => !selfCycleGateIds.has(gateId));
const requiredRealTrafficBlockedGates = asStringArray(release.requiredRealTrafficBlockedGates);
const effectiveReleaseReady = release.releaseReady === true
  || (release.shortReady === true && requiredReleaseMissing.length === 0 && requiredRealTrafficBlockedGates.length === 0);
const releaseBlockedOnlyByRequiredRealTrafficForGoal = release.releaseBlockedOnlyByRequiredRealTraffic === true
  || (requiredReleaseMissing.length > 0
    && requiredReleaseMissing.length === requiredRealTrafficBlockedGates.length
    && requiredReleaseMissing.every((gateId) => requiredRealTrafficBlockedGates.includes(gateId)));

const blockingStages = [];
if (account.safeToAskUserForSecondAccountLogin !== true) blockingStages.push("second_account_login_not_ready");
if (account.separateAccountVerified === true || account.releaseAcceptableAccountProof === true) blockingStages.push("unexpected_account_proof_claim");
if (approval.realTaskRefresh?.needed === true) blockingStages.push("real_task_refresh_requires_explicit_approval");
if (requiredRealTrafficBlockedGates.length > 0) blockingStages.push("release_gates_require_explicit_real_traffic");
if (effectiveReleaseReady !== true) blockingStages.push("release_not_ready");

const failures = [];
for (const source of [approvalReport, goalReport, roadmapReport, sequenceReport, approvedSequenceReport, releaseReport, accountReport]) {
  if (!source.present) failures.push(`missing_${source.fileName}`);
  else if (!source.parseable) failures.push(`unparseable_${source.fileName}`);
}
if (approval.requestedRealTraffic !== false || approval.usedRealTraffic !== false) failures.push("approval_plan_not_no_traffic");
if (goal.requestedRealTraffic !== false || goal.usedRealTraffic !== false) failures.push("goal_readiness_not_no_traffic");
if (roadmap.requestedRealTraffic !== false || roadmap.usedRealTraffic !== false) failures.push("roadmap_not_no_traffic");
if (sequence.requestedRealTraffic !== false || sequence.usedRealTraffic !== false) failures.push("required_sequence_not_no_traffic");
if (approvedSequence.requestedRealTraffic !== false || approvedSequence.usedRealTraffic !== false) failures.push("approved_sequence_not_no_traffic");
if (realTaskRefreshNeeded && uniqueRefreshTasks.length < 1) failures.push("missing_real_task_refresh_tasks");
for (const taskMode of realTaskRefreshNeeded ? EXPECTED_REAL_TASK_MODES : []) {
  if (!uniqueRefreshTasks.includes(taskMode)) failures.push(`missing_expected_real_task:${taskMode}`);
}
if (missingTaskScenarios.length > 0) failures.push(`missing_pending_task_scenarios:${missingTaskScenarios.join(",")}`);
if (pendingRealTaskScenarios.some((item) => item.realTrafficRequired !== true || item.acceptanceEvidence.length < 1 || item.expectedResultPresent !== true)) failures.push("incomplete_pending_task_scenarios");
for (const requiredGate of (requiredReleaseGateIds.length > 0 ? requiredReleaseGateIds : ["accountProxyReadiness", "postVerification"])) {
  if (!requiredReleaseGateIds.includes(requiredGate)) failures.push(`missing_required_gate:${requiredGate}`);
  if (completedRequiredGateIds.includes(requiredGate)) {
    continue;
  }
  if (requiredReleaseComplete) {
    if (!completedRequiredGateIds.includes(requiredGate)) failures.push(`missing_completed_required_gate:${requiredGate}`);
  } else if (!requiredActionIds.includes(requiredGate)) {
    failures.push(`missing_required_action:${requiredGate}`);
  }
}
if (requiredCommands.length < requiredActionIds.length) failures.push("missing_required_real_traffic_commands");
if (sequence.noOptionalActionsInRequiredSequence !== true) failures.push("optional_actions_mixed_into_required_sequence");
if (release.shortReady !== true) failures.push("short_path_not_ready");
if (effectiveReleaseReady !== true && releaseBlockedOnlyByRequiredRealTrafficForGoal !== true) failures.push("release_not_ready_or_blocked_only_by_required_real_traffic");
if (account.readinessBlockingReason !== "target_windows_user_missing" && account.safeToAskUserForSecondAccountLogin !== true) failures.push("account_blocking_reason_unexpected");

const payload = {
  ok: failures.length === 0,
  reportName: "goal-real-run-readiness",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "goal-real-run-readiness-report-only",
  sourceReports: {
    realApprovalPlan: { present: approvalReport.present, parseable: approvalReport.parseable },
    goalReadiness: { present: goalReport.present, parseable: goalReport.parseable },
    realTaskCoverageRoadmap: { present: roadmapReport.present, parseable: roadmapReport.parseable },
    requiredRealTrafficSequence: { present: sequenceReport.present, parseable: sequenceReport.parseable },
    approvedRealRunSequence: { present: approvedSequenceReport.present, parseable: approvedSequenceReport.parseable },
    releaseGates: { present: releaseReport.present, parseable: releaseReport.parseable },
    accountIsolation: { present: accountReport.present, parseable: accountReport.parseable },
  },
  readyForUserApprovedRealRun: false,
  safeToAskUserForSecondAccountLogin: account.safeToAskUserForSecondAccountLogin === true,
  accountCompletionState: String(account.completionState || ""),
  accountReadinessBlockingReason: String(account.readinessBlockingReason || ""),
  separateAccountVerified: account.separateAccountVerified === true,
  releaseAcceptableAccountProof: account.releaseAcceptableAccountProof === true,
  readyToRequestUserApproval,
  readyToRequestSecondAccountLoginApproval,
  readyToRequestPostLoginProofApproval,
  approvedSequenceOperatorNextAction,
  approvedSequenceNextAction: approvedSequenceOperatorNextAction,
  approvedSequenceBlockingStages,
  approvedSequenceAccountReadinessBlockingReason,
  realTaskRefreshNeeded,
  uniqueRefreshTasks,
  pendingRealTaskScenarios,
  missingTaskScenarios,
  realTaskRefreshCommandPresent: typeof approval.realTaskRefresh?.command === "string" && approval.realTaskRefresh.command.includes("--allow-real-traffic"),
  realTaskRefreshCommandArgs: asStringArray(approval.realTaskRefresh?.commandArgs),
  requiredReleaseGateIds,
  completedRequiredGateIds,
  requiredReleaseComplete,
  requiredActionIds,
  requiredCommandCount: requiredCommands.length,
  requiredRealTrafficBlockedGates,
  releaseShortReady: release.shortReady === true,
  releaseReady: effectiveReleaseReady,
  releaseBlockedOnlyByRequiredRealTraffic: releaseBlockedOnlyByRequiredRealTrafficForGoal,
  missingRequired: requiredReleaseMissing,
  goalComplete: goal.goalComplete === true,
  goalBlockers: asStringArray(goal.blockers),
  blockingStages,
  nextNoTrafficAction: String(approval.nextNoTrafficAction || goal.nextRequiredUserAction || ""),
  operatorNextAction: account.safeToAskUserForSecondAccountLogin === true ? "await_explicit_user_approval_for_login_and_real_tasks" : "create_or_verify_separate_windows_user_then_rerun_account_prepare",
  failures,
  elapsedMs: Date.now() - startedAt,
};

mkdirSync(reportRoot, { recursive: true });
const latest = resolve(reportRoot, "latest-goal-real-run-readiness.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
const history = resolve(reportRoot, `${stamp}-goal-real-run-readiness.json`);
const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
for (const file of [latest, history]) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, json, "utf8");
  renameSync(temp, file);
  writeFileSync(`${file}.sha256`, `${createHash("sha256").update(json).digest("hex")}\n`, "ascii");
}

console.log(JSON.stringify({ ...payload, report: { latest, history } }));
