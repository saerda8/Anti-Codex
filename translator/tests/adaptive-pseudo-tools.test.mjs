import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const {
  antigravityFailureDetails,
  artifactMarkerMismatchForChat,
  artifactMarkerMismatchRelayPrompt,
  buildSystemBlock,
  callAntigravityWithInternalTools,
  callUpstreamWithInternalTools,
  canUseNativeStreaming,
  chatBodyHasInternalTools,
  chatBodyWithInternalTools,
  ChatToResponsesStreamMapper,
  chatToCompactResponseFormat,
  chatToResponsesFormat,
  classifyUpstreamFailure,
  commandLaunchTargetKey,
  deterministicArtifactCompletionResponse,
  deterministicArtifactToolCallCompletion,
  deterministicAmbientSuggestionsCompletion,
  deterministicBackgroundRolloutAnalysisCompletion,
  deterministicExactReplyCompletion,
  genericLocalArtifactExactReplyEvidence,
  verifiedGenericLocalArtifactExactReplyReady,
  userTextRequiresProcessLaunch,
  deterministicRepoFileEditCompletionResponse,
  deterministicRepoFileEditToolCallCompletion,
  deterministicRepoMultiFileEditCompletionResponse,
  deterministicRepoMultiFileEditToolCallCompletion,
  deterministicTaskTitleCompletion,
  deterministicWebBackedArtifactResponse,
  hasPseudoToolMarkup,
  inputTokensResponse,
  localBackendApiResponse,
  localArtifactToolEvidenceMatchesUserText,
  localProjectToolMarkupExampleForBody,
  applyResponsesEndTurnHint,
  normalizeCompactSummary,
  parsePseudoToolCalls,
  pipeAntigravityResponseAsSSE,
  prepareCompactChatBody,
  responsesToChatBody,
  requestNeedsInternalWebTools,
  requestNeedsWebBackedArtifactOutput,
  requestLooksLikePlainChatNoTools,
  sanitizeMarkdownUrlFormatting,
  shouldUseDeterministicInternalWebSearchResponse,
  shouldRecordAntigravityTrafficFailure,
  stripPseudoToolMarkup,
  unknownInputItemText,
  usageDiagnostics,
  antigravityWorkspaceForRequest,
  antigravityStreamingTimeouts,
  workspaceCwdFromCodexSession,
  workspaceCwdFromRequest,
} = await import("../adaptive-server.mjs");

test("passing test names that mention TypeError remain valid local artifact evidence", () => {
  const userText = "Only edit C:\\Project\\package.json, run npm test, and verify the file has no BOM.";
  const evidence = [
    "Exit code: 0",
    "✔ normalizeEvent throws TypeError for null",
    "ℹ tests 18",
    "ℹ pass 18",
    "ℹ fail 0",
    "No BOM",
  ].join("\n");

  assert.equal(localArtifactToolEvidenceMatchesUserText(userText, evidence), true);
});

test("a later passing test summary cannot hide an earlier syntax failure", () => {
  const userText = "Only edit C:\\Project\\cli.mjs, run node --check cli.mjs, then run npm test.";
  const evidence = [
    "Exit code: 0",
    "SyntaxError: Identifier 'fs' has already been declared",
    "tests 18",
    "pass 18",
    "fail 0",
  ].join("\n");

  assert.equal(localArtifactToolEvidenceMatchesUserText(userText, evidence), false);
});

test("a passing test summary cannot hide a PowerShell parameter binding failure", () => {
  const userText = "Run npm test and verify C:\\Project has no UTF-8 BOM.";
  const evidence = [
    "Exit code: 0",
    "pass 19",
    "fail 0",
    "Get-Content : A parameter cannot be found that matches parameter name 'AsByteStream'.",
    "FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.GetContentCommand",
  ].join("\n");

  assert.equal(localArtifactToolEvidenceMatchesUserText(userText, evidence), false);
});

test("Antigravity thinking models receive longer default stream timeouts", () => {
  assert.deepEqual(antigravityStreamingTimeouts("claude-opus-4-6-thinking", {
    defaultIdleMs: 45_000,
    defaultTotalMs: 120_000,
  }), {
    idleMs: 120_000,
    totalMs: 300_000,
  });
  assert.deepEqual(antigravityStreamingTimeouts("claude-opus-4-6-thinking", {
    defaultIdleMs: 45_000,
    defaultTotalMs: 120_000,
    streamIdleTimeoutMs: 25,
    streamTotalTimeoutMs: 50,
  }), {
    idleMs: 25,
    totalMs: 50,
  });
  assert.deepEqual(antigravityStreamingTimeouts("gemini-3.5-flash-low", {
    defaultIdleMs: 45_000,
    defaultTotalMs: 120_000,
  }), {
    idleMs: 45_000,
    totalMs: 120_000,
  });
});

test("workspaceCwdFromRequest selects the latest standalone Codex environment context", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex workspace cwd "));
  const earlier = path.join(root, "earlier workspace");
  const current = path.join(root, "current workspace with spaces");
  fs.mkdirSync(earlier);
  fs.mkdirSync(current);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const environmentContext = (cwd) => `<environment_context>
  <cwd>${cwd}</cwd>
  <shell>powershell</shell>
  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots></filesystem>
</environment_context>`;
  const request = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: environmentContext(earlier) }] },
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `Do not treat this inline example as runtime context: ${environmentContext(path.join(root, "fake"))}`,
        }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: environmentContext(current) }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the task." }] },
    ],
  };

  assert.equal(workspaceCwdFromRequest(request), path.resolve(current));
});

test("workspaceCwdFromRequest reads the standalone environment context from a Codex developer item", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex developer cwd "));
  const current = path.join(root, "current workspace");
  fs.mkdirSync(current);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(workspaceCwdFromRequest({
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions>never</permissions instructions>" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: `<environment_context><cwd>${current}</cwd></environment_context>`,
        }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the task." }] },
    ],
  }), path.resolve(current));
});

test("workspaceCwdFromRequest rejects a Codex workspace that is a file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex workspace file "));
  const filePath = path.join(root, "not-a-directory.txt");
  fs.writeFileSync(filePath, "not a workspace", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => workspaceCwdFromRequest({
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `<environment_context><cwd>${filePath}</cwd></environment_context>`,
      }],
    }],
  }), /workspace is not a directory/i);
});

test("workspaceCwdFromRequest reads the latest context from a serialized Codex prompt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex serialized cwd "));
  const earlier = path.join(root, "earlier");
  const current = path.join(root, "current project");
  fs.mkdirSync(earlier);
  fs.mkdirSync(current);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const input = [
    "[SYSTEM]",
    "Codex transcript",
    "[USER]",
    `<environment_context><cwd>${earlier}</cwd></environment_context>`,
    "[USER]",
    "older task",
    "[USER]",
    `<environment_context><cwd>${current}</cwd></environment_context>`,
    "[USER]",
    "continue current task",
  ].join("\n\n");

  assert.equal(workspaceCwdFromRequest({ input }), path.resolve(current));
});

test("workspaceCwdFromCodexSession reads the latest turn_context without using prompt text", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex session cwd "));
  const sessionId = "019f4fa1-d845-7590-bf2d-a0644b0487b9";
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "11");
  const earlier = path.join(codexHome, "earlier workspace");
  const current = path.join(codexHome, "current workspace");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(earlier);
  fs.mkdirSync(current);
  const sessionPath = path.join(sessionDir, `rollout-2026-07-11T13-23-54-${sessionId}.jsonl`);
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: "turn_context", payload: { cwd: earlier, workspace_roots: [earlier] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "plain task" }] } }),
    JSON.stringify({ type: "turn_context", payload: { cwd: current, workspace_roots: [current] } }),
    "{partial trailing line",
  ].join("\n"), "utf8");
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  assert.equal(workspaceCwdFromCodexSession(sessionId, { codexHome }), path.resolve(current));
  assert.deepEqual(antigravityWorkspaceForRequest({ headers: { session_id: sessionId } }, {
    input: "Reply exactly once.",
  }, { codexHome }), {
    cwd: path.resolve(current),
    source: "codex-session-turn-context",
    sessionId,
  });
});

test("an explicit project directory overrides a drifted session and environment workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex explicit workspace "));
  const codexHome = path.join(root, "codex-home");
  const project = path.join(root, "real project with spaces");
  const drifted = path.join(root, "generated fallback workspace");
  const sessionId = "019f4fa1-d845-7590-bf2d-a0644b0487b9";
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "11");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(project);
  fs.mkdirSync(drifted);
  fs.writeFileSync(path.join(sessionDir, `rollout-2026-07-11T13-23-54-${sessionId}.jsonl`), JSON.stringify({
    type: "turn_context",
    payload: { cwd: drifted, workspace_roots: [drifted] },
  }), "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const request = {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `<environment_context><cwd>${drifted}</cwd></environment_context>` }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Continue the same task.\n\nProject directory:\n${project}\n\nRun the tests.` }],
      },
    ],
  };

  assert.equal(workspaceCwdFromRequest(request), path.resolve(project));
  assert.deepEqual(antigravityWorkspaceForRequest({ headers: { session_id: sessionId } }, request, { codexHome }), {
    cwd: path.resolve(project),
    source: "request-explicit-workspace",
    sessionId,
  });
});

test("a prior shell workdir keeps the project across a plain same-chat follow-up", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex retained workdir "));
  const project = path.join(root, "real project with spaces");
  const drifted = path.join(root, "generated fallback workspace");
  fs.mkdirSync(project);
  fs.mkdirSync(drifted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const request = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${drifted}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Run the project tests." }] },
      { type: "function_call", call_id: "call_test", name: "shell_command", arguments: JSON.stringify({ command: "npm test", workdir: project }) },
      { type: "function_call_output", call_id: "call_test", output: "Exit code: 0" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue in the same project." }] },
    ],
  };

  assert.equal(workspaceCwdFromRequest(request), path.resolve(project));
});

test("workspaceCwdFromRequest accepts an inline Chinese project-directory label", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex chinese workspace "));
  const project = path.join(root, "真实项目");
  const drifted = path.join(root, "generated fallback workspace");
  fs.mkdirSync(project);
  fs.mkdirSync(drifted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(workspaceCwdFromRequest({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${drifted}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `继续同一个项目。工作目录：${project}` }] },
    ],
  }), path.resolve(project));
});

const dsmlFetch = `最后抓一下 163 那篇比较全面的伤亡统计文章，确认乌克兰方面的完整数据：

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="web_fetch">
<｜｜DSML｜｜parameter name="url" string="true">https://m.163.com/news/article/KLMPU1SA0523C0OR.html</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;

const dsmlExec = `我需要查看文件列表：

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="exec_command">
<｜｜DSML｜｜parameter name="cmd" string="true">ls</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;

test("pseudo DSML tool calls are detected and stripped from text", () => {
  assert.equal(hasPseudoToolMarkup(dsmlFetch), true);
  const stripped = stripPseudoToolMarkup(dsmlFetch);
  assert.equal(stripped.includes("DSML"), false);
  assert.equal(stripped.includes("web_fetch"), false);
  assert.match(stripped, /最后抓一下 163/);
});

test("pseudo DSML web_fetch is parsed as an internal tool call", () => {
  const calls = parsePseudoToolCalls(dsmlFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "web_fetch");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    url: "https://m.163.com/news/article/KLMPU1SA0523C0OR.html",
  });
});

test("plain XML tool_call is detected, stripped, and parsed", () => {
  const xml = `<tool_call>
  <tool_name>web_search</tool_name>
  <parameters>
    <query>COMPACT_SEED_88282_20260614</query>
  </parameters>
</tool_call>`;

  assert.equal(hasPseudoToolMarkup(xml), true);
  assert.equal(stripPseudoToolMarkup(xml), "");
  const calls = parsePseudoToolCalls(xml);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "web_search");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    query: "COMPACT_SEED_88282_20260614",
  });
});

test("pseudo XML parameters decode standard entities before tool execution", () => {
  const xml = `<tool_calls><invoke name="shell_command"><parameter name="command">$body = @&apos;\nif (a &lt; b &amp;&amp; c &gt; d) { Write-Output &quot;ok&quot; }\n&apos;</parameter></invoke></tool_calls>`;
  const calls = parsePseudoToolCalls(xml);

  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].function.arguments).command, `$body = @'\nif (a < b && c > d) { Write-Output "ok" }\n'`);
});

test("oversized pseudo shell commands are returned as split-write guidance", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_OVERSIZED_20260712";
  const oversized = `$body = '${"x".repeat(15_000)}'; [System.IO.File]::WriteAllText('src/normalize.mjs', $body)`;
  const completion = {
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="shell_command"><parameter name="command">${oversized}</parameter></invoke></tool_calls>`,
      },
    }],
  };
  const fmt = chatToResponsesFormat(completion, {
    model: "gemini-3.5-flash-low",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Implement the project with real shell commands. Finish with ${marker}.` }],
    }],
  });
  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);

  assert.ok(args.command.length < 2_000);
  assert.match(args.command, /too long|split/i);
  assert.doesNotMatch(args.command, /x{100}/);
  assert.doesNotMatch(args.command, new RegExp(marker));
});

test("compact responses are returned as context_compaction items", () => {
  const formatted = chatToCompactResponseFormat({
    id: "chatcmpl_compact",
    created: 123,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    choices: [{
      message: { role: "assistant", content: "  当前进展：translator compact 已包装 context_compaction。下一步：继续验证 Codex 接受该结构。  " },
    }],
  }, "gpt-5.5");

  assert.equal(formatted.object, "response");
  assert.equal(formatted.status, "completed");
  assert.equal(formatted.output.length, 1);
  assert.deepEqual(formatted.output[0], {
    type: "context_compaction",
    summary: "当前进展：translator compact 已包装 context_compaction。下一步：继续验证 Codex 接受该结构。",
  });
  assert.equal(formatted.usage.total_tokens, 15);
});

test("compact chat body disables tools and adds strict compact instruction", () => {
  const prepared = prepareCompactChatBody({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "history" }],
    tools: [{ type: "function", function: { name: "web_search" } }],
  });

  assert.equal(prepared.stream, false);
  assert.equal(prepared.tool_choice, "none");
  assert.equal(prepared.tools, undefined);
  assert.equal(prepared.messages[0].role, "system");
  assert.match(prepared.messages[0].content, /CONTEXT CHECKPOINT COMPACTION/);
  assert.match(prepared.messages[0].content, /handoff summary/);
  assert.match(prepared.messages[0].content, /latest user request/);
  assert.match(prepared.messages[0].content, /active in-flight task/);
  assert.match(prepared.messages[0].content, /exact files, commands, parameters/);
  assert.match(prepared.messages[0].content, /one-line continuation instruction/);
  assert.match(prepared.messages[0].content, /What remains to be done/);
});

test("compact summary normalizer rejects acknowledgements", () => {
  const summary = normalizeCompactSummary("已理解，我会保存这些上下文用于后续工程。");
  assert.match(summary, /Compact summary unavailable/);
});

test("compact fallback preserves active task when upstream summary is weak", () => {
  const formatted = chatToCompactResponseFormat({
    id: "chatcmpl_compact_weak",
    choices: [{ message: { role: "assistant", content: "好的" } }],
  }, "gpt-5.5", {
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "text", text: "当前任务：把 Editorial.tsx 的 padding 从 280 改成 400，并继续检查 node news-pipeline/pipeline.js demo-001 的结果。" }],
    }],
  });

  const summary = formatted.output[0].summary;
  assert.match(summary, /上游模型没有返回可用的压缩摘要/);
  assert.match(summary, /Editorial\.tsx/);
  assert.match(summary, /280/);
  assert.match(summary, /400/);
  assert.match(summary, /news-pipeline\/pipeline\.js demo-001/);
});

test("compact fallback appends missing next action when upstream only preserves marker", () => {
  const formatted = chatToCompactResponseFormat({
    id: "chatcmpl_compact_marker_only",
    choices: [{ message: { role: "assistant", content: "COMPACT_SEED_29163_20260701" } }],
  }, "claude-sonnet-4-6", {
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Active task marker: COMPACT_SEED_29163_20260701. Completed: installed routing validation. Next action: verify installed compaction resume. Preserve the exact marker and next action for the next turn." }],
    }],
  });

  const summary = formatted.output[0].summary;
  assert.match(summary, /COMPACT_SEED_29163_20260701/);
  assert.match(summary, /Recovered compact input facts/);
  assert.match(summary, /Next action: verify installed compaction resume/);
});

test("compact summary normalizer unwraps json and fences", () => {
  assert.equal(normalizeCompactSummary('```json\n{"summary":"具体进展：已完成 translator compact 包装测试。"}\n```'), "具体进展：已完成 translator compact 包装测试。");
});

test("input token probe returns a stable Responses-compatible shape", () => {
  const result = inputTokensResponse({ input: "hello" });
  assert.equal(result.object, "response.input_tokens");
  assert.equal(typeof result.input_tokens, "number");
  assert.ok(result.input_tokens > 0);
  assert.deepEqual(result.input_tokens_details, { cached_tokens: 0 });
});

test("unknown input items are preserved as bounded system text", () => {
  const text = unknownInputItemText({
    type: "computer_call_output",
    call_id: "call_123",
    screenshot: "x".repeat(5000),
    output: "visible result",
  });
  assert.match(text, /computer_call_output/);
  assert.match(text, /visible result/);
  assert.match(text, /screenshot omitted/);
  assert.ok(text.length < 2400);
});

test("markdown sanitizer unwraps bold local URLs without touching normal text", () => {
  assert.equal(
    sanitizeMarkdownUrlFormatting("服务已启动，运行在 **🌐 http://localhost:3000/**，返回 200。"),
    "服务已启动，运行在 🌐 http://localhost:3000/，返回 200。",
  );
  assert.equal(
    sanitizeMarkdownUrlFormatting("打开 `http://127.0.0.1:8080/**` 测试。"),
    "打开 `http://127.0.0.1:8080/` 测试。",
  );
});

test("chat completions are wrapped with a full Responses shell", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_123",
    created: 123,
    model: "deepseek-chat",
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "Hi",
        reasoning_content: "Need to answer briefly.",
      },
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  }, {
    model: "gpt-5.5",
    instructions: "Be brief.",
    max_output_tokens: 128,
    parallel_tool_calls: true,
    reasoning: { effort: "xhigh" },
    store: false,
    tool_choice: "auto",
    tools: [{ type: "function", name: "exec_command" }],
    text: { verbosity: "low" },
  });

  assert.equal(formatted.object, "response");
  assert.equal(formatted.status, "completed");
  assert.equal(formatted.instructions, "Be brief.");
  assert.equal(formatted.max_output_tokens, 128);
  assert.deepEqual(formatted.reasoning, { effort: "xhigh" });
  assert.equal(formatted.output[0].type, "reasoning");
  assert.equal(formatted.output[0].summary.length, 0);
  assert.match(formatted.output[0].encrypted_content, /^deepcodex\.reasoning\.hex\.v1:/);
  assert.equal(formatted.output[1].type, "message");
  assert.equal(formatted.output[1].content[0].text, "Hi");
  assert.equal(formatted.usage.input_tokens, 10);
  assert.equal(formatted.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(formatted.usage.output_tokens_details.reasoning_tokens, 1);
});

test("chat finish_reason maps to Responses incomplete status", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "length",
      message: { role: "assistant", content: "partial" },
    }],
  }, { model: "gpt-5.5", input: "hello" });

  assert.equal(formatted.status, "incomplete");
  assert.deepEqual(formatted.incomplete_details, { reason: "max_output_tokens" });
});

test("DeepSeek prompt cache usage fields map to Responses cached tokens", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_cache",
    model: "deepseek-v4-pro",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "ok" },
    }],
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 750,
      prompt_cache_miss_tokens: 250,
      completion_tokens: 10,
      total_tokens: 1010,
    },
  }, { model: "gpt-5.5", input: "hello" });

  assert.equal(formatted.usage.input_tokens, 1000);
  assert.equal(formatted.usage.input_tokens_details.cached_tokens, 750);
  assert.equal(formatted.usage.output_tokens, 10);
});

test("usage diagnostics classify cache misses and prompt explosion", () => {
  assert.deepEqual(usageDiagnostics({
    prompt_tokens: 60000,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 60000,
    completion_tokens: 0,
    total_tokens: 60000,
  }), {
    input: 60000,
    output: 0,
    total: 60000,
    cache_hit: 0,
    cache_miss: 60000,
    flags: ["zero_completion", "cache_miss_large_prompt"],
  });

  const huge = usageDiagnostics({
    prompt_tokens: 250000,
    prompt_tokens_details: { cached_tokens: 100000 },
    completion_tokens: 20,
    total_tokens: 250020,
  });
  assert.equal(huge.cache_hit, 100000);
  assert.equal(huge.cache_miss, 150000);
  assert.deepEqual(huge.flags, ["prompt_explosion"]);
});

test("upstream failure classifier separates transient, protocol, auth, and quota failures", () => {
  assert.deepEqual(classifyUpstreamFailure(502, "Bad Gateway").type, "transient_upstream_error");
  assert.equal(classifyUpstreamFailure(502, "Bad Gateway").retryable, true);
  assert.equal(classifyUpstreamFailure(500, "streamGenerateContent: EOF").type, "transient_upstream_error");
  assert.equal(classifyUpstreamFailure(500, "streamGenerateContent: EOF").retryable, true);

  const protocol = classifyUpstreamFailure(400, "", {
    error: {
      message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
      type: "invalid_request_error",
      code: "invalid_request_error",
    },
  });
  assert.equal(protocol.type, "protocol_or_translation_error");
  assert.equal(protocol.retryable, false);
  assert.match(protocol.hint, /message\/tool ordering/);
  assert.equal(protocol.raw_type, "invalid_request_error");

  assert.equal(classifyUpstreamFailure(401, "Invalid API key").type, "auth_error");
  assert.equal(classifyUpstreamFailure(402, "insufficient quota").type, "quota_or_billing_error");

  const genericPermission = classifyUpstreamFailure(403, "PERMISSION_DENIED (code 403): Verify your account to continue.");
  assert.equal(genericPermission.type, "auth_error");
  assert.equal(genericPermission.retryable, false);
  assert.equal(genericPermission.diagnosis, undefined);

  const details = antigravityFailureDetails(Object.assign(
    new Error("PERMISSION_DENIED (code 403): Verify your account to continue."),
    { type: "antigravity_account_unavailable" },
  ));
  assert.equal(details.status, 403);
  assert.equal(details.type, "antigravity_account_unavailable");
  assert.equal(details.retryable, false);
  assert.equal(details.diagnosis, "account_verification_required");

  const queueFull = Object.assign(new Error("queue full"), {
    statusCode: 429,
    type: "antigravity_queue_full",
    retryable: true,
  });
  assert.deepEqual(antigravityFailureDetails(queueFull), {
    status: 429,
    type: "antigravity_queue_full",
    retryable: true,
    message: "queue full",
  });
  assert.equal(shouldRecordAntigravityTrafficFailure(queueFull), false);

  const quota = Object.assign(new Error("daily usage limit reached for Antigravity account"), {
    statusCode: 429,
  });
  assert.deepEqual(antigravityFailureDetails(quota), {
    status: 429,
    type: "antigravity_quota_exceeded",
    retryable: false,
    diagnosis: "quota_or_limit_reached",
    message: "daily usage limit reached for Antigravity account",
    suggestedAction: "切换模型，或等待该模型额度/限额恢复后重试。",
  });
  assert.equal(shouldRecordAntigravityTrafficFailure(quota), true);
});

test("classifyUpstreamFailure with Antigravity quota text returns non-retryable quota_or_billing_error with Chinese hint", () => {
  const result = classifyUpstreamFailure(429, "Quota exceeded for daily cloudcode usage.");
  assert.equal(result.type, "quota_or_billing_error");
  assert.equal(result.retryable, false);
  assert.ok(result.hint, "quota_or_billing_error must expose a Chinese actionable hint");
  assert.match(result.hint, /[一-鿿]/, "hint must contain Chinese characters");
  assert.match(result.hint, /额度|限额|充值|Antigravity|桌面端/, "hint should mention actionable quota resolution");
});

test("chat response blocks fake tool execution claims without tool calls", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "我已经运行 npm install，启动 Remotion Studio，并生成音频文件。" },
    }],
  }, { model: "gpt-5.5", input: "帮我做视频" });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /Anti-Codex/);
  assert.doesNotMatch(formatted.output[0].content[0].text, /DeepCodex/);
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /没有真的读文件/);
  assert.match(formatted.output[0].content[0].text, /没有实际 tool call/);
  assert.doesNotMatch(formatted.output[0].content[0].text, /请继续时/);
});

test("chat response does not block evaluation advice that mentions files and commands", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "\u53ef\u4ee5\u7528\u666e\u901a\u804a\u5929\u3001\u6587\u4ef6\u521b\u5efa\u3001\u547d\u4ee4\u6267\u884c\u548c\u7ed3\u679c\u9a8c\u8bc1\u6765\u5224\u65ad\u662f\u5426\u8dd1\u901a\u3002",
      },
    }],
  }, {
    model: "gpt-5.5",
    input: "\u5982\u679c Anti-Codex \u662f Codex \u5ba2\u6237\u7aef\u63a5\u5165\u53e6\u4e00\u4e2a\u6a21\u578b\uff0c\u6b63\u5e38\u5c0f\u4efb\u52a1\u5e94\u8be5\u600e\u4e48\u5224\u65ad\u662f\u5426\u8dd1\u901a\uff1f",
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.doesNotMatch(formatted.output[0].content[0].text, /Anti-Codex/);
  assert.match(formatted.output[0].content[0].text, /\u6587\u4ef6\u521b\u5efa/);
});

test("chat response does not block small-task run-through criteria advice with a marker", () => {
  const marker = "UI_CHAT_SMOKE_1782969105956";
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `\u5224\u65ad\u6807\u51c6\uff1a\u770b\u5b83\u662f\u5426\u80fd\u5148\u7406\u89e3\u4efb\u52a1\uff0c\u518d\u521b\u5efa\u6587\u4ef6\u3001\u8fd0\u884c\u6d4b\u8bd5\uff0c\u5e76\u628a\u4ea7\u7269\u548c\u7ed3\u679c\u6838\u5bf9\u6e05\u695a\u3002\n${marker}`,
      },
    }],
  }, {
    model: "gpt-5.5",
    input: `\u7528\u4e2d\u6587\u7b80\u77ed\u56de\u7b54\uff1a\u5982\u679c Anti-Codex \u662f Codex \u5ba2\u6237\u7aef\u63a5\u5165\u53e6\u4e00\u4e2a\u6a21\u578b\uff0c\u6b63\u5e38\u5c0f\u4efb\u52a1\u5e94\u8be5\u600e\u4e48\u5224\u65ad\u662f\u5426\u8dd1\u901a\uff1f\u6700\u540e\u5355\u72ec\u4e00\u884c\u5199 ${marker}\u3002`,
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.doesNotMatch(formatted.output[0].content[0].text, /Anti-Codex \u5df2\u62e6\u622a/);
  assert.match(formatted.output[0].content[0].text, new RegExp(marker));
});

test("system prompt does not expose legacy DeepCodex product identity", () => {
  const block = buildSystemBlock();

  assert.doesNotMatch(block, /DeepCodex/);
  assert.match(block, /Anti-Codex/);
});

test("adaptive system prompt carries the Chinese visible-reply language rule", () => {
  const block = buildSystemBlock();

  assert.match(block, /Language rule:/);
  assert.match(block, /use Simplified Chinese for user-visible answers/);
  assert.match(block, /progress narration/);

  const body = responsesToChatBody({
    input: "请用中文回答：Anti-Codex 是否能正常回复？",
  }, { extraSystem: block });

  const systemMessages = body.messages.filter((message) => message.role === "system");
  assert.ok(systemMessages.some((message) => /Language rule:/.test(message.content)));
  assert.ok(systemMessages.some((message) => /use Simplified Chinese for user-visible answers/.test(message.content)));
});

test("chat response trusts current internal tool evidence", () => {
  const formatted = chatToResponsesFormat({
    _internalToolEvidence: true,
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "我已经运行 npm install，启动 Remotion Studio，并生成音频文件。" },
    }],
  }, { model: "gpt-5.5", input: "帮我做视频" });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text, "我已经运行 npm install，启动 Remotion Studio，并生成音频文件。");
  assert.doesNotMatch(formatted.output[0].content[0].text, /拦截|DeepCodex/);
});

test("chat response ignores stale prior-turn tool evidence for a same-chat follow-up", () => {
  const priorCall = {
    id: "call_prior_read",
    type: "function",
    function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-Content old.md" }) },
  };
  const chatMessages = [
    { role: "user", content: "Read the old audit." },
    { role: "assistant", content: null, tool_calls: [priorCall] },
    { role: "tool", tool_call_id: priorCall.id, content: "old audit content" },
    { role: "user", content: "Read the current audit file and continue the same task." },
  ];
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Reading current audit file." },
    }],
  }, {
    model: "gpt-oss-120b-medium",
    input: [
      { type: "message", role: "user", content: "Read the old audit." },
      { type: "function_call", call_id: priorCall.id, name: "shell_command", arguments: priorCall.function.arguments },
      { type: "function_call_output", call_id: priorCall.id, output: "old audit content" },
      { type: "message", role: "user", content: "Read the current audit file and continue the same task." },
    ],
  }, null, { chatMessages });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /Anti-Codex/);
  assert.match(formatted.output[0].content[0].text, /tool call/i);
  assert.notEqual(formatted.output[0].content[0].text, "Reading current audit file.");
});

test("chat response blocks plain TOOL_RESULT transcript text even with prior tool evidence", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_999001";
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `[TOOL_RESULT] shell_command: {"stdout":"${marker}"}\nI created package.json, word-tally.mjs, word-tally.test.mjs, and done.txt.`,
      },
    }],
  }, {
    model: "claude-sonnet-4-6",
    input: [
      {
        type: "message",
        role: "user",
        content: `Create a tiny Node.js CLI project in C:\\Temp\\desktop-visible-coding-project\\fake. Write package.json, word-tally.mjs, word-tally.test.mjs, and done.txt. Final marker ${marker}.`,
      },
      {
        type: "function_call_output",
        call_id: "call_old_probe",
        output: "old unrelated output",
      },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /Anti-Codex/);
  assert.match(formatted.output[0].content[0].text, /没有实际 tool call|娌℃湁瀹為檯 tool call/);
  assert.doesNotMatch(formatted.output[0].content[0].text, /\[TOOL_RESULT\] shell_command/);
});

test("chat response blocks fabricated TOOL_RESULT text while preserving real tool calls", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "[TOOL_RESULT] invented file contents",
        tool_calls: [{
          id: "call_real_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-Content README.md -Head 20" }) },
        }],
      },
    }],
  }, {
    model: "claude-sonnet-4-6",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read README.md." }] }],
  });

  const message = formatted.output.find(item => item.type === "message");
  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call);
  assert.match(message.content[0].text, /Anti-Codex/);
  assert.doesNotMatch(message.content[0].text, /\[TOOL_RESULT\]|invented file contents/);
});

test("chat response blocks Chinese fake search-result narration without tool calls", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "搜到了几个不错的 Remotion 案例，我刚才看了官方 showcase 和 GitHub 示例仓库。" },
    }],
  }, { model: "gpt-5.5", input: [] });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response allows long-context marker echoes without tool calls", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "已经找到 LONGCTX_HEAD_12345 和 LONGCTX_TAIL_67890，说明长上下文稳定性填充可读。" },
    }],
  }, { model: "gpt-5.5", input: [] });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /LONGCTX_HEAD_12345/);
  assert.match(formatted.output[0].content[0].text, /LONGCTX_TAIL_67890/);
  assert.doesNotMatch(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response allows compacted task-state recall containing installed as an adjective", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "COMPACT_SEED_731 | verify installed compaction resume" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: "Active task marker: COMPACT_SEED_731. Next action: verify installed compaction resume.",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Recall the marker and next action." }] },
    ],
  });

  assert.equal(formatted.output[0].content[0].text, "COMPACT_SEED_731 | verify installed compaction resume");
  assert.doesNotMatch(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response allows explicit compacted next-action recall even when phrased as Next Action", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "COMPACT_SEED_842 | Next Action: Verify the installed compaction resume." },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: "Active task marker: COMPACT_SEED_842. Next action: verify installed compaction resume.",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Recall the exact active task marker and next action." }] },
    ],
  });

  assert.match(formatted.output[0].content[0].text, /COMPACT_SEED_842/);
  assert.doesNotMatch(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response replaces partial compacted recall that keeps marker but drops next action", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "Active Task Marker: `COMPACT_SEED_67444_20260614`\n\nNo active background tasks are currently running.",
      },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: "Active task marker: COMPACT_SEED_67444_20260614. Next action: verify installed compaction resume.",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue from the compacted context. Reply with the exact active task marker and exact next action." }] },
    ],
  });

  const text = formatted.output[0].content[0].text;
  assert.match(text, /COMPACT_SEED_67444_20260614/);
  assert.match(text, /verify installed compaction resume/i);
  assert.doesNotMatch(text, /No active background tasks/i);
});

test("chat response replaces compacted recall that invents a scheduled task", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: [
          "Active Task Marker: `COMPACT_SEED_43630_20260619`",
          "Next Action: 验证 compaction 状态并确认状态延续性。",
          "",
          "我已成功调用了 `schedule` 工具，设定了一个一次性的定时任务（任务 ID: `task-6`）。",
        ].join("\n"),
      },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: [
          "### Context Checkpoint Compaction Summary",
          "- **Active Task Marker**: `COMPACT_SEED_43630_20260619`",
          "- **Next Steps**:",
          "  1. Verify the installed compaction resume.",
          "",
          "**Continuation Instruction**:",
          "Verify the installed compaction resume using the active task marker `COMPACT_SEED_43630_20260619`.",
        ].join("\n"),
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue from the compacted context. Reply with the exact active task marker and exact next action." }] },
    ],
  });

  const text = formatted.output[0].content[0].text;
  assert.match(text, /COMPACT_SEED_43630_20260619/);
  assert.match(text, /verify (?:the )?installed compaction resume/i);
  assert.doesNotMatch(text, /schedule|task-6|定时任务/i);
});

test("compacted recall accepts continuation instruction written on the next line", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "COMPACT_SEED_43631_20260619 | Verify the installed compaction resume." },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: [
          "Active task marker: COMPACT_SEED_43631_20260619.",
          "Continuation Instruction:",
          "Verify the installed compaction resume.",
        ].join("\n"),
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Recall the exact active task marker and next action." }] },
    ],
  });

  assert.match(formatted.output[0].content[0].text, /COMPACT_SEED_43631_20260619/);
  assert.match(formatted.output[0].content[0].text, /Verify the installed compaction resume/i);
});

test("compacted recall rejects missing continuation terms from next-line instruction", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "COMPACT_SEED_43632_20260619 | 验证 compaction 状态。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: [
          "Active task marker: COMPACT_SEED_43632_20260619.",
          "Continuation Instruction:",
          "Verify the installed compaction resume.",
        ].join("\n"),
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Recall the exact active task marker and next action." }] },
    ],
  });

  const text = formatted.output[0].content[0].text;
  assert.match(text, /COMPACT_SEED_43632_20260619/);
  assert.match(text, /Verify the installed compaction resume/i);
});

test("chat response replaces pseudo web_search markup during compacted task-state recall", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `<tool_call>
  <tool_name>web_search</tool_name>
  <parameters>
    <query>COMPACT_SEED_88282_20260614</query>
  </parameters>
</tool_call>`,
      },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: "Active task marker: COMPACT_SEED_88282_20260614. Next action: verify installed compaction resume.",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue from the compacted context. Reply with the exact active task marker and exact next action." }] },
    ],
  });

  const text = formatted.output[0].content[0].text;
  assert.match(text, /COMPACT_SEED_88282_20260614/);
  assert.match(text, /verify installed compaction resume/i);
  assert.doesNotMatch(text, /tool_call|web_search|tool_name/i);
});

test("chat response replaces missing-tool detours during compacted task-state recall", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "The required command and file tools are unavailable, so I cannot verify COMPACT_SEED_22831_20260614.",
      },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      {
        type: "context_compaction",
        summary: "Active task marker: COMPACT_SEED_22831_20260614. Next action: verify installed compaction resume.",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue from the compacted context. Reply with the exact active task marker and exact next action." }] },
    ],
  });

  const text = formatted.output[0].content[0].text;
  assert.match(text, /COMPACT_SEED_22831_20260614/);
  assert.match(text, /verify installed compaction resume/i);
  assert.doesNotMatch(text, /unavailable|required command|cannot verify/i);
});

test("chat response still blocks new future tool promises after compaction", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Next I will install dependencies and verify the build." },
    }],
  }, {
    model: "gpt-5.5",
    input: [{
      type: "context_compaction",
      summary: "The previous next action was to install dependencies and verify the build.",
    }],
  });

  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks direct command promises without tool calls", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "`npm run dev` / `npm start` 都崩。我直接在项目目录用 `npx remotion studio --port=3001`。" },
    }],
  }, { model: "gpt-5.5", input: "赶紧的" });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response allows completion summary when prior tool evidence exists", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "已经读取 projections.mjs，并把对应改动写入完成。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "function_call_output", call_id: "call_read", output: "file content" }],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.doesNotMatch(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response still blocks future action promise even when prior tool evidence exists", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "读完了。现在我直接用 npx remotion studio 启动。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "function_call_output", call_id: "call_read", output: "file content" }],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks dangling skeleton promise after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "webbridge daemon 活了，extension_connected: false。现在先不管扩展连通——直接做 gemini-cli 的 skeleton：" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_status", name: "exec_command", arguments: "{\"cmd\":\"curl http://127.0.0.1:10086/status\"}" },
      { type: "function_call_output", call_id: "call_status", output: "{\"extension_connected\":false,\"running\":true}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks dangling colon action after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "看到 new-chat-3 了，这很可能就是 qwen 相关项目。看看它的内容：" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_ls", name: "exec_command", arguments: "{\"cmd\":\"ssh win-codex ls\"}" },
      { type: "function_call_output", call_id: "call_ls", output: "new-chat-3" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("artifact completion does not reuse an old desktop task after a new plain user message", () => {
  const messages = [
    { role: "user", content: "Create index.html, README.md, done.txt in C:\\Temp\\old-task. done.txt must contain UI_OLD_ARTIFACT_20260627." },
    { role: "assistant", tool_calls: [{ id: "call_old", function: { name: "exec_command" } }] },
    { role: "tool", tool_call_id: "call_old", content: "Anti-Codex artifact marker verification:\nUI_OLD_ARTIFACT_20260627\nindex.html done.txt README.md" },
    { role: "assistant", content: "Files created and verified.\n\nUI_OLD_ARTIFACT_20260627" },
    { role: "user", content: "Reply with exactly UI_NEW_PLAIN_REPLY_20260627 and nothing else." },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_old", output: "UI_OLD_ARTIFACT_20260627" }],
  }, { model: "gemini-pro-agent", messages });

  assert.equal(completion, null);
  assert.equal(artifactMarkerMismatchForChat(messages, "Files created and verified.\n\nUI_OLD_ARTIFACT_20260627"), null);
});

test("report-site tool evidence gets a final marker completion", () => {
  const marker = "UI_REPORT_SITE_SMOKE_20260702_DONE";
  const messages = [
    { role: "user", content: `Create report.md, index.html and done.txt in C:\\Temp\\desktop-visible-report-site\\run. done.txt must contain ${marker}.` },
    { role: "assistant", tool_calls: [{ id: "call_report", function: { name: "shell_command" } }] },
    { role: "tool", tool_call_id: "call_report", content: `report.md:120\nindex.html:220\ndone.txt:34\n${marker}` },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_report", output: `report.md index.html done.txt ${marker}` }],
  }, { model: "gemini-pro-agent", messages });

  assert.ok(completion);
  assert.match(completion.choices[0].message.content, new RegExp(marker));
  assert.match(completion.choices[0].message.content, /report\.md/);
});

test("deterministic exact reply uses only the latest user message", () => {
  const completion = deterministicExactReplyCompletion({
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly UI_OLD_REPLY_20260627 and nothing else." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "UI_OLD_REPLY_20260627" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly UI_NEW_REPLY_20260627 and nothing else." }] },
    ],
  });

  assert.equal(completion.choices[0].message.content, "UI_NEW_REPLY_20260627");
});

test("deterministic exact reply prefers current responses input over restored messages", () => {
  const completion = deterministicExactReplyCompletion({
    model: "gemini-pro-agent",
    messages: [
      { role: "user", content: [{ type: "input_text", text: "Reply with exactly UI_RESTORED_REPLY_20260627 and nothing else." }] },
    ],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly UI_CURRENT_REPLY_20260627 and nothing else." }] },
    ],
  });

  assert.equal(completion.choices[0].message.content, "UI_CURRENT_REPLY_20260627");
});

test("deterministic exact reply supports a Chinese only-reply clause after a read-only instruction", () => {
  const completion = deterministicExactReplyCompletion({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "只读取当前项目状态，不修改任何文件。V2 已经完成 19 个测试；请仅回复 RECOVERY_HOOK_OK。",
      }],
    }],
  });

  assert.equal(completion.choices[0].message.content, "RECOVERY_HOOK_OK");
});

test("deterministic exact reply never skips requested file and command work", () => {
  const completion = deterministicExactReplyCompletion({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "请在 C:\\Temp\\launch-once 新建 start.bat，用 Start-Process 启动一次，再读取 launch-count.txt 验证等于 1。验证成功后最后一行只回复 UI_LAUNCH_ONCE_OK。",
      }],
    }],
  });

  assert.equal(completion, null);
});

test("deterministic exact reply closes a verified launch-once tool turn", () => {
  const marker = "UI_LAUNCH_ONCE_VERIFIED_REPLY_123";
  const prompt = `工作目录是 C:\\Temp\\launch-once。新建 start.bat，用 Start-Process 只启动一次，读取 launch-count.txt 严格验证等于 1，读取 launch-proof.txt。验证成功后最后一行只回复 ${marker}。`;
  const command = [
    "Set-Content -Path .\\start.bat -Value 'powershell -File launch-target.ps1' -Encoding Ascii",
    "Start-Process -FilePath .\\start.bat -Wait",
    "Get-Content .\\launch-count.txt",
    "Get-Content .\\launch-proof.txt",
  ].join("; ");
  const completion = deterministicExactReplyCompletion({
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call_launch_once", name: "shell_command", arguments: JSON.stringify({ command }) },
      { type: "function_call_output", call_id: "call_launch_once", output: `Exit code: 0\nOutput:\n1\n${marker}` },
    ],
  });

  assert.equal(completion.choices[0].message.content, marker);
});

test("deterministic exact reply refuses duplicate launch evidence", () => {
  const marker = "UI_LAUNCH_ONCE_DUPLICATE_REPLY_123";
  const prompt = `工作目录是 C:\\Temp\\launch-once。新建 start.bat，用 Start-Process 只启动一次，读取 launch-count.txt 严格验证等于 1，读取 launch-proof.txt。验证成功后最后一行只回复 ${marker}。`;
  const command = [
    "Set-Content -Path .\\start.bat -Value 'powershell -File launch-target.ps1' -Encoding Ascii",
    "Start-Process -FilePath .\\start.bat -Wait",
    "Start-Process -FilePath .\\start.bat -Wait",
    "Get-Content .\\launch-count.txt",
    "Get-Content .\\launch-proof.txt",
  ].join("; ");
  const completion = deterministicExactReplyCompletion({
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call_launch_twice", name: "shell_command", arguments: JSON.stringify({ command }) },
      { type: "function_call_output", call_id: "call_launch_twice", output: `Exit code: 0\nOutput:\n2\n${marker}` },
    ],
  });

  assert.equal(completion, null);
});

test("deterministic exact reply closes a verified already-running artifact task without launching again", () => {
  const marker = "UI_ALREADY_RUNNING_VERIFIED_REPLY_123";
  const prompt = `软件已经启动好了，目录是 C:\\Temp\\already-running。不要再启动 start.bat。读取 running-state.json 和 launch-count.txt，然后只创建 status.json，内容的 marker 为 ${marker}，写完后读回，launch-count.txt 必须保持 1。最后一行写 ${marker}。`;
  const command = [
    `Set-Content -Path C:\\Temp\\already-running\\status.json -Value '{"state":"already-running","observedLaunchCount":1,"marker":"${marker}"}'`,
    "Get-Content C:\\Temp\\already-running\\status.json -TotalCount 20",
    "Get-Content C:\\Temp\\already-running\\launch-count.txt -TotalCount 2",
  ].join("; ");
  const request = {
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call_already_running", name: "shell_command", arguments: JSON.stringify({ command }) },
      { type: "function_call_output", call_id: "call_already_running", output: `Exit code: 0\nOutput:\n{"state":"already-running","observedLaunchCount":1,"marker":"${marker}"}\n1` },
    ],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const completion = deterministicExactReplyCompletion(request, chatBody);

  assert.equal(userTextRequiresProcessLaunch(prompt), false);
  const genericEvidence = genericLocalArtifactExactReplyEvidence(request, null, prompt);
  assert.equal(genericEvidence.ready, true, JSON.stringify(genericEvidence));
  assert.equal(completion.choices[0].message.content, marker);
});

test("deterministic exact reply does not close an already-running task after read-only evidence", () => {
  const marker = "UI_ALREADY_RUNNING_READ_ONLY_123";
  const prompt = `软件已经启动好了，目录是 C:\\Temp\\already-running。不要再启动 start.bat。读取状态后创建 status.json。最后一行写 ${marker}。`;
  const completion = deterministicExactReplyCompletion({
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call_read_only", name: "shell_command", arguments: JSON.stringify({ command: "Get-Content C:\\Temp\\already-running\\running-state.json -TotalCount 20" }) },
      { type: "function_call_output", call_id: "call_read_only", output: `Exit code: 0\nOutput:\n{"marker":"${marker}"}` },
    ],
  });

  assert.equal(completion, null);
});

test("deterministic exact reply does not hide a failed already-running artifact verification", () => {
  const marker = "UI_ALREADY_RUNNING_FAILED_VERIFY_123";
  const prompt = `软件已经启动好了，目录是 C:\\Temp\\already-running。不要再启动 start.bat。创建 status.json 并验证。最后一行写 ${marker}。`;
  const completion = deterministicExactReplyCompletion({
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call_failed_verify", name: "shell_command", arguments: JSON.stringify({ command: `Set-Content C:\\Temp\\already-running\\status.json '${marker}'` }) },
      { type: "function_call_output", call_id: "call_failed_verify", output: `Exit code: 1\nOutput:\n${marker}\nstatus verification failed` },
    ],
  });

  assert.equal(completion, null);
});

test("deterministic exact reply does not treat a first-turn marker as completed requirement correction", () => {
  const marker = "UI_HUMAN_CORRECTION_FINAL_123";
  const prompt = `继续 C:\\Temp\\correction 项目，追加 uniqueWords，更新 word-tally.test.mjs，创建 CHANGELOG.md 和 followup.txt。followup.txt 只写 ${marker}。最后一行写 ${marker}。`;
  const completion = deterministicExactReplyCompletion({
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call_old_marker", name: "shell_command", arguments: JSON.stringify({ command: "Get-Content done.txt; Set-Content word-tally.mjs 'export function uniqueWords() {}'" }) },
      { type: "function_call_output", call_id: "call_old_marker", output: `Exit code: 0\nOutput:\n${marker}_FIRST` },
    ],
  });

  assert.equal(completion, null);
});

test("process launch intent keeps one required launch when a later sentence forbids relaunch", () => {
  const prompt = [
    "请处理启动失败，目录是 C:\\Temp\\failed-launch，里面已有 launch-target.ps1。",
    "先用中文说明只尝试启动一次，然后创建 start.bat。",
    "必须用 shell_command 的 Start-Process 启动 start.bat 一次。",
    "这个启动预期会失败；即使 Start-Process 返回 0，也绝对不能再启动第二次。",
    "随后读取 launch-count.txt 和 error.log，创建 config.json 与 diagnosis.json。",
  ].join("\n");

  assert.equal(userTextRequiresProcessLaunch(prompt), true);
});

test("failed launch diagnosis does not receive a generic HTML project tool template", () => {
  const marker = "UI_FAILED_LAUNCH_TEMPLATE_GUARD_123";
  const prompt = `请在 C:\\Temp\\failed-launch 创建 start.bat，用 Start-Process 启动一次；失败后读取 error.log，创建 config.json 和 diagnosis.json，绝对不能再启动第二次。diagnosis.json 的 marker=${marker}。最后一行写 ${marker}。`;
  const body = {
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } } } } }],
  };

  const instruction = localProjectToolMarkupExampleForBody(body);
  assert.equal(instruction, "");
  assert.doesNotMatch(instruction, /index\.html|README\.md|阶段1：准备创建文件/);
});

test("deterministic artifact tool call does not replace a batch launch task with report files", () => {
  const marker = "UI_LAUNCH_ONCE_DETERMINISTIC_GUARD_123";
  const prompt = `工作目录是 C:\\Temp\\launch-once。请新建 start.bat，用 Start-Process 只启动一次，再读取 launch-count.txt 验证等于 1。验证成功后最后一行只回复 ${marker}。`;
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
  };
  const chatBody = {
    model: request.model,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };

  assert.equal(deterministicArtifactToolCallCompletion(request, chatBody), null);
});

test("deterministic artifact completion rejects unrelated marker evidence for a batch launch task", () => {
  const marker = "UI_LAUNCH_ONCE_EVIDENCE_GUARD_123";
  const prompt = `工作目录是 C:\\Temp\\launch-once。请新建 start.bat，用 Start-Process 只启动一次，再读取 launch-count.txt 验证等于 1。验证成功后最后一行只回复 ${marker}。`;
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
  };
  const chatBody = {
    model: request.model,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: null, tool_calls: [{ id: "call_wrong_artifact", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: "write unrelated files" }) } }] },
      { role: "tool", tool_call_id: "call_wrong_artifact", content: `index.html\nREADME.md\ndone.txt\n${marker}` },
    ],
  };

  assert.equal(deterministicArtifactCompletionResponse(request, chatBody), null);
});

test("specialized artifact marker mismatch guard ignores ordinary batch launch tasks", () => {
  const marker = "UI_LAUNCH_ONCE_MISMATCH_GUARD_123";
  const prompt = `工作目录是 C:\\Temp\\launch-once。请新建 start.bat，用 Start-Process 只启动一次，最后回复 ${marker}。`;
  const mismatch = artifactMarkerMismatchForChat(
    [{ role: "user", content: prompt }],
    `start.bat 已创建、启动并验证。\n${marker}`,
  );

  assert.equal(mismatch, null);
});

test("chat response blocks English dangling patch retry promise after failed patch", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Patch body got clipped. Let me use the full content directly:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "apply_patch verification failed: invalid patch: The last line of the patch must be '*** End Patch'" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /没有实际 tool call/);
});

test("chat response blocks English direct write promise after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "I found the target files. Let me now write the implementation directly:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_read", name: "exec_command", arguments: "{\"cmd\":\"sed -n '1,120p' src/App.jsx\"}" },
      { type: "function_call_output", call_id: "call_read", output: "export default function App() {}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks English dangling verification promise after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Now I have the full picture. Let me check that the computeResultConsumption function is actually in the file:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "{\"output\":\"Success. Updated the following files:\\nM runtime/codex/projections.mjs\\n\"}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks English dangling update promise with numbered lead-in", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "I need to add consumption-first rendering. Let me update: 1" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_read", name: "exec_command", arguments: "{\"cmd\":\"sed -n '1,220p' SidePanel.jsx\"}" },
      { type: "function_call_output", call_id: "call_read", output: "function TurnResultBlock() {}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks English dangling line-number lookup promise", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Now let me also get the exact line numbers for CONTEXT.md sections and the SidePanel consumption section:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_read", name: "exec_command", arguments: "{\"cmd\":\"sed -n '305,340p' ThreadTimeline.jsx\"}" },
      { type: "function_call_output", call_id: "call_read", output: "<span className=\\\"turn-result-summary\\\">" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks English dangling see/follow promise after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "The projection functions are called at line 1620 area. Let me see what function wraps those calls and where THAT function is called:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_rg", name: "exec_command", arguments: "{\"cmd\":\"rg -n projectTurnTimeline runtime/codex/projections.mjs\"}" },
      { type: "function_call_output", call_id: "call_rg", output: "runtime/codex/projections.mjs:1620: const result = computeTurnResult(items, turn.status)" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks status-probe detour after results are ready", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "搜索已经跑完了，结果就在上面。让我确认一下 daemon 还在跑、工具链完整，然后给你最终总结。",
        tool_calls: [{
          id: "call_status",
          type: "function",
          function: {
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "powershell -Command \"netstat -ano | findstr ':10086'\"" }),
          },
        }],
      },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_search", name: "exec_command", arguments: "{\"cmd\":\"google-cli search AI\"}" },
      { type: "function_call_output", call_id: "call_search", output: "{\"data\":[{\"title\":\"AI news\"}]}" },
    ],
  }, { exec_command: { type: "function", codexName: "exec_command" } });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /最终回答/);
  assert.ok(!formatted.output.some(item => item.type === "function_call"), "status probe should not be forwarded");
});

test("chat response allows factual blocker after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "webbridge daemon 活了，但 extension_connected 还是 false。需要先安装 Chrome 扩展，否则不能控制网页。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_status", name: "exec_command", arguments: "{\"cmd\":\"curl http://127.0.0.1:10086/status\"}" },
      { type: "function_call_output", call_id: "call_status", output: "{\"extension_connected\":false,\"running\":true}" },
    ],
  });

  assert.doesNotMatch(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /需要先安装 Chrome 扩展/);
});

test("chat response blocks web_search unavailable claim when only exec_command failed", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "现在搜了，但 web_search 真的暂时不可用，只能基于已有信息回答。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"curl https://example.com\"}" },
      { type: "function_call_output", call_id: "call_exec", output: "curl: network is unreachable" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /web_search\/web_fetch 不可用/);
  assert.match(formatted.output[0].content[0].text, /exec_command 的网络失败/);
  assert.doesNotMatch(formatted.output[0].content[0].text, /请继续时/);
});

test("chat response allows web_search unavailable claim after matching web_search failure output", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "web_search 返回失败，当前没有可靠搜索结果。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_search", name: "web_search", arguments: "{\"query\":\"Remotion examples\"}" },
      { type: "function_call_output", call_id: "call_search", output: "{\"ok\":false,\"error\":\"network blocked\"}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text, "web_search 返回失败，当前没有可靠搜索结果。");
});

test("chat response allows honest shell-network failure without inventing web_search", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "我现在没有实际搜索结果，shell 网络访问失败。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"curl https://example.com\"}" },
      { type: "function_call_output", call_id: "call_exec", output: "Could not resolve host" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text, "我现在没有实际搜索结果，shell 网络访问失败。");
});

test("chat custom tool calls become completed Responses custom_tool_call items", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_123",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "{\"content\":\"*** Begin Patch\\n*** End Patch\\n\"}",
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "patch" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "custom_tool_call");
  assert.equal(formatted.output[0].status, "completed");
  assert.equal(formatted.output[0].call_id, "call_123");
  assert.equal(formatted.output[0].name, "apply_patch");
  assert.equal(formatted.output[0].input, "*** Begin Patch\n*** End Patch\n");
  assert.notEqual(formatted.output[0].id, "call_123");
});

test("chat custom apply_patch anchors relative paths to an explicit project directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex patch workspace "));
  const project = path.join(root, "real project with spaces");
  const drifted = path.join(root, "generated fallback workspace");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(drifted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/value.mjs",
    "@@",
    "-export const value = 1;",
    "+export const value = 2;",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_scoped_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: patch }) },
      }] },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${drifted}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `Project directory:\n${project}\n\nFix src/value.mjs.` }] },
    ],
  }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.ok(formatted.output[0].input.includes(`*** Update File: ${path.resolve(project, "src", "value.mjs")}`));
});

test("chat shell commands inherit the latest explicit project directory when workdir is omitted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex shell workspace "));
  const project = path.join(root, "real project with spaces");
  const drifted = path.join(root, "generated fallback workspace");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(drifted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_scoped_shell",
        type: "function",
        function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-Content test/analyze.test.mjs" }) },
      }] },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${drifted}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `Continue the repair.\n\nProject directory:\n${project}\n\nRead test/analyze.test.mjs.` }] },
    ],
  }, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  assert.equal(JSON.parse(call.arguments).workdir, path.resolve(project));
});

test("exec_command unwraps a redundant nested PowerShell command", () => {
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const command = "New-Item -ItemType Directory -Force -Path 'C:\\Temp\\new-project'";
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_nested_powershell",
        type: "function",
        function: {
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `powershell -Command \"${command}\"`,
            workdir: "C:\\Temp",
          }),
        },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "Create C:\\Temp\\new-project." }, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.cmd, command);
  assert.equal(args.workdir, "C:\\Temp");
});

test("exec_command preserves an intentional PowerShell child under a non-PowerShell shell", () => {
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, shell: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const command = "powershell -Command \"Write-Output child\"";
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_intentional_powershell_child",
        type: "function",
        function: {
          name: "exec_command",
          arguments: JSON.stringify({ cmd: command, shell: "cmd.exe" }),
        },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "Run a PowerShell child from cmd.exe." }, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  assert.equal(JSON.parse(call.arguments).cmd, command);
});

test("exec_command quotes only the cmd ampersand chain before appended PowerShell lines", () => {
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const command = [
    "cmd /c type word-tally.mjs & type word-tally.test.mjs",
    "$marker = 'UI_MULTI_TURN_PROJECT_SMOKE_CMD_CHAIN_123'",
    "Write-Output $marker",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_cmd_ampersand_chain",
        type: "function",
        function: {
          name: "exec_command",
          arguments: JSON.stringify({ cmd: command, workdir: "C:\\Temp" }),
        },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "Read both files and print the marker." }, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.cmd, [
    "cmd /d /s /c \"type word-tally.mjs & type word-tally.test.mjs\"",
    "$marker = 'UI_MULTI_TURN_PROJECT_SMOKE_CMD_CHAIN_123'",
    "Write-Output $marker",
  ].join("\n"));
});

test("exec_command runs bare cd double-ampersand chains through cmd on Windows PowerShell", () => {
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const workdir = "C:\\Temp\\autonomous-project";
  const command = `cd ${workdir} && node --test codex-update-analyzer.test.mjs && node codex-update-analyzer.mjs sources.json`;
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_bare_cmd_chain",
        type: "function",
        function: {
          name: "exec_command",
          arguments: JSON.stringify({ cmd: command, workdir }),
        },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "Run the analyzer tests and CLI." }, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.cmd, `cmd /d /s /c \"cd /d ${workdir} && node --test codex-update-analyzer.test.mjs && node codex-update-analyzer.mjs sources.json\"`);
});

test("exec_command leaves programming-language double ampersands untouched", () => {
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
  };
  const command = `node -e \"if (ready && valid) console.log('ok')\"`;
  const formatted = chatToResponsesFormat({
    choices: [{ message: { role: "assistant", tool_calls: [{
      id: "call_js_and",
      type: "function",
      function: { name: "exec_command", arguments: JSON.stringify({ cmd: command }) },
    }] } }],
  }, { model: "gemini-3.5-flash-low", input: "Run the JavaScript condition." }, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  assert.equal(JSON.parse(call.arguments).cmd, command);
});

test("fourth consecutive failed apply_patch attempt ends the current tool loop", () => {
  const failedPatchTurn = (id) => [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: { name: "apply_patch", arguments: JSON.stringify({ content: "*** Begin Patch\n*** End Patch" }) },
    }],
  }, {
    role: "tool",
    tool_call_id: id,
    content: "apply_patch verification failed: Failed to find expected lines in test/analyze.test.mjs",
  }];
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_patch_4",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ content: "*** Begin Patch\n*** Update File: test/analyze.test.mjs\n*** End Patch" }),
          },
        }],
      },
    }],
  }, {
    model: "gemini-3-flash-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the failing test and rerun npm test." }] }],
  }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  }, {
    chatMessages: [
      { role: "user", content: "Fix the failing test and rerun npm test." },
      ...failedPatchTurn("call_patch_1"),
      ...failedPatchTurn("call_patch_2"),
      ...failedPatchTurn("call_patch_3"),
    ],
  });

  assert.equal(formatted.output.some(item => item.type === "custom_tool_call"), false);
  const text = formatted.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.match(text, /three consecutive patch-context/i);
  assert.match(text, /same chat/i);
});

test("chat custom apply_patch converts a conflict replacement into Codex patch grammar", () => {
  const conflictPatch = [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "<<<<<<<",
    "old line",
    "=======",
    "new line",
    ">>>>>>>",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_conflict_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ content: conflictPatch }),
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "replace cli.mjs" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "custom_tool_call");
  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "@@",
    "-old line",
    "+new line",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch converts short conflict markers with a Path header", () => {
  const conflictPatch = [
    "*** Begin Patch",
    "*** Path: fixtures/events.json",
    "<<<<",
    "old fixture",
    "====",
    "new fixture",
    ">>>>",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_short_conflict_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ content: conflictPatch }),
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "replace fixture" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    "*** Update File: fixtures/events.json",
    "@@",
    "-old fixture",
    "+new fixture",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch converts full-file blocks into Add File hunks", () => {
  const fullFilePatch = [
    "*** Begin Patch",
    "File: generated/package.json",
    "<<<<",
    "{",
    "  \"name\": \"generated-project\"",
    "}",
    ">>>>",
    "File: generated/done.txt",
    "<<<<",
    "UI_COMPLEX_PROJECT_SMOKE_FULL_FILE_123",
    ">>>>",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_full_file_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: fullFilePatch }) },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "create the two generated files" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    "*** Add File: generated/package.json",
    "+{",
    "+  \"name\": \"generated-project\"",
    "+}",
    "*** Add File: generated/done.txt",
    "+UI_COMPLEX_PROJECT_SMOKE_FULL_FILE_123",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch converts wrapped full-file blocks into Add File hunks", () => {
  const fullFilePatch = [
    "<<<<",
    "File: generated/report.md",
    "====",
    "# Report",
    "",
    "Complete.",
    ">>>>",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_wrapped_full_file_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: fullFilePatch }) },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "create generated/report.md" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    "*** Add File: generated/report.md",
    "+# Report",
    "+",
    "+Complete.",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch converts an inline-path full replacement for an existing file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-inline-full-replacement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "word-tally.mjs");
  fs.writeFileSync(target, "export const oldValue = 1;\n", "utf8");
  const replacement = [
    `<<<< ${target}`,
    "====",
    "export const newValue = 2;",
    "export function uniqueWords() { return []; }",
    ">>>>",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_inline_full_replacement",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: replacement }) },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: `Replace ${target}.` }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    `*** Update File: ${target}`,
    "@@",
    "-export const oldValue = 1;",
    "+export const newValue = 2;",
    "+export function uniqueWords() { return []; }",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch converts CDATA-wrapped multi-file bare-path conflict replacements", () => {
  const conflictPatch = [
    "<![CDATA[cli.mjs",
    "<<<<",
    "old cli",
    "====",
    "new cli",
    ">>>>",
    "",
    "test/analyze.test.mjs",
    "<<<<",
    "old test",
    "====",
    "new test",
    ">>>>",
    "",
    "README.md",
    "<<<<",
    "old readme",
    "====",
    "new readme",
    ">>>>]]>",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_cdata_multi_conflict_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: conflictPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "patch three files" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "@@",
    "-old cli",
    "+new cli",
    "*** Update File: test/analyze.test.mjs",
    "@@",
    "-old test",
    "+new test",
    "*** Update File: README.md",
    "@@",
    "-old readme",
    "+new readme",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch converts multi-file unified headers with conflict replacements and a missing end marker", () => {
  const conflictPatch = [
    "*** Begin Patch",
    "--- cli.mjs",
    "+++ cli.mjs",
    "<<<<",
    "old cli",
    "====",
    "new cli",
    ">>>>",
    "--- test/analyze.test.mjs",
    "+++ test/analyze.test.mjs",
    "<<<<",
    "old test",
    "====",
    "new test",
    ">>>>",
    "--- README.md",
    "+++ README.md",
    "<<<<",
    "old readme",
    "====",
    "new readme",
    ">>>>",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_header_multi_conflict_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: conflictPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "patch three files" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  const normalized = formatted.output[0].input;
  assert.equal((normalized.match(/^\*\*\* Update File:/gm) || []).length, 3);
  assert.equal(normalized.startsWith("*** Begin Patch\n"), true);
  assert.equal(normalized.endsWith("\n*** End Patch"), true);
  assert.doesNotMatch(normalized, /<!\[CDATA\[|\]\]>|^--- |^\+\+\+ |^<{4,7}$|^>{4,7}$/m);
});

test("chat custom apply_patch converts a unified diff into Codex patch grammar", () => {
  const unifiedPatch = [
    "--- README.md",
    "+++ README.md",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
    " unchanged",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_unified_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: unifiedPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "replace README" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    "*** Update File: README.md",
    "@@",
    "-old line",
    "+new line",
    " unchanged",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch removes unsupported line numbers from Codex hunks", () => {
  const numberedPatch = [
    "*** Begin Patch",
    "*** Update File: README.md",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_numbered_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: numberedPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "replace README" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.match(formatted.output[0].input, /\*\*\* Update File: README\.md\n@@\n-old line\n\+new line/);
  assert.doesNotMatch(formatted.output[0].input, /@@ -1,2 \+1,2 @@/);
});

test("chat custom apply_patch prefixes unmarked Update File context lines", () => {
  const malformedPatch = [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "@@",
    "const before = true;",
    "-const value = oldValue;",
    "+const value = newValue;",
    "",
    "const after = true;",
    "*** Update File: test/analyze.test.mjs",
    "@@",
    "});",
    "+test('new case', () => {});",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_unmarked_context_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: malformedPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "patch two files" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.match(formatted.output[0].input, /@@\n const before = true;\n-const value/);
  assert.match(formatted.output[0].input, /\+const value = newValue;\n \n const after = true;/);
  assert.match(formatted.output[0].input, /\*\*\* Update File: test\/analyze\.test\.mjs\n@@\n \}\);/);
});

test("chat custom apply_patch preserves Codex hunks while converting an embedded unified diff", () => {
  const mixedPatch = [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "@@",
    "const before = true;",
    "-const value = oldValue;",
    "+const value = newValue;",
    " diff --git a/test/analyze.test.mjs b/test/analyze.test.mjs",
    "--- a/test/analyze.test.mjs",
    "+++ b/test/analyze.test.mjs",
    "@@ -1,1 +1,2 @@",
    " test('old', () => {});",
    "+test('new', () => {});",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_mixed_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: mixedPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "patch two files" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.match(formatted.output[0].input, /\*\*\* Update File: cli\.mjs/);
  assert.match(formatted.output[0].input, /\*\*\* Update File: test\/analyze\.test\.mjs/);
  assert.doesNotMatch(formatted.output[0].input, /diff --git|^--- |^\+\+\+ /m);
});

test("chat custom apply_patch converts embedded file headers with a bare hunk", () => {
  const mixedPatch = [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "@@",
    " const before = true;",
    "-const value = oldValue;",
    "+const value = newValue;",
    "--- test/analyze.test.mjs",
    "+++ test/analyze.test.mjs",
    "@@",
    " test('old', () => {});",
    "+test('new', () => {});",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_bare_mixed_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: mixedPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "patch two files" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.match(formatted.output[0].input, /\*\*\* Update File: cli\.mjs/);
  assert.match(formatted.output[0].input, /\*\*\* Update File: test\/analyze\.test\.mjs\n@@/);
  assert.doesNotMatch(formatted.output[0].input, /^--- |^\+\+\+ /m);
});

test("chat custom apply_patch prefixes unmarked Add File content", () => {
  const addPatch = [
    "*** Begin Patch",
    "*** Delete File: README.md",
    "*** Add File: README.md",
    "# Session Inspector",
    "",
    "New documentation.",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_add_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: addPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "replace README" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.match(formatted.output[0].input, /\*\*\* Add File: README\.md\n\+# Session Inspector\n\+\n\+New documentation\./);
});

test("chat custom apply_patch converts Create File aliases into Add File hunks", () => {
  const createPatch = [
    "*** Begin Patch",
    "*** Create File: generated/package.json",
    "@@",
    "+{",
    "+  \"type\": \"module\"",
    "+}",
    "*** Create File: generated/done.txt",
    "@@",
    "+UI_MULTI_TURN_PROJECT_SMOKE_CREATE_ALIAS_123",
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_create_alias_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: createPatch }) },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "create generated project files" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input, [
    "*** Begin Patch",
    "*** Add File: generated/package.json",
    "+{",
    "+  \"type\": \"module\"",
    "+}",
    "*** Add File: generated/done.txt",
    "+UI_MULTI_TURN_PROJECT_SMOKE_CREATE_ALIAS_123",
    "*** End Patch",
  ].join("\n"));
});

test("chat custom apply_patch closes a complete Create File patch missing only End Patch", () => {
  const createPatch = [
    "*** Begin Patch",
    "*** Create File: generated/done.txt",
    "@@",
    "+UI_MULTI_TURN_PROJECT_SMOKE_CREATE_ALIAS_456",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_unclosed_create_alias_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: createPatch }) },
      }] },
    }],
  }, { model: "gemini-3.5-flash-low", input: "create generated/done.txt" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output[0].input.endsWith("\n*** End Patch"), true);
  assert.match(formatted.output[0].input, /\*\*\* Add File: generated\/done\.txt\n\+UI_MULTI/);
});

test("chat custom apply_patch matches an existing UTF-8 BOM in absolute-path context", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-bom-patch-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const target = path.join(tempRoot, "README.md");
  fs.writeFileSync(target, "\uFEFF# Old title\n", "utf8");
  const unifiedPatch = [
    `--- ${target}`,
    `+++ ${target}`,
    "@@ -1 +1 @@",
    "-# Old title",
    "+# New title",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{
        id: "call_bom_patch",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: unifiedPatch }) },
      }] },
    }],
  }, { model: "gpt-5.5", input: "replace README and remove its BOM" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.ok(formatted.output[0].input.includes("-\uFEFF# Old title"));
  assert.match(formatted.output[0].input, /\+# New title/);
});

test("chat response with fake-tool wording and real tool call is not blocked", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "我现在先读一下文件，然后继续处理。",
        tool_calls: [{
          id: "call_read_real",
          type: "function",
          function: {
            name: "exec_command",
            arguments: "{\"cmd\":\"Get-Content package.json -TotalCount 40\"}",
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "看看项目是什么" });

  const call = formatted.output.find((item) => item.type === "function_call");
  assert.ok(call, "real tool call should be forwarded");
  assert.equal(call.call_id, "call_read_real");
  assert.equal(call.name, "exec_command");
  assert.doesNotMatch(JSON.stringify(formatted.output), /DeepCodex|已拦截|没有实际 tool call/);
});

test("a completed write and verification turn suppresses any trailing pseudo tool call", () => {
  const userText = [
    "Only modify test/analyze.test.mjs, then run npm test and verify the CLI edge cases.",
    "After all checks pass, reply in Chinese and make the last line exactly GEMINI_V6_FINAL_CLOSURE_OK_20260712.",
  ].join("\n");
  const chatMessages = [
    { role: "user", content: userText },
    { role: "assistant", tool_calls: [{ id: "write_once", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: "[System.IO.File]::WriteAllText('test/analyze.test.mjs', 'fixed')" }) } }] },
    { role: "tool", tool_call_id: "write_once", content: "Exit code: 0\nOutput:\n" },
    { role: "assistant", tool_calls: [{ id: "verify_once", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: "node --check test/analyze.test.mjs; npm test" }) } }] },
    { role: "tool", tool_call_id: "verify_once", content: "Exit code: 0\ntests 35\npass 35\nfail 0" },
  ];
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_completed_verification_pseudo_tool",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="shell_command"><parameter name="command">Get-Content test/analyze.test.mjs</parameter></invoke></tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, {
    model: "antigravity",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  }, {
    shell_command: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  }, { strictTools: true, chatMessages });

  assert.equal(formatted.output.some(item => item.type === "function_call" || item.type === "custom_tool_call"), false);
  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.doesNotMatch(formatted.output[0].content[0].text, /tool_calls|Get-Content/);
  assert.match(formatted.output[0].content[0].text, /验证.*通过|通过.*验证/);
  assert.match(formatted.output[0].content[0].text, /GEMINI_V6_FINAL_CLOSURE_OK_20260712$/);
});

test("completed verification suppression falls back to hydrated Responses input", () => {
  const userText = "Only modify test/analyze.test.mjs, then run npm test and verify it. 最后一行必须是 GEMINI_V6_FINAL_CLOSURE_OK_20260712";
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    { type: "function_call", call_id: "write_from_responses", name: "shell_command", arguments: JSON.stringify({ command: "[System.IO.File]::WriteAllText('test/analyze.test.mjs', 'fixed')" }) },
    { type: "function_call_output", call_id: "write_from_responses", output: "Exit code: 0\nOutput:\n" },
    { type: "function_call", call_id: "verify_from_responses", name: "shell_command", arguments: JSON.stringify({ command: "node --check test/analyze.test.mjs; npm test" }) },
    { type: "function_call_output", call_id: "verify_from_responses", output: "Exit code: 0\ntests 35\npass 35\nfail 0" },
  ];
  const formatted = chatToResponsesFormat({
    model: "antigravity",
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="shell_command"><parameter name="command">Get-Content test/analyze.test.mjs</parameter></invoke></tool_calls>`,
      },
    }],
  }, { model: "antigravity", input }, {
    shell_command: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  }, {
    strictTools: true,
    chatMessages: [{ role: "user", content: "工具调用已完成，请直接总结。" }],
  });

  assert.equal(formatted.output.some(item => item.type === "function_call" || item.type === "custom_tool_call"), false);
  assert.equal(formatted.output.length, 1);
  assert.match(formatted.output[0].content[0].text, /GEMINI_V6_FINAL_CLOSURE_OK_20260712$/);
});

test("Anti-Codex repair guidance does not count as completed verification", () => {
  const targetPath = "C:\\Temp\\desktop-visible-autonomous-reasoning\\repair";
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_REPAIR_20260712";
  const userText = [
    `Continue the task in ${targetPath}.`,
    "codex-update-analyzer.mjs must export summarizeSources.",
    "Run node --test codex-update-analyzer.test.mjs after the repair.",
    `The final line must be ${marker}.`,
  ].join("\n");
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    {
      type: "function_call",
      call_id: "inspection_guidance",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "Write-Output 'Anti-Codex completed the inspection phase after detecting repeated read-only calls. Run node --test after the required edit.'",
        workdir: targetPath,
      }),
    },
    { type: "function_call_output", call_id: "inspection_guidance", output: "Process exited with code 0\nOutput:\nAnti-Codex completed the inspection phase after detecting repeated read-only calls." },
    {
      type: "function_call",
      call_id: "patch_guidance",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "Write-Output 'Anti-Codex blocked apply_patch for generated artifacts. Continue with WriteAllText and then node --test.'",
        workdir: targetPath,
      }),
    },
    { type: "function_call_output", call_id: "patch_guidance", output: "Process exited with code 0\nOutput:\nAnti-Codex blocked apply_patch for generated artifacts." },
  ];
  const formatted = chatToResponsesFormat({
    model: "antigravity",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "real_repair_verification",
          type: "function",
          function: {
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "node --test codex-update-analyzer.test.mjs", workdir: targetPath }),
          },
        }],
      },
    }],
  }, { model: "antigravity", input }, {
    exec_command: {
      codexName: "exec_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  }, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call, "the real repair verification call must not be suppressed by control guidance");
  assert.equal(call.call_id, "real_repair_verification");
});

test("malformed custom apply_patch call is not forwarded to Codex", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_bad_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "{}",
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "patch" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /requires a complete freeform patch/);
  assert.match(formatted.output[0].content[0].text, /Add File/);
  assert.match(formatted.output[0].content[0].text, /End Patch/);
  assert.match(formatted.output[0].content[0].text, /Do not bypass/);
});

test("empty custom apply_patch content is not forwarded to Codex", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_empty_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "{\"content\":\"  \"}",
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "patch" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /Regenerate a valid patch body/);
});

test("stream mapper converts Chat text deltas to Responses events", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "hello" }, "gpt-5.5");
  const first = mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
  });
  assert.ok(first.some(([event]) => event === "response.created"));
  assert.ok(first.some(([event]) => event === "response.output_text.delta"));

  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].content[0].text, "Hi");
  assert.equal(completed.response.usage.total_tokens, 4);
});

test("stream mapper blocks future-action-only text at completion", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "继续" }, "gpt-5.5");
  mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "好的，先完整读当前 projections.mjs，然后一次性把补丁打上。" }, finish_reason: null }],
  });
  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.match(completed.response.output[0].content[0].text, /已拦截这轮回复/);
});

test("stream mapper blocks direct command promises at completion", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "继续" }, "gpt-5.5");
  mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "Server 挂了。让我确认文件状态然后启动：我直接用 npx remotion studio。" }, finish_reason: null }],
  });
  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.match(completed.response.output[0].content[0].text, /已拦截这轮回复/);
});

test("stream mapper blocks web_search unavailable claims without web tool evidence", () => {
  const mapper = new ChatToResponsesStreamMapper({
    model: "gpt-5.5",
    input: [
      { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_exec", output: "curl: failed to connect" },
    ],
  }, "gpt-5.5");

  mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "我试了，web_search 目前不可用，只能靠 shell。" }, finish_reason: null }],
  });
  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.match(completed.response.output[0].content[0].text, /不能等同于 web_search\/web_fetch 不可用/);
  assert.doesNotMatch(completed.response.output[0].content[0].text, /请继续时/);
});

test("tool-capable stream mapper buffers fake action text until guarded completion", () => {
  const rawClaim = "I will run the marker tool now.";
  const mapper = new ChatToResponsesStreamMapper({
    model: "gpt-5.5",
    input: "run marker tool",
    tools: [{ type: "function", name: "marker_tool" }],
  }, "gpt-5.5");

  const first = mapper.pushChunk({
    choices: [{ index: 0, delta: { content: rawClaim }, finish_reason: null }],
  });
  assert.ok(!first.some(([event]) => event === "response.output_text.delta"), "raw fake-action text must not stream before guard checks");

  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const deltas = done.filter(([event]) => event === "response.output_text.delta").map(([, payload]) => payload.delta);
  assert.equal(deltas.length, 1);
  assert.doesNotMatch(deltas[0], /I will run the marker tool now/);
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.notEqual(completed.response.output[0].content[0].text, rawClaim);
});

test("Antigravity non-stream fake tool retry includes external tool schema", async () => {
  let calls = 0;
  let retryPrompt = "";
  const completion = await callAntigravityWithInternalTools({
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "Create report.md and index.html with the write_report_site tool." }],
    tools: [{
      type: "function",
      function: {
        name: "write_report_site",
        parameters: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "object" } },
            marker: { type: "string" },
          },
          required: ["files", "marker"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: "required",
  }, {
    callQueued: async (body) => {
      calls += 1;
      if (calls === 1) {
        return { choices: [{ message: { role: "assistant", content: "I will write the report and site now." }, finish_reason: "stop" }] };
      }
      retryPrompt = body.messages.at(-1).content;
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_report", type: "function", function: { name: "write_report_site", arguments: '{"files":[],"marker":"M"}' } }],
          },
        }],
      };
    },
  });

  assert.equal(calls, 2);
  assert.match(retryPrompt, /write_report_site/);
  assert.match(retryPrompt, /files/);
  assert.match(retryPrompt, /<tool_calls><invoke name="tool_name">/);
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "write_report_site");
});

test("single required external tool is forced by name and described on the first turn", () => {
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: "Create report.md and index.html.",
    tool_choice: "required",
    tools: [{
      type: "function",
      name: "write_report_site",
      description: "Write the requested report and site files.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "object" } },
          marker: { type: "string" },
        },
        required: ["files", "marker"],
        additionalProperties: false,
      },
    }],
  });

  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "write_report_site" } });
  assert.match(body.messages[0].content, /write_report_site/);
  assert.match(body.messages[0].content, /files/);
  assert.match(body.messages[0].content, /<tool_calls><invoke name="tool_name">/);
});

test("an explicitly required next external tool overrides auto choice", () => {
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: "继续同一项目。下一项输出必须是 shell_command，并设置 workdir 为目标目录。",
    tool_choice: "auto",
    tools: [{
      type: "function",
      name: "shell_command",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["command"],
      },
    }],
  });

  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "shell_command" } });
});

test("a Chinese first-step shell contract overrides auto tool choice", () => {
  const body = responsesToChatBody({
    model: "gemini-3.1-pro-low",
    input: "第一步必须直接调用一次 shell_command，在项目目录执行恢复，不要先读文件或列目录。",
    tool_choice: "auto",
    tools: [
      {
        type: "function",
        name: "shell_command",
        description: "Run a shell command.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      { type: "custom", name: "apply_patch", description: "Apply a patch.", format: { type: "text" } },
    ],
  });

  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "shell_command" } });
});

test("an explicitly required first custom tool overrides auto choice", () => {
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "Your first action must be exactly one apply_patch call using relative README.md. After it succeeds, run npm test with shell_command.",
        }],
      },
    ],
    tool_choice: "auto",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch to workspace files.",
        format: { type: "text" },
      },
      {
        type: "function",
        name: "shell_command",
        description: "Run a shell command.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, workdir: { type: "string" } },
          required: ["command"],
        },
      },
    ],
  });

  assert.ok(body.tools.some(tool => tool.function?.name === "apply_patch"));
  assert.ok(body.tools.some(tool => tool.function?.name === "shell_command"));
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "apply_patch" } });
});

test("an explicit next-tool choice does not persist after that tool returns", () => {
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "下一项输出必须是 shell_command。完成后根据工具结果继续。" }],
      },
      { type: "function_call", call_id: "call_required_shell", name: "shell_command", arguments: "{\"command\":\"node --test\"}" },
      { type: "function_call_output", call_id: "call_required_shell", output: "Exit code: 0" },
    ],
    tool_choice: "auto",
    tools: [{
      type: "function",
      name: "shell_command",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    }],
  });

  assert.equal(body.tool_choice, "auto");
});

test("Antigravity SSE pipe forwards the resolved Codex workspace to the streamed upstream", async () => {
  const chunks = [];
  const res = {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); },
    end() {},
  };
  const cwd = path.resolve(os.tmpdir(), "anticodex streamed workspace");
  let receivedOptions = null;
  async function* streamUpstream(_body, options) {
    receivedOptions = options;
    yield {
      type: "done",
      completion: {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
      },
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "reply once" }],
  }, {
    model: "gemini-pro-agent",
    input: "reply once",
  }, null, {
    cwd,
    workspaceSource: "request-environment-context",
    codexSessionId: "019f5014-0070-7891-845b-c16f1f1f6215",
    queue: { run: async (task) => task({}) },
    streamUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  assert.equal(receivedOptions.cwd, cwd);
  assert.equal(receivedOptions.workspaceSource, "request-environment-context");
  assert.equal(receivedOptions.codexSessionId, "019f5014-0070-7891-845b-c16f1f1f6215");
  assert.match(chunks.join(""), /response\.completed/);
});

test("Antigravity SSE pipe preserves a completed trajectory pseudo shell call", async () => {
  const chunks = [];
  const res = {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); },
    end() {},
  };
  const instruction = [
    "Continue the same task. Do not read, list, or run the old tests first.",
    "Your next response must be a real shell_command that rewrites src/normalize.mjs.",
    "UI_AUTONOMOUS_REASONING_SMOKE_FINAL3_20260711",
  ].join(" ");
  const parsed = {
    model: "claude-opus-4-6-thinking",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: instruction }],
    }],
    tools: [{
      type: "function",
      name: "shell_command",
      description: "Run a PowerShell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = chatBody._routing;
  delete chatBody._routing;
  const trajectoryText = `先看一下项目当前的文件结构和状态。\n\n<tool_calls>\n<invoke name="shell_command">\n<parameter name="command">Get-ChildItem -Recurse -Force "C:\\Temp\\session-inspector" | Select-Object FullName, Length</parameter>\n<parameter name="workdir">C:\\Temp\\session-inspector</parameter>\n</invoke>\n</tool_calls>`;
  const trajectoryCompletion = {
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: trajectoryText },
    }],
  };
  const direct = chatToResponsesFormat(trajectoryCompletion, parsed, routing, {
    strictTools: true,
    chatMessages: chatBody.messages,
  });
  assert.equal(direct.output.find((item) => item.type === "function_call")?.name, "shell_command");
  let streamCalls = 0;
  let nonStreamingCalls = 0;
  async function* streamUpstream() {
    streamCalls += 1;
    yield {
      type: "done",
      completion: trajectoryCompletion,
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue: { run: async (task) => task({}) },
    streamUpstream,
    nonStreamingUpstream: async () => {
      nonStreamingCalls += 1;
      return trajectoryCompletion;
    },
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.deepEqual({ streamCalls, nonStreamingCalls }, { streamCalls: 1, nonStreamingCalls: 0 });
  assert.match(wire, /"type":"function_call"/);
  assert.match(wire, /"name":"shell_command"/);
  assert.doesNotMatch(wire, /本轮没有实际 tool call/);
});

test("Antigravity SSE pipe retries fake tool claims before emitting buffered tool-capable text", async () => {
  let streamCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const parsed = {
    model: "gemini-pro-agent",
    input: "run the marker tool",
    tools: [{ type: "function", name: "marker_tool" }],
  };
  const chatBody = {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "run the marker tool" }],
    tools: [{ type: "function", function: { name: "marker_tool", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    tool_choice: "auto",
  };
  const routing = {
    marker_tool: {
      type: "function",
      codexName: "marker_tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };
  const queue = { run: async (task) => task({}) };
  async function* streamUpstream(body) {
    streamCalls += 1;
    if (streamCalls === 1) {
      assert.match(body.messages.at(-1).content, /run the marker tool/);
      yield { type: "text_delta", delta: "I will run the marker tool now." };
      yield {
        type: "done",
        completion: {
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "I will run the marker tool now." } }],
        },
      };
      return;
    }
    assert.match(body.messages.at(-1).content, /This is not the final answer|CODEX_TOOLS/);
    yield {
      type: "done",
      completion: {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_marker", type: "function", function: { name: "marker_tool", arguments: "{}" } }],
          },
        }],
      },
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue,
    streamUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.equal(streamCalls, 2);
  assert.doesNotMatch(wire, /I will run the marker tool now/);
  assert.match(wire, /"type":"function_call"/);
  assert.match(wire, /"name":"marker_tool"/);
  assert.match(wire, /response.completed/);
});

test("Antigravity SSE pipe retries an empty tool-capable stream and surfaces a visible blocker", async () => {
  let streamCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const parsed = {
    model: "claude-opus-4-6-thinking",
    input: "run the marker tool",
    tools: [{ type: "function", name: "marker_tool" }],
  };
  const chatBody = {
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "run the marker tool" }],
    tools: [{ type: "function", function: { name: "marker_tool", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    tool_choice: "auto",
  };
  const routing = {
    marker_tool: {
      type: "function",
      codexName: "marker_tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };
  const queue = { run: async (task) => task({}) };
  async function* streamUpstream(body) {
    streamCalls += 1;
    if (streamCalls === 2) assert.match(body.messages.at(-1).content, /空回复|empty/i);
    yield {
      type: "done",
      completion: {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }],
      },
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue,
    streamUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.equal(streamCalls, 2);
  assert.match(wire, /已拦截空回复/);
  assert.match(wire, /response\.output_text\.done/);
  assert.match(wire, /response.completed/);
});

test("Antigravity SSE pipe uses non-streaming model call for local artifact tool tasks", async () => {
  let streamCalls = 0;
  let nonStreamingCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const marker = "UI_AGENTIC_STEP_FLOW_STREAM_TEST_123456";
  const parsed = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Create index.html, README.md, and done.txt in C:\\Temp\\agentic. done.txt must contain ${marker}.` }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const queue = { run: async (task) => task({}) };
  async function* streamUpstream() {
    streamCalls += 1;
    yield { type: "done", completion: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "I will create the files now." } }] } };
  }
  async function nonStreamingUpstream(body) {
    nonStreamingCalls += 1;
    assert.equal(body.stream, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    return {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_shell", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: `Write-Output ${marker}` }) } }],
        },
      }],
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue,
    streamUpstream,
    nonStreamingUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
    streamIdleTimeoutMs: 5,
    streamTotalTimeoutMs: 100,
  });

  const wire = chunks.join("");
  assert.equal(streamCalls, 0);
  assert.equal(nonStreamingCalls, 1);
  assert.match(wire, /"type":"function_call"/);
  assert.match(wire, /"name":"shell_command"/);
  assert.match(wire, new RegExp(marker));
  assert.match(wire, /response.completed/);
});

test("Antigravity SSE pipe retries a fake completion for a Chinese batch launch task", async () => {
  let streamCalls = 0;
  let nonStreamingCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const prompt = [
    "请在 C:\\Temp\\launch-once 新建 start.bat。",
    "使用 shell_command 和 Start-Process 只启动一次 start.bat。",
    "随后读取 launch-count.txt 与 launch-proof.txt 验证结果。",
  ].join(" ");
  const parsed = {
    model: "gemini-3.5-flash-low",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  async function* streamUpstream() {
    streamCalls += 1;
    yield {
      type: "done",
      completion: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "start.bat 已创建并启动，结果已验证。" } }] },
    };
  }
  async function nonStreamingUpstream(body) {
    nonStreamingCalls += 1;
    assert.equal(body.stream, false);
    if (nonStreamingCalls === 1) {
      return {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "start.bat 已创建并启动，结果已验证。" } }],
      };
    }
    assert.match(body.messages.at(-1).content, /not the final answer|CODEX_TOOLS|实际 tool call/i);
    return {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_launch_once",
            type: "function",
            function: {
              name: "shell_command",
              arguments: JSON.stringify({ command: "Set-Content start.bat 'launch-target.ps1'" }),
            },
          }],
        },
      }],
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue: { run: async (task) => task({}) },
    streamUpstream,
    nonStreamingUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.deepEqual({ streamCalls, nonStreamingCalls }, { streamCalls: 0, nonStreamingCalls: 2 });
  assert.doesNotMatch(wire, /start\.bat 已创建并启动/);
  assert.match(wire, /"type":"function_call"/);
  assert.match(wire, /"name":"shell_command"/);
  assert.match(wire, /response.completed/);
});

test("Antigravity SSE pipe finalizes completed report-site tool evidence without another model call", async () => {
  let nonStreamingCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const marker = "UI_REPORT_SITE_SMOKE_STREAM_DONE_123456";
  const parsed = {
    model: "gemini-3.5-flash-low",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Create report.md, index.html, and done.txt in C:\\Temp\\desktop-visible-report-site\\run. done.txt must contain ${marker}.` }],
      },
      { type: "function_call", call_id: "call_report_done", name: "shell_command", arguments: JSON.stringify({ command: "write report files" }) },
      { type: "function_call_output", call_id: "call_report_done", output: `report.md:262\nindex.html:373\ndone.txt:34\n${marker}` },
    ],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"],
    },
  },
  };

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue: { run: async (task) => task({}) },
    nonStreamingUpstream: async () => {
      nonStreamingCalls += 1;
      return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "I will verify the report files now." } }] };
    },
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.equal(nonStreamingCalls, 0);
  assert.match(wire, /report\.md/);
  assert.match(wire, new RegExp(marker));
  assert.doesNotMatch(wire, /没有实际 tool call|I will verify/);
  assert.match(wire, /response\.completed/);
});

test("Antigravity non-streaming local artifact path retries an empty completion and surfaces a visible blocker", async () => {
  let nonStreamingCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_EMPTY_20260711";
  const targetPath = "C:\\Temp\\empty-completion";
  const parsed = {
    model: "claude-opus-4-6-thinking",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请自主完成长任务，在 ${targetPath} 创建 package.json, analyzer.mjs, report.md, README.md, done.txt。done.txt must contain ${marker}. 可以创建文件和运行命令。`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const queue = { run: async (task) => task({}) };
  async function nonStreamingUpstream(body) {
    nonStreamingCalls += 1;
    if (nonStreamingCalls === 2) assert.match(body.messages.at(-1).content, /空回复|empty/i);
    return {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }],
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue,
    nonStreamingUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.equal(nonStreamingCalls, 2);
  assert.match(wire, /已拦截空回复/);
  assert.match(wire, /response\.output_text\.done/);
  assert.match(wire, /response.completed/);
});

test("Antigravity non-streaming local artifact path replays fake completions until a tool call", async () => {
  let nonStreamingCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_TEST_123456";
  const targetPath = "C:\\Temp\\autonomous-reasoning";
  const parsed = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请自主完成长任务，在 ${targetPath} 创建 package.json, codex-update-analyzer.mjs, sources.json, report.md, index.html, done.txt。done.txt must contain ${marker}. 可以创建文件和运行命令。`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const queue = { run: async (task) => task({}) };
  async function nonStreamingUpstream(body) {
    nonStreamingCalls += 1;
    assert.equal(body.stream, false);
    if (nonStreamingCalls === 1) {
      return {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: `Files created and verified.\n\n${marker}` } }],
      };
    }
    assert.match(body.messages.at(-1).content, /Anti-Codex blocked|Required exact marker|CODEX_TOOLS/);
    return {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_shell", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: `Write-Output ${marker}` }) } }],
        },
      }],
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue,
    nonStreamingUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.equal(nonStreamingCalls, 2);
  assert.doesNotMatch(wire, /Files created and verified/);
  assert.match(wire, /"type":"function_call"/);
  assert.match(wire, /"name":"shell_command"/);
  assert.match(wire, new RegExp(marker));
  assert.match(wire, /response.completed/);
});

test("Antigravity SSE pipe blocks fake tool claims after replay exhaustion", async () => {
  let streamCalls = 0;
  const chunks = [];
  const res = {
    writeHead(status, headers) {
      chunks.push(`HEAD ${status} ${headers["content-type"]}`);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      chunks.push("END");
    },
  };
  const parsed = {
    model: "gemini-pro-agent",
    input: "run the marker tool",
    tools: [{ type: "function", name: "marker_tool" }],
  };
  const chatBody = {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "run the marker tool" }],
    tools: [{ type: "function", function: { name: "marker_tool", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    tool_choice: "auto",
  };
  const routing = {
    marker_tool: {
      type: "function",
      codexName: "marker_tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };
  const queue = { run: async (task) => task({}) };
  async function* streamUpstream() {
    streamCalls += 1;
    yield { type: "text_delta", delta: "I will run the marker tool now." };
    yield {
      type: "done",
      completion: {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "I will run the marker tool now." } }],
      },
    };
  }

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue,
    streamUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  const wire = chunks.join("");
  assert.equal(streamCalls, 3);
  assert.match(wire, /Anti-Codex/);
  assert.match(wire, /tool call/);
  assert.doesNotMatch(wire, /I will run the marker tool now/);
  assert.doesNotMatch(wire, /"type":"function_call"/);
  assert.match(wire, /response.completed/);
});

test("generic provider streaming path aborts upstream fetch when the client disconnects", () => {
  const server = fs.readFileSync(new URL("../adaptive-server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("async function pipeStreamingChatAsResponses");
  const end = server.indexOf("async function readRaw", start);
  assert.ok(start >= 0 && end > start, "pipeStreamingChatAsResponses must be extractable");
  const body = server.slice(start, end);
  assert.match(body, /const controller = new AbortController\(\)/);
  assert.match(body, /req\.on\?\.\("aborted", abortStreaming\)/);
  assert.match(body, /res\.on\?\.\("close", abortStreaming\)/);
  assert.match(body, /signal: controller\.signal/);
  assert.match(body, /cleanupStreamingListeners\(\)/);
});

test("native streaming is disabled when translator internal web tools may be needed", () => {
  assert.equal(canUseNativeStreaming({ stream: true }, { model: "deepseek-v4-pro" }, false), false);
});

test("native streaming is opt-in even when no tools are present", () => {
  const previous = process.env.TRANSLATOR_NATIVE_STREAMING;
  delete process.env.TRANSLATOR_NATIVE_STREAMING;
  try {
    assert.equal(canUseNativeStreaming({ stream: true }, { model: "plain-chat" }, false), false);
  } finally {
    if (previous === undefined) delete process.env.TRANSLATOR_NATIVE_STREAMING;
    else process.env.TRANSLATOR_NATIVE_STREAMING = previous;
  }
});

test("system block includes global macOS permission-sensitive action guidance", () => {
  const block = buildSystemBlock();
  assert.match(block, /macOS permission-sensitive action rule:/);
  assert.match(block, /keep the triggering process alive for at least 15 seconds/i);
  assert.match(block, /do not immediately replace a just-started local server/i);
});

test("system block tells Windows agents to use Node .cmd shims", () => {
  const block = buildSystemBlock();
  assert.match(block, /Windows Node command rule:/);
  assert.match(block, /npx\.cmd/);
  assert.match(block, /Start-Process -FilePath "npx"/);
  assert.match(block, /Do not prepend C:\\Program Files\\nodejs to PATH/);
  assert.match(block, /honor an explicit user requirement to use a specific tool or command/i);
  assert.match(block, /System\.IO\.File.*WriteAllText/);
  assert.match(block, /Do not force Node\.js/i);
  assert.match(block, /read the files back and fix any mojibake/i);
  assert.doesNotMatch(block, /Write those files with Node\.js fs\.writeFileSync/);
});

test("system block distinguishes hosted tool limits from internal web tools", () => {
  const block = buildSystemBlock();
  assert.match(block, /does NOT support provider-hosted tools/i);
  assert.match(block, /use the translator-provided internal web_search and web_fetch tools/i);
  assert.match(block, /Do not say web_search or web_fetch is unavailable/i);
  assert.doesNotMatch(block, /This route does NOT support: hosted tools/i);
});

test("system block includes honest local Skill MCP and connector inventory", () => {
  const block = buildSystemBlock();
  assert.match(block, /Anti-Codex local feature inventory:/);
  assert.match(block, /Local Skills copied into this Anti-Codex home:/);
  assert.match(block, /Local MCP servers configured in this Anti-Codex home:/);
  assert.match(block, /Snapshot presence is metadata, not proof that a remote app tool is callable/);
});

test("system block forbids fake tool execution narration", () => {
  const block = buildSystemBlock();
  assert.match(block, /Tool evidence honesty rule:/);
  assert.match(block, /Never claim that you searched/);
  assert.match(block, /corresponding tool call\/result exists/);
  assert.match(block, /Do not say a search is running in the background/);
  assert.match(block, /找一找, 搜索, 查案例, 看看 GitHub/);
  assert.match(block, /do not have actual search results/i);
  assert.match(block, /Do not invent URLs, repositories, examples, or source claims/i);
  assert.match(block, /Do not claim you switched to a different execution\/authentication mode/i);
  assert.match(block, /token, browser, SSH, API key, local bridge/i);
  assert.match(block, /Do not end a turn with a future-action promise/);
  assert.match(block, /call the appropriate tool now/);
  assert.match(block, /After a tool failure/);
});

test("stream mapper converts Chat tool_call deltas to Responses function_call events", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "pwd" }, "gpt-5.5");
  const first = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_exec",
          type: "function",
          function: { name: "exec_command", arguments: "{\"cmd\"" },
        }],
      },
      finish_reason: null,
    }],
  });
  assert.ok(first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "function_call"));
  assert.ok(first.some(([event]) => event === "response.function_call_arguments.delta"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: ":\"pwd\"}" } }] },
      finish_reason: "tool_calls",
    }],
  });
  const argsDone = done.find(([event]) => event === "response.function_call_arguments.done")?.[1];
  assert.equal(argsDone.arguments, "{\"cmd\":\"pwd\"}");
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].type, "function_call");
  assert.equal(completed.response.output[0].call_id, "call_exec");
  assert.equal(completed.response.output[0].arguments, "{\"cmd\":\"pwd\"}");
});

test("stream mapper normalizes shell_command command arg when Codex schema requires cmd", () => {
  const routing = {
    shell_command: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
    },
  };
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "pwd" }, "gpt-5.5", routing);
  const first = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_shell_cmd_stream",
          type: "function",
          function: { name: "shell_command", arguments: "{\"command\"" },
        }],
      },
      finish_reason: null,
    }],
  });
  assert.ok(first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "function_call"));
  assert.ok(!first.some(([event]) => event === "response.function_call_arguments.delta"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: ":\"pwd\"}" } }] },
      finish_reason: "tool_calls",
    }],
  });
  const argsDone = done.find(([event]) => event === "response.function_call_arguments.done")?.[1];
  assert.equal(argsDone.arguments, "{\"cmd\":\"pwd\"}");
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].name, "shell_command");
  assert.deepEqual(JSON.parse(completed.response.output[0].arguments), { cmd: "pwd" });
});

test("stream mapper buffers and anchors shell workdir to the latest explicit project directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex streamed shell workspace "));
  const project = path.join(root, "real project with spaces");
  const drifted = path.join(root, "generated fallback workspace");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(drifted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const routing = {
    shell_command: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
    },
  };
  const mapper = new ChatToResponsesStreamMapper({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${drifted}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `Project directory:\n${project}\n\nRead test/analyze.test.mjs.` }] },
    ],
  }, "gpt-5.5", routing);
  const first = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{
        index: 0,
        id: "call_scoped_shell_stream",
        type: "function",
        function: { name: "shell_command", arguments: '{"command":"Get-Content test/analyze.test.mjs"}' },
      }] },
      finish_reason: null,
    }],
  });
  assert.ok(!first.some(([event]) => event === "response.function_call_arguments.delta"));

  const done = mapper.pushChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  const argsDone = done.find(([event]) => event === "response.function_call_arguments.done")?.[1];
  assert.equal(JSON.parse(argsDone.arguments).workdir, path.resolve(project));
});

test("stream mapper converts Chat custom tool calls to custom_tool_call items", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "patch" }, "gpt-5.5", {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });
  const patch = "*** Begin Patch\n*** End Patch\n";
  const first = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_patch",
          type: "function",
          function: { name: "apply_patch", arguments: JSON.stringify({ content: patch }).slice(0, 20) },
        }],
      },
      finish_reason: null,
    }],
  });
  assert.ok(!first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "custom_tool_call"));
  assert.ok(!first.some(([event]) => event === "response.function_call_arguments.delta"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ content: patch }).slice(20) } }] },
      finish_reason: "tool_calls",
    }],
  });
  assert.ok(!done.some(([event]) => event === "response.function_call_arguments.done"));
  const itemAdded = done.find(([event, data]) => event === "response.output_item.added" && data.item.type === "custom_tool_call")?.[1];
  assert.equal(itemAdded.item.call_id, "call_patch");
  assert.equal(itemAdded.item.name, "apply_patch");
  const itemDone = done.find(([event, data]) => event === "response.output_item.done" && data.item.type === "custom_tool_call")?.[1];
  assert.equal(itemDone.item.call_id, "call_patch");
  assert.equal(itemDone.item.name, "apply_patch");
  assert.equal(itemDone.item.input, patch);
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].type, "custom_tool_call");
  assert.equal(completed.response.output[0].input, patch);
});

test("stream mapper anchors relative custom patches to an explicit project directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex streamed patch workspace "));
  const project = path.join(root, "real project with spaces");
  const drifted = path.join(root, "generated fallback workspace");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(drifted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mapper = new ChatToResponsesStreamMapper({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${drifted}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `Project directory:\n${project}\n\nFix src/value.mjs.` }] },
    ],
  }, "gpt-5.5", {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/value.mjs",
    "@@",
    "-export const value = 1;",
    "+export const value = 2;",
    "*** End Patch",
  ].join("\n");
  const events = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{
        index: 0,
        id: "call_scoped_patch_stream",
        type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ content: patch }) },
      }] },
      finish_reason: "tool_calls",
    }],
  });

  const itemDone = events.find(([event, data]) => event === "response.output_item.done" && data.item.type === "custom_tool_call")?.[1];
  assert.ok(itemDone.item.input.includes(`*** Update File: ${path.resolve(project, "src", "value.mjs")}`));
});

test("stream mapper normalizes a conflict replacement custom patch", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "patch" }, "gpt-5.5", {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });
  const conflictPatch = [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "<<<<<<<",
    "old line",
    "=======",
    "new line",
    ">>>>>>>",
    "*** End Patch",
  ].join("\n");
  const events = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_conflict_patch_stream",
          type: "function",
          function: { name: "apply_patch", arguments: JSON.stringify({ content: conflictPatch }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });

  const itemDone = events.find(([event, data]) => event === "response.output_item.done" && data.item.type === "custom_tool_call")?.[1];
  assert.equal(itemDone.item.input, [
    "*** Begin Patch",
    "*** Update File: cli.mjs",
    "@@",
    "-old line",
    "+new line",
    "*** End Patch",
  ].join("\n"));
});

test("stream mapper keeps invalid Chat custom tool calls as message items", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "patch" }, "gpt-5.5", {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });
  const first = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_patch",
          type: "function",
          function: { name: "apply_patch", arguments: "{\"content\":\"   " },
        }],
      },
      finish_reason: null,
    }],
  });
  assert.ok(!first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "custom_tool_call"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: "\"}" } }] },
      finish_reason: "tool_calls",
    }],
  });
  assert.ok(!done.some(([event, data]) => event === "response.output_item.added" && data.item.type === "custom_tool_call"));
  const itemAdded = done.find(([event]) => event === "response.output_item.added")?.[1];
  const itemDone = done.find(([event]) => event === "response.output_item.done")?.[1];
  assert.equal(itemAdded.output_index, itemDone.output_index);
  assert.equal(itemAdded.item.type, "message");
  assert.equal(itemDone.item.type, "message");
  assert.match(itemDone.item.content[0].text, /apply_patch requires a complete freeform patch\/tool body/);
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].type, "message");
});

test("stream mapper converts reasoning_content to replayable reasoning item", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "pwd" }, "gpt-5.5");
  const first = mapper.pushChunk({
    choices: [{ index: 0, delta: { reasoning_content: "Need to inspect cwd." }, finish_reason: null }],
  });
  assert.ok(first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "reasoning"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_exec",
          type: "function",
          function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
  const reasoningDone = done.find(([event, data]) => event === "response.output_item.done" && data.item.type === "reasoning")?.[1];
  assert.match(reasoningDone.item.encrypted_content, /^deepcodex\.reasoning\.hex\.v1:/);
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].type, "reasoning");
  assert.equal(completed.response.output[1].type, "function_call");
});

test("polluted history is cleaned before forwarding to Chat Completions", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: dsmlFetch }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "继续" }],
      },
    ],
  }, { allowTools: false, injectInternalTools: false });
  assert.equal(body.messages[0].content.includes("DSML"), false);
  assert.equal(body.messages[0].content.includes("web_fetch"), false);
  assert.match(body.messages[0].content, /最后抓一下 163/);
});

test("Responses reasoning effort is preserved for the Antigravity bridge", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    reasoning: { effort: "xhigh", summary: "auto" },
    input: [{ type: "message", role: "user", content: "Analyze carefully." }],
  });

  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
});

test("pure leaked pseudo DSML assistant history is dropped after cleanup", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: `< | | DSML | | tool_calls>
< | | DSML | | invoke name="web_fetch">
< | | DSML | | parameter name="url" string="true">https://example.com</| | DSML | | parameter>
</| | DSML | | invoke>
</| | DSML | | tool_calls>` }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "继续" }],
      },
    ],
  }, { allowTools: false, injectInternalTools: false });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "继续");
});

test("user-supplied pseudo DSML is preserved as text and never becomes null content", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="read_file">
<｜｜DSML｜｜parameter name="file_path" string="true">/tmp/example.tsx</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>` }],
      },
    ],
  }, { allowTools: true, injectInternalTools: false });

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(typeof body.messages[0].content, "string");
  assert.match(body.messages[0].content, /read_file/);
  assert.notEqual(body.messages[0].content, null);
});

test("non-assistant empty content is removed before forwarding to Chat", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [] },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, "继续");
});

test("unsupported message roles are preserved as valid system messages", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "critic", content: [{ type: "text", text: "role should not break upstream" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /unsupported role "critic"/);
  assert.match(body.messages[0].content, /role should not break upstream/);
  assert.equal(body.messages[1].role, "user");
});

test("restored history keeps only the latest Codex model-switch instruction", () => {
  const oldSwitch = `<model_switch>\nOLD_MODEL_SWITCH_${"x".repeat(8000)}\n</model_switch>`;
  const latestSwitch = `<model_switch>\nLATEST_MODEL_SWITCH_${"y".repeat(8000)}\n</model_switch>`;
  const body = responsesToChatBody({
    model: "gemini-3.1-pro-low",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: oldSwitch }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier task" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: latestSwitch }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the current task" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.doesNotMatch(joined, /OLD_MODEL_SWITCH/);
  assert.match(joined, /LATEST_MODEL_SWITCH/);
  assert.equal(body.messages.filter(message => String(message.content).includes("<model_switch>")).length, 1);
});

test("duplicate task retry pruning preserves the latest model-switch instruction", () => {
  const task = "Continue this exact long task, modify the requested file, run every test, and finish with MODEL_SWITCH_RETRY_OK.";
  const body = responsesToChatBody({
    model: "gemini-3.1-pro-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The earlier attempt did not finish." }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "<model_switch>\nCURRENT_MODEL_RULES\n</model_switch>" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /CURRENT_MODEL_RULES/);
  assert.doesNotMatch(joined, /earlier attempt did not finish/i);
  assert.equal(body.messages.filter(message => String(message.content).includes("<model_switch>")).length, 1);
});

test("readable context_compaction input is preserved with Codex summary prefix", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "context_compaction", summary: "项目名 deepcodex，translator 已补 compact。" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content, /Another language model started to solve this problem/);
  assert.match(body.messages[0].content, /avoid duplicating work/);
  assert.match(body.messages[0].content, /deepcodex/);
  assert.equal(body.messages[1].role, "user");
});

test("opaque context_compaction input is not injected into prompt", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "context_compaction", encrypted_content: "opaque" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
});

test("damaged context_compaction repairs restore and drops noisy tool history", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "context_compaction" },
      { type: "function_call", call_id: "call_old", name: "exec_command", arguments: "{\"cmd\":\"render\"}" },
      { type: "function_call_output", call_id: "call_old", output: "ANSI render log ".repeat(2000) },
      { type: "message", role: "developer", content: [{ type: "text", text: "stale developer instruction" }] },
      { type: "message", role: "assistant", content: [{ type: "text", text: "上一轮已经做到一半。" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "继续修复 compact restore。" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content, /damaged previous context_compaction/);
  assert.match(body.messages[0].content, /omitted/);
  assert.ok(!body.messages.some((message) => message.role === "tool"), "old tool outputs are dropped");
  assert.ok(!body.messages.some((message) => String(message.content).includes("stale developer instruction")), "stale developer message is dropped");
  assert.equal(body.messages.at(-1).role, "user");
  assert.match(body.messages.at(-1).content, /继续修复 compact restore/);
});

test("healthy long restored history caps pre-active history while keeping active turn", () => {
  const input = Array.from({ length: 230 }, (_, index) => ({
    type: "message",
    role: index % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `healthy-history-${index}` }],
  }));

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages.length, 222);
  assert.match(body.messages[0].content, /healthy-history-8/);
  assert.match(body.messages.at(-1).content, /healthy-history-229/);
});

test("healthy long restored history keeps the latest compaction summary before capped tail", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "text", text: "old noisy setup" }] },
    { type: "context_compaction", summary: "压缩摘要：用户正在修复缓存命中，必须保留这个记忆。" },
    ...Array.from({ length: 230 }, (_, index) => ({
      type: "message",
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `tail-history-${index}` }],
    })),
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  assert.match(body.messages[0].content, /压缩摘要/);
  assert.match(body.messages[0].content, /缓存命中/);
  assert.match(body.messages[1].content, /tail-history-8/);
  assert.match(body.messages.at(-1).content, /tail-history-229/);
});

test("restored history caps character-heavy pre-active context without losing current rules", () => {
  const currentTask = "CURRENT_LONG_TASK: modify the requested file, run all tests, and report the verified result.";
  const input = [
    { type: "context_compaction", summary: "LATEST_COMPACT_STATE: V5 is complete and V6 has one pending correction." },
    ...Array.from({ length: 90 }, (_, index) => ({
      type: "message",
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "input_text", text: `OLD_HISTORY_${index}_${"z".repeat(1800)}` }],
    })),
    { type: "message", role: "developer", content: [{ type: "input_text", text: `<model_switch>\nCURRENT_MODEL_RULES_${"r".repeat(12000)}\n</model_switch>` }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: currentTask }] },
  ];
  const body = responsesToChatBody({ model: "gemini-3.1-pro-low", input }, { allowTools: false, injectInternalTools: false });
  const joined = JSON.stringify(body.messages);

  assert.ok(joined.length < 48_000, `expected bounded restored context, got ${joined.length} chars`);
  assert.match(joined, /LATEST_COMPACT_STATE/);
  assert.match(joined, /CURRENT_MODEL_RULES/);
  assert.match(joined, /CURRENT_LONG_TASK/);
  assert.doesNotMatch(joined, /OLD_HISTORY_0_/);
});

test("restored history treats an immediately repeated long task as a fresh retry", () => {
  const task = [
    "Work only inside C:\\Temp\\session-inspector.",
    "Use apply_patch with relative README.md to change the title, then run npm test and read the file back.",
    "Finish with PATCH_SUCCESS_CONTINUATION_OK_20260712.",
  ].join("\n");
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [
      { type: "context_compaction", summary: "Long project context: V4 CLI is implemented and tests pass." },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier unrelated project requirement: preserve streaming JSON output." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The streaming requirement remains part of the project." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
      { type: "custom_tool_call", call_id: "stale_patch", name: "apply_patch", input: "*** Begin Patch\n*** Update File: README.md\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "stale_patch", output: "apply_patch verification failed: expected lines not found" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The README title was updated and all requested work is complete." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
    ],
  }, { allowTools: true, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  const normalizedTask = task.replace(/\s+/g, " ").trim();
  const matchingUserMessages = body.messages.filter(message => message.role === "user"
    && String(message.content || "").replace(/\s+/g, " ").trim() === normalizedTask);
  assert.equal(matchingUserMessages.length, 1);
  assert.match(joined, /Earlier unrelated project requirement/);
  assert.match(joined, /omitted a previous duplicate attempt/);
  assert.doesNotMatch(joined, /stale_patch/);
  assert.doesNotMatch(joined, /all requested work is complete/);
  assert.equal(body.messages.at(-1).role, "user");
  assert.equal(String(body.messages.at(-1).content).replace(/\s+/g, " ").trim(), normalizedTask);
});

test("restored history recognizes a repeated long task with whitespace-only differences", () => {
  const first = "Project directory: C:\\Temp\\session-inspector\n\nChange README.md with apply_patch, run npm test, then verify the title.";
  const retry = "  Project directory: C:\\Temp\\session-inspector\r\n Change README.md with apply_patch,   run npm test, then verify the title.  ";
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the existing V4 streaming behavior." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Streaming behavior is preserved." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: first }] },
      { type: "function_call", call_id: "stale_test", name: "shell_command", arguments: JSON.stringify({ command: "npm test", workdir: "C:\\Temp\\session-inspector" }) },
      { type: "function_call_output", call_id: "stale_test", output: "Exit code: 0\nOutput:\n30 tests passed" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Everything is already complete." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: retry }] },
    ],
  }, { allowTools: true, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Keep the existing V4 streaming behavior/);
  assert.match(joined, /omitted a previous duplicate attempt/);
  assert.doesNotMatch(joined, /stale_test/);
  assert.doesNotMatch(joined, /Everything is already complete/);
  assert.equal(body.messages.at(-1).role, "user");
  assert.equal(String(body.messages.at(-1).content).replace(/\s+/g, " ").trim(), retry.replace(/\s+/g, " ").trim());
});

test("restored history removes a consecutive chain of repeated long-task attempts", () => {
  const task = "Project directory: C:\\Temp\\session-inspector. Use relative apply_patch on README.md, run all 30 tests, read the file back, and finish with PATCH_CHAIN_RETRY_OK_20260712.";
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Preserve the earlier V4 CLI implementation and streaming behavior." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The earlier V4 requirements remain active." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
      { type: "function_call", call_id: "stale_chain_1", name: "shell_command", arguments: JSON.stringify({ command: "npm test" }) },
      { type: "function_call_output", call_id: "stale_chain_1", output: "Exit code: 0\n30 tests passed" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "First stale completion." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
      { type: "custom_tool_call", call_id: "stale_chain_2", name: "apply_patch", input: "*** Begin Patch\n*** Update File: README.md\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "stale_chain_2", output: "apply_patch verification failed" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Second stale completion." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
    ],
  }, { allowTools: true, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  const normalizedTask = task.replace(/\s+/g, " ").trim();
  const matchingUserMessages = body.messages.filter(message => message.role === "user"
    && String(message.content || "").replace(/\s+/g, " ").trim() === normalizedTask);
  assert.equal(matchingUserMessages.length, 1);
  assert.match(joined, /Preserve the earlier V4 CLI implementation/);
  assert.doesNotMatch(joined, /stale_chain_1|stale_chain_2|First stale completion|Second stale completion/);
});

test("restored history prunes older tool transcripts while keeping recent tool pairs", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前任务。" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `call_${index}`, name: "exec_command", arguments: `{"cmd":"echo ${index}"}` },
      { type: "function_call_output", call_id: `call_${index}`, output: `output-${index} ` + "x".repeat(7000) },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  assert.match(body.messages[0].content, /omitted older restored tool transcripts/);
  assert.ok(!body.messages.some((message) => String(message.content).includes("output-0")), "old tool output is omitted");
  assert.ok(body.messages.some((message) => String(message.content).includes("output-19")), "recent tool output is preserved");
  assert.ok(body.messages.some((message) => String(message.content).includes("clipped by Anti-Codex translator")), "large tool output is clipped");
  assert.equal(body.messages.at(-1).role, "user");
});

test("restored history keeps active-turn tool transcripts stable for prompt cache", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前任务。" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `old_${index}`, name: "exec_command", arguments: `{"cmd":"echo old-${index}"}` },
      { type: "function_call_output", call_id: `old_${index}`, output: `old-output-${index}` },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续修复缓存命中" }] },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `active_${index}`, name: "exec_command", arguments: `{"cmd":"echo active-${index}"}` },
      { type: "function_call_output", call_id: `active_${index}`, output: `active-output-${index}` },
    ])).flat(),
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(body.messages[0].content, /omitted older restored tool transcripts/);
  assert.doesNotMatch(joined, /old-output-0/);
  assert.match(joined, /old-output-19/);
  assert.match(joined, /active-output-0/);
  assert.match(joined, /active-output-19/);
});

test("restored history keeps active-turn prefix stable after item cap", () => {
  const oldHistory = Array.from({ length: 260 }, (_, index) => ({
    type: "message",
    role: index % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `old-history-${index}` }],
  }));
  const activeStart = [
    { type: "message", role: "user", content: [{ type: "text", text: "继续当前长任务" }] },
    ...Array.from({ length: 12 }, (_, index) => ([
      { type: "function_call", call_id: `active_${index}`, name: "exec_command", arguments: `{"cmd":"echo active-${index}"}` },
      { type: "function_call_output", call_id: `active_${index}`, output: `active-output-${index}` },
    ])).flat(),
  ];
  const activeContinuation = [
    ...Array.from({ length: 6 }, (_, index) => ([
      { type: "function_call", call_id: `active_more_${index}`, name: "exec_command", arguments: `{"cmd":"echo active-more-${index}"}` },
      { type: "function_call_output", call_id: `active_more_${index}`, output: `active-more-output-${index}` },
    ])).flat(),
  ];

  const first = responsesToChatBody({
    model: "gpt-5.5",
    input: [...oldHistory, ...activeStart],
  }, { allowTools: false, injectInternalTools: false });
  const second = responsesToChatBody({
    model: "gpt-5.5",
    input: [...oldHistory, ...activeStart, ...activeContinuation],
  }, { allowTools: false, injectInternalTools: false });

  const firstText = JSON.stringify(first.messages);
  const secondText = JSON.stringify(second.messages);
  let common = 0;
  while (common < firstText.length && common < secondText.length && firstText[common] === secondText[common]) common += 1;

  assert.ok(common / firstText.length > 0.95, `expected stable prefix, got ${(common / firstText.length).toFixed(3)}`);
  assert.match(secondText, /active-output-0/);
  assert.match(secondText, /active-more-output-5/);
});

test("restored history prunes active-turn tool transcripts already summarized by assistant", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "text", text: "继续修复" }] },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `summarized_${index}`, name: "exec_command", arguments: `{"cmd":"echo summarized-${index}"}` },
      { type: "function_call_output", call_id: `summarized_${index}`, output: `summarized-output-${index}` },
    ])).flat(),
    { type: "message", role: "assistant", content: [{ type: "text", text: "前面失败原因已经确认，继续下一步。" }] },
    { type: "function_call", call_id: "current_0", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
    { type: "function_call_output", call_id: "current_0", output: "/tmp/project" },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(body.messages[0].content, /omitted older restored tool transcripts/);
  assert.doesNotMatch(joined, /summarized-output-0/);
  assert.doesNotMatch(joined, /summarized-output-19/);
  assert.match(joined, /前面失败原因已经确认/);
  assert.ok(joined.includes("/tmp/project"));
});

test("restored history drops volatile polling transcripts that change every turn", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前发布任务。" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "可能还在跑。等等再查。" }] },
    { type: "function_call", call_id: "call_poll", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex \"powershell -NoProfile -Command \\\"Get-Process python\\\"\"" }) },
    { type: "function_call_output", call_id: "call_poll", output: "Chunk ID: abc\nWall time: 10.0009 seconds\nProcess running with session ID 96679\nOriginal token count: 56\nOutput:\n" },
    { type: "function_call", call_id: "call_result", name: "exec_command", arguments: JSON.stringify({ cmd: "cat release-notes.txt" }) },
    { type: "function_call_output", call_id: "call_result", output: "Chunk ID: stable\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 20\nOutput:\nrelease notes are ready" },
    { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });
  const joined = JSON.stringify(body.messages);

  assert.match(joined, /omitted volatile restored polling/);
  assert.doesNotMatch(joined, /Get-Process/);
  assert.doesNotMatch(joined, /session ID 96679/);
  assert.doesNotMatch(joined, /等等再查/);
  assert.doesNotMatch(joined, /Chunk ID/);
  assert.doesNotMatch(joined, /Wall time/);
  assert.match(joined, /release notes are ready/);
  assert.equal(body.messages.at(-1).role, "user");
});

test("restored history drops update_plan transcripts that churn prompt cache", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "assistant", content: [{ type: "text", text: "更新计划后继续。" }] },
      { type: "function_call", call_id: "call_plan", name: "update_plan", arguments: JSON.stringify({ plan: [{ status: "in_progress", step: "A" }] }) },
      { type: "function_call_output", call_id: "call_plan", output: "Plan updated" },
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }) },
      { type: "function_call_output", call_id: "call_exec", output: "/tmp/project" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /omitted volatile restored polling/);
  assert.doesNotMatch(joined, /update_plan/);
  assert.doesNotMatch(joined, /Plan updated/);
  assert.match(joined, /exec_command/);
  assert.ok(joined.includes("/tmp/project"));
});

test("restored history preserves durable tool facts before pruning noisy probes", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前跨工具任务。" },
    { type: "function_call", call_id: "list", name: "exec_command", arguments: JSON.stringify({ cmd: "docker exec app ls /workspace" }) },
    { type: "function_call_output", call_id: "list", output: "Chunk ID: ls\nWall time: 0s\nProcess exited with code 0\nOutput:\nnew-chat-3\nqwen-cli\nsrc\n" },
    { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "docker exec app cat /workspace/qwen-cli/package.json" }) },
    { type: "function_call_output", call_id: "read", output: "Chunk ID: read\nWall time: 0s\nProcess exited with code 0\nOutput:\n{\"name\":\"qwen-cli\"}\n" },
    { type: "function_call", call_id: "build", name: "exec_command", arguments: JSON.stringify({ cmd: "docker exec app npm run build" }) },
    { type: "function_call_output", call_id: "build", output: "Chunk ID: build\nWall time: 1s\nProcess exited with code 1\nOutput:\nError: missing script build\n" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `old_${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: `echo old-${index}` }) },
      { type: "function_call_output", call_id: `old_${index}`, output: `old-output-${index}` },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续看 qwen-cli" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Anti-Codex durable environment facts/);
  assert.match(joined, /workspace: Listing result from docker exec app ls \/workspace: new-chat-3, qwen-cli, src/);
  assert.match(joined, /tool-state: Read command succeeded: docker exec app cat \/workspace\/qwen-cli\/package\.json/);
  assert.match(joined, /tool-state: Command failed, do not assume success: docker exec app npm run build -> Error: missing script build/);
  assert.match(joined, /继续看 qwen-cli/);
});

test("restored history tells scoped fixture tasks to recover from failed apply_patch without searching transcripts", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Work only inside C:\\Temp\\fixture. Implement status-dashboard.mjs and run status-dashboard.test.mjs." }] },
    { type: "custom_tool_call", call_id: "patch_bad", name: "apply_patch", input: "*** Begin Patch\n*** Update File: C:\\Temp\\fixture\\status-dashboard.mjs\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "patch_bad", output: "apply_patch verification failed: invalid hunk at line 4, expected lines not found" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "继续修，不要查历史" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /apply_patch failed because the patch body or context was invalid/);
  assert.match(joined, /Do not search prior transcripts, Antigravity brain/);
  assert.match(joined, /Scoped fixture\/generated task recovery/);
  assert.match(joined, /use shell\/PowerShell file writes only inside the scoped directory/);
});

test("restored desktop shell history keeps missing README pending after tests pass", () => {
  const input = [
    { type: "context_compaction", summary: "Anti-Codex durable environment facts from verified tool results:\n- workspace: stale first listing" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Work only inside C:\\Temp\\desktop-coworker-project. Create README.md and fix status-dashboard.mjs, then run node --test status-dashboard.test.mjs." }] },
    { type: "function_call", call_id: "test_ok", name: "shell_command", arguments: JSON.stringify({ command: "node --test status-dashboard.test.mjs", workdir: "C:\\Temp\\desktop-coworker-project" }) },
    { type: "function_call_output", call_id: "test_ok", output: "Exit code: 0\nWall time: 0.3 seconds\nOutput:\npass 2\nfail 0" },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Build\/install command succeeded: node --test status-dashboard\.test\.mjs/);
  assert.match(joined, /there is still no successful tool evidence that README\.md was created/);
  assert.match(joined, /before rereading tests, running git status, calling get_goal/);
  assert.doesNotMatch(joined, /stale first listing/);
});

test("restored history task ledger preserves explicit task target and pending action", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前任务。" },
    { type: "message", role: "user", content: [{ type: "text", text: "帮我在 Windows 上找到 qwen-cli 项目，看看 new-chat-3 是不是相关。" }] },
    { type: "function_call", call_id: "ls", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'dir C:\\\\Users\\\\jz\\\\Documents\\\\Codex\\\\2026-05-14'" }) },
    { type: "function_call_output", call_id: "ls", output: "new-chat-3\nremotion-demo\n" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "看到 new-chat-3 了，这很可能就是 qwen 相关项目。看看它的内容：" }] },
    { type: "message", role: "user", content: [{ type: "text", text: "你倒是看啊" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Anti-Codex task ledger/);
  assert.match(joined, /current-user-task: 帮我在 Windows 上找到 qwen-cli 项目/);
  assert.match(joined, /pending-next-action: 看到 new-chat-3/);
  assert.match(joined, /target-hint: qwen-cli/);
  assert.match(joined, /target-hint: new-chat-3/);
});

test("restored history target hints keep deepcodex paths but drop bare legacy brand tokens", () => {
  const input = [
    { type: "context_compaction", summary: "continue existing task" },
    { type: "message", role: "user", content: [{ type: "text", text: "继续 deepcodex-old，真正路径是 deepcodex\\scripts\\start-deepcodex.ps1，还要看 qwen-cli" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /target-hint: deepcodex\\\\scripts\\\\start-deepcodex\.ps1/);
  assert.match(joined, /target-hint: qwen-cli/);
  assert.doesNotMatch(joined, /target-hint: deepcodex-old/);
});

test("restored history keeps successful non-shell tool calls as durable facts", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续处理浏览器标签页。" },
    { type: "function_call", call_id: "close_1", name: "closeTab", arguments: JSON.stringify({ targetId: "tab-123", url: "https://example.com/search" }) },
    { type: "function_call_output", call_id: "close_1", output: JSON.stringify({ ok: true, closed: true, targetId: "tab-123" }) },
    { type: "message", role: "assistant", content: [{ type: "text", text: "抱歉，刚才的回复没有实际行动。让我现在验证一下。" }] },
    { type: "message", role: "user", content: [{ type: "text", text: "刚才你已经成功关闭了" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Anti-Codex durable environment facts/);
  assert.match(joined, /tool-state: Tool closeTab succeeded/);
  assert.match(joined, /targetId=tab-123/);
  assert.match(joined, /刚才你已经成功关闭了/);
});

test("restored history does not turn failed non-shell tool calls into success facts", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续处理浏览器标签页。" },
    { type: "function_call", call_id: "close_1", name: "closeTab", arguments: JSON.stringify({ targetId: "tab-123" }) },
    { type: "function_call_output", call_id: "close_1", output: JSON.stringify({ ok: false, error: "tab not found" }) },
    { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Tool closeTab failed, do not assume success/);
  assert.doesNotMatch(joined, /Tool closeTab succeeded/);
});

test("restored history drops stale completion detours and paired status probes", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：用户要基于搜索结果总结 2026 年 AI 发展。" },
    { type: "function_call", call_id: "search", name: "exec_command", arguments: JSON.stringify({ cmd: "google-cli search 2026 AI" }) },
    { type: "function_call_output", call_id: "search", output: "Chunk ID: s\nWall time: 1s\nProcess exited with code 0\nOutput:\n{\"data\":[{\"title\":\"AI 2026\"}]}\n" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "搜索已经跑完了，结果就在上面。让我确认一下 daemon 还在跑、工具链完整，然后给你最终总结。" }] },
    { type: "function_call", call_id: "status", name: "exec_command", arguments: JSON.stringify({ cmd: "netstat -ano | findstr ':10086'" }) },
    { type: "function_call_output", call_id: "status", output: "Chunk ID: st\nWall time: 1s\nProcess exited with code 0\nOutput:\nTCP 127.0.0.1:10086 LISTENING\n" },
    { type: "message", role: "user", content: [{ type: "text", text: "直接总结" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /omitted volatile restored polling/);
  assert.doesNotMatch(joined, /让我确认一下 daemon/);
  assert.doesNotMatch(joined, /findstr ':10086'/);
  assert.match(joined, /2026 年 AI/);
  assert.match(joined, /直接总结/);
});

test("restored history drops local artifact tool commands with stale smoke markers", () => {
  const oldMarker = "UI_COMPLEX_PROJECT_SMOKE_111111";
  const newMarker = "UI_COMPLEX_PROJECT_SMOKE_222222";
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Create package.json, codex-update-analyzer.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\old. done.txt must contain ${oldMarker}.` }],
      },
      {
        type: "function_call",
        call_id: "call_old_complex",
        name: "shell_command",
        arguments: JSON.stringify({
          command: `# Anti-Codex complex artifact safety repair\nnode -e "require('node:fs').writeFileSync('C:\\\\Temp\\\\old\\\\done.txt','${oldMarker}','utf8')"`,
        }),
      },
      {
        type: "function_call_output",
        call_id: "call_old_complex",
        output: `Exit code: 0\n${oldMarker}`,
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Continue the same complex-project task in C:\\Temp\\new. Create package.json, codex-update-analyzer.mjs, sources.json, report.md, index.html, done.txt. done.txt must contain ${newMarker}.` }],
      },
    ],
  }, { allowTools: true, injectInternalTools: false });

  const forwarded = JSON.stringify(body.messages);
  assert.match(forwarded, new RegExp(newMarker));
  assert.doesNotMatch(forwarded, new RegExp(oldMarker));
  assert.doesNotMatch(forwarded, /Anti-Codex complex artifact safety repair/);
});

test("restored history ledger preserves workspace and tool-state facts", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续找 qwen 项目。" },
    { type: "function_call", call_id: "ls_day", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'powershell -NoProfile -Command \"Get-ChildItem C:\\\\Users\\\\jz\\\\Documents\\\\Codex\\\\2026-05-14 -Name\"'" }) },
    { type: "function_call_output", call_id: "ls_day", output: "Chunk ID: ls\nWall time: 1s\nProcess exited with code 0\nOutput:\nnew-chat-3\nqwen-cli\nremotion-demo\n" },
    { type: "function_call", call_id: "read_pkg", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'type C:\\\\Users\\\\jz\\\\Documents\\\\Codex\\\\2026-05-14\\\\new-chat-3\\\\package.json'" }) },
    { type: "function_call_output", call_id: "read_pkg", output: "Chunk ID: read\nWall time: 1s\nProcess exited with code 0\nOutput:\n{\"name\":\"new-chat-3\"}\n" },
    { type: "function_call", call_id: "build_fail", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'npm run build'" }) },
    { type: "function_call_output", call_id: "build_fail", output: "Chunk ID: build\nWall time: 1s\nProcess exited with code 1\nOutput:\nError: missing script build\n" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `old_${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: `echo old-${index}` }) },
      { type: "function_call_output", call_id: `old_${index}`, output: `old-output-${index}` },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续看 qwen" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /workspace: Listing result/);
  assert.match(joined, /new-chat-3/);
  assert.match(joined, /qwen-cli/);
  assert.match(joined, /tool-state: Read command succeeded/);
  assert.match(joined, /tool-state: Command failed, do not assume success/);
  assert.match(joined, /missing script build/);
});

test("restored custom tool calls replay as Chat tool calls", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "patch failed" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_patch");
  assert.equal(body.messages[0].tool_calls[0].function.name, "apply_patch");
  assert.deepEqual(JSON.parse(body.messages[0].tool_calls[0].function.arguments), {
    content: "*** Begin Patch\n*** End Patch",
  });
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_patch");
  assert.equal(body.messages[1].content, "patch failed");
  assert.equal(body.messages[2].role, "user");
});

test("restored custom tool bodies are clipped to avoid prompt-cache churn", () => {
  const largePatch = `*** Begin Patch\n${"x".repeat(5000)}\n*** End Patch`;
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: largePatch },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "apply_patch verification failed: expected lines not found" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const toolMessage = body.messages.find(message => Array.isArray(message.tool_calls) && message.tool_calls[0]?.function?.name === "apply_patch");
  assert.ok(toolMessage);
  const args = JSON.parse(toolMessage.tool_calls[0].function.arguments);
  assert.ok(args.content.length < largePatch.length);
  assert.match(args.content, /older custom tool body clipped/);
  assert.ok(body.messages.some(message => message.role === "tool" && message.content === "apply_patch verification failed: expected lines not found"));
});

test("repo multi-file README step rewrites forbidden listing detours to the requested file write", () => {
  const prompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. After README.md exists, reply with exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_123 on the final line and stop.`;
  const request = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
  };
  const routing = { shell_command: { codexName: "shell_command", type: "function" } };
  const formatted = chatToResponsesFormat({
    choices: [{
      message: {
        tool_calls: [{
          id: "call_detour",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: String.raw`Get-ChildItem -Path C:\Users\XD\.gemini\antigravity\brain -Recurse` }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const toolCall = formatted.output.find(item => item.type === "function_call");
  assert.ok(toolCall);
  const args = JSON.parse(toolCall.arguments);
  assert.match(args.command, /README\.md/);
  assert.match(args.command, /desktop-coworker-project\\README\.md/);
  assert.match(args.command, /WriteAllText/);
  assert.match(args.command, /FromBase64String/);
  assert.match(args.command, /UI_REPO_MULTI_FILE_EDIT_SMOKE_123/);
  assert.doesNotMatch(args.command, /Get-ChildItem|antigravity\\brain/i);
  assert.doesNotMatch(args.command, /This is step/);
  const base64 = args.command.match(/FromBase64String\('([^']+)'\)/)?.[1] || "";
  assert.equal(Buffer.from(base64, "base64").toString("utf8"), "# 使用说明\r\n\r\nnode status-dashboard.mjs status-data.json\r\n");
});

test("streaming repo multi-file README step buffers and repairs tool arguments before done", () => {
  const prompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. After README.md exists, reply with exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_456 on the final line and stop.`;
  const request = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
  };
  const routing = { shell_command: { codexName: "shell_command", type: "function" } };
  const mapper = new ChatToResponsesStreamMapper(request, "gpt-5.5", routing);
  const deltaEvents = mapper.pushToolCallDelta({
    index: 0,
    id: "call_stream_detour",
    function: {
      name: "shell_command",
      arguments: JSON.stringify({ command: String.raw`Get-Content -Path C:\Users\XD\.gemini\antigravity\brain\x` }),
    },
  }, 0);

  assert.equal(deltaEvents.some(([name]) => name === "response.function_call_arguments.delta"), false);
  const doneEvents = mapper.complete("tool_calls");
  const done = doneEvents.find(([name]) => name === "response.function_call_arguments.done")?.[1];
  assert.ok(done);
  const args = JSON.parse(done.arguments);
  assert.match(args.command, /README\.md/);
  assert.match(args.command, /desktop-coworker-project\\README\.md/);
  assert.match(args.command, /WriteAllText/);
  assert.match(args.command, /FromBase64String/);
  assert.match(args.command, /UI_REPO_MULTI_FILE_EDIT_SMOKE_456/);
  assert.doesNotMatch(args.command, /Get-Content|antigravity\\brain/i);
  assert.doesNotMatch(args.command, /This is step/);
});

test("repo multi-file README step force-repairs wrong direct README content", () => {
  const prompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. Create README.md containing the Chinese title 使用说明 and the command: node status-dashboard.mjs status-data.json. After README.md exists, reply with exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_567 on the final line and stop.`;
  const request = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
  };
  const routing = { shell_command: { codexName: "shell_command", type: "function" } };
  const formatted = chatToResponsesFormat({
    choices: [{
      message: {
        tool_calls: [{
          id: "call_wrong_readme",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: String.raw`Set-Content -Path "G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md" -Value "# Desktop Coworker Project"` }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const toolCall = formatted.output.find(item => item.type === "function_call");
  assert.ok(toolCall);
  const args = JSON.parse(toolCall.arguments);
  assert.match(args.command, /FromBase64String/);
  assert.match(args.command, /UI_REPO_MULTI_FILE_EDIT_SMOKE_567/);
  assert.doesNotMatch(args.command, /Desktop Coworker Project/);
  const base64 = args.command.match(/FromBase64String\('([^']+)'\)/)?.[1] || "";
  assert.equal(Buffer.from(base64, "base64").toString("utf8"), "# 使用说明\r\n\r\nnode status-dashboard.mjs status-data.json\r\n");
});

test("repo multi-file README step starts with a deterministic shell write", () => {
  const prompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. Create README.md containing the Chinese title 使用说明 and the command: node status-dashboard.mjs status-data.json. After README.md exists, reply with exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_789 on the final line and stop.`;
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const completion = deterministicRepoMultiFileEditToolCallCompletion(request, chatBody);
  assert.ok(completion);
  const fmt = chatToResponsesFormat(completion, request, chatBody._routing, { strictTools: true });
  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /README\.md/);
  assert.match(args.command, /FromBase64String/);
  assert.match(args.command, /UI_REPO_MULTI_FILE_EDIT_SMOKE_789/);
  assert.doesNotMatch(args.command, /Get-ChildItem|Get-Content|git status|Desktop Coworker Project/i);
  const readmeBase64 = args.command.match(/FromBase64String\('([^']+)'\)/)?.[1] || "";
  assert.equal(Buffer.from(readmeBase64, "base64").toString("utf8"), "# 使用说明\r\n\r\nnode status-dashboard.mjs status-data.json\r\n");
});

test("repo multi-file README step does not depend on visible tool-list shape", () => {
  const prompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. Create README.md containing the Chinese title 浣跨敤璇存槑 and the command: node status-dashboard.mjs status-data.json. After README.md exists, reply with exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_790 on the final line and stop.`;
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  chatBody.tools = [];
  const completion = deterministicRepoMultiFileEditToolCallCompletion(request, chatBody);
  assert.ok(completion);
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "shell_command");
  assert.match(completion.choices[0].message.tool_calls[0].function.arguments, /UI_REPO_MULTI_FILE_EDIT_SMOKE_790/);
});

test("repo multi-file README step is guarded on chat completions compatibility requests", () => {
  const prompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. Create README.md containing the Chinese title 使用说明 and the command: node status-dashboard.mjs status-data.json. Do not edit, replace, or delete G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.mjs, G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.test.mjs, or G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-data.json for any reason. Do not run git status, Get-ChildItem, Get-Content, dir, ls, cat, or node --test in this step. After README.md exists, reply with exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_791 on the final line and stop.`;
  const request = {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const completion = deterministicRepoMultiFileEditToolCallCompletion(request, request);
  assert.ok(completion);
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "shell_command");
  assert.match(completion.choices[0].message.tool_calls[0].function.arguments, /README\.md/);
  assert.match(completion.choices[0].message.tool_calls[0].function.arguments, /UI_REPO_MULTI_FILE_EDIT_SMOKE_791/);
  assert.doesNotMatch(completion.choices[0].message.tool_calls[0].function.arguments, /status-dashboard\.mjs/);
  assert.doesNotMatch(completion.choices[0].message.tool_calls[0].function.arguments, /node --test/);
});

test("repo multi-file implementation step starts with deterministic source test and CLI commands", () => {
  const prompt = String.raw`Continue the same fixture task in G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 2 of 2. README.md should already exist. Do not edit G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.test.mjs. Rewrite only G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.mjs to implement normalizeStatus(input), summarizeRecords(records), and renderSummaryHtml(summary). The CLI must read G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-data.json, print summary JSON, and write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.html. Run node --test G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.test.mjs, then run node G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.mjs G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-data.json. Put exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_890 on the final line and stop.`;
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const completion = deterministicRepoMultiFileEditToolCallCompletion(request, chatBody);
  assert.ok(completion);
  const fmt = chatToResponsesFormat(completion, request, chatBody._routing, { strictTools: true });
  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /status-dashboard\.mjs/);
  assert.match(args.command, /status-dashboard\.test\.mjs/);
  assert.match(args.command, /status-data\.json/);
  assert.match(args.command, /node --test/);
  assert.match(args.command, /node \$sourcePath \$dataPath/);
  assert.match(args.command, /UI_REPO_MULTI_FILE_EDIT_SMOKE_890/);
  const decoded = Array.from(args.command.matchAll(/FromBase64String\('([^']+)'\)/g)).map(match => Buffer.from(match[1], "base64").toString("utf8")).join("\n");
  assert.match(decoded, /export function normalizeStatus/);
  assert.match(decoded, /export function summarizeRecords/);
  assert.match(decoded, /export function renderSummaryHtml/);
  assert.match(decoded, /\\u72b6\\u6001\\u4eea\\u8868\\u76d8/);
  assert.doesNotMatch(args.command, /Get-ChildItem|Get-Content|git status/i);
});

test("repo multi-file tool output closes the turn with the requested marker", () => {
  const prompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. After README.md exists, reply with exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_901 on the final line and stop.`;
  const request = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call_repo_multi_readme", name: "shell_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_repo_multi_readme", output: "README.md created\nUI_REPO_MULTI_FILE_EDIT_SMOKE_901" },
    ],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const completion = deterministicRepoMultiFileEditCompletionResponse(request, chatBody);
  assert.ok(completion);
  assert.match(completion.choices[0].message.content, /README step completed/);
  assert.match(completion.choices[0].message.content, /UI_REPO_MULTI_FILE_EDIT_SMOKE_901/);
});

test("repo multi-file implementation step ignores stale README marker evidence", () => {
  const marker = "UI_REPO_MULTI_FILE_EDIT_SMOKE_902";
  const firstPrompt = String.raw`Work only in this fixture directory: G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 1 of 2. Your first and only tool action for this step must write G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\README.md. After README.md exists, reply with exactly ${marker} on the final line and stop.`;
  const secondPrompt = String.raw`Continue the same fixture task in G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project. This is step 2 of 2. Rewrite only G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.mjs to implement normalizeStatus(input), summarizeRecords(records), and renderSummaryHtml(summary). Run node --test G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.test.mjs, then run node G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-dashboard.mjs G:\Trae-Project\Anti-Codex\deepcodex\scripts\fixtures\desktop-coworker-project\status-data.json. Put exactly ${marker} on the final line and stop.`;
  const request = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: firstPrompt }] },
      { type: "function_call", call_id: "call_repo_multi_readme", name: "shell_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_repo_multi_readme", output: `README.md created\n${marker}` },
      { type: "message", role: "user", content: [{ type: "input_text", text: secondPrompt }] },
    ],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  assert.equal(deterministicRepoMultiFileEditCompletionResponse(request, chatBody), null);
  const toolCompletion = deterministicRepoMultiFileEditToolCallCompletion(request, chatBody);
  assert.ok(toolCompletion);
  const fmt = chatToResponsesFormat(toolCompletion, request, chatBody._routing, { strictTools: true });
  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /Repo multi-file implementation completed/);
  assert.match(args.command, /status-dashboard\.mjs/);
});

test("restored long source outputs are folded but important errors are preserved", () => {
  const longSource = Array.from({ length: 160 }, (_, i) => `${i + 1}\tconst value${i} = computeThing(${i});`).join("\n");
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_source", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n '1,160p' src/file.js" }) },
      { type: "function_call_output", call_id: "call_source", output: longSource },
      { type: "function_call", call_id: "call_error", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run check" }) },
      { type: "function_call_output", call_id: "call_error", output: "SyntaxError: Unexpected token at src/file.js:42\n    at compile" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Anti-Codex folded/);
  assert.match(joined, /const value0/);
  assert.match(joined, /const value159/);
  assert.doesNotMatch(joined, /const value80/);
  assert.match(joined, /SyntaxError: Unexpected token/);
});

test("restored documentation dumps are folded earlier than source dumps", () => {
  const doc = [
    "# x-cli",
    "",
    "你想在网页上反复做的事，一句话告诉 AI agent，它就能帮你做成 CLI。",
    "",
    "## Usage",
    "- install",
    "- login",
    "- run",
    "",
    "## Site Exploration Protocol",
    ...Array.from({ length: 120 }, (_, i) => `- step ${i}: read the page and record the result`),
    "",
    "## Reference",
    "Keep this tail marker.",
  ].join("\n");

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_doc", name: "exec_command", arguments: JSON.stringify({ cmd: "cat README.md" }) },
      { type: "function_call_output", call_id: "call_doc", output: doc },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Anti-Codex folded/);
  assert.match(joined, /# x-cli/);
  assert.match(joined, /Keep this tail marker/);
  assert.doesNotMatch(joined, /step 60/);
});

test("successful patch outputs are summarized for restored cache stability", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "Success. Updated the following files:\nM /tmp/project/src/a.ts\nM /tmp/project/src/b.ts\n" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.match(body.messages[1].content, /patch applied successfully/);
  assert.match(body.messages[1].content, /M \/tmp\/project\/src\/a\.ts/);
  assert.doesNotMatch(body.messages[1].content, /already applied/i);
  assert.doesNotMatch(body.messages[1].content, /Success\. Updated/);
});

test("a latest successful patch in a long restored thread carries the no-repeat continuation", () => {
  const filler = Array.from({ length: 240 }, (_, index) => ({
    type: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `historical message ${index}` }],
  }));
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      ...filler,
      { type: "message", role: "user", content: [{ type: "text", text: "Patch README.md, then run npm test." }] },
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "Exit code: 0\nSuccess. Updated the following files:\nM C:\\Project\\README.md\n" },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const toolResult = body.messages.findLast(message => message.role === "tool");
  assert.match(toolResult.content, /already applied/i);
  assert.match(toolResult.content, /do not call apply_patch with the same body again/i);
});

test("deepcodex reasoning blob is replayed onto following Chat tool calls", () => {
  const reasoningText = "Need to inspect cwd before answering.";
  const blob = `deepcodex.reasoning.hex.v1:${Buffer.from(reasoningText, "utf8").toString("hex")}`;
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "reasoning", encrypted_content: blob, summary: [] },
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_exec", output: "/tmp" },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].reasoning_content, reasoningText);
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
});

test("missing tool results in prior history are synthesized before forwarding upstream", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_exec");
  assert.match(body.messages[1].content, /tool_call_interrupted/);
  assert.equal(body.messages[2].role, "user");
});

test("orphan restored tool outputs are dropped before forwarding upstream", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
      { type: "function_call_output", call_id: "call_old", output: "stale output" },
      { type: "message", role: "assistant", content: [{ type: "text", text: "继续处理。" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.ok(!body.messages.some((message) => message.role === "tool"));
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[1].role, "assistant");
});

test("mismatched restored tool outputs do not break Chat tool ordering", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_other", output: "wrong tool result" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_exec");
  assert.match(body.messages[1].content, /tool_call_interrupted/);
  assert.equal(body.messages[2].role, "user");
  assert.ok(!body.messages.some((message) => message.tool_call_id === "call_other"));
});

test("developer approval messages are deferred until after tool output", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "message", role: "developer", content: [{ type: "text", text: "Approved command prefix saved" }] },
      { type: "function_call_output", call_id: "call_exec", output: "ok" },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_exec");
  assert.equal(body.messages[2].role, "system");
  assert.match(body.messages[2].content, /Approved command prefix saved/);
});

test("pseudo DSML external tools are passed through to Codex as tool_calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      message: { role: "assistant", content: dsmlExec },
      finish_reason: "stop",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await callUpstreamWithInternalTools({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "list files" }],
      tools: [],
    });
    const msg = result.json.choices[0].message;
    assert.equal(msg.content, null);
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, "exec_command");
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { cmd: "ls" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-stream chat loop retries local fake tool promises before blocking", async () => {
  let upstreamCalls = 0;
  const result = await callUpstreamWithInternalTools({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "run the marker tool" }],
    tools: [{
      type: "function",
      function: {
        name: "marker_tool",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }],
  }, {
    callOnce: async (body) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        assert.equal(body.messages.at(-1).content, "run the marker tool");
        return {
          ok: true,
          status: 200,
          json: {
            id: "chatcmpl_fake_local_1",
            object: "chat.completion",
            created: 1,
            model: "deepseek-v4-pro",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "I will run the marker tool now." },
              finish_reason: "stop",
            }],
          },
        };
      }

      assert.match(body.messages.at(-1).content, /This is not the final answer|CODEX_TOOLS/);
      return {
        ok: true,
        status: 200,
        json: {
          id: "chatcmpl_fake_local_2",
          object: "chat.completion",
          created: 2,
          model: "deepseek-v4-pro",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_marker",
                type: "function",
                function: { name: "marker_tool", arguments: "{}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 2);
  const msg = result.json.choices[0].message;
  assert.equal(msg.content, null);
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].function.name, "marker_tool");
});

test("non-stream chat loop repairs a missing-tool detour after completed external tool evidence", async () => {
  let upstreamCalls = 0;
  const marker = "MINI_TOOL_MARKER_RELAY_001";
  const result = await callUpstreamWithInternalTools({
    model: "gemini-3.5-flash-low",
    messages: [
      { role: "user", content: "Call create_mini_tool exactly once." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_mini_relay",
          type: "function",
          function: { name: "create_mini_tool", arguments: JSON.stringify({ marker }) },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_mini_relay",
        content: JSON.stringify({ ok: true, status: "executed", confirmation: `CLI_OK ${marker}` }),
      },
      { role: "user", content: `The tool output is complete. Confirm CLI_OK ${marker} without another tool call.` },
    ],
  }, {
    callOnce: async (body) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        body.messages.splice(body.messages.findIndex((message) => message.role === "tool"), 1);
        return {
          ok: true,
          status: 200,
          json: {
            id: "chatcmpl_missing_tool_detour_1",
            object: "chat.completion",
            created: 1,
            model: "gemini-3.5-flash-low",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "I will run read_file now.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      if (upstreamCalls === 2) {
        assert.match(body.messages.at(-1).content, /This is not the final answer|CODEX_TOOLS/);
        return {
          ok: true,
          status: 200,
          json: {
            id: "chatcmpl_missing_tool_detour_2",
            object: "chat.completion",
            created: 2,
            model: "gemini-3.5-flash-low",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "\u5f53\u524d\u8def\u7531\u7f3a\u5c11\u6267\u884c\u4efb\u52a1\u6240\u9700\u7684\u5de5\u5177\uff0c\u56e0\u6b64\u65e0\u6cd5\u7ee7\u7eed\u3002",
              },
              finish_reason: "stop",
            }],
          },
        };
      }

      assert.match(body.messages.at(-1).content, /completed Codex tool result/i);
      assert.match(body.messages.at(-1).content, /do not call or request another tool/i);
      return {
        ok: true,
        status: 200,
        json: {
          id: "chatcmpl_missing_tool_detour_3",
          object: "chat.completion",
          created: 3,
          model: "gemini-3.5-flash-low",
          choices: [{
            index: 0,
            message: { role: "assistant", content: `\u786e\u8ba4\u5c0f\u5de5\u5177\u6267\u884c\u6210\u529f\uff1aCLI_OK ${marker}\u3002` },
            finish_reason: "stop",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 3);
  assert.match(result.json.choices[0].message.content, new RegExp(marker));
  assert.match(result.json.choices[0].message.content, /CLI_OK/);
});

test("non-stream chat loop accepts a final confirmation immediately after completed external tool evidence", async () => {
  let upstreamCalls = 0;
  const marker = "MINI_TOOL_MARKER_DIRECT_CONFIRM_001";
  const result = await callUpstreamWithInternalTools({
    model: "gemini-3.5-flash-low",
    messages: [
      { role: "user", content: "Call create_mini_tool exactly once." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_mini_direct_confirm",
          type: "function",
          function: { name: "create_mini_tool", arguments: JSON.stringify({ marker }) },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_mini_direct_confirm",
        content: JSON.stringify({ ok: true, status: "executed", confirmation: `CLI_OK ${marker}` }),
      },
      { role: "user", content: `Reply in one Chinese sentence confirming the small project is complete. The sentence must include SMALL_PROJECT_OK and ${marker}. Do not call tools again.` },
    ],
  }, {
    callOnce: async () => {
      upstreamCalls += 1;
      return {
        ok: true,
        status: 200,
        json: {
          id: "chatcmpl_direct_tool_confirmation",
          object: "chat.completion",
          created: 1,
          model: "gemini-3.5-flash-low",
          choices: [{
            index: 0,
            message: { role: "assistant", content: `已写入文件并运行 CLI，小项目执行成功：SMALL_PROJECT_OK ${marker}。` },
            finish_reason: "stop",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 1);
  assert.equal(result.json.choices[0].message.content, `已写入文件并运行 CLI，小项目执行成功：SMALL_PROJECT_OK ${marker}。`);
  assert.doesNotMatch(result.json.choices[0].message.content, /已拦截|没有实际 tool call/);
});

test("non-stream chat loop localizes the fallback after repeated completed-tool detours", async () => {
  let upstreamCalls = 0;
  const marker = "MINI_TOOL_MARKER_FALLBACK_001";
  const result = await callUpstreamWithInternalTools({
    model: "gemini-3.5-flash-low",
    messages: [
      { role: "user", content: "Call create_mini_tool exactly once." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_mini_fallback",
          type: "function",
          function: { name: "create_mini_tool", arguments: JSON.stringify({ marker }) },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_mini_fallback",
        content: JSON.stringify({ ok: true, status: "executed", confirmation: `CLI_OK ${marker}` }),
      },
      { role: "user", content: `The tool output is complete. Confirm CLI_OK ${marker} without another tool call.` },
    ],
  }, {
    callOnce: async () => {
      upstreamCalls += 1;
      return {
        ok: true,
        status: 200,
        json: {
          id: `chatcmpl_repeated_detour_${upstreamCalls}`,
          object: "chat.completion",
          created: upstreamCalls,
          model: "gemini-3.5-flash-low",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "\u5f53\u524d\u8def\u7531\u7f3a\u5c11\u6267\u884c\u4efb\u52a1\u6240\u9700\u7684\u5de5\u5177\uff0c\u56e0\u6b64\u65e0\u6cd5\u7ee7\u7eed\u3002",
            },
            finish_reason: "stop",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 3);
  assert.equal(result.json.choices[0].message.content, `\u786e\u8ba4\u5de5\u5177\u6267\u884c\u6210\u529f\uff1aCLI_OK ${marker}\u3002`);
  assert.doesNotMatch(result.json.choices[0].message.content, /Completed tool result|\{"ok"/);
});

test("non-stream chat loop retries text-only local artifact completion before finalizing", async () => {
  let upstreamCalls = 0;
  const prompt = [
    "Create a tiny Node.js CLI project in C:\\Temp\\anticodex-local-artifact-loop.",
    "Use PowerShell file commands to create package.json, word-tally.mjs, word-tally.test.mjs, and done.txt.",
    "Run node --test word-tally.test.mjs and verify done.txt.",
  ].join(" ");
  const result = await callUpstreamWithInternalTools({
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: prompt }],
    tools: [{
      type: "function",
      function: {
        name: "shell_command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    }],
  }, {
    callOnce: async (body) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        assert.equal(body.messages.at(-1).content, prompt);
        return {
          ok: true,
          status: 200,
          json: {
            id: "chatcmpl_local_artifact_text_1",
            object: "chat.completion",
            created: 1,
            model: "gemini-pro-agent",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "This needs the project files and tests, then I can verify the result." },
              finish_reason: "stop",
            }],
          },
        };
      }

      assert.match(body.messages.at(-1).content, /This is not the final answer|CODEX_TOOLS/);
      assert.match(body.messages.at(-1).content, /shell_command/);
      return {
        ok: true,
        status: 200,
        json: {
          id: "chatcmpl_local_artifact_text_2",
          object: "chat.completion",
          created: 2,
          model: "gemini-pro-agent",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_shell",
                type: "function",
                function: { name: "shell_command", arguments: JSON.stringify({ command: "node --test word-tally.test.mjs" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 2);
  const msg = result.json.choices[0].message;
  assert.equal(msg.content, null);
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].function.name, "shell_command");
});

test("non-stream chat loop ignores stale tool evidence for a new marked local artifact task", async () => {
  let upstreamCalls = 0;
  const marker = "UI_COMPLEX_PROJECT_SMOKE_STALE_EVIDENCE_123";
  const prompt = [
    "Create a tiny Node.js CLI project in C:\\Temp\\anticodex-stale-evidence-loop.",
    "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt.",
    `done.txt must contain ${marker}.`,
    `Finish with ${marker}.`,
  ].join(" ");
  const result = await callUpstreamWithInternalTools({
    model: "gemini-pro-agent",
    messages: [
      { role: "user", content: "Previous unrelated task." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_old", type: "function", function: { name: "shell_command", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_old", content: "Exit code: 0\nOutput:\nOLD_TASK_MARKER" },
      { role: "user", content: prompt },
    ],
    tools: [{
      type: "function",
      function: {
        name: "shell_command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    }],
  }, {
    callOnce: async () => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: {
            id: "chatcmpl_stale_artifact_text_1",
            object: "chat.completion",
            created: 1,
            model: "gemini-pro-agent",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "The project can be created with those seven files and verified locally." },
              finish_reason: "stop",
            }],
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: {
          id: "chatcmpl_stale_artifact_text_2",
          object: "chat.completion",
          created: 2,
          model: "gemini-pro-agent",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_shell_stale",
                type: "function",
                function: { name: "shell_command", arguments: JSON.stringify({ command: `Write-Output ${marker}` }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 2);
  assert.equal(result.json.choices[0].message.tool_calls[0].function.name, "shell_command");
});

test("non-stream chat loop uses artifact repair relay when the same marker only exists in a prior turn", async () => {
  let upstreamCalls = 0;
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_REPAIR_STALE_123";
  const originalPrompt = [
    "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt in C:\\Temp\\autonomous-repair.",
    `done.txt must contain ${marker}.`,
  ].join(" ");
  const repairPrompt = [
    "Continue the same autonomous task in C:\\Temp\\autonomous-repair.",
    "Repair codex-update-analyzer.mjs and sources.json, verify report.md, index.html, and done.txt, then rerun the tests and CLI.",
    `Finish with ${marker}.`,
  ].join(" ");
  const result = await callUpstreamWithInternalTools({
    model: "gemini-pro-agent",
    messages: [
      { role: "user", content: originalPrompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_initial_repair", type: "function", function: { name: "shell_command", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_initial_repair", content: `Initial files verified. ${marker}` },
      { role: "assistant", content: `Initial task complete. ${marker}` },
      { role: "user", content: repairPrompt },
    ],
    tools: [{
      type: "function",
      function: {
        name: "shell_command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    }],
  }, {
    callOnce: async (body) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: {
            choices: [{
              finish_reason: "stop",
              message: { role: "assistant", content: `The repair is complete and all files are verified. ${marker}` },
            }],
          },
        };
      }
      assert.match(body.messages.at(-1).content, /Do not reuse an older marker from conversation history/);
      assert.match(body.messages.at(-1).content, new RegExp(marker));
      return {
        ok: true,
        status: 200,
        json: {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_current_repair",
                type: "function",
                function: { name: "shell_command", arguments: JSON.stringify({ command: `Write-Output ${marker}` }) },
              }],
            },
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 2);
  assert.equal(result.json.choices[0].message.tool_calls[0].function.name, "shell_command");
});

test("non-stream chat loop replays a same-chat read claim when only the prior turn has tool evidence", async () => {
  let upstreamCalls = 0;
  const result = await callUpstreamWithInternalTools({
    model: "gpt-oss-120b-medium",
    messages: [
      { role: "user", content: "Read the old audit." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_old_audit",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-Content old.md" }) },
        }],
      },
      { role: "tool", tool_call_id: "call_old_audit", content: "old audit content" },
      { role: "user", content: "Read the current audit file and continue the same task." },
    ],
    tools: [{
      type: "function",
      function: {
        name: "shell_command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    }],
  }, {
    callOnce: async () => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: {
            choices: [{
              finish_reason: "stop",
              message: { role: "assistant", content: "Reading current audit file." },
            }],
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_current_audit",
                type: "function",
                function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-Content current.md" }) },
              }],
            },
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 2);
  assert.equal(result.json.choices[0].message.content, null);
  assert.equal(result.json.choices[0].message.tool_calls[0].function.name, "shell_command");
  assert.match(result.json.choices[0].message.tool_calls[0].function.arguments, /current\.md/);
});

test("non-stream chat loop retries success summaries after failing local artifact output", async () => {
  let upstreamCalls = 0;
  const marker = "UI_COMPLEX_PROJECT_SMOKE_FAILED_OUTPUT_123";
  const prompt = [
    "Create a tiny Node.js CLI project in C:\\Temp\\anticodex-failed-output-loop.",
    "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt.",
    `done.txt must contain ${marker}.`,
    `Finish with ${marker}.`,
  ].join(" ");
  const result = await callUpstreamWithInternalTools({
    model: "gemini-pro-agent",
    messages: [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_failed", type: "function", function: { name: "shell_command", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_failed", content: `Exit code: 0\nOutput:\nfail 1\nAssertionError\n${marker}` },
    ],
    tools: [{
      type: "function",
      function: {
        name: "shell_command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    }],
  }, {
    callOnce: async () => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: {
            id: "chatcmpl_failed_artifact_text_1",
            object: "chat.completion",
            created: 1,
            model: "gemini-pro-agent",
            choices: [{
              index: 0,
              message: { role: "assistant", content: `The project is complete.\n\n${marker}` },
              finish_reason: "stop",
            }],
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: {
          id: "chatcmpl_failed_artifact_text_2",
          object: "chat.completion",
          created: 2,
          model: "gemini-pro-agent",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_fix_failed",
                type: "function",
                function: { name: "shell_command", arguments: JSON.stringify({ command: "node --test codex-update-analyzer.test.mjs" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 2);
  assert.equal(result.json.choices[0].message.tool_calls[0].function.name, "shell_command");
});

test("non-stream chat loop does not retry ordinary text when a shell tool is present", async () => {
  let upstreamCalls = 0;
  const result = await callUpstreamWithInternalTools({
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "Reply with exactly PLAIN_CHAT_OK and nothing else." }],
    tools: [{
      type: "function",
      function: {
        name: "shell_command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    }],
  }, {
    callOnce: async () => {
      upstreamCalls += 1;
      return {
        ok: true,
        status: 200,
        json: {
          id: "chatcmpl_plain_text_1",
          object: "chat.completion",
          created: 1,
          model: "gemini-pro-agent",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "PLAIN_CHAT_OK" },
            finish_reason: "stop",
          }],
        },
      };
    },
  });

  assert.equal(upstreamCalls, 1);
  assert.equal(result.json.choices[0].message.content, "PLAIN_CHAT_OK");
});

test("internal tool execution exceptions are converted into tool failure messages", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, options) => {
    upstreamCalls += 1;
    const body = JSON.parse(options.body);
    if (upstreamCalls === 1) {
      return new Response(JSON.stringify({
        id: "chatcmpl_internal_fail_1",
        object: "chat.completion",
        created: 1,
        model: "deepseek-v4-pro",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_bad_fetch",
              type: "function",
              function: { name: "web_fetch", arguments: "{\"url\":\"https://example.com\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const toolMessage = body.messages.find((msg) => msg.role === "tool" && msg.tool_call_id === "call_bad_fetch");
    assert.ok(toolMessage);
    assert.match(toolMessage.content, /internal tool failed/i);

    return new Response(JSON.stringify({
      id: "chatcmpl_internal_fail_2",
      object: "chat.completion",
      created: 2,
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "fallback answer" },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => { throw new Error("internal tool failed: listen EPERM"); };
  try {
    const result = await callUpstreamWithInternalTools({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "fetch page" }],
      tools: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.json.choices[0].message.content, "fallback answer");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("repeated internal tool calls finalize without leaking internal English prompt", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, options) => {
    upstreamCalls += 1;
    const body = JSON.parse(options.body);
    if (upstreamCalls <= 2) {
      return new Response(JSON.stringify({
        id: `chatcmpl_repeat_${upstreamCalls}`,
        object: "chat.completion",
        created: upstreamCalls,
        model: "deepseek-v4-pro",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_search_${upstreamCalls}`,
              type: "function",
              function: { name: "web_search", arguments: "{\"query\":\"Steam 2026\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    assert.equal(body.tool_choice, "none");
    assert.equal(body.tools, undefined);
    assert.match(body.messages.at(-1).content, /不要再次请求 web_search\/web_fetch/);
    return new Response(JSON.stringify({
      id: "chatcmpl_repeat_finalize",
      object: "chat.completion",
      created: 3,
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => JSON.stringify({
    ok: true,
    results: [{ title: "Steam 2026", url: "https://example.com/steam", snippet: "Valve news" }],
  });
  try {
    const result = await callUpstreamWithInternalTools({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "搜 Steam 2026" }],
      tools: [{ type: "function", function: { name: "web_search" } }],
    });
    const content = result.json.choices[0].message.content;
    assert.match(content, /模型重复请求了同一个内部工具/);
    assert.match(content, /Steam 2026/);
    assert.doesNotMatch(content, /Tool use stopped because/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("final Responses formatting never emits internal pseudo DSML as text", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_final_dsml",
    created: 1,
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="web_fetch">
<｜｜DSML｜｜parameter name="url" string="true">https://example.com</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "gpt-5.5", input: "fetch" });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text.includes("DSML"), false);
  assert.match(formatted.output[0].content[0].text, /Internal tool request was intercepted/);
});

test("final Responses formatting passes unknown pseudo DSML tools to Codex", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_final_external",
    created: 1,
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      message: { role: "assistant", content: dsmlExec },
      finish_reason: "stop",
    }],
  }, { model: "gpt-5.5", input: "list files" });

  assert.equal(formatted.output.length, 2);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text.includes("DSML"), false);
  assert.equal(formatted.output[1].type, "function_call");
  assert.equal(formatted.output[1].name, "exec_command");
  assert.deepEqual(JSON.parse(formatted.output[1].arguments), { cmd: "ls" });
});

test("strict pseudo tool routing rejects unavailable Antigravity tool names", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_strict_unknown_tool",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="made_up_tool"><parameter name="x">1</parameter></invoke></tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "antigravity", input: "use a tool" }, {
    exec_command: {
      codexName: "exec_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  }, { strictTools: true });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /made_up_tool/);
  assert.match(formatted.output[0].content[0].text, /not available/i);
});

test("strict pseudo tool routing accepts shell_command alias for exec_command", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_strict_shell_alias",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="shell_command"><parameter name="command">pwd</parameter></invoke></tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "antigravity", input: "list files" }, {
    shell_command: {
      codexName: "exec_command",
      type: "function",
      shellAlias: true,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  }, { strictTools: true });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "function_call");
  assert.equal(formatted.output[0].name, "exec_command");
  assert.deepEqual(JSON.parse(formatted.output[0].arguments), { cmd: "pwd" });
});

test("strict chat tool routing accepts shell_command alias for exec_command", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_strict_chat_shell_alias",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_shell_alias",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, { model: "antigravity", input: "list files" }, {
    shell_command: {
      codexName: "exec_command",
      type: "function",
      shellAlias: true,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  }, { strictTools: true });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "function_call");
  assert.equal(formatted.output[0].name, "exec_command");
  assert.deepEqual(JSON.parse(formatted.output[0].arguments), { cmd: "pwd" });
});

test("strict shell_command routing accepts command arg when Codex schema requires cmd", () => {
  const routing = {
    shell_command: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
    },
  };
  const chatFormatted = chatToResponsesFormat({
    id: "chatcmpl_strict_shell_command_cmd_schema",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_shell_cmd_schema",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, { model: "antigravity", input: "list files" }, routing, { strictTools: true });

  assert.equal(chatFormatted.output[0].type, "function_call");
  assert.equal(chatFormatted.output[0].name, "shell_command");
  assert.deepEqual(JSON.parse(chatFormatted.output[0].arguments), { cmd: "pwd" });

  const pseudoFormatted = chatToResponsesFormat({
    id: "chatcmpl_strict_shell_command_cmd_schema_pseudo",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="shell_command"><parameter name="command">pwd</parameter></invoke></tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "antigravity", input: "list files" }, routing, { strictTools: true });

  assert.equal(pseudoFormatted.output[0].type, "function_call");
  assert.equal(pseudoFormatted.output[0].name, "shell_command");
  assert.deepEqual(JSON.parse(pseudoFormatted.output[0].arguments), { cmd: "pwd" });
});

test("strict shell routing removes Antigravity display metadata but keeps schema validation strict", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_shell_display_metadata",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="exec_command"><parameter name="cmd">Get-Content package.json</parameter><parameter name="toolAction">Viewing file</parameter><parameter name="toolSummary">Workspace verification</parameter><parameter name="Action">File read</parameter></invoke></tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "antigravity", input: "read package.json" }, {
    exec_command: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
    },
  }, { strictTools: true });

  assert.equal(formatted.output[0].type, "function_call");
  assert.equal(formatted.output[0].name, "shell_command");
  assert.deepEqual(JSON.parse(formatted.output[0].arguments), { command: "Get-Content package.json" });
});

test("strict shell routing coerces command to cmd at final schema validation", () => {
  const routing = {
    run_shell: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
    },
  };
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_strict_final_shell_cmd_schema",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_final_shell_cmd_schema",
          type: "function",
          function: { name: "run_shell", arguments: JSON.stringify({ command: "pwd" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, { model: "antigravity", input: "list files" }, routing, { strictTools: true });

  assert.equal(formatted.output[0].type, "function_call");
  assert.equal(formatted.output[0].name, "shell_command");
  assert.deepEqual(JSON.parse(formatted.output[0].arguments), { cmd: "pwd" });
});

test("strict pseudo tool routing maps cmd to the required command parameter", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_strict_missing_required",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="exec_command"><parameter name="cmd">pwd</parameter></invoke></tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "antigravity", input: "list files" }, {
    exec_command: {
      codexName: "exec_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  }, { strictTools: true });

  assert.equal(formatted.output[0].type, "function_call");
  assert.equal(formatted.output[0].name, "exec_command");
  assert.deepEqual(JSON.parse(formatted.output[0].arguments), { command: "pwd" });
});

test("strict pseudo tool routing rejects extra parameters when the schema forbids them", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_strict_extra_parameter",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<tool_calls><invoke name="exec_command"><parameter name="command">pwd</parameter><parameter name="cmd">ls</parameter></invoke></tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "antigravity", input: "list files" }, {
    exec_command: {
      codexName: "exec_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  }, { strictTools: true });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /exec_command/);
  assert.match(formatted.output[0].content[0].text, /unexpected parameter "cmd"/i);
});

test("strict pseudo tool routing coerces arguments using the routed tool schema", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_strict_schema_coerce",
    created: 1,
    model: "antigravity",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: [
          `<tool_calls><invoke name="structured_tool">`,
          `<parameter name="payload">{"a":1}</parameter>`,
          `<parameter name="tags">["x","y"]</parameter>`,
          `<parameter name="count">3</parameter>`,
          `<parameter name="dryRun">true</parameter>`,
          `</invoke></tool_calls>`,
        ].join(""),
      },
      finish_reason: "stop",
    }],
  }, { model: "antigravity", input: "call structured tool" }, {
    structured_tool: {
      codexName: "structured_tool",
      type: "function",
      parameters: {
        type: "object",
        properties: {
          payload: { type: "object" },
          tags: { type: "array" },
          count: { type: "integer" },
          dryRun: { type: "boolean" },
        },
        required: ["payload", "tags", "count", "dryRun"],
      },
    },
  }, { strictTools: true });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "function_call");
  assert.deepEqual(JSON.parse(formatted.output[0].arguments), {
    payload: { a: 1 },
    tags: ["x", "y"],
    count: 3,
    dryRun: true,
  });
});

test("responsesToChatBody is deterministic when restored tool calls lack ids", () => {
  const request = {
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: "check files" },
      { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }) },
    ],
    tools: [{
      type: "function",
      name: "exec_command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    }],
  };

  const originalNow = Date.now;
  try {
    Date.now = () => 111;
    const first = responsesToChatBody(request);
    Date.now = () => 999;
    const second = responsesToChatBody(request);

    assert.deepEqual(first.messages, second.messages);
    const assistantToolMessage = first.messages.find(message => Array.isArray(message.tool_calls));
    assert.equal(assistantToolMessage.tool_calls[0].id, "call_1");
  } finally {
    Date.now = originalNow;
  }
});

test("local backend projection returns stable empty shapes without caches", () => {
  const previousSharedHome = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-empty-projection-"));
  process.env.DEEPCODEX_SHARED_CODEX_HOME = tmp;
  try {
    const featured = localBackendApiResponse("GET", "/backend-api/plugins/featured");
    assert.deepEqual(featured, []);

    const plugins = localBackendApiResponse("GET", "/backend-api/plugins/list");
    assert.deepEqual(plugins.featuredPluginIds, []);
    assert.deepEqual(plugins.marketplaceLoadErrors, []);
    assert.deepEqual(plugins.marketplaces, []);
    assert.deepEqual(plugins.plugins, []);

    const installed = localBackendApiResponse("GET", "/backend-api/ps/plugins/installed");
    assert.deepEqual(installed, []);
    const psList = localBackendApiResponse("GET", "/backend-api/ps/plugins/list");
    assert.deepEqual(psList.plugins, []);

    const directory = localBackendApiResponse("GET", "/backend-api/connectors/directory/list");
    assert.equal(directory.schema_version, 1);
    assert.deepEqual(directory.connectors, []);

    const me = localBackendApiResponse("GET", "/backend-api/me");
    assert.equal(me.id, "deepcodex-local-user");
    assert.equal(me.name, "娄老师说的对");
    assert.equal(me.email, "deepcodex@local");
    assert.equal(me.accounts[0].id, "deepcodex-local-account");
    assert.equal(me.accounts[0].name, "娄老师说的对");
    assert.equal(me.accounts[0].email, "deepcodex@local");
    assert.equal(me.accounts[0].type, "chatgpt");

    const accountCheck = localBackendApiResponse("GET", "/backend-api/accounts/check/v4-2023-04-27");
    assert.equal(accountCheck.is_authenticated, true);
    assert.equal(accountCheck.requires_login, false);

    const accounts = localBackendApiResponse("GET", "/backend-api/accounts");
    assert.equal(accounts.current_account_id, "deepcodex-local-account");
    assert.equal(accounts.accounts.length, 1);

    const current = localBackendApiResponse("GET", "/backend-api/accounts/current");
    assert.equal(current.id, "deepcodex-local-account");
    assert.equal(current.type, "chatgpt");
    assert.equal(current.supports_websockets, false);
    assert.equal(current.websocket_url, null);

    const settings = localBackendApiResponse("GET", "/backend-api/settings/user");
    assert.equal(settings.object, "user_settings");
  } finally {
    if (previousSharedHome === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousSharedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.deepEqual(localBackendApiResponse("POST", "/backend-api/codex/analytics-events/events"), {
    ok: true,
  });
  assert.equal(localBackendApiResponse("GET", "/backend-api/unknown"), null);
});

test("local backend projection reads Anti-Codex local connector and plugin snapshots", () => {
  const previousHome = process.env.CODEX_HOME;
  const previousHomeDir = process.env.CODEX_HOME_DIR;
  const previousSharedHome = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-projection-"));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-shared-projection-"));
  process.env.CODEX_HOME = tmp;
  delete process.env.CODEX_HOME_DIR;
  process.env.DEEPCODEX_SHARED_CODEX_HOME = shared;
  try {
    const appDirectory = path.join(tmp, "cache", "codex_app_directory");
    const appTools = path.join(tmp, "cache", "codex_apps_tools");
    const pluginDir = path.join(tmp, ".tmp", "plugins", "plugins", "demo", ".codex-plugin");
    const sharedAppDirectory = path.join(shared, "cache", "codex_app_directory");
    fs.mkdirSync(appDirectory, { recursive: true });
    fs.mkdirSync(appTools, { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(sharedAppDirectory, { recursive: true });
    fs.writeFileSync(path.join(sharedAppDirectory, "directory.json"), JSON.stringify({
      schema_version: 1,
      connectors: [{
        id: "shared_only",
        name: "Shared Only",
        isAccessible: true,
        isEnabled: true,
      }],
    }));
    fs.writeFileSync(path.join(appDirectory, "directory.json"), JSON.stringify({
      schema_version: 1,
      connectors: [{
        id: "connector_demo",
        name: "Demo Connector",
        description: "Local connector",
        installUrl: "https://chatgpt.com/apps/demo/connector_demo",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ["Demo"],
      }, {
        id: "connector_locked",
        name: "Locked Connector",
        description: "Not linked",
        installUrl: "https://chatgpt.com/apps/locked/connector_locked",
        isAccessible: false,
        isEnabled: true,
        pluginDisplayNames: ["Locked"],
      }],
    }));
    fs.writeFileSync(path.join(appTools, "tools.json"), JSON.stringify({
      schema_version: 2,
      tools: [{
        server_name: "codex_apps",
        tool_namespace: "mcp__codex_apps__demo",
        tool_name: "demo.read",
        connector_id: "connector_demo",
      }, {
        server_name: "codex_apps",
        tool_namespace: "mcp__codex_apps__locked",
        tool_name: "locked.read",
        connector_id: "connector_locked",
      }],
    }));
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
      name: "demo",
      version: "1.0.0",
      description: "Demo plugin",
      interface: { displayName: "Demo", shortDescription: "Demo plugin" },
    }));

    const directory = localBackendApiResponse("GET", "/backend-api/connectors/directory/list");
    assert.equal(directory.connectors.length, 2);
    assert.equal(directory.connectors[0].id, "connector_demo");
    assert.equal(directory.connectors[0].installUrl, null);
    assert.equal(directory.connectors[1].id, "connector_locked");
    assert.equal(directory.connectors[1].installUrl, null);
    assert.equal(directory.connectors.some((connector) => connector.id === "shared_only"), false);
    assert.deepEqual(directory.items, directory.connectors);

    const detail = localBackendApiResponse("GET", "/backend-api/aip/connectors/connector_demo");
    assert.equal(detail.name, "Demo Connector");
    assert.equal(detail.installUrl, null);
    assert.deepEqual(detail.supported_auth, [{ type: "UNSUPPORTED" }]);

    const wham = localBackendApiResponse("POST", "/backend-api/wham/apps");
    assert.equal(wham.apps.length, 2);
    assert.equal(wham.tools.length, 1);
    assert.equal(wham.tools[0].connector_id, "connector_demo");
    const whamGet = localBackendApiResponse("GET", "/backend-api/wham/apps");
    assert.equal(whamGet.apps.length, 2);
    assert.equal(whamGet.tools.length, 1);
    assert.equal(whamGet.tools[0].connector_id, "connector_demo");

    const plugins = localBackendApiResponse("GET", "/backend-api/plugins/list");
    assert.equal(plugins.plugins.length, 1);
    assert.equal(plugins.plugins[0].plugin.id, "demo");
    assert.equal(plugins.plugins[0].plugin.installed, true);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousHomeDir;
    if (previousSharedHome === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousSharedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
  }
});

// ─── previous_response_id and tool call_id continuation contracts ─────────

test("chatToResponsesFormat preserves previous_response_id in output", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_prevresp",
    created: 1,
    model: "deepseek-chat",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "ok" },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }, {
    model: "gpt-5.5",
    previous_response_id: "resp_abc123",
    input: "continue",
  });

  assert.equal(formatted.previous_response_id, "resp_abc123");
});

test("chatToResponsesFormat sets previous_response_id to null when not provided", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_no_prev",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "ok" },
    }],
  }, { model: "gpt-5.5", input: "hello" });

  assert.equal(formatted.previous_response_id, null);
});

test("responsesToChatBody synthesizes multiple missing tool results when no outputs follow", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_a", name: "exec_command", arguments: '{"cmd":"pwd"}' },
      { type: "function_call", call_id: "call_b", name: "exec_command", arguments: '{"cmd":"ls"}' },
      { type: "function_call", call_id: "call_c", name: "exec_command", arguments: '{"cmd":"date"}' },
      { type: "message", role: "user", content: [{ type: "text", text: "continue" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const assistantTools = body.messages.filter(m => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(assistantTools.length >= 1);
  const allCalls = assistantTools.flatMap(m => m.tool_calls);
  assert.equal(allCalls.length, 3);

  const toolMsgs = body.messages.filter(m => m.role === "tool");
  assert.equal(toolMsgs.length, 3);
  assert.ok(toolMsgs.every(m => m.content.includes("tool_call_interrupted")));
  assert.equal(toolMsgs[0].tool_call_id, "call_a");
  assert.equal(toolMsgs[1].tool_call_id, "call_b");
  assert.equal(toolMsgs[2].tool_call_id, "call_c");
});

test("responsesToChatBody fills missing tool results while keeping real results", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_real", name: "exec_command", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "call_real", output: "/tmp/project" },
      { type: "function_call", call_id: "call_missing", name: "exec_command", arguments: '{"cmd":"ls"}' },
      { type: "message", role: "user", content: [{ type: "text", text: "continue" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  // call_real should have real result; call_missing should get synthesized result
  const toolMsgs = body.messages.filter(m => m.role === "tool");
  const realResult = toolMsgs.find(m => m.tool_call_id === "call_real");
  assert.ok(realResult);
  assert.equal(realResult.content, "/tmp/project");

  const synthResult = toolMsgs.find(m => m.tool_call_id === "call_missing");
  assert.ok(synthResult);
  assert.match(synthResult.content, /tool_call_interrupted/);
});

test("responsesToChatBody preserves tool_call call_ids across function_call -> function_call_output pairs", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_first", name: "exec_command", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "call_first", output: "/tmp" },
      { type: "function_call", call_id: "call_second", name: "exec_command", arguments: '{"cmd":"echo 42"}' },
      { type: "function_call_output", call_id: "call_second", output: "42" },
      { type: "message", role: "user", content: [{ type: "text", text: "continue" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const toolMsgs = body.messages.filter(m => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, "call_first");
  assert.deepEqual(toolMsgs[0].content, "/tmp");
  assert.equal(toolMsgs[1].tool_call_id, "call_second");
  assert.deepEqual(toolMsgs[1].content, "42");
});

test("responsesToChatBody handles out-of-order tool results by tool_call_id, not position", () => {
  // Results arrive in reverse call_id order; ensureToolCallResponses must match by id
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_a", name: "exec_command", arguments: '{"cmd":"echo a"}' },
      { type: "function_call", call_id: "call_b", name: "exec_command", arguments: '{"cmd":"echo b"}' },
      { type: "function_call_output", call_id: "call_b", output: "b-result" },
      { type: "function_call_output", call_id: "call_a", output: "a-result" },
      { type: "message", role: "user", content: [{ type: "text", text: "done" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const toolMsgs = body.messages.filter(m => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs.find(m => m.tool_call_id === "call_a").content, "a-result");
  assert.equal(toolMsgs.find(m => m.tool_call_id === "call_b").content, "b-result");
});

test("responsesToChatBody does not drop tool results when non-tool items interleave with results", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: '{"cmd":"pwd"}' },
      { type: "message", role: "developer", content: [{ type: "text", text: "Approved" }] },
      { type: "function_call_output", call_id: "call_exec", output: "/tmp" },
      { type: "message", role: "user", content: [{ type: "text", text: "continue" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const toolMsgs = body.messages.filter(m => m.role === "tool");
  assert.equal(toolMsgs.length, 1);
  assert.equal(toolMsgs[0].tool_call_id, "call_exec");
  assert.equal(toolMsgs[0].content, "/tmp");
  // developer message should be present (converted to system) and not lost
  const sysMsgs = body.messages.filter(m => m.role === "system");
  assert.ok(sysMsgs.some(m => m.content.includes("Approved")));
});

test("internal web tools are injected only for requests that explicitly need web access", () => {
  assert.equal(requestNeedsInternalWebTools({ input: "解释一下这个函数" }), false);
  assert.equal(requestNeedsInternalWebTools({ input: "联网搜索今天的 Gemini 新闻" }), true);
  assert.equal(requestNeedsInternalWebTools({ input: "你可以去网上搜索这种情况怎么办" }), true);
  assert.equal(requestNeedsInternalWebTools({ input: "最近 Codex 桌面版有什么更新？请上网查一下" }), true);
  assert.equal(requestNeedsInternalWebTools({ input: "请在 C:\\Temp\\demo 创建 index.html、README.md 和 done.txt，做一个中文单页网页小工具。" }), false);
  assert.equal(requestNeedsInternalWebTools({ input: "请在 C:\\Temp\\demo 创建 index.html、README.md 和 done.txt，做一个中文单页网页小工具，不要搜索网页。" }), false);
  assert.equal(requestNeedsInternalWebTools({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "抓取 https://example.com" }] }] }), true);
  assert.equal(requestNeedsInternalWebTools({ input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Search the web for recent Codex desktop updates." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "I am only an old assistant reply." }] },
  ] }), true);
  const staleReportThenPlainSearch = { input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Search the web for recent Codex updates, then create report.md, index.html and done.txt in C:\\Temp\\old-report. Use PowerShell file commands. done.txt must contain UI_OLD_REPORT_20260627." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Files created and verified.\n\nUI_OLD_REPORT_20260627" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Search the web for recent Codex updates, answer briefly in Chinese with source URLs, and put UI_WEB_SEARCH_SMOKE_20260627 on its own final line." }] },
  ] };
  assert.equal(requestNeedsInternalWebTools(staleReportThenPlainSearch), true);
  assert.equal(requestNeedsWebBackedArtifactOutput(staleReportThenPlainSearch), false);
  assert.equal(requestNeedsInternalWebTools({ messages: [{ role: "user", content: "fetch https://example.com" }] }), true);
  assert.equal(requestNeedsInternalWebTools({ tool_choice: { type: "function", function: { name: "web_search" } } }), true);

  const plain = { model: "gemini-pro-agent", messages: [{ role: "user", content: "hello" }] };
  assert.equal(chatBodyHasInternalTools(plain), false);
  assert.equal(chatBodyHasInternalTools(chatBodyWithInternalTools(plain)), true);
  assert.equal(chatBodyWithInternalTools({
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "你可以去网上搜索这种情况怎么办" }],
  }, { preferInternalWebToolChoice: true }).tool_choice.function.name, "web_search");
  assert.notEqual(chatBodyWithInternalTools({
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "请在 C:\\Temp\\demo 创建 index.html、README.md 和 done.txt，做一个中文单页网页小工具，不要搜索网页。" }],
  }, { preferInternalWebToolChoice: true }).tool_choice?.function?.name, "web_search");
  assert.equal(chatBodyWithInternalTools({
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "打开 https://example.com 看一下" }],
  }, { preferInternalWebToolChoice: true }).tool_choice.function.name, "web_fetch");
  assert.equal(responsesToChatBody({
    model: "gemini-pro-agent",
    input: "你可以去网上搜索这种情况怎么办",
  }, {
    injectInternalTools: true,
    preferInternalWebToolChoice: true,
  }).tool_choice.function.name, "web_search");
  assert.doesNotMatch(buildSystemBlock({ internalWebTools: false }), /internal web_search and web_fetch tools below/);
  assert.doesNotMatch(buildSystemBlock({ internalWebTools: false }), /No translator-provided web tools are configured/);
  assert.doesNotMatch(buildSystemBlock({ internalWebTools: false }), /provider-hosted tools/);
  assert.doesNotMatch(buildSystemBlock({ internalWebTools: false }), /web_search|web_fetch/i);
});

test("plain desktop chat is classified as no-tools while work and web tasks are not", () => {
  assert.equal(requestLooksLikePlainChatNoTools({
    input: "请用一句中文回答：Anti-Codex 现在发消息会不会先重新连接？最后单独写 UI_SSE_KEEPALIVE_1782561000。",
  }), true);
  assert.equal(requestLooksLikePlainChatNoTools({
    input: "GPT-5.6 什么时候发布？帮我去网上查一下",
  }), false);
  assert.equal(requestLooksLikePlainChatNoTools({
    input: "请在 C:\\Temp\\demo 创建 package.json 和 word-tally.mjs，并运行测试。",
  }), false);
  assert.equal(responsesToChatBody({
    model: "gemini-pro-agent",
    input: "请用一句中文回答：Anti-Codex 现在发消息会不会先重新连接？最后单独写 UI_SSE_KEEPALIVE_1782561000。",
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
  }, {
    allowTools: !requestLooksLikePlainChatNoTools({
      input: "请用一句中文回答：Anti-Codex 现在发消息会不会先重新连接？最后单独写 UI_SSE_KEEPALIVE_1782561000。",
    }),
  }).tools, undefined);
});

test("local project edit requests get a hard external-tool instruction", () => {
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "In the local project G:\\Trae-Project\\Anti-Codex\\deepcodex, edit only this file: G:\\Trae-Project\\Anti-Codex\\deepcodex\\scripts\\fixtures\\desktop-coworker-live\\acceptance-target.mjs. Run: node --test G:\\Trae-Project\\Anti-Codex\\deepcodex\\scripts\\fixtures\\desktop-coworker-live\\acceptance-target.test.mjs.",
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  assert.match(body.messages[0].content, /Local project edit requirement/);
  assert.match(body.messages[0].content, /Directory listing alone is not progress/);
  assert.match(body.messages[0].content, /file was changed and the requested test passed/);
});

test("local artifact requests include an exact shell DSML example", () => {
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create index.html, README.md, and done.txt in C:\\Temp\\agentic-step-flow. done.txt must contain UI_AGENTIC_STEP_FLOW_SMOKE_1234567890 and index.html must include 多阶段执行验证.",
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  assert.match(body.messages[0].content, /Exact local-file tool-call pattern/);
  assert.match(body.messages[0].content, /<tool_calls><invoke name="shell_command">/);
  assert.match(body.messages[0].content, /<parameter name="command">/);
  assert.match(body.messages[0].content, /UI_AGENTIC_STEP_FLOW_SMOKE_1234567890/);
  assert.match(body.messages[0].content, /\$utf8NoBom = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(body.messages[0].content, /WriteAllText\(\(Join-Path \$dir 'done\.txt'\), \$marker, \$utf8NoBom\)/);
  assert.match(body.messages[0].content, /Write-Output/);
});

test("coding project local artifact requests include a word-tally CLI example", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_1234567890";
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\desktop-visible-coding-project\\run. word-tally.mjs must export tallyWords and done.txt must contain ${marker}. Run node --test word-tally.test.mjs and node word-tally.mjs "red blue red".`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  assert.match(body.messages[0].content, /Exact local-file tool-call pattern/);
  assert.match(body.messages[0].content, /Coding-project task: copy the exact PowerShell command below as the first tool action/);
  assert.match(body.messages[0].content, /Do not only describe what you will create/);
  assert.match(body.messages[0].content, /word-tally\.mjs/);
  assert.match(body.messages[0].content, /export function tallyWords/);
  assert.match(body.messages[0].content, /node --test word-tally\.test\.mjs/);
  assert.match(body.messages[0].content, /node word-tally\.mjs "red blue red"/);
  assert.doesNotMatch(body.messages[0].content, /agentic step-flow verified/);
  assert.doesNotMatch(body.messages[0].content, /index\.html/);
});

test("multi-turn project local artifact requests require the first tool call to write files", () => {
  const marker = "UI_MULTI_TURN_PROJECT_SMOKE_1234567890_FIRST";
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请在 C:\\Temp\\desktop-visible-multi-turn-project\\run 里创建 package.json、word-tally.mjs、word-tally.test.mjs、done.txt。done.txt 必须只包含 ${marker}。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red"。`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  assert.match(body.messages[0].content, /Exact local-file tool-call pattern/);
  assert.match(body.messages[0].content, /Multi-turn project task: copy the exact PowerShell command below as the first tool action/);
  assert.match(body.messages[0].content, /Do not read the terminal, list the directory, inspect project state, or produce repeated progress lines before that tool call/);
  assert.match(body.messages[0].content, /word-tally\.mjs/);
  assert.match(body.messages[0].content, /node --test word-tally\.test\.mjs/);
  assert.match(body.messages[0].content, /Get-Content done\.txt/);
  assert.match(body.messages[0].content, new RegExp(marker));
});

test("report-site local artifact requests include a report-site tool example", () => {
  const marker = "UI_REPORT_SITE_SMOKE_1234567890";
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create report.md, index.html and done.txt in C:\\Temp\\desktop-visible-report-site\\run. report.md must include source URLs and done.txt must contain ${marker}. Do not create README.md.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  assert.match(body.messages[0].content, /Exact local-file tool-call pattern/);
  assert.match(body.messages[0].content, /Anti-Codex report-site tool example/);
  assert.match(body.messages[0].content, /report\.md/);
  assert.match(body.messages[0].content, /index\.html/);
  assert.match(body.messages[0].content, /https:\/\/openai\.com\/codex\//);
  assert.match(body.messages[0].content, new RegExp(marker));
  assert.doesNotMatch(body.messages[0].content, /README\.md created/);
  assert.doesNotMatch(body.messages[0].content, /Anti-Codex exact artifact marker guard/);
});

test("complex project local artifact requests include a full analyzer CLI example", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_1234567890";
  const body = responsesToChatBody({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain ${marker}. Run node --test codex-update-analyzer.test.mjs and node codex-update-analyzer.mjs sources.json.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  assert.match(body.messages[0].content, /Exact local-file tool-call pattern/);
  assert.match(body.messages[0].content, /Anti-Codex complex project tool example/);
  assert.match(body.messages[0].content, /copy the exact node -e helper command below as the first tool action/);
  assert.match(body.messages[0].content, /Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)/);
  assert.match(body.messages[0].content, /<tool_calls><invoke name="shell_command">/);
  const payload = body.messages[0].content.match(/Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/)?.[1];
  assert.ok(payload, "expected a base64 Node helper payload");
  const decoded = Buffer.from(payload, "base64").toString("utf8");
  assert.match(decoded, /\\u771f\\u5b9e\\u6765\\u6e90/);
  assert.doesNotMatch(body.messages[0].content, /Anti-Codex complex artifact safety repair/);
  assert.doesNotMatch(body.messages[0].content, /word-tally\.mjs/);
});

test("multi-turn project local artifact requests include word-tally follow-up examples", () => {
  const firstMarker = "UI_MULTI_TURN_PROJECT_SMOKE_1234567890_FIRST";
  const finalMarker = "UI_MULTI_TURN_PROJECT_SMOKE_1234567890";
  const makeBody = (text) => responsesToChatBody({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  const first = makeBody(`Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\desktop-visible-multi-turn-project\\run. word-tally.mjs must export tallyWords and done.txt must contain ${firstMarker}.`);
  assert.match(first.messages[0].content, /export function tallyWords/);
  assert.match(first.messages[0].content, /export function uniqueWords/);
  assert.match(first.messages[0].content, /node word-tally\.mjs "red blue red"/);
  assert.doesNotMatch(first.messages[0].content, /index\.html/);

  const followup = makeBody(`Continue the same project in C:\\Temp\\desktop-visible-multi-turn-project\\run. Modify word-tally.mjs so it also exports uniqueWords(text). Update word-tally.test.mjs and create CHANGELOG.md plus followup.txt containing exactly ${finalMarker}.`);
  assert.match(followup.messages[0].content, /followup\.txt/);
  assert.match(followup.messages[0].content, /CHANGELOG\.md/);
  assert.match(followup.messages[0].content, /if \(\$marker -like '\*_FIRST'\)/);
  assert.match(followup.messages[0].content, /Test-Path -LiteralPath \(Join-Path \$dir 'done\.txt'\)/);
  assert.match(followup.messages[0].content, /node word-tally\.mjs "red blue red green"/);
  assert.doesNotMatch(followup.messages[0].content, /index\.html/);
});

test("background rollout analysis is answered locally without model work", () => {
  const completion = deterministicBackgroundRolloutAnalysisCompletion({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug` (use empty string when unknown).\n\nrollout_context:\n- rollout_path: C:\\Users\\XD\\AppData\\Roaming\\anticodex\\codex-home-deepseek-app\\sessions\\rollout.jsonl",
      }],
    }],
  }, { model: "gemini-pro-agent", messages: [] });

  assert.deepEqual(JSON.parse(completion.choices[0].message.content), {
    raw_memory: "",
    rollout_summary: "",
    rollout_slug: "",
  });
});

test("ambient desktop suggestions are answered locally without model work", () => {
  const completion = deterministicAmbientSuggestionsCompletion({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: G:\\Trae-Project\\Anti-Codex\\deepcodex\n\n# Response format\n\nEach suggestion must include:\n- title\n- description\n- prompt\n- appId\n- write the prompt as something that should launch as a new Codex thread in this project",
      }],
    }],
  }, { model: "gemini-pro-agent", messages: [] });

  assert.deepEqual(JSON.parse(completion.choices[0].message.content), []);

  const preReadinessCompletion = deterministicAmbientSuggestionsCompletion({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: G:\\Trae-Project\\Anti-Codex\\deepcodex\n\n# Response format\n\nEach suggestion must include:\n- title\n- description\n- prompt\n- appId\n- write the prompt as something that should launch as a new Codex thread in this project",
      }],
    }],
  }, null);
  assert.deepEqual(JSON.parse(preReadinessCompletion.choices[0].message.content), []);
});

test("current desktop ambient suggestions using Codex task wording are answered locally", () => {
  const completion = deterministicAmbientSuggestionsCompletion({
    model: "gemini-3.5-flash-low",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: G:\\Project\n\n# Response format\n\nEach suggestion must include:\n- title\n- description\n- prompt\n- appId\n- write the prompt as something that should launch as a new Codex task in this project",
      }],
    }],
  });

  assert.ok(completion);
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), []);
  assert.deepEqual(completion.choices[0].message.tool_calls, undefined);
});

test("desktop task-title requests are answered locally without model work", () => {
  const completion = deterministicTaskTitleCompletion({
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.\n\nUser prompt:\nReply with exactly UI_CHAT_SMOKE_12345 and nothing else.",
      }],
    }],
  }, { model: "gemini-pro-agent", messages: [] });

  assert.equal(completion.choices[0].message.role, "assistant");
  assert.match(completion.choices[0].message.content, /UI_CHAT_SMOKE_12345|Reply/);
  assert.doesNotMatch(completion.choices[0].message.content, /Generating Task Titles/i);
});

test("new desktop structured task-title requests return title and description JSON", () => {
  const completion = deterministicTaskTitleCompletion({
    model: "claude-sonnet-4-6",
    text: {
      format: {
        type: "json_schema",
        name: "task_title",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, description: { type: "string" } },
          required: ["title", "description"],
        },
      },
    },
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.\nGenerate a concise UI title (up to 36 characters).\nFill the structured title field with plain text.\nFill the structured description field with a compact summary.\n\nUser prompt:\n这是 Anti-Codex 项目的真实收尾任务，请检查模型通路并生成 audit-v1.md。",
      }],
    }],
  }, { model: "claude-sonnet-4-6", messages: [] });

  const value = JSON.parse(completion.choices[0].message.content);
  assert.deepEqual(Object.keys(value), ["title", "description"]);
  assert.match(value.title, /Anti-Codex/);
  assert.ok(Array.from(value.title).length <= 36);
  assert.ok(Array.from(value.description).length <= 100);
});

test("local deterministic background replies consume desktop continuation without forcing another turn", () => {
  const sessionId = `ambient-session-${Date.now()}-${Math.random()}`;
  applyResponsesEndTurnHint({}, {
    path: "/responses/compact",
    headers: { session_id: sessionId, "x-codex-window-id": "window:1" },
  }, {}, { allowEndTurnFalse: true });

  const ambientFmt = { id: "resp_ambient", output: [] };
  applyResponsesEndTurnHint(ambientFmt, {
    path: "/responses",
    headers: { session_id: sessionId, "x-codex-window-id": "window:2" },
  }, {}, { allowEndTurnFalse: false });

  assert.equal(ambientFmt.end_turn, undefined);

  const nextFmt = { id: "resp_next", output: [] };
  applyResponsesEndTurnHint(nextFmt, {
    path: "/responses",
    headers: { session_id: sessionId, "x-codex-window-id": "window:3" },
  }, {}, { allowEndTurnFalse: true });

  assert.equal(nextFmt.end_turn, undefined);
});

test("repo file edit smoke uses a real shell tool call before completion", () => {
  const marker = "UI_REPO_FILE_EDIT_SMOKE_1782630926326";
  const prompt = `In the local project G:\\Trae-Project\\Anti-Codex\\deepcodex, edit only this file: G:\\Trae-Project\\Anti-Codex\\deepcodex\\scripts\\fixtures\\desktop-coworker-live\\acceptance-target.mjs. The test file already exists at G:\\Trae-Project\\Anti-Codex\\deepcodex\\scripts\\fixtures\\desktop-coworker-live\\acceptance-target.test.mjs and currently fails. Implement normalizeStatus(input). Then run: node --test G:\\Trae-Project\\Anti-Codex\\deepcodex\\scripts\\fixtures\\desktop-coworker-live\\acceptance-target.test.mjs. Put exactly ${marker} on the final line.`;
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
  };
  const chatBody = responsesToChatBody({
    ...request,
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  }, { allowTools: true });

  const initial = deterministicRepoFileEditToolCallCompletion(request, chatBody);
  assert.ok(initial);
  assert.equal(initial.choices[0].message.tool_calls[0].function.name, "shell_command");
  assert.match(initial.choices[0].message.tool_calls[0].function.arguments, /WriteAllText/);
  assert.match(initial.choices[0].message.tool_calls[0].function.arguments, /node --test/);

  const staleReadOnly = deterministicRepoFileEditToolCallCompletion({
    ...request,
    input: [
      ...request.input,
      { type: "function_call_output", call_id: "call_read_only", output: "Exit code: 0\nOutput:\nGet-Content acceptance-target.test.mjs" },
    ],
  }, {
    ...chatBody,
    messages: [
      ...chatBody.messages,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_only", type: "function", function: { name: "shell_command", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_read_only", content: "Exit code: 0\nOutput:\nGet-Content acceptance-target.test.mjs" },
    ],
  });
  assert.match(staleReadOnly.choices[0].message.tool_calls[0].function.arguments, /WriteAllText/);

  const withoutEvidence = deterministicRepoFileEditCompletionResponse(request, chatBody);
  assert.equal(withoutEvidence, null);

  const completed = deterministicRepoFileEditCompletionResponse({
    ...request,
    input: [
      ...request.input,
      { type: "function_call_output", call_id: "call_repo_edit", output: `Exit code: 0\nOutput:\n\u2139 tests 2\n\u2139 pass 2\n\u2139 fail 0\n${marker}` },
    ],
  }, {
    model: "gemini-pro-agent",
    messages: [
      ...chatBody.messages,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_repo_edit", type: "function", function: { name: "shell_command", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_repo_edit", content: `Exit code: 0\nOutput:\n\u2139 tests 2\n\u2139 pass 2\n\u2139 fail 0\n${marker}` },
    ],
  });
  assert.match(completed.choices[0].message.content, new RegExp(marker));
});

test("artifact completion does not reuse stale marker for a newer project edit task", () => {
  const messages = [
    {
      role: "user",
      content: "Create a tiny Node.js CLI project in C:\\Temp\\multi. done.txt must contain UI_MULTI_TURN_PROJECT_SMOKE_20260627.",
    },
    {
      role: "tool",
      tool_call_id: "call_old_check",
      content: "Anti-Codex artifact marker verification:\nUI_MULTI_TURN_PROJECT_SMOKE_20260627\nword-tally.mjs done.txt",
    },
    {
      role: "assistant",
      content: "Files created and verified.\n\nUI_MULTI_TURN_PROJECT_SMOKE_20260627",
    },
    {
      role: "user",
      content: "In the local project G:\\Trae-Project\\Anti-Codex\\deepcodex, edit only this file: scripts\\fixtures\\desktop-coworker-live\\acceptance-target.mjs. Run the failing test after editing.",
    },
    {
      role: "tool",
      tool_call_id: "call_project_read",
      content: "Get-Content scripts\\fixtures\\desktop-coworker-live\\acceptance-target.test.mjs\n---\nexport function normalizeStatus(input = \"\") { return String(input).trim(); }",
    },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_project_read", output: messages.at(-1).content }],
  }, { model: "gemini-pro-agent", messages });

  assert.equal(completion, null);
});

test("complex project tool output closes the turn after marker tests and CLI pass", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_20260701";
  const messages = [
    {
      role: "user",
      content: `Search the web for recent Codex updates, then create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\complex. done.txt must contain exactly ${marker}. The CLI must print sourceCount and codexMentionCount.`,
    },
    {
      role: "tool",
      tool_call_id: "call_complex",
      content: [
        `Exit code: 0`,
        `Output:`,
        `UI_COMPLEX_PROJECT_SMOKE_20260701`,
        `✔ summarizes three sources (1ms)`,
        `ℹ pass 1`,
        `ℹ fail 0`,
        `{"sourceCount":3,"codexMentionCount":3,"urls":["https://openai.com/codex/","https://openai.com/news/","https://developers.openai.com/codex/"]}`,
      ].join("\n"),
    },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_complex", output: messages.at(-1).content }],
  }, { model: "gemini-pro-agent", messages });

  assert.ok(completion);
  assert.match(completion.choices[0].message.content, /Files created, tested, and verified/);
  assert.match(completion.choices[0].message.content, new RegExp(marker));
});

test("autonomous reasoning tool output closes the turn after marker tests and CLI pass", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_20260702";
  const messages = [
    {
      role: "user",
      content: `请自主完成任务。工作目录：C:\\Temp\\autonomous。最终标记：${marker}。必须创建 package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt，并运行测试和 CLI。`,
    },
    {
      role: "tool",
      tool_call_id: "call_autonomous",
      content: [
        `Exit code: 0`,
        `Output:`,
        marker,
        `✔ summarizes three sources (1ms)`,
        `ℹ pass 1`,
        `ℹ fail 0`,
        `{"sourceCount":3,"codexMentionCount":3,"urls":["https://openai.com/codex/","https://openai.com/news/","https://developers.openai.com/codex/"]}`,
      ].join("\n"),
    },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_autonomous", output: messages.at(-1).content }],
  }, { model: "gemini-pro-agent", messages });

  assert.ok(completion);
  assert.match(completion.choices[0].message.content, /Files created, tested, and verified/);
  assert.match(completion.choices[0].message.content, new RegExp(marker));
});

test("coding project artifact completion requires CLI JSON proof", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_20260702_NO_CLI";
  const messages = [
    {
      role: "user",
      content: `Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\coding. word-tally.mjs must export tallyWords and done.txt must contain ${marker}. Run node --test word-tally.test.mjs and node word-tally.mjs "red blue red".`,
    },
    {
      role: "tool",
      tool_call_id: "call_coding",
      content: [
        `Exit code: 0`,
        `Output:`,
        marker,
        `✔ tallyWords counts words correctly (1ms)`,
        `ℹ pass 1`,
        `ℹ fail 0`,
        `done.txt`,
        `word-tally.mjs`,
      ].join("\n"),
    },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_coding", output: messages.at(-1).content }],
  }, { model: "gemini-pro-agent", messages });

  assert.equal(completion, null);
});

test("coding project artifact completion closes after tests and CLI JSON pass", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_20260702_WITH_CLI";
  const messages = [
    {
      role: "user",
      content: `Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\coding. word-tally.mjs must export tallyWords and done.txt must contain ${marker}. Run node --test word-tally.test.mjs and node word-tally.mjs "red blue red".`,
    },
    {
      role: "tool",
      tool_call_id: "call_coding",
      content: [
        `Exit code: 0`,
        `Output:`,
        marker,
        `✔ tallyWords counts words correctly (1ms)`,
        `ℹ pass 1`,
        `ℹ fail 0`,
        `{"red":2,"blue":1}`,
      ].join("\n"),
    },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_coding", output: messages.at(-1).content }],
  }, { model: "gemini-pro-agent", messages });

  assert.ok(completion);
  assert.match(completion.choices[0].message.content, /测试和本地 CLI 输出已通过/);
  assert.match(completion.choices[0].message.content, new RegExp(marker));
});

test("internal tool loop closes coding project from existing evidence before another model turn", async () => {
  const marker = "UI_CODING_PROJECT_SMOKE_20260702_PRE_LOOP";
  let callCount = 0;
  const result = await callUpstreamWithInternalTools({
    model: "gemini-pro-agent",
    stream: false,
    messages: [
      {
        role: "user",
        content: `Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\coding. word-tally.mjs must export tallyWords and done.txt must contain ${marker}. Run node --test word-tally.test.mjs and node word-tally.mjs "red blue red".`,
      },
      {
        role: "tool",
        tool_call_id: "call_coding",
        content: [
          `Exit code: 0`,
          `Output:`,
          marker,
          `✔ tallyWords counts words correctly (1ms)`,
          `ℹ pass 1`,
          `ℹ fail 0`,
          `{"red":2,"blue":1}`,
        ].join("\n"),
      },
    ],
  }, {
    callOnce: async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        json: {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_again",
                type: "function",
                function: { name: "web_search", arguments: "{}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      };
    },
  });

  assert.equal(callCount, 0);
  assert.equal(result.ok, true);
  assert.match(result.json.choices[0].message.content, /Files created, tested, and verified/);
  assert.match(result.json.choices[0].message.content, new RegExp(marker));
});

test("complex project chat tool output closes when Responses input has no tool output", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_20260701_CHAT_ONLY";
  const messages = [
    {
      role: "user",
      content: `Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\complex. done.txt must contain exactly ${marker}. The CLI must print sourceCount and codexMentionCount.`,
    },
    {
      role: "tool",
      tool_call_id: "call_complex",
      content: [
        `Exit code: 0`,
        `Output:`,
        marker,
        `✔ summarizes three sources (1ms)`,
        `ℹ pass 1`,
        `ℹ fail 0`,
        `{"sourceCount":3,"codexMentionCount":1,"urls":["https://openai.com/codex/","https://openai.com/news/","https://developers.openai.com/codex/"]}`,
      ].join("\n"),
    },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: messages[0].content }],
  }, { model: "gemini-pro-agent", messages });

  assert.ok(completion);
  assert.match(completion.choices[0].message.content, /验证：测试和本地 CLI 输出已通过/);
  assert.match(completion.choices[0].message.content, new RegExp(marker));
});

test("complex project Responses input tool output closes even without chat tool messages", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_20260701_INPUT_ONLY";
  const output = [
    `Exit code: 0`,
    `Output:`,
    marker,
    `✔ summarizes three sources (1ms)`,
    `ℹ pass 1`,
    `ℹ fail 0`,
    `{"sourceCount":3,"codexMentionCount":3,"urls":["https://openai.com/codex/","https://openai.com/news/","https://developers.openai.com/codex/"]}`,
  ].join("\n");

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\complex. done.txt must contain exactly ${marker}. The CLI must print sourceCount and codexMentionCount.`,
        }],
      },
      { type: "function_call_output", call_id: "call_complex", output },
    ],
  }, { model: "gemini-pro-agent", messages: [] });

  assert.ok(completion);
  assert.match(completion.choices[0].message.content, /Files created, tested, and verified/);
  assert.match(completion.choices[0].message.content, new RegExp(marker));
});

test("local artifact marker guard catches wrong marker in read-back evidence", () => {
  const messages = [
    {
      role: "user",
      content: "Create index.html, README.md and done.txt in C:\\Temp\\demo. done.txt must contain DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_01.",
    },
    {
      role: "tool",
      tool_call_id: "call_check",
      content: "Name Length\r\ndone.txt 26\r\nDESKTOP_SMALL_PROJECT\r\nindex.html contains no requested marker",
    },
  ];

  const mismatch = artifactMarkerMismatchForChat(messages, "Created index.html, README.md and done.txt. The task is complete.");
  assert.equal(mismatch.marker, "DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_01");
  assert.match(artifactMarkerMismatchRelayPrompt(mismatch), /Required exact marker: DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_01/);

  const ok = artifactMarkerMismatchForChat([
    messages[0],
    { role: "tool", tool_call_id: "call_check", content: "done.txt\r\nDESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_01" },
  ], "Created index.html, README.md and done.txt. The task is complete.");
  assert.equal(ok, null);
});

test("local artifact marker guard does not reuse the same marker from a prior repair turn", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_20260712_STALE";
  const messages = [
    {
      role: "user",
      content: `Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt in C:\\Temp\\autonomous. done.txt must contain exactly ${marker}.`,
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_initial", type: "function", function: { name: "shell_command", arguments: "{}" } }],
    },
    {
      role: "tool",
      tool_call_id: "call_initial",
      content: `Initial files written and verified. ${marker}`,
    },
    {
      role: "assistant",
      content: `Initial project completed. ${marker}`,
    },
    {
      role: "user",
      content: `Continue the same autonomous task in C:\\Temp\\autonomous. Repair codex-update-analyzer.mjs and sources.json, verify report.md, index.html, and done.txt, run the tests and CLI, then finish with ${marker}.`,
    },
  ];

  const mismatch = artifactMarkerMismatchForChat(
    messages,
    `The repair is complete and all files are verified. ${marker}`,
  );

  assert.equal(mismatch?.marker, marker);
  assert.equal(mismatch?.evidenceText, "");

  const currentTurnVerified = artifactMarkerMismatchForChat([
    ...messages,
    { role: "tool", tool_call_id: "call_repair", content: `Repair tests passed. ${marker}` },
  ], `The repair is complete and all files are verified. ${marker}`);
  assert.equal(currentTurnVerified, null);
});

test("deterministic artifact completion does not reuse complete evidence from a prior same-marker turn", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_DETERMINISTIC_STALE_20260712";
  const initialPrompt = `Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt in C:\\Temp\\autonomous-deterministic. done.txt must contain exactly ${marker}.`;
  const repairPrompt = `Continue the same autonomous task in C:\\Temp\\autonomous-deterministic. Repair codex-update-analyzer.mjs and sources.json, verify report.md, index.html, and done.txt, rerun tests and CLI, then finish with ${marker}.`;
  const priorEvidence = [
    "tests 3",
    "pass 3",
    "fail 0",
    '{"sourceCount":3,"codexMentionCount":2}',
    marker,
  ].join("\n");
  const messages = [
    { role: "user", content: initialPrompt },
    { role: "tool", tool_call_id: "call_initial", content: priorEvidence },
    { role: "assistant", content: `Initial task complete. ${marker}` },
    { role: "user", content: repairPrompt },
  ];

  const completion = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: initialPrompt },
      { type: "function_call_output", call_id: "call_initial", output: priorEvidence },
      { type: "message", role: "user", content: repairPrompt },
    ],
  }, { model: "gemini-pro-agent", messages });

  assert.equal(completion, null);
});

test("local artifact marker guard keeps all tool evidence from the current artifact turn", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_MULTI_TOOL_20260712";
  const messages = [
    {
      role: "user",
      content: `Create report.md, index.html, and done.txt in C:\\Temp\\autonomous-multi-tool. done.txt must contain exactly ${marker}.`,
    },
    { role: "tool", tool_call_id: "call_write", content: `Files written. ${marker}` },
    { role: "tool", tool_call_id: "call_test", content: "tests 4\npass 4\nfail 0" },
  ];

  const mismatch = artifactMarkerMismatchForChat(
    messages,
    `The files were created and verified. ${marker}`,
  );

  assert.equal(mismatch, null);
});

test("local artifact marker guard preserves tool evidence across a synthetic relay user", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_SYNTHETIC_RELAY_20260712";
  const messages = [
    {
      role: "user",
      content: `Create report.md, index.html, and done.txt in C:\\Temp\\autonomous-relay. done.txt must contain exactly ${marker}.`,
    },
    { role: "tool", tool_call_id: "call_verify", content: `Files and marker verified. ${marker}` },
    { role: "user", content: "Tool call is complete. Continue the same task now. This is not the final answer." },
  ];

  const mismatch = artifactMarkerMismatchForChat(
    messages,
    `The files were created and verified. ${marker}`,
  );

  assert.equal(mismatch, null);
});

test("local artifact marker guard rejects a marker echoed only by blocked tool guidance", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_BLOCKED_GUIDANCE_20260712";
  const messages = [
    {
      role: "user",
      content: `Create report.md, index.html, and done.txt in C:\\Temp\\autonomous-blocked-guidance. done.txt must contain exactly ${marker}.`,
    },
    {
      role: "tool",
      tool_call_id: "call_blocked_patch",
      content: `Anti-Codex blocked apply_patch for generated artifacts. Continue with exec_command. Required exact marker: ${marker}.`,
    },
  ];

  const mismatch = artifactMarkerMismatchForChat(
    messages,
    `The files were created and verified. ${marker}`,
  );

  assert.equal(mismatch?.marker, marker);
  assert.match(mismatch?.evidenceText || "", /blocked apply_patch/i);
});

test("autonomous artifact relay names the complete remaining project checklist", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_20260712002";
  const messages = [
    {
      role: "user",
      content: `Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt in C:\\Temp\\desktop-visible-autonomous-reasoning\\run. done.txt must contain exactly ${marker}.`,
    },
    {
      role: "tool",
      tool_call_id: "call_package_only",
      content: "package.json created",
    },
  ];

  const mismatch = artifactMarkerMismatchForChat(messages, "Created the project and finished the task.");
  assert.equal(mismatch.autonomousReasoning, true);
  const relay = artifactMarkerMismatchRelayPrompt(mismatch);
  for (const fileName of [
    "codex-update-analyzer.mjs",
    "codex-update-analyzer.test.mjs",
    "sources.json",
    "report.md",
    "index.html",
    "done.txt",
  ]) {
    assert.match(relay, new RegExp(fileName.replaceAll(".", "\\.")));
  }
  assert.match(relay, /batch-create the remaining files/i);
  assert.match(relay, /node --test codex-update-analyzer\.test\.mjs/i);
  assert.match(relay, /openai\.com/i);
  assert.match(relay, /sourceCount/);
  assert.match(relay, /codexMentionCount/);
  assert.match(relay, /真实来源/);
});

test("local artifact marker guard does not accept prefix-only multi-turn evidence", () => {
  const messages = [
    {
      role: "user",
      content: "Create a tiny Node.js CLI project in C:\\Temp\\multi. done.txt must contain UI_MULTI_TURN_PROJECT_SMOKE_20260627_FIRST.",
    },
    {
      role: "tool",
      tool_call_id: "call_first",
      content: "Anti-Codex artifact marker verification:\r\nUI_MULTI_TURN_PROJECT_SMOKE_20260627_FIRST\r\nword-tally.mjs word-tally.test.mjs done.txt",
    },
    {
      role: "assistant",
      content: "Files created and verified.\n\nUI_MULTI_TURN_PROJECT_SMOKE_20260627_FIRST",
    },
    {
      role: "user",
      content: "Continue the same project in C:\\Temp\\multi. Modify word-tally.mjs so it also exports uniqueWords(text). Create CHANGELOG.md and followup.txt containing exactly UI_MULTI_TURN_PROJECT_SMOKE_20260627.",
    },
  ];

  const mismatch = artifactMarkerMismatchForChat(messages, "Files created and verified.\n\nUI_MULTI_TURN_PROJECT_SMOKE_20260627");
  assert.equal(mismatch.marker, "UI_MULTI_TURN_PROJECT_SMOKE_20260627");
  assert.equal(mismatch.multiTurnProject, true);
  assert.match(artifactMarkerMismatchRelayPrompt(mismatch), /followup\.txt and CHANGELOG\.md/);

  const deterministic = deterministicArtifactCompletionResponse({
    model: "gemini-pro-agent",
    input: [{ type: "function_call_output", call_id: "call_first", output: "UI_MULTI_TURN_PROJECT_SMOKE_20260627_FIRST" }],
  }, { model: "gemini-pro-agent", messages });
  assert.equal(deterministic, null);
});

test("Antigravity tool loop replays when artifact completion used stale marker", async () => {
  let callCount = 0;
  const body = {
    model: "gemini-pro-agent",
    messages: [
      {
        role: "user",
        content: "Create index.html, README.md and done.txt in C:\\Temp\\demo. done.txt must contain DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_01.",
      },
      {
        role: "tool",
        tool_call_id: "call_check",
        content: "Name Length\r\ndone.txt 26\r\nDESKTOP_SMALL_PROJECT",
      },
    ],
  };
  assert.ok(artifactMarkerMismatchForChat(
    body.messages,
    "Created index.html, README.md and done.txt. The task is complete.",
  ));
  const result = await callUpstreamWithInternalTools(body, {
    callOnce: async (body) => {
      callCount += 1;
      if (callCount === 2) {
        assert.match(body.messages.at(-1).content, /Required exact marker: DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_01/);
      }
      return {
        ok: true,
        status: 200,
        json: {
          model: "gemini-pro-agent",
          choices: [{ message: { role: "assistant", content: "Created index.html, README.md and done.txt. The task is complete." }, finish_reason: "stop" }],
        },
      };
    },
  });

  assert.ok(callCount >= 2);
  assert.match(result.json.choices[0].message.content, /generated local files were not verified/);
  assert.match(result.json.choices[0].message.content, /DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_01/);
});

test("chatToResponsesFormat repairs stale marker in outgoing local artifact command", () => {
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_artifact",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "$targetDir = \"C:\\Temp\\demo\"\nSet-Content -Path \"$targetDir\\done.txt\" -Value \"DESKTOP_SMALL_PROJECT\" -Encoding UTF8",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Create index.html, README.md and done.txt in C:\\Temp\\demo. done.txt must contain DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_02." }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /DESKTOP_TOOL_DONE_20260627_AFTER_FIX_TOOL_02/);
  assert.doesNotMatch(args.command, /DESKTOP_SMALL_PROJECT/);
  assert.match(args.command, /Anti-Codex exact artifact marker guard/);
  assert.match(args.command, /New-Item -ItemType Directory/);
  assert.match(args.command, /README\.md/);
  assert.match(args.command, /Anti-Codex Report/);
  assert.match(args.command, /-cnotlike/);
  assert.match(args.command, /-CaseSensitive/);
  assert.match(args.command, /Select-String/);
});

test("ordinary audit tasks with reply markers are not rewritten as smoke fixtures", () => {
  const originalCommand = "[System.IO.File]::WriteAllText('C:\\Temp\\audit-v1.md', '# audit', [System.Text.UTF8Encoding]::new($false))";
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_real_audit",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: originalCommand }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Read G:\\Project\\app\\scripts\\worker.mjs, then write C:\\Temp\\audit-v1.md. Final reply line: ANTICODEX_FINAL_AUDIT_V1_20260710",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.command, originalCommand);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
  assert.doesNotMatch(args.command, /word-tally|done\.txt|Anti-Codex Report/);
});

test("one model response exposes at most four external tool calls", () => {
  const toolCalls = Array.from({ length: 7 }, (_, index) => ({
    id: `call_fanout_${index}`,
    type: "function",
    function: { name: "shell_command", arguments: JSON.stringify({ command: `Get-Content file-${index}.md -Head 20` }) },
  }));
  const fmt = chatToResponsesFormat({
    choices: [{ message: { role: "assistant", content: "", tool_calls: toolCalls }, finish_reason: "tool_calls" }],
  }, {
    model: "claude-sonnet-4-6",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect these files and continue." }] }],
  });

  assert.equal(fmt.output.filter(item => item.type === "function_call").length, 4);
});

test("a read-only verification follow-up blocks stale writes and deletes", () => {
  const userText = [
    "Continue the same project. Do not modify any file.",
    "Run npm test exactly once, then verify recursively that exactly 10 files exist and none has a UTF-8 BOM.",
    "Do not call apply_patch and do not inspect any other directory.",
  ].join(" ");
  const commands = [
    "npm test",
    "Get-ChildItem -Recurse -File | Measure-Object",
    "[System.IO.File]::WriteAllText('C:\\Project\\cli.mjs', 'stale')",
    "Remove-Item -LiteralPath 'C:\\Project\\report.md' -Force",
  ];
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: commands.map((command, index) => ({
          id: `call_read_only_${index}`,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command }) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const outputCommands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  assert.equal(outputCommands[0], commands[0]);
  assert.equal(outputCommands[1], commands[1]);
  assert.match(outputCommands[2], /blocked a filesystem mutation because the latest user requested read-only verification/i);
  assert.match(outputCommands[3], /blocked a filesystem mutation because the latest user requested read-only verification/i);
});

test("a Chinese read-only status request blocks a stale filesystem write", () => {
  const userText = "只读取当前项目状态，不修改任何文件。请确认 V2 的测试状态。";
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_chinese_read_only_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: "[System.IO.File]::WriteAllText('C:\\Project\\dummy.txt', 'stale')" }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  assert.match(JSON.parse(call.arguments).command, /blocked a filesystem mutation because the latest user requested read-only verification/i);
});

test("a read-only diagnosis step does not block explicitly requested repair files", () => {
  const marker = "UI_FAILED_LAUNCH_MIXED_READ_WRITE_123";
  const userText = [
    "继续当前同一个任务，绝对不能再次启动。",
    "先只读取 launch-count.txt 和 error.log。",
    "随后创建 config.json 和 diagnosis.json。",
    `diagnosis.json 必须写入 marker=${marker}。`,
  ].join(" ");
  const command = [
    "[System.IO.File]::WriteAllText('C:\\Project\\config.json', '{\"mode\":\"repaired\"}')",
    `[System.IO.File]::WriteAllText('C:\\Project\\diagnosis.json', '{\"marker\":\"${marker}\"}')`,
  ].join("; ");
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_mixed_read_write_repair",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  assert.equal(JSON.parse(call.arguments).command, command);
});

test("explicit exclusive artifact constraints bound reads and block unrelated writes", () => {
  const targetDir = "C:\\Temp\\final-product-audit-work";
  const userText = `禁止使用 Get-Content -Raw 整文件读取。请创建目录 ${targetDir}，并写入 audit-v1.md。不要修改项目源文件，不要读取 .env，不要写其他文件。`;
  const commands = [
    'Get-Content "G:\\Project\\task_plan.md" -Raw -Encoding UTF8',
    'New-Item -ItemType Directory -Path "G:\\Project\\config" -Force; Set-Content "G:\\Project\\config\\bad.json" "{}"',
    `New-Item -ItemType Directory -Path "${targetDir}" -Force`,
    `Set-Content -Path "${targetDir}\\audit-v1.md" -Value "# audit" -Encoding UTF8`,
  ];
  const fmt = chatToResponsesFormat({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: commands.map((command, index) => ({
          id: `call_constraint_${index}`,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command }) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "claude-sonnet-4-6",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const outputCommands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  assert.match(outputCommands[0], /-TotalCount 160/);
  assert.doesNotMatch(outputCommands[0], /\s-Raw\b/);
  assert.match(outputCommands[1], /blocked an out-of-scope write/);
  assert.match(outputCommands[2], /New-Item[\s\S]*final-product-audit-work/);
  assert.match(outputCommands[3], /audit-v1\.md/);
});

test("a PowerShell path variable cannot bypass an explicit multi-file write scope", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex scoped artifact recovery "));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const userText = [
    `Project directory:\n${project}`,
    "Only modify report.md and done.txt, and delete index.html.",
    "Do not create, delete, or modify any other file.",
  ].join("\n");
  const commands = [
    '$path = "test/analyze.test.mjs"; $content = [System.IO.File]::ReadAllText($path); [System.IO.File]::WriteAllText($path, $content + "\\n// TEMP_MOD\\n", [System.Text.Encoding]::UTF8)',
    '$path = "report.md"; [System.IO.File]::WriteAllText($path, "# restored", [System.Text.Encoding]::UTF8)',
  ];
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: commands.map((command, index) => ({
          id: `call_variable_scope_${index}`,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command, workdir: project }) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const outputCommands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  assert.match(outputCommands[0], /blocked an out-of-scope write/);
  assert.match(outputCommands[1], /WriteAllText/);
  assert.doesNotMatch(outputCommands[1], /blocked an out-of-scope write/);
});

test("a forbidden directory listing in a single-file task is redirected to the target file", () => {
  const target = "C:\\Project\\cli.mjs";
  const userText = [
    `Only edit this file ${target}.`,
    "Do not create, write, modify, or touch any other file.",
    "Do not list directories or inspect git.",
    "You may read cli.mjs before editing, then run node --check cli.mjs.",
  ].join(" ");
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_forbidden_single_file_listing",
            type: "function",
            function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-ChildItem -Path "C:\\Project" -Force' }) },
          },
          {
            id: "call_forbidden_single_file_git_probe",
            type: "function",
            function: { name: "shell_command", arguments: JSON.stringify({ command: "git status; git log -1" }) },
          },
          {
            id: "call_forbidden_single_file_rg_listing",
            type: "function",
            function: { name: "shell_command", arguments: JSON.stringify({ command: "rg --files" }) },
          },
        ],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const commands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  for (const command of commands) {
    assert.match(command, /Get-Content -LiteralPath/);
    assert.match(command, /C:\\Project\\cli\.mjs/);
    assert.match(command, /-TotalCount 240/);
    assert.doesNotMatch(command, /Get-ChildItem|git status|git log|rg --files/);
  }
});

test("a directory detour is redirected to explicitly requested source reads", () => {
  const userText = [
    "Continue the project in C:\\Project.",
    "Only modify cli.mjs and do not create any other file.",
    "Read cli.mjs plus src\\normalize.mjs, src\\analyze.mjs, and src\\report.mjs once to learn their actual named exports.",
    "Then repair cli.mjs and run node --check cli.mjs.",
  ].join(" ");
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_directory_detour_before_explicit_reads",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-ChildItem" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const command = JSON.parse(call.arguments).command;
  assert.doesNotMatch(command, /Get-ChildItem/);
  assert.match(command, /Get-Content[\s\S]*cli\.mjs/);
  assert.match(command, /src\\normalize\.mjs/);
  assert.match(command, /src\\analyze\.mjs/);
  assert.match(command, /src\\report\.mjs/);
});

test("a model switch cannot replay a stale write outside a relative single-file scope", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex model switch scope "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userText = [
    "Continue the same project.",
    "Only modify cli.mjs; do not modify or create any other file.",
    "Read cli.mjs once, replace it, then run node --check cli.mjs.",
  ].join(" ");
  const staleTarget = path.join(root, "README.md");
  const fmt = chatToResponsesFormat({
    model: "gemini-3.1-pro-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_stale_model_switch_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: `[System.IO.File]::WriteAllText('${staleTarget}', 'stale')` }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.1-pro-low",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "<model_switch>Use the new model.</model_switch>" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    ],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const command = JSON.parse(call.arguments).command;
  assert.match(command, /blocked an out-of-scope write/i);
  assert.match(command, /cli\.mjs/i);
  assert.doesNotMatch(command, /WriteAllText/);
});

test("a Chinese one-file correction blocks stale report-site writes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex Chinese correction scope "));
  fs.mkdirSync(path.join(root, "test"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userText = [
    `继续当前任务，只修复项目目录 ${root} 中剩余的一个失败测试。`,
    "第一步必须直接修改 test/analyze.test.mjs，不要改 cli.mjs、README.md、done.txt 或其他测试。",
    "只替换名为 CLI --version extra regression 的测试断言，然后运行 npm test。",
  ].join(" ");
  const staleCommand = [
    'Set-Content -Path "report.md" -Value "# Search Report" -Encoding UTF8',
    'Set-Content -Path "index.html" -Value "<html></html>" -Encoding UTF8',
    'Set-Content -Path "done.txt" -Value "Task completed." -Encoding UTF8',
  ].join("; ");
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_stale_report_site_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: staleCommand, workdir: root }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    ],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const command = JSON.parse(call.arguments).command;
  assert.match(command, /blocked an out-of-scope write/i);
  assert.match(command, /test\\analyze\.test\.mjs/i);
  assert.doesNotMatch(command, /Set-Content|report\.md|index\.html|done\.txt/i);
});

test("a relative two-file scope allows both targets and blocks a third file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex two file scope "));
  fs.mkdirSync(path.join(root, "test"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userText = [
    "V2 edge requirement for the same project.",
    "Only modify cli.mjs and test\\analyze.test.mjs; do not create, delete, or modify any other file.",
    "Read both files once, implement the feature, and run npm test.",
  ].join(" ");
  const allowedCommand = [
    `[System.IO.File]::WriteAllText('${path.join(root, "cli.mjs")}', 'cli')`,
    `[System.IO.File]::WriteAllText('${path.join(root, "test", "analyze.test.mjs")}', 'test')`,
  ].join("; ");
  const deniedCommand = `[System.IO.File]::WriteAllText('${path.join(root, "README.md")}', 'stale')`;
  const fmt = chatToResponsesFormat({
    model: "gemini-3.1-pro-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [allowedCommand, deniedCommand].map((command, index) => ({
          id: `call_two_file_scope_${index}`,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command }) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.1-pro-low",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    ],
  });

  const commands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  assert.equal(commands[0], allowedCommand);
  assert.match(commands[1], /blocked an out-of-scope write/i);
  assert.match(commands[1], /cli\.mjs[\s\S]*analyze\.test\.mjs/i);
});

test("a Chinese single-file repair permits an explicit same-directory cleanup target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-same-directory-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const analyzerPath = path.join(root, "codex-update-analyzer.mjs");
  const userText = [
    "继续当前同一个任务，直接完成最后修复，不要再列目录。",
    `只允许修改 ${analyzerPath}，并删除同目录中误建的 setup.js；不要修改其他文件。`,
  ].join(" ");
  const allowedCommand = [
    `$dir = "${root}"`,
    'Remove-Item -Path "$dir\\setup.js" -ErrorAction SilentlyContinue',
    '[System.IO.File]::WriteAllText("$dir\\codex-update-analyzer.mjs", "code", [System.Text.UTF8Encoding]::new($false))',
  ].join("\n");
  const deniedCommand = `[System.IO.File]::WriteAllText('${path.join(root, "README.md")}', 'stale')`;
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [allowedCommand, deniedCommand].map((command, index) => ({
          id: `call_same_directory_cleanup_${index}`,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command, workdir: root }) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    ],
  });

  const commands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  assert.equal(commands[0], allowedCommand);
  assert.match(commands[1], /blocked an out-of-scope write/i);
  assert.match(commands[1], /codex-update-analyzer\.mjs[\s\S]*setup\.js/i);
});

test("explicit verbatim file body overrides a model-authored write and blocks other targets", () => {
  const target = "C:\\Temp\\clean-audit-work\\audit-clean.md";
  const exactBody = [
    "# 项目目标",
    "Codex Desktop 同步副本加薄的 Anti-Codex 模型适配层。",
    "单一 Antigravity 账号，不以双账号为完成条件。",
  ].join("\n");
  const userText = [
    "只允许操作现有文件：",
    target,
    "不要创建任何其他文件。",
    "最终文件正文必须逐字等于下面代码块中的内容：",
    "```text",
    exactBody,
    "```",
  ].join("\n");
  const commands = [
    `$path = '${target}'; $content = '# generic audit'; [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))`,
    `[System.IO.File]::WriteAllText('C:\\Temp\\clean-audit-work\\other.md', 'wrong', [System.Text.UTF8Encoding]::new($false))`,
  ];
  const fmt = chatToResponsesFormat({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: commands.map((command, index) => ({
          id: `call_exact_body_${index}`,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command }) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const outputCommands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  assert.match(outputCommands[0], /Anti-Codex exact file body enforcement/);
  assert.ok(outputCommands[0].includes(Buffer.from(exactBody, "utf8").toString("base64")));
  assert.match(outputCommands[0], /WriteAllText/);
  assert.match(outputCommands[1], /blocked an out-of-scope write/);
});

test("a second read in an explicit verbatim task is promoted to the exact write", () => {
  const target = "C:\\Temp\\clean-audit-work\\audit-clean.md";
  const exactBody = "# 项目目标\n目标没有变。\nANTICODEX_EXACT_BODY_DONE";
  const userText = [
    "只允许操作现有文件：",
    target,
    "不要创建任何其他文件。",
    "最终文件正文必须逐字等于下面代码块中的内容：",
    "```text",
    exactBody,
    "```",
    "最终回复最后一行只写：ANTICODEX_EXACT_BODY_DONE",
  ].join("\n");
  const priorRead = `Get-Content -Raw -Encoding UTF8 -Path '${target}'`;
  const fmt = chatToResponsesFormat({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_second_exact_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: priorRead }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
      { type: "function_call", call_id: "call_first_exact_read", name: "shell_command", arguments: JSON.stringify({ command: priorRead }) },
      { type: "function_call_output", call_id: "call_first_exact_read", output: "old content" },
    ],
  });

  const command = JSON.parse(fmt.output.find(item => item.type === "function_call").arguments).command;
  assert.match(command, /Anti-Codex exact file body enforcement/);
  assert.match(command, /WriteAllText/);
  assert.ok(command.includes(Buffer.from(exactBody, "utf8").toString("base64")));
});

test("verified explicit verbatim body closes the turn with the requested final marker", () => {
  const target = "C:\\Temp\\clean-audit-work\\audit-clean.md";
  const marker = "ANTICODEX_EXACT_BODY_DONE";
  const exactBody = `# 项目目标\n目标没有变。\n${marker}`;
  const userText = [
    "只允许操作现有文件：",
    target,
    "不要创建任何其他文件。",
    "最终文件正文必须逐字等于下面代码块中的内容：",
    "```text",
    exactBody,
    "```",
    `最终回复最后一行只写：${marker}`,
  ].join("\n");
  const request = {
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
      { type: "function_call_output", call_id: "call_exact_write", output: exactBody },
    ],
  };
  const completion = deterministicArtifactCompletionResponse(request, {
    model: request.model,
    messages: [
      { role: "user", content: userText },
      { role: "tool", tool_call_id: "call_exact_write", content: exactBody },
    ],
  });

  assert.ok(completion);
  assert.equal(completion.choices[0].message.content, marker);
});

test("explicit bounded-read constraints cap plain Get-Content and detect Node writes", () => {
  const targetDir = "C:\\Temp\\final-product-audit-work";
  const userText = `task_plan.md 和 findings.md 很大，禁止整文件读取，必须使用有界读取。请创建目录 ${targetDir}，并写入 audit-v1.md。不要写其他文件。`;
  const commands = [
    'Get-Content -Path "G:\\Project\\task_plan.md", "G:\\Project\\findings.md"',
    `node -e "require('fs').writeFileSync('${targetDir.replaceAll("\\", "\\\\")}', 'bad')"`,
    `node -e "require('fs').writeFileSync('${`${targetDir}\\audit-v1.md`.replaceAll("\\", "\\\\")}', '# audit')"`,
  ];
  const fmt = chatToResponsesFormat({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: commands.map((command, index) => ({
          id: `call_bounded_constraint_${index}`,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command }) },
        })),
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const outputCommands = fmt.output
    .filter(item => item.type === "function_call")
    .map(item => JSON.parse(item.arguments).command);
  assert.match(outputCommands[0], /Select-Object -First 160/);
  assert.match(outputCommands[1], /blocked an out-of-scope write/);
  assert.match(outputCommands[2], /audit-v1\.md/);
  assert.doesNotMatch(outputCommands[2], /blocked an out-of-scope write/);
});

test("third consecutive write to the same sole file ends the tool loop", () => {
  const target = "C:\\Temp\\final-product-audit-work\\audit-v1.md";
  const writeCommand = (heading) => `$path = '${target}'; $content = '${heading}'; [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false)); Get-Content -LiteralPath $path -Raw -Encoding UTF8`;
  const priorTurn = (id, heading) => [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand(heading) }) },
    }],
  }, {
    role: "tool",
    tool_call_id: id,
    content: `Exit code: 0\nOutput:\n${heading}`,
  }];
  const fmt = chatToResponsesFormat({
    model: "gemini-3.1-pro-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_write_3",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand("audit three") }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.1-pro-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Only write ${target}, verify it, then finish.` }] }],
  }, null, {
    chatMessages: [
      ...priorTurn("call_write_1", "audit one"),
      ...priorTurn("call_write_2", "audit two"),
    ],
  });

  assert.equal(fmt.output.some(item => item.type === "function_call"), false);
  const text = fmt.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.match(text, /stopped a third consecutive write/i);
  assert.match(text, /audit-v1\.md/i);
  assert.match(text, /same chat/i);
});

test("third consecutive relative WriteAllText in one workdir ends the tool loop", () => {
  const workdir = "C:\\Temp\\session-inspector";
  const writeCommand = (value) => `$code = @'\n${value}\n'@\n[System.IO.File]::WriteAllText("cli.mjs", $code, [System.Text.UTF8Encoding]::new($false))`;
  const priorTurn = (id, value) => [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand(value), workdir }) },
    }],
  }, {
    role: "tool",
    tool_call_id: id,
    content: "Exit code: 0",
  }];
  const fmt = chatToResponsesFormat({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_relative_write_3",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand("three"), workdir }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3-flash-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Finish the CLI and then run its tests." }] }],
  }, null, {
    chatMessages: [
      ...priorTurn("call_relative_write_1", "one"),
      ...priorTurn("call_relative_write_2", "two"),
    ],
  });

  assert.equal(fmt.output.some(item => item.type === "function_call"), false);
  const text = fmt.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.match(text, /stopped a third consecutive write/i);
  assert.match(text, /cli\.mjs/i);
});

test("same-file repair remains allowed after an intervening verification command", () => {
  const target = "C:\\Temp\\project\\app.mjs";
  const writeCommand = `$path = '${target}'; [System.IO.File]::WriteAllText($path, 'export const value = 2;', [System.Text.UTF8Encoding]::new($false))`;
  const prior = [
    { role: "assistant", content: "", tool_calls: [{ id: "call_write_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand }) } }] },
    { role: "tool", tool_call_id: "call_write_1", content: "Exit code: 0" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_test", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: "node --test app.test.mjs" }) } }] },
    { role: "tool", tool_call_id: "call_test", content: "Exit code: 1" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_write_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand }) } }] },
    { role: "tool", tool_call_id: "call_write_2", content: "Exit code: 0" },
  ];
  const fmt = chatToResponsesFormat({
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_write_3", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand }) } }] }, finish_reason: "tool_calls" }],
  }, {
    model: "gemini-3.1-pro-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fix app.mjs until the tests pass." }] }],
  }, null, { chatMessages: prior });

  assert.equal(fmt.output.filter(item => item.type === "function_call").length, 1);
});

test("a new user follow-up resets the consecutive same-file write guard", () => {
  const target = "C:\\Temp\\audit\\audit-v1.md";
  const writeCommand = (value) => `$path = '${target}'; [System.IO.File]::WriteAllText($path, '${value}', [System.Text.UTF8Encoding]::new($false))`;
  const prior = [
    { role: "assistant", content: "", tool_calls: [{ id: "call_old_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand("one") }) } }] },
    { role: "tool", tool_call_id: "call_old_1", content: "Exit code: 0" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_old_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand("two") }) } }] },
    { role: "tool", tool_call_id: "call_old_2", content: "Exit code: 0" },
    { role: "user", content: "Continue in the same chat and repair the missing sections." },
  ];
  const fmt = chatToResponsesFormat({
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_followup", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: writeCommand("repaired") }) } }] }, finish_reason: "tool_calls" }],
  }, {
    model: "gemini-3.1-pro-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue in the same chat and repair the missing sections." }] }],
  }, null, { chatMessages: prior });

  assert.equal(fmt.output.filter(item => item.type === "function_call").length, 1);
});

test("third repeated unbounded full-file read is blocked before another tool loop", () => {
  const repeatedCommand = 'Get-Content -Path "G:\\Project\\task_plan.md" -Raw';
  const priorCall = (id) => ({
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: { name: "shell_command", arguments: JSON.stringify({ command: repeatedCommand }) },
    }],
  });
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_read_3",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: repeatedCommand }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Audit the project and write audit-v1.md." }] }],
  }, null, {
    chatMessages: [
      priorCall("call_read_1"),
      { role: "tool", tool_call_id: "call_read_1", content: "large clipped output" },
      priorCall("call_read_2"),
      { role: "tool", tool_call_id: "call_read_2", content: "large clipped output" },
    ],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /blocked the third repeated unbounded full-file read/);
  assert.doesNotMatch(args.command, /Get-Content[\s\S]*-Raw/);
});

test("a new user follow-up resets the repeated full-file read guard", () => {
  const repeatedCommand = 'Get-Content -Path "C:\\Project\\src\\normalize.mjs" -Raw';
  const priorCall = (id) => ({
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: repeatedCommand }) } }],
  });
  const chatMessages = [
    { role: "user", content: "Inspect normalize.mjs." },
    priorCall("old_read_1"),
    { role: "tool", tool_call_id: "old_read_1", content: "old output" },
    priorCall("old_read_2"),
    { role: "tool", tool_call_id: "old_read_2", content: "old output" },
    { role: "user", content: "This is a new repair contract. Read the authorized file once, then replace it." },
  ];
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "new_read_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: repeatedCommand }) } }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "This is a new repair contract. Read the authorized file once, then replace it." }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  assert.equal(JSON.parse(call.arguments).command, repeatedCommand);
});

test("repeated read-only inspection loop is forced to proceed to the deliverable", () => {
  const commands = [
    'Get-ChildItem -Path "G:\\Project"',
    'Get-ChildItem -Path "G:\\Project" -Recurse',
  ];
  const chatMessages = commands.flatMap((command, index) => {
    const id = `call_inspect_${index}`;
    return [{
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }],
    }, { role: "tool", tool_call_id: id, content: "inspection output" }];
  });
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_inspect_7",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-ChildItem -Path "G:\\Project"' }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Audit the project and write audit-v1.md." }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /completed the inspection phase after detecting repeated read-only calls/);
  assert.match(args.command, /create or edit every missing requested deliverable/);
  assert.match(args.command, /exit 0/);
  assert.doesNotMatch(args.command, /throw/);
  assert.doesNotMatch(args.command, /Get-ChildItem/);
});

test("a repeated Chinese read-only inspection is forced to answer instead of write", () => {
  const userText = "只读取当前项目状态，不修改任何文件。V2 已经完成 19 个测试；请仅回复 RECOVERY_HOOK_OK。";
  const commands = [
    'Get-Content -Path "G:\\Project\\cli.mjs"',
    'Get-Content -Raw -Path "G:\\Project\\cli.mjs"',
  ];
  const chatMessages = commands.flatMap((command, index) => {
    const id = `call_read_only_chinese_${index}`;
    return [{
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }],
    }, { role: "tool", tool_call_id: id, content: "inspection output" }];
  });
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_read_only_chinese_3",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: commands[0] }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /completed the requested read-only inspection/i);
  assert.match(args.command, /reply directly to the latest user request/i);
  assert.doesNotMatch(args.command, /create or edit|missing requested deliverable/i);
});

test("read-only inspection variants are blocked when they keep reopening the same target", () => {
  const commands = [
    'Get-Content "C:\\Project\\src\\normalize.mjs"',
    'Get-Content src/normalize.mjs -Raw',
  ];
  const chatMessages = commands.flatMap((command, index) => {
    const id = `call_variant_read_${index}`;
    return [{
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }],
    }, { role: "tool", tool_call_id: id, content: "file output" }];
  });
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_variant_read_3",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: 'Get-Content src/analyze.mjs; Get-Content src/normalize.mjs; Get-Content cli.mjs' }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Repair the requested files and run the tests." }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /completed the inspection phase after detecting repeated read-only calls/);
  assert.doesNotMatch(args.command, /Get-Content/);
});

test("repeated bounded reads fall back to complete Responses history", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_BOUNDED_READ_20260712";
  const userText = `继续当前同一个任务，只修复 C:\\Project\\codex-update-analyzer.mjs，最后输出 ${marker}。`;
  const readCommand = "Get-Content -LiteralPath 'C:\\Project\\codex-update-analyzer.mjs' -TotalCount 400 -Encoding UTF8";
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    { type: "function_call", call_id: "bounded_read_1", name: "exec_command", arguments: JSON.stringify({ cmd: readCommand, workdir: "C:\\Project" }) },
    { type: "function_call_output", call_id: "bounded_read_1", output: "const sourceCount = 3;" },
    { type: "function_call", call_id: "bounded_read_2", name: "exec_command", arguments: JSON.stringify({ cmd: readCommand, workdir: "C:\\Project" }) },
    { type: "function_call_output", call_id: "bounded_read_2", output: "const sourceCount = 3;" },
  ];
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const formatted = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "bounded_read_3",
          type: "function",
          function: { name: "exec_command", arguments: JSON.stringify({ cmd: readCommand, workdir: "C:\\Project" }) },
        }],
      },
    }],
  }, { model: "gemini-pro-agent", input }, routing, {
    strictTools: true,
    chatMessages: [{ role: "user", content: userText }],
  });

  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.cmd, /completed the inspection phase after detecting repeated read-only calls/);
  assert.doesNotMatch(args.cmd, /Get-Content/);
});

test("an explicit write-first contract blocks the first read-only detour", () => {
  const userText = [
    "Your first output must be shell_command.",
    "Do not read, list, inspect, or check files first.",
    "Only modify C:\\Project\\src\\normalize.mjs and C:\\Project\\test\\analyze.test.mjs, then run the tests.",
  ].join(" ");
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_forbidden_first_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-Content "C:\\Project\\src\\normalize.mjs"' }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /explicitly required a write-first tool turn/i);
  assert.match(args.command, /create or edit the authorized files now/i);
  assert.doesNotMatch(args.command, /Get-Content/);
});

test("a first shell command must modify contract also blocks a read-only detour", () => {
  const userText = [
    "Your first shell_command must modify src/normalize.mjs.",
    "Do not list, read, inspect, or run old tests before editing.",
    "Then continue implementing the requested project files.",
  ].join(" ");
  const fmt = chatToResponsesFormat({
    model: "claude-opus-4-6-thinking",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_forbidden_natural_first_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-ChildItem -Recurse" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "claude-opus-4-6-thinking",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /explicitly required a write-first tool turn/i);
  assert.doesNotMatch(args.command, /Get-ChildItem/);
});

test("a Chinese first-step shell recovery contract blocks the first read-only detour", () => {
  const userText = [
    "Only modify report.md and done.txt, and delete index.html. Do not modify any other file.",
    "第一步必须直接调用一次 shell_command 执行恢复，不要先读文件或列目录。",
    "删除 index.html，重新生成 report.md，并把 done.txt 写成指定标记。",
    "随后只做读取和验证。",
  ].join(" ");
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_forbidden_chinese_restore_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-Content test/analyze.test.mjs" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /explicitly required a write-first tool turn/i);
  assert.match(args.command, /create or edit the authorized files now/i);
  assert.doesNotMatch(args.command, /completed the requested read-only inspection/i);
  assert.doesNotMatch(args.command, /Get-Content/);
});

test("an explicit write-first contract wins when a continuation prompt starts a new user turn", () => {
  const userText = [
    "Continue the same task.",
    "Only edit this file C:\\Project\\cli.mjs.",
    "Do not create, write, modify, or touch any other files.",
    "Do not read or list first.",
    "Your next shell_command must overwrite C:\\Project\\cli.mjs.",
    "After the write, stop without reading, listing, testing, or editing another file.",
  ].join(" ");
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_forbidden_continuation_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-ChildItem -Path "C:\\Project"' }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /explicitly required a write-first tool turn/i);
  assert.doesNotMatch(args.command, /Get-ChildItem/);
});

test("an explicit write-first reminder is not mistaken for a deliverable write", () => {
  const userText = [
    "Continue the same task.",
    "Only edit this file C:\\Project\\cli.mjs.",
    "Do not create, write, modify, or touch any other files.",
    "Do not read or list first.",
    "Your next shell_command must overwrite C:\\Project\\cli.mjs.",
    "After the write, stop without reading, listing, testing, or editing another file.",
  ].join(" ");
  const nudge = `Write-Output 'The user explicitly required a write-first tool turn. Do not read or list first; create or edit the authorized files now. Current user task reminder: ${userText}'; exit 0`;
  const chatMessages = [
    { role: "user", content: userText },
    { role: "assistant", content: "", tool_calls: [{ id: "call_write_first_nudge", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nudge }) } }] },
    { role: "tool", tool_call_id: "call_write_first_nudge", content: "write-first reminder" },
  ];
  const fmt = chatToResponsesFormat({
    model: "gemini-3.5-flash-low",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_forbidden_after_nudge_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-ChildItem -Path "C:\\Project"' }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /explicitly required a write-first tool turn/i);
  assert.doesNotMatch(args.command, /Get-ChildItem/);
});

test("third read after two forced implementation nudges ends the turn without another tool call", () => {
  const nudge = "Write-Output 'Anti-Codex completed the inspection phase after detecting repeated read-only calls. Do not issue another read or listing command.'; exit 0";
  const chatMessages = [
    { role: "user", content: "Create every requested project file and run the tests." },
    { role: "assistant", content: "", tool_calls: [{ id: "call_read_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-ChildItem -Path "G:\\Project"' }) } }] },
    { role: "tool", tool_call_id: "call_read_1", content: "inspection output" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_read_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-ChildItem -Path "G:\\Project" -Recurse' }) } }] },
    { role: "tool", tool_call_id: "call_read_2", content: "inspection output" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_nudge_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nudge }) } }] },
    { role: "tool", tool_call_id: "call_nudge_1", content: "implementation reminder" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_nudge_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nudge }) } }] },
    { role: "tool", tool_call_id: "call_nudge_2", content: "implementation reminder" },
  ];
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_read_3", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-ChildItem -Path "G:\\Project" -Recurse' }) } }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Create every requested project file and run the tests." }] }],
  }, null, { chatMessages });

  assert.equal(fmt.output.some(item => item.type === "function_call"), false);
  const text = fmt.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.match(text, /连续两次忽略/);
  assert.match(text, /没有被标记为完成/);
});

test("third read after two explicit write-first nudges also ends the turn", () => {
  const nudge = "Write-Output 'The user explicitly required a write-first tool turn. Do not read or list first; create or edit the authorized files now.'; exit 0";
  const chatMessages = [
    { role: "user", content: "Your first output must be shell_command. Do not read first. Only modify C:\\Project\\src\\normalize.mjs." },
    { role: "assistant", content: "", tool_calls: [{ id: "call_nudge_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nudge }) } }] },
    { role: "tool", tool_call_id: "call_nudge_1", content: "write-first reminder" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_nudge_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nudge }) } }] },
    { role: "tool", tool_call_id: "call_nudge_2", content: "write-first reminder" },
  ];
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_read_3", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-Content "C:\\Project\\src\\normalize.mjs"' }) } }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Your first output must be shell_command. Do not read first. Only modify C:\\Project\\src\\normalize.mjs." }] }],
  }, null, { chatMessages });

  assert.equal(fmt.output.some(item => item.type === "function_call"), false);
  const text = fmt.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.match(text, /连续两次忽略/);
});

test("stream mapper ends a third read after two explicit write-first nudges", () => {
  const nudge = "Write-Output 'The user explicitly required a write-first tool turn. Do not read or list first; create or edit the authorized files now.'; exit 0";
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Your first output must be shell_command. Do not read first. Only modify C:\\Project\\src\\normalize.mjs." }] },
    { type: "function_call", id: "fc_nudge_1", call_id: "call_nudge_1", name: "shell_command", arguments: JSON.stringify({ command: nudge }) },
    { type: "function_call_output", call_id: "call_nudge_1", output: "write-first reminder" },
    { type: "function_call", id: "fc_nudge_2", call_id: "call_nudge_2", name: "shell_command", arguments: JSON.stringify({ command: nudge }) },
    { type: "function_call_output", call_id: "call_nudge_2", output: "write-first reminder" },
  ];
  const mapper = new ChatToResponsesStreamMapper({ model: "gemini-pro-agent", input }, "gemini-pro-agent", {
    shell_command: {
      codexName: "shell_command",
      type: "function",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  });
  const events = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_read_3",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-Content "C:\\Project\\src\\normalize.mjs"' }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });

  assert.equal(events.some(([event, data]) => event === "response.output_item.added" && data.item.type === "function_call"), false);
  const completed = events.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output.some(item => item.type === "function_call"), false);
  const text = completed.response.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.match(text, /连续两次忽略/);
  assert.match(text, /没有被标记为完成/);
});

test("third inspection after a successful write is forced back to implementation", () => {
  const write = '$dir = "G:\\Project"; Set-Content -Path "$dir\\package.json" -Value "{}"';
  const commands = [
    write,
    'Get-ChildItem -Path "G:\\Project"',
    'Get-ChildItem -Path "G:\\Project" -Recurse',
  ];
  const chatMessages = [
    { role: "user", content: "Create package.json, src/analyze.mjs, test/analyze.test.mjs, and README.md in G:\\Project, then run npm test." },
    ...commands.flatMap((command, index) => {
      const id = `call_after_write_${index}`;
      return [{
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }],
      }, { role: "tool", tool_call_id: id, content: "Exit code: 0" }];
    }),
  ];
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_after_write_3",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-Content -Path "G:\\Project\\package.json"' }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Create the requested multi-file project." }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /completed the inspection phase after detecting repeated read-only calls/);
  assert.match(args.command, /every missing requested deliverable/);
  assert.match(args.command, /Current user task reminder: Create package\.json, src\/analyze\.mjs/);
  assert.doesNotMatch(args.command, /Get-Content -Path/);
});

test("two targeted inspections after a write are still allowed", () => {
  const chatMessages = [
    { role: "user", content: "Create and verify G:\\Project\\report.md." },
    { role: "assistant", content: "", tool_calls: [{ id: "call_write", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: 'Set-Content -Path "G:\\Project\\report.md" -Value "ready"' }) } }] },
    { role: "tool", tool_call_id: "call_write", content: "Exit code: 0" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_read_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: 'Get-Content -Path "G:\\Project\\report.md"' }) } }] },
    { role: "tool", tool_call_id: "call_read_1", content: "ready" },
  ];
  const nextCommand = 'Get-ChildItem -Path "G:\\Project"';
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: { role: "assistant", content: "", tool_calls: [{ id: "call_read_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nextCommand }) } }] },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Create and verify G:\\Project\\report.md." }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  assert.equal(JSON.parse(call.arguments).command, nextCommand);
});

test("a successful custom patch resets earlier inspection nudges before verification", () => {
  const nudge = "Write-Output 'Anti-Codex completed the inspection phase after detecting repeated read-only calls. Do not issue another read or listing command.'; exit 0";
  const readCli = 'Get-Content -LiteralPath "G:\\Project\\cli.mjs" -TotalCount 240';
  const readReadme = 'Get-Content -LiteralPath "G:\\Project\\README.md" -TotalCount 80';
  const chatMessages = [
    { role: "user", content: "Modify cli.mjs and README.md, then run node --check, npm test, and verify both files." },
    { role: "assistant", content: "", tool_calls: [{ id: "call_read_cli", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: readCli }) } }] },
    { role: "tool", tool_call_id: "call_read_cli", content: "cli source" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_read_readme", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: readReadme }) } }] },
    { role: "tool", tool_call_id: "call_read_readme", content: "readme source" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_nudge_1", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nudge }) } }] },
    { role: "tool", tool_call_id: "call_nudge_1", content: "implementation reminder" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_nudge_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: nudge }) } }] },
    { role: "tool", tool_call_id: "call_nudge_2", content: "implementation reminder" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ content: "*** Begin Patch\n*** End Patch" }) } }] },
    { role: "tool", tool_call_id: "call_patch", content: "Exit code: 0\nSuccess. Updated the following files:\nM G:\\Project\\cli.mjs\nM G:\\Project\\README.md\n" },
  ];
  const verification = 'node --check cli.mjs; npm test; Get-Content -LiteralPath "G:\\Project\\README.md" -TotalCount 1';
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: { role: "assistant", content: "", tool_calls: [{ id: "call_verify", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: verification, workdir: "G:\\Project" }) } }] },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Modify cli.mjs and README.md, then run node --check, npm test, and verify both files." }] }],
  }, null, { chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  assert.ok(call);
  assert.equal(JSON.parse(call.arguments).command, verification);
});

test("chatToResponsesFormat keeps model-led report-site commands without deterministic guard", () => {
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_report_artifact",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "$targetDir = \"C:\\Temp\\report-site\"\nSet-Content -Path \"$targetDir\\README.md\" -Value \"wrong\"\nSet-Content -Path \"$targetDir\\done.txt\" -Value \"DESKTOP_SMALL_PROJECT\"",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Search the web for recent Codex updates, then create report.md, index.html and done.txt in C:\\Temp\\report-site. Do not create README.md. report.md must include source URLs and done.txt must contain UI_REPORT_SITE_SMOKE_20260701.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /UI_REPORT_SITE_SMOKE_20260701/);
  assert.doesNotMatch(args.command, /DESKTOP_SMALL_PROJECT/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
  assert.doesNotMatch(args.command, /\$__antiCodexReportSite = \$true/);
});

test("report-site artifact requests start with the report-site tool example, not the marker guard", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Search the web for recent Codex updates, then create report.md, index.html and done.txt in C:\\Temp\\report-site. report.md must include source URLs and done.txt must contain UI_REPORT_SITE_SMOKE_20260702.",
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });

  const completion = deterministicArtifactToolCallCompletion(request, chatBody);
  assert.ok(completion);
  const args = JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments);
  assert.match(args.command, /Anti-Codex report-site tool example/);
  assert.match(args.command, /report\.md/);
  assert.match(args.command, /index\.html/);
  assert.match(args.command, /UI_REPORT_SITE_SMOKE_20260702/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
  assert.equal(requestNeedsWebBackedArtifactOutput(request), false);
});

test("complex project requests do not start with the deterministic artifact guard", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. sources.json must contain sourceCount evidence and done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const completion = deterministicArtifactToolCallCompletion(request, chatBody);
  assert.equal(completion, null);
  assert.equal(requestNeedsWebBackedArtifactOutput(request), false);
});

test("complex project web searches do not short-circuit to deterministic summaries", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Search the web for recent Codex updates, then create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
    tool_choice: { type: "function", function: { name: "web_search" } },
    tools: [
      { type: "function", function: { name: "web_search", parameters: { type: "object" } } },
      { type: "function", function: { name: "shell_command", parameters: { type: "object" } } },
    ],
  };

  assert.equal(requestNeedsInternalWebTools(request), true);
  assert.equal(requestNeedsWebBackedArtifactOutput(request), false);
  assert.equal(shouldUseDeterministicInternalWebSearchResponse(request), false);
});

test("plain web searches can still use deterministic internal web summaries", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Search the web for recent Codex release notes and summarize the result." }],
    }],
    tool_choice: { type: "function", function: { name: "web_search" } },
    tools: [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }],
  };

  assert.equal(requestNeedsInternalWebTools(request), true);
  assert.equal(shouldUseDeterministicInternalWebSearchResponse(request), true);
});

test("specific non-web tool choice is not preempted by URL-bearing artifact text", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create report.md from https://developers.openai.com/codex/changelog and call write_report_site exactly once.",
      }],
    }],
    tool_choice: { type: "function", function: { name: "write_report_site" } },
    tools: [
      { type: "function", function: { name: "write_report_site", parameters: { type: "object" } } },
      { type: "function", function: { name: "web_fetch", parameters: { type: "object" } } },
    ],
  };

  assert.equal(requestNeedsInternalWebTools(request), false);
  assert.equal(shouldUseDeterministicInternalWebSearchResponse(request), false);
});

test("complex project web prefetch keeps external Codex tools for model-led work", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  const userText = "Search the web for recent Codex updates, then create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.";
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name) => {
    assert.equal(name, "web_search");
    return JSON.stringify({ ok: true, results: [{ title: "Codex update", url: "https://example.com/codex", snippet: "Codex update" }] });
  };

  try {
    let upstreamBody;
    const completion = await callAntigravityWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: userText }],
      tools: [
        { type: "function", function: { name: "web_search", parameters: { type: "object" } } },
        { type: "function", function: { name: "shell_command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
      ],
      tool_choice: { type: "function", function: { name: "web_search" } },
    }, {
      callQueued: async (body) => {
        upstreamBody = structuredClone(body);
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_complex_project_shell",
                type: "function",
                function: { name: "shell_command", arguments: JSON.stringify({ command: "echo complex-ok" }) },
              }],
            },
            finish_reason: "stop",
          }],
        };
      },
    });

    assert.deepEqual(upstreamBody.tools.map(tool => tool.function.name), ["shell_command"]);
    assert.equal(upstreamBody.tool_choice, "auto");
    assert.match(upstreamBody.messages.at(-1).content, /calling the exposed external Codex tool/);
    assert.doesNotMatch(upstreamBody.messages.at(-1).content, /Answer the original user request now/);
    assert.equal(completion.choices[0].message.tool_calls[0].function.name, "shell_command");
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("chatToResponsesFormat does not append deterministic guard to complex project tool calls", () => {
  const fmt = chatToResponsesFormat({
    id: "chatcmpl_complex_tool",
    created: 1,
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_complex_tool",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "$dir = \"C:\\Temp\\desktop-visible-complex-project\\run\"\nnode --version",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
});

test("chatToResponsesFormat does not replace fragile complex project shell commands with a safety repair", () => {
  const fmt = chatToResponsesFormat({
    id: "chatcmpl_complex_fragile_tool",
    created: 1,
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_complex_fragile_tool",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "$env:HTML = ''<!DOCTYPE html><html><body>broken</body></html>''\n[System.IO.File]::WriteAllText('C:\\Temp\\desktop-visible-complex-project\\run\\index.html', $env:HTML)",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.doesNotMatch(args.command, /Anti-Codex complex artifact safety repair/);
  assert.doesNotMatch(args.command, /Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)/);
  assert.match(args.command, /\$env:HTML/);
  assert.match(args.command, /WriteAllText/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
});

test("complex project JavaScript shell commands escape raw Chinese for Windows transport", () => {
  const fmt = chatToResponsesFormat({
    id: "chatcmpl_complex_cjk_tool",
    created: 1,
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_complex_cjk_tool",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "node -e \"const fs=require('fs');fs.writeFileSync('report.md','# Codex 与 OpenAI 更新资料分析报告','utf8');fs.writeFileSync('index.html','<h1>中文仪表盘</h1>','utf8')\"",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.doesNotMatch(args.command, /与|更新资料分析报告|中文仪表盘/);
  assert.match(args.command, /\\u4e0e/);
  assert.match(args.command, /\\u4e2d\\u6587\\u4eea\\u8868\\u76d8/);
  assert.doesNotMatch(args.command, /Anti-Codex complex artifact safety repair/);
});

test("complex project JavaScript shell commands normalize double escaped unicode text", () => {
  const fmt = chatToResponsesFormat({
    id: "chatcmpl_complex_double_unicode_tool",
    created: 1,
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_complex_double_unicode_tool",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "node -e \"const fs=require('fs');fs.writeFileSync('report.md','# Codex \\\\u4e2d\\\\u6587','utf8')\"",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /# Codex \\u4e2d\\u6587/);
  assert.doesNotMatch(args.command, /\\\\u4e2d/);
});

test("complex project JavaScript shell commands normalize double escaped newlines", () => {
  const fmt = chatToResponsesFormat({
    id: "chatcmpl_complex_double_newline_tool",
    created: 1,
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_complex_double_newline_tool",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "node -e \"const fs=require('fs');fs.writeFileSync('report.md','# Codex\\\\n\\\\n真实来源','utf8')\"",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /# Codex\\n\\n\\u771f\\u5b9e\\u6765\\u6e90/);
  assert.doesNotMatch(args.command, /\\\\n/);
});

test("complex project JavaScript shell commands normalize escaped HTML tags", () => {
  const fmt = chatToResponsesFormat({
    id: "chatcmpl_complex_html_entity_tool",
    created: 1,
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_complex_html_entity_tool",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "node -e \"const fs=require('fs');fs.writeFileSync('index.html','&lt;!DOCTYPE html&gt;&lt;html lang=\\\"zh-CN\\\"&gt;&lt;body&gt;ok&lt;/body&gt;&lt;/html&gt;','utf8')\"",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\desktop-visible-complex-project\\run. done.txt must contain UI_COMPLEX_PROJECT_SMOKE_20260701.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /<!DOCTYPE html>/);
  assert.match(args.command, /<html lang=/);
  assert.doesNotMatch(args.command, /&lt;html/);
});

test("agentic visible step-flow requests do not start with the deterministic artifact guard", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
          "1. 先在可见回复里单独写一行：阶段1：准备创建文件。",
          "2. 然后用工具创建 index.html、README.md、done.txt。",
          "3. 文件创建后，在可见回复里单独写一行：阶段2：准备验证文件。",
          "done.txt 必须只包含 UI_AGENTIC_STEP_FLOW_SMOKE_20260701。",
        ].join("\n"),
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const promptText = JSON.stringify(chatBody);

  assert.match(promptText, /Exact local-file tool-call pattern for this agentic step-flow task/);
  assert.match(promptText, /After the tool returns, the next step must be 阶段2：准备验证文件/);
  assert.match(promptText, /Do not inspect parent directories/);
  assert.equal(deterministicArtifactToolCallCompletion(request, chatBody), null);
});

test("agentic visible step-flow follow-up prompt asks for phase2 verification only", () => {
  const marker = "UI_AGENTIC_STEP_FLOW_SMOKE_20260701";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
          "1. 先在可见回复里单独写一行：阶段1：准备创建文件。",
          "2. 然后用工具创建 index.html、README.md、done.txt。",
          "3. 文件创建后，在可见回复里单独写一行：阶段2：准备验证文件。",
          `done.txt 必须只包含 ${marker}。`,
        ].join("\n"),
      }],
    }, {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "阶段1：准备创建文件" }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const promptText = JSON.stringify(chatBody);

  assert.match(promptText, /Agentic step-flow second phase/);
  assert.match(promptText, /阶段2：准备验证文件/);
  assert.match(promptText, /verify only the exact target directory/);
  assert.doesNotMatch(promptText, /valid first assistant response shape/);
});

test("agentic visible step-flow rejects bare tool-name text as unfinished tool work", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
          "然后用工具创建 index.html、README.md、done.txt。",
          "done.txt 必须只包含 UI_AGENTIC_STEP_FLOW_SMOKE_20260701。",
        ].join("\n"),
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };

  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: { role: "assistant", content: "write_to_file" },
      finish_reason: "stop",
    }],
  }, request, null, { strictTools: true });

  assert.equal(fmt.output[0].type, "message");
  assert.match(fmt.output[0].content[0].text, /Anti-Codex 已拦截/);
  assert.notEqual(fmt.output[0].content[0].text.trim(), "write_to_file");
});

test("agentic visible step-flow shell writes are normalized to UTF-8 without BOM", () => {
  const marker = "UI_AGENTIC_STEP_FLOW_SMOKE_20260701";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
          "1. 先在可见回复里单独写一行：阶段1：准备创建文件。",
          "2. 然后用工具创建 index.html、README.md、done.txt。",
          "3. 文件创建后，在可见回复里单独写一行：阶段2：准备验证文件。",
          `done.txt 必须只包含 ${marker}。`,
        ].join("\n"),
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  const completion = {
    id: "chatcmpl_agentic_old_encoding",
    created: 1,
    model: "gemini-pro-agent",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "阶段1：准备创建文件。",
        tool_calls: [{
          id: "call_agentic_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: `[System.IO.File]::WriteAllText("C:\\Temp\\agentic-step-flow\\done.txt", "${marker}", [System.Text.Encoding]::UTF8)`,
            }),
          },
        }],
      },
    }],
  };

  const fmt = chatToResponsesFormat(completion, request, chatBody._routing, { strictTools: true });
  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /\$__antiCodexUtf8NoBom = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(args.command, /WriteAllText\("C:\\Temp\\agentic-step-flow\\done\.txt", "UI_AGENTIC_STEP_FLOW_SMOKE_20260701", \$__antiCodexUtf8NoBom\)/);
  assert.doesNotMatch(args.command, /WriteAllText\([^)]*\[System\.Text\.Encoding\]::UTF8\)/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
});

test("agentic visible step-flow rejects user prompt echo as unfinished tool work", () => {
  const prompt = [
    "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
    "然后用工具创建 index.html、README.md、done.txt。",
    "done.txt 必须只包含 UI_AGENTIC_STEP_FLOW_SMOKE_20260701。",
  ].join("\n");
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };

  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: { role: "assistant", content: "请完成一个多阶段可见任务工作目录是 C:Tempagentic-step-flow" },
      finish_reason: "stop",
    }],
  }, request, null, { strictTools: true });

  assert.equal(fmt.output[0].type, "message");
  assert.match(fmt.output[0].content[0].text, /Anti-Codex 已拦截/);
  assert.doesNotMatch(fmt.output[0].content[0].text, /^请完成一个多阶段可见任务/);
});

test("chatToResponsesFormat keeps model-led coding project commands without deterministic guard", () => {
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_coding_artifact",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "$targetDir = \"C:\\Temp\\coding\"\nSet-Content -Path \"$targetDir\\done.txt\" -Value \"DESKTOP_SMALL_PROJECT\" -Encoding UTF8",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\coding. word-tally.mjs must export tallyWords and done.txt must contain DESKTOP_CODING_PROJECT_DONE_20260627.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /DESKTOP_CODING_PROJECT_DONE_20260627/);
  assert.doesNotMatch(args.command, /DESKTOP_SMALL_PROJECT/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
  assert.doesNotMatch(args.command, /export function tallyWords/);
  assert.doesNotMatch(args.command, /node --test/);
});

test("local coding project artifact requests start with a project tool call without marker guard", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\coding. word-tally.mjs must export tallyWords and done.txt must contain DESKTOP_CODING_PROJECT_DONE_20260627.",
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });

  const completion = deterministicArtifactToolCallCompletion(request, chatBody);
  assert.ok(completion);
  const call = completion.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "shell_command");
  assert.match(call.function.arguments, /word-tally\.mjs/);
  assert.match(call.function.arguments, /node --test word-tally\.test\.mjs/);
  assert.doesNotMatch(call.function.arguments, /Anti-Codex exact artifact marker guard/);
  assert.equal(requestNeedsWebBackedArtifactOutput(request), false);
});

test("local coding project artifact requests work without visible tool-list shape", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_20260704001";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请在 C:\\Temp\\desktop-visible-coding-project\\run 里创建 package.json、word-tally.mjs、word-tally.test.mjs、done.txt。done.txt 必须只包含 ${marker}。运行 node --test word-tally.test.mjs。`,
      }],
    }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  chatBody.tools = [];

  const completion = deterministicArtifactToolCallCompletion(request, chatBody);
  assert.ok(completion);
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "shell_command");
  assert.match(completion.choices[0].message.tool_calls[0].function.arguments, new RegExp(marker));
});

test("local coding project artifact requests with Chinese text start with a project tool call", () => {
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "在本地创建 Node.js CLI 小项目，目录是 C:\\Temp\\coding。请创建 package.json、word-tally.mjs、word-tally.test.mjs、done.txt。done.txt 必须包含 DESKTOP_CODING_PROJECT_DONE_20260701。",
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });

  const completion = deterministicArtifactToolCallCompletion(request, chatBody);
  assert.ok(completion);
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "shell_command");
  assert.match(completion.choices[0].message.tool_calls[0].function.arguments, /word-tally\.mjs/);
  assert.equal(requestNeedsWebBackedArtifactOutput(request), false);
});

test("multi-turn local project follow-up is model-led and does not start with deterministic guard", () => {
  const firstPrompt = "Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\multi. done.txt must contain UI_MULTI_TURN_PROJECT_SMOKE_20260627_FIRST.";
  const followupPrompt = "Continue the same project in C:\\Temp\\multi. Modify word-tally.mjs so it also exports uniqueWords(text). Update word-tally.test.mjs and create CHANGELOG.md plus followup.txt containing exactly UI_MULTI_TURN_PROJECT_SMOKE_20260627.";
  const request = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: firstPrompt }] },
      { type: "function_call", call_id: "call_first", name: "shell_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_first", output: "UI_MULTI_TURN_PROJECT_SMOKE_20260627_FIRST" },
      { type: "message", role: "user", content: [{ type: "input_text", text: followupPrompt }] },
    ],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });

  const completion = deterministicArtifactToolCallCompletion(request, chatBody);
  assert.equal(completion, null);
  assert.equal(requestNeedsWebBackedArtifactOutput(request), false);
});

test("multi-turn marker-only Set-Content writes are normalized without deterministic guard", () => {
  const marker = "UI_MULTI_TURN_PROJECT_SMOKE_20260701002";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Continue the same project in C:\\Temp\\multi. Modify word-tally.mjs so it also exports uniqueWords(text). Update word-tally.test.mjs and create CHANGELOG.md plus followup.txt containing exactly ${marker}.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_followup",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: `Set-Content -Path (Join-Path $dir "followup.txt") -Value '${marker}' -Encoding utf8`,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /\bfollowup\.txt\b/);
  assert.match(args.command, /\s-NoNewline\b/);
  assert.match(args.command, /exact marker-only write normalization/);
  assert.match(args.command, /WriteAllText\(\(Join-Path \$__antiCodexMarkerOnlyDir 'followup\.txt'\)/);
  assert.match(args.command, /WriteAllText\(\(Join-Path \$__antiCodexMarkerOnlyDir 'CHANGELOG\.md'\)/);
  assert.match(args.command, /Added uniqueWords follow-up/);
  assert.doesNotMatch(args.command, /Join-Path \$__antiCodexMarkerOnlyDir 'done\.txt'/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
});

test("multi-turn relative dotnet writes run from the Set-Location artifact directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-multi-turn-dotnet-write-"));
  const targetPath = path.join(root, "ui_multi_turn_project_smoke_20260712001");
  fs.mkdirSync(targetPath, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const marker = "UI_MULTI_TURN_PROJECT_SMOKE_20260712001";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Continue the same project: ${targetPath}. Modify word-tally.mjs so it exports uniqueWords(text), update word-tally.test.mjs, and create followup.txt containing exactly ${marker}.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const command = [
    "$__antiCodexUtf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    `Set-Location \"${targetPath}\"`,
    "[System.IO.File]::WriteAllText(\"word-tally.mjs\", \"export function uniqueWords() { return []; }\", $__antiCodexUtf8NoBom)",
    `Set-Content -Path followup.txt -Value '${marker}' -NoNewline`,
  ].join("\n");
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_relative_dotnet_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command, workdir: root }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.workdir, targetPath);
  assert.match(args.command, /WriteAllText\(\"word-tally\.mjs\"/);
});

test("multi-turn first marker normalization does not create followup.txt", () => {
  const marker = "UI_MULTI_TURN_PROJECT_SMOKE_20260701002_FIRST";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\multi. done.txt must contain ${marker}.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_first",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: `Set-Content -Path (Join-Path $dir "done.txt") -Value '${marker}' -Encoding utf8`,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /Join-Path \$__antiCodexMarkerOnlyDir 'done\.txt'/);
  assert.doesNotMatch(args.command, /followup\.txt/);
});

test("local artifact tool calls block Antigravity brain transcript detours", () => {
  const marker = "UI_MULTI_TURN_PROJECT_SMOKE_20260701003_FIRST";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\multi. Do not inspect Antigravity brain, transcript, history, or log directories. done.txt must contain ${marker}.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_detour",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: String.raw`Get-Content -Path C:\Users\XD\.gemini\antigravity\brain\run\.system_generated\logs\transcript.jsonl; Get-ChildItem C:\Temp\multi`,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /blocked forbidden Antigravity brain\/transcript\/history\/log inspection/);
  assert.doesNotMatch(args.command, /\.gemini\\antigravity\\brain/i);
  assert.doesNotMatch(args.command, /transcript\.jsonl/i);
  assert.doesNotMatch(args.command, new RegExp(marker));
});

test("local artifact tool calls allow commands that only repeat forbidden history guidance", () => {
  const marker = "UI_MULTI_TURN_PROJECT_SMOKE_GUIDANCE_123_FIRST";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create package.json, word-tally.mjs, word-tally.test.mjs and done.txt in C:\\Temp\\multi. Do not inspect Antigravity brain, transcript, history, or log directories. done.txt must contain ${marker}.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_guidance_text",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: String.raw`$dir='C:\Temp\multi'; New-Item -ItemType Directory -Path $dir -Force | Out-Null; Set-Content -Path (Join-Path $dir 'done.txt') -Value '${marker}' -NoNewline; Write-Output 'Do not inspect Antigravity brain, transcript, history, or log directories.'`,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.doesNotMatch(args.command, /blocked forbidden Antigravity brain\/transcript\/history\/log inspection/);
  assert.match(args.command, /Anti-Codex exact marker-only write normalization/);
  assert.match(args.command, /done\.txt/);
});

test("complex project shell commands inherit the artifact workdir when using relative paths", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_WORKDIR_123";
  const artifactDir = "C:\\Temp\\anticodex-complex-workdir";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create a Node.js project in ${artifactDir}. Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, and done.txt. done.txt must contain ${marker}.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_complex_relative",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "node -e \"require('fs').writeFileSync('package.json','{}','utf8')\"",
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.workdir, artifactDir);
  assert.match(args.command, /package\.json/);
});

test("artifact directory creation commands run from the existing parent directory", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_WORKDIR_PARENT_123";
  const artifactDir = path.join(os.tmpdir(), `anticodex-missing-artifact-${Date.now()}`);
  fs.rmSync(artifactDir, { recursive: true, force: true });
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create a tiny Node.js project in ${artifactDir}. Create package.json, word-tally.mjs, word-tally.test.mjs, and done.txt. done.txt must contain ${marker}.`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_create_artifact_dir",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: `[System.IO.Directory]::CreateDirectory('${artifactDir}') | Out-Null; [System.IO.File]::WriteAllText('${artifactDir}\\done.txt','${marker}')`,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.workdir, path.dirname(artifactDir));
});

test("explicit missing artifact workdir is repaired to the parent directory", () => {
  const marker = "UI_AGENTIC_STEP_FLOW_SMOKE_WORKDIR_123";
  const artifactDir = path.join(os.tmpdir(), `anticodex-missing-explicit-workdir-${Date.now()}`);
  fs.rmSync(artifactDir, { recursive: true, force: true });
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请完成一个多阶段可见任务，工作目录是 ${artifactDir}。创建 index.html、README.md、done.txt。done.txt 必须只包含 ${marker}。`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_bad_workdir",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: `New-Item -ItemType Directory -Force -Path "${artifactDir}"; Set-Content -Path "${path.join(artifactDir, "done.txt")}" -Value "${marker}"`,
              workdir: artifactDir,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.workdir, path.dirname(artifactDir));
});

test("complex project exec_command repairs an explicit missing artifact workdir", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_WORKDIR_456";
  const artifactDir = path.join(os.tmpdir(), `anticodex-missing-complex-workdir-${Date.now()}`);
  fs.rmSync(artifactDir, { recursive: true, force: true });
  const helper = "G:\\Trae-Project\\Anti-Codex\\deepcodex\\scripts\\write-anticodex-complex-project-artifact.mjs";
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个真实的中文长任务。",
          `工作目录：${artifactDir}`,
          `最终标记：${marker}`,
          "必须创建 package.json、codex-update-analyzer.mjs、sources.json、report.md、index.html 和 done.txt。",
          `第一条工具调用必须执行：node \"${helper}\" --dir \"${artifactDir}\" --marker \"${marker}\"`,
        ].join("\n"),
      }],
    }],
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
  };
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_missing_complex_workdir",
          type: "function",
          function: {
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: `node \"${helper}\" --dir \"${artifactDir}\" --marker \"${marker}\"`,
              workdir: artifactDir,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.workdir, path.dirname(artifactDir));
});

test("exec_command runs a self-creating --dir command from the nearest existing parent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-self-creating-workdir-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, "reports", "new-project");
  const helper = path.join(root, "create-project.mjs");
  fs.writeFileSync(helper, "", "utf8");
  const request = {
    model: "gemini-3.5-flash-low",
    input: "Run the provided project generator command.",
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
  };
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_self_creating_workdir",
          type: "function",
          function: {
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: `node \"${helper}\" --dir \"${artifactDir}\"`,
              workdir: artifactDir,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.workdir, root);
});

test("repo file edit smoke markers do not trigger local artifact marker guard", () => {
  const fmt = chatToResponsesFormat({
    model: "gemini-pro-agent",
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_repo_multi",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: "Set-Content -Path \"C:\\Temp\\fixture\\status-dashboard.mjs\" -Value \"export function normalizeStatus(){}\"",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, {
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Work only inside C:\\Temp\\fixture. Implement status-dashboard.mjs and run status-dashboard.test.mjs. Put exactly UI_REPO_MULTI_FILE_EDIT_SMOKE_20260627 on the final line.",
      }],
    }],
  });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /status-dashboard\.mjs/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
  assert.doesNotMatch(args.command, /UI_REPO_MULTI_FILE_EDIT_SMOKE_20260627/);
});

test("autonomous reasoning smoke does not use deterministic artifact or web-backed guards", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_20260701";
  const prompt = `请作为 Codex 风格开发代理，自主完成任务。工作目录：C:\\Temp\\desktop-visible-autonomous-reasoning\\run。最终标记：${marker}。创建 package.json, codex-update-analyzer.mjs, sources.json, report.md, index.html, done.txt。`;
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });

  assert.equal(deterministicArtifactToolCallCompletion(request, chatBody), null);
  assert.equal(requestNeedsWebBackedArtifactOutput(request), false);
});

test("autonomous local projects do not prefetch example URLs without an explicit web action", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_20260712003";
  const prompt = [
    "请自主完成一个本地研究+代码+报告任务。",
    `工作目录：C:\\Temp\\desktop-visible-autonomous-reasoning\\run，最终标记：${marker}。`,
    "创建 package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt。",
    "分析器读取 sources.json 并打印 sourceCount 和 codexMentionCount。",
    "sources.json 可使用 https://openai.com/codex/、https://openai.com/news/、https://developers.openai.com/codex/，报告写真实来源。",
  ].join("\n");
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };

  assert.equal(requestNeedsInternalWebTools(request), false);
  assert.equal(shouldUseDeterministicInternalWebSearchResponse(request), false);
});

test("autonomous generated artifacts redirect apply_patch to shell guidance", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_20260712004";
  const targetPath = "C:\\Temp\\desktop-visible-autonomous-reasoning\\run";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create package.json, codex-update-analyzer.mjs, sources.json, report.md, index.html, and done.txt in ${targetPath}. done.txt must equal ${marker}.`,
      }],
    }],
  };
  const routing = {
    apply_patch: {
      type: "custom",
      codexName: "apply_patch",
      parameters: { type: "string" },
    },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_generated_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              content: `*** Begin Patch\n*** Add File: ${targetPath}\\done.txt\n+${marker}\n*** End Patch`,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  assert.equal(formatted.output.some(item => item.type === "custom_tool_call"), false);
  const call = formatted.output.find(item => item.type === "function_call");
  assert.equal(call.name, "exec_command");
  const args = JSON.parse(call.arguments);
  assert.match(args.cmd, /blocked apply_patch for generated artifacts/i);
  assert.match(args.cmd, /WriteAllText/);
  assert.match(args.cmd, /done\.txt/);
  assert.doesNotMatch(args.cmd, new RegExp(marker));
});

test("autonomous shell writes normalize done.txt to exact UTF-8 marker bytes", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_EXACT_DONE_20260712";
  const targetPath = "C:\\Temp\\desktop-visible-autonomous-reasoning\\run";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Create the autonomous project in ${targetPath}. done.txt must contain only ${marker}.`,
      }],
    }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
    },
  };
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_autonomous_done_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: `Set-Content -Path done.txt -Value '${marker}' -Encoding utf8`,
              workdir: targetPath,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /Anti-Codex exact marker-only write normalization/);
  assert.match(args.command, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(args.command, /WriteAllText/);
  assert.match(args.command, new RegExp(marker));
});

test("autonomous repair shell guidance anchors an explicit file target to its parent directory", (t) => {
  const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-artifact-file-guidance-"));
  t.after(() => fs.rmSync(targetPath, { recursive: true, force: true }));
  const analyzerPath = path.join(targetPath, "codex-update-analyzer.mjs");
  fs.writeFileSync(analyzerPath, "export const sourceCount = 3;\n", "utf8");
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_FILE_GUIDANCE_20260712";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `继续当前同一个任务。只允许修改 ${analyzerPath}，并删除同目录中误建的 setup.js。都成功后最后一行只输出 ${marker}。`,
      }],
    }],
  };
  const routing = {
    apply_patch: {
      type: "custom",
      codexName: "apply_patch",
      parameters: { type: "string" },
    },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_generated_file_target_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              content: `*** Begin Patch\n*** Add File: ${targetPath}\\done.txt\n+${marker}\n*** End Patch`,
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.workdir, targetPath);
  assert.ok(args.cmd.includes(`Target directory: ${targetPath}`));
  assert.ok(!args.cmd.includes(`Target directory: ${analyzerPath}`));
});

test("autonomous generated artifact repairs preserve existing-file update patches", (t) => {
  const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-artifact-repair-"));
  t.after(() => fs.rmSync(targetPath, { recursive: true, force: true }));
  const analyzerPath = path.join(targetPath, "codex-update-analyzer.mjs");
  fs.writeFileSync(analyzerPath, "const sourceCount = 3;\n", "utf8");
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_REPAIR_PATCH_20260712";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Continue the autonomous task. Working directory: ${targetPath}. Repair codex-update-analyzer.mjs so it exports summarizeSources. done.txt must equal ${marker}.`,
      }],
    }],
  };
  const routing = {
    apply_patch: {
      type: "custom",
      codexName: "apply_patch",
      parameters: { type: "string" },
    },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_generated_repair_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              content: "*** Begin Patch\n*** Update File: codex-update-analyzer.mjs\n@@\n-const sourceCount = 3;\n+export const summarizeSources = () => ({ sourceCount: 3 });\n*** End Patch",
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "custom_tool_call");
  assert.ok(call, "an update-only repair patch for an existing artifact must reach Codex");
  assert.equal(call.name, "apply_patch");
  assert.match(call.input, /\*\*\* Update File:/);
  assert.match(call.input, /codex-update-analyzer\.mjs/);
  assert.doesNotMatch(call.input, /\*\*\* Add File:/);
});

test("generated JSON artifact repairs strip accidental patch separator content", (t) => {
  const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-json-repair-"));
  t.after(() => fs.rmSync(targetPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetPath, "config.json"), '{"mode":"repaired"}\n', "utf8");
  fs.writeFileSync(path.join(targetPath, "diagnosis.json"), '{"fixed":true}\n', "utf8");
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_JSON_SEPARATOR_20260713";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Continue the autonomous task. Working directory: ${targetPath}. Repair config.json and diagnosis.json. done.txt must equal ${marker}.`,
      }],
    }],
  };
  const routing = {
    apply_patch: { type: "custom", codexName: "apply_patch", parameters: { type: "string" } },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const patch = [
    "*** Begin Patch",
    "*** Update File: config.json",
    "@@",
    '-{"mode":"repaired"}',
    "+----",
    '+{"mode":"repaired","reason":"CONFIG_MISSING"}',
    "*** Update File: diagnosis.json",
    "@@",
    '-{"fixed":true}',
    "+----",
    '+{"fixed":true,"launchCount":1}',
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_json_separator_repair",
          type: "function",
          function: { name: "apply_patch", arguments: JSON.stringify({ content: patch }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "custom_tool_call");
  assert.ok(call);
  assert.doesNotMatch(call.input, /^\+----\s*$/m);
  assert.match(call.input, /CONFIG_MISSING/);
  assert.match(call.input, /launchCount/);
});

test("autonomous generated artifact repairs convert existing-file Add patches to updates", (t) => {
  const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-artifact-replace-"));
  t.after(() => fs.rmSync(targetPath, { recursive: true, force: true }));
  const analyzerPath = path.join(targetPath, "codex-update-analyzer.mjs");
  fs.writeFileSync(analyzerPath, "const sourceCount = 3;\n", "utf8");
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_REPLACE_PATCH_20260712";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Working directory: ${targetPath}\nRepair codex-update-analyzer.mjs so it exports summarizeSources. done.txt must equal ${marker}.`,
      }],
    }],
  };
  const routing = {
    apply_patch: { type: "custom", codexName: "apply_patch", parameters: { type: "string" } },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_generated_replace_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              content: "*** Begin Patch\n*** Add File: codex-update-analyzer.mjs\n+export function summarizeSources() {\n+  return { sourceCount: 3 };\n+}\n*** End Patch",
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "custom_tool_call");
  assert.ok(call, "an existing generated artifact may be replaced through a normalized repair patch");
  assert.match(call.input, /\*\*\* Update File:/);
  assert.match(call.input, /-const sourceCount = 3;/);
  assert.match(call.input, /\+export function summarizeSources/);
  assert.doesNotMatch(call.input, /\*\*\* Add File:/);
});

test("autonomous generated artifact repairs normalize unified diffs before safety checks", (t) => {
  const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-artifact-unified-"));
  t.after(() => fs.rmSync(targetPath, { recursive: true, force: true }));
  const analyzerPath = path.join(targetPath, "codex-update-analyzer.mjs");
  fs.writeFileSync(analyzerPath, "const sourceCount = 3;\n", "utf8");
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_UNIFIED_PATCH_20260712";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Working directory: ${targetPath}\nRepair codex-update-analyzer.mjs so it exports summarizeSources. done.txt must equal ${marker}.`,
      }],
    }],
  };
  const routing = {
    apply_patch: { type: "custom", codexName: "apply_patch", parameters: { type: "string" } },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_generated_unified_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              content: "--- codex-update-analyzer.mjs\n+++ codex-update-analyzer.mjs\n@@ -1 +1 @@\n-const sourceCount = 3;\n+export const summarizeSources = () => ({ sourceCount: 3 });",
            }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "custom_tool_call");
  assert.ok(call, "a repair unified diff must be normalized and forwarded");
  assert.match(call.input, /\*\*\* Begin Patch/);
  assert.match(call.input, /\*\*\* Update File:/);
  assert.match(call.input, /summarizeSources/);
});

test("autonomous repair extracts the latest single-file target from a mixed git diff patch", (t) => {
  const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-artifact-mixed-git-"));
  t.after(() => fs.rmSync(targetPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetPath, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  fs.writeFileSync(path.join(targetPath, "codex-update-analyzer.mjs"), "const sourceCount = 3;\n", "utf8");
  fs.writeFileSync(path.join(targetPath, "done.txt"), "UI_AUTONOMOUS_REASONING_SMOKE_MIXED_GIT_20260712", "utf8");
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_MIXED_GIT_20260712";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `继续当前任务，只修复工作目录 ${targetPath} 中的 codex-update-analyzer.mjs。它必须导出 summarizeSources，最后一行输出 ${marker}。`,
      }],
    }],
  };
  const routing = {
    apply_patch: { type: "custom", codexName: "apply_patch", parameters: { type: "string" } },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const mixedPatch = [
    "*** Begin Patch",
    "*** Update File: package.json",
    "@@",
    "+{\"name\":\"replacement\",\"type\":\"module\"}",
    "diff --git a/codex-update-analyzer.mjs b/codex-update-analyzer.mjs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/codex-update-analyzer.mjs",
    "@@",
    "+export function summarizeSources() {",
    "+  return { sourceCount: 3, codexMentionCount: 1 };",
    "+}",
    "diff --git a/done.txt b/done.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/done.txt",
    "@@",
    `+${marker}`,
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_generated_mixed_git_patch",
          type: "function",
          function: { name: "apply_patch", arguments: JSON.stringify({ content: mixedPatch }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "custom_tool_call");
  assert.ok(call, "the in-scope analyzer repair must survive a malformed multi-file model patch");
  assert.match(call.input, /\*\*\* Update File: .*codex-update-analyzer\.mjs/);
  assert.match(call.input, /summarizeSources/);
  assert.match(call.input, /-const sourceCount = 3;/);
  assert.doesNotMatch(call.input, /package\.json/);
  assert.doesNotMatch(call.input, /done\.txt/);
  assert.doesNotMatch(call.input, /diff --git/);
});

test("autonomous repair redirects destructive inspection patches to a read", (t) => {
  const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-artifact-inspection-patch-"));
  t.after(() => fs.rmSync(targetPath, { recursive: true, force: true }));
  const analyzerPath = path.join(targetPath, "codex-update-analyzer.mjs");
  fs.writeFileSync(analyzerPath, "const sourceCount = 3;\n", "utf8");
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_INSPECTION_PATCH_20260712";
  const prompt = `继续当前同一个任务，只修复工作目录 ${targetPath} 中的 codex-update-analyzer.mjs。它必须导出 summarizeSources，最后输出 ${marker}。`;
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
  };
  const routing = {
    apply_patch: { type: "custom", codexName: "apply_patch", parameters: { type: "string" } },
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const inspectionPatch = [
    "*** Begin Patch",
    `*** Update File: ${analyzerPath}`,
    "@@",
    "+import fs from 'fs';",
    `+throw new Error(\"FILE_CONTENT:\\n\" + fs.readFileSync('${analyzerPath.replaceAll("\\", "\\\\")}', 'utf8'));`,
    "*** End Patch",
  ].join("\n");
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_destructive_inspection_patch",
          type: "function",
          function: { name: "apply_patch", arguments: JSON.stringify({ content: inspectionPatch }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  assert.equal(formatted.output.some(item => item.type === "custom_tool_call"), false);
  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call, "destructive inspection must become a safe shell read");
  const args = JSON.parse(call.arguments);
  assert.match(args.cmd, /Get-Content -LiteralPath/);
  assert.match(args.cmd, /codex-update-analyzer\.mjs/);
  assert.doesNotMatch(args.cmd, /FILE_CONTENT|throw new Error|WriteAllText/);
  assert.equal(args.workdir, targetPath);
  assert.equal(fs.readFileSync(analyzerPath, "utf8"), "const sourceCount = 3;\n");
});

test("autonomous local project prompt does not inject a fixed sample project", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_CUSTOM_20260711";
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请自主完成长任务。工作目录：C:\\Temp\\session-inspector。创建 package.json, src/normalize.mjs, src/analyze.mjs, cli.mjs, fixtures/events.json, test/analyze.test.mjs, README.md, report.md, done.txt。done.txt 必须等于 ${marker}。`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };

  const chatBody = responsesToChatBody(request, { allowTools: true });
  const systemText = String(chatBody.messages[0]?.content || "");
  assert.match(systemText, /derive the first batch write from the user's exact named-file and behavior checklist/i);
  assert.match(systemText, /Do not copy or substitute a canned sample project/i);
  assert.doesNotMatch(systemText, /autonomous project tool example/i);
  assert.doesNotMatch(systemText, /codex-update-analyzer/i);
  assert.doesNotMatch(systemText, /eval\(Buffer\.from/i);
});

test("autonomous project follow-up never falls back to the canned report-site tool", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_FOLLOWUP_CANNED_20260711";
  const originalPrompt = `请自主完成长任务。工作目录：C:\\Temp\\session-inspector。创建 package.json, src/normalize.mjs, src/analyze.mjs, src/report.mjs, cli.mjs, fixtures/events.json, test/analyze.test.mjs, README.md, report.md, done.txt。done.txt 必须等于 ${marker}。`;
  const followup = "Claude 上一轮没有产出，已停止。现在继续同一个任务，完整契约就是上一条用户消息。下一项输出只能是 shell_command；运行 node --test 后再完成。";
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: followup }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const chatBody = responsesToChatBody(request, { allowTools: true });
  chatBody.messages.push(
    { role: "user", content: originalPrompt },
    { role: "assistant", content: "Working on the original project." },
    { role: "user", content: followup },
  );

  const completion = deterministicArtifactToolCallCompletion(request, chatBody);
  assert.equal(completion, null);
});

test("autonomous local project instruction is placed immediately before the latest user task", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_ORDER_20260711";
  const request = {
    model: "gemini-3.5-flash-low",
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Read the codebase before making changes." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions\nFollow the project rules." }],
      },
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `请自主完成任务。工作目录：C:\\Temp\\autonomous-order。创建 package.json 和 done.txt，done.txt 必须等于 ${marker}。`,
        }],
      },
    ],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };

  const chatBody = responsesToChatBody(request, { allowTools: true });
  const instructionIndex = chatBody.messages.findIndex(message => /Autonomous local project execution rule/.test(String(message.content || "")));
  const latestUserIndex = chatBody.messages.map(message => message.role).lastIndexOf("user");

  assert.ok(instructionIndex > 0);
  assert.equal(instructionIndex, latestUserIndex - 1);
  assert.equal(latestUserIndex, chatBody.messages.length - 1);
  assert.match(chatBody.messages.at(-1).content, new RegExp(marker));
});

test("autonomous project blocks the first pre-write inspection and anchors the correction to the target", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_PREWRITE_20260711";
  const target = path.join(os.tmpdir(), `anticodex-autonomous-prewrite-${Date.now()}`);
  fs.rmSync(target, { recursive: true, force: true });
  const prompt = `请自主完成任务。工作目录：${target}。创建 package.json、src/analyze.mjs、test/analyze.test.mjs 和 done.txt，done.txt 必须等于 ${marker}。`;
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_autonomous_first_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "Get-ChildItem" }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true, chatMessages: [{ role: "user", content: prompt }] });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /completed the inspection phase after detecting repeated read-only calls/);
  assert.match(args.command, /create or edit every missing requested deliverable/);
  assert.doesNotMatch(args.command, /Get-ChildItem/);
  assert.equal(args.workdir, path.dirname(target));
});

test("autonomous correction follow-up inherits the original target and permits targeted inspection", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_FOLLOWUP_20260711";
  const target = path.join(os.tmpdir(), `anticodex-autonomous-followup-${Date.now()}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  const originalPrompt = `请自主完成任务。工作目录：${target}。创建 package.json、src/analyze.mjs 和 done.txt，done.txt 必须等于 ${marker}。`;
  const correction = "纠偏：当前文件不符合本轮清单。请在同一个目标目录内按原始消息和原始清单继续实现，不能结束。";
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: correction }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const chatMessages = [
    { role: "user", content: originalPrompt },
    { role: "assistant", content: "Working on the project." },
    { role: "user", content: correction },
  ];
  const readCommand = `Get-Content -LiteralPath "${path.join(target, "src", "analyze.mjs")}" -TotalCount 80`;
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_autonomous_followup_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: readCommand }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true, chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.command, readCommand);
  assert.equal(args.workdir, target);
  fs.rmSync(target, { recursive: true, force: true });
});

test("autonomous same-task single-file repair permits a targeted read before editing", (t) => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_SINGLE_REPAIR_20260712";
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-autonomous-single-repair-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const analyzer = path.join(target, "codex-update-analyzer.mjs");
  fs.writeFileSync(analyzer, "const sourceCount = 3;\n", "utf8");
  const repairPrompt = `继续当前同一个任务，只修复工作目录 ${target} 中的 codex-update-analyzer.mjs。它必须导出 summarizeSources，最后一行输出 ${marker}。`;
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: repairPrompt }] }],
  };
  const routing = {
    exec_command: {
      type: "function",
      codexName: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, workdir: { type: "string" } },
        required: ["cmd"],
      },
    },
  };
  const readCommand = `Get-Content -LiteralPath "${analyzer}" -TotalCount 200 -Encoding UTF8`;
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_single_repair_read",
          type: "function",
          function: { name: "exec_command", arguments: JSON.stringify({ cmd: readCommand, workdir: target }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true, chatMessages: [{ role: "user", content: repairPrompt }] });

  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(call.call_id, "call_single_repair_read");
  assert.equal(args.cmd, readCommand);
  assert.equal(args.workdir, target);
});

test("autonomous project permits a targeted read after a real deliverable write", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_POSTWRITE_20260711";
  const target = path.join(os.tmpdir(), `anticodex-autonomous-postwrite-${Date.now()}`);
  fs.mkdirSync(target, { recursive: true });
  const prompt = `请自主完成任务。工作目录：${target}。创建 package.json、src/analyze.mjs 和 done.txt，done.txt 必须等于 ${marker}。`;
  const writtenFile = path.join(target, "package.json");
  const readCommand = `Get-Content -LiteralPath "${writtenFile}" -TotalCount 20`;
  const request = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    },
  };
  const chatMessages = [
    { role: "user", content: prompt },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_autonomous_write",
        type: "function",
        function: { name: "shell_command", arguments: JSON.stringify({ command: `Set-Content -LiteralPath "${writtenFile}" -Value "{}"` }) },
      }],
    },
    { role: "tool", tool_call_id: "call_autonomous_write", content: "Exit code: 0" },
  ];
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_autonomous_targeted_read",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: readCommand }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true, chatMessages });

  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.equal(args.command, readCommand);
  assert.equal(args.workdir, target);
  fs.rmSync(target, { recursive: true, force: true });
});

test("autonomous reasoning tool calls get visible progress text before execution", () => {
  const marker = "UI_AUTONOMOUS_REASONING_SMOKE_20260701";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请自主完成任务。工作目录：C:\\Temp\\desktop-visible-autonomous-reasoning\\run。最终标记：${marker}。`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_test",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: "node --test codex-update-analyzer.test.mjs" }),
          },
        }],
      },
    }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  const fmt = chatToResponsesFormat(completion, request, routing, { strictTools: true });
  assert.equal(fmt.output[0].type, "message");
  assert.match(fmt.output[0].content[0].text, /验证：运行测试/);
  assert.match(fmt.output[0].content[0].text, /如果失败/);
  assert.doesNotMatch(fmt.output[0].content[0].text, /^我/m);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
});

test("file-writing tool progress distinguishes implementation and test edits", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_20260701_PROGRESS";
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `请在 C:\\Temp\\desktop-visible-complex-project\\run 创建 package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt。最终标记：${marker}` }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const implementation = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_impl",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "node -e \"require('fs').writeFileSync('codex-update-analyzer.mjs','export function summarizeSources(){}')\"" }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });
  const testFile = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_test_file",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "node -e \"require('fs').writeFileSync('codex-update-analyzer.test.mjs','import test from node:test')\"" }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  assert.match(implementation.output[0].content[0].text, /判断：核心程序是本轮风险点/);
  assert.match(implementation.output[0].content[0].text, /codex-update-analyzer\.mjs/);
  assert.match(testFile.output[0].content[0].text, /判断：先把验收条件写成可运行测试/);
  assert.match(testFile.output[0].content[0].text, /codex-update-analyzer\.test\.mjs/);
  assert.doesNotMatch(implementation.output[0].content[0].text, /^我/m);
  assert.doesNotMatch(testFile.output[0].content[0].text, /^我/m);
  assert.notEqual(implementation.output[0].content[0].text, testFile.output[0].content[0].text);
});

test("combined local artifact command gets multi-step visible progress text", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_20260701_COMBINED_PROGRESS";
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `请在 C:\\Temp\\desktop-visible-coding-project\\run 创建 package.json, word-tally.mjs, word-tally.test.mjs, done.txt。最终标记：${marker}` }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_combined",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: "New-Item run; [System.IO.File]::WriteAllText('word-tally.mjs',''); [System.IO.File]::WriteAllText('word-tally.test.mjs',''); node --test word-tally.test.mjs; node word-tally.mjs \"red blue red\"; Get-Content done.txt" }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const text = fmt.output[0].content[0].text;
  assert.equal(fmt.output[0].type, "message");
  assert.match(text, /计划：这条命令同时落地项目文件和测试文件/);
  assert.match(text, /验证：随后运行测试和本地 CLI/);
  assert.match(text, /核对：最后读回完成标记/);
  assert.doesNotMatch(text, /^我/m);
  assert.equal(fmt.output[1].type, "function_call");
});

test("thin model progress does not suppress multi-step visible progress for combined commands", () => {
  const marker = "UI_CODING_PROJECT_SMOKE_20260702_THIN_PROGRESS";
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `请在 C:\\Temp\\desktop-visible-coding-project\\run 创建 package.json, word-tally.mjs, word-tally.test.mjs, done.txt。最终标记：${marker}` }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "阶段1：创建 Node.js CLI 项目。",
        tool_calls: [{
          id: "call_combined",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: "New-Item run; [System.IO.File]::WriteAllText('word-tally.mjs',''); [System.IO.File]::WriteAllText('word-tally.test.mjs',''); node --test word-tally.test.mjs; node word-tally.mjs \"red blue red\"; Get-Content done.txt" }),
          },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  const text = fmt.output.map(item => item?.content?.[0]?.text || "").join("\n");
  assert.match(text, /阶段1：创建 Node\.js CLI 项目/);
  assert.match(text, /计划：这条命令同时落地项目文件和测试文件/);
  assert.match(text, /验证：随后运行测试和本地 CLI/);
  assert.match(text, /核对：最后读回完成标记/);
  assert.equal(fmt.output.at(-1).type, "function_call");
});

test("complex project tool calls get visible progress text before execution", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_20260701_VISIBLE";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `请在 C:\\Temp\\desktop-visible-complex-project\\run 创建 package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt。最终标记：${marker}。`,
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_complex_visible",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: "node --test codex-update-analyzer.test.mjs" }),
          },
        }],
      },
    }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  const fmt = chatToResponsesFormat(completion, request, routing, { strictTools: true });
  assert.equal(fmt.output[0].type, "message");
  assert.match(fmt.output[0].content[0].text, /验证：运行测试/);
  assert.match(fmt.output[0].content[0].text, /codex-update-analyzer\.test\.mjs/);
  assert.doesNotMatch(fmt.output[0].content[0].text, /^我/m);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
});

test("agentic step-flow tool calls also get visible progress text before execution", () => {
  const marker = "UI_AGENTIC_STEP_FLOW_SMOKE_20260701";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
          "1. 先在可见回复里单独写一行：阶段1：准备创建文件。",
          "2. 然后用工具创建 index.html、README.md、done.txt。",
          `done.txt 必须只包含 ${marker}。`,
        ].join("\n"),
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: `[System.IO.File]::WriteAllText("C:\\Temp\\agentic-step-flow\\done.txt", "${marker}")` }),
          },
        }],
      },
    }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  const fmt = chatToResponsesFormat(completion, request, routing, { strictTools: true });
  assert.equal(fmt.output[0].type, "message");
  assert.match(fmt.output[0].content[0].text, /判断：交付物需要互相校验/);
  assert.match(fmt.output[0].content[0].text, /done\.txt/);
  assert.doesNotMatch(fmt.output[0].content[0].text, /^我/m);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
});

test("agentic step-flow suppresses repeated visible phase text while preserving tool calls", () => {
  const marker = "UI_AGENTIC_STEP_FLOW_SMOKE_20260701";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
          "1. 先在可见回复里单独写一行：阶段1：准备创建文件。",
          "2. 然后用工具创建 index.html、README.md、done.txt。",
          "3. 文件创建后，在可见回复里单独写一行：阶段2：准备验证文件。",
          `done.txt 必须只包含 ${marker}。`,
        ].join("\n"),
      }],
    }, {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "阶段1：准备创建文件。" }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "阶段1：准备创建文件。",
        tool_calls: [{
          id: "call_write",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: `[System.IO.File]::WriteAllText("C:\\Temp\\agentic-step-flow\\done.txt", "${marker}")` }),
          },
        }],
      },
    }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  const fmt = chatToResponsesFormat(completion, request, routing, { strictTools: true });
  assert.equal(fmt.output.length, 2);
  assert.equal(fmt.output[0].type, "message");
  assert.doesNotMatch(fmt.output[0].content[0].text, /阶段1：准备创建文件/);
  assert.match(fmt.output[0].content[0].text, /判断：交付物需要互相校验/);
  assert.match(fmt.output[0].content[0].text, /done\.txt/);
  assert.doesNotMatch(fmt.output[0].content[0].text, /^我/m);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
});

test("generic assistant text does not suppress visible tool progress for long tasks", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_20260701_GENERIC_PROGRESS";
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `请在 C:\\Temp\\desktop-visible-complex-project\\run 创建 package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt。最终标记：${marker}` }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "我开始处理这个任务。",
        tool_calls: [{
          id: "call_impl",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "node -e \"require('fs').writeFileSync('codex-update-analyzer.mjs','export function summarizeSources(){}')\"" }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  assert.equal(fmt.output.length, 3);
  assert.equal(fmt.output[0].type, "message");
  assert.equal(fmt.output[0].content[0].text, "我开始处理这个任务。");
  assert.equal(fmt.output[1].type, "message");
  assert.match(fmt.output[1].content[0].text, /判断：核心程序是本轮风险点/);
  assert.match(fmt.output[1].content[0].text, /codex-update-analyzer\.mjs/);
  assert.doesNotMatch(fmt.output[1].content[0].text, /^我/m);
  assert.equal(fmt.output[2].type, "function_call");
});

test("report-site tool calls get visible progress text before execution", () => {
  const marker = "UI_REPORT_SITE_SMOKE_20260701_PROGRESS";
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Search the web, then create report.md, index.html, and done.txt in C:\\Temp\\desktop-visible-report-site\\run. done.txt must contain ${marker}.` }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "Files created and verified.",
        tool_calls: [{
          id: "call_report",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "node -e \"require('fs').writeFileSync('report.md','中文 https://openai.com')\"" }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  assert.equal(fmt.output[0].type, "message");
  assert.equal(fmt.output[0].content[0].text, "Files created and verified.");
  assert.equal(fmt.output[1].type, "message");
  assert.match(fmt.output[1].content[0].text, /判断：交付物需要互相校验/);
  assert.match(fmt.output[1].content[0].text, /report\.md/);
  assert.doesNotMatch(fmt.output[1].content[0].text, /^我/m);
  assert.equal(fmt.output[2].type, "function_call");
});

test("repo multi-file tool calls get visible progress text before execution", () => {
  const marker = "UI_REPO_MULTI_FILE_EDIT_SMOKE_20260701001";
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Work only in this fixture directory: C:\\Temp\\desktop-coworker-project. Write C:\\Temp\\desktop-coworker-project\\README.md. Do not edit C:\\Temp\\desktop-coworker-project\\status-dashboard.mjs, C:\\Temp\\desktop-coworker-project\\status-dashboard.test.mjs, or C:\\Temp\\desktop-coworker-project\\status-data.json. Reply ${marker}.` }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const fmt = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_repo_multi",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "node -e \"require('fs').writeFileSync('README.md','# 使用说明')\"" }) },
        }],
      },
    }],
  }, request, routing, { strictTools: true });

  assert.equal(fmt.output[0].type, "message");
  assert.match(fmt.output[0].content[0].text, /判断：交付物需要互相校验/);
  assert.match(fmt.output[0].content[0].text, /README\.md/);
  assert.doesNotMatch(fmt.output[0].content[0].text, /^我/m);
  assert.equal(fmt.output[1].type, "function_call");
});

test("generated visible tool progress is not repeated from assistant history", () => {
  const marker = "UI_COMPLEX_PROJECT_SMOKE_20260701_REPEAT_PROGRESS";
  const request = {
    model: "gemini-pro-agent",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Create package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt in C:\\Temp\\complex. done.txt must contain exactly ${marker}.` }] }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const completion = (id) => ({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: "node -e \"require('fs').writeFileSync('codex-update-analyzer.mjs','export function summarizeSources(){}')\"" }) },
        }],
      },
    }],
  });

  const first = chatToResponsesFormat(completion("call_impl_1"), request, routing, { strictTools: true });
  assert.equal(first.output[0].type, "message");
  assert.equal(first.output[1].type, "function_call");

  const continuedRequest = {
    ...request,
    input: [
      ...request.input,
      { type: "function_call_output", call_id: "call_impl_1", output: `created files for ${marker}` },
    ],
  };
  const second = chatToResponsesFormat(completion("call_impl_2"), continuedRequest, routing, { strictTools: true });

  assert.equal(second.output.length, 1);
  assert.equal(second.output[0].type, "function_call");
});

test("agentic step-flow suppresses repeated phase text restored through chat messages", () => {
  const marker = "UI_AGENTIC_STEP_FLOW_SMOKE_20260701";
  const request = {
    model: "gemini-pro-agent",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "请完成一个多阶段可见任务，工作目录是 C:\\Temp\\agentic-step-flow。",
          "1. 先在可见回复里单独写一行：阶段1：准备创建文件。",
          "2. 然后用工具创建 index.html、README.md、done.txt。",
          "3. 文件创建后，在可见回复里单独写一行：阶段2：准备验证文件。",
          `done.txt 必须只包含 ${marker}。`,
        ].join("\n"),
      }],
    }],
    tools: [{ type: "function", function: { name: "shell_command", parameters: { type: "object" } } }],
  };
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "阶段2：准备验证文件。",
        tool_calls: [{
          id: "call_verify",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({ command: `Get-Content "C:\\Temp\\agentic-step-flow\\done.txt"` }),
          },
        }],
      },
    }],
  };
  const routing = {
    shell_command: {
      type: "function",
      codexName: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  const fmt = chatToResponsesFormat(completion, request, routing, {
    strictTools: true,
    chatMessages: [
      { role: "assistant", content: "阶段1：准备创建文件。" },
      { role: "assistant", content: "阶段2：准备验证文件。" },
    ],
  });
  assert.equal(fmt.output[0].type, "message");
  assert.doesNotMatch(fmt.output[0].content[0].text, /阶段2：准备验证文件/);
  assert.match(fmt.output[0].content[0].text, /(?:读回关键结果|交付物需要互相校验)/);
  assert.match(fmt.output[0].content[0].text, /done\.txt/);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
});

test("Antigravity internal web loop returns plain search evidence directly", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  const upstreamBodies = [];
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name, args) => {
    assert.equal(name, "web_search");
    assert.equal(args.query, "search the web for Anti-Codex");
    return JSON.stringify({ ok: true, marker: "LOCAL_WEB_RESULT" });
  };

  try {
    const completion = await callAntigravityWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "search the web for Anti-Codex" }],
      tools: chatBodyWithInternalTools({}).tools,
      tool_choice: { type: "function", function: { name: "web_search" } },
    }, {
      callQueued: async (body) => {
        upstreamBodies.push(structuredClone(body));
        throw new Error("plain web search should not ask the model to summarize already fetched web evidence");
      },
    });

    assert.equal(upstreamBodies.length, 0);
    assert.equal(completion._internalWebEvidence, true);
    assert.match(completion.choices[0].message.content, /LOCAL_WEB_RESULT/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity plain web search returns deterministic evidence without model summarization", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  const upstreamBodies = [];
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name, args) => {
    assert.equal(name, "web_search");
    assert.match(args.query, /recent Codex updates/);
    return JSON.stringify({ ok: true, results: [{ title: "Codex update", url: "https://example.com/codex", snippet: "Codex news" }] });
  };

  try {
    const completion = await callAntigravityWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "Search the web for recent Codex updates and answer with source URLs." }],
    }, {
      callQueued: async (body) => {
        upstreamBodies.push(structuredClone(body));
        throw new Error("plain web search should not ask the model to summarize already fetched web evidence");
      },
    });

    assert.equal(upstreamBodies.length, 0);
    assert.equal(completion._internalWebEvidence, true);
    assert.match(completion.choices[0].message.content, /https:\/\/example\.com\/codex/);
    assert.match(completion.choices[0].message.content, /Codex update/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity web prefetch blocks report-site completion without file evidence", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  const userText = "Search the web for recent Codex updates, then create report.md, index.html and done.txt in C:\\Temp\\report-site. Use PowerShell file commands. done.txt must contain UI_REPORT_SITE_TEST_20260627.";
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name) => {
    assert.equal(name, "web_search");
    return JSON.stringify({
      ok: true,
      results: [
        { title: "Codex updates", url: "https://example.com/codex-1", snippet: "Codex update one." },
        { title: "OpenAI Codex", url: "https://example.com/codex-2", snippet: "Codex update two." },
        { title: "Codex release", url: "https://example.com/codex-3", snippet: "Codex update three." },
      ],
    });
  };

  try {
    assert.equal(requestNeedsWebBackedArtifactOutput({ input: userText }), false);
    let upstreamBody;
    await callAntigravityWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: userText }],
      tools: chatBodyWithInternalTools({}).tools,
      tool_choice: { type: "function", function: { name: "web_search" } },
    }, {
      callQueued: async (body) => {
        upstreamBody = structuredClone(body);
        return {
          choices: [{ message: { role: "assistant", content: "UI_REPORT_SITE_TEST_20260627" }, finish_reason: "stop" }],
        };
      },
    });

    assert.match(upstreamBody.messages.at(-1).content, /Required exact marker: UI_REPORT_SITE_TEST_20260627/);
    assert.match(upstreamBody.messages.at(-1).content, /Read the files back/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity report-site task does not write files when the model only promises work", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-ui-report-site-"));
  const marker = "UI_REPORT_SITE_TEST_20260627_WRITE";
  const userText = `Search the web for recent Codex updates, then create report.md, index.html and done.txt in ${dir}. Use PowerShell file commands. done.txt must contain ${marker}.`;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name) => {
    assert.equal(name, "web_search");
    return JSON.stringify({
      ok: true,
      results: [
        { title: "Codex update one", url: "https://example.com/codex-1", snippet: "Codex update one." },
        { title: "OpenAI Codex update two", url: "https://example.com/codex-2", snippet: "Codex update two." },
        { title: "Codex release three", url: "https://example.com/codex-3", snippet: "Codex update three." },
      ],
    });
  };

  try {
    const completion = await callAntigravityWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: userText }],
      tools: chatBodyWithInternalTools({}).tools,
      tool_choice: { type: "function", function: { name: "web_search" } },
    }, {
      callQueued: async () => ({
        choices: [{ message: { role: "assistant", content: "I will create report.md and index.html now." }, finish_reason: "stop" }],
      }),
    });

    assert.match(completion.choices[0].message.content, /model_omitted_web_source_urls|Anti-Codex blocked/);
    assert.equal(fs.existsSync(path.join(dir, "report.md")), false);
    assert.equal(fs.existsSync(path.join(dir, "index.html")), false);
    assert.equal(fs.existsSync(path.join(dir, "done.txt")), false);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Responses report-site artifact path stays model-led instead of deterministic file writes", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-responses-report-site-"));
  const marker = "UI_REPORT_SITE_RESPONSES_20260627";
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name) => {
    assert.equal(name, "web_search");
    return JSON.stringify({
      ok: true,
      results: [
        { title: "Codex updates", url: "https://example.com/r1", snippet: "Codex update one." },
        { title: "OpenAI Codex", url: "https://example.com/r2", snippet: "Codex update two." },
        { title: "Codex release", url: "https://example.com/r3", snippet: "Codex update three." },
      ],
    });
  };

  try {
    const parsed = {
      model: "gpt-5.5",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Search the web for recent Codex updates, then create report.md, index.html and done.txt in ${dir}. done.txt must contain ${marker}.` }],
      }],
    };
    const chatBody = responsesToChatBody(parsed, {
      injectInternalTools: true,
      preferInternalWebToolChoice: true,
    });
    const response = await deterministicWebBackedArtifactResponse(parsed, chatBody);
    assert.equal(response, null);
    assert.equal(fs.existsSync(path.join(dir, "done.txt")), false);
    assert.equal(fs.existsSync(path.join(dir, "report.md")), false);
    assert.equal(fs.existsSync(path.join(dir, "index.html")), false);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity answers explicit URL fetch requests from fetched evidence", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name, args) => {
    assert.equal(name, "web_fetch");
    assert.equal(args.url, "https://example.com");
    return JSON.stringify({ ok: true, text: "PREFETCH_EVIDENCE" });
  };

  try {
    let modelCalled = false;
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "Read https://example.com. and summarize it." }],
    }), {
      callQueued: async () => {
        modelCalled = true;
        throw new Error("model should not be called for explicit URL fetch prompts");
      },
    });

    assert.equal(modelCalled, false);
    assert.match(completion.choices[0].message.content, /PREFETCH_EVIDENCE/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity answers explicit web_fetch tool verifier prompts from fetched evidence", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name, args) => {
    assert.equal(name, "web_fetch");
    assert.equal(args.url, "https://example.com");
    return JSON.stringify({
      ok: true,
      url: "https://example.com",
      status: 200,
      text: "Example Domain\nThis domain is for use in documentation examples without needing permission. Avoid use in operations.",
    });
  };

  try {
    let modelCalled = false;
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{
        role: "user",
        content: "Call web_fetch exactly once for https://example.com. Output only the required XML-like tool request and no prose before the tool result. After the tool result arrives, answer with one short sentence quoting a distinctive phrase from the fetched page.",
      }],
    }), {
      callQueued: async () => {
        modelCalled = true;
        throw new Error("model should not be called for explicit web_fetch verifier prompts");
      },
    });

    assert.equal(modelCalled, false);
    assert.match(completion.choices[0].message.content, /Example Domain/);
    assert.match(completion.choices[0].message.content, /documentation examples/);
    assert.match(completion.choices[0].message.content, /Avoid use in operations/);

    const formatted = chatToResponsesFormat(completion, {
      model: "gemini-pro-agent",
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "Call web_fetch exactly once for https://example.com. Output only the required XML-like tool request and no prose before the tool result. After the tool result arrives, answer with one short sentence quoting a distinctive phrase from the fetched page.",
        }],
      }],
    }, null, { strictTools: true });
    const formattedText = formatted.output[0].content[0].text;
    assert.match(formattedText, /Example Domain/);
    assert.doesNotMatch(formattedText, /Anti-Codex .*拦截|没有实际 tool call/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity returns actual prefetched evidence when the model only promises a future action", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => JSON.stringify({
    ok: true,
    text: "DETERMINISTIC_WEB_EVIDENCE",
  });

  try {
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "Fetch https://example.com and summarize it." }],
    }), {
      callQueued: async () => ({
        choices: [{ message: { role: "assistant", content: "I will fetch the page now." }, finish_reason: "stop" }],
      }),
    });
    assert.match(completion.choices[0].message.content, /DETERMINISTIC_WEB_EVIDENCE/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity returns actual prefetched evidence when the model detours to missing tools", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => JSON.stringify({
    ok: true,
    text: "DETERMINISTIC_SEARCH_EVIDENCE",
  });

  try {
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "Search the web for recent Codex updates." }],
      tool_choice: { type: "function", function: { name: "web_search" } },
    }), {
      callQueued: async () => ({
        choices: [{ message: { role: "assistant", content: "缺少工具：bash, read_file, write_file, apply_patch, grep_search, list_dir" }, finish_reason: "stop" }],
      }),
    });
    assert.match(completion.choices[0].message.content, /DETERMINISTIC_SEARCH_EVIDENCE/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity treats explicit web_search token as internal web intent", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  let sawSearch = false;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name, args) => {
    assert.equal(name, "web_search");
    assert.match(args.query, /Codex updates/);
    sawSearch = true;
    return JSON.stringify({
      ok: true,
      results: [{
        title: "Codex updates",
        url: "https://example.com/codex-updates",
        snippet: "Recent Codex update evidence.",
      }],
    });
  };

  try {
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "Use web_search to research recent OpenAI Codex updates." }],
    }), {
      callQueued: async (body) => {
        throw new Error("plain explicit web_search should not ask the model to summarize already fetched web evidence");
      },
    });
    assert.equal(sawSearch, true);
    assert.equal(completion._internalWebEvidence, true);
    assert.match(completion.choices[0].message.content, /https:\/\/example\.com\/codex-updates/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity treats Chinese release-date questions as internal web intent", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  let sawSearch = false;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name, args) => {
    assert.equal(name, "web_search");
    assert.match(args.query, /GBT5\.6/);
    sawSearch = true;
    return JSON.stringify({
      ok: true,
      results: [{
        title: "Release date evidence",
        url: "https://example.com/release-date",
        snippet: "Release date evidence.",
      }],
    });
  };

  try {
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "GBT5.6什么时候发布啊" }],
    }), {
      callQueued: async (body) => {
        throw new Error("plain release-date search should not ask the model to summarize already fetched web evidence");
      },
    });
    assert.equal(sawSearch, true);
    assert.equal(completion._internalWebEvidence, true);
    assert.match(completion.choices[0].message.content, /https:\/\/example\.com\/release-date/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity web prefetch uses the latest user request in polluted history", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async (name, args) => {
    assert.equal(name, "web_search");
    assert.equal(args.query, "最近 Codex 都更新了什么？请上网搜索后用中文简要回答，");
    return JSON.stringify({
      ok: true,
      results: [{
        title: "Codex changelog",
        url: "https://developers.openai.com/codex/changelog",
        snippet: "Codex Remote reaches general availability.",
      }],
    });
  };

  try {
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [
        { role: "user", content: "Reply with exactly UI_CHAT_SMOKE_OLD and nothing else." },
        { role: "assistant", content: "Anti-Codex 已拦截这轮回复：这次模型只是在文字里说自己要执行或已经执行，但没有真的搜索网页。" },
        { role: "user", content: "最近 Codex 都更新了什么？请上网搜索后用中文简要回答，最后单独写 UI_WEB_SEARCH_SMOKE_NEW。" },
      ],
      tool_choice: { type: "function", function: { name: "web_search" } },
    }), {
      callQueued: async () => assert.fail("polluted web history should use deterministic local web evidence without another model call"),
    });
    const text = completion.choices[0].message.content;
    assert.match(text, /Codex changelog/);
    assert.match(text, /https:\/\/developers\.openai\.com\/codex\/changelog/);
    assert.match(text, /UI_WEB_SEARCH_SMOKE_NEW/);
    assert.doesNotMatch(text, /UI_CHAT_SMOKE_OLD/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity web prefetch falls back when the model omits source URLs", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => JSON.stringify({
    ok: true,
    results: [{
      title: "Codex changelog",
      url: "https://developers.openai.com/codex/changelog",
      snippet: "Codex Remote reaches general availability.",
    }],
  });

  try {
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "最近 Codex 都更新了什么？请上网搜索后用中文简要回答，最后单独写 UI_WEB_SEARCH_SMOKE_URL。" }],
      tool_choice: { type: "function", function: { name: "web_search" } },
    }), {
      callQueued: async () => ({
        choices: [{ message: { role: "assistant", content: "Codex Remote 已经 GA，CLI 也更新了。" }, finish_reason: "stop" }],
      }),
    });
    const text = completion.choices[0].message.content;
    assert.match(text, /https:\/\/developers\.openai\.com\/codex\/changelog/);
    assert.match(text, /UI_WEB_SEARCH_SMOKE_URL/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity web prefetch falls back when the model returns a no-tool blocker", async () => {
  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => JSON.stringify({
    ok: true,
    results: [{
      title: "Codex update source",
      url: "https://example.com/codex-update",
      snippet: "Codex update evidence.",
    }],
  });

  try {
    const completion = await callAntigravityWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "Search the web for recent Codex updates and answer with source URLs. Put UI_WEB_SEARCH_BLOCKER_DONE on the final line." }],
    }, {
      callQueued: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: "Anti-Codex 已拦截这轮回复：这次模型只是在文字里说自己要执行或已经执行，但没有真的读文件、运行命令、安装依赖、启动服务、生成文件、移动文件或搜索网页。",
          },
          finish_reason: "stop",
        }],
      }),
    });
    const text = completion.choices[0].message.content;
    assert.match(text, /https:\/\/example\.com\/codex-update/);
    assert.match(text, /UI_WEB_SEARCH_BLOCKER_DONE/);
    assert.doesNotMatch(text, /没有真的读文件/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("final Responses formatting trusts translator-owned web evidence", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_web_evidence",
    _internalWebEvidence: true,
    choices: [{ message: { role: "assistant", content: "I fetched the page and found Example Domain." }, finish_reason: "stop" }],
  }, { model: "gemini-pro-agent", input: "Fetch https://example.com" });
  assert.match(formatted.output[0].content[0].text, /Example Domain/);
  assert.doesNotMatch(formatted.output[0].content[0].text, /DeepCodex .*拦截/);
});

// ─── static scan: no old-brand leakage in user-visible text strings ──────────

test("no user-visible DeepCodex or Deep Codex brand in source string literals", () => {
  const source = fs.readFileSync(
    new URL("../adaptive-server.mjs", import.meta.url),
    "utf-8",
  );
  const lines = source.split("\n");

  // Known-safe exceptions (not user-visible):
  //   A) .replaceAll("DeepCodex", ...) — safety net inside brandTranslatorText
  //   B) DEEPCODEX_* — environment variable / config identifier
  //   C) "deepcodex.reasoning.hex.v1:" — technical prefix for encrypted blobs
  //   D) /(?:Anti-Codex|DeepCodex).../ — backward-compat compaction check regex
  //   E) __DEEPCODEX_TEST_* — test-only global hook
  //   F) "DeepCodex" as a single word inside a regex character set or literal
  //      in backward-compat context (task ledger / durable environment facts)

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    const hasOldBrand = line.includes("DeepCodex") || line.includes("Deep Codex");
    if (!hasOldBrand) continue;

    // ── skip known-safe patterns ──
    if (line.includes('replaceAll("DeepCodex"')) continue;        // A
    if (line.includes("DEEPCODEX_")) continue;                     // B
    if (line.includes("deepcodex.reasoning.hex.v1:")) continue;    // C
    if (line.includes("__DEEPCODEX_TEST_")) continue;              // E
    if (/(?:Anti-Codex\||DeepCodex).*?(?:task ledger|durable environment facts)/.test(line)) continue; // D

    // Any remaining hit is suspicious — likely old brand in user-visible text
    assert.fail(
      `Line ${n}: unexpected user-visible "DeepCodex" or "Deep Codex" reference:\n  ${line.trim()}`,
    );
  }
});

// ─── 2026-07-13 Incident Regression Tests ────────────────────────────────────

test("Start-Process bat execution is preserved on the first attempt in the current user turn", () => {
  const userText = "Please run the setup script.";
  const parsed = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] }
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      description: "Run a PowerShell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    }],
  };

  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_start_process_1",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: 'Start-Process -FilePath "setup.bat" -WorkingDirectory "C:\\project"',
            }),
          },
        }],
      },
    }],
  };

  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = chatBody._routing;
  const formatted = chatToResponsesFormat(completion, parsed, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call, "The tool call must be present");
  assert.equal(call.name, "shell_command");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /Start-Process -FilePath "setup.bat"/);
});

test("Batch launch commands are not polluted by the generic artifact marker repair", () => {
  const marker = "UI_LAUNCH_ONCE_COMMAND_GUARD_123";
  const userText = `工作目录是 C:\\Temp\\launch-once。新建 start.bat，只用 Start-Process 启动一次，读取 launch-count.txt 和 launch-proof.txt，最后回复 ${marker}。`;
  const parsed = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
    tools: [{
      type: "function",
      name: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }],
  };
  const command = [
    "Set-Content -Path start.bat -Value 'powershell -File launch-target.ps1' -Encoding Ascii",
    "Start-Process -FilePath .\\start.bat -WorkingDirectory C:\\Temp\\launch-once -Wait",
    "Get-Content launch-count.txt, launch-proof.txt",
  ].join("; ");
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{ id: "call_launch_guard", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }],
      },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const formatted = chatToResponsesFormat(completion, parsed, chatBody._routing, { strictTools: true });
  const call = formatted.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  const progressText = formatted.output
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .map(part => part.text || "")
    .join("\n");

  assert.equal(args.command, command);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard|index\.html|README\.md|done\.txt/);
  assert.match(progressText, /启动：现在只启动一次/);
  assert.doesNotMatch(progressText, /package\.json|codex-update-analyzer/);
});

test("Reading source text that mentions Start-Process is not treated as a launch", () => {
  const command = 'Select-String -LiteralPath "C:\\project\\launch.ps1" -Pattern "Start-Process"';
  const parsed = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the launch script." }] },
      { type: "function_call", name: "shell_command", call_id: "read_1", arguments: JSON.stringify({ command }) },
      { type: "function_call_output", call_id: "read_1", output: "line 20: Start-Process" },
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{ id: "read_2", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }] },
    }],
  }, parsed, chatBody._routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  assert.equal(JSON.parse(call.arguments).command, command);
  const text = formatted.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.doesNotMatch(text, /只启动一次/);
});

test("The same Start-Process target is rewritten even when the first launch was combined with a listing", () => {
  const userText = "Please run the setup script.";
  const parsed = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
      {
        type: "message",
        role: "assistant",
        tool_calls: [{
          id: "call_start_process_1",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: 'Get-ChildItem -Path "C:\\project"; Start-Process -FilePath "setup.bat" -WorkingDirectory "C:\\project"',
            }),
          },
        }],
      },
      {
        type: "function_call_output",
        call_id: "call_start_process_1",
        output: "Exit code: 0\n",
      }
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      description: "Run a PowerShell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    }],
  };

  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_start_process_2",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: 'Start-Process -FilePath "setup.bat" -WorkingDirectory "C:\\project"',
            }),
          },
        }],
      },
    }],
  };

  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = chatBody._routing;
  const formatted = chatToResponsesFormat(completion, parsed, routing, { strictTools: true });

  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call, "The tool call must be present");
  assert.equal(call.name, "shell_command");
  const args = JSON.parse(call.arguments);

  assert.doesNotMatch(args.command, /Start-Process/);
  assert.match(args.command, /已阻止重复启动/);
  assert.match(args.command, /验证进程\/窗口/);
  assert.match(args.command, /检查错误日志/);
  assert.match(args.command, /exit 0/);
});

test("A variable working directory cannot disguise a repeated relative Start-Process target", () => {
  const targetDir = "C:\\Users\\XD\\AppData\\Local\\Temp\\anticodex-launch-once-variable";
  const firstCommand = `Start-Process -FilePath "${targetDir}\\start.bat" -WorkingDirectory "${targetDir}"`;
  const repeatedCommand = [
    `$workdir = "${targetDir}"`,
    "Set-Location -Path $workdir",
    'Start-Process -FilePath ".\\start.bat" -WorkingDirectory $workdir -Wait',
    "Get-Content launch-count.txt, launch-proof.txt",
  ].join("\n");
  const parsed = {
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Create start.bat and launch it exactly once." }] },
      { type: "function_call", name: "shell_command", call_id: "variable_launch_1", arguments: JSON.stringify({ command: firstCommand }) },
      { type: "function_call_output", call_id: "variable_launch_1", output: "Exit code: 0\nOutput:\n" },
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }],
  };
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "variable_launch_2",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: repeatedCommand }) },
        }],
      },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const formatted = chatToResponsesFormat(completion, parsed, chatBody._routing, { strictTools: true });
  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call);
  const command = JSON.parse(call.arguments).command;
  assert.doesNotMatch(command, /(?:^|[;\r\n]\s*)Start-Process\b/i);
  assert.match(command, /已阻止重复启动/);
});

test("cmd.exe ArgumentList cannot disguise a repeated Start-Process batch target", () => {
  const targetDir = "C:\\Users\\XD\\AppData\\Local\\Temp\\anticodex-launch-wrapper";
  const firstCommand = `Start-Process -FilePath "${targetDir}\\start.bat" -WorkingDirectory "${targetDir}" -Wait`;
  const repeatedCommand = 'Start-Process -FilePath "cmd.exe" -ArgumentList "/c start.bat" -NoNewWindow -Wait';
  assert.equal(commandLaunchTargetKey(firstCommand, targetDir), commandLaunchTargetKey(repeatedCommand, targetDir));
  const parsed = {
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Create start.bat and launch it exactly once." }] },
      { type: "function_call", name: "shell_command", call_id: "wrapped_launch_1", arguments: JSON.stringify({ command: firstCommand }) },
      { type: "function_call_output", call_id: "wrapped_launch_1", output: "Exit code: 0\nOutput:\n" },
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    }],
  };
  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "wrapped_launch_2",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: repeatedCommand, workdir: targetDir }) },
        }],
      },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const formatted = chatToResponsesFormat(completion, parsed, chatBody._routing, { strictTools: true });
  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call);
  const command = JSON.parse(call.arguments).command;
  assert.doesNotMatch(command, /Start-Process/i);
  assert.match(command, /已阻止重复启动/);
  assert.match(command, /target:c:\\users\\xd\\appdata\\local\\temp\\anticodex-launch-wrapper\\start\.bat/i);
});

test("a duplicate launch after artifact writes is redirected to read-only verification and exact completion", () => {
  const targetDir = "C:\\Temp\\failed-launch-verification";
  const marker = "UI_FAILED_LAUNCH_VERIFICATION_123";
  const userText = [
    `工作目录是 ${targetDir}，创建 start.bat 并用 Start-Process 只启动一次。`,
    "读取 launch-count.txt 和 error.log，创建 config.json 与 diagnosis.json。",
    `diagnosis.json 必须包含 marker=${marker}，最后一行写 ${marker}。`,
  ].join(" ");
  const startWrite = "Set-Content -Path start.bat -Value 'powershell -File launch-target.ps1'";
  const launch = 'Start-Process -FilePath "start.bat" -Wait';
  const artifactWrite = `Set-Content config.json '{"mode":"repaired","reason":"CONFIG_MISSING"}'; Set-Content diagnosis.json '{"reason":"CONFIG_MISSING","launchCount":1,"fixed":true,"marker":"${marker}"}'`;
  const parsed = {
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
      { type: "function_call", name: "shell_command", call_id: "verification_start_write", arguments: JSON.stringify({ command: startWrite, workdir: targetDir }) },
      { type: "function_call_output", call_id: "verification_start_write", output: "Exit code: 0" },
      { type: "function_call", name: "shell_command", call_id: "verification_launch", arguments: JSON.stringify({ command: launch, workdir: targetDir }) },
      { type: "function_call_output", call_id: "verification_launch", output: "Exit code: 0" },
      { type: "function_call", name: "shell_command", call_id: "verification_read_error", arguments: JSON.stringify({ command: "Get-Content launch-count.txt; Get-Content error.log", workdir: targetDir }) },
      { type: "function_call_output", call_id: "verification_read_error", output: "Exit code: 0\nOutput:\n1\nCONFIG_MISSING" },
      { type: "function_call", name: "shell_command", call_id: "verification_artifact_write", arguments: JSON.stringify({ command: artifactWrite, workdir: targetDir }) },
      { type: "function_call_output", call_id: "verification_artifact_write", output: "Exit code: 0" },
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "verification_duplicate_launch",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command: launch, workdir: targetDir }) },
        }],
      },
    }],
  }, parsed, chatBody._routing, { strictTools: true });
  const verificationCall = formatted.output.find(item => item.type === "function_call");
  assert.ok(verificationCall);
  const verificationCommand = JSON.parse(verificationCall.arguments).command;
  assert.doesNotMatch(verificationCommand, /Start-Process/i);
  assert.match(verificationCommand, /Get-Content/);
  assert.match(verificationCommand, /launch-count\.txt/);
  assert.match(verificationCommand, /config\.json/);
  assert.match(verificationCommand, /diagnosis\.json/);

  const completionRequest = {
    ...parsed,
    input: [
      ...parsed.input,
      { ...verificationCall, call_id: verificationCall.call_id || verificationCall.id },
      {
        type: "function_call_output",
        call_id: verificationCall.call_id || verificationCall.id,
        output: `Exit code: 0\nOutput:\n1\nCONFIG_MISSING\n{"mode":"repaired","reason":"CONFIG_MISSING"}\n{"reason":"CONFIG_MISSING","launchCount":1,"fixed":true,"marker":"${marker}"}`,
      },
    ],
  };
  const completion = deterministicExactReplyCompletion(completionRequest, responsesToChatBody(completionRequest, { allowTools: true }));
  assert.equal(completion.choices[0].message.content, marker);
});

test("a duplicate launch before repair writes is redirected to requested failure evidence", () => {
  const targetDir = "C:\\Temp\\failed-launch-before-repair";
  const marker = "UI_FAILED_LAUNCH_BEFORE_REPAIR_123";
  const userText = `在 ${targetDir} 创建 start.bat，用 Start-Process 只启动一次。随后读取 launch-count.txt 和 error.log，创建 config.json 与 diagnosis.json，最后写 ${marker}。`;
  const launch = 'Start-Process -FilePath "start.bat" -Wait';
  const parsed = {
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
      { type: "function_call", name: "shell_command", call_id: "before_repair_start_write", arguments: JSON.stringify({ command: "Set-Content start.bat 'powershell -File launch-target.ps1'", workdir: targetDir }) },
      { type: "function_call_output", call_id: "before_repair_start_write", output: "Exit code: 0" },
      { type: "function_call", name: "shell_command", call_id: "before_repair_launch", arguments: JSON.stringify({ command: launch, workdir: targetDir }) },
      { type: "function_call_output", call_id: "before_repair_launch", output: "Exit code: 0" },
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", tool_calls: [{ id: "before_repair_duplicate", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command: launch, workdir: targetDir }) } }] },
    }],
  }, parsed, chatBody._routing, { strictTools: true });
  const call = formatted.output.find(item => item.type === "function_call");
  assert.ok(call);
  const command = JSON.parse(call.arguments).command;
  assert.doesNotMatch(command, /Start-Process/i);
  assert.match(command, /Get-Content/);
  assert.match(command, /launch-count\.txt/);
  assert.match(command, /error\.log/);
});

test("A third Start-Process request ends the tool loop after the duplicate-launch nudge", () => {
  const command = 'Start-Process -FilePath "setup.bat" -WorkingDirectory "C:\\project"';
  const nudgeMarker = "Anti-Codex 已阻止重复启动 [target:c:\\project\\setup.bat]";
  const parsed = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Please run the setup script once." }] },
      { type: "function_call", name: "shell_command", call_id: "launch_1", arguments: JSON.stringify({ command }) },
      { type: "function_call_output", call_id: "launch_1", output: "Exit code: 0" },
      { type: "function_call", name: "shell_command", call_id: "launch_nudge", arguments: JSON.stringify({ command: `Write-Output '${nudgeMarker}: verify the process'; exit 0` }) },
      { type: "function_call_output", call_id: "launch_nudge", output: `${nudgeMarker}: verify the process` },
    ],
    tools: [{
      type: "function",
      name: "shell_command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }],
  };
  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "launch_3",
          type: "function",
          function: { name: "shell_command", arguments: JSON.stringify({ command }) },
        }],
      },
    }],
  }, parsed, chatBody._routing, { strictTools: true });

  assert.equal(formatted.output.some(item => item.type === "function_call"), false);
  const text = formatted.output.flatMap(item => item.content || []).map(part => part.text || "").join("\n");
  assert.match(text, /已停止重复启动循环/);
  assert.match(text, /不得再次执行相同启动命令/);
});

test("Ordinary launch and create bat task has a Chinese warning before the first Start-Process tool call", () => {
  const userText = "帮我启动这个脚本并创建 BAT";
  const parsed = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: userText }] }
    ],
    tools: [{
      type: "function",
      name: "shell_command",
    }],
  };

  const completion = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_start_process_1",
          type: "function",
          function: {
            name: "shell_command",
            arguments: JSON.stringify({
              command: 'Start-Process -FilePath "run.bat"',
            }),
          },
        }],
      },
    }],
  };

  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = chatBody._routing;
  const formatted = chatToResponsesFormat(completion, parsed, routing, { strictTools: true });

  const msgIndex = formatted.output.findIndex(item => item.type === "message");
  const callIndex = formatted.output.findIndex(item => item.type === "function_call");

  assert.ok(msgIndex !== -1, "A message containing warning text must be present");
  assert.ok(callIndex !== -1, "The tool call must be present");
  assert.ok(msgIndex < callIndex, "Warning message must be placed before the tool call");

  const msgText = formatted.output[msgIndex].content[0].text;
  assert.match(msgText, /只启动一次/);
  assert.match(msgText, /随后检查/);
});

test("Fake-tool auto-replay exhaustion returns a final explanation of automatic resume failure instead of asking model to retry", async () => {
  const chunks = [];
  const res = {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); },
    end() {},
  };

  const parsed = {
    model: "gemini-pro-agent",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "帮我做视频" }] }
    ],
    tools: [{
      type: "function",
      name: "shell_command",
    }],
  };

  const chatBody = responsesToChatBody(parsed, { allowTools: true });
  const routing = chatBody._routing;
  delete chatBody._routing;

  let callCount = 0;
  async function* streamUpstream(body, deps) {
    callCount += 1;
    yield {
      type: "done",
      completion: {
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "我已经运行了 npm install 并成功启动了项目服务。",
          },
        }],
      },
    };
  }

  const nonStreamingUpstream = async (body, deps) => {
    callCount += 1;
    return {
      choices: [{
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "我已经运行了 npm install 并成功启动了项目服务。",
        },
      }],
    };
  };

  await pipeAntigravityResponseAsSSE({}, res, chatBody, parsed, routing, {
    queue: { run: async (task) => task({}) },
    streamUpstream,
    nonStreamingUpstream,
    registry: { register() {}, attachCascade() {}, finish() {} },
    circuit: { beforeRequest() {}, recordSuccess() {}, recordFailure() {} },
    routeAudit: { record() {} },
  });

  assert.ok(callCount > 1, "Should retry the model because it only made a text claim without tool calls");

  const sseOutput = chunks.join("");
  const completedMatch = sseOutput.match(/event: response\.completed\ndata: (\{.*\})/);
  assert.ok(completedMatch, "Must emit response.completed event");
  const responseData = JSON.parse(completedMatch[1]);

  const textOutput = responseData.response.output.find(item => item.type === "message")?.content[0]?.text;
  assert.ok(textOutput, "Must have final message text output");

  assert.doesNotMatch(textOutput, /会要求模型重新发起/);
  assert.match(textOutput, /自动续跑未成功/);
});
