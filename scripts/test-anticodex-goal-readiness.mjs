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
const accountIsolation = readReport("latest-antigravity-account-isolation-status.json");
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
const workerMcp = {
  reportPresent: mcpSkills.present,
  reportOk: mcpSkills.report?.ok === true,
  requiredServers: requiredWorkerMcpServers,
  passedServers: mcpPassedServers,
  missingServers: missingWorkerMcpServers,
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

const gates = releaseGates.report || {};
const releaseGateStatus = {
  reportPresent: releaseGates.present,
  reportOk: gates.ok === true,
  shortReady: gates.shortReady === true,
  releaseReady: gates.releaseReady === true,
  releaseBlockedOnlyByRequiredRealTraffic: gates.releaseBlockedOnlyByRequiredRealTraffic === true,
  missingShort: Array.isArray(gates.missingShort) ? gates.missingShort.map(String) : [],
  missingRequired: Array.isArray(gates.missingRequired) ? gates.missingRequired.map(String) : [],
  requiredRealTrafficBlockedGates: Array.isArray(gates.requiredRealTrafficBlockedGates) ? gates.requiredRealTrafficBlockedGates.map(String) : [],
};

const proven = {
  codexClientCopy: codexClientCopy.reportOk
    && codexClientCopy.mode === "codex-client-copy-plus-anticodex-patches"
    && codexClientCopy.nativeClientBehaviorCarriedByHostSync
    && codexClientCopy.forbidsFeatureByFeatureReimplementation
    && codexClientCopy.versionMatches,
  workerMcp: workerMcp.reportOk && workerMcp.allRequiredPassed,
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
  releaseShortPath: releaseGateStatus.reportOk
    && releaseGateStatus.shortReady
    && releaseGateStatus.missingShort.length === 0
    && releaseGateStatus.releaseBlockedOnlyByRequiredRealTraffic,
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
if (!proven.desktopAgenticTasks) blockers.push("desktop_agentic_task_evidence_incomplete_or_stale");
if (!proven.agenticCapabilityMatrix) blockers.push("agentic_capability_matrix_incomplete_or_stale");
if (!proven.releaseShortPath) blockers.push("short_release_path_not_clean");
if (!antigravityAccountIsolation.releaseAcceptableAccountProof) blockers.push("second_antigravity_account_real_proof_missing");
for (const gate of releaseGateStatus.requiredRealTrafficBlockedGates) blockers.push(`required_real_traffic_gate_blocked:${gate}`);
const goalComplete = proven.codexClientCopy
  && proven.workerMcp
  && proven.desktopAgenticTasks
  && proven.agenticCapabilityMatrix
  && releaseGateStatus.releaseReady
  && antigravityAccountIsolation.releaseAcceptableAccountProof;

const payload = {
  ok: blockers.length === 0 || (proven.codexClientCopy && proven.workerMcp && proven.desktopAgenticTasks && proven.agenticCapabilityMatrix && proven.releaseShortPath && proven.accountIsolationPreparedOnly),
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
  antigravityAccountIsolation,
  releaseGateStatus,
  nextRequiredUserAction: antigravityAccountIsolation.safeToAskUserForSecondAccountLogin
    ? "login_second_antigravity_account_with_explicit_approval"
    : "create_or_verify_separate_windows_user_then_rerun_account_prepare",
  elapsedMs: Date.now() - startedAt,
};

const report = writeReport(payload);
console.log(JSON.stringify({ ...payload, report }));
if (!payload.ok) process.exit(1);
