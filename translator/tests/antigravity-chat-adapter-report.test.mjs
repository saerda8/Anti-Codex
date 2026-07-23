import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { createCurrentReleaseBinding } from "../../scripts/lib/anticodex-release-binding.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..", "..");

test("no-traffic adapter readiness cannot overwrite formal Gate 3 evidence", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "antigravity-adapter-report-"));
  const reportRoot = join(temporaryRoot, "output");
  const releaseReportRoot = join(temporaryRoot, "release");
  const formalPath = join(reportRoot, "2026-07-14-antigravity-chat-adapter-contract.json");
  const readinessPath = join(reportRoot, "2026-07-14-antigravity-chat-adapter-readiness.json");
  const formalBefore = Buffer.from("FORMAL_GATE3_SENTINEL\n", "utf8");
  try {
    mkdirSync(reportRoot, { recursive: true });
    writeCurrentReleaseFixture(releaseReportRoot);
    assert.equal(
      createCurrentReleaseBinding({ sourceRoot: root, reportRoot: releaseReportRoot }).valid,
      true,
    );
    writeFileSync(formalPath, formalBefore);

    const { stdout } = await execFileAsync(process.execPath, [
      resolve(root, "scripts", "test-antigravity-chat-adapter-contract.mjs"),
      "--offline-fixture",
      "--report-root", reportRoot,
      "--release-report-root", releaseReportRoot,
      "--compact",
    ], { cwd: root, timeout: 60_000 });

    assert.deepEqual(readFileSync(formalPath), formalBefore);
    const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
    assert.equal(readiness.ok, true);
    assert.equal(readiness.releaseBinding.valid, true);
    assert.equal(readiness.requestedRealTraffic, false);
    assert.equal(readiness.usedRealTraffic, false);
    assert.equal(readiness.behaviorCovered, false);
    assert.equal(readiness.formalGateEvidence, false);
    assert.equal(readiness.coverageKind, "no-traffic");
    assert.equal(readiness.realTraffic.reason, "not_requested");
    assert.equal(existsSync(`${readinessPath}.sha256`), false);
    const compact = JSON.parse(stdout);
    assert.equal(compact.ok, true);
    assert.deepEqual(compact.failedIds, []);
    assert.equal(compact.reportPath, readinessPath);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function writeCurrentReleaseFixture(reportRoot) {
  const metadata = JSON.parse(readFileSync(join(root, "third_party", "codexplusplus", "upstream.json"), "utf8"));
  const binarySha256 = String(metadata.verification.launcherReleaseBuild)
    .replace(/^sha256:/i, "")
    .toLowerCase();
  const shellVersion = "26.fixture.1.0";
  const body = `${JSON.stringify({
    ok: true,
    noTraffic: true,
    usedRealTraffic: false,
    clientSyncContract: {
      sourcePackageVersion: shellVersion,
      activeSourcePackageVersion: shellVersion,
      activeSourcePackageVersionFromMarker: shellVersion,
    },
    sync: {
      updateStatus: {
        components: {
          sourceVersion: metadata.version,
          activeVersion: metadata.version,
          sourceHash: binarySha256,
          activeHash: binarySha256,
          manifestHash: binarySha256,
          expectedPatchCount: metadata.patches.length,
          patchCount: metadata.patches.length,
        },
      },
    },
  }, null, 2)}\n`;
  mkdirSync(reportRoot, { recursive: true });
  const path = join(reportRoot, "latest-sync-readiness.json");
  writeFileSync(path, body, "utf8");
  writeFileSync(
    `${path}.sha256`,
    `sha256:${createHash("sha256").update(body).digest("hex")}\n`,
    "ascii",
  );
}
