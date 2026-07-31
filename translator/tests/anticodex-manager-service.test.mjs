import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createAntiCodexManagerService,
  saveThirdPartyCodexPlusPlusSettings,
} from "../../scripts/anticodex-manager-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createSaveOnlyFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-save-only-"));
  const settingsPath = path.join(tempDir, "settings.json");
  const catalogPath = path.join(tempDir, "anticodex-model-catalog.json");
  const codexConfigPath = path.join(tempDir, "config.toml");
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    relayProfiles: [
      {
        id: "anticodex-antigravity",
        apiKey: "local-adapter-key",
        testModel: "gemini-3.1-pro-low",
        modelList: "anticodex/antigravity\ngemini-3.1-pro-low\nclaude-sonnet-4-6",
      },
      {
        id: "anticodex-third-party",
        apiKey: "saved-third-party-key",
        testModel: "gpt-5.5",
        contextWindow: "272000",
        modelList: "anticodex/third-party\nanticodex/third-party/gpt-5.5",
      },
    ],
    activeRelayId: "anticodex-antigravity",
    relayTestModel: "gemini-3.1-pro-low",
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(catalogPath, `${JSON.stringify({
    models: [
      {
        slug: "gemini-3.1-pro-low",
        display_name: "Gemini 3.1 Pro (Low)",
        visibility: "list",
        shell_type: "shell_command",
        apply_patch_tool_type: "freeform",
        context_window: 1_000_000,
        max_context_window: 1_000_000,
      },
      {
        slug: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        visibility: "list",
        shell_type: "shell_command",
        apply_patch_tool_type: "freeform",
        context_window: 200_000,
        max_context_window: 200_000,
      },
      {
        slug: "anticodex/third-party/gpt-5.5",
        display_name: "第三方 · gpt-5.5",
        visibility: "list",
        shell_type: "shell_command",
        apply_patch_tool_type: "freeform",
        context_window: 272_000,
        max_context_window: 272_000,
      },
      {
        slug: "anticodex/third-party",
        display_name: "第三方 API（当前模型）",
        visibility: "list",
        shell_type: "shell_command",
        apply_patch_tool_type: "freeform",
        context_window: 272_000,
        max_context_window: 272_000,
      },
    ],
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(codexConfigPath, `model = "gemini-3.1-pro-low"
model_provider = "anticodex_antigravity"
model_context_window = 777777
model_auto_compact_token_limit = 666666
model_auto_compact_token_limit_scope = "body_after_prefix"
some_root_setting = "preserved"

[model_providers.anticodex_antigravity]
wire_api = "responses"
`, "utf8");
  return { tempDir, settingsPath, catalogPath, codexConfigPath };
}

function saveThirdPartyOptions(fixture, model = "gpt-5.6-terra") {
  return {
    settingsPath: fixture.settingsPath,
    nativeCatalogPath: fixture.catalogPath,
    codexConfigPath: fixture.codexConfigPath,
    thirdParty: {
      protocol: "openai-compatible",
      baseUrl: "http://localhost:8080",
      model,
      apiKey: "new-third-party-key",
      contextWindow: 128_000,
      providerModels: ["gpt-5.6-terra", "gpt-5.6-sol"],
    },
  };
}

test("saving third-party settings updates the unified catalog without switching the active model", () => {
  const fixture = createSaveOnlyFixture();
  try {
    const configBefore = fs.readFileSync(fixture.codexConfigPath);
    const result = saveThirdPartyCodexPlusPlusSettings(saveThirdPartyOptions(fixture));
    const settings = JSON.parse(fs.readFileSync(fixture.settingsPath, "utf8"));
    const catalog = JSON.parse(fs.readFileSync(fixture.catalogPath, "utf8"));
    const terra = catalog.models.find((entry) => entry.slug === "anticodex/third-party/gpt-5.6-terra");
    const sol = catalog.models.find((entry) => entry.slug === "anticodex/third-party/gpt-5.6-sol");
    const thirdPartyProfile = settings.relayProfiles.find((entry) => entry.id === "anticodex-third-party");

    assert.equal(result.ok, true);
    assert.equal(result.saved, true);
    assert.equal(settings.activeRelayId, "anticodex-antigravity");
    assert.equal(settings.relayTestModel, "gemini-3.1-pro-low");
    assert.equal(thirdPartyProfile.testModel, "gpt-5.6-terra");
    assert.match(thirdPartyProfile.modelList, /anticodex\/third-party\/gpt-5\.6-terra/);
    assert.match(thirdPartyProfile.modelList, /anticodex\/third-party\/gpt-5\.6-sol/);
    assert.equal(terra.display_name, "第三方 · gpt-5.6-terra");
    assert.equal(terra.visibility, "list");
    assert.equal(terra.context_window, 128_000);
    assert.equal(terra.max_context_window, 128_000);
    assert.equal(sol.visibility, "list");
    assert.equal(sol.context_window, 128_000);
    assert.equal(sol.max_context_window, 128_000);
    assert.ok(catalog.models.some((entry) => entry.slug === "gemini-3.1-pro-low"));
    assert.ok(catalog.models.some((entry) => entry.slug === "claude-sonnet-4-6"));
    assert.deepEqual(fs.readFileSync(fixture.codexConfigPath), configBefore);
    for (const field of ["nativeConfigReload", "nativeModel", "hotSwitch", "restartRequired", "switchRollbackId"]) {
      assert.equal(Object.hasOwn(result, field), false, `${field} must not be returned by a save-only operation`);
    }
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("a catalog write failure restores settings and catalog bytes without touching root config", () => {
  const fixture = createSaveOnlyFixture();
  try {
    const settingsBefore = fs.readFileSync(fixture.settingsPath);
    const catalogBefore = fs.readFileSync(fixture.catalogPath);
    const configBefore = fs.readFileSync(fixture.codexConfigPath);
    const renameSync = fs.renameSync;
    let settingsWriteCompleted = false;
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(fixture.catalogPath)) {
        assert.equal(settingsWriteCompleted, true);
        throw new Error("catalog replace failed");
      }
      const result = renameSync(source, destination);
      if (path.resolve(destination) === path.resolve(fixture.settingsPath)) settingsWriteCompleted = true;
      return result;
    };
    try {
      assert.throws(
        () => saveThirdPartyCodexPlusPlusSettings(saveThirdPartyOptions(fixture, "gpt-5.6-sol")),
        /catalog replace failed/,
      );
    } finally {
      fs.renameSync = renameSync;
    }
    assert.deepEqual(fs.readFileSync(fixture.settingsPath), settingsBefore);
    assert.deepEqual(fs.readFileSync(fixture.catalogPath), catalogBefore);
    assert.deepEqual(fs.readFileSync(fixture.codexConfigPath), configBefore);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
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

test("Manager accepts dot-prefixed isolated homes but rejects custom instructions outside its state root", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-manager-home-boundary-"));
  try {
    assert.doesNotThrow(() => createAntiCodexManagerService({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      codexHome: path.join(stateRoot, "..custom-home"),
    }));
    assert.throws(() => createAntiCodexManagerService({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      codexHome: path.resolve(stateRoot, "..", "outside-home"),
    }), /inside the isolated state root/i);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("snapshot freshness is fail-closed until an explicit source check proves the marker", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-snapshot-status-"));
  const codexHome = path.join(stateRoot, "codex-home-deepseek-app");
  const sharedHome = path.join(stateRoot, "shared-codex");
  const agentsSkills = path.join(stateRoot, "agents-skills");
  const sharedSkill = path.join(sharedHome, "skills", "shared-demo");
  const agentSkill = path.join(agentsSkills, "agent-demo");
  const connectorFile = path.join(sharedHome, "cache", "codex_app_directory", "connectors.json");
  const appToolsFile = path.join(sharedHome, "cache", "codex_apps_tools", "tools.json");
  const syncScript = path.resolve(__dirname, "../../scripts/sync-shared-codex-plugin-host.mjs");
  let manager = null;

  try {
    for (const directory of [
      sharedSkill,
      agentSkill,
      path.dirname(connectorFile),
      path.dirname(appToolsFile),
    ]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(sharedSkill, "SKILL.md"), "---\nname: shared-demo\ndescription: test\n---\n", "utf8");
    fs.writeFileSync(path.join(agentSkill, "SKILL.md"), "---\nname: agent-demo\ndescription: test\n---\n", "utf8");
    for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
      fs.writeFileSync(path.join(sharedHome, name), `${name}\n`, "utf8");
    }
    fs.writeFileSync(connectorFile, '{"connectors":["one"]}\n', "utf8");
    fs.writeFileSync(appToolsFile, '{"tools":["one"]}\n', "utf8");

    const sync = spawnSync(process.execPath, [syncScript, codexHome, sharedHome, "--startup-snapshots"], {
      encoding: "utf8",
      env: { ...process.env, ANTICODEX_EXTRA_SKILLS_ROOTS: agentsSkills },
    });
    assert.equal(sync.status, 0, sync.stderr || sync.stdout);

    manager = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot,
      fixedHealthUrl: "http://127.0.0.1:1/anticodex/fixed-route/health",
    });
    const server = await manager.listen();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const readStatus = async (verify = false) => {
      const response = await fetch(`${baseUrl}/anticodex/diagnostics${verify ? "?snapshotFreshness=refresh" : ""}`);
      assert.equal(response.status, 200);
      return (await response.json()).localFeatures.snapshotStatus;
    };

    const initial = await readStatus();
    assert.equal(initial.state, "unverified");
    assert.equal(initial.stale, true);
    assert.equal(initial.staleReason, "unverified");
    const verified = await readStatus(true);
    assert.equal(verified.state, "fresh");
    assert.equal(verified.stale, false);
    assert.equal(verified.sourceFingerprintMatches, true);

    const originalConnector = fs.readFileSync(connectorFile, "utf8");
    fs.writeFileSync(connectorFile, originalConnector, "utf8");
    assert.equal((await readStatus(true)).state, "fresh");

    fs.writeFileSync(connectorFile, '{"connectors":["two"]}\n', "utf8");
    const changed = await readStatus(true);
    assert.equal(changed.state, "stale");
    assert.equal(changed.stale, true);
    assert.equal(changed.staleReason, "source_changed");
    assert.equal(changed.sourceFingerprintMatches, false);

    const markerPath = path.join(codexHome, ".anticodex-startup-snapshots-ready.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    fs.writeFileSync(markerPath, JSON.stringify({
      ...marker,
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }), "utf8");
    const aged = await readStatus();
    assert.equal(aged.state, "stale");
    assert.equal(aged.stale, true);
    assert.equal(aged.staleReason, "age");

    fs.writeFileSync(markerPath, JSON.stringify({ ...marker, schema: "wrong-schema" }), "utf8");
    const invalid = await readStatus();
    assert.equal(invalid.state, "invalid");
    assert.equal(invalid.stale, true);
    assert.equal(invalid.staleReason, "invalid_marker");
  } finally {
    if (manager) await manager.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
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
      "viewLatestReports"
    ].sort());

    token = body.token;
  });

  await t.test("prompt policy is isolated, authenticated, and restorable", async () => {
    const codexHome = path.join(tempDir, "codex-home-deepseek-app");
    const agentsPath = path.join(codexHome, "AGENTS.md");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(agentsPath, "initial local instructions", "utf8");
    const denied = await fetch(`${baseUrl}/anticodex/prompt-policy`);
    assert.equal(denied.status, 403);

    const initialResponse = await fetch(`${baseUrl}/anticodex/prompt-policy`, { headers: { origin: baseUrl } });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.policy.codexSystem.enabled, true);
    assert.equal(initial.providerBase.exposed, false);
    assert.equal(initial.nativeCustomInstructions.content, "initial local instructions");
    assert.equal(initial.nativeCustomInstructions.enabled, true);

    const invalidToken = await fetch(`${baseUrl}/anticodex/prompt-policy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "x-anticodex-manager-token": "bad" },
      body: JSON.stringify(initial.defaults),
    });
    assert.equal(invalidToken.status, 403);

    const changed = {
      ...initial.defaults,
      codexDeveloper: { enabled: true, content: "local override" },
      nativeCustomInstructions: { content: "edited local instructions" },
    };
    const saveResponse = await fetch(`${baseUrl}/anticodex/prompt-policy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "x-anticodex-manager-token": token },
      body: JSON.stringify(changed),
    });
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();
    assert.equal(saved.policy.codexDeveloper.content, "local override");
    assert.equal(saved.nativeCustomInstructions.content, "edited local instructions");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), "edited local instructions");

    const legacySaveResponse = await fetch(`${baseUrl}/anticodex/prompt-policy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "x-anticodex-manager-token": token },
      body: JSON.stringify({ ...initial.defaults, codexSystem: { enabled: false, content: null } }),
    });
    assert.equal(legacySaveResponse.status, 200);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), "edited local instructions");

    const restoreResponse = await fetch(`${baseUrl}/anticodex/prompt-policy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "x-anticodex-manager-token": token },
      body: JSON.stringify({ ...initial.defaults, nativeCustomInstructions: { content: "" } }),
    });
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json();
    assert.equal(restored.policy.codexDeveloper.content, null);
    assert.equal(restored.nativeCustomInstructions.enabled, false);
    assert.equal(fs.existsSync(agentsPath), false);
  });

  await t.test("upstream test falls back from an undersized caller timeout without aborting the local probe", async () => {
    const providerServer = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      }, 25);
    });
    await listenOnLoopback(providerServer);
    try {
      const response = await fetch(`${baseUrl}/anticodex/upstream-test`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: baseUrl,
          "x-anticodex-manager-token": token,
        },
        body: JSON.stringify({
          protocol: "openai-compatible",
          baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`,
          apiKey: "local-test-key",
          model: "gpt-local",
          timeoutMs: 1,
        }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    } finally {
      await closeServer(providerServer);
    }
  });

  await t.test("profile save reuses one fresh successful probe and never sends a duplicate provider request", async () => {
    const fixture = createSaveOnlyFixture();
    const settingsPath = path.join(tempDir, "codexplusplus", "settings.json");
    const catalogPath = path.join(tempDir, "codex-home-deepseek-app", "anticodex-model-catalog.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.copyFileSync(fixture.settingsPath, settingsPath);
    fs.copyFileSync(fixture.catalogPath, catalogPath);

    let providerRequests = 0;
    const providerServer = createServer((_req, res) => {
      providerRequests += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      }, 25);
    });
    await listenOnLoopback(providerServer);
    const profileBody = {
      mode: "third-party",
      protocol: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`,
      apiKey: "local-test-key",
      model: "gpt-local",
      contextWindow: 128_000,
      capabilities: { secretNote: "must-not-persist" },
    };
    const saveProfile = (body) => fetch(`${baseUrl}/anticodex/upstream-profile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "x-anticodex-manager-token": token,
      },
      body: JSON.stringify(body),
    });
    const testProfile = (body) => fetch(`${baseUrl}/anticodex/upstream-test`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "x-anticodex-manager-token": token,
      },
      body: JSON.stringify(body),
    });
    try {
      const untested = await saveProfile(profileBody);
      assert.equal(untested.status, 400);
      assert.equal(providerRequests, 0);

      const tested = await testProfile(profileBody);
      assert.equal(tested.status, 200);
      assert.equal((await tested.json()).ok, true);
      assert.equal(providerRequests, 1);

      const response = await saveProfile(profileBody);
      assert.equal(response.status, 200);
      assert.equal(providerRequests, 1);
      assert.doesNotMatch(await response.text(), /secretNote|must-not-persist/);
      const repeatedSave = await saveProfile(profileBody);
      assert.equal(repeatedSave.status, 400);
      assert.equal(providerRequests, 1);

      const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, "upstream-profile.json"), "utf8"));
      assert.deepEqual(Object.keys(persisted.capabilities).sort(), ["connectionStages", "providerModels"]);
      assert.equal(persisted.capabilities.secretNote, undefined);

      const publicResponse = await fetch(`${baseUrl}/anticodex/upstream-profile`);
      assert.equal(publicResponse.status, 200);
      assert.doesNotMatch(await publicResponse.text(), /secretNote|must-not-persist/);

      const boundedTest = await testProfile({ ...profileBody, capabilities: {}, timeoutMs: 1 });
      assert.equal((await boundedTest.json()).ok, true);
      const changedAfterTest = await saveProfile({ ...profileBody, contextWindow: 256_000 });
      assert.equal(changedAfterTest.status, 400);
      assert.equal(providerRequests, 2);
      const retested = await testProfile({ ...profileBody, capabilities: {}, timeoutMs: 1 });
      assert.equal((await retested.json()).ok, true);
      const boundedResponse = await saveProfile({ ...profileBody, capabilities: {}, timeoutMs: 1 });
      assert.equal(boundedResponse.status, 200);
      assert.equal(providerRequests, 3);
    } finally {
      await closeServer(providerServer);
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  await t.test("Antigravity models remain exposed through the profile API", async () => {
    const catalogDir = path.join(tempDir, "codex-home-deepseek-app");
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(path.join(catalogDir, "antigravity-model-catalog.json"), JSON.stringify({
      models: [
        { slug: "gemini-3-flash-agent", display_name: "Gemini 3.5 Flash (High)" },
        { slug: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6 (Thinking)" },
        { slug: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", visibility: "hide" },
      ],
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
    const catalogService = createAntiCodexManagerService({
      port: 0,
      host: "127.0.0.1",
      stateRoot: tempDir,
      fixedHealthUrl: `http://127.0.0.1:${healthServer.address().port}/anticodex/fixed-route/health`,
    });
    const catalogServer = await catalogService.listen();
    const catalogBaseUrl = `http://127.0.0.1:${catalogServer.address().port}`;
    try {
      const beforeResponse = await fetch(`${catalogBaseUrl}/anticodex/upstream-profile`);
      assert.equal(beforeResponse.status, 200);
      const before = await beforeResponse.json();
      const antigravityModelIds = before.antigravityModels.map((entry) => entry.id);
      assert.ok(antigravityModelIds.includes("gemini-3-flash-agent"));
      assert.ok(antigravityModelIds.includes("claude-sonnet-4-6"));
      assert.equal(antigravityModelIds.includes("claude-sonnet-4-5"), false);
    } finally {
      await catalogService.close();
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
    for (const group of ["status", "modelSources", "updates", "troubleshooting"]) {
      assert.match(html, new RegExp(`<section data-action-group="${group}">`));
    }
    assert.match(html, /<details(?![^>]*\sopen(?:\s|=|>))[^>]*data-action-group="advanced"[^>]*>\s*<summary>高级诊断<\/summary>/);
    assert.match(html, /confirmHighImpactAction/);
    assert.doesNotMatch(html, /data-manager-action="upstreamConfig"/);
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
    const completedAt = new Date().toISOString();
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, "latest-source-preflight.json"), JSON.stringify({
      ok: true,
      elapsedMs: 123,
      generatedAt: completedAt,
      apiKey: "must-not-leak",
    }), "utf8");
    fs.writeFileSync(path.join(reportsDir, "latest-post-verification.json"), JSON.stringify({
      ok: false,
      state: "completed",
      completedAt,
      failures: ["visible acceptance failed"],
    }), "utf8");
    fs.writeFileSync(path.join(tempDir, "update-status.json"), JSON.stringify({
      ok: true,
      operation: {
        state: "succeeded",
        completedAt,
        message: "sync completed",
      },
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
    assert.equal(body.result.existingCount, 2);

    const report = body.result.reports.find((item) => item.fileName === "latest-source-preflight.json");
    assert.equal(report.exists, true);
    assert.equal(report.parseable, true);
    assert.equal(report.invalid, false);
    assert.equal(report.ok, true);
    assert.equal(report.effectiveOk, true);
    assert.equal(report.elapsedMs, 123);
    assert.equal(report.reportedAt, completedAt);
    assert.equal(report.value, undefined);
    assert.equal(report.apiKey, undefined);

    const postVerification = body.result.reports.find((item) => item.fileName === "latest-post-verification.json");
    assert.equal(postVerification.exists, true);
    assert.equal(postVerification.ok, false);
    assert.equal(postVerification.firstFailure, "visible acceptance failed");
    assert.equal(postVerification.reportedAt, completedAt);

    const diagnosticsResponse = await fetch(`${baseUrl}/anticodex/diagnostics`);
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.managerActionResults.postVerificationFull.ok, false);
    assert.equal(diagnostics.managerActionResults.postVerificationFull.firstFailure, "visible acceptance failed");
    assert.equal(diagnostics.managerActionResults.postVerificationFull.reportedAt, completedAt);
    assert.equal(diagnostics.managerActionResults.syncHost.ok, true);
    assert.equal(diagnostics.managerActionResults.syncHost.state, "succeeded");
    assert.equal(diagnostics.managerActionResults.syncHost.reportedAt, completedAt);
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
