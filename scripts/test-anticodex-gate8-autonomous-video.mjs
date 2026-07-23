#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGate8AutonomousVideoReport,
  verifyEphemeralGate8Witness,
} from "./lib/anticodex-gate8-evidence.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const value = process.argv[index + 1];
  if (value && !value.startsWith("--")) {
    args.set(key, value);
    index += 1;
  } else {
    args.set(key, true);
  }
}

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/test-anticodex-gate8-autonomous-video.mjs [options]

Options:
  --evidence <path>       JSON evidence from the completed native autonomous task
  --report-root <path>    Signed report directory (default: %APPDATA%\\anticodex\\reports)
  --compact               Print one compact JSON line

This verifier is offline-only. It reads existing task/media evidence and never opens
Anti-Codex, sends a prompt, switches a provider, or starts a model request.`);
  process.exit(0);
}

const evidencePath = resolve(String(args.get("--evidence") || ""));
const sourceBuilderPath = resolve(dirname(fileURLToPath(import.meta.url)), "build-anticodex-gate8-autonomous-video-evidence.mjs");
const reportRoot = resolve(String(
  args.get("--report-root")
  || join(process.env.APPDATA || ".", "anticodex", "reports"),
));
if (!args.get("--evidence") || !existsSync(evidencePath)) {
  throw new Error("Gate 8 autonomous-video evidence JSON is required");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(path, value, encoding = "utf8") {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, value, encoding);
  renameSync(temporary, path);
}

function verifyArtifactFiles(artifacts = []) {
  const failures = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const path = String(artifact?.path || "");
    if (!path || !existsSync(path)) {
      failures.push(`artifact file is missing: ${path || "<empty>"}`);
      continue;
    }
    const stats = statSync(path);
    if (!stats.isFile() || stats.size !== Number(artifact?.bytes || 0)) {
      failures.push(`artifact size does not match: ${path}`);
      continue;
    }
    const expectedSha256 = String(artifact?.sha256 || "").toLowerCase();
    const actualSha256 = sha256(readFileSync(path));
    if (actualSha256 !== expectedSha256) failures.push(`artifact hash does not match: ${path}`);
  }
  return failures;
}

function normalizedPath(value) {
  return resolve(String(value || "")).replaceAll("\\", "/").toLowerCase();
}

const evidenceBytes = readFileSync(evidencePath);
const evidenceSha256 = sha256(evidenceBytes);
const evidenceSidecarPath = `${evidencePath}.sha256`;
if (!existsSync(evidenceSidecarPath)) throw new Error("Gate 8 source evidence integrity sidecar is required");
const sidecarMatch = readFileSync(evidenceSidecarPath, "ascii").trim().match(/^(?:sha256:)?([a-f0-9]{64})$/i);
if (!sidecarMatch || sidecarMatch[1].toLowerCase() !== evidenceSha256) {
  throw new Error("Gate 8 source evidence integrity hash does not match");
}
const input = JSON.parse(evidenceBytes.toString("utf8").replace(/^\uFEFF/, ""));
const hostWitness = input?.sourceEvidence?.hostWitness || {};
if (verifyEphemeralGate8Witness(hostWitness).ok !== true) {
  throw new Error("Gate 8 in-process integrity witness is missing or invalid");
}
const builderSource = input?.sourceEvidence?.builder || {};
const currentBuilderSha256 = sha256(readFileSync(sourceBuilderPath));
if (builderSource?.schema !== "anticodex-gate8-source-builder-v1"
  || builderSource?.mode !== "offline-local-media-verifier"
  || normalizedPath(builderSource?.path) !== normalizedPath(sourceBuilderPath)
  || String(builderSource?.sha256 || "").toLowerCase() !== currentBuilderSha256) {
  throw new Error("Gate 8 source builder provenance does not match the installed offline builder");
}
const semanticReport = buildGate8AutonomousVideoReport({
  ...input,
  generatedAt: new Date().toISOString(),
});
const failures = [...new Set([
  ...semanticReport.failures,
  ...verifyArtifactFiles(semanticReport.artifacts),
])];
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const latest = join(reportRoot, "latest-gate8-final-long-task.json");
const history = join(reportRoot, `${runStamp}-gate8-autonomous-live-action-video.json`);
const report = {
  ...semanticReport,
  ok: failures.length === 0,
  gateComplete: failures.length === 0,
  failures,
  evidenceInput: {
    path: evidencePath,
    sha256: evidenceSha256,
    sidecarPath: evidenceSidecarPath,
    integritySidecarVerified: true,
    inProcessWitnessVerified: true,
    cryptographicHostIdentity: false,
    sourceBuilderMatched: true,
    sourceBuilder: {
      path: sourceBuilderPath,
      sha256: currentBuilderSha256,
      schema: builderSource.schema,
      mode: builderSource.mode,
    },
  },
  report: { latest, history },
};
const body = `${JSON.stringify(report, null, 2)}\n`;
for (const path of [latest, history]) {
  writeAtomic(path, body);
  writeAtomic(`${path}.sha256`, `sha256:${sha256(body)}\n`, "ascii");
}

console.log(args.has("--compact")
  ? JSON.stringify({
    ok: report.ok,
    reportName: report.reportName,
    taskId: report.task?.taskId || "",
    artifactCount: report.artifacts?.length || 0,
    failures: report.failures,
    report: report.report,
  })
  : JSON.stringify(report));
process.exitCode = report.ok ? 0 : 1;
