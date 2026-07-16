import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..", "..");

test("no-traffic adapter readiness cannot overwrite formal Gate 3 evidence", async () => {
  const reportRoot = mkdtempSync(join(tmpdir(), "antigravity-adapter-report-"));
  const formalPath = join(reportRoot, "2026-07-14-antigravity-chat-adapter-contract.json");
  const readinessPath = join(reportRoot, "2026-07-14-antigravity-chat-adapter-readiness.json");
  const formalBefore = Buffer.from("FORMAL_GATE3_SENTINEL\n", "utf8");
  try {
    writeFileSync(formalPath, formalBefore);

    const { stdout } = await execFileAsync(process.execPath, [
      resolve(root, "scripts", "test-antigravity-chat-adapter-contract.mjs"),
      "--offline-fixture",
      "--report-root", reportRoot,
      "--compact",
    ], { cwd: root, timeout: 60_000 });

    assert.deepEqual(readFileSync(formalPath), formalBefore);
    const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
    assert.equal(readiness.requestedRealTraffic, false);
    assert.equal(readiness.usedRealTraffic, false);
    assert.equal(readiness.behaviorCovered, false);
    assert.equal(readiness.formalGateEvidence, false);
    assert.equal(readiness.coverageKind, "no-traffic");
    assert.equal(readiness.realTraffic.reason, "not_requested");
    assert.equal(JSON.parse(stdout).reportPath, readinessPath);
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }
});
