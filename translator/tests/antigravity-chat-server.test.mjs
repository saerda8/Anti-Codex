import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { createAntigravityChatAdapter } from "../provider/antigravity-chat-adapter.mjs";
import {
  MAX_CHAT_BODY_BYTES,
  createAntigravityChatServer,
} from "../provider/antigravity-chat-server.mjs";
import { startAntigravityChatProvider } from "../provider/start-antigravity-chat-provider.mjs";

test("provider construction passes the fixed-route bearer into the Chat server", async () => {
  const provider = await startAntigravityChatProvider({
    authToken: "route-generated-secret",
    client: fakeClient([]),
  });
  try {
    assert.equal(provider.authToken, "route-generated-secret");
    const rejected = await fetch(`${provider.url}/models`);
    assert.equal(rejected.status, 401);
    const accepted = await fetch(`${provider.url}/models`, {
      headers: { authorization: "Bearer route-generated-secret" },
    });
    assert.equal(accepted.status, 200);
  } finally {
    await provider.close();
  }
});

test("uses a fresh bearer and a hard 128 MiB request ceiling", async () => {
  const first = await createAntigravityChatServer({ adapter: adapterFor(fakeClient([])) });
  const second = await createAntigravityChatServer({
    adapter: adapterFor(fakeClient([])),
    maxBodyBytes: MAX_CHAT_BODY_BYTES + 1,
  });
  try {
    assert.equal(MAX_CHAT_BODY_BYTES, 128 * 1024 * 1024);
    assert.equal(first.maxBodyBytes, MAX_CHAT_BODY_BYTES);
    assert.equal(second.maxBodyBytes, MAX_CHAT_BODY_BYTES);
    assert.notEqual(first.authToken, second.authToken);
    assert.ok(first.authToken.length >= 32);

    const missing = await fetch(`${first.url}/models`);
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${first.url}/models`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(wrong.status, 401);
    const accepted = await fetch(`${first.url}/models`, {
      headers: { authorization: `Bearer ${first.authToken}` },
    });
    assert.equal(accepted.status, 200);
  } finally {
    await first.close();
    await second.close();
  }
});

test("rejects an authenticated Chat body above the configured bounded limit", async () => {
  const server = await createAntigravityChatServer({
    adapter: adapterFor(fakeClient([])),
    maxBodyBytes: 128,
  });
  try {
    const response = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(256) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test("serves loopback model discovery and non-stream Chat Completions", async () => {
  const client = fakeClient([{ type: "text_delta", delta: "hello" }, { type: "done" }]);
  const adapter = adapterFor(client);
  const server = await createAntigravityChatServer({ adapter });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const modelsResponse = await authorizedFetch(server, "/models");
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json();
    assert.equal(models.object, "list");
    assert.equal(models.data[0].id, "gemini-pro-agent");

    const response = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    const completion = await response.json();
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.choices[0].message.content, "hello");
    assert.equal(completion.choices[0].finish_reason, "stop");
  } finally {
    await server.close();
  }
});

test("serves anonymized account readiness without model traffic", async () => {
  const fingerprint = `sha256:${"b".repeat(64)}`;
  const client = {
    ...fakeClient([]),
    async getReadiness() {
      return {
        signedIn: true,
        accountFingerprint: fingerprint,
        planName: "Google AI Pro",
      };
    },
  };
  const server = await createAntigravityChatServer({ adapter: adapterFor(client) });
  try {
    const response = await authorizedFetch(server, "/account");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      object: "antigravity.account",
      provider: "antigravity",
      signedIn: true,
      identityAvailable: true,
      fingerprint,
      planName: "Google AI Pro",
      tierName: "",
    });
    assert.equal(client.starts?.length ?? 0, 0);
  } finally {
    await server.close();
  }
});

test("streams standard Chat chunks followed by exactly one DONE marker", async () => {
  const client = fakeClient([
    { type: "text_delta", delta: "A" },
    { type: "text_delta", delta: "B" },
    { type: "done" },
  ]);
  const server = await createAntigravityChatServer({ adapter: adapterFor(client) });
  try {
    const response = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({ stream: true })),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const text = await response.text();
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data: "));
    assert.equal(lines.at(-1), "data: [DONE]");
    assert.equal(lines.filter((line) => line === "data: [DONE]").length, 1);
    const chunks = lines.slice(0, -1).map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(chunks.map((chunk) => chunk.choices[0]), [
      { index: 0, delta: { role: "assistant" }, finish_reason: null },
      { index: 0, delta: { content: "A" }, finish_reason: null },
      { index: 0, delta: { content: "B" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]);
  } finally {
    await server.close();
  }
});

test("commits streaming headers after Cascade acceptance without waiting for the first model token", async () => {
  let releaseFirstToken;
  const firstToken = new Promise((resolve) => { releaseFirstToken = resolve; });
  const adapter = {
    async models() {
      return { object: "list", data: [] };
    },
    async complete() {
      throw new Error("not used");
    },
    stream() {
      return (async function* () {
        yield {
          id: "chatcmpl_ready",
          object: "chat.completion.chunk",
          created: 1,
          model: "claude-sonnet-4-6",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        };
        await firstToken;
        yield {
          id: "chatcmpl_ready",
          object: "chat.completion.chunk",
          created: 1,
          model: "claude-sonnet-4-6",
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }],
        };
      }());
    },
  };
  const server = await createAntigravityChatServer({ adapter });
  const responsePromise = authorizedFetch(server, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body({ stream: true })),
  });
  try {
    const headers = await Promise.race([
      responsePromise.then((response) => ({ ready: true, response })),
      new Promise((resolve) => setTimeout(() => resolve({ ready: false, response: null }), 200)),
    ]);
    assert.equal(headers.ready, true);
    assert.equal(headers.response.status, 200);
    assert.match(headers.response.headers.get("content-type"), /^text\/event-stream/);
    releaseFirstToken();
    assert.match(await headers.response.text(), /\"content\":\"done\"/);
  } finally {
    releaseFirstToken();
    await responsePromise.catch(() => {});
    await server.close();
  }
});

test("returns OpenAI-shaped JSON errors before streaming headers", async () => {
  const client = {
    ...fakeClient([]),
    start() {
      return (async function* () {
        throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { statusCode: 429 });
      }());
    },
  };
  const server = await createAntigravityChatServer({ adapter: adapterFor(client) });
  try {
    const response = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.deepEqual(payload, {
      error: {
        message: "RESOURCE_EXHAUSTED",
        type: "server_error",
        code: "quota_exceeded",
      },
    });
  } finally {
    await server.close();
  }
});

test("returns a terminal quota status before opening an empty stream", async () => {
  const client = {
    ...fakeClient([]),
    start() {
      return (async function* () {
        throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { statusCode: 429 });
      }());
    },
  };
  const server = await createAntigravityChatServer({ adapter: adapterFor(client) });
  try {
    const response = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({ stream: true })),
    });
    assert.equal(response.status, 429);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await response.json(), {
      error: {
        message: "RESOURCE_EXHAUSTED",
        type: "server_error",
        code: "quota_exceeded",
      },
    });
  } finally {
    await server.close();
  }
});

test("maps an upstream AbortError before headers without crashing the server", async () => {
  let streamCalls = 0;
  const adapter = {
    async models() {
      return { object: "list", data: [] };
    },
    async complete() {
      throw new DOMException("upstream aborted", "AbortError");
    },
    stream() {
      streamCalls += 1;
      return (async function* () {
        throw new DOMException("upstream aborted", "AbortError");
      }());
    },
  };
  const server = await createAntigravityChatServer({ adapter });
  try {
    const response = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({ stream: true })),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "upstream_error");
    assert.equal(streamCalls, 1);

    const health = await authorizedFetch(server, "/models");
    assert.equal(health.status, 200);
  } finally {
    await server.close();
  }
});

test("malformed native tool arguments return a structured 502 and cancel the continuation", async () => {
  const continuation = { cascadeId: "malformed-http" };
  const cancels = [];
  const client = {
    ...fakeClient([]),
    start() {
      return (async function* () {
        yield {
          type: "tool_calls",
          calls: [{ callId: "call_bad", name: "shell_command", arguments: ["invalid"] }],
          continuation,
        };
      }());
    },
    async cancel(value) {
      cancels.push(value);
    },
  };
  const server = await createAntigravityChatServer({ adapter: adapterFor(client) });
  try {
    const response = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.code, "invalid_cascade_tool_arguments");
    assert.deepEqual(cancels, [continuation]);
  } finally {
    await server.close();
  }
});

test("normal non-stream response close preserves a retained tool continuation", async () => {
  const continuation = { cascadeId: "retained" };
  let firstSignal;
  let resumes = 0;
  const client = {
    ...fakeClient([]),
    start(request) {
      firstSignal = request.signal;
      return (async function* () {
        yield {
          type: "tool_calls",
          calls: [{ callId: "call_http", name: "echo", arguments: { value: 1 } }],
          continuation,
        };
      }());
    },
    resume(receivedContinuation, results) {
      resumes += 1;
      assert.equal(receivedContinuation, continuation);
      assert.deepEqual(results, [{ callId: "call_http", output: "EXACT", isError: false }]);
      return (async function* () {
        yield { type: "text_delta", delta: "resumed" };
        yield { type: "done" };
      }());
    },
  };
  const server = await createAntigravityChatServer({ adapter: adapterFor(client) });
  try {
    const firstResponse = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({
        tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
      })),
    });
    const first = await firstResponse.json();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstSignal.aborted, false);
    const secondResponse = await authorizedFetch(server, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({ messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
        { role: "tool", tool_call_id: "call_http", content: "EXACT" },
      ] })),
    });
    const second = await secondResponse.json();
    assert.equal(second.choices[0].message.content, "resumed");
    assert.equal(resumes, 1);
  } finally {
    await server.close();
  }
});

test("client disconnect aborts the in-flight Cascade request", async () => {
  let observeAbort;
  const aborted = new Promise((resolve) => { observeAbort = resolve; });
  const client = {
    ...fakeClient([]),
    start({ signal }) {
      return (async function* () {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            observeAbort(signal.reason);
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
        yield { type: "done" };
      }());
    },
  };
  const server = await createAntigravityChatServer({ adapter: adapterFor(client) });
  try {
    await new Promise((resolve, reject) => {
      const target = new URL(`${server.url}/chat/completions`);
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${server.authToken}`,
          "content-type": "application/json",
        },
      }, (response) => response.resume());
      request.once("error", (error) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      request.end(JSON.stringify(body({ stream: true })));
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 50);
    });
    const reason = await Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("disconnect was not propagated")), 1000)),
    ]);
    assert.equal(reason?.name, "AbortError");
  } finally {
    await server.close();
  }
});

function adapterFor(client) {
  let id = 0;
  return createAntigravityChatAdapter({
    client,
    idFactory: () => `chatcmpl_http_${++id}`,
    now: () => 1_700_000_000_000,
  });
}

function fakeClient(events) {
  return {
    async listModels() {
      return [{ id: "gemini-pro-agent", displayName: "Gemini Pro" }];
    },
    start() {
      return (async function* () {
        for (const event of events) yield event;
      }());
    },
    resume() {
      return (async function* () { yield { type: "done" }; }());
    },
    async cancel() {},
  };
}

function body(overrides = {}) {
  return {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function authorizedFetch(server, path, options = {}) {
  return fetch(`${server.url}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${server.authToken}`,
    },
  });
}
