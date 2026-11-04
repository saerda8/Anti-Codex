#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode, sourceArg, targetArg, originalHashArg, patchedHashArg, brandOption] = process.argv.slice(2);
if (!["--patch", "--verify"].includes(mode) || !sourceArg || !targetArg || (brandOption && brandOption !== "--brand")) {
  console.error("Usage: node electron-asar-integrity-host.mjs <--patch|--verify> <source.exe> <target.exe> <original-hash> <patched-hash> [--brand]");
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

const legacyExpected = expected;
let branded = false;
if (brandOption === "--brand" || (mode === "--verify" && !target.equals(legacyExpected))) {
  expected = brandExecutable(legacyExpected, targetPath);
  branded = true;
}
if (mode === "--patch") {
  if (!target.equals(source) && !target.equals(legacyExpected) && !target.equals(expected)) {
    throw new Error("Isolated launcher differs from its source outside the ASAR header hash or approved identity resources");
  }
  if (!target.equals(expected)) replaceAtomically(targetPath, expected);
}

const verified = readFileSync(targetPath);
if (!verified.equals(expected)) {
  const message = "Isolated launcher differs outside the approved ASAR and identity patches";
  if (mode === "--verify") {
    console.log(JSON.stringify({ ok: false, mode: "verify", error: message }));
    process.exit(1);
  }
  throw new Error(message);
}

console.log(JSON.stringify({
  ok: true,
  mode: mode.slice(2),
  patched,
  branded,
  offset: patched ? offset : null,
  bytes: verified.length,
  originalHash,
  patchedHash,
}));

function brandExecutable(bytes, target) {
  if (process.platform !== "win32") throw new Error("Executable identity patch requires Windows");
  const script = fileURLToPath(new URL("./patch-exe-identity.ps1", import.meta.url));
  const icon = join(dirname(target), "resources", "icon.ico");
  if (!existsSync(script) || !existsSync(icon)) throw new Error("Identity patcher or isolated icon is missing");
  const directory = mkdtempSync(join(tmpdir(), "anticodex-identity-"));
  try {
    const fixture = join(directory, "expected.exe");
    writeFileSync(fixture, bytes);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-ExePath", fixture, "-IconPath", icon], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (result.status !== 0) throw new Error(`Executable identity patch failed: ${result.stderr || result.error?.message || result.stdout}`);
    return readFileSync(fixture);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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
