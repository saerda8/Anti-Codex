import test from "node:test";
import assert from "node:assert/strict";

import {
  createAntigravityNativeMcpBridge,
  normalizeTools,
} from "../antigravity-native-mcp-bridge.mjs";

test("normalizeTools maps Chat function schemas and deduplicates names", () => {
  assert.deepEqual(normalizeTools([
    { type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } },
    { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
  ]), [{
    name: "read_file",
    description: "Read",
    inputSchema: { type: "object" },
  }]);
});

test("native MCP bridge lists tools, captures a call, and returns its result", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    }],
  });
  try {
    const initialized = await rpc(bridge.url, 1, "initialize", { protocolVersion: "2025-03-26" });
    assert.equal(initialized.result.serverInfo.name, "anticodex-native-tool-bridge");
    const listed = await rpc(bridge.url, 2, "tools/list", {});
    assert.equal(listed.result.tools[0].name, "read_file");

    const callResponse = rpc(bridge.url, 3, "tools/call", {
      name: "read_file",
      arguments: { path: "README.md" },
    });
    const call = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(call.name, "read_file");
    assert.deepEqual(call.arguments, { path: "README.md" });
    assert.equal(bridge.pendingCount, 1);
    assert.equal(bridge.completeCall(call.callId, "file contents"), true);
    const completed = await callResponse;
    assert.equal(completed.result.content[0].text, "file contents");
    assert.equal(completed.result.isError, false);
  } finally {
    await bridge.close();
  }
});

test("native MCP bridge rejects unknown tools and waitForCall supports abort", async () => {
  const bridge = await createAntigravityNativeMcpBridge({ tools: [] });
  try {
    const unknown = await rpc(bridge.url, 4, "tools/call", { name: "missing", arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const controller = new AbortController();
    const waiting = bridge.waitForCall({ timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
  } finally {
    await bridge.close();
  }
});

async function rpc(url, id, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return response.json();
}
