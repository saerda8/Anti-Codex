import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("translator exited before health");
    try {
      const response = await fetch(baseUrl + "/health");
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("translator health timeout");
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function responseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const dataLines = String(text)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter((line) => line && line !== "[DONE]");
  for (const line of dataLines.reverse()) {
    try {
      const event = JSON.parse(line);
      if (event?.object === "response") return event;
      if (event?.response?.object === "response") return event.response;
    } catch {}
  }
  throw new SyntaxError("response body did not contain a response object");
}

test("Anthropic runtime, connection test, and encrypted profile save work end to end", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "anticodex-upstream-integration-"));
  const requests = [];
  let forceFailure = false;
  const upstream = http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : {};
    requests.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    if (forceFailure) {
      res.end(JSON.stringify({ ok: true, but: "not an anthropic message" }));
      return;
    }
    res.end(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "第三方接口已接通" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 8 },
    }));
  });

  let child;
  try {
    const upstreamPort = await listen(upstream);
    const translatorProbe = http.createServer();
    const translatorPort = await listen(translatorProbe);
    await close(translatorProbe);
    const translatorUrl = "http://127.0.0.1:" + translatorPort;
    child = spawn(process.execPath, [resolve(root, "translator", "adaptive-server.mjs")], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRANSLATOR_HOST: "127.0.0.1",
        TRANSLATOR_LISTEN_HOST: "127.0.0.1",
        TRANSLATOR_PORT: String(translatorPort),
        TRANSLATOR_UPSTREAM_MODE: "chat",
        UPSTREAM_PROTOCOL: "anthropic",
        UPSTREAM_URL: "http://127.0.0.1:" + upstreamPort,
        UPSTREAM_MODEL: "claude-test",
        UPSTREAM_API_KEY: "sk-anthropic-secret",
        DEEPCODEX_STATE_ROOT: stateRoot,
        CODEX_HOME_DIR: join(stateRoot, "codex-home-deepseek-app"),
        TRANSLATOR_NATIVE_STREAMING: "0",
      },
    });
    await waitForHealth(translatorUrl, child);

    const models = await fetch(translatorUrl + "/v1/models").then((response) => response.json());
    assert.deepEqual(models.data.map((model) => model.id), ["claude-test"]);

    const response = await fetch(translatorUrl + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        stream: false,
        input: "请用中文回复",
      }),
    });
    assert.equal(response.status, 200);
    const responseText = await response.text();
    const firstResponse = responseJsonFromText(responseText);
    assert.equal(firstResponse.previous_response_id, null);
    const responseHistoryPath = join(stateRoot, "response-history.json");
    const responseHistoryBeforeSwitch = readFileSync(responseHistoryPath, "utf8");
    assert.match(responseText, /第三方接口已接通/);
    assert.ok(requests.some((request) => request.path === "/v1/messages"));
    const chatRequest = requests.find((request) => request.path === "/v1/messages");
    assert.equal(chatRequest.headers["x-api-key"], "sk-anthropic-secret");
    assert.equal(chatRequest.headers["anthropic-version"], "2023-06-01");
    assert.equal(chatRequest.body.model, "claude-test");

    const profilePayload = await fetch(translatorUrl + "/anticodex/upstream-profile").then((result) => result.json());
    assert.equal(profilePayload.active, "third-party");
    assert.equal(profilePayload.runtime.protocol, "anthropic");
    assert.doesNotMatch(JSON.stringify(profilePayload), /sk-anthropic-secret/);
    const diagnosticsBeforeSwitch = await fetch(translatorUrl + "/anticodex/diagnostics").then((result) => result.json());
    assert.equal(diagnosticsBeforeSwitch.paths.stateRoot, stateRoot);
    assert.equal(diagnosticsBeforeSwitch.paths.responseHistory, responseHistoryPath);

    const unauthorizedRequestsBefore = requests.length;
    const unauthorized = await fetch(translatorUrl + "/anticodex/upstream-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:" + upstreamPort,
        model: "claude-test",
        apiKey: "sk-save-secret",
      }),
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(requests.length, unauthorizedRequestsBefore);

    const crossOriginBootstrap = await fetch(
      translatorUrl + "/anticodex/manager/bootstrap",
      { headers: { origin: "https://example.invalid" } },
    );
    assert.equal(crossOriginBootstrap.status, 403);

    const managerHeaders = { origin: translatorUrl, referer: translatorUrl + "/anticodex/manager" };
    const bootstrap = await fetch(translatorUrl + "/anticodex/manager/bootstrap", { headers: managerHeaders }).then((result) => result.json());
    const crossOriginActionScript = await fetch(
      translatorUrl + "/anticodex/manager/action-script?action=refreshStatus&callback=__anticodexTest&token=" + encodeURIComponent(bootstrap.token),
      { headers: { origin: "https://example.invalid" } },
    );
    assert.equal(crossOriginActionScript.status, 403);

    const connection = await fetch(translatorUrl + "/anticodex/upstream-test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anticodex-manager-token": bootstrap.token,
        origin: translatorUrl,
        referer: translatorUrl + "/anticodex/manager",
      },
      body: JSON.stringify({
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:" + upstreamPort,
        model: "claude-test",
        apiKey: "sk-save-secret",
      }),
    }).then((result) => result.json());
    assert.equal(connection.ok, true);
    assert.ok(connection.stages.length >= 4);

    forceFailure = true;
    const rejected = await fetch(translatorUrl + "/anticodex/upstream-profile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anticodex-manager-token": bootstrap.token,
        origin: translatorUrl,
        referer: translatorUrl + "/anticodex/manager",
      },
      body: JSON.stringify({
        mode: "third-party",
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:" + upstreamPort,
        model: "claude-test",
        apiKey: "sk-save-secret",
        stages: [{ stage: "forged", status: "ok", detail: "client says ok" }],
      }),
    });
    assert.equal(rejected.status, 400);
    forceFailure = false;

    const saved = await fetch(translatorUrl + "/anticodex/upstream-profile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anticodex-manager-token": bootstrap.token,
        origin: translatorUrl,
        referer: translatorUrl + "/anticodex/manager",
      },
      body: JSON.stringify({
        mode: "third-party",
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:" + upstreamPort,
        model: "claude-test",
        apiKey: "sk-save-secret",
        stages: connection.stages,
      }),
    }).then(async (result) => responseJsonFromText(await result.text()));
    assert.equal(saved.ok, true);
    assert.equal(saved.restartRequired, true);
    const profileText = readFileSync(join(stateRoot, "upstream-profile.json"), "utf8");
    assert.doesNotMatch(profileText, /sk-save-secret/);
    const healthAfterSave = await fetch(translatorUrl + "/health").then((result) => result.json());
    assert.equal(healthAfterSave.upstreamProfile.mode, "third-party");
    assert.equal(healthAfterSave.upstreamProfile.protocol, "anthropic");
    assert.equal(healthAfterSave.upstreamProfile.model, "claude-test");
    assert.equal(healthAfterSave.upstreamProfile.capabilitySummary.present, true);
    assert.equal(healthAfterSave.upstreamProfile.capabilitySummary.warnCount >= 1, true);
    const diagnosticsAfterSwitch = await fetch(translatorUrl + "/anticodex/diagnostics").then((result) => result.json());
    assert.equal(diagnosticsAfterSwitch.mode.upstreamMode, "chat");
    assert.equal(diagnosticsAfterSwitch.health.upstreamProfile.mode, "third-party");
    assert.equal(diagnosticsAfterSwitch.models.count, 1);
    assert.deepEqual(diagnosticsAfterSwitch.models.ids, ["claude-test"]);
    assert.equal(diagnosticsAfterSwitch.toolBridge.mode, "provider-native-or-compat");
    assert.equal(diagnosticsAfterSwitch.toolBridge.transport, "upstream-provider");
    assert.equal(diagnosticsAfterSwitch.toolBridge.nativeAntigravityToolEvents, false);
    assert.equal(diagnosticsAfterSwitch.paths.stateRoot, stateRoot);
    assert.equal(diagnosticsAfterSwitch.paths.responseHistory, responseHistoryPath);
    assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryBeforeSwitch);

    const restoredItems = await fetch(translatorUrl + "/v1/responses/" + firstResponse.id + "/input_items").then((result) => result.json());
    assert.equal(restoredItems.object, "list");
    assert.equal(restoredItems.data.length, 1);
    assert.equal(restoredItems.data[0].role, "user");

    const followup = await fetch(translatorUrl + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        stream: false,
        previous_response_id: firstResponse.id,
        input: "continue without losing project state",
      }),
    }).then(async (result) => responseJsonFromText(await result.text()));
    assert.equal(followup.previous_response_id, firstResponse.id);
    const routeAfterFollowup = await fetch(translatorUrl + "/anticodex/model-routes").then((result) => result.json());
    assert.equal(routeAfterFollowup.latest.transport, "upstream-provider");
    assert.equal(routeAfterFollowup.latest.providerProtocol, "anthropic");
    assert.equal(routeAfterFollowup.latest.requestedModel, "claude-test");
    assert.equal(routeAfterFollowup.latest.resolvedModel, "claude-test");
    const responseHistoryAfterFollowup = readFileSync(responseHistoryPath, "utf8");
    for (const staleModel of ["gemini-pro-agent", "gemini-3-flash-agent"]) {
      const staleAntigravityModelFollowup = await fetch(translatorUrl + "/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: staleModel,
          stream: false,
          previous_response_id: firstResponse.id,
          input: "continue after switching models",
        }),
      }).then(async (result) => responseJsonFromText(await result.text()));
      assert.equal(staleAntigravityModelFollowup.previous_response_id, firstResponse.id);
      const staleModelRequest = requests.filter((request) => request.path === "/v1/messages").at(-1);
      assert.equal(staleModelRequest.body.model, "claude-test");
    }
    const responseHistoryAfterStaleModelFollowup = readFileSync(responseHistoryPath, "utf8");

    const restoredAntigravityResponse = await fetch(translatorUrl + "/anticodex/upstream-profile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anticodex-manager-token": bootstrap.token,
        origin: translatorUrl,
        referer: translatorUrl + "/anticodex/manager",
      },
      body: JSON.stringify({ mode: "antigravity" }),
    });
    const restoredAntigravityText = await restoredAntigravityResponse.text();
    assert.equal(restoredAntigravityResponse.status, 200, restoredAntigravityText);
    const restoredAntigravity = responseJsonFromText(restoredAntigravityText);
    assert.equal(restoredAntigravity.ok, true);
    assert.equal(restoredAntigravity.saved.mode, "antigravity");
    assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryAfterStaleModelFollowup);
    const diagnosticsAfterRestore = await fetch(translatorUrl + "/anticodex/diagnostics").then((result) => result.json());
    assert.equal(diagnosticsAfterRestore.paths.stateRoot, stateRoot);
    assert.equal(diagnosticsAfterRestore.paths.responseHistory, responseHistoryPath);

    const requestsBeforeEmptyKeyTest = requests.length;
    const emptyKeyConnection = await fetch(translatorUrl + "/anticodex/upstream-test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anticodex-manager-token": bootstrap.token,
        origin: translatorUrl,
        referer: translatorUrl + "/anticodex/manager",
      },
      body: JSON.stringify({
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:" + upstreamPort,
        model: "claude-test",
        apiKey: "",
      }),
    }).then((result) => result.json());
    assert.equal(emptyKeyConnection.ok, true);
    assert.ok(requests.slice(requestsBeforeEmptyKeyTest).every((request) => request.headers["x-api-key"] === "sk-save-secret"));
  } finally {
    if (child && child.exitCode === null) child.kill();
    await close(upstream);
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("OpenAI-compatible runtime preserves model identity and bearer authentication", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "anticodex-openai-integration-"));
  const requests = [];
  let exposeSecretFailure = false;
  const upstream = http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : {};
    requests.push({ path: req.url, headers: req.headers, body });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "vendor-model-3.5" }] }));
      return;
    }
    if (exposeSecretFailure) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authorization Bearer sk-openai-secret was rejected" } }));
      return;
    }
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl_stream_test",
        object: "chat.completion.chunk",
        created: 1,
        model: "vendor-model-3.5",
        choices: [{ index: 0, delta: { role: "assistant", content: "OpenAI 兼容接口已接通" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl_stream_test",
        object: "chat.completion.chunk",
        created: 1,
        model: "vendor-model-3.5",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_test",
      object: "chat.completion",
      created: 1,
      model: "vendor-model-3.5",
      choices: [{ index: 0, message: { role: "assistant", content: "OpenAI 兼容接口已接通" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }));
  });

  let child;
  try {
    const upstreamPort = await listen(upstream);
    const translatorProbe = http.createServer();
    const translatorPort = await listen(translatorProbe);
    await close(translatorProbe);
    const translatorUrl = "http://127.0.0.1:" + translatorPort;
    const profilePath = join(stateRoot, "provider-profile.json");
    writeFileSync(profilePath, JSON.stringify({
      provider: "custom-openai",
      baseUrl: "http://127.0.0.1:" + upstreamPort + "/v1",
      model: "vendor-model-3.5",
      defaultModel: "vendor-model-3.5",
      fastModel: "vendor-model-3.5",
      models: ["vendor-model-3.5"],
      capabilities: {
        basicChat: true,
        stream: false,
        toolCalls: true,
        hostedTools: false,
        internalWebTools: false,
        nativeStreaming: false,
      },
      toolStrategy: {},
    }), "utf8");
    child = spawn(process.execPath, [resolve(root, "translator", "adaptive-server.mjs")], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRANSLATOR_HOST: "127.0.0.1",
        TRANSLATOR_LISTEN_HOST: "127.0.0.1",
        TRANSLATOR_PORT: String(translatorPort),
        TRANSLATOR_UPSTREAM_MODE: "chat",
        UPSTREAM_PROTOCOL: "openai-compatible",
        UPSTREAM_URL: "http://127.0.0.1:" + upstreamPort + "/v1",
        UPSTREAM_MODEL: "vendor-model-3.5",
        UPSTREAM_API_KEY: "sk-openai-secret",
        TRANSLATOR_PROFILE_PATH: profilePath,
        DEEPCODEX_STATE_ROOT: stateRoot,
        CODEX_HOME_DIR: join(stateRoot, "codex-home-deepseek-app"),
        TRANSLATOR_NATIVE_STREAMING: "1",
        TRANSLATOR_CAP_INTERNAL_WEB_TOOLS: "0",
      },
    });
    await waitForHealth(translatorUrl, child);

    const models = await fetch(translatorUrl + "/v1/models").then((response) => response.json());
    assert.deepEqual(models.data.map((model) => model.id), ["vendor-model-3.5"]);

    const responseText = await fetch(translatorUrl + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vendor-model-3.5", stream: true, input: "继续当前项目" }),
    }).then((response) => response.text());
    assert.match(responseText, /OpenAI 兼容接口已接通/);
    const firstResponse = responseJsonFromText(responseText);
    const restoredItems = await fetch(translatorUrl + "/v1/responses/" + firstResponse.id + "/input_items").then((response) => response.json());
    assert.equal(restoredItems.object, "list");
    assert.equal(restoredItems.data[0].role, "user");
    const followup = await fetch(translatorUrl + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "vendor-model-3.5",
        stream: false,
        previous_response_id: firstResponse.id,
        input: "继续上一条",
      }),
    }).then(async (response) => responseJsonFromText(await response.text()));
    assert.equal(followup.previous_response_id, firstResponse.id);
    const chatRequest = requests.filter((request) => request.path === "/v1/chat/completions").at(-1);
    assert.ok(chatRequest);
    assert.equal(chatRequest.headers.authorization, "Bearer sk-openai-secret");
    assert.equal(chatRequest.body.model, "vendor-model-3.5");

    exposeSecretFailure = true;
    const failedResponse = await fetch(translatorUrl + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vendor-model-3.5", stream: false, input: "触发安全错误" }),
    });
    const failedText = await failedResponse.text();
    assert.equal(failedResponse.status, 401);
    assert.doesNotMatch(failedText, /sk-openai-secret/);
    assert.match(failedText, /auth_error/);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await close(upstream);
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("missing response history returns a non-retryable 410 without calling upstream", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "anticodex-missing-history-integration-"));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : {};
    requests.push({ path: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_unexpected",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "unexpected upstream call" }, finish_reason: "stop" }],
    }));
  });

  let child;
  try {
    const upstreamPort = await listen(upstream);
    const translatorProbe = http.createServer();
    const translatorPort = await listen(translatorProbe);
    await close(translatorProbe);
    const translatorUrl = "http://127.0.0.1:" + translatorPort;
    const profilePath = join(stateRoot, "provider-profile.json");
    writeFileSync(profilePath, JSON.stringify({
      provider: "missing-history-test",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1:" + upstreamPort + "/v1",
      model: "history-test-model",
      defaultModel: "history-test-model",
      fastModel: "history-test-model",
      models: ["history-test-model"],
      capabilities: { basicChat: true, stream: false, toolCalls: false },
      toolStrategy: {},
    }), "utf8");

    child = spawn(process.execPath, [resolve(root, "translator", "adaptive-server.mjs")], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRANSLATOR_HOST: "127.0.0.1",
        TRANSLATOR_LISTEN_HOST: "127.0.0.1",
        TRANSLATOR_PORT: String(translatorPort),
        TRANSLATOR_UPSTREAM_MODE: "chat",
        UPSTREAM_PROTOCOL: "openai-compatible",
        UPSTREAM_URL: "http://127.0.0.1:" + upstreamPort + "/v1",
        UPSTREAM_MODEL: "",
        UPSTREAM_API_KEY: "sk-history-test",
        TRANSLATOR_PROFILE_PATH: profilePath,
        DEEPCODEX_STATE_ROOT: stateRoot,
        CODEX_HOME_DIR: join(stateRoot, "codex-home-deepseek-app"),
        TRANSLATOR_NATIVE_STREAMING: "0",
        TRANSLATOR_CAP_INTERNAL_WEB_TOOLS: "0",
      },
    });
    await waitForHealth(translatorUrl, child);

    const upstreamRequestsBefore = requests.length;
    const missingId = "resp_expired_history_marker";
    const response = await fetch(translatorUrl + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "history-test-model",
        stream: false,
        previous_response_id: missingId,
        input: "continue expired conversation",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 410);
    assert.equal(payload.error.type, "response_history_missing");
    assert.equal(payload.error.details.status, 410);
    assert.equal(payload.error.details.retryable, false);
    assert.equal(payload.error.details.previous_response_id, missingId);
    assert.match(payload.error.message, /Start a fresh request or reopen the original conversation context/);
    assert.equal(requests.length, upstreamRequestsBefore);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await close(upstream);
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
