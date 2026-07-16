export function countMarkerOccurrences(text, marker) {
  const value = String(text || "");
  const needle = String(marker || "");
  if (!needle) return 0;
  return value.split(needle).length - 1;
}

export function classifyReconnectOutcome({
  reconnectSeen = false,
  answerText = "",
  completionObserved = false,
  stableIdleObserved = false,
} = {}) {
  const terminalProviderError = String(answerText || "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => /RESOURCE_EXHAUSTED|Individual quota reached|quota (?:has been )?(?:reached|exhausted)|rate limit exceeded|unexpected status (?:4\d\d|5\d\d)|(?:stream )?disconnected before completion|额度(?:已)?(?:用完|耗尽)|配额(?:已)?(?:用完|耗尽)/i.test(line))
    ?.slice(0, 600) || null;
  const recovered = reconnectSeen === true
    && terminalProviderError === null
    && completionObserved === true
    && stableIdleObserved === true;
  return {
    reconnectSeen: reconnectSeen === true,
    recovered,
    unresolved: terminalProviderError !== null || (reconnectSeen === true && !recovered),
    terminalProviderError,
  };
}

export function assistantMessageIsVisibleProgress(text, marker = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  const finalMarker = String(marker || "").trim();
  return !finalMarker || !value.includes(finalMarker);
}

export function utf8BytesExactlyMatch(actualBytes, expectedText) {
  if (!(actualBytes instanceof Uint8Array)) return false;
  return Buffer.from(actualBytes).equals(Buffer.from(String(expectedText ?? ""), "utf8"));
}

export function countNewAssistantMarkers({ visibleText, marker, baselineMarkerCount = 0, submittedPrompt = "" } = {}) {
  const total = countMarkerOccurrences(visibleText, marker);
  const submittedPromptMarkers = countMarkerOccurrences(submittedPrompt, marker);
  return Math.max(0, total - Math.max(0, Number(baselineMarkerCount) || 0) - submittedPromptMarkers);
}

export function countVerifiedNewAssistantMarkers({
  visibleNewMarkerCount = 0,
  recentVisibleText = "",
  marker = "",
  assistantHistoryCount = 0,
  assistantHistoryBaselineCount = 0,
} = {}) {
  const visibleMarkerSeen = Number(visibleNewMarkerCount || 0) > 0
    || countMarkerOccurrences(recentVisibleText, marker) > 0;
  if (!visibleMarkerSeen) return 0;
  return Math.max(0, Number(assistantHistoryCount || 0) - Number(assistantHistoryBaselineCount || 0));
}

export function countObservedAssistantMarkers(evidence = {}) {
  const visibleAndHistoryCount = countVerifiedNewAssistantMarkers(evidence);
  if (visibleAndHistoryCount > 0) return visibleAndHistoryCount;
  return Math.max(
    0,
    Number(evidence.assistantHistoryCount || 0) - Number(evidence.assistantHistoryBaselineCount || 0),
  );
}

export function composerHasUnsubmittedMarker({ composerText = "", marker = "", answerMarkerCount = 0 } = {}) {
  const needle = String(marker || "");
  if (!needle || !String(composerText || "").includes(needle)) return false;
  return Number(answerMarkerCount || 0) < 1;
}

export function responsesPayloadAdvanceConfirmsSubmit({
  beforePayloadCount = 0,
  currentPayloadCount = 0,
  requestKind = "",
  latestUserChars = 0,
  inputItems = 0,
  relayTextDeltaChars = 0,
  relayToolCallCount = 0,
} = {}) {
  if (Number(currentPayloadCount || 0) <= Number(beforePayloadCount || 0)) return false;
  if (String(requestKind || "") === "task_title") return false;
  return Number(latestUserChars || 0) > 0
    || Number(inputItems || 0) > 0
    || Number(relayTextDeltaChars || 0) > 0
    || Number(relayToolCallCount || 0) > 0;
}

export function pendingDesktopTaskConfirmsSubmit({ composerCleared = false, visibleIdleEvidence = null } = {}) {
  return composerCleared === true
    && visibleIdleEvidence?.ok === false
    && visibleIdleEvidence?.state?.hasStop === true;
}

export function freshDesktopTurnConfirmsSubmit({
  beforeMarkerEntryIds = [],
  afterMarkerEntryIds = [],
  assistantMarkerBaselineCount = 0,
  assistantMarkerCount = 0,
} = {}) {
  const before = new Set((Array.isArray(beforeMarkerEntryIds) ? beforeMarkerEntryIds : []).map(String));
  const freshMarkerTurn = (Array.isArray(afterMarkerEntryIds) ? afterMarkerEntryIds : [])
    .map(String)
    .some((entryId) => !before.has(entryId));
  return freshMarkerTurn
    || Number(assistantMarkerCount || 0) > Number(assistantMarkerBaselineCount || 0);
}

export function latestMarkerTurnCompleted(rolloutBundles = []) {
  const latestBundle = Array.isArray(rolloutBundles) ? rolloutBundles[0] : null;
  if (!latestBundle) return false;
  if (Array.isArray(latestBundle.markerTurnIds) && latestBundle.markerTurnIds.length > 0) {
    return latestBundle.latestMarkerTurnComplete === true;
  }
  return latestBundle.taskCompleteSeen === true;
}

export function resultDrivenTurnCompletionReady({
  enabled = false,
  rolloutBundles = [],
  composerText = "",
  marker = "",
  routeReady = false,
} = {}) {
  return enabled === true
    && routeReady === true
    && latestMarkerTurnCompleted(rolloutBundles)
    && !composerHasUnsubmittedMarker({ composerText, marker, answerMarkerCount: 0 });
}

export function advanceStableIdleWindow(state, {
  nowMs = Date.now(),
  idle = false,
  activitySequence = 0,
} = {}) {
  const sequence = String(activitySequence ?? "");
  if (!idle) return { stableSinceMs: null, activitySequence: sequence };
  const unchanged = state?.stableSinceMs != null && state?.activitySequence === sequence;
  return {
    stableSinceMs: unchanged ? state.stableSinceMs : Number(nowMs),
    activitySequence: sequence,
  };
}

export function stableIdleWindowReady(state, { nowMs = Date.now(), quietMs = 10_000 } = {}) {
  if (state?.stableSinceMs == null) return false;
  return Number(nowMs) - Number(state.stableSinceMs) >= Math.max(0, Number(quietMs) || 0);
}

export function stableIdleTimeoutForTaskMode(taskMode = "") {
  return new Set([
    "exact-marker",
    "local-project",
    "coding-project",
    "multi-turn-project",
    "complex-project",
    "autonomous-reasoning",
    "report-site",
    "agentic-step-flow",
    "repo-file-edit",
    "repo-multi-file-edit",
  ]).has(String(taskMode || "")) ? 60_000 : 20_000;
}

export function taskScopedToolOutputObserved(history = null) {
  return history?.taskScopedToolOutputSeen === true || history?.taskToolOutputSeen === true;
}

export function codexLikeAgentProcessProven(history = null, { minVisibleProgress = 2 } = {}) {
  const requiredProgress = Math.max(1, Number(minVisibleProgress) || 1);
  return history?.assistantHasFinalMarker === true
    && (Number(history?.taskToolCallCount) || 0) > 0
    && taskScopedToolOutputObserved(history)
    && (Number(history?.visibleProgressCount) || 0) >= requiredProgress
    && (Number(history?.distinctVisibleProgressCount) || 0) >= requiredProgress
    && history?.artifactGuardUsed !== true;
}

export function repoMultiTurnCompletionReady({
  artifactFailureCount = 0,
  answerMarkerCount = 0,
  composerHasMarker = false,
  diagnosticsIdle = false,
  responseHistory = null,
} = {}) {
  return Number(artifactFailureCount || 0) === 0
    && Number(answerMarkerCount || 0) >= 1
    && composerHasMarker !== true
    && diagnosticsIdle === true
    && taskScopedToolOutputObserved(responseHistory);
}

export function multiTurnFirstTurnReadyForFollowup({ turnOk = false, evidence = null } = {}) {
  const files = evidence?.files || {};
  return turnOk === true
    && files.packageJson === true
    && files.wordTally === true
    && files.testFile === true
    && files.doneTxt === true
    && evidence?.firstDoneExact === true
    && evidence?.exportsTallyWords === true
    && evidence?.testPassed === true
    && evidence?.cliPassed === true
    && evidence?.responseHistory?.taskToolOutputSeen === true;
}

export function hasAssistantFinalMarkerEvidence({
  answerMarkerCount = 0,
  responseHistoryMarkerSeen = false,
  assistantHasFinalMarker = false,
} = {}) {
  return Number(answerMarkerCount || 0) >= 1
    || responseHistoryMarkerSeen === true
    || assistantHasFinalMarker === true;
}

export function filterAssistantMarkerObservationFailures(failures = [], finalMarkerObserved = false) {
  const values = Array.isArray(failures) ? failures : [];
  if (!finalMarkerObserved) return [...values];
  return values.filter(failure => !/assistant reply marker was not observed/i.test(String(failure || "")));
}

export function shouldRecoverIdleAutonomousTurn({
  diagnosticsIdle = false,
  elapsedMs = 0,
  artifactFailureCount = 0,
  waitMs = 30_000,
} = {}) {
  return diagnosticsIdle === true
    && Number(artifactFailureCount || 0) > 0
    && Number(elapsedMs || 0) >= Math.max(0, Number(waitMs || 0));
}

export function autonomousContinuationHasFreshCompletion({
  answerMarkerCount = 0,
  hasRequiredFiles = false,
  hasToolEvidence = false,
} = {}) {
  return Number(answerMarkerCount || 0) >= 1
    && hasRequiredFiles === true
    && hasToolEvidence === true;
}

export function parseWordCountCliOutput(output = "") {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}

  if (text.startsWith("{") && text.endsWith("}")) {
    const counts = {};
    const entries = text.slice(1, -1).split(",").map(entry => entry.trim()).filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(-?\d+(?:\.\d+)?)$/);
      if (!match) return null;
      counts[match[1]] = Number(match[2]);
    }
    if (Object.keys(counts).length > 0) return counts;
  }

  const counts = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    counts[match[1]] = Number(match[2]);
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function responseItemText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return String(part.text ?? part.output_text ?? part.input_text ?? "");
    }).join("\n");
  }
  if (!content || typeof content !== "object") return "";
  return String(content.text ?? content.output_text ?? content.input_text ?? "");
}

export function collectCodexRolloutMarkerEvidence(records = [], marker = "") {
  const needle = String(marker || "");
  const models = new Set();
  const contextItems = [];
  const assistantMarkerMessages = new Set();
  const markerTurnIds = [];
  const completedMarkerTurnIds = new Set();
  let sessionId = "";
  let sessionCwd = "";
  let currentTurnId = "";
  let userMarkerSeen = false;

  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    if (!record || typeof record !== "object") continue;
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
    if (record.type === "session_meta") {
      sessionId ||= String(payload.id || payload.session_id || "");
      sessionCwd ||= String(payload.cwd || payload.session?.cwd || "");
      continue;
    }
    if (record.type === "turn_context") {
      currentTurnId = String(payload.turn_id || payload.id || currentTurnId || "");
      const model = String(payload.model || payload.collaboration_mode?.settings?.model || "").trim();
      if (model) models.add(model);
      continue;
    }
    if (record.type === "event_msg") {
      if (payload.type === "task_started") {
        currentTurnId = String(payload.turn_id || payload.id || currentTurnId || "");
      } else if (payload.type === "task_complete") {
        const completedTurnId = String(payload.turn_id || currentTurnId || markerTurnIds.at(-1) || "");
        if (markerTurnIds.includes(completedTurnId)) completedMarkerTurnIds.add(completedTurnId);
      }
      continue;
    }
    if (record.type !== "response_item") continue;

    const item = payload;
    const isMarkerPrompt = item.type === "message"
      && item.role === "user"
      && needle
      && responseItemText(item.content).includes(needle);
    if (isMarkerPrompt) {
      const markerTurnId = currentTurnId
        || String(item.id || record.timestamp || `marker-user-${index}`);
      if (!markerTurnIds.includes(markerTurnId)) markerTurnIds.push(markerTurnId);
      userMarkerSeen = true;
    }
    if (!userMarkerSeen) continue;

    contextItems.push(item);
    if (item.type === "message" && item.role === "assistant") {
      const text = responseItemText(item.content);
      if (needle && text.includes(needle)) {
        assistantMarkerMessages.add(String(item.id || `content:${text}`));
      }
    }
  }

  const latestMarkerTurnId = markerTurnIds.at(-1) || "";

  return {
    sessionId,
    sessionCwd,
    userMarkerSeen,
    models: [...models],
    assistantMarkerCount: assistantMarkerMessages.size,
    taskCompleteSeen: completedMarkerTurnIds.size > 0,
    markerTurnIds,
    completedMarkerTurnIds: markerTurnIds.filter((turnId) => completedMarkerTurnIds.has(turnId)),
    latestMarkerTurnId,
    latestMarkerTurnComplete: latestMarkerTurnId !== "" && completedMarkerTurnIds.has(latestMarkerTurnId),
    contextItems,
  };
}

function responseHistoryEntryLooksLikeTaskTitle(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (String(entry.requestKind || "") === "task_title") return true;
  const contextItems = Array.isArray(entry.contextItems) ? entry.contextItems : [];
  const legacyInputItems = Array.isArray(entry.inputItems) ? entry.inputItems : [];
  const inputCount = Number.isInteger(entry.inputItemCount)
    ? Math.max(0, Math.min(contextItems.length, entry.inputItemCount))
    : contextItems.length;
  const inputItems = [...legacyInputItems, ...contextItems.slice(0, inputCount)];
  return inputItems.some((item) => item?.type === "message"
    && item?.role === "user"
    && /provide a short title for a task|Generate a concise UI title/i.test(responseItemText(item.content)));
}

export function countUniqueAssistantMarkerMessages(history, marker) {
  const needle = String(marker || "");
  if (!needle || !history || typeof history !== "object") return 0;
  const visited = new Set();
  const matched = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value.type === "message" && value.role === "assistant") {
      const text = responseItemText(value.content);
      if (text.includes(needle)) matched.add(String(value.id || `content:${text}`));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  const roots = Array.isArray(history.entries)
    ? history.entries.filter((entry) => !responseHistoryEntryLooksLikeTaskTitle(entry))
    : [history];
  for (const root of roots) visit(root);
  return matched.size;
}

export function findScopedCommandViolations(commands = [], {
  artifactDir = "",
  allowedAbsolutePaths = [],
  allowedRuntimePaths = [],
} = {}) {
  const artifactRoot = normalizeWindowsEvidencePath(artifactDir);
  const allowedRoots = [artifactRoot, ...allowedAbsolutePaths.map(normalizeWindowsEvidencePath)].filter(Boolean);
  const allowedRuntimeRoots = allowedRuntimePaths.map(normalizeWindowsEvidencePath).filter(Boolean);
  const allowedCommandRoots = [...allowedRoots, ...allowedRuntimeRoots];
  const violations = [];
  const seen = new Set();
  const record = (commandIndex, reason, evidence) => {
    const key = `${commandIndex}\0${reason}\0${evidence}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ commandIndex, reason, evidence: String(evidence || "").slice(0, 500) });
  };

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
    const entry = commands[commandIndex];
    const command = typeof entry === "object" && entry !== null
      ? String(entry.command || entry.cmd || entry.script || "")
      : String(entry || "");
    const workdir = typeof entry === "object" && entry !== null
      ? String(entry.workdir || entry.cwd || "")
      : "";
    const normalizedWorkdir = normalizeWindowsEvidencePath(workdir);
    if (normalizedWorkdir
      && !allowedRoots.some((root) => normalizedWorkdir === root || normalizedWorkdir.startsWith(`${root}/`))) {
      record(commandIndex, "workdir_outside_artifact", workdir);
    }
    const normalized = command.replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();
    const forbiddenScan = allowedRuntimeRoots.reduce(
      (value, root) => value.replaceAll(root, "/allowed-native-runtime"),
      normalized,
    );
    const forbiddenEvidence = [
      [/(?:^|[\/])\.gemini\/antigravity\/brain(?:[\/]|$)/i, "private_antigravity_history"],
      [/(?:^|[\/])anticodex\/(?:reports|response-history\.json|codex-home[^\/]*|visualizations)(?:[\/]|$)/i, "private_anticodex_runtime"],
      [/(?:^|[\s'"`./\\])translator(?:[\/\\]|[\s'"`;]|$)/i, "product_source_outside_artifact"],
      [/(?:^|[\s'"`./\\])scripts(?:[\/\\]|[\s'"`;]|$)/i, "product_source_outside_artifact"],
      [/(?:^|[\s'"`./\\])deepcodex\.app(?:[\/\\]|[\s'"`;]|$)/i, "product_source_outside_artifact"],
      [/(?:^|[\s'"`./\\])src(?:[\/\\]|[\s'"`;]|$)/i, "product_source_outside_artifact"],
      [/(?:^|[;\r\n]\s*)git\s+(?:status|config)\b/i, "host_repository_probe"],
      [/(?:^|[\s'"`])\.\.[\/\\]/i, "parent_directory_escape"],
    ];
    for (const [pattern, reason] of forbiddenEvidence) {
      const match = forbiddenScan.match(pattern);
      if (match) record(commandIndex, reason, match[0].trim() || reason);
    }

    const absolutePaths = command.match(/(?<![A-Za-z])[A-Za-z]:[\\/][^'"`\r\n;|<>]*/g) || [];
    for (const rawPath of absolutePaths) {
      const path = normalizeWindowsEvidencePath(rawPath.replace(/[\s,)\]}]+$/g, ""));
      if (!path || allowedCommandRoots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
      record(commandIndex, "absolute_path_outside_artifact", rawPath.trim());
    }

    if (/(?:\$env:appdata|%appdata%|\$env:userprofile|%userprofile%)[\s\S]{0,160}(?:anticodex|\.gemini)/i.test(command)) {
      record(commandIndex, "private_runtime_environment_path", compactEvidenceCommand(command));
    }
    if (normalized.includes("g:/trae-project") && !allowedRoots.some((root) => root.startsWith("g:/trae-project"))) {
      record(commandIndex, "host_workspace_outside_artifact", "G:/Trae-Project");
    }
  }
  return violations;
}

function normalizeWindowsEvidencePath(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function compactEvidenceCommand(command) {
  return String(command || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
