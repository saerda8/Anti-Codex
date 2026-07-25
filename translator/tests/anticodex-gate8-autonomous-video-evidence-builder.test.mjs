import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createEphemeralGate8Witness,
} from "../../scripts/lib/anticodex-gate8-evidence.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const builderPath = join(root, "scripts", "build-anticodex-gate8-autonomous-video-evidence.mjs");
const reviewProducerPath = join(root, "scripts", "prepare-anticodex-gate8-host-review.mjs");
const evidenceLibraryPath = join(root, "scripts", "lib", "anticodex-gate8-evidence.mjs");
const runnerPath = join(root, "scripts", "test-anticodex-gate8-autonomous-video.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runRunner(evidence, { withSidecar = true } = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "anticodex-gate8-runner-"));
  const evidencePath = join(temporaryRoot, "evidence.json");
  const reportRoot = join(temporaryRoot, "reports");
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(evidencePath, body);
  if (withSidecar) writeFileSync(`${evidencePath}.sha256`, `sha256:${sha256(body)}\n`);
  const child = spawnSync(process.execPath, [
    runnerPath,
    "--evidence", evidencePath,
    "--report-root", reportRoot,
    "--compact",
  ], { encoding: "utf8", windowsHide: true });
  return {
    child,
    temporaryRoot,
    latest: join(reportRoot, "latest-gate8-final-long-task.json"),
  };
}

test("production builder exposes only fail-closed host review inputs and no test injection", () => {
  const source = readFileSync(builderPath, "utf8");
  assert.match(source, /--host-review-request/);
  assert.match(source, /--host-review-receipt/);
  assert.match(source, /--host-review-secret-stdin/);
  assert.match(source, /readFileSync\(0/);
  assert.doesNotMatch(source, /ANTICODEX_GATE8_HOST_REVIEW_SECRET/);
  assert.doesNotMatch(source, /--host-review-secret(?:\s|")/);
  assert.match(source, /deriveTrustedProviderReceipts\(rollout\.records\)/);
  assert.match(source, /validatePostTaskHostBoundary/);
  assert.match(source, /createEphemeralGate8Witness/);
  for (const forbidden of [
    "ANTICODEX_GATE8_TEST_MEDIA_VERIFIER",
    "--test-media-verifier-result",
    "--trusted-evaluator-report",
    "--provider-receipt",
  ]) {
    assert.equal(source.includes(forbidden), false, `production builder still exposes ${forbidden}`);
  }
});

test("production builder derives only canonical product reviews after normal native completion", () => {
  const source = readFileSync(builderPath, "utf8");
  assert.match(source, /parseGate8ProductReview/);
  assert.match(source, /acceptanceFeedbacks/);
  assert.match(source, /task_complete/);
  assert.match(source, /previousTurnId/);
});

test("production builder resolves and hashes the real ffmpeg and ffprobe executables", () => {
  const source = readFileSync(builderPath, "utf8");
  assert.match(source, /where\.exe/);
  assert.match(source, /isAbsolute\(command\)/);
  assert.match(source, /sha256\(readFileSync\(path\)\)/);
  assert.match(source, /resolveMediaTool\("ffprobe"\)/);
  assert.match(source, /resolveMediaTool\("ffmpeg"\)/);
});

test("host producer runs post-task, extracts hashed frames and clips, and never self-approves", () => {
  const source = readFileSync(reviewProducerPath, "utf8");
  assert.match(source, /task_complete/);
  assert.match(source, /mkdtempSync/);
  assert.match(source, /frame-\$\{String/);
  assert.match(source, /clipSha256: sha256\(readFileSync\(clipPath\)\)/);
  assert.match(source, /speaker:\s*"speaker-unidentified"/);
  assert.match(source, /faceTrackId:\s*"face-track-unidentified"/);
  assert.doesNotMatch(source, /index\s*%\s*2[\s\S]{0,120}(?:speaker|face-track)-(?:a|b)/);
  assert.match(source, /host-review-receipt\.UNAPPROVED\.template\.json/);
  assert.match(source, /receiptApproved: false/);
  assert.doesNotMatch(source, /receiptApproved: true/);
});

test("host finalizer uses its one-time secret only for caller integrity, never host identity", () => {
  const source = readFileSync(reviewProducerPath, "utf8");
  const evidenceSource = readFileSync(evidenceLibraryPath, "utf8");
  assert.match(source, /randomBytes\(32\)/);
  assert.match(source, /createHostReviewHmacAttestation/);
  assert.match(source, /--host-review-secret-stdin/);
  assert.match(source, /input:\s*hostSecret\.toString\("base64"\)/);
  assert.match(source, /hostSecret\.fill\(0\)/);
  assert.doesNotMatch(source, /hostSecret.*writeFileSync|secretBase64.*writeFileSync/);
  assert.match(evidenceSource, /trustKind:\s*"caller-integrity-only"/);
  assert.match(evidenceSource, /cryptographicHostIdentity:\s*false/);
  assert.match(evidenceSource, /EXTERNAL_HOST_TRUST_ANCHOR_CONFIGURED\s*=\s*false/);
  assert.match(
    evidenceSource,
    /external host trust anchor is not configured; caller self-HMAC is integrity-only/,
  );
});

test("builder fails closed before writing evidence when external host review is absent", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "anticodex-gate8-builder-closed-"));
  const outputPath = join(temporaryRoot, "evidence.json");
  try {
    const child = spawnSync(process.execPath, [
      builderPath,
      "--output", outputPath,
      "--compact",
    ], { encoding: "utf8", windowsHide: true });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr + child.stdout, /missing.*host-review-request.*host-review-receipt/i);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(`${outputPath}.sha256`), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner rejects an integrity-sidecar report with no in-process witness", () => {
  const result = runRunner({ sourceEvidence: {} });
  try {
    assert.notEqual(result.child.status, 0);
    assert.match(result.child.stderr + result.child.stdout, /integrity witness/i);
    assert.equal(existsSync(result.latest), false);
  } finally {
    rmSync(result.temporaryRoot, { recursive: true, force: true });
  }
});

test("runner rejects a tampered witness even after the same user rewrites the SHA sidecar", () => {
  const witness = createEphemeralGate8Witness({
    taskId: "019f9000-1111-7222-8333-444444444444",
    mainVideoSha256: "a".repeat(64),
  });
  witness.payload.mainVideoSha256 = "b".repeat(64);
  const result = runRunner({ sourceEvidence: { hostWitness: witness } });
  try {
    assert.notEqual(result.child.status, 0);
    assert.match(result.child.stderr + result.child.stdout, /integrity witness/i);
    assert.equal(existsSync(result.latest), false);
  } finally {
    rmSync(result.temporaryRoot, { recursive: true, force: true });
  }
});

test("Gate 8 evidence path is offline-only and introduces no privileged persistence", () => {
  const combined = [
    readFileSync(builderPath, "utf8"),
    readFileSync(reviewProducerPath, "utf8"),
    readFileSync(runnerPath, "utf8"),
  ].join("\n");
  assert.doesNotMatch(combined, /\bfetch\s*\(|WebSocket|https?:\/\//);
  assert.doesNotMatch(
    combined,
    /Start-Process\s+.*-Verb\s+RunAs|New-Service|sc\.exe\s+create|HKLM:|schtasks|Register-ScheduledTask/i,
  );
});
