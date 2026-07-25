import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as evidence from "../../scripts/lib/anticodex-gate8-evidence.mjs";

const sha = (digit) => String(digit).repeat(64);
const taskId = "019f9000-1111-7222-8333-444444444444";
const turnId = "019f9000-2222-7333-8444-555555555555";
const cwd = "G:\\Trae-Project\\Anti-Codex\\deliverables\\2026-07-23-anticodex-autonomous-live-action-lipsync";
const promptSha256 = sha("a");

function artifact(role, name, digit, extra = {}) {
  return {
    role,
    path: `${cwd}\\${name}`,
    bytes: 1024,
    sha256: sha(digit),
    ...extra,
  };
}

function validReport() {
  const mainVideo = artifact("main-video", "release\\main.mp4", "1", {
    durationSeconds: 52.4,
    width: 1080,
    height: 1920,
    frameRate: 25,
    videoCodec: "h264",
    decodable: true,
    liveAction: true,
    continuousHumanFootage: true,
    visibleSpeaking: true,
  });
  const releaseVideos = ["douyin.mp4", "kuaishou.mp4", "xiaohongshu.mp4"]
    .map((name, index) => artifact("release-video", `release\\${name}`, String(index + 2), {
      durationSeconds: 52.4,
      width: 1080,
      height: 1920,
      decodable: true,
    }));
  const subtitle = artifact("subtitle", "release\\captions.zh-CN.srt", "5");
  const lipSyncReport = artifact("lipsync-report", "qa\\lipsync.json", "6");
  const mediaQaReport = artifact("media-qa-report", "qa\\media.json", "7");
  const checksumManifest = artifact("checksum-manifest", "release\\SHA256SUMS.txt", "8");
  const totalGoalPrompt = artifact("total-goal-prompt", "evidence\\total-goal.md", "a");
  const nativeRollout = artifact("native-rollout", "evidence\\rollout.jsonl", "e");
  const artifacts = [
    mainVideo,
    ...releaseVideos,
    subtitle,
    lipSyncReport,
    mediaQaReport,
    checksumManifest,
    totalGoalPrompt,
    nativeRollout,
  ];
  const windows = Array.from({ length: 5 }, (_, index) => ({
    id: `W0${index + 1}`,
    startSeconds: index * 8,
    endSeconds: index * 8 + 3,
    speaker: index % 2 === 0 ? "host" : "guest",
    faceTrackId: index % 2 === 0 ? "face-a" : "face-b",
    offsetMs: 80 + index,
    mouthMotionScore: 0.75,
    avSyncScore: 0.82,
    passed: true,
  }));
  const subtitleCues = Array.from({ length: 5 }, (_, index) => ({
    index: index + 1,
    startSeconds: index * 9,
    endSeconds: index * 9 + 9,
    text: `中文对白${index + 1}`,
  }));
  const subtitleCoveredSeconds = subtitleCues.reduce(
    (sum, cue) => sum + cue.endSeconds - cue.startSeconds,
    0,
  );
  const report = {
    schema: "anticodex-gate8-autonomous-video-v1",
    reportName: "gate8-autonomous-live-action-video",
    gate: 8,
    ok: true,
    gateComplete: true,
    generatedAt: new Date().toISOString(),
    requestedRealTraffic: false,
    usedRealTraffic: false,
    sourceTaskUsedRealTraffic: true,
    coverageKind: "native-single-task-single-goal-autonomous-live-action-video",
    releaseBinding: {
      schema: "anticodex-release-binding-v1",
      valid: true,
      officialShellVersion: "26.715.10079.0",
      activeShellVersion: "26.715.10079.0",
      codexPlusPlusVersion: "v1.2.39",
      codexPlusPlusPatchCommit: "a".repeat(40),
      codexPlusPlusBinarySha256: sha("b"),
      codexPlusPlusPatchTreeSha256: sha("c"),
      codexPlusPlusPatchCount: 9,
      syncReadinessSha256: sha("d"),
    },
    task: {
      newTask: true,
      nativeTask: true,
      taskId,
      primaryTurnId: turnId,
      cwd,
      rolloutPath: nativeRollout.path,
      rolloutSha256: nativeRollout.sha256,
      sameTaskThroughout: true,
      finalState: "completed",
      prompt: {
        path: totalGoalPrompt.path,
        sha256: totalGoalPrompt.sha256,
        marker: "UI_ANTICODEX_AUTONOMOUS_LIPSYNC_20260723_FINAL",
        totalGoal: true,
        submissionCount: 1,
        hostIntermediatePromptCount: 0,
      },
      turns: [{
        turnId,
        taskId,
        cwd,
        promptSha256,
        autonomous: true,
        status: "completed",
        provider: "gemini",
        model: "gemini-3.1-pro-low",
      }],
      interruptions: [],
      continuations: [],
    },
    providerPolicy: {
      priority: ["gemini", "claude", "third-party"],
    },
    providerReceipts: [{
      receiptId: "provider-receipt-1",
      taskId,
      turnId,
      cwd,
      promptSha256,
      provider: "gemini",
      model: "gemini-3.1-pro-low",
      requestObserved: true,
      responseObserved: true,
      statusCode: 200,
      terminalKind: "native-task-complete",
      errorCode: null,
      reasonKind: null,
      terminalAtUtc: "2026-07-23T01:01:00.000Z",
      component: {
        version: "v1.2.39",
        patchCommit: "a".repeat(40),
        binarySha256: sha("b"),
      },
    }],
    autonomousExecution: {
      planCreated: true,
      planUpdateCount: 4,
      toolCallCount: 18,
      fileActionCount: 9,
      sameTask: true,
      finalMarkerSeen: true,
      finalMarker: "UI_ANTICODEX_AUTONOMOUS_LIPSYNC_20260723_FINAL",
      hostIntermediatePromptCount: 0,
      postFinalToolCallCount: 0,
    },
    deliverable: {
      artifactRoot: cwd,
      mainVideo,
      releaseVideos,
      subtitle: {
        ...subtitle,
        language: "zh-CN",
        cues: subtitleCues,
        cueCount: subtitleCues.length,
        coveredSeconds: subtitleCoveredSeconds,
        durationCoverageRatio: subtitleCoveredSeconds / mainVideo.durationSeconds,
        burnedIn: true,
      },
      audio: {
        streamPresent: true,
        dialoguePresent: true,
        musicPresent: true,
        silenceRatio: 0.02,
        integratedLufs: -16.2,
        truePeakDb: -1.4,
      },
      lipSync: {
        ...lipSyncReport,
        evaluator: "host-human-review",
        evaluatorVersion: "1",
        contractVersion: "anticodex-gate8-host-human-review-v1",
        sourceVideoSha256: mainVideo.sha256,
        passed: true,
        aggregateDenominator: windows.length,
        passCount: windows.length,
        windows,
      },
      mediaQa: {
        ...mediaQaReport,
        sourceVideoSha256: mainVideo.sha256,
        passed: true,
        decodePassed: true,
        videoStreamPresent: true,
        audioStreamPresent: true,
        subtitlePresent: true,
        durationMatches: true,
        blackFrameRatio: 0.001,
        freezeFrameRatio: 0.01,
        silenceRatio: 0.02,
      },
      package: {
        manifest: checksumManifest,
        fileCount: artifacts.filter((artifact) => (
          !["checksum-manifest", "total-goal-prompt", "native-rollout"].includes(artifact.role)
        )).length,
        checksumsVerified: true,
        hashManifestComplete: true,
        requiredRoles: [
          "main-video",
          "release-video",
          "subtitle",
          "lipsync-report",
          "media-qa-report",
          "checksum-manifest",
          "total-goal-prompt",
          "native-rollout",
        ],
      },
    },
    mediaVerification: {
      schema: "anticodex-gate8-local-media-verification-v1",
      mode: "local-ffmpeg-ffprobe",
      tools: {
        ffprobe: {
          name: "ffprobe",
          path: "C:\\tools\\ffprobe.exe",
          sha256: sha("9"),
          version: "ffprobe version 7.1",
        },
        ffmpeg: {
          name: "ffmpeg",
          path: "C:\\tools\\ffmpeg.exe",
          sha256: sha("0"),
          version: "ffmpeg version 7.1",
        },
      },
      hostReview: {
        trustKind: "host-human-review",
        cryptographicIdentityClaimed: false,
        callerSecretMatched: true,
        externalTrustAnchorVerified: false,
        hostAttestation: {
          schema: "anticodex-gate8-host-review-hmac-v1",
          algorithm: "HMAC-SHA256",
          trustKind: "caller-integrity-only",
          cryptographicHostIdentity: false,
          nonce: sha("d"),
          signatureBase64: Buffer.alloc(32, 0x4a).toString("base64"),
        },
        requestPath: "C:\\host-review\\request.json",
        requestSha256: sha("3"),
        receiptPath: "C:\\host-review\\receipt.json",
        receiptSha256: sha("4"),
        schema: "anticodex-gate8-host-human-review-v1",
        name: "host-human-review",
        version: "1",
        contractVersion: "anticodex-gate8-host-human-review-v1",
      },
    },
    postTaskWitness: {
      taskTerminal: true,
      taskCompletedAtUtc: "2026-07-23T01:01:00.000Z",
      finalTurnId: turnId,
      supervisorState: "ready",
      residueProcessCount: 0,
      reviewPathsOutsideTask: true,
    },
    sourceEvidence: {
      hostReview: {
        requestPath: "C:\\host-review\\request.json",
        requestSha256: sha("3"),
        receiptPath: "C:\\host-review\\receipt.json",
        receiptSha256: sha("4"),
        trustKind: "host-human-review",
        cryptographicHostIdentity: false,
        callerSecretMatched: true,
        externalTrustAnchorVerified: false,
        hostAttestation: {
          schema: "anticodex-gate8-host-review-hmac-v1",
          algorithm: "HMAC-SHA256",
          trustKind: "caller-integrity-only",
          cryptographicHostIdentity: false,
          nonce: sha("d"),
          signatureBase64: Buffer.alloc(32, 0x4a).toString("base64"),
        },
      },
      builder: {
        schema: "anticodex-gate8-source-builder-v1",
        path: "G:\\Trae-Project\\Anti-Codex\\deepcodex\\scripts\\build-anticodex-gate8-autonomous-video-evidence.mjs",
        sha256: sha("f"),
        mode: "offline-local-media-verifier",
      },
    },
    artifacts,
    failures: [],
  };
  report.sourceEvidence.hostWitness = evidence.createEphemeralGate8Witness({
    taskId,
    finalTurnId: turnId,
    taskCompletedAtUtc: report.postTaskWitness.taskCompletedAtUtc,
    rolloutSha256: nativeRollout.sha256,
    mainVideoSha256: mainVideo.sha256,
    hostReviewRequestSha256: report.mediaVerification.hostReview.requestSha256,
    hostReviewReceiptSha256: report.mediaVerification.hostReview.receiptSha256,
    builderSha256: report.sourceEvidence.builder.sha256,
    ffmpegPath: report.mediaVerification.tools.ffmpeg.path,
    ffmpegSha256: report.mediaVerification.tools.ffmpeg.sha256,
    ffprobePath: report.mediaVerification.tools.ffprobe.path,
    ffprobeSha256: report.mediaVerification.tools.ffprobe.sha256,
  });
  return report;
}

function validator() {
  assert.equal(
    typeof evidence.validateGate8AutonomousVideoReport,
    "function",
    "Gate 8 autonomous-video validator is missing",
  );
  return evidence.validateGate8AutonomousVideoReport;
}

test("fails closed without an external host trust anchor even when all task and media evidence is complete", () => {
  assert.match(
    validator()(validReport()).join(" "),
    /external host trust anchor.*integrity-only/i,
  );
});

test("five passed windows from one visible speaker and one face track satisfy lip-sync semantics", () => {
  const report = validReport();
  for (const window of report.deliverable.lipSync.windows) {
    window.speaker = "speaker-unidentified";
    window.faceTrackId = "face-track-unidentified";
  }
  assert.doesNotMatch(validator()(report).join(" "), /lip-sync/i);
});

test("rejects host review provenance without the integrity-only caller HMAC", () => {
  const report = validReport();
  delete report.mediaVerification.hostReview.callerSecretMatched;
  delete report.mediaVerification.hostReview.hostAttestation;
  delete report.sourceEvidence.hostReview.callerSecretMatched;
  delete report.sourceEvidence.hostReview.hostAttestation;
  assert.match(validator()(report).join(" "), /integrity-only.*HMAC|caller-HMAC/i);
});

test("rejects the retired inventory migration and greenfield code-journey evidence", () => {
  const legacy = {
    schema: "anticodex-gate8-final-long-task-v1",
    reportName: "gate8-final-long-task",
    gate: 8,
    ok: true,
    gateComplete: true,
    coverageKind: "desktop-ui-real-antigravity-gate8",
    journeys: [
      { id: "interrupted-migration-three-turn", ok: true },
      { id: "greenfield-project-three-turn", ok: true },
    ],
  };
  assert.match(validator()(legacy).join(" "), /schema|autonomous|video/i);
});

test("rejects host follow-up or micro-stage instructions after the one total-goal submission", () => {
  const report = validReport();
  report.task.prompt.hostIntermediatePromptCount = 1;
  report.task.continuations = [{
    text: "现在执行 Stage 4P 并修字幕",
    reason: "host-stage-instruction",
    taskId,
    turnId,
  }];
  report.autonomousExecution.hostIntermediatePromptCount = 1;
  assert.match(validator()(report).join(" "), /host|intermediate|continuation|single goal/i);
});

test("rejects a continue receipt that is not bound to a real turn after the proven interruption", () => {
  const report = validReport();
  report.task.interruptions = [{
    receiptId: "interruption-1",
    kind: "client-interruption",
    taskId,
    turnId,
  }];
  report.task.continuations = [{
    text: "继续",
    interruptionReceiptId: "interruption-1",
    taskId,
    turnId: "not-a-real-turn",
  }];
  assert.match(validator()(report).join(" "), /continuation|turn/i);
});

test("rejects third-party usage without explicit Gemini and Claude unavailability receipts", () => {
  const report = validReport();
  report.providerReceipts[0].provider = "third-party";
  report.providerReceipts[0].model = "gpt-5.6-sol";
  assert.match(validator()(report).join(" "), /fallback|preferred|Gemini|Claude/i);
});

test("rejects media evidence with missing numeric measurements instead of treating NaN as passing", () => {
  const report = validReport();
  delete report.deliverable.mainVideo.durationSeconds;
  delete report.deliverable.mainVideo.frameRate;
  assert.match(validator()(report).join(" "), /main video/i);
});

test("accepts extra hashed release-package files while still failing closed on the missing trust anchor", () => {
  const report = validReport();
  report.artifacts.push(artifact("poster", "release\\poster.png", "f"));
  report.deliverable.package.fileCount = report.artifacts.filter((artifact) => (
    !["checksum-manifest", "total-goal-prompt", "native-rollout"].includes(artifact.role)
  )).length;
  const failures = validator()(report);
  assert.match(failures.join(" "), /external host trust anchor.*integrity-only/i);
  assert.doesNotMatch(failures.join(" "), /release package|artifact manifest/i);
});

test("rejects incomplete task binding, media, lip-sync, subtitle, audio, hashes, and package semantics", async (t) => {
  const cases = [
    ["task/turn binding", (report) => { report.task.turns[0].promptSha256 = sha("f"); }, /task, turn|binding/i],
    ["provider/component receipt", (report) => { report.providerReceipts[0].component.version = "v0.0.0"; }, /provider receipt/i],
    ["final marker binding", (report) => { report.autonomousExecution.finalMarker = "WRONG"; }, /final marker|autonomous execution/i],
    ["live-action main video", (report) => { report.deliverable.mainVideo.liveAction = false; }, /main video/i],
    ["Chinese subtitle", (report) => { report.deliverable.subtitle.burnedIn = false; }, /subtitle/i],
    ["dialogue and music audio", (report) => { report.deliverable.audio.musicPresent = false; }, /dialogue|music|audio/i],
    ["lip-sync windows", (report) => { report.deliverable.lipSync.windows[1].startSeconds = 1; }, /lip-sync/i],
    ["QA source hash binding", (report) => { report.deliverable.mediaQa.sourceVideoSha256 = sha("f"); }, /media QA|source video|binding/i],
    ["media QA", (report) => { report.deliverable.mediaQa.blackFrameRatio = 0.5; }, /media QA/i],
    ["release package hashes", (report) => { report.deliverable.package.checksumsVerified = false; }, /release package/i],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const report = validReport();
      mutate(report);
      assert.match(validator()(report).join(" "), expected);
    });
  }
});

test("the formal release gate consumes only the autonomous-video report, never the retired code journeys", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-release-gates.mjs", import.meta.url), "utf8");
  assert.match(source, /validateGate8AutonomousVideoReport/);
  assert.match(source, /integritySidecarVerified[\s\S]*inProcessWitnessVerified[\s\S]*sourceBuilderMatched[\s\S]*sha256File\(builderPath\)/);
  assert.doesNotMatch(source, /latest-ui-human-long-journey\.json/);
  assert.doesNotMatch(source, /formal inventory|interrupted-migration|greenfield-project/i);
});

test("every release-required Gate 1-6 report is signed, fresh, and bound to the current release", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-release-gates.mjs", import.meta.url), "utf8");
  for (let gate = 1; gate <= 6; gate += 1) {
    assert.match(
      source,
      new RegExp(`id: "gate${gate}"[^\\n]*signed: true[^\\n]*freshnessRequired: true`),
      `Gate ${gate} is not signed and freshness-bound`,
    );
    assert.match(
      source,
      new RegExp(`function validateGate${gate}\\([\\s\\S]*?validateReleaseBinding\\(report\\?\\.releaseBinding, failures, "gate${gate}"\\)`),
      `Gate ${gate} is not current-release-bound`,
    );
  }
});

test("component progress cannot display 100 until Gate 5 and Gate 8 make the release ready", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-release-gates.mjs", import.meta.url), "utf8");
  assert.match(source, /shellProgress: releaseReady \? 100/);
  assert.match(source, /codexPlusPlusProgress: releaseReady \? 100/);
  assert.match(source, /antigravityAdapterProgress: releaseReady \? 100/);
  assert.doesNotMatch(source, /(?:shell|codexPlusPlus|antigravityAdapter)Progress: gate7\.satisfied \? 100/);
});

test("the Gate 8 runner is an offline signed video-evidence verifier with no model or UI traffic", async () => {
  const runnerUrl = new URL("../../scripts/test-anticodex-gate8-autonomous-video.mjs", import.meta.url);
  assert.equal(existsSync(runnerUrl), true, "offline autonomous-video Gate 8 runner is missing");
  const source = await readFile(runnerUrl, "utf8");
  assert.match(source, /buildGate8AutonomousVideoReport/);
  assert.match(source, /latest-gate8-final-long-task\.json/);
  assert.match(source, /\.sha256/);
  assert.match(source, /integrity sidecar is required/);
  assert.match(source, /in-process integrity witness is missing or invalid/);
  assert.match(source, /source builder provenance does not match/);
  assert.doesNotMatch(source, /\bfetch\s*\(|--allow-real-traffic|test-anticodex-ui|human-long-journey|inventory|migration|greenfield/i);
});
