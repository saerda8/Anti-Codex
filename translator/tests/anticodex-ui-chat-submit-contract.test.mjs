import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const uiSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-ui-chat-smoke.mjs"), "utf8");
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

test("native single-task acceptance rejects task-suggestion tool use and request loops", () => {
  assert.match(uiSmoke, /taskSuggestionThreadsUsedTools/);
  assert.match(uiSmoke, /taskSuggestionThreadsRepeated/);
  assert.match(uiSmoke, /task suggestion generation executed a tool/);
  assert.match(uiSmoke, /task suggestion generation repeated requests/);
});

test("UI state validates the current isolated fixed-route catalog before legacy fallbacks", () => {
  const currentCatalog = "anticodex\\codex-home-deepseek-app\\antigravity-model-catalog.json";
  const legacyCatalog = "anticodex\\antigravity-model-catalog.json";
  const currentIndex = uiStateWrapper.indexOf(currentCatalog);
  const legacyIndex = uiStateWrapper.indexOf(legacyCatalog);

  assert.ok(currentIndex >= 0, "current fixed-route catalog path is missing");
  assert.ok(legacyIndex > currentIndex, "legacy catalog must only be a fallback");
});
