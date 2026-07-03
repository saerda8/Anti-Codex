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
const requiredWorkerMcpTaskSmokeWorkers = [
  "deepseek-code-worker",
  "kilo-worker",
  "mimo-claude-coworker",
  "mimocode-worker",
  "opencode-worker",
];
const minTaskSmokePassedWorkers = 5;
const requiredAgenticTasks = ["coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit"];
const directWorkerProbeCommand = "node scripts\\probe-anticodex-worker-mcp-servers.mjs";
const currentChannelReadOnlyProbeInstruction = "from a freshly reloaded Codex channel, run one worker read-only get_job/wait/status tool call, then record it with record-anticodex-current-channel-worker-transport.mjs";
const currentChannelRecoveryRecordCommand = "node scripts\\record-anticodex-current-channel-worker-transport.mjs --worker-tool <worker_read_tool> --worker-status ok --generic-mcp-tool node_repl --generic-mcp-status ok";
const currentChannelRecoveryStatusCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-current-channel-worker-recovery.ps1 -Compact";

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
const secondAccountReadinessSummaryReport = readReport("latest-second-account-readiness-summary.json");
const secondAccountPostLoginProofReport = readReport("latest-second-account-post-login-proof.json");
const releaseGates = readReport("latest-release-gates.json");
const workerMcpServerProbeReport = readReport("latest-worker-mcp-server-probe.json");
const workerMcpStatusProbeReport = readReport("latest-worker-mcp-status-probe.json");
const workerMcpTaskSmokeReport = readReport("latest-worker-mcp-task-smoke.json");
const workerMcpProjectSmokeReport = readReport("latest-worker-mcp-project-smoke.json");
const currentChannelWorkerTransportReport = readReport("latest-current-channel-worker-transport.json");
const currentChannelWorkerRecoveryReport = readReport("latest-current-channel-worker-recovery.json");

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
const workerServerProbe = workerMcpServerProbeReport.report || {};
const workerStatusProbe = workerMcpStatusProbeReport.report || {};
const currentChannelWorkerTransport = currentChannelWorkerTransportReport.report || {};
const currentChannelWorkerRecovery = currentChannelWorkerRecoveryReport.report || {};
const recommendedReadOnlyProbes = Array.isArray(currentChannelWorkerRecovery.recommendedReadOnlyProbes)
  ? currentChannelWorkerRecovery.recommendedReadOnlyProbes.map((item) => ({
    worker: String(item?.worker || ""),
    statusTool: String(item?.statusTool || ""),
    jobId: String(item?.jobId || ""),
    expectedStatus: String(item?.expectedStatus || ""),
    recordCommand: String(item?.recordCommand || ""),
  })).filter((item) => item.worker && item.statusTool && item.jobId)
  : [];
const exposedRecommendedReadOnlyProbes = Array.isArray(currentChannelWorkerRecovery.exposedRecommendedReadOnlyProbes)
  ? currentChannelWorkerRecovery.exposedRecommendedReadOnlyProbes.map((item) => ({
    worker: String(item?.worker || ""),
    statusTool: String(item?.statusTool || ""),
    jobId: String(item?.jobId || ""),
    expectedStatus: String(item?.expectedStatus || ""),
    recordCommand: String(item?.recordCommand || ""),
  })).filter((item) => item.worker && item.statusTool && item.jobId)
  : [];
const recommendedFirstReadOnlyProbe = currentChannelWorkerRecovery.recommendedFirstReadOnlyProbe
  ? {
    worker: String(currentChannelWorkerRecovery.recommendedFirstReadOnlyProbe.worker || ""),
    statusTool: String(currentChannelWorkerRecovery.recommendedFirstReadOnlyProbe.statusTool || ""),
    jobId: String(currentChannelWorkerRecovery.recommendedFirstReadOnlyProbe.jobId || ""),
    expectedStatus: String(currentChannelWorkerRecovery.recommendedFirstReadOnlyProbe.expectedStatus || ""),
    recordCommand: String(currentChannelWorkerRecovery.recommendedFirstReadOnlyProbe.recordCommand || ""),
  }
  : currentChannelWorkerRecovery.operatorActionCard?.recommendedFirstReadOnlyProbe
  ? {
    worker: String(currentChannelWorkerRecovery.operatorActionCard.recommendedFirstReadOnlyProbe.worker || ""),
    statusTool: String(currentChannelWorkerRecovery.operatorActionCard.recommendedFirstReadOnlyProbe.statusTool || ""),
    jobId: String(currentChannelWorkerRecovery.operatorActionCard.recommendedFirstReadOnlyProbe.jobId || ""),
    expectedStatus: String(currentChannelWorkerRecovery.operatorActionCard.recommendedFirstReadOnlyProbe.expectedStatus || ""),
    recordCommand: String(currentChannelWorkerRecovery.operatorActionCard.recommendedFirstReadOnlyProbe.recordCommand || ""),
  }
  : (exposedRecommendedReadOnlyProbes[0] || recommendedReadOnlyProbes[0] || null);
const currentChannelWorkerObservations = Array.isArray(currentChannelWorkerTransport.workerObservations)
  ? currentChannelWorkerTransport.workerObservations.map((item) => ({
    workerTool: String(item?.workerTool || ""),
    workerStatus: String(item?.workerStatus || ""),
    workerTransportOk: item?.workerTransportOk === true,
    workerTransportFailed: item?.workerTransportFailed === true,
  })).filter((item) => item.workerTool)
  : (currentChannelWorkerTransport.workerTool
    ? [{
      workerTool: String(currentChannelWorkerTransport.workerTool || ""),
      workerStatus: String(currentChannelWorkerTransport.workerStatus || ""),
      workerTransportOk: currentChannelWorkerTransport.workerTransportOk === true,
      workerTransportFailed: currentChannelWorkerTransport.workerTransportFailed === true,
    }]
    : []);
const currentChannelWorkerTransportMaxAgeMs = Number(args.get("--current-channel-worker-transport-max-age-ms") || 6 * 60 * 60 * 1000);
const currentChannelCheckedAtMs = Date.parse(String(currentChannelWorkerTransport.checkedAt || ""));
const currentChannelWorkerTransportAgeMs = Number.isFinite(currentChannelCheckedAtMs) ? Math.max(0, startedAt - currentChannelCheckedAtMs) : null;
const currentChannelWorkerTransportFresh = Number.isFinite(currentChannelWorkerTransportAgeMs)
  && currentChannelWorkerTransportAgeMs <= currentChannelWorkerTransportMaxAgeMs;
const workerTaskSmoke = workerMcpTaskSmokeReport.report || {};
const workerTaskSmokeResults = Array.isArray(workerTaskSmoke.results) ? workerTaskSmoke.results : [];
const workerTaskSmokePassedWorkers = workerTaskSmokeResults
  .filter((entry) => entry?.ok === true && entry?.workspaceVerification?.ok === true && String(entry?.worker || "") !== "antigravity-code-worker")
  .map((entry) => String(entry.worker || ""))
  .filter(Boolean);
const workerTaskSmokePassedWorkerSet = new Set(workerTaskSmokePassedWorkers);
const workerTaskSmokeMissingRequiredWorkers = requiredWorkerMcpTaskSmokeWorkers.filter((worker) => !workerTaskSmokePassedWorkerSet.has(worker));
const workerProjectSmoke = workerMcpProjectSmokeReport.report || {};
const workerProjectSmokeResults = Array.isArray(workerProjectSmoke.results) ? workerProjectSmoke.results : [];
const workerProjectSmokePassedWorkers = workerProjectSmokeResults
  .filter((entry) => entry?.ok === true
    && entry?.workspaceVerification?.ok === true
    && entry.workspaceVerification?.doneTextMatches === true
    && Array.isArray(entry.workspaceVerification?.extraFiles)
    && entry.workspaceVerification.extraFiles.length === 0
    && Number(entry.workspaceVerification?.testExitCode) === 0
    && Number(entry.workspaceVerification?.cliExitCode) === 0
    && Number(entry.workspaceVerification?.cliJson?.red) === 2
    && Number(entry.workspaceVerification?.cliJson?.blue) === 1
    && String(entry?.worker || "") !== "antigravity-code-worker")
  .map((entry) => String(entry.worker || ""))
  .filter(Boolean);
const workerProjectSmokePassedWorkerSet = new Set(workerProjectSmokePassedWorkers);
const workerProjectSmokeMissingRequiredWorkers = requiredWorkerMcpTaskSmokeWorkers.filter((worker) => !workerProjectSmokePassedWorkerSet.has(worker));
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
  serverProbeReportPresent: workerMcpServerProbeReport.present,
  serverProbeReportOk: workerServerProbe.ok === true,
  directProbePassedServerCount: Number(workerServerProbe.passedServerCount || 0),
  directProbeMissingServers: Array.isArray(workerServerProbe.missingServers) ? workerServerProbe.missingServers.map(String).filter(Boolean) : [],
  directProbeMissingStartToolServers: Array.isArray(workerServerProbe.missingStartToolServers) ? workerServerProbe.missingStartToolServers.map(String).filter(Boolean) : [],
  directProbeMissingWaitToolServers: Array.isArray(workerServerProbe.missingWaitToolServers) ? workerServerProbe.missingWaitToolServers.map(String).filter(Boolean) : [],
  statusProbeReportPresent: workerMcpStatusProbeReport.present,
  statusProbeReportOk: workerStatusProbe.ok === true,
  statusProbeUsedRealTraffic: workerStatusProbe.usedRealTraffic === true,
  statusProbeCoverageKind: String(workerStatusProbe.coverageKind || ""),
  statusProbeStatusCallOkCount: Number(workerStatusProbe.statusCallOkCount || 0),
  statusProbeStatusCallOkWorkers: Array.isArray(workerStatusProbe.statusCallOkWorkers) ? workerStatusProbe.statusCallOkWorkers.map(String).filter(Boolean) : [],
  statusProbeFailedWorkers: Array.isArray(workerStatusProbe.failedWorkers) ? workerStatusProbe.failedWorkers.map(String).filter(Boolean) : [],
  statusProbeSkippedWorkers: Array.isArray(workerStatusProbe.skippedWorkers) ? workerStatusProbe.skippedWorkers.map(String).filter(Boolean) : [],
  statusProbeAntigravitySkippedForAccountIsolation: workerStatusProbe.antigravitySkippedForAccountIsolation === true,
  statusProbeCurrentChannelCaveatPresent: typeof workerStatusProbe.currentChannelCaveat === "string" && workerStatusProbe.currentChannelCaveat.trim().length > 0,
  codexSessionTransportStatus: String(workerServerProbe.codexSessionTransportStatus || "unknown"),
  currentChannelTransportProven: workerServerProbe.codexSessionTransportStatus === "verified-by-current-channel",
  currentChannelWorkerTransportReportPresent: currentChannelWorkerTransportReport.present,
  currentChannelWorkerTransportReportOk: currentChannelWorkerTransport.ok === true,
  currentChannelWorkerTool: String(currentChannelWorkerTransport.workerTool || ""),
  currentChannelWorkerStatus: String(currentChannelWorkerTransport.workerStatus || ""),
  currentChannelWorkerTransportOk: currentChannelWorkerTransport.workerTransportOk === true,
  currentChannelWorkerTransportFailed: currentChannelWorkerTransport.workerTransportFailed === true,
  currentChannelWorkerObservations,
  currentChannelWorkerObservationCount: Number(currentChannelWorkerTransport.workerObservationCount || currentChannelWorkerObservations.length),
  currentChannelWorkerTransportOkCount: Number(currentChannelWorkerTransport.workerTransportOkCount || currentChannelWorkerObservations.filter((item) => item.workerTransportOk).length),
  currentChannelWorkerTransportFailedCount: Number(currentChannelWorkerTransport.workerTransportFailedCount || currentChannelWorkerObservations.filter((item) => item.workerTransportFailed).length),
  currentChannelWorkerTransportOkTools: Array.isArray(currentChannelWorkerTransport.workerTransportOkTools) ? currentChannelWorkerTransport.workerTransportOkTools.map(String).filter(Boolean) : currentChannelWorkerObservations.filter((item) => item.workerTransportOk).map((item) => item.workerTool),
  currentChannelWorkerTransportFailedTools: Array.isArray(currentChannelWorkerTransport.workerTransportFailedTools) ? currentChannelWorkerTransport.workerTransportFailedTools.map(String).filter(Boolean) : currentChannelWorkerObservations.filter((item) => item.workerTransportFailed).map((item) => item.workerTool),
  currentChannelWorkerTransportAnyOk: currentChannelWorkerTransport.workerTransportAnyOk === true,
  currentChannelWorkerTransportAllFailed: currentChannelWorkerTransport.workerTransportAllFailed === true,
  currentChannelGenericMcpTool: String(currentChannelWorkerTransport.genericMcpTool || ""),
  currentChannelGenericMcpStatus: String(currentChannelWorkerTransport.genericMcpStatus || ""),
  currentChannelGenericMcpControlOk: currentChannelWorkerTransport.genericMcpControlOk === true,
  currentChannelDirectProbeOk: currentChannelWorkerTransport.directProbeReport?.ok === true,
  currentChannelDirectProbePassedServerCount: Number(currentChannelWorkerTransport.directProbeReport?.passedServerCount || 0),
  currentChannelSplitObserved: currentChannelWorkerTransport.splitObserved === true,
  currentChannelCheckedAt: String(currentChannelWorkerTransport.checkedAt || ""),
  currentChannelWorkerTransportAgeMs,
  currentChannelWorkerTransportMaxAgeMs,
  currentChannelWorkerTransportFresh,
  currentChannelWorkerDispatchBlocked: currentChannelWorkerTransport.currentChannelWorkerDispatchBlocked === true,
  currentChannelWorkerDispatchUsable: Object.prototype.hasOwnProperty.call(currentChannelWorkerTransport, "currentChannelWorkerDispatchUsable")
    ? currentChannelWorkerTransport.currentChannelWorkerDispatchUsable === true
    : currentChannelWorkerTransport.workerTransportOk === true
      && currentChannelWorkerTransport.currentChannelWorkerDispatchBlocked !== true,
  currentChannelReadOnlyProbeRequiredBeforeDispatch: currentChannelWorkerTransport.readOnlyProbeRequiredBeforeDispatch === true,
  currentChannelOperatorRecoveryAction: String(currentChannelWorkerTransport.operatorRecoveryAction || ""),
  currentChannelPostReloadVerification: String(currentChannelWorkerTransport.postReloadVerification || ""),
  operatorRecoveryAction: String(workerServerProbe.operatorRecoveryAction || ""),
  postReloadVerification: String(workerServerProbe.postReloadVerification || ""),
  taskSmokeReportPresent: workerMcpTaskSmokeReport.present,
  taskSmokeReportOk: workerTaskSmoke.ok === true,
  taskSmokeUsedRealTraffic: workerTaskSmoke.usedRealTraffic === true,
  taskSmokeAntigravityExcluded: workerTaskSmoke.antigravityWorkerExcluded === true,
  taskSmokeRequiredPassedWorkerCount: minTaskSmokePassedWorkers,
  taskSmokeRequiredWorkers: requiredWorkerMcpTaskSmokeWorkers,
  taskSmokePassedWorkerCount: workerTaskSmokePassedWorkers.length,
  taskSmokePassedWorkers: workerTaskSmokePassedWorkers,
  taskSmokeMissingRequiredWorkers: workerTaskSmokeMissingRequiredWorkers,
  taskSmokeFailedWorkers: Array.isArray(workerTaskSmoke.failedWorkers) ? workerTaskSmoke.failedWorkers.map(String).filter(Boolean) : [],
  projectSmokeReportPresent: workerMcpProjectSmokeReport.present,
  projectSmokeReportOk: workerProjectSmoke.ok === true,
  projectSmokeScenario: String(workerProjectSmoke.scenario || ""),
  projectSmokeUsedRealTraffic: workerProjectSmoke.usedRealTraffic === true,
  projectSmokeAntigravityExcluded: workerProjectSmoke.antigravityWorkerExcluded === true,
  projectSmokePassedWorkerCount: workerProjectSmokePassedWorkers.length,
  projectSmokePassedWorkers: workerProjectSmokePassedWorkers,
  projectSmokeMissingRequiredWorkers: workerProjectSmokeMissingRequiredWorkers,
  projectSmokeFailedWorkers: Array.isArray(workerProjectSmoke.failedWorkers) ? workerProjectSmoke.failedWorkers.map(String).filter(Boolean) : [],
};

const currentChannelWorkerCanDispatch = workerMcp.currentChannelWorkerDispatchUsable
  && workerMcp.currentChannelWorkerTransportFresh
  && workerMcp.currentChannelWorkerTransportOk;
const workerTransportRecoveryReadiness = {
  ok: currentChannelWorkerCanDispatch,
  canDispatchCurrentChannelWorkers: currentChannelWorkerCanDispatch,
  requiresCodexMcpReload: !currentChannelWorkerCanDispatch,
  requiresFreshReadOnlyProbe: !currentChannelWorkerCanDispatch,
  currentChannelReadOnlyProbeInstruction,
  directWorkerProbeCommand,
  currentChannelRecoveryRecordCommand,
  blockingReason: currentChannelWorkerCanDispatch
    ? ""
    : workerMcp.currentChannelWorkerTransportFresh
      ? "current_channel_worker_transport_not_recovered"
      : "current_channel_worker_transport_probe_stale",
  safeToDispatchRule: "only dispatch worker implementation jobs after a fresh current-channel read-only worker status call succeeds",
  currentChannelWorkerStatus: workerMcp.currentChannelWorkerStatus,
  currentChannelWorkerObservationCount: workerMcp.currentChannelWorkerObservationCount,
  currentChannelWorkerTransportFailedCount: workerMcp.currentChannelWorkerTransportFailedCount,
  currentChannelWorkerTransportFailedTools: workerMcp.currentChannelWorkerTransportFailedTools,
  currentChannelGenericMcpStatus: workerMcp.currentChannelGenericMcpStatus,
  currentChannelSplitObserved: workerMcp.currentChannelSplitObserved,
  directProbeOk: workerMcp.currentChannelDirectProbeOk || workerMcp.serverProbeReportOk,
  directProbePassedServerCount: Math.max(workerMcp.currentChannelDirectProbePassedServerCount, workerMcp.directProbePassedServerCount),
  recommendedReadOnlyProbes,
  exposedRecommendedReadOnlyProbes,
  recommendedFirstReadOnlyProbe,
  operatorRecoveryAction: workerMcp.currentChannelOperatorRecoveryAction || workerMcp.operatorRecoveryAction,
  postReloadVerification: workerMcp.currentChannelPostReloadVerification || workerMcp.postReloadVerification,
  nextActions: currentChannelWorkerCanDispatch
    ? [
      "dispatch only a narrow worker task after normal scope checks",
    ]
    : [
      "reload Codex MCP/session or open a fresh channel",
      directWorkerProbeCommand,
      currentChannelReadOnlyProbeInstruction,
    ],
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
    && entrypointProofCommand.includes("-WindowsUser")
    && entrypointProofCommand.includes("-AccountIsolationBoundary separate-windows-user"),
  postLoginProofCommandTemplateHasWindowsUser: entrypoint.postLoginProofCommandTemplateHasWindowsUser === true,
  postLoginProofPlanPresent: !!entrypoint.postLoginProofPlan,
  postLoginProofPlanValid: String(entrypointProofPlan.proofScript || "") === "test-anticodex-antigravity-cli-real-smoke.ps1"
    && String(entrypointProofPlan.accountIsolationBoundary || "") === "separate-windows-user"
    && String(entrypointProofPlan.targetWindowsUser || "").length > 0
    && entrypointProofPlan.requiresInteractiveLoginComplete === true
    && entrypointProofPlan.requiresProofRunAsTargetWindowsUser === true
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

const secondSummary = secondAccountReadinessSummaryReport.report || {};
const secondSummarySteps = Array.isArray(secondSummary.steps) ? secondSummary.steps : [];
const secondSummaryFailures = Array.isArray(secondSummary.failures) ? secondSummary.failures : [];
const secondSummaryLoginCommand = String(secondSummary.approvedLoginCommandTemplate || "");
const secondSummaryStatusCommand = String(secondSummary.nextNoTrafficStatusCommand || "");
const secondSummaryProofCommand = String(secondSummary.postLoginProofCommandTemplate || "");
const secondSummaryChecklistStages = Array.isArray(secondSummary.operatorChecklistStages) ? secondSummary.operatorChecklistStages.map(String) : [];
const secondSummaryPostManualCommands = Array.isArray(secondSummary.postManualSetupValidationCommands) ? secondSummary.postManualSetupValidationCommands.map(String) : [];
const secondSummaryPostManualReadyFields = Array.isArray(secondSummary.postManualSetupRequiredReadyFields) ? secondSummary.postManualSetupRequiredReadyFields.map(String) : [];
const expectedSecondAccountChecklistStages = [
  "create_target_windows_user",
  "windows_user_account_prepare",
  "account_isolation_status",
  "second_account_login_entrypoint_with_explicit_approval",
];
const secondAccountReadinessSummary = {
  reportPresent: secondAccountReadinessSummaryReport.present,
  reportOk: secondSummary.ok === true,
  reportName: String(secondSummary.reportName || ""),
  windowsUser: String(secondSummary.windowsUser || ""),
  noTraffic: secondSummary.noTraffic === true,
  requestedRealTraffic: secondSummary.requestedRealTraffic === true,
  usedRealTraffic: secondSummary.usedRealTraffic === true,
  behaviorCovered: secondSummary.behaviorCovered === true,
  coverageKind: String(secondSummary.coverageKind || ""),
  changedSystem: secondSummary.changedSystem === true,
  createdUser: secondSummary.createdUser === true,
  startedLogin: secondSummary.startedLogin === true,
  capturesPassword: secondSummary.capturesPassword === true,
  storesPassword: secondSummary.storesPassword === true,
  targetUserExists: secondSummary.targetUserExists === true,
  currentWindowsUserSid: String(secondSummary.currentWindowsUserSid || ""),
  targetWindowsUserSid: String(secondSummary.targetWindowsUserSid || ""),
  targetUserSidMatchesCurrentUser: secondSummary.targetUserSidMatchesCurrentUser === true,
  targetUserIdentityBoundaryOk: secondSummary.targetUserIdentityBoundaryOk === true,
  targetUserIsCurrentUser: secondSummary.targetUserIsCurrentUser === true,
  currentProcessElevated: secondSummary.currentProcessElevated === true,
  localUserCommandAvailable: secondSummary.localUserCommandAvailable === true,
  newLocalUserCommandAvailable: secondSummary.newLocalUserCommandAvailable === true,
  canCreateTargetWindowsUser: secondSummary.canCreateTargetWindowsUser === true,
  recommendedOperatorAction: String(secondSummary.recommendedOperatorAction || ""),
  readyForOperatorLogin: secondSummary.readyForOperatorLogin === true,
  safeToAskUserForSecondAccountLogin: secondSummary.safeToAskUserForSecondAccountLogin === true,
  canProceedToInteractiveLogin: secondSummary.canProceedToInteractiveLogin === true,
  releaseAcceptableAccountProof: secondSummary.releaseAcceptableAccountProof === true,
  goalComplete: secondSummary.goalComplete === true,
  releaseReady: secondSummary.releaseReady === true,
  readyToRequestUserApproval: secondSummary.readyToRequestUserApproval === true,
  readyToRequestSecondAccountLoginApproval: secondSummary.readyToRequestSecondAccountLoginApproval === true,
  readyToRequestPostLoginProofApproval: secondSummary.readyToRequestPostLoginProofApproval === true,
  approvedSequenceOperatorNextAction: String(secondSummary.approvedSequenceOperatorNextAction || ""),
  approvedSequenceNextAction: String(secondSummary.approvedSequenceNextAction || ""),
  approvedSequenceAccountReadinessBlockingReason: String(secondSummary.approvedSequenceAccountReadinessBlockingReason || ""),
  completionState: String(secondSummary.completionState || ""),
  readinessBlockingReason: String(secondSummary.readinessBlockingReason || ""),
  operatorBlockingStage: String(secondSummary.operatorBlockingStage || ""),
  operatorNextStep: String(secondSummary.operatorNextStep || ""),
  nextOperatorAction: String(secondSummary.nextOperatorAction || ""),
  manualSetupCommandHint: String(secondSummary.manualSetupCommandHint || ""),
  postManualSetupValidationCommands: secondSummaryPostManualCommands,
  postManualSetupRequiredReadyFields: secondSummaryPostManualReadyFields,
  postManualSetupValidationCommandsOk: secondSummaryPostManualCommands.length >= 3
    && secondSummaryPostManualCommands.some((command) => command.includes("test-anticodex-windows-user-account-prepare.ps1"))
    && secondSummaryPostManualCommands.some((command) => command.includes("test-anticodex-antigravity-account-isolation-status.ps1"))
    && secondSummaryPostManualCommands.some((command) => command.includes("start-anticodex-second-antigravity-account-login.ps1")),
  postManualSetupRequiredReadyFieldsOk: secondSummaryPostManualReadyFields.includes("targetUserExists:true")
    && secondSummaryPostManualReadyFields.includes("targetWindowsUserSid:present")
    && secondSummaryPostManualReadyFields.includes("targetUserIdentityBoundaryOk:true")
    && secondSummaryPostManualReadyFields.includes("safeToAskUserForSecondAccountLogin:true")
    && secondSummaryPostManualReadyFields.includes("canProceedToInteractiveLogin:true")
    && secondSummaryPostManualReadyFields.includes("startedLogin:false")
    && secondSummaryPostManualReadyFields.includes("usedRealTraffic:false"),
  readinessCheckSequence: Array.isArray(secondSummary.readinessCheckSequence) ? secondSummary.readinessCheckSequence.map(String) : [],
  operatorChecklistStages: secondSummaryChecklistStages,
  operatorChecklistStartsLoginCount: Number(secondSummary.operatorChecklistStartsLoginCount || 0),
  operatorChecklistUsesRealTrafficCount: Number(secondSummary.operatorChecklistUsesRealTrafficCount || 0),
  operatorChecklistOrderOk: secondSummaryChecklistStages.join("|") === expectedSecondAccountChecklistStages.join("|"),
  accountIsolationCaveat: String(secondSummary.accountIsolationCaveat || ""),
  approvedLoginCommandTemplate: secondSummaryLoginCommand,
  nextNoTrafficStatusCommand: secondSummaryStatusCommand,
  postLoginProofCommandTemplate: secondSummaryProofCommand,
  approvedLoginCommandPresent: secondSummaryLoginCommand.includes("scripts\\start-anticodex-second-antigravity-account-login.ps1")
    && secondSummaryLoginCommand.includes("-StartLoginApproval start-separate-windows-user-login"),
  nextNoTrafficStatusCommandPresent: secondSummaryStatusCommand.includes("scripts\\test-anticodex-antigravity-account-isolation-status.ps1"),
  postLoginProofCommandPresent: secondSummaryProofCommand.includes("scripts\\test-anticodex-antigravity-cli-real-smoke.ps1")
    && secondSummaryProofCommand.includes("-AllowSeparateAccountProof")
    && secondSummaryProofCommand.includes("-WindowsUser")
    && secondSummaryProofCommand.includes("SeparateAccountProofApprovalId"),
  postLoginProofCommandTemplateHasWindowsUser: secondSummary.postLoginProofCommandTemplateHasWindowsUser === true,
  stepCount: secondSummarySteps.length,
  failedStepCount: secondSummarySteps.filter((item) => item?.ok !== true).length,
  failureCount: secondSummaryFailures.length,
};

const postLoginProof = secondAccountPostLoginProofReport.report || {};
const postLoginProofOperatorActionCard = postLoginProof.operatorActionCard && typeof postLoginProof.operatorActionCard === "object"
  ? postLoginProof.operatorActionCard
  : {};
const postLoginProofDryRunValid = postLoginProof.reportName === "second-account-post-login-proof"
  && postLoginProof.noTraffic === true
  && postLoginProof.requestedRealTraffic === false
  && postLoginProof.usedRealTraffic === false
  && postLoginProof.behaviorCovered === true
  && postLoginProof.coverageKind === "second-account-post-login-proof-dry-run"
  && postLoginProof.willRunRealSmoke === false
  && postLoginProof.loginVerified === false
  && postLoginProof.separateAccountVerified === false
  && postLoginProof.releaseAcceptableAccountProof === false;
const postLoginProofRealValid = postLoginProof.reportName === "second-account-post-login-proof"
  && postLoginProof.noTraffic === false
  && postLoginProof.requestedRealTraffic === true
  && postLoginProof.usedRealTraffic === true
  && postLoginProof.behaviorCovered === true
  && postLoginProof.coverageKind === "second-account-post-login-proof-real-traffic"
  && postLoginProof.willRunRealSmoke === true
  && postLoginProof.loginVerified === true
  && postLoginProof.separateAccountVerified === true
  && postLoginProof.releaseAcceptableAccountProof === true
  && postLoginProof.accountIdentityComparisonPresent === true;
const secondAccountPostLoginProof = {
  reportPresent: secondAccountPostLoginProofReport.present,
  reportOk: postLoginProof.ok === true,
  reportName: String(postLoginProof.reportName || ""),
  noTraffic: postLoginProof.noTraffic === true,
  requestedRealTraffic: postLoginProof.requestedRealTraffic === true,
  usedRealTraffic: postLoginProof.usedRealTraffic === true,
  behaviorCovered: postLoginProof.behaviorCovered === true,
  coverageKind: String(postLoginProof.coverageKind || ""),
  changedSystem: postLoginProof.changedSystem === true,
  createdUser: postLoginProof.createdUser === true,
  capturesPassword: postLoginProof.capturesPassword === true,
  storesPassword: postLoginProof.storesPassword === true,
  targetUserExists: postLoginProof.targetUserExists === true,
  safeToAskUserForSecondAccountLogin: postLoginProof.safeToAskUserForSecondAccountLogin === true,
  canRunAfterInteractiveLogin: postLoginProof.canRunAfterInteractiveLogin === true,
  willRunRealSmoke: postLoginProof.willRunRealSmoke === true,
  loginVerified: postLoginProof.loginVerified === true,
  separateAccountVerified: postLoginProof.separateAccountVerified === true,
  releaseAcceptableAccountProof: postLoginProof.releaseAcceptableAccountProof === true,
  accountIdentityComparisonPresent: postLoginProof.accountIdentityComparisonPresent === true,
  accountIsolationBoundary: String(postLoginProof.accountIsolationBoundary || ""),
  accountIsolationCaveat: String(postLoginProof.accountIsolationCaveat || ""),
  failureCount: Array.isArray(postLoginProof.failures) ? postLoginProof.failures.length : 0,
  warningCount: Array.isArray(postLoginProof.warnings) ? postLoginProof.warnings.length : 0,
  proofCommandPreview: String(postLoginProof.proofCommandPreview || ""),
  operatorActionCard: {
    status: String(postLoginProofOperatorActionCard.status || ""),
    windowsUser: String(postLoginProofOperatorActionCard.windowsUser || ""),
    canRunPostLoginProofNow: postLoginProofOperatorActionCard.canRunPostLoginProofNow === true,
    targetUserExists: postLoginProofOperatorActionCard.targetUserExists === true,
    canAskUserToLoginNow: postLoginProofOperatorActionCard.canAskUserToLoginNow === true,
    confirmInteractiveLoginComplete: postLoginProofOperatorActionCard.confirmInteractiveLoginComplete === true,
    missingRequirement: String(postLoginProofOperatorActionCard.missingRequirement || ""),
    missingRequirements: Array.isArray(postLoginProofOperatorActionCard.missingRequirements) ? postLoginProofOperatorActionCard.missingRequirements.map(String).filter(Boolean) : [],
    readinessBlockingReason: String(postLoginProofOperatorActionCard.readinessBlockingReason || ""),
    nextOperatorAction: String(postLoginProofOperatorActionCard.nextOperatorAction || ""),
    userVisibleNextStep: String(postLoginProofOperatorActionCard.userVisibleNextStep || ""),
    noTrafficStatusCommand: String(postLoginProofOperatorActionCard.noTrafficStatusCommand || ""),
    proofCommandPreview: String(postLoginProofOperatorActionCard.proofCommandPreview || ""),
  },
  dryRunValid: postLoginProofDryRunValid,
  realProofValid: postLoginProofRealValid,
  semanticsValid: postLoginProof.reportName === "second-account-post-login-proof"
    && postLoginProof.ok === true
    && postLoginProof.changedSystem === false
    && postLoginProof.createdUser === false
    && postLoginProof.capturesPassword === false
    && postLoginProof.storesPassword === false
    && String(postLoginProof.accountIsolationBoundary || "") === "separate-windows-user"
    && String(postLoginProof.accountIsolationCaveat || "").length > 0
    && String(postLoginProof.proofCommandPreview || "").includes("test-anticodex-antigravity-cli-real-smoke.ps1")
    && String(postLoginProof.proofCommandPreview || "").includes("-AllowSeparateAccountProof")
    && String(postLoginProof.proofCommandPreview || "").includes("-WindowsUser")
    && String(postLoginProofOperatorActionCard.status || "").length > 0
    && String(postLoginProofOperatorActionCard.windowsUser || "").length > 0
    && String(postLoginProofOperatorActionCard.nextOperatorAction || "").length > 0
    && String(postLoginProofOperatorActionCard.noTrafficStatusCommand || "").includes("test-anticodex-second-account-post-login-proof.ps1")
    && (postLoginProofDryRunValid || postLoginProofRealValid),
};

const gates = releaseGates.report || {};
const selfCycleGateIds = new Set(["realApprovalPlan", "goalReadiness", "requiredRealTrafficSequence", "goalRealRunReadiness", "approvedRealRunSequence"]);
const rawMissingRequired = Array.isArray(gates.missingRequired) ? gates.missingRequired.map(String) : [];
const rawMissingShort = Array.isArray(gates.missingShort) ? gates.missingShort.map(String) : [];
const effectiveMissingRequired = rawMissingRequired.filter((gateId) => !selfCycleGateIds.has(gateId));
const effectiveMissingShort = rawMissingShort.filter((gateId) => !selfCycleGateIds.has(gateId));
const effectiveRequiredRealTrafficBlockedGates = Array.isArray(gates.requiredRealTrafficBlockedGates) ? gates.requiredRealTrafficBlockedGates.map(String) : [];
const effectiveReleaseBlockedOnlyByRequiredRealTraffic = gates.releaseBlockedOnlyByRequiredRealTraffic === true
  || (effectiveMissingRequired.length > 0
    && effectiveMissingRequired.length === effectiveRequiredRealTrafficBlockedGates.length
    && effectiveMissingRequired.every((gateId) => effectiveRequiredRealTrafficBlockedGates.includes(gateId)));
const effectiveShortReady = gates.shortReady === true || effectiveMissingShort.length === 0;
const effectiveReleaseReady = gates.releaseReady === true
  || (effectiveShortReady && effectiveMissingRequired.length === 0 && effectiveRequiredRealTrafficBlockedGates.length === 0);
const releaseGateStatus = {
  reportPresent: releaseGates.present,
  reportOk: gates.ok === true,
  shortReady: effectiveShortReady,
  releaseReady: effectiveReleaseReady,
  releaseBlockedOnlyByRequiredRealTraffic: effectiveReleaseBlockedOnlyByRequiredRealTraffic,
  missingShort: effectiveMissingShort,
  missingRequired: effectiveMissingRequired,
  rawMissingShort,
  rawMissingRequired,
  requiredRealTrafficBlockedGates: effectiveRequiredRealTrafficBlockedGates,
};

const proven = {
  codexClientCopy: codexClientCopy.reportOk
    && codexClientCopy.mode === "codex-client-copy-plus-anticodex-patches"
    && codexClientCopy.nativeClientBehaviorCarriedByHostSync
    && codexClientCopy.forbidsFeatureByFeatureReimplementation
    && codexClientCopy.versionMatches,
  workerMcp: workerMcp.reportOk
    && workerMcp.allRequiredPassed
    && workerMcp.incompleteToolCountServers.length === 0
    && workerMcp.taskSmokeReportOk
    && workerMcp.taskSmokeUsedRealTraffic
    && workerMcp.taskSmokeAntigravityExcluded
    && workerMcp.taskSmokePassedWorkerCount >= minTaskSmokePassedWorkers
    && workerMcp.taskSmokeMissingRequiredWorkers.length === 0
    && workerMcp.taskSmokeFailedWorkers.length === 0
    && workerMcp.projectSmokeReportOk
    && workerMcp.projectSmokeScenario === "project"
    && workerMcp.projectSmokeUsedRealTraffic
    && workerMcp.projectSmokeAntigravityExcluded
    && workerMcp.projectSmokePassedWorkerCount >= minTaskSmokePassedWorkers
    && workerMcp.projectSmokeMissingRequiredWorkers.length === 0
    && workerMcp.projectSmokeFailedWorkers.length === 0,
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
    && agenticCapabilityMatrix.requiredCapabilities.length >= 7
    && agenticCapabilityMatrix.okCapabilityCount >= agenticCapabilityMatrix.requiredCapabilities.length,
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
    && secondAccountLoginEntrypoint.postLoginProofCommandTemplateHasWindowsUser
    && secondAccountLoginEntrypoint.postLoginProofPlanPresent
    && secondAccountLoginEntrypoint.postLoginProofPlanValid
    && secondAccountLoginEntrypoint.separateAccountVerified === false
    && secondAccountLoginEntrypoint.releaseAcceptableAccountProof === false,
  secondAccountReadinessSummary: secondAccountReadinessSummary.reportOk
    && secondAccountReadinessSummary.reportName === "second-account-readiness-summary"
    && secondAccountReadinessSummary.noTraffic
    && secondAccountReadinessSummary.requestedRealTraffic === false
    && secondAccountReadinessSummary.usedRealTraffic === false
    && secondAccountReadinessSummary.behaviorCovered
    && secondAccountReadinessSummary.coverageKind === "second-account-readiness-summary-no-traffic"
    && secondAccountReadinessSummary.changedSystem === false
    && secondAccountReadinessSummary.createdUser === false
    && secondAccountReadinessSummary.startedLogin === false
    && secondAccountReadinessSummary.capturesPassword === false
    && secondAccountReadinessSummary.storesPassword === false
    && secondAccountReadinessSummary.releaseAcceptableAccountProof === false
    && secondAccountReadinessSummary.goalComplete === false
    && secondAccountReadinessSummary.currentWindowsUserSid.length > 0
    && secondAccountReadinessSummary.targetUserSidMatchesCurrentUser === false
    && secondAccountReadinessSummary.targetUserIsCurrentUser === false
    && (secondAccountReadinessSummary.targetUserExists === false || (secondAccountReadinessSummary.targetWindowsUserSid.length > 0 && secondAccountReadinessSummary.targetUserIdentityBoundaryOk === true))
    && secondAccountReadinessSummary.nextOperatorAction.length > 0
    && secondAccountReadinessSummary.manualSetupCommandHint.length > 0
    && secondAccountReadinessSummary.postManualSetupValidationCommandsOk
    && secondAccountReadinessSummary.postManualSetupRequiredReadyFieldsOk
    && secondAccountReadinessSummary.operatorChecklistOrderOk
    && secondAccountReadinessSummary.operatorChecklistStartsLoginCount === 1
    && secondAccountReadinessSummary.operatorChecklistUsesRealTrafficCount === 0
    && secondAccountReadinessSummary.accountIsolationCaveat.length > 0
    && secondAccountReadinessSummary.approvedLoginCommandPresent
    && secondAccountReadinessSummary.nextNoTrafficStatusCommandPresent
    && secondAccountReadinessSummary.postLoginProofCommandPresent
    && secondAccountReadinessSummary.postLoginProofCommandTemplateHasWindowsUser
    && secondAccountReadinessSummary.stepCount >= 7
    && secondAccountReadinessSummary.failedStepCount === 0
    && secondAccountReadinessSummary.failureCount === 0,
  secondAccountPostLoginProof: secondAccountPostLoginProof.semanticsValid,
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
if (!workerMcp.reportOk || !workerMcp.allRequiredPassed) blockers.push("worker_mcp_real_list_incomplete");
if (workerMcp.incompleteToolCountServers.length > 0) blockers.push("worker_mcp_tool_count_incomplete");
if (!workerMcp.taskSmokeReportOk) blockers.push("worker_mcp_task_smoke_missing_or_failed");
if (!workerMcp.taskSmokeUsedRealTraffic) blockers.push("worker_mcp_task_smoke_real_traffic_missing");
if (!workerMcp.taskSmokeAntigravityExcluded) blockers.push("worker_mcp_task_smoke_antigravity_not_excluded");
if (workerMcp.taskSmokePassedWorkerCount < 1) blockers.push("worker_mcp_task_smoke_no_passed_worker");
if (workerMcp.taskSmokePassedWorkerCount < minTaskSmokePassedWorkers) blockers.push("worker_mcp_task_smoke_insufficient_worker_diversity");
if (workerMcp.taskSmokeMissingRequiredWorkers.length > 0) blockers.push("worker_mcp_task_smoke_missing_required_worker");
if (workerMcp.taskSmokeFailedWorkers.length > 0) blockers.push("worker_mcp_task_smoke_failed_workers");
if (!workerMcp.projectSmokeReportOk) blockers.push("worker_mcp_project_smoke_missing_or_failed");
if (workerMcp.projectSmokeScenario !== "project") blockers.push("worker_mcp_project_smoke_wrong_scenario");
if (!workerMcp.projectSmokeUsedRealTraffic) blockers.push("worker_mcp_project_smoke_real_traffic_missing");
if (!workerMcp.projectSmokeAntigravityExcluded) blockers.push("worker_mcp_project_smoke_antigravity_not_excluded");
if (workerMcp.projectSmokePassedWorkerCount < minTaskSmokePassedWorkers) blockers.push("worker_mcp_project_smoke_insufficient_worker_diversity");
if (workerMcp.projectSmokeMissingRequiredWorkers.length > 0) blockers.push("worker_mcp_project_smoke_missing_required_worker");
if (workerMcp.projectSmokeFailedWorkers.length > 0) blockers.push("worker_mcp_project_smoke_failed_workers");
if (!workerMcp.currentChannelWorkerTransportFresh) blockers.push("current_channel_worker_transport_probe_stale");
if (!workerMcp.currentChannelWorkerDispatchUsable) blockers.push("current_channel_worker_transport_not_recovered");
if (!proven.desktopAgenticTasks) blockers.push("desktop_agentic_task_evidence_incomplete_or_stale");
if (!proven.agenticCapabilityMatrix) blockers.push("agentic_capability_matrix_incomplete_or_stale");
if (!proven.realTaskCoverageRoadmap) blockers.push("real_task_coverage_roadmap_missing_or_invalid");
if (!realTaskCoverageRoadmap.artifactProofComplete) blockers.push("real_task_artifact_proof_missing");
if (!realTaskCoverageRoadmap.resultProofComplete) blockers.push("real_task_result_proof_missing");
if (!proven.realApprovalPlan) blockers.push("real_approval_plan_missing_or_invalid");
for (const profile of realTaskCoverageRoadmap.nextProfilesNeedingRealTraffic) blockers.push(`real_task_coverage_refresh_required:${profile}`);
if (!proven.releaseShortPath) blockers.push("short_release_path_not_clean");
if (!proven.secondAccountLoginEntrypoint) blockers.push("second_account_login_entrypoint_missing_or_invalid");
if (!proven.secondAccountReadinessSummary) blockers.push("second_account_readiness_summary_missing_or_invalid");
if (!proven.secondAccountPostLoginProof) blockers.push("second_account_post_login_proof_missing_or_invalid");
if (!antigravityAccountIsolation.releaseAcceptableAccountProof) blockers.push("second_antigravity_account_real_proof_missing");
for (const gate of releaseGateStatus.requiredRealTrafficBlockedGates) blockers.push(`required_real_traffic_gate_blocked:${gate}`);
const goalComplete = proven.codexClientCopy
  && proven.workerMcp
  && workerMcp.currentChannelWorkerDispatchUsable
  && workerMcp.currentChannelWorkerTransportFresh
  && proven.desktopAgenticTasks
  && proven.agenticCapabilityMatrix
  && proven.realTaskCoverageRoadmap
  && proven.realApprovalPlan
  && proven.secondAccountLoginEntrypoint
  && proven.secondAccountReadinessSummary
  && proven.secondAccountPostLoginProof
  && realTaskCoverageRoadmap.nextProfilesNeedingRealTraffic.length === 0
  && releaseGateStatus.releaseReady
  && antigravityAccountIsolation.releaseAcceptableAccountProof;

function objectiveRequirement(id, label, complete, evidence = [], missing = []) {
  return {
    id,
    label,
    status: complete ? "complete" : "incomplete",
    complete,
    evidence: evidence.map(String).filter(Boolean),
    missing: missing.map(String).filter(Boolean),
  };
}

const objectiveRequirementAudit = [
  objectiveRequirement(
    "codex_client_copy",
    "Anti-Codex is a guarded complete Codex client copy, not a feature-by-feature rewrite",
    proven.codexClientCopy,
    [
      `sync report ok: ${codexClientCopy.reportOk}`,
      `mode: ${codexClientCopy.mode}`,
      `version matches: ${codexClientCopy.versionMatches}`,
      `maintenance path: ${codexClientCopy.maintenancePath}`,
    ],
    [
      ...(!proven.codexClientCopy ? ["codex client-copy sync contract not fully proven"] : []),
    ],
  ),
  objectiveRequirement(
    "antigravity_model_text",
    "Antigravity supplies model text while Codex-owned tools stay in Anti-Codex",
    proven.desktopAgenticTasks && proven.realTaskCoverageRoadmap && proven.releaseShortPath,
    [
      `desktop agentic task suite ok: ${desktopAgenticTasks.reportOk}`,
      `real task coverage complete: ${realTaskCoverageRoadmap.resultProofComplete}`,
      `release short path ready: ${releaseGateStatus.shortReady}`,
    ],
    [
      ...(!proven.desktopAgenticTasks ? ["desktop agentic task evidence missing or stale"] : []),
      ...(!proven.realTaskCoverageRoadmap ? ["real task coverage roadmap missing or invalid"] : []),
      ...(!proven.releaseShortPath ? ["release short path not clean"] : []),
    ],
  ),
  objectiveRequirement(
    "separate_antigravity_accounts",
    "Two Antigravity accounts can be isolated for Anti-Codex model text and MCP use",
    antigravityAccountIsolation.releaseAcceptableAccountProof === true,
    [
      `credential boundary: ${antigravityAccountIsolation.credentialBoundary}`,
      `target user exists: ${antigravityAccountIsolation.targetUserExists}`,
      `safe to ask login: ${antigravityAccountIsolation.safeToAskUserForSecondAccountLogin}`,
      `release acceptable account proof: ${antigravityAccountIsolation.releaseAcceptableAccountProof}`,
    ],
    [
      ...(!antigravityAccountIsolation.targetUserExists ? [`target Windows user missing: ${secondAccountReadinessSummary.windowsUser}`] : []),
      ...(!antigravityAccountIsolation.releaseAcceptableAccountProof ? ["interactive second-account login and distinct account proof missing"] : []),
    ],
  ),
  objectiveRequirement(
    "worker_mcp_multiuse",
    "Worker MCPs are available, used, and dispatchable from the current Codex channel",
    proven.workerMcp && currentChannelWorkerCanDispatch,
    [
      `configured worker servers passed: ${workerMcp.passedServerCount}/${requiredWorkerMcpServers.length}`,
      `direct status-call workers ok: ${workerMcp.statusProbeStatusCallOkCount}`,
      `task smoke passed workers: ${workerMcp.taskSmokePassedWorkerCount}`,
      `project smoke passed workers: ${workerMcp.projectSmokePassedWorkerCount}`,
      `current-channel dispatch usable: ${workerMcp.currentChannelWorkerDispatchUsable}`,
    ],
    [
      ...(!proven.workerMcp ? ["worker MCP inventory/probe evidence incomplete"] : []),
      ...(!currentChannelWorkerCanDispatch ? ["current Codex channel worker transport has no successful read-only worker call"] : []),
    ],
  ),
  objectiveRequirement(
    "real_long_tasks_with_results",
    "Visible real long tasks land concrete files, tests, CLI output, reports, and final markers",
    proven.desktopAgenticTasks && proven.agenticCapabilityMatrix && proven.realTaskCoverageRoadmap,
    [
      `selected agentic tasks: ${desktopAgenticTasks.selectedTasks.join(",")}`,
      `capability count: ${agenticCapabilityMatrix.okCapabilityCount}/${agenticCapabilityMatrix.capabilityCount}`,
      `artifact proof complete: ${realTaskCoverageRoadmap.artifactProofComplete}`,
      `result proof complete: ${realTaskCoverageRoadmap.resultProofComplete}`,
    ],
    [
      ...(!proven.desktopAgenticTasks ? ["desktop agentic task suite incomplete or stale"] : []),
      ...(!proven.agenticCapabilityMatrix ? ["agentic capability matrix incomplete or stale"] : []),
      ...(!proven.realTaskCoverageRoadmap ? ["real task coverage roadmap incomplete"] : []),
    ],
  ),
  objectiveRequirement(
    "native_codex_like_agentic_experience",
    "Anti-Codex behaves like native Codex for complex agentic work, not just text replies",
    proven.desktopAgenticTasks
      && proven.agenticCapabilityMatrix
      && realTaskCoverageRoadmap.artifactProofComplete
      && realTaskCoverageRoadmap.resultProofComplete
      && releaseGateStatus.releaseReady,
    [
      `agentic task suite fresh: ${desktopAgenticTasks.realTaskEvidenceFresh}`,
      `real task profiles complete: ${realTaskCoverageRoadmap.completeProfiles.join(",")}`,
      `release ready: ${releaseGateStatus.releaseReady}`,
      `missing required release reports: ${releaseGateStatus.missingRequired.join(",")}`,
    ],
    [
      ...(!desktopAgenticTasks.realTaskEvidenceFresh ? ["real desktop task evidence stale"] : []),
      ...(!realTaskCoverageRoadmap.artifactProofComplete ? ["artifact proof incomplete"] : []),
      ...(!realTaskCoverageRoadmap.resultProofComplete ? ["result proof incomplete"] : []),
      ...(!releaseGateStatus.releaseReady ? ["release gates not ready"] : []),
    ],
  ),
];

const objectiveRequirementSummary = {
  total: objectiveRequirementAudit.length,
  completeCount: objectiveRequirementAudit.filter((item) => item.complete).length,
  incompleteCount: objectiveRequirementAudit.filter((item) => !item.complete).length,
  incompleteRequirementIds: objectiveRequirementAudit.filter((item) => !item.complete).map((item) => item.id),
  canClaimFullGoalNow: objectiveRequirementAudit.every((item) => item.complete) && goalComplete,
};

const currentChannelWorkerTransportStatus = currentChannelWorkerCanDispatch
  ? "dispatch_ready"
  : workerMcp.currentChannelWorkerTransportFresh
    ? "reload_required"
    : "fresh_probe_required";
const secondAccountOperatorStatus = secondAccountReadinessSummary.releaseAcceptableAccountProof
  ? "proof_complete"
  : secondAccountReadinessSummary.canProceedToInteractiveLogin
    ? "ready_for_interactive_login"
    : "manual_windows_user_setup_required";
const goalRequiresFreshCodexChannel = !currentChannelWorkerCanDispatch;
const goalRequiresUserPresence = !antigravityAccountIsolation.releaseAcceptableAccountProof;
const unattendedSafeActions = goalComplete ? [] : [
  "refresh_no_traffic_goal_readiness",
  "refresh_current_channel_worker_recovery_status",
  "refresh_release_gate_summary",
];
const freshChannelRequiredActions = [
  ...(!currentChannelWorkerCanDispatch ? ["reload_codex_or_open_fresh_channel_then_rerun_worker_read_only_probe"] : []),
];
const userPresenceRequiredActions = [
  ...(!secondAccountReadinessSummary.targetUserExists ? ["create_or_verify_target_windows_user_then_rerun_summary"] : []),
  ...(secondAccountReadinessSummary.targetUserExists && !antigravityAccountIsolation.releaseAcceptableAccountProof ? ["run_approved_second_account_login_then_post_login_account_proof"] : []),
];
const goalOperatorActionCard = {
  status: goalComplete ? "goal_complete" : "external_actions_required",
  canClaimFullGoalNow: goalComplete,
  releaseReady: releaseGateStatus.releaseReady,
  requiresFreshCodexChannel: goalRequiresFreshCodexChannel,
  requiresUserPresence: goalRequiresUserPresence,
  canMakeUnattendedProgress: false,
  unattendedSafeActions,
  freshChannelRequiredActions,
  userPresenceRequiredActions,
  workerStatus: currentChannelWorkerTransportStatus,
  workerCanDispatchCurrentChannel: currentChannelWorkerCanDispatch,
  secondAccountStatus: secondAccountOperatorStatus,
  secondAccountCanAskUserToLoginNow: secondAccountReadinessSummary.canProceedToInteractiveLogin,
  missingRequirements: [
    ...(!currentChannelWorkerCanDispatch ? ["reload_codex_channel_and_verify_worker_read_only_call"] : []),
    ...(!antigravityAccountIsolation.releaseAcceptableAccountProof ? ["second_antigravity_account_login_and_proof"] : []),
  ],
  nextOperatorActions: [
    ...freshChannelRequiredActions,
    ...userPresenceRequiredActions,
  ],
  userVisibleNextStep: !secondAccountReadinessSummary.targetUserExists
    ? "Create or verify the separate Windows user, then rerun the no-traffic readiness summary."
    : !currentChannelWorkerCanDispatch
      ? "Reload Codex or open a fresh channel, then rerun a worker read-only status probe."
      : !antigravityAccountIsolation.releaseAcceptableAccountProof
        ? "With the user present, run the approved second-account login and post-login proof."
        : "Rerun goal readiness.",
  noTrafficStatusCommand: "node scripts\\test-anticodex-goal-readiness.mjs",
  workerRecoveryStatusCommand: currentChannelRecoveryStatusCommand,
  workerRecoveryCommand: recommendedFirstReadOnlyProbe?.recordCommand || currentChannelRecoveryRecordCommand,
  workerRecoveryRecommendedReadOnlyProbes: recommendedReadOnlyProbes,
  workerRecoveryExposedRecommendedReadOnlyProbes: exposedRecommendedReadOnlyProbes,
  workerRecoveryRecommendedFirstReadOnlyProbe: recommendedFirstReadOnlyProbe,
  secondAccountStatusCommand: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-second-account-readiness-summary.ps1 -Compact",
  secondAccountPostLoginProofStatus: secondAccountPostLoginProof.operatorActionCard.status,
  secondAccountPostLoginProofCommand: secondAccountPostLoginProof.operatorActionCard.noTrafficStatusCommand,
};

const payload = {
  ok: blockers.length === 0 || (proven.codexClientCopy && proven.workerMcp && proven.desktopAgenticTasks && proven.agenticCapabilityMatrix && proven.realTaskCoverageRoadmap && proven.realApprovalPlan && proven.releaseShortPath && proven.secondAccountLoginEntrypoint && proven.secondAccountReadinessSummary && proven.secondAccountPostLoginProof && proven.accountIsolationPreparedOnly),
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
  objectiveRequirementSummary,
  objectiveRequirementAudit,
  goalOperatorActionCard,
  currentChannelWorkerCanDispatch,
  currentChannelWorkerTransportStatus,
  currentChannelWorkerRecoveryRequired: !currentChannelWorkerCanDispatch,
  secondAccountTargetWindowsUser: secondAccountReadinessSummary.windowsUser,
  secondAccountTargetUserExists: secondAccountReadinessSummary.targetUserExists,
  secondAccountReadyForOperatorLogin: secondAccountReadinessSummary.readyForOperatorLogin,
  secondAccountSafeToAskUserForSecondAccountLogin: secondAccountReadinessSummary.safeToAskUserForSecondAccountLogin,
  secondAccountCanProceedToInteractiveLogin: secondAccountReadinessSummary.canProceedToInteractiveLogin,
  secondAccountOperatorStatus,
  secondAccountReadinessBlockingReason: secondAccountReadinessSummary.readinessBlockingReason,
  secondAccountOperatorBlockingStage: secondAccountReadinessSummary.operatorBlockingStage,
  secondAccountOperatorNextStep: secondAccountReadinessSummary.operatorNextStep,
  secondAccountNextOperatorAction: secondAccountReadinessSummary.nextOperatorAction,
  secondAccountPostLoginProofStatus: secondAccountPostLoginProof.operatorActionCard.status,
  secondAccountPostLoginProofCanRunNow: secondAccountPostLoginProof.operatorActionCard.canRunPostLoginProofNow,
  secondAccountPostLoginProofNextOperatorAction: secondAccountPostLoginProof.operatorActionCard.nextOperatorAction,
  codexClientCopy,
  workerMcp,
  workerTransportRecoveryReadiness,
  desktopAgenticTasks,
  agenticCapabilityMatrix,
  realTaskCoverageRoadmap,
  realApprovalPlan,
  antigravityAccountIsolation,
  secondAccountLoginEntrypoint,
  secondAccountReadinessSummary,
  secondAccountPostLoginProof,
  releaseGateStatus,
  nextRequiredUserAction: secondAccountReadinessSummary.nextOperatorAction
    || (antigravityAccountIsolation.safeToAskUserForSecondAccountLogin
    ? "login_second_antigravity_account_with_explicit_approval"
    : "create_or_verify_separate_windows_user_then_rerun_account_prepare"),
  elapsedMs: Date.now() - startedAt,
};

const report = writeReport(payload);
console.log(JSON.stringify({ ...payload, report }));
if (!payload.ok) process.exit(1);
