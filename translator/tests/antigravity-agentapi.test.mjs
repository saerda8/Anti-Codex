import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  antigravityAccountSnapshot,
  antigravityModelOnlyToolConfig,
  createDesktopConnectionCache,
  discoverDesktopConnection,
  extractAvailableAgentModelEntries,
  fetchAntigravityUserStatus,
  fetchAvailableAgentModels,
  requestHeaders,
  resolveAntigravityModel,
} from "../antigravity-agentapi.mjs";

const connection = {
  lsAddress: "127.0.0.1:41111",
  agentApiAddress: "127.0.0.1:42222",
  csrfToken: "secret-token",
};

test("requestHeaders creates the native Connect JSON headers", () => {
  assert.deepEqual(requestHeaders("secret-token"), {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    "x-codeium-csrf-token": "secret-token",
  });
});

test("model-only probe configuration disables Antigravity-owned tools", () => {
  const config = antigravityModelOnlyToolConfig();
  assert.equal(config.runCommand.forceDisable, true);
  assert.equal(config.writeToFile.forceDisable, true);
  assert.equal(config.mcp.forceDisable, true);
  assert.equal(config.antigravityBrowser.enabled, false);
  assert.equal(config.invokeSubagent.enabled, false);
});

test("desktop discovery accepts an explicit environment boundary", () => {
  assert.deepEqual(discoverDesktopConnection({
    ANTIGRAVITY_LS_ADDRESS: "http://localhost:41111",
    ANTIGRAVITY_AGENTAPI_ADDRESS: "https://127.0.0.1:42222",
    ANTIGRAVITY_CSRF_TOKEN: "token",
  }), {
    lsAddress: "127.0.0.1:41111",
    agentApiAddress: "127.0.0.1:42222",
    csrfToken: "token",
  });
});

test("read-only helper reuses the bounded current provider discovery", async () => {
  const source = await readFile(new URL("../antigravity-agentapi.mjs", import.meta.url), "utf8");
  assert.match(source, /discoverAntigravityDesktopConnection/);
  assert.doesNotMatch(source, /Get-NetTCPConnection|Get-CimInstance Win32_Process \|/);
});

test("desktop connection cache reuses and invalidates one discovered connection", () => {
  let calls = 0;
  const first = { ...connection };
  const second = { ...connection, lsAddress: "127.0.0.1:43333" };
  const cache = createDesktopConnectionCache({ discover: () => (++calls === 1 ? first : second) });
  assert.equal(cache.get(), first);
  assert.equal(cache.get(), first);
  assert.equal(calls, 1);
  cache.invalidate({ ...first });
  assert.equal(cache.get(), first);
  cache.invalidate(first);
  assert.equal(cache.get(), second);
  assert.equal(calls, 2);
});

test("model discovery sends one bounded native request", async () => {
  const requests = [];
  const payload = { response: { models: { "gemini-pro-agent": { model: 7 } } } };
  const result = await fetchAvailableAgentModels({
    connection,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(payload);
    },
  });
  assert.deepEqual(result, payload);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /GetAvailableModels$/);
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  assert.equal(requests[0].options.headers["x-codeium-csrf-token"], "secret-token");
});

test("user status uses the same read-only desktop transport", async () => {
  const payload = { userStatus: { email: "user@example.com" } };
  const result = await fetchAntigravityUserStatus({
    connection,
    fetchImpl: async (url) => {
      assert.match(url, /GetUserStatus$/);
      return jsonResponse(payload);
    },
  });
  assert.deepEqual(result, payload);
});

test("connection failures invalidate discovery once and retry the read", async () => {
  const first = { ...connection, lsAddress: "127.0.0.1:40001" };
  const second = { ...connection, lsAddress: "127.0.0.1:40002" };
  let discoveries = 0;
  const cache = createDesktopConnectionCache({ discover: () => (++discoveries === 1 ? first : second) });
  const urls = [];
  const result = await fetchAvailableAgentModels({
    connectionCache: cache,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes(":40001")) throw new TypeError("fetch failed: ECONNREFUSED");
      return jsonResponse({ response: { models: {} } });
    },
  });
  assert.deepEqual(result, { response: { models: {} } });
  assert.equal(discoveries, 2);
  assert.equal(urls.length, 2);
});

test("HTTP provider errors propagate without rediscovery", async () => {
  let fetches = 0;
  await assert.rejects(
    fetchAvailableAgentModels({
      connection,
      fetchImpl: async () => {
        fetches += 1;
        return new Response("denied", { status: 401 });
      },
    }),
    (error) => error.statusCode === 401 && /GetAvailableModels failed/.test(error.message),
  );
  assert.equal(fetches, 1);
});

test("an aborted read is not retried", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let fetches = 0;
  await assert.rejects(fetchAvailableAgentModels({
    connection,
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      fetches += 1;
      if (options.signal.aborted) throw new DOMException("aborted", "AbortError");
      return jsonResponse({});
    },
  }), /aborted/i);
  assert.equal(fetches, 1);
});

test("account snapshot exposes only a fingerprint and capability facts", () => {
  const email = "user@example.com";
  const snapshot = antigravityAccountSnapshot({
    userStatus: {
      email: ` ${email.toUpperCase()} `,
      userTier: { name: "pro" },
      planStatus: {
        planInfo: {
          planName: "Pro",
          maxNumChatInputTokens: 123456,
          cascadeWebSearchEnabled: true,
          browserEnabled: false,
          cascadeCanAutoRunCommands: true,
        },
      },
    },
  });
  assert.equal(snapshot.signedIn, true);
  assert.equal(snapshot.identityAvailable, true);
  assert.equal(snapshot.fingerprint, `sha256:${createHash("sha256").update(email).digest("hex")}`);
  assert.equal(snapshot.planName, "Pro");
  assert.equal(snapshot.tierName, "pro");
  assert.equal(snapshot.webSearchEnabled, true);
  assert.equal(snapshot.browserEnabled, false);
  assert.equal(snapshot.autoRunCommandsEnabled, true);
  assert.equal(JSON.stringify(snapshot).includes(email), false);
});

test("model entries expose sorted agent models without unsorted internal entries", () => {
  const entries = extractAvailableAgentModelEntries({
    response: {
      agentModelSorts: [{ groups: [{ modelIds: ["flash", "pro", "flash"] }] }],
      models: {
        pro: { model: 1, displayName: "Pro" },
        flash: { model: 2, displayName: "Flash" },
        extra: { model: 3, displayName: "Extra" },
      },
    },
  });
  assert.deepEqual(entries.map((item) => item.id), ["flash", "pro"]);
});

test("model entries fall back to all models when Antigravity provides no agent sort", () => {
  const entries = extractAvailableAgentModelEntries({
    response: {
      models: {
        pro: { model: 1, displayName: "Pro" },
        flash: { model: 2, displayName: "Flash" },
      },
    },
  });
  assert.deepEqual(entries.map((item) => item.id), ["pro", "flash"]);
});

test("model resolution selects an exact exported id and returns its internal enum", () => {
  const payload = {
    response: {
      models: {
        "gemini-pro-agent": { model: 1, displayName: "Gemini Pro" },
        "gemini-3.5-flash-low": { model: 2, displayName: "Gemini Flash" },
      },
    },
  };
  const selected = resolveAntigravityModel(payload, "gemini-3.5-flash-low");
  assert.equal(selected.id, "gemini-3.5-flash-low");
  assert.equal(selected.internalModel, 2);
});

test("model resolution fails closed when no model is available", () => {
  assert.throws(() => resolveAntigravityModel({ response: { models: {} } }, "missing"), /no available models/i);
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
