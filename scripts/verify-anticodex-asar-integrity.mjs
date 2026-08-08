#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ASAR_PREFIX_SIZE = 16;
export const EXPECTED_INTEGRITY_ALGORITHM = "SHA256";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function alignedAsarDataOffset(headerStringSize) {
  const prefixSize = ASAR_PREFIX_SIZE;
  return prefixSize + headerStringSize + ((4 - ((prefixSize + headerStringSize) % 4)) % 4);
}

export function readAsarHeader(fd) {
  const sizeBuf = Buffer.alloc(ASAR_PREFIX_SIZE);
  readSync(fd, sizeBuf, 0, ASAR_PREFIX_SIZE, 0);
  const headerStringSize = sizeBuf.readUInt32LE(12);
  const headerBuf = Buffer.alloc(headerStringSize);
  readSync(fd, headerBuf, 0, headerStringSize, ASAR_PREFIX_SIZE);
  return {
    header: JSON.parse(headerBuf.toString("utf8")),
    headerStringSize,
    dataOffset: alignedAsarDataOffset(headerStringSize),
    headerSha256: sha256(headerBuf),
  };
}

function* walkFiles(node, prefix = "") {
  for (const [name, child] of Object.entries(node?.files ?? {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child?.files) {
      yield* walkFiles(child, rel);
    } else if (!child?.unpacked) {
      yield [rel, child];
    }
  }
}

export function readEntryPayload(fd, dataOffset, entry) {
  const size = Number(entry?.size);
  const rawOffset = Number(entry?.offset);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`invalid entry size ${entry?.size}`);
  }
  if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) {
    throw new RangeError(`invalid entry offset ${entry?.offset}`);
  }
  const offset = dataOffset + rawOffset;
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const bytesRead = readSync(fd, buffer, read, size - read, offset + read);
    if (bytesRead <= 0) {
      throw new RangeError(
        `unexpected end of file reading entry offset ${rawOffset} size ${size}: got ${read} of ${size} bytes`,
      );
    }
    read += bytesRead;
  }
  return buffer;
}

export function expectedBlockCount(payloadSize, blockSize) {
  const size = Number(blockSize);
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  return Math.max(1, Math.ceil(payloadSize / size));
}

export function verifyEntryIntegrity(fd, dataOffset, rel, entry) {
  const integrity = entry?.integrity;
  if (!integrity) {
    return { ok: true, path: rel, reason: "no-integrity-metadata" };
  }
  const size = Number(entry?.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    return { ok: false, path: rel, reason: "invalid-entry-size", size: entry?.size };
  }
  const offset = Number(entry?.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return { ok: false, path: rel, reason: "invalid-entry-offset", offset: entry?.offset };
  }
  const algorithm = integrity.algorithm
    ? String(integrity.algorithm)
    : EXPECTED_INTEGRITY_ALGORITHM;
  if (algorithm !== EXPECTED_INTEGRITY_ALGORITHM) {
    return { ok: false, path: rel, reason: "unsupported-algorithm", algorithm };
  }
  const blockSize = Number(integrity.blockSize);
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    return { ok: false, path: rel, reason: "invalid-block-size", blockSize: integrity.blockSize };
  }
  let payload;
  try {
    payload = readEntryPayload(fd, dataOffset, { ...entry, size, offset });
  } catch (error) {
    return {
      ok: false,
      path: rel,
      reason: "entry-read-error",
      message: error?.message || String(error),
    };
  }
  const blocks = Array.isArray(integrity.blocks) ? integrity.blocks : [];
  const actualHash = sha256(payload);
  if (actualHash !== String(integrity.hash ?? "")) {
    return {
      ok: false,
      path: rel,
      reason: "whole-file-hash-mismatch",
      expected: integrity.hash,
      actual: actualHash,
    };
  }
  const expected = expectedBlockCount(payload.length, blockSize);
  if (blocks.length !== expected) {
    return {
      ok: false,
      path: rel,
      reason: "block-count-mismatch",
      expectedBlocks: expected,
      actualBlocks: blocks.length,
    };
  }
  for (let index = 0; index < expected; index += 1) {
    const start = index * blockSize;
    const end = Math.min(start + blockSize, payload.length);
    const actualBlock = sha256(payload.subarray(start, end));
    if (actualBlock !== String(blocks[index])) {
      return {
        ok: false,
        path: rel,
        reason: "block-hash-mismatch",
        index,
        expected: blocks[index],
        actual: actualBlock,
      };
    }
  }
  return { ok: true, path: rel, checked: true };
}

export function verifyAsarFile(asarPath) {
  const fd = openSync(asarPath, "r");
  try {
    const { header, dataOffset } = readAsarHeader(fd);
    const failures = [];
    let checked = 0;
    for (const [rel, entry] of walkFiles(header)) {
      if (!entry?.integrity) continue;
      checked += 1;
      const result = verifyEntryIntegrity(fd, dataOffset, rel, entry);
      if (!result.ok) failures.push(result);
    }
    if (checked === 0) {
      failures.push({ ok: false, path: null, reason: "no-integrity-entries" });
    }
    return { ok: failures.length === 0, checked, failures };
  } finally {
    closeSync(fd);
  }
}

function failureDetail(failure) {
  switch (failure.reason) {
    case "whole-file-hash-mismatch":
      return `expected ${failure.expected} but found ${failure.actual}`;
    case "block-count-mismatch":
      return `expected ${failure.expectedBlocks} blocks but found ${failure.actualBlocks}`;
    case "block-hash-mismatch":
      return `block ${failure.index} expected ${failure.expected} but found ${failure.actual}`;
    case "unsupported-algorithm":
      return `algorithm ${failure.algorithm}`;
    case "invalid-block-size":
      return `blockSize ${failure.blockSize}`;
    case "invalid-entry-size":
      return `size ${failure.size}`;
    case "invalid-entry-offset":
      return `offset ${failure.offset}`;
    case "entry-read-error":
      return failure.message;
    case "no-integrity-entries":
      return "no integrity-tagged packed entries";
    default:
      return failure.reason;
  }
}

function main() {
  const asarPath = process.argv[2];
  if (!asarPath) {
    console.error("Usage: node verify-anticodex-asar-integrity.mjs <app.asar>");
    process.exit(2);
  }
  let report;
  try {
    report = verifyAsarFile(resolve(asarPath));
  } catch (error) {
    console.error(
      `Anti-Codex ASAR integrity validation could not read ${asarPath}: ${error?.message || error}`,
    );
    process.exit(1);
  }
  if (!report.ok) {
    console.error(
      `Anti-Codex ASAR integrity validation failed: ${report.failures.length} failure(s) across ${report.checked} checked integrity entries`,
    );
    for (const failure of report.failures) {
      const where = failure.path ? `${failure.path}: ` : "";
      console.error(`  ${where}${failure.reason} (${failureDetail(failure)})`);
    }
    process.exit(1);
  }
  console.log(`Anti-Codex ASAR integrity validated: ${report.checked} integrity entries`);
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
