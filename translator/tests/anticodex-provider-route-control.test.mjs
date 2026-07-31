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
  assert.doesNotMatch(profile, /UseAntigravity/);
  assert.doesNotMatch(profile, /mode = "third-party"/);
  assert.match(launcher, /const runtimeProfile = readThirdPartyRuntimeProfile\(plan, env\)/);
  assert.match(launcher, /if \(thirdPartyConfigured && apiKey\)/);
  assert.match(controlApi, /antigravityModelsFromCatalog/);
  assert.match(controlApi, /providerModels/);
});

test("Manager labels third-party routes as Chat Completions or Responses", () => {
  assert.match(managerUi, /value:\s*"openai-compatible",\s*text:\s*"Chat Completions"/);
  assert.match(managerUi, /value:\s*"responses",\s*text:\s*"Responses"/);
  assert.doesNotMatch(managerUi, /value:\s*"anthropic"/);
});

test("Manager discloses one real probe and reuses it during save", () => {
  assert.match(managerUi, /发送一次最小真实请求/);
  assert.match(managerUi, /保存配置.*复用这次结果.*不会再次请求/);
  assert.match(controlApi, /UPSTREAM_TEST_EVIDENCE_TTL_MS/);
  assert.match(controlApi, /createHmac\("sha256", upstreamTestEvidenceSalt\)/);
});

test("third-party profiles carry an explicit context window", () => {
  assert.match(profile, /\[int\]\$ContextWindow\s*=\s*272000/);
  assert.match(profile, /contextWindow\s*=\s*\$ContextWindow/);
  assert.match(launcher, /UPSTREAM_CONTEXT_WINDOW:\s*String\(runtimeProfile\.contextWindow\)/);
  assert.match(controlApi, /addArg\("ContextWindow",\s*values\.contextWindow\)/);
  assert.match(managerUi, /row\("上下文窗口（token）",\s*contextWindow\)/);
});

test("Manager only saves third-party profiles and cannot switch the native model", () => {
  const start = managerUi.indexOf("async function showUpstreamConfig()");
  const end = managerUi.indexOf("function installActions()", start);
  const block = managerUi.slice(start, end);
  assert.doesNotMatch(block, /selectNativeModelByLabels|reloadNativeCodexConfig/);
  assert.doesNotMatch(block, /upstream-profile\/rollback|switchRollbackId/);
  assert.match(controlApi, /export function saveThirdPartyCodexPlusPlusSettings/);
  assert.doesNotMatch(controlApi, /\bhotSwitchCodexPlusPlusSettings\b/);
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
