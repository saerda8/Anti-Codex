import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = {
  routing: fileURLToPath(new URL("../../scripts/test-anticodex-model-routing.ps1", import.meta.url)),
  switching: fileURLToPath(new URL("../../scripts/test-anticodex-model-switch-history.ps1", import.meta.url)),
};

function jsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function runPowerShell(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      ...args,
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function lastJson(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(lines.length, "PowerShell script did not emit JSON");
  return JSON.parse(lines.at(-1));
}

async function createHarness(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "anticodex-real-endpoints-"));
  const stateRoot = path.join(root, "state");
  const reportRoot = path.join(root, "reports");
  const token = "synthetic-token";
  const managerRequests = [];
  const healthRequests = [];
  const proxyRequests = [];
  const responseHistory = new Map();
  const historyLookups = [];
  const modelData = options.models ?? [
    { id: "model-a", object: "model", display_name: "Model A" },
    { id: "model-b", object: "model", display_name: "Model B" },
  ];

  const proxy = await listen(async (request, response) => {
    const body = request.method === "POST" ? await readJson(request) : null;
    proxyRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    if (request.headers.authorization !== `Bearer ${token}`) {
      jsonResponse(response, 401, { error: { type: "authentication_error", message: "missing local bearer" } });
      return;
    }
    if (request.method === "GET" && request.url === "/models") {
      jsonResponse(response, 200, { object: "list", data: modelData });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      if (options.failResponses) {
        jsonResponse(response, 502, { error: { type: "upstream_error", message: "synthetic response failure" } });
        return;
      }
      const serialized = JSON.stringify(body.input ?? []);
      let marker = serialized.match(/(?:MODEL_ROUTE|MODEL_SWITCH_HISTORY)_[A-Za-z0-9_]+/)?.[0] ?? "";
      const hasClientHistory = Array.isArray(body.input)
        && body.input.length === 3
        && body.input[0]?.role === "user"
        && body.input[1]?.role === "assistant"
        && body.input[2]?.role === "user";
      const hasPreviousId = Boolean(body.previous_response_id);
      const barePreviousId = hasPreviousId && !hasClientHistory;
      let text = marker;
      if (hasPreviousId) {
        historyLookups.push(String(body.previous_response_id));
        if (options.responseHistoryMode === "unsupported") {
          jsonResponse(response, 400, { error: { type: "invalid_request_error", code: "previous_response_id_unsupported", message: "stored response history is not supported" } });
          return;
        }
        if (options.responseHistoryMode === "supported") {
          const stored = responseHistory.get(String(body.previous_response_id));
          if (!stored) {
            jsonResponse(response, 410, {
              error: {
                type: "response_history_missing",
                message: "Start a fresh request or reopen the original conversation context.",
                details: {
                  status: 410,
                  retryable: false,
                  previous_response_id: String(body.previous_response_id),
                },
              },
            });
            return;
          }
          if (barePreviousId) {
            marker = stored.marker;
            text = marker;
          }
        } else if (barePreviousId) {
          text = "UNKNOWN";
        }
      }
      const responseId = `resp-${proxyRequests.length}`;
      if (body.store !== false && options.discardStoredResponses !== true) responseHistory.set(responseId, { marker, text });
      jsonResponse(response, 200, {
        id: responseId,
        object: "response",
        model: body.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      });
      return;
    }
    jsonResponse(response, 404, { error: "not_found" });
  });

  const fixedHealth = await listen((request, response) => {
    healthRequests.push({ method: request.method, path: request.url });
    if (request.method === "GET" && request.url === "/anticodex/fixed-route/health") {
      jsonResponse(response, 200, {
        ok: true,
        state: "ready",
        provider: "antigravity",
        model: "model-a",
        route: { codexBaseUrl: `${proxy.baseUrl}/v1`, relayProtocol: "chatCompletions" },
      });
      return;
    }
    jsonResponse(response, 404, { error: "not_found" });
  });

  const manager = await listen((request, response) => {
    managerRequests.push({
      method: request.method,
      path: request.url,
      origin: request.headers.origin,
      managerToken: request.headers["x-anticodex-manager-token"],
    });
    if (request.method === "GET" && request.url === "/health") {
      jsonResponse(response, 200, {
        schema: "anticodex-manager-service-v1",
        ok: true,
        role: "launcher-management-only",
        state: "ready",
        provider: "antigravity",
        model: "model-a",
      });
      return;
    }
    if (request.method === "GET" && request.url === "/anticodex/manager/bootstrap") {
      const expectedOrigin = `http://${request.headers.host}`;
      if (request.headers.origin !== expectedOrigin) {
        jsonResponse(response, 403, { ok: false, message: "untrusted manager source" });
        return;
      }
      jsonResponse(response, 200, { ok: true, token: "manager-action-token", baseUrl: expectedOrigin });
      return;
    }
    if (request.method === "POST" && request.url === "/anticodex/models/refresh") {
      const expectedOrigin = `http://${request.headers.host}`;
      if (request.headers.origin !== expectedOrigin || request.headers["x-anticodex-manager-token"] !== "manager-action-token") {
        jsonResponse(response, 403, { ok: false, message: "missing manager action auth" });
        return;
      }
      if (options.failRefresh) {
        jsonResponse(response, 500, { ok: false, message: "synthetic refresh failure" });
      } else {
        jsonResponse(response, 200, { ok: true, refreshed: true });
      }
      return;
    }
    if (request.method === "GET" && request.url === "/anticodex/diagnostics") {
      jsonResponse(response, 200, {
        ok: true,
        mode: { upstreamMode: "antigravity", upstream: "Antigravity Desktop Cascade" },
        health: { ok: true, state: "ready", provider: "antigravity", model: "model-a" },
        fixedRoute: { ready: true, provider: "antigravity", model: "model-a", relayProtocol: "chatCompletions" },
        models: { count: modelData.length, active: ["model-a"], provider: ["antigravity"] },
        toolBridge: { mode: "codex-native-harness", active: true, owner: "codex" },
      });
      return;
    }
    if (request.url === "/anticodex/model-routes") {
      jsonResponse(response, 200, { count: 0, latest: null, entries: [] });
      return;
    }
    jsonResponse(response, 404, { error: "not_found" });
  });

  await mkdir(path.join(stateRoot, "codex-home-deepseek-app"), { recursive: true });
  await writeFile(path.join(stateRoot, "codex-home-deepseek-app", "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: token })}\n`);
  await writeFile(path.join(stateRoot, "fixed-route-status.json"), `${JSON.stringify({
    ok: true,
    state: "ready",
    ports: { health: new URL(fixedHealth.baseUrl).port, proxy: new URL(proxy.baseUrl).port },
    route: { codexBaseUrl: `${proxy.baseUrl}/v1` },
  })}\n`);

  return {
    root, stateRoot, reportRoot, manager, fixedHealth, proxy,
    managerRequests, healthRequests, proxyRequests, historyLookups,
    async close() {
      await Promise.all([manager.close(), fixedHealth.close(), proxy.close()]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("model routing uses authenticated fixed-route endpoints and response evidence", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness();
  try {
    const result = await runPowerShell(scripts.routing, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-ReportRoot", harness.reportRoot,
      "-MaxModels", "1",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.proxyBaseUrl, harness.proxy.baseUrl);
    assert.equal(report.results[0].responseModel, "model-a");
    assert.equal(report.results[0].responseContainsMarker, true);
    assert.equal(report.results[0].route, null);
    assert.equal(report.results[0].evidenceKind, "fixed-route-response");
    assert.ok(harness.healthRequests.some((entry) => entry.path === "/anticodex/fixed-route/health"));
    assert.ok(harness.managerRequests.some((entry) => entry.path === "/anticodex/diagnostics"));
    assert.ok(harness.managerRequests.some((entry) => entry.path === "/anticodex/manager/bootstrap"));
    assert.ok(harness.managerRequests.some((entry) => entry.path === "/anticodex/models/refresh"
      && entry.origin === harness.manager.baseUrl
      && entry.managerToken === "manager-action-token"));
    assert.equal(harness.managerRequests.some((entry) => entry.path === "/anticodex/model-routes"), false);
    assert.deepEqual(
      harness.proxyRequests.map(({ path: requestPath, authorization }) => ({ path: requestPath, authorization })),
      [
        { path: "/models", authorization: "Bearer synthetic-token" },
        { path: "/v1/responses", authorization: "Bearer synthetic-token" },
      ],
    );
  } finally {
    await harness.close();
  }
});

test("model routing rejects unsafe manager and proxy URLs before local credentials can leave", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness();
  try {
    const unsafeManager = harness.manager.baseUrl.replace("http://", "http://user@");
    const managerResult = await runPowerShell(scripts.routing, [
      "-ManagerBaseUrl", unsafeManager,
      "-ProxyBaseUrl", harness.proxy.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-ReportRoot", harness.reportRoot,
      "-SkipRefresh",
      "-SkipRequests",
    ]);
    assert.equal(managerResult.status, 1);
    assert.match(lastJson(managerResult.stdout).failures.join("\n"), /ManagerBaseUrl.*safe HTTP loopback/i);
    assert.equal(harness.managerRequests.length, 0);
    assert.equal(harness.proxyRequests.length, 0);

    const proxyResult = await runPowerShell(scripts.routing, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-ProxyBaseUrl", `${harness.proxy.baseUrl}?credential-leak=1`,
      "-StateRoot", harness.stateRoot,
      "-ReportRoot", harness.reportRoot,
      "-SkipRefresh",
      "-SkipRequests",
    ]);
    assert.equal(proxyResult.status, 1);
    assert.match(lastJson(proxyResult.stdout).failures.join("\n"), /ProxyBaseUrl.*safe HTTP loopback/i);
    assert.equal(harness.proxyRequests.length, 0);

    const switchResult = await runPowerShell(scripts.switching, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-ProxyBaseUrl", `${harness.proxy.baseUrl}#credential-leak`,
      "-StateRoot", harness.stateRoot,
      "-FirstModel", "model-a",
      "-SecondModel", "model-b",
    ]);
    assert.equal(switchResult.status, 1);
    assert.match(lastJson(switchResult.stdout).failures.join("\n"), /ProxyBaseUrl.*safe HTTP loopback/i);
    assert.equal(harness.proxyRequests.length, 0);
  } finally {
    await harness.close();
  }
});

test("model routing never retries refresh or model POST and reports failed availability honestly", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness({ failRefresh: true, failResponses: true });
  try {
    const result = await runPowerShell(scripts.routing, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-ReportRoot", harness.reportRoot,
      "-MaxModels", "1",
    ]);
    assert.equal(result.status, 1);
    const report = lastJson(result.stdout);
    assert.equal(harness.managerRequests.filter((entry) => entry.path === "/anticodex/models/refresh").length, 1);
    assert.equal(harness.proxyRequests.filter((entry) => entry.path === "/v1/responses").length, 1);
    assert.equal(report.requestAttemptCount, 1);
    assert.equal(report.successfulRequestCount, 0);
    assert.equal(report.usedRealTraffic, true);
    assert.equal(report.results[0].requestAvailable, false);
  } finally {
    await harness.close();
  }
});

test("model routing reports zero traffic when an empty catalog causes no POST", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness({ models: [] });
  try {
    const result = await runPowerShell(scripts.routing, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-ReportRoot", harness.reportRoot,
      "-SkipRefresh",
    ]);
    assert.equal(result.status, 1);
    const report = lastJson(result.stdout);
    assert.equal(report.requestAttemptCount, 0);
    assert.equal(report.successfulRequestCount, 0);
    assert.equal(report.usedRealTraffic, false);
    assert.equal(harness.proxyRequests.some((entry) => entry.path === "/v1/responses"), false);
  } finally {
    await harness.close();
  }
});

test("MaxModels does not make no-traffic diagnostics compare a truncated list as the catalog", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness();
  try {
    const result = await runPowerShell(scripts.routing, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-ReportRoot", harness.reportRoot,
      "-SkipRefresh",
      "-SkipRequests",
      "-MaxModels", "1",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = lastJson(result.stdout);
    assert.equal(report.modelCatalogCount, 2);
    assert.equal(report.modelCount, 1);
    assert.equal(report.usedRealTraffic, false);
  } finally {
    await harness.close();
  }
});

test("model switch validates explicit client history without a fabricated route audit", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness({ responseHistoryMode: "supported" });
  try {
    const result = await runPowerShell(scripts.switching, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-FirstModel", "model-a",
      "-SecondModel", "model-b",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.historyMode, "explicit_client_history");
    assert.equal(report.previousResponseIdOnlySupported, null);
    assert.equal(report.requestCount, 2);
    assert.deepEqual(report.responseModels, { first: "model-a", second: "model-b" });
    assert.equal(report.route, null);
    assert.equal(harness.managerRequests.some((entry) => entry.path === "/anticodex/model-routes"), false);
    const responseRequests = harness.proxyRequests.filter((entry) => entry.path === "/v1/responses");
    assert.equal(responseRequests.length, 2);
    assert.equal(responseRequests[1].body.previous_response_id, report.firstResponseId);
    assert.deepEqual(responseRequests[1].body.input.map((item) => item.role), ["user", "assistant", "user"]);
    assert.ok(responseRequests.every((entry) => entry.authorization === "Bearer synthetic-token"));
    assert.deepEqual(harness.historyLookups, [report.firstResponseId]);
  } finally {
    await harness.close();
  }
});

test("previous_response_id-only mode keeps the current fixed-route history gap visible", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness();
  try {
    const result = await runPowerShell(scripts.switching, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-FirstModel", "model-a",
      "-SecondModel", "model-b",
      "-PreviousResponseIdOnly",
    ]);
    assert.equal(result.status, 1, `expected the known gap to remain red\n${result.stderr}\n${result.stdout}`);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.historyMode, "previous_response_id_only");
    assert.equal(report.previousResponseIdOnlySupported, false);
    assert.equal(report.requestCount, 2);
    assert.match(report.failures.join("\n"), /previous_response_id-only history was not preserved/i);
    const responseRequests = harness.proxyRequests.filter((entry) => entry.path === "/v1/responses");
    assert.equal(responseRequests.length, 2);
    assert.deepEqual(responseRequests[1].body.input.map((item) => item.role), ["user"]);
    assert.equal(responseRequests[1].body.previous_response_id, report.firstResponseId);
  } finally {
    await harness.close();
  }
});

test("previous_response_id-only mode restores stored history across a model switch", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness({ responseHistoryMode: "supported" });
  try {
    const result = await runPowerShell(scripts.switching, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-FirstModel", "model-a",
      "-SecondModel", "model-b",
      "-PreviousResponseIdOnly",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.historyMode, "previous_response_id_only");
    assert.equal(report.previousResponseIdOnlySupported, true);
    assert.equal(report.requestCount, 2);
    assert.deepEqual(report.responseModels, { first: "model-a", second: "model-b" });
    const responseRequests = harness.proxyRequests.filter((entry) => entry.path === "/v1/responses");
    assert.equal(responseRequests.length, 2);
    assert.deepEqual(responseRequests[1].body.input.map((item) => item.role), ["user"]);
    assert.equal(responseRequests[1].body.previous_response_id, report.firstResponseId);
    assert.ok(responseRequests.every((entry) => entry.authorization === "Bearer synthetic-token"));
    assert.deepEqual(harness.historyLookups, [report.firstResponseId]);
  } finally {
    await harness.close();
  }
});

test("previous_response_id-only mode fails honestly when the first stored response is missing", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness({ responseHistoryMode: "supported", discardStoredResponses: true });
  try {
    const result = await runPowerShell(scripts.switching, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-FirstModel", "model-a",
      "-SecondModel", "model-b",
      "-PreviousResponseIdOnly",
    ]);
    assert.equal(result.status, 1, `unknown previous id must fail\n${result.stderr}\n${result.stdout}`);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.requestCount, 2);
    assert.match(report.failures.join("\n"), /second model request failed/i);
    const responseRequests = harness.proxyRequests.filter((entry) => entry.path === "/v1/responses");
    assert.equal(responseRequests.length, 2);
    assert.deepEqual(harness.historyLookups, [report.firstResponseId]);
  } finally {
    await harness.close();
  }
});

test("previous_response_id-only mode fails honestly when an external service rejects stored history", { skip: process.platform !== "win32" }, async () => {
  const harness = await createHarness({ responseHistoryMode: "unsupported" });
  try {
    const result = await runPowerShell(scripts.switching, [
      "-ManagerBaseUrl", harness.manager.baseUrl,
      "-StateRoot", harness.stateRoot,
      "-FirstModel", "model-a",
      "-SecondModel", "model-b",
      "-PreviousResponseIdOnly",
    ]);
    assert.equal(result.status, 1, `unsupported history must fail\n${result.stderr}\n${result.stdout}`);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.requestCount, 2);
    assert.match(report.failures.join("\n"), /second model request failed/i);
    const responseRequests = harness.proxyRequests.filter((entry) => entry.path === "/v1/responses");
    assert.equal(responseRequests.length, 2);
    assert.deepEqual(harness.historyLookups, [report.firstResponseId]);
  } finally {
    await harness.close();
  }
});
