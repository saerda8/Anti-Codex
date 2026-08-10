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
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeManifestClockToleranceMs = 1;
const requiredShortcutRestoreRounds = 10;

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!String(key).startsWith("--")) continue;
    const next = values[index + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) index += 1;
    const existing = parsed.get(key);
    parsed.set(key, existing === undefined ? [value] : [...existing, value]);
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const values = (flag) => (args.get(flag) || []).map(String);
const value = (flag, fallback = "") => values(flag).at(-1) || fallback;
const compact = args.has("--compact");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/build-anticodex-gate5-evidence.mjs [options]

Offline normalization only. This command never launches UI, processes, or model traffic.

Required raw evidence:
  --task-receipt <path>             Signed single-submit handoff receipt
  --task-artifact <path>            Current task artifact (repeat at least 3 times)
  --manager-matrix <path>           Signed Manager 20-action UI-interaction matrix
  --manager-profile <path>          Signed Manager profile-entry mouse probe
  --manager-close <path>            Signed Manager three-height close mouse probe
  --manager-protocol <path>         Signed Manager protocol round-trip mouse probe
  --model-switch <path>             Signed same-task model switch probe (repeat 3+)
  --shortcut-restore <path>         Signed taskbar-button restore probe (repeat exactly 10)
  --live-tray-evidence <path>       Signed live notification-area accessibility probe
  --release-binding-evidence <path> Signed current release-binding report
  --sync-readiness-evidence <path>  Signed sync-readiness report bound by release hash

Output:
  --output-root <path>              Directory for five signed Gate 5 inputs
  --max-source-age-hours <n>        Maximum raw evidence age (default: 48)
  --compact                         Compact stdout JSON
  --help                            Show help without writing files`);
  process.exit(0);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveNumber(input, fallback) {
  const parsed = Number(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const maxSourceAgeHours = positiveNumber(value("--max-source-age-hours"), 48);
const maxLiveTrayAgeMinutes = 5;
const outputRoot = resolve(value("--output-root", resolve(process.cwd(), "gate5-normalized-evidence")));
const outputNames = {
  taskManifest: "gate5-task-manifest.json",
  managerEvidence: "gate5-manager-evidence.json",
  modelSwitchEvidence: "gate5-model-switch-evidence.json",
  shortcutRestoreEvidence: "gate5-shortcut-restore-evidence.json",
  releaseBindingEvidence: "gate5-release-binding-evidence.json",
};
const managerActions = Object.freeze([
  "refreshStatus",
  "refreshModels",
  "accountSwitch",
  "accountProxy",
  "syncReadiness",
  "repairShortcuts",
  "updateCheck",
  "sourcePreflight",
  "mcpSkills",
  "pluginCapabilities",
  "diagnosticsBundle",
  "viewLatestReports",
  "syncHost",
  "upstreamConfig",
  "refreshFeatures",
  "stabilitySoak",
  "coldRelaunch",
  "fastOverallNoTraffic",
  "overallNoTraffic",
  "postVerificationFull",
]);
const safeRealManagerActions = Object.freeze([
  "updateCheck", "repairShortcuts", "mcpSkills", "pluginCapabilities",
  "viewLatestReports", "diagnosticsBundle",
]);
const highImpactManagerActions = Object.freeze([
  "syncHost", "refreshFeatures", "stabilitySoak", "coldRelaunch",
  "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull",
]);
const managerHandlerContractByAction = Object.freeze({
  refreshStatus: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  refreshModels: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  accountSwitch: ["script", "scripts/anticodex-manager-service.mjs", "open-antigravity-account-switch.ps1"],
  accountProxy: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-account-proxy-readiness.ps1"],
  syncReadiness: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-sync-readiness.ps1"],
  repairShortcuts: ["script", "scripts/anticodex-manager-service.mjs", "repair-anticodex-shortcuts.ps1"],
  updateCheck: ["script", "scripts/anticodex-manager-service.mjs", "check-anticodex-update.ps1"],
  sourcePreflight: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-source-preflight.ps1"],
  mcpSkills: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-mcp-skills.ps1"],
  pluginCapabilities: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-plugin-capabilities.ps1"],
  diagnosticsBundle: ["script", "scripts/anticodex-manager-service.mjs", "collect-anticodex-diagnostics.ps1"],
  viewLatestReports: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  syncHost: ["script", "scripts/anticodex-manager-service.mjs", "sync-anticodex-launcher.ps1"],
  upstreamConfig: ["ui-function", "scripts/anticodex-manager-inject.js", "ui-function"],
  refreshFeatures: ["script", "scripts/anticodex-manager-service.mjs", "refresh-anticodex-local-features.ps1"],
  stabilitySoak: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-stability-soak.ps1"],
  coldRelaunch: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-cold-relaunch.ps1"],
  fastOverallNoTraffic: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-installed-overall.ps1"],
  overallNoTraffic: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-installed-overall.ps1"],
  postVerificationFull: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-post-verification.ps1"],
});

function exactStringList(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function currentSourceGitHead() {
  const child = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const head = String(child.stdout || "").trim().toLowerCase();
  return child.status === 0 && /^[a-f0-9]{40}$/.test(head) ? head : "";
}
const requiredSingleFlags = [
  "--task-receipt",
  "--manager-matrix",
  "--manager-profile",
  "--manager-close",
  "--manager-protocol",
  "--live-tray-evidence",
  "--release-binding-evidence",
  "--sync-readiness-evidence",
];

function sourceTimestampMs(data, label) {
  for (const candidate of [data?.checkedAt, data?.generatedAt, data?.completedAt, data?.createdAt]) {
    const parsed = Date.parse(String(candidate || ""));
    if (Number.isFinite(parsed)) return { timestampMs: parsed, kind: "embedded" };
  }
  throw new Error(`${label}: content-embedded timestamp is required`);
}

function readRaw(pathValue, { requireSigned = true, label }) {
  const path = resolve(String(pathValue || ""));
  if (!pathValue || !existsSync(path) || !statSync(path).isFile()) throw new Error(`${label}: missing raw evidence: ${path}`);
  const bytes = readFileSync(path);
  const actualHash = sha256(bytes);
  const sidecarPath = `${path}.sha256`;
  let signed = false;
  if (existsSync(sidecarPath)) {
    const sidecar = readFileSync(sidecarPath, "ascii").trim();
    const match = sidecar.match(/^(?:sha256:)?([a-f0-9]{64})$/i);
    if (!match || match[1].toLowerCase() !== actualHash) throw new Error(`${label}: invalid source signature`);
    signed = true;
  } else if (requireSigned) {
    throw new Error(`${label}: signed source sidecar is required`);
  }
  let data;
  try {
    data = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error?.message || error}`);
  }
  const timestamp = sourceTimestampMs(data, label);
  const ageHours = (Date.now() - timestamp.timestampMs) / 3_600_000;
  if (ageHours < -(5 / 60) || ageHours > maxSourceAgeHours) {
    throw new Error(`${label}: raw evidence is stale or future-dated (${ageHours.toFixed(2)}h)`);
  }
  return {
    label,
    path,
    sidecarPath: signed ? sidecarPath : null,
    data,
    sha256: actualHash,
    signed,
    checkedAt: new Date(timestamp.timestampMs).toISOString(),
    timestampKind: timestamp.kind,
    ageHours: Math.max(0, ageHours),
  };
}

function writeSignedAtomic(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(payload, null, compact ? 0 : 2)}\n`;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const sidecarPath = `${path}.sha256`;
  const temporarySidecarPath = `${sidecarPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, body, "utf8");
  writeFileSync(temporarySidecarPath, `sha256:${sha256(body)}`, "ascii");
  renameSync(temporaryPath, path);
  renameSync(temporarySidecarPath, sidecarPath);
  return { path, sidecarPath, sha256: sha256(body), bytes: Buffer.byteLength(body) };
}

function invalidateNormalizedOutputs() {
  for (const name of Object.values(outputNames)) {
    const path = resolve(outputRoot, name);
    rmSync(path, { force: true });
    rmSync(`${path}.sha256`, { force: true });
  }
}

function releaseBindingFrom(data) {
  return data?.releaseBinding || data;
}

const releaseBindingFields = [
  "schema",
  "officialShellVersion",
  "activeShellVersion",
  "codexPlusPlusVersion",
  "codexPlusPlusPatchCommit",
  "codexPlusPlusBinarySha256",
  "codexPlusPlusPatchTreeSha256",
  "codexPlusPlusPatchCount",
  "syncReadinessSha256",
];

function validReleaseBinding(binding) {
  return binding?.schema === "anticodex-release-binding-v1"
    && binding?.valid === true
    && String(binding?.officialShellVersion || "") !== ""
    && binding.officialShellVersion === binding.activeShellVersion
    && String(binding?.codexPlusPlusVersion || "") !== ""
    && /^[a-f0-9]{40}$/i.test(String(binding?.codexPlusPlusPatchCommit || ""))
    && /^[a-f0-9]{64}$/i.test(String(binding?.codexPlusPlusBinarySha256 || ""))
    && /^[a-f0-9]{64}$/i.test(String(binding?.codexPlusPlusPatchTreeSha256 || ""))
    && Number(binding?.codexPlusPlusPatchCount) > 0
    && /^[a-f0-9]{64}$/i.test(String(binding?.syncReadinessSha256 || ""));
}

function sameTarget(sources) {
  const targets = sources.map((source) => source?.data?.target || source?.target).filter(Boolean);
  if (targets.length !== sources.length) return false;
  const identity = (target) => String(target?.id || "").trim().toLowerCase();
  const first = identity(targets[0]);
  return Boolean(first) && targets.every((target) => identity(target) === first);
}

function targetIdFrom(source) {
  return String(source?.data?.target?.id || source?.target?.id || "").trim();
}

function requireMatchingRuntimeIdentity(raw, runtimeIdentity, label) {
  const processIdentity = raw?.processIdentity || {};
  const sessionIdentity = raw?.sessionIdentity || {};
  requireCondition(
    Number(processIdentity?.supervisorPid) === runtimeIdentity.supervisorPid
      && Number(processIdentity?.codexPlusPlusPid) === runtimeIdentity.codexPlusPlusPid
      && Number(processIdentity?.antiCodexMainPid) === runtimeIdentity.antiCodexMainPid
      && Number(processIdentity?.originalCodexPid) === runtimeIdentity.originalCodexPid
      && processIdentity?.originalCodexAlive === true,
    `${label}: process identity does not match the task runtime`,
  );
  requireCondition(
    Number(sessionIdentity?.cdpPort) === runtimeIdentity.cdpPort
      && String(sessionIdentity?.targetId || "") === runtimeIdentity.targetId
      && String(sessionIdentity?.targetUrl || "") === runtimeIdentity.targetUrl,
    `${label}: CDP renderer session does not match the task runtime`,
  );
}

function uniqueSourceFiles(sources) {
  const paths = sources.map((source) => resolve(source.path).toLowerCase());
  const hashes = sources.map((source) => source.sha256);
  return new Set(paths).size === paths.length && new Set(hashes).size === hashes.length;
}

function normalizeProtocol(input) {
  const value = input && typeof input === "object" ? input.value : input;
  const normalized = String(value || "").trim().toLowerCase().replace(/[_\s-]/g, "");
  if (normalized.includes("chatcompletions")) return "chatCompletions";
  if (normalized === "responses" || normalized.includes("/responses")) return "responses";
  return "";
}

function sameNativePath(left, right) {
  return resolve(String(left || "")).replace(/\\/g, "/").toLowerCase()
    === resolve(String(right || "")).replace(/\\/g, "/").toLowerCase();
}

function insideRoot(path, root) {
  const child = resolve(path);
  const parent = resolve(root);
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function userMessagesFromRollout(path) {
  const bytes = readFileSync(path);
  const lines = bytes.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      records.push({ index, record: JSON.parse(lines[index]) });
    } catch (error) {
      throw new Error(`task-receipt: rollout invalid JSON at line ${index + 1}: ${error?.message || error}`);
    }
  }

  let currentTurnId = "";
  const turnStarts = new Map();
  const turnContexts = new Map();
  const turnCompletions = new Map();
  const turnAborts = new Map();
  const eventMessages = [];
  const responseMessages = [];
  for (const entry of records) {
    const { index, record } = entry;
    const timestamp = String(record?.timestamp || record?.payload?.timestamp || "");
    if (record?.type === "event_msg" && record?.payload?.type === "task_started") {
      currentTurnId = String(record?.payload?.turn_id || "").trim();
      if (currentTurnId && !turnStarts.has(currentTurnId)) {
        turnStarts.set(currentTurnId, { index, timestamp });
      }
    } else if (record?.type === "turn_context") {
      currentTurnId = String(record?.payload?.turn_id || currentTurnId).trim();
      if (currentTurnId && !turnContexts.has(currentTurnId)) {
        turnContexts.set(currentTurnId, {
          index,
          timestamp,
          cwd: String(record?.payload?.cwd || ""),
        });
      }
    } else if (record?.type === "event_msg" && record?.payload?.type === "task_complete") {
      const turnId = String(record?.payload?.turn_id || "").trim();
      if (turnId) {
        const rawError = record?.payload?.error;
        const errorMessage = typeof rawError === "string"
          ? rawError
          : String(rawError?.message || rawError?.error?.message || "");
        const completions = turnCompletions.get(turnId) || [];
        completions.push({
          index,
          timestamp,
          errorMessage,
        });
        turnCompletions.set(turnId, completions);
      }
    } else if (record?.type === "response_item"
      && record?.payload?.type === "message"
      && record?.payload?.role === "user") {
      const turnId = String(
        record?.payload?.internal_chat_message_metadata_passthrough?.turn_id || currentTurnId,
      ).trim();
      const text = (Array.isArray(record?.payload?.content) ? record.payload.content : [])
        .filter((item) => item?.type === "input_text")
        .map((item) => String(item?.text || ""))
        .join("");
      if (text.startsWith("<turn_aborted>\n") && text.endsWith("\n</turn_aborted>")) {
        const aborts = turnAborts.get(turnId) || [];
        aborts.push({ index, timestamp, text });
        turnAborts.set(turnId, aborts);
      } else {
        responseMessages.push({ index, timestamp, turnId, text });
      }
    } else if (record?.type === "event_msg" && record?.payload?.type === "user_message") {
      eventMessages.push({
        index,
        timestamp,
        turnId: String(record?.payload?.turn_id || currentTurnId).trim(),
        text: String(record?.payload?.message || ""),
      });
    }
  }

  requireCondition(eventMessages.length > 0 && responseMessages.length > 0,
    "task-receipt: rollout user-message dual ledgers are incomplete");
  requireCondition(eventMessages.length === responseMessages.length
    && eventMessages.every((message, index) => (
      message.text === responseMessages[index].text
      && message.timestamp === responseMessages[index].timestamp
      && (!message.turnId || message.turnId === responseMessages[index].turnId)
    )),
  "task-receipt: rollout user-message ledgers disagree");

  return {
    records: records.map((entry) => entry.record),
    messages: responseMessages,
    turnStarts,
    turnContexts,
    turnCompletions,
    turnAborts,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

function rolloutTaskStartedAt(records) {
  const candidates = records
    .filter((record) => record?.type === "session_meta" || record?.type === "turn_context")
    .map((record) => Date.parse(String(record?.timestamp || record?.payload?.timestamp || "")))
    .filter(Number.isFinite);
  return candidates.length > 0 ? Math.min(...candidates) : Number.NaN;
}

function rolloutToolEvidenceText(records) {
  const responseToolTypes = new Set([
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "local_shell_call",
    "computer_tool_call",
    "web_search_call",
  ]);
  return records
    .filter((record) => (
      record?.type === "response_item" && responseToolTypes.has(String(record?.payload?.type || ""))
    ) || (
      record?.type === "event_msg"
      && /(?:^|_)(?:tool|exec|command|patch|file)(?:_|$)/i.test(String(record?.payload?.type || ""))
    ))
    .map((record) => JSON.stringify(record))
    .join("\n")
    .toLowerCase();
}

function providerFromModel(raw) {
  const explicit = String(raw?.provider || raw?.selectedModel?.provider || "").trim().toLowerCase();
  if (["gemini", "claude", "third-party"].includes(explicit)) return explicit;
  const model = String(raw?.selectedModel?.model || raw?.requiredModel || "").toLowerCase();
  if (model.includes("gemini")) return "gemini";
  if (model.includes("claude")) return "claude";
  if (model.includes("third-party") || model.includes("gpt-")) return "third-party";
  return "";
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeTaskReceipt(source, artifactPaths, releaseBinding) {
  const raw = source.data;
  const rollout = raw?.startupEvidence?.rollout || {};
  const native = raw?.startupEvidence?.native || {};
  const nativeActivity = native?.activity || {};
  const upstream = raw?.startupEvidence?.upstream || {};
  const request = upstream?.request || {};
  const response = upstream?.response || {};
  const taskId = String(rollout?.taskId || rollout?.sessionId || "").trim();
  const targetId = targetIdFrom(raw);
  const processIdentity = raw?.processIdentity || {};
  const runtimeIdentity = {
    targetId,
    targetUrl: String(raw?.target?.url || ""),
    cdpPort: Number(raw?.cdpPort || 0),
    supervisorPid: Number(processIdentity?.supervisorPid || 0),
    codexPlusPlusPid: Number(processIdentity?.codexPlusPlusPid || 0),
    antiCodexMainPid: Number(processIdentity?.antiCodexMainPid || 0),
    originalCodexPid: Number(processIdentity?.originalCodexPid || 0),
  };
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
  requireCondition(raw?.startupEvidence?.ok === true
    && rollout?.ok === true
    && rollout?.newTask === true
    && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(taskId)
    && rollout?.cwdMatched === true
    && rollout?.modelMatched === true
    && rollout?.promptSeen === true,
  "task-receipt: native rollout/task/cwd/model evidence is incomplete");
  requireCondition(native?.ok === true
    && native?.reason === "task_bound_native_request"
    && native?.expectedRequestObserved === true
    && native?.taskId === taskId
    && Array.isArray(nativeActivity?.expectedThreadIds)
    && nativeActivity.expectedThreadIds.length === 1
    && nativeActivity.expectedThreadIds[0] === taskId
    && Array.isArray(nativeActivity?.unexpectedRequestThreadIds)
    && nativeActivity.unexpectedRequestThreadIds.length === 0
    && Array.isArray(nativeActivity?.unexpectedExecutionThreadIds)
    && nativeActivity.unexpectedExecutionThreadIds.length === 0
    && nativeActivity?.titleThreadsUsedTools === false
    && nativeActivity?.taskSuggestionThreadsUsedTools === false,
  "task-receipt: native request is not exclusively bound to the rollout taskId");
  requireCondition(request?.relayId === "anticodex-antigravity"
    && Number(request?.candidateCount) === 1
    && Number(request?.requestTools?.count) > 0
    && Number(request?.upstreamTools?.count) > 0
    && response?.relayId === request.relayId
    && response?.endpoint === request.endpoint
    && Number(response?.attempt) === Number(request?.attempt)
    && Number(response?.candidateCount) === Number(request?.candidateCount)
    && Number(response?.statusCode) >= 200
    && Number(response?.statusCode) < 300
    && upstream?.ok === true,
  "task-receipt: first Antigravity tool-bearing request/response evidence is incomplete");
  requireCondition(runtimeIdentity.targetId
    && runtimeIdentity.targetUrl
    && runtimeIdentity.cdpPort > 0
    && runtimeIdentity.supervisorPid > 0
    && runtimeIdentity.codexPlusPlusPid > 0
    && runtimeIdentity.antiCodexMainPid > 0
    && runtimeIdentity.originalCodexPid > 0
    && processIdentity?.originalCodexAlive === true,
  "task-receipt: current runtime PID/session identity is incomplete");

  const promptPath = resolve(String(raw?.promptFile || ""));
  requireCondition(existsSync(promptPath) && statSync(promptPath).isFile(), "task-receipt: prompt file is missing");
  const promptText = readFileSync(promptPath, "utf8").replace(/^\uFEFF/, "");
  requireCondition(sha256(promptText) === String(raw?.promptSha256 || "").toLowerCase(), "task-receipt: prompt file hash changed");
  const rolloutPath = resolve(String(rollout?.file || ""));
  requireCondition(existsSync(rolloutPath) && statSync(rolloutPath).isFile(), "task-receipt: rollout file is missing");
  const rolloutEvidence = userMessagesFromRollout(rolloutPath);
  const sessionMeta = rolloutEvidence.records.find((record) => record?.type === "session_meta");
  requireCondition(String(sessionMeta?.payload?.id || sessionMeta?.payload?.session_id || "") === taskId,
    "task-receipt: rollout taskId does not match receipt");
  const hostMessages = rolloutEvidence.messages;
  const exactGoalCount = hostMessages.filter((message) => message.text === promptText).length;
  requireCondition(hostMessages.length >= 1
    && hostMessages[0]?.text === promptText
    && exactGoalCount === 1
    && hostMessages.slice(1).every((message) => message.text === "继续"),
  "task-receipt: rollout must contain one total-goal prompt followed only by exact continuation text");
  requireCondition(hostMessages[0]?.turnId === String(rollout?.turnId || "").trim(),
    "task-receipt: total-goal prompt is not bound to the initial native turn");
  requireCondition(new Set(hostMessages.map((message) => message.turnId)).size === hostMessages.length
    && hostMessages.every((message) => message.turnId),
  "task-receipt: every host message must belong to one unique native turn");
  const continuations = hostMessages.slice(1).map((message, index) => {
    const previous = hostMessages[index];
    const start = rolloutEvidence.turnStarts.get(message.turnId);
    const context = rolloutEvidence.turnContexts.get(message.turnId);
    const errorInterruptions = (rolloutEvidence.turnCompletions.get(previous.turnId) || [])
      .filter((entry) => entry.errorMessage
        && entry.index > previous.index
        && entry.index < Number(start?.index))
      .map((entry) => ({ ...entry, kind: "task_complete.error", evidence: entry.errorMessage }));
    const abortInterruptions = (rolloutEvidence.turnAborts.get(previous.turnId) || [])
      .filter((entry) => entry.index > previous.index && entry.index < Number(start?.index))
      .map((entry) => ({ ...entry, kind: "turn_aborted", evidence: entry.text }));
    const interruption = [...errorInterruptions, ...abortInterruptions]
      .sort((left, right) => right.index - left.index)[0];
    requireCondition(start
      && start.index < message.index
      && context
      && context.index < message.index
      && sameNativePath(context.cwd, raw?.projectRoot),
    `task-receipt: continuation turn ${message.turnId} is not a new native turn in the task cwd`);
    requireCondition(interruption
      && interruption.index < start.index
      && Number.isFinite(Date.parse(interruption.timestamp))
      && Number.isFinite(Date.parse(message.timestamp)),
    `task-receipt: continuation turn ${message.turnId} lacks an earlier task_complete.error or native turn_aborted interruption`);
    return {
      sequence: index + 1,
      turnId: message.turnId,
      at: new Date(Date.parse(message.timestamp)).toISOString(),
      previousTurnId: previous.turnId,
      interruptionAt: new Date(Date.parse(interruption.timestamp)).toISOString(),
      interruptionKind: interruption.kind,
      interruptionErrorSha256: sha256(interruption.evidence),
      messageSha256: sha256(message.text),
    };
  });
  requireCondition(sameNativePath(rollout?.cwd, raw?.projectRoot), "task-receipt: rollout cwd does not match project root");

  requireCondition(artifactPaths.length >= 3, "task-receipt: at least three task artifacts are required");
  const artifactIdentities = artifactPaths.map((pathValue) => resolve(pathValue).toLowerCase());
  requireCondition(new Set(artifactIdentities).size === artifactIdentities.length,
    "task-receipt: artifact paths must be unique");
  const receiptTaskStartedAtMs = Date.parse(String(raw?.taskStartedAt || ""));
  const rolloutTaskStartedAtMs = rolloutTaskStartedAt(rolloutEvidence.records);
  requireCondition(Number.isFinite(receiptTaskStartedAtMs) && Number.isFinite(rolloutTaskStartedAtMs),
    "task-receipt: signed task start and native rollout start timestamps are required");
  requireCondition(Math.abs(receiptTaskStartedAtMs - rolloutTaskStartedAtMs) <= 5 * 60_000,
    "task-receipt: signed task start does not match the native rollout session");
  const taskStartedAtMs = Math.min(receiptTaskStartedAtMs, rolloutTaskStartedAtMs);
  const toolEvidence = rolloutToolEvidenceText(rolloutEvidence.records);
  const artifacts = artifactPaths.map((pathValue) => {
    const path = resolve(pathValue);
    requireCondition(insideRoot(path, raw?.projectRoot), `task-receipt: artifact is outside project root: ${path}`);
    requireCondition(existsSync(path) && statSync(path).isFile() && statSync(path).size > 0,
      `task-receipt: artifact is missing or empty: ${path}`);
    const stat = statSync(path);
    requireCondition(stat.mtimeMs >= taskStartedAtMs,
      `task-receipt: artifact predates task start: ${path}`);
    requireCondition(toolEvidence.includes(basename(path).toLowerCase()),
      `task-receipt: artifact is absent from native rollout tool evidence: ${path}`);
    return {
      name: basename(path),
      path,
      bytes: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      toolEvidenceMentioned: true,
      sha256: sha256(readFileSync(path)),
    };
  });

  return {
    taskId,
    normalized: {
      schema: "anticodex-native-autonomous-task-manifest-v1",
      reportName: "native-autonomous-task-manifest",
      ok: true,
      newTask: true,
      nativeTask: true,
      sameTask: true,
      taskId,
      turnId: String(rollout?.turnId || ""),
      projectRoot: resolve(String(raw?.projectRoot || "")),
      promptFile: promptPath,
      promptSha256: String(raw.promptSha256).toLowerCase(),
      promptSubmissionCount: 1,
      totalGoalPromptCount: 1,
      continuationPromptCount: continuations.length,
      hostMessageCount: hostMessages.length,
      hostIntermediatePromptCount: 0,
      continuations,
      taskStartedAt: new Date(taskStartedAtMs).toISOString(),
      requestedRealTraffic: true,
      usedRealTraffic: true,
      route: {
        state: "ready",
        provider: "antigravity",
        model: String(raw?.requiredModel || rollout?.model || ""),
        relayProtocol: normalizeProtocol(request?.wireApi || request?.endpoint),
        codexPlusPlusVersion: releaseBinding.codexPlusPlusVersion,
      },
      artifacts,
      sourceReceipt: { path: source.path, sha256: source.sha256 },
      rollout: {
        path: rolloutPath,
        sha256: rolloutEvidence.sha256,
        bytes: rolloutEvidence.bytes,
        messageCount: hostMessages.length,
        userTurnCount: new Set(hostMessages.map((message) => message.turnId)).size,
      },
      runtimeIdentity,
      releaseBinding,
    },
    runtimeIdentity,
  };
}

const antiCodexTrayGuid = "a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3";

function normalizeLiveTray(source, runtimeIdentity) {
  const raw = source.data;
  const item = raw?.notificationAreaItem || {};
  const identity = raw?.identity || {};
  const rectangle = item?.rectangle || {};
  requireCondition(source.ageHours * 60 <= maxLiveTrayAgeMinutes,
    `live-tray-evidence: probe is stale (${(source.ageHours * 60).toFixed(2)}m)`);
  requireCondition(raw?.schema === "anticodex-live-tray-icon-v2"
    && raw?.ok === true
    && raw?.requestedRealTraffic === false
    && raw?.usedRealTraffic === false
    && item?.present === true
    && item?.visible === true
    && item?.clickable === true
    && item?.name === "Anti-Codex"
    && item?.provider === "MSAA+Shell_NotifyIconGetRect"
    && Number(item?.role) === 43
    && Number(item?.state) >= 0
    && Number(item?.childId) > 0
    && Number(item?.toolbarWindowHandle) > 0
    && Number(item?.rawNameCandidateCount) >= 1
    && Number(item?.verifiedAntiCandidateCount) === 1
    && Number(item?.expectedMainPid) === Number(runtimeIdentity?.antiCodexMainPid)
    && Number(item?.ownerWindowHandle) > 0
    && Number(item?.ownerProcessId) === Number(runtimeIdentity?.antiCodexMainPid)
    && item?.ownerWindowClass === "OwlElectron_NotifyIconHostWindow"
    && Number(item?.notifyIconId) > 0
    && String(item?.notifyIconGuid || "").toLowerCase() === antiCodexTrayGuid
    && item?.shellNotifyIconRectMatched === true
    && item?.isEnabled === true
    && item?.isInvisible === false
    && item?.isOffscreen === false
    && item?.hitTestMatched === true
    && Number.isFinite(rectangle?.x)
    && Number.isFinite(rectangle?.y)
    && Number(rectangle?.width) >= 16
    && Number(rectangle?.height) >= 16
    && identity?.exactAccessibleName === true
    && identity?.expectedMainPidMatched === true
    && identity?.ownerWindowClassMatched === true
    && identity?.antiGuidRectMatched === true
    && identity?.pinkArtwork === true
    && Number(identity?.minimumPinkPixels) >= 8
    && Number(identity?.pinkPixels) >= Number(identity?.minimumPinkPixels),
  "live-tray-evidence: live visible clickable Anti-Codex notification-area identity is incomplete");
  return {
    schema: raw.schema,
    ok: true,
    checkedAt: source.checkedAt,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    notificationAreaItem: item,
    identity,
    sourcePath: source.path,
    sourceSha256: source.sha256,
  };
}

function normalizedContractPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") ? normalized : "";
}

function processStartedForManifest(processCreatedAt, manifestCreatedAt) {
  const processCreatedAtMs = Date.parse(String(processCreatedAt || ""));
  const manifestCreatedAtMs = Date.parse(String(manifestCreatedAt || ""));
  return Number.isFinite(processCreatedAtMs) && Number.isFinite(manifestCreatedAtMs)
    && processCreatedAtMs + runtimeManifestClockToleranceMs >= manifestCreatedAtMs;
}

function validateManagerHandlerProvenance(wrapper, handlerContracts, contractEntries, runtimeIdentity) {
  const provenance = handlerContracts?.provenance || {};
  const runtimeRoot = resolve(String(provenance?.runtimeRoot || ""));
  const scriptsRoot = resolve(String(provenance?.scriptsRoot || ""));
  const manifestPath = resolve(String(provenance?.manifestPath || ""));
  const taskRuntimePid = Number(provenance?.taskRuntimePid || 0);
  const taskRuntimeScriptPath = resolve(String(provenance?.taskRuntimeScriptPath || ""));
  const taskRuntimeCreationDateUtc = String(provenance?.taskRuntimeCreationDateUtc || "");
  const expectedTaskRuntimeScriptPath = resolve(runtimeRoot, "scripts", "start-anticodex-fixed-route.mjs");
  const expectedFiles = [...new Set(["scripts/start-anticodex-fixed-route.mjs", ...contractEntries.flatMap(([, entry]) => [
    normalizedContractPath(entry?.source),
    String(entry?.handler || "").toLowerCase().endsWith(".ps1")
      ? normalizedContractPath(`scripts/${entry.handler}`)
      : "",
  ])].filter(Boolean))];
  const files = Array.isArray(provenance?.files) ? provenance.files : [];
  const sourceHead = currentSourceGitHead();
  requireCondition(provenance?.schema === "anticodex-manager-handler-provenance-v1"
    && provenance?.verified === true
    && sameNativePath(wrapper?.runtimeRoot, runtimeRoot)
    && sameNativePath(scriptsRoot, resolve(runtimeRoot, "scripts"))
    && sameNativePath(manifestPath, resolve(runtimeRoot, ".anticodex-runtime-manifest.json"))
    && sameNativePath(provenance?.sourceRoot, sourceRoot)
    && provenance?.sourceGitClean === true
    && provenance?.sourceRevisionProvenance === "git"
    && /^[a-f0-9]{40}$/i.test(String(provenance?.sourceGitHead || ""))
    && String(provenance.sourceGitHead).toLowerCase() === sourceHead
    && files.length === expectedFiles.length,
  "manager-matrix: handler runtime/source provenance is incomplete or stale");
  requireCondition(taskRuntimePid > 0
    && taskRuntimePid === Number(wrapper?.processIdentity?.supervisorPid || 0)
    && taskRuntimePid === Number(runtimeIdentity?.supervisorPid || 0)
    && sameNativePath(taskRuntimeScriptPath, expectedTaskRuntimeScriptPath)
    && Number.isFinite(Date.parse(taskRuntimeCreationDateUtc)),
  "manager-matrix: handler task runtime PID/script does not match the fixed-route supervisor command line");
  requireCondition(existsSync(manifestPath) && statSync(manifestPath).isFile()
    && /^[a-f0-9]{64}$/i.test(String(provenance?.manifestSha256 || ""))
    && sha256(readFileSync(manifestPath)) === String(provenance.manifestSha256).toLowerCase(),
  "manager-matrix: handler runtime manifest hash is invalid");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`manager-matrix: handler runtime manifest is invalid JSON: ${error?.message || error}`);
  }
  requireCondition(manifest?.schema === "anticodex-runtime-manifest-v2"
    && manifest?.state === "validated"
    && sameNativePath(manifest?.activeRuntime, runtimeRoot)
    && sameNativePath(manifest?.sourceRoot, sourceRoot)
    && manifest?.sourceGitClean === true
    && manifest?.sourceRevisionProvenance === "git"
    && String(manifest?.sourceGitHead || "").toLowerCase() === sourceHead,
  "manager-matrix: handler runtime manifest identity is stale");
  requireCondition(processStartedForManifest(taskRuntimeCreationDateUtc, manifest?.createdAt),
    "manager-matrix: fixed-route supervisor predates runtime manifest generation");
  const fileByPath = new Map(files.map((entry) => [normalizedContractPath(entry?.relativePath), entry]));
  requireCondition(fileByPath.size === files.length && expectedFiles.every((path) => fileByPath.has(path)),
    "manager-matrix: handler provenance file inventory is incomplete or duplicated");
  for (const relativePath of expectedFiles) {
    const entry = fileByPath.get(relativePath);
    const runtimePath = resolve(runtimeRoot, relativePath);
    const sourcePath = resolve(sourceRoot, relativePath);
    const manifestEntry = Object.entries(manifest?.files || {}).find(([path]) => normalizedContractPath(path) === relativePath);
    const expectedHash = String(entry?.fileSha256 || "").toLowerCase();
    requireCondition(insideRoot(runtimePath, runtimeRoot)
      && insideRoot(sourcePath, sourceRoot)
      && existsSync(runtimePath) && statSync(runtimePath).isFile()
      && existsSync(sourcePath) && statSync(sourcePath).isFile()
      && /^[a-f0-9]{64}$/.test(expectedHash)
      && String(entry?.manifestSha256 || "").toLowerCase() === expectedHash
      && String(manifestEntry?.[1] || "").toLowerCase() === expectedHash
      && sha256(readFileSync(runtimePath)) === expectedHash
      && sha256(readFileSync(sourcePath)) === expectedHash,
    `manager-matrix: handler provenance hash mismatch: ${relativePath}`);
  }
  return {
    schema: provenance.schema,
    verified: true,
    runtimeRoot,
    scriptsRoot,
    manifestPath,
    manifestSha256: String(provenance.manifestSha256).toLowerCase(),
    sourceRoot,
    sourceGitHead: sourceHead,
    sourceGitClean: true,
    sourceRevisionProvenance: "git",
    taskRuntimePid,
    taskRuntimeScriptPath,
    taskRuntimeCreationDateUtc,
    files: expectedFiles.map((path) => ({
      relativePath: path,
      fileSha256: String(fileByPath.get(path).fileSha256).toLowerCase(),
      manifestSha256: String(fileByPath.get(path).manifestSha256).toLowerCase(),
    })),
  };
}

function normalizeManager(matrixSource, profileSource, closeSource, protocolSource, releaseBinding, liveTrayEvidence, runtimeIdentity) {
  const wrapper = matrixSource.data;
  const matrix = wrapper?.managerButton?.payload || wrapper;
  requireCondition(wrapper?.ok === true && (wrapper?.managerButton ? wrapper.managerButton?.ok === true : true),
    "manager-matrix: wrapper reported failure");
  const actions = Array.isArray(matrix?.actions) ? matrix.actions : [];
  const uiInteraction = matrix?.uiInteractionEvidence || {};
  const handlerContracts = matrix?.handlerContractEvidence || {};
  const contractEntries = handlerContracts?.contracts && typeof handlerContracts.contracts === "object"
    ? Object.entries(handlerContracts.contracts)
    : [];
  requireCondition(matrix?.ok === true
    && matrix?.mode === "ui-only-matrix"
    && matrix?.zeroSideEffects === true
    && matrix?.usedRealTraffic === false
    && actions.length === managerActions.length
    && new Set(actions).size === managerActions.length
    && actions.every((action, index) => action === managerActions[index])
    && actions.every((action) => {
      const entry = matrix?.results?.[action];
      return entry?.ok === true
        && entry?.actionActualMouseOk === true
        && entry?.managerOpenedNewPage === false;
    }),
  "manager-matrix: exact 20 unique UI interactions or actual-mouse zero-side-effect evidence is incomplete");
  requireCondition(uiInteraction?.schema === "anticodex-manager-ui-interaction-v1"
    && uiInteraction?.scope === "ui-interaction-only"
    && Number(uiInteraction?.passedCount) === managerActions.length
    && exactStringList(uiInteraction?.verifiedActions, managerActions),
  "manager-matrix: 20/20 UI interaction evidence is incomplete");
  requireCondition(handlerContracts?.schema === "anticodex-manager-handler-contract-v1"
    && exactStringList(handlerContracts?.offlineContractVerifiedActions, managerActions)
    && exactStringList(handlerContracts?.safeRealActionAllowlist, safeRealManagerActions)
    && exactStringList(handlerContracts?.liveExecutedActions, [])
    && exactStringList(handlerContracts?.pendingAuthorizedActions, highImpactManagerActions)
    && handlerContracts?.allFunctionsVerified === false
    && contractEntries.length === managerActions.length
    && contractEntries.every(([action, entry], index) => {
      const expected = managerHandlerContractByAction[action];
      return action === managerActions[index]
        && entry?.verified === true
        && String(entry?.kind || "") === expected?.[0]
        && String(entry?.source || "") === expected?.[1]
        && String(entry?.handler || "") === expected?.[2];
    }),
  "manager-matrix: offline handler contract mapping is missing or UI-only evidence claims functional execution");
  const handlerProvenance = validateManagerHandlerProvenance(wrapper, handlerContracts, contractEntries, runtimeIdentity);

  const profile = profileSource.data?.profileEntry || profileSource.data;
  requireCondition(profileSource.data?.ok === true
    && profile?.ok === true
    && profile?.phase === "profile-entry-actual-mouse"
    && profile?.profileEntryText === "管理"
    && profile?.forbiddenEnglishVisible === false
    && profile?.actualMouseOpened === true,
  "manager-profile: exact Chinese 管理 actual-mouse evidence is incomplete");

  const close = closeSource.data?.closeActualMouse || closeSource.data;
  const closeProbes = Array.isArray(close?.probes) ? close.probes : [];
  requireCondition(closeSource.data?.ok === true
    && close?.ok === true
    && close?.phase === "actual-click"
    && closeSource.data?.finalOverlayClosed === true
    && closeProbes.length >= 3
    && ["upper-center", "center", "lower-center"].every((name) => {
      const probe = closeProbes.find((entry) => entry?.name === name);
      return probe?.ok === true && probe?.closed === true && probe?.hasTextNode === false;
    }),
  "manager-close: actual-click three-height pseudo-element evidence is incomplete");

  const upstream = protocolSource.data?.upstreamConfig || protocolSource.data;
  const interaction = upstream?.protocolInteraction || {};
  const before = normalizeProtocol(interaction?.before);
  const alternate = normalizeProtocol(interaction?.alternate);
  const restored = normalizeProtocol(interaction?.restored);
  requireCondition(protocolSource.data?.ok === true
    && upstream?.ok === true
    && upstream?.usedRealTraffic === false
    && interaction?.ok === true
    && interaction?.selectedAlternate === true
    && interaction?.restoredOriginal === true
    && before === "chatCompletions"
    && alternate === "responses"
    && restored === before
    && upstream?.profileUnchanged === true
    && upstream?.closeActualMouse === true
    && upstream?.closeHasTextNode === false
    && Number(upstream?.pageTargetCountBefore) === Number(upstream?.pageTargetCountAfter),
  "manager-protocol: physical Chat Completions/Responses round trip is incomplete");
  requireCondition(sameTarget([
    matrix,
    profileSource.data,
    closeSource.data,
    protocolSource.data,
  ]), "manager evidence targets do not identify the same renderer session");
  requireCondition(targetIdFrom(matrix) === runtimeIdentity.targetId,
    "manager evidence target does not match the task runtime session");
  for (const [label, raw] of [
    ["manager-matrix", wrapper],
    ["manager-profile", profileSource.data],
    ["manager-close", closeSource.data],
    ["manager-protocol", protocolSource.data],
  ]) {
    requireMatchingRuntimeIdentity(raw, runtimeIdentity, label);
  }
  return {
    schema: "anticodex-manager-actual-mouse-matrix-v2",
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    actionCount: actions.length,
    zeroSideEffects: true,
    uiInteraction: {
      scope: "ui-interaction-only",
      verifiedActionIds: [...managerActions],
      verifiedCount: managerActions.length,
    },
    handlerVerification: {
      offlineContractVerifiedActionIds: [...managerActions],
      safeRealActionIds: [...safeRealManagerActions],
      realExecutedActionIds: [],
      pendingAuthorizedActionIds: [...highImpactManagerActions],
      allFunctionsVerified: false,
      contracts: handlerContracts.contracts,
      provenance: handlerProvenance,
    },
    actualMouse: true,
    profileEntryText: "管理",
    forbiddenEnglishVisible: false,
    trayIconPreserved: true,
    liveTrayEvidence,
    closeProbes: ["upper-center", "center", "lower-center"].map((name) => {
      const probe = closeProbes.find((entry) => entry?.name === name);
      return { name, ok: true, actualMouse: true, closed: true, hasTextNode: probe.hasTextNode };
    }),
    protocolInteraction: {
      before,
      alternate,
      restored,
      selectedAlternate: true,
      restoredOriginal: true,
      profileUnchanged: true,
    },
    runtimeIdentity,
    releaseBinding,
  };
}

function normalizeModelSwitches(sources, taskId, releaseBinding, runtimeIdentity) {
  requireCondition(sources.length >= 3, "model-switch: at least three signed probes are required");
  requireCondition(uniqueSourceFiles(sources), "model-switch: source files and hashes must be unique");
  const switches = sources.map((source, index) => {
    const raw = source.data;
    const request = raw?.requestEvidence || {};
    const process = raw?.processIdentity || {};
    const provider = providerFromModel(raw);
    requireCondition(raw?.ok === true
      && raw?.frontendModelProbeOnly === true
      && raw?.requestedRealTraffic === false
      && raw?.usedRealTraffic === false
      && raw?.coverageKind === "desktop-ui-physical-model-switch-no-traffic"
      && raw?.taskId === taskId
      && raw?.expectedTaskId === taskId
      && raw?.sameChatEvidence?.actualMouseClick === true
      && raw?.selection?.ok === true
      && raw?.selection?.actualMouseClick === true
      && targetIdFrom(raw) === runtimeIdentity.targetId
      && ["gemini", "claude", "third-party"].includes(provider),
    `model-switch[${index}]: taskId/runtime session/physical selection/provider evidence is incomplete`);
    requireCondition(Number(request?.beforeCount) === Number(request?.afterCount)
      && Number(request?.beforeLatestRequestRowId) === Number(request?.afterLatestRequestRowId),
    `model-switch[${index}]: model request count changed`);
    requireCondition(Number(process?.supervisorBefore) > 0
      && Number(process?.supervisorBefore) === Number(process?.supervisorAfter)
      && Number(process?.codexPlusPlusBefore) > 0
      && Number(process?.codexPlusPlusBefore) === Number(process?.codexPlusPlusAfter)
      && Number(process?.antiCodexMainBefore) > 0
      && Number(process?.antiCodexMainBefore) === Number(process?.antiCodexMainAfter)
      && Number(process?.supervisorBefore) === runtimeIdentity.supervisorPid
      && Number(process?.codexPlusPlusBefore) === runtimeIdentity.codexPlusPlusPid
      && Number(process?.antiCodexMainBefore) === runtimeIdentity.antiCodexMainPid
      && Number(process?.expectedOriginalCodexPid) === runtimeIdentity.originalCodexPid
      && process?.originalCodexAlive === true,
    `model-switch[${index}]: process identity changed or original Codex exited`);
    return {
      ok: true,
      provider,
      model: String(raw?.selectedModel?.model || ""),
      taskId,
      actualMouse: true,
      requestCountBefore: Number(request.beforeCount),
      requestCountAfter: Number(request.afterCount),
      latestRequestRowIdBefore: Number(request.beforeLatestRequestRowId),
      latestRequestRowIdAfter: Number(request.afterLatestRequestRowId),
      supervisorPidBefore: Number(process.supervisorBefore),
      supervisorPidAfter: Number(process.supervisorAfter),
      codexPlusPlusPidBefore: Number(process.codexPlusPlusBefore),
      codexPlusPlusPidAfter: Number(process.codexPlusPlusAfter),
      antiCodexMainPidBefore: Number(process.antiCodexMainBefore),
      antiCodexMainPidAfter: Number(process.antiCodexMainAfter),
      originalCodexAlive: true,
      sourcePath: source.path,
      sourceSha256: source.sha256,
    };
  });
  const providers = new Set(switches.map((entry) => entry.provider));
  requireCondition(["gemini", "claude", "third-party"].every((provider) => providers.has(provider)),
    "model-switch: Gemini, Claude, and third-party evidence are all required");
  const pidKeys = ["supervisorPidBefore", "codexPlusPlusPidBefore", "antiCodexMainPidBefore"];
  requireCondition(switches.every((entry) => pidKeys.every((key) => entry[key] === switches[0][key])),
    "model-switch: process baseline changed between probes");
  return {
    schema: "anticodex-frontend-model-hot-switch-v1",
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    sameTask: true,
    taskId,
    switches,
    runtimeIdentity,
    releaseBinding,
  };
}

function normalizeShortcutRestores(sources, releaseBinding, runtimeIdentity) {
  requireCondition(sources.length === requiredShortcutRestoreRounds, "shortcut-restore: exactly ten signed taskbar-button probes are required");
  requireCondition(uniqueSourceFiles(sources), "shortcut-restore: source files and hashes must be unique");
  const rounds = sources.map((source, index) => {
    const raw = source.data;
    const taskbarRectangle = raw?.taskbarRectangle;
    const taskbarClickPoint = raw?.taskbarClickPoint;
    requireMatchingRuntimeIdentity(raw, runtimeIdentity, `shortcut-restore[${index}]`);
    requireCondition(raw?.schema === "anticodex-shortcut-restore-acceptance-v1"
      && raw?.ok === true
      && (!Array.isArray(raw?.failures) || raw.failures.length === 0)
      && raw?.activationMode === "taskbar-button"
      && raw?.actualMouse === true
      && raw?.taskbarActivationObserved === true
      && Number.isFinite(raw?.taskbarActivationWaitMs)
      && raw.taskbarActivationWaitMs >= 0
      && raw.taskbarActivationWaitMs <= 2100
      && Number.isFinite(raw?.taskbarClickSentAtMs)
      && raw.taskbarClickSentAtMs >= 0
      && raw?.frameCaptureOrigin === "exact-foreground-window"
      && Number.isFinite(raw?.frameCaptureOriginMs)
      && raw.frameCaptureOriginMs >= raw.taskbarClickSentAtMs
      && raw.taskbarActivationWaitMs === raw.frameCaptureOriginMs - raw.taskbarClickSentAtMs
      && raw?.visibleWindowCriterion === "presentable-exact-executable-v1"
      && raw?.taskbarElement?.name === "Anti-Codex"
      && raw?.taskbarElement?.accessibleName === "Anti-Codex - 1 个运行窗口"
      && raw?.taskbarElement?.provider === "MSAA"
      && Number(raw?.taskbarElement?.role) === 43
      && Number(raw?.taskbarElement?.childId) > 0
      && Number(raw?.taskbarElement?.taskListWindowHandle) > 0
      && raw?.taskbarElement?.taskbarClassName === "MSTaskListWClass"
      && Number(raw?.taskbarElement?.candidateCount) === 1
      && raw?.taskbarElement?.isEnabled === true
      && raw?.taskbarElement?.isOffscreen === false
      && raw?.taskbarElement?.hitTestMatched === true
      && Number.isFinite(taskbarRectangle?.width)
      && taskbarRectangle.width > 0
      && Number.isFinite(taskbarRectangle?.height)
      && taskbarRectangle.height > 0
      && Number.isFinite(taskbarClickPoint?.x)
      && taskbarClickPoint.x >= Number(taskbarRectangle?.left)
      && taskbarClickPoint.x <= Number(taskbarRectangle?.right)
      && Number.isFinite(taskbarClickPoint?.y)
      && taskbarClickPoint.y >= Number(taskbarRectangle?.top)
      && taskbarClickPoint.y <= Number(taskbarRectangle?.bottom)
      && raw?.samePid === true
      && raw?.sameHwnd === true
      && raw?.sameExecutable === true
      && raw?.sameCdpTarget === true
      && Number(raw?.windowHandleBefore) > 0
      && Number(raw?.windowHandleAfter) === Number(raw?.windowHandleBefore)
      && Number.isFinite(raw?.firstFrame?.elapsedMs)
      && raw.firstFrame.elapsedMs >= raw.frameCaptureOriginMs
      && Number.isFinite(raw?.firstFrame?.standardDeviation)
      && raw.firstFrame.standardDeviation >= 0
      && Number(raw?.firstFrame?.sampleCount) === 640
      && Number.isFinite(raw?.firstFrameDelayMs)
      && raw.firstFrameDelayMs >= 0
      && raw.firstFrameDelayMs <= 100
      && raw.firstFrameDelayMs === raw.firstFrame.elapsedMs - raw.frameCaptureOriginMs
      && Number.isFinite(raw?.maxSampleIntervalMs)
      && raw.maxSampleIntervalMs > 0
      && raw.maxSampleIntervalMs <= 125
      && Number(raw?.earlyFrameCount) >= 8
      && Number(raw?.frameSamplingThresholds?.maximumFirstFrameDelayMs) === 100
      && Number(raw?.frameSamplingThresholds?.maximumFrameSampleIntervalMs) === 125
      && Number(raw?.frameSamplingThresholds?.minimumEarlyFrameCount) === 8
      && Number(raw?.frameSamplingThresholds?.earlyWindowMs) === 750
      && Number(raw?.expectedMainPid) > 0
      && Number(raw?.expectedOriginalCodexPid) > 0
      && Number(raw?.expectedMainPid) === runtimeIdentity.antiCodexMainPid
      && Number(raw?.expectedOriginalCodexPid) === runtimeIdentity.originalCodexPid
      && raw?.minimizedObserved === true
      && raw?.reminimizedAfterRestore === false
      && Number(raw?.restoredAtMs) > 0
      && Number(raw?.restoredAtMs) === raw.frameCaptureOriginMs
      && raw?.deadlineState?.visible === true
      && raw?.deadlineState?.minimized === false
      && raw?.deadlineState?.exactForeground === true
      && raw?.probeRecoveryApplied === false
      && Number(raw?.maxRootProcessCount) === 1
      && Number(raw?.maxVisibleWindowCount) === 1
      && Number(raw?.maxVisibleTopLevelWindowCount) === 1
      && Number(raw?.maxAppPageCount) === 1
      && Number(raw?.appPagesAfter) === 1
      && Number(raw?.blankFrameCount) === 0
      && Number(raw?.frameCount) >= 2
      && raw?.originalCodexAlive === true
      && Array.isArray(raw?.after?.rootProcessIds)
      && raw.after.rootProcessIds.length === 1
      && Number(raw.after.rootProcessIds[0]) === Number(raw.expectedMainPid)
      && Array.isArray(raw?.after?.visibleWindowProcessIds)
      && raw.after.visibleWindowProcessIds.length === 1
      && Number(raw.after.visibleWindowProcessIds[0]) === Number(raw.expectedMainPid)
      && Array.isArray(raw?.after?.visibleTopLevelWindowHandles)
      && raw.after.visibleTopLevelWindowHandles.length === 1
      && Number(raw.after.visibleTopLevelWindowHandles[0]) === Number(raw.windowHandleBefore)
      && Array.isArray(raw?.seenVisibleTopLevelWindowHandles)
      && raw.seenVisibleTopLevelWindowHandles.length === 1
      && Number(raw.seenVisibleTopLevelWindowHandles[0]) === Number(raw.windowHandleBefore)
      && Array.isArray(raw?.observedTopLevelWindows)
      && raw.observedTopLevelWindows.filter((entry) => entry?.presentable === true).length === 1
      && Number(raw.observedTopLevelWindows.find((entry) => entry?.presentable === true)?.handle)
        === Number(raw.windowHandleBefore),
    `shortcut-restore[${index}]: MSAA taskbar actual mouse, runtime main PID/HWND/executable, high-cadence frame sampling, or single-window evidence is incomplete`);
    return { ...raw, sourcePath: source.path, sourceSha256: source.sha256 };
  });
  requireCondition(rounds.every((round) => Number(round.expectedMainPid) === Number(rounds[0].expectedMainPid)
    && Number(round.expectedOriginalCodexPid) === Number(rounds[0].expectedOriginalCodexPid)),
  "shortcut-restore: process baseline changed between rounds");
  return {
    schema: "anticodex-shortcut-restore-matrix-v1",
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    rounds,
    runtimeIdentity,
    releaseBinding,
  };
}

async function main() {
  const failures = [];
  let payload;
  invalidateNormalizedOutputs();
  try {
    const missing = requiredSingleFlags.filter((flag) => values(flag).length !== 1);
    if (missing.length > 0) throw new Error(`missing or repeated required arguments: ${missing.join(", ")}`);
    if (values("--task-artifact").length < 3) throw new Error("--task-artifact must be supplied at least three times");
    if (values("--model-switch").length < 3) throw new Error("--model-switch must be supplied at least three times");
    if (values("--shortcut-restore").length !== requiredShortcutRestoreRounds) {
      throw new Error("--shortcut-restore must be supplied exactly ten times for taskbar-button acceptance");
    }

    const taskReceipt = readRaw(value("--task-receipt"), { requireSigned: true, label: "task-receipt" });
    const managerMatrix = readRaw(value("--manager-matrix"), { requireSigned: true, label: "manager-matrix" });
    const managerProfile = readRaw(value("--manager-profile"), { requireSigned: true, label: "manager-profile" });
    const managerClose = readRaw(value("--manager-close"), { requireSigned: true, label: "manager-close" });
    const managerProtocol = readRaw(value("--manager-protocol"), { requireSigned: true, label: "manager-protocol" });
    const modelSwitchSources = values("--model-switch").map((path, index) =>
      readRaw(path, { requireSigned: true, label: `model-switch[${index}]` }));
    const shortcutSources = values("--shortcut-restore").map((path, index) =>
      readRaw(path, { requireSigned: true, label: `shortcut-restore[${index}]` }));
    const releaseSource = readRaw(value("--release-binding-evidence"), { requireSigned: true, label: "release-binding-evidence" });
    const syncSource = readRaw(value("--sync-readiness-evidence"), { requireSigned: true, label: "sync-readiness-evidence" });
    const liveTraySource = readRaw(value("--live-tray-evidence"), { requireSigned: true, label: "live-tray-evidence" });

    const releaseBinding = releaseBindingFrom(releaseSource.data);
    requireCondition(validReleaseBinding(releaseBinding), "release-binding-evidence: invalid current release binding");
    requireCondition(releaseBindingFields.every((field) => releaseBinding[field] !== undefined),
      "release-binding-evidence: release binding is incomplete");
    requireCondition(syncSource.sha256 === String(releaseBinding.syncReadinessSha256).toLowerCase(),
      "sync-readiness-evidence: hash does not match current release binding");
    requireCondition(syncSource.data?.ok === true
      && syncSource.data?.noTraffic === true
      && syncSource.data?.usedRealTraffic === false,
    "sync-readiness-evidence: current no-traffic sync readiness is not green");
    const task = normalizeTaskReceipt(taskReceipt, values("--task-artifact"), releaseBinding);
    const liveTrayEvidence = normalizeLiveTray(liveTraySource, task.runtimeIdentity);
    const normalized = {
      taskManifest: task.normalized,
      managerEvidence: normalizeManager(
        managerMatrix,
        managerProfile,
        managerClose,
        managerProtocol,
        releaseBinding,
        liveTrayEvidence,
        task.runtimeIdentity,
      ),
      modelSwitchEvidence: normalizeModelSwitches(modelSwitchSources, task.taskId, releaseBinding, task.runtimeIdentity),
      shortcutRestoreEvidence: normalizeShortcutRestores(shortcutSources, releaseBinding, task.runtimeIdentity),
      releaseBindingEvidence: {
        schema: "anticodex-release-binding-report-v1",
        releaseBinding,
        sourceEvidence: {
          releaseBinding: { path: releaseSource.path, sha256: releaseSource.sha256 },
          syncReadiness: { path: syncSource.path, sha256: syncSource.sha256 },
        },
      },
    };
    const checkedAt = new Date().toISOString();
    for (const output of Object.values(normalized)) output.checkedAt = checkedAt;

    const outputs = Object.fromEntries(Object.entries(normalized).map(([id, output]) => [
      id,
      writeSignedAtomic(resolve(outputRoot, outputNames[id]), output),
    ]));
    const rawSources = [
      taskReceipt,
      managerMatrix,
      managerProfile,
      managerClose,
      managerProtocol,
      ...modelSwitchSources,
      ...shortcutSources,
      releaseSource,
      syncSource,
      liveTraySource,
    ];
    payload = {
      schema: "anticodex-gate5-evidence-build-v1",
      ok: true,
      checkedAt,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      taskId: task.taskId,
      outputRoot,
      outputs,
      sources: rawSources.map((source) => ({
        label: source.label,
        path: source.path,
        sha256: source.sha256,
        signed: source.signed,
        checkedAt: source.checkedAt,
        timestampKind: source.timestampKind,
        ageHours: source.ageHours,
      })),
      failures,
    };
  } catch (error) {
    invalidateNormalizedOutputs();
    failures.push(error instanceof Error ? error.message : String(error));
    payload = {
      schema: "anticodex-gate5-evidence-build-v1",
      ok: false,
      checkedAt: new Date().toISOString(),
      requestedRealTraffic: false,
      usedRealTraffic: false,
      outputRoot,
      failures,
    };
  }
  console.log(JSON.stringify(payload, null, compact ? 0 : 2));
  process.exit(payload.ok ? 0 : 1);
}

main();
