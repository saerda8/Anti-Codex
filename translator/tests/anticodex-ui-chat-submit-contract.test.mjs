import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const uiSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-ui-chat-smoke.mjs"), "utf8");
const uiState = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.mjs"), "utf8");
const uiStateWrapper = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.ps1"), "utf8");

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
