import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Fake Chat Completions Server Tests', async (t) => {
  const readyPath = path.join(__dirname, 'ready.json');
  const logPath = path.join(__dirname, 'log.jsonl');

  if (fs.existsSync(readyPath)) fs.unlinkSync(readyPath);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  // Spawn the server
  const serverProcess = spawn('node', [
    path.join(__dirname, 'fake-chat-server.mjs'),
    '--port', '0',
    '--ready', readyPath,
    '--log', logPath
  ], {
    stdio: ['ignore', 'pipe', 'inherit']
  });

  // Ensure server process kills on test exit
  t.after(() => {
    serverProcess.kill('SIGTERM');
    try {
      if (fs.existsSync(readyPath)) fs.unlinkSync(readyPath);
      if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    } catch (e) {
      // ignore
    }
  });

  // Wait for readyPath to exist and be populated
  let baseUrl = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not become ready in time')), 5000);
    const interval = setInterval(() => {
      if (fs.existsSync(readyPath)) {
        try {
          const content = fs.readFileSync(readyPath, 'utf8');
          const data = JSON.parse(content);
          if (data.baseUrl) {
            baseUrl = data.baseUrl;
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        } catch (e) {
          // file might be partially written, try again next tick
        }
      }
    }, 50);
  });

  // Test 1: GET /health
  await t.test('GET /health returns OK', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, { status: 'ok' });
  });

  // Test 2: GET /v1/models
  await t.test('GET /v1/models returns model list', async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.object, 'list');
    const model = data.data.find(m => m.id === 'gate2-chat-model');
    assert.ok(model);
  });

  // Test 3: Auth rejection
  await t.test('Auth rejection works', async () => {
    // No auth header
    const res1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ messages: [] })
    });
    assert.strictEqual(res1.status, 401);
    const err1 = await res1.json();
    assert.strictEqual(err1.error.code, 'invalid_api_key');

    // Wrong auth header
    const res2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer bad-key' },
      body: JSON.stringify({ messages: [] })
    });
    assert.strictEqual(res2.status, 401);
  });

  // Test 4: Nonstream text completion
  await t.test('Nonstream text returns GATE2_TEXT_OK', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'hello GATE2_TEXT world' }]
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'GATE2_TEXT_OK');
  });

  // Test 5: Streaming text completion
  await t.test('Streaming text returns GATE2_TEXT_OK', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_TEXT' }],
        stream: true
      })
    });
    assert.strictEqual(res.status, 200);
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of res.body) {
      text += decoder.decode(chunk);
    }
    assert.ok(text.includes('GATE2_TEXT_OK'));
    assert.ok(text.includes('[DONE]'));
  });

  // Test 6: Multi-turn history enforcement
  await t.test('Multi-turn B fails without A', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_MULTI_B' }]
      })
    });
    assert.strictEqual(res.status, 400);
    const err = await res.json();
    assert.strictEqual(err.error.code, 'multi_turn_violation');
  });

  await t.test('Multi-turn B succeeds with prior A', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [
          { role: 'user', content: 'GATE2_MULTI_A' },
          { role: 'assistant', content: 'GATE2_MULTI_A_OK' },
          { role: 'user', content: 'GATE2_MULTI_B' }
        ]
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'GATE2_MULTI_B_OK');
  });

  // Test 7: Streamed tool-call then tool-result continuation
  await t.test('Streamed tool-call works', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_TOOL' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'shell_command',
              parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command']
              }
            }
          }
        ],
        stream: true
      })
    });
    assert.strictEqual(res.status, 200);
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of res.body) {
      text += decoder.decode(chunk);
    }
    assert.ok(text.includes('shell_command'));
    assert.ok(text.includes('Write-Output GATE2_TOOL_OUTPUT'));
    assert.ok(text.includes('tool_calls'));
  });

  await t.test('Tool-result continuation works', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [
          { role: 'user', content: 'GATE2_TOOL' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'shell_command', arguments: '{"command":"Write-Output GATE2_TOOL_OUTPUT"}' } }] },
          { role: 'tool', tool_call_id: 'call_123', content: 'my_custom_result' }
        ]
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'GATE2_TOOL_RESULT:my_custom_result');
  });

  // Test 8: Quota error
  await t.test('Quota error simulated', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_QUOTA' }]
      })
    });
    assert.strictEqual(res.status, 429);
    const err = await res.json();
    assert.strictEqual(err.error.code, 'rate_limit_exceeded');
  });

  await t.test('Gate 8 rehearsal drives a deterministic edit and test sequence', async () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'shell_command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    }];
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE8_REHEARSAL_CREATE' }],
        tools
      })
    });
    assert.strictEqual(first.status, 200);
    const firstBody = await first.json();
    assert.match(firstBody.choices[0].message.content, /创建项目文件/);
    assert.deepStrictEqual(
      JSON.parse(firstBody.choices[0].message.tool_calls[0].function.arguments),
      { command: 'node .gate8-rehearsal-actions.mjs create' }
    );

    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [
          { role: 'user', content: 'GATE8_REHEARSAL_CREATE' },
          { role: 'tool', tool_call_id: 'call_create', content: 'GATE8_CREATE_OK' }
        ],
        tools
      })
    });
    assert.strictEqual(second.status, 200);
    const secondBody = await second.json();
    assert.match(
      JSON.parse(secondBody.choices[0].message.tool_calls[0].function.arguments).command,
      /GATE8_CREATE_TEST_OK/
    );

    const final = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [
          { role: 'user', content: 'GATE8_REHEARSAL_CREATE' },
          { role: 'tool', tool_call_id: 'call_create', content: 'GATE8_CREATE_OK' },
          { role: 'tool', tool_call_id: 'call_test', content: 'GATE8_CREATE_TEST_OK' }
        ],
        tools
      })
    });
    assert.strictEqual(final.status, 200);
    const finalBody = await final.json();
    assert.match(finalBody.choices[0].message.content, /GATE8_CREATE_COMPLETE/);
    assert.strictEqual(finalBody.choices[0].message.tool_calls, undefined);
  });

  await t.test('Gate 8 rehearsal returns a tool-free native compaction summary', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{
          role: 'user',
          content: 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.'
        }],
        stream: true
      })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.match(body, /GATE8_NATIVE_COMPACTION_OK/);
    assert.doesNotMatch(body, /tool_calls/);
  });

  await t.test('Gate 8 diverse inventory mode drives an edit and host-test sequence', async () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'shell_command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    }];
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gate2-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE8_MATRIX_INVENTORY_REPAIR' }],
        tools
      })
    });
    const firstBody = await first.json();
    assert.deepStrictEqual(
      JSON.parse(firstBody.choices[0].message.tool_calls[0].function.arguments),
      { command: 'node .gate8-diverse-actions.mjs inventory-repair' }
    );

    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gate2-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [
          { role: 'user', content: 'GATE8_MATRIX_INVENTORY_REPAIR' },
          { role: 'tool', tool_call_id: 'call_repair', content: 'MATRIX_INVENTORY_REPAIR_OK' }
        ],
        tools
      })
    });
    const secondBody = await second.json();
    assert.match(
      JSON.parse(secondBody.choices[0].message.tool_calls[0].function.arguments).command,
      /MATRIX_INVENTORY_REPAIR_TEST_OK/
    );
  });

  await t.test('Gate 8 failed-launch mode diagnoses after one failed command without replay', async () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'shell_command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    }];
    const request = async (toolContents) => {
      const messages = [{ role: 'user', content: 'GATE8_MATRIX_FAILED_LAUNCH' }];
      for (const [index, content] of toolContents.entries()) {
        messages.push({ role: 'tool', tool_call_id: `call_${index}`, content });
      }
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gate2-test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gate2-chat-model', messages, tools })
      });
      return response.json();
    };
    const first = await request([]);
    assert.deepStrictEqual(
      JSON.parse(first.choices[0].message.tool_calls[0].function.arguments),
      { command: 'node process-edge/start-service.mjs' }
    );
    const second = await request(['MATRIX_CONFIG_MISSING']);
    assert.deepStrictEqual(
      JSON.parse(second.choices[0].message.tool_calls[0].function.arguments),
      { command: 'node .gate8-diverse-actions.mjs diagnose-failed-launch' }
    );
    const final = await request(['MATRIX_CONFIG_MISSING', 'MATRIX_FAILURE_DIAGNOSED']);
    assert.match(final.choices[0].message.content, /GATE8_MATRIX_FAILED_LAUNCH_COMPLETE/);
    assert.strictEqual(final.choices[0].message.tool_calls, undefined);
  });

  await t.test('Gate 8 already-running mode audits state without a launch command', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gate2-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE8_MATRIX_ALREADY_RUNNING' }],
        tools: [{
          type: 'function',
          function: {
            name: 'shell_command',
            parameters: { type: 'object', properties: { command: { type: 'string' } } }
          }
        }]
      })
    });
    const body = await response.json();
    const command = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).command;
    assert.strictEqual(command, 'node .gate8-diverse-actions.mjs audit-already-running');
    assert.doesNotMatch(command, /start-service/);
  });

  await t.test('Gate 8 rehearsal quota error is terminal and distinguishable', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE8_REHEARSAL_QUOTA' }]
      })
    });
    assert.strictEqual(res.status, 429);
    const error = await res.json();
    assert.strictEqual(error.error.code, 'quota_exceeded');
  });

  await t.test('Gate 8 interruption waits in the provider after the completed action', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [
          { role: 'user', content: 'GATE8_REHEARSAL_INTERRUPT' },
          { role: 'tool', tool_call_id: 'call_once', content: 'GATE8_ONCE_OK' }
        ],
        stream: true
      }),
      signal: controller.signal
    });
    assert.strictEqual(res.status, 200);
    const first = await res.body.getReader().read();
    assert.match(new TextDecoder().decode(first.value), /chat\.completion\.chunk/);
    controller.abort();
  });

  // Test 9: Cancellation/disconnect logging
  await t.test('Cancellation disconnect logging works', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_SLOW' }],
        stream: true
      }),
      signal: controller.signal
    });

    assert.strictEqual(res.status, 200);

    const reader = res.body.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.ok(text.includes('chat.completion.chunk'));
    } finally {
      reader.releaseLock();
    }

    try {
      controller.abort();
    } catch (e) {
      // ignore
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const logContent = fs.readFileSync(logPath, 'utf8');
    const lines = logContent.trim().split('\n');
    let slowRecord = null;
    for (const line of lines) {
      if (line) {
        const record = JSON.parse(line);
        if (record.response_mode === 'GATE2_SLOW') {
          slowRecord = record;
        }
      }
    }

    assert.ok(slowRecord);
    assert.strictEqual(slowRecord.disconnected, true);
  });

  await t.test('Pre-header cancellation disconnect logging works', async () => {
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_SLOW_HEADERS' }],
        stream: true
      }),
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(request, (error) => error?.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 500));

    const records = fs.readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const record = records.find(entry => entry.response_mode === 'GATE2_SLOW_HEADERS');
    assert.ok(record);
    assert.strictEqual(record.disconnected, true);
  });

  // Test 10: GATE2_NETWORK triggers network disconnection
  await t.test('GATE2_NETWORK triggers network disconnection', async () => {
    let fetchError = null;
    try {
      await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer gate2-test-key',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gate2-chat-model',
          messages: [{ role: 'user', content: 'GATE2_NETWORK' }]
        })
      });
    } catch (err) {
      fetchError = err;
    }

    assert.ok(fetchError, 'Fetch should fail due to network disconnection');

    // Wait a brief moment for the log to be written
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify log file contains GATE2_NETWORK with disconnected: true
    const logContent = fs.readFileSync(logPath, 'utf8');
    const lines = logContent.trim().split('\n');
    let networkRecord = null;
    for (const line of lines) {
      if (line) {
        const record = JSON.parse(line);
        if (record.response_mode === 'GATE2_NETWORK') {
          networkRecord = record;
        }
      }
    }

    assert.ok(networkRecord, 'Log record for GATE2_NETWORK must exist');
    assert.strictEqual(networkRecord.disconnected, true, 'Log record disconnected must be true');
  });

  // Test 11: GATE2_TOOL with 'input' parameter in schema
  await t.test('GATE2_TOOL with input parameter schema', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_TOOL' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'local_shell',
              parameters: {
                type: 'object',
                properties: { input: { type: 'string' } },
                required: ['input']
              }
            }
          }
        ]
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const toolCall = data.choices[0].message.tool_calls[0];
    assert.strictEqual(toolCall.function.name, 'local_shell');
    assert.deepStrictEqual(JSON.parse(toolCall.function.arguments), { input: 'Write-Output GATE2_TOOL_OUTPUT' });
  });

  // Test 12: GATE2_TOOL fallback to first function with minimal params
  await t.test('GATE2_TOOL fallback to first function with minimal params', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gate2-test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gate2-chat-model',
        messages: [{ role: 'user', content: 'GATE2_TOOL' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'custom_math_tool',
              parameters: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' }
                },
                required: ['x', 'y']
              }
            }
          }
        ]
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const toolCall = data.choices[0].message.tool_calls[0];
    assert.strictEqual(toolCall.function.name, 'custom_math_tool');
    assert.deepStrictEqual(JSON.parse(toolCall.function.arguments), { x: 0, y: 0 });
  });
});
