import http from 'http';
import fs from 'fs';
import crypto from 'crypto';

// CLI argument parsing
let host = '127.0.0.1';
let port = 0;
let logPath = null;
let readyPath = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--host=')) {
    host = arg.slice(7);
  } else if (arg === '--host' && i + 1 < process.argv.length) {
    host = process.argv[++i];
  } else if (arg.startsWith('--port=')) {
    port = parseInt(arg.slice(7), 10);
  } else if (arg === '--port' && i + 1 < process.argv.length) {
    port = parseInt(process.argv[++i], 10);
  } else if (arg.startsWith('--log=')) {
    logPath = arg.slice(6);
  } else if (arg === '--log' && i + 1 < process.argv.length) {
    logPath = process.argv[++i];
  } else if (arg.startsWith('--ready=')) {
    readyPath = arg.slice(8);
  } else if (arg === '--ready' && i + 1 < process.argv.length) {
    readyPath = process.argv[++i];
  }
}

function generateMinimalJson(schema) {
  if (!schema || typeof schema !== 'object') return {};
  if (schema.type === 'object') {
    const obj = {};
    const required = schema.required || [];
    const properties = schema.properties || {};
    for (const key of Object.keys(properties)) {
      if (required.includes(key)) {
        obj[key] = generateMinimalJson(properties[key]);
      }
    }
    return obj;
  }
  if (schema.type === 'string') return "";
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [];
  return null;
}

function sendNormalText(res, id, created, model, text) {
  const responseBody = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text
      },
      logprobs: null,
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: Math.max(1, Math.ceil(text.length / 4)),
      total_tokens: 10 + Math.max(1, Math.ceil(text.length / 4))
    }
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseBody));
}

function sendStreamText(res, id, created, model, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const chunk1 = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "" },
      logprobs: null,
      finish_reason: null
    }]
  };
  res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

  const chunk2 = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta: { content: text },
      logprobs: null,
      finish_reason: null
    }]
  };
  res.write(`data: ${JSON.stringify(chunk2)}\n\n`);

  const chunk3 = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta: {},
      logprobs: null,
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: Math.max(1, Math.ceil(text.length / 4)),
      total_tokens: 10 + Math.max(1, Math.ceil(text.length / 4))
    }
  };
  res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function selectShellTool(tools) {
  const shellNames = ['shell_command', 'local_shell', 'shell', 'exec'];
  for (const name of shellNames) {
    const match = tools.find(tool => tool.type === 'function' && tool.function?.name === name);
    if (match) return match;
  }
  return null;
}

function shellToolArguments(tool, command) {
  const properties = tool?.function?.parameters?.properties || {};
  if ('command' in properties) return JSON.stringify({ command });
  if ('input' in properties) return JSON.stringify({ input: command });
  return null;
}

function sendCommandToolCall(res, options) {
  const {
    id,
    created,
    model,
    stream,
    tool,
    command,
    preamble,
  } = options;
  const args = shellToolArguments(tool, command);
  if (!args) return false;
  const toolCallId = `call_${crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;

  if (!stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: preamble,
          tool_calls: [{
            id: toolCallId,
            type: 'function',
            function: { name: tool.function.name, arguments: args }
          }]
        },
        logprobs: null,
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    }));
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: preamble,
        tool_calls: [{
          index: 0,
          id: toolCallId,
          type: 'function',
          function: { name: tool.function.name, arguments: '' }
        }]
      },
      logprobs: null,
      finish_reason: null
    }]
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
      logprobs: null,
      finish_reason: null
    }]
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {},
      logprobs: null,
      finish_reason: 'tool_calls'
    }]
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
  return true;
}

function sendPendingRehearsalStream(req, res, id, created, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: '' },
      logprobs: null,
      finish_reason: null
    }]
  })}\n\n`);
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: { content: '' },
        logprobs: null,
        finish_reason: null
      }]
    })}\n\n`);
  }, 250);
  const stop = () => clearInterval(heartbeat);
  req.once('aborted', stop);
  res.once('close', stop);
}

function gate8RehearsalStep(responseMode, toolContents) {
  const has = marker => toolContents.some(content => content.includes(marker));
  const testCommand = marker => `node --test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Write-Output ${marker}`;
  const steps = {
    GATE8_REHEARSAL_CREATE: [
      ['GATE8_CREATE_OK', 'node .gate8-rehearsal-actions.mjs create', '我先创建项目文件并记录第一轮改动。'],
      ['GATE8_CREATE_TEST_OK', testCommand('GATE8_CREATE_TEST_OK'), '文件已经创建，现在运行第一轮真实测试。'],
    ],
    GATE8_REHEARSAL_CORRECT: [
      ['GATE8_CORRECT_OK', 'node .gate8-rehearsal-actions.mjs correct', '我先按你的纠正修改实现和测试。'],
      ['GATE8_CORRECT_TEST_OK', testCommand('GATE8_CORRECT_TEST_OK'), '纠正已经落盘，现在重新运行测试。'],
    ],
    GATE8_REHEARSAL_EXTEND: [
      ['GATE8_EXTEND_OK', 'node .gate8-rehearsal-actions.mjs extend', '我继续增加汇总功能和对应测试。'],
      ['GATE8_EXTEND_TEST_OK', testCommand('GATE8_EXTEND_TEST_OK'), '第三轮编辑完成，现在运行完整测试。'],
    ],
    GATE8_REHEARSAL_AUDIT: [
      ['GATE8_AUDIT_TEST_OK', testCommand('GATE8_AUDIT_TEST_OK'), '我先做只读测试，不再修改项目文件。'],
      ['GATE8_AUDIT_OK', 'node .gate8-rehearsal-actions.mjs audit', '测试通过，现在只读核对文件与关键行为。'],
    ],
    GATE8_REHEARSAL_INTERRUPT: [
      ['GATE8_ONCE_OK', 'node .gate8-rehearsal-actions.mjs once', '我先执行一次不可重复的落盘动作。'],
    ],
    GATE8_REHEARSAL_RESUME: [
      ['GATE8_RESUME_OK', 'node .gate8-rehearsal-actions.mjs resume', '我会从同一任务继续，只写续跑结果，不重放已完成动作。'],
    ],
  };
  const sequence = steps[responseMode];
  if (!sequence) return null;
  for (const [marker, command, preamble] of sequence) {
    if (!has(marker)) return { marker, command, preamble };
  }
  return { complete: true };
}

function gate8FinalText(responseMode) {
  return ({
    GATE8_REHEARSAL_CREATE: 'GATE8_CREATE_COMPLETE：第一轮文件和测试均已完成。',
    GATE8_REHEARSAL_CORRECT: 'GATE8_CORRECT_COMPLETE：已按用户纠正修改并重新验证。',
    GATE8_REHEARSAL_EXTEND: 'GATE8_EXTEND_COMPLETE：第三轮功能扩展和完整测试均已完成。',
    GATE8_REHEARSAL_AUDIT: 'GATE8_AUDIT_COMPLETE：只读复核通过，未修改项目文件。',
    GATE8_REHEARSAL_INTERRUPT: 'GATE8_INTERRUPT_COMPLETE：可控等待已经结束。',
    GATE8_REHEARSAL_RESUME: 'GATE8_RESUME_COMPLETE：同任务续跑完成，已完成动作没有重放。',
  })[responseMode] || 'GATE8_REHEARSAL_COMPLETE';
}

function gate8MatrixStep(responseMode, toolContents) {
  const has = marker => toolContents.some(content => content.includes(marker));
  const steps = {
    GATE8_MATRIX_INVENTORY_REPAIR: [
      ['MATRIX_INVENTORY_REPAIR_OK', 'node .gate8-diverse-actions.mjs inventory-repair', '我先修复现有实现，不改保护文件。'],
      ['MATRIX_INVENTORY_REPAIR_TEST_OK', 'node --test inventory-project/inventory.test.mjs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Write-Output MATRIX_INVENTORY_REPAIR_TEST_OK', '实现已落盘，现在运行现有测试确认结果。'],
    ],
    GATE8_MATRIX_INVENTORY_CORRECT: [
      ['MATRIX_INVENTORY_CORRECT_OK', 'node .gate8-diverse-actions.mjs inventory-correct', '我按新的业务规则修改当前实现和测试。'],
      ['MATRIX_INVENTORY_CORRECT_TEST_OK', 'node --test inventory-project/inventory.test.mjs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node inventory-project/inventory.mjs --input inventory-project/data/inventory.json --output inventory-project/summary.json; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Write-Output MATRIX_INVENTORY_CORRECT_TEST_OK', '业务规则已更新，现在验证测试和真实 CLI 输出。'],
    ],
    GATE8_MATRIX_INVENTORY_REPORT: [
      ['MATRIX_INVENTORY_REPORT_OK', 'node .gate8-diverse-actions.mjs inventory-report', '我根据已经跑出的汇总结果生成中文交付文件。'],
      ['MATRIX_INVENTORY_REPORT_VERIFY_OK', 'node .gate8-diverse-actions.mjs verify-inventory', '交付文件已生成，现在只读核对测试、指标和编码。'],
    ],
    GATE8_MATRIX_INVENTORY_RECOVER: [
      ['MATRIX_INVENTORY_RECOVER_OK', 'node .gate8-diverse-actions.mjs recover-inventory', '我先检查中断现场并只执行一次恢复。'],
    ],
    GATE8_MATRIX_INVENTORY_RESUME: [
      ['MATRIX_INVENTORY_RESUME_OK', 'node .gate8-diverse-actions.mjs audit-inventory-resume', '我从同一任务继续，只复核恢复结果，不重放恢复动作。'],
    ],
    GATE8_MATRIX_ALREADY_RUNNING: [
      ['MATRIX_ALREADY_RUNNING_AUDITED', 'node .gate8-diverse-actions.mjs audit-already-running', '我先读取现有运行状态；已经运行时不会再次启动。'],
    ],
    GATE8_MATRIX_FAILED_LAUNCH: [
      ['MATRIX_CONFIG_MISSING', 'node process-edge/start-service.mjs', '我会启动一次并记录真实退出结果。'],
      ['MATRIX_FAILURE_DIAGNOSED', 'node .gate8-diverse-actions.mjs diagnose-failed-launch', '启动已经明确失败；我现在记录根因，不会循环重启。'],
    ],
  };
  const sequence = steps[responseMode];
  if (!sequence) return null;
  for (const [marker, command, preamble] of sequence) {
    if (!has(marker)) return { marker, command, preamble };
  }
  return { complete: true };
}

function gate8MatrixFinalText(responseMode) {
  return ({
    GATE8_MATRIX_INVENTORY_REPAIR: 'GATE8_MATRIX_INVENTORY_REPAIR_COMPLETE：现有项目修复并通过测试。',
    GATE8_MATRIX_INVENTORY_CORRECT: 'GATE8_MATRIX_INVENTORY_CORRECT_COMPLETE：业务纠正和真实 CLI 结果均已通过。',
    GATE8_MATRIX_INVENTORY_REPORT: 'GATE8_MATRIX_INVENTORY_REPORT_COMPLETE：中文交付文件已按真实结果生成。',
    GATE8_MATRIX_INVENTORY_RECOVER: 'GATE8_MATRIX_INVENTORY_RECOVER_COMPLETE：中断恢复动作已完成一次。',
    GATE8_MATRIX_INVENTORY_RESUME: 'GATE8_MATRIX_INVENTORY_RESUME_COMPLETE：同任务恢复后复核完成，没有重放。',
    GATE8_MATRIX_ALREADY_RUNNING: 'GATE8_MATRIX_ALREADY_RUNNING_COMPLETE：确认服务已运行，没有重复启动。',
    GATE8_MATRIX_FAILED_LAUNCH: 'GATE8_MATRIX_FAILED_LAUNCH_COMPLETE：启动失败已诊断，没有无限重试。',
  })[responseMode] || 'GATE8_MATRIX_COMPLETE';
}

const server = http.createServer((req, res) => {
  const logRecord = {
    timestamp: new Date().toISOString(),
    path: req.url,
    model: null,
    stream: false,
    roles: [],
    latest_user_text: null,
    tool_names: [],
    tool_shapes: [],
    tool_message_contents: [],
    response_mode: 'NORMAL',
    disconnected: false,
    disconnect_kind: null
  };

  let logWritten = false;
  let finished = false;

  function writeLog() {
    if (logWritten) return;
    logWritten = true;
    if (logPath) {
      try {
        fs.appendFileSync(logPath, JSON.stringify(logRecord) + '\n');
      } catch (err) {
        console.error("Failed to write to log file:", err);
      }
    }
  }

  res.on('finish', () => {
    finished = true;
    writeLog();
  });

  res.on('close', () => {
    if (!finished) {
      logRecord.disconnected = true;
      logRecord.disconnect_kind = 'response_close';
      writeLog();
    }
  });

  req.once('aborted', () => {
    if (!finished) {
      logRecord.disconnected = true;
      logRecord.disconnect_kind = 'request_aborted';
      writeLog();
    }
  });

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: "ok" }));
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: "list",
      data: [
        {
          id: "gate2-chat-model",
          object: "model",
          created: 1686935002,
          owned_by: "organization-owner"
        }
      ]
    }));
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 2 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Payload Too Large", type: "invalid_request_error" } }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (res.writableEnded) return;

      let reqBody;
      try {
        reqBody = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
            param: null,
            code: "parse_error"
          }
        }));
      }

      if (!reqBody || !Array.isArray(reqBody.messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: "Field 'messages' is required and must be an array",
            type: "invalid_request_error",
            param: "messages",
            code: "invalid_type"
          }
        }));
      }

      const messages = reqBody.messages;
      const latestUserMsg = messages.slice().reverse().find(m => m.role === 'user');
      let latestUserText = '';
      if (latestUserMsg) {
        if (typeof latestUserMsg.content === 'string') {
          latestUserText = latestUserMsg.content;
        } else if (Array.isArray(latestUserMsg.content)) {
          latestUserText = latestUserMsg.content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join(' ');
        }
      }

      let responseMode = 'NORMAL';
      if (latestUserText.includes('CONTEXT CHECKPOINT COMPACTION')) responseMode = 'GATE8_REHEARSAL_NATIVE_COMPACTION';
      else if (latestUserText.includes('GATE8_MATRIX_INVENTORY_REPAIR')) responseMode = 'GATE8_MATRIX_INVENTORY_REPAIR';
      else if (latestUserText.includes('GATE8_MATRIX_INVENTORY_CORRECT')) responseMode = 'GATE8_MATRIX_INVENTORY_CORRECT';
      else if (latestUserText.includes('GATE8_MATRIX_INVENTORY_REPORT')) responseMode = 'GATE8_MATRIX_INVENTORY_REPORT';
      else if (latestUserText.includes('GATE8_MATRIX_INVENTORY_RECOVER')) responseMode = 'GATE8_MATRIX_INVENTORY_RECOVER';
      else if (latestUserText.includes('GATE8_MATRIX_INVENTORY_RESUME')) responseMode = 'GATE8_MATRIX_INVENTORY_RESUME';
      else if (latestUserText.includes('GATE8_MATRIX_ALREADY_RUNNING')) responseMode = 'GATE8_MATRIX_ALREADY_RUNNING';
      else if (latestUserText.includes('GATE8_MATRIX_FAILED_LAUNCH')) responseMode = 'GATE8_MATRIX_FAILED_LAUNCH';
      else if (latestUserText.includes('GATE8_REHEARSAL_CREATE')) responseMode = 'GATE8_REHEARSAL_CREATE';
      else if (latestUserText.includes('GATE8_REHEARSAL_CORRECT')) responseMode = 'GATE8_REHEARSAL_CORRECT';
      else if (latestUserText.includes('GATE8_REHEARSAL_EXTEND')) responseMode = 'GATE8_REHEARSAL_EXTEND';
      else if (latestUserText.includes('GATE8_REHEARSAL_AUDIT')) responseMode = 'GATE8_REHEARSAL_AUDIT';
      else if (latestUserText.includes('GATE8_REHEARSAL_INTERRUPT')) responseMode = 'GATE8_REHEARSAL_INTERRUPT';
      else if (latestUserText.includes('GATE8_REHEARSAL_RESUME')) responseMode = 'GATE8_REHEARSAL_RESUME';
      else if (latestUserText.includes('GATE8_REHEARSAL_QUOTA')) responseMode = 'GATE8_REHEARSAL_QUOTA';
      else if (latestUserText.includes('GATE2_TEXT')) responseMode = 'GATE2_TEXT';
      else if (latestUserText.includes('GATE2_MULTI_A')) responseMode = 'GATE2_MULTI_A';
      else if (latestUserText.includes('GATE2_MULTI_B')) responseMode = 'GATE2_MULTI_B';
      else if (latestUserText.includes('GATE2_TOOL')) responseMode = 'GATE2_TOOL';
      else if (latestUserText.includes('GATE2_SLOW_HEADERS')) responseMode = 'GATE2_SLOW_HEADERS';
      else if (latestUserText.includes('GATE2_SLOW')) responseMode = 'GATE2_SLOW';
      else if (latestUserText.includes('GATE2_AUTH')) responseMode = 'GATE2_AUTH';
      else if (latestUserText.includes('GATE2_QUOTA')) responseMode = 'GATE2_QUOTA';
      else if (latestUserText.includes('GATE2_SERVER_ERROR')) responseMode = 'GATE2_SERVER_ERROR';
      else if (latestUserText.includes('GATE2_NETWORK')) responseMode = 'GATE2_NETWORK';

      // Update log record
      logRecord.model = reqBody.model || null;
      logRecord.stream = !!reqBody.stream;
      logRecord.roles = messages.map(m => m.role);
      logRecord.latest_user_text = latestUserText || null;
      logRecord.tool_names = Array.isArray(reqBody.tools) ? reqBody.tools.map(t => t.function?.name || t.name).filter(Boolean) : [];
      logRecord.tool_shapes = Array.isArray(reqBody.tools) ? reqBody.tools.map(t => ({
        type: t.type || null,
        name: t.function?.name || t.name || null,
        parameter_keys: Object.keys(t.function?.parameters?.properties || t.parameters?.properties || {})
      })) : [];
      logRecord.tool_message_contents = messages.filter(m => m.role === 'tool').map(m => String(m.content));
      logRecord.response_mode = responseMode;

      // Validate Authorization header
      const auth = req.headers['authorization'];
      if (!auth || auth !== 'Bearer gate2-test-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: "Invalid API key or Authorization header missing",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key"
          }
        }));
      }

      // Check deterministic tag GATE2_NETWORK immediately after authentication
      if (responseMode === 'GATE2_NETWORK') {
        logRecord.response_mode = 'GATE2_NETWORK';
        logRecord.disconnected = true;
        logRecord.disconnect_kind = 'upstream_socket_destroy';
        writeLog();
        req.socket?.destroy();
        return;
      }

      // Simulated Errors
      if (responseMode === 'GATE2_AUTH') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: "Unauthorized (GATE2_AUTH simulated)",
            type: "invalid_request_error",
            param: null,
            code: "unauthorized"
          }
        }));
      }

      if (responseMode === 'GATE2_QUOTA' || responseMode === 'GATE8_REHEARSAL_QUOTA') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: responseMode === 'GATE2_QUOTA'
              ? "Quota exceeded (GATE2_QUOTA simulated)"
              : "Quota exhausted (GATE8_REHEARSAL_QUOTA simulated)",
            type: "requests",
            param: null,
            code: responseMode === 'GATE2_QUOTA' ? "rate_limit_exceeded" : "quota_exceeded"
          }
        }));
      }

      if (responseMode === 'GATE2_SERVER_ERROR') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: "Internal server error (GATE2_SERVER_ERROR simulated)",
            type: "api_error",
            param: null,
            code: "internal_error"
          }
        }));
      }

      if (responseMode === 'GATE2_MULTI_B') {
        const hasPriorA = messages.some(m => {
          return m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('GATE2_MULTI_A_OK');
        });

        if (!hasPriorA) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: "Multi-turn conversation error: Prior assistant content must contain GATE2_MULTI_A_OK",
              type: "invalid_request_error",
              param: "messages",
              code: "multi_turn_violation"
            }
          }));
        }
      }

      const stream = !!reqBody.stream;
      const model = reqBody.model || 'gate2-chat-model';
      const createdTime = Math.floor(Date.now() / 1000);
      const chatCmplId = `chatcmpl-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

      if (responseMode === 'GATE8_REHEARSAL_NATIVE_COMPACTION') {
        const summary = 'GATE8_NATIVE_COMPACTION_OK: preserve the current project state, completed edits, test evidence, user correction, and next same-thread action without replaying completed commands.';
        if (stream) sendStreamText(res, chatCmplId, createdTime, model, summary);
        else sendNormalText(res, chatCmplId, createdTime, model, summary);
        return;
      }

      if (responseMode.startsWith('GATE8_MATRIX_')) {
        if (responseMode === 'GATE8_MATRIX_INVENTORY_RECOVER'
          && logRecord.tool_message_contents.some(content => content.includes('MATRIX_INVENTORY_RECOVER_OK'))) {
          logRecord.response_mode = 'GATE8_MATRIX_INVENTORY_RECOVER_PENDING';
          sendPendingRehearsalStream(req, res, chatCmplId, createdTime, model);
          return;
        }
        const step = gate8MatrixStep(responseMode, logRecord.tool_message_contents);
        if (!step) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: `Unsupported Gate 8 matrix mode: ${responseMode}`,
              type: 'invalid_request_error',
              param: null,
              code: 'unsupported_matrix_mode'
            }
          }));
        }
        if (step.complete) {
          const responseText = gate8MatrixFinalText(responseMode);
          if (stream) sendStreamText(res, chatCmplId, createdTime, model, responseText);
          else sendNormalText(res, chatCmplId, createdTime, model, responseText);
          return;
        }
        const selectedTool = selectShellTool(reqBody.tools || []);
        logRecord.tool_command = step.command;
        if (!selectedTool || !sendCommandToolCall(res, {
          id: chatCmplId,
          created: createdTime,
          model,
          stream,
          tool: selectedTool,
          command: step.command,
          preamble: step.preamble,
        })) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: 'Gate 8 matrix requires a shell command tool',
              type: 'invalid_request_error',
              param: 'tools',
              code: 'missing_shell_tool'
            }
          }));
        }
        return;
      }

      if (responseMode.startsWith('GATE8_REHEARSAL_')) {
        if (responseMode === 'GATE8_REHEARSAL_INTERRUPT'
          && logRecord.tool_message_contents.some(content => content.includes('GATE8_ONCE_OK'))) {
          logRecord.response_mode = 'GATE8_REHEARSAL_INTERRUPT_PENDING';
          sendPendingRehearsalStream(req, res, chatCmplId, createdTime, model);
          return;
        }
        const step = gate8RehearsalStep(responseMode, logRecord.tool_message_contents);
        if (!step) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: `Unsupported Gate 8 rehearsal mode: ${responseMode}`,
              type: 'invalid_request_error',
              param: null,
              code: 'unsupported_rehearsal_mode'
            }
          }));
        }
        if (step.complete) {
          const responseText = gate8FinalText(responseMode);
          if (stream) sendStreamText(res, chatCmplId, createdTime, model, responseText);
          else sendNormalText(res, chatCmplId, createdTime, model, responseText);
          return;
        }
        const selectedTool = selectShellTool(reqBody.tools || []);
        logRecord.tool_command = step.command;
        if (!selectedTool || !sendCommandToolCall(res, {
          id: chatCmplId,
          created: createdTime,
          model,
          stream,
          tool: selectedTool,
          command: step.command,
          preamble: step.preamble,
        })) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: 'Gate 8 rehearsal requires a shell command tool',
              type: 'invalid_request_error',
              param: 'tools',
              code: 'missing_shell_tool'
            }
          }));
        }
      } else if (responseMode === 'GATE2_TOOL') {
        const toolMsgExists = messages.some(m => m.role === 'tool');

        if (!toolMsgExists) {
          const tools = reqBody.tools || [];
          const shellNames = ['shell_command', 'local_shell', 'shell', 'exec'];
          let selectedTool = null;

          for (const name of shellNames) {
            const found = tools.find(t => t.type === 'function' && t.function?.name === name);
            if (found) {
              selectedTool = found;
              break;
            }
          }

          if (!selectedTool && tools.length > 0) {
            selectedTool = tools.find(t => t.type === 'function');
          }

          if (!selectedTool) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              error: {
                message: "GATE2_TOOL requested but no valid tools supplied in request",
                type: "invalid_request_error",
                param: "tools",
                code: "missing_tools"
              }
            }));
          }

          let selectedArgs = '{}';
          const params = selectedTool.function?.parameters;
          const properties = params?.properties || {};

          if (shellNames.includes(selectedTool.function?.name)) {
            if ('command' in properties) {
              selectedArgs = JSON.stringify({ command: "Write-Output GATE2_TOOL_OUTPUT" });
            } else if ('input' in properties) {
              selectedArgs = JSON.stringify({ input: "Write-Output GATE2_TOOL_OUTPUT" });
            } else {
              selectedArgs = JSON.stringify(generateMinimalJson(params));
            }
          } else {
            selectedArgs = JSON.stringify(generateMinimalJson(params));
          }

          const toolCallId = `call_${crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;

          if (stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });

            const chunk1 = {
              id: chatCmplId,
              object: "chat.completion.chunk",
              created: createdTime,
              model: model,
              choices: [{
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [{
                    index: 0,
                    id: toolCallId,
                    type: "function",
                    function: {
                      name: selectedTool.function.name,
                      arguments: ""
                    }
                  }]
                },
                logprobs: null,
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

            const chunk2 = {
              id: chatCmplId,
              object: "chat.completion.chunk",
              created: createdTime,
              model: model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: {
                      arguments: selectedArgs
                    }
                  }]
                },
                logprobs: null,
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(chunk2)}\n\n`);

            const chunk3 = {
              id: chatCmplId,
              object: "chat.completion.chunk",
              created: createdTime,
              model: model,
              choices: [{
                index: 0,
                delta: {},
                logprobs: null,
                finish_reason: "tool_calls"
              }]
            };
            res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          } else {
            const responseBody = {
              id: chatCmplId,
              object: "chat.completion",
              created: createdTime,
              model: model,
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: toolCallId,
                    type: "function",
                    function: {
                      name: selectedTool.function.name,
                      arguments: selectedArgs
                    }
                  }]
                },
                logprobs: null,
                finish_reason: "tool_calls"
              }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30
              }
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(responseBody));
          }
        } else {
          const toolMsg = messages.find(m => m.role === 'tool');
          const toolContent = toolMsg ? toolMsg.content : '';
          const responseText = `GATE2_TOOL_RESULT:${toolContent || 'GATE2_TOOL_OUTPUT'}`;

          if (stream) {
            sendStreamText(res, chatCmplId, createdTime, model, responseText);
          } else {
            sendNormalText(res, chatCmplId, createdTime, model, responseText);
          }
        }
      } else if (responseMode === 'GATE2_SLOW_HEADERS') {
        const slowHeaderTimeout = setTimeout(() => {
          if (!logRecord.disconnected && !res.writableEnded) {
            sendStreamText(res, chatCmplId, createdTime, model, 'GATE2_SLOW_HEADERS_DONE');
          }
        }, 60000);
        req.on('aborted', () => clearTimeout(slowHeaderTimeout));
        res.on('close', () => clearTimeout(slowHeaderTimeout));
      } else if (responseMode === 'GATE2_SLOW') {
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const initialChunk = {
            id: chatCmplId,
            object: "chat.completion.chunk",
            created: createdTime,
            model: model,
            choices: [{
              index: 0,
              delta: { role: "assistant", content: "" },
              logprobs: null,
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

          const heartbeatInterval = setInterval(() => {
            if (!logRecord.disconnected && !res.writableEnded) {
              const heartbeat = {
                id: chatCmplId,
                object: "chat.completion.chunk",
                created: createdTime,
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: "" },
                  logprobs: null,
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
            }
          }, 250);

          const slowTimeout = setTimeout(() => {
            clearInterval(heartbeatInterval);
            if (!logRecord.disconnected && !res.writableEnded) {
              const finalChunk = {
                id: chatCmplId,
                object: "chat.completion.chunk",
                created: createdTime,
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: "GATE2_SLOW_DONE" },
                  logprobs: null,
                  finish_reason: "stop"
                }]
              };
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }, 60000);

          req.on('aborted', () => {
            clearInterval(heartbeatInterval);
            clearTimeout(slowTimeout);
          });
          res.on('close', () => {
            clearInterval(heartbeatInterval);
            clearTimeout(slowTimeout);
          });
        } else {
          const slowTimeout = setTimeout(() => {
            if (!logRecord.disconnected && !res.writableEnded) {
              sendNormalText(res, chatCmplId, createdTime, model, "GATE2_SLOW_DONE");
            }
          }, 60000);

          req.on('aborted', () => {
            clearTimeout(slowTimeout);
          });
        }
      } else {
        let responseText = 'GATE2_TEXT_OK';
        if (responseMode === 'GATE2_MULTI_A') responseText = 'GATE2_MULTI_A_OK';
        else if (responseMode === 'GATE2_MULTI_B') responseText = 'GATE2_MULTI_B_OK';
        else if (responseMode === 'NORMAL') responseText = 'NORMAL_RESPONSE';

        if (stream) {
          sendStreamText(res, chatCmplId, createdTime, model, responseText);
        } else {
          sendNormalText(res, chatCmplId, createdTime, model, responseText);
        }
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: `Route not found: ${req.method} ${req.url}`,
      type: "invalid_request_error",
      param: null,
      code: "not_found"
    }
  }));
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = address.port;
  const baseUrl = `http://${host}:${actualPort}`;

  if (readyPath) {
    const readyData = JSON.stringify({
      host,
      port: actualPort,
      baseUrl,
      pid: process.pid
    });
    const tmpPath = readyPath + '.' + Math.random().toString(36).slice(2) + '.tmp';
    try {
      fs.writeFileSync(tmpPath, readyData);
      fs.renameSync(tmpPath, readyPath);
    } catch (err) {
      console.error("Failed to write ready file:", err);
    }
  }

  console.log(JSON.stringify({
    event: 'ready',
    host,
    port: actualPort,
    baseUrl,
    pid: process.pid
  }));
});

const signals = ['SIGINT', 'SIGTERM'];
signals.forEach(signal => {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });
});
