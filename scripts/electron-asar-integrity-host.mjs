#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const [mode, sourceArg, targetArg, originalHashArg, patchedHashArg] = process.argv.slice(2);
if (!["--patch", "--verify"].includes(mode) || !sourceArg || !targetArg) {
  console.error("Usage: node electron-asar-integrity-host.mjs <--patch|--verify> <source.exe> <target.exe> <original-hash> <patched-hash>");
  process.exit(2);
}

const originalHash = normalizedHash(originalHashArg, "original hash");
const patchedHash = normalizedHash(patchedHashArg, "patched hash");
const sourcePath = resolve(sourceArg);
const targetPath = resolve(targetArg);
if (sourcePath.toLowerCase() === targetPath.toLowerCase()) {
  throw new Error("Source and isolated launcher paths must differ");
}
if (!existsSync(sourcePath) || !existsSync(targetPath)) {
  throw new Error("Source or isolated launcher executable is missing");
}

const source = readFileSync(sourcePath);
const target = readFileSync(targetPath);
if (source.length !== target.length) throw new Error("Source and isolated launcher sizes differ");

const originalBytes = Buffer.from(originalHash, "ascii");
const patchedBytes = Buffer.from(patchedHash, "ascii");
const originalOffsets = offsetsOf(source, originalBytes);
const patchedOffsets = offsetsOf(source, patchedBytes);
let expected = Buffer.from(source);
let patched = false;
let offset = -1;

if (originalHash !== patchedHash && originalOffsets.length === 1 && patchedOffsets.length === 0) {
  offset = originalOffsets[0];
  patchedBytes.copy(expected, offset);
  patched = true;
} else if (originalHash !== patchedHash && (originalOffsets.length !== 0 || patchedOffsets.length !== 0)) {
  throw new Error("Embedded Electron ASAR header hash is missing or ambiguous");
}

if (mode === "--patch") {
  if (!target.equals(source) && !target.equals(expected)) {
    throw new Error("Isolated launcher differs from its source outside the ASAR header hash");
  }
  if (!target.equals(expected)) replaceAtomically(targetPath, expected);
}

const verified = readFileSync(targetPath);
if (!verified.equals(expected)) {
  throw new Error("Isolated launcher ASAR header hash patch is invalid");
}

console.log(JSON.stringify({
  ok: true,
  mode: mode.slice(2),
  patched,
  offset: patched ? offset : null,
  bytes: verified.length,
  originalHash,
  patchedHash,
}));

function normalizedHash(value, label) {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} must be SHA-256`);
  return hash;
}

function offsetsOf(buffer, needle) {
  const offsets = [];
  for (let offset = 0; (offset = buffer.indexOf(needle, offset)) >= 0; offset += needle.length) {
    offsets.push(offset);
  }
  return offsets;
}

function replaceAtomically(target, bytes) {
  const temporary = `${target}.asar-integrity.${process.pid}.tmp`;
  const backup = `${target}.asar-integrity.${process.pid}.bak`;
  rmSync(temporary, { force: true });
  rmSync(backup, { force: true });
  writeFileSync(temporary, bytes);
  try {
    renameSync(target, backup);
    renameSync(temporary, target);
    rmSync(backup, { force: true });
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
    if (existsSync(backup) && existsSync(target)) rmSync(backup, { force: true });
  }
}
