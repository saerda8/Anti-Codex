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

test("native MCP bridge installs Codex instructions as trusted Custom Agent sections", async () => {
  const systemPromptSections = [{
    title: "Codex system instructions",
    content: "Use Codex tools and wait for their real results.",
    metadata: { isInternal: true },
  }];
  const bridge = await createAntigravityNativeMcpBridge({
    systemPromptSections,
    tools: [{
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
    }],
  });
  try {
    assert.deepEqual(bridge.customAgentSpec.customAgent, {
      systemPromptSections,
    });
    assert.deepEqual(bridge.customAgentSpec.customTools, ["read_file"]);
    assert.deepEqual(bridge.customAgentSpec.customizationConfig.toolNames, ["read_file"]);
  } finally {
    await bridge.close();
  }
});

test("native MCP bridge uses a fresh unguessable URL secret and rejects other paths", async () => {
  const first = await createAntigravityNativeMcpBridge({ tools: [] });
  const second = await createAntigravityNativeMcpBridge({ tools: [] });
  try {
    assert.notEqual(first.secret, second.secret);
    assert.ok(first.secret.length >= 32);
    assert.match(first.url, new RegExp(`/${first.secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

    const origin = new URL(first.url).origin;
    const missing = await fetch(origin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${origin}/wrong-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
    });
    assert.equal(wrong.status, 401);
  } finally {
    await first.close();
    await second.close();
  }
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
    assert.equal(call.nativeCallId, "3");
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

test("native MCP bridge preserves text and image tool result parts", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    tools: [{ name: "view_image", parameters: { type: "object" } }],
  });
  try {
    const responsePromise = rpc(bridge.url, "native-image-call", "tools/call", {
      name: "view_image",
      arguments: { path: "frame.png" },
    });
    const call = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(bridge.completeCall(call.callId, [
      { type: "text", text: "frame" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]), true);
    const response = await responsePromise;
    assert.deepEqual(response.result.content, [
      { type: "text", text: "frame" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  } finally {
    await bridge.close();
  }
});

test("native MCP bridge bounds request bodies and retains results beyond ten minutes by default", async () => {
  const bridge = await createAntigravityNativeMcpBridge({ maxBodyBytes: 128, tools: [] });
  try {
    assert.ok(bridge.pendingCallTimeoutMs > 10 * 60 * 1000);
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { padding: "x".repeat(256) } }),
    });
    assert.equal(response.status, 413);
  } finally {
    await bridge.close();
  }
});

test("native MCP bridge maps Antigravity command alias back to Codex shell_command", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    tools: [{
      type: "function",
      function: {
        name: "shell_command",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    }],
  });
  try {
    const listed = await rpc(bridge.url, 20, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["shell_command", "command"]);
    assert.deepEqual(bridge.customAgentSpec.customTools, ["shell_command"]);

    const callResponse = rpc(bridge.url, 21, "tools/call", {
      name: "command",
      arguments: { command: "npm test" },
    });
    const call = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(call.name, "shell_command");
    assert.equal(call.nativeName, "command");
    assert.deepEqual(call.arguments, { command: "npm test" });
    assert.equal(bridge.completeCall(call.callId, "ok"), true);
    assert.equal((await callResponse).result.content[0].text, "ok");
  } finally {
    await bridge.close();
  }
});

test("native MCP bridge accepts host-qualified function aliases", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    tools: [
      { name: "exec_command", description: "Run a command", parameters: { type: "object" } },
      { name: "apply_patch", description: "Apply a patch", parameters: { type: "object" } },
    ],
  });
  try {
    assert.deepEqual(bridge.customAgentSpec.customTools, ["exec_command", "apply_patch"]);
    const listed = await rpc(bridge.url, 30, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      "exec_command", "apply_patch", "functions.exec", "functions.apply_patch",
    ]);
    const callResponse = rpc(bridge.url, 31, "tools/call", {
      name: "functions.exec",
      arguments: { cmd: "Get-Location" },
    });
    const call = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(call.name, "exec_command");
    assert.equal(call.nativeName, "functions.exec");
    assert.deepEqual(call.arguments, { cmd: "Get-Location" });
    assert.equal(bridge.completeCall(call.callId, "ok"), true);
    assert.equal((await callResponse).result.content[0].text, "ok");
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

test("native MCP bridge evicts abandoned calls after waiter timeout", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    pendingCallTimeoutMs: 20,
    tools: [{
      name: "late_tool",
      description: "Late tool",
      parameters: { type: "object" },
    }],
  });
  try {
    await assert.rejects(
      bridge.waitForCall({ timeoutMs: 10 }),
      /Timed out waiting for native tool call/,
    );

    const lateCall = rpc(bridge.url, 5, "tools/call", {
      name: "late_tool",
      arguments: { value: 1 },
    });
    await waitFor(() => bridge.pendingCount === 1);
    const result = await lateCall;
    assert.equal(result.error.code, -32000);
    assert.match(result.error.message, /Timed out waiting for Codex tool result/);
    assert.equal(bridge.pendingCount, 0);
    assert.deepEqual(bridge.takeCalls(), []);
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

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.equal(predicate(), true);
}
