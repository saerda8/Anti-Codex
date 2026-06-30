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

function readReport(fileName) {
  const path = resolve(reportRoot, fileName);
  if (!existsSync(path)) return { fileName, path, present: false, parseable: false, report: null };
  try {
    return { fileName, path, present: true, parseable: true, report: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { fileName, path, present: true, parseable: false, error: String(error?.message || error || "JSON parse failed"), report: null };
  }
}

function asArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asObjectArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function makeAction(id, phase, command, options = {}) {
  return {
    id,
    phase,
    command,
    requiresRealTraffic: options.requiresRealTraffic === true,
    requiresGatewayStart: options.requiresGatewayStart === true,
    highImpact: options.highImpact === true,
    startsLogin: options.startsLogin === true,
    blockedUntilExplicitUserApproval: options.blockedUntilExplicitUserApproval === true,
    blockedByOperatorSetup: options.blockedByOperatorSetup === true,
    reason: String(options.reason || ""),
  };
}

const roadmapReport = readReport("latest-real-task-coverage-roadmap.json");
const goalReport = readReport("latest-goal-readiness.json");
const releaseReport = readReport("latest-release-gates.json");
const accountReport = readReport("latest-antigravity-account-isolation-status.json");

const roadmap = roadmapReport.report || {};
const goal = goalReport.report || {};
const release = releaseReport.report || {};
const account = accountReport.report || {};

const uniqueRefreshTasks = asArray(roadmap.uniqueRefreshTasks);
const pendingRealTaskScenarios = asObjectArray(roadmap.pendingRealTaskScenarios)
  .map((item) => ({
    taskMode: String(item.taskMode || ""),
    workType: String(item.workType || ""),
    realTrafficRequired: item.realTrafficRequired === true,
    acceptanceEvidence: asArray(item.acceptanceEvidence),
    expectedResultPresent: typeof item.expectedResult === "string" && item.expectedResult.trim().length > 0,
  }))
  .filter((item) => item.taskMode);
const requiredRealTrafficBlockedGates = asArray(release.requiredRealTrafficBlockedGates);
const releaseNextActions = Array.isArray(release.nextActions) ? release.nextActions : [];
const releaseRealTrafficActions = releaseNextActions
  .filter((item) => item?.requiresRealTraffic === true)
  .map((item) => makeAction(
    String(item?.id || item?.gateId || "release-real-traffic"),
    String(item?.phase || "real-traffic"),
    String(item?.command || ""),
    {
      requiresRealTraffic: item?.requiresRealTraffic === true,
      requiresGatewayStart: item?.requiresGatewayStart === true,
      highImpact: item?.highImpact === true,
      blockedUntilExplicitUserApproval: item?.blockedUntilExplicitUserApproval === true,
      reason: String(item?.reason || ""),
    },
  ));
const requiredReleaseRealTrafficActions = releaseRealTrafficActions.filter((item) => requiredRealTrafficBlockedGates.includes(item.id));
const optionalReleaseRealTrafficActions = releaseRealTrafficActions.filter((item) => !requiredRealTrafficBlockedGates.includes(item.id));

const targetUserMissing = account.readinessBlockingReason === "target_windows_user_missing"
  || account.blockingReason === "target_windows_user_missing"
  || goal.antigravityAccountIsolation?.blockingReason === "target_windows_user_missing";
const accountSetupBlocked = account.safeToAskUserForSecondAccountLogin !== true || account.releaseAcceptableAccountProof !== true;
const accountProofPlan = account.postLoginProofPlan && typeof account.postLoginProofPlan === "object" ? account.postLoginProofPlan : {};
const accountProofCommand = typeof accountProofPlan.commandTemplate === "string"
  ? accountProofPlan.commandTemplate
  : "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-antigravity-cli-real-smoke.ps1 -AllowRealTraffic -AccountIsolationBoundary separate-windows-user -AllowSeparateAccountProof";
const minimalRefreshCommand = typeof roadmap.minimalRefreshCommand === "string" ? roadmap.minimalRefreshCommand : "";
const minimalRefreshCommandArgs = asArray(roadmap.minimalRefreshCommandArgs);
const roadmapRefreshApprovalSummary = roadmap.refreshApprovalSummary && typeof roadmap.refreshApprovalSummary === "object" ? roadmap.refreshApprovalSummary : {};

const realTaskRefresh = {
  needed: uniqueRefreshTasks.length > 0,
  uniqueRefreshTasks,
  pendingRealTaskScenarios,
  command: minimalRefreshCommand,
  commandArgs: minimalRefreshCommandArgs,
  approvalSummary: {
    requiresExplicitUserApproval: roadmapRefreshApprovalSummary.requiresExplicitUserApproval === true || uniqueRefreshTasks.length > 0,
    approvalReason: String(roadmapRefreshApprovalSummary.approvalReason || (uniqueRefreshTasks.length > 0 ? "explicit_user_approval_required_for_desktop_task_refresh" : "")),
    taskCount: Number.isFinite(Number(roadmapRefreshApprovalSummary.taskCount)) ? Number(roadmapRefreshApprovalSummary.taskCount) : uniqueRefreshTasks.length,
    refreshTaskModes: asArray(roadmapRefreshApprovalSummary.refreshTaskModes).length > 0 ? asArray(roadmapRefreshApprovalSummary.refreshTaskModes) : uniqueRefreshTasks,
    nextProfilesNeedingRealTraffic: asArray(roadmapRefreshApprovalSummary.nextProfilesNeedingRealTraffic).length > 0 ? asArray(roadmapRefreshApprovalSummary.nextProfilesNeedingRealTraffic) : asArray(roadmap.nextProfilesNeedingRealTraffic),
  },
  requiresRealTraffic: uniqueRefreshTasks.length > 0,
  blockedUntilExplicitUserApproval: uniqueRefreshTasks.length > 0,
  nextProfilesNeedingRealTraffic: asArray(roadmap.nextProfilesNeedingRealTraffic),
};

const releaseRealTrafficGates = {
  needed: requiredRealTrafficBlockedGates.length > 0,
  gateIds: requiredRealTrafficBlockedGates,
  actions: requiredReleaseRealTrafficActions,
  requiredActions: requiredReleaseRealTrafficActions,
  optionalActions: optionalReleaseRealTrafficActions,
  optionalGateIds: optionalReleaseRealTrafficActions.map((item) => item.id),
  releaseBlockedOnlyByRequiredRealTraffic: release.releaseBlockedOnlyByRequiredRealTraffic === true,
};

const accountIsolation = {
  completionState: String(account.completionState || goal.antigravityAccountIsolation?.completionState || ""),
  readinessBlockingReason: String(account.readinessBlockingReason || account.blockingReason || goal.antigravityAccountIsolation?.blockingReason || ""),
  targetUserExists: account.targetUserExists === true,
  targetUserMissing,
  safeToAskUserForSecondAccountLogin: account.safeToAskUserForSecondAccountLogin === true,
  safeToStartLogin: account.safeToStartLogin === true,
  releaseAcceptableAccountProof: account.releaseAcceptableAccountProof === true,
  accountSetupBlocked,
  requiresSeparateWindowsUser: true,
};
const preLoginChecklist = [
  {
    id: "windows-user-account-prepare",
    report: "latest-windows-user-account-prepare.json",
    command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-windows-user-account-prepare.ps1",
    noTraffic: true,
    mustPassBeforeLogin: true,
    expectedReadyField: "readyForInteractiveLogin",
  },
  {
    id: "account-isolation-status",
    report: "latest-antigravity-account-isolation-status.json",
    command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-antigravity-account-isolation-status.ps1",
    noTraffic: true,
    mustPassBeforeLogin: true,
    expectedReadyField: "safeToAskUserForSecondAccountLogin",
  },
  {
    id: "second-account-login-entrypoint-status",
    report: "latest-second-antigravity-account-login-entrypoint.json",
    command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-second-account-login-entrypoint.ps1",
    noTraffic: true,
    mustPassBeforeLogin: true,
    expectedReadyField: "safeToStartLogin",
  },
];

const orderedActions = [
  makeAction("rerun-no-traffic-status", "report-only", "node scripts\\test-anticodex-real-approval-plan.mjs", { reason: "refresh_plan_only" }),
  makeAction("create-or-verify-target-windows-user", "operator-setup", "Windows Settings > Accounts > Other users > create or verify .\\AntiCodexModel", {
    blockedByOperatorSetup: targetUserMissing,
    highImpact: true,
    reason: accountIsolation.readinessBlockingReason,
  }),
  makeAction("second-antigravity-account-login", "interactive-login", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\start-anticodex-second-antigravity-account-login.ps1 -StartLogin -StartLoginApproval start-separate-windows-user-login", {
    startsLogin: true,
    blockedByOperatorSetup: accountSetupBlocked,
    blockedUntilExplicitUserApproval: true,
    reason: accountIsolation.completionState,
  }),
  makeAction("second-account-identity-real-smoke", "account-proof-real-traffic", accountProofCommand, {
    requiresRealTraffic: true,
    blockedByOperatorSetup: accountSetupBlocked,
    blockedUntilExplicitUserApproval: true,
    highImpact: true,
    reason: "separate_account_identity_proof_required",
  }),
];

if (realTaskRefresh.needed) {
  orderedActions.push(makeAction("refresh-real-task-coverage", "real-task-refresh", minimalRefreshCommand, {
    requiresRealTraffic: true,
    blockedUntilExplicitUserApproval: true,
    highImpact: true,
    reason: "real_task_coverage_refresh_required",
  }));
}
for (const item of requiredReleaseRealTrafficActions) orderedActions.push(item);

const payload = {
  ok: true,
  reportName: "real-approval-plan",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "real-approval-plan-report-only",
  reportRoot,
  sourceReports: {
    realTaskCoverageRoadmap: { present: roadmapReport.present, parseable: roadmapReport.parseable },
    goalReadiness: { present: goalReport.present, parseable: goalReport.parseable },
    releaseGates: { present: releaseReport.present, parseable: releaseReport.parseable },
    accountIsolation: { present: accountReport.present, parseable: accountReport.parseable },
  },
  realTaskRefresh,
  releaseRealTrafficGates,
  accountIsolation,
  preLoginChecklist,
  preLoginChecklistComplete: preLoginChecklist.every((item) => item.noTraffic === true && item.mustPassBeforeLogin === true && item.report && item.command),
  preLoginChecklistCount: preLoginChecklist.length,
  orderedActions,
  blockedUntilExplicitUserApprovalCount: orderedActions.filter((item) => item.blockedUntilExplicitUserApproval).length,
  requiresRealTrafficCount: orderedActions.filter((item) => item.requiresRealTraffic).length,
  operatorSetupBlockedCount: orderedActions.filter((item) => item.blockedByOperatorSetup).length,
  requiredReleaseRealTrafficActionCount: requiredReleaseRealTrafficActions.length,
  optionalReleaseRealTrafficActionCount: optionalReleaseRealTrafficActions.length,
  nextNoTrafficAction: targetUserMissing ? "create_or_verify_target_windows_user_then_rerun_account_prepare" : "rerun_real_approval_plan",
  elapsedMs: Date.now() - startedAt,
};

mkdirSync(reportRoot, { recursive: true });
const latest = resolve(reportRoot, "latest-real-approval-plan.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
const history = resolve(reportRoot, `${stamp}-real-approval-plan.json`);
const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
for (const file of [latest, history]) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, json, "utf8");
  renameSync(temp, file);
  writeFileSync(`${file}.sha256`, `${createHash("sha256").update(json).digest("hex")}\n`, "ascii");
}

console.log(JSON.stringify({ ...payload, report: { latest, history } }));
