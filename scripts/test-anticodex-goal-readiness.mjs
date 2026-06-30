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
const requiredWorkerMcpServers = [
  "antigravity-code-worker",
  "deepseek-code-worker",
  "deveco-code-worker",
  "kilo-worker",
  "mimo-claude-coworker",
  "mimocode-worker",
  "opencode-worker",
];
const requiredAgenticTasks = ["coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit"];

function readReport(fileName) {
  const path = resolve(reportRoot, fileName);
  if (!existsSync(path)) return { path, present: false, parseable: false, report: null };
  try {
    return { path, present: true, parseable: true, report: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { path, present: true, parseable: false, error: String(error?.message || error || "JSON parse failed"), report: null };
  }
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-goal-readiness.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-goal-readiness.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

const syncReadiness = readReport("latest-sync-readiness.json");
const mcpSkills = readReport("latest-mcp-skills.json");
const desktopSuite = readReport("latest-desktop-task-suite.json");
const capabilityMatrixReport = readReport("latest-agentic-capability-matrix.json");
const realTaskCoverageRoadmapReport = readReport("latest-real-task-coverage-roadmap.json");
const realApprovalPlanReport = readReport("latest-real-approval-plan.json");
const accountIsolation = readReport("latest-antigravity-account-isolation-status.json");
const secondAccountLoginEntrypointReport = readReport("latest-second-antigravity-account-login-entrypoint.json");
const releaseGates = readReport("latest-release-gates.json");

const sync = syncReadiness.report || {};
const clientSyncContract = sync.clientSyncContract || {};
const codexClientCopy = {
  reportPresent: syncReadiness.present,
  reportOk: sync.ok === true,
  mode: String(clientSyncContract.mode || ""),
  maintenancePath: String(clientSyncContract.maintenancePath || ""),
  nativeClientBehaviorCarriedByHostSync: clientSyncContract.nativeClientBehaviorCarriedByHostSync === true,
  forbidsFeatureByFeatureReimplementation: clientSyncContract.forbidsFeatureByFeatureReimplementation === true,
  sourcePackageVersion: String(clientSyncContract.sourcePackageVersion || ""),
  activeSourcePackageVersion: String(clientSyncContract.activeSourcePackageVersion || ""),
  versionMatches: clientSyncContract.sourcePackageVersion && clientSyncContract.sourcePackageVersion === clientSyncContract.activeSourcePackageVersion,
};

const mcpRealList = Array.isArray(mcpSkills.report?.mcp?.smoke?.realList) ? mcpSkills.report.mcp.smoke.realList : [];
const mcpPassedServers = mcpRealList.filter((entry) => entry?.passed === true).map((entry) => String(entry.server || "")).filter(Boolean);
const missingWorkerMcpServers = requiredWorkerMcpServers.filter((server) => !mcpPassedServers.includes(server));
const workerToolCountByServer = Object.fromEntries(
  requiredWorkerMcpServers.map((server) => {
    const entry = mcpRealList.find((item) => String(item?.server || "") === server);
    return [server, Number(entry?.toolCount || 0)];
  }),
);
const incompleteWorkerToolCountServers = requiredWorkerMcpServers.filter((server) => workerToolCountByServer[server] < 1);
const workerMcp = {
  reportPresent: mcpSkills.present,
  reportOk: mcpSkills.report?.ok === true,
  requiredServers: requiredWorkerMcpServers,
  passedServers: mcpPassedServers,
  passedServerCount: mcpPassedServers.length,
  missingServers: missingWorkerMcpServers,
  toolCountByServer: workerToolCountByServer,
  incompleteToolCountServers: incompleteWorkerToolCountServers,
  allRequiredPassed: missingWorkerMcpServers.length === 0,
};

const selectedTasks = Array.isArray(desktopSuite.report?.selectedTasks) ? desktopSuite.report.selectedTasks.map(String) : [];
const missingAgenticTasks = requiredAgenticTasks.filter((task) => !selectedTasks.includes(task));
const desktopAgenticTasks = {
  reportPresent: desktopSuite.present,
  reportOk: desktopSuite.report?.ok === true,
  suiteProfile: String(desktopSuite.report?.suiteProfile || ""),
  requestedRealTraffic: desktopSuite.report?.requestedRealTraffic === true,
  usedRealTraffic: desktopSuite.report?.usedRealTraffic === true,
  dryRun: desktopSuite.report?.dryRun === true,
  selectedTasks,
  missingAgenticTasks,
  realTaskEvidenceComplete: desktopSuite.report?.realTaskEvidenceComplete === true,
  realTaskEvidenceFresh: desktopSuite.report?.realTaskEvidenceFresh === true,
  refreshNeeded: desktopSuite.report?.realTaskEvidenceRefreshPlan?.needed === true,
};
const matrix = capabilityMatrixReport.report || {};
const agenticCapabilityMatrix = {
  reportPresent: capabilityMatrixReport.present,
  reportOk: matrix.ok === true,
  complete: matrix.complete === true,
  fresh: matrix.fresh === true,
  coverageKind: String(matrix.coverageKind || ""),
  requiredCapabilities: Array.isArray(matrix.requiredCapabilities) ? matrix.requiredCapabilities.map(String) : [],
  missingCapabilities: Array.isArray(matrix.missingCapabilities) ? matrix.missingCapabilities.map(String) : [],
  staleCapabilities: Array.isArray(matrix.staleCapabilities) ? matrix.staleCapabilities.map(String) : [],
  capabilityCount: Array.isArray(matrix.capabilities) ? matrix.capabilities.length : 0,
  okCapabilityCount: Array.isArray(matrix.capabilities) ? matrix.capabilities.filter((item) => item?.ok === true).length : 0,
};
const roadmap = realTaskCoverageRoadmapReport.report || {};
const roadmapProfiles = Array.isArray(roadmap.profiles) ? roadmap.profiles : [];
const roadmapProfileByName = new Map(roadmapProfiles.map((item) => [String(item?.profile || ""), item]));
const requiredRoadmapProfiles = ["core", "agentic", "extended", "all"];
const missingRoadmapProfiles = requiredRoadmapProfiles.filter((profile) => !roadmapProfileByName.has(profile));
const nextRoadmapProfilesNeedingRealTraffic = Array.isArray(roadmap.nextProfilesNeedingRealTraffic)
  ? roadmap.nextProfilesNeedingRealTraffic.map(String).filter(Boolean)
  : [];
const roadmapArtifactProofs = Array.isArray(roadmap.taskArtifactProofs) ? roadmap.taskArtifactProofs : [];
const roadmapMissingArtifactProofTasks = Array.isArray(roadmap.missingArtifactProofTasks)
  ? roadmap.missingArtifactProofTasks.map(String).filter(Boolean)
  : [];
const roadmapResultProofs = Array.isArray(roadmap.taskResultProofs) ? roadmap.taskResultProofs : [];
const roadmapMissingResultProofTasks = Array.isArray(roadmap.missingResultProofTasks)
  ? roadmap.missingResultProofTasks.map(String).filter(Boolean)
  : [];
const realTaskCoverageRoadmap = {
  reportPresent: realTaskCoverageRoadmapReport.present,
  reportOk: roadmap.ok === true,
  coverageKind: String(roadmap.coverageKind || ""),
  requestedRealTraffic: roadmap.requestedRealTraffic === true,
  usedRealTraffic: roadmap.usedRealTraffic === true,
  requiredProfiles: Array.isArray(roadmap.requiredProfiles) ? roadmap.requiredProfiles.map(String) : [],
  completeProfiles: Array.isArray(roadmap.completeProfiles) ? roadmap.completeProfiles.map(String) : [],
  missingProfiles: missingRoadmapProfiles,
  nextProfilesNeedingRealTraffic: nextRoadmapProfilesNeedingRealTraffic,
  uniqueRefreshTasks: Array.isArray(roadmap.uniqueRefreshTasks) ? roadmap.uniqueRefreshTasks.map(String).filter(Boolean) : [],
  artifactProofTaskCount: roadmapArtifactProofs.length,
  missingArtifactProofTaskCount: Number(roadmap.missingArtifactProofTaskCount || 0),
  missingArtifactProofTasks: roadmapMissingArtifactProofTasks,
  artifactProofComplete: roadmapArtifactProofs.length >= 5 && Number(roadmap.missingArtifactProofTaskCount || 0) === 0 && roadmapMissingArtifactProofTasks.length === 0,
  resultProofTaskCount: roadmapResultProofs.length,
  missingResultProofTaskCount: Number(roadmap.missingResultProofTaskCount || 0),
  missingResultProofTasks: roadmapMissingResultProofTasks,
  resultProofComplete: roadmapResultProofs.length >= 9 && Number(roadmap.missingResultProofTaskCount || 0) === 0 && roadmapMissingResultProofTasks.length === 0,
  minimalRefreshCommandPresent: typeof roadmap.minimalRefreshCommand === "string" && roadmap.minimalRefreshCommand.includes("test-anticodex-desktop-task-suite.mjs") && roadmap.minimalRefreshCommand.includes("--tasks") && roadmap.minimalRefreshCommand.includes("--allow-real-traffic"),
  minimalRefreshCommandRequiresRealTraffic: roadmap.minimalRefreshCommandRequiresRealTraffic === true,
  approvalRequiredForRefresh: roadmap.approvalRequiredForRefresh === true,
  realTrafficApprovalReason: String(roadmap.realTrafficApprovalReason || ""),
  recommendedNoTrafficNextStep: String(roadmap.recommendedNoTrafficNextStep || ""),
  profiles: roadmapProfiles.map((item) => ({
    profile: String(item?.profile || ""),
    taskCount: Number(item?.taskCount || 0),
    okTaskCount: Number(item?.okTaskCount || 0),
    allOk: item?.allOk === true,
    refreshTasks: Array.isArray(item?.refreshTasks) ? item.refreshTasks.map(String) : [],
    approvalRequiredForRefresh: item?.approvalRequiredForRefresh === true,
  })),
};

const approvalPlan = realApprovalPlanReport.report || {};
const realApprovalPlan = {
  reportPresent: realApprovalPlanReport.present,
  reportOk: approvalPlan.ok === true,
  coverageKind: String(approvalPlan.coverageKind || ""),
  requestedRealTraffic: approvalPlan.requestedRealTraffic === true,
  usedRealTraffic: approvalPlan.usedRealTraffic === true,
  nextNoTrafficAction: String(approvalPlan.nextNoTrafficAction || ""),
  requiredReleaseRealTrafficActionCount: Number(approvalPlan.requiredReleaseRealTrafficActionCount || 0),
  optionalReleaseRealTrafficActionCount: Number(approvalPlan.optionalReleaseRealTrafficActionCount || 0),
  requiredReleaseGateIds: Array.isArray(approvalPlan.releaseRealTrafficGates?.requiredGateIds) ? approvalPlan.releaseRealTrafficGates.requiredGateIds.map(String) : [],
  completedRequiredGateIds: Array.isArray(approvalPlan.releaseRealTrafficGates?.completedGateIds) ? approvalPlan.releaseRealTrafficGates.completedGateIds.map(String) : [],
  requiredReleaseComplete: approvalPlan.releaseRealTrafficGates?.requiredReleaseComplete === true,
  optionalReleaseGateIds: Array.isArray(approvalPlan.releaseRealTrafficGates?.optionalGateIds) ? approvalPlan.releaseRealTrafficGates.optionalGateIds.map(String) : [],
  orderedActionCount: Array.isArray(approvalPlan.orderedActions) ? approvalPlan.orderedActions.length : 0,
};

const isolation = accountIsolation.report || {};
const antigravityAccountIsolation = {
  reportPresent: accountIsolation.present,
  reportOk: isolation.ok === true,
  completionState: String(isolation.completionState || ""),
  credentialBoundary: String(isolation.credentialBoundary || ""),
  safeToAskUserForSecondAccountLogin: isolation.safeToAskUserForSecondAccountLogin === true,
  separateAccountVerified: isolation.separateAccountVerified === true,
  loginVerified: isolation.loginVerified === true,
  releaseAcceptableAccountProof: isolation.releaseAcceptableAccountProof === true,
  blockingReason: String(isolation.readinessBlockingReason || ""),
  targetUserExists: isolation.targetUserExists === true,
  finalProofPlanPresent: !!isolation.finalProofPlan,
  postLoginProofPlanPresent: !!isolation.postLoginProofPlan,
};

const entrypoint = secondAccountLoginEntrypointReport.report || {};
const entrypointLoginCommand = String(entrypoint.approvedLoginCommandTemplate || "");
const entrypointStatusCommand = String(entrypoint.nextNoTrafficStatusCommand || "");
const entrypointProofCommand = String(entrypoint.postLoginProofCommandTemplate || "");
const entrypointProofPlan = entrypoint.postLoginProofPlan && typeof entrypoint.postLoginProofPlan === "object" ? entrypoint.postLoginProofPlan : {};
const entrypointRequiredIdentityInputs = Array.isArray(entrypointProofPlan.requiredAccountIdentityInputs)
  ? entrypointProofPlan.requiredAccountIdentityInputs.map(String).filter(Boolean)
  : [];
const secondAccountLoginEntrypoint = {
  reportPresent: secondAccountLoginEntrypointReport.present,
  reportOk: entrypoint.ok === true,
  reportName: String(entrypoint.reportName || ""),
  noTraffic: entrypoint.noTraffic === true,
  requestedRealTraffic: entrypoint.requestedRealTraffic === true,
  usedRealTraffic: entrypoint.usedRealTraffic === true,
  behaviorCovered: entrypoint.behaviorCovered === true,
  coverageKind: String(entrypoint.coverageKind || ""),
  statusOnlyOk: entrypoint.statusOnlyOk === true,
  missingApprovalBlocked: entrypoint.missingApprovalBlocked === true,
  approvedStartBlockedByStatusGate: entrypoint.approvedStartBlockedByStatusGate === true,
  sameWindowsUserTargetBlocked: entrypoint.sameWindowsUserTargetBlocked === true,
  sameWindowsUserTargetStartedLogin: entrypoint.sameWindowsUserTargetStartedLogin === true,
  sameWindowsUserTargetSafetyFieldsOk: entrypoint.sameWindowsUserTargetSafetyFieldsOk === true,
  requestedStartLogin: entrypoint.requestedStartLogin === true,
  startedLogin: entrypoint.startedLogin === true,
  changedSystem: entrypoint.changedSystem === true,
  createdUser: entrypoint.createdUser === true,
  capturesLoginOutput: entrypoint.capturesLoginOutput === true,
  capturesPassword: entrypoint.capturesPassword === true,
  storesPassword: entrypoint.storesPassword === true,
  safeToStartLogin: entrypoint.safeToStartLogin === true,
  canRunPostLoginProof: entrypoint.canRunPostLoginProof === true,
  completionState: String(entrypoint.completionState || ""),
  readinessBlockingReason: String(entrypoint.readinessBlockingReason || ""),
  operatorBlockingStage: String(entrypoint.operatorBlockingStage || ""),
  operatorNextStep: String(entrypoint.operatorNextStep || ""),
  approvedLoginCommandTemplate: entrypointLoginCommand,
  nextNoTrafficStatusCommand: entrypointStatusCommand,
  postLoginProofCommandTemplate: entrypointProofCommand,
  approvedLoginCommandPresent: entrypointLoginCommand.includes("scripts\\start-anticodex-second-antigravity-account-login.ps1")
    && entrypointLoginCommand.includes("-StartLogin")
    && entrypointLoginCommand.includes("-StartLoginApproval start-separate-windows-user-login"),
  nextNoTrafficStatusCommandPresent: entrypointStatusCommand.includes("scripts\\test-anticodex-antigravity-account-isolation-status.ps1"),
  postLoginProofCommandPresent: entrypointProofCommand.includes("scripts\\test-anticodex-antigravity-cli-real-smoke.ps1")
    && entrypointProofCommand.includes("-AllowSeparateAccountProof")
    && entrypointProofCommand.includes("-AccountIsolationBoundary separate-windows-user"),
  postLoginProofPlanPresent: !!entrypoint.postLoginProofPlan,
  postLoginProofPlanValid: String(entrypointProofPlan.proofScript || "") === "test-anticodex-antigravity-cli-real-smoke.ps1"
    && String(entrypointProofPlan.accountIsolationBoundary || "") === "separate-windows-user"
    && entrypointProofPlan.requiresInteractiveLoginComplete === true
    && entrypointProofPlan.requiresApprovedRealTraffic === true
    && entrypointProofPlan.requiresSeparateAccountProofApproval === true
    && entrypointProofPlan.requiresDistinctAccountIdentityComparison === true
    && entrypointRequiredIdentityInputs.includes("AntiCodexAccountId")
    && entrypointRequiredIdentityInputs.includes("McpAccountId")
    && entrypointProofPlan.accountIdsMustDiffer === true
    && entrypointProofPlan.mcpAccountLaneManagedByAntiCodex === false
    && String(entrypointProofPlan.mcpAccountLaneOwner || "") === "external-antigravity-account-not-managed-here",
  separateAccountVerified: entrypoint.separateAccountVerified === true,
  loginVerified: entrypoint.loginVerified === true,
  releaseAcceptableAccountProof: entrypoint.releaseAcceptableAccountProof === true,
};

const gates = releaseGates.report || {};
const selfCycleGateIds = new Set(["realApprovalPlan", "goalReadiness", "goalRealRunReadiness", "approvedRealRunSequence"]);
const rawMissingRequired = Array.isArray(gates.missingRequired) ? gates.missingRequired.map(String) : [];
const effectiveMissingRequired = rawMissingRequired.filter((gateId) => !selfCycleGateIds.has(gateId));
const effectiveRequiredRealTrafficBlockedGates = Array.isArray(gates.requiredRealTrafficBlockedGates) ? gates.requiredRealTrafficBlockedGates.map(String) : [];
const effectiveReleaseBlockedOnlyByRequiredRealTraffic = gates.releaseBlockedOnlyByRequiredRealTraffic === true
  || (effectiveMissingRequired.length > 0
    && effectiveMissingRequired.length === effectiveRequiredRealTrafficBlockedGates.length
    && effectiveMissingRequired.every((gateId) => effectiveRequiredRealTrafficBlockedGates.includes(gateId)));
const effectiveReleaseReady = gates.releaseReady === true
  || (gates.shortReady === true && effectiveMissingRequired.length === 0 && effectiveRequiredRealTrafficBlockedGates.length === 0);
const releaseGateStatus = {
  reportPresent: releaseGates.present,
  reportOk: gates.ok === true,
  shortReady: gates.shortReady === true,
  releaseReady: effectiveReleaseReady,
  releaseBlockedOnlyByRequiredRealTraffic: effectiveReleaseBlockedOnlyByRequiredRealTraffic,
  missingShort: Array.isArray(gates.missingShort) ? gates.missingShort.map(String) : [],
  missingRequired: effectiveMissingRequired,
  rawMissingRequired,
  requiredRealTrafficBlockedGates: effectiveRequiredRealTrafficBlockedGates,
};

const proven = {
  codexClientCopy: codexClientCopy.reportOk
    && codexClientCopy.mode === "codex-client-copy-plus-anticodex-patches"
    && codexClientCopy.nativeClientBehaviorCarriedByHostSync
    && codexClientCopy.forbidsFeatureByFeatureReimplementation
    && codexClientCopy.versionMatches,
  workerMcp: workerMcp.reportOk && workerMcp.allRequiredPassed && workerMcp.incompleteToolCountServers.length === 0,
  desktopAgenticTasks: desktopAgenticTasks.reportOk
    && desktopAgenticTasks.suiteProfile === "agentic"
    && desktopAgenticTasks.dryRun
    && missingAgenticTasks.length === 0
    && desktopAgenticTasks.realTaskEvidenceComplete
    && desktopAgenticTasks.realTaskEvidenceFresh
    && !desktopAgenticTasks.refreshNeeded,
  agenticCapabilityMatrix: agenticCapabilityMatrix.reportOk
    && agenticCapabilityMatrix.complete
    && agenticCapabilityMatrix.fresh
    && agenticCapabilityMatrix.coverageKind === "agentic-capability-matrix-report-only"
    && agenticCapabilityMatrix.missingCapabilities.length === 0
    && agenticCapabilityMatrix.staleCapabilities.length === 0
    && agenticCapabilityMatrix.okCapabilityCount >= 5,
  realTaskCoverageRoadmap: realTaskCoverageRoadmap.reportOk
    && realTaskCoverageRoadmap.coverageKind === "real-task-coverage-roadmap-report-only"
    && realTaskCoverageRoadmap.requestedRealTraffic === false
    && realTaskCoverageRoadmap.usedRealTraffic === false
    && realTaskCoverageRoadmap.missingProfiles.length === 0
    && realTaskCoverageRoadmap.artifactProofComplete
    && realTaskCoverageRoadmap.resultProofComplete,
  realApprovalPlan: realApprovalPlan.reportOk
    && realApprovalPlan.coverageKind === "real-approval-plan-report-only"
    && realApprovalPlan.requestedRealTraffic === false
    && realApprovalPlan.usedRealTraffic === false
    && (realApprovalPlan.requiredReleaseComplete || realApprovalPlan.requiredReleaseRealTrafficActionCount > 0)
    && realApprovalPlan.optionalReleaseRealTrafficActionCount >= 0
    && realApprovalPlan.nextNoTrafficAction.length > 0,
  releaseShortPath: releaseGateStatus.reportOk
    && releaseGateStatus.shortReady
    && releaseGateStatus.missingShort.length === 0
    && (releaseGateStatus.releaseReady || releaseGateStatus.releaseBlockedOnlyByRequiredRealTraffic),
  secondAccountLoginEntrypoint: secondAccountLoginEntrypoint.reportOk
    && secondAccountLoginEntrypoint.reportName === "second-antigravity-account-login-entrypoint"
    && secondAccountLoginEntrypoint.noTraffic
    && secondAccountLoginEntrypoint.requestedRealTraffic === false
    && secondAccountLoginEntrypoint.usedRealTraffic === false
    && secondAccountLoginEntrypoint.behaviorCovered
    && secondAccountLoginEntrypoint.coverageKind === "second-account-login-entrypoint-no-traffic"
    && secondAccountLoginEntrypoint.statusOnlyOk
    && secondAccountLoginEntrypoint.missingApprovalBlocked
    && secondAccountLoginEntrypoint.approvedStartBlockedByStatusGate
    && secondAccountLoginEntrypoint.sameWindowsUserTargetBlocked
    && secondAccountLoginEntrypoint.sameWindowsUserTargetStartedLogin === false
    && secondAccountLoginEntrypoint.sameWindowsUserTargetSafetyFieldsOk
    && secondAccountLoginEntrypoint.requestedStartLogin === false
    && secondAccountLoginEntrypoint.startedLogin === false
    && secondAccountLoginEntrypoint.changedSystem === false
    && secondAccountLoginEntrypoint.createdUser === false
    && secondAccountLoginEntrypoint.capturesLoginOutput === false
    && secondAccountLoginEntrypoint.capturesPassword === false
    && secondAccountLoginEntrypoint.storesPassword === false
    && secondAccountLoginEntrypoint.approvedLoginCommandPresent
    && secondAccountLoginEntrypoint.nextNoTrafficStatusCommandPresent
    && secondAccountLoginEntrypoint.postLoginProofCommandPresent
    && secondAccountLoginEntrypoint.postLoginProofPlanPresent
    && secondAccountLoginEntrypoint.postLoginProofPlanValid
    && secondAccountLoginEntrypoint.separateAccountVerified === false
    && secondAccountLoginEntrypoint.releaseAcceptableAccountProof === false,
  accountIsolationPreparedOnly: antigravityAccountIsolation.reportOk
    && antigravityAccountIsolation.completionState === "blocked_before_interactive_login"
    && antigravityAccountIsolation.safeToAskUserForSecondAccountLogin === false
    && antigravityAccountIsolation.separateAccountVerified === false
    && antigravityAccountIsolation.releaseAcceptableAccountProof === false
    && antigravityAccountIsolation.finalProofPlanPresent
    && antigravityAccountIsolation.postLoginProofPlanPresent,
};

const blockers = [];
if (!proven.codexClientCopy) blockers.push("codex_client_copy_evidence_missing_or_invalid");
if (!proven.workerMcp) blockers.push("worker_mcp_real_list_incomplete");
if (workerMcp.incompleteToolCountServers.length > 0) blockers.push("worker_mcp_tool_count_incomplete");
if (!proven.desktopAgenticTasks) blockers.push("desktop_agentic_task_evidence_incomplete_or_stale");
if (!proven.agenticCapabilityMatrix) blockers.push("agentic_capability_matrix_incomplete_or_stale");
if (!proven.realTaskCoverageRoadmap) blockers.push("real_task_coverage_roadmap_missing_or_invalid");
if (!realTaskCoverageRoadmap.artifactProofComplete) blockers.push("real_task_artifact_proof_missing");
if (!realTaskCoverageRoadmap.resultProofComplete) blockers.push("real_task_result_proof_missing");
if (!proven.realApprovalPlan) blockers.push("real_approval_plan_missing_or_invalid");
for (const profile of realTaskCoverageRoadmap.nextProfilesNeedingRealTraffic) blockers.push(`real_task_coverage_refresh_required:${profile}`);
if (!proven.releaseShortPath) blockers.push("short_release_path_not_clean");
if (!proven.secondAccountLoginEntrypoint) blockers.push("second_account_login_entrypoint_missing_or_invalid");
if (!antigravityAccountIsolation.releaseAcceptableAccountProof) blockers.push("second_antigravity_account_real_proof_missing");
for (const gate of releaseGateStatus.requiredRealTrafficBlockedGates) blockers.push(`required_real_traffic_gate_blocked:${gate}`);
const goalComplete = proven.codexClientCopy
  && proven.workerMcp
  && proven.desktopAgenticTasks
  && proven.agenticCapabilityMatrix
  && proven.realTaskCoverageRoadmap
  && proven.realApprovalPlan
  && proven.secondAccountLoginEntrypoint
  && realTaskCoverageRoadmap.nextProfilesNeedingRealTraffic.length === 0
  && releaseGateStatus.releaseReady
  && antigravityAccountIsolation.releaseAcceptableAccountProof;

const payload = {
  ok: blockers.length === 0 || (proven.codexClientCopy && proven.workerMcp && proven.desktopAgenticTasks && proven.agenticCapabilityMatrix && proven.realTaskCoverageRoadmap && proven.realApprovalPlan && proven.releaseShortPath && proven.secondAccountLoginEntrypoint && proven.accountIsolationPreparedOnly),
  reportName: "goal-readiness",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "goal-readiness-report-only",
  reportRoot,
  objective: "codex-client-copy-plus-antigravity-model-with-separate-antigravity-account-lanes-and-real-agentic-task-evidence",
  goalComplete,
  proven,
  blockers,
  codexClientCopy,
  workerMcp,
  desktopAgenticTasks,
  agenticCapabilityMatrix,
  realTaskCoverageRoadmap,
  realApprovalPlan,
  antigravityAccountIsolation,
  secondAccountLoginEntrypoint,
  releaseGateStatus,
  nextRequiredUserAction: antigravityAccountIsolation.safeToAskUserForSecondAccountLogin
    ? "login_second_antigravity_account_with_explicit_approval"
    : "create_or_verify_separate_windows_user_then_rerun_account_prepare",
  elapsedMs: Date.now() - startedAt,
};

const report = writeReport(payload);
console.log(JSON.stringify({ ...payload, report }));
if (!payload.ok) process.exit(1);
