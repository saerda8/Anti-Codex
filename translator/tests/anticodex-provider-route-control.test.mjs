import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const profile = readFileSync(resolve(root, "scripts", "anticodex-upstream-profile.ps1"), "utf8");
const managerUi = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
const launcher = readFileSync(resolve(root, "scripts", "start-anticodex-task.mjs"), "utf8");
const supervisor = readFileSync(resolve(root, "scripts", "start-anticodex-fixed-route.mjs"), "utf8");
const controlApi = readFileSync(resolve(root, "scripts", "anticodex-manager-service.mjs"), "utf8");
const managerBridge = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
const humanLong = readFileSync(resolve(root, "scripts", "test-anticodex-human-long-journey.mjs"), "utf8");

test("saved third-party profiles expose only CodexPlusPlus-native protocols", () => {
  assert.match(profile, /ValidateSet\("",\s*"openai-compatible",\s*"responses"\)/);
  assert.match(profile, /Protocol must be openai-compatible or responses/);
  assert.doesNotMatch(profile, /ValidateSet\([^\n]+"anthropic"/);
});

test("Antigravity and third-party choices persist independently", () => {
  assert.match(profile, /antigravityModel/);
  assert.match(profile, /GetRuntime[\s\S]*apiKey = \$runtimeApiKey/);
  assert.match(launcher, /const runtimeProfile = readThirdPartyRuntimeProfile\(plan, env\)/);
  assert.match(launcher, /if \(thirdPartyConfigured && apiKey\)/);
  assert.match(controlApi, /antigravityModelsFromCatalog/);
  assert.match(controlApi, /savedThirdPartyForHotSwitch/);
});

test("Manager labels third-party routes as Chat Completions or Responses", () => {
  assert.match(managerUi, /value:\s*"openai-compatible",\s*text:\s*"Chat Completions"/);
  assert.match(managerUi, /value:\s*"responses",\s*text:\s*"Responses"/);
  assert.doesNotMatch(managerUi, /value:\s*"anthropic"/);
});

test("third-party profiles carry an explicit context window", () => {
  assert.match(profile, /\[int\]\$ContextWindow\s*=\s*272000/);
  assert.match(profile, /contextWindow\s*=\s*\$ContextWindow/);
  assert.match(launcher, /UPSTREAM_CONTEXT_WINDOW:\s*String\(runtimeProfile\.contextWindow\)/);
  assert.match(controlApi, /addArg\("ContextWindow",\s*values\.contextWindow\)/);
  assert.match(managerUi, /row\("上下文窗口（token）",\s*contextWindow\)/);
});

test("Manager hot-switches profiles and cannot request a route or client restart", () => {
  const start = managerUi.indexOf("async function showUpstreamConfig()");
  const end = managerUi.indexOf("function installActions()", start);
  const block = managerUi.slice(start, end);
  assert.match(block, /selectNativeModelByLabels/);
  assert.match(block, /payload\.restartRequired === false/);
  assert.match(controlApi, /hotSwitchCodexPlusPlusSettings/);
  assert.match(controlApi, /restartRequired:\s*false/);
  assert.doesNotMatch(block, /upstream-apply|applyAndWait|正在重启|30 秒内恢复/);
  assert.doesNotMatch(controlApi, /pathname === "\/anticodex\/upstream-apply"/);
  assert.doesNotMatch(managerBridge, /\/anticodex\/upstream-apply/);
});

test("the supervisor keeps both relays and the Antigravity adapter resident", () => {
  assert.match(supervisor, /const relayRoutes = \[antigravityRoute, thirdPartyRoute\]\.filter\(Boolean\)/);
  assert.match(supervisor, /relayRoutes:\s*runtimeRelayRoutes/);
  assert.match(supervisor, /provider = await startAntigravityChatProvider/);
  assert.match(supervisor, /buildUnifiedModelCatalog/);
  assert.match(supervisor, /anticodex-model-catalog\.json/);
});

test("synthetic human long journeys accept either supported provider", () => {
  assert.match(humanLong, /new Set\(\["antigravity",\s*"third-party"\]\)/);
  assert.match(humanLong, /supportedFixedRouteProviders\.has\(fixedRouteProvider\)/);
  assert.doesNotMatch(humanLong, /fixed Antigravity route is not ready for a real human journey/);
});

test("synthetic human long journeys stop after the first pre-dispatch failure", () => {
  assert.match(humanLong, /if \(turn\.usedRealTraffic !== true\)/);
  assert.match(humanLong, /stoppedAfterNoTrafficFailure/);
});
