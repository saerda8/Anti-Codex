#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-conversation-hygiene.mjs [options]

Options:
  --state-root <path>       Anti-Codex state root
  --report-root <path>      Report output root
  --workspace-root <path>   Expected project root
  --max-files <n>           Max session files to inspect (default: 2000)
  --cleanup-threshold <n>   Validation session count that recommends cleanup (default: 12)
  --no-write-report         Print JSON only
  --help, -h                Show this help`);
    process.exit(0);
  }
  if (!key.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "1");
  }
}

const startedAt = Date.now();
const stateRoot = resolve(args.get("--state-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex"));
const reportRoot = resolve(args.get("--report-root") || join(stateRoot, "reports"));
const workspaceRoot = resolve(args.get("--workspace-root") || resolve(import.meta.dirname, ".."));
const codexHome = join(stateRoot, "codex-home-deepseek-app");
const sessionRoots = [join(codexHome, "sessions"), join(stateRoot, "sessions")];
const maxFiles = Math.max(1, Number(args.get("--max-files") || 2000));
const cleanupThreshold = Math.max(1, Number(args.get("--cleanup-threshold") || 12));
const noWriteReport = args.has("--no-write-report");

function writeTextAtomic(filePath, text, encoding = "utf8") {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, encoding);
  renameSync(tmp, filePath);
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const latest = join(reportRoot, "latest-conversation-hygiene.json");
  const history = join(reportRoot, `${stamp}-conversation-hygiene.json`);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  for (const file of [latest, history]) {
    writeTextAtomic(file, json);
    writeTextAtomic(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function walkFiles(root, out = []) {
  if (!existsSync(root) || out.length >= maxFiles) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (out.length >= maxFiles) break;
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function countMatches(text, regex) {
  return Array.from(text.matchAll(regex)).length;
}

const validationNeedles = [
  /UI_[A-Z0-9_]+_SMOKE_\d+/g,
  /desktop-visible-[a-z0-9-]+/gi,
  /Create a tiny Node\.js CLI project in/gi,
  /Work only in this fixture directory/gi,
  /Reply with exactly UI_/gi,
  /test-anticodex-ui-chat-smoke/gi,
  /UI_AGENTIC_STEP_FLOW_SMOKE_/g,
  /UI_AUTONOMOUS_REASONING_SMOKE_/g,
  /UI_COMPLEX_PROJECT_SMOKE_/g,
  /UI_MULTI_TURN_PROJECT_SMOKE_/g,
];

const uniqueFiles = Array.from(new Set(sessionRoots.flatMap((root) => walkFiles(root, [])))).slice(0, maxFiles);
const validationSessions = [];
const smokeMarkers = new Set();
let sessionBytes = 0;
let likelyValidationSessionCount = 0;
let smokeMarkerCount = 0;
let userVisiblePromptLikeCount = 0;

for (const file of uniqueFiles) {
  let size = 0;
  let text = "";
  try {
    const stat = statSync(file);
    size = stat.size;
    sessionBytes += size;
    text = readFileSync(file, "utf8");
  } catch (error) {
    validationSessions.push({
      file: basename(file),
      path: file,
      unreadable: true,
      error: error && error.message ? String(error.message) : String(error),
    });
    continue;
  }
  const markerMatches = Array.from(text.matchAll(/UI_[A-Z0-9_]+_SMOKE_\d+/g)).map((match) => match[0]);
  for (const marker of markerMatches) smokeMarkers.add(marker);
  const validationHitCount = validationNeedles.reduce((sum, regex) => sum + countMatches(text, regex), 0);
  const promptLike = /"role":"user"|"type":"input_text"|Create a tiny Node\.js CLI project in|Work only in this fixture directory/i.test(text);
  if (validationHitCount > 0) likelyValidationSessionCount += 1;
  if (promptLike) userVisiblePromptLikeCount += 1;
  smokeMarkerCount += markerMatches.length;
  if (validationHitCount > 0) {
    validationSessions.push({
      file: basename(file),
      path: file,
      bytes: size,
      validationHitCount,
      smokeMarkerCount: markerMatches.length,
      sampleMarkers: Array.from(new Set(markerMatches)).slice(0, 5),
    });
  }
}

const recommendCleanup = likelyValidationSessionCount >= cleanupThreshold;
const result = {
  ok: true,
  reportName: "conversation-hygiene",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  noTraffic: true,
  behaviorCovered: true,
  coverageKind: "conversation-inventory-report-only",
  stateRoot,
  codexHome,
  workspaceRoot,
  sessionRoots,
  inspectedSessionFileCount: uniqueFiles.length,
  sessionBytes,
  likelyValidationSessionCount,
  userVisiblePromptLikeCount,
  smokeMarkerCount,
  uniqueSmokeMarkerCount: smokeMarkers.size,
  uniqueSmokeMarkers: Array.from(smokeMarkers).slice(0, 40),
  cleanupThreshold,
  recommendCleanup,
  cleanupCommandPreview: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\clear-anticodex-conversations.ps1 -WhatIfOnly",
  nextSafeCleanupStep: recommendCleanup ? "run_cleanup_whatif_then_operator_approved_cleanup" : "no_cleanup_needed",
  destructiveActionTaken: false,
  stoppedProcessCount: 0,
  movedPathCount: 0,
  nativeCodexTouched: false,
  preservesProjectRoot: true,
  safetyCaveat: "This report only scans isolated Anti-Codex session files and writes a signed report. It does not stop processes, move files, delete chats, or touch native Codex state.",
  validationSessions: validationSessions
    .sort((a, b) => Number(b.validationHitCount || 0) - Number(a.validationHitCount || 0))
    .slice(0, 25),
  elapsedMs: Date.now() - startedAt,
};

if (!noWriteReport) result.report = writeReport(result);
console.log(JSON.stringify(result));
