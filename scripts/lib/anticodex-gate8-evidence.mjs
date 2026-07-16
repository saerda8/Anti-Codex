import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MIN_LONG_CONTEXT_CHARS = 65_536;
const MAX_QUOTA_PROBE_AGE_MS = 10 * 60_000;
const MULTI_STYLE_JOURNEYS = Object.freeze({
  "interrupted-migration-three-turn": 3,
  "greenfield-project-three-turn": 4,
});

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
