import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS,
  MAX_NATIVE_MCP_BODY_BYTES,
  boundedPositiveInteger,
} from "./antigravity-contract.mjs";

export async function createAntigravityNativeMcpBridge(options = {}) {
  const canonicalTools = normalizeTools(options.tools);
  const { tools, canonicalNameByNativeName } = withAntigravityToolAliases(canonicalTools);
  const systemPromptSections = normalizeSystemPromptSections(options.systemPromptSections);
  const calls = [];
  const waiters = [];
  const pending = new Map();
  const secret = String(options.secret || randomBytes(32).toString("base64url"));
  const secretPath = `/mcp/${encodeURIComponent(secret)}`;
  const maxBodyBytes = boundedPositiveInteger(
    options.maxBodyBytes,
    MAX_NATIVE_MCP_BODY_BYTES,
    MAX_NATIVE_MCP_BODY_BYTES,
  );
  const pendingCallTimeoutMs = positiveInteger(
    options.pendingCallTimeoutMs ?? options.callTimeoutMs,
    DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS,
  );
  let closed = false;

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== secretPath) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "POST required" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, maxBodyBytes);
    } catch (error) {
      sendJson(response, error?.statusCode ?? 400, { error: String(error?.message ?? error) });
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
    const timeoutMs = pendingCallTimeoutMs;
    const timeout = setTimeout(() => {
      removeQueuedCall(callId);
      completion.reject(new Error(`Timed out waiting for Codex tool result after ${timeoutMs}ms.`));
    }, timeoutMs);
    pending.set(callId, { completion, response, rpcId: body.id, timeout });
    enqueue({
      callId,
      nativeCallId: String(body.id),
      name: canonicalNameByNativeName.get(name) ?? name,
      nativeName: name,
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
  const url = `http://127.0.0.1:${address.port}${secretPath}`;

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
    secret,
    tools,
    customAgentSpec: withAntigravitySystemPromptSections({
      customizationConfig: {
        customizationServerUrl: url,
        toolNames: tools.map((tool) => tool.name),
      },
      customTools: canonicalTools.map((tool) => tool.name),
    }, systemPromptSections),
    waitForCall,
    takeCalls,
    completeCall,
    close,
    maxBodyBytes,
    pendingCallTimeoutMs,
    get pendingCount() {
      return pending.size;
    },
  };
}

export function withAntigravitySystemPromptSections(baseSpec = {}, sections = []) {
  const normalizedSections = normalizeSystemPromptSections(sections);
  if (normalizedSections.length === 0) return { ...baseSpec };
  return {
    ...baseSpec,
    customAgent: {
      ...(baseSpec?.customAgent ?? {}),
      systemPromptSections: normalizedSections,
    },
  };
}

function normalizeSystemPromptSections(sections = []) {
  return (sections ?? []).flatMap((section) => {
    const content = String(section?.content ?? "").trim();
    if (!content) return [];
    return [{
      title: String(section?.title ?? "Codex instructions").trim() || "Codex instructions",
      content,
      metadata: {
        ...(section?.metadata ?? {}),
        isInternal: true,
      },
    }];
  });
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

function withAntigravityToolAliases(tools) {
  const aliases = [...tools];
  const canonicalNameByNativeName = new Map(tools.map((tool) => [tool.name, tool.name]));
  const names = new Set(canonicalNameByNativeName.keys());
  const shellCommand = tools.find((tool) => tool.name === "shell_command");
  if (shellCommand && !names.has("command")) {
    aliases.push({
      name: "command",
      description: `${shellCommand.description || "Run a shell command"} (Antigravity compatibility alias for shell_command.)`,
      inputSchema: shellCommand.inputSchema,
    });
    canonicalNameByNativeName.set("command", "shell_command");
  }
  for (const [name, alias] of [["exec_command", "functions.exec"], ["apply_patch", "functions.apply_patch"]]) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool || names.has(alias)) continue;
    aliases.push({
      ...tool,
      name: alias,
      description: `${tool.description || name} (host compatibility alias for ${name}.)`,
    });
    names.add(alias);
    canonicalNameByNativeName.set(alias, name);
  }
  return { tools: aliases, canonicalNameByNativeName };
}

function mcpToolResult(output, isError) {
  const content = Array.isArray(output)
    ? output.map(mcpContentPart)
    : [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? null) }];
  return { content, isError };
}

function mcpContentPart(part) {
  const type = String(part?.type ?? "");
  if (type === "text" || type === "input_text") {
    return { type: "text", text: String(part?.text ?? "") };
  }
  if (type === "image_url") {
    const source = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
    const match = String(source ?? "").match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if (!match) throw new Error("MCP image result must be a base64 data image.");
    return { type: "image", data: match[2].replace(/\s+/g, ""), mimeType: match[1].toLowerCase() };
  }
  throw new Error(`Unsupported MCP result content part: ${type || "missing"}`);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
