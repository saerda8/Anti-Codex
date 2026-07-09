#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const value = process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[++index] : "1";
  args.set(key, value);
}

if (args.has("--help") || args.has("-h")) {
  console.log([
    "Usage: node scripts/build-anticodex-goal-unblock-package.mjs",
    "  [--report-root PATH] [--source-report-root PATH] [--compact]",
    "",
    "Builds a no-traffic machine-readable handoff for deferred operator-only follow-ups.",
  ].join("\n"));
  process.exit(0);
}

const startedAt = Date.now();
const defaultReportRoot = resolve(join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const reportRoot = resolve(args.get("--report-root") || defaultReportRoot);
const sourceReportRoot = resolve(args.get("--source-report-root") || defaultReportRoot);
const compact = args.has("--compact");

function readReport(fileName) {
  const path = resolve(sourceReportRoot, fileName);
  if (!existsSync(path)) return { path, present: false, parseable: false, report: null };
  try {
    return {
      path,
      present: true,
      parseable: true,
      report: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")),
    };
  } catch (error) {
    return { path, present: true, parseable: false, report: null, error: String(error?.message || error) };
  }
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function writeSignedReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-goal-unblock-package.json");
  const history = resolve(reportRoot, `${utcStamp()}-goal-unblock-package.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asString(value) {
  return value === undefined || value === null ? "" : String(value);
}

const goalFile = readReport("latest-goal-readiness.json");
const workerRecoveryFile = readReport("latest-current-channel-worker-recovery.json");
const workerTransportFile = readReport("latest-current-channel-worker-transport.json");
const secondSummaryFile = readReport("latest-second-account-readiness-summary.json");
const postLoginProofFile = readReport("latest-second-account-post-login-proof.json");
const externalMcpIdentityFile = readReport("latest-external-mcp-identity-contract.json");
const releaseGatesFile = readReport("latest-release-gates.json");

const goal = goalFile.report || {};
const goalCard = goal.goalOperatorActionCard || {};
const workerRecovery = workerRecoveryFile.report || {};
const workerTransport = workerTransportFile.report || {};
const secondSummary = secondSummaryFile.report || {};
const postLoginProof = postLoginProofFile.report || {};
const postLoginCard = postLoginProof.operatorActionCard || {};
const checklist = postLoginProof.accountIdentityInputChecklist || {};
const externalContract = externalMcpIdentityFile.report || {};
const releaseGates = releaseGatesFile.report || {};

const recommendedFirstReadOnlyProbe = workerRecovery.recommendedFirstReadOnlyProbe
  || goalCard.workerRecoveryRecommendedFirstReadOnlyProbe
  || goal.workerTransportRecoveryReadiness?.recommendedFirstReadOnlyProbe
  || null;

const blockers = asStringArray(goal.blockers);
const remainingObjectiveRequirementIds = asStringArray(goal.objectiveRequirementSummary?.incompleteRequirementIds);
const deferredObjectiveRequirementIds = asStringArray(goal.deferredObjectiveRequirementSummary?.deferredRequirementIds);
const incompleteDeferredObjectiveRequirementIds = asStringArray(goal.deferredObjectiveRequirementSummary?.incompleteDeferredRequirementIds);
const deferredBlockers = asStringArray(goal.deferredBlockers);
const releaseReady = goal.releaseGateStatus?.releaseReady === true || releaseGates.releaseReady === true;
const canClaimFullGoalNow = goal.goalComplete === true && goal.objectiveRequirementSummary?.canClaimFullGoalNow === true;
const fullObjectiveCanClaimFullGoalNow = goal.fullObjectiveRequirementSummary?.canClaimFullGoalNow === true;
const targetUserExists = secondSummary.targetUserExists === true || postLoginProof.targetUserExists === true;
const effectiveAntiCodexAccountIdPresent = checklist.effectiveAntiCodexAccountIdPresent === true
  || postLoginProof.effectiveAntiCodexAccountIdPresent === true
  || postLoginProof.proofInputs?.effectiveAntiCodexAccountIdPresent === true;
const effectiveMcpAccountIdPresent = checklist.effectiveMcpAccountIdPresent === true
  || postLoginProof.effectiveMcpAccountIdPresent === true
  || postLoginProof.proofInputs?.effectiveMcpAccountIdPresent === true;

const freshChannelWorkerProof = {
  status: asString(workerRecovery.status || goal.currentChannelWorkerTransportStatus || ""),
  latestTransportCheckedAt: asString(workerTransport.checkedAt || ""),
  workerObservationCount: Number(workerTransport.workerObservationCount || workerRecovery.currentChannelWorkerObservationCount || 0),
  workerTransportFailedCount: Number(workerTransport.workerTransportFailedCount || workerRecovery.currentChannelWorkerTransportFailedCount || 0),
  workerTransportOkCount: Number(workerTransport.workerTransportOkCount || 0),
  genericMcpControlOk: workerTransport.genericMcpControlOk === true || workerRecovery.currentChannelGenericMcpStatus === "ok",
  directProbeOk: workerTransport.directProbeReport?.ok === true || workerRecovery.directProbeOk === true,
  requiresFreshCodexChannel: goalCard.requiresFreshCodexChannel === true || workerRecovery.requiresCodexMcpReload === true,
  requiresFreshReadOnlyProbe: workerRecovery.requiresFreshReadOnlyProbe === true || goal.workerTransportRecoveryReadiness?.requiresFreshReadOnlyProbe === true,
  canDispatchCurrentChannelWorkers: workerRecovery.canDispatchCurrentChannelWorkers === true || goal.currentChannelWorkerCanDispatch === true,
  sameChannelRetryRecommended: workerRecovery.repeatedFailureAudit?.sameChannelRetryRecommended === true,
  repeatedCurrentChannelWorkerFailure: workerRecovery.repeatedFailureAudit?.repeatedCurrentChannelWorkerFailure === true,
  namespaceWideRepeatedWorkerFailure: workerRecovery.repeatedFailureAudit?.namespaceWideRepeatedWorkerFailure === true,
  currentFailureHiddenByHistoricalOk: workerRecovery.repeatedFailureAudit?.currentFailureHiddenByHistoricalOk === true,
  recommendedFirstReadOnlyProbe,
  statusCommand: asString(goalCard.workerRecoveryStatusCommand || "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-current-channel-worker-recovery.ps1 -Compact"),
  recordCommand: asString(recommendedFirstReadOnlyProbe?.recordCommand || goalCard.workerRecoveryCommand || ""),
  proofReport: "latest-current-channel-worker-recovery.json",
};
const workerRecoveryStillRequired = freshChannelWorkerProof.canDispatchCurrentChannelWorkers !== true;

const secondAccountProof = {
  requiresUserPresence: goalCard.requiresUserPresence === true || targetUserExists !== true,
  windowsUser: asString(secondSummary.windowsUser || postLoginProof.windowsUser || ".\\AntiCodexModel"),
  targetUserExists,
  targetUserEnabled: secondSummary.targetUserEnabled ?? null,
  readyForOperatorLogin: secondSummary.readyForOperatorLogin === true,
  safeToAskUserForSecondAccountLogin: secondSummary.safeToAskUserForSecondAccountLogin === true || postLoginProof.safeToAskUserForSecondAccountLogin === true,
  canProceedToInteractiveLogin: secondSummary.canProceedToInteractiveLogin === true,
  postLoginProofStatus: asString(postLoginCard.status || goal.secondAccountPostLoginProofStatus || ""),
  effectiveAntiCodexAccountIdPresent,
  effectiveMcpAccountIdPresent,
  approvalIdPresent: checklist.approvalId?.provided === true || postLoginProof.proofInputs?.separateAccountProofApprovalIdPresent === true,
  statusCommand: asString(goalCard.secondAccountStatusCommand || secondSummary.operatorActionCard?.noTrafficStatusCommand || ""),
  postLoginProofCommand: asString(goalCard.secondAccountPostLoginProofCommand || postLoginCard.noTrafficStatusCommand || ""),
  approvedLoginCommandTemplate: asString(secondSummary.approvedLoginCommandTemplate || secondSummary.operatorActionCard?.approvedLoginCommandTemplate || ""),
  realProofCommandTemplate: asString(postLoginProof.proofCommandPreview || secondSummary.postLoginProofCommandTemplate || ""),
  proofReport: "latest-second-account-post-login-proof.json",
};

const externalMcpIdentityHandoff = {
  contractReportPresent: externalMcpIdentityFile.present && externalMcpIdentityFile.parseable,
  contractAccepted: externalContract.externalMcpIdentityAccepted === true,
  effectiveMcpAccountIdPresent: externalContract.effectiveMcpAccountIdPresent === true,
  mcpAccountIdFromExternalReport: externalContract.mcpAccountIdFromExternalReport === true,
  managedByAntiCodex: externalContract.mcpAccountLaneManagedByAntiCodex === true,
  requiredSource: asString(externalContract.mcpAccountRequiredSource || "external-mcp-antigravity-account"),
  statusCommand: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-external-mcp-identity-contract.ps1",
  proofReport: "latest-external-mcp-identity-contract.json",
};

const machineReadableNextActions = [
  ...(workerRecoveryStillRequired ? [{
    id: "fresh_channel_worker_read_only_probe",
    owner: "fresh-codex-channel",
    reason: "current channel worker calls repeatedly returned Transport closed",
    command: freshChannelWorkerProof.statusCommand,
    recordCommand: freshChannelWorkerProof.recordCommand,
    proofReport: freshChannelWorkerProof.proofReport,
    requiresRealTraffic: false,
    startsLogin: false,
    changesSystem: false,
  }] : [{
    id: "dispatch_scoped_worker_task_after_read_only_success",
    owner: "current-codex-channel",
    reason: "current channel worker read-only proof is healthy",
    command: freshChannelWorkerProof.statusCommand,
    recordCommand: freshChannelWorkerProof.recordCommand,
    proofReport: freshChannelWorkerProof.proofReport,
    requiresRealTraffic: false,
    startsLogin: false,
    changesSystem: false,
  }]),
  {
    id: "create_or_verify_second_windows_user",
    owner: "user",
    reason: "second Antigravity account proof must run under a separate Windows user",
    command: secondAccountProof.statusCommand,
    proofReport: "latest-second-account-readiness-summary.json",
    requiresRealTraffic: false,
    startsLogin: false,
    changesSystem: true,
  },
  {
    id: "external_mcp_account_identity_report",
    owner: "external-mcp-agent",
    reason: "Anti-Codex must not invent the MCP Antigravity account identity",
    command: externalMcpIdentityHandoff.statusCommand,
    proofReport: externalMcpIdentityHandoff.proofReport,
    requiresRealTraffic: false,
    startsLogin: false,
    changesSystem: false,
  },
  {
    id: "approved_second_account_post_login_proof",
    owner: "user-present-anticodex",
    reason: "after the separate Windows user is logged into Antigravity, run the approved real proof",
    command: secondAccountProof.postLoginProofCommand,
    proofReport: secondAccountProof.proofReport,
    requiresRealTraffic: true,
    startsLogin: false,
    changesSystem: false,
  },
];

const failures = [];
if (!goalFile.present || !goalFile.parseable) failures.push("goal_readiness_report_missing_or_unparseable");
if (!workerRecoveryFile.present || !workerRecoveryFile.parseable) failures.push("worker_recovery_report_missing_or_unparseable");
if (!workerTransportFile.present || !workerTransportFile.parseable) failures.push("worker_transport_report_missing_or_unparseable");
if (!secondSummaryFile.present || !secondSummaryFile.parseable) failures.push("second_account_summary_missing_or_unparseable");
if (!postLoginProofFile.present || !postLoginProofFile.parseable) failures.push("second_account_post_login_proof_missing_or_unparseable");
if (!externalMcpIdentityFile.present || !externalMcpIdentityFile.parseable) failures.push("external_mcp_identity_contract_missing_or_unparseable");
if (releaseReady !== true) failures.push("release_ready_not_true");
if (goal.goalComplete !== true) failures.push("goal_unblock_package_goal_not_complete");
if (canClaimFullGoalNow !== true) failures.push("goal_unblock_package_should_claim_current_goal_completion");
if (fullObjectiveCanClaimFullGoalNow !== false) failures.push("goal_unblock_package_full_objective_should_remain_deferred");
if (!deferredObjectiveRequirementIds.includes("separate_antigravity_accounts")) failures.push("missing_separate_account_deferred_requirement");
if (!deferredObjectiveRequirementIds.includes("worker_mcp_multiuse")) failures.push("missing_worker_mcp_deferred_requirement");
if (workerRecoveryStillRequired && !deferredBlockers.includes("current_channel_worker_transport_not_recovered")) failures.push("missing_current_channel_worker_deferred_blocker");
if (!deferredBlockers.includes("second_antigravity_account_real_proof_missing")) failures.push("missing_second_account_deferred_blocker");
if (workerRecoveryStillRequired && !freshChannelWorkerProof.requiresFreshCodexChannel) failures.push("fresh_channel_requirement_missing");
if (workerRecoveryStillRequired && !freshChannelWorkerProof.requiresFreshReadOnlyProbe) failures.push("fresh_read_only_probe_requirement_missing");
if (!freshChannelWorkerProof.recordCommand) failures.push("worker_recovery_record_command_missing");
if (!freshChannelWorkerProof.latestTransportCheckedAt) failures.push("worker_transport_checked_at_missing");
if (freshChannelWorkerProof.workerObservationCount < 3) failures.push("worker_transport_observation_count_too_low");
if (workerRecoveryStillRequired && freshChannelWorkerProof.workerTransportFailedCount < 3) failures.push("worker_transport_failed_count_too_low");
if (!workerRecoveryStillRequired && freshChannelWorkerProof.workerTransportOkCount < 1) failures.push("worker_transport_ok_count_too_low");
if (freshChannelWorkerProof.genericMcpControlOk !== true) failures.push("worker_transport_generic_mcp_control_missing");
if (freshChannelWorkerProof.directProbeOk !== true) failures.push("worker_transport_direct_probe_missing");
if (!secondAccountProof.windowsUser) failures.push("second_account_windows_user_missing");
if (!secondAccountProof.postLoginProofCommand) failures.push("second_account_post_login_command_missing");
if (!externalMcpIdentityHandoff.contractAccepted) failures.push("external_mcp_identity_contract_not_accepted");

const payload = {
  ok: failures.length === 0,
  reportName: "goal-unblock-package",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  changedSystem: false,
  createdUser: false,
  startedLogin: false,
  capturesPassword: false,
  storesPassword: false,
  behaviorCovered: true,
  coverageKind: "goal-unblock-package-report-only",
  sourceReportRoot,
  canClaimFullGoalNow,
  fullObjectiveCanClaimFullGoalNow,
  releaseReady,
  goalComplete: goal.goalComplete === true,
  objectiveRequirementSummary: goal.objectiveRequirementSummary || null,
  fullObjectiveRequirementSummary: goal.fullObjectiveRequirementSummary || null,
  deferredObjectiveRequirementSummary: goal.deferredObjectiveRequirementSummary || null,
  remainingObjectiveRequirementIds,
  deferredObjectiveRequirementIds,
  incompleteDeferredObjectiveRequirementIds,
  blockers,
  deferredBlockers,
  freshChannelWorkerProof,
  secondAccountProof,
  externalMcpIdentityHandoff,
  machineReadableNextActions,
  failures,
  elapsedMs: Date.now() - startedAt,
};

const report = writeSignedReport(payload);
const output = compact
  ? {
    ok: payload.ok,
    reportName: payload.reportName,
    releaseReady: payload.releaseReady,
    canClaimFullGoalNow: payload.canClaimFullGoalNow,
    fullObjectiveCanClaimFullGoalNow: payload.fullObjectiveCanClaimFullGoalNow,
    remainingObjectiveRequirementIds: payload.remainingObjectiveRequirementIds,
    deferredObjectiveRequirementIds: payload.deferredObjectiveRequirementIds,
    incompleteDeferredObjectiveRequirementIds: payload.incompleteDeferredObjectiveRequirementIds,
    blockers: payload.blockers,
    deferredBlockers: payload.deferredBlockers,
    nextActionCount: payload.machineReadableNextActions.length,
    report,
  }
  : { ...payload, report };

console.log(JSON.stringify(output));
process.exit(payload.ok ? 0 : 1);
