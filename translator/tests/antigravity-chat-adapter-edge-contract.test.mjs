import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCurrentReleaseBinding } from "../../scripts/lib/anticodex-release-binding.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..", "..");
const { NODE_TEST_CONTEXT: _nodeTestContext, ...childEnv } = process.env;

test("formal Gate 6 matrix advances only with signed visible Gate 5 evidence", async () => {
  const scriptPath = resolve(root, "scripts", "test-antigravity-chat-adapter-edge-contract.mjs");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "anticodex-gate6-contract-"));
  const reportPath = join(temporaryRoot, "gate6.json");
  const gate5Path = join(temporaryRoot, "gate5.json");
  const outputRoot = join(temporaryRoot, "reports");
  const releaseReportRoot = resolve(process.env.APPDATA || tmpdir(), "anticodex", "reports");
  try {
    const releaseBinding = createCurrentReleaseBinding({ sourceRoot: root, reportRoot: releaseReportRoot });
    assert.equal(releaseBinding.valid, true);
    const gate5Body = `${JSON.stringify({
      generatedAtUtc: new Date().toISOString(),
      ok: true,
      gateComplete: true,
      sourceEvidenceUsedRealTraffic: true,
      checks: [{ id: "fixture", ok: true }],
      releaseBinding,
    }, null, 2)}\n`;
    writeFileSync(gate5Path, gate5Body, "utf8");
    writeFileSync(
      `${gate5Path}.sha256`,
      `sha256:${createHash("sha256").update(gate5Body).digest("hex")}`,
      "ascii",
    );

    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--formal",
      "--compact",
      "--gate5-report",
      gate5Path,
      "--report",
      reportPath,
      "--output-report-root",
      outputRoot,
      "--release-report-root",
      releaseReportRoot,
    ], {
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
    assert.equal(report.checks.find((check) => check.id === "gate5_visible_integration_fresh")?.ok, true);
    assert.equal(report.checks.find((check) => check.id === "gate5_visible_integration_current_release")?.ok, true);
    assert.equal(report.checks.every((check) => check.ok === true), true);

    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(readFileSync(`${reportPath}.sha256`, "ascii").trim(), `sha256:${expectedHash}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
