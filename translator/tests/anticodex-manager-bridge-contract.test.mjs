import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const source = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
const managerOpenInject = readFileSync(resolve(root, "scripts", "anticodex-manager-open-inject.js"), "utf8");
const managerService = readFileSync(resolve(root, "scripts", "anticodex-manager-service.mjs"), "utf8");
const cdpInject = readFileSync(resolve(root, "scripts", "deepcodex-cdp-inject.mjs"), "utf8");
const managerButtonTest = readFileSync(resolve(root, "scripts", "test-anticodex-manager-button.mjs"), "utf8");

const completeSnapshotPaths = [
  "/anticodex/manager/bootstrap",
  "/health",
  "/models",
  "/anticodex/diagnostics",
  "/anticodex/upstream-profile",
  "/anticodex/model-routes",
  "/anticodex/local-connectors/allowlist",
  "/backend-api/ps/plugins/installed",
  "/backend-api/aip/connectors",
  "/backend-api/plugins/list",
  "/backend-api/wham/apps",
];

test("Manager bridge snapshots identify themselves to the launcher-owned service", () => {
  const block = source.match(/async function managerSnapshot\(\) \{[\s\S]*?\n\}\n\nasync function runAction/)?.[0] ?? "";
  assert.match(block, /const trustedHeaders\s*=\s*\{/);
  assert.match(block, /origin:\s*baseUrl/);
  assert.match(block, /referer:\s*`\$\{baseUrl\}\/anticodex\/manager`/);
  assert.match(block, /headers:\s*trustedHeaders/);
});

test("Manager bridge and startup injector both build complete read snapshots", () => {
  const bridgeBlock = source.match(/async function managerSnapshot\(\) \{[\s\S]*?\n\}\n\nasync function runAction/)?.[0] ?? "";
  const injectorBlock = cdpInject.match(/const snapshot = \{[\s\S]*?source = \[/)?.[0] ?? "";
  for (const path of completeSnapshotPaths) {
    assert.match(bridgeBlock, new RegExp(path.replaceAll("/", "\\/")), `bridge snapshot is missing ${path}`);
    assert.match(injectorBlock, new RegExp(path.replaceAll("/", "\\/")), `startup snapshot is missing ${path}`);
  }
  assert.match(injectorBlock, /origin:\s*baseUrl/);
  assert.match(injectorBlock, /referer:\s*`\$\{baseUrl\}\/anticodex\/manager`/);
});

test("Manager bridge reinstalls its renderer runtime after reload", () => {
  assert.match(source, /const managerQueuePollSource = `[\s\S]*?\$\{bridgeSource\}[\s\S]*?__ANTICODEX_MANAGER_ACTION_QUEUE__/);
  assert.match(source, /evaluate\(managerQueuePollSource/);
  assert.match(source, /typeof globalThis\.__ANTICODEX_RUN_MANAGER_ACTION__ !== "function"/);
  assert.match(source, /typeof globalThis\.__ANTICODEX_RUN_MANAGER_REQUEST__ !== "function"/);
});

test("third-party profile reads and writes use a bounded renderer-to-Manager request bridge", () => {
  const allowedRequestBlock = source.match(/const ALLOWED_MANAGER_BRIDGE_REQUESTS = new Map\([\s\S]*?\n\]\);/)?.[0] ?? "";
  for (const path of [...completeSnapshotPaths, "/anticodex/account", "/anticodex/upstream-test", "/anticodex/upstream-apply"]) {
    assert.match(allowedRequestBlock, new RegExp(path.replaceAll("/", "\\/")), `request bridge is missing ${path}`);
  }
  for (const path of [
    "/anticodex/upstream-test",
    "/anticodex/upstream-apply",
    "/anticodex/local-connectors/allowlist",
  ]) {
    assert.match(allowedRequestBlock, new RegExp(path.replaceAll("/", "\\/")), `request bridge is missing ${path}`);
  }
  assert.match(source, /request\.kind === "manager-request"/);
  assert.match(source, /runManagerRequest\(request\.path, request\.options\)/);
  assert.match(source, /path === "\/backend-api\/wham\/apps" && method === "GET"\s*\? "POST"/);
  assert.match(managerInject, /__ANTICODEX_RUN_MANAGER_REQUEST__/);
  assert.match(managerInject, /managerRequestViaBridge/);
  assert.match(managerInject, /managerGetLiveJson/);
  const getJsonBlock = managerInject.match(/async function getJson\(path, options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(getJsonBlock, /managerRequestViaBridge\(path[\s\S]*?apiCandidates\(\)/);
});

test("Manager initial render consumes its complete snapshot without serial bridge fan-out", () => {
  const getJsonBlock = managerInject.match(/async function getJson\(path, options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(getJsonBlock, /options\.preferSnapshot === true[\s\S]*?return snapshotFallback/);
  const loadBlock = managerInject.match(/async function load\(options = \{\}\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(loadBlock, /const snapshotReadOptions = \{ preferSnapshot: true \}/);
  assert.match(loadBlock, /safeJson\("\/health", snapshotReadOptions\)/);
  assert.match(loadBlock, /safeJson\("\/anticodex\/diagnostics", \{ \.\.\.snapshotReadOptions, timeoutMs: DIAGNOSTICS_FETCH_TIMEOUT_MS \}\)/);
  assert.match(loadBlock, /safeJson\("\/anticodex\/upstream-profile", snapshotReadOptions\)/);
  const upstreamConfigStart = managerInject.indexOf("async function showUpstreamConfig()");
  const upstreamConfigEnd = managerInject.indexOf("function installActions()", upstreamConfigStart);
  const upstreamConfigBlock = managerInject.slice(upstreamConfigStart, upstreamConfigEnd);
  assert.match(upstreamConfigBlock, /safeJson\("\/anticodex\/upstream-profile", \{ preferSnapshot: true \}\)/);
});

test("high-impact confirmation resolves the live result node inside its own scope", () => {
  const block = managerInject.match(/function requireHighImpactConfirmation\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(block, /const result = document\.querySelector\(`#\$\{MANAGER_ID\} \[data-anticodex-result="action"\]`\)/);
  assert.match(block, /if \(!result\)[\s\S]*?return true/);
});

test("Manager verifier has a no-traffic actual-mouse third-party form mode", () => {
  assert.match(managerButtonTest, /const upstreamConfigOnly = args\.has\("--upstream-config-only"\)/);
  assert.match(managerButtonTest, /async function verifyUpstreamConfigActualMouseClick\(\)/);
  assert.match(managerButtonTest, /data-action="upstreamConfig"/);
  assert.match(managerButtonTest, /profileUnchanged/);
  assert.match(managerButtonTest, /usedRealTraffic: false/);
  assert.match(managerButtonTest, /if \(upstreamConfigOnly\)/);
});

test("profile-entry verifier closes an existing Manager overlay before opening settings", () => {
  const start = managerButtonTest.indexOf("async function verifyProfileManagerEntryActualMouseWithFreshCdp()");
  const end = managerButtonTest.indexOf("async function verifyCloseButtonActualMouseClick()", start);
  const block = managerButtonTest.slice(start, end);
  const closeIndex = block.indexOf("existingManagerOverlay");
  const triggerIndex = block.indexOf("const trigger =");

  assert.ok(closeIndex >= 0 && triggerIndex > closeIndex);
  assert.match(block, /data-anticodex-close="true"/);
  assert.match(block, /existing Manager overlay did not close/);
});

test("Manager verifier restores any action bridge that it replaces", () => {
  assert.match(managerButtonTest, /__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__ = window\.__ANTICODEX_RUN_MANAGER_ACTION__/);
  assert.match(managerButtonTest, /function cleanupRealBridgeSource/);
  assert.match(managerButtonTest, /window\.__ANTICODEX_RUN_MANAGER_ACTION__ = window\.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__/);
  assert.match(managerButtonTest, /realBridgeSource\(!uiOnlyMode && !upstreamConfigOnly && !closeOnly\)/);
  const finalCleanup = managerButtonTest.lastIndexOf("cleanupRealBridgeSource()");
  const finalClose = managerButtonTest.lastIndexOf("ws.close()");
  assert.ok(finalCleanup >= 0 && finalCleanup < finalClose, "single-action cleanup must run before the CDP socket closes");
});

test("Manager bridge refreshes the model catalog through the read-only models endpoint", () => {
  const block = source.match(/async function runAction\(action\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(block, /action === "refreshModels"[\s\S]*?`\$\{baseUrl\}\/models`/);
  assert.doesNotMatch(block, /anticodex\/models\/refresh/);
});

test("current Manager UI exposes no legacy session-controller action", () => {
  assert.match(managerInject, /const VERSION = "native-panel-v105"/);
  assert.match(managerOpenInject, /__ANTICODEX_MANAGER_VERSION__ === "native-panel-v105"/);
  for (const [name, text] of Object.entries({ source, managerInject, managerService })) {
    assert.doesNotMatch(text, /resetAntigravitySessionLock/, `${name} still exposes the removed session reset`);
  }
});

test("native compatibility style makes closed Radix menu wrappers mouse transparent", () => {
  assert.match(managerInject, /anticodex-native-compat-style/);
  assert.match(
    managerInject,
    /\[data-radix-popper-content-wrapper\]:has\(> \[data-radix-menu-content\]\[data-state="closed"\]\)\{pointer-events:none!important\}/,
  );
});
