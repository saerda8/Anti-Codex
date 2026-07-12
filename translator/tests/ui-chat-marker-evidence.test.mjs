import test from "node:test";
import assert from "node:assert/strict";
import {
  autonomousContinuationHasFreshCompletion,
  composerHasUnsubmittedMarker,
  countMarkerOccurrences,
  countNewAssistantMarkers,
  countObservedAssistantMarkers,
  countVerifiedNewAssistantMarkers,
  countUniqueAssistantMarkerMessages,
  filterAssistantMarkerObservationFailures,
  hasAssistantFinalMarkerEvidence,
  parseWordCountCliOutput,
  pendingDesktopTaskConfirmsSubmit,
  responsesPayloadAdvanceConfirmsSubmit,
  shouldRecoverIdleAutonomousTurn,
} from "../../scripts/lib/ui-chat-marker-evidence.mjs";

test("marker counting treats custom marker text literally", () => {
  assert.equal(countMarkerOccurrences("DONE[1] DONE[1]", "DONE[1]"), 2);
});

test("historical and submitted user markers do not count as an assistant reply", () => {
  const marker = "GEMINI_V6_VERSION_OK_20260712";
  const history = `old user ${marker}`;
  const prompt = `finish with ${marker}`;
  assert.equal(countNewAssistantMarkers({
    visibleText: `${history}\n${prompt}`,
    marker,
    baselineMarkerCount: 1,
    submittedPrompt: prompt,
  }), 0);
});

test("only markers added after history and the submitted prompt count as assistant evidence", () => {
  const marker = "GEMINI_V6_VERSION_OK_20260712";
  const prompt = `finish with ${marker}`;
  assert.equal(countNewAssistantMarkers({
    visibleText: `old user ${marker}\n${prompt}\nassistant\n${marker}`,
    marker,
    baselineMarkerCount: 1,
    submittedPrompt: prompt,
  }), 1);
});

test("response history confirms a new assistant marker when the virtualized DOM count does not grow", () => {
  const marker = "GEMINI_V6_FINAL_CLOSURE_OK_20260712";
  assert.equal(countVerifiedNewAssistantMarkers({
    visibleNewMarkerCount: 0,
    recentVisibleText: `task completed\n${marker}`,
    marker,
    assistantHistoryCount: 1,
    assistantHistoryBaselineCount: 0,
  }), 1);
  assert.equal(countVerifiedNewAssistantMarkers({
    visibleNewMarkerCount: 0,
    recentVisibleText: `user prompt asks for ${marker}`,
    marker,
    assistantHistoryCount: 0,
    assistantHistoryBaselineCount: 0,
  }), 0);
});

test("a new assistant-history marker can settle a virtualized UI wait", () => {
  assert.equal(countObservedAssistantMarkers({
    visibleNewMarkerCount: 0,
    recentVisibleText: "tool output only",
    marker: "UI_MULTI_TURN_PROJECT_SMOKE_HISTORY_123",
    assistantHistoryCount: 2,
    assistantHistoryBaselineCount: 1,
  }), 1);
  assert.equal(countObservedAssistantMarkers({
    visibleNewMarkerCount: 0,
    recentVisibleText: "user prompt only",
    marker: "UI_MULTI_TURN_PROJECT_SMOKE_HISTORY_123",
    assistantHistoryCount: 1,
    assistantHistoryBaselineCount: 1,
  }), 0);
});

test("a hidden stale composer marker does not block a history-confirmed completion", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_STALE_COMPOSER_123";
  assert.equal(composerHasUnsubmittedMarker({
    composerText: `hidden prompt ${marker}`,
    marker,
    answerMarkerCount: 1,
  }), false);
  assert.equal(composerHasUnsubmittedMarker({
    composerText: `unsent prompt ${marker}`,
    marker,
    answerMarkerCount: 0,
  }), true);
});

test("a new real task payload confirms submit before response history is persisted", () => {
  assert.equal(responsesPayloadAdvanceConfirmsSubmit({
    beforePayloadCount: 32,
    currentPayloadCount: 33,
    requestKind: "agent_task",
    inputItems: 1,
  }), true);
  assert.equal(responsesPayloadAdvanceConfirmsSubmit({
    beforePayloadCount: 33,
    currentPayloadCount: 33,
    requestKind: "agent_task",
    inputItems: 1,
  }), false);
});

test("a background task-title payload never confirms a desktop task submit", () => {
  assert.equal(responsesPayloadAdvanceConfirmsSubmit({
    beforePayloadCount: 32,
    currentPayloadCount: 33,
    requestKind: "task_title",
    inputItems: 1,
  }), false);
});

test("a cleared composer plus a visible stop control confirms a pending desktop task", () => {
  assert.equal(pendingDesktopTaskConfirmsSubmit({
    composerCleared: true,
    visibleIdleEvidence: { ok: false, state: { hasStop: true } },
  }), true);
  assert.equal(pendingDesktopTaskConfirmsSubmit({
    composerCleared: true,
    visibleIdleEvidence: { ok: false, state: { hasStop: false } },
  }), false);
  assert.equal(pendingDesktopTaskConfirmsSubmit({
    composerCleared: false,
    visibleIdleEvidence: { ok: false, state: { hasStop: true } },
  }), false);
});

test("user prompts and tool outputs never count as assistant marker messages", () => {
  const marker = "V6_ARTIFACT_RECOVERY_OK_20260712";
  const history = {
    entries: [{
      contextItems: [
        { id: "user-1", type: "message", role: "user", content: [{ type: "input_text", text: `finish with ${marker}` }] },
        { id: "call-1", type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: `Write-Output '${marker}'` }) },
        { id: "output-1", type: "function_call_output", call_id: "call-1", output: `Current user task reminder: ${marker}` },
      ],
    }],
  };

  assert.equal(countUniqueAssistantMarkerMessages(history, marker), 0);
  history.entries[0].contextItems.push({
    id: "assistant-1",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: `恢复完成。\n${marker}` }],
  });
  assert.equal(countUniqueAssistantMarkerMessages(history, marker), 1);
  history.entries.push({ contextItems: [history.entries[0].contextItems.at(-1)] });
  assert.equal(countUniqueAssistantMarkerMessages(history, marker), 1);
});

test("tool-only completion never satisfies final assistant marker evidence", () => {
  assert.equal(hasAssistantFinalMarkerEvidence({
    answerMarkerCount: 0,
    responseHistoryMarkerSeen: false,
    assistantHasFinalMarker: false,
    markerToolOutputSeen: true,
  }), false);
  assert.equal(hasAssistantFinalMarkerEvidence({ answerMarkerCount: 1 }), true);
  assert.equal(hasAssistantFinalMarkerEvidence({ responseHistoryMarkerSeen: true }), true);
  assert.equal(hasAssistantFinalMarkerEvidence({ assistantHasFinalMarker: true }), true);
});

test("word-count CLI evidence accepts JSON, key-value lines, and Node object output", () => {
  assert.deepEqual(parseWordCountCliOutput('{"red":2,"blue":1,"green":1}'), {
    red: 2,
    blue: 1,
    green: 1,
  });
  assert.deepEqual(parseWordCountCliOutput("red=2\nblue=1\ngreen=1"), {
    red: 2,
    blue: 1,
    green: 1,
  });
  assert.deepEqual(parseWordCountCliOutput("{ red: 2, blue: 1, green: 1 }"), {
    red: 2,
    blue: 1,
    green: 1,
  });
  assert.equal(parseWordCountCliOutput("tests passed"), null);
});

test("history-backed final marker removes only the stale UI marker failure", () => {
  const failures = [
    "assistant reply marker was not observed after the submitted prompt in the desktop UI",
    "node:test did not pass",
  ];
  assert.deepEqual(filterAssistantMarkerObservationFailures(failures, true), [
    "node:test did not pass",
  ]);
  assert.deepEqual(filterAssistantMarkerObservationFailures(failures, false), failures);
});

test("idle incomplete autonomous turns recover promptly despite delayed tool history", () => {
  assert.equal(shouldRecoverIdleAutonomousTurn({
    diagnosticsIdle: true,
    elapsedMs: 30_000,
    artifactFailureCount: 6,
    hasToolEvidence: true,
  }), true);
  assert.equal(shouldRecoverIdleAutonomousTurn({
    diagnosticsIdle: true,
    elapsedMs: 29_999,
    artifactFailureCount: 6,
    hasToolEvidence: true,
  }), false);
  assert.equal(shouldRecoverIdleAutonomousTurn({
    diagnosticsIdle: true,
    elapsedMs: 30_000,
    artifactFailureCount: 0,
    hasToolEvidence: true,
  }), false);
  assert.equal(shouldRecoverIdleAutonomousTurn({
    diagnosticsIdle: true,
    elapsedMs: 30_000,
    artifactFailureCount: 6,
    hasToolEvidence: false,
  }), true);
});

test("autonomous continuation cannot settle from stale artifacts before a fresh assistant marker", () => {
  assert.equal(autonomousContinuationHasFreshCompletion({
    answerMarkerCount: 0,
    hasRequiredFiles: true,
    hasToolEvidence: true,
  }), false);
  assert.equal(autonomousContinuationHasFreshCompletion({
    answerMarkerCount: 1,
    hasRequiredFiles: true,
    hasToolEvidence: true,
  }), true);
});
