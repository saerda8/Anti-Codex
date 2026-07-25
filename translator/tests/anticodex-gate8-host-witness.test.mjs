import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";

import * as gate8 from "../../scripts/lib/anticodex-gate8-evidence.mjs";

const builderPath = resolve("scripts/build-anticodex-gate8-autonomous-video-evidence.mjs");

function required(name) {
  assert.equal(typeof gate8[name], "function", `${name} must be exported`);
  return gate8[name];
}

function turn(turnId, model) {
  return {
    type: "turn_context",
    timestamp: "2026-07-23T01:00:00.000Z",
    payload: {
      turn_id: turnId,
      cwd: "G:\\deliverable",
      model,
    },
  };
}

function complete(turnId, timestamp = "2026-07-23T01:01:00.000Z") {
  return {
    type: "event_msg",
    timestamp,
    payload: { type: "task_complete", turn_id: turnId },
  };
}

function providerError(turnId, provider, statusCode, errorCode) {
  return {
    type: "event_msg",
    timestamp: "2026-07-23T01:00:30.000Z",
    payload: {
      type: "provider_error",
      turn_id: turnId,
      provider,
      status_code: statusCode,
      error_code: errorCode,
    },
  };
}

test("production Gate 8 CLI has no fake-media or external self-signed evaluator/provider bypass", () => {
  const source = readFileSync(builderPath, "utf8");
  for (const forbidden of [
    "ANTICODEX_GATE8_TEST_MEDIA_VERIFIER",
    "--test-media-verifier-result",
    "--trusted-evaluator-report",
    "--provider-receipt",
  ]) {
    assert.equal(source.includes(forbidden), false, `production CLI still exposes ${forbidden}`);
  }
  assert.match(source, /--host-review-request/);
  assert.match(source, /--host-review-receipt/);
  assert.match(source, /trustKind[\s\S]*host-human-review/);
});

test("SRT evidence is ordered, non-overlapping, bounded, Chinese per cue, and union-covered", () => {
  const parseTrustedSrtCues = required("parseTrustedSrtCues");
  const valid = [
    "1",
    "00:00:00,000 --> 00:00:05,000",
    "你好",
    "",
    "2",
    "00:00:04,000 --> 00:00:10,000",
    "世界",
  ].join("\n");
  assert.throws(() => parseTrustedSrtCues(valid, 12), /overlap/i);

  const ordered = [
    "1",
    "00:00:00,000 --> 00:00:05,000",
    "你好",
    "",
    "2",
    "00:00:05,000 --> 00:00:10,000",
    "世界",
  ].join("\n");
  const parsed = parseTrustedSrtCues(ordered, 12);
  assert.equal(parsed.coveredSeconds, 10);
  assert.equal(parsed.durationCoverageRatio, 10 / 12);

  assert.throws(
    () => parseTrustedSrtCues(ordered.replace("世界", "hello"), 12),
    /Chinese.*cue/i,
  );
  assert.throws(
    () => parseTrustedSrtCues(ordered.replace("00:00:10,000", "00:00:13,000"), 12),
    /duration/i,
  );
  assert.throws(
    () => parseTrustedSrtCues(ordered.replace("00:00:05,000 --> 00:00:10,000", "00:00:04,000 --> 00:00:06,000"), 12),
    /ordered|overlap/i,
  );
});

test("lip-sync windows allow one honest speaker/face identity while preserving every hard window gate", () => {
  const validateTrustedLipSyncWindows = required("validateTrustedLipSyncWindows");
  const windows = Array.from({ length: 5 }, (_, index) => ({
    id: `w${index + 1}`,
    startSeconds: index * 2,
    endSeconds: index * 2 + 1.5,
    speaker: "speaker-unidentified",
    faceTrackId: "face-track-unidentified",
    offsetMs: 100,
    mouthMotionScore: 0.8,
    avSyncScore: 0.9,
  }));
  assert.equal(validateTrustedLipSyncWindows(windows, 12).length, 5);
  assert.throws(
    () => validateTrustedLipSyncWindows(windows.slice(0, 4), 12),
    /at least five/i,
  );
  assert.throws(
    () => validateTrustedLipSyncWindows(windows.map((entry, index) => (
      index === 1 ? { ...entry, startSeconds: 1 } : entry
    )), 12),
    /overlap/i,
  );
  assert.throws(
    () => validateTrustedLipSyncWindows(windows.map((entry, index) => (
      index === 0 ? { ...entry, endSeconds: 13 } : entry
    )), 12),
    /duration/i,
  );
  assert.throws(
    () => validateTrustedLipSyncWindows(windows.map((entry, index) => (
      index === 0 ? { ...entry, speaker: "" } : entry
    )), 12),
    /speaker/i,
  );
  assert.throws(
    () => validateTrustedLipSyncWindows(windows.map((entry, index) => (
      index === 0 ? { ...entry, faceTrackId: "" } : entry
    )), 12),
    /face track/i,
  );
  assert.throws(
    () => validateTrustedLipSyncWindows(windows.map((entry, index) => (
      index === 0 ? { ...entry, avSyncScore: 1.01 } : entry
    )), 12),
    /score/i,
  );
  assert.throws(
    () => validateTrustedLipSyncWindows(windows.map((entry, index) => (
      index === 0 ? { ...entry, mouthMotionScore: 0.49 } : entry
    )), 12),
    /threshold/i,
  );
});

test("provider receipts come only from structured rollout failures and support trusted recovery", () => {
  const deriveTrustedProviderReceipts = required("deriveTrustedProviderReceipts");
  const geminiTurn = "019f9000-1111-7111-8111-111111111111";
  const claudeTurn = "019f9000-2222-7222-8222-222222222222";
  const thirdPartyTurn = "019f9000-3333-7333-8333-333333333333";
  const recoveredTurn = "019f9000-4444-7444-8444-444444444444";
  const records = [
    turn(geminiTurn, "gemini-3.1-pro-low"),
    providerError(geminiTurn, "gemini", 429, "quota_exhausted"),
    turn(claudeTurn, "claude-sonnet-4-6"),
    providerError(claudeTurn, "claude", 503, "service_unavailable"),
    turn(thirdPartyTurn, "anticodex/third-party/gpt-5.6-sol"),
    complete(thirdPartyTurn),
    turn(recoveredTurn, "gemini-3.1-pro-low"),
    complete(recoveredTurn, "2026-07-23T01:02:00.000Z"),
  ];
  const result = deriveTrustedProviderReceipts(records);
  assert.deepEqual(result.receipts.map((entry) => entry.provider), [
    "gemini",
    "claude",
    "third-party",
    "gemini",
  ]);
  assert.deepEqual(result.fallbacks.map((entry) => [entry.from, entry.to]), [
    ["gemini", "claude"],
    ["claude", "third-party"],
  ]);
  assert.deepEqual(result.recoveries.map((entry) => [entry.from, entry.to]), [
    ["third-party", "gemini"],
  ]);

  const fake = [
    turn(geminiTurn, "gemini-3.1-pro-low"),
    {
      type: "event_msg",
      timestamp: "2026-07-23T01:00:30.000Z",
      payload: { type: "agent_message", turn_id: geminiTurn, message: "HTTP 429 quota exhausted" },
    },
    turn(claudeTurn, "claude-sonnet-4-6"),
    complete(claudeTurn),
  ];
  assert.throws(() => deriveTrustedProviderReceipts(fake), /structured.*provider/i);
});

test("a Gemini retry after recovery may fail structurally and then downgrade normally", () => {
  const deriveTrustedProviderReceipts = required("deriveTrustedProviderReceipts");
  const geminiTurn = "019f9001-1111-7111-8111-111111111111";
  const claudeTurn = "019f9001-2222-7222-8222-222222222222";
  const thirdPartyTurn = "019f9001-3333-7333-8333-333333333333";
  const retriedGeminiTurn = "019f9001-4444-7444-8444-444444444444";
  const resumedClaudeTurn = "019f9001-5555-7555-8555-555555555555";
  const result = deriveTrustedProviderReceipts([
    turn(geminiTurn, "gemini-3.1-pro-low"),
    providerError(geminiTurn, "gemini", 429, "quota_exhausted"),
    turn(claudeTurn, "claude-sonnet-4-6"),
    providerError(claudeTurn, "claude", 503, "service_unavailable"),
    turn(thirdPartyTurn, "anticodex/third-party/gpt-5.6-sol"),
    complete(thirdPartyTurn),
    turn(retriedGeminiTurn, "gemini-3.1-pro-low"),
    providerError(retriedGeminiTurn, "gemini", 503, "service_unavailable"),
    turn(resumedClaudeTurn, "claude-sonnet-4-6"),
    complete(resumedClaudeTurn, "2026-07-23T01:03:00.000Z"),
  ]);

  assert.deepEqual(result.recoveries.map((entry) => [
    entry.from,
    entry.to,
    entry.credentialKind,
  ]), [["third-party", "gemini", "structured-provider-retry"]]);
  assert.deepEqual(result.fallbacks.map((entry) => [entry.from, entry.to]), [
    ["gemini", "claude"],
    ["claude", "third-party"],
    ["gemini", "claude"],
  ]);
});

test("post-task host boundary rejects active turns, background residue, and task-visible review paths", () => {
  const validatePostTaskHostBoundary = required("validatePostTaskHostBoundary");
  const taskId = "019f9000-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const turnId = "019f9000-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const taskCwd = "G:\\deliverable";
  const reviewPath = "C:\\Users\\XD\\AppData\\Local\\Temp\\gate8-host-a1b2\\review.json";
  const records = [
    { type: "session_meta", timestamp: "2026-07-23T01:00:00.000Z", payload: { id: taskId, cwd: taskCwd } },
    turn(turnId, "gemini-3.1-pro-low"),
    complete(turnId),
  ];
  const status = {
    schema: "anticodex-fixed-route-status-v1",
    state: "ready",
    processes: { copiedClient: [100], managerService: 200, codexPlusPlus: 300 },
  };
  const clean = validatePostTaskHostBoundary({
    records,
    taskId,
    taskCwd,
    reviewPaths: [reviewPath],
    reviewGeneratedAtUtc: "2026-07-23T01:02:00.000Z",
    status,
    processRows: [
      { processId: 100, parentProcessId: 0, name: "Anti-Codex.exe", executablePath: "C:\\Anti-Codex.exe" },
      { processId: 200, parentProcessId: 0, name: "node.exe", executablePath: "C:\\node.exe" },
      { processId: 300, parentProcessId: 200, name: "codex-plus-plus.exe", executablePath: "C:\\codex-plus-plus.exe" },
    ],
  });
  assert.equal(clean.taskTerminal, true);
  assert.equal(clean.residueProcessCount, 0);

  assert.throws(() => validatePostTaskHostBoundary({
    records: records.slice(0, -1),
    taskId,
    taskCwd,
    reviewPaths: [reviewPath],
    reviewGeneratedAtUtc: "2026-07-23T01:02:00.000Z",
    status,
    processRows: [],
  }), /terminal/i);
  assert.throws(() => validatePostTaskHostBoundary({
    records,
    taskId,
    taskCwd,
    reviewPaths: [reviewPath],
    reviewGeneratedAtUtc: "2026-07-23T01:02:00.000Z",
    status,
    processRows: [
      { processId: 100, parentProcessId: 0, name: "Anti-Codex.exe", executablePath: "C:\\Anti-Codex.exe" },
      { processId: 999, parentProcessId: 100, name: "ffmpeg.exe", executablePath: "C:\\ffmpeg.exe" },
    ],
  }), /residue/i);
  assert.throws(() => validatePostTaskHostBoundary({
    records: [
      ...records,
      {
        type: "response_item",
        timestamp: "2026-07-23T01:00:30.000Z",
        payload: { type: "function_call", arguments: JSON.stringify({ path: reviewPath }) },
      },
    ],
    taskId,
    taskCwd,
    reviewPaths: [reviewPath],
    reviewGeneratedAtUtc: "2026-07-23T01:02:00.000Z",
    status,
    processRows: [],
  }), /review path.*rollout/i);

  assert.throws(() => validatePostTaskHostBoundary({
    records,
    taskId,
    taskCwd,
    reviewPaths: [reviewPath],
    reviewGeneratedAtUtc: "2026-07-23T01:02:00.000Z",
    status,
    processRows: [
      {
        processId: 100,
        parentProcessId: 0,
        name: "Anti-Codex.exe",
        executablePath: "C:\\Anti-Codex.exe",
        creationTimeUtc: "2026-07-23T00:55:00.000Z",
      },
      {
        processId: 200,
        parentProcessId: 0,
        name: "node.exe",
        executablePath: "C:\\node.exe",
        creationTimeUtc: "2026-07-23T00:55:00.000Z",
      },
      {
        processId: 300,
        parentProcessId: 200,
        name: "codex-plus-plus.exe",
        executablePath: "C:\\codex-plus-plus.exe",
        creationTimeUtc: "2026-07-23T00:55:00.000Z",
      },
      {
        processId: 999,
        parentProcessId: 555,
        name: "node.exe",
        executablePath: "C:\\node.exe",
        commandLine: "node.exe watcher.mjs",
        creationTimeUtc: "2026-07-23T01:00:30.000Z",
      },
    ],
  }), /orphan|residue/i);
});

test("host review receipt is post-terminal and integrity-bound but cannot claim external host identity", () => {
  const validateHostHumanReviewReceipt = required("validateHostHumanReviewReceipt");
  const createHostReviewHmacAttestation = required("createHostReviewHmacAttestation");
  const verifyHostReviewHmacAttestation = required("verifyHostReviewHmacAttestation");
  const hostSecret = Buffer.alloc(32, 0x3a);
  const rolloutSha256 = "e".repeat(64);
  const requestPath = "C:\\host\\request.json";
  const receiptPath = "C:\\host\\receipt.json";
  const request = {
    schema: "anticodex-gate8-host-review-request-v1",
    generatedAtUtc: "2026-07-23T01:01:30.000Z",
    challenge: "a".repeat(64),
    taskId: "019f9000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    turnId: "019f9000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
    taskCompletedAtUtc: "2026-07-23T01:01:00.000Z",
    mainVideoSha256: "b".repeat(64),
    samples: Array.from({ length: 6 }, (_, index) => ({
      path: `C:\\host\\frame-${index + 1}.png`,
      sha256: String(index + 1).repeat(64),
      timestampSeconds: index + 1,
    })),
    windows: Array.from({ length: 5 }, (_, index) => ({
      id: `w${index + 1}`,
      startSeconds: index * 2,
      endSeconds: index * 2 + 1.5,
      speaker: index % 2 ? "guest" : "host",
      faceTrackId: index % 2 ? "face-b" : "face-a",
      clipPath: `C:\\host\\window-${index + 1}.mp4`,
      clipSha256: String(index + 1).repeat(64),
    })),
  };
  const receipt = {
    schema: "anticodex-gate8-host-human-review-v1",
    trustKind: "host-human-review",
    generatedAtUtc: "2026-07-23T01:02:00.000Z",
    challenge: request.challenge,
    requestSha256: "d".repeat(64),
    mainVideoSha256: request.mainVideoSha256,
    liveAction: true,
    continuousHumanFootage: true,
    visibleSpeaking: true,
    observedSpeakingSeconds: 12,
    dialoguePresent: true,
    musicPresent: true,
    subtitleLanguage: "zh-CN",
    subtitleBurnedIn: true,
    lipSyncWindows: request.windows.map((window) => ({
      ...window,
      offsetMs: 100,
      mouthMotionScore: 0.8,
      avSyncScore: 0.9,
    })),
  };
  receipt.hostAttestation = createHostReviewHmacAttestation({
    secret: hostSecret,
    request,
    requestSha256: receipt.requestSha256,
    receipt,
    rolloutSha256,
    requestPath,
    receiptPath,
  });
  const integrity = verifyHostReviewHmacAttestation({
    secret: hostSecret,
    request,
    requestSha256: receipt.requestSha256,
    receipt,
    rolloutSha256,
    requestPath,
    receiptPath,
  });
  assert.equal(integrity.callerSecretMatched, true);
  assert.equal(integrity.externalTrustAnchorVerified, false);
  assert.equal(integrity.hostAttestation.algorithm, "HMAC-SHA256");
  assert.equal(integrity.hostAttestation.trustKind, "caller-integrity-only");
  assert.equal(integrity.hostAttestation.cryptographicHostIdentity, false);
  assert.equal("secret" in integrity.hostAttestation, false);
  assert.equal("publicKey" in integrity.hostAttestation, false);

  assert.throws(() => validateHostHumanReviewReceipt({
    request,
    requestSha256: receipt.requestSha256,
    receipt,
    rolloutSha256,
    hostSecret,
    taskCwd: "G:\\deliverable",
    requestPath,
    receiptPath,
  }), /external host trust anchor.*integrity-only/i);

  assert.throws(() => validateHostHumanReviewReceipt({
    request,
    requestSha256: receipt.requestSha256,
    receipt: { ...receipt, generatedAtUtc: request.taskCompletedAtUtc },
    rolloutSha256,
    hostSecret,
    taskCwd: "G:\\deliverable",
    requestPath,
    receiptPath,
  }), /after.*task complete/i);
  assert.throws(() => validateHostHumanReviewReceipt({
    request,
    requestSha256: receipt.requestSha256,
    receipt,
    rolloutSha256,
    hostSecret,
    taskCwd: "G:\\deliverable",
    requestPath: "G:\\deliverable\\request.json",
    receiptPath,
  }), /outside.*task/i);
});

test("host review HMAC rejects missing external secrets, self-keys, and forged conclusions", () => {
  const createHostReviewHmacAttestation = required("createHostReviewHmacAttestation");
  const validateHostHumanReviewReceipt = required("validateHostHumanReviewReceipt");
  const secret = Buffer.alloc(32, 0x51);
  const attackerSecret = Buffer.alloc(32, 0x71);
  const rolloutSha256 = "e".repeat(64);
  const requestPath = "C:\\host\\request.json";
  const receiptPath = "C:\\host\\receipt.json";
  const request = {
    schema: "anticodex-gate8-host-review-request-v1",
    generatedAtUtc: "2026-07-23T01:01:30.000Z",
    taskId: "019f9000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    turnId: "019f9000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
    taskCompletedAtUtc: "2026-07-23T01:01:00.000Z",
    mainVideoSha256: "b".repeat(64),
    samples: Array.from({ length: 6 }, (_, index) => ({
      path: `C:\\host\\frame-${index + 1}.png`,
      sha256: String(index + 1).repeat(64),
      timestampSeconds: index + 1,
    })),
    windows: Array.from({ length: 5 }, (_, index) => ({
      id: `w${index + 1}`,
      startSeconds: index * 2,
      endSeconds: index * 2 + 1.5,
      speaker: index % 2 ? "guest" : "host",
      faceTrackId: index % 2 ? "face-b" : "face-a",
      clipPath: `C:\\host\\window-${index + 1}.mp4`,
      clipSha256: String(index + 1).repeat(64),
    })),
  };
  const receipt = {
    schema: "anticodex-gate8-host-human-review-v1",
    trustKind: "host-human-review",
    generatedAtUtc: "2026-07-23T01:02:00.000Z",
    requestSha256: "d".repeat(64),
    mainVideoSha256: request.mainVideoSha256,
    liveAction: true,
    continuousHumanFootage: true,
    visibleSpeaking: true,
    observedSpeakingSeconds: 12,
    dialoguePresent: true,
    musicPresent: true,
    subtitleLanguage: "zh-CN",
    subtitleBurnedIn: true,
    lipSyncWindows: request.windows.map((window) => ({
      ...window,
      offsetMs: 100,
      mouthMotionScore: 0.8,
      avSyncScore: 0.9,
    })),
  };
  const sealed = {
    ...receipt,
    hostAttestation: createHostReviewHmacAttestation({
      secret,
      request,
      requestSha256: receipt.requestSha256,
      receipt,
      rolloutSha256,
      requestPath,
      receiptPath,
    }),
  };
  const validate = (candidate, hostSecret, overrides = {}) => (
    validateHostHumanReviewReceipt({
      request,
      requestSha256: receipt.requestSha256,
      receipt: candidate,
      rolloutSha256,
      hostSecret,
      taskCwd: "G:\\deliverable",
      requestPath,
      receiptPath,
      ...overrides,
    })
  );

  assert.throws(() => validate(sealed, undefined), /external.*secret/i);
  assert.throws(() => validate(sealed, attackerSecret), /HMAC|signature/i);
  assert.throws(
    () => validate({ ...sealed, observedSpeakingSeconds: 13 }, secret),
    /HMAC|signature/i,
  );
  assert.throws(
    () => validate(sealed, secret, { receiptPath: "C:\\host\\forged-receipt.json" }),
    /HMAC|signature/i,
  );
  assert.throws(
    () => validate({
      ...sealed,
      hostAttestation: {
        ...sealed.hostAttestation,
        publicKey: "attacker-controlled",
      },
    }, secret),
    /self-key|unexpected.*key/i,
  );
});

test("an orphan caller cannot turn its own random secret into external host authorization", () => {
  const createHostReviewHmacAttestation = required("createHostReviewHmacAttestation");
  const validateHostHumanReviewReceipt = required("validateHostHumanReviewReceipt");
  const attackerSecret = Buffer.alloc(32, 0x61);
  const requestPath = "C:\\host\\request.json";
  const receiptPath = "C:\\host\\receipt.json";
  const request = {
    schema: "anticodex-gate8-host-review-request-v1",
    generatedAtUtc: "2026-07-23T01:01:30.000Z",
    taskId: "019f9000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    turnId: "019f9000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
    taskCompletedAtUtc: "2026-07-23T01:01:00.000Z",
    mainVideoSha256: "b".repeat(64),
    samples: Array.from({ length: 6 }, (_, index) => ({
      path: `C:\\host\\frame-${index + 1}.png`,
      sha256: String(index + 1).repeat(64),
      timestampSeconds: index + 1,
    })),
    windows: Array.from({ length: 5 }, (_, index) => ({
      id: `w${index + 1}`,
      startSeconds: index * 2,
      endSeconds: index * 2 + 1.5,
      speaker: index % 2 ? "guest" : "host",
      faceTrackId: index % 2 ? "face-b" : "face-a",
      clipPath: `C:\\host\\window-${index + 1}.mp4`,
      clipSha256: String(index + 1).repeat(64),
    })),
  };
  const receipt = {
    schema: "anticodex-gate8-host-human-review-v1",
    trustKind: "host-human-review",
    generatedAtUtc: "2026-07-23T01:02:00.000Z",
    requestSha256: "d".repeat(64),
    mainVideoSha256: request.mainVideoSha256,
    liveAction: true,
    continuousHumanFootage: true,
    visibleSpeaking: true,
    observedSpeakingSeconds: 12,
    dialoguePresent: true,
    musicPresent: true,
    subtitleLanguage: "zh-CN",
    subtitleBurnedIn: true,
    lipSyncWindows: request.windows.map((window) => ({
      ...window,
      offsetMs: 100,
      mouthMotionScore: 0.8,
      avSyncScore: 0.9,
    })),
  };
  receipt.hostAttestation = createHostReviewHmacAttestation({
    secret: attackerSecret,
    request,
    requestSha256: receipt.requestSha256,
    receipt,
    rolloutSha256: "e".repeat(64),
    requestPath,
    receiptPath,
  });
  assert.throws(() => validateHostHumanReviewReceipt({
    request,
    requestSha256: receipt.requestSha256,
    receipt,
    rolloutSha256: "e".repeat(64),
    hostSecret: attackerSecret,
    taskCwd: "G:\\deliverable",
    requestPath,
    receiptPath,
  }), /external.*trust anchor|caller.*authorization/i);
});

test("tool identity requires resolved absolute executable paths and SHA-256", () => {
  const validateMediaToolIdentity = required("validateMediaToolIdentity");
  const valid = validateMediaToolIdentity({
    name: "ffmpeg",
    path: "C:\\tools\\ffmpeg.exe",
    sha256: "a".repeat(64),
    version: "ffmpeg version 8.1.1",
  });
  assert.equal(isAbsolute(valid.path), true);
  assert.throws(() => validateMediaToolIdentity({
    ...valid,
    path: "ffmpeg",
  }), /absolute/i);
  assert.throws(() => validateMediaToolIdentity({
    ...valid,
    sha256: "",
  }), /sha-256/i);
});

test("ephemeral witness signs the in-process chain without claiming host identity", () => {
  const createEphemeralGate8Witness = required("createEphemeralGate8Witness");
  const verifyEphemeralGate8Witness = required("verifyEphemeralGate8Witness");
  const witness = createEphemeralGate8Witness({
    taskId: "019f9000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    sourceEvidenceSha256: "a".repeat(64),
    hostReviewSha256: "b".repeat(64),
  });
  assert.equal(witness.algorithm, "Ed25519");
  assert.equal(witness.trustKind, "in-process-integrity-only");
  assert.equal(witness.cryptographicHostIdentity, false);
  assert.equal("privateKey" in witness, false);
  assert.equal(verifyEphemeralGate8Witness(witness).ok, true);
  assert.equal(verifyEphemeralGate8Witness({
    ...witness,
    payload: { ...witness.payload, sourceEvidenceSha256: "c".repeat(64) },
  }).ok, false);
});
