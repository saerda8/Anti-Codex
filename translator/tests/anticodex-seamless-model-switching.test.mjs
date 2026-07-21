import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ANTIGRAVITY_MODEL_SLOT,
  ANTIGRAVITY_RELAY_ID,
  THIRD_PARTY_MODEL_SLOT,
  THIRD_PARTY_RELAY_ID,
  buildCodexPlusPlusSettings,
  generateRouteConfig,
  thirdPartyNativeModel,
} from "../../scripts/lib/anticodex-fixed-route.mjs";
import {
  buildTaskLaunchPlan,
  buildTaskLauncherEnvironment,
} from "../../scripts/start-anticodex-task.mjs";
import { buildUnifiedModelCatalog } from "../../scripts/start-anticodex-fixed-route.mjs";
import { hotSwitchCodexPlusPlusSettings } from "../../scripts/anticodex-manager-service.mjs";

const root = resolve(import.meta.dirname, "..", "..");

function routes() {
  const common = {
    proxyPort: 18484,
    catalogPath: "C:\\Users\\XD\\AppData\\Roaming\\anticodex\\codex-home-deepseek-app\\anticodex-model-catalog.json",
    localProxyKey: "local-proxy-key",
  };
  const antigravity = generateRouteConfig({
    ...common,
    provider: "antigravity",
    adapterPort: 18488,
    model: "gemini-3.1-pro-low",
    clientModel: "gemini-3.1-pro-low",
    relayModelList: [ANTIGRAVITY_MODEL_SLOT, "gemini-3.1-pro-low", "claude-sonnet-4-6"],
  });
  const thirdParty = generateRouteConfig({
    ...common,
    provider: "third-party",
    model: "gpt-5.5",
    clientModel: thirdPartyNativeModel("gpt-5.5"),
    relayModelList: [THIRD_PARTY_MODEL_SLOT, thirdPartyNativeModel("gpt-5.5")],
    thirdPartyConfig: {
      protocol: "responses",
      baseUrl: "https://provider.example/v1",
      model: "gpt-5.5",
      apiKey: "third-party-key",
    },
  });
  return { antigravity, thirdParty };
}

test("CodexPlusPlus keeps Antigravity and third-party relays resident at the same time", () => {
  const { antigravity, thirdParty } = routes();
  const settings = buildCodexPlusPlusSettings({
    route: antigravity,
    relayRoutes: [antigravity, thirdParty],
    userDataDir: "C:\\AntiCodex-Test\\electron",
  });

  assert.equal(settings.activeRelayId, ANTIGRAVITY_RELAY_ID);
  assert.deepEqual(settings.relayProfiles.map((profile) => profile.id), [
    ANTIGRAVITY_RELAY_ID,
    THIRD_PARTY_RELAY_ID,
  ]);
  assert.match(settings.relayProfiles[0].modelList, /gemini-3\.1-pro-low/);
  assert.match(settings.relayProfiles[1].modelList, /anticodex\/third-party\/gpt-5\.5/);
});

test("one stable native catalog exposes Gemini, Claude and third-party choices together", () => {
  const bundled = {
    models: [{
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      visibility: "list",
      supported_in_api: true,
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      context_window: 272000,
      max_context_window: 272000,
    }],
  };
  const antigravityCatalog = {
    ...bundled,
    models: [
      { ...bundled.models[0], slug: "gemini-3.1-pro-low", display_name: "Gemini 3.1 Pro (Low)" },
      { ...bundled.models[0], slug: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    ],
  };
  const catalog = buildUnifiedModelCatalog(bundled, {
    antigravityCatalog,
    thirdPartyModel: "gpt-5.5",
    thirdPartyModels: ["gpt-5.5", "gpt-5.6-terra"],
    thirdPartyContextWindow: 1_000_000,
  });
  const visible = catalog.models.filter((model) => model.visibility === "list");
  const slugs = visible.map((model) => model.slug);

  assert.ok(slugs.includes("gemini-3.1-pro-low"));
  assert.ok(slugs.includes("claude-sonnet-4-6"));
  assert.ok(slugs.includes(ANTIGRAVITY_MODEL_SLOT));
  assert.ok(slugs.includes(THIRD_PARTY_MODEL_SLOT));
  assert.ok(slugs.includes(thirdPartyNativeModel("gpt-5.5")));
  assert.equal(
    visible.find((model) => model.slug === thirdPartyNativeModel("gpt-5.5"))?.display_name,
    "第三方 · gpt-5.5",
  );
});

test("Manager hot switching rewrites settings atomically and preserves both relays", () => {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-hot-switch-"));
  const settingsPath = join(fixture, "settings.json");
  try {
    const { antigravity, thirdParty } = routes();
    writeFileSync(settingsPath, JSON.stringify(buildCodexPlusPlusSettings({
      route: antigravity,
      relayRoutes: [antigravity, thirdParty],
      userDataDir: join(fixture, "electron"),
    })));

    const thirdPartyResult = hotSwitchCodexPlusPlusSettings({
      settingsPath,
      mode: "third-party",
      adapterPort: 18488,
      antigravityModel: "gemini-3.1-pro-low",
      antigravityModels: ["gemini-3.1-pro-low", "claude-sonnet-4-6"],
      thirdParty: {
        protocol: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080",
        model: "gpt-5.6-terra",
        apiKey: "new-third-party-key",
        providerModels: ["gpt-5.6-terra"],
      },
    });
    const switched = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(thirdPartyResult.restartRequired, false);
    assert.equal(thirdPartyResult.hotSwitch, true);
    assert.equal(thirdPartyResult.nativeModel.slug, THIRD_PARTY_MODEL_SLOT);
    assert.equal(switched.activeRelayId, THIRD_PARTY_RELAY_ID);
    assert.equal(switched.relayProfiles.length, 2);
    assert.equal(switched.relayProfiles.find((profile) => profile.id === THIRD_PARTY_RELAY_ID).testModel, "gpt-5.6-terra");

    const antigravityResult = hotSwitchCodexPlusPlusSettings({
      settingsPath,
      mode: "antigravity",
      adapterPort: 18488,
      antigravityModel: "claude-sonnet-4-6",
      antigravityModels: ["gemini-3.1-pro-low", "claude-sonnet-4-6"],
      thirdParty: {
        protocol: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080",
        model: "gpt-5.6-terra",
        apiKey: "new-third-party-key",
        providerModels: ["gpt-5.6-terra"],
      },
    });
    const restored = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(antigravityResult.nativeModel.slug, "claude-sonnet-4-6");
    assert.equal(restored.activeRelayId, ANTIGRAVITY_RELAY_ID);
    assert.equal(restored.relayProfiles.find((profile) => profile.id === THIRD_PARTY_RELAY_ID).testModel, "gpt-5.6-terra");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Antigravity startup keeps the saved third-party route available for a later frontend switch", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\XD\\AppData\\Local",
    APPDATA: "C:\\Users\\XD\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\XD",
  };
  const plan = buildTaskLaunchPlan({
    env,
    profile: {
      mode: "antigravity",
      antigravityModel: "gemini-3.1-pro-low",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "gpt-5.6-terra",
      contextWindow: 1_000_000,
    },
  });
  const child = buildTaskLauncherEnvironment(plan, env, {
    ...plan.profile,
    apiKey: "saved-third-party-key",
  });

  assert.equal(child.ANTICODEX_PROVIDER, "antigravity");
  assert.equal(child.UPSTREAM_URL, "http://127.0.0.1:8080");
  assert.equal(child.UPSTREAM_MODEL, "gpt-5.6-terra");
  assert.equal(child.UPSTREAM_API_KEY, "saved-third-party-key");
});

test("formal PowerShell launcher keeps a saved third-party relay resident while Antigravity is active", () => {
  const launcher = readFileSync(join(root, "scripts", "start-anticodex.ps1"), "utf8");
  const start = launcher.indexOf("function Set-AntiCodexProviderEnvironment");
  const end = launcher.indexOf("\nfunction Wait-AntiCodexFixedRouteReady", start);
  const block = launcher.slice(start, end);

  assert.match(block, /\$thirdPartyConfigured\s*=/);
  assert.match(block, /if \(\$thirdPartyConfigured\)[\s\S]*?\$env:UPSTREAM_URL\s*=/);
  assert.match(block, /\$env:UPSTREAM_MODEL\s*=\s*\[string\]\$RuntimeProfile\.model/);
  assert.match(block, /\$env:UPSTREAM_API_KEY\s*=\s*\[string\]\$RuntimeProfile\.apiKey/);
  assert.match(block, /if \(\$runtimeMode -eq "third-party"\)[\s\S]*?\$provider\s*=\s*"third-party"/);
});

test("Manager switches the native model in place and never calls the route restart endpoint", () => {
  const ui = readFileSync(join(root, "scripts", "anticodex-manager-inject.js"), "utf8");
  const start = ui.indexOf("async function showUpstreamConfig()");
  const end = ui.indexOf("\n    function installActions()", start);
  const block = ui.slice(start, end);

  assert.match(block, /selectNativeModelByLabels/);
  assert.match(block, /restartRequired\s*===\s*false|restartRequired:\s*false/);
  assert.doesNotMatch(block, /upstream-apply|applyAndWait|正在重启|30 秒内恢复/);
});

test("CodexPlusPlus patch routes Anti-Codex model slots without a fixed-model environment override", () => {
  const patch = readFileSync(
    join(root, "third_party", "codexplusplus", "patches", "0004-route-anticodex-model-slots.patch"),
    "utf8",
  );
  assert.match(patch, /select_anticodex_relay_for_model/);
  assert.match(patch, /anticodex\/antigravity/);
  assert.match(patch, /anticodex\/third-party/);
  assert.match(patch, /anticodex-antigravity/);
  assert.match(patch, /anticodex-third-party/);
  assert.doesNotMatch(patch, /CODEX_PLUS_FIXED_MODEL|apply_fixed_model_override/);
});

test("desktop verifier physically switches the native model without sending traffic", () => {
  const verifier = readFileSync(join(root, "scripts", "test-anticodex-ui-chat-smoke.mjs"), "utf8");
  const start = verifier.indexOf("async function runFrontendModelProbeOnly()");
  const end = verifier.indexOf("\nasync function runWorkspaceCommandOnly()", start);
  const block = verifier.slice(start, end);
  const helperStart = verifier.indexOf("async function selectFrontendModelWithPhysicalMouse(");
  const helperEnd = verifier.indexOf("\nasync function readFrontendRuntimeReady()", helperStart);
  const helperBlock = verifier.slice(helperStart, helperEnd);

  assert.match(verifier, /--frontend-model-probe-only/);
  assert.match(verifier, /\[role="menu"\]/);
  assert.match(verifier, /composerDistance <= 360/);
  assert.match(verifier, /模型\|自定义/);
  assert.match(verifier, /targetThread/);
  assert.match(helperBlock, /Input\.dispatchMouseEvent/);
  assert.match(verifier, /aria-haspopup.*!==.*menu/);
  assert.match(helperBlock, /selectorRetryCount === 0/);
  assert.match(helperBlock, /key: "ArrowRight"/);
  assert.match(helperBlock, /document\.activeElement === item/);
  assert.match(helperBlock, /scrollIntoView\(\{ block: 'nearest'/);
  assert.match(block, /selectFrontendModelWithPhysicalMouse/);
  assert.match(block, /readNativeCodexRequestSnapshot/);
  assert.match(block, /frontend model probe sent a model request/);
  assert.match(block, /modelDirected:\s*true/);
  assert.doesNotMatch(block, /fixed route did not follow the frontend-selected model/);
  assert.match(block, /CodexPlusPlus restarted during frontend selection/);
  assert.match(block, /Anti-Codex client restarted during frontend selection/);
  assert.doesNotMatch(block, /pressComposerEnter|sendButton|httpJsonPost/);
});
