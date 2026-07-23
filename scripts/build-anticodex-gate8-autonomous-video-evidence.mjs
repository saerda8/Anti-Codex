#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGate8AutonomousVideoReport,
  createEphemeralGate8Witness,
  deriveTrustedProviderReceipts,
  parseTrustedSrtCues,
  validateHostHumanReviewReceipt,
  validateGate8AutonomousVideoReport,
  validateMediaToolIdentity,
  validatePostTaskHostBoundary,
  validateTrustedLipSyncWindows,
} from "./lib/anticodex-gate8-evidence.mjs";
import {
  createCurrentReleaseBinding,
  isFreshReleaseEvidence,
  releaseBindingsEqual,
} from "./lib/anticodex-release-binding.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builderScriptPath = fileURLToPath(import.meta.url);
const args = parseArgs(process.argv.slice(2));
const value = (name, fallback = "") => String(args.get(name)?.at(-1) ?? fallback);
const values = (name) => (args.get(name) || []).map(String);
const compact = args.has("--compact");
const maxSourceAgeHours = positiveNumber(value("--max-source-age-hours"), 48);
const outputPath = resolve(value("--output", resolve(process.cwd(), "gate8-autonomous-video-source-evidence.json")));
const releaseReportRoot = resolve(
  value("--release-report-root", resolve(process.env.APPDATA || ".", "anticodex", "reports")),
);
const requiredFlags = [
  "--task-receipt",
  "--rollout",
  "--release-binding-evidence",
  "--deliverable-facts",
  "--host-review-request",
  "--host-review-receipt",
  "--host-review-secret-stdin",
];
const forbiddenFactKeys = new Set([
  "task",
  "taskid",
  "turnid",
  "cwd",
  "prompt",
  "promptsha256",
  "provider",
  "providerpolicy",
  "providerreceipts",
  "providerfallbacks",
  "releasebinding",
  "component",
  "model",
  "rollout",
  "rolloutpath",
  "rolloutsha256",
]);
const productRequiredRoles = Object.freeze([
  "main-video",
  "release-video",
  "subtitle",
  "lipsync-report",
  "media-qa-report",
  "checksum-manifest",
]);
const packageRequiredRoles = Object.freeze([
  "main-video",
  "release-video",
  "subtitle",
  "lipsync-report",
  "media-qa-report",
]);
const nativeIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/build-anticodex-gate8-autonomous-video-evidence.mjs [options]

Offline-only trusted evidence normalization. It never opens Anti-Codex, starts a
client, sends a model request, switches a provider, or accesses the network.

Required:
  --task-receipt <path>             Signed one-shot native task receipt
  --rollout <path>                  Completed native Codex rollout JSONL
  --release-binding-evidence <path> Signed current release-binding evidence
  --deliverable-facts <path>        Product-written deliverable facts only
  --host-review-request <path>    Post-task host-generated frame/window request
  --host-review-receipt <path>    Post-task host-human review bound to that request
  --host-review-secret-stdin        Read the one-time 32-byte host secret from stdin
  --output <path>                   Atomic signed Gate 8 source evidence

Optional:
  --release-report-root <path>      Current signed sync-readiness report root
  --max-source-age-hours <n>        Receipt maximum age (default: 48)
  --compact                         Print compact JSON`);
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

function positiveNumber(input, fallback) {
  const number = Number(input);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function normalizedPath(value) {
  return resolve(String(value || "")).replaceAll("\\", "/").toLowerCase();
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function insideRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..\\`) && !isAbsolute(rel);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    fail(`${label}: invalid JSON: ${error?.message || error}`);
  }
}

function readSignedJson(pathValue, label) {
  const path = resolve(String(pathValue || ""));
  requireCondition(pathValue && existsSync(path) && statSync(path).isFile(), `${label}: source is missing`);
  const bytes = readFileSync(path);
  const actualSha256 = sha256(bytes);
  const sidecarPath = `${path}.sha256`;
  requireCondition(existsSync(sidecarPath) && statSync(sidecarPath).isFile(), `${label}: signature sidecar is missing`);
  const match = readFileSync(sidecarPath, "ascii").trim().match(/^(?:sha256:)?([a-f0-9]{64})$/i);
  requireCondition(match && match[1].toLowerCase() === actualSha256, `${label}: signature hash mismatch`);
  const data = readJson(path, label);
  requireCondition(
    isFreshReleaseEvidence(data, { maxAgeHours: maxSourceAgeHours }),
    `${label}: content-embedded timestamp is missing or stale`,
  );
  return { path, sha256: actualSha256, data };
}

function readHostJson(pathValue, label) {
  const path = resolve(String(pathValue || ""));
  requireCondition(pathValue && existsSync(path) && statSync(path).isFile(), `${label}: source is missing`);
  const bytes = readFileSync(path);
  const data = readJson(path, label);
  requireCondition(
    isFreshReleaseEvidence(data, { maxAgeHours: maxSourceAgeHours }),
    `${label}: content-embedded timestamp is missing or stale`,
  );
  return { path, sha256: sha256(bytes), data };
}

function readHostReviewSecretFromStdin() {
  const encoded = readFileSync(0, "utf8").trim();
  requireCondition(/^[A-Za-z0-9+/]{43}=$/.test(encoded),
    "host-review-receipt: external stdin secret is missing or invalid");
  const secret = Buffer.from(encoded, "base64");
  requireCondition(secret.length === 32 && secret.toString("base64") === encoded,
    "host-review-receipt: external stdin secret is missing or invalid");
  return secret;
}

function readRollout(pathValue) {
  const path = resolve(String(pathValue || ""));
  requireCondition(pathValue && existsSync(path) && statSync(path).isFile(), "rollout: native JSONL is missing");
  const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  requireCondition(lines.length > 0, "rollout: native JSONL is empty");
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`rollout: invalid JSON at line ${index + 1}: ${error?.message || error}`);
    }
  });
  return { path, records, bytes: readFileSync(path) };
}

function readSupervisorStatus() {
  const stateRoot = resolve(
    process.env.DEEPCODEX_STATE_ROOT
      || join(process.env.APPDATA || ".", "anticodex"),
  );
  const path = join(stateRoot, "fixed-route-status.json");
  requireCondition(existsSync(path) && statSync(path).isFile(),
    "post-task witness: fixed-route supervisor status is missing");
  return { path, data: readJson(path, "post-task supervisor status") };
}

function supervisorProcessIds(status) {
  const processes = status?.processes || {};
  return [
    processes.managerService,
    processes.codexPlusPlus,
    processes.managerWatcher,
    processes.managerBridge,
    ...(Array.isArray(processes.copiedClient) ? processes.copiedClient : []),
  ].map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function readOwnedProcessSnapshot(status) {
  const roots = supervisorProcessIds(status);
  requireCondition(roots.length >= 3,
    "post-task witness: supervisor process identity is incomplete");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows = Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{Name='CreationTimeUtc';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }}",
    "$rows | Sort-Object ProcessId -Unique | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  const child = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  requireCondition(!child.error && child.status === 0,
    `post-task witness: process snapshot failed: ${String(child.stderr || child.error?.message || "").trim()}`);
  const text = String(child.stdout || "").trim().replace(/^\uFEFF/, "");
  requireCondition(text, "post-task witness: process snapshot is empty");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`post-task witness: process snapshot JSON is invalid: ${error?.message || error}`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function modelProvider(modelValue) {
  const model = String(modelValue || "").toLowerCase();
  if (model.includes("gemini")) return "gemini";
  if (model.includes("claude")) return "claude";
  if (model.includes("third-party") || model.includes("gpt-")) return "third-party";
  return "";
}

function responseText(record) {
  if (record?.type !== "response_item" || record?.payload?.type !== "message") return "";
  return (Array.isArray(record?.payload?.content) ? record.payload.content : [])
    .filter((item) => ["output_text", "input_text"].includes(String(item?.type || "")))
    .map((item) => String(item?.text || ""))
    .join("");
}

function userMessages(records) {
  const useEventMessages = records.some((record) => (
    record?.type === "event_msg" && record?.payload?.type === "user_message"
  ));
  let currentTurnId = "";
  const messages = [];
  for (const [index, record] of records.entries()) {
    if (record?.type === "turn_context") currentTurnId = String(record?.payload?.turn_id || "");
    if (useEventMessages && record?.type === "event_msg" && record?.payload?.type === "user_message") {
      messages.push({ text: String(record?.payload?.message || ""), turnId: currentTurnId, index });
    } else if (!useEventMessages
      && record?.type === "response_item"
      && record?.payload?.type === "message"
      && record?.payload?.role === "user") {
      messages.push({ text: responseText(record), turnId: currentTurnId, index });
    }
  }
  return messages;
}

function explicitInterruption(records, turnId) {
  let currentTurnId = "";
  for (const [index, record] of records.entries()) {
    if (record?.type === "turn_context") {
      currentTurnId = String(record?.payload?.turn_id || "");
    }
    const recordTurnId = String(
      record?.payload?.turn_id
      || record?.payload?.internal_chat_message_metadata_passthrough?.turn_id
      || currentTurnId,
    );
    if (recordTurnId !== turnId) continue;
    if (record?.type !== "event_msg") continue;
    const type = String(record?.payload?.type || "");
    const statusCode = Number(record?.payload?.status_code);
    const errorCode = String(record?.payload?.error_code || "");
    const provider = String(record?.payload?.provider || "");
    if (type === "provider_error"
      && provider
      && statusCode === 429
      && ["quota_exhausted", "rate_limit_exceeded", "resource_exhausted"].includes(errorCode)) {
      return { index, kind: "provider-quota", reasonKind: "quota-error", explicitProviderError: true };
    }
    if (type === "provider_error"
      && provider
      && statusCode === 503
      && ["service_unavailable", "provider_unavailable"].includes(errorCode)) {
      return { index, kind: "provider-service", reasonKind: "service-error", explicitProviderError: true };
    }
    if (["turn_aborted", "turn_interrupted"].includes(type)) {
      return { index, kind: "client-interruption", reasonKind: "client-interruption", explicitProviderError: false };
    }
  }
  return null;
}

function deriveRolloutEvidence({ rollout, receipt, promptText, promptSha256, marker }) {
  const sessionMeta = rollout.records.find((record) => record?.type === "session_meta");
  const taskId = String(sessionMeta?.payload?.id || sessionMeta?.payload?.session_id || "");
  const cwd = resolve(String(sessionMeta?.payload?.cwd || ""));
  requireCondition(nativeIdPattern.test(taskId), "rollout: native task id is invalid");
  requireCondition(cwd && samePath(cwd, receipt.projectRoot), "rollout: task cwd differs from the signed receipt");

  const turnContexts = rollout.records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record?.type === "turn_context")
    .map(({ record, index }) => ({
      index,
      turnId: String(record?.payload?.turn_id || ""),
      cwd: resolve(String(record?.payload?.cwd || "")),
      model: String(record?.payload?.model || record?.payload?.collaboration_mode?.settings?.model || ""),
    }));
  requireCondition(turnContexts.length >= 1, "rollout: no native turn context was found");
  requireCondition(
    turnContexts.every((turn) => nativeIdPattern.test(turn.turnId) && samePath(turn.cwd, cwd) && modelProvider(turn.model)),
    "rollout: native turn id, cwd, or model is invalid",
  );
  requireCondition(
    new Set(turnContexts.map((turn) => turn.turnId)).size === turnContexts.length,
    "rollout: duplicate native turn ids were found",
  );

  const messages = userMessages(rollout.records);
  const totalGoalMessages = messages.filter((message) => message.text === promptText);
  const continuations = messages.filter((message) => message.text.trim() === "继续");
  const hostIntermediateMessages = messages.filter(
    (message) => message.text !== promptText && message.text.trim() !== "继续",
  );
  requireCondition(totalGoalMessages.length === 1, "rollout: total goal was not submitted exactly once");
  requireCondition(messages[0]?.text === promptText, "rollout: first user input is not the signed total goal");
  requireCondition(hostIntermediateMessages.length === 0, "rollout: host intermediate instruction was observed");

  const toolCalls = [];
  const fileActions = [];
  const planCalls = [];
  const assistantOutputs = [];
  let currentTurnId = "";
  for (const [index, record] of rollout.records.entries()) {
    if (record?.type === "turn_context") currentTurnId = String(record?.payload?.turn_id || "");
    if (record?.type === "response_item"
      && ["function_call", "custom_tool_call", "local_shell_call"].includes(String(record?.payload?.type || ""))) {
      const name = String(record?.payload?.name || record?.payload?.tool_name || record?.payload?.type || "");
      const call = { index, turnId: currentTurnId, name };
      toolCalls.push(call);
      if (name === "update_plan") planCalls.push(call);
      if (/^(?:apply_patch|edit_file|write_file)$/i.test(name)) fileActions.push(call);
    }
    if (record?.type === "response_item"
      && record?.payload?.type === "message"
      && record?.payload?.role === "assistant") {
      assistantOutputs.push({ index, turnId: currentTurnId, text: responseText(record) });
    }
  }
  const markerOutputs = assistantOutputs.filter((output) => output.text.includes(marker));
  requireCondition(markerOutputs.length === 1, "rollout: exact final marker was not observed once");
  const finalOutput = markerOutputs[0];
  const finalLine = finalOutput.text.trim().split(/\r?\n/).at(-1)?.trim();
  requireCondition(finalLine === marker, "rollout: final marker is not the last line of the final response");
  const postFinalToolCallCount = toolCalls.filter((call) => call.index > finalOutput.index).length;
  requireCondition(postFinalToolCallCount === 0, "rollout: a tool call occurred after the final marker");
  requireCondition(planCalls.length >= 1, "rollout: autonomous update_plan evidence is missing");
  requireCondition(toolCalls.length >= 5, "rollout: fewer than five native tool calls were observed");
  requireCondition(fileActions.length >= 1, "rollout: no native file action was observed");

  const interruptions = [];
  const continuationEvidence = [];
  for (const continuation of continuations) {
    const continuationTurnIndex = turnContexts.findIndex((turn) => turn.turnId === continuation.turnId);
    requireCondition(continuationTurnIndex > 0, "rollout: continuation has no preceding native turn");
    const previousTurn = turnContexts[continuationTurnIndex - 1];
    const interruption = explicitInterruption(rollout.records, previousTurn.turnId);
    requireCondition(interruption, "rollout: 继续 was not preceded by a proven interruption");
    const receiptId = `rollout-interruption-${previousTurn.turnId}`;
    interruptions.push({
      receiptId,
      taskId,
      turnId: previousTurn.turnId,
      kind: interruption.kind,
    });
    continuationEvidence.push({
      text: "继续",
      taskId,
      turnId: continuation.turnId,
      interruptionReceiptId: receiptId,
    });
  }

  const turns = turnContexts.map((turn, index) => {
    const interruption = explicitInterruption(rollout.records, turn.turnId);
    const completed = turn.turnId === finalOutput.turnId;
    return {
      turnId: turn.turnId,
      taskId,
      cwd,
      promptSha256,
      autonomous: true,
      status: completed
        ? "completed"
        : interruption?.kind === "client-interruption"
          ? "interrupted"
          : "provider-error",
      model: turn.model,
      provider: modelProvider(turn.model),
      index,
    };
  });

  return {
    taskId,
    cwd,
    primaryTurnId: turnContexts[0].turnId,
    turns,
    interruptions,
    continuations: continuationEvidence,
    planUpdateCount: planCalls.length,
    toolCallCount: toolCalls.length,
    fileActionCount: fileActions.length,
    postFinalToolCallCount,
    hostIntermediatePromptCount: hostIntermediateMessages.length,
    finalMarkerSeen: true,
  };
}

function forbiddenFactKey(value, location = "$") {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenFactKeys.has(key.toLowerCase())) return `${location}.${key}`;
    const child = forbiddenFactKey(nested, `${location}.${key}`);
    if (child) return child;
  }
  return null;
}

function fileArtifact(pathValue, role, artifactRoot, { allowExternal = false, taskStartedAtMs = Number.NaN } = {}) {
  const path = resolve(String(pathValue || ""));
  requireCondition(pathValue && existsSync(path) && statSync(path).isFile(), `artifact is missing: ${path || "<empty>"}`);
  const stats = statSync(path);
  requireCondition(stats.size > 0, `artifact is empty: ${path}`);
  requireCondition(allowExternal || insideRoot(artifactRoot, path), `artifact is outside the task cwd: ${path}`);
  requireCondition(
    allowExternal || !Number.isFinite(taskStartedAtMs) || stats.mtimeMs >= taskStartedAtMs,
    `artifact predates the signed native task start: ${path}`,
  );
  const bytes = readFileSync(path);
  return { role, path, bytes: bytes.length, sha256: sha256(bytes) };
}

function runMediaTool(command, toolArgs, label) {
  requireCondition(isAbsolute(command), `${label}: media tool path is not absolute`);
  const child = spawnSync(command, toolArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  requireCondition(!child.error, `${label}: ${child.error?.message || "tool failed to start"}`);
  requireCondition(child.status === 0, `${label}: ${String(child.stderr || child.stdout || `exit ${child.status}`).trim()}`);
  return { stdout: String(child.stdout || ""), stderr: String(child.stderr || "") };
}

function resolveMediaTool(label) {
  const lookup = spawnSync("where.exe", [`${label}.exe`], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  requireCondition(!lookup.error && lookup.status === 0,
    `${label}: executable could not be resolved`);
  const candidates = String(lookup.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isAbsolute(line) && existsSync(line) && statSync(line).isFile());
  requireCondition(candidates.length >= 1, `${label}: resolved executable is missing`);
  const path = resolve(candidates[0]);
  const result = runMediaTool(path, ["-version"], `${label} version`);
  const version = result.stdout.split(/\r?\n/)[0]?.trim() || "";
  requireCondition(version.toLowerCase().includes(label), `${label}: version output is invalid`);
  return validateMediaToolIdentity({
    name: label,
    path,
    sha256: sha256(readFileSync(path)),
    version,
  });
}

function parseFrameRate(value) {
  const text = String(value || "");
  if (text.includes("/")) {
    const [numerator, denominator] = text.split("/").map(Number);
    return denominator > 0 ? numerator / denominator : Number.NaN;
  }
  return Number(text);
}

function probeVideo(path, tools) {
  const result = runMediaTool(tools.ffprobe.path, [
    "-v", "error",
    "-show_error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels",
    "-of", "json",
    path,
  ], `ffprobe ${basename(path)}`);
  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch (error) {
    fail(`ffprobe ${basename(path)}: invalid JSON: ${error?.message || error}`);
  }
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  const durationSeconds = Number(probe?.format?.duration);
  requireCondition(video && audio && Number.isFinite(durationSeconds),
    `ffprobe ${basename(path)}: video/audio stream or duration is missing`);
  runMediaTool(tools.ffmpeg.path, [
    "-hide_banner", "-nostats", "-v", "error", "-xerror",
    "-i", path,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-f", "null", "-",
  ], `full decode ${basename(path)}`);
  return {
    path,
    durationSeconds,
    width: Number(video.width),
    height: Number(video.height),
    frameRate: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
    videoCodec: String(video.codec_name || ""),
    audioCodec: String(audio.codec_name || ""),
    audioSampleRate: Number(audio.sample_rate),
    audioChannels: Number(audio.channels),
    decodable: true,
    videoStreamPresent: true,
    audioStreamPresent: true,
  };
}

function summedDurations(text, field) {
  const pattern = new RegExp(`${field}:([0-9]+(?:\\.[0-9]+)?)`, "gi");
  return [...String(text).matchAll(pattern)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

function analyzeMainMedia(path, durationSeconds, tools) {
  const black = runMediaTool(tools.ffmpeg.path, [
    "-hide_banner", "-nostats", "-v", "info",
    "-i", path,
    "-vf", "blackdetect=d=0.10:pix_th=0.10",
    "-an", "-f", "null", "-",
  ], "black-frame analysis");
  const freeze = runMediaTool(tools.ffmpeg.path, [
    "-hide_banner", "-nostats", "-v", "info",
    "-i", path,
    "-vf", "freezedetect=n=-50dB:d=0.50",
    "-an", "-f", "null", "-",
  ], "freeze-frame analysis");
  const silence = runMediaTool(tools.ffmpeg.path, [
    "-hide_banner", "-nostats", "-v", "info",
    "-i", path,
    "-vn", "-af", "silencedetect=noise=-50dB:d=0.50",
    "-f", "null", "-",
  ], "silence analysis");
  const loudness = runMediaTool(tools.ffmpeg.path, [
    "-hide_banner", "-nostats", "-v", "info",
    "-i", path,
    "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ], "loudness analysis");
  const integratedMatch = loudness.stderr.match(/"input_i"\s*:\s*"(-?[0-9]+(?:\.[0-9]+)?)"/);
  const peakMatch = loudness.stderr.match(/"input_tp"\s*:\s*"(-?[0-9]+(?:\.[0-9]+)?)"/);
  requireCondition(integratedMatch && peakMatch, "loudness analysis: integrated LUFS or true peak is missing");
  return {
    blackFrameRatio: Math.min(1, summedDurations(black.stderr, "black_duration") / durationSeconds),
    freezeFrameRatio: Math.min(1, summedDurations(freeze.stderr, "freeze_duration") / durationSeconds),
    silenceRatio: Math.min(1, summedDurations(silence.stderr, "silence_duration") / durationSeconds),
    integratedLufs: Number(integratedMatch[1]),
    truePeakDb: Number(peakMatch[1]),
  };
}

function subtitleSeconds(hours, minutes, seconds, millis) {
  return (Number(hours) * 3600) + (Number(minutes) * 60) + Number(seconds) + (Number(millis) / 1000);
}

function inspectSubtitle(path, mainDurationSeconds) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const parsed = parseTrustedSrtCues(text, mainDurationSeconds);
  requireCondition(parsed.cueCount >= 5, "subtitle: fewer than five valid cues");
  return {
    path,
    language: "zh-CN",
    cues: parsed.cues,
    cueCount: parsed.cueCount,
    coveredSeconds: parsed.coveredSeconds,
    durationCoverageRatio: parsed.durationCoverageRatio,
  };
}

function validateMediaVerification(result, {
  mainPath,
  releasePaths,
  subtitlePath,
}) {
  const main = result?.mainVideo || {};
  const releases = Array.isArray(result?.releaseVideos) ? result.releaseVideos : [];
  const subtitle = result?.subtitle || {};
  const audio = result?.audio || {};
  const qa = result?.mediaQa || {};
  requireCondition(samePath(main.path, mainPath)
    && main.decodable === true
    && main.videoStreamPresent === true
    && main.audioStreamPresent === true
    && Number(main.width) === 1080
    && Number(main.height) === 1920
    && Number(main.durationSeconds) >= 45
    && Number(main.durationSeconds) <= 60
    && Number(main.frameRate) >= 20
    && String(main.videoCodec || ""),
  "media verifier: main video failed decode, stream, duration, resolution, or frame-rate checks");
  requireCondition(releases.length >= 3
    && new Set(releases.map((video) => normalizedPath(video.path))).size === releases.length
    && releasePaths.every((path) => releases.some((video) => samePath(video.path, path)))
    && releases.every((video) => (
      video.decodable === true
      && video.videoStreamPresent === true
      && video.audioStreamPresent === true
      && Number(video.width) === 1080
      && Number(video.height) === 1920
      && Number(video.durationSeconds) >= 45
      && Number(video.durationSeconds) <= 60
    )),
  "media verifier: release video decode, stream, duration, or resolution check failed");
  requireCondition(samePath(subtitle.path, subtitlePath)
    && subtitle.language === "zh-CN"
    && Number(subtitle.cueCount) >= 5
    && Number(subtitle.durationCoverageRatio) >= 0.8,
  "media verifier: subtitle file, language, cue count, or coverage check failed");
  requireCondition(audio.streamPresent === true
    && Number(audio.silenceRatio) >= 0
    && Number(audio.silenceRatio) <= 0.1
    && Number(audio.integratedLufs) >= -24
    && Number(audio.integratedLufs) <= -8
    && Number(audio.truePeakDb) <= -1,
  "media verifier: audio stream, silence, loudness, or true peak check failed");
  requireCondition(qa.decodePassed === true
    && qa.videoStreamPresent === true
    && qa.audioStreamPresent === true
    && qa.subtitlePresent === true
    && qa.durationMatches === true
    && Number(qa.blackFrameRatio) >= 0
    && Number(qa.blackFrameRatio) <= 0.01
    && Number(qa.freezeFrameRatio) >= 0
    && Number(qa.freezeFrameRatio) <= 0.05
    && Number(qa.silenceRatio) >= 0
    && Number(qa.silenceRatio) <= 0.1,
  "media verifier: black-frame, freeze-frame, silence, or duration QA failed");
  return result;
}

function verifyMediaLocally(paths) {
  const tools = {
    ffprobe: resolveMediaTool("ffprobe"),
    ffmpeg: resolveMediaTool("ffmpeg"),
  };
  const mainVideo = probeVideo(paths.mainPath, tools);
  const releaseVideos = paths.releasePaths.map((path) => probeVideo(path, tools));
  const subtitle = inspectSubtitle(paths.subtitlePath, mainVideo.durationSeconds);
  const measurements = analyzeMainMedia(paths.mainPath, mainVideo.durationSeconds, tools);
  const durationMatches = releaseVideos.every((video) => (
    Math.abs(video.durationSeconds - mainVideo.durationSeconds) <= 0.5
  ));
  return validateMediaVerification({
    schema: "anticodex-gate8-local-media-verification-v1",
    mode: "local-ffmpeg-ffprobe",
    mainVideo,
    releaseVideos,
    subtitle,
    audio: {
      streamPresent: mainVideo.audioStreamPresent,
      silenceRatio: measurements.silenceRatio,
      integratedLufs: measurements.integratedLufs,
      truePeakDb: measurements.truePeakDb,
    },
    mediaQa: {
      decodePassed: true,
      videoStreamPresent: mainVideo.videoStreamPresent,
      audioStreamPresent: mainVideo.audioStreamPresent,
      subtitlePresent: true,
      durationMatches,
      blackFrameRatio: measurements.blackFrameRatio,
      freezeFrameRatio: measurements.freezeFrameRatio,
      silenceRatio: measurements.silenceRatio,
    },
    tools,
  }, paths);
}

function mediaVerification(paths) {
  return verifyMediaLocally(paths);
}

function normalizeHostReview({
  requestSource,
  receiptSource,
  mainVideo,
  mainDurationSeconds,
  taskCwd,
  rolloutSha256,
  hostSecret,
}) {
  const review = validateHostHumanReviewReceipt({
    request: requestSource.data,
    requestSha256: requestSource.sha256,
    receipt: receiptSource.data,
    rolloutSha256,
    hostSecret,
    taskCwd,
    requestPath: requestSource.path,
    receiptPath: receiptSource.path,
  });
  requireCondition(
    String(requestSource.data?.mainVideoSha256 || "").toLowerCase() === mainVideo.sha256,
    "host review: request is not bound to the main video hash",
  );
  for (const [index, sample] of requestSource.data.samples.entries()) {
    const path = resolve(String(sample?.path || ""));
    requireCondition(
      existsSync(path)
        && statSync(path).isFile()
        && !insideRoot(taskCwd, path)
        && sha256(readFileSync(path)) === String(sample?.sha256 || "").toLowerCase(),
      `host review: generated frame sample ${index + 1} is missing, inside task cwd, or hash-mismatched`,
    );
  }
  for (const [index, window] of requestSource.data.windows.entries()) {
    const clipPath = resolve(String(window?.clipPath || ""));
    requireCondition(
      existsSync(clipPath)
        && statSync(clipPath).isFile()
        && !insideRoot(taskCwd, clipPath)
        && sha256(readFileSync(clipPath)) === String(window?.clipSha256 || "").toLowerCase(),
      `host review: generated review clip ${index + 1} is missing, inside task cwd, or hash-mismatched`,
    );
  }
  const windows = validateTrustedLipSyncWindows(
    review.lipSyncWindows,
    mainDurationSeconds,
  );
  return {
    sourceVideoSha256: mainVideo.sha256,
    evaluator: "host-human-review",
    evaluatorVersion: "1",
    contractVersion: "anticodex-gate8-host-human-review-v1",
    visual: {
      liveAction: true,
      continuousHumanFootage: true,
      visibleSpeaking: true,
      observedSpeakingSeconds: review.observedSpeakingSeconds,
    },
    audio: { dialoguePresent: true, musicPresent: true },
    subtitle: { language: "zh-CN", burnedIn: true },
    lipSync: {
      passed: true,
      aggregateDenominator: windows.length,
      passCount: windows.length,
      windows,
    },
    trustKind: review.trustKind,
    cryptographicIdentityClaimed: review.cryptographicIdentityClaimed,
    callerSecretMatched: review.callerSecretMatched,
    externalTrustAnchorVerified: review.externalTrustAnchorVerified,
    hostAttestation: review.hostAttestation,
  };
}

function parseChecksumManifest(path, artifactRoot) {
  const entries = new Map();
  for (const [index, rawLine] of readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+[* ]?(.+)$/i);
    requireCondition(match, `checksum manifest: invalid line ${index + 1}`);
    const candidate = resolve(artifactRoot, match[2].replaceAll("/", "\\"));
    requireCondition(insideRoot(artifactRoot, candidate), `checksum manifest: path escapes task cwd at line ${index + 1}`);
    const key = normalizedPath(candidate);
    requireCondition(!entries.has(key), `checksum manifest: duplicate path at line ${index + 1}`);
    entries.set(key, match[1].toLowerCase());
  }
  return entries;
}

function normalizeFacts(
  facts,
  artifactRoot,
  promptArtifact,
  rolloutArtifact,
  taskStartedAtMs,
  rolloutToolEvidence,
  hostReviewRequestSource,
  hostReviewReceiptSource,
  rolloutSha256,
  hostSecret,
) {
  requireCondition(
    facts?.schema === "anticodex-autonomous-video-deliverable-facts-v1",
    "deliverable-facts: unsupported schema",
  );
  const forbidden = forbiddenFactKey(facts);
  requireCondition(!forbidden, `deliverable-facts: forbidden task/provider/release metadata at ${forbidden}`);
  const rawArtifacts = Array.isArray(facts?.artifacts) ? facts.artifacts : [];
  requireCondition(rawArtifacts.length >= 8, "deliverable-facts: at least eight product artifacts are required");
  const artifacts = rawArtifacts.map((artifact) => (
    fileArtifact(artifact?.path, String(artifact?.role || ""), artifactRoot, { taskStartedAtMs })
  ));
  requireCondition(
    new Set(artifacts.map((artifact) => normalizedPath(artifact.path))).size === artifacts.length,
    "deliverable-facts: artifact paths are not unique",
  );
  requireCondition(
    new Set(artifacts.map((artifact) => basename(artifact.path).toLowerCase())).size === artifacts.length,
    "deliverable-facts: artifact basenames must be unique for native tool correlation",
  );
  requireCondition(
    artifacts.every((artifact) => rolloutToolEvidence.includes(basename(artifact.path).toLowerCase())),
    "deliverable-facts: product artifact is absent from native rollout tool evidence",
  );
  requireCondition(
    productRequiredRoles.every((role) => artifacts.some((artifact) => artifact.role === role)),
    "deliverable-facts: required product roles are incomplete",
  );
  requireCondition(
    artifacts.filter((artifact) => artifact.role === "main-video").length === 1
      && artifacts.filter((artifact) => artifact.role === "release-video").length >= 3
      && artifacts.filter((artifact) => artifact.role === "checksum-manifest").length === 1,
    "deliverable-facts: main, release-video, or checksum-manifest cardinality is invalid",
  );
  const byPath = new Map(artifacts.map((artifact) => [normalizedPath(artifact.path), artifact]));
  const reference = (fact, role, label) => {
    const artifact = byPath.get(normalizedPath(fact?.path));
    requireCondition(artifact?.role === role, `deliverable-facts: ${label} is not bound to role ${role}`);
    return artifact;
  };
  const mainVideoArtifact = reference(facts?.mainVideo, "main-video", "main video");
  const releaseVideoArtifacts = (Array.isArray(facts?.releaseVideos) ? facts.releaseVideos : [])
    .map((video) => reference(video, "release-video", "release video"));
  const subtitleArtifact = reference(facts?.subtitle, "subtitle", "subtitle");
  const lipSyncArtifact = reference(facts?.lipSync, "lipsync-report", "lip-sync report");
  const mediaQaArtifact = reference(facts?.mediaQa, "media-qa-report", "media QA report");
  const verified = mediaVerification({
    mainPath: mainVideoArtifact.path,
    releasePaths: releaseVideoArtifacts.map((artifact) => artifact.path),
    subtitlePath: subtitleArtifact.path,
  });
  const evaluator = normalizeHostReview({
    requestSource: hostReviewRequestSource,
    receiptSource: hostReviewReceiptSource,
    mainVideo: mainVideoArtifact,
    mainDurationSeconds: verified.mainVideo.durationSeconds,
    taskCwd: artifactRoot,
    rolloutSha256,
    hostSecret,
  });
  const mainVideo = {
    ...mainVideoArtifact,
    ...verified.mainVideo,
    ...evaluator.visual,
  };
  const releaseByPath = new Map(verified.releaseVideos.map((video) => [normalizedPath(video.path), video]));
  const releaseVideos = releaseVideoArtifacts.map((artifact) => ({
    ...artifact,
    ...releaseByPath.get(normalizedPath(artifact.path)),
  }));
  const subtitle = {
    ...subtitleArtifact,
    ...verified.subtitle,
    ...evaluator.subtitle,
  };
  const audio = {
    ...verified.audio,
    ...evaluator.audio,
  };
  const lipSync = {
    ...lipSyncArtifact,
    sourceVideoSha256: evaluator.sourceVideoSha256,
    evaluator: evaluator.evaluator,
    evaluatorVersion: evaluator.evaluatorVersion,
    contractVersion: evaluator.contractVersion,
    ...evaluator.lipSync,
  };
  const mediaQa = {
    ...mediaQaArtifact,
    sourceVideoSha256: mainVideoArtifact.sha256,
    passed: true,
    ...verified.mediaQa,
  };
  const manifest = reference(
    { path: facts?.package?.manifestPath },
    "checksum-manifest",
    "checksum manifest",
  );
  const packageArtifacts = artifacts.filter((artifact) => artifact.role !== "checksum-manifest");
  const checksumEntries = parseChecksumManifest(manifest.path, artifactRoot);
  requireCondition(
    checksumEntries.size === packageArtifacts.length
      && packageArtifacts.every((artifact) => checksumEntries.get(normalizedPath(artifact.path)) === artifact.sha256),
    "checksum manifest: hashes are incomplete or do not match the product artifacts",
  );

  return {
    artifacts: [...artifacts, promptArtifact, rolloutArtifact],
    deliverable: {
      artifactRoot,
      mainVideo,
      releaseVideos,
      subtitle,
      audio,
      lipSync,
      mediaQa,
      package: {
        manifest,
        fileCount: packageArtifacts.length,
        checksumsVerified: true,
        hashManifestComplete: true,
        requiredRoles: packageRequiredRoles,
      },
    },
    mediaVerification: {
      schema: "anticodex-gate8-local-media-verification-v1",
      mode: "local-ffmpeg-ffprobe",
      tools: verified.tools,
      hostReview: {
        trustKind: evaluator.trustKind,
        cryptographicIdentityClaimed: evaluator.cryptographicIdentityClaimed,
        callerSecretMatched: evaluator.callerSecretMatched,
        externalTrustAnchorVerified: evaluator.externalTrustAnchorVerified,
        hostAttestation: evaluator.hostAttestation,
        requestPath: hostReviewRequestSource.path,
        requestSha256: hostReviewRequestSource.sha256,
        receiptPath: hostReviewReceiptSource.path,
        receiptSha256: hostReviewReceiptSource.sha256,
        schema: hostReviewReceiptSource.data.schema,
        name: evaluator.evaluator,
        version: evaluator.evaluatorVersion,
        contractVersion: evaluator.contractVersion,
      },
    },
  };
}

function validateTaskReceipt(source, rolloutPath) {
  const raw = source.data;
  const rollout = raw?.startupEvidence?.rollout || {};
  const native = raw?.startupEvidence?.native || {};
  const activity = native?.activity || {};
  const upstream = raw?.startupEvidence?.upstream || {};
  const request = upstream?.request || {};
  const response = upstream?.response || {};
  const taskId = String(rollout?.taskId || rollout?.sessionId || "");
  requireCondition(raw?.ok === true
    && raw?.singleSubmitHandoff === true
    && raw?.coverageKind === "desktop-ui-single-submit-handoff"
    && raw?.requestedRealTraffic === true
    && raw?.usedRealTraffic === true
    && Number(raw?.maximumSendClicks) === 1
    && Number(raw?.sendClickCount) === 1
    && raw?.sendDispatched === true
    && raw?.waitedForTaskCompletion === false
    && raw?.harnessInterruptedTask === false
    && raw?.harnessSubmittedAdditionalTurns === false,
  "task-receipt: not a successful one-shot native handoff");
  requireCondition(rollout?.ok === true
    && rollout?.newTask === true
    && nativeIdPattern.test(taskId)
    && rollout?.cwdMatched === true
    && rollout?.modelMatched === true
    && rollout?.promptSeen === true
    && samePath(rollout?.file, rolloutPath),
  "task-receipt: rollout/task/cwd/model evidence is incomplete");
  requireCondition(native?.ok === true
    && native?.reason === "task_bound_native_request"
    && native?.expectedRequestObserved === true
    && String(native?.taskId || "") === taskId
    && Array.isArray(activity?.expectedThreadIds)
    && activity.expectedThreadIds.length === 1
    && activity.expectedThreadIds[0] === taskId
    && Array.isArray(activity?.unexpectedRequestThreadIds)
    && activity.unexpectedRequestThreadIds.length === 0
    && Array.isArray(activity?.unexpectedExecutionThreadIds)
    && activity.unexpectedExecutionThreadIds.length === 0
    && activity?.titleThreadsUsedTools === false
    && activity?.taskSuggestionThreadsUsedTools === false,
  "task-receipt: native request is not exclusively bound to the rollout task");
  requireCondition(upstream?.ok === true
    && request?.relayId === "anticodex-antigravity"
    && Number(request?.candidateCount) === 1
    && Number(request?.requestTools?.count) >= 1
    && Number(request?.upstreamTools?.count) >= 1
    && response?.relayId === request?.relayId
    && response?.endpoint === request?.endpoint
    && Number(response?.attempt) === Number(request?.attempt)
    && Number(response?.candidateCount) === 1
    && Number(response?.statusCode) >= 200
    && Number(response?.statusCode) < 300,
  "task-receipt: tool-bearing provider request/response evidence is incomplete");
  return raw;
}

function writeSignedAtomic(path, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, body, "utf8");
  renameSync(temporary, path);
  const sidecar = `${path}.sha256`;
  const temporarySidecar = `${sidecar}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporarySidecar, `sha256:${sha256(body)}\n`, "ascii");
  renameSync(temporarySidecar, sidecar);
}

async function main() {
  rmSync(outputPath, { force: true });
  rmSync(`${outputPath}.sha256`, { force: true });
  const missing = requiredFlags.filter((flag) => values(flag).length !== 1);
  requireCondition(missing.length === 0, `missing or repeated required arguments: ${missing.join(", ")}`);
  const hostSecret = readHostReviewSecretFromStdin();
  try {

  const taskReceipt = readSignedJson(value("--task-receipt"), "task-receipt");
  const rollout = readRollout(value("--rollout"));
  const rolloutSha256 = sha256(rollout.bytes);
  const rawReceipt = validateTaskReceipt(taskReceipt, rollout.path);
  const releaseSource = readSignedJson(value("--release-binding-evidence"), "release-binding-evidence");
  const releaseBinding = releaseSource.data?.releaseBinding || releaseSource.data;
  const currentReleaseBinding = createCurrentReleaseBinding({
    sourceRoot: repoRoot,
    reportRoot: releaseReportRoot,
  });
  requireCondition(
    releaseBindingsEqual(releaseBinding, currentReleaseBinding),
    "release-binding-evidence: binding is not the current source/runtime release",
  );

  const promptPath = resolve(String(rawReceipt.promptFile || ""));
  requireCondition(existsSync(promptPath) && statSync(promptPath).isFile(), "task-receipt: total-goal prompt is missing");
  const promptBytes = readFileSync(promptPath);
  const promptText = promptBytes.toString("utf8").replace(/^\uFEFF/, "");
  const promptSha256 = sha256(Buffer.from(promptText, "utf8"));
  requireCondition(promptSha256 === String(rawReceipt.promptSha256 || "").toLowerCase(),
    "task-receipt: total-goal prompt hash changed");
  const markers = [...new Set(promptText.match(/UI_[A-Z0-9_]{12,}/g) || [])];
  requireCondition(markers.length === 1, "task-receipt: total-goal prompt must contain one unique final marker");
  const marker = markers[0];

  const derived = deriveRolloutEvidence({
    rollout,
    receipt: rawReceipt,
    promptText,
    promptSha256,
    marker,
  });
  const signedTaskStartedAtMs = Date.parse(String(rawReceipt.taskStartedAt || ""));
  const sessionMeta = rollout.records.find((record) => record?.type === "session_meta");
  const rolloutTaskStartedAtMs = Date.parse(String(
    sessionMeta?.timestamp || sessionMeta?.payload?.timestamp || "",
  ));
  requireCondition(
    Number.isFinite(signedTaskStartedAtMs)
      && Number.isFinite(rolloutTaskStartedAtMs)
      && Math.abs(signedTaskStartedAtMs - rolloutTaskStartedAtMs) <= 5 * 60_000,
    "task-receipt: signed task start does not match the native rollout session",
  );
  const taskStartedAtMs = Math.min(signedTaskStartedAtMs, rolloutTaskStartedAtMs);
  requireCondition(
    String(rawReceipt.startupEvidence.rollout.taskId || rawReceipt.startupEvidence.rollout.sessionId) === derived.taskId,
    "task-receipt: signed task id differs from native rollout",
  );

  const providerEvidence = deriveTrustedProviderReceipts(rollout.records);
  const providerPriority = providerEvidence.priority;
  const componentBinding = {
    version: releaseBinding.codexPlusPlusVersion,
    patchCommit: releaseBinding.codexPlusPlusPatchCommit,
    binarySha256: releaseBinding.codexPlusPlusBinarySha256,
  };
  const providerReceipts = providerEvidence.receipts.map((receipt) => ({
    ...receipt,
    taskId: derived.taskId,
    cwd: derived.cwd,
    promptSha256,
    component: componentBinding,
  }));
  requireCondition(providerReceipts.length === derived.turns.length
    && derived.turns.every((turn, index) => (
      providerReceipts[index]?.turnId === turn.turnId
      && providerReceipts[index]?.provider === turn.provider
      && providerReceipts[index]?.model === turn.model
    )),
  "rollout provider evidence is not bound to every native task turn");
  derived.turns = derived.turns.map((turn, index) => ({
    ...turn,
    status: providerReceipts[index].terminalKind === "native-task-complete"
      ? "completed"
      : providerReceipts[index].terminalKind === "native-client-interruption"
        ? "interrupted"
        : "provider-error",
  }));
  const providerFallbacks = providerEvidence.fallbacks.map((fallback) => ({
    ...fallback,
    taskId: derived.taskId,
  }));
  const providerRecoveries = providerEvidence.recoveries.map((recovery) => ({
    ...recovery,
    taskId: derived.taskId,
  }));

  const hostReviewRequestSource = readHostJson(
    value("--host-review-request"),
    "host-review-request",
  );
  const hostReviewReceiptSource = readHostJson(
    value("--host-review-receipt"),
    "host-review-receipt",
  );
  const supervisorStatusSource = readSupervisorStatus();
  const processRows = readOwnedProcessSnapshot(supervisorStatusSource.data);
  const postTaskWitness = validatePostTaskHostBoundary({
    records: rollout.records,
    taskId: derived.taskId,
    taskCwd: derived.cwd,
    reviewPaths: [hostReviewRequestSource.path, hostReviewReceiptSource.path],
    reviewGeneratedAtUtc: hostReviewReceiptSource.data?.generatedAtUtc,
    status: supervisorStatusSource.data,
    processRows,
    trustedHostProcessIds: [Number(rawReceipt?.processIdentity?.originalCodexPid || 0)],
  });
  requireCondition(
    String(hostReviewRequestSource.data?.taskId || "") === derived.taskId
      && String(hostReviewRequestSource.data?.turnId || "") === postTaskWitness.finalTurnId
      && String(hostReviewRequestSource.data?.taskCompletedAtUtc || "")
        === postTaskWitness.taskCompletedAtUtc,
    "host review request is not bound to the native terminal task and turn",
  );

  const factsPath = resolve(value("--deliverable-facts"));
  requireCondition(existsSync(factsPath) && statSync(factsPath).isFile(), "deliverable-facts: file is missing");
  requireCondition(insideRoot(derived.cwd, factsPath), "deliverable-facts: file is outside the native task cwd");
  requireCondition(statSync(factsPath).mtimeMs >= taskStartedAtMs,
    "deliverable-facts: file predates the signed native task start");
  const facts = readJson(factsPath, "deliverable-facts");
  requireCondition(
    isFreshReleaseEvidence(facts, { maxAgeHours: maxSourceAgeHours })
      && Date.parse(String(facts?.generatedAtUtc || "")) >= taskStartedAtMs,
    "deliverable-facts: content timestamp is missing, stale, or predates the task",
  );
  const rolloutToolEvidence = rollout.records
    .filter((record) => record?.type === "response_item"
      && ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "local_shell_call"]
        .includes(String(record?.payload?.type || "")))
    .map((record) => JSON.stringify(record))
    .join("\n")
    .toLowerCase();
  const promptArtifact = fileArtifact(promptPath, "total-goal-prompt", derived.cwd, { allowExternal: true });
  const rolloutArtifact = fileArtifact(rollout.path, "native-rollout", derived.cwd, { allowExternal: true });
  const normalizedFacts = normalizeFacts(
    facts,
    derived.cwd,
    promptArtifact,
    rolloutArtifact,
    taskStartedAtMs,
    rolloutToolEvidence,
    hostReviewRequestSource,
    hostReviewReceiptSource,
    rolloutSha256,
    hostSecret,
  );
  const builderSha256 = sha256(readFileSync(builderScriptPath));
  const hostWitness = createEphemeralGate8Witness({
    taskId: derived.taskId,
    finalTurnId: postTaskWitness.finalTurnId,
    taskCompletedAtUtc: postTaskWitness.taskCompletedAtUtc,
    rolloutSha256: rolloutArtifact.sha256,
    mainVideoSha256: normalizedFacts.deliverable.mainVideo.sha256,
    hostReviewRequestSha256: hostReviewRequestSource.sha256,
    hostReviewReceiptSha256: hostReviewReceiptSource.sha256,
    builderSha256,
    ffmpegPath: normalizedFacts.mediaVerification.tools.ffmpeg.path,
    ffmpegSha256: normalizedFacts.mediaVerification.tools.ffmpeg.sha256,
    ffprobePath: normalizedFacts.mediaVerification.tools.ffprobe.path,
    ffprobeSha256: normalizedFacts.mediaVerification.tools.ffprobe.sha256,
  });

  const candidate = buildGate8AutonomousVideoReport({
    generatedAt: new Date().toISOString(),
    sourceTaskUsedRealTraffic: true,
    releaseBinding,
    task: {
      newTask: true,
      nativeTask: true,
      taskId: derived.taskId,
      primaryTurnId: derived.primaryTurnId,
      cwd: derived.cwd,
      rolloutPath: rolloutArtifact.path,
      rolloutSha256: rolloutArtifact.sha256,
      sameTaskThroughout: true,
      finalState: "completed",
      prompt: {
        path: promptArtifact.path,
        sha256: promptArtifact.sha256,
        marker,
        totalGoal: true,
        submissionCount: 1,
        hostIntermediatePromptCount: derived.hostIntermediatePromptCount,
      },
      turns: derived.turns.map(({ index: _index, ...turn }) => turn),
      interruptions: derived.interruptions,
      continuations: derived.continuations,
    },
    providerPolicy: { priority: providerPriority },
    providerReceipts,
    providerFallbacks,
    providerRecoveries,
    postTaskWitness,
    autonomousExecution: {
      planCreated: derived.planUpdateCount >= 1,
      planUpdateCount: derived.planUpdateCount,
      toolCallCount: derived.toolCallCount,
      fileActionCount: derived.fileActionCount,
      sameTask: true,
      finalMarkerSeen: derived.finalMarkerSeen,
      finalMarker: marker,
      hostIntermediatePromptCount: derived.hostIntermediatePromptCount,
      postFinalToolCallCount: derived.postFinalToolCallCount,
    },
    ...normalizedFacts,
    sourceEvidence: {
      taskReceipt: { path: taskReceipt.path, sha256: taskReceipt.sha256 },
      rollout: { path: rolloutArtifact.path, sha256: rolloutArtifact.sha256 },
      releaseBinding: { path: releaseSource.path, sha256: releaseSource.sha256 },
      deliverableFacts: { path: factsPath, sha256: sha256(readFileSync(factsPath)) },
      hostReview: {
        requestPath: hostReviewRequestSource.path,
        requestSha256: hostReviewRequestSource.sha256,
        receiptPath: hostReviewReceiptSource.path,
        receiptSha256: hostReviewReceiptSource.sha256,
        trustKind: "host-human-review",
        cryptographicHostIdentity: false,
        callerSecretMatched: normalizedFacts.mediaVerification.hostReview.callerSecretMatched,
        externalTrustAnchorVerified:
          normalizedFacts.mediaVerification.hostReview.externalTrustAnchorVerified,
        hostAttestation: normalizedFacts.mediaVerification.hostReview.hostAttestation,
      },
      postTaskSupervisor: {
        path: supervisorStatusSource.path,
        sha256: sha256(readFileSync(supervisorStatusSource.path)),
        processSnapshotCount: processRows.length,
      },
      builder: {
        schema: "anticodex-gate8-source-builder-v1",
        path: builderScriptPath,
        sha256: builderSha256,
        mode: "offline-local-media-verifier",
      },
      hostWitness,
    },
  });
  const validationFailures = validateGate8AutonomousVideoReport(candidate);
  requireCondition(candidate.ok === true && validationFailures.length === 0,
    `Gate 8 source evidence validation failed: ${validationFailures.join("; ") || candidate.failures.join("; ")}`);
  writeSignedAtomic(outputPath, candidate);
  return {
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    taskId: derived.taskId,
    turnCount: derived.turns.length,
    artifactCount: candidate.artifacts.length,
    output: outputPath,
    outputSigned: true,
    failures: [],
  };
  } finally {
    hostSecret.fill(0);
  }
}

try {
  const result = await main();
  console.log(compact ? JSON.stringify(result) : JSON.stringify(result, null, 2));
} catch (error) {
  rmSync(outputPath, { force: true });
  rmSync(`${outputPath}.sha256`, { force: true });
  const result = {
    ok: false,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    output: outputPath,
    outputSigned: false,
    failures: [String(error?.message || error)],
  };
  console.log(compact ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  process.stderr.write(`${result.failures[0]}\n`);
  process.exitCode = 1;
}
