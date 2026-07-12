export function countMarkerOccurrences(text, marker) {
  const value = String(text || "");
  const needle = String(marker || "");
  if (!needle) return 0;
  return value.split(needle).length - 1;
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
  visit(history);
  return matched.size;
}
