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
    "Usage: node scripts/build-anticodex-fresh-channel-worker-proof-kit.mjs",
    "  [--report-root PATH] [--source-report-root PATH] [--compact]",
    "",
    "Builds a no-traffic proof kit for the fresh-channel worker read-only recovery step.",
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
  const latest = resolve(reportRoot, "latest-fresh-channel-worker-proof-kit.json");
  const history = resolve(reportRoot, `${utcStamp()}-fresh-channel-worker-proof-kit.json`);
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

const recoveryFile = readReport("latest-current-channel-worker-recovery.json");
const transportFile = readReport("latest-current-channel-worker-transport.json");
const goalFile = readReport("latest-goal-readiness.json");
const recovery = recoveryFile.report || {};
const transport = transportFile.report || {};
const goal = goalFile.report || {};
const goalCard = goal.goalOperatorActionCard || {};

const recommendedReadOnlyProbes = asStringArray(recovery.recommendedReadOnlyProbes)
  .map((_, index) => recovery.recommendedReadOnlyProbes[index])
  .filter((item) => item && typeof item === "object" && item.statusTool && item.jobId);
const exposedRecommendedReadOnlyProbes = asStringArray(recovery.exposedRecommendedReadOnlyProbes)
  .map((_, index) => recovery.exposedRecommendedReadOnlyProbes[index])
  .filter((item) => item && typeof item === "object" && item.statusTool && item.jobId);
const recommendedFirstReadOnlyProbe = recovery.recommendedFirstReadOnlyProbe
  || goalCard.workerRecoveryRecommendedFirstReadOnlyProbe
  || exposedRecommendedReadOnlyProbes[0]
  || recommendedReadOnlyProbes[0]
  || null;
const recordSuccessCommand = asString(recommendedFirstReadOnlyProbe?.recordCommand || goalCard.workerRecoveryCommand || "");
const statusCommand = asString(goalCard.workerRecoveryStatusCommand || recovery.commands?.recoveryReadiness || "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-current-channel-worker-recovery.ps1 -Compact");

const currentEvidence = {
  latestTransportCheckedAt: asString(transport.checkedAt || recovery.currentEvidence?.transportCheckedAt),
  workerTransportOkCount: Number(transport.workerTransportOkCount || recovery.currentEvidence?.workerTransportOkTools?.length || 0),
  workerTransportFailedCount: Number(transport.workerTransportFailedCount || recovery.currentEvidence?.workerTransportFailedTools?.length || 0),
  workerObservationCount: Number(transport.workerObservationCount || 0),
  genericMcpControlOk: transport.genericMcpControlOk === true || recovery.currentEvidence?.genericMcpControlOk === true,
  directProbeOk: transport.directProbeReport?.ok === true || recovery.currentEvidence?.directProbeOk === true,
  directStatusProbeOk: recovery.currentEvidence?.directStatusProbeOk === true,
  repeatedCurrentChannelWorkerFailure: recovery.repeatedFailureAudit?.repeatedCurrentChannelWorkerFailure === true,
  sameChannelRetryRecommended: recovery.repeatedFailureAudit?.sameChannelRetryRecommended === true,
};

const requiredSuccessCriteria = {
  workerTransportOk: true,
  genericMcpControlOk: true,
  directWorkerServerProbeOk: true,
  directWorkerStatusProbeOk: true,
  recordedByTransportReport: true,
  latestTransportReportFresh: true,
  goalReadinessCanDispatchCurrentChannelWorker: true,
};

const failures = [];
if (!recoveryFile.present || !recoveryFile.parseable) failures.push("worker_recovery_report_missing_or_unparseable");
if (!transportFile.present || !transportFile.parseable) failures.push("worker_transport_report_missing_or_unparseable");
if (recommendedReadOnlyProbes.length < 3) failures.push("recommended_read_only_probe_count_too_low");
if (!recommendedFirstReadOnlyProbe?.statusTool) failures.push("recommended_first_read_only_probe_missing");
if (!recordSuccessCommand.includes("record-anticodex-current-channel-worker-transport.mjs")) failures.push("record_success_command_missing");
if (currentEvidence.genericMcpControlOk !== true) failures.push("generic_mcp_control_evidence_missing");
if (currentEvidence.directProbeOk !== true) failures.push("direct_worker_probe_evidence_missing");

const payload = {
  ok: failures.length === 0,
  reportName: "fresh-channel-worker-proof-kit",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "fresh-channel-worker-proof-kit-report-only",
  changedSystem: false,
  startedLogin: false,
  capturesPassword: false,
  storesPassword: false,
  startsWorkerImplementation: false,
  allowImplementationDispatchBeforeReadOnlySuccess: false,
  generatedAt: new Date(startedAt).toISOString(),
  currentEvidence,
  requiredSuccessCriteria,
  recommendedReadOnlyProbes,
  exposedRecommendedReadOnlyProbes,
  recommendedFirstReadOnlyProbe,
  statusCommand,
  recordSuccessCommand,
  postSuccessValidationCommand: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-current-channel-worker-recovery.ps1 -Compact",
  goalValidationCommand: "node scripts\\test-anticodex-goal-readiness.mjs --compact",
  releaseGateValidationCommand: "node scripts\\test-anticodex-release-gates.mjs --compact-status",
  proofSequence: [
    "open a fresh or reloaded Codex channel",
    "run the recommended first read-only worker status/get/wait tool call",
    "run a same-channel generic MCP control call",
    "record success with recordSuccessCommand only if the worker call returned normally",
    "run postSuccessValidationCommand",
    "run goalValidationCommand and require currentChannelWorkerCanDispatch:true before worker implementation dispatch",
  ],
  forbiddenBeforeSuccess: [
    "do not start worker implementation jobs",
    "do not mark worker_mcp_multiuse complete",
    "do not mark full goal complete",
    "do not treat visible worker metadata as worker transport proof",
  ],
  failures,
  elapsedMs: Date.now() - startedAt,
};

const report = writeSignedReport(payload);
if (compact) {
  console.log(JSON.stringify({
    ok: payload.ok,
    reportName: payload.reportName,
    requestedRealTraffic: payload.requestedRealTraffic,
    usedRealTraffic: payload.usedRealTraffic,
    startsWorkerImplementation: payload.startsWorkerImplementation,
    allowImplementationDispatchBeforeReadOnlySuccess: payload.allowImplementationDispatchBeforeReadOnlySuccess,
    recommendedFirstReadOnlyProbe: payload.recommendedFirstReadOnlyProbe,
    recommendedReadOnlyProbeCount: payload.recommendedReadOnlyProbes.length,
    failures: payload.failures,
    report,
  }));
} else {
  console.log(JSON.stringify({ ...payload, report }, null, 2));
}
