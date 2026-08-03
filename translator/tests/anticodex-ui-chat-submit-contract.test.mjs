import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..", "..");
const uiSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-ui-chat-smoke.mjs"), "utf8");
const uiState = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.mjs"), "utf8");
const uiStateWrapper = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.ps1"), "utf8");
const autonomousCompletionPrompt = readFileSync(
  resolve(root, "docs", "prompts", "2026-07-21-lipsync-stage7-autonomous-completion.md"),
  "utf8",
);
const freshAutonomousVideoPrompt = readFileSync(
  resolve(root, "docs", "prompts", "2026-07-23-autonomous-live-action-lipsync-total-goal.md"),
  "utf8",
);

test("all UI chat entry paths select the primary app page when the avatar overlay is listed first", () => {
  const helperSource = uiSmoke.match(/function pickPrimaryAppTarget\(targets\) \{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(helperSource, "primary app target helper is missing");
  const pickPrimaryAppTarget = vm.runInNewContext(`(${helperSource})`);
  const overlay = {
    id: "overlay",
    type: "page",
    url: "app://-/index.html?initialRoute=%2Favatar-overlay",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/overlay",
  };
  const primary = {
    id: "primary",
    type: "page",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/primary",
  };

  assert.equal(pickPrimaryAppTarget([overlay, primary])?.id, "primary");
  assert.equal(pickPrimaryAppTarget([overlay]), null);
  assert.equal((uiSmoke.match(/(?:const )?target = pickPrimaryAppTarget\(targets\);/g) || []).length, 5);
  assert.doesNotMatch(uiSmoke, /targets\.find\(\(item\) => String\(item\.url \|\| ""\)\.startsWith\("app:\/\/"\)\) \|\| targets\[0\]/);
});

function loadSingleSubmitRolloutReader({ files, recordsByPath }) {
  const functionName = "readSingleSubmitRolloutEvidence";
  const start = uiSmoke.indexOf(`function ${functionName}(`);
  assert.ok(start >= 0, `${functionName} is missing`);
  const openingBrace = uiSmoke.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = openingBrace; index < uiSmoke.length; index += 1) {
    if (uiSmoke[index] === "{") depth += 1;
    if (uiSmoke[index] === "}") depth -= 1;
    if (depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.ok(end > openingBrace, `${functionName} could not be extracted`);
  const functionSource = uiSmoke.slice(start, end);
  return new Function(
    "recentCodexRolloutFiles",
    "readJsonLines",
    "sameNativePath",
    "modelValueMatches",
    "requiredModelNeedles",
    "recordContainsExactPrompt",
    `${functionSource}; return ${functionName};`,
  )(
    () => files,
    (path) => recordsByPath.get(path) || [],
    (left, right) => left === right,
    (model, needles) => needles.includes(model),
    () => ["gemini-3.1-pro-low"],
    (record, prompt) => record?.type === "event_msg"
      && record?.payload?.type === "user_message"
      && record?.payload?.message === prompt,
  );
}

function singleSubmitRolloutRecords({ sessionId, cwd, prompt }) {
  return [
    { type: "session_meta", payload: { id: sessionId, cwd } },
    {
      type: "turn_context",
      payload: { turn_id: `${sessionId}-turn`, cwd, model: "gemini-3.1-pro-low" },
    },
    { type: "event_msg", payload: { type: "user_message", message: prompt } },
  ];
}

test("autonomous completion contract requires model-owned planning and forbids milestone finalization", () => {
  assert.match(autonomousCompletionPrompt, /update_plan/);
  assert.match(autonomousCompletionPrompt, /顶层计划/);
  assert.match(autonomousCompletionPrompt, /中间阶段.*BLOCKED.*不是任务终点/);
  assert.match(autonomousCompletionPrompt, /每完成一个步骤.*更新计划.*自动进入下一项/);
  assert.match(autonomousCompletionPrompt, /仍有未完成项.*不得输出最终回复/);
});

test("fresh autonomous video goal is one self-planned deliverable contract", () => {
  assert.match(freshAutonomousVideoPrompt, /update_plan/);
  assert.match(freshAutonomousVideoPrompt, /连续执行、更新计划、诊断失败、返工并复验/);
  assert.match(freshAutonomousVideoPrompt, /45 至 60 秒/);
  assert.match(freshAutonomousVideoPrompt, /1080x1920/);
  assert.match(freshAutonomousVideoPrompt, /真人.*口型.*同步/);
  assert.match(freshAutonomousVideoPrompt, /UI_ANTICODEX_AUTONOMOUS_LIPSYNC_20260723_FINAL/);
  assert.doesNotMatch(freshAutonomousVideoPrompt, /Stage\s*4|019f7379|逐阶段下指令/);
});

test("exact-marker submit closes model overlays before probing the send button", () => {
  assert.match(
    uiSmoke,
    /Input\.insertText", \{ text: promptText \}\);\s+await closeOpenModelMenusAndOverlays\(ws, \{ timeoutMs: 6_000 \}\);\s+prep = await waitForComposerPromptReady\(ws, promptText, 5_000\);/,
  );
});

test("desktop submit proves the first click did not start a turn before any replay input", () => {
  assert.match(uiSmoke, /confirmDesktopSubmitBeforeReplay/);
  assert.doesNotMatch(uiSmoke, /sendButtonProbeExpression\(prompt, \{ click: true \}\)/);

  const genericStart = uiSmoke.indexOf("const submitWaitMs = requiredModelNeedles().length > 0 ? 15_000 : 4_000;");
  const genericConfirm = uiSmoke.indexOf("confirmDesktopSubmitBeforeReplay", genericStart);
  const genericEnter = uiSmoke.indexOf("await pressComposerEnter(ws);", genericStart);
  assert.ok(genericStart >= 0 && genericConfirm > genericStart && genericEnter > genericConfirm);
});

test("desktop long-task submit fails closed unless Anti-Codex is foreground and visible", () => {
  assert.match(
    uiSmoke,
    /async function main\(\)[\s\S]*?Page\.bringToFront[\s\S]*?activateAntiCodexWindow\(foregroundProcessId\)[\s\S]*?visibleWindow\?\.focused !== true[\s\S]*?Anti-Codex window was not foreground and visible before desktop submit/,
  );
  assert.match(uiSmoke, /windowActivationEvidence\.postSubmit = activateAntiCodexWindow/);
  assert.match(uiSmoke, /windowActivationEvidence,\s+submitEvidence,/);
});

test("send button probing has no host-scope click dependency", () => {
  assert.doesNotMatch(uiSmoke, /\$\{click\s*\?/);
  assert.match(uiSmoke, /clicked:\s*false,/);
});

test("fixed-route desktop traffic is proven by marker-scoped native request evidence", () => {
  assert.match(uiSmoke, /nativeExpectedRequestObserved/);
  assert.match(uiSmoke, /nativeSubmit/);
  assert.match(uiSmoke, /markerScopedRequestObserved/);
  assert.match(uiSmoke, /fixedRouteHealthEvidence/);
});

test("model selection falls through to the native Codex picker when no route override is active", () => {
  assert.match(uiSmoke, /async function readFixedRouteRequiredModelEvidence/);
  assert.match(uiSmoke, /requestModelOverride/);
  assert.match(uiSmoke, /selectionSource: "fixed-route-request-model-override"/);
  assert.doesNotMatch(uiSmoke, /selectionSource: "fixed-route-health"/);
  assert.match(
    uiSmoke,
    /async function selectRequiredModel[\s\S]*?readFixedRouteRequiredModelEvidence\(requiredValues\)[\s\S]*?if \(fixedRouteEvidence\.matched\) return fixedRouteEvidence;/,
  );
  assert.match(
    uiSmoke,
    /async function confirmRequiredModelSelected[\s\S]*?readFixedRouteRequiredModelEvidence\(requiredValues\)[\s\S]*?if \(fixedRouteEvidence\.matched\)/,
  );
  assert.match(uiSmoke, /modelOptionProbeExpression/);
  assert.match(uiSmoke, /Input\.dispatchMouseEvent/);
  assert.match(
    uiSmoke,
    /async function selectRequiredModel[\s\S]*?type: "mousePressed"[\s\S]*?buttons: 1[\s\S]*?pointerType: "mouse"/,
  );
  assert.match(
    uiSmoke,
    /focusedOption[\s\S]*?modelOptionProbeExpression\(requiredValues, \{ focusSelected: true \}\)/,
  );
});

test("native single-task acceptance rejects task-suggestion tool use and request loops", () => {
  assert.match(uiSmoke, /taskSuggestionThreadsUsedTools/);
  assert.match(uiSmoke, /taskSuggestionThreadsRepeated/);
  assert.match(uiSmoke, /task suggestion generation executed a tool/);
  assert.match(uiSmoke, /task suggestion generation repeated requests/);
});

test("third-party GPT slugs match Codex UI labels that omit the GPT prefix", () => {
  assert.match(uiSmoke, /const gptDisplayAliases/);
  assert.match(uiSmoke, /replace\(\/\^gpt\[- \]\/i,\s*""\)/);
});

test("model confirmation measures controls from the composer edge for long prompts", () => {
  assert.match(
    uiSmoke,
    /const horizontalGap = composerRect[\s\S]*?Math\.max\(composerRect\.left - centerX, 0, centerX - composerRect\.right\)/,
  );
  assert.match(
    uiSmoke,
    /const verticalGap = composerRect[\s\S]*?Math\.max\(composerRect\.top - centerY, 0, centerY - composerRect\.bottom\)/,
  );
  assert.match(uiSmoke, /const composerDistance = composerRect \? Math\.hypot\(horizontalGap, verticalGap\) : 0/);
});

test("model picker prefers a menu trigger beside the composer over modelish history rows", () => {
  assert.match(uiSmoke, /const isMenuTrigger = element\.getAttribute\('aria-haspopup'\) === 'menu' \|\| element\.getAttribute\('role'\) === 'menu'/);
  assert.match(uiSmoke, /const outsideHistorySidebar = !composerRect \|\| rect\.right > composerRect\.left/);
  assert.match(uiSmoke, /\+ \(isMenuTrigger \? 260 : 0\)/);
  assert.match(uiSmoke, /\.filter\(\(item\) => item\.outsideHistorySidebar/);
});

test("frontend-only model switching waits for the lazily rendered native selector", () => {
  assert.match(
    uiSmoke,
    /async function waitForFrontendModelSelector\(ws, requiredValues, timeoutMs[\s\S]*?while \(Date\.now\(\) < deadline\)[\s\S]*?currentModelProbeExpression\(requiredValues\)[\s\S]*?await new Promise/,
  );
  assert.match(
    uiSmoke,
    /async function selectFrontendModelWithPhysicalMouse[\s\S]*?waitForFrontendModelSelector\(ws, requiredValues, 5_000\)/,
  );
  assert.match(uiSmoke, /--expected-task-id/);
  assert.match(uiSmoke, /--frontend-model-probe-only requires --expected-task-id/);
  assert.match(uiSmoke, /sameChatEvidence\?\.taskId[\s\S]*?expectedTaskId/);
});

test("single-submit handoff is an exact-marker-only fresh-task mode", () => {
  assert.match(uiSmoke, /--single-submit-handoff/);
  assert.match(
    uiSmoke,
    /if \(singleSubmitHandoff && taskMode !== "exact-marker"\)[\s\S]*?--single-submit-handoff requires --task-mode exact-marker/,
  );
  assert.match(
    uiSmoke,
    /singleSubmitForbiddenArgs[\s\S]*?--same-chat[\s\S]*?--same-chat-title-contains[\s\S]*?--followup-prompt-file[\s\S]*?--followup-prompt[\s\S]*?--force-reset-same-chat/,
  );
  assert.match(uiSmoke, /--single-submit-handoff requires --project-root, --prompt-file, and --model/);
  assert.match(uiSmoke, /--single-submit-handoff requires --require-native-single-task/);
});

test("single-submit handoff creates the fresh task with a re-probed native mouse hit", () => {
  assert.match(
    uiSmoke,
    /function singleSubmitNewTaskProbeExpression[\s\S]*?selectedHit[\s\S]*?clicked: false/,
  );
  assert.match(
    uiSmoke,
    /async function createSingleSubmitTaskWithPhysicalMouse[\s\S]*?const probe = async[\s\S]*?singleSubmitNewTaskProbeExpression\(projectChatLabel\)[\s\S]*?initial = await probe\(\)[\s\S]*?await new Promise[\s\S]*?const live = await probe\(\)[\s\S]*?live\?\.selectedHit !== true[\s\S]*?Input\.dispatchMouseEvent", \{ type: "mousePressed"[\s\S]*?Input\.dispatchMouseEvent", \{ type: "mouseReleased"/,
  );
});

test("single-submit snapshots existing rollouts before clicking the new-task control", () => {
  assert.match(
    uiSmoke,
    /rolloutBaseline = snapshotSingleSubmitRollouts\(\);[\s\S]*?createSingleSubmitTaskWithPhysicalMouse\(ws\)[\s\S]*?sendSingleSubmitPromptWithPhysicalMouse\(ws\)/,
  );
});

test("single-submit handoff sends exactly once and has no host continuation or cleanup path", () => {
  const submitStart = uiSmoke.indexOf("async function sendSingleSubmitPromptWithPhysicalMouse(ws)");
  const submitEnd = uiSmoke.indexOf("\nfunction sameChatClickExpression", submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart, "dedicated single-submit click helper is missing");
  const submit = uiSmoke.slice(submitStart, submitEnd);
  assert.match(submit, /sendClickCount:\s*1/);
  assert.equal((submit.match(/type: "mousePressed"/g) || []).length, 1);
  assert.equal((submit.match(/type: "mouseReleased"/g) || []).length, 1);
  assert.doesNotMatch(submit, /pressComposerEnter|retryDesktopSubmit/);

  const start = uiSmoke.indexOf("async function runSingleSubmitHandoff()");
  const end = uiSmoke.indexOf("\nasync function main()", start);
  assert.ok(start >= 0 && end > start, "dedicated single-submit function is missing");
  const handoff = uiSmoke.slice(start, end);

  assert.match(handoff, /nativeActivityPreflight = await beginNativeSingleTaskWindow\(\)[\s\S]*?activateNativeProjectRoot/);
  assert.match(handoff, /sendSingleSubmitPromptWithPhysicalMouse/);
  assert.match(handoff, /maximumSendClicks:\s*1/);
  assert.doesNotMatch(handoff, /pressComposerEnter|submitDesktopPromptAndWait|retryDesktopSubmit|resetBackendSessionLock|recoverStaleComposer|failureCleanup|repairPrompt|followupPrompt|autonomousContinuation/);
});

test("single-submit handoff exits after bounded read-only rollout and upstream receipts", () => {
  assert.match(uiSmoke, /const SINGLE_SUBMIT_EVIDENCE_MS = 25_000/);
  assert.match(
    uiSmoke,
    /readSingleSubmitRolloutEvidence[\s\S]*?session_meta[\s\S]*?turn_context[\s\S]*?sessionId[\s\S]*?cwd[\s\S]*?model/,
  );
  assert.match(
    uiSmoke,
    /readSingleSubmitUpstreamEvidence[\s\S]*?protocol_proxy\.upstream_request[\s\S]*?anticodex-antigravity[\s\S]*?requestTools[\s\S]*?upstreamTools[\s\S]*?protocol_proxy\.upstream_response[\s\S]*?statusCode/,
  );
  assert.match(
    uiSmoke,
    /readSingleSubmitRolloutEvidence[\s\S]*?if \(baseline\.has\(file\.path\)\) continue;/,
  );
  assert.match(uiSmoke, /Number\(record\?\.detail\?\.candidateCount[^\n]+=== 1/);
  assert.match(uiSmoke, /protocol_proxy\.upstream_response[\s\S]*?Number\(record\?\.detail\?\.candidateCount[^\n]+=== Number\(requestRecord\.detail\.candidateCount/);
  assert.match(
    uiSmoke,
    /runSingleSubmitHandoff[\s\S]*?codexPlusPlusLogOffset[\s\S]*?waitForSingleSubmitReadOnlyEvidence[\s\S]*?writeReport\(payload\)/,
  );
  assert.match(
    uiSmoke,
    /runSingleSubmitHandoff[\s\S]*?findPriorSingleSubmitTask\(projectChatRoot, promptText\)[\s\S]*?exact handoff goal was already submitted/,
  );
  assert.match(
    uiSmoke,
    /readSingleSubmitNativeEvidence[\s\S]*?expectedThreadIds:\s*\[rollout\.taskId\][\s\S]*?nativeExpectedRequestObserved/,
  );
  assert.match(
    uiSmoke,
    /waitForSingleSubmitReadOnlyEvidence[\s\S]*?rollout\.ok && native\.ok && upstream\.ok/,
  );
});

test("single-submit rollout evidence rejects a pre-existing rollout even when it grows", () => {
  const expectedCwd = "G:\\deliverables\\fresh-task";
  const expectedPrompt = "one autonomous total goal";
  const existingPath = "G:\\sessions\\rollout-existing.jsonl";
  const reader = loadSingleSubmitRolloutReader({
    files: [{ path: existingPath, size: 900, mtimeMs: 200 }],
    recordsByPath: new Map([[
      existingPath,
      singleSubmitRolloutRecords({ sessionId: "existing-task", cwd: expectedCwd, prompt: expectedPrompt }),
    ]]),
  });

  const evidence = reader(
    new Map([[existingPath, { size: 400, mtimeMs: 100 }]]),
    expectedCwd,
    expectedPrompt,
  );

  assert.equal(evidence.ok, false);
  assert.equal(evidence.newTask, false);
  assert.equal(evidence.taskId, null);
});

test("single-submit rollout evidence accepts a valid rollout absent from the baseline", () => {
  const expectedCwd = "G:\\deliverables\\fresh-task";
  const expectedPrompt = "one autonomous total goal";
  const freshPath = "G:\\sessions\\rollout-fresh.jsonl";
  const reader = loadSingleSubmitRolloutReader({
    files: [{ path: freshPath, size: 500, mtimeMs: 200 }],
    recordsByPath: new Map([[
      freshPath,
      singleSubmitRolloutRecords({ sessionId: "fresh-task", cwd: expectedCwd, prompt: expectedPrompt }),
    ]]),
  });

  const evidence = reader(new Map(), expectedCwd, expectedPrompt);

  assert.equal(evidence.ok, true);
  assert.equal(evidence.newTask, true);
  assert.equal(evidence.taskId, "fresh-task");
  assert.equal(evidence.file, freshPath);
});

test("history-only UI probe never submits model traffic", () => {
  assert.match(uiSmoke, /--history-probe-only/);
  assert.match(uiSmoke, /async function runHistoryProbeOnly\(\)/);
  assert.match(uiSmoke, /coverageKind: "desktop-ui-history-no-traffic"/);
  assert.match(uiSmoke, /requestedRealTraffic: false,\s+usedRealTraffic: false,/);
  assert.match(uiSmoke, /if \(historyProbeOnly\) \{\s+runHistoryProbeOnly\(\)/);
});

test("same-chat title matching is confined to the history sidebar", () => {
  assert.match(
    uiSmoke,
    /function sameChatClickExpression[\s\S]*?rect\.left < 420[\s\S]*?rect\.right <= 520/,
  );
  assert.match(
    uiSmoke,
    /function sameChatClickExpression[\s\S]*?querySelectorAll\('\[data-app-action-sidebar-thread-id\]'\)[\s\S]*?data-app-action-sidebar-thread-title/,
  );
});

test("forced same-chat recovery opens the target before stopping its active turn", () => {
  assert.match(
    uiSmoke,
    /else if \(sameChatTitleContains\) \{[\s\S]*?openSameChatByTitle\(ws, sameChatTitleContains, \{[\s\S]*?waitForIdle: preserveSameChatActiveTask,[\s\S]*?\}\);/,
  );
  assert.match(
    uiSmoke,
    /if \(!preserveSameChatActiveTask && sameChatEvidence\?\.visibleIdleAfterClick\?\.ok !== true\) \{[\s\S]*?recoverStaleComposerExpression\(\)[\s\S]*?clickRecoveryControlsWithMouse\(ws, sameChatEvidence\.staleRecovery\)[\s\S]*?waitForVisibleComposerIdle\(ws, 20_000\)/,
  );
});

test("local-project follow-up can bind its marker to an explicit required file", () => {
  assert.match(uiSmoke, /--required-file-authoritative/);
  assert.match(
    uiSmoke,
    /requiredFileAuthoritative && \(!requiredFile \|\| !requiredFileContains\.includes\(marker\)\)/,
  );
  assert.match(
    uiSmoke,
    /authoritativeArtifactReady: requiredFileCompletionReady\(\)/,
  );
  assert.match(
    uiSmoke,
    /requiredFileCompletionReady\(\)[\s\S]*?!requiredFileAuthoritative \|\| latestMarkerTurnCompleted\(codexRolloutMarkerBundles\(marker\)\)/,
  );
  assert.match(
    uiSmoke,
    /\(evidence\) => requiredFileAuthoritative[\s\S]*?\? requiredFileCompletionReady\(\)[\s\S]*?: evidence\?\.files\?\.indexHtml === true/,
  );
  assert.match(uiSmoke, /if \(!requiredFileAuthoritative && !artifactEvidence\?\.files\?\.indexHtml\)/);
  assert.match(uiSmoke, /if \(!requiredFileAuthoritative && !artifactEvidence\?\.files\?\.readmeMd\)/);
  assert.match(uiSmoke, /if \(!requiredFileAuthoritative && !artifactEvidence\?\.files\?\.doneTxt\)/);
});

test("result-driven verification fails fast on a rollout task error", () => {
  assert.match(uiSmoke, /const latestTurnError = String\(rolloutBundles\[0\]\?\.latestMarkerTurnError \|\| ""\)\.trim\(\)/);
  assert.match(uiSmoke, /if \(latestTurnError\) \{[\s\S]*?resultDrivenCompletionError = latestTurnError;[\s\S]*?break;/);
  assert.match(uiSmoke, /provider turn failed: \$\{resultDrivenCompletionError\}/);
});

test("UI state validates the current isolated fixed-route catalog before legacy fallbacks", () => {
  const currentCatalog = "anticodex\\codex-home-deepseek-app\\antigravity-model-catalog.json";
  const legacyCatalog = "anticodex\\antigravity-model-catalog.json";
  const currentIndex = uiStateWrapper.indexOf(currentCatalog);
  const legacyIndex = uiStateWrapper.indexOf(legacyCatalog);

  assert.ok(currentIndex >= 0, "current fixed-route catalog path is missing");
  assert.ok(legacyIndex > currentIndex, "legacy catalog must only be a fallback");
});

test("UI state recognizes third-party model controls and no-task screens", () => {
  assert.match(uiState, /const modelControlPatternSource = String\.raw`[^`]*gpt-\\d[^`]*third-party[^`]*第三方/);
  assert.match(uiState, /composerPresent: Boolean\(document\.querySelector/);
  assert.match(uiState, /selectedContextProbe\?\.composerPresent === false/);
  assert.match(uiState, /else if \(!matchedModelText\)/);
});

test("UI state falls back to the isolated unified catalog when the selected upstream cannot list models", () => {
  assert.match(uiState, /anticodex-model-catalog\.json/);
  assert.match(uiState, /if \(modelCount < 1 && isolatedCatalogModels\.length > 0\)/);
  assert.match(uiState, /modelCatalogSource = "isolated-unified-catalog"/);
});

test("UI state ignores modelish history text and reads the control beside the composer", () => {
  assert.match(uiState, /const modelControlCandidates = Array\.from\(document\.querySelectorAll/);
  assert.match(uiState, /rect\.right > composerRect\.left/);
  assert.match(uiState, /element\.getAttribute\("aria-haspopup"\) === "menu" \? 260 : 0/);
});
