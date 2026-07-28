import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
} from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MIN_LONG_CONTEXT_CHARS = 65_536;
const MAX_QUOTA_PROBE_AGE_MS = 10 * 60_000;
const MULTI_STYLE_JOURNEYS = Object.freeze({
  "interrupted-migration-three-turn": 3,
  "greenfield-project-three-turn": 4,
});
const GATE8_PRODUCT_REVIEW_FIELDS = Object.freeze([
  ["画面", "picture", ["合格", "不够鲜艳", "不够清晰", "不连贯", "不像真人", "观感不好"]],
  ["口型", "lipSync", ["合格", "没有对上", "不自然", "看不清"]],
  ["主题", "theme", ["合格", "不符合"]],
  ["故事逻辑", "storyLogic", ["合格", "不成立", "不完整", "节奏不好"]],
  ["对白", "dialogue", ["合格", "听不清", "不自然"]],
  ["音乐", "music", ["合格", "缺失", "不协调", "压住对白"]],
  ["字幕", "subtitles", ["合格", "缺失", "不准确", "看不清"]],
  ["发布包", "releasePackage", ["合格", "不完整", "无法使用"]],
]);
const GATE8_PRODUCT_REVIEW_SUFFIX = "。结论：验收未通过。请自行检查原因并继续修改，反复复验直到原总目标真实通过。";

export function parseGate8ProductReview(value) {
  const text = String(value ?? "");
  const prefix = "成品评价：";
  if (!text.startsWith(prefix) || !text.endsWith(GATE8_PRODUCT_REVIEW_SUFFIX)) return null;
  const body = text.slice(prefix.length, -GATE8_PRODUCT_REVIEW_SUFFIX.length);
  const parts = body.split("；");
  if (parts.length !== GATE8_PRODUCT_REVIEW_FIELDS.length) return null;
  const review = {};
  for (let index = 0; index < GATE8_PRODUCT_REVIEW_FIELDS.length; index += 1) {
    const [label, key, allowed] = GATE8_PRODUCT_REVIEW_FIELDS[index];
    const expectedPrefix = `${label}=`;
    if (!parts[index].startsWith(expectedPrefix)) return null;
    const rating = parts[index].slice(expectedPrefix.length);
    if (!allowed.includes(rating)) return null;
    review[key] = rating;
  }
  if (Object.values(review).every((rating) => rating === "合格")) return null;
  const canonical = `${prefix}${GATE8_PRODUCT_REVIEW_FIELDS
    .map(([label, key]) => `${label}=${review[key]}`)
    .join("；")}${GATE8_PRODUCT_REVIEW_SUFFIX}`;
  return canonical === text ? review : null;
}

export function isNormalNativeTaskComplete(record) {
  if (record?.type !== "event_msg" || record?.payload?.type !== "task_complete") return false;
  const error = record.payload.error;
  return error == null || (typeof error === "string" && error.trim() === "");
}

export async function fetchJsonWithRetry(fetchImpl, url, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  const delayMs = Math.max(0, Number(options.delayMs ?? 300));
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 8_000));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`request returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
    }
  }
  throw lastError;
}

export function countTurnStaleConflicts(turns = []) {
  return turns.reduce((count, turn) => {
    const failureText = [turn?.failures, turn?.error, turn?.stderr]
      .flat(Infinity)
      .map((value) => String(value || ""))
      .join("\n");
    return count + (/\b409\s+Conflict\b|unexpected status 409\b/i.test(failureText) ? 1 : 0);
  }, 0);
}

export function createTerminalProviderStopGate() {
  let failure = null;
  return {
    get failure() {
      return failure;
    },
    assertCanStart(context = {}) {
      if (!failure) return;
      const error = new Error(
        `terminal provider failure already observed at ${failure.turnId || "unknown turn"}: ${failure.message}`,
      );
      error.code = "ANTICODEX_TERMINAL_PROVIDER_STOP";
      error.terminalProviderStop = failure;
      error.nextTurn = {
        journeyId: String(context.journeyId || ""),
        turnId: String(context.turnId || ""),
      };
      throw error;
    },
    observe(turn = {}) {
      const message = String(turn?.reconnectOutcome?.terminalProviderError || "").trim();
      if (!message || failure) return failure;
      failure = {
        journeyId: String(turn.journeyId || ""),
        turnId: String(turn.turnId || ""),
        message,
        usedRealTraffic: turn.usedRealTraffic === true,
        turn,
      };
      return failure;
    },
  };
}

export function evaluateHistoryReopenEvidence({
  initialThreadId = "",
  historyTurn = {},
  sameChatEvidence = {},
  filesUnchanged = false,
  historyOpenBudgetMs = 5_000,
} = {}) {
  const history = historyTurn?.history || {};
  const threadId = String(history.threadId || "");
  const expectedThreadId = String(initialThreadId || "");
  const actualMouseClick = sameChatEvidence.actualMouseClick === true;
  const navigatedAwayFirst = sameChatEvidence.navigatedAwayFirst === true;
  const visibleIdleAfterClick = sameChatEvidence.visibleIdleAfterClick?.ok === true;
  const openLatencyMs = Number(sameChatEvidence.openLatencyMs || 0);
  const completionSeen = history.assistantFinalMarkerSeen === true
    || (historyTurn.resultDrivenCompletionObserved === true && history.taskCompleteSeen === true);
  const resumedSameTask = expectedThreadId !== ""
    && threadId === expectedThreadId
    && actualMouseClick
    && navigatedAwayFirst
    && filesUnchanged === true
    && history.toolOutputSeen === true
    && completionSeen;
  const responsive = visibleIdleAfterClick
    && Number.isFinite(openLatencyMs)
    && openLatencyMs <= Math.max(250, Number(historyOpenBudgetMs || 0));
  return {
    ok: resumedSameTask && responsive,
    initialThreadId: expectedThreadId,
    threadId,
    threadMatched: threadId !== "" && threadId === expectedThreadId,
    actualMouseClick,
    navigatedAwayFirst,
    resumedSameTask,
    responsive,
    openLatencyMs,
    visibleIdleAfterClick,
    filesUnchanged: filesUnchanged === true,
  };
}

export function failedLaunchEvidenceProvesSingleAttempt({
  failedLaunchCount = 0,
  commands = [],
  diagnosis = null,
} = {}) {
  const startCommands = commands.filter((command) => /start-service\.mjs/i.test(String(command?.command || "")));
  return Number(failedLaunchCount) === 1
    && startCommands.length === 1
    && commands.length === 2
    && Number(commands[0]?.exitCode) !== 0
    && Number(commands[1]?.exitCode) === 0
    && diagnosis?.state === "failed"
    && diagnosis?.reason === "CONFIG_MISSING"
    && Number(diagnosis?.attempts) === 1;
}

export function countDuplicateCommands(commands = [], { allowDuplicate = null } = {}) {
  const seenSinceMutation = new Map();
  let duplicates = 0;
  for (const entry of commands) {
    const command = String(entry?.command ?? entry ?? "");
    const toolName = String(entry?.toolName || entry?.tool_name || "").toLowerCase();
    const mutatesFiles = /^(apply_patch|edit_file|write_file)$/.test(toolName)
      || /^\s*\*\*\* Begin Patch\b/i.test(command);
    if (mutatesFiles) {
      seenSinceMutation.clear();
      continue;
    }
    const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) continue;
    const repeatIndex = Number(seenSinceMutation.get(normalized) || 0);
    if (repeatIndex > 0) {
      const allowed = typeof allowDuplicate === "function"
        && allowDuplicate({ entry, command, normalized, repeatIndex }) === true;
      if (!allowed) duplicates += 1;
    }
    seenSinceMutation.set(normalized, repeatIndex + 1);
  }
  return duplicates;
}

export function allowMigrationIdempotencyDuplicate({ normalized = "", repeatIndex = 0 } = {}) {
  if (Number(repeatIndex) !== 1) return false;
  const command = String(normalized).trim();
  return /^node(?:\.exe)?\s+[.\\/]*migrate\.mjs\b/i.test(command)
    || /^get-filehash\b.*\bnormalized\.json\b.*\brejects\.ndjson\b.*\bmigration-summary\.json\b/i.test(command)
    || /^get-childitem(?:\s|$)/i.test(command)
    || /^node(?:\.exe)?\s+-e\s+(?:"console\.log\(require\('fs'\)\.readdirsync\('\.'\)\);?"|'console\.log\(require\("fs"\)\.readdirsync\("\."\)\);?')$/i.test(command);
}

export function resolveFixedRouteModel(routeHealth = {}, requestedModel = "") {
  const fixedRouteModel = String(routeHealth?.route?.model || routeHealth?.model || "").trim();
  if (!fixedRouteModel) throw new Error("fixed Antigravity route did not report a model");
  const requested = String(requestedModel || "").trim();
  if (requested && requested.toLowerCase() !== fixedRouteModel.toLowerCase()) {
    throw new Error(`selected model does not match the fixed Antigravity route: ${requested}`);
  }
  return fixedRouteModel;
}

function normalizeModelValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function modelValueMatchesExpected(value, expectedModel) {
  const actual = normalizeModelValue(value);
  const expected = normalizeModelValue(expectedModel);
  return Boolean(actual && expected && actual === expected);
}

function hasValidSha256Evidence(values) {
  return Array.isArray(values)
    && values.length > 0
    && values.every((value) => SHA256_PATTERN.test(String(value || "")));
}

export function correlateScopedCommandResultHashes(scopedCommands = [], toolOutputRecords = []) {
  const commandCallIds = new Set(scopedCommands
    .filter((entry) => String(entry?.command ?? entry ?? "").trim().length > 0)
    .map((entry) => String(entry?.callId || entry?.call_id || "").trim())
    .filter(Boolean));
  return [...new Set(toolOutputRecords
    .filter((record) => commandCallIds.has(String(record?.callId || record?.call_id || "").trim()))
    .map((record) => String(record?.text ?? record?.output ?? "").trim())
    .filter(Boolean)
    .map((text) => createHash("sha256").update(text, "utf8").digest("hex")))];
}

export function evaluateGate8TurnEvidence(turn = {}, selectedModel = "") {
  const history = turn?.history || {};
  const proof = turn?.modelProof || {};
  const proofSources = Array.isArray(proof?.proofSources) ? proof.proofSources : [];
  const allowedProofSources = new Set(["marker-scoped-submit", "new-model-route"]);
  const proofSourcesValid = proofSources.length > 0 && proofSources.every((source) => (
    allowedProofSources.has(String(source))
    && (source !== "marker-scoped-submit" || proof?.markerScopedSubmitMatched === true)
    && (source !== "new-model-route" || proof?.newRouteMatched === true)
  ));
  const observedModelMatched = Array.isArray(proof?.observedModels)
    && proof.observedModels.some((value) => modelValueMatchesExpected(value, selectedModel));
  const modelProofValid = turn?.actualModelProven === true
    && proof?.proven === true
    && modelValueMatchesExpected(turn?.requiredModel, selectedModel)
    && modelValueMatchesExpected(proof?.expectedModel, selectedModel)
    && modelValueMatchesExpected(proof?.requiredModel, selectedModel)
    && proof?.requiredModelMatches === true
    && proof?.selectionMatched === true
    && proof?.preSubmitSelectionMatched === true
    && proofSourcesValid
    && observedModelMatched;
  const nonEmptyScopedCommands = Array.isArray(history?.scopedCommands)
    ? history.scopedCommands.filter((entry) => String(entry?.command ?? entry ?? "").trim().length > 0)
    : [];
  const hasNonEmptyScopedCommand = nonEmptyScopedCommands.length > 0;
  const scopedCommandCallIds = nonEmptyScopedCommands
    .map((entry) => String(entry?.callId || entry?.call_id || "").trim());
  const scopedCommandCallIdsValid = scopedCommandCallIds.length > 0
    && scopedCommandCallIds.every(Boolean)
    && new Set(scopedCommandCallIds).size === scopedCommandCallIds.length;
  const nonEmptyToolOutputHashes = Array.isArray(history?.nonEmptyToolOutputHashes)
    ? history.nonEmptyToolOutputHashes.map((value) => String(value || ""))
    : [];
  const scopedCommandResultHashes = Array.isArray(history?.scopedCommandResultHashes)
    ? history.scopedCommandResultHashes.map((value) => String(value || ""))
    : [];
  const correlatedCommandResultEvidence = hasValidSha256Evidence(scopedCommandResultHashes)
    && scopedCommandResultHashes.every((hash) => nonEmptyToolOutputHashes.includes(hash));
  const rolloutToolOutputEvidence = history?.toolOutputSeen === true
    && hasValidSha256Evidence(nonEmptyToolOutputHashes)
    && correlatedCommandResultEvidence;
  const rolloutPreCommandEvidence = history?.preCommandExplanationSeen === true
    && hasValidSha256Evidence(history?.preCommandExplanationHashes);
  return {
    modelProofValid,
    hasNonEmptyScopedCommand,
    scopedCommandCallIdsValid,
    correlatedCommandResultEvidence,
    rolloutToolOutputEvidence,
    rolloutPreCommandEvidence,
  };
}

export function buildTurnModelProof(payload = {}, expectedModel = "") {
  const requiredModel = String(payload?.requiredModel || "").trim();
  const expected = String(expectedModel || "").trim();
  const requiredModelMatches = requiredModel !== ""
    && expected !== ""
    && requiredModel.toLowerCase() === expected.toLowerCase();
  const selectionMatched = payload?.modelSelectionEvidence?.matched === true;
  const preSubmitSelectionMatched = payload?.preSubmitModelSelectionEvidence?.matched === true;
  const submissions = [
    payload?.submitEvidence?.retryRealSubmit,
    payload?.submitEvidence?.realSubmit,
    payload?.submitEvidence?.nativeSubmit,
  ].filter(Boolean);
  const submitModels = submissions.flatMap((entry) => (
    Array.isArray(entry?.observedModels) ? entry.observedModels.map(String).filter(Boolean) : []
  ));
  const markerScopedSubmitMatched = submissions.some((entry) => (
    entry?.ok === true
    && entry?.markerScopedRequestObserved === true
    && entry?.requiredModelMatched === true
    && (Array.isArray(entry?.observedModels) ? entry.observedModels : [])
      .some((value) => modelValueMatchesExpected(value, expected))
  ));
  const modelRouteEvidence = payload?.modelRouteEvidence || {};
  const newRoutes = Number(modelRouteEvidence?.newRouteCount || 0) > 0
    ? (Array.isArray(modelRouteEvidence?.routes) ? modelRouteEvidence.routes : [])
    : [];
  const routeModels = newRoutes.flatMap((route) => [
    route?.requestedModel,
    route?.resolvedModel,
    route?.displayName,
    route?.internalModel,
  ].map((value) => String(value || "").trim()).filter(Boolean));
  const routeActualModels = newRoutes.flatMap((route) => [
    route?.resolvedModel,
    route?.displayName,
    route?.internalModel,
  ].map((value) => String(value || "").trim()).filter(Boolean));
  const newRouteMatched = routeActualModels
    .some((value) => modelValueMatchesExpected(value, expected));
  const proofSources = [];
  if (markerScopedSubmitMatched) proofSources.push("marker-scoped-submit");
  if (newRouteMatched) proofSources.push("new-model-route");
  const observedModels = [...new Set([...submitModels, ...routeModels])];
  const proven = payload?.usedRealTraffic === true
    && requiredModelMatches
    && selectionMatched
    && preSubmitSelectionMatched
    && proofSources.length > 0;
  return {
    proven,
    expectedModel: expected,
    requiredModel,
    requiredModelMatches,
    selectionMatched,
    preSubmitSelectionMatched,
    markerScopedSubmitMatched,
    newRouteMatched,
    proofSources,
    observedModels,
  };
}

export function auditCodexPlusPlusLogSegment(text = "") {
  const records = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  const responseRequests = records.filter((record) => requestMatches(record, "/v1/responses"));
  const compactRequests = records.filter((record) => requestMatches(record, "/v1/responses/compact"));
  const upstreamRequests = records.filter((record) => record?.event === "protocol_proxy.upstream_request");
  const staleConflictCount = records.filter((record) => {
    const statusCode = Number(record?.detail?.statusCode ?? String(record?.detail?.status ?? "").match(/^\d+/)?.[0]);
    return statusCode === 409;
  }).length;
  const duplicateRequestPairs = [];
  const sameSizeRequestPairs = [];
  const postRequests = [...responseRequests, ...compactRequests]
    .sort((left, right) => Number(left?.timestamp_ms || 0) - Number(right?.timestamp_ms || 0));
  for (let index = 1; index < postRequests.length; index += 1) {
    const previous = postRequests[index - 1];
    const current = postRequests[index];
    const elapsedMs = Number(current?.timestamp_ms || 0) - Number(previous?.timestamp_ms || 0);
    const sameSize = current?.detail?.path === previous?.detail?.path
      && Number(current?.detail?.body_bytes) > 0
      && Number(current?.detail?.body_bytes) === Number(previous?.detail?.body_bytes)
      && elapsedMs >= 0
      && elapsedMs <= 1_500;
    if (sameSize) {
      sameSizeRequestPairs.push({
        path: String(current.detail.path),
        bodyBytes: Number(current.detail.body_bytes),
        elapsedMs,
      });
    }
    const matchingIdentity = matchingRequestIdentity(previous, current);
    if (current?.detail?.path === previous?.detail?.path
      && matchingIdentity
      && elapsedMs >= 0
      && elapsedMs <= 1_500) {
      duplicateRequestPairs.push({
        path: String(current.detail.path),
        identityKind: matchingIdentity,
        elapsedMs,
      });
    }
  }
  return {
    parsedLineCount: records.length,
    responseRequestCount: responseRequests.length,
    compactRequestCount: compactRequests.length,
    upstreamRequestCount: upstreamRequests.length,
    allUpstreamChatCompletions: upstreamRequests.length > 0 && upstreamRequests.every((record) => (
      String(record?.detail?.endpoint || "") === "http://127.0.0.1:18488/v1/chat/completions"
      && String(record?.detail?.wireApi || "").toLowerCase() === "chatcompletions"
    )),
    staleConflictCount,
    duplicateRequestPairs,
    sameSizeRequestPairs,
  };
}

export function detectNativeCompactionEvidence(records = []) {
  const items = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    const type = String(value.type || "");
    if (["compaction", "compacted", "context_compaction", "context_compacted", "contextCompaction"].includes(type)) items.push(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(records);
  const summaries = items.map((item) => textValue(
    item.summary
    ?? item.message
    ?? item.content
    ?? item.text
    ?? item.payload?.summary
    ?? item.payload?.message
    ?? item.payload?.content
    ?? item.payload?.text,
  )).filter(Boolean);
  return {
    observed: items.length > 0,
    itemCount: items.length,
    summaryLength: summaries.reduce((maximum, value) => Math.max(maximum, value.length), 0),
    itemTypes: [...new Set(items.map((item) => String(item.type)))],
  };
}

export function retainJourneyTurnEvidence(...sources) {
  const retained = [];
  const indexes = new Map();
  const add = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const journeyId = String(value.journeyId || "");
    const turnId = String(value.turnId || "");
    const marker = String(value.marker || "");
    if (!journeyId && !turnId && !marker) return;
    const key = `${journeyId}\u0000${turnId}\u0000${marker}`;
    const existingIndex = indexes.get(key);
    if (existingIndex !== undefined) {
      retained[existingIndex] = { ...retained[existingIndex], ...value };
      return;
    }
    indexes.set(key, retained.length);
    retained.push(value);
  };
  for (const source of sources) add(source);
  return retained;
}

const NATIVE_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const AUTONOMOUS_VIDEO_COVERAGE = "native-single-task-single-goal-autonomous-live-action-video";
const REQUIRED_ARTIFACT_ROLES = Object.freeze([
  "main-video",
  "release-video",
  "subtitle",
  "lipsync-report",
  "media-qa-report",
  "checksum-manifest",
  "total-goal-prompt",
  "native-rollout",
]);
const REQUIRED_PACKAGE_ROLES = Object.freeze([
  "main-video",
  "release-video",
  "subtitle",
  "lipsync-report",
  "media-qa-report",
]);
const TRUSTED_EXTERNAL_EVIDENCE_ROLES = new Set(["total-goal-prompt", "native-rollout"]);
const STRUCTURED_PROVIDER_ERROR_CODES = new Set([
  "quota_exhausted",
  "rate_limit_exceeded",
  "resource_exhausted",
  "service_unavailable",
  "provider_unavailable",
]);
const TOOL_RESIDUE_NAMES = /^(?:cmd|conhost|powershell|pwsh|python|pythonw|node|ffmpeg|ffprobe|git|bash|sh)\.exe$/i;

function gate8Assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function recordTurnId(record, currentTurnId = "") {
  return String(
    record?.payload?.turn_id
    || record?.payload?.internal_chat_message_metadata_passthrough?.turn_id
    || currentTurnId
    || "",
  );
}

function modelProvider(modelValue) {
  const model = String(modelValue || "").toLowerCase();
  if (model.includes("gemini")) return "gemini";
  if (model.includes("claude")) return "claude";
  if (model.includes("third-party") || model.includes("gpt-")) return "third-party";
  return "";
}

function secondsFromSrtTimestamp(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  gate8Assertion(match, `subtitle timestamp is invalid: ${value}`);
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60)
    + Number(match[3]) + (Number(match[4]) / 1000);
}

export function parseTrustedSrtCues(textValue, durationSecondsValue) {
  const durationSeconds = Number(durationSecondsValue);
  gate8Assertion(Number.isFinite(durationSeconds) && durationSeconds > 0,
    "subtitle main duration is invalid");
  const blocks = String(textValue || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .filter((block) => block.trim());
  const cues = [];
  let previousStart = Number.NEGATIVE_INFINITY;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/).map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    gate8Assertion(timingIndex >= 0, `subtitle cue ${index + 1} has no timing`);
    const match = lines[timingIndex].trim().match(
      /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{3})$/,
    );
    gate8Assertion(match, `subtitle cue ${index + 1} timing is invalid`);
    const startSeconds = secondsFromSrtTimestamp(match[1]);
    const endSeconds = secondsFromSrtTimestamp(match[2]);
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    gate8Assertion(/[\u3400-\u9fff]/u.test(text),
      `subtitle Chinese text is missing from cue ${index + 1}`);
    gate8Assertion(endSeconds > startSeconds,
      `subtitle cue ${index + 1} duration is invalid`);
    gate8Assertion(startSeconds >= previousStart,
      `subtitle cue ${index + 1} is not ordered`);
    gate8Assertion(startSeconds >= previousEnd,
      `subtitle cue ${index + 1} overlaps the previous cue`);
    gate8Assertion(endSeconds <= durationSeconds + 0.001,
      `subtitle cue ${index + 1} exceeds main duration`);
    cues.push({ index: index + 1, startSeconds, endSeconds, text });
    previousStart = startSeconds;
    previousEnd = endSeconds;
  }
  gate8Assertion(cues.length >= 1, "subtitle has no cues");

  let coveredSeconds = 0;
  let unionStart = Number.NaN;
  let unionEnd = Number.NaN;
  for (const cue of cues) {
    if (!Number.isFinite(unionStart)) {
      unionStart = cue.startSeconds;
      unionEnd = cue.endSeconds;
      continue;
    }
    if (cue.startSeconds <= unionEnd) {
      unionEnd = Math.max(unionEnd, cue.endSeconds);
      continue;
    }
    coveredSeconds += unionEnd - unionStart;
    unionStart = cue.startSeconds;
    unionEnd = cue.endSeconds;
  }
  if (Number.isFinite(unionStart)) coveredSeconds += unionEnd - unionStart;
  return {
    cues,
    cueCount: cues.length,
    coveredSeconds,
    durationCoverageRatio: Math.min(1, coveredSeconds / durationSeconds),
  };
}

export function validateTrustedLipSyncWindows(windowsValue, durationSecondsValue) {
  const durationSeconds = Number(durationSecondsValue);
  gate8Assertion(Number.isFinite(durationSeconds) && durationSeconds > 0,
    "lip-sync main duration is invalid");
  const windows = Array.isArray(windowsValue) ? windowsValue : [];
  gate8Assertion(windows.length >= 5, "lip-sync requires at least five windows");
  const normalized = [];
  const ids = new Set();
  let previousStart = Number.NEGATIVE_INFINITY;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const [index, raw] of windows.entries()) {
    const id = String(raw?.id || "").trim();
    const speaker = String(raw?.speaker || "").trim();
    const faceTrackId = String(raw?.faceTrackId || "").trim();
    const startSeconds = Number(raw?.startSeconds);
    const endSeconds = Number(raw?.endSeconds);
    const offsetMs = Number(raw?.offsetMs);
    const mouthMotionScore = Number(raw?.mouthMotionScore);
    const avSyncScore = Number(raw?.avSyncScore);
    gate8Assertion(id && !ids.has(id), `lip-sync window ${index + 1} id is empty or duplicated`);
    gate8Assertion(speaker, `lip-sync window ${id} speaker is empty`);
    gate8Assertion(faceTrackId, `lip-sync window ${id} face track is empty`);
    gate8Assertion(Number.isFinite(startSeconds) && Number.isFinite(endSeconds)
      && startSeconds >= 0 && endSeconds > startSeconds,
    `lip-sync window ${id} timing is invalid`);
    gate8Assertion(startSeconds >= previousStart && startSeconds >= previousEnd,
      `lip-sync window ${id} is unordered or overlaps`);
    gate8Assertion(endSeconds <= durationSeconds + 0.001,
      `lip-sync window ${id} exceeds main duration`);
    gate8Assertion(Number.isFinite(offsetMs) && offsetMs >= 0 && offsetMs <= 500,
      `lip-sync window ${id} offset is invalid`);
    gate8Assertion(Number.isFinite(mouthMotionScore)
      && mouthMotionScore >= 0 && mouthMotionScore <= 1
      && Number.isFinite(avSyncScore)
      && avSyncScore >= 0 && avSyncScore <= 1,
    `lip-sync window ${id} score is outside 0..1`);
    gate8Assertion(mouthMotionScore >= 0.5 && avSyncScore >= 0.65,
      `lip-sync window ${id} score is below the acceptance threshold`);
    ids.add(id);
    previousStart = startSeconds;
    previousEnd = endSeconds;
    normalized.push({
      id,
      startSeconds,
      endSeconds,
      speaker,
      faceTrackId,
      offsetMs,
      mouthMotionScore,
      avSyncScore,
      passed: true,
    });
  }
  return normalized;
}

function structuredProviderErrorForTurn(records, turnId, provider) {
  const matches = records.filter((record) => {
    const payload = record?.payload || {};
    if (record?.type !== "event_msg"
      || payload?.type !== "provider_error"
      || String(payload?.turn_id || "") !== turnId
      || String(payload?.provider || "") !== provider) return false;
    const statusCode = Number(payload?.status_code);
    const errorCode = String(payload?.error_code || "");
    return [429, 503].includes(statusCode) && STRUCTURED_PROVIDER_ERROR_CODES.has(errorCode);
  });
  gate8Assertion(matches.length <= 1,
    `multiple structured provider errors exist for turn ${turnId}`);
  if (matches.length === 0) return null;
  const payload = matches[0].payload;
  return {
    statusCode: Number(payload.status_code),
    errorCode: String(payload.error_code),
    reasonKind: Number(payload.status_code) === 429 ? "quota-error" : "service-error",
    timestamp: String(matches[0].timestamp || ""),
  };
}

export function deriveTrustedProviderReceipts(recordsValue = []) {
  const records = Array.isArray(recordsValue) ? recordsValue : [];
  const turns = records
    .filter((record) => record?.type === "turn_context")
    .map((record) => ({
      turnId: String(record?.payload?.turn_id || ""),
      model: String(record?.payload?.model || record?.payload?.collaboration_mode?.settings?.model || ""),
      provider: modelProvider(
        record?.payload?.model || record?.payload?.collaboration_mode?.settings?.model,
      ),
      timestamp: String(record?.timestamp || ""),
    }));
  gate8Assertion(turns.length >= 1, "provider evidence has no native turn");
  gate8Assertion(turns.every((turn) => NATIVE_ID_PATTERN.test(turn.turnId)
    && turn.model && turn.provider),
  "provider evidence has an invalid native turn, model, or provider");
  gate8Assertion(turns[0].provider === "gemini",
    "provider state machine must start with Gemini");
  const receipts = turns.map((turn) => {
    const completions = records.filter((record) => (
      record?.type === "event_msg"
      && record?.payload?.type === "task_complete"
      && String(record?.payload?.turn_id || "") === turn.turnId
    ));
    const error = structuredProviderErrorForTurn(records, turn.turnId, turn.provider);
    const interruptions = records.filter((record) => (
      record?.type === "event_msg"
      && ["turn_aborted", "turn_interrupted"].includes(String(record?.payload?.type || ""))
      && String(record?.payload?.turn_id || "") === turn.turnId
    ));
    gate8Assertion(completions.length <= 1,
      `multiple task_complete events exist for turn ${turn.turnId}`);
    gate8Assertion(completions.every(isNormalNativeTaskComplete),
      `task_complete for turn ${turn.turnId} carries an error and is not a normal completion`);
    gate8Assertion(interruptions.length <= 1,
      `multiple client interruptions exist for turn ${turn.turnId}`);
    const terminalCount = completions.length + Number(Boolean(error)) + interruptions.length;
    gate8Assertion(terminalCount === 1,
      `turn ${turn.turnId} needs exactly one task_complete, structured provider error, or client interruption`);
    const completed = completions.length === 1;
    const interrupted = interruptions.length === 1;
    return {
      receiptId: `rollout-provider-${turn.turnId}`,
      turnId: turn.turnId,
      provider: turn.provider,
      model: turn.model,
      requestObserved: true,
      responseObserved: completed,
      terminalKind: completed
        ? "native-task-complete"
        : interrupted
          ? "native-client-interruption"
          : "structured-provider-error",
      statusCode: completed ? 200 : interrupted ? 0 : error.statusCode,
      errorCode: error?.errorCode || null,
      reasonKind: error?.reasonKind || null,
      terminalAtUtc: String(
        completions[0]?.timestamp || interruptions[0]?.timestamp || error?.timestamp || "",
      ),
    };
  });
  const priority = ["gemini", "claude", "third-party"];
  const fallbacks = [];
  const recoveries = [];
  for (let index = 1; index < receipts.length; index += 1) {
    const previous = receipts[index - 1];
    const current = receipts[index];
    const previousIndex = priority.indexOf(previous.provider);
    const currentIndex = priority.indexOf(current.provider);
    if (currentIndex === previousIndex) continue;
    if (currentIndex === previousIndex + 1) {
      gate8Assertion(previous.terminalKind === "structured-provider-error"
        && ["quota-error", "service-error"].includes(previous.reasonKind),
      `provider downgrade ${previous.provider} to ${current.provider} lacks a structured provider error`);
      fallbacks.push({
        explicitProviderError: true,
        from: previous.provider,
        to: current.provider,
        reasonKind: previous.reasonKind,
        turnId: previous.turnId,
      });
      continue;
    }
    if (currentIndex === 0 && previousIndex > 0) {
      const successfulRecovery = current.terminalKind === "native-task-complete"
        && current.responseObserved === true;
      const structuredRetryFailure = current.terminalKind === "structured-provider-error"
        && current.responseObserved === false
        && ["quota-error", "service-error"].includes(current.reasonKind);
      gate8Assertion(successfulRecovery || structuredRetryFailure,
        `provider recovery ${previous.provider} to Gemini lacks a trusted native retry`);
      recoveries.push({
        from: previous.provider,
        to: "gemini",
        turnId: current.turnId,
        credentialKind: successfulRecovery
          ? "native-task-complete"
          : "structured-provider-retry",
        terminalAtUtc: current.terminalAtUtc,
      });
      continue;
    }
    throw new Error(`provider transition ${previous.provider} to ${current.provider} is invalid`);
  }
  return { priority, receipts, fallbacks, recoveries };
}

function processField(row, camel, pascal) {
  return row?.[camel] ?? row?.[pascal];
}

function statusProcessIds(status) {
  const processes = status?.processes || {};
  return [
    processes.managerService,
    processes.codexPlusPlus,
    processes.managerWatcher,
    processes.managerBridge,
    ...(Array.isArray(processes.copiedClient) ? processes.copiedClient : []),
  ].map(Number).filter((value) => Number.isInteger(value) && value > 0);
}

function descendantProcessIds(rows, rootIds) {
  const descendants = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const pid = Number(processField(row, "processId", "ProcessId") || 0);
      const parentPid = Number(processField(row, "parentProcessId", "ParentProcessId") || 0);
      if (pid > 0 && descendants.has(parentPid) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return descendants;
}

function valueMentionsPath(value, targetPath) {
  const target = String(targetPath || "").toLowerCase();
  const targetForward = target.replaceAll("\\", "/");
  if (typeof value === "string") {
    const text = value.toLowerCase();
    if (text.includes(target) || text.replaceAll("\\", "/").includes(targetForward)) return true;
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return valueMentionsPath(JSON.parse(trimmed), targetPath);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((entry) => valueMentionsPath(entry, targetPath));
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => valueMentionsPath(entry, targetPath));
  }
  return false;
}

export function validatePostTaskHostBoundary({
  records: recordsValue = [],
  taskId,
  taskCwd,
  reviewPaths = [],
  reviewGeneratedAtUtc,
  status = {},
  processRows: processRowsValue = [],
  trustedHostProcessIds: trustedHostProcessIdsValue = [],
} = {}) {
  const records = Array.isArray(recordsValue) ? recordsValue : [];
  const processRows = Array.isArray(processRowsValue) ? processRowsValue : [];
  const session = records.find((record) => record?.type === "session_meta");
  gate8Assertion(String(session?.payload?.id || session?.payload?.session_id || "") === String(taskId || ""),
    "post-task witness task id differs from native rollout");
  gate8Assertion(normalizedPath(session?.payload?.cwd) === normalizedPath(taskCwd),
    "post-task witness cwd differs from native rollout");
  const turns = records.filter((record) => record?.type === "turn_context");
  gate8Assertion(turns.length >= 1, "post-task witness has no native turn");
  const finalTurnId = String(turns.at(-1)?.payload?.turn_id || "");
  const completions = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record?.type === "event_msg"
      && record?.payload?.type === "task_complete"
      && String(record?.payload?.turn_id || "") === finalTurnId);
  gate8Assertion(completions.length === 1, "native task is not terminal");
  const completion = completions[0];
  const taskCompletedAtUtc = String(completion.record?.timestamp || "");
  const completedAtMs = Date.parse(taskCompletedAtUtc);
  gate8Assertion(Number.isFinite(completedAtMs), "native task terminal timestamp is invalid");
  const taskStartedAtMs = Date.parse(String(session?.timestamp || session?.payload?.timestamp || ""));
  gate8Assertion(Number.isFinite(taskStartedAtMs) && taskStartedAtMs <= completedAtMs,
    "native task start timestamp is invalid");
  const reviewAtMs = Date.parse(String(reviewGeneratedAtUtc || ""));
  gate8Assertion(Number.isFinite(reviewAtMs) && reviewAtMs > completedAtMs,
    "host review was not generated after native task complete");
  for (const path of reviewPaths.map(String)) {
    gate8Assertion(isAbsolute(path) && !pathIsInside(taskCwd, path)
      && normalizedPath(path) !== normalizedPath(taskCwd),
    "host review path must be outside the native task cwd");
    gate8Assertion(!records.some((record) => valueMentionsPath(record, path)),
    "host review path appeared in the native rollout");
  }
  const activeAfterComplete = records.slice(completion.index + 1).some((record) => (
    record?.type === "turn_context"
    || (record?.type === "event_msg"
      && ["task_started", "user_message"].includes(String(record?.payload?.type || "")))
    || (record?.type === "response_item"
      && ["function_call", "custom_tool_call", "local_shell_call"]
        .includes(String(record?.payload?.type || "")))
  ));
  gate8Assertion(!activeAfterComplete, "native task remained active after task_complete");
  gate8Assertion(status?.schema === "anticodex-fixed-route-status-v1"
    && status?.state === "ready",
  "Anti-Codex supervisor status is not ready");
  const ownedIds = statusProcessIds(status);
  gate8Assertion(ownedIds.length >= 3, "Anti-Codex supervisor process identity is incomplete");
  gate8Assertion(processRows.length > 0, "post-task process snapshot is missing");
  const descendantIds = descendantProcessIds(processRows, ownedIds);
  const ownedIdSet = new Set(ownedIds);
  const trustedHostProcessIds = (Array.isArray(trustedHostProcessIdsValue)
    ? trustedHostProcessIdsValue
    : [])
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const trustedHostDescendantIds = descendantProcessIds(processRows, trustedHostProcessIds);
  const residue = processRows.filter((row) => {
    const pid = Number(processField(row, "processId", "ProcessId") || 0);
    if (ownedIdSet.has(pid) || trustedHostDescendantIds.has(pid)) return false;
    const name = String(processField(row, "name", "Name") || "");
    const commandLine = String(processField(row, "commandLine", "CommandLine") || "");
    if (descendantIds.has(pid)) {
      return TOOL_RESIDUE_NAMES.test(name)
        || (taskCwd && normalizedPath(commandLine).includes(normalizedPath(taskCwd)));
    }
    const createdAtMs = Date.parse(String(
      processField(row, "creationTimeUtc", "CreationTimeUtc") || "",
    ));
    return Number.isFinite(createdAtMs)
      && createdAtMs >= taskStartedAtMs
      && createdAtMs <= completedAtMs;
  });
  gate8Assertion(residue.length === 0,
    `post-task tool/background residue remains: ${residue.map((row) => (
      `${processField(row, "name", "Name") || "process"}:${processField(row, "processId", "ProcessId") || "?"}`
    )).join(", ")}`);
  return {
    taskTerminal: true,
    taskCompletedAtUtc,
    finalTurnId,
    supervisorState: status.state,
    residueProcessCount: residue.length,
    reviewPathsOutsideTask: true,
  };
}

const HOST_REVIEW_ATTESTATION_KEYS = Object.freeze([
  "algorithm",
  "cryptographicHostIdentity",
  "nonce",
  "schema",
  "signatureBase64",
  "trustKind",
]);
const EXTERNAL_HOST_TRUST_ANCHOR_CONFIGURED = false;

function hostReviewContainsSelfKey(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:secret|secretBase64|privateKey|publicKey|verificationKey|hmacKey)$/i.test(key)) return true;
    if (hostReviewContainsSelfKey(nested, seen)) return true;
  }
  return false;
}

function hostReviewConclusion(receipt = {}) {
  return {
    liveAction: receipt?.liveAction === true,
    continuousHumanFootage: receipt?.continuousHumanFootage === true,
    visibleSpeaking: receipt?.visibleSpeaking === true,
    observedSpeakingSeconds: Number(receipt?.observedSpeakingSeconds),
    dialoguePresent: receipt?.dialoguePresent === true,
    musicPresent: receipt?.musicPresent === true,
    subtitleLanguage: String(receipt?.subtitleLanguage || ""),
    subtitleBurnedIn: receipt?.subtitleBurnedIn === true,
    lipSyncWindows: (Array.isArray(receipt?.lipSyncWindows) ? receipt.lipSyncWindows : [])
      .map((window) => ({
        id: String(window?.id || ""),
        startSeconds: Number(window?.startSeconds),
        endSeconds: Number(window?.endSeconds),
        speaker: String(window?.speaker || ""),
        faceTrackId: String(window?.faceTrackId || ""),
        offsetMs: Number(window?.offsetMs),
        mouthMotionScore: Number(window?.mouthMotionScore),
        avSyncScore: Number(window?.avSyncScore),
      })),
  };
}

function hostReviewHmacPayload({
  nonce,
  request = {},
  requestSha256,
  receipt = {},
  rolloutSha256,
  requestPath,
  receiptPath,
} = {}) {
  return {
    schema: "anticodex-gate8-host-review-hmac-payload-v1",
    nonce: String(nonce || ""),
    taskId: String(request?.taskId || ""),
    turnId: String(request?.turnId || ""),
    rolloutSha256: String(rolloutSha256 || "").toLowerCase(),
    requestSha256: String(requestSha256 || "").toLowerCase(),
    mainVideoSha256: String(request?.mainVideoSha256 || "").toLowerCase(),
    taskCompletedAtUtc: String(request?.taskCompletedAtUtc || ""),
    reviewGeneratedAtUtc: String(receipt?.generatedAtUtc || ""),
    requestPath: resolve(String(requestPath || "")),
    receiptPath: resolve(String(receiptPath || "")),
    reviewConclusion: hostReviewConclusion(receipt),
  };
}

function requireExternalHostReviewSecret(secret) {
  gate8Assertion(Buffer.isBuffer(secret) && secret.length === 32,
    "host review external secret is missing or invalid");
  return secret;
}

export function createHostReviewHmacAttestation({
  secret,
  request = {},
  requestSha256,
  receipt = {},
  rolloutSha256,
  requestPath,
  receiptPath,
} = {}) {
  requireExternalHostReviewSecret(secret);
  gate8Assertion(!hostReviewContainsSelfKey(receipt),
    "host review receipt contains a forbidden self-key");
  gate8Assertion(SHA256_PATTERN.test(String(rolloutSha256 || "")),
    "host review rollout SHA-256 is invalid");
  const nonce = randomBytes(32).toString("hex");
  const payload = hostReviewHmacPayload({
    nonce,
    request,
    requestSha256,
    receipt,
    rolloutSha256,
    requestPath,
    receiptPath,
  });
  const signatureBase64 = createHmac("sha256", secret)
    .update(jsonBytes(payload))
    .digest("base64");
  return {
    schema: "anticodex-gate8-host-review-hmac-v1",
    algorithm: "HMAC-SHA256",
    trustKind: "caller-integrity-only",
    cryptographicHostIdentity: false,
    nonce,
    signatureBase64,
  };
}

export function verifyHostReviewHmacAttestation({
  secret,
  request = {},
  requestSha256,
  receipt = {},
  rolloutSha256,
  requestPath,
  receiptPath,
} = {}) {
  requireExternalHostReviewSecret(secret);
  gate8Assertion(!hostReviewContainsSelfKey(receipt),
    "host review receipt contains a forbidden self-key");
  const attestation = receipt?.hostAttestation || {};
  gate8Assertion(
    Object.keys(attestation).sort().join(",") === [...HOST_REVIEW_ATTESTATION_KEYS].sort().join(","),
    "host review attestation has an unexpected self-key or field",
  );
  gate8Assertion(attestation?.schema === "anticodex-gate8-host-review-hmac-v1"
    && attestation?.algorithm === "HMAC-SHA256"
    && attestation?.trustKind === "caller-integrity-only"
    && attestation?.cryptographicHostIdentity === false
    && /^[a-f0-9]{64}$/i.test(String(attestation?.nonce || "")),
  "host review HMAC attestation schema, algorithm, or nonce is invalid");
  gate8Assertion(SHA256_PATTERN.test(String(rolloutSha256 || "")),
    "host review rollout SHA-256 is invalid");
  const supplied = Buffer.from(String(attestation?.signatureBase64 || ""), "base64");
  const expected = createHmac("sha256", secret)
    .update(jsonBytes(hostReviewHmacPayload({
      nonce: attestation.nonce,
      request,
      requestSha256,
      receipt,
      rolloutSha256,
      requestPath,
      receiptPath,
    })))
    .digest();
  gate8Assertion(supplied.length === expected.length && timingSafeEqual(supplied, expected),
    "host review HMAC signature is invalid");
  return {
    callerSecretMatched: true,
    externalTrustAnchorVerified: false,
    hostAttestation: {
      schema: attestation.schema,
      algorithm: attestation.algorithm,
      trustKind: attestation.trustKind,
      cryptographicHostIdentity: attestation.cryptographicHostIdentity,
      nonce: attestation.nonce,
      signatureBase64: attestation.signatureBase64,
    },
  };
}

export function validateHostHumanReviewReceipt({
  request = {},
  requestSha256,
  receipt = {},
  rolloutSha256,
  hostSecret,
  taskCwd,
  requestPath,
  receiptPath,
} = {}) {
  gate8Assertion(isAbsolute(String(requestPath || ""))
    && isAbsolute(String(receiptPath || ""))
    && !pathIsInside(taskCwd, requestPath)
    && !pathIsInside(taskCwd, receiptPath)
    && normalizedPath(requestPath) !== normalizedPath(taskCwd)
    && normalizedPath(receiptPath) !== normalizedPath(taskCwd),
  "host review request and receipt must be outside the native task cwd");
  gate8Assertion(request?.schema === "anticodex-gate8-host-review-request-v1",
    "host review request schema is invalid");
  gate8Assertion(receipt?.schema === "anticodex-gate8-host-human-review-v1"
    && receipt?.trustKind === "host-human-review",
  "host review receipt trust kind or schema is invalid");
  gate8Assertion(SHA256_PATTERN.test(String(requestSha256 || ""))
    && String(receipt?.requestSha256 || "").toLowerCase() === String(requestSha256).toLowerCase(),
  "host review receipt is not bound to the generated request hash");
  gate8Assertion(SHA256_PATTERN.test(String(request?.mainVideoSha256 || ""))
    && String(receipt?.mainVideoSha256 || "").toLowerCase()
      === String(request.mainVideoSha256).toLowerCase(),
  "host review receipt main video hash binding is invalid");
  const completedAtMs = Date.parse(String(request?.taskCompletedAtUtc || ""));
  const requestAtMs = Date.parse(String(request?.generatedAtUtc || ""));
  const receiptAtMs = Date.parse(String(receipt?.generatedAtUtc || ""));
  gate8Assertion(Number.isFinite(completedAtMs)
    && Number.isFinite(requestAtMs)
    && Number.isFinite(receiptAtMs)
    && requestAtMs > completedAtMs
    && receiptAtMs > requestAtMs,
  "host review request and receipt must be generated after native task complete");
  const samples = Array.isArray(request?.samples) ? request.samples : [];
  gate8Assertion(samples.length >= 6 && samples.every((sample) => (
    isAbsolute(String(sample?.path || ""))
    && SHA256_PATTERN.test(String(sample?.sha256 || ""))
    && Number.isFinite(Number(sample?.timestampSeconds))
  )), "host review request lacks six builder-generated hashed frame samples");
  const requestedWindows = Array.isArray(request?.windows) ? request.windows : [];
  const receiptWindows = Array.isArray(receipt?.lipSyncWindows) ? receipt.lipSyncWindows : [];
  gate8Assertion(requestedWindows.length >= 5
    && requestedWindows.every((window) => (
      String(window?.id || "").trim()
      && String(window?.speaker || "").trim()
      && String(window?.faceTrackId || "").trim()
      && Number.isFinite(Number(window?.startSeconds))
      && Number.isFinite(Number(window?.endSeconds))
      && isAbsolute(String(window?.clipPath || ""))
      && SHA256_PATTERN.test(String(window?.clipSha256 || ""))
    ))
    && receiptWindows.length === requestedWindows.length
    && requestedWindows.every((window, index) => (
      String(window?.id || "") === String(receiptWindows[index]?.id || "")
      && Number(window?.startSeconds) === Number(receiptWindows[index]?.startSeconds)
      && Number(window?.endSeconds) === Number(receiptWindows[index]?.endSeconds)
      && String(window?.speaker || "") === String(receiptWindows[index]?.speaker || "")
      && String(window?.faceTrackId || "") === String(receiptWindows[index]?.faceTrackId || "")
    )),
  "host review lip-sync windows do not match the generated request");
  gate8Assertion(receipt?.liveAction === true
    && receipt?.continuousHumanFootage === true
    && receipt?.visibleSpeaking === true
    && Number(receipt?.observedSpeakingSeconds) >= 10
    && receipt?.dialoguePresent === true
    && receipt?.musicPresent === true
    && receipt?.subtitleLanguage === "zh-CN"
    && receipt?.subtitleBurnedIn === true,
  "host human review did not prove live action, speaking, audio, or burned-in subtitles");
  const hmac = verifyHostReviewHmacAttestation({
    secret: hostSecret,
    request,
    requestSha256,
    receipt,
    rolloutSha256,
    requestPath,
    receiptPath,
  });
  gate8Assertion(EXTERNAL_HOST_TRUST_ANCHOR_CONFIGURED,
    "external host trust anchor is not configured; caller self-HMAC is integrity-only");
  return {
    trustKind: "host-human-review",
    cryptographicIdentityClaimed: false,
    callerSecretMatched: hmac.callerSecretMatched,
    externalTrustAnchorVerified: hmac.externalTrustAnchorVerified,
    hostAttestation: hmac.hostAttestation,
    liveAction: true,
    continuousHumanFootage: true,
    visibleSpeaking: true,
    observedSpeakingSeconds: Number(receipt.observedSpeakingSeconds),
    dialoguePresent: true,
    musicPresent: true,
    subtitleLanguage: "zh-CN",
    subtitleBurnedIn: true,
    lipSyncWindows: receiptWindows,
  };
}

export function validateMediaToolIdentity(identity = {}) {
  const path = String(identity?.path || "");
  gate8Assertion(String(identity?.name || ""), "media tool name is missing");
  gate8Assertion(isAbsolute(path), "media tool executable path must be absolute");
  gate8Assertion(SHA256_PATTERN.test(String(identity?.sha256 || "")),
    "media tool executable SHA-256 is invalid");
  gate8Assertion(String(identity?.version || ""), "media tool version is missing");
  return {
    name: String(identity.name),
    path: resolve(path),
    sha256: String(identity.sha256).toLowerCase(),
    version: String(identity.version),
  };
}

export function createEphemeralGate8Witness(payload = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const challenge = randomBytes(32).toString("hex");
  const signedPayload = {
    ...payload,
    challenge,
  };
  const signature = signBytes(null, jsonBytes(signedPayload), privateKey).toString("base64");
  privateKey.export({ type: "pkcs8", format: "der" }).fill(0);
  return {
    schema: "anticodex-gate8-ephemeral-witness-v1",
    algorithm: "Ed25519",
    trustKind: "in-process-integrity-only",
    cryptographicHostIdentity: false,
    payload: signedPayload,
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    signatureBase64: signature,
  };
}

export function verifyEphemeralGate8Witness(witness = {}) {
  try {
    if (witness?.schema !== "anticodex-gate8-ephemeral-witness-v1"
      || witness?.algorithm !== "Ed25519"
      || witness?.trustKind !== "in-process-integrity-only"
      || witness?.cryptographicHostIdentity !== false
      || !/^[a-f0-9]{64}$/i.test(String(witness?.payload?.challenge || ""))) {
      return { ok: false };
    }
    const key = {
      key: Buffer.from(String(witness.publicKeySpkiBase64 || ""), "base64"),
      type: "spki",
      format: "der",
    };
    const ok = verifyBytes(
      null,
      jsonBytes(witness.payload),
      key,
      Buffer.from(String(witness.signatureBase64 || ""), "base64"),
    );
    return { ok };
  } catch {
    return { ok: false };
  }
}

function normalizedPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

function pathIsInside(root, candidate) {
  const normalizedRoot = normalizedPath(root);
  const normalizedCandidate = normalizedPath(candidate);
  return normalizedRoot !== ""
    && normalizedCandidate !== normalizedRoot
    && normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function artifactMatches(left, right) {
  return normalizedPath(left?.path) === normalizedPath(right?.path)
    && String(left?.role || "") === String(right?.role || "")
    && Number(left?.bytes || 0) === Number(right?.bytes || 0)
    && String(left?.sha256 || "").toLowerCase() === String(right?.sha256 || "").toLowerCase();
}

function validateArtifactReference(reference, artifactByPath, failures, label) {
  const artifact = artifactByPath.get(normalizedPath(reference?.path));
  if (!artifact || !artifactMatches(reference, artifact)) {
    failures.push(`${label} is not bound to the hashed artifact manifest`);
  }
}

function validateContinuationContract(task, failures) {
  const interruptions = Array.isArray(task?.interruptions) ? task.interruptions : [];
  const continuations = Array.isArray(task?.continuations) ? task.continuations : [];
  const turns = Array.isArray(task?.turns) ? task.turns : [];
  const turnIds = new Set(turns
    .map((turn) => String(turn?.turnId || ""))
    .filter(Boolean));
  const turnIndexById = new Map(turns.map((turn, index) => [String(turn?.turnId || ""), index]));
  const interruptionById = new Map(interruptions.map((entry) => [String(entry?.receiptId || ""), entry]));
  for (const continuation of continuations) {
    const interruption = interruptionById.get(String(continuation?.interruptionReceiptId || ""));
    if (String(continuation?.text || "").trim() !== "继续"
      || !interruption
      || !["client-interruption", "provider-quota", "provider-service"].includes(String(interruption?.kind || ""))
      || String(interruption?.taskId || "") !== String(task?.taskId || "")
      || String(continuation?.taskId || "") !== String(task?.taskId || "")
      || !turnIds.has(String(interruption?.turnId || ""))
      || !turnIds.has(String(continuation?.turnId || ""))) {
      failures.push("continuation is not an exact native resume after a proven interruption");
    }
  }
  if (task?.acceptanceFeedbacks !== undefined && !Array.isArray(task.acceptanceFeedbacks)) {
    failures.push("product review acceptance feedback list is invalid");
    return;
  }
  const feedbackTurnIds = new Set();
  for (const feedback of task?.acceptanceFeedbacks || []) {
    const feedbackTurnId = String(feedback?.turnId || "");
    const currentIndex = turnIndexById.get(String(feedback?.turnId || ""));
    const previousIndex = turnIndexById.get(String(feedback?.previousTurnId || ""));
    const previousTurn = Number.isInteger(previousIndex) ? turns[previousIndex] : null;
    if (!parseGate8ProductReview(feedback?.text)
      || String(feedback?.taskId || "") !== String(task?.taskId || "")
      || feedbackTurnIds.has(feedbackTurnId)
      || !Number.isInteger(currentIndex)
      || !Number.isInteger(previousIndex)
      || currentIndex !== previousIndex + 1
      || previousTurn?.status !== "completed") {
      failures.push("product review acceptance feedback is not bound to the immediately previous completed turn");
    }
    feedbackTurnIds.add(feedbackTurnId);
  }
}

function validateLipSyncEvidence(lipSync, failures, durationSeconds) {
  const windows = Array.isArray(lipSync?.windows) ? lipSync.windows : [];
  const ids = new Set();
  let previousStart = Number.NEGATIVE_INFINITY;
  let previousEnd = Number.NEGATIVE_INFINITY;
  let invalidWindow = false;
  for (const window of windows) {
    const id = String(window?.id || "");
    const speaker = String(window?.speaker || "").trim();
    const faceTrackId = String(window?.faceTrackId || "").trim();
    const startSeconds = Number(window?.startSeconds);
    const endSeconds = Number(window?.endSeconds);
    const offsetMs = Number(window?.offsetMs);
    const mouthMotionScore = Number(window?.mouthMotionScore);
    const avSyncScore = Number(window?.avSyncScore);
    if (!id
      || ids.has(id)
      || !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || startSeconds < 0
      || endSeconds <= startSeconds
      || startSeconds < previousStart
      || startSeconds < previousEnd
      || !Number.isFinite(Number(durationSeconds))
      || endSeconds > Number(durationSeconds) + 0.001
      || !speaker
      || !faceTrackId
      || !Number.isFinite(offsetMs)
      || offsetMs < 0
      || offsetMs > 500
      || !Number.isFinite(mouthMotionScore)
      || mouthMotionScore < 0.5
      || mouthMotionScore > 1
      || !Number.isFinite(avSyncScore)
      || avSyncScore < 0.65
      || avSyncScore > 1
      || window?.passed !== true) {
      invalidWindow = true;
    }
    ids.add(id);
    previousStart = startSeconds;
    previousEnd = endSeconds;
  }
  if (lipSync?.passed !== true
    || !String(lipSync?.evaluator || "")
    || !String(lipSync?.evaluatorVersion || "")
    || !String(lipSync?.contractVersion || "")
    || windows.length < 5
    || Number(lipSync?.aggregateDenominator) !== windows.length
    || Number(lipSync?.passCount) !== windows.length
    || invalidWindow) {
    failures.push("lip-sync evidence lacks five distinct non-overlapping passed speaking windows");
  }
}

export function validateGate8AutonomousVideoReport(report = {}) {
  const failures = [];
  if (report?.schema !== "anticodex-gate8-autonomous-video-v1"
    || report?.reportName !== "gate8-autonomous-live-action-video"
    || Number(report?.gate) !== 8
    || report?.coverageKind !== AUTONOMOUS_VIDEO_COVERAGE) {
    failures.push("Gate 8 schema is not the autonomous live-action video contract");
  }
  if (report?.ok !== true
    || report?.gateComplete !== true
    || report?.requestedRealTraffic !== false
    || report?.usedRealTraffic !== false
    || report?.sourceTaskUsedRealTraffic !== true
    || !Array.isArray(report?.failures)
    || report.failures.length !== 0) {
    failures.push("autonomous video result is incomplete");
  }

  const releaseBinding = report?.releaseBinding || {};
  const codexPlusPlusPatchCount = Number(releaseBinding?.codexPlusPlusPatchCount);
  if (releaseBinding?.schema !== "anticodex-release-binding-v1"
    || releaseBinding?.valid !== true
    || !String(releaseBinding?.officialShellVersion || "")
    || releaseBinding?.activeShellVersion !== releaseBinding?.officialShellVersion
    || !String(releaseBinding?.codexPlusPlusVersion || "")
    || !/^[0-9a-f]{40}$/i.test(String(releaseBinding?.codexPlusPlusPatchCommit || ""))
    || !SHA256_PATTERN.test(String(releaseBinding?.codexPlusPlusBinarySha256 || ""))
    || !SHA256_PATTERN.test(String(releaseBinding?.codexPlusPlusPatchTreeSha256 || ""))
    || !Number.isInteger(codexPlusPlusPatchCount)
    || codexPlusPlusPatchCount <= 0
    || !SHA256_PATTERN.test(String(releaseBinding?.syncReadinessSha256 || ""))) {
    failures.push("current release and CodexPlusPlus component binding is invalid");
  }

  const task = report?.task || {};
  const prompt = task?.prompt || {};
  const taskId = String(task?.taskId || "");
  const primaryTurnId = String(task?.primaryTurnId || "");
  const taskCwd = String(task?.cwd || "");
  const promptSha256 = String(prompt?.sha256 || "").toLowerCase();
  const turns = Array.isArray(task?.turns) ? task.turns : [];
  if (task?.newTask !== true
    || task?.nativeTask !== true
    || !NATIVE_ID_PATTERN.test(taskId)
    || !NATIVE_ID_PATTERN.test(primaryTurnId)
    || !taskCwd
    || task?.sameTaskThroughout !== true
    || task?.finalState !== "completed"
    || prompt?.totalGoal !== true
    || !String(prompt?.path || "")
    || !SHA256_PATTERN.test(promptSha256)
    || !String(prompt?.marker || "")
    || Number(prompt?.submissionCount) !== 1
    || Number(prompt?.hostIntermediatePromptCount) !== 0
    || !String(task?.rolloutPath || "")
    || !SHA256_PATTERN.test(String(task?.rolloutSha256 || ""))
    || turns.length < 1
    || !turns.some((turn) => String(turn?.turnId || "") === primaryTurnId)
    || turns.some((turn) => (
      !NATIVE_ID_PATTERN.test(String(turn?.turnId || ""))
      || String(turn?.taskId || "") !== taskId
      || normalizedPath(turn?.cwd) !== normalizedPath(taskCwd)
      || String(turn?.promptSha256 || "").toLowerCase() !== promptSha256
      || turn?.autonomous !== true
      || !["gemini", "claude", "third-party"].includes(String(turn?.provider || ""))
      || !String(turn?.model || "")
      || !["completed", "interrupted", "provider-error"].includes(String(turn?.status || ""))
    ))) {
    failures.push("native single-task single-goal task, turn, cwd, prompt, or rollout binding is invalid");
  }
  validateContinuationContract(task, failures);

  const providerPriority = report?.providerPolicy?.priority;
  if (!Array.isArray(providerPriority)
    || providerPriority.join(",") !== "gemini,claude,third-party") {
    failures.push("provider priority is not Gemini then Claude then third-party");
  }
  const providerReceipts = Array.isArray(report?.providerReceipts) ? report.providerReceipts : [];
  const receiptTurnIds = providerReceipts.map((receipt) => String(receipt?.turnId || ""));
  const validProviderTerminal = (receipt) => {
    const terminalKind = String(receipt?.terminalKind || "");
    const statusCode = Number(receipt?.statusCode);
    if (terminalKind === "native-task-complete") {
      return receipt?.responseObserved === true
        && statusCode >= 200
        && statusCode < 300
        && !receipt?.errorCode
        && !receipt?.reasonKind;
    }
    if (terminalKind === "structured-provider-error") {
      return receipt?.responseObserved === false
        && [429, 503].includes(statusCode)
        && STRUCTURED_PROVIDER_ERROR_CODES.has(String(receipt?.errorCode || ""))
        && String(receipt?.reasonKind || "") === (statusCode === 429 ? "quota-error" : "service-error");
    }
    return terminalKind === "native-client-interruption"
      && receipt?.responseObserved === false
      && statusCode === 0
      && !receipt?.errorCode
      && !receipt?.reasonKind;
  };
  if (providerReceipts.length !== turns.length
    || new Set(receiptTurnIds).size !== receiptTurnIds.length
    || providerReceipts.some((receipt) => {
      const turn = turns.find((entry) => String(entry?.turnId || "") === String(receipt?.turnId || ""));
      return !String(receipt?.receiptId || "")
        || String(receipt?.taskId || "") !== taskId
        || !turn
        || normalizedPath(receipt?.cwd) !== normalizedPath(taskCwd)
        || String(receipt?.promptSha256 || "").toLowerCase() !== promptSha256
        || !["gemini", "claude", "third-party"].includes(String(receipt?.provider || ""))
        || !String(receipt?.model || "")
        || String(turn?.provider || "") !== String(receipt?.provider || "")
        || String(turn?.model || "") !== String(receipt?.model || "")
        || receipt?.requestObserved !== true
        || !String(receipt?.terminalAtUtc || "")
        || !validProviderTerminal(receipt)
        || String(receipt?.component?.version || "") !== String(releaseBinding?.codexPlusPlusVersion || "")
        || String(receipt?.component?.patchCommit || "") !== String(releaseBinding?.codexPlusPlusPatchCommit || "")
        || String(receipt?.component?.binarySha256 || "").toLowerCase()
          !== String(releaseBinding?.codexPlusPlusBinarySha256 || "").toLowerCase();
    })) {
    failures.push("provider receipt is not bound to the current task, turn, cwd, prompt, and component");
  }
  const providerFallbacks = Array.isArray(report?.providerFallbacks) ? report.providerFallbacks : [];
  const providerRecoveries = Array.isArray(report?.providerRecoveries) ? report.providerRecoveries : [];
  const receiptByTurn = new Map(providerReceipts.map((receipt) => [String(receipt?.turnId || ""), receipt]));
  if (String(providerReceipts[0]?.provider || "") !== "gemini") {
    failures.push("provider state machine did not start with Gemini");
  }
  for (let index = 1; index < turns.length; index += 1) {
    const previousReceipt = receiptByTurn.get(String(turns[index - 1]?.turnId || ""));
    const currentReceipt = receiptByTurn.get(String(turns[index]?.turnId || ""));
    const previousProviderIndex = providerPriority.indexOf(String(previousReceipt?.provider || ""));
    const currentProviderIndex = providerPriority.indexOf(String(currentReceipt?.provider || ""));
    if (previousProviderIndex >= 0 && currentProviderIndex === previousProviderIndex) continue;
    if (previousProviderIndex >= 0 && currentProviderIndex === previousProviderIndex + 1) {
      const fallback = providerFallbacks.find((entry) => (
        entry?.explicitProviderError === true
        && String(entry?.from || "") === String(previousReceipt?.provider || "")
        && String(entry?.to || "") === String(currentReceipt?.provider || "")
        && String(entry?.turnId || "") === String(previousReceipt?.turnId || "")
        && String(entry?.taskId || "") === taskId
        && ["quota-error", "service-error"].includes(String(entry?.reasonKind || ""))
      ));
      if (!fallback
        || previousReceipt?.terminalKind !== "structured-provider-error"
        || previousReceipt?.reasonKind !== fallback?.reasonKind) {
        failures.push("provider switch lacks its turn-scoped structured unavailability receipt");
      }
      continue;
    }
    if (previousProviderIndex > 0 && currentProviderIndex === 0) {
      const successfulRecovery = currentReceipt?.terminalKind === "native-task-complete"
        && currentReceipt?.responseObserved === true;
      const structuredRetryFailure = currentReceipt?.terminalKind === "structured-provider-error"
        && currentReceipt?.responseObserved === false
        && ["quota-error", "service-error"].includes(String(currentReceipt?.reasonKind || ""));
      const credentialKind = successfulRecovery
        ? "native-task-complete"
        : "structured-provider-retry";
      const recovery = providerRecoveries.find((entry) => (
        String(entry?.from || "") === String(previousReceipt?.provider || "")
        && entry?.to === "gemini"
        && String(entry?.turnId || "") === String(currentReceipt?.turnId || "")
        && String(entry?.taskId || "") === taskId
        && entry?.credentialKind === credentialKind
      ));
      if (!recovery
        || (!successfulRecovery && !structuredRetryFailure)) {
        failures.push("return to Gemini lacks a trusted native recovery or structured retry turn");
      }
      continue;
    }
    failures.push("provider receipts do not follow Gemini then Claude then third-party or trusted Gemini recovery");
  }

  const execution = report?.autonomousExecution || {};
  if (execution?.planCreated !== true
    || Number(execution?.planUpdateCount) < 1
    || Number(execution?.toolCallCount) < 5
    || Number(execution?.fileActionCount) < 1
    || execution?.sameTask !== true
    || execution?.finalMarkerSeen !== true
    || String(execution?.finalMarker || "") !== String(prompt?.marker || "")
    || Number(execution?.hostIntermediatePromptCount) !== 0
    || Number(execution?.postFinalToolCallCount) !== 0) {
    failures.push("autonomous execution or zero host-intermediate-prompt contract is invalid");
  }

  const sourceBuilder = report?.sourceEvidence?.builder || {};
  const mediaVerification = report?.mediaVerification || {};
  const hostReview = mediaVerification?.hostReview || {};
  const sourceHostReview = report?.sourceEvidence?.hostReview || {};
  const hostReviewAttestation = hostReview?.hostAttestation || {};
  const sourceHostReviewAttestation = sourceHostReview?.hostAttestation || {};
  const postTaskWitness = report?.postTaskWitness || {};
  const ephemeralWitness = report?.sourceEvidence?.hostWitness || {};
  const ffprobe = mediaVerification?.tools?.ffprobe || {};
  const ffmpeg = mediaVerification?.tools?.ffmpeg || {};
  if (!EXTERNAL_HOST_TRUST_ANCHOR_CONFIGURED) {
    failures.push("external host trust anchor is not configured; caller self-HMAC is integrity-only");
  }
  if (sourceBuilder?.schema !== "anticodex-gate8-source-builder-v1"
    || sourceBuilder?.mode !== "offline-local-media-verifier"
    || !String(sourceBuilder?.path || "")
    || !SHA256_PATTERN.test(String(sourceBuilder?.sha256 || ""))) {
    failures.push("Gate 8 source builder provenance is missing or invalid");
  }
  if (mediaVerification?.schema !== "anticodex-gate8-local-media-verification-v1"
    || mediaVerification?.mode !== "local-ffmpeg-ffprobe"
    || ffprobe?.name !== "ffprobe"
    || !isAbsolute(String(ffprobe?.path || ""))
    || !SHA256_PATTERN.test(String(ffprobe?.sha256 || ""))
    || !String(ffprobe?.version || "")
    || ffmpeg?.name !== "ffmpeg"
    || !isAbsolute(String(ffmpeg?.path || ""))
    || !SHA256_PATTERN.test(String(ffmpeg?.sha256 || ""))
    || !String(ffmpeg?.version || "")
    || hostReview?.trustKind !== "host-human-review"
    || hostReview?.cryptographicIdentityClaimed !== false
    || hostReview?.callerSecretMatched !== true
    || hostReview?.externalTrustAnchorVerified !== false
    || Object.keys(hostReviewAttestation).sort().join(",")
      !== [...HOST_REVIEW_ATTESTATION_KEYS].sort().join(",")
    || hostReviewAttestation?.schema !== "anticodex-gate8-host-review-hmac-v1"
    || hostReviewAttestation?.algorithm !== "HMAC-SHA256"
    || hostReviewAttestation?.trustKind !== "caller-integrity-only"
    || hostReviewAttestation?.cryptographicHostIdentity !== false
    || !/^[a-f0-9]{64}$/i.test(String(hostReviewAttestation?.nonce || ""))
    || Buffer.from(String(hostReviewAttestation?.signatureBase64 || ""), "base64").length !== 32
    || hostReview?.schema !== "anticodex-gate8-host-human-review-v1"
    || !isAbsolute(String(hostReview?.requestPath || ""))
    || !isAbsolute(String(hostReview?.receiptPath || ""))
    || pathIsInside(taskCwd, hostReview?.requestPath)
    || pathIsInside(taskCwd, hostReview?.receiptPath)
    || !SHA256_PATTERN.test(String(hostReview?.requestSha256 || ""))
    || !SHA256_PATTERN.test(String(hostReview?.receiptSha256 || ""))
    || !String(hostReview?.name || "")
    || !String(hostReview?.version || "")
    || !String(hostReview?.contractVersion || "")
    || sourceHostReview?.trustKind !== "host-human-review"
    || sourceHostReview?.cryptographicHostIdentity !== false
    || sourceHostReview?.callerSecretMatched !== true
    || sourceHostReview?.externalTrustAnchorVerified !== false
    || Object.keys(sourceHostReviewAttestation).sort().join(",")
      !== [...HOST_REVIEW_ATTESTATION_KEYS].sort().join(",")
    || sourceHostReviewAttestation?.schema !== hostReviewAttestation?.schema
    || sourceHostReviewAttestation?.algorithm !== hostReviewAttestation?.algorithm
    || sourceHostReviewAttestation?.nonce !== hostReviewAttestation?.nonce
    || sourceHostReviewAttestation?.signatureBase64 !== hostReviewAttestation?.signatureBase64
    || normalizedPath(sourceHostReview?.requestPath) !== normalizedPath(hostReview?.requestPath)
    || normalizedPath(sourceHostReview?.receiptPath) !== normalizedPath(hostReview?.receiptPath)
    || String(sourceHostReview?.requestSha256 || "").toLowerCase()
      !== String(hostReview?.requestSha256 || "").toLowerCase()
    || String(sourceHostReview?.receiptSha256 || "").toLowerCase()
      !== String(hostReview?.receiptSha256 || "").toLowerCase()) {
    failures.push("local media tools or integrity-only caller-HMAC post-task host-human review provenance is invalid");
  }
  if (postTaskWitness?.taskTerminal !== true
    || !String(postTaskWitness?.taskCompletedAtUtc || "")
    || String(postTaskWitness?.finalTurnId || "") !== String(turns.at(-1)?.turnId || "")
    || postTaskWitness?.supervisorState !== "ready"
    || Number(postTaskWitness?.residueProcessCount) !== 0
    || postTaskWitness?.reviewPathsOutsideTask !== true) {
    failures.push("post-task terminal or zero-residue host boundary is invalid");
  }
  if (verifyEphemeralGate8Witness(ephemeralWitness).ok !== true) {
    failures.push("in-process integrity witness is missing or invalid");
  }

  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : [];
  const artifactPaths = artifacts.map((artifact) => normalizedPath(artifact?.path));
  const artifactByPath = new Map(artifacts.map((artifact) => [normalizedPath(artifact?.path), artifact]));
  const artifactRoot = String(report?.deliverable?.artifactRoot || "");
  if (artifacts.length < 10
    || artifactPaths.some((path) => !path)
    || new Set(artifactPaths).size !== artifactPaths.length
    || artifacts.some((artifact) => (
      !String(artifact?.role || "")
      || (!TRUSTED_EXTERNAL_EVIDENCE_ROLES.has(String(artifact?.role || ""))
        && !pathIsInside(artifactRoot, artifact?.path))
      || Number(artifact?.bytes) <= 0
      || !SHA256_PATTERN.test(String(artifact?.sha256 || ""))
    ))
    || REQUIRED_ARTIFACT_ROLES.some((role) => !artifacts.some((artifact) => artifact?.role === role))) {
    failures.push("hashed artifact manifest or release-package roles are incomplete");
  }
  if (normalizedPath(taskCwd) !== normalizedPath(artifactRoot)) {
    failures.push("deliverable root is not the native task cwd");
  }
  validateArtifactReference({
    role: "total-goal-prompt",
    path: prompt.path,
    bytes: artifactByPath.get(normalizedPath(prompt.path))?.bytes,
    sha256: prompt.sha256,
  }, artifactByPath, failures, "total-goal prompt");
  validateArtifactReference({
    role: "native-rollout",
    path: task.rolloutPath,
    bytes: artifactByPath.get(normalizedPath(task.rolloutPath))?.bytes,
    sha256: task.rolloutSha256,
  }, artifactByPath, failures, "native rollout");

  const deliverable = report?.deliverable || {};
  const mainVideo = deliverable?.mainVideo || {};
  const mainDurationSeconds = Number(mainVideo?.durationSeconds);
  const mainFrameRate = Number(mainVideo?.frameRate);
  validateArtifactReference(mainVideo, artifactByPath, failures, "main video");
  if (mainVideo?.role !== "main-video"
    || mainVideo?.decodable !== true
    || mainVideo?.liveAction !== true
    || mainVideo?.continuousHumanFootage !== true
    || mainVideo?.visibleSpeaking !== true
    || !Number.isFinite(mainDurationSeconds)
    || mainDurationSeconds < 45
    || mainDurationSeconds > 60
    || Number(mainVideo?.width) !== 1080
    || Number(mainVideo?.height) !== 1920
    || !Number.isFinite(mainFrameRate)
    || mainFrameRate < 20
    || !String(mainVideo?.videoCodec || "")) {
    failures.push("main video is not a decodable 45-60 second 1080x1920 continuous live-action speaking film");
  }

  const releaseVideos = Array.isArray(deliverable?.releaseVideos) ? deliverable.releaseVideos : [];
  if (releaseVideos.length < 3
    || new Set(releaseVideos.map((video) => normalizedPath(video?.path))).size !== releaseVideos.length
    || releaseVideos.some((video) => (
      video?.role !== "release-video"
      || video?.decodable !== true
      || !Number.isFinite(Number(video?.durationSeconds))
      || Number(video?.durationSeconds) < 45
      || Number(video?.durationSeconds) > 60
      || Number(video?.width) !== 1080
      || Number(video?.height) !== 1920
    ))) {
    failures.push("three platform-ready release videos were not proven");
  }
  for (const video of releaseVideos) validateArtifactReference(video, artifactByPath, failures, "release video");

  const subtitle = deliverable?.subtitle || {};
  const subtitleCueCount = Number(subtitle?.cueCount);
  const subtitleCoverage = Number(subtitle?.durationCoverageRatio);
  const subtitleCoveredSeconds = Number(subtitle?.coveredSeconds);
  const subtitleCues = Array.isArray(subtitle?.cues) ? subtitle.cues : [];
  let subtitlePreviousStart = Number.NEGATIVE_INFINITY;
  let subtitlePreviousEnd = Number.NEGATIVE_INFINITY;
  let subtitleUnionSeconds = 0;
  let subtitleCuesInvalid = false;
  for (const cue of subtitleCues) {
    const startSeconds = Number(cue?.startSeconds);
    const endSeconds = Number(cue?.endSeconds);
    const text = String(cue?.text || "");
    if (!Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || startSeconds < 0
      || endSeconds <= startSeconds
      || startSeconds < subtitlePreviousStart
      || startSeconds < subtitlePreviousEnd
      || endSeconds > mainDurationSeconds + 0.001
      || !/[\u3400-\u9fff]/u.test(text)) {
      subtitleCuesInvalid = true;
    }
    if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds) {
      subtitleUnionSeconds += endSeconds - startSeconds;
    }
    subtitlePreviousStart = startSeconds;
    subtitlePreviousEnd = endSeconds;
  }
  validateArtifactReference(subtitle, artifactByPath, failures, "Chinese subtitle");
  if (subtitle?.role !== "subtitle"
    || subtitle?.language !== "zh-CN"
    || subtitle?.burnedIn !== true
    || !Number.isFinite(subtitleCueCount)
    || subtitleCueCount < 5
    || subtitleCueCount !== subtitleCues.length
    || subtitleCuesInvalid
    || !Number.isFinite(subtitleCoveredSeconds)
    || Math.abs(subtitleCoveredSeconds - subtitleUnionSeconds) > 0.002
    || !Number.isFinite(subtitleCoverage)
    || Math.abs(subtitleCoverage - (subtitleUnionSeconds / mainDurationSeconds)) > 0.0001
    || subtitleCoverage < 0.8) {
    failures.push("Chinese subtitle coverage is incomplete");
  }

  const audio = deliverable?.audio || {};
  const audioSilenceRatio = Number(audio?.silenceRatio);
  const integratedLufs = Number(audio?.integratedLufs);
  const truePeakDb = Number(audio?.truePeakDb);
  if (audio?.streamPresent !== true
    || audio?.dialoguePresent !== true
    || audio?.musicPresent !== true
    || !Number.isFinite(audioSilenceRatio)
    || audioSilenceRatio < 0
    || audioSilenceRatio > 0.1
    || !Number.isFinite(integratedLufs)
    || integratedLufs < -24
    || integratedLufs > -8
    || !Number.isFinite(truePeakDb)
    || truePeakDb > -1) {
    failures.push("dialogue, music, silence, or loudness evidence is invalid");
  }

  const lipSync = deliverable?.lipSync || {};
  validateArtifactReference(lipSync, artifactByPath, failures, "lip-sync report");
  validateLipSyncEvidence(lipSync, failures, mainDurationSeconds);
  if (String(lipSync?.sourceVideoSha256 || "").toLowerCase() !== String(mainVideo?.sha256 || "").toLowerCase()) {
    failures.push("lip-sync report is not bound to the main source video hash");
  }

  const witnessPayload = ephemeralWitness?.payload || {};
  if (String(witnessPayload?.taskId || "") !== taskId
    || String(witnessPayload?.finalTurnId || "") !== String(postTaskWitness?.finalTurnId || "")
    || String(witnessPayload?.taskCompletedAtUtc || "") !== String(postTaskWitness?.taskCompletedAtUtc || "")
    || String(witnessPayload?.rolloutSha256 || "").toLowerCase()
      !== String(task?.rolloutSha256 || "").toLowerCase()
    || String(witnessPayload?.mainVideoSha256 || "").toLowerCase()
      !== String(mainVideo?.sha256 || "").toLowerCase()
    || String(witnessPayload?.hostReviewRequestSha256 || "").toLowerCase()
      !== String(hostReview?.requestSha256 || "").toLowerCase()
    || String(witnessPayload?.hostReviewReceiptSha256 || "").toLowerCase()
      !== String(hostReview?.receiptSha256 || "").toLowerCase()
    || String(witnessPayload?.builderSha256 || "").toLowerCase()
      !== String(sourceBuilder?.sha256 || "").toLowerCase()
    || normalizedPath(witnessPayload?.ffmpegPath) !== normalizedPath(ffmpeg?.path)
    || String(witnessPayload?.ffmpegSha256 || "").toLowerCase()
      !== String(ffmpeg?.sha256 || "").toLowerCase()
    || normalizedPath(witnessPayload?.ffprobePath) !== normalizedPath(ffprobe?.path)
    || String(witnessPayload?.ffprobeSha256 || "").toLowerCase()
      !== String(ffprobe?.sha256 || "").toLowerCase()) {
    failures.push("in-process integrity witness is not bound to the report inputs and media tools");
  }

  const mediaQa = deliverable?.mediaQa || {};
  const blackFrameRatio = Number(mediaQa?.blackFrameRatio);
  const freezeFrameRatio = Number(mediaQa?.freezeFrameRatio);
  const mediaSilenceRatio = Number(mediaQa?.silenceRatio);
  validateArtifactReference(mediaQa, artifactByPath, failures, "media QA report");
  if (mediaQa?.passed !== true
    || String(mediaQa?.sourceVideoSha256 || "").toLowerCase() !== String(mainVideo?.sha256 || "").toLowerCase()
    || mediaQa?.decodePassed !== true
    || mediaQa?.videoStreamPresent !== true
    || mediaQa?.audioStreamPresent !== true
    || mediaQa?.subtitlePresent !== true
    || mediaQa?.durationMatches !== true
    || !Number.isFinite(blackFrameRatio)
    || blackFrameRatio < 0
    || blackFrameRatio > 0.01
    || !Number.isFinite(freezeFrameRatio)
    || freezeFrameRatio < 0
    || freezeFrameRatio > 0.05
    || !Number.isFinite(mediaSilenceRatio)
    || mediaSilenceRatio < 0
    || mediaSilenceRatio > 0.1) {
    failures.push("decode, stream, duration, black-frame, freeze-frame, or silence media QA failed");
  }

  const packageEvidence = deliverable?.package || {};
  validateArtifactReference(packageEvidence?.manifest, artifactByPath, failures, "checksum manifest");
  const requiredRoles = Array.isArray(packageEvidence?.requiredRoles) ? packageEvidence.requiredRoles : [];
  const packagedArtifactCount = artifacts.filter((artifact) => (
    pathIsInside(artifactRoot, artifact?.path)
      && artifact?.role !== "checksum-manifest"
      && !TRUSTED_EXTERNAL_EVIDENCE_ROLES.has(String(artifact?.role || ""))
  )).length;
  if (packageEvidence?.checksumsVerified !== true
    || packageEvidence?.hashManifestComplete !== true
    || Number(packageEvidence?.fileCount) !== packagedArtifactCount
    || REQUIRED_PACKAGE_ROLES.some((role) => !requiredRoles.includes(role))) {
    failures.push("release package manifest, hashes, or required roles are incomplete");
  }

  return [...new Set(failures)];
}

export function buildGate8AutonomousVideoReport(input = {}) {
  const candidate = {
    ...input,
    schema: "anticodex-gate8-autonomous-video-v1",
    reportName: "gate8-autonomous-live-action-video",
    gate: 8,
    coverageKind: AUTONOMOUS_VIDEO_COVERAGE,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    ok: true,
    gateComplete: true,
    failures: [],
  };
  const failures = validateGate8AutonomousVideoReport(candidate);
  return {
    ...candidate,
    ok: failures.length === 0,
    gateComplete: failures.length === 0,
    failures,
  };
}

export function validateGate8MultiStyleReport(report = {}) {
  const failures = [];
  const requiredIds = Object.keys(MULTI_STYLE_JOURNEYS);
  const model = String(report?.model || "").trim();
  const journeyIds = Array.isArray(report?.journeyIds) ? report.journeyIds.map(String) : [];
  const journeys = Array.isArray(report?.journeys) ? report.journeys : [];
  const journeyById = new Map(journeys.map((journey) => [String(journey?.id || ""), journey]));

  if (report?.reportName !== "ui-human-long-journey") failures.push("multi-style report name is invalid");
  if (report?.ok !== true
    || report?.requestedRealTraffic !== true
    || report?.usedRealTraffic !== true
    || report?.behaviorCovered !== true
    || report?.coverageKind !== "desktop-ui-real-human-long-journey") {
    failures.push("multi-style real result is incomplete");
  }
  if (!model) failures.push("multi-style model is missing");
  if (report?.stoppedAfterTerminalProviderFailure === true) failures.push("multi-style run stopped on a terminal provider failure");
  if (!Array.isArray(report?.failures) || report.failures.length !== 0) failures.push("multi-style report contains failures");
  if (report?.workspaceRestore?.ok !== true) failures.push("multi-style workspace state was not restored");
  for (const id of requiredIds) {
    if (!journeyIds.includes(id) || !journeyById.has(id)) failures.push(`missing ${id} journey`);
  }
  if (journeyIds.length !== requiredIds.length || journeys.length !== requiredIds.length) {
    failures.push("multi-style report must contain exactly the two required journeys");
  }
  if (Number(report?.journeyCount) !== requiredIds.length
    || Number(report?.passedJourneyCount) !== requiredIds.length
    || Number(report?.resultValidatedJourneyCount) !== requiredIds.length
    || Number(report?.totalTurnCount) < 7
    || Number(report?.passedTurnCount) < 7) {
    failures.push("multi-style aggregate counts are incomplete");
  }

  for (const id of requiredIds) {
    const journey = journeyById.get(id);
    if (!journey) continue;
    const minimumTurns = MULTI_STYLE_JOURNEYS[id];
    const turns = Array.isArray(journey?.turns) ? journey.turns : [];
    if (journey?.ok !== true
      || journey?.usedRealTraffic !== true
      || !Array.isArray(journey?.failures)
      || journey.failures.length !== 0
      || Number(journey?.turnCount) < minimumTurns
      || Number(journey?.passedTurnCount) < minimumTurns
      || turns.length < minimumTurns) {
      failures.push(`${id} journey result is incomplete`);
    }
    for (const turn of turns) {
      const turnId = String(turn?.turnId || "unknown-turn");
      const history = turn?.history || {};
      const evaluated = evaluateGate8TurnEvidence(turn, model);
      if (turn?.ok !== true || turn?.usedRealTraffic !== true || turn?.workspaceCwdMatches !== true) {
        failures.push(`${id} ${turnId} did not complete in the expected workspace`);
      }
      if (!evaluated.modelProofValid) failures.push(`${id} ${turnId} model proof is invalid`);
      if (!evaluated.hasNonEmptyScopedCommand
        || !evaluated.scopedCommandCallIdsValid
        || !evaluated.rolloutToolOutputEvidence
        || !evaluated.rolloutPreCommandEvidence) {
        failures.push(`${id} ${turnId} lacks correlated command/result evidence`);
      }
      if (history?.chinesePreCommandSeen !== true) failures.push(`${id} ${turnId} lacks a Chinese pre-command explanation`);
      if (history?.assistantFinalMarkerSeen !== true && turn?.resultDrivenCompletionObserved !== true) {
        failures.push(`${id} ${turnId} lacks visible completion evidence`);
      }
      if (Number(history?.launchCommandCount || 0) !== 0
        || Number(history?.postFinalToolCallCount || 0) !== 0
        || Number(history?.postFinalToolOutputCount || 0) !== 0
        || Number(history?.duplicateCommandCount || 0) !== 0
        || history?.parseErrorSeen === true
        || Number(history?.scopeViolationCount || 0) !== 0) {
        failures.push(`${id} ${turnId} violated execution boundaries`);
      }
    }
  }

  const migration = journeyById.get("interrupted-migration-three-turn")?.artifactEvidence || {};
  for (const field of [
    "protectedFilesUnchanged",
    "testsPassed",
    "firstRunPassed",
    "secondRunPassed",
    "outputMatches",
    "summaryMatches",
    "rejectsExact",
    "idempotent",
    "staleTempAbsent",
  ]) {
    if (migration?.[field] !== true) failures.push(`migration ${field} result was not proven`);
  }
  if (Number(migration?.recoveryLaunchCommandCount || 0) !== 0) failures.push("migration recovery launched a program");
  if (!Array.isArray(migration?.unexpectedFiles) || migration.unexpectedFiles.length !== 0) failures.push("migration contains unexpected files");

  const greenfield = journeyById.get("greenfield-project-three-turn")?.artifactEvidence || {};
  for (const field of [
    "protectedFilesUnchanged",
    "testPassed",
    "cliJsonPassed",
    "cliTextPassed",
    "cliJsonHasExpectedValues",
    "readmeHasChinese",
    "htmlHasChinese",
    "htmlIsFullPage",
    "markerInHtml",
    "summaryPresent",
    "summaryHasExpectedValues",
    "reportPresent",
    "noopHashesUnchanged",
    "minimumTurns",
  ]) {
    if (greenfield?.[field] !== true) failures.push(`greenfield ${field} result was not proven`);
  }
  if (Number(greenfield?.fileCount || 0) < 12) failures.push("greenfield project has fewer than 12 files");
  if (Number(greenfield?.noopLaunchCommandCount || 0) !== 0) failures.push("greenfield read-only turn launched a program");
  if (Number(greenfield?.noopVerificationCommandCount || 0) < 1
    || Number(greenfield?.noopVerificationCommandCount || 0) > 3) failures.push("greenfield read-only verification count is invalid");
  if (!Array.isArray(greenfield?.unexpectedFiles) || greenfield.unexpectedFiles.length !== 0) failures.push("greenfield contains unexpected files");

  return failures;
}

export function buildGate8Report(input = {}) {
  const failures = [];
  const routeBefore = input.routeBefore || {};
  const routeAfter = input.routeAfter || {};
  const journey = input.journey || {};
  const compaction = input.compaction || {};
  const cppAudit = input.cppAudit || {};
  const evidence = input.evidence || {};
  const accountBefore = evidence.accountBefore || {};
  const modelCatalogBefore = evidence.modelCatalogBefore || {};
  const quotaProbeBefore = evidence.quotaProbeBefore || {};
  const selectedModel = String(input.model || "");
  const accountReady = accountBefore.signedIn === true && accountBefore.identityAvailable === true;
  const selectedModelPresent = selectedModel !== ""
    && Number(modelCatalogBefore.count || 0) > 0
    && modelCatalogBefore.selectedModelPresent === true
    && String(modelCatalogBefore.selectedModel || "") === selectedModel;
  const quotaProbeAgeMs = Number(quotaProbeBefore.ageMs);
  const quotaProbeReady = quotaProbeBefore.ok === true
    && quotaProbeBefore.quotaReady === true
    && quotaProbeBefore.usedRealTraffic === true
    && Number(quotaProbeBefore.requestCount) === 1
    && String(quotaProbeBefore.model || "") === selectedModel
    && quotaProbeBefore.markerMatched === true
    && Number(quotaProbeBefore.responseStatusCode) === 200
    && Number.isFinite(quotaProbeAgeMs)
    && quotaProbeAgeMs >= -60_000
    && quotaProbeAgeMs <= MAX_QUOTA_PROBE_AGE_MS;
  if (!accountReady) failures.push("signed-in account identity was not proven before model traffic");
  if (!selectedModelPresent) failures.push("selected model was not proven in the current model catalog before model traffic");
  if (!quotaProbeReady) failures.push("fresh successful one-request quota probe was not proven before the long task");
  const editRounds = Array.isArray(journey.editRounds)
    ? journey.editRounds.filter((round) => Array.isArray(round?.changedFiles) && round.changedFiles.length > 0).length
    : 0;
  const dialogueTurns = Number(journey.turnCount || 0);
  const passedDialogueTurns = Number(journey.passedTurnCount || 0);
  const userCorrections = Array.isArray(journey.userCorrections) ? journey.userCorrections.length : 0;
  const turnEvidence = Array.isArray(journey.turns) ? journey.turns : [];
  const progressUpdates = turnEvidence
    .reduce((sum, turn) => sum + Number(turn?.history?.progressUpdateCount || turn?.progressUpdateCount || 0), 0);
  const toolCalls = turnEvidence
    .reduce((sum, turn) => sum + Number(
      turn?.taskToolCallCount
      ?? (Array.isArray(turn?.history?.scopedCommands) ? turn.history.scopedCommands.length : 0),
    ), 0);
  const unexpectedLaunchCommands = turnEvidence
    .reduce((sum, turn) => sum + Number(turn?.history?.launchCommandCount || 0), 0);
  const postFinalToolCalls = turnEvidence
    .reduce((sum, turn) => sum + Number(turn?.history?.postFinalToolCallCount || 0), 0);
  const postFinalToolOutputs = turnEvidence
    .reduce((sum, turn) => sum + Number(turn?.history?.postFinalToolOutputCount || 0), 0);
  const duplicateCommands = turnEvidence
    .reduce((sum, turn) => sum + Number(turn?.history?.duplicateCommandCount || 0), 0);
  const evidencedTurns = turnEvidence.length;
  const evaluatedTurns = turnEvidence.map((turn) => evaluateGate8TurnEvidence(turn, selectedModel));
  const modelProvenTurns = evaluatedTurns.filter((turn) => turn.modelProofValid).length;
  const preCommandExplanations = evaluatedTurns.filter((turn) => turn.rolloutPreCommandEvidence).length;
  const nonEmptyToolResults = evaluatedTurns.filter((turn) => turn.rolloutToolOutputEvidence).length;
  const turnContractsPassed = evidencedTurns >= 8 && turnEvidence.every((turn) => {
    const history = turn?.history || {};
    const evaluated = evaluateGate8TurnEvidence(turn, selectedModel);
    const completionSeen = history.assistantFinalMarkerSeen === true
      || (turn?.resultDrivenCompletionObserved === true && history.taskCompleteSeen === true);
    return turn?.ok === true
      && turn?.usedRealTraffic === true
      && evaluated.modelProofValid
      && completionSeen
      && evaluated.hasNonEmptyScopedCommand
      && evaluated.scopedCommandCallIdsValid
      && evaluated.rolloutToolOutputEvidence
      && evaluated.rolloutPreCommandEvidence
      && Number(history.launchCommandCount || 0) === 0
      && Number(history.postFinalToolCallCount || 0) === 0
      && Number(history.postFinalToolOutputCount || 0) === 0
      && Number(history.duplicateCommandCount || 0) === 0
      && history.parseErrorSeen !== true
      && Number(history.scopeViolationCount || 0) === 0;
  });

  const fixedRoute = routeReady(routeBefore) && routeReady(routeAfter);
  const oldRouteBeforeCount = Number(input.oldRouteBefore?.count || 0);
  const oldRouteAfterCount = Number(input.oldRouteAfter?.count || 0);
  const oldRouteHits = Math.max(0, oldRouteAfterCount - oldRouteBeforeCount);
  const oldRouteUnchanged = oldRouteHits === 0
    && String(input.oldRouteBefore?.entriesSha256 || "") === String(input.oldRouteAfter?.entriesSha256 || "");
  if (!fixedRoute) failures.push("fixed Antigravity Chat route was not ready for the full run");
  if (!oldRouteUnchanged) failures.push(`old route received ${oldRouteHits} hit(s) or its fingerprint changed`);
  if (cppAudit.allUpstreamChatCompletions !== true || Number(cppAudit.upstreamRequestCount || 0) < 1) {
    failures.push("CodexPlusPlus did not exclusively use the Antigravity Chat endpoint");
  }

  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  const artifactsValid = artifacts.length >= 5 && artifacts.every((artifact) => (
    artifact?.exists === true
    && SHA256_PATTERN.test(String(artifact?.sha256 || ""))
    && Number(artifact?.bytes) > 0
  ));
  if (!artifactsValid) failures.push("fewer than five non-empty hashed artifacts were verified");
  const tests = Array.isArray(input.tests) ? input.tests : [];
  const testsValid = tests.length >= 2 && tests.every((entry) => entry?.passed === true && Number(entry?.exitCode) === 0);
  if (!testsValid) failures.push("fewer than two host tests completed with exit code 0");

  if (journey.ok !== true || journey.usedRealTraffic !== true || dialogueTurns < 8 || passedDialogueTurns < 8) {
    failures.push("eight visible turns did not all complete");
  }
  if (evidencedTurns < 8) failures.push(`fewer than eight complete turn-history records were provided (${evidencedTurns})`);
  for (const [index, turn] of turnEvidence.entries()) {
    const turnId = String(turn?.turnId || `turn-${index + 1}`);
    const evaluated = evaluateGate8TurnEvidence(turn, selectedModel);
    if (String(turn?.requiredModel || "") !== selectedModel) {
      failures.push(`${turnId} required model ${String(turn?.requiredModel || "<missing>")} does not match selected model ${selectedModel || "<missing>"}`);
    } else if (turn?.actualModelProven !== true) {
      failures.push(`model provenance not verified for turn ${turnId}`);
    } else if (!evaluated.modelProofValid) {
      failures.push(`model proof detail not verified for turn ${turnId}`);
    }
    const turnScopedCommands = turn?.history?.scopedCommands;
    if (!Array.isArray(turnScopedCommands) || turnScopedCommands.length === 0) {
      failures.push(`${turnId} has no scoped commands`);
    } else if (!evaluated.hasNonEmptyScopedCommand) {
      failures.push(`${turnId} has no non-empty scoped command`);
    }
    if (evaluated.hasNonEmptyScopedCommand && !evaluated.scopedCommandCallIdsValid) {
      failures.push(`${turnId} has a missing or duplicate command call-id`);
    }
    if (!evaluated.rolloutToolOutputEvidence || !evaluated.rolloutPreCommandEvidence) {
      failures.push(`${turnId} lacks rollout-derived tool result or action explanation evidence with a correlated command call-id`);
    }
  }
  if (modelProvenTurns < 8) failures.push(`only ${modelProvenTurns} turn(s) proved the selected model`);
  if (!turnContractsPassed) failures.push("at least one turn-history contract lacks completion, real traffic, non-empty tool output, or a pre-command action explanation");
  if (editRounds < 3) failures.push(`only ${editRounds} edit round(s) were proven`);
  if (userCorrections < 1) failures.push("no mid-task user correction was proven");
  if (progressUpdates < 3) failures.push(`only ${progressUpdates} visible progress update(s) were proven`);
  if (toolCalls < 5) failures.push(`only ${toolCalls} task tool call(s) were proven`);
  if (unexpectedLaunchCommands > 0) failures.push(`${unexpectedLaunchCommands} unexpected program launch command(s) were observed`);
  if (postFinalToolCalls > 0) failures.push(`${postFinalToolCalls} tool call(s) were dispatched after a visible final marker`);
  if (postFinalToolOutputs > 0) failures.push(`${postFinalToolOutputs} tool output(s) arrived after a visible final marker`);
  if (duplicateCommands > 0) failures.push(`${duplicateCommands} duplicate command(s) were observed inside visible turns`);

  const longContextReached = Number(compaction.longContextChars || 0) >= MIN_LONG_CONTEXT_CHARS;
  const compactionTriggered = compaction.ok === true
    && compaction.requestedRealTraffic === true
    && compaction.usedRealTraffic === true
    && compaction.nativeCompactionObserved === true;
  const resumedSameTask = compaction.followup?.ok === true
    && compaction.followup?.sameThread === true
    && String(compaction.threadId || "") !== ""
    && String(compaction.threadId) === String(journey.historyReopen?.threadId || "")
    && journey.historyReopen?.resumedSameTask === true;
  const historyReopened = journey.historyReopen?.ok === true
    && journey.historyReopen?.actualMouseClick === true
    && journey.historyReopen?.navigatedAwayFirst === true;
  if (!longContextReached) failures.push("long-context pressure did not reach the minimum size");
  if (!compactionTriggered) failures.push("native context compaction was not proven");
  if (!resumedSameTask) failures.push("compacted and visible task continuity was not proven");
  if (!historyReopened) failures.push("the visible task was not reopened from history after navigating away");

  const edgeInjected = journey.edgeRecovery?.injected === true;
  const recovered = journey.edgeRecovery?.recovered === true;
  const executionCount = Number(journey.edgeRecovery?.executionCount || 0);
  const staleConflictCount = Number(journey.edgeRecovery?.staleConflictCount || 0)
    + Number(cppAudit.staleConflictCount || 0);
  const duplicatePairs = Array.isArray(cppAudit.duplicateRequestPairs) ? cppAudit.duplicateRequestPairs : [];
  const noDuplicateExecution = executionCount === 1 && duplicatePairs.length === 0;
  if (!edgeInjected) failures.push("no controlled interruption edge was injected");
  if (!recovered) failures.push("the controlled interruption was not recovered");
  if (executionCount !== 1) failures.push(`edge command executed ${executionCount} times`);
  if (duplicatePairs.length > 0) failures.push(`CodexPlusPlus logged ${duplicatePairs.length} adjacent duplicate request pair(s)`);
  if (staleConflictCount !== 0) failures.push(`stale conflict count is ${staleConflictCount}`);

  const originalCodexUnchanged = sameJson(input.processBefore?.originalCodex, input.processAfter?.originalCodex);
  const oneVisibleAntiCodex = Array.isArray(input.processAfter?.antiCodexRoots)
    && input.processAfter.antiCodexRoots.length === 1
    && Array.isArray(routeAfter?.processes?.copiedClient)
    && routeAfter.processes.copiedClient.length === 1;
  const supervisorBefore = Number(routeBefore?.processes?.managerService || 0);
  const supervisorAfter = Number(routeAfter?.processes?.managerService || 0);
  const oneFixedRouteSupervisor = supervisorBefore > 0 && supervisorBefore === supervisorAfter;
  const legacyProcessCount = Number(input.legacyProcessCount ?? -1);
  if (!oneVisibleAntiCodex) failures.push("visible Anti-Codex root process count was not exactly one");
  if (!oneFixedRouteSupervisor) failures.push("fixed-route supervisor changed or was not unique");
  if (!originalCodexUnchanged) failures.push("original Codex process set changed");
  if (legacyProcessCount !== 0) failures.push(`legacy process count is ${legacyProcessCount}`);

  const requestedRealTraffic = true;
  const usedRealTraffic = journey.usedRealTraffic === true || compaction.usedRealTraffic === true;
  const resultBasedVerification = artifactsValid && testsValid;
  const ok = failures.length === 0;
  return {
    schema: "anticodex-gate8-final-long-task-v1",
    reportName: "gate8-final-long-task",
    gate: 8,
    ok,
    gateComplete: ok,
    generatedAt: input.generatedAt || new Date().toISOString(),
    startedAt: input.startedAt || null,
    endedAt: input.endedAt || null,
    model: selectedModel,
    requestedRealTraffic,
    usedRealTraffic,
    resultBasedVerification,
    preflight: {
      accountReady,
      selectedModelPresent,
      quotaProbeReady,
      modelCatalogCount: Number(modelCatalogBefore.count || 0),
    },
    route: {
      fixed: fixedRoute,
      provider: routeAfter?.route?.provider || routeAfter?.provider || "",
      relayProtocol: routeAfter?.route?.relayProtocol || "",
      oldRouteHits,
      oldRouteFingerprintUnchanged: oldRouteUnchanged,
      cppAudit,
    },
    artifacts,
    tests,
    interaction: {
      editRounds,
      dialogueTurns,
      passedDialogueTurns,
      userCorrections,
      progressUpdates,
      toolCalls,
      unexpectedLaunchCommands,
      postFinalToolCalls,
      postFinalToolOutputs,
      duplicateCommands,
      evidencedTurns,
      modelProvenTurns,
      preCommandExplanations,
      nonEmptyToolResults,
      turnContractsPassed,
    },
    continuity: {
      longContextReached,
      compactionTriggered,
      resumedSameTask,
      historyReopened,
      longContextChars: Number(compaction.longContextChars || 0),
      compactSummaryLength: Number(compaction.compact_summary_length || 0),
    },
    recovery: {
      edgeInjected,
      recovered,
      noDuplicateExecution,
      executionCount,
      staleConflictCount,
      duplicateRequestPairs: duplicatePairs,
    },
    processes: {
      oneVisibleAntiCodex,
      oneFixedRouteSupervisor,
      originalCodexUnchanged,
      legacyProcessCount,
      before: input.processBefore || null,
      after: input.processAfter || null,
    },
    evidence,
    failures,
  };
}

function requestMatches(record, path) {
  return record?.event === "helper.request"
    && String(record?.detail?.method || "").toUpperCase() === "POST"
    && String(record?.detail?.path || "") === path;
}

function matchingRequestIdentity(previous, current) {
  const fields = [
    ["bodySha256", ["body_sha256", "bodySha256", "sha256"]],
    ["bodyHash", ["body_hash", "bodyHash", "request_hash", "requestHash"]],
    ["requestId", ["request_id", "requestId"]],
    ["idempotencyKey", ["idempotency_key", "idempotencyKey"]],
  ];
  for (const [kind, aliases] of fields) {
    for (const alias of aliases) {
      const left = String(previous?.detail?.[alias] || "").trim();
      const right = String(current?.detail?.[alias] || "").trim();
      if (left && left === right) return kind;
    }
  }
  return "";
}

function routeReady(value) {
  return value?.ok === true
    && value?.schema === "anticodex-fixed-route-status-v1"
    && value?.state === "ready"
    && (value?.route?.provider || value?.provider) === "antigravity"
    && value?.route?.relayProtocol === "chatCompletions";
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return textValue(value.text ?? value.content ?? value.summary ?? "");
  }
  return "";
}
