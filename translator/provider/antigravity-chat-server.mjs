import { createServer } from "node:http";

import { ChatAdapterError, mapAntigravityError } from "./antigravity-chat-adapter.mjs";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function createAntigravityChatServer(options = {}) {
  const adapter = options.adapter;
  if (!adapter || typeof adapter.stream !== "function" || typeof adapter.complete !== "function") {
    throw new TypeError("An Antigravity Chat adapter is required.");
  }
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The Antigravity Chat adapter may listen only on loopback.");
  }
  const maxBodyBytes = positiveInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const active = new Set();

  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    let finished = false;
    let iterator = null;
    active.add(controller);

    const abort = () => {
      if (finished || controller.signal.aborted) return;
      controller.abort(new DOMException("Chat client disconnected.", "AbortError"));
      void iterator?.return?.().catch?.(() => {});
    };
    request.once("aborted", abort);
    response.once("close", abort);

    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const models = await adapter.models({ signal: controller.signal });
        finished = true;
        sendJson(response, 200, models);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/account") {
        const account = await adapter.account({ signal: controller.signal });
        finished = true;
        sendJson(response, 200, account);
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        finished = true;
        sendJson(response, 404, openAiError("Route not found.", "not_found", "invalid_request_error"));
        return;
      }

      const body = await readJsonBody(request, maxBodyBytes);
      if (body?.stream === true) {
        iterator = adapter.stream(body, { signal: controller.signal })[Symbol.asyncIterator]();
        const buffered = [];
        while (true) {
          const item = await iterator.next();
          if (item.done) break;
          buffered.push(item.value);
          if (chatChunkCommitsResponse(item.value)) break;
        }
        if (response.destroyed || controller.signal.aborted) return;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.flushHeaders?.();
        for (const value of buffered) {
          response.write(`data: ${JSON.stringify(value)}\n\n`);
        }
        while (true) {
          const item = await iterator.next();
          if (item.done) break;
          if (response.destroyed || controller.signal.aborted) return;
          response.write(`data: ${JSON.stringify(item.value)}\n\n`);
        }
        if (!response.destroyed && !controller.signal.aborted) {
          response.write("data: [DONE]\n\n");
          finished = true;
          response.end();
        }
        return;
      }

      const completion = await adapter.complete(body, { signal: controller.signal });
      finished = true;
      sendJson(response, 200, completion);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const mapped = error instanceof ChatAdapterError ? error : mapAntigravityError(error);
      const payload = openAiError(mapped.message, mapped.code, mapped.type);
      if (!response.headersSent) {
        finished = true;
        sendJson(response, mapped.statusCode, payload);
      } else {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
        response.write("data: [DONE]\n\n");
        finished = true;
        response.end();
      }
    } finally {
      active.delete(controller);
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(options.port ?? 0), host, resolve);
  });
  const address = server.address();
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;

  async function close() {
    for (const controller of active) {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Antigravity Chat server closed.", "AbortError"));
      }
    }
    await adapter.close?.();
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return {
    url: `http://${displayHost}:${address.port}/v1`,
    host: address.address,
    port: address.port,
    close,
  };
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ChatAdapterError(`Request body exceeds ${maxBytes} bytes.`, {
        statusCode: 413,
        code: "request_too_large",
        type: "invalid_request_error",
      });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ChatAdapterError("Request body must be valid JSON.", {
      cause: error,
      statusCode: 400,
      code: "invalid_json",
      type: "invalid_request_error",
    });
  }
}

function openAiError(message, code, type) {
  return { error: { message: String(message), type: String(type), code: String(code) } };
}

function sendJson(response, statusCode, value) {
  if (response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function chatChunkCommitsResponse(value) {
  const choices = Array.isArray(value?.choices) ? value.choices : [];
  return choices.some((choice) => {
    const delta = choice?.delta;
    return choice?.finish_reason !== null
      || typeof delta?.content === "string"
      || typeof delta?.reasoning_content === "string"
      || Array.isArray(delta?.tool_calls);
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
