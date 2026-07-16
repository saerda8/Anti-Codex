import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..", "..");
const { NODE_TEST_CONTEXT: _nodeTestContext, ...childEnv } = process.env;

test("formal Gate 6 matrix advances only with signed visible Gate 5 evidence", async () => {
  const scriptPath = resolve(root, "scripts", "test-antigravity-chat-adapter-edge-contract.mjs");
  const reportPath = resolve(root, "docs", "audits", "2026-07-15-gate6-edge-matrix.json");
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--formal", "--compact"], {
    cwd: root,
    env: childEnv,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = JSON.parse(stdout.trim());

  assert.equal(output.ok, true);
  assert.equal(output.formalGateAdvanced, true);
  assert.equal(output.failedIds.length, 0);
  assert.equal(existsSync(reportPath), true);
  assert.equal(existsSync(`${reportPath}.sha256`), true);

  const bytes = readFileSync(reportPath);
  const report = JSON.parse(bytes);
  assert.equal(report.formalGateAdvanced, true);
  assert.equal(report.blockedBy, null);
  assert.equal(report.checks.find((check) => check.id === "gate5_visible_integration_signed")?.ok, true);
  assert.equal(report.checks.every((check) => check.ok === true), true);

  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(readFileSync(`${reportPath}.sha256`, "ascii").trim(), `sha256:${expectedHash}`);
});
