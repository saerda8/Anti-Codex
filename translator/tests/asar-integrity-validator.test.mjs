import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildAsarIntegrity } from "../../scripts/brand-patch-compat.mjs";
import {
  alignedAsarDataOffset,
  verifyAsarFile,
} from "../../scripts/verify-anticodex-asar-integrity.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const validatorScript = resolve(root, "scripts", "verify-anticodex-asar-integrity.mjs");
const candidateGate = readFileSync(resolve(root, "scripts", "test-anticodex-host-candidate.ps1"), "utf8");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function buildAsar(files) {
  const headerFiles = {};
  const dataChunks = [];
  let offset = 0;
  for (const file of files) {
    const content = Buffer.from(file.content);
    headerFiles[file.path] = {
      size: file.size ?? content.length,
      offset: file.offset ?? offset,
      ...(file.integrity ? { integrity: file.integrity } : {}),
    };
    dataChunks.push(content);
    offset += content.length;
  }
  const headerText = JSON.stringify({ files: headerFiles });
  const headerStringSize = Buffer.byteLength(headerText, "utf8");
  const dataOffset = alignedAsarDataOffset(headerStringSize);

  const buffer = Buffer.alloc(dataOffset + offset);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(4 + headerStringSize, 4);
  buffer.writeUInt32LE(4 + headerStringSize, 8);
  buffer.writeUInt32LE(headerStringSize, 12);
  Buffer.from(headerText, "utf8").copy(buffer, 16);
  let dataPos = dataOffset;
  for (const chunk of dataChunks) {
    chunk.copy(buffer, dataPos);
    dataPos += chunk.length;
  }
  return buffer;
}

function writeAsarFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "anticodex-asar-integrity-"));
  const asarPath = join(dir, "app.asar");
  writeFileSync(asarPath, buildAsar(files));
  return { dir, asarPath };
}

function runValidator(asarPath) {
  return spawnSync(process.execPath, [validatorScript, asarPath], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}

const multiBlockPayload = Buffer.from("Anti-Codex ASAR integrity self-check");
const multiBlockIntegrity = {
  algorithm: "SHA256",
  blockSize: 8,
  ...buildAsarIntegrity(multiBlockPayload, 8),
};

test("passes a multi-block ASAR whose integrity matches its payload", () => {
  const { dir, asarPath } = writeAsarFixture([
    { path: "bundle.js", content: multiBlockPayload, integrity: multiBlockIntegrity },
  ]);
  try {
    assert.equal(multiBlockIntegrity.blocks.length, Math.ceil(multiBlockPayload.length / 8));
    assert.ok(multiBlockIntegrity.blocks.length > 1, "fixture must use multiple blocks");
    assert.equal(multiBlockIntegrity.hash, sha256(multiBlockPayload));

    const report = verifyAsarFile(asarPath);
    assert.equal(report.ok, true);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.failures, []);

    const cli = runValidator(asarPath);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /validated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when a multi-block payload is reduced to a single integrity block", () => {
  const truncated = {
    ...multiBlockIntegrity,
    blocks: [multiBlockIntegrity.blocks[0]],
  };
  const { dir, asarPath } = writeAsarFixture([
    { path: "bundle.js", content: multiBlockPayload, integrity: truncated },
  ]);
  try {
    const report = verifyAsarFile(asarPath);
    assert.equal(report.ok, false);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].reason, "block-count-mismatch");
    assert.ok(report.failures[0].expectedBlocks > report.failures[0].actualBlocks);

    const cli = runValidator(asarPath);
    assert.equal(cli.status, 1);
    assert.match(cli.stdout + cli.stderr, /block-count-mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when one per-block SHA-256 does not match the payload chunk", () => {
  const corruptedBlocks = [...multiBlockIntegrity.blocks];
  corruptedBlocks[1] = `${corruptedBlocks[1][0] === "a" ? "b" : "a"}${corruptedBlocks[1].slice(1)}`;
  const corrupted = { ...multiBlockIntegrity, blocks: corruptedBlocks };
  const { dir, asarPath } = writeAsarFixture([
    { path: "bundle.js", content: multiBlockPayload, integrity: corrupted },
  ]);
  try {
    const report = verifyAsarFile(asarPath);
    assert.equal(report.ok, false);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].reason, "block-hash-mismatch");
    assert.equal(report.failures[0].index, 1);

    const cli = runValidator(asarPath);
    assert.equal(cli.status, 1);
    assert.match(cli.stdout + cli.stderr, /block-hash-mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when the whole-file SHA-256 does not match the payload", () => {
  const corruptedHash = `${multiBlockIntegrity.hash[0] === "a" ? "b" : "a"}${multiBlockIntegrity.hash.slice(1)}`;
  const corrupted = { ...multiBlockIntegrity, hash: corruptedHash };
  const { dir, asarPath } = writeAsarFixture([
    { path: "bundle.js", content: multiBlockPayload, integrity: corrupted },
  ]);
  try {
    const report = verifyAsarFile(asarPath);
    assert.equal(report.ok, false);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].reason, "whole-file-hash-mismatch");

    const cli = runValidator(asarPath);
    assert.equal(cli.status, 1);
    assert.match(cli.stdout + cli.stderr, /whole-file-hash-mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed when no packed entry carries integrity metadata", () => {
  const { dir, asarPath } = writeAsarFixture([
    { path: "bundle.js", content: Buffer.from("plain") },
  ]);
  try {
    const report = verifyAsarFile(asarPath);
    assert.equal(report.ok, false);
    assert.equal(report.checked, 0);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].reason, "no-integrity-entries");

    const cli = runValidator(asarPath);
    assert.equal(cli.status, 1);
    assert.match(cli.stdout + cli.stderr, /no-integrity-entries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when an integrity entry is truncated beyond the end of the archive", () => {
  const truncatedPayload = Buffer.from("truncated");
  const integrity = {
    algorithm: "SHA256",
    blockSize: 8,
    ...buildAsarIntegrity(truncatedPayload, 8),
  };
  const { dir, asarPath } = writeAsarFixture([
    {
      path: "bundle.js",
      content: truncatedPayload,
      size: truncatedPayload.length + 64, // header claims more bytes than the archive holds
      integrity,
    },
  ]);
  try {
    const report = verifyAsarFile(asarPath);
    assert.equal(report.ok, false);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].reason, "entry-read-error");

    const cli = runValidator(asarPath);
    assert.equal(cli.status, 1);
    assert.match(cli.stdout + cli.stderr, /entry-read-error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes when a valid integrity entry uses canonical decimal-string size and offset", () => {
  const { dir, asarPath } = writeAsarFixture([
    {
      path: "bundle.js",
      content: multiBlockPayload,
      size: String(multiBlockPayload.length),
      offset: "0",
      integrity: multiBlockIntegrity,
    },
  ]);
  try {
    const report = verifyAsarFile(asarPath);
    assert.equal(report.ok, true);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.failures, []);

    const cli = runValidator(asarPath);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /validated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed for negative, non-integer, and unsafe entry size/offset strings", () => {
  const cases = [
    { field: "size", value: String(-1), reason: "invalid-entry-size" },
    { field: "size", value: String(multiBlockPayload.length + 0.5), reason: "invalid-entry-size" },
    { field: "size", value: String(Number.MAX_SAFE_INTEGER + 1), reason: "invalid-entry-size" },
    { field: "offset", value: String(-1), reason: "invalid-entry-offset" },
    { field: "offset", value: "0.5", reason: "invalid-entry-offset" },
    { field: "offset", value: String(Number.MAX_SAFE_INTEGER + 1), reason: "invalid-entry-offset" },
  ];
  for (const { field, value, reason } of cases) {
    const { dir, asarPath } = writeAsarFixture([
      {
        path: "bundle.js",
        content: multiBlockPayload,
        [field]: value,
        integrity: multiBlockIntegrity,
      },
    ]);
    try {
      const report = verifyAsarFile(asarPath);
      assert.equal(report.ok, false, `${field}=${value} must fail closed`);
      assert.equal(report.failures.length, 1, `${field}=${value} must produce one failure`);
      assert.equal(report.failures[0].reason, reason, `${field}=${value} failure reason`);

      const cli = runValidator(asarPath);
      assert.equal(cli.status, 1, `${field}=${value} CLI must fail`);
      assert.match(cli.stdout + cli.stderr, new RegExp(reason));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("candidate gate runs the ASAR integrity validator before starting the bundled CLI", () => {
  assert.match(candidateGate, /verify-anticodex-asar-integrity\.mjs/);
  const validatorCallIndex = candidateGate.indexOf("verify-anticodex-asar-integrity.mjs");
  const cliStartIndex = candidateGate.indexOf("$codex --version");
  assert.notEqual(validatorCallIndex, -1);
  assert.notEqual(cliStartIndex, -1);
  assert.ok(validatorCallIndex < cliStartIndex, "integrity validator must run before the bundled CLI starts");
  assert.match(candidateGate, /\$LASTEXITCODE\s+-ne\s+0/);
});
