import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, "1");
  }
}

const sourceRoot = resolve(args.get("--source-root") || resolve(import.meta.dirname, ".."));
const runtimeRoot = resolve(args.get("--runtime-root") || sourceRoot);
const reportRoot = resolve(args.get("--report-root") || join(os.tmpdir(), "anticodex-reports"));
const timeoutMs = Math.max(10_000, Number(args.get("--timeout-ms") || 90_000));
const translatorPath = resolve(runtimeRoot, "translator", "adaptive-server.mjs");
const startedAt = Date.now();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stateRoot = mkdtempSync(join(os.tmpdir(), "anticodex-real-third-party-provider-"));
const profilePath = join(stateRoot, "provider-profile.json");
const reportName = "real-third-party-provider";
let translator = null;

function writeTextAtomic(filePath, text, encoding = "utf8") {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, encoding);
    renameSync(tmp, filePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeHashSidecar(filePath) {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  writeTextAtomic(`${filePath}.sha256`, `sha256:${hash}`, "ascii");
}

function writeReport(payload) {
  const latest = join(reportRoot, "latest-real-third-party-provider.json");
  const history = join(reportRoot, `${stamp}-real-third-party-provider.json`);
  const text = JSON.stringify(payload, null, 2);
  JSON.parse(text);
  writeTextAtomic(history, text);
  writeTextAtomic(latest, text);
  writeHashSidecar(history);
  writeHashSidecar(latest);
  return { latest, history };
}

function completeSkipped(reason, { requestedRealTraffic = false, ok = true } = {}) {
  return {
    ok,
    reportName,
    skipped: true,
    requestedRealTraffic,
    reason,
    coveredBy: "test-anticodex-real-third-party-provider.mjs",
    failures: ok ? [] : [reason],
    behaviorCovered: false,
    coverageKind: "skipped",
    usedRealTraffic: false,
    elapsedMs: Date.now() - startedAt,
  };
}

function safeFailureMessage(error, secret) {
  let message = String(error?.message || error || "real provider verification failed");
  if (secret) message = message.split(secret).join("[redacted-api-key]");
  return message.replace(/https?:\/\/\S+/gi, "[redacted-provider-url]");
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
  throw new Error("provider response did not contain a Responses object");
}

function textFromResponse(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || "")
    .join("\n");
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (translator?.exitCode !== null) throw new Error("isolated translator exited before health became ready");
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("isolated translator health timed out");
}

async function postResponse(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`provider request failed with HTTP ${response.status}`);
  return responseJsonFromText(text);
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`route audit request failed with HTTP ${response.status}`);
  return JSON.parse(text);
}

async function stopTranslator() {
  if (!translator || translator.exitCode !== null) return;
  translator.kill();
  await Promise.race([
    new Promise((resolveExit) => translator.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

async function runRealVerification({ protocol, baseUrl, model, apiKey, apiKeyEnv }) {
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.username || parsedUrl.password) throw new Error("provider URL must not contain credentials");
  if (parsedUrl.search || parsedUrl.hash) throw new Error("provider URL must not contain query parameters or fragments");
  if (/^(chat\.)?openai\.com$|(^|\.)chatgpt\.com$/i.test(parsedUrl.hostname)) {
    throw new Error("ChatGPT login endpoints are not supported");
  }
  if (parsedUrl.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
    throw new Error("non-loopback provider URLs must use HTTPS");
  }

  writeFileSync(profilePath, JSON.stringify({
    provider: `real-${protocol}`,
    protocol,
    baseUrl,
    model,
    defaultModel: model,
    fastModel: model,
    models: [model],
    capabilities: {
      basicChat: true,
      stream: false,
      toolCalls: false,
      hostedTools: false,
      internalWebTools: false,
      nativeStreaming: false,
    },
    toolStrategy: {},
  }), "utf8");

  const translatorPort = await reservePort();
  const translatorUrl = `http://127.0.0.1:${translatorPort}`;
  const translatorEnv = {
    ...process.env,
    TRANSLATOR_HOST: "127.0.0.1",
    TRANSLATOR_LISTEN_HOST: "127.0.0.1",
    TRANSLATOR_PORT: String(translatorPort),
    TRANSLATOR_UPSTREAM_MODE: "chat",
    UPSTREAM_PROTOCOL: protocol,
    UPSTREAM_URL: baseUrl,
    UPSTREAM_MODEL: model,
    UPSTREAM_API_KEY: apiKey,
    TRANSLATOR_PROFILE_PATH: profilePath,
    DEEPCODEX_STATE_ROOT: stateRoot,
    CODEX_HOME_DIR: join(stateRoot, "codex-home-deepseek-app"),
    TRANSLATOR_NATIVE_STREAMING: "0",
    TRANSLATOR_CAP_INTERNAL_WEB_TOOLS: "0",
  };
  delete translatorEnv[apiKeyEnv];
  realTrafficAttempted = true;
  translator = spawn(process.execPath, [translatorPath], {
    cwd: sourceRoot,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: translatorEnv,
  });

  const health = await waitForHealth(translatorUrl);
  assert.equal(health?.upstreamProfile?.mode, "third-party");
  assert.equal(health?.upstreamProfile?.protocol, protocol);
  assert.equal(health?.upstreamProfile?.model, model);

  const firstMarker = `REAL_PROVIDER_FIRST_${randomUUID()}`;
  const secondMarker = `REAL_PROVIDER_SECOND_${randomUUID()}`;
  const first = await postResponse(translatorUrl, {
    model,
    stream: false,
    max_output_tokens: 128,
    input: `Reply with exactly this marker and nothing else: ${firstMarker}`,
  });
  const firstText = textFromResponse(first);
  const firstMarkerObserved = firstText.includes(firstMarker);
  assert.equal(firstMarkerObserved, true);

  const second = await postResponse(translatorUrl, {
    model,
    stream: false,
    max_output_tokens: 128,
    previous_response_id: first.id,
    input: `Repeat the marker from the previous turn, then append this new marker: ${secondMarker}`,
  });
  const secondText = textFromResponse(second);
  const secondMarkerObserved = secondText.includes(secondMarker);
  const historyContinuationObserved = secondText.includes(firstMarker)
    && second.previous_response_id === first.id;
  assert.equal(secondMarkerObserved, true);
  assert.equal(historyContinuationObserved, true);

  const routeAudit = await getJson(`${translatorUrl}/anticodex/model-routes`);
  const routeEvidence = routeAudit?.latest || {};
  assert.equal(routeEvidence.transport, "upstream-provider");
  assert.equal(routeEvidence.providerProtocol, protocol);
  assert.equal(routeEvidence.requestedModel, model);
  assert.equal(routeEvidence.resolvedModel, model);
  assert.equal(routeEvidence.status, "success");

  return {
    ok: true,
    reportName,
    skipped: false,
    mode: "third-party",
    protocol,
    model,
    apiKeyEnv,
    isolatedState: true,
    installedProfileMutated: false,
    behaviorCovered: true,
    coverageKind: "real-traffic",
    requestedRealTraffic: true,
    usedRealTraffic: true,
    firstMarkerObserved,
    secondMarkerObserved,
    historyContinuationObserved,
    routeEvidence: {
      transport: routeEvidence.transport || "",
      providerProtocol: routeEvidence.providerProtocol || "",
      requestedModel: routeEvidence.requestedModel || "",
      resolvedModel: routeEvidence.resolvedModel || "",
      status: routeEvidence.status || "",
    },
    secretsRedacted: true,
    turns: 2,
    elapsedMs: Date.now() - startedAt,
  };
}

let result;
let apiKey = "";
let realTrafficAttempted = false;
try {
  if (process.argv.includes("--api-key")) {
    throw new Error("command-line API keys are not accepted; use --api-key-env");
  }
  if (!args.has("--allow-real-traffic")) {
    result = completeSkipped("real third-party provider verification is opt-in; rerun with --allow-real-traffic");
  } else {
    const protocol = String(args.get("--protocol") || "").trim();
    const baseUrl = String(args.get("--base-url") || "").trim();
    const model = String(args.get("--model") || "").trim();
    const apiKeyEnv = String(args.get("--api-key-env") || "").trim();
    if (!protocol || !baseUrl || !model || !apiKeyEnv) {
      result = completeSkipped("real provider protocol, base URL, model, and API key environment variable are required", { requestedRealTraffic: true, ok: false });
    } else if (!["openai-compatible", "anthropic"].includes(protocol)) {
      throw new Error("protocol must be openai-compatible or anthropic");
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new Error("API key environment variable name is invalid");
    } else {
      apiKey = String(process.env[apiKeyEnv] || "");
      if (!apiKey) {
        result = completeSkipped(`API key environment variable ${apiKeyEnv} is not set`, { requestedRealTraffic: true, ok: false });
      } else {
        result = await runRealVerification({ protocol, baseUrl, model, apiKey, apiKeyEnv });
      }
    }
  }
} catch (error) {
  result = {
    ok: false,
    reportName,
    skipped: false,
    behaviorCovered: false,
    coverageKind: "failed",
    usedRealTraffic: realTrafficAttempted,
    failures: [safeFailureMessage(error, apiKey)],
    elapsedMs: Date.now() - startedAt,
  };
} finally {
  await stopTranslator();
  rmSync(stateRoot, { recursive: true, force: true });
}

const reportText = JSON.stringify(result);
if (apiKey && reportText.includes(apiKey)) {
  result = {
    ok: false,
    reportName,
    skipped: false,
    behaviorCovered: false,
    coverageKind: "failed",
    usedRealTraffic: realTrafficAttempted,
    failures: ["real third-party provider report leaked an API key"],
    elapsedMs: Date.now() - startedAt,
  };
}
writeReport(result);

console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
