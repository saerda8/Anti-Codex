import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "1");
  }
}

const sourceRoot = resolve(args.get("--source-root") || resolve(import.meta.dirname, ".."));
const runtimeRoot = resolve(args.get("--runtime-root") || sourceRoot);
const reportRoot = resolve(args.get("--report-root") || join(os.tmpdir(), "anticodex-reports"));
const timeoutMs = Math.max(10_000, Number(args.get("--timeout-ms") || 90_000));
const translatorPath = resolve(runtimeRoot, "translator", "adaptive-server.mjs");
const stateRoot = mkdtempSync(join(os.tmpdir(), "anticodex-third-party-provider-"));
const startedAt = Date.now();
const failures = [];
const requests = [];
let translator = null;
let upstream = null;

function addFailure(message) {
  failures.push(String(message || "unknown failure"));
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose) => {
    if (!server) return resolveClose();
    server.close(() => resolveClose());
  });
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

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  if (!json) throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 500)}`);
  return json;
}

function responseJsonFromText(text) {
  try { return JSON.parse(text); } catch {}
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

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (translator?.exitCode !== null) throw new Error("temporary translator exited before health");
    try {
      const health = await getJson(`${baseUrl}/health`);
      if (health.ok) return health;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error("temporary translator health timeout");
}

function writeReport(payload) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const latest = resolve(reportRoot, "latest-third-party-provider.json");
  const history = resolve(reportRoot, `${stamp}-third-party-provider.json`);
  mkdirSync(reportRoot, { recursive: true });
  const text = JSON.stringify({ ...payload, report: { latest, history } });
  writeFileSync(latest, text, "utf8");
  writeFileSync(history, text, "utf8");
  return { latest, history };
}

async function main() {
  let forceAuthFailure = false;
  upstream = http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : {};
    requests.push({ path: req.url, headers: req.headers, body });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-gpt-4.1" }] }));
      return;
    }
    if (forceAuthFailure) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bearer sk-fake-secret was rejected" } }));
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_fake_provider",
      object: "chat.completion",
      created: 1,
      model: "fake-gpt-4.1",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "THIRD_PARTY_PROVIDER_OK" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }));
  });

  const upstreamPort = await listen(upstream);
  const translatorProbe = http.createServer();
  const translatorPort = await listen(translatorProbe);
  await close(translatorProbe);
  const translatorUrl = `http://127.0.0.1:${translatorPort}`;
  const upstreamFullUrl = `http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
  const profilePath = join(stateRoot, "provider-profile.json");
  writeFileSync(profilePath, JSON.stringify({
    provider: "fake-openai",
    baseUrl: upstreamFullUrl,
    model: "fake-gpt-4.1",
    defaultModel: "fake-gpt-4.1",
    fastModel: "fake-gpt-4.1",
    models: ["fake-gpt-4.1"],
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

  translator = spawn(process.execPath, [translatorPath], {
    cwd: sourceRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TRANSLATOR_HOST: "127.0.0.1",
      TRANSLATOR_LISTEN_HOST: "127.0.0.1",
      TRANSLATOR_PORT: String(translatorPort),
      TRANSLATOR_UPSTREAM_MODE: "chat",
      UPSTREAM_PROTOCOL: "openai-compatible",
      UPSTREAM_URL: upstreamFullUrl,
      UPSTREAM_MODEL: "fake-gpt-4.1",
      UPSTREAM_API_KEY: "sk-fake-secret",
      TRANSLATOR_PROFILE_PATH: profilePath,
      DEEPCODEX_STATE_ROOT: stateRoot,
      CODEX_HOME_DIR: join(stateRoot, "codex-home-deepseek-app"),
      TRANSLATOR_NATIVE_STREAMING: "0",
      TRANSLATOR_CAP_INTERNAL_WEB_TOOLS: "0",
    },
  });

  const health = await waitForHealth(translatorUrl);
  assert.equal(health.upstreamProfile.mode, "third-party");
  assert.equal(health.upstreamProfile.protocol, "openai-compatible");
  assert.equal(health.upstreamProfile.model, "fake-gpt-4.1");

  const models = await getJson(`${translatorUrl}/v1/models`);
  assert.deepEqual(models.data.map((model) => model.id), ["fake-gpt-4.1"]);

  const firstText = await fetch(`${translatorUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-gpt-4.1", stream: false, input: "hello" }),
  }).then((response) => response.text());
  assert.match(firstText, /THIRD_PARTY_PROVIDER_OK/);
  const first = responseJsonFromText(firstText);
  const responseHistoryPath = join(stateRoot, "response-history.json");
  const responseHistoryBefore = readFileSync(responseHistoryPath, "utf8");
  const chatRequest = requests.find((request) => request.path === "/v1/chat/completions");
  assert.ok(chatRequest);
  assert.equal(chatRequest.headers.authorization, "Bearer sk-fake-secret");
  assert.equal(chatRequest.body.model, "fake-gpt-4.1");

  const unauthorizedBefore = requests.length;
  const unauthorized = await fetch(`${translatorUrl}/anticodex/upstream-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "openai-compatible",
      baseUrl: upstreamFullUrl,
      model: "fake-gpt-4.1",
      apiKey: "sk-save-secret",
    }),
  });
  assert.equal(unauthorized.status, 403);
  assert.equal(requests.length, unauthorizedBefore);

  const managerHeaders = { origin: translatorUrl, referer: `${translatorUrl}/anticodex/manager` };
  const bootstrap = await getJson(`${translatorUrl}/anticodex/manager/bootstrap`, { headers: managerHeaders });
  const authedHeaders = {
    "content-type": "application/json",
    "x-anticodex-manager-token": bootstrap.token,
    origin: translatorUrl,
    referer: `${translatorUrl}/anticodex/manager`,
  };
  const connection = await getJson(`${translatorUrl}/anticodex/upstream-test`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      protocol: "openai-compatible",
      baseUrl: upstreamFullUrl,
      model: "fake-gpt-4.1",
      apiKey: "sk-save-secret",
      timeoutMs: 10_000,
    }),
  });
  assert.equal(connection.ok, true);
  assert.ok(connection.stages.length >= 3);

  const savedResponse = await fetch(`${translatorUrl}/anticodex/upstream-profile`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      mode: "third-party",
      protocol: "openai-compatible",
      baseUrl: upstreamFullUrl,
      model: "fake-gpt-4.1",
      apiKey: "sk-save-secret",
      stages: connection.stages,
    }),
  });
  const savedText = await savedResponse.text();
  assert.equal(savedResponse.status, 200, savedText);
  const saved = responseJsonFromText(savedText);
  assert.equal(saved.ok, true);
  assert.equal(saved.restartRequired, true);
  assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryBefore);
  assert.doesNotMatch(readFileSync(join(stateRoot, "upstream-profile.json"), "utf8"), /sk-save-secret/);

  const routeAudit = await getJson(`${translatorUrl}/anticodex/model-routes`);
  assert.equal(routeAudit.latest.transport, "upstream-provider");
  assert.equal(routeAudit.latest.providerProtocol, "openai-compatible");
  assert.equal(routeAudit.latest.resolvedModel, "fake-gpt-4.1");

  forceAuthFailure = true;
  const failedResponse = await fetch(`${translatorUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-gpt-4.1", stream: false, input: "fail safely" }),
  });
  const failedText = await failedResponse.text();
  assert.equal(failedResponse.status, 401);
  assert.match(failedText, /auth_error/);
  assert.doesNotMatch(failedText, /sk-fake-secret|sk-save-secret/);

  return {
    ok: failures.length === 0,
    failures,
    elapsedMs: Date.now() - startedAt,
    mode: "third-party",
    protocol: "openai-compatible",
    model: "fake-gpt-4.1",
    upstreamFullUrlAccepted: true,
    unauthorizedManagerBlocked: true,
    savedWithoutHistoryLoss: true,
    routeEvidence: routeAudit.latest,
    requestCount: requests.length,
  };
}

let result;
try {
  result = await main();
} catch (error) {
  addFailure(error?.stack || error?.message || String(error));
  result = {
    ok: false,
    failures,
    elapsedMs: Date.now() - startedAt,
  };
} finally {
  if (translator && translator.exitCode === null) translator.kill();
  await close(upstream);
  rmSync(stateRoot, { recursive: true, force: true });
}

writeReport(result);
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
