import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const hostScript = resolve(root, "scripts", "electron-asar-integrity-host.mjs");

const ORIGINAL_HASH = "a".repeat(64);
const PATCHED_HASH = "b".repeat(64);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "anticodex-asar-integrity-tamper-"));
  const prefix = Buffer.from("fictitious-launcher:embedded=");
  const suffix = Buffer.from(":tail");
  const source = Buffer.concat([prefix, Buffer.from(ORIGINAL_HASH, "ascii"), suffix]);
  const sourcePath = join(dir, "source.exe");
  const targetPath = join(dir, "target.exe");
  writeFileSync(sourcePath, source);
  return { dir, source, sourcePath, targetPath };
}

function runHost(args) {
  return spawnSync(process.execPath, [hostScript, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}

test("patches the embedded ASAR header hash and verifies it", () => {
  const { dir, source, sourcePath, targetPath } = fixture();
  try {
    writeFileSync(targetPath, source);
    const patch = runHost(["--patch", sourcePath, targetPath, ORIGINAL_HASH, PATCHED_HASH]);
    assert.equal(patch.status, 0, patch.stdout + patch.stderr);
    const report = JSON.parse(patch.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.mode, "patch");
    assert.equal(report.patched, true);
    assert.equal(report.originalHash, ORIGINAL_HASH);
    assert.equal(report.patchedHash, PATCHED_HASH);

    const patched = runHost(["--verify", sourcePath, targetPath, ORIGINAL_HASH, PATCHED_HASH]);
    assert.equal(patched.status, 0, patched.stdout + patched.stderr);
    assert.equal(JSON.parse(patched.stdout).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a target changed anywhere outside the ASAR header hash", () => {
  const { dir, source, sourcePath, targetPath } = fixture();
  try {
    const tampered = Buffer.from(source);
    tampered[0] ^= 0x01;
    tampered[tampered.length - 1] ^= 0x01;
    writeFileSync(targetPath, tampered);

    const patch = runHost(["--patch", sourcePath, targetPath, ORIGINAL_HASH, PATCHED_HASH]);
    assert.notEqual(patch.status, 0);
    assert.match(patch.stderr, /differs from its source outside the ASAR header hash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects using the same path as both source and target", () => {
  const { dir, source, sourcePath } = fixture();
  try {
    writeFileSync(sourcePath, source);
    const samePath = runHost(["--patch", sourcePath, sourcePath, ORIGINAL_HASH, PATCHED_HASH]);
    assert.notEqual(samePath.status, 0);
    assert.match(samePath.stderr, /Source and isolated launcher paths must differ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
