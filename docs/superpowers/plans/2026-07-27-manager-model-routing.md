# Anti-Codex Manager Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Manager save third-party configuration without switching providers, while the native model menu remains the only provider/model selector.

**Architecture:** Keep the existing three layers and both resident CodexPlusPlus relays. Replace the Manager save-and-switch transaction with one atomic save-and-catalog transaction, delete renderer-side native model switching, and reorganize the existing actions without adding a router, task controller, watcher, dependency, or restart path.

**Tech Stack:** Node.js ESM, Electron renderer injection, PowerShell wrappers, `node:test`

---

## Constraints

- The official Codex isolation shell remains the only task controller.
- CodexPlusPlus patch `0004-route-anticodex-model-slots.patch` remains the only request-model-directed relay selector.
- Gemini and Claude remain Antigravity models; configured third-party models remain namespaced as `anticodex/third-party/*`.
- Explicit provider requests fail closed. Do not add fallback between providers.
- Saving third-party configuration must not change the active task, current model, `activeRelayId`, root Codex config, or any process identity.
- Do not run provider traffic for implementation or Manager acceptance.
- Do not run CDP or real-mouse checks while the user is operating the computer.
- After product acceptance, the existing long task receives only the exact text `继续`.

## Task 1: Lock the save-only service contract with failing tests

**Files:**

- Modify: `translator/tests/anticodex-manager-service.test.mjs`
- Modify: `translator/tests/anticodex-seamless-model-switching.test.mjs`
- Modify: `translator/tests/anticodex-provider-route-control.test.mjs`

- [ ] **Step 1: Replace the direct hot-switch expectations with save-only invariants**

In `anticodex-manager-service.test.mjs`, import the renamed operation and build fixtures with an Antigravity `activeRelayId`, a third-party profile, a native model catalog, and a root `config.toml`. Assert all of these after saving:

```js
const beforeConfig = readFileSync(configPath, "utf8");
const beforePid = process.pid;
const result = saveThirdPartyCodexPlusPlusSettings({
  settingsPath,
  nativeCatalogPath: catalogPath,
  thirdParty: {
    protocol: "responses",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: "saved-test-key",
    model: "gpt-5.6-terra",
    contextWindow: 128000,
    providerModels: ["gpt-5.6-terra", "gpt-5.6-sol"],
  },
});

const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
assert.equal(result.ok, true);
assert.equal(result.saved, true);
assert.equal(settings.activeRelayId, "anticodex-antigravity");
assert.equal(settings.relayTestModel, "gemini-3.1-pro-low");
assert.equal(readFileSync(configPath, "utf8"), beforeConfig);
assert.equal(process.pid, beforePid);
assert.equal("nativeConfigReload" in result, false);
assert.equal("nativeModel" in result, false);
```

- [ ] **Step 2: Prove the unified catalog contains every provider model**

Assert that both third-party models are present with their namespace and configured context window, while Gemini and Claude entries remain present:

```js
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const bySlug = new Map(catalog.models.map((entry) => [entry.slug, entry]));
assert.ok(bySlug.has("gemini-3.1-pro-low"));
assert.ok(bySlug.has("claude-sonnet-4-6"));
assert.equal(bySlug.get("anticodex/third-party/gpt-5.6-terra").context_window, 128000);
assert.equal(bySlug.get("anticodex/third-party/gpt-5.6-sol").context_window, 128000);
```

- [ ] **Step 3: Add rollback coverage**

Use the existing write-failure hook to fail the catalog write after the settings write. Assert both files exactly match their original bytes and that the root config was never touched.

- [ ] **Step 4: Invert the endpoint and renderer contract assertions**

In `anticodex-seamless-model-switching.test.mjs`, replace assertions for `mode: "antigravity"`, native reload, native selection, and `switchRollbackId` with assertions that the save response contains only saved profile/catalog facts. Preserve the existing resident-relay and patch-0004 routing tests.

In `anticodex-provider-route-control.test.mjs`, expect `saveThirdPartyCodexPlusPlusSettings` and forbid the removed hot-switch function name.

- [ ] **Step 5: Run the focused tests and confirm RED**

Run:

```powershell
node --test translator/tests/anticodex-manager-service.test.mjs translator/tests/anticodex-seamless-model-switching.test.mjs translator/tests/anticodex-provider-route-control.test.mjs
```

Expected: failures name the missing save-only export and the still-present switch/reload behavior. No network request or runtime process change occurs.

- [ ] **Step 6: Commit the contract tests**

```powershell
git add translator/tests/anticodex-manager-service.test.mjs translator/tests/anticodex-seamless-model-switching.test.mjs translator/tests/anticodex-provider-route-control.test.mjs
git commit -m "Test Manager save-only provider configuration"
```

## Task 2: Replace the service hot switch with an atomic save transaction

**Files:**

- Modify: `scripts/anticodex-manager-service.mjs`
- Test: `translator/tests/anticodex-manager-service.test.mjs`
- Test: `translator/tests/anticodex-seamless-model-switching.test.mjs`
- Test: `translator/tests/anticodex-provider-route-control.test.mjs`

- [ ] **Step 1: Rename and narrow the shared settings operation**

Replace `hotSwitchCodexPlusPlusSettings(options)` with:

```js
export function saveThirdPartyCodexPlusPlusSettings(options = {}) {
  const settingsPath = path.resolve(String(options.settingsPath || ""));
  const nativeCatalogPath = path.resolve(String(options.nativeCatalogPath || ""));
  const thirdParty = options.thirdParty;
  // Validate the trust boundary, update the existing third-party profile,
  // refresh the existing unified catalog, then atomically write both files.
}
```

Reuse `uniqueModelIds`, `thirdPartyNativeModel`, `writeJsonAtomic`, and the existing catalog template logic. Do not introduce a new class or router.

- [ ] **Step 2: Preserve active routing fields byte-for-byte**

Before mutation, capture these values and restore them into the outgoing settings:

```js
const activeRelayId = settings.activeRelayId;
const relayTestModel = settings.relayTestModel;
// update relayProfiles only
settings.activeRelayId = activeRelayId;
settings.relayTestModel = relayTestModel;
```

The operation must update the existing `anticodex-third-party` profile with provider models, credentials, protocol, test model, and context data, while leaving the resident Antigravity profile unchanged.

- [ ] **Step 3: Refresh the unified catalog without changing the selected model**

Build namespaced entries for every unique provider model. Preserve all visible Antigravity entries and remove only obsolete `anticodex/third-party/*` entries before inserting the refreshed third-party set.

Return the minimal result:

```js
return {
  ok: true,
  saved: true,
  model: thirdPartyProfile.testModel,
  providerModels,
  catalogModelIds,
};
```

Do not return `hotSwitch`, `nativeModel`, `nativeConfigReload`, `restartRequired`, or `switchRollbackId`.

- [ ] **Step 4: Remove native config and switch rollback machinery**

Delete service-only code that exists solely for Manager routing changes:

- `prepareCodexContextConfig`
- `readCodexContextValues`
- `nativeConfigReload`
- `applySavedProfileHotSwitch`
- pending profile-switch rollback endpoint/state
- `mode === "antigravity"` handling under `/anticodex/upstream-profile`

Keep generic atomic file snapshots if they are still used by the save transaction. Reduce `profileSwitchPaths` to the saved profile, CodexPlusPlus settings, and unified catalog; rename it to `profileSavePaths`.

- [ ] **Step 5: Make `/anticodex/upstream-profile` save third-party configuration only**

Keep the current connection test and model discovery. After `SaveThirdParty`, invoke the save-only settings/catalog operation. On any later failure, restore all captured save files and return the existing clear stage error.

The success response is:

```js
return jsonResponse(res, 200, {
  ok: true,
  saved,
  providerModels: capabilities.providerModels,
  message: "配置已保存，可在聊天输入框的模型菜单选择第三方模型。",
}, req);
```

Reject `body.mode === "antigravity"` with status 400 and a message directing model changes to the composer menu. Do not call Antigravity, CodexPlusPlus, or the native config bridge.

- [ ] **Step 6: Run focused tests and confirm GREEN**

```powershell
node --test translator/tests/anticodex-manager-service.test.mjs translator/tests/anticodex-seamless-model-switching.test.mjs translator/tests/anticodex-provider-route-control.test.mjs
```

Expected: all focused tests pass and the rollback fixture preserves both saved files after an injected failure.

- [ ] **Step 7: Commit the service change**

```powershell
git add scripts/anticodex-manager-service.mjs translator/tests/anticodex-manager-service.test.mjs translator/tests/anticodex-seamless-model-switching.test.mjs translator/tests/anticodex-provider-route-control.test.mjs
git commit -m "Make Manager third-party setup save only"
```

## Task 3: Lock the simplified Manager UI contract with failing tests

**Files:**

- Modify: `translator/tests/anticodex-manager-bridge-contract.test.mjs`
- Modify: `scripts/test-anticodex-manager-button.mjs`
- Modify: `scripts/test-anticodex-ui-state.mjs`

- [ ] **Step 1: Assert the third-party form has no route-switch controls**

Update the static contract test to require `保存配置` and the composer-menu success text, and forbid all of these strings/calls inside `showUpstreamConfig`:

```js
assert.doesNotMatch(block, /保存并切换/);
assert.doesNotMatch(block, /恢复 Antigravity/);
assert.doesNotMatch(block, /Antigravity 模型/);
assert.doesNotMatch(block, /reloadNativeCodexConfig/);
assert.doesNotMatch(block, /selectNativeModelByLabels/);
assert.doesNotMatch(block, /mode:\s*"antigravity"/);
assert.match(block, /配置已保存，可在聊天输入框的模型菜单选择第三方模型/);
```

- [ ] **Step 2: Replace two action groups with the five exact groups**

Use the same identifiers in the injected UI, fallback HTML, verifier, and contract test:

```js
const MANAGER_ACTION_GROUPS = Object.freeze({
  status: ["refreshStatus"],
  modelSources: ["refreshModels", "accountSwitch", "upstreamConfig"],
  updates: ["updateCheck", "syncHost"],
  troubleshooting: ["repairShortcuts", "diagnosticsBundle", "viewLatestReports"],
  advanced: [
    "accountProxy", "syncReadiness", "sourcePreflight", "mcpSkills",
    "pluginCapabilities", "refreshFeatures", "fastOverallNoTraffic",
    "overallNoTraffic", "stabilitySoak", "coldRelaunch", "postVerificationFull",
  ],
});
```

Keep high-impact confirmation as a separate set based on behavior, not section membership.

- [ ] **Step 3: Assert advanced diagnostics are collapsed by default**

Require a `<details data-action-group="advanced">` without an `open` attribute and verify every action appears exactly once across the five groups.

- [ ] **Step 4: Run the focused UI contract tests and confirm RED**

```powershell
node --test translator/tests/anticodex-manager-bridge-contract.test.mjs
node scripts/test-anticodex-manager-button.mjs --ui-only-matrix true --compact true
node scripts/test-anticodex-ui-state.mjs
```

Expected: the static test fails on old switch controls/two-group layout. The UI-only matrix may also fail until the renderer and fallback HTML are updated; it must not call provider traffic.

- [ ] **Step 5: Commit the UI contract tests**

```powershell
git add translator/tests/anticodex-manager-bridge-contract.test.mjs scripts/test-anticodex-manager-button.mjs scripts/test-anticodex-ui-state.mjs
git commit -m "Test simplified Manager information architecture"
```

## Task 4: Simplify the injected and fallback Manager surfaces

**Files:**

- Modify: `scripts/anticodex-manager-inject.js`
- Modify: `scripts/anticodex-manager-service.mjs`
- Test: `translator/tests/anticodex-manager-bridge-contract.test.mjs`
- Test: `scripts/test-anticodex-manager-button.mjs`
- Test: `scripts/test-anticodex-ui-state.mjs`

- [ ] **Step 1: Make the third-party form save-only**

In `showUpstreamConfig`:

- remove the Antigravity model select and `restoreButton`;
- rename the submit button to `保存配置` and remove danger styling;
- keep protocol, URL, main test model, provider model list, context window, key, and test button;
- POST only the third-party configuration;
- show the response message and invalidate only the Manager snapshot.

The save handler should end as:

```js
const payload = await managerPostJson("/anticodex/upstream-profile", {
  protocol: protocol.value,
  baseUrl: baseUrl.value.trim(),
  model: model.value.trim(),
  contextWindow: Number(contextWindow.value),
  apiKey: apiKey.value,
}, { timeoutMs: UPSTREAM_TEST_TIMEOUT_MS, retryCandidates: false });
stageBox.textContent = payload.message
  || "配置已保存，可在聊天输入框的模型菜单选择第三方模型。";
window.__ANTICODEX_MANAGER_SNAPSHOT__ = null;
```

Delete `reloadNativeCodexConfig` and `selectNativeModelByLabels` after confirming no callers remain.

- [ ] **Step 2: Render the four default sections and collapsed advanced diagnostics**

Reuse the existing action buttons, busy guard, progress summaries, and high-impact confirmation. Render ordinary groups as `<section>` and advanced diagnostics as one collapsed `<details>` with a `<summary>` label.

- [ ] **Step 3: Mirror the same grouping in fallback HTML**

Replace the fallback `daily` and `high-impact` sections in `anticodex-manager-service.mjs` with the same five groups and collapsed advanced block. Do not add a second action implementation.

- [ ] **Step 4: Run focused UI tests and confirm GREEN**

```powershell
node --check scripts/anticodex-manager-inject.js
node --check scripts/anticodex-manager-service.mjs
node --test translator/tests/anticodex-manager-bridge-contract.test.mjs
node scripts/test-anticodex-manager-button.mjs --ui-only-matrix true --compact true
node scripts/test-anticodex-ui-state.mjs
```

Expected: all commands pass; the UI-only matrix reports every action exactly once, no provider request, no new page, and no native model switch call.

- [ ] **Step 5: Commit the UI implementation**

```powershell
git add scripts/anticodex-manager-inject.js scripts/anticodex-manager-service.mjs translator/tests/anticodex-manager-bridge-contract.test.mjs scripts/test-anticodex-manager-button.mjs scripts/test-anticodex-ui-state.mjs
git commit -m "Simplify Manager model setup and action groups"
```

## Task 5: Run offline regression and synchronize documentation

**Files:**

- Modify: `docs/FINAL_MIGRATION_PLAN.md`
- Modify: `docs/CURRENT_LONG_TASK_ACCEPTANCE.md`
- Modify: `task_plan.md`
- Modify: `findings.md`

- [ ] **Step 1: Run all affected offline tests**

```powershell
node --test translator/tests/anticodex-manager-service.test.mjs translator/tests/anticodex-seamless-model-switching.test.mjs translator/tests/anticodex-manager-bridge-contract.test.mjs translator/tests/anticodex-provider-route-control.test.mjs translator/tests/anticodex-manager-process-safety.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-anticodex-source-preflight.ps1
git diff --check
```

Expected: all tests pass, source preflight stays green, and no whitespace errors are reported.

- [ ] **Step 2: Prove removed behavior has no remaining product caller**

```powershell
rg -n "恢复 Antigravity|保存并切换|reloadNativeCodexConfig|selectNativeModelByLabels|hotSwitchCodexPlusPlusSettings|mode:\s*['\"]antigravity['\"]" scripts translator/tests
```

Expected: no product-code hit. Test-only negative assertions are allowed.

- [ ] **Step 3: Record exact evidence and remaining runtime gate**

Update the four documents with:

- the save-only contract;
- focused/offline test totals;
- source commit and clean/dirty state;
- the fact that runtime sync and real UI acceptance remain pending until the user yields the window;
- no claim of 100% or long-task completion before runtime and final media acceptance.

- [ ] **Step 4: Commit offline completion evidence**

```powershell
git add docs/FINAL_MIGRATION_PLAN.md docs/CURRENT_LONG_TASK_ACCEPTANCE.md task_plan.md findings.md
git commit -m "Record Manager routing acceptance evidence"
```

## Task 6: Synchronize the runtime, perform controlled UI acceptance, and resume the original task

**Files:**

- Verify source and installed copies of:
  - `scripts/anticodex-manager-service.mjs`
  - `scripts/anticodex-manager-inject.js`
  - `scripts/test-anticodex-manager-button.mjs`
- Update after verification:
  - `docs/CURRENT_LONG_TASK_ACCEPTANCE.md`
  - `task_plan.md`
  - `findings.md`

- [ ] **Step 1: Wait until the user yields UI control**

Do not steal focus. If the user is operating the computer, report the single required action and pause only the real-mouse portion; continue all read-only/offline work.

- [ ] **Step 2: Synchronize once without restarting**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-anticodex-runtime.ps1 -NoRestart -TimeoutSec 45
```

Expected: source, installed, sync-readiness, and legacy-zero-hit gates pass; no second Anti-Codex window is created and native Codex remains alive.

- [ ] **Step 3: Restart only the existing Anti-Codex instance when safe**

Use the project-managed single-instance restart path. Confirm exactly one visible Anti-Codex, the same isolated data root, a responsive native Codex, and fixed-route health `provider=antigravity`, `model=gemini-3.1-pro-low` before any task resume.

- [ ] **Step 4: Run no-traffic real UI Manager acceptance**

Run the installed UI-only matrix and manually/physically verify:

- the button label is exactly `管理`;
- open and pseudo-element close work with real mouse input;
- four default groups and collapsed `高级诊断` are visible;
- `配置第三方 API` exposes only save/test fields;
- save success does not change model, task ID, cwd, process IDs, or root config;
- update check and sync show version/result in-page without an unexplained console window.

Do not send a model request during this step.

- [ ] **Step 5: Verify the native model menu without traffic**

With the original task `019f9a93-0de5-71f3-9329-12e0e914e681` open, run the existing `--frontend-model-probe-only` harness for Gemini, Claude, and one configured third-party model. After each selection, verify task ID, cwd, history, and process IDs remain unchanged. End on Gemini.

- [ ] **Step 6: Resume only the original autonomous task**

If the task is idle and final media acceptance is incomplete, submit exactly:

```text
继续
```

Use the existing same-chat harness with the exact task ID/title, `--no-config-model-override`, and `--require-native-single-task`. Do not use `--force-reset-same-chat`, create a task, add a method, or send a micro-stage prompt.

- [ ] **Step 7: Monitor and complete the final acceptance**

Remain read-only while the turn produces plans, tools, or files. Provider order is Gemini, Claude, then saved third-party only after explicit dual failure. Completion requires independently verified live-action video, dialogue/music/subtitles, lip-sync evidence, media QA, hashes, release package, and same-task tool evidence.

- [ ] **Step 8: Record final runtime evidence and commit**

Update the three acceptance documents with operation IDs, process/window counts, model-route evidence, task/turn IDs, artifact hashes, and residual risks. Commit only after every claim has current evidence.

## Plan Self-Review

- [ ] Compare every design-spec acceptance bullet with Tasks 1-6.
- [ ] Confirm every referenced file exists and every renamed symbol is consistent.
- [ ] Run:

```powershell
rg -n "T[B]D|TO[D]O|implement la[t]er|similar t[o]|appropriate error handl[i]ng|write tests f[o]r" docs/superpowers/plans/2026-07-27-manager-model-routing.md
git diff --check
```

Expected: no placeholder hit and no whitespace error.
