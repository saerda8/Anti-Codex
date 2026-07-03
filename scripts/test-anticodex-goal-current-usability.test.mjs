#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("goal readiness separates current Anti-Codex usability from optional account and worker MCP closure", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/test-anticodex-goal-readiness.mjs", "--compact"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const reportPath = join(process.env.APPDATA || ".", "anticodex", "reports", "latest-goal-readiness.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(report.goalComplete, false);
  assert.equal(report.releaseReady, true);
  assert.equal(report.shortReady, true);
  assert.deepEqual(report.missingRequired, []);
  assert.deepEqual(report.missingShort, []);
  assert.equal(report.releaseReady, report.releaseGateStatus?.releaseReady);
  assert.equal(report.currentUsability?.mode, "shared-account-worker-mcp-disabled");
  assert.equal(report.currentUsability?.usableNow, true);
  assert.equal(report.currentUsability?.releaseReady, true);
  assert.equal(report.currentUsability?.requiresSeparateAntigravityAccount, false);
  assert.equal(report.currentUsability?.requiresCurrentChannelWorkerMcp, false);
  assert.equal(report.currentUsability?.workerMcpTemporarilyDisabled, true);
  assert.equal(report.currentUsability?.usesSharedAntigravityAccount, true);
  assert.equal(report.currentUsability?.codexClientCopy, true);
  assert.equal(report.currentUsability?.antigravityModelText, true);
  assert.equal(report.currentUsability?.nativeCodexLikeAgenticEvidence, true);
  assert.match(report.currentUsability?.caveat || "", /Full goal/);
  assert.equal(report.objectiveRequirementSummary.canClaimFullGoalNow, false);
  assert.match(report.goalOperatorActionCard?.compactStatusCommand || "", /--compact-status/);
});

test("goal readiness compact-status is short and carries operator status", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/test-anticodex-goal-readiness.mjs", "--compact-status"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(status.reportName, "goal-readiness-status");
  assert.equal(status.usableNow, true);
  assert.equal(status.releaseReady, true);
  assert.equal(status.shortReady, true);
  assert.equal(status.goalComplete, false);
  assert.deepEqual(status.incompleteRequirements, ["separate_antigravity_accounts", "worker_mcp_multiuse"]);
  assert.match(status.currentChannelWorkerTransportStatus, /reload_required|fresh_probe_required|dispatch_ready/);
  assert.equal(status.currentChannelWorkerCanDispatch, false);
  assert.equal(status.secondAccountTargetWindowsUser, ".\\AntiCodexModel");
  assert.ok(!Object.hasOwn(status, "workerMcp"));
});
