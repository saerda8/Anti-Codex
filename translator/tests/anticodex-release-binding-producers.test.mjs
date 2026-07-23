import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  RELEASE_BINDING_FIELDS,
  createCurrentReleaseBinding,
  isFreshReleaseEvidence,
  releaseBindingsEqual,
} from "../../scripts/lib/anticodex-release-binding.mjs";

const root = resolve(import.meta.dirname, "..", "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeSignedJson(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  write(path, body);
  write(`${path}.sha256`, `sha256:${sha256(body)}\n`);
}

test("current release binding is derived from the signed sync report and sealed patch tree", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "anticodex-release-binding-source-"));
  const reportRoot = mkdtempSync(join(tmpdir(), "anticodex-release-binding-reports-"));
  try {
    const patchBody = "sealed patch\n";
    const patchSha256 = sha256(patchBody);
    const binarySha256 = "b".repeat(64);
    const patchCommit = "c".repeat(40);
    write(join(sourceRoot, "third_party", "codexplusplus", "patches", "0001.patch"), patchBody);
    write(
      join(sourceRoot, "third_party", "codexplusplus", "upstream.json"),
      JSON.stringify({
        version: "v-test",
        patchCommit,
        verification: { launcherReleaseBuild: `sha256:${binarySha256}` },
        patches: [{ file: "patches/0001.patch", sha256: patchSha256 }],
      }),
    );
    writeSignedJson(join(reportRoot, "latest-sync-readiness.json"), {
      ok: true,
      noTraffic: true,
      usedRealTraffic: false,
      clientSyncContract: {
        sourcePackageVersion: "26.test.1.0",
        activeSourcePackageVersion: "26.test.1.0",
        activeSourcePackageVersionFromMarker: "26.test.1.0",
      },
      sync: {
        updateStatus: {
          components: {
            sourceVersion: "v-test",
            activeVersion: "v-test",
            sourceHash: binarySha256,
            activeHash: binarySha256,
            manifestHash: binarySha256,
            expectedPatchCount: 1,
            patchCount: 1,
          },
        },
      },
    });

    const binding = createCurrentReleaseBinding({ sourceRoot, reportRoot });
    assert.equal(binding.valid, true);
    assert.equal(binding.schema, "anticodex-release-binding-v1");
    assert.equal(binding.officialShellVersion, "26.test.1.0");
    assert.equal(binding.activeShellVersion, "26.test.1.0");
    assert.equal(binding.codexPlusPlusPatchCommit, patchCommit);
    assert.equal(binding.codexPlusPlusBinarySha256, binarySha256);
    assert.equal(binding.codexPlusPlusPatchCount, 1);
    assert.match(binding.codexPlusPlusPatchTreeSha256, /^[a-f0-9]{64}$/);
    assert.match(binding.syncReadinessSha256, /^[a-f0-9]{64}$/);
    assert.equal(releaseBindingsEqual(binding, structuredClone(binding)), true);
    assert.equal(RELEASE_BINDING_FIELDS.every((field) => field in binding), true);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("release evidence freshness requires an embedded current timestamp", () => {
  const now = Date.parse("2026-07-23T04:00:00.000Z");
  assert.equal(isFreshReleaseEvidence({ generatedAtUtc: "2026-07-23T03:30:00.000Z" }, { now, maxAgeHours: 1 }), true);
  assert.equal(isFreshReleaseEvidence({ generatedAtUtc: "2026-07-23T02:30:00.000Z" }, { now, maxAgeHours: 1 }), false);
  assert.equal(isFreshReleaseEvidence({}, { now, maxAgeHours: 1 }), false);
});

test("Gate 1-4 producers embed the shared binding and sign successful formal reports", () => {
  const files = [
    "scripts/test-codexplusplus-runtime-isolation.ps1",
    "scripts/test-codexplusplus-third-party-route.ps1",
    "scripts/test-antigravity-chat-adapter-contract.mjs",
    "scripts/test-codexplusplus-antigravity-route-switch.mjs",
  ];
  for (const relativePath of files) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.match(source, /anticodex-release-binding/, relativePath);
    assert.match(source, /releaseBinding/, relativePath);
    assert.match(source, /generatedAtUtc/, relativePath);
    assert.match(source, /\.sha256/, relativePath);
  }
});

test("formal Gate 6 requires a fresh signed Gate 5 bound to the same current release", () => {
  const source = readFileSync(join(root, "scripts", "test-antigravity-chat-adapter-edge-contract.mjs"), "utf8");
  assert.match(source, /createCurrentReleaseBinding/);
  assert.match(source, /isFreshReleaseEvidence/);
  assert.match(source, /releaseBindingsEqual/);
  assert.match(source, /gate5_visible_integration_fresh/);
  assert.match(source, /gate5_visible_integration_current_release/);
  assert.match(source, /releaseBinding/);
});

test("runtime sync and install contracts require the shared release-binding helper", () => {
  const sync = readFileSync(join(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const install = readFileSync(join(root, "scripts", "install-anticodex.ps1"), "utf8");
  assert.match(sync, /scripts\\lib\\anticodex-release-binding\.mjs/);
  assert.match(install, /scripts\\lib\\anticodex-release-binding\.mjs/);
});
