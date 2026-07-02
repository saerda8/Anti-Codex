#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";

const DEFAULT_REPORT_ROOT = `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`;
const DEFAULT_PROBE_REPORT = "latest-worker-mcp-server-probe.json";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return { present: false, parseable: false, path };
  try {
    return { present: true, parseable: true, path, report: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { present: true, parseable: false, path, error: error?.message || String(error) };
  }
}

function writeSignedReport(payload, reportRoot) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-current-channel-worker-transport.json");
  const history = resolve(reportRoot, `${utcStamp()}-current-channel-worker-transport.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function main() {
  if (hasArg("--help")) {
    console.log([
      "Usage: node scripts/record-anticodex-current-channel-worker-transport.mjs",
      "  --worker-tool kilo_get_job --worker-status transport_closed",
      "  --generic-mcp-tool node_repl --generic-mcp-status ok",
      "  [--worker-detail TEXT] [--generic-mcp-detail TEXT]",
    ].join("\n"));
    return;
  }

  const reportRoot = resolve(argValue("--report-root", DEFAULT_REPORT_ROOT));
  const probePath = resolve(reportRoot, argValue("--direct-probe-report", DEFAULT_PROBE_REPORT));
  const directProbe = readJsonIfPresent(probePath);
  const workerStatus = normalizeStatus(argValue("--worker-status", "unknown"));
  const genericMcpStatus = normalizeStatus(argValue("--generic-mcp-status", "unknown"));
  const workerTool = argValue("--worker-tool", "");
  const genericMcpTool = argValue("--generic-mcp-tool", "");
  const directProbeOk = directProbe.parseable && directProbe.report?.ok === true;
  const workerTransportOk = workerStatus === "ok";
  const workerTransportFailed = ["transport_closed", "error", "failed", "timeout"].includes(workerStatus);
  const genericMcpControlOk = genericMcpStatus === "ok";
  const splitObserved = workerTransportFailed && genericMcpControlOk && directProbeOk;
  const currentChannelWorkerDispatchBlocked = !workerTransportOk;
  const currentChannelWorkerDispatchUsable = workerTransportOk && !currentChannelWorkerDispatchBlocked;

  const payload = {
    reportName: "current-channel-worker-transport",
    ok: workerTool.length > 0 && genericMcpTool.length > 0 && directProbe.parseable === true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "current-channel-worker-transport-observation",
    checkedAt: new Date().toISOString(),
    currentChannelProbe: true,
    workerTool,
    workerStatus,
    workerDetail: argValue("--worker-detail", ""),
    workerTransportOk,
    workerTransportFailed,
    genericMcpTool,
    genericMcpStatus,
    genericMcpDetail: argValue("--generic-mcp-detail", ""),
    genericMcpControlOk,
    directProbeReport: {
      path: probePath,
      present: directProbe.present === true,
      parseable: directProbe.parseable === true,
      ok: directProbeOk,
      passedServerCount: directProbe.parseable ? Number(directProbe.report?.passedServerCount || 0) : 0,
      missingServers: directProbe.parseable && Array.isArray(directProbe.report?.missingServers) ? directProbe.report.missingServers.map(String) : [],
      codexSessionTransportStatus: directProbe.parseable ? String(directProbe.report?.codexSessionTransportStatus || "") : "",
    },
    splitObserved,
    currentChannelWorkerDispatchBlocked,
    currentChannelWorkerDispatchUsable,
    readOnlyProbeRequiredBeforeDispatch: true,
    interpretation: splitObserved
      ? "worker namespace transport is failing in the current Codex channel while generic MCP and direct worker server probe are healthy"
      : "current-channel worker transport is not proven split; inspect worker/generic/direct statuses before dispatching worker jobs",
    operatorRecoveryAction: workerTransportOk
      ? "current-channel worker read path is healthy; a narrow worker task can be dispatched after normal scope checks"
      : "reload Codex MCP/session or open a fresh channel, then rerun a read-only worker status check before dispatching worker jobs",
    postReloadVerification: workerTransportOk
      ? "keep the successful read-only worker status report as dispatch evidence before starting implementation work"
      : "after reload or a fresh channel, run one read-only worker get_job/wait/list status check; only dispatch if workerTransportOk is true",
  };
  const report = writeSignedReport(payload, reportRoot);
  console.log(JSON.stringify({ ...payload, report }));
  if (!payload.ok) process.exitCode = 1;
}

main();
