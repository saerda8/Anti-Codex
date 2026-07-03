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
    "Usage: node scripts/test-anticodex-current-channel-worker-recovery.mjs",
    "  [--report-root PATH] [--max-age-ms N] [--compact]",
    "",
    "Reads current-channel transport plus direct worker server/status probe reports.",
    "Writes latest-current-channel-worker-recovery.json without traffic or worker dispatch.",
  ].join("\n"));
  process.exit(0);
}

const startedAt = Date.now();
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const maxAgeMs = Number(args.get("--max-age-ms") || 6 * 60 * 60 * 1000);
const compact = args.has("--compact");

function readReport(fileName) {
  const path = resolve(reportRoot, fileName);
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
  const latest = resolve(reportRoot, "latest-current-channel-worker-recovery.json");
  const history = resolve(reportRoot, `${utcStamp()}-current-channel-worker-recovery.json`);
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

function deriveWorkerPrefixes(tools) {
  return [...new Set(tools.map((tool) => String(tool).split("_")[0]).filter(Boolean))];
}

function recommendedReadOnlyProbesFromStatusProbe(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  return results
    .filter((item) => item && item.statusCallOk === true && item.skipped !== true && item.statusTool && item.jobId)
    .map((item) => ({
      worker: String(item.worker || ""),
      statusTool: String(item.statusTool || ""),
      jobId: String(item.jobId || ""),
      expectedStatus: String(item.status || ""),
      recordCommand: `node scripts\\record-anticodex-current-channel-worker-transport.mjs --worker-tool ${String(item.statusTool || "")} --worker-status ok --generic-mcp-tool node_repl --generic-mcp-status ok`,
    }));
}

const transportFile = readReport("latest-current-channel-worker-transport.json");
const probeFile = readReport("latest-worker-mcp-server-probe.json");
const statusProbeFile = readReport("latest-worker-mcp-status-probe.json");
const transport = transportFile.report || {};
const directProbe = probeFile.report || {};
const statusProbe = statusProbeFile.report || {};
const exposedWorkerTools = asStringArray(transport.exposedWorkerTools);
const exposedWorkerToolSet = new Set(exposedWorkerTools);
const checkedAtMs = Date.parse(String(transport.checkedAt || ""));
const transportAgeMs = Number.isFinite(checkedAtMs) ? Math.max(0, startedAt - checkedAtMs) : null;
const transportFresh = Number.isFinite(transportAgeMs) && transportAgeMs <= maxAgeMs;
const failedTools = asStringArray(transport.workerTransportFailedTools);
const okTools = asStringArray(transport.workerTransportOkTools);
const failedWorkerPrefixes = deriveWorkerPrefixes(failedTools);
const okWorkerPrefixes = deriveWorkerPrefixes(okTools);

const directProbeOk = directProbe.ok === true;
const directStatusProbeOk = statusProbe.ok === true
  && statusProbe.usedRealTraffic === false
  && Number(statusProbe.statusCallOkCount || 0) >= 6
  && Array.isArray(statusProbe.failedWorkers)
  && statusProbe.failedWorkers.length === 0
  && statusProbe.antigravitySkippedForAccountIsolation === true
  && typeof statusProbe.currentChannelCaveat === "string"
  && statusProbe.currentChannelCaveat.trim().length > 0;
const recommendedReadOnlyProbes = recommendedReadOnlyProbesFromStatusProbe(statusProbe);
const exposedRecommendedReadOnlyProbes = recommendedReadOnlyProbes.filter((item) => exposedWorkerToolSet.has(item.statusTool));
const recommendedFirstReadOnlyProbe = exposedRecommendedReadOnlyProbes[0] || recommendedReadOnlyProbes[0] || null;
const genericMcpOk = transport.genericMcpControlOk === true && String(transport.genericMcpStatus || "") === "ok";
const currentWorkerOk = transport.workerTransportOk === true && transport.currentChannelWorkerDispatchUsable === true;
const canDispatchCurrentChannelWorkers = Boolean(
  transportFile.present
    && transportFile.parseable
    && transport.ok === true
    && transportFresh
    && currentWorkerOk
    && genericMcpOk
    && (transport.directProbeReport?.ok === true || directProbeOk),
);

const missingRequirements = [];
if (!transportFile.present) missingRequirements.push("current_channel_worker_transport_report_missing");
if (transportFile.present && !transportFile.parseable) missingRequirements.push("current_channel_worker_transport_report_unparseable");
if (transportFile.parseable && transport.ok !== true) missingRequirements.push("current_channel_worker_transport_report_not_ok");
if (!transportFresh) missingRequirements.push("fresh_current_channel_worker_read_only_probe");
if (!currentWorkerOk) missingRequirements.push("successful_current_channel_worker_read_only_call");
if (!genericMcpOk) missingRequirements.push("same_channel_generic_mcp_ok");
if (!(transport.directProbeReport?.ok === true || directProbeOk)) missingRequirements.push("direct_worker_server_probe_ok");
if (!directStatusProbeOk) missingRequirements.push("direct_worker_status_probe_ok");

const status = canDispatchCurrentChannelWorkers
  ? "ready_to_dispatch"
  : transportFile.present && transportFile.parseable
    ? "reload_required"
    : "missing_evidence";
const repeatedFailureThreshold = 3;
const repeatedCurrentChannelWorkerFailure = !canDispatchCurrentChannelWorkers
  && failedTools.length >= repeatedFailureThreshold
  && okTools.length === 0
  && genericMcpOk
  && directProbeOk;
const repeatedFailureAudit = {
  threshold: repeatedFailureThreshold,
  failedObservationCount: failedTools.length,
  okObservationCount: okTools.length,
  failedWorkerPrefixCount: failedWorkerPrefixes.length,
  failedWorkerPrefixes,
  genericMcpControlOk: genericMcpOk,
  directWorkerProbeOk: directProbeOk,
  repeatedCurrentChannelWorkerFailure,
  sameChannelRetryRecommended: !repeatedCurrentChannelWorkerFailure,
  recommendedAction: repeatedCurrentChannelWorkerFailure
    ? "stop_same_channel_worker_retries_and_use_fresh_channel_or_reload"
    : "rerun_read_only_worker_probe_if_evidence_is_stale_or_incomplete",
};

const payload = {
  reportName: "current-channel-worker-recovery",
  ok: true,
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "current-channel-worker-recovery-report-only",
  checkedAt: new Date(startedAt).toISOString(),
  status,
  canDispatchCurrentChannelWorkers,
  requiresCodexMcpReload: !canDispatchCurrentChannelWorkers,
  requiresFreshReadOnlyProbe: !canDispatchCurrentChannelWorkers,
  missingRequirements,
  repeatedFailureAudit,
  currentEvidence: {
    transportReportPresent: transportFile.present,
    transportReportParseable: transportFile.parseable,
    transportReportOk: transport.ok === true,
    transportCheckedAt: String(transport.checkedAt || ""),
    transportAgeMs,
    transportMaxAgeMs: maxAgeMs,
    transportFresh,
    workerTransportOk: transport.workerTransportOk === true,
    workerTransportFailed: transport.workerTransportFailed === true,
    currentChannelWorkerDispatchUsable: transport.currentChannelWorkerDispatchUsable === true,
    currentChannelWorkerDispatchBlocked: transport.currentChannelWorkerDispatchBlocked === true,
    workerTransportOkTools: okTools,
    workerTransportFailedTools: failedTools,
    workerTransportOkWorkerPrefixes: okWorkerPrefixes,
    workerTransportFailedWorkerPrefixes: failedWorkerPrefixes,
    expectedWorkerPrefixes: asStringArray(transport.expectedWorkerPrefixes),
    exposedWorkerTools,
    exposedWorkerPrefixes: asStringArray(transport.exposedWorkerPrefixes),
    observedWorkerPrefixes: asStringArray(transport.observedWorkerPrefixes),
    missingExpectedWorkerPrefixes: asStringArray(transport.missingExpectedWorkerPrefixes),
    exposedButUntestedWorkerPrefixes: asStringArray(transport.exposedButUntestedWorkerPrefixes),
    genericMcpTool: String(transport.genericMcpTool || ""),
    genericMcpStatus: String(transport.genericMcpStatus || ""),
    genericMcpControlOk: genericMcpOk,
    splitObserved: transport.splitObserved === true,
    directProbeOk: transport.directProbeReport?.ok === true || directProbeOk,
    directProbePassedServerCount: Number(transport.directProbeReport?.passedServerCount || directProbe.passedServerCount || 0),
    directProbeCodexSessionTransportStatus: String(transport.directProbeReport?.codexSessionTransportStatus || directProbe.codexSessionTransportStatus || ""),
    directStatusProbeReportPresent: statusProbeFile.present,
    directStatusProbeReportParseable: statusProbeFile.parseable,
    directStatusProbeOk,
    directStatusProbeStatusCallOkCount: Number(statusProbe.statusCallOkCount || 0),
    directStatusProbeStatusCallOkWorkers: asStringArray(statusProbe.statusCallOkWorkers),
    directStatusProbeFailedWorkers: asStringArray(statusProbe.failedWorkers),
    directStatusProbeSkippedWorkers: asStringArray(statusProbe.skippedWorkers),
    directStatusProbeAntigravitySkippedForAccountIsolation: statusProbe.antigravitySkippedForAccountIsolation === true,
    directStatusProbeCurrentChannelCaveatPresent: typeof statusProbe.currentChannelCaveat === "string" && statusProbe.currentChannelCaveat.trim().length > 0,
  },
  postReloadAcceptanceCriteria: [
    "run a current-channel read-only worker get_job/wait/status call",
    "record it with record-anticodex-current-channel-worker-transport.mjs using worker-status ok",
    "same-channel generic MCP control must be ok",
    "direct worker server probe must be ok",
    "direct worker status probe must be ok",
    "use one recommendedReadOnlyProbes entry from the latest direct status probe as the first fresh-channel worker read-only call",
    "latest transport report must be fresh",
    "canDispatchCurrentChannelWorkers must be true before starting implementation workers",
  ],
  recommendedReadOnlyProbes,
  exposedRecommendedReadOnlyProbes,
  recommendedFirstReadOnlyProbe,
  commands: {
    directWorkerProbe: "node scripts\\probe-anticodex-worker-mcp-servers.mjs",
    directWorkerStatusProbe: "node scripts\\test-anticodex-worker-mcp-status-probe.mjs --timeout-ms 30000",
    recordSuccess: "node scripts\\record-anticodex-current-channel-worker-transport.mjs --worker-tool <worker_read_tool> --worker-status ok --generic-mcp-tool node_repl --generic-mcp-status ok",
    goalReadiness: "node scripts\\test-anticodex-goal-readiness.mjs",
    recoveryReadiness: "node scripts\\test-anticodex-current-channel-worker-recovery.mjs",
  },
  operatorActionCard: {
    status,
    canDispatchCurrentChannelWorkers,
    safeToStartImplementationWorker: canDispatchCurrentChannelWorkers,
    repeatedCurrentChannelWorkerFailure,
    sameChannelRetryRecommended: repeatedFailureAudit.sameChannelRetryRecommended,
    missingRequirements,
    nextOperatorAction: canDispatchCurrentChannelWorkers
      ? "dispatch_only_a_narrow_worker_task_after_normal_scope_checks"
      : repeatedCurrentChannelWorkerFailure
        ? "stop_same_channel_worker_retries_and_use_fresh_channel_or_reload"
      : "reload_codex_or_open_fresh_channel_then_rerun_worker_read_only_probe",
    recommendedFirstReadOnlyProbe,
    userVisibleNextStep: canDispatchCurrentChannelWorkers
      ? "Worker MCP read path is healthy in this channel; start only a narrow worker task first."
      : repeatedCurrentChannelWorkerFailure
        ? "Stop retrying worker tools in this channel; reload Codex or use a fresh channel, then run one read-only worker status check."
      : "Reload Codex or use a fresh channel, then run one read-only worker status check before worker tasks.",
  },
};

const report = writeSignedReport(payload);
if (compact) {
  console.log(JSON.stringify({
    ok: payload.ok,
    reportName: payload.reportName,
    requestedRealTraffic: payload.requestedRealTraffic,
    usedRealTraffic: payload.usedRealTraffic,
    status: payload.status,
    canDispatchCurrentChannelWorkers: payload.canDispatchCurrentChannelWorkers,
    requiresCodexMcpReload: payload.requiresCodexMcpReload,
    requiresFreshReadOnlyProbe: payload.requiresFreshReadOnlyProbe,
    missingRequirements: payload.missingRequirements,
    repeatedFailureAudit: payload.repeatedFailureAudit,
    workerTransportFailedTools: payload.currentEvidence.workerTransportFailedTools,
    workerTransportOkTools: payload.currentEvidence.workerTransportOkTools,
    expectedWorkerPrefixes: payload.currentEvidence.expectedWorkerPrefixes,
    exposedWorkerPrefixes: payload.currentEvidence.exposedWorkerPrefixes,
    observedWorkerPrefixes: payload.currentEvidence.observedWorkerPrefixes,
    missingExpectedWorkerPrefixes: payload.currentEvidence.missingExpectedWorkerPrefixes,
    exposedButUntestedWorkerPrefixes: payload.currentEvidence.exposedButUntestedWorkerPrefixes,
    genericMcpControlOk: payload.currentEvidence.genericMcpControlOk,
    directProbeOk: payload.currentEvidence.directProbeOk,
    directStatusProbeOk: payload.currentEvidence.directStatusProbeOk,
    recommendedReadOnlyProbes: payload.recommendedReadOnlyProbes,
    exposedRecommendedReadOnlyProbes: payload.exposedRecommendedReadOnlyProbes,
    recommendedFirstReadOnlyProbe: payload.operatorActionCard.recommendedFirstReadOnlyProbe,
    nextOperatorAction: payload.operatorActionCard.nextOperatorAction,
    report,
  }));
} else {
  console.log(JSON.stringify({ ...payload, report }));
}
