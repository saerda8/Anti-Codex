import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
