#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const stateRoot = mkdtempSync(join(os.tmpdir(), "anticodex-local-connectors-"));
const codexHome = join(stateRoot, "codex-home-deepseek-app");
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

function requestTimeoutSignal(ms = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

async function getJson(url, options = {}) {
  const { controller, timer } = requestTimeoutSignal(options.timeoutMs || 5_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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
  } finally {
    clearTimeout(timer);
  }
}

async function waitForEndpoint(baseUrl, pathname) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (translator?.exitCode !== null) {
      throw new Error(`temporary translator exited before ${pathname}: ${stderrTail()}`);
    }
    try {
      return await getJson(`${baseUrl}${pathname}`, { timeoutMs: 2_000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
  throw new Error(`timeout waiting for ${pathname}: ${lastError?.message || "no response"}`);
}

function stderrTail() {
  return String(translator?.stderrText || "").split(/\r?\n/).slice(-12).join("\n");
}

function writeLocalCaches() {
  const connectorDir = join(codexHome, "cache", "codex_app_directory");
  const toolsDir = join(codexHome, "cache", "codex_apps_tools");
  mkdirSync(connectorDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  const blockedInstallHost = ["chatgpt", "com"].join(".");
  const blockedLegacyInstallHost = ["chat", "openai", "com"].join(".");

  writeFileSync(join(connectorDir, "directory.json"), JSON.stringify({
    schema_version: 1,
    connectors: [
      { id: "linked-demo", name: "Linked Demo", isAccessible: true, installUrl: "https://example.invalid/apps/linked-demo" },
      { id: "allowlisted-demo", name: "Allowlisted Demo", isAccessible: false, installUrl: `https://${blockedInstallHost}/apps/allowlisted-demo` },
      { id: "hidden-connector", name: "Hidden Connector", isAccessible: false, installUrl: `https://${blockedLegacyInstallHost}/apps/hidden-connector` },
      { id: "another-hidden", name: "Another Hidden", isAccessible: false },
    ],
  }), "utf8");

  writeFileSync(join(toolsDir, "tools.json"), JSON.stringify({
    schema_version: 2,
    tools: [
      { server_name: "apps", tool_namespace: "demo", tool_name: "linked_tool", connector_id: "linked-demo" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "allowlisted_tool", connector_id: "allowlisted-demo" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "hidden_tool", connector_id: "hidden-connector" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "another_hidden_tool", connector_id: "another-hidden" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "orphan_tool" },
    ],
  }), "utf8");

  writeFileSync(join(codexHome, "config.toml"), [
    "[local_authorized_connectors]",
    "\"allowlisted-demo\" = true",
    "",
  ].join("\n"), "utf8");
}

function writeProviderProfile(profilePath, upstreamUrl) {
  writeFileSync(profilePath, JSON.stringify({
    provider: "fake-openai",
    protocol: "openai-compatible",
    baseUrl: upstreamUrl,
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
}

function writeReport(payload) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const latest = resolve(reportRoot, "latest-local-connectors.json");
  const history = resolve(reportRoot, `${stamp}-local-connectors.json`);
  mkdirSync(reportRoot, { recursive: true });
  const text = JSON.stringify({ ...payload, report: { latest, history } }, null, 2);
  writeJsonReportAtomic(latest, history, text);
  return { latest, history };
}

function writeTextAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    JSON.parse(readFileText(tmp));
    renameSync(tmp, filePath);
    writeHashSidecar(filePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeHashSidecar(filePath) {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const sidecar = `${filePath}.sha256`;
  const tmp = `${sidecar}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `sha256:${hash}`, "ascii");
    renameSync(tmp, sidecar);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function readFileText(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeJsonReportAtomic(latest, history, text) {
  writeTextAtomic(history, text);
  writeTextAtomic(latest, text);
}

function connectorById(payload, id) {
  return payload.connectors.find((connector) => connector.id === id);
}

function toolNames(payload) {
  return payload.tools.map((tool) => tool.tool_name).sort();
}

function assertLocalConnectorProjection({ connectors, whamPost, whamGet, allowlistedDetail, hiddenDetail, linkPayloads }) {
  assert.deepEqual(
    connectors.connectors.map((connector) => connector.id).sort(),
    ["allowlisted-demo", "another-hidden", "hidden-connector", "linked-demo"],
  );

  const linked = connectorById(connectors, "linked-demo");
  const allowlisted = connectorById(connectors, "allowlisted-demo");
  const hidden = connectorById(connectors, "hidden-connector");
  const anotherHidden = connectorById(connectors, "another-hidden");
  assert.equal(linked.isAccessible, true);
  assert.equal(linked.locallyAllowlisted, false);
  assert.equal(linked.installUrl, "https://example.invalid/apps/linked-demo");
  assert.equal(allowlisted.isAccessible, false);
  assert.equal(allowlisted.locallyAllowlisted, true);
  assert.equal(allowlisted.localAuthorization, "anticodex-local-allowlist");
  assert.equal(allowlisted.installUrl, null);
  assert.equal(hidden.isAccessible, false);
  assert.equal(hidden.locallyAllowlisted, false);
  assert.equal(hidden.localAuthorization, undefined);
  assert.equal(hidden.installUrl, null);
  assert.equal(anotherHidden.isAccessible, false);
  assert.equal(anotherHidden.locallyAllowlisted, false);
  assert.equal(anotherHidden.localAuthorization, undefined);

  assert.deepEqual(toolNames(whamPost), ["linked_tool"]);
  assert.deepEqual(toolNames(whamGet), ["linked_tool"]);
  assert.equal(toolNames(whamPost).includes("allowlisted_tool"), false);
  assert.equal(toolNames(whamPost).includes("hidden_tool"), false);
  assert.equal(toolNames(whamPost).includes("orphan_tool"), false);
  assert.equal(whamPost.tools[0].connector_id, "linked-demo");

  assert.equal(allowlistedDetail.id, "allowlisted-demo");
  assert.equal(allowlistedDetail.isAccessible, false);
  assert.equal(allowlistedDetail.locallyAllowlisted, true);
  assert.equal(allowlistedDetail.localAuthorization, "anticodex-local-allowlist");
  assert.equal(allowlistedDetail.installUrl, null);
  assert.equal(hiddenDetail.id, "hidden-connector");
  assert.equal(hiddenDetail.isAccessible, false);
  assert.equal(hiddenDetail.localAuthorization, undefined);
  assert.equal(hiddenDetail.installUrl, null);

  for (const payload of linkPayloads) {
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "unsupported");
    assert.match(payload.error, /metadata-only/);
    assert.equal("url" in payload, false);
    assert.equal("redirect_url" in payload, false);
  }
}

async function main() {
  writeLocalCaches();

  upstream = http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : {};
    requests.push({ path: req.url, body });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-gpt-4.1" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_fake_provider",
        object: "chat.completion",
        created: 1,
        model: "fake-gpt-4.1",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  const upstreamPort = await listen(upstream);
  const translatorProbe = http.createServer();
  const translatorPort = await listen(translatorProbe);
  await close(translatorProbe);

  const upstreamUrl = `http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
  const translatorUrl = `http://127.0.0.1:${translatorPort}`;
  const profilePath = join(stateRoot, "provider-profile.json");
  writeProviderProfile(profilePath, upstreamUrl);

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
      UPSTREAM_URL: upstreamUrl,
      UPSTREAM_MODEL: "fake-gpt-4.1",
      UPSTREAM_API_KEY: "sk-local-connector-test",
      TRANSLATOR_PROFILE_PATH: profilePath,
      DEEPCODEX_STATE_ROOT: stateRoot,
      CODEX_HOME: codexHome,
      CODEX_HOME_DIR: codexHome,
      DEEPCODEX_SHARED_CODEX_HOME: join(stateRoot, "missing-shared-codex-home"),
      GLOBAL_CODEX_HOME: join(stateRoot, "missing-global-codex-home"),
      ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS: "",
      TRANSLATOR_NATIVE_STREAMING: "0",
      TRANSLATOR_CAP_INTERNAL_WEB_TOOLS: "0",
    },
  });
  translator.stderrText = "";
  translator.stderr.on("data", (chunk) => {
    translator.stderrText = `${translator.stderrText}${chunk.toString("utf8")}`.slice(-8_000);
  });
  translator.stdout.on("data", () => {});

  await waitForEndpoint(translatorUrl, "/health");
  const upstreamRequestsBeforeLocalEndpoints = requests.length;
  const connectors = await getJson(`${translatorUrl}/backend-api/aip/connectors`);
  const whamPost = await getJson(`${translatorUrl}/backend-api/wham/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const whamGet = await getJson(`${translatorUrl}/backend-api/wham/apps`);
  const allowlistedDetail = await getJson(`${translatorUrl}/backend-api/aip/connectors/allowlisted-demo`);
  const hiddenDetail = await getJson(`${translatorUrl}/backend-api/aip/connectors/hidden-connector`);
  const noauth = await getJson(`${translatorUrl}/backend-api/aip/connectors/links/noauth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const oauth = await getJson(`${translatorUrl}/backend-api/aip/connectors/links/oauth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const link = await getJson(`${translatorUrl}/backend-api/aip/connectors/allowlisted-demo/link`);

  assertLocalConnectorProjection({
    connectors,
    whamPost,
    whamGet,
    allowlistedDetail,
    hiddenDetail,
    linkPayloads: [noauth, oauth, link],
  });
  const upstreamRequestsAfterLocalEndpoints = requests.length;
  assert.equal(
    upstreamRequestsAfterLocalEndpoints,
    upstreamRequestsBeforeLocalEndpoints,
    "local connector/app-tool endpoints must not make provider or OAuth upstream requests",
  );

  return {
    ok: true,
    reportName: "local-connectors",
    failures,
    elapsedMs: Date.now() - startedAt,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "local-fake-provider",
    endpointEvidence: {
      connectors: connectors.connectors.length,
      exposedToolsPost: whamPost.tools.length,
      exposedToolsGet: whamGet.tools.length,
      exposedToolNames: toolNames(whamPost),
      linkedConnectorAccessible: connectorById(connectors, "linked-demo")?.isAccessible === true,
      allowlistedConnectorAccessible: connectorById(connectors, "allowlisted-demo")?.isAccessible === true,
      allowlistedConnectorLocallyAllowlisted: connectorById(connectors, "allowlisted-demo")?.locallyAllowlisted === true,
      hiddenConnectorAccessible: connectorById(connectors, "hidden-connector")?.isAccessible === true,
      chatgptInstallUrlsScrubbed: connectors.connectors.every((connector) => {
        const value = connector?.installUrl;
        const lower = String(value || "").toLowerCase();
        return !value || (!lower.includes(["chatgpt", "com"].join(".")) && !lower.includes(["chat", "openai", "com"].join(".")));
      }),
      linkEndpointsUnsupported: [noauth, oauth, link].every((payload) => payload?.ok === false && payload?.status === "unsupported"),
      upstreamRequestsBeforeLocalEndpoints,
      upstreamRequestsAfterLocalEndpoints,
      upstreamRequestsDuringLocalEndpoints: upstreamRequestsAfterLocalEndpoints - upstreamRequestsBeforeLocalEndpoints,
    },
    tempIsolation: {
      codexHome,
      stateRoot,
      sharedHomeUsed: false,
    },
    disclaimer: "This verifies only Anti-Codex local metadata projection and local allowlist filtering. It does not claim remote OAuth or real connector authorization.",
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
    stderrTail: stderrTail(),
  };
} finally {
  if (translator && translator.exitCode === null) translator.kill();
  await close(upstream);
  rmSync(stateRoot, { recursive: true, force: true });
}

writeReport(result);
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
