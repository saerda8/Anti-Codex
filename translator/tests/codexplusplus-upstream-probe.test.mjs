import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexPlusPlusProbeRequest,
  normalizeCodexPlusPlusProbeProfile,
  testCodexPlusPlusUpstreamConnection,
} from "../provider/codexplusplus-upstream-probe.mjs";

test("probe profile accepts only Chat Completions and Responses", () => {
  assert.equal(normalizeCodexPlusPlusProbeProfile({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "secret",
  }).protocol, "chatCompletions");
  assert.equal(normalizeCodexPlusPlusProbeProfile({
    protocol: "responses",
    baseUrl: "https://api.example.test/v1",
    model: "response-model",
    apiKey: "secret",
  }).protocol, "responses");
  assert.throws(() => normalizeCodexPlusPlusProbeProfile({
    protocol: "anthropic",
    baseUrl: "https://api.example.test/v1",
    model: "model",
    apiKey: "secret",
  }), /Chat Completions or Responses/);
});

test("probe requests use the protocol-native endpoint and body", () => {
  const chat = buildCodexPlusPlusProbeRequest({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "secret",
  });
  assert.equal(chat.url, "https://api.example.test/v1/chat/completions");
  assert.equal(chat.body.model, "chat-model");
  assert.deepEqual(chat.body.messages, [{ role: "user", content: "Reply with OK only." }]);

  const responses = buildCodexPlusPlusProbeRequest({
    protocol: "responses",
    baseUrl: "https://api.example.test/v1/responses",
    model: "response-model",
    apiKey: "secret",
  });
  assert.equal(responses.url, "https://api.example.test/v1/responses");
  assert.equal(responses.body.input, "Reply with OK only.");
  assert.equal(responses.body.max_output_tokens, 8);
});

test("connection probe performs one bounded request and never returns the key", async () => {
  const calls = [];
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "responses",
    baseUrl: "https://api.example.test/v1",
    model: "response-model",
    apiKey: "TOP_SECRET_KEY",
  }, {
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "resp_probe", output_text: "OK" }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/responses");
  assert.equal(calls[0].init.headers.authorization, "Bearer TOP_SECRET_KEY");
  assert.equal(stages.every((stage) => stage.status !== "fail"), true);
  assert.equal(JSON.stringify(stages).includes("TOP_SECRET_KEY"), false);
});

test("connection probe sanitizes provider failures", async () => {
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "FAIL_SECRET_KEY",
  }, {
    fetchImpl: async () => new Response("bad FAIL_SECRET_KEY request", { status: 401 }),
  });
  assert.equal(stages.at(-1).status, "fail");
  assert.equal(JSON.stringify(stages).includes("FAIL_SECRET_KEY"), false);
  assert.match(stages.at(-1).detail, /HTTP 401/);
});

test("connection probe rejects HTTP 200 bodies that do not match the selected protocol", async () => {
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "secret",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ output_text: "not a chat completion" }), { status: 200 }),
  });
  assert.equal(stages.at(-1).status, "fail");
  assert.match(stages.at(-1).detail, /Chat Completions response/i);
});
