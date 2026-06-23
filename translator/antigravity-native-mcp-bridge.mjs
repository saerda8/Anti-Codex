import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export async function createAntigravityNativeMcpBridge(options = {}) {
  const tools = normalizeTools(options.tools);
  const calls = [];
  const waiters = [];
  const pending = new Map();
  let closed = false;

  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    if (request.method !== "POST") {
      sendJson(response, request.url === "/.well-known/oauth-protected-resource" ? 404 : 405, { error: "POST required" });
      return;
    }
    if (body?.id === undefined || body?.id === null) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (body.method === "initialize") {
      sendResult(response, body.id, {
        protocolVersion: body?.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "anticodex-native-tool-bridge", version: "1.0.0" },
      });
      return;
    }
    if (body.method === "tools/list") {
      sendResult(response, body.id, { tools });
      return;
    }
    if (body.method !== "tools/call") {
      sendResult(response, body.id, {});
      return;
    }

    const name = String(body?.params?.name ?? "");
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      sendError(response, body.id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const callId = `call_${randomUUID().replaceAll("-", "")}`;
    const completion = deferred();
    const timeoutMs = Math.max(1, Number(options.pendingCallTimeoutMs ?? options.callTimeoutMs ?? 300_000) || 300_000);
    const timeout = setTimeout(() => {
      removeQueuedCall(callId);
      completion.reject(new Error(`Timed out waiting for Codex tool result after ${timeoutMs}ms.`));
    }, timeoutMs);
    pending.set(callId, { completion, response, rpcId: body.id, timeout });
    enqueue({
      callId,
      name,
      arguments: body?.params?.arguments ?? {},
    });
    try {
      const result = await completion.promise;
      sendResult(response, body.id, mcpToolResult(result.output, result.isError));
    } catch (error) {
      sendError(response, body.id, -32000, String(error?.message ?? error));
    } finally {
      clearTimeout(timeout);
      pending.delete(callId);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  const onAbort = () => void close(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  function enqueue(call) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(call);
    else calls.push(call);
  }

  function removeQueuedCall(callId) {
    const index = calls.findIndex((call) => call?.callId === callId);
    if (index >= 0) calls.splice(index, 1);
  }

  async function waitForCall(waitOptions = {}) {
    if (calls.length) return calls.shift();
    if (closed) throw new Error("Antigravity native MCP bridge is closed.");
    const waiter = deferred();
    waiters.push(waiter);
    return withTimeoutAndSignal(
      waiter.promise,
      waitOptions.timeoutMs ?? options.callTimeoutMs ?? 300_000,
      waitOptions.signal ?? options.signal,
      () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
      },
    );
  }

  function completeCall(callId, output, completeOptions = {}) {
    const item = pending.get(callId);
    if (!item) return false;
    clearTimeout(item.timeout);
    item.completion.resolve({ output, isError: completeOptions.isError === true });
    return true;
  }

  function takeCalls() {
    return calls.splice(0);
  }

  async function close(reason = new Error("Antigravity native MCP bridge closed.")) {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    for (const waiter of waiters.splice(0)) waiter.reject(reason);
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.completion.reject(reason);
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    url,
    tools,
    customAgentSpec: {
      customizationConfig: {
        customizationServerUrl: url,
        toolNames: tools.map((tool) => tool.name),
      },
      customTools: tools.map((tool) => tool.name),
    },
    waitForCall,
    takeCalls,
    completeCall,
    close,
    get pendingCount() {
      return pending.size;
    },
  };
}

export function normalizeTools(tools = []) {
  const seen = new Set();
  return tools.flatMap((tool) => {
    const value = tool?.function ?? tool;
    const name = String(value?.name ?? "");
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{
      name,
      description: String(value?.description ?? ""),
      inputSchema: value?.parameters && typeof value.parameters === "object"
        ? value.parameters
        : { type: "object", properties: {}, additionalProperties: true },
    }];
  });
}

function mcpToolResult(output, isError) {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return { content: [{ type: "text", text }], isError };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function sendResult(response, id, result) {
  sendJson(response, 200, { jsonrpc: "2.0", id, result }, { "mcp-session-id": "anticodex-native-tool-bridge" });
}

function sendError(response, id, code, message) {
  sendJson(response, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function sendJson(response, status, value, headers = {}) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeoutAndSignal(promise, timeoutMs, signal, cleanup) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      cleanup?.();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for native tool call after ${timeoutMs}ms.`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
