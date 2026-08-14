import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceStableIdleWindow,
  assistantMessageIsVisibleProgress,
  autonomousContinuationHasFreshCompletion,
  codexLikeAgentProcessProven,
  classifyReconnectOutcome,
  collectCodexRolloutMarkerEvidence,
  collectCodexRolloutSubmittedTurnEvidence,
  composerHasUnsubmittedMarker,
  countMarkerOccurrences,
  countNewAssistantMarkers,
  countObservedAssistantMarkers,
  countVerifiedNewAssistantMarkers,
  countUniqueAssistantMarkerMessages,
  filterAssistantMarkerObservationFailures,
  findScopedCommandViolations,
  freshDesktopTurnConfirmsSubmit,
  hasAssistantFinalMarkerEvidence,
  latestMarkerTurnCompleted,
  multiTurnFirstTurnReadyForFollowup,
  parseWordCountCliOutput,
  pendingDesktopTaskConfirmsSubmit,
  responsesPayloadAdvanceConfirmsSubmit,
  repoMultiTurnCompletionReady,
  resultDrivenTurnCompletionReady,
  shouldRecoverIdleAutonomousTurn,
  stableIdleTimeoutForTaskMode,
  stableIdleWindowReady,
  utf8BytesExactlyMatch,
} from "../../scripts/lib/ui-chat-marker-evidence.mjs";

test("a transient reconnect that reaches a completed idle turn is recorded as recovered", () => {
  assert.deepEqual(classifyReconnectOutcome({
    reconnectSeen: true,
    answerText: "正在重新连接\n继续执行\nTASK_DONE",
    completionObserved: true,
    stableIdleObserved: true,
  }), {
    reconnectSeen: true,
    recovered: true,
    unresolved: false,
    terminalProviderError: null,
  });
});

test("a terminal provider quota error is never hidden as a recovered reconnect", () => {
  const outcome = classifyReconnectOutcome({
    reconnectSeen: true,
    answerText: "stream disconnected before completion: RESOURCE_EXHAUSTED (code 429): Individual quota reached.",
    completionObserved: false,
    stableIdleObserved: false,
  });
  assert.equal(outcome.recovered, false);
  assert.equal(outcome.unresolved, true);
  assert.match(outcome.terminalProviderError, /RESOURCE_EXHAUSTED.*Individual quota reached/i);
});

test("an unsupported-location provider error is terminal even without reconnect text", () => {
  const outcome = classifyReconnectOutcome({
    reconnectSeen: false,
    answerText: "FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
    completionObserved: true,
    stableIdleObserved: true,
  });
  assert.equal(outcome.recovered, false);
  assert.equal(outcome.unresolved, true);
  assert.match(outcome.terminalProviderError, /location is not supported/i);
});

test("a reconnect without completed idle evidence remains unresolved", () => {
  assert.deepEqual(classifyReconnectOutcome({
    reconnectSeen: true,
    answerText: "正在重新连接",
    completionObserved: false,
    stableIdleObserved: false,
  }), {
    reconnectSeen: true,
    recovered: false,
    unresolved: true,
    terminalProviderError: null,
  });
});

test("native Codex rollout evidence confirms one fixed-route task without a legacy diagnostics entry", () => {
  const marker = "UI_FIXED_ROUTE_ROLLOUT_123";
  const evidence = collectCodexRolloutMarkerEvidence([
    {
      type: "session_meta",
      payload: {
        id: "thread-123",
        model_provider: "anticodex_antigravity",
        cwd: "C:\\Temp\\gate8-fixture",
      },
    },
    {
      type: "turn_context",
      payload: { model: "gemini-3.5-flash-low" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `finish with ${marker}` }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `done\n${marker}` }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete" } },
  ], marker);

  assert.equal(evidence.sessionId, "thread-123");
  assert.equal(evidence.sessionCwd, "C:\\Temp\\gate8-fixture");
  assert.equal(evidence.userMarkerSeen, true);
  assert.deepEqual(evidence.models, ["gemini-3.5-flash-low"]);
  assert.equal(evidence.assistantMarkerCount, 1);
  assert.equal(evidence.taskCompleteSeen, true);
  assert.equal(evidence.contextItems.length, 2);
});

test("native Codex rollout evidence ignores assistant and tool data before the marker-scoped user turn", () => {
  const marker = "UI_FIXED_ROUTE_TOOL_456";
  const evidence = collectCodexRolloutMarkerEvidence([
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] },
    },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "shell_command", call_id: "call-1", arguments: "{}" },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "tests passed" },
    },
  ], marker);

  assert.equal(evidence.userMarkerSeen, true);
  assert.equal(evidence.assistantMarkerCount, 0);
  assert.deepEqual(evidence.contextItems.map((item) => item.type), [
    "message",
    "function_call",
    "function_call_output",
  ]);
});

test("native Codex rollout evidence distinguishes repeated marker turns in one session", () => {
  const marker = "UI_MULTI_TURN_123";
  const evidence = collectCodexRolloutMarkerEvidence([
    { type: "session_meta", payload: { id: "thread-multi" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "turn_context", payload: { turn_id: "turn-1", model: "gemini-3-flash-agent" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${marker}_FIRST` }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
    { type: "turn_context", payload: { turn_id: "turn-2", model: "gemini-3-flash-agent" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } },
  ], marker);

  assert.deepEqual(evidence.markerTurnIds, ["turn-1", "turn-2"]);
  assert.deepEqual(evidence.completedMarkerTurnIds, ["turn-1", "turn-2"]);
  assert.equal(evidence.latestMarkerTurnId, "turn-2");
  assert.equal(evidence.latestMarkerTurnComplete, true);
});

test("native Codex rollout evidence exposes a failed marker turn instead of completing it", () => {
  const marker = "UI_PROVIDER_FAILURE_123";
  const evidence = collectCodexRolloutMarkerEvidence([
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-failed" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-failed",
        error: { message: "FAILED_PRECONDITION (code 400): User location is not supported for the API use." },
      },
    },
  ], marker);

  assert.equal(evidence.latestMarkerTurnComplete, false);
  assert.match(evidence.latestMarkerTurnError, /location is not supported/i);
  assert.deepEqual(evidence.failedMarkerTurnIds, ["turn-failed"]);
  assert.equal(resultDrivenTurnCompletionReady({
    enabled: true,
    rolloutBundles: [evidence],
    composerText: "",
    marker,
    routeReady: true,
  }), false);
});

test("submitted-turn evidence ignores an identical failed prompt before this run's baseline", () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续\n" }] } },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "old-turn",
        error: { message: "FAILED_PRECONDITION (code 400): User location is not supported for the API use." },
      },
    },
  ];
  const baselineRecordCount = records.length;
  records.push(
    { type: "event_msg", payload: { type: "task_started", turn_id: "current-turn" } },
    { type: "turn_context", payload: { turn_id: "current-turn", model: "claude-sonnet-4-6" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续\n" }] } },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "current-turn",
        error: { message: "exceeded retry limit, last status: 429 Too Many Requests" },
      },
    },
  );

  const evidence = collectCodexRolloutSubmittedTurnEvidence(records, "继续", { baselineRecordCount });

  assert.equal(evidence.latestSubmittedTurnId, "current-turn");
  assert.equal(evidence.latestSubmittedTurnComplete, false);
  assert.match(evidence.latestSubmittedTurnError, /429 Too Many Requests/i);
  assert.doesNotMatch(evidence.latestSubmittedTurnError, /location is not supported/i);
  assert.deepEqual(evidence.models, ["claude-sonnet-4-6"]);
});

test("submitted-turn evidence stays pending until this run records the exact prompt", () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] } },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "old-turn",
        error: { message: "FAILED_PRECONDITION: old failure" },
      },
    },
  ];
  const evidence = collectCodexRolloutSubmittedTurnEvidence(records, "继续", {
    baselineRecordCount: records.length,
  });

  assert.equal(evidence.promptSeen, false);
  assert.equal(evidence.latestSubmittedTurnId, null);
  assert.equal(evidence.latestSubmittedTurnComplete, false);
  assert.equal(evidence.latestSubmittedTurnError, null);
});

test("submitted-turn evidence recognizes a successful current continuation", () => {
  const evidence = collectCodexRolloutSubmittedTurnEvidence([
    { type: "event_msg", payload: { type: "task_started", turn_id: "current-turn" } },
    { type: "turn_context", payload: { turn_id: "current-turn", model: "gemini-3.1-pro-low" } },
    { type: "event_msg", payload: { type: "user_message", message: "继续\n" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "current-turn" } },
  ], "继续");

  assert.equal(evidence.promptSeen, true);
  assert.equal(evidence.latestSubmittedTurnId, "current-turn");
  assert.equal(evidence.latestSubmittedTurnComplete, true);
  assert.equal(evidence.latestSubmittedTurnError, null);
  assert.deepEqual(evidence.models, ["gemini-3.1-pro-low"]);
});

test("latest marker turn completion ignores an older completed rollout", () => {
  assert.equal(latestMarkerTurnCompleted([
    {
      markerTurnIds: ["current-turn"],
      latestMarkerTurnId: "current-turn",
      latestMarkerTurnComplete: false,
    },
    {
      markerTurnIds: ["older-turn"],
      latestMarkerTurnId: "older-turn",
      latestMarkerTurnComplete: true,
    },
  ]), false);

  assert.equal(latestMarkerTurnCompleted([
    {
      markerTurnIds: ["current-turn"],
      latestMarkerTurnId: "current-turn",
      latestMarkerTurnComplete: true,
    },
  ]), true);
  assert.equal(latestMarkerTurnCompleted([]), false);
});

test("result-driven completion accepts the current completed turn without trusting final marker text", () => {
  const rolloutBundles = [{
    markerTurnIds: ["current-turn"],
    latestMarkerTurnId: "current-turn",
    latestMarkerTurnComplete: true,
  }];
  assert.equal(resultDrivenTurnCompletionReady({
    enabled: true,
    rolloutBundles,
    composerText: "",
    marker: "UI_CURRENT_123",
    routeReady: true,
  }), true);
  assert.equal(resultDrivenTurnCompletionReady({
    enabled: true,
    rolloutBundles,
    composerText: "unsent UI_CURRENT_123",
    marker: "UI_CURRENT_123",
    routeReady: true,
  }), false);
  assert.equal(resultDrivenTurnCompletionReady({
    enabled: false,
    rolloutBundles,
    composerText: "",
    marker: "UI_CURRENT_123",
    routeReady: true,
  }), false);
  assert.equal(resultDrivenTurnCompletionReady({
    enabled: true,
    rolloutBundles,
    composerText: "",
    marker: "UI_CURRENT_123",
    routeReady: true,
    authoritativeArtifactReady: false,
  }), false);
});

test("a fresh marker turn prevents retry even when diagnostics missed the request", () => {
  assert.equal(freshDesktopTurnConfirmsSubmit({
    beforeMarkerEntryIds: ["rollout:thread:turn:turn-1"],
    afterMarkerEntryIds: ["rollout:thread:turn:turn-1", "rollout:thread:turn:turn-2"],
    assistantMarkerBaselineCount: 1,
    assistantMarkerCount: 1,
  }), true);
  assert.equal(freshDesktopTurnConfirmsSubmit({
    beforeMarkerEntryIds: ["rollout:thread:turn:turn-1"],
    afterMarkerEntryIds: ["rollout:thread:turn:turn-1"],
    assistantMarkerBaselineCount: 1,
    assistantMarkerCount: 2,
  }), true);
  assert.equal(freshDesktopTurnConfirmsSubmit({
    beforeMarkerEntryIds: ["rollout:thread:turn:turn-1"],
    afterMarkerEntryIds: ["rollout:thread:turn:turn-1"],
    assistantMarkerBaselineCount: 1,
    assistantMarkerCount: 1,
  }), false);
});

test("scoped command evidence accepts commands confined to the journey artifact", () => {
  const artifactDir = "C:\\Users\\XD\\AppData\\Local\\Temp\\anticodex-human-long-1\\inventory";
  const overEscapedArtifactFile = `${artifactDir}\\inventory.mjs`.replaceAll("\\", "\\\\\\\\");
  const violations = findScopedCommandViolations([
    `Get-Content -Raw "${artifactDir}\\inventory.mjs"`,
    `node --test "${artifactDir}\\inventory.test.mjs"`,
    `*** Begin Patch\n*** Update File: ${artifactDir}\\inventory.mjs\n*** End Patch`,
    `*** Begin Patch\n*** Update File: ${overEscapedArtifactFile}\n*** End Patch`,
    "Get-ChildItem -Recurse; node inventory.mjs --dry-run",
  ], { artifactDir });
  assert.deepEqual(violations, []);
});

test("scoped command evidence does not treat an https URL inside a patch as a Windows drive path", () => {
  const artifactDir = "C:\\Users\\XD\\AppData\\Local\\Temp\\anticodex-human-long-1\\greenfield";
  const violations = findScopedCommandViolations([
    `*** Begin Patch\n*** Update File: ${artifactDir}\\README.md\n@@\n+- 安装 Node.js：https://nodejs.org/（推荐版本）\n*** End Patch`,
  ], { artifactDir });
  assert.deepEqual(violations, []);
});

test("scoped command evidence narrowly allows native Codex memory without allowing Anti-Codex runtime reports", () => {
  const artifactDir = "C:\\Users\\XD\\AppData\\Local\\Temp\\anticodex-human-long-1\\inventory";
  const nativeCodexMemoryRoot = "C:\\Users\\XD\\AppData\\Roaming\\anticodex\\codex-home-deepseek-app\\memories";
  const violations = findScopedCommandViolations([
    `Get-Content "${nativeCodexMemoryRoot}\\MEMORY.md" -Head 50`,
    "Get-Content C:\\Users\\XD\\AppData\\Roaming\\anticodex\\reports\\latest.json",
  ], { artifactDir, allowedRuntimePaths: [nativeCodexMemoryRoot] });
  assert.deepEqual(violations.filter(({ commandIndex }) => commandIndex === 0), []);
  const rejectedReasons = new Set(violations.filter(({ commandIndex }) => commandIndex === 1).map(({ reason }) => reason));
  assert.equal(rejectedReasons.has("private_anticodex_runtime"), true);
  assert.equal(rejectedReasons.has("absolute_path_outside_artifact"), true);
});

test("scoped command evidence rejects private history and host product exploration", () => {
  const artifactDir = "C:\\Users\\XD\\AppData\\Local\\Temp\\anticodex-human-long-1\\inventory";
  const violations = findScopedCommandViolations([
    "Get-Content C:\\Users\\XD\\.gemini\\antigravity\\brain\\abc\\output.txt",
    "Get-ChildItem -Path G:\\Trae-Project -Filter summary.json -Recurse",
    "Get-ChildItem translator; Get-ChildItem scripts; git status",
    "Get-Content C:\\Users\\XD\\AppData\\Roaming\\anticodex\\reports\\latest.json",
  ], { artifactDir });
  const reasons = new Set(violations.map(({ reason }) => reason));
  assert.equal(reasons.has("private_antigravity_history"), true);
  assert.equal(reasons.has("absolute_path_outside_artifact"), true);
  assert.equal(reasons.has("host_workspace_outside_artifact"), true);
  assert.equal(reasons.has("product_source_outside_artifact"), true);
  assert.equal(reasons.has("host_repository_probe"), true);
  assert.equal(reasons.has("private_anticodex_runtime"), true);
});

test("scoped command evidence validates an explicit shell workdir", () => {
  const artifactDir = "C:\\Users\\XD\\AppData\\Local\\Temp\\anticodex-human-long-1\\migration";
  assert.deepEqual(findScopedCommandViolations([
    { command: "node --test migrate.test.mjs", workdir: artifactDir },
  ], { artifactDir }), []);

  const violations = findScopedCommandViolations([
    { command: "node --test migrate.test.mjs", workdir: "G:\\Trae-Project\\Anti-Codex\\deepcodex" },
  ], { artifactDir });
  assert.deepEqual(violations.map((item) => item.reason), ["workdir_outside_artifact"]);
});

test("Codex-like process proof accepts task-scoped tool output without leaking the final marker into commands", () => {
  assert.equal(codexLikeAgentProcessProven({
    assistantHasFinalMarker: true,
    taskToolCallCount: 4,
    taskToolOutputSeen: true,
    taskScopedToolOutputSeen: true,
    markerToolOutputSeen: false,
    visibleProgressCount: 3,
    distinctVisibleProgressCount: 3,
    artifactGuardUsed: false,
  }), true);
});

test("repo multi-file turns cannot settle during an idle gap before their fresh final reply", () => {
  const base = {
    artifactFailureCount: 0,
    composerHasMarker: false,
    diagnosticsIdle: true,
    responseHistory: {
      taskToolOutputSeen: true,
      taskScopedToolOutputSeen: true,
    },
  };
  assert.equal(repoMultiTurnCompletionReady({ ...base, answerMarkerCount: 0 }), false);
  assert.equal(repoMultiTurnCompletionReady({ ...base, answerMarkerCount: 1 }), true);
  assert.equal(repoMultiTurnCompletionReady({ ...base, answerMarkerCount: 1, diagnosticsIdle: false }), false);
});

test("visible progress accepts natural model updates and excludes final marker replies", () => {
  const marker = "UI_LONG_TASK_RESULT_123";
  assert.equal(assistantMessageIsVisibleProgress("I will inspect the failing module, then run its focused test.", marker), true);
  assert.equal(assistantMessageIsVisibleProgress("先定位失败模块，再运行对应测试。", marker), true);
  assert.equal(assistantMessageIsVisibleProgress(`Task completed.\n${marker}`, marker), false);
  assert.equal(assistantMessageIsVisibleProgress(marker, marker), false);
  assert.equal(assistantMessageIsVisibleProgress("", marker), false);
});

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

test("task-title assistant text never counts as a task completion marker", () => {
  const marker = "UI_HUMAN_LONG_MIGRATION_T1_123";
  const titleInstruction = "You are a helpful assistant. Provide a short title for a task. Generate a concise UI title.";
  const history = {
    entries: [
      {
        id: "resp_title",
        inputItemCount: 1,
        contextItems: [
          { type: "message", role: "user", content: [{ type: "input_text", text: `${titleInstruction}\nUser prompt: finish with ${marker}` }] },
          { id: "msg_title", type: "message", role: "assistant", content: [{ type: "output_text", text: `Title: repair migration ${marker}` }] },
        ],
      },
      {
        id: "resp_task",
        inputItemCount: 1,
        contextItems: [
          { type: "message", role: "user", content: [{ type: "input_text", text: `repair migration and finish with ${marker}` }] },
          { id: "msg_progress", type: "message", role: "assistant", content: [{ type: "output_text", text: "I am still running tests." }] },
        ],
      },
    ],
  };

  assert.equal(countUniqueAssistantMarkerMessages(history, marker), 0);
  history.entries[1].contextItems.push({
    id: "msg_task_final",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: `Migration complete.\n${marker}` }],
  });
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

test("desktop verifier requires a quiet idle window and resets it on late background traffic", () => {
  let state = advanceStableIdleWindow(null, {
    nowMs: 1_000,
    idle: true,
    activitySequence: 7,
  });
  assert.equal(stableIdleWindowReady(state, { nowMs: 10_999, quietMs: 10_000 }), false);

  state = advanceStableIdleWindow(state, {
    nowMs: 8_000,
    idle: false,
    activitySequence: 8,
  });
  assert.equal(state.stableSinceMs, null);

  state = advanceStableIdleWindow(state, {
    nowMs: 12_000,
    idle: true,
    activitySequence: 9,
  });
  assert.equal(stableIdleWindowReady(state, { nowMs: 21_999, quietMs: 10_000 }), false);
  assert.equal(stableIdleWindowReady(state, { nowMs: 22_000, quietMs: 10_000 }), true);
});

test("exact-marker long tasks receive a full final-continuation idle window", () => {
  assert.equal(stableIdleTimeoutForTaskMode("exact-marker"), 60_000);
  assert.equal(stableIdleTimeoutForTaskMode("plain-chat"), 20_000);
});

test("multi-turn follow-up uses host results and real tool output instead of marker text in tool output", () => {
  const evidence = {
    files: { packageJson: true, wordTally: true, testFile: true, doneTxt: true },
    firstDoneExact: true,
    exportsTallyWords: true,
    testPassed: true,
    cliPassed: true,
    responseHistory: {
      taskToolOutputSeen: true,
      markerToolOutputSeen: false,
    },
  };
  assert.equal(multiTurnFirstTurnReadyForFollowup({ turnOk: true, evidence }), true);
  assert.equal(multiTurnFirstTurnReadyForFollowup({
    turnOk: true,
    evidence: { ...evidence, responseHistory: { taskToolOutputSeen: false } },
  }), false);
  assert.equal(multiTurnFirstTurnReadyForFollowup({
    turnOk: true,
    evidence: { ...evidence, testPassed: false },
  }), false);
});

test("exact UTF-8 evidence rejects BOM and trailing newlines", () => {
  const marker = "UI_MULTI_TURN_PROJECT_SMOKE_1_FIRST";
  assert.equal(utf8BytesExactlyMatch(Buffer.from(marker, "utf8"), marker), true);
  assert.equal(utf8BytesExactlyMatch(Buffer.from(`\uFEFF${marker}`, "utf8"), marker), false);
  assert.equal(utf8BytesExactlyMatch(Buffer.from(`${marker}\r\n`, "utf8"), marker), false);
});
