import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  createAntiCodexManagerService,
  hotSwitchCodexPlusPlusSettings,
} from "../../scripts/anticodex-manager-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("third-party hot switch adds the tested model to the native catalog", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-terra-catalog-"));
  try {
    const settingsPath = path.join(tempDir, "settings.json");
    const catalogPath = path.join(tempDir, "anticodex-model-catalog.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      relayProfiles: [
        {
          id: "anticodex-antigravity",
          apiKey: "local-adapter-key",
          testModel: "gemini-3-flash-agent",
        },
        {
          id: "anticodex-third-party",
          apiKey: "saved-third-party-key",
          testModel: "gpt-5.6-sol",
        },
      ],
      activeRelayId: "anticodex-third-party",
      relayTestModel: "gpt-5.6-sol",
    }), "utf8");
    fs.writeFileSync(catalogPath, JSON.stringify({
      models: [
        {
          slug: "anticodex/third-party/gpt-5.6-sol",
          display_name: "第三方 · gpt-5.6-sol",
          visibility: "list",
          shell_type: "shell_command",
          apply_patch_tool_type: "freeform",
          context_window: 272000,
          max_context_window: 272000,
        },
        {
          slug: "anticodex/third-party",
          display_name: "第三方 API（当前模型）",
          visibility: "list",
          shell_type: "shell_command",
          apply_patch_tool_type: "freeform",
          context_window: 272000,
          max_context_window: 272000,
        },
      ],
    }), "utf8");

    const switched = hotSwitchCodexPlusPlusSettings({
      settingsPath,
      nativeCatalogPath: catalogPath,
      nativeCatalogModels: [
        "anticodex/third-party/gpt-5.6-sol",
        "anticodex/third-party",
      ],
      mode: "third-party",
      adapterPort: 18488,
      antigravityModel: "gemini-3-flash-agent",
      thirdParty: {
        protocol: "openai-compatible",
        baseUrl: "http://localhost:8080",
        model: "gpt-5.6-terra",
        apiKey: "saved-third-party-key",
        contextWindow: 128000,
        providerModels: ["gpt-5.6-terra"],
      },
    });

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const terra = catalog.models.find((entry) => entry.slug === "anticodex/third-party/gpt-5.6-terra");
    const sol = catalog.models.find((entry) => entry.slug === "anticodex/third-party/gpt-5.6-sol");
    const current = catalog.models.find((entry) => entry.slug === "anticodex/third-party");
    assert.equal(terra.display_name, "第三方 · gpt-5.6-terra");
    assert.equal(terra.visibility, "list");
    assert.equal(terra.shell_type, "shell_command");
    assert.equal(terra.apply_patch_tool_type, "freeform");
    assert.equal(terra.context_window, 128000);
    assert.equal(current.context_window, 128000);
    assert.equal(current.max_context_window, 128000);
    assert.equal(sol.visibility, "hide");
    assert.deepEqual(switched.nativeModel, {
      slug: "anticodex/third-party/gpt-5.6-terra",
      label: "第三方 · gpt-5.6-terra",
    });

    const settingsBeforeFailedSwitch = fs.readFileSync(settingsPath, "utf8");
    const catalogBeforeFailedSwitch = fs.readFileSync(catalogPath, "utf8");
    const renameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(catalogPath)) {
        throw new Error("catalog replace failed");
      }
      return renameSync(source, destination);
    };
    try {
      assert.throws(() => hotSwitchCodexPlusPlusSettings({
        settingsPath,
        nativeCatalogPath: catalogPath,
        mode: "third-party",
        adapterPort: 18488,
        antigravityModel: "gemini-3-flash-agent",
        thirdParty: {
          protocol: "openai-compatible",
          baseUrl: "http://localhost:8080",
          model: "gpt-5.6-alt",
          apiKey: "saved-third-party-key",
          contextWindow: 128000,
        },
      }), /catalog replace failed/);
    } finally {
      fs.renameSync = renameSync;
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(settingsPath, "utf8")),
      JSON.parse(settingsBeforeFailedSwitch),
    );
    assert.equal(fs.readFileSync(catalogPath, "utf8"), catalogBeforeFailedSwitch);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Static code assertions: no prohibited basenames or model/task control words in service source", () => {
  const servicePath = path.resolve(__dirname, "../../scripts/anticodex-manager-service.mjs");
  const code = fs.readFileSync(servicePath, "utf8");

  // Prohibited basenames (split to avoid matching this test file if it is scanned)
  const prohibitedBasenames = [
    "adaptive-" + "server.mjs",
    "serv" + "er.mjs",
    "antigravity-" + "upstream.mjs",
    "upstream-" + "provider.mjs",
    "compat-" + "rules.mjs",
    "codex-native-harness-" + "turn.mjs",
    "codex-native-" + "protocol.mjs",
    "codex-native-" + "sse.mjs",
    "codex-native-" + "compact.mjs",
    "response-" + "history.mjs",
    "reg" + "istry.mjs",
    "cache_stability_" + "diff.mjs",
  ];

  for (const name of prohibitedBasenames) {
    assert.ok(
      !code.includes(name),
      `Service source must not contain prohibited basename: ${name}`
    );
  }

  // Prohibited words (split to avoid matching this test file if it is scanned)
  const prohibitedPatterns = [
    "/" + "responses",
    "chat" + "/completions",
    "tool" + "-call",
    "tool" + "_call",
    "tool" + "Call",
    "task" + "-control",
    "task" + "_control",
    "task" + "Control",
  ];

  for (const pattern of prohibitedPatterns) {
    assert.ok(
      !code.includes(pattern),
      `Service source must not contain prohibited pattern/word: ${pattern}`
    );
  }

  assert.doesNotMatch(code, /SaveThirdParty[\s\S]{0,500}apiKey:\s*body\.apiKey/);
  assert.match(code, /runUpstreamProfileScript\("SaveThirdParty",\s*\{[\s\S]{0,500}\bapiKey,\s*\n\s*testStatus/);
});

test("local connector verifier recognizes the deliberate offline Manager health response", () => {
  const verifierPath = path.resolve(__dirname, "../../scripts/test-anticodex-local-connectors.mjs");
  const code = fs.readFileSync(verifierPath, "utf8");

  assert.match(code, /acceptedStatuses:\s*\[200, 503\]/);
  assert.match(code, /managerHealth\.schema,\s*"anticodex-manager-service-v1"/);
  assert.match(code, /managerHealth\.role,\s*"launcher-management-only"/);
  assert.doesNotMatch(code, /response\.ok\s*\|\|\s*response\.status\s*===\s*503/);
});

test("Anti-Codex Manager Service API contract and security suite", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-manager-test-"));

  // Create fixed-route status stub
  const statusPath = path.join(tempDir, "fixed-route-status.json");
  fs.writeFileSync(
    statusPath,
    JSON.stringify({
      ports: {
        proxy: 18485
      }
    }),
    "utf8"
  );

  // Reserve and release an ephemeral port so the offline-health case cannot
  // accidentally probe a real Anti-Codex route already running on this host.
  const offlineHealthServer = createServer();
  await listenOnLoopback(offlineHealthServer);
  const offlineHealthPort = offlineHealthServer.address().port;
  await new Promise((resolve, reject) => offlineHealthServer.close((error) => error ? reject(error) : resolve()));

  let modelRefreshCalls = 0;

  // Initialize service on port 0
  const service = createAntiCodexManagerService({
    port: 0,
    host: "127.0.0.1",
    stateRoot: tempDir,
    fixedHealthUrl: `http://127.0.0.1:${offlineHealthPort}/anticodex/fixed-route/health`,
    refreshModels: async () => {
      modelRefreshCalls += 1;
      return {
        ok: true,
        refreshed: true,
        source: "antigravity-cascade",
        modelCount: 2,
        models: ["gemini-3.1-pro-low", "claude-sonnet-4-6"],
      };
    },
  });

  const server = await service.listen();
  const address = server.address();
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let token = "";

  await t.test("GET /health identity verification", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.schema, "anticodex-manager-service-v1");
    assert.equal(body.ok, false);
    assert.equal(body.routeReady, false);
    assert.equal(body.role, "launcher-management-only");
    // Ensure it doesn't act as a model gateway
    assert.equal(body.choices, undefined);
    assert.equal(body.object, undefined);
  });

  await t.test("GET /health exposes a safe third-party profile summary", async () => {
    const healthServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        state: "ready",
        provider: "third-party",
        model: "gpt-5.6-terra",
        catalogModelCount: 1,
        route: { relayProtocol: "chatCompletions" },
      }));
    });
    await listenOnLoopback(healthServer);
    const manager = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot: tempDir,
      fixedHealthUrl: `http://127.0.0.1:${healthServer.address().port}/anticodex/fixed-route/health`,
    });
    const managerServer = await manager.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${managerServer.address().port}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.upstreamProfile, {
        mode: "third-party",
        protocol: "openai-compatible",
        model: "gpt-5.6-terra",
      });
      assert.equal(body.modelCount, 1);
    } finally {
      await manager.close();
      await closeServer(healthServer);
    }
  });

  await t.test("diagnostics report route facts and fail closed when the fixed route is offline", async () => {
    const originalStatus = fs.readFileSync(statusPath, "utf8");
    fs.writeFileSync(statusPath, JSON.stringify({
      ok: true,
      state: "ready",
      provider: "third-party",
      model: "stale-model",
      pid: 999999,
      readyAt: "2026-07-18T00:00:00.000Z",
      ports: { proxy: 18485 },
    }), "utf8");
    const offlineService = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot: tempDir,
      fixedHealthUrl: "http://127.0.0.1:1/anticodex/fixed-route/health",
    });
    const offlineServer = await offlineService.listen();
    const offlinePort = offlineServer.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${offlinePort}/anticodex/diagnostics`, {
        headers: { origin: `http://127.0.0.1:${offlinePort}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.health.ok, false);
      assert.equal(body.mode.upstreamMode, "offline");
      assert.deepEqual(body.models.active, []);
      assert.equal(body.lifecycle.state, "offline");
      assert.equal(body.accountTracking.state, "unavailable");
      assert.equal(body.accountTracking.identityAvailable, false);
      assert.equal(body.tools.owner, "codex-native-harness");
      assert.equal(body.tools.adapterExecutesTools, false);
      assert.equal(body.windowsUserSetupGuidanceEvidence, undefined);
      assert.doesNotMatch(JSON.stringify(body), /deepseek-v4-pro|antigravityCli|secondAccount/);
    } finally {
      await offlineService.close();
      fs.writeFileSync(statusPath, originalStatus, "utf8");
    }
  });

  await t.test("account and diagnostics proxy the fixed adapter's anonymized identity", async () => {
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const adapterServer = createServer((req, res) => {
      if (req.url !== "/v1/account") {
        res.writeHead(404).end();
        return;
      }
      const payload = JSON.stringify({
        object: "antigravity.account",
        provider: "antigravity",
        signedIn: true,
        identityAvailable: true,
        fingerprint,
        planName: "Pro",
        tierName: "",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
    await listenOnLoopback(adapterServer);
    const adapterPort = adapterServer.address().port;
    const healthServer = createServer((_req, res) => {
      const payload = JSON.stringify({
        ok: true,
        state: "ready",
        provider: "antigravity",
        model: "claude-sonnet-4-6",
        pid: 1234,
        readyAt: "2026-07-16T00:00:00.000Z",
        ports: { adapter: adapterPort },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
    await listenOnLoopback(healthServer);
    const healthPort = healthServer.address().port;
    const accountService = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot: tempDir,
      fixedHealthUrl: `http://127.0.0.1:${healthPort}/anticodex/fixed-route/health`,
    });
    const accountManagerServer = await accountService.listen();
    const accountBaseUrl = `http://127.0.0.1:${accountManagerServer.address().port}`;
    try {
      const accountResponse = await fetch(`${accountBaseUrl}/anticodex/account`);
      assert.equal(accountResponse.status, 200);
      const account = await accountResponse.json();
      assert.equal(account.signedIn, true);
      assert.equal(account.identityAvailable, true);
      assert.equal(account.fingerprint, fingerprint);
      assert.equal(account.planName, "Pro");

      const diagnosticsResponse = await fetch(`${accountBaseUrl}/anticodex/diagnostics`);
      assert.equal(diagnosticsResponse.status, 200);
      const diagnostics = await diagnosticsResponse.json();
      assert.equal(diagnostics.accountTracking.state, "ready");
      assert.equal(diagnostics.accountTracking.fingerprint, fingerprint);
      assert.equal(diagnostics.accountTracking.identityAvailable, true);
    } finally {
      await accountService.close();
      await closeServer(healthServer);
      await closeServer(adapterServer);
    }
  });

  await t.test("GET /anticodex/manager/bootstrap returns token and actions", async () => {
    // Should fail without Origin/Referer
    const failRes = await fetch(`${baseUrl}/anticodex/manager/bootstrap`);
    assert.equal(failRes.status, 403);

    // Should succeed with valid Origin
    const res = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, {
      headers: {
        origin: baseUrl
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.token);
    assert.equal(body.baseUrl, `${baseUrl}`);
    assert.ok(body.actions);
    assert.ok(body.actions.accountSwitch);
    assert.equal(body.actions.updateCheck.label, "检查全部更新");
    assert.equal(body.actions.syncHost.label, "一键更新");
    assert.deepEqual(Object.keys(body.actions).sort(), [
      "accountProxy",
      "accountSwitch",
      "coldRelaunch",
      "diagnosticsBundle",
      "fastOverallNoTraffic",
      "mcpSkills",
      "overallNoTraffic",
      "pluginCapabilities",
      "postVerificationFull",
      "refreshFeatures",
      "refreshModels",
      "refreshStatus",
      "repairShortcuts",
      "sourcePreflight",
      "stabilitySoak",
      "syncHost",
      "syncReadiness",
      "updateCheck",
      "upstreamConfig",
      "viewLatestReports"
    ].sort());

    token = body.token;
  });

  await t.test("Antigravity model catalog and selection are exposed through the profile API", async () => {
    const catalogDir = path.join(tempDir, "codex-home-deepseek-app");
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(path.join(catalogDir, "antigravity-model-catalog.json"), JSON.stringify({
      models: [
        { slug: "gemini-3-flash-agent", display_name: "Gemini 3.5 Flash (High)" },
        { slug: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6 (Thinking)" },
        { slug: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", visibility: "hide" },
      ],
    }), "utf8");

    const componentStateDir = path.join(tempDir, "codexplusplus");
    fs.mkdirSync(componentStateDir, { recursive: true });
    fs.writeFileSync(path.join(componentStateDir, "settings.json"), JSON.stringify({
      relayProfiles: [{
        id: "anticodex-antigravity",
        name: "Anti-Codex Antigravity",
        upstreamBaseUrl: "http://127.0.0.1:18488/v1",
        protocol: "chatCompletions",
        relayMode: "pureApi",
        apiKey: "test-local-adapter-token",
        testModel: "gemini-3-flash-agent",
        modelList: "gemini-3-flash-agent\nclaude-sonnet-4-6",
      }],
      activeRelayId: "anticodex-antigravity",
      relayTestModel: "gemini-3-flash-agent",
    }), "utf8");

    const healthServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        state: "ready",
        provider: "antigravity",
        model: "gemini-3-flash-agent",
        ports: { adapter: 18488 },
      }));
    });
    await listenOnLoopback(healthServer);
    const selectionService = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot: tempDir,
      fixedHealthUrl: `http://127.0.0.1:${healthServer.address().port}/anticodex/fixed-route/health`,
      ensureAntigravityReady: async () => ({ signedIn: true, identityAvailable: true }),
    });
    const selectionServer = await selectionService.listen();
    const selectionBaseUrl = `http://127.0.0.1:${selectionServer.address().port}`;
    try {
      const bootstrapResponse = await fetch(`${selectionBaseUrl}/anticodex/manager/bootstrap`, {
        headers: { origin: selectionBaseUrl },
      });
      assert.equal(bootstrapResponse.status, 200);
      const selectionToken = (await bootstrapResponse.json()).token;

      const beforeResponse = await fetch(`${selectionBaseUrl}/anticodex/upstream-profile`);
      assert.equal(beforeResponse.status, 200);
      const before = await beforeResponse.json();
      const antigravityModelIds = before.antigravityModels.map((entry) => entry.id);
      assert.ok(antigravityModelIds.includes("gemini-3-flash-agent"));
      assert.ok(antigravityModelIds.includes("claude-sonnet-4-6"));
      assert.equal(antigravityModelIds.includes("claude-sonnet-4-5"), false);

      const saveResponse = await fetch(`${selectionBaseUrl}/anticodex/upstream-profile`, {
        method: "POST",
        headers: {
          origin: selectionBaseUrl,
          "content-type": "application/json",
          "x-anticodex-manager-token": selectionToken,
        },
        body: JSON.stringify({ mode: "antigravity", antigravityModel: "claude-sonnet-4-6" }),
      });
      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json();
      assert.equal(saved.saved.antigravityModel, "claude-sonnet-4-6");
      assert.equal(saved.accountReady, true);
      assert.equal(saved.restartRequired, false);
      assert.equal(saved.hotSwitch, true);
      const switchedSettings = JSON.parse(fs.readFileSync(path.join(componentStateDir, "settings.json"), "utf8"));
      const switchedAntigravity = switchedSettings.relayProfiles.find((entry) => entry.id === "anticodex-antigravity");
      assert.equal(switchedAntigravity.apiKey, "test-local-adapter-token");
    } finally {
      await selectionService.close();
      await closeServer(healthServer);
    }
  });

  await t.test("Antigravity hot switch fails before saving when Desktop is not ready", async () => {
    const settingsPath = path.join(tempDir, "codexplusplus", "settings.json");
    const settingsBefore = fs.readFileSync(settingsPath, "utf8");
    const healthServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        state: "ready",
        provider: "third-party",
        model: "gpt-5.6-sol",
        ports: { adapter: 18488 },
      }));
    });
    await listenOnLoopback(healthServer);
    const blockedService = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot: tempDir,
      fixedHealthUrl: `http://127.0.0.1:${healthServer.address().port}/anticodex/fixed-route/health`,
      ensureAntigravityReady: async () => { throw new Error("Desktop not ready"); },
    });
    const blockedServer = await blockedService.listen();
    const blockedBaseUrl = `http://127.0.0.1:${blockedServer.address().port}`;
    try {
      const boot = await fetch(`${blockedBaseUrl}/anticodex/manager/bootstrap`, {
        headers: { origin: blockedBaseUrl },
      });
      const blockedToken = (await boot.json()).token;
      const response = await fetch(`${blockedBaseUrl}/anticodex/upstream-profile`, {
        method: "POST",
        headers: {
          origin: blockedBaseUrl,
          "content-type": "application/json",
          "x-anticodex-manager-token": blockedToken,
        },
        body: JSON.stringify({ mode: "antigravity", antigravityModel: "claude-sonnet-4-6" }),
      });
      const payload = await response.json();
      assert.equal(response.status, 400, payload.message);
      assert.match(payload.message, /Desktop not ready/);
      assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsBefore);
    } finally {
      await blockedService.close();
      await closeServer(healthServer);
    }
  });

  await t.test("service instances issue independent action tokens", async () => {
    const secondService = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot: tempDir,
      fixedHealthUrl: "http://127.0.0.1:18487/anticodex/fixed-route/health"
    });
    const secondServer = await secondService.listen();
    try {
      const secondAddress = secondServer.address();
      const secondBaseUrl = `http://127.0.0.1:${secondAddress.port}`;
      const response = await fetch(`${secondBaseUrl}/anticodex/manager/bootstrap`, {
        headers: { origin: secondBaseUrl }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.token);
      assert.notEqual(body.token, token);
    } finally {
      await secondService.close();
    }
  });

  await t.test("trusted browser preflight is explicit and bounded", async () => {
    const response = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "OPTIONS",
      headers: {
        origin: "app://-",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-anticodex-manager-token"
      }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "app://-");
    assert.match(response.headers.get("access-control-allow-methods") || "", /POST/);
    assert.match(response.headers.get("access-control-allow-headers") || "", /x-anticodex-manager-token/i);
  });

  await t.test("Origin and Referer loopback validation checks", async () => {
    // Malicious Origin
    const res1 = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, {
      headers: {
        origin: "http://malicious.com"
      }
    });
    assert.equal(res1.status, 403);

    // Malicious Referer
    const res2 = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, {
      headers: {
        referer: "http://malicious.com/page"
      }
    });
    assert.equal(res2.status, 403);

    // Arbitrary app: origins are not the copied client.
    const res3 = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, {
      headers: {
        origin: "app://local-codex"
      }
    });
    assert.equal(res3.status, 403);

    // The copied client has the exact app://- origin.
    const res4 = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, {
      headers: { origin: "app://-" }
    });
    assert.equal(res4.status, 200);

    // A different loopback port cannot claim a Manager action token.
    const res5 = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, {
      headers: { origin: "http://127.0.0.1:65534" }
    });
    assert.equal(res5.status, 403);
  });

  await t.test("loopback diagnostics can read the static Manager page without browser headers", async () => {
    const response = await fetch(`${baseUrl}/anticodex/manager`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    const html = await response.text();
    assert.match(html, /<title>Anti-Codex \u7ba1\u7406<\/title>/);
    assert.match(html, /<h1>Anti-Codex \u7ba1\u7406<\/h1>/);
    assert.match(html, /data-action-group="daily"/);
    assert.match(html, /data-action-group="high-impact"/);
    assert.match(html, /confirmHighImpactAction/);
    assert.doesNotMatch(html, /Gate 7|Anti-Codex Manager/);
    assert.doesNotMatch(html, /resetAntigravitySessionLock|secondAccountLoginStatus/);
  });

  await t.test("POST /anticodex/manager/action security and virtual behavior", async () => {
    // Missing token
    const res1 = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        origin: baseUrl
      },
      body: JSON.stringify({ action: "refreshStatus" })
    });
    assert.equal(res1.status, 403);

    // Invalid token
    const res2 = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        origin: baseUrl,
        "x-anticodex-manager-token": "bad-token"
      },
      body: JSON.stringify({ action: "refreshStatus" })
    });
    assert.equal(res2.status, 403);

    // Valid token & virtual action
    const res3 = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        origin: baseUrl,
        "x-anticodex-manager-token": token
      },
      body: JSON.stringify({ action: "refreshStatus" })
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.ok, true);
    assert.equal(body3.action, "refreshStatus");
    assert.deepEqual(body3.result, { ok: true });

    const refreshResponse = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        origin: baseUrl,
        "x-anticodex-manager-token": token,
      },
      body: JSON.stringify({ action: "refreshModels" }),
    });
    assert.equal(refreshResponse.status, 200);
    const refreshBody = await refreshResponse.json();
    assert.equal(refreshBody.ok, true);
    assert.equal(refreshBody.action, "refreshModels");
    assert.equal(refreshBody.result.refreshed, true);
    assert.equal(refreshBody.result.modelCount, 2);
    assert.equal(modelRefreshCalls, 1);
  });

  await t.test("viewLatestReports returns a summarized report payload", async () => {
    const reportsDir = path.join(tempDir, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, "latest-source-preflight.json"), JSON.stringify({
      ok: true,
      elapsedMs: 123,
      generatedAt: new Date().toISOString(),
      apiKey: "must-not-leak",
    }), "utf8");

    const response = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "x-anticodex-manager-token": token,
      },
      body: JSON.stringify({ action: "viewLatestReports" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.action, "viewLatestReports");
    assert.equal(body.result.reportRoot, reportsDir);
    assert.ok(Array.isArray(body.result.reports));
    assert.equal(body.result.existingCount, 1);

    const report = body.result.reports.find((item) => item.fileName === "latest-source-preflight.json");
    assert.equal(report.exists, true);
    assert.equal(report.parseable, true);
    assert.equal(report.invalid, false);
    assert.equal(report.ok, true);
    assert.equal(report.effectiveOk, true);
    assert.equal(report.elapsedMs, 123);
    assert.equal(report.value, undefined);
    assert.equal(report.apiKey, undefined);
  });

  await t.test("GET /anticodex/manager/action-script JSONP compatibility", async () => {
    // Missing/invalid token
    const res1 = await fetch(`${baseUrl}/anticodex/manager/action-script?callback=onSuccess&action=refreshStatus&token=bad`);
    assert.equal(res1.status, 403);

    // Invalid callback
    const res2 = await fetch(`${baseUrl}/anticodex/manager/action-script?callback=invalid-cb&action=refreshStatus&token=${token}`, {
      headers: { origin: baseUrl }
    });
    assert.equal(res2.status, 400);

    // Valid JSONP call
    const res3 = await fetch(`${baseUrl}/anticodex/manager/action-script?callback=onSuccess&action=refreshStatus&token=${token}`, {
      headers: { origin: baseUrl }
    });
    assert.equal(res3.status, 200);
    const text = await res3.text();
    assert.ok(text.startsWith(";try{globalThis[\"onSuccess\"]"));
    assert.ok(text.includes('"ok":true'));
  });

  await t.test("POST /anticodex/manager/action invalid action returns 404", async () => {
    const res = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        origin: baseUrl,
        "x-anticodex-manager-token": token
      },
      body: JSON.stringify({ action: "invalid_action_name" })
    });
    assert.equal(res.status, 404);
  });

  await t.test("Lightweight compatibility read-only endpoints", async () => {
    const endpoints = [
      "/anticodex/diagnostics",
      "/anticodex/model-routes",
      "/backend-api/ps/plugins/installed",
      "/backend-api/aip/connectors",
      "/backend-api/plugins/list",
      "/backend-api/wham/apps",
      "/anticodex/local-connectors/allowlist"
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`, {
        headers: { origin: baseUrl }
      });
      assert.equal(res.status, 200, `Endpoint ${ep} must return 200`);
      const body = await res.json();
      assert.ok(body, `Endpoint ${ep} must return a truthy JSON payload`);
    }
  });

  await t.test("Port release when close() is called", async () => {
    await service.close();

    // Attempt to connect to check if it's closed
    await assert.rejects(
      fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) }),
      /fetch failed|TimeoutError|ECONNREFUSED/i
    );
  });

  // Cleanup temp dir
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
