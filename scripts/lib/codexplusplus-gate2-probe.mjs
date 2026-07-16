import fs from 'node:fs';
import net from 'node:net';

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[name] = next;
      index += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function assertCondition(condition, message, evidence = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.evidence = evidence;
    throw error;
  }
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function responseMessage(role, text, contentType) {
  return {
    type: 'message',
    role,
    content: [{ type: contentType, text }],
  };
}

function baseRequest(marker, extra = {}) {
  return {
    model: 'gate2-chat-model',
    input: [responseMessage('user', marker, 'input_text')],
    ...extra,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await fetch(url, { ...options, signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, expectedStatus = 200) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer gate2-proxy-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assertCondition(
    expectedStatuses.includes(response.status),
    `unexpected HTTP status for ${collectStrings(body).join(' ').slice(0, 80)}`,
    { expectedStatuses, actualStatus: response.status, body: text.slice(0, 1_000) },
  );
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('expected JSON response'), { evidence: text.slice(0, 1_000) });
  }
  return { response, text, json };
}

async function postStream(url, body, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer gate2-proxy-key',
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
    assertCondition(response.status === 200, 'stream request did not return 200', {
      status: response.status,
      marker: collectStrings(body).join(' ').slice(0, 80),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let readerReleased = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (options.abortAfterFirstChunk) {
          reader.releaseLock();
          readerReleased = true;
          controller.abort();
          break;
        }
      }
      text += decoder.decode();
    } catch (error) {
      if (!options.abortAfterFirstChunk || error?.name !== 'AbortError') throw error;
    } finally {
      if (!readerReleased) {
        try {
          await reader.cancel();
        } catch {}
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function readLog(path) {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForLog(path, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = readLog(path).find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function resetSocket(socket) {
  if (typeof socket.resetAndDestroy === 'function') {
    socket.resetAndDestroy();
  } else {
    socket.destroy();
  }
}

async function abortRawResponsesStream(proxyBase, body, timeoutMs = 10_000) {
  const url = new URL(`${proxyBase}/responses`);
  const payload = JSON.stringify({ ...body, stream: true });
  const request = [
    `POST ${url.pathname} HTTP/1.1`,
    `Host: ${url.host}`,
    'Authorization: Bearer gate2-proxy-key',
    'Accept: text/event-stream',
    'Content-Type: application/json',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    '',
    payload,
  ].join('\r\n');

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    let settled = false;
    let received = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`raw cancellation stream timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (!settled && received.includes('response.created')) {
        settled = true;
        clearTimeout(timer);
        resetSocket(socket);
        resolve(received);
      }
    });
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`raw cancellation stream closed before response.created: ${received.slice(0, 500)}`));
    });
  });
}

async function abortRawResponsesBeforeHeaders(proxyBase, body, timeoutMs = 10_000) {
  const url = new URL(`${proxyBase}/responses`);
  const payload = JSON.stringify({ ...body, stream: true });
  const request = [
    `POST ${url.pathname} HTTP/1.1`,
    `Host: ${url.host}`,
    'Authorization: Bearer gate2-proxy-key',
    'Accept: text/event-stream',
    'Content-Type: application/json',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    '',
    payload,
  ].join('\r\n');

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`pre-header cancellation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(request, () => {
        setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resetSocket(socket);
          resolve();
        }, 500);
      });
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`pre-header cancellation received an unexpected response: ${chunk.toString('utf8').slice(0, 500)}`));
    });
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('pre-header cancellation stream closed before the planned reset'));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const proxyBase = String(args['proxy-url'] ?? '').replace(/\/$/, '');
  const fakeLogPath = String(args['fake-log'] ?? '');
  assertCondition(proxyBase.startsWith('http://127.0.0.1:'), '--proxy-url must be a loopback URL');
  assertCondition(fakeLogPath.length > 0, '--fake-log is required');

  const responsesUrl = `${proxyBase}/responses`;
  const modelsResponse = await fetchWithTimeout(`${proxyBase}/models`, {
    headers: { authorization: 'Bearer gate2-proxy-key' },
  });
  const modelsText = await modelsResponse.text();
  assertCondition(modelsResponse.status === 200 && modelsText.includes('gate2-chat-model'), 'model proxy failed', {
    status: modelsResponse.status,
    body: modelsText.slice(0, 1_000),
  });

  const textStream = await postStream(responsesUrl, baseRequest('GATE2_TEXT'));
  assertCondition(textStream.includes('GATE2_TEXT_OK'), 'streamed text marker missing');
  assertCondition(countMatches(textStream, /event: response\.completed/g) === 1, 'stream must have exactly one completed event');
  assertCondition(countMatches(textStream, /event: response\.failed/g) === 0, 'successful stream must not fail');
  assertCondition(countMatches(textStream, /data: \[DONE\]/g) === 1, 'stream must have exactly one DONE marker');

  const firstTurn = await postJson(responsesUrl, baseRequest('GATE2_MULTI_A', { stream: false }));
  assertCondition(collectStrings(firstTurn.json).includes('GATE2_MULTI_A_OK'), 'first history marker missing');

  const secondTurn = await postJson(responsesUrl, {
    model: 'gate2-chat-model',
    stream: false,
    input: [
      responseMessage('user', 'GATE2_MULTI_A', 'input_text'),
      responseMessage('assistant', 'GATE2_MULTI_A_OK', 'output_text'),
      responseMessage('user', 'GATE2_MULTI_B', 'input_text'),
    ],
  });
  assertCondition(collectStrings(secondTurn.json).includes('GATE2_MULTI_B_OK'), 'second history marker missing');

  const toolDefinition = {
    type: 'local_shell',
    name: 'local_shell',
    description: 'Run one PowerShell command in the disposable Gate 2 workspace.',
  };
  const toolStream = await postStream(responsesUrl, baseRequest('GATE2_TOOL', {
    tools: [toolDefinition],
  }));
  assertCondition(toolStream.includes('local_shell'), 'local_shell tool name missing from converted stream');
  assertCondition(toolStream.includes('Write-Output GATE2_TOOL_OUTPUT'), 'local_shell command missing from converted stream');
  const callId = toolStream.match(/"call_id":"([^"]+)"/)?.[1];
  assertCondition(Boolean(callId), 'converted tool stream did not expose a call_id', toolStream.slice(0, 2_000));

  const toolContinuation = await postJson(responsesUrl, {
    model: 'gate2-chat-model',
    stream: false,
    tools: [toolDefinition],
    input: [
      responseMessage('user', 'GATE2_TOOL', 'input_text'),
      {
        type: 'custom_tool_call',
        call_id: callId,
        name: 'local_shell',
        input: 'Write-Output GATE2_TOOL_OUTPUT',
      },
      {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: 'GATE2_TOOL_OUTPUT',
      },
    ],
  });
  assertCondition(
    collectStrings(toolContinuation.json).some((value) => value.includes('GATE2_TOOL_RESULT:GATE2_TOOL_OUTPUT')),
    'exact tool-result continuation marker missing',
  );

  const authError = await postJson(responsesUrl, baseRequest('GATE2_AUTH', { stream: false }), 401);
  assertCondition(collectStrings(authError.json).includes('unauthorized'), 'auth error code was not preserved');
  const quotaError = await postJson(responsesUrl, baseRequest('GATE2_QUOTA', { stream: false }), 429);
  assertCondition(collectStrings(quotaError.json).includes('rate_limit_exceeded'), 'quota error code was not preserved');
  const serverError = await postJson(responsesUrl, baseRequest('GATE2_SERVER_ERROR', { stream: false }), 500);
  assertCondition(collectStrings(serverError.json).includes('internal_error'), 'server error code was not preserved');
  const networkError = await postJson(responsesUrl, baseRequest('GATE2_NETWORK', { stream: false }), [502, 503]);
  assertCondition(collectStrings(networkError.json).some((value) => /upstream|request|connection/i.test(value)), 'network error was not mapped');

  const slowPrefix = await abortRawResponsesStream(proxyBase, baseRequest('GATE2_SLOW'));
  assertCondition(slowPrefix.includes('response.created') || slowPrefix.includes('response.in_progress'), 'slow stream never started');
  await abortRawResponsesBeforeHeaders(proxyBase, baseRequest('GATE2_SLOW_HEADERS'));

  const cancelledLog = await waitForLog(fakeLogPath, (entry) => entry.response_mode === 'GATE2_SLOW' && entry.disconnected === true);
  const cancelledBeforeHeadersLog = await waitForLog(fakeLogPath, (entry) => entry.response_mode === 'GATE2_SLOW_HEADERS' && entry.disconnected === true);
  const networkLog = await waitForLog(fakeLogPath, (entry) => entry.response_mode === 'GATE2_NETWORK' && entry.disconnected === true);
  assertCondition(Boolean(networkLog), 'network disconnect was not observed');

  const logs = readLog(fakeLogPath).filter((entry) => entry.path === '/v1/chat/completions');
  const routed = logs.filter((entry) => entry.response_mode !== 'NORMAL');
  assertCondition(routed.length >= 9, 'too few routed fake-provider requests', { count: routed.length });
  assertCondition(routed.every((entry) => entry.model === 'gate2-chat-model'), 'model selection changed before the fake provider');
  assertCondition(
    logs.some((entry) => entry.response_mode === 'GATE2_TOOL' && entry.tool_names.includes('local_shell')),
    'tool definition did not reach the Chat provider',
  );
  assertCondition(
    logs.some((entry) => entry.response_mode === 'GATE2_TOOL'
      && entry.roles.includes('tool')
      && entry.tool_message_contents.some((value) => value.includes('GATE2_TOOL_OUTPUT'))),
    'tool result did not return through the Chat provider',
  );

  const result = {
    ok: true,
    proxyBase,
    model: 'gate2-chat-model',
    checks: {
      modelProxy: true,
      textStreaming: true,
      singleTerminalOutcome: true,
      multiTurnHistory: true,
      structuredToolCall: true,
      exactToolResult: true,
      authError: true,
      quotaError: true,
      serverError: true,
      networkError: true,
      cancellation: Boolean(cancelledLog),
      cancellationBeforeHeaders: Boolean(cancelledBeforeHeadersLog),
    },
    gateReady: Boolean(cancelledLog) && Boolean(cancelledBeforeHeadersLog),
    fakeChatRequestCount: logs.length,
    toolCallId: callId,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error?.message ?? String(error),
    evidence: error?.evidence ?? null,
  })}\n`);
  process.exitCode = 1;
});
