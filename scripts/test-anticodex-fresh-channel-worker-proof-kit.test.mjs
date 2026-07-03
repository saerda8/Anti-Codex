#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("fresh-channel worker proof kit is no-traffic and blocks implementation dispatch before read-only success", () => {
  const reportRoot = mkdtempSync(join(os.tmpdir(), "anticodex-fresh-worker-proof-kit-"));
  const result = spawnSync(
    process.execPath,
    ["scripts/build-anticodex-fresh-channel-worker-proof-kit.mjs", "--report-root", reportRoot],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const reportPath = join(reportRoot, "latest-fresh-channel-worker-proof-kit.json");
  assert.equal(existsSync(reportPath), true, "latest-fresh-channel-worker-proof-kit.json was not written");

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.reportName, "fresh-channel-worker-proof-kit");
  assert.equal(report.requestedRealTraffic, false);
  assert.equal(report.usedRealTraffic, false);
  assert.equal(report.startsWorkerImplementation, false);
  assert.equal(report.allowImplementationDispatchBeforeReadOnlySuccess, false);
  assert.equal(report.requiredSuccessCriteria?.workerTransportOk, true);
  assert.equal(report.requiredSuccessCriteria?.genericMcpControlOk, true);
  assert.equal(report.requiredSuccessCriteria?.recordedByTransportReport, true);
  assert.equal(Array.isArray(report.recommendedReadOnlyProbes), true);
  assert.equal(report.recommendedReadOnlyProbes.length >= 3, true);
  assert.equal(report.recommendedFirstReadOnlyProbe?.statusTool, "mimocode_wait_for_job");
  assert.match(report.recordSuccessCommand || "", /record-anticodex-current-channel-worker-transport\.mjs/);
  assert.match(report.postSuccessValidationCommand || "", /test-anticodex-current-channel-worker-recovery/);
  assert.match(report.goalValidationCommand || "", /test-anticodex-goal-readiness/);
});
