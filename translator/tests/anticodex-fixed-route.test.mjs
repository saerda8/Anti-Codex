import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// 静态导入未来模块
import {
  resolveProductPaths,
  generateRouteConfig,
  getCopiedClientArgs,
  getLauncherArgs,
  mergeCodexRouteConfig,
  buildCodexPlusPlusSettings
} from "../../scripts/lib/anticodex-fixed-route.mjs";

test("Contract 1: Product paths are isolated under install/state roots and CodexPlusPlus binary is correct", () => {
  const installRoot = "G:\\mock-install-root";
  const stateRoot = "G:\\mock-state-root";

  const resolved = resolveProductPaths(installRoot, stateRoot);

  // 1.1 CodexPlusPlus binary is components/codexplusplus/codex-plus-plus.exe
  const expectedBinary = path.normalize(path.join(installRoot, "components/codexplusplus/codex-plus-plus.exe"));
  assert.equal(path.normalize(resolved.codexPlusPlusBinary), expectedBinary);

  // 1.2 Must never point to original Codex components or default user profiles
  const forbiddenPatterns = [
    /windowsapps/i,
    /chatgpt\.exe/i,
    /\.codex(?![a-zA-Z0-9_\-])/i, // match .codex but not anticodex
  ];

  for (const [key, value] of Object.entries(resolved)) {
    const normalizedPath = path.normalize(value);

    // Paths must reside inside installRoot or stateRoot
    const isUnderInstall = normalizedPath.startsWith(path.normalize(installRoot));
    const isUnderState = normalizedPath.startsWith(path.normalize(stateRoot));
    assert.ok(isUnderInstall || isUnderState, `Path resolved.${key} (${normalizedPath}) is not under installRoot or stateRoot`);

    for (const pattern of forbiddenPatterns) {
      assert.ok(!pattern.test(normalizedPath), `Path resolved.${key} (${normalizedPath}) matches forbidden pattern ${pattern}`);
    }
  }
});

test("Contract 2: Antigravity routes only let thin Chat adapter become CodexPlusPlus upstream, and Responses base_url points to proxy", () => {
  const proxyPort = 41002;
  const adapterPort = 41003;
  const configOptions = {
    provider: "antigravity",
    proxyPort,
    adapterPort
  };

  const routeConfig = generateRouteConfig(configOptions);

  // 2.1 Thin adapter is enabled
  assert.equal(routeConfig.adapterEnabled, true);

  // 2.2 CodexPlusPlus upstream URL points to the thin Chat adapter
  assert.equal(routeConfig.codexPlusPlusUpstreamUrl, `http://127.0.0.1:${adapterPort}/v1`);

  // 2.3 Codex Responses base_url points to the CodexPlusPlus proxy/helper port
  assert.equal(routeConfig.codexBaseUrl, `http://127.0.0.1:${proxyPort}/v1`);

  // 2.4 Must never point to the legacy 8484 model route
  const configText = routeConfig.config;
  assert.ok(!configText.includes("8484"), "Configuration contains legacy port 8484");
});

test("Contract 2b: the default Antigravity route uses the currently validated Gemini agent model", () => {
  const routeConfig = generateRouteConfig({
    provider: "antigravity",
    proxyPort: 41002,
    adapterPort: 41003,
  });

  assert.equal(routeConfig.model, "gemini-3-flash-agent");
  assert.match(routeConfig.config, /model = "gemini-3-flash-agent"/);
});

test("Contract 2c: the isolated Codex route disables the user login shell profile", () => {
  const routeConfig = generateRouteConfig({
    provider: "antigravity",
    proxyPort: 41002,
    adapterPort: 41003,
  });

  assert.match(routeConfig.config, /^allow_login_shell = false$/m);
});

test("Contract 3: Third-party Chat API directly becomes CodexPlusPlus upstream with adapter disabled and no Antigravity URL", () => {
  const proxyPort = 41002;
  const adapterPort = 41003;
  const thirdPartyConfig = {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "mock-key",
    protocol: "chat"
  };
  const configOptions = {
    provider: "third-party",
    proxyPort,
    adapterPort,
    thirdPartyConfig
  };

  const routeConfig = generateRouteConfig(configOptions);

  // 3.1 Thin adapter is disabled
  assert.equal(routeConfig.adapterEnabled, false);

  // 3.2 Third-party Chat API becomes direct upstream
  assert.equal(routeConfig.codexPlusPlusUpstreamUrl, "https://api.deepseek.com/v1");

  // 3.3 Codex Responses base_url points to the CodexPlusPlus proxy/helper port
  assert.equal(routeConfig.codexBaseUrl, `http://127.0.0.1:${proxyPort}/v1`);

  // 3.4 Antigravity URL/adapter port must not appear
  const configText = routeConfig.config;
  assert.ok(!configText.includes(`127.0.0.1:${adapterPort}`), "Configuration contains Antigravity adapter URL/port");
  assert.equal(routeConfig.profileId, "anticodex-third-party");
  assert.equal(routeConfig.profileName, "Anti-Codex third-party API");
  assert.equal(routeConfig.modelContextWindow, 272000);
  assert.equal(routeConfig.modelAutoCompactTokenLimit, 244800);
  assert.match(routeConfig.config, /^model_context_window = 272000$/m);
  assert.match(routeConfig.config, /^model_auto_compact_token_limit = 244800$/m);
  assert.match(routeConfig.config, /^model_auto_compact_token_limit_scope = "total"$/m);
});

test("Contract 3b: switching upstream routes preserves the Codex provider identity used by thread history", () => {
  const antigravity = generateRouteConfig({
    provider: "antigravity",
    proxyPort: 41002,
    adapterPort: 41003,
  });
  const thirdParty = generateRouteConfig({
    provider: "third-party",
    proxyPort: 41002,
    thirdPartyConfig: {
      baseUrl: "https://provider.example/v1",
      apiKey: "upstream-provider-key",
      protocol: "chatCompletions",
      model: "third-party-model",
    },
  });
  const providerName = (config) => /^model_provider = "([^"]+)"$/m.exec(config)?.[1] ?? null;

  assert.equal(providerName(antigravity.config), "anticodex_antigravity");
  assert.equal(providerName(thirdParty.config), providerName(antigravity.config));
  assert.match(thirdParty.config, /\[model_providers\.anticodex_antigravity\]/);
  assert.doesNotMatch(thirdParty.config, /\[model_providers\.anticodex_third_party\]/);
});

test("Contract 4: CodexPlusPlus stays helper-only while the copied client receives native desktop args", () => {
  const debugPort = 41001;
  const helperPort = 41002;

  const proxyArgs = getLauncherArgs({
    launchDesktop: false,
    helperPort
  });
  assert.deepEqual(proxyArgs, ["--helper-only", "--helper-port", String(helperPort)]);

  const clientArgs = getCopiedClientArgs({
    debugPort,
    codexExtraArgs: ["--user-data-dir=G:\\state\\electron", "--no-first-run"],
  });
  assert.deepEqual(clientArgs, [
    `--remote-debugging-port=${debugPort}`,
    `--remote-allow-origins=http://127.0.0.1:${debugPort}`,
    "--user-data-dir=G:\\state\\electron",
    "--no-first-run",
  ]);
  assert.equal(clientArgs.some((value) => value === "--app-path"), false);
});

test("Contract 5: mergeCodexRouteConfig retains [features], [mcp_servers.*] and common root config, removes old root-level keys, generates single provider block, no 8484", () => {
  const route = generateRouteConfig({
    provider: "antigravity",
    proxyPort: 41002,
    adapterPort: 41003,
    model: "gemini-3.5-flash-low",
  });

  const existingConfig = `
chatgpt_base_url = "http://127.0.0.1:8484/v1"
openai_base_url = "http://127.0.0.1:8484/v1"
model = "old-model-8484"
model_provider = "old-provider"
model_catalog_json = "C:\\\\old\\\\catalog.json"
model_context_window = 999999
model_auto_compact_token_limit = 888888
model_auto_compact_token_limit_scope = "body_after_prefix"
allow_login_shell = true
some_root_setting = "value"

[features]
enable_telemetry = false

[mcp_servers.foo]
command = "node"
`;

  const merged = mergeCodexRouteConfig(existingConfig, route);

  // Assertions for Contract 5:
  // 1. Must retain [features], [mcp_servers.*]
  assert.ok(merged.includes("[features]"), "Should retain [features] section");
  assert.ok(merged.includes("enable_telemetry = false"), "Should retain settings inside [features]");
  assert.ok(merged.includes("[mcp_servers.foo]"), "Should retain [mcp_servers.foo] section");
  assert.ok(merged.includes('command = "node"'), "Should retain settings inside [mcp_servers.foo]");

  // 2. Must retain common root config
  assert.ok(merged.includes('some_root_setting = "value"'), "Should retain common root config");

  // 3. Must remove old root level chatgpt_base_url/openai_base_url/model/model_provider/model_catalog_json
  assert.ok(!merged.includes("chatgpt_base_url"), "Should remove old chatgpt_base_url");
  assert.ok(!merged.includes("openai_base_url"), "Should remove old openai_base_url");
  assert.ok(!merged.includes("old-model-8484"), "Should remove old model");
  assert.ok(!merged.includes("old-provider"), "Should remove old model_provider");
  assert.ok(!merged.includes("catalog.json"), "Should remove old model_catalog_json");
  assert.ok(!merged.includes("model_context_window"), "Should remove old model_context_window outside third-party routes");
  assert.ok(!merged.includes("model_auto_compact_token_limit"), "Should remove old model_auto_compact_token_limit outside third-party routes");
  assert.ok(!merged.includes("model_auto_compact_token_limit_scope"), "Should remove old model_auto_compact_token_limit_scope outside third-party routes");
  assert.ok(!merged.includes("allow_login_shell = true"), "Should remove old allow_login_shell value");
  assert.equal((merged.match(/^allow_login_shell = false$/gm) ?? []).length, 1, "Should generate exactly one disabled login shell setting");

  // 4. Must generate new provider block
  assert.ok(merged.includes("[model_providers.anticodex_antigravity]"), "Should generate new provider block");

  // 5. Output must not contain 8484
  assert.ok(!merged.includes("8484"), "Output should not contain legacy port 8484");
});

test("Contract 6: Repeated mergeCodexRouteConfig is idempotent (byte-level equal), and buildCodexPlusPlusSettings configuration is correct", () => {
  const route = generateRouteConfig({
    provider: "antigravity",
    proxyPort: 41002,
    adapterPort: 41003,
    model: "gemini-3.5-flash-low",
  });

  const existingConfig = `
chatgpt_base_url = "http://127.0.0.1:8484/v1"
openai_base_url = "http://127.0.0.1:8484/v1"
model = "old-model-8484"
model_provider = "old-provider"
model_catalog_json = "C:\\\\old\\\\catalog.json"
some_root_setting = "value"

[features]
enable_telemetry = false

[mcp_servers.foo]
command = "node"
`;

  const mergedFirst = mergeCodexRouteConfig(existingConfig, route);
  const mergedSecond = mergeCodexRouteConfig(mergedFirst, route);

  // 1. Must be byte-level equal (no extra changes on second call)
  assert.equal(mergedSecond, mergedFirst, "Repeated mergeCodexRouteConfig call must yield byte-level identical configuration");

  // 2. Cannot duplicate provider section
  const sectionHeader = "[model_providers.anticodex_antigravity]";
  const firstIndex = mergedFirst.indexOf(sectionHeader);
  assert.ok(firstIndex !== -1, "Provider section must exist");
  const lastIndex = mergedFirst.lastIndexOf(sectionHeader);
  assert.equal(firstIndex, lastIndex, "Provider section must not be duplicated");

  // 3. Test buildCodexPlusPlusSettings
  const mockUserDataDir = path.resolve("G:\\mock-user-data-dir");
  const settings = buildCodexPlusPlusSettings({
    route,
    userDataDir: mockUserDataDir,
    disableGpu: true,
  });

  // Verify codexExtraArgs use isolated user-data directory
  const hasUserDataArg = settings.codexExtraArgs.some(arg => arg.startsWith(`--user-data-dir=${mockUserDataDir}`));
  assert.ok(hasUserDataArg, `codexExtraArgs must contain the isolated user-data-dir path, got: ${settings.codexExtraArgs.join(" ")}`);

  // Verify disabling enhancements and provider sync
  assert.equal(settings.enhancementsEnabled, false, "CodexPlusPlus enhancements must be disabled");
  assert.equal(settings.providerSyncEnabled, false, "CodexPlusPlus provider sync must be disabled");

  // Verify active relay is consistent with route
  assert.equal(settings.activeRelayId, route.profileId, "Active relay ID must match route profile ID");
  assert.equal(settings.relayTestModel, route.model, "Relay test model must match route model");

  // Verify the relay profile details are consistent with route
  const activeProfile = settings.relayProfiles.find(p => p.id === route.profileId);
  assert.ok(activeProfile, "Relay profile corresponding to route.profileId must exist");
  assert.equal(activeProfile.name, route.profileName);
  assert.equal(activeProfile.upstreamBaseUrl, route.codexPlusPlusUpstreamUrl);
  assert.equal(activeProfile.apiKey, route.upstreamApiKey);
  assert.equal(activeProfile.protocol, route.relayProtocol);
  assert.equal(activeProfile.testModel, route.model);
  assert.equal(activeProfile.configContents, route.config);
  assert.equal(activeProfile.authContents, route.authContents);
});

test("Contract 7: third-party relay auth uses the upstream API key, not the local proxy key", () => {
  const route = generateRouteConfig({
    provider: "third-party",
    proxyPort: 41002,
    model: "third-party-model",
    localProxyKey: "local-proxy-key",
    thirdPartyConfig: {
      baseUrl: "https://provider.example/v1",
      apiKey: "upstream-provider-key",
      protocol: "chatCompletions",
      model: "third-party-model",
    },
  });
  const settings = buildCodexPlusPlusSettings({
    route,
    userDataDir: path.resolve("G:\\mock-user-data-dir"),
  });
  const profile = settings.relayProfiles[0];

  assert.equal(JSON.parse(route.authContents).OPENAI_API_KEY, "local-proxy-key");
  assert.equal(profile.apiKey, "upstream-provider-key");
  assert.equal(JSON.parse(profile.authContents).OPENAI_API_KEY, "upstream-provider-key");
});
