import test from "node:test";
import assert from "node:assert/strict";

import {
  createAntigravityNativeMcpBridge,
  normalizeTools,
} from "../antigravity-native-mcp-bridge.mjs";

test("normalizeTools maps Chat function schemas, removes empty enum values, and deduplicates names", () => {
  assert.deepEqual(normalizeTools([
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read",
        parameters: {
          type: "object",
          properties: { allowAsync: { type: "string", enum: ["", "async"] } },
        },
      },
    },
    { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
  ]), [{
    name: "read_file",
    description: "Read",
    inputSchema: {
      type: "object",
      properties: { allowAsync: { type: "string", enum: ["async"] } },
    },
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
    assert.deepEqual(bridge.customAgentSpec.customizationConfig.toolNames, ["shell_command"]);

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
    assert.deepEqual(bridge.customAgentSpec.customizationConfig.toolNames, ["exec_command", "apply_patch"]);
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

test("native MCP bridge updateTools adds, removes, and aliases tools live while preserving pending calls", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    tools: [{
      type: "function",
      function: {
        name: "tool_a",
        description: "Tool A",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    }],
  });
  try {
    const listedInitial = await rpc(bridge.url, 1, "tools/list", {});
    assert.deepEqual(listedInitial.result.tools.map((t) => t.name), ["tool_a"]);

    const callAResponse = rpc(bridge.url, 2, "tools/call", { name: "tool_a", arguments: { value: "first" } });
    const callA = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(callA.name, "tool_a");
    assert.equal(callA.nativeCallId, "2");
    assert.equal(bridge.pendingCount, 1);

    bridge.updateTools([
      { name: "tool_a", description: "Tool A", parameters: { type: "object" } },
      { name: "tool_b", description: "Tool B", parameters: { type: "object" } },
    ]);

    const listedAfterAdd = await rpc(bridge.url, 3, "tools/list", {});
    assert.deepEqual(listedAfterAdd.result.tools.map((t) => t.name).sort(), ["tool_a", "tool_b"].sort());

    const callBResponse = rpc(bridge.url, 4, "tools/call", { name: "tool_b", arguments: { value: "second" } });
    const callB = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(callB.name, "tool_b");
    assert.equal(callB.nativeCallId, "4");
    assert.equal(bridge.pendingCount, 2);

    assert.equal(bridge.completeCall(callB.callId, "B done"), true);
    const completedB = await callBResponse;
    assert.equal(completedB.result.content[0].text, "B done");

    assert.equal(bridge.completeCall(callA.callId, "A done"), true);
    const completedA = await callAResponse;
    assert.equal(completedA.result.content[0].text, "A done");
    assert.equal(bridge.pendingCount, 0);

    bridge.updateTools([{ name: "tool_b", description: "Tool B", parameters: { type: "object" } }]);
    const listedAfterRemove = await rpc(bridge.url, 5, "tools/list", {});
    assert.deepEqual(listedAfterRemove.result.tools.map((t) => t.name), ["tool_b"]);

    const rejectedA = await rpc(bridge.url, 6, "tools/call", { name: "tool_a", arguments: { value: "blocked" } });
    assert.equal(rejectedA.error.code, -32602);

    const callB2Response = rpc(bridge.url, 7, "tools/call", { name: "tool_b", arguments: { value: "third" } });
    const callB2 = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(bridge.completeCall(callB2.callId, "B again"), true);
    assert.equal((await callB2Response).result.content[0].text, "B again");

    const agentSpec = bridge.customAgentSpec;
    assert.deepEqual(agentSpec.customTools, ["tool_b"]);
    assert.deepEqual(agentSpec.customizationConfig.toolNames, ["tool_b"]);
  } finally {
    await bridge.close();
  }
});

test("native MCP bridge updateTools aliases canonicalize for shell_command and host-qualified names", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    tools: [
      { name: "shell_command", description: "Run shell", parameters: { type: "object" } },
      { name: "exec_command", description: "Exec", parameters: { type: "object" } },
      { name: "apply_patch", description: "Patch", parameters: { type: "object" } },
    ],
  });
  try {
    bridge.updateTools([
      { name: "shell_command", description: "Run shell", parameters: { type: "object" } },
      { name: "exec_command", description: "Exec", parameters: { type: "object" } },
      { name: "apply_patch", description: "Patch", parameters: { type: "object" } },
    ]);

    const listed = await rpc(bridge.url, 10, "tools/list", {});
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["apply_patch", "command", "exec_command", "functions.apply_patch", "functions.exec", "shell_command"].sort());

    const agentSpec = bridge.customAgentSpec;
    assert.deepEqual(agentSpec.customTools.sort(), ["apply_patch", "exec_command", "shell_command"].sort());
    assert.deepEqual(agentSpec.customizationConfig.toolNames.sort(), ["apply_patch", "exec_command", "shell_command"].sort());

    const callAliasResponse = rpc(bridge.url, 11, "tools/call", { name: "command", arguments: { command: "echo hi" } });
    const callAlias = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(callAlias.name, "shell_command");
    assert.equal(callAlias.nativeName, "command");
    assert.equal(bridge.completeCall(callAlias.callId, "ok"), true);
    assert.equal((await callAliasResponse).result.content[0].text, "ok");

    const callHostResponse = rpc(bridge.url, 12, "tools/call", { name: "functions.exec", arguments: { cmd: "pwd" } });
    const callHost = await bridge.waitForCall({ timeoutMs: 1000 });
    assert.equal(callHost.name, "exec_command");
    assert.equal(callHost.nativeName, "functions.exec");
    assert.equal(bridge.completeCall(callHost.callId, "ok"), true);
    assert.equal((await callHostResponse).result.content[0].text, "ok");
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
