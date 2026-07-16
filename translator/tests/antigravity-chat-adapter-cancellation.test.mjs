import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..", "..");

test("chat adapter cancellation script generates valid signed no-traffic report under report-root", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cancellation-test-"));
  try {
    const scriptPath = resolve(root, "scripts", "test-antigravity-chat-adapter-cancellation.mjs");

    const { stdout } = await execFileAsync("node", [
      scriptPath,
      "--report-root", tmpDir,
      "--compact",
    ]);

    const latestPath = join(tmpDir, "latest-cancellation.json");
    assert.ok(existsSync(latestPath), "latest-cancellation.json must be written");

    const content = JSON.parse(readFileSync(latestPath, "utf8"));
    assert.equal(content.reportName, "cancellation");
    assert.equal(content.requestedRealTraffic, false);
    assert.equal(content.usedRealTraffic, false);
    assert.equal(content.mode, "antigravity");
    assert.equal(content.coverageKind, "no-traffic");
    assert.equal(content.ok, true);
    assert.equal(content.behaviorCovered, false);
    assert.equal(content.cancelStatus, "not-run");
    assert.equal(content.hasCancelled, false);
    assert.equal(content.hasCompleted, false);
    assert.equal(content.hasFailed, false);
    assert.deepEqual(content.eventNames, []);
    assert.equal(content.providerReady, false);
    assert.equal(content.checks.find((check) => check.id === "antigravity_read_only_ready")?.skipped, true);

    const sidecarPath = `${latestPath}.sha256`;
    assert.ok(existsSync(sidecarPath), "sidecar hash file must be written");

    const sidecarContent = readFileSync(sidecarPath, "ascii").trim();
    const expectedHash = createHash("sha256").update(readFileSync(latestPath)).digest("hex");
    assert.equal(sidecarContent, `sha256:${expectedHash}`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test("default no-traffic cancellation readiness cannot overwrite formal real evidence", async () => {
  const scriptPath = resolve(root, "scripts", "test-antigravity-chat-adapter-cancellation.mjs");
  const auditRoot = resolve(root, "docs", "audits");
  const formalPath = join(auditRoot, "2026-07-15-gate6-adapter-cancellation.json");
  const formalSidecarPath = `${formalPath}.sha256`;
  const readinessPath = join(auditRoot, "2026-07-15-gate6-adapter-cancellation-readiness.json");
  const readinessSidecarPath = `${readinessPath}.sha256`;
  const formalBefore = readFileSync(formalPath);
  const formalSidecarBefore = readFileSync(formalSidecarPath);

  rmSync(readinessPath, { force: true });
  rmSync(readinessSidecarPath, { force: true });
  try {
    await execFileAsync("node", [scriptPath, "--compact"], { timeout: 30_000 });

    assert.deepEqual(readFileSync(formalPath), formalBefore, "no-traffic mode must not rewrite the formal real report");
    assert.deepEqual(readFileSync(formalSidecarPath), formalSidecarBefore, "no-traffic mode must not rewrite the formal report sidecar");
    assert.equal(existsSync(readinessPath), true, "no-traffic mode must write a separate readiness report");
    const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
    assert.equal(readiness.requestedRealTraffic, false);
    assert.equal(readiness.usedRealTraffic, false);
    assert.equal(readiness.behaviorCovered, false);
  } finally {
    writeFileSync(formalPath, formalBefore);
    writeFileSync(formalSidecarPath, formalSidecarBefore);
    rmSync(readinessPath, { force: true });
    rmSync(readinessSidecarPath, { force: true });
  }
});
