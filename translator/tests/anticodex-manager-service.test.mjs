import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createAntiCodexManagerService } from "../../scripts/anticodex-manager-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // Initialize service on port 0
  const service = createAntiCodexManagerService({
    port: 0,
    host: "127.0.0.1",
    stateRoot: tempDir,
    fixedHealthUrl: "http://127.0.0.1:18487/anticodex/fixed-route/health"
  });

  const server = await service.listen();
  const address = server.address();
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let token = "";

  await t.test("GET /health identity verification", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema, "anticodex-manager-service-v1");
    assert.equal(body.ok, true);
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
        headers: { origin: "http://127.0.0.1:8484" },
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
        origin: "http://127.0.0.1:8484"
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
      assert.equal(saved.restartRequired, false);
      assert.equal(saved.hotSwitch, true);
    } finally {
      await selectionService.close();
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
        origin: "app://local-codex",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-anticodex-manager-token"
      }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "app://local-codex");
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

    // Allowed app: protocol Origin
    const res3 = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, {
      headers: {
        origin: "app://local-codex"
      }
    });
    assert.equal(res3.status, 200);
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
        origin: "http://127.0.0.1:8484"
      },
      body: JSON.stringify({ action: "refreshStatus" })
    });
    assert.equal(res1.status, 403);

    // Invalid token
    const res2 = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:8484",
        "x-anticodex-manager-token": "bad-token"
      },
      body: JSON.stringify({ action: "refreshStatus" })
    });
    assert.equal(res2.status, 403);

    // Valid token & virtual action
    const res3 = await fetch(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:8484",
        "x-anticodex-manager-token": token
      },
      body: JSON.stringify({ action: "refreshStatus" })
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.ok, true);
    assert.equal(body3.action, "refreshStatus");
    assert.deepEqual(body3.result, { ok: true });
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
        origin: "http://127.0.0.1:8484",
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
      headers: { origin: "http://127.0.0.1:8484" }
    });
    assert.equal(res2.status, 400);

    // Valid JSONP call
    const res3 = await fetch(`${baseUrl}/anticodex/manager/action-script?callback=onSuccess&action=refreshStatus&token=${token}`, {
      headers: { origin: "http://127.0.0.1:8484" }
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
        origin: "http://127.0.0.1:8484",
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
        headers: { origin: "http://127.0.0.1:8484" }
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
