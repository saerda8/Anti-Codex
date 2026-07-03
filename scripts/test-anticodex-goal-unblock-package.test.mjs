#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("goal unblock package is a no-traffic machine-readable handoff for the two remaining blockers", () => {
  const reportRoot = mkdtempSync(join(os.tmpdir(), "anticodex-goal-unblock-package-"));
  const result = spawnSync(
    process.execPath,
    ["scripts/build-anticodex-goal-unblock-package.mjs", "--report-root", reportRoot],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const reportPath = join(reportRoot, "latest-goal-unblock-package.json");
  assert.equal(existsSync(reportPath), true, "latest-goal-unblock-package.json was not written");

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.reportName, "goal-unblock-package");
  assert.equal(report.requestedRealTraffic, false);
  assert.equal(report.usedRealTraffic, false);
  assert.equal(report.changedSystem, false);
  assert.equal(report.createdUser, false);
  assert.equal(report.startedLogin, false);
  assert.equal(report.capturesPassword, false);
  assert.equal(report.storesPassword, false);

  assert.equal(report.canClaimFullGoalNow, false);
  assert.equal(report.releaseReady, true);
  assert.deepEqual(report.remainingObjectiveRequirementIds, ["separate_antigravity_accounts", "worker_mcp_multiuse"]);
  assert.deepEqual(report.blockers, [
    "current_channel_worker_transport_not_recovered",
    "second_antigravity_account_real_proof_missing",
  ]);

  assert.equal(report.freshChannelWorkerProof?.requiresFreshCodexChannel, true);
  assert.equal(report.freshChannelWorkerProof?.requiresFreshReadOnlyProbe, true);
  assert.equal(report.freshChannelWorkerProof?.sameChannelRetryRecommended, false);
  assert.equal(report.freshChannelWorkerProof?.recommendedFirstReadOnlyProbe?.statusTool, "mimocode_wait_for_job");
  assert.match(report.freshChannelWorkerProof?.recordCommand || "", /record-anticodex-current-channel-worker-transport\.mjs/);

  assert.equal(report.secondAccountProof?.requiresUserPresence, true);
  assert.equal(report.secondAccountProof?.windowsUser, ".\\AntiCodexModel");
  assert.equal(report.secondAccountProof?.targetUserExists, false);
  assert.equal(report.secondAccountProof?.safeToAskUserForSecondAccountLogin, false);
  assert.equal(report.secondAccountProof?.postLoginProofStatus, "blocked_before_login");
  assert.equal(report.secondAccountProof?.effectiveAntiCodexAccountIdPresent, true);
  assert.equal(report.secondAccountProof?.effectiveMcpAccountIdPresent, false);

  assert.equal(report.externalMcpIdentityHandoff?.contractReportPresent, true);
  assert.equal(report.externalMcpIdentityHandoff?.contractAccepted, true);
  assert.equal(report.externalMcpIdentityHandoff?.managedByAntiCodex, false);

  assert.equal(Array.isArray(report.machineReadableNextActions), true);
  assert.equal(report.machineReadableNextActions.length >= 4, true);
  for (const action of report.machineReadableNextActions) {
    assert.equal(typeof action.id, "string");
    assert.equal(action.id.length > 0, true);
    assert.equal(typeof action.owner, "string");
    assert.equal(action.owner.length > 0, true);
    assert.equal(Boolean(action.command || action.proofReport || action.recordCommand), true);
  }
});
