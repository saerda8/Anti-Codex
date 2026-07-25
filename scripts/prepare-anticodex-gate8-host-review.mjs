#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHostReviewHmacAttestation,
} from "./lib/anticodex-gate8-evidence.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const builderPath = join(dirname(scriptPath), "build-anticodex-gate8-autonomous-video-evidence.mjs");
const args = parseArgs(process.argv.slice(2));
const value = (name, fallback = "") => String(args.get(name)?.at(-1) ?? fallback);

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/prepare-anticodex-gate8-host-review.mjs [options]

Required:
  --rollout <path>             Completed native Codex rollout JSONL
  --deliverable-facts <path>   Product-written deliverable facts inside task cwd

Optional:
  --output-root <path>         New external review directory (default: random host temp path)
  --finalize-review <path>     Completed unsigned human-review draft outside task cwd
  --host-review-request <path> Request produced by the first invocation
  --sealed-receipt-output <path> External sealed receipt path (must not exist)
  --task-receipt <path>        Signed native task handoff receipt for finalization
  --release-binding-evidence <path> Signed current release binding for finalization
  --gate8-output <path>        Gate 8 source evidence written by the child builder
  --compact                    Print compact JSON

This offline host utility runs only after native task_complete. It extracts hashed
frames and audio/video review clips outside the task cwd, then writes a review
request and an unapproved receipt template. A later finalize invocation seals the
completed human review with a one-time in-memory HMAC and invokes the Gate 8 builder
in the same host call. That HMAC proves caller-side integrity only, not external host
identity; formal Gate 8 remains fail-closed until an external trust anchor is configured.
It never opens Anti-Codex, sends a prompt, switches a provider, or accesses a network.`);
  process.exit(0);
}

function parseArgs(items) {
  const parsed = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const key = String(items[index] || "");
    if (!key.startsWith("--")) continue;
    const next = items[index + 1];
    const item = next && !String(next).startsWith("--") ? String(next) : true;
    if (item !== true) index += 1;
    parsed.set(key, parsed.has(key) ? [...parsed.get(key), item] : [item]);
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function insideRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..\\`) && !isAbsolute(rel);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error?.message || error}`);
  }
}

function readRollout(pathValue) {
  const path = resolve(String(pathValue || ""));
  requireCondition(pathValue && existsSync(path) && statSync(path).isFile(),
    "rollout: completed native JSONL is missing");
  const records = readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`rollout: invalid JSON at line ${index + 1}: ${error?.message || error}`);
      }
    });
  return { path, records, bytes: readFileSync(path) };
}

function run(command, toolArgs, label) {
  requireCondition(isAbsolute(command), `${label}: executable path is not absolute`);
  const child = spawnSync(command, toolArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  requireCondition(!child.error && child.status === 0,
    `${label}: ${String(child.stderr || child.stdout || child.error?.message || "").trim()}`);
  return { stdout: String(child.stdout || ""), stderr: String(child.stderr || "") };
}

function resolveTool(name) {
  const lookup = spawnSync("where.exe", [`${name}.exe`], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  requireCondition(!lookup.error && lookup.status === 0,
    `${name}: executable could not be resolved`);
  const path = String(lookup.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => isAbsolute(line) && existsSync(line) && statSync(line).isFile());
  requireCondition(path, `${name}: resolved executable is missing`);
  const absolutePath = resolve(path);
  const version = run(absolutePath, ["-version"], `${name} version`)
    .stdout.split(/\r?\n/)[0]?.trim() || "";
  requireCondition(version.toLowerCase().includes(name), `${name}: version output is invalid`);
  return {
    name,
    path: absolutePath,
    sha256: sha256(readFileSync(absolutePath)),
    version,
  };
}

function writeAtomic(path, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, body, "utf8");
  renameSync(temporary, path);
  return sha256(body);
}

function terminalTask(records) {
  const session = records.find((record) => record?.type === "session_meta");
  const taskId = String(session?.payload?.id || session?.payload?.session_id || "");
  const taskCwd = resolve(String(session?.payload?.cwd || ""));
  requireCondition(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(taskId)
    && taskCwd,
  "rollout: task id or cwd is invalid");
  const turns = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record?.type === "turn_context");
  requireCondition(turns.length >= 1, "rollout: no native turn exists");
  const finalTurnId = String(turns.at(-1).record?.payload?.turn_id || "");
  const completions = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record?.type === "event_msg"
      && record?.payload?.type === "task_complete"
      && String(record?.payload?.turn_id || "") === finalTurnId);
  requireCondition(completions.length === 1, "rollout: final native turn is not task_complete");
  const completion = completions[0];
  const taskCompletedAtUtc = String(completion.record?.timestamp || "");
  requireCondition(Number.isFinite(Date.parse(taskCompletedAtUtc)),
    "rollout: task_complete timestamp is invalid");
  const activeAfterComplete = records.slice(completion.index + 1).some((record) => (
    record?.type === "turn_context"
    || (record?.type === "event_msg"
      && ["task_started", "user_message"].includes(String(record?.payload?.type || "")))
    || (record?.type === "response_item"
      && ["function_call", "custom_tool_call", "local_shell_call"]
        .includes(String(record?.payload?.type || "")))
  ));
  requireCondition(!activeAfterComplete, "rollout: native task remained active after task_complete");
  return { taskId, taskCwd, finalTurnId, taskCompletedAtUtc };
}

function probeMainVideo(path, ffprobe) {
  const result = run(ffprobe.path, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    path,
  ], "main video probe");
  const payload = JSON.parse(result.stdout);
  const durationSeconds = Number(payload?.format?.duration);
  const video = (payload?.streams || []).find((stream) => stream?.codec_type === "video");
  const audio = (payload?.streams || []).find((stream) => stream?.codec_type === "audio");
  requireCondition(video && audio
    && Number(video.width) === 1080
    && Number(video.height) === 1920
    && Number.isFinite(durationSeconds)
    && durationSeconds >= 45
    && durationSeconds <= 60,
  "main video is not a 45-60 second 1080x1920 video with audio");
  return { durationSeconds };
}

function reviewWindows(durationSeconds) {
  const lengthSeconds = Math.min(3, durationSeconds / 12);
  return Array.from({ length: 5 }, (_, index) => {
    const center = durationSeconds * ((index + 1) / 6);
    const startSeconds = Math.max(0, center - (lengthSeconds / 2));
    return {
      id: `W${String(index + 1).padStart(2, "0")}`,
      startSeconds: Number(startSeconds.toFixed(3)),
      endSeconds: Number(Math.min(durationSeconds, startSeconds + lengthSeconds).toFixed(3)),
      speaker: "speaker-unidentified",
      faceTrackId: "face-track-unidentified",
    };
  });
}

function sampleTimes(durationSeconds) {
  return Array.from({ length: 6 }, (_, index) => (
    Number((durationSeconds * ((index + 0.5) / 6)).toFixed(3))
  ));
}

function finalizeHostReview({ rollout, terminal, factsPath, mainVideoPath }) {
  const required = [
    "--finalize-review",
    "--host-review-request",
    "--task-receipt",
    "--release-binding-evidence",
    "--gate8-output",
  ];
  const missing = required.filter((flag) => !value(flag));
  requireCondition(missing.length === 0,
    `finalize review is missing required arguments: ${missing.join(", ")}`);
  const requestPath = resolve(value("--host-review-request"));
  const reviewDraftPath = resolve(value("--finalize-review"));
  const receiptPath = resolve(value(
    "--sealed-receipt-output",
    join(dirname(requestPath), "host-review-receipt.sealed.json"),
  ));
  const gate8OutputPath = resolve(value("--gate8-output"));
  for (const [label, path] of [
    ["host review request", requestPath],
    ["human review draft", reviewDraftPath],
  ]) {
    requireCondition(existsSync(path) && statSync(path).isFile(),
      `${label} is missing`);
    requireCondition(!insideRoot(terminal.taskCwd, path)
      && resolve(path) !== resolve(terminal.taskCwd),
    `${label} must be outside the native task cwd`);
  }
  requireCondition(!insideRoot(terminal.taskCwd, receiptPath)
    && resolve(receiptPath) !== resolve(terminal.taskCwd)
    && receiptPath !== requestPath
    && receiptPath !== reviewDraftPath,
  "sealed host review receipt must be a new path outside the native task cwd");
  requireCondition(!existsSync(receiptPath), "sealed host review receipt already exists");
  requireCondition(!insideRoot(terminal.taskCwd, gate8OutputPath)
    && resolve(gate8OutputPath) !== resolve(terminal.taskCwd),
  "Gate 8 output must be outside the native task cwd");

  const requestBytes = readFileSync(requestPath);
  const request = readJson(requestPath, "host review request");
  const draft = readJson(reviewDraftPath, "human review draft");
  requireCondition(request?.schema === "anticodex-gate8-host-review-request-v1"
    && String(request?.taskId || "") === terminal.taskId
    && String(request?.turnId || "") === terminal.finalTurnId
    && String(request?.taskCompletedAtUtc || "") === terminal.taskCompletedAtUtc,
  "host review request is not bound to the terminal native task");
  requireCondition(String(request?.mainVideoSha256 || "").toLowerCase()
    === sha256(readFileSync(mainVideoPath)),
  "host review request is not bound to the current main video");
  requireCondition(draft?.schema === "anticodex-gate8-host-human-review-v1"
    && draft?.trustKind === "host-human-review"
    && !Object.hasOwn(draft, "hostAttestation"),
  "human review draft must be unsigned and use the host-human-review schema");

  const {
    challenge: _publicChallenge,
    hostAttestation: _selfAttestation,
    ...reviewFields
  } = draft;
  const receipt = {
    ...reviewFields,
    generatedAtUtc: new Date().toISOString(),
    requestSha256: sha256(requestBytes),
    mainVideoSha256: String(request.mainVideoSha256).toLowerCase(),
  };
  requireCondition(Date.parse(receipt.generatedAtUtc) > Date.parse(request.generatedAtUtc)
    && Date.parse(request.generatedAtUtc) > Date.parse(terminal.taskCompletedAtUtc),
  "human review finalization is not after the post-task review request");

  const hostSecret = randomBytes(32);
  let receiptWritten = false;
  try {
    receipt.hostAttestation = createHostReviewHmacAttestation({
      secret: hostSecret,
      request,
      requestSha256: receipt.requestSha256,
      receipt,
      rolloutSha256: sha256(rollout.bytes),
      requestPath,
      receiptPath,
    });
    const receiptSha256 = writeAtomic(receiptPath, receipt);
    receiptWritten = true;
    const builderArgs = [
      builderPath,
      "--task-receipt", resolve(value("--task-receipt")),
      "--rollout", rollout.path,
      "--release-binding-evidence", resolve(value("--release-binding-evidence")),
      "--deliverable-facts", factsPath,
      "--host-review-request", requestPath,
      "--host-review-receipt", receiptPath,
      "--host-review-secret-stdin",
      "--output", gate8OutputPath,
      "--compact",
    ];
    if (value("--release-report-root")) {
      builderArgs.push("--release-report-root", resolve(value("--release-report-root")));
    }
    if (value("--max-source-age-hours")) {
      builderArgs.push("--max-source-age-hours", value("--max-source-age-hours"));
    }
    const child = spawnSync(process.execPath, builderArgs, {
      input: hostSecret.toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    requireCondition(!child.error && child.status === 0,
      `Gate 8 builder rejected the sealed host review: ${
        String(child.stderr || child.stdout || child.error?.message || "").trim()
      }`);
    const builderResultText = String(child.stdout || "").trim().split(/\r?\n/).at(-1) || "{}";
    const builderResult = JSON.parse(builderResultText);
    requireCondition(builderResult?.ok === true, "Gate 8 builder did not return success");
    return {
      ok: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      taskId: terminal.taskId,
      receiptPath,
      receiptSha256,
      gate8Output: gate8OutputPath,
      gate8BuilderOk: true,
      externalSecretPersisted: false,
    };
  } catch (error) {
    if (receiptWritten) rmSync(receiptPath, { force: true });
    throw error;
  } finally {
    hostSecret.fill(0);
  }
}

async function main() {
  requireCondition(value("--rollout") && value("--deliverable-facts"),
    "rollout and deliverable-facts are required");
  const rollout = readRollout(value("--rollout"));
  const terminal = terminalTask(rollout.records);
  const factsPath = resolve(value("--deliverable-facts"));
  requireCondition(existsSync(factsPath) && statSync(factsPath).isFile()
    && insideRoot(terminal.taskCwd, factsPath),
  "deliverable-facts must be a file inside the native task cwd");
  const facts = readJson(factsPath, "deliverable-facts");
  requireCondition(facts?.schema === "anticodex-autonomous-video-deliverable-facts-v1",
    "deliverable-facts schema is invalid");
  const mainVideoPath = resolve(String(facts?.mainVideo?.path || ""));
  requireCondition(existsSync(mainVideoPath) && statSync(mainVideoPath).isFile()
    && insideRoot(terminal.taskCwd, mainVideoPath),
  "main video must be a file inside the native task cwd");
  if (value("--finalize-review")) {
    return finalizeHostReview({
      rollout,
      terminal,
      factsPath,
      mainVideoPath,
    });
  }

  const outputRootArg = value("--output-root");
  const outputRoot = outputRootArg
    ? resolve(outputRootArg)
    : mkdtempSync(join(tmpdir(), "anticodex-gate8-host-review-"));
  requireCondition(!insideRoot(terminal.taskCwd, outputRoot)
    && resolve(outputRoot) !== resolve(terminal.taskCwd),
  "host review output root must be outside the native task cwd");
  if (outputRootArg) {
    requireCondition(!existsSync(outputRoot), "host review output root already exists");
    mkdirSync(outputRoot, { recursive: true });
  }
  const frameRoot = join(outputRoot, "frames");
  const clipRoot = join(outputRoot, "windows");
  mkdirSync(frameRoot, { recursive: true });
  mkdirSync(clipRoot, { recursive: true });

  const tools = {
    ffprobe: resolveTool("ffprobe"),
    ffmpeg: resolveTool("ffmpeg"),
  };
  const { durationSeconds } = probeMainVideo(mainVideoPath, tools.ffprobe);
  const samples = sampleTimes(durationSeconds).map((timestampSeconds, index) => {
    const path = join(frameRoot, `frame-${String(index + 1).padStart(2, "0")}.png`);
    run(tools.ffmpeg.path, [
      "-hide_banner", "-nostats", "-v", "error", "-y",
      "-ss", String(timestampSeconds),
      "-i", mainVideoPath,
      "-frames:v", "1",
      path,
    ], `frame sample ${index + 1}`);
    return {
      path,
      sha256: sha256(readFileSync(path)),
      timestampSeconds,
    };
  });
  const windows = reviewWindows(durationSeconds).map((window) => {
    const clipPath = join(clipRoot, `${window.id}.mp4`);
    run(tools.ffmpeg.path, [
      "-hide_banner", "-nostats", "-v", "error", "-y",
      "-ss", String(window.startSeconds),
      "-t", String(window.endSeconds - window.startSeconds),
      "-i", mainVideoPath,
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "18",
      "-c:a", "aac",
      clipPath,
    ], `review window ${window.id}`);
    return {
      ...window,
      clipPath,
      clipSha256: sha256(readFileSync(clipPath)),
    };
  });

  const generatedAtUtc = new Date().toISOString();
  requireCondition(Date.parse(generatedAtUtc) > Date.parse(terminal.taskCompletedAtUtc),
    "review request timestamp is not after task_complete");
  const requestPath = join(outputRoot, "host-review-request.json");
  const request = {
    schema: "anticodex-gate8-host-review-request-v1",
    generatedAtUtc,
    taskId: terminal.taskId,
    turnId: terminal.finalTurnId,
    taskCompletedAtUtc: terminal.taskCompletedAtUtc,
    mainVideoPath,
    mainVideoSha256: sha256(readFileSync(mainVideoPath)),
    durationSeconds,
    samples,
    windows,
    tools,
    producer: {
      path: scriptPath,
      sha256: sha256(readFileSync(scriptPath)),
      trustKind: "host-post-task-extractor",
      cryptographicHostIdentity: false,
    },
  };
  const requestSha256 = writeAtomic(requestPath, request);
  const receiptTemplatePath = join(outputRoot, "host-review-receipt.UNAPPROVED.template.json");
  writeAtomic(receiptTemplatePath, {
    schema: "anticodex-gate8-host-human-review-v1",
    trustKind: "host-human-review",
    generatedAtUtc: "",
    requestSha256,
    mainVideoSha256: request.mainVideoSha256,
    liveAction: false,
    continuousHumanFootage: false,
    visibleSpeaking: false,
    observedSpeakingSeconds: 0,
    dialoguePresent: false,
    musicPresent: false,
    subtitleLanguage: "",
    subtitleBurnedIn: false,
    lipSyncWindows: windows.map((window) => ({
      id: window.id,
      startSeconds: window.startSeconds,
      endSeconds: window.endSeconds,
      speaker: window.speaker,
      faceTrackId: window.faceTrackId,
      offsetMs: null,
      mouthMotionScore: null,
      avSyncScore: null,
    })),
  });
  return {
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    taskId: terminal.taskId,
    requestPath,
    requestSha256,
    receiptTemplatePath,
    receiptApproved: false,
    nextAction: "Review every generated frame and clip, save a completed unsigned draft to a new external path, then use this utility's finalize mode so the one-time secret reaches Gate 8 only through child stdin.",
  };
}

try {
  const result = await main();
  console.log(args.has("--compact") ? JSON.stringify(result) : JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    ok: false,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    failures: [String(error?.message || error)],
  };
  console.log(args.has("--compact") ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  process.stderr.write(`${result.failures[0]}\n`);
  process.exitCode = 1;
}
