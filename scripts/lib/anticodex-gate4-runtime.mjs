import { createServer } from "node:http";

const DEFAULT_OUTPUT_LIMIT = 32_000;

export async function waitForCondition(
  check,
  { timeout = 60_000, interval = 200, description = "condition" } = {},
) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error?.terminal === true) throw error;
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, interval));
  }
  throw new Error(
    `Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError.message}` : ""}`,
  );
}

export async function fetchModelCatalog(options = {}) {
  const response = await (options.fetchImpl ?? fetch)(String(options.url ?? ""), {
    headers: { Authorization: `Bearer ${String(options.token ?? "")}` },
    signal: AbortSignal.timeout(positiveInteger(options.timeout, 2_000)),
  });
  const text = await response.text();
  if (!response.ok) {
    throw terminalError(
      `CodexPlusPlus model proxy returned HTTP ${response.status}.`,
      {
        statusCode: response.status,
        responseTail: text.slice(-1_000),
      },
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw terminalError("CodexPlusPlus model proxy returned invalid JSON.", {
      statusCode: response.status,
      responseTail: text.slice(-1_000),
    });
  }
  const models = Array.isArray(body?.data) ? body.data : [];
  return models.some((entry) => entry?.id === options.model) ? body : null;
}

export function assertRouteAuditUnchanged(before, after, label = "forbidden route") {
  if (before && after && JSON.stringify(before) === JSON.stringify(after)) return;
  throw terminalError(`${label} received an unexpected request.`, { before, after });
}

export function observeChild(child, options = {}) {
  const outputLimit = positiveInteger(options.outputLimit, DEFAULT_OUTPUT_LIMIT);
  const redactValues = [...new Set(
    (options.redactValues ?? []).map(String).filter(Boolean),
  )];
  let stdout = "";
  let stderr = "";
  let spawnError = null;
  let closed = false;
  let exitCode = null;
  let signal = null;

  child.stdout?.on("data", (chunk) => {
    stdout = appendTail(stdout, chunk, outputLimit);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendTail(stderr, chunk, outputLimit);
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const closedPromise = new Promise((resolveClosed) => {
    child.once("close", (code, closeSignal) => {
      closed = true;
      exitCode = code;
      signal = closeSignal;
      resolveClosed(snapshot());
    });
  });

  function snapshot() {
    return {
      pid: Number(child.pid) || null,
      exitCode: closed ? exitCode : child.exitCode,
      signal: closed ? signal : child.signalCode,
      spawnError: spawnError?.message ?? null,
      stdoutTail: redact(stdout, redactValues),
      stderrTail: redact(stderr, redactValues),
    };
  }

  function throwIfTerminated(label = "child process") {
    const evidence = snapshot();
    if (!spawnError && !closed && evidence.exitCode === null && evidence.signal === null) return;
    const status = evidence.spawnError
      ? `failed to spawn: ${evidence.spawnError}`
      : `exited with code ${evidence.exitCode ?? "null"}${evidence.signal ? ` signal ${evidence.signal}` : ""}`;
    const output = [evidence.stderrTail, evidence.stdoutTail].filter(Boolean).join("\n");
    throw terminalError(`${label} ${status}.${output ? ` Output: ${output}` : ""}`, evidence);
  }

  return {
    child,
    closed: closedPromise,
    snapshot,
    throwIfTerminated,
  };
}

export async function startLoopbackRequestAudit(options = {}) {
  const host = String(options.host ?? "127.0.0.1");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Gate 4 request audit may listen only on loopback.");
  }
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    requests.push({
      method: String(request.method ?? ""),
      path: url.pathname,
    });
    request.resume();
    const body = JSON.stringify({ error: "gate4_forbidden_route" });
    response.writeHead(418, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolveListen);
  });
  const address = server.address();
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    url: `http://${displayHost}:${address.port}/v1`,
    snapshot() {
      return {
        count: requests.length,
        requests: requests.map((entry) => ({ ...entry })),
      };
    },
    async close() {
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

function terminalError(message, evidence) {
  const error = new Error(message);
  error.terminal = true;
  error.evidence = evidence;
  return error;
}

function appendTail(current, chunk, limit) {
  const combined = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function redact(value, secrets) {
  let result = String(value ?? "");
  for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
