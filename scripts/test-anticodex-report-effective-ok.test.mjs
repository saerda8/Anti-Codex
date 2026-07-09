import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

function runSummary(tempRoot, fileName, report) {
  const reportPath = join(tempRoot, fileName);
  writeFileSync(reportPath, JSON.stringify(report), "utf8");
  const result = spawnSync(process.execPath, [resolve(root, "scripts", "summarize-anticodex-report.mjs"), reportPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runRecord(tempRoot, args) {
  const result = spawnSync(process.execPath, [
    resolve(root, "scripts", "record-anticodex-current-channel-worker-transport.mjs"),
    "--report-root",
    tempRoot,
    ...args,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("current-channel worker reports only pass when dispatch is usable", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "anticodex-current-worker-effective-ok-"));
  try {
    const failedTransport = runSummary(tempRoot, "latest-current-channel-worker-transport.json", {
      ok: true,
      reportName: "current-channel-worker-transport",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "current-channel-worker-transport-observation",
      workerTool: "mimo_get_job",
      workerStatus: "transport_closed",
      workerTransportOk: false,
      currentChannelWorkerDispatchUsable: false,
      currentChannelWorkerDispatchBlocked: true,
    });
    assert.equal(failedTransport.ok, true);
    assert.equal(failedTransport.effectiveOk, false);

    const healthyTransport = runSummary(tempRoot, "latest-current-channel-worker-transport.json", {
      ok: true,
      reportName: "current-channel-worker-transport",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "current-channel-worker-transport-observation",
      workerTool: "mimo_get_job",
      workerStatus: "ok",
      workerTransportOk: true,
      currentChannelWorkerDispatchUsable: true,
      currentChannelWorkerDispatchBlocked: false,
    });
    assert.equal(healthyTransport.effectiveOk, true);

    const failedRecovery = runSummary(tempRoot, "latest-current-channel-worker-recovery.json", {
      ok: true,
      reportName: "current-channel-worker-recovery",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "current-channel-worker-recovery-report-only",
      status: "reload_required",
      canDispatchCurrentChannelWorkers: false,
    });
    assert.equal(failedRecovery.ok, true);
    assert.equal(failedRecovery.effectiveOk, false);

    const healthyRecovery = runSummary(tempRoot, "latest-current-channel-worker-recovery.json", {
      ok: true,
      reportName: "current-channel-worker-recovery",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "current-channel-worker-recovery-report-only",
      status: "ready_to_dispatch",
      canDispatchCurrentChannelWorkers: true,
    });
    assert.equal(healthyRecovery.effectiveOk, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("transport recorder keeps latest failed probe from being masked by historical success", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "anticodex-current-worker-recorder-"));
  try {
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(join(tempRoot, "latest-worker-mcp-server-probe.json"), JSON.stringify({
      ok: true,
      passedServerCount: 7,
      missingServers: [],
      codexSessionTransportStatus: "not-tested-by-direct-probe",
    }), "utf8");

    const first = runRecord(tempRoot, [
      "--worker-tool", "mimo_get_job",
      "--worker-status", "ok",
      "--generic-mcp-tool", "node_repl",
      "--generic-mcp-status", "ok",
      "--exposed-worker-tool", "mimo_get_job",
    ]);
    assert.equal(first.workerTransportOk, true);
    assert.equal(first.currentChannelWorkerDispatchUsable, true);

    const second = runRecord(tempRoot, [
      "--worker-tool", "kilo_get_job",
      "--worker-status", "transport_closed",
      "--generic-mcp-tool", "node_repl",
      "--generic-mcp-status", "ok",
      "--exposed-worker-tool", "kilo_get_job",
    ]);
    assert.equal(second.workerTransportOk, false);
    assert.equal(second.workerTransportFailed, true);
    assert.equal(second.workerTransportAnyOk, true);
    assert.equal(second.currentChannelWorkerDispatchUsable, false);
    assert.equal(second.currentChannelWorkerDispatchBlocked, true);
    assert.equal(second.currentFailureHiddenByHistoricalOk, true);

    const summary = runSummary(tempRoot, "latest-current-channel-worker-transport.json", second);
    assert.equal(summary.ok, true);
    assert.equal(summary.effectiveOk, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
