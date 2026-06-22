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
const stateRoot = mkdtempSync(join(os.tmpdir(), "anticodex-third-party-provider-"));
const startedAt = Date.now();
const failures = [];
const requests = [];
let translator = null;
let upstream = null;
let upstreamB = null;
let upstreamC = null;
let upstreamD = null;
let forceAuthFailure = false;

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

function textFromResponse(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || "")
    .join("\n");
}

function requestText(body) {
  return JSON.stringify(body?.messages || body?.input || body || "");
}

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const latest = messages.filter((message) => message?.role === "user").at(-1);
  const content = latest?.content;
  if (typeof content === "string") return content;
  return JSON.stringify(content || "");
}

function providerAnswerFor(body, prefix = "PROVIDER") {
  const text = latestUserText(body);
  const matches = [...text.matchAll(/turn-(\d+)/g)];
  const turn = matches.at(-1)?.[1] || "";
  return turn ? `${prefix}_HISTORY_TURN_${turn}` : `${prefix}_THIRD_PARTY_PROVIDER_OK`;
}

function toolCallOutputItems(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .filter((item) => item?.type === "function_call" || item?.type === "custom_tool_call");
}

function assertOpenAiToolHistory(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const assistantTool = messages.find((message) =>
    message?.role === "assistant"
    && Array.isArray(message.tool_calls)
    && message.tool_calls.some((toolCall) => toolCall?.id === "call_provider_a_tool_history")
  );
  assert.ok(assistantTool, "OpenAI-compatible history is missing assistant.tool_calls");
  const toolCall = assistantTool.tool_calls.find((item) => item?.id === "call_provider_a_tool_history");
  assert.equal(toolCall.function.name, "provider_tool_marker");
  assert.match(toolCall.function.arguments, /TOOL_HISTORY_MARKER_FROM_PROVIDER_A/);
  const toolResult = messages.find((message) =>
    message?.role === "tool"
    && message.tool_call_id === "call_provider_a_tool_history"
    && /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/.test(String(message.content || ""))
  );
  assert.ok(toolResult, "OpenAI-compatible history is missing paired tool result");
}

function assertAnthropicToolHistory(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const assistantTool = messages.find((message) =>
    message?.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block) => block?.type === "tool_use" && block.id === "call_provider_a_tool_history")
  );
  assert.ok(assistantTool, "Anthropic history is missing tool_use");
  const toolUse = assistantTool.content.find((block) => block?.type === "tool_use" && block.id === "call_provider_a_tool_history");
  assert.equal(toolUse.name, "provider_tool_marker");
  assert.equal(toolUse.input?.marker, "TOOL_HISTORY_MARKER_FROM_PROVIDER_A");
  const toolResultMessage = messages.find((message) =>
    message?.role === "user"
    && Array.isArray(message.content)
    && message.content.some((block) =>
      block?.type === "tool_result"
      && block.tool_use_id === "call_provider_a_tool_history"
      && /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/.test(String(block.content || ""))
    )
  );
  assert.ok(toolResultMessage, "Anthropic history is missing paired tool_result");
}

function createFakeOpenAiProvider({ providerName, model, answerPrefix }) {
  return http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : {};
    requests.push({ provider: providerName, path: req.url, headers: req.headers, body });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: model }] }));
      return;
    }
    if (forceAuthFailure) {
      const rejectedKey = providerName === "provider-a"
        ? "sk-fake-secret"
        : providerName === "provider-d"
        ? "sk-openai-return-secret"
        : "sk-second-secret";
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Bearer ${rejectedKey} was rejected` } }));
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (/turn-tool-call/.test(latestUserText(body)) && /provider_tool_marker/.test(JSON.stringify(body.tools || []))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `chatcmpl_${providerName}_tool_history`,
        object: "chat.completion",
        created: 1,
        model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_provider_a_tool_history",
              type: "function",
              function: {
                name: "provider_tool_marker",
                arguments: JSON.stringify({ marker: "TOOL_HISTORY_MARKER_FROM_PROVIDER_A" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }));
      return;
    }
    const answer = providerAnswerFor(body, answerPrefix);
    const answerTurn = answer.match(/TURN_(\d+)/)?.[1] || "compat";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `chatcmpl_${providerName}_${answerTurn}`,
      object: "chat.completion",
      created: 1,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: answer },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }));
  });
}

function createFakeAnthropicProvider({ providerName, model, answerPrefix }) {
  return http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : {};
    requests.push({ provider: providerName, path: req.url, headers: req.headers, body });
    if (forceAuthFailure) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "x-api-key sk-anthropic-secret was rejected" } }));
      return;
    }
    if (req.url !== "/v1/messages") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const answer = providerAnswerFor(body, answerPrefix);
    const answerTurn = answer.match(/TURN_(\d+)/)?.[1] || "compat";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `msg_${providerName}_${answerTurn}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: answer }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 5 },
    }));
  });
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

async function stopTranslator() {
  if (!translator || translator.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => resolveStop(), 5_000);
    translator.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    translator.kill();
  });
}

function writeReport(payload) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const latest = resolve(reportRoot, "latest-third-party-provider.json");
  const history = resolve(reportRoot, `${stamp}-third-party-provider.json`);
  mkdirSync(reportRoot, { recursive: true });
  const text = JSON.stringify({ ...payload, report: { latest, history } });
  writeJsonReportAtomic(latest, history, text);
  return { latest, history };
}

function writeTextAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    JSON.parse(readFileSync(tmp, "utf8"));
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

function writeJsonReportAtomic(latest, history, text) {
  writeTextAtomic(history, text);
  writeTextAtomic(latest, text);
}

async function main() {
  upstream = createFakeOpenAiProvider({ providerName: "provider-a", model: "fake-gpt-4.1", answerPrefix: "PROVIDER" });
  upstreamB = createFakeOpenAiProvider({ providerName: "provider-b", model: "fake-gpt-4.2", answerPrefix: "PROVIDER_B" });
  upstreamC = createFakeAnthropicProvider({ providerName: "provider-c", model: "fake-claude-4.1", answerPrefix: "PROVIDER_C" });
  upstreamD = createFakeOpenAiProvider({ providerName: "provider-d", model: "fake-gpt-4.3", answerPrefix: "PROVIDER_D" });
  const upstreamPort = await listen(upstream);
  const upstreamBPort = await listen(upstreamB);
  const upstreamCPort = await listen(upstreamC);
  const upstreamDPort = await listen(upstreamD);
  const translatorProbe = http.createServer();
  const translatorPort = await listen(translatorProbe);
  await close(translatorProbe);
  const translatorUrl = `http://127.0.0.1:${translatorPort}`;
  const upstreamFullUrl = `http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
  const upstreamBFullUrl = `http://127.0.0.1:${upstreamBPort}/v1/chat/completions`;
  const upstreamCFullUrl = `http://127.0.0.1:${upstreamCPort}/v1/messages`;
  const upstreamDFullUrl = `http://127.0.0.1:${upstreamDPort}/v1/chat/completions`;
  const profilePath = join(stateRoot, "provider-profile.json");
  let runtimeProtocol = "openai-compatible";
  let runtimeUpstreamUrl = upstreamFullUrl;
  let runtimeModel = "fake-gpt-4.1";
  let runtimeApiKey = "sk-fake-secret";
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

  const startTranslator = () => {
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
        UPSTREAM_PROTOCOL: runtimeProtocol,
        UPSTREAM_URL: runtimeUpstreamUrl,
        UPSTREAM_MODEL: runtimeModel,
        UPSTREAM_API_KEY: runtimeApiKey,
        TRANSLATOR_PROFILE_PATH: profilePath,
        DEEPCODEX_STATE_ROOT: stateRoot,
        CODEX_HOME_DIR: join(stateRoot, "codex-home-deepseek-app"),
        TRANSLATOR_NATIVE_STREAMING: "0",
        TRANSLATOR_CAP_INTERNAL_WEB_TOOLS: "0",
      },
    });
  };

  startTranslator();

  const health = await waitForHealth(translatorUrl);
  assert.equal(health.upstreamProfile.mode, "third-party");
  assert.equal(health.upstreamProfile.protocol, "openai-compatible");
  assert.equal(health.upstreamProfile.model, "fake-gpt-4.1");

  const models = await getJson(`${translatorUrl}/v1/models`);
  assert.deepEqual(models.data.map((model) => model.id), ["fake-gpt-4.1"]);

  async function postResponse(body) {
    const text = await fetch(`${translatorUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.text());
    return { text, response: responseJsonFromText(text) };
  }

  const firstResult = await postResponse({
    model: "fake-gpt-4.1",
    stream: false,
    input: "turn-1 user asks alpha",
  });
  assert.match(firstResult.text, /PROVIDER_HISTORY_TURN_1/);
  const first = firstResult.response;
  assert.equal(textFromResponse(first), "PROVIDER_HISTORY_TURN_1");

  const secondResult = await postResponse({
    model: "gemini-pro-agent",
    stream: false,
    previous_response_id: first.id,
    input: "turn-2 user asks beta",
  });
  assert.match(secondResult.text, /PROVIDER_HISTORY_TURN_2/);
  const second = secondResult.response;
  assert.equal(second.previous_response_id, first.id);
  assert.equal(textFromResponse(second), "PROVIDER_HISTORY_TURN_2");

  const thirdResult = await postResponse({
    model: "fake-gpt-4.1",
    stream: false,
    previous_response_id: second.id,
    input: "turn-3 user asks gamma",
  });
  assert.match(thirdResult.text, /PROVIDER_HISTORY_TURN_3/);
  const third = thirdResult.response;
  assert.equal(third.previous_response_id, second.id);
  assert.equal(textFromResponse(third), "PROVIDER_HISTORY_TURN_3");

  const fourthResult = await postResponse({
    model: "gemini-3.5-flash-low",
    stream: false,
    previous_response_id: third.id,
    input: "turn-4 user asks delta",
  });
  assert.match(fourthResult.text, /PROVIDER_HISTORY_TURN_4/);
  const fourth = fourthResult.response;
  assert.equal(fourth.previous_response_id, third.id);
  assert.equal(textFromResponse(fourth), "PROVIDER_HISTORY_TURN_4");

  const chatRequests = requests.filter((request) => request.path === "/v1/chat/completions");
  assert.ok(chatRequests.length >= 4);
  const [firstChat, secondChat, thirdChat, fourthChat] = chatRequests;
  assert.equal(firstChat.headers.authorization, "Bearer sk-fake-secret");
  assert.equal(firstChat.body.model, "fake-gpt-4.1");
  assert.equal(secondChat.body.model, "fake-gpt-4.1");
  assert.equal(thirdChat.body.model, "fake-gpt-4.1");
  assert.equal(fourthChat.body.model, "fake-gpt-4.1");
  assert.match(requestText(secondChat.body), /turn-1 user asks alpha/);
  assert.match(requestText(secondChat.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(thirdChat.body), /turn-1 user asks alpha/);
  assert.match(requestText(thirdChat.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(thirdChat.body), /turn-2 user asks beta/);
  assert.match(requestText(thirdChat.body), /PROVIDER_HISTORY_TURN_2/);
  assert.match(requestText(fourthChat.body), /turn-1 user asks alpha/);
  assert.match(requestText(fourthChat.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(fourthChat.body), /turn-2 user asks beta/);
  assert.match(requestText(fourthChat.body), /PROVIDER_HISTORY_TURN_2/);
  assert.match(requestText(fourthChat.body), /turn-3 user asks gamma/);
  assert.match(requestText(fourthChat.body), /PROVIDER_HISTORY_TURN_3/);

  const toolCallResult = await postResponse({
    model: "fake-gpt-4.1",
    stream: false,
    previous_response_id: fourth.id,
    input: "turn-tool-call user asks provider tool marker",
    tools: [{
      type: "function",
      name: "provider_tool_marker",
      description: "Records a marker used to prove tool history survives provider switches.",
      parameters: {
        type: "object",
        properties: {
          marker: { type: "string" },
        },
        required: ["marker"],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: "function", function: { name: "provider_tool_marker" } },
  });
  const toolCallResponse = toolCallResult.response;
  const providerToolCalls = toolCallOutputItems(toolCallResponse);
  assert.equal(providerToolCalls.length, 1);
  const providerToolCall = providerToolCalls[0];
  assert.equal(providerToolCall.call_id, "call_provider_a_tool_history");
  assert.equal(providerToolCall.name, "provider_tool_marker");
  assert.match(providerToolCall.arguments || providerToolCall.input || "", /TOOL_HISTORY_MARKER_FROM_PROVIDER_A/);
  const toolCallChat = requests.filter((request) => request.path === "/v1/chat/completions").at(-1);
  assert.equal(toolCallChat.body.model, "fake-gpt-4.1");
  assert.match(requestText(toolCallChat.body), /turn-4 user asks delta/);
  assert.match(requestText(toolCallChat.body), /PROVIDER_HISTORY_TURN_4/);
  assert.match(JSON.stringify(toolCallChat.body.tools || []), /provider_tool_marker/);

  const toolOutputResult = await postResponse({
    model: "fake-gpt-4.1",
    stream: false,
    previous_response_id: toolCallResponse.id,
    input: [{
      type: "function_call_output",
      call_id: providerToolCall.call_id,
      output: "TOOL_HISTORY_RESULT_FROM_PROVIDER_A",
    }],
  });
  assert.match(toolOutputResult.text, /PROVIDER_THIRD_PARTY_PROVIDER_OK/);
  const toolOutputResponse = toolOutputResult.response;
  assert.equal(toolOutputResponse.previous_response_id, toolCallResponse.id);
  assert.equal(textFromResponse(toolOutputResponse), "PROVIDER_THIRD_PARTY_PROVIDER_OK");
  const toolOutputChat = requests.filter((request) => request.path === "/v1/chat/completions").at(-1);
  assert.match(requestText(toolOutputChat.body), /provider_tool_marker/);
  assert.match(requestText(toolOutputChat.body), /TOOL_HISTORY_MARKER_FROM_PROVIDER_A/);
  assert.match(requestText(toolOutputChat.body), /call_provider_a_tool_history/);
  assert.match(requestText(toolOutputChat.body), /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);

  const responseHistoryPath = join(stateRoot, "response-history.json");
  const responseHistoryBefore = readFileSync(responseHistoryPath, "utf8");
  assert.match(responseHistoryBefore, new RegExp(fourth.id));
  assert.match(responseHistoryBefore, new RegExp(toolCallResponse.id));
  assert.match(responseHistoryBefore, new RegExp(toolOutputResponse.id));
  assert.match(responseHistoryBefore, /provider_tool_marker/);
  assert.match(responseHistoryBefore, /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);

  const chatCompatText = await fetch(`${translatorUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-gpt-4.1", messages: [{ role: "user", content: "plain chat compat" }] }),
  }).then((response) => response.text());
  assert.match(chatCompatText, /THIRD_PARTY_PROVIDER_OK/);

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

  const fifthAfterSaveResult = await postResponse({
    model: "gemini-3-flash-agent",
    stream: false,
    previous_response_id: toolOutputResponse.id,
    input: "turn-5 user asks epsilon after provider save",
  });
  assert.match(fifthAfterSaveResult.text, /PROVIDER_HISTORY_TURN_5/);
  const fifthAfterSave = fifthAfterSaveResult.response;
  assert.equal(fifthAfterSave.previous_response_id, toolOutputResponse.id);
  assert.equal(textFromResponse(fifthAfterSave), "PROVIDER_HISTORY_TURN_5");

  const fifthChat = requests.filter((request) => request.path === "/v1/chat/completions").at(-1);
  assert.equal(fifthChat.body.model, "fake-gpt-4.1");
  assert.match(requestText(fifthChat.body), /turn-1 user asks alpha/);
  assert.match(requestText(fifthChat.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(fifthChat.body), /turn-2 user asks beta/);
  assert.match(requestText(fifthChat.body), /PROVIDER_HISTORY_TURN_2/);
  assert.match(requestText(fifthChat.body), /turn-3 user asks gamma/);
  assert.match(requestText(fifthChat.body), /PROVIDER_HISTORY_TURN_3/);
  assert.match(requestText(fifthChat.body), /turn-4 user asks delta/);
  assert.match(requestText(fifthChat.body), /PROVIDER_HISTORY_TURN_4/);
  assert.match(requestText(fifthChat.body), /provider_tool_marker/);
  assert.match(requestText(fifthChat.body), /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);
  assertOpenAiToolHistory(fifthChat.body);
  const responseHistoryAfterSaveContinuation = readFileSync(responseHistoryPath, "utf8");
  assert.match(responseHistoryAfterSaveContinuation, new RegExp(fifthAfterSave.id));

  const routeAfterSaveContinuation = await getJson(`${translatorUrl}/anticodex/model-routes`);
  assert.equal(routeAfterSaveContinuation.latest.transport, "upstream-provider");
  assert.equal(routeAfterSaveContinuation.latest.providerProtocol, "openai-compatible");
  assert.equal(routeAfterSaveContinuation.latest.requestedModel, "fake-gpt-4.1");
  assert.equal(routeAfterSaveContinuation.latest.resolvedModel, "fake-gpt-4.1");

  await stopTranslator();
  startTranslator();
  const healthAfterRestart = await waitForHealth(translatorUrl);
  assert.equal(healthAfterRestart.upstreamProfile.mode, "third-party");
  assert.equal(healthAfterRestart.upstreamProfile.protocol, "openai-compatible");
  assert.equal(healthAfterRestart.upstreamProfile.model, "fake-gpt-4.1");

  const sixthAfterRestartResult = await postResponse({
    model: "gemini-pro-agent",
    stream: false,
    previous_response_id: fifthAfterSave.id,
    input: "turn-6 user asks zeta after provider restart",
  });
  assert.match(sixthAfterRestartResult.text, /PROVIDER_HISTORY_TURN_6/);
  const sixthAfterRestart = sixthAfterRestartResult.response;
  assert.equal(sixthAfterRestart.previous_response_id, fifthAfterSave.id);
  assert.equal(textFromResponse(sixthAfterRestart), "PROVIDER_HISTORY_TURN_6");
  const sixthChat = requests.filter((request) => request.path === "/v1/chat/completions").at(-1);
  assert.equal(sixthChat.body.model, "fake-gpt-4.1");
  assert.match(requestText(sixthChat.body), /turn-1 user asks alpha/);
  assert.match(requestText(sixthChat.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(sixthChat.body), /turn-5 user asks epsilon after provider save/);
  assert.match(requestText(sixthChat.body), /PROVIDER_HISTORY_TURN_5/);
  assert.match(requestText(sixthChat.body), /provider_tool_marker/);
  assert.match(requestText(sixthChat.body), /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);
  assertOpenAiToolHistory(sixthChat.body);
  const responseHistoryAfterRestartContinuation = readFileSync(responseHistoryPath, "utf8");
  assert.match(responseHistoryAfterRestartContinuation, new RegExp(sixthAfterRestart.id));

  const restartBootstrap = await getJson(`${translatorUrl}/anticodex/manager/bootstrap`, { headers: managerHeaders });
  const restartedAuthedHeaders = {
    ...authedHeaders,
    "x-anticodex-manager-token": restartBootstrap.token,
  };

  const providerBSwitchConnection = await getJson(`${translatorUrl}/anticodex/upstream-test`, {
    method: "POST",
    headers: restartedAuthedHeaders,
    body: JSON.stringify({
      protocol: "openai-compatible",
      baseUrl: upstreamBFullUrl,
      model: "fake-gpt-4.2",
      apiKey: "sk-second-secret",
      timeoutMs: 10_000,
    }),
  });
  assert.equal(providerBSwitchConnection.ok, true);

  const providerBSavedResponse = await fetch(`${translatorUrl}/anticodex/upstream-profile`, {
    method: "POST",
    headers: restartedAuthedHeaders,
    body: JSON.stringify({
      mode: "third-party",
      protocol: "openai-compatible",
      baseUrl: upstreamBFullUrl,
      model: "fake-gpt-4.2",
      apiKey: "sk-second-secret",
      stages: providerBSwitchConnection.stages,
    }),
  });
  const providerBSavedText = await providerBSavedResponse.text();
  assert.equal(providerBSavedResponse.status, 200, providerBSavedText);
  const providerBSaved = responseJsonFromText(providerBSavedText);
  assert.equal(providerBSaved.ok, true);
  assert.equal(providerBSaved.restartRequired, true);
  assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryAfterRestartContinuation);
  assert.doesNotMatch(readFileSync(join(stateRoot, "upstream-profile.json"), "utf8"), /sk-second-secret/);

  runtimeUpstreamUrl = upstreamBFullUrl;
  runtimeModel = "fake-gpt-4.2";
  runtimeApiKey = "sk-second-secret";
  await stopTranslator();
  startTranslator();
  const healthAfterProviderSwitch = await waitForHealth(translatorUrl);
  assert.equal(healthAfterProviderSwitch.upstreamProfile.mode, "third-party");
  assert.equal(healthAfterProviderSwitch.upstreamProfile.protocol, "openai-compatible");
  assert.equal(healthAfterProviderSwitch.upstreamProfile.model, "fake-gpt-4.2");

  const seventhAfterProviderSwitchResult = await postResponse({
    model: "gemini-pro-agent",
    stream: false,
    previous_response_id: sixthAfterRestart.id,
    input: "turn-7 user asks eta after provider switch",
  });
  assert.match(seventhAfterProviderSwitchResult.text, /PROVIDER_B_HISTORY_TURN_7/);
  const seventhAfterProviderSwitch = seventhAfterProviderSwitchResult.response;
  assert.equal(seventhAfterProviderSwitch.previous_response_id, sixthAfterRestart.id);
  assert.equal(textFromResponse(seventhAfterProviderSwitch), "PROVIDER_B_HISTORY_TURN_7");
  const seventhChat = requests.filter((request) => request.provider === "provider-b" && request.path === "/v1/chat/completions").at(-1);
  assert.equal(seventhChat.body.model, "fake-gpt-4.2");
  assert.equal(seventhChat.headers.authorization, "Bearer sk-second-secret");
  assert.match(requestText(seventhChat.body), /turn-1 user asks alpha/);
  assert.match(requestText(seventhChat.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(seventhChat.body), /turn-5 user asks epsilon after provider save/);
  assert.match(requestText(seventhChat.body), /PROVIDER_HISTORY_TURN_5/);
  assert.match(requestText(seventhChat.body), /turn-6 user asks zeta after provider restart/);
  assert.match(requestText(seventhChat.body), /PROVIDER_HISTORY_TURN_6/);
  assert.match(requestText(seventhChat.body), /provider_tool_marker/);
  assert.match(requestText(seventhChat.body), /TOOL_HISTORY_MARKER_FROM_PROVIDER_A/);
  assert.match(requestText(seventhChat.body), /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);
  assertOpenAiToolHistory(seventhChat.body);
  const responseHistoryAfterProviderSwitchContinuation = readFileSync(responseHistoryPath, "utf8");
  assert.match(responseHistoryAfterProviderSwitchContinuation, new RegExp(seventhAfterProviderSwitch.id));

  const providerSwitchBootstrap = await getJson(`${translatorUrl}/anticodex/manager/bootstrap`, { headers: managerHeaders });
  const providerSwitchAuthedHeaders = {
    ...authedHeaders,
    "x-anticodex-manager-token": providerSwitchBootstrap.token,
  };

  const anthropicSwitchConnection = await getJson(`${translatorUrl}/anticodex/upstream-test`, {
    method: "POST",
    headers: providerSwitchAuthedHeaders,
    body: JSON.stringify({
      protocol: "anthropic",
      baseUrl: upstreamCFullUrl,
      model: "fake-claude-4.1",
      apiKey: "sk-anthropic-secret",
      timeoutMs: 10_000,
    }),
  });
  assert.equal(anthropicSwitchConnection.ok, true);

  const anthropicSavedResponse = await fetch(`${translatorUrl}/anticodex/upstream-profile`, {
    method: "POST",
    headers: providerSwitchAuthedHeaders,
    body: JSON.stringify({
      mode: "third-party",
      protocol: "anthropic",
      baseUrl: upstreamCFullUrl,
      model: "fake-claude-4.1",
      apiKey: "sk-anthropic-secret",
      stages: anthropicSwitchConnection.stages,
    }),
  });
  const anthropicSavedText = await anthropicSavedResponse.text();
  assert.equal(anthropicSavedResponse.status, 200, anthropicSavedText);
  const anthropicSaved = responseJsonFromText(anthropicSavedText);
  assert.equal(anthropicSaved.ok, true);
  assert.equal(anthropicSaved.restartRequired, true);
  assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryAfterProviderSwitchContinuation);
  assert.doesNotMatch(readFileSync(join(stateRoot, "upstream-profile.json"), "utf8"), /sk-anthropic-secret/);

  runtimeProtocol = "anthropic";
  runtimeUpstreamUrl = upstreamCFullUrl;
  runtimeModel = "fake-claude-4.1";
  runtimeApiKey = "sk-anthropic-secret";
  await stopTranslator();
  startTranslator();
  const healthAfterProtocolSwitch = await waitForHealth(translatorUrl);
  assert.equal(healthAfterProtocolSwitch.upstreamProfile.mode, "third-party");
  assert.equal(healthAfterProtocolSwitch.upstreamProfile.protocol, "anthropic");
  assert.equal(healthAfterProtocolSwitch.upstreamProfile.model, "fake-claude-4.1");

  const eighthAfterProtocolSwitchResult = await postResponse({
    model: "gemini-pro-agent",
    stream: false,
    previous_response_id: seventhAfterProviderSwitch.id,
    input: "turn-8 user asks theta after protocol switch",
  });
  assert.match(eighthAfterProtocolSwitchResult.text, /PROVIDER_C_HISTORY_TURN_8/);
  const eighthAfterProtocolSwitch = eighthAfterProtocolSwitchResult.response;
  assert.equal(eighthAfterProtocolSwitch.previous_response_id, seventhAfterProviderSwitch.id);
  assert.equal(textFromResponse(eighthAfterProtocolSwitch), "PROVIDER_C_HISTORY_TURN_8");
  const eighthAnthropic = requests.filter((request) => request.provider === "provider-c" && request.path === "/v1/messages").at(-1);
  assert.equal(eighthAnthropic.body.model, "fake-claude-4.1");
  assert.equal(eighthAnthropic.headers["x-api-key"], "sk-anthropic-secret");
  assert.match(requestText(eighthAnthropic.body), /turn-1 user asks alpha/);
  assert.match(requestText(eighthAnthropic.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(eighthAnthropic.body), /turn-6 user asks zeta after provider restart/);
  assert.match(requestText(eighthAnthropic.body), /PROVIDER_HISTORY_TURN_6/);
  assert.match(requestText(eighthAnthropic.body), /turn-7 user asks eta after provider switch/);
  assert.match(requestText(eighthAnthropic.body), /PROVIDER_B_HISTORY_TURN_7/);
  assert.match(requestText(eighthAnthropic.body), /provider_tool_marker/);
  assert.match(requestText(eighthAnthropic.body), /TOOL_HISTORY_MARKER_FROM_PROVIDER_A/);
  assert.match(requestText(eighthAnthropic.body), /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);
  assertAnthropicToolHistory(eighthAnthropic.body);
  const responseHistoryAfterProtocolSwitchContinuation = readFileSync(responseHistoryPath, "utf8");
  assert.match(responseHistoryAfterProtocolSwitchContinuation, new RegExp(eighthAfterProtocolSwitch.id));

  const protocolSwitchBootstrap = await getJson(`${translatorUrl}/anticodex/manager/bootstrap`, { headers: managerHeaders });
  const protocolSwitchAuthedHeaders = {
    ...authedHeaders,
    "x-anticodex-manager-token": protocolSwitchBootstrap.token,
  };

  const openAiReturnConnection = await getJson(`${translatorUrl}/anticodex/upstream-test`, {
    method: "POST",
    headers: protocolSwitchAuthedHeaders,
    body: JSON.stringify({
      protocol: "openai-compatible",
      baseUrl: upstreamDFullUrl,
      model: "fake-gpt-4.3",
      apiKey: "sk-openai-return-secret",
      timeoutMs: 10_000,
    }),
  });
  assert.equal(openAiReturnConnection.ok, true);

  const openAiReturnSavedResponse = await fetch(`${translatorUrl}/anticodex/upstream-profile`, {
    method: "POST",
    headers: protocolSwitchAuthedHeaders,
    body: JSON.stringify({
      mode: "third-party",
      protocol: "openai-compatible",
      baseUrl: upstreamDFullUrl,
      model: "fake-gpt-4.3",
      apiKey: "sk-openai-return-secret",
      stages: openAiReturnConnection.stages,
    }),
  });
  const openAiReturnSavedText = await openAiReturnSavedResponse.text();
  assert.equal(openAiReturnSavedResponse.status, 200, openAiReturnSavedText);
  const openAiReturnSaved = responseJsonFromText(openAiReturnSavedText);
  assert.equal(openAiReturnSaved.ok, true);
  assert.equal(openAiReturnSaved.restartRequired, true);
  assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryAfterProtocolSwitchContinuation);
  assert.doesNotMatch(readFileSync(join(stateRoot, "upstream-profile.json"), "utf8"), /sk-openai-return-secret/);

  runtimeProtocol = "openai-compatible";
  runtimeUpstreamUrl = upstreamDFullUrl;
  runtimeModel = "fake-gpt-4.3";
  runtimeApiKey = "sk-openai-return-secret";
  await stopTranslator();
  startTranslator();
  const healthAfterReverseProtocolSwitch = await waitForHealth(translatorUrl);
  assert.equal(healthAfterReverseProtocolSwitch.upstreamProfile.mode, "third-party");
  assert.equal(healthAfterReverseProtocolSwitch.upstreamProfile.protocol, "openai-compatible");
  assert.equal(healthAfterReverseProtocolSwitch.upstreamProfile.model, "fake-gpt-4.3");

  const ninthAfterReverseProtocolSwitchResult = await postResponse({
    model: "gemini-pro-agent",
    stream: false,
    previous_response_id: eighthAfterProtocolSwitch.id,
    input: "turn-9 user asks iota after reverse protocol switch",
  });
  assert.match(ninthAfterReverseProtocolSwitchResult.text, /PROVIDER_D_HISTORY_TURN_9/);
  const ninthAfterReverseProtocolSwitch = ninthAfterReverseProtocolSwitchResult.response;
  assert.equal(ninthAfterReverseProtocolSwitch.previous_response_id, eighthAfterProtocolSwitch.id);
  assert.equal(textFromResponse(ninthAfterReverseProtocolSwitch), "PROVIDER_D_HISTORY_TURN_9");
  const ninthChat = requests.filter((request) => request.provider === "provider-d" && request.path === "/v1/chat/completions").at(-1);
  assert.equal(ninthChat.body.model, "fake-gpt-4.3");
  assert.equal(ninthChat.headers.authorization, "Bearer sk-openai-return-secret");
  assert.match(requestText(ninthChat.body), /turn-1 user asks alpha/);
  assert.match(requestText(ninthChat.body), /PROVIDER_HISTORY_TURN_1/);
  assert.match(requestText(ninthChat.body), /turn-8 user asks theta after protocol switch/);
  assert.match(requestText(ninthChat.body), /PROVIDER_C_HISTORY_TURN_8/);
  assert.match(requestText(ninthChat.body), /provider_tool_marker/);
  assert.match(requestText(ninthChat.body), /TOOL_HISTORY_MARKER_FROM_PROVIDER_A/);
  assert.match(requestText(ninthChat.body), /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/);
  assertOpenAiToolHistory(ninthChat.body);
  const responseHistoryAfterReverseProtocolSwitchContinuation = readFileSync(responseHistoryPath, "utf8");
  assert.match(responseHistoryAfterReverseProtocolSwitchContinuation, new RegExp(ninthAfterReverseProtocolSwitch.id));

  const reverseProtocolSwitchBootstrap = await getJson(`${translatorUrl}/anticodex/manager/bootstrap`, { headers: managerHeaders });
  const reverseProtocolSwitchAuthedHeaders = {
    ...authedHeaders,
    "x-anticodex-manager-token": reverseProtocolSwitchBootstrap.token,
  };

  const restoredResponse = await fetch(`${translatorUrl}/anticodex/upstream-profile`, {
    method: "POST",
    headers: reverseProtocolSwitchAuthedHeaders,
    body: JSON.stringify({ mode: "antigravity" }),
  });
  const restoredText = await restoredResponse.text();
  assert.equal(restoredResponse.status, 200, restoredText);
  const restored = responseJsonFromText(restoredText);
  assert.equal(restored.ok, true);
  assert.equal(restored.restartRequired, true);
  assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryAfterReverseProtocolSwitchContinuation);

  const routeAudit = await getJson(`${translatorUrl}/anticodex/model-routes`);
  assert.equal(routeAudit.latest.transport, "upstream-provider");
  assert.equal(routeAudit.latest.providerProtocol, "openai-compatible");
  assert.equal(routeAudit.latest.resolvedModel, "fake-gpt-4.3");
  assert.ok((routeAudit.entries || []).every((entry) => ["fake-gpt-4.1", "fake-gpt-4.2", "fake-claude-4.1", "fake-gpt-4.3"].includes(entry.resolvedModel)));

  const publicProfile = await getJson(`${translatorUrl}/anticodex/upstream-profile`, { headers: managerHeaders });
  const secretPattern = /sk-fake-secret|sk-save-secret|sk-second-secret|sk-anthropic-secret|sk-openai-return-secret/;
  assert.doesNotMatch(openAiReturnSavedText, secretPattern);
  assert.doesNotMatch(anthropicSavedText, secretPattern);
  assert.doesNotMatch(providerBSavedText, secretPattern);
  assert.doesNotMatch(savedText, secretPattern);
  assert.doesNotMatch(restoredText, secretPattern);
  assert.doesNotMatch(JSON.stringify(publicProfile), secretPattern);
  assert.doesNotMatch(JSON.stringify(routeAudit), /gemini-pro-agent|gemini-3\.5-flash-low|gemini-3-flash-agent/);

  const providerChatRequests = requests.filter((request) => request.path === "/v1/chat/completions");
  const providerAChatRequests = providerChatRequests.filter((request) => request.provider === "provider-a");
  const providerBChatRequests = providerChatRequests.filter((request) => request.provider === "provider-b");
  const providerDChatRequests = providerChatRequests.filter((request) => request.provider === "provider-d");
  assert.ok(providerAChatRequests.every((request) => request.body.model === "fake-gpt-4.1"));
  assert.ok(providerBChatRequests.every((request) => request.body.model === "fake-gpt-4.2"));
  assert.ok(providerDChatRequests.every((request) => request.body.model === "fake-gpt-4.3"));
  const anthropicMessageRequests = requests.filter((request) => request.provider === "provider-c" && request.path === "/v1/messages");
  assert.ok(anthropicMessageRequests.every((request) => request.body.model === "fake-claude-4.1"));

  forceAuthFailure = true;
  const responseHistoryBeforeAuthFailure = readFileSync(responseHistoryPath, "utf8");
  const failedResponse = await fetch(`${translatorUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-gpt-4.1", stream: false, input: "fail safely" }),
  });
  const failedText = await failedResponse.text();
  assert.equal(failedResponse.status, 401);
  assert.match(failedText, /auth_error/);
  assert.doesNotMatch(failedText, secretPattern);
  assert.equal(readFileSync(responseHistoryPath, "utf8"), responseHistoryBeforeAuthFailure);

  return {
    ok: failures.length === 0,
    failures,
    elapsedMs: Date.now() - startedAt,
    mode: "third-party",
    protocol: "openai-compatible",
    model: "fake-gpt-4.3",
    upstreamFullUrlAccepted: true,
    unauthorizedManagerBlocked: true,
    savedWithoutHistoryLoss: true,
    restoredAntigravityWithoutHistoryLoss: true,
    restartedProviderWithoutHistoryLoss: true,
    switchedProviderWithoutHistoryLoss: true,
    crossProtocolWithoutHistoryLoss: true,
    reverseCrossProtocolWithoutHistoryLoss: true,
    secretsRedacted: true,
    multiTurnHistory: {
      turns: 9,
      toolHistoryTurns: 2,
      antigravityModelFallbacks: ["gemini-pro-agent", "gemini-3.5-flash-low", "gemini-3-flash-agent"],
      providerModelUsedForEveryTurn: [firstChat, secondChat, thirdChat, fourthChat, fifthChat, sixthChat].every((request) => request.body.model === "fake-gpt-4.1"),
      toolHistory: {
        toolCallResponseId: toolCallResponse.id,
        toolOutputResponseId: toolOutputResponse.id,
        callId: providerToolCall.call_id,
        name: providerToolCall.name,
        outputMarker: "TOOL_HISTORY_RESULT_FROM_PROVIDER_A",
        savedContinuationPreviousResponseId: fifthAfterSave.previous_response_id,
        restartPreservesOpenAiToolPair: /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/.test(requestText(sixthChat.body)),
        providerSwitchPreservesOpenAiToolPair: /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/.test(requestText(seventhChat.body)),
        protocolSwitchPreservesAnthropicToolPair: /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/.test(requestText(eighthAnthropic.body)),
        reverseProtocolSwitchPreservesOpenAiToolPair: /TOOL_HISTORY_RESULT_FROM_PROVIDER_A/.test(requestText(ninthChat.body)),
      },
      providerSwitch: {
        from: "fake-gpt-4.1",
        to: "fake-gpt-4.2",
        continuationPreviousResponseId: seventhAfterProviderSwitch.previous_response_id,
        requestReachedSecondProvider: seventhChat.provider === "provider-b",
      },
      protocolSwitch: {
        from: "openai-compatible",
        to: "anthropic",
        provider: "provider-c",
        model: "fake-claude-4.1",
        continuationPreviousResponseId: eighthAfterProtocolSwitch.previous_response_id,
        requestReachedAnthropicProvider: eighthAnthropic.provider === "provider-c",
      },
      reverseProtocolSwitch: {
        from: "anthropic",
        to: "openai-compatible",
        provider: "provider-d",
        model: "fake-gpt-4.3",
        continuationPreviousResponseId: ninthAfterReverseProtocolSwitch.previous_response_id,
        requestReachedOpenAiCompatibleProvider: ninthChat.provider === "provider-d",
      },
      fourthTurnContextIncludesPriorTurns: /turn-1 user asks alpha/.test(requestText(fourthChat.body))
        && /PROVIDER_HISTORY_TURN_1/.test(requestText(fourthChat.body))
        && /turn-2 user asks beta/.test(requestText(fourthChat.body))
        && /PROVIDER_HISTORY_TURN_2/.test(requestText(fourthChat.body))
        && /turn-3 user asks gamma/.test(requestText(fourthChat.body))
        && /PROVIDER_HISTORY_TURN_3/.test(requestText(fourthChat.body)),
      fifthAfterSavePreservesHistory: /turn-1 user asks alpha/.test(requestText(fifthChat.body))
        && /PROVIDER_HISTORY_TURN_1/.test(requestText(fifthChat.body))
        && /turn-4 user asks delta/.test(requestText(fifthChat.body))
        && /PROVIDER_HISTORY_TURN_4/.test(requestText(fifthChat.body)),
      seventhAfterProviderSwitchPreservesHistory: /turn-1 user asks alpha/.test(requestText(seventhChat.body))
        && /PROVIDER_HISTORY_TURN_1/.test(requestText(seventhChat.body))
        && /turn-6 user asks zeta after provider restart/.test(requestText(seventhChat.body))
        && /PROVIDER_HISTORY_TURN_6/.test(requestText(seventhChat.body)),
      eighthAfterProtocolSwitchPreservesHistory: /turn-1 user asks alpha/.test(requestText(eighthAnthropic.body))
        && /PROVIDER_HISTORY_TURN_1/.test(requestText(eighthAnthropic.body))
        && /turn-7 user asks eta after provider switch/.test(requestText(eighthAnthropic.body))
        && /PROVIDER_B_HISTORY_TURN_7/.test(requestText(eighthAnthropic.body)),
      ninthAfterReverseProtocolSwitchPreservesHistory: /turn-1 user asks alpha/.test(requestText(ninthChat.body))
        && /PROVIDER_HISTORY_TURN_1/.test(requestText(ninthChat.body))
        && /turn-8 user asks theta after protocol switch/.test(requestText(ninthChat.body))
        && /PROVIDER_C_HISTORY_TURN_8/.test(requestText(ninthChat.body)),
      finalPreviousResponseId: fourth.previous_response_id,
      savedContinuationPreviousResponseId: fifthAfterSave.previous_response_id,
      restartContinuationPreviousResponseId: sixthAfterRestart.previous_response_id,
      providerSwitchContinuationPreviousResponseId: seventhAfterProviderSwitch.previous_response_id,
      protocolSwitchContinuationPreviousResponseId: eighthAfterProtocolSwitch.previous_response_id,
      reverseProtocolSwitchContinuationPreviousResponseId: ninthAfterReverseProtocolSwitch.previous_response_id,
    },
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
  await close(upstreamB);
  await close(upstreamC);
  await close(upstreamD);
  rmSync(stateRoot, { recursive: true, force: true });
}

const reportPaths = writeReport(result);
const reportText = readFileSync(reportPaths.latest, "utf8");
if (/sk-fake-secret|sk-save-secret|sk-second-secret|sk-anthropic-secret|sk-openai-return-secret/.test(reportText)) {
  console.error(JSON.stringify({ ok: false, failures: ["third-party provider report leaked an API key"] }));
  process.exit(1);
}
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
