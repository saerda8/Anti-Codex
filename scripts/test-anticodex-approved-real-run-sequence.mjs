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
const BASE_REQUIRED_RELEASE_GATES = ["accountProxyReadiness", "postVerification"];

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

function stage(id, phase, command, options = {}) {
  return {
    id,
    phase,
    command,
    requiresRealTraffic: options.requiresRealTraffic === true,
    startsLogin: options.startsLogin === true,
    requiresExplicitUserApproval: options.requiresExplicitUserApproval === true,
    requiresGatewayStart: options.requiresGatewayStart === true,
    highImpact: options.highImpact === true,
    failFastIfNotReady: options.failFastIfNotReady === true,
    expectedReport: String(options.expectedReport || ""),
    evidence: asStringArray(options.evidence),
  };
}

const readinessReport = readReport("latest-goal-real-run-readiness.json");
const approvalReport = readReport("latest-real-approval-plan.json");
const sequenceReport = readReport("latest-required-real-traffic-sequence.json");
const releaseReport = readReport("latest-release-gates.json");
const accountReport = readReport("latest-antigravity-account-isolation-status.json");
const secondAccountLoginEntrypointReport = readReport("latest-second-antigravity-account-login-entrypoint.json");

const readiness = readinessReport.report || {};
const approval = approvalReport.report || {};
const sequence = sequenceReport.report || {};
const release = releaseReport.report || {};
const account = accountReport.report || {};
const secondAccountLoginEntrypoint = secondAccountLoginEntrypointReport.report || {};

const pendingRealTaskScenarios = asObjectArray(readiness.pendingRealTaskScenarios).map((item) => ({
  taskMode: String(item.taskMode || ""),
  workType: String(item.workType || ""),
  realTrafficRequired: item.realTrafficRequired === true,
  acceptanceEvidence: asStringArray(item.acceptanceEvidence),
  expectedResultPresent: item.expectedResultPresent === true,
})).filter((item) => item.taskMode);
const uniqueRefreshTasks = asStringArray(readiness.uniqueRefreshTasks);
const realTaskRefreshNeeded = readiness.realTaskRefreshNeeded === true;
const expectedRealTaskModes = realTaskRefreshNeeded
  ? (uniqueRefreshTasks.length > 0 ? uniqueRefreshTasks : pendingRealTaskScenarios.map((item) => item.taskMode))
  : [];
const requiredActionIds = asStringArray(sequence.requiredActionIds);
const completedRequiredGateIds = asStringArray(sequence.completedRequiredGateIds);
const requiredReleaseComplete = sequence.requiredReleaseComplete === true;
const optionalActionIds = asStringArray(sequence.optionalActionIds);
const requiredGateIds = asStringArray(sequence.requiredGateIds);
const requiredBlockedGates = asStringArray(readiness.requiredRealTrafficBlockedGates);
const selfCycleGateIds = new Set(["realApprovalPlan", "goalReadiness", "requiredRealTrafficSequence", "goalRealRunReadiness", "approvedRealRunSequence"]);
const effectiveReleaseMissing = asStringArray(release.missingRequired).filter((gateId) => !selfCycleGateIds.has(gateId));
const effectiveReleaseReady = release.releaseReady === true
  || (release.shortReady === true && effectiveReleaseMissing.length === 0 && requiredBlockedGates.length === 0);
const realTaskCommand = String(approval.realTaskRefresh?.command || "");
const requiredReleaseActionStages = asObjectArray(approval.releaseRealTrafficGates?.requiredActions)
  .map((item) => stage(String(item.id || "required-release-real-traffic"), String(item.phase || "required-release-real-traffic"), String(item.command || ""), {
    requiresRealTraffic: true,
    requiresExplicitUserApproval: true,
    requiresGatewayStart: item.requiresGatewayStart === true,
    highImpact: item.highImpact === true,
    failFastIfNotReady: true,
    expectedReport: item.id ? `latest-${String(item.id).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.json` : "",
    evidence: [String(item.id || "requiredReleaseGate"), "usedRealTraffic"],
  }))
  .filter((item) => item.id && item.command);
const accountProofPlan = account.postLoginProofPlan && typeof account.postLoginProofPlan === "object" ? account.postLoginProofPlan : {};
const accountProofCommand = String(secondAccountLoginEntrypoint.postLoginProofCommandTemplate || accountProofPlan.commandTemplate || "");
const loginCommand = String(secondAccountLoginEntrypoint.approvedLoginCommandTemplate || "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\start-anticodex-second-antigravity-account-login.ps1 -WindowsUser .\\AntiCodexModel -StartLogin -StartLoginApproval start-separate-windows-user-login");
const noTrafficStatusCommand = String(secondAccountLoginEntrypoint.nextNoTrafficStatusCommand || "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-antigravity-account-isolation-status.ps1 -WindowsUser .\\AntiCodexModel");

const noTrafficPrechecks = [
  stage("windowsUserAccountPrepare", "no-traffic-precheck", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-windows-user-account-prepare.ps1", {
    expectedReport: "latest-windows-user-account-prepare.json",
    failFastIfNotReady: true,
    evidence: ["readyForInteractiveLogin", "safeToAskUserForSecondAccountLogin"],
  }),
  stage("accountIsolationStatus", "no-traffic-precheck", noTrafficStatusCommand, {
    expectedReport: "latest-antigravity-account-isolation-status.json",
    failFastIfNotReady: true,
    evidence: ["safeToAskUserForSecondAccountLogin", "releaseAcceptableAccountProof"],
  }),
  stage("secondAccountLoginEntrypointStatus", "no-traffic-precheck", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-second-account-login-entrypoint.ps1", {
    expectedReport: "latest-second-antigravity-account-login-entrypoint.json",
    failFastIfNotReady: true,
    evidence: ["safeToStartLogin", "completionState"],
  }),
  stage("goalRealRunReadiness", "no-traffic-precheck", "node scripts\\test-anticodex-goal-real-run-readiness.mjs", {
    expectedReport: "latest-goal-real-run-readiness.json",
    failFastIfNotReady: true,
    evidence: ["pendingRealTaskScenarios", "requiredRealTrafficBlockedGates"],
  }),
];

const approvedRealRunSequence = [
  ...noTrafficPrechecks,
  stage("createOrVerifyTargetWindowsUser", "operator-setup", "Windows Settings > Accounts > Other users > create or verify .\\AntiCodexModel", {
    highImpact: true,
    failFastIfNotReady: true,
    evidence: ["targetWindowsUser", "targetUserSidDiffersFromCurrentUser"],
  }),
  stage("secondAntigravityAccountLogin", "interactive-login", loginCommand, {
    startsLogin: true,
    requiresExplicitUserApproval: true,
    highImpact: true,
    failFastIfNotReady: true,
    evidence: ["separate-windows-user", "StartLoginApproval"],
  }),
  stage("separateAccountIdentityProof", "account-proof-real-traffic", accountProofCommand, {
    requiresRealTraffic: true,
    requiresExplicitUserApproval: true,
    highImpact: true,
    failFastIfNotReady: true,
    expectedReport: "latest-antigravity-cli-real-smoke.json",
    evidence: ["separateAccountVerified", "accountIdentityComparison", "SeparateAccountProofApprovalId"],
  }),
  ...(realTaskRefreshNeeded ? [
    stage("refreshConcreteRealTasks", "real-task-refresh", realTaskCommand, {
      requiresRealTraffic: true,
      requiresExplicitUserApproval: true,
      requiresGatewayStart: true,
      highImpact: true,
      failFastIfNotReady: true,
      expectedReport: "latest-desktop-task-suite.json",
      evidence: [...expectedRealTaskModes, "usedRealTraffic"],
    }),
  ] : []),
  ...(requiredReleaseActionStages.length > 0 ? requiredReleaseActionStages : [
    stage("accountProxyReadiness", "required-release-real-traffic", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-account-proxy-readiness.ps1 -TimeoutSec 120", {
      requiresRealTraffic: true,
      requiresExplicitUserApproval: true,
      requiresGatewayStart: true,
      failFastIfNotReady: true,
      expectedReport: "latest-account-proxy-readiness.json",
      evidence: ["accountReady", "refreshOk", "realRequestOk"],
    }),
    stage("postVerification", "required-release-real-traffic", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10", {
      requiresRealTraffic: true,
      requiresExplicitUserApproval: true,
      requiresGatewayStart: true,
      highImpact: true,
      failFastIfNotReady: true,
      expectedReport: "latest-post-verification.json",
      evidence: ["overallOk", "releaseReady", "usedRealTraffic"],
    }),
  ]),
];

const optionalActionsSeparated = optionalActionIds.length > 0 && optionalActionIds.every((id) => !requiredActionIds.includes(id));
const accountReadinessBlockingReason = String(account.readinessBlockingReason || account.blockingReason || "");
const readyToRequestSecondAccountLoginApproval = account.safeToAskUserForSecondAccountLogin === true
  && secondAccountLoginEntrypoint.safeToStartLogin === true
  && account.releaseAcceptableAccountProof !== true;
const readyToRequestPostLoginProofApproval = account.safeToAskUserForSecondAccountLogin === true
  && accountProofPlan.canRunAfterInteractiveLogin === true
  && account.releaseAcceptableAccountProof !== true;
const readyToRequestUserApproval = readyToRequestSecondAccountLoginApproval || readyToRequestPostLoginProofApproval;
const executionBlockedBeforeRealTraffic = account.safeToAskUserForSecondAccountLogin !== true
  || account.releaseAcceptableAccountProof !== true
  || readiness.safeToAskUserForSecondAccountLogin !== true
  || readiness.releaseAcceptableAccountProof !== true;
const failures = [];

for (const source of [readinessReport, approvalReport, sequenceReport, releaseReport, accountReport, secondAccountLoginEntrypointReport]) {
  if (!source.present) failures.push(`missing_${source.fileName}`);
  else if (!source.parseable) failures.push(`unparseable_${source.fileName}`);
}
for (const sourceReport of [readiness, approval, sequence]) {
  if (sourceReport.requestedRealTraffic !== false || sourceReport.usedRealTraffic !== false) failures.push(`${sourceReport.reportName || "source"}_not_no_traffic`);
}
for (const taskMode of expectedRealTaskModes) {
  if (!uniqueRefreshTasks.includes(taskMode)) failures.push(`missing_real_task:${taskMode}`);
  const scenario = pendingRealTaskScenarios.find((item) => item.taskMode === taskMode);
  if (!scenario) failures.push(`missing_real_task_scenario:${taskMode}`);
  else if (scenario.realTrafficRequired !== true || scenario.acceptanceEvidence.length < 1 || scenario.expectedResultPresent !== true) failures.push(`incomplete_real_task_scenario:${taskMode}`);
}
for (const gateId of (requiredGateIds.length > 0 ? requiredGateIds : BASE_REQUIRED_RELEASE_GATES)) {
  if (!requiredGateIds.includes(gateId)) failures.push(`missing_required_gate:${gateId}`);
  if (completedRequiredGateIds.includes(gateId)) {
    continue;
  }
  if (requiredReleaseComplete) {
    if (!completedRequiredGateIds.includes(gateId)) failures.push(`missing_completed_required_gate:${gateId}`);
  } else {
    if (!requiredActionIds.includes(gateId)) failures.push(`missing_required_action:${gateId}`);
    if (!requiredBlockedGates.includes(gateId)) failures.push(`missing_blocked_gate:${gateId}`);
  }
}
if (!optionalActionsSeparated) failures.push("optional_actions_mixed_into_required_sequence");
if (realTaskRefreshNeeded && (!realTaskCommand.includes("--allow-real-traffic") || expectedRealTaskModes.some((taskMode) => !realTaskCommand.includes(taskMode)))) failures.push("real_task_refresh_command_not_concrete");
if (!loginCommand.includes("-StartLoginApproval start-separate-windows-user-login")) failures.push("login_command_missing_approval_token");
if (!loginCommand.includes("-WindowsUser")) failures.push("login_command_missing_windows_user");
if (accountProofCommand && !accountProofCommand.includes("SeparateAccountProofApprovalId")) failures.push("account_proof_command_missing_approval_id");
if (accountProofCommand && !accountProofCommand.includes("-AllowSeparateAccountProof")) failures.push("account_proof_command_missing_separate_account_flag");
if (executionBlockedBeforeRealTraffic !== (account.releaseAcceptableAccountProof !== true || readiness.releaseAcceptableAccountProof !== true)) failures.push("execution_block_state_inconsistent");
if (readyToRequestUserApproval && executionBlockedBeforeRealTraffic !== true) failures.push("approval_ready_after_execution_unblocked");
if (readyToRequestSecondAccountLoginApproval && accountReadinessBlockingReason) failures.push("login_approval_ready_with_blocking_reason");
if (approvedRealRunSequence.some((item) => item.requiresRealTraffic && item.requiresExplicitUserApproval !== true)) failures.push("real_traffic_stage_without_explicit_approval");
if (approvedRealRunSequence.some((item) => item.startsLogin && item.requiresExplicitUserApproval !== true)) failures.push("login_stage_without_explicit_approval");
if (release.shortReady !== true) failures.push("short_path_not_ready");

const payload = {
  ok: failures.length === 0,
  reportName: "approved-real-run-sequence",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "approved-real-run-sequence-report-only",
  executionBlockedBeforeRealTraffic,
  readyToRequestUserApproval,
  readyToRequestSecondAccountLoginApproval,
  readyToRequestPostLoginProofApproval,
  sourceReports: {
    goalRealRunReadiness: { present: readinessReport.present, parseable: readinessReport.parseable },
    realApprovalPlan: { present: approvalReport.present, parseable: approvalReport.parseable },
    requiredRealTrafficSequence: { present: sequenceReport.present, parseable: sequenceReport.parseable },
    releaseGates: { present: releaseReport.present, parseable: releaseReport.parseable },
    accountIsolation: { present: accountReport.present, parseable: accountReport.parseable },
    secondAccountLoginEntrypoint: { present: secondAccountLoginEntrypointReport.present, parseable: secondAccountLoginEntrypointReport.parseable },
  },
  noTrafficPrechecks,
  approvedRealRunSequence,
  sequenceStageCount: approvedRealRunSequence.length,
  explicitApprovalStageCount: approvedRealRunSequence.filter((item) => item.requiresExplicitUserApproval).length,
  realTrafficStageCount: approvedRealRunSequence.filter((item) => item.requiresRealTraffic).length,
  startsLoginStageCount: approvedRealRunSequence.filter((item) => item.startsLogin).length,
  requiredRealTaskModes: expectedRealTaskModes,
  pendingRealTaskScenarios,
  requiredReleaseGateIds: requiredGateIds.length > 0 ? requiredGateIds : BASE_REQUIRED_RELEASE_GATES,
  requiredActionIds,
  completedRequiredGateIds,
  requiredReleaseComplete,
  optionalActionIds,
  optionalActionsSeparated,
  requiredRealTrafficBlockedGates: requiredBlockedGates,
  releaseShortReady: release.shortReady === true,
  releaseReady: effectiveReleaseReady,
  accountCompletionState: String(account.completionState || ""),
  accountReadinessBlockingReason,
  safeToAskUserForSecondAccountLogin: account.safeToAskUserForSecondAccountLogin === true,
  releaseAcceptableAccountProof: account.releaseAcceptableAccountProof === true,
  operatorNextAction: accountReadinessBlockingReason === "target_windows_user_missing"
    ? "complete_separate_windows_user_account_setup_before_any_real_traffic"
    : (readyToRequestSecondAccountLoginApproval
      ? "request_explicit_user_approval_for_second_account_login"
      : (readyToRequestPostLoginProofApproval
        ? "request_explicit_user_approval_for_separate_account_identity_proof"
        : (executionBlockedBeforeRealTraffic
          ? "complete_second_account_login_and_identity_proof_before_real_traffic"
          : "request_explicit_user_approval_for_approved_real_run_sequence"))),
  failures,
  failureCount: failures.length,
  elapsedMs: Date.now() - startedAt,
};

mkdirSync(reportRoot, { recursive: true });
const latest = resolve(reportRoot, "latest-approved-real-run-sequence.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
const history = resolve(reportRoot, `${stamp}-approved-real-run-sequence.json`);
const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
for (const file of [latest, history]) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, json, "utf8");
  renameSync(temp, file);
  writeFileSync(`${file}.sha256`, `${createHash("sha256").update(json).digest("hex")}\n`, "ascii");
}

console.log(JSON.stringify({ ...payload, report: { latest, history } }));
