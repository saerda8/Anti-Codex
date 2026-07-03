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

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
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

function parseWorkerObservation(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return makeWorkerObservation(parsed?.workerTool, parsed?.workerStatus, parsed?.workerDetail);
  } catch {
    const first = text.indexOf("=");
    const second = first >= 0 ? text.indexOf("=", first + 1) : -1;
    const tool = first >= 0 ? text.slice(0, first) : text;
    const status = first >= 0 && second >= 0 ? text.slice(first + 1, second) : (first >= 0 ? text.slice(first + 1) : "");
    const detail = second >= 0 ? text.slice(second + 1) : "";
    return makeWorkerObservation(tool, status, detail);
  }
}

function makeWorkerObservation(workerTool, workerStatus, workerDetail = "") {
  const status = normalizeStatus(workerStatus);
  const observation = {
    workerTool: String(workerTool || "").trim(),
    workerStatus: status,
    workerDetail: String(workerDetail || ""),
    workerTransportOk: status === "ok",
    workerTransportFailed: ["transport_closed", "error", "failed", "timeout"].includes(status),
  };
  return observation.workerTool ? observation : null;
}

function normalizeWorkerObservations(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => makeWorkerObservation(item?.workerTool, item?.workerStatus, item?.workerDetail))
    .filter(Boolean);
}

function dedupeWorkerObservations(values) {
  const seen = new Set();
  const deduped = [];
  for (const item of values) {
    const key = [item.workerTool, item.workerStatus, item.workerDetail].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function workerPrefixFromTool(tool) {
  return String(tool || "").trim().split("_")[0] || "";
}

function main() {
  if (hasArg("--help")) {
    console.log([
      "Usage: node scripts/record-anticodex-current-channel-worker-transport.mjs",
      "  --worker-tool kilo_get_job --worker-status transport_closed",
      "  --worker-observation kilo_get_job=transport_closed=optional-detail",
      "  --exposed-worker-tool kilo_get_job",
      "  --expected-worker-prefix kilo",
      "  --generic-mcp-tool node_repl --generic-mcp-status ok",
      "  [--worker-detail TEXT] [--generic-mcp-detail TEXT]",
      "  [--replace-latest]",
    ].join("\n"));
    return;
  }

  const reportRoot = resolve(argValue("--report-root", DEFAULT_REPORT_ROOT));
  const latestTransportPath = resolve(reportRoot, "latest-current-channel-worker-transport.json");
  const latestTransport = readJsonIfPresent(latestTransportPath);
  const probePath = resolve(reportRoot, argValue("--direct-probe-report", DEFAULT_PROBE_REPORT));
  const directProbe = readJsonIfPresent(probePath);
  const replaceLatest = hasArg("--replace-latest");
  const workerStatus = normalizeStatus(argValue("--worker-status", "unknown"));
  const genericMcpStatus = normalizeStatus(argValue("--generic-mcp-status", "unknown"));
  const workerTool = argValue("--worker-tool", "");
  const genericMcpTool = argValue("--generic-mcp-tool", "");
  const inputWorkerObservations = [
    ...argValues("--worker-observation").map(parseWorkerObservation),
    makeWorkerObservation(workerTool, workerStatus, argValue("--worker-detail", "")),
  ].filter(Boolean);
  const latestWorkerObservations = replaceLatest ? [] : normalizeWorkerObservations(latestTransport.report?.workerObservations);
  const inputHasHealthyWorker = inputWorkerObservations.some((item) => item.workerTransportOk);
  const mergedLatestWorkerObservations =
    latestWorkerObservations.length > inputWorkerObservations.length && !inputHasHealthyWorker;
  const workerObservations = mergedLatestWorkerObservations
    ? dedupeWorkerObservations([...inputWorkerObservations, ...latestWorkerObservations])
    : inputWorkerObservations;
  const expectedWorkerPrefixes = uniqueStrings([
    ...argValues("--expected-worker-prefix"),
    ...argValue("--expected-worker-prefixes", "").split(","),
    ...(replaceLatest ? [] : (Array.isArray(latestTransport.report?.expectedWorkerPrefixes) ? latestTransport.report.expectedWorkerPrefixes : [])),
  ]);
  const exposedWorkerTools = uniqueStrings([
    ...argValues("--exposed-worker-tool"),
    ...(replaceLatest ? [] : (Array.isArray(latestTransport.report?.exposedWorkerTools) ? latestTransport.report.exposedWorkerTools : [])),
  ]);
  const observedWorkerPrefixes = uniqueStrings(workerObservations.map((item) => workerPrefixFromTool(item.workerTool)));
  const exposedWorkerPrefixes = uniqueStrings(exposedWorkerTools.map(workerPrefixFromTool));
  const missingExpectedWorkerPrefixes = expectedWorkerPrefixes.length
    ? expectedWorkerPrefixes.filter((prefix) => !exposedWorkerPrefixes.includes(prefix))
    : [];
  const exposedButUntestedWorkerPrefixes = exposedWorkerPrefixes.filter((prefix) => !observedWorkerPrefixes.includes(prefix));
  const directProbeOk = directProbe.parseable && directProbe.report?.ok === true;
  const primaryObservation = workerObservations[0] || makeWorkerObservation(workerTool, workerStatus, argValue("--worker-detail", "")) || {};
  const workerTransportOkCount = workerObservations.filter((item) => item.workerTransportOk).length;
  const workerTransportFailedCount = workerObservations.filter((item) => item.workerTransportFailed).length;
  const workerTransportOk = workerTransportOkCount > 0;
  const workerTransportFailed = workerTransportFailedCount > 0 && workerTransportOkCount === 0;
  const genericMcpControlOk = genericMcpStatus === "ok";
  const splitObserved = workerTransportFailedCount > 0 && genericMcpControlOk && directProbeOk;
  const currentChannelWorkerDispatchBlocked = !workerTransportOk;
  const currentChannelWorkerDispatchUsable = workerTransportOk && !currentChannelWorkerDispatchBlocked;

  const payload = {
    reportName: "current-channel-worker-transport",
    ok: workerObservations.length > 0 && genericMcpTool.length > 0 && directProbe.parseable === true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "current-channel-worker-transport-observation",
    checkedAt: new Date().toISOString(),
    currentChannelProbe: true,
    workerTool: primaryObservation.workerTool || workerTool,
    workerStatus: primaryObservation.workerStatus || workerStatus,
    workerDetail: primaryObservation.workerDetail || argValue("--worker-detail", ""),
    workerTransportOk,
    workerTransportFailed,
    workerObservations,
    workerObservationCount: workerObservations.length,
    inputWorkerObservationCount: inputWorkerObservations.length,
    mergedLatestWorkerObservations,
    replaceLatestTransportReport: replaceLatest,
    latestTransportReport: {
      path: latestTransportPath,
      present: latestTransport.present === true,
      parseable: latestTransport.parseable === true,
      workerObservationCount: latestTransport.parseable ? Number(latestTransport.report?.workerObservationCount || 0) : 0,
    },
    workerTransportOkCount,
    workerTransportFailedCount,
    workerTransportOkTools: workerObservations.filter((item) => item.workerTransportOk).map((item) => item.workerTool),
    workerTransportFailedTools: workerObservations.filter((item) => item.workerTransportFailed).map((item) => item.workerTool),
    workerTransportAnyOk: workerTransportOkCount > 0,
    workerTransportAllFailed: workerObservations.length > 0 && workerTransportFailedCount === workerObservations.length,
    expectedWorkerPrefixes,
    exposedWorkerTools,
    exposedWorkerToolCount: exposedWorkerTools.length,
    exposedWorkerPrefixes,
    exposedWorkerPrefixCount: exposedWorkerPrefixes.length,
    observedWorkerPrefixes,
    observedWorkerPrefixCount: observedWorkerPrefixes.length,
    missingExpectedWorkerPrefixes,
    exposedButUntestedWorkerPrefixes,
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
