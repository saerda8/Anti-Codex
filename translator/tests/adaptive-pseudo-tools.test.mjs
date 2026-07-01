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
  deterministicArtifactCompletionResponse,
  deterministicArtifactToolCallCompletion,
  deterministicAmbientSuggestionsCompletion,
  deterministicBackgroundRolloutAnalysisCompletion,
  deterministicExactReplyCompletion,
  deterministicRepoFileEditCompletionResponse,
  deterministicRepoFileEditToolCallCompletion,
  deterministicRepoMultiFileEditCompletionResponse,
  deterministicRepoMultiFileEditToolCallCompletion,
  deterministicTaskTitleCompletion,
  deterministicWebBackedArtifactResponse,
  hasPseudoToolMarkup,
  inputTokensResponse,
  localBackendApiResponse,
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
} = await import("../adaptive-server.mjs");

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
  });

  const wire = chunks.join("");
  assert.equal(streamCalls, 0);
  assert.equal(nonStreamingCalls, 1);
  assert.match(wire, /"type":"function_call"/);
  assert.match(wire, /"name":"shell_command"/);
  assert.match(wire, new RegExp(marker));
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
  assert.doesNotMatch(body.messages[1].content, /Success\. Updated/);
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

test("strict pseudo tool routing rejects calls missing required schema parameters", () => {
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

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /exec_command/);
  assert.match(formatted.output[0].content[0].text, /missing required parameter "command"/i);
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
  const result = await callUpstreamWithInternalTools({
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
  }, {
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

test("chatToResponsesFormat repairs report-site artifact commands without README fallback", () => {
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
  const guard = args.command.slice(args.command.indexOf("Anti-Codex exact artifact marker guard"));
  assert.match(guard, /\$__antiCodexReportSite = \$true/);
  assert.match(guard, /report\.md/);
  assert.match(guard, /index\.html/);
  assert.match(guard, /UTF8Encoding/);
  const reportSiteBranchIndex = guard.indexOf("} elseif ($__antiCodexReportSite)");
  const fallbackReadmeIndex = guard.indexOf("Files: index.html, README.md, done.txt");
  assert.ok(reportSiteBranchIndex > 0);
  assert.ok(fallbackReadmeIndex < 0 || reportSiteBranchIndex < fallbackReadmeIndex);
});

test("report-site artifact requests start with the report-site shell guard", () => {
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
  const reportSiteBranchIndex = args.command.indexOf("} elseif ($__antiCodexReportSite)");
  const fallbackReadmeIndex = args.command.indexOf("Files: index.html, README.md, done.txt");
  assert.match(args.command, /\$__antiCodexReportSite = \$true/);
  assert.ok(reportSiteBranchIndex > 0);
  assert.ok(fallbackReadmeIndex < 0 || reportSiteBranchIndex < fallbackReadmeIndex);
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

test("chatToResponsesFormat replaces fragile complex project shell commands with a safety repair", () => {
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
  const encodedScript = args.command.match(/Buffer\.from\('([^']+)','base64'\)/)?.[1] || "";
  const decodedScript = Buffer.from(encodedScript, "base64").toString("utf8");
  assert.match(args.command, /Anti-Codex complex artifact safety repair/);
  assert.match(args.command, /node -e/);
  assert.match(args.command, /Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)/);
  assert.match(decodedScript, /codex-update-analyzer\.mjs/);
  assert.match(decodedScript, /UI_COMPLEX_PROJECT_SMOKE_20260701/);
  assert.match(decodedScript, /complex artifact verification passed/);
  assert.match(decodedScript, /console\.log\(marker\)/);
  assert.doesNotMatch(args.command, /\$env:HTML/);
  assert.doesNotMatch(args.command, /\\"node:fs\\"/);
  assert.doesNotMatch(args.command, /Anti-Codex exact artifact marker guard/);
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

  assert.equal(deterministicArtifactToolCallCompletion(request, chatBody), null);
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

test("chatToResponsesFormat repairs coding project artifact commands with runnable files", () => {
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
  assert.match(args.command, /Anti-Codex exact artifact marker guard/);
  assert.match(args.command, /package\.json/);
  assert.match(args.command, /word-tally\.mjs/);
  assert.match(args.command, /word-tally\.test\.mjs/);
  assert.match(args.command, /export function tallyWords/);
  assert.match(args.command, /node --test/);
  assert.match(args.command, /red blue red/);
});

test("local coding project artifact requests start with a real shell tool call", () => {
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
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "shell_command");

  const fmt = chatToResponsesFormat(completion, request, chatBody._routing, { strictTools: true });
  const call = fmt.output.find(item => item.type === "function_call");
  assert.ok(call);
  assert.equal(call.name, "shell_command");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /Anti-Codex exact artifact marker guard/);
  assert.match(args.command, /DESKTOP_CODING_PROJECT_DONE_20260627/);
  assert.match(args.command, /package\.json/);
  assert.match(args.command, /word-tally\.mjs/);
  assert.match(args.command, /word-tally\.test\.mjs/);
  assert.match(args.command, /export function tallyWords/);
  assert.match(args.command, /node --test/);
  assert.match(args.command, /red blue red/);
});

test("local coding project artifact path stops at Chinese prompt punctuation", () => {
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
  const args = JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments);
  assert.match(args.command, /\$__antiCodexArtifactDir = 'C:\\Temp\\coding'/);
  assert.doesNotMatch(args.command, /C:\\Temp\\coding。/);
  assert.doesNotMatch(args.command, /C:\\Temp\\coding銆/);
});

test("multi-turn local project follow-up starts with the latest artifact tool call", () => {
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
  assert.ok(completion);
  const fmt = chatToResponsesFormat(completion, request, chatBody._routing, { strictTools: true });
  const call = fmt.output.find(item => item.type === "function_call");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /UI_MULTI_TURN_PROJECT_SMOKE_20260627/);
  assert.match(args.command, /\$__antiCodexMultiTurnProject = \$true/);
  assert.match(args.command, /export function uniqueWords/);
  assert.match(args.command, /followup\.txt/);
  assert.match(args.command, /CHANGELOG\.md/);
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
  assert.match(fmt.output[0].content[0].text, /运行测试验证/);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
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
  assert.match(fmt.output[0].content[0].text, /运行测试验证/);
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
  assert.match(fmt.output[0].content[0].text, /创建或更新项目文件/);
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
  assert.match(fmt.output[0].content[0].text, /创建或更新项目文件/);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
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
  assert.match(fmt.output[0].content[0].text, /读取文件和结果/);
  assert.equal(fmt.output[1].type, "function_call");
  assert.equal(fmt.output[1].name, "shell_command");
});

test("Antigravity internal web loop prefetches search evidence before asking the model to summarize", async () => {
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
        assert.equal(body.tool_choice, "none");
        assert.equal(body.tools, undefined);
        assert.equal(body.messages.at(-3).tool_calls[0].function.name, "web_search");
        assert.match(body.messages.at(-2).content, /LOCAL_WEB_RESULT/);
        assert.match(body.messages.at(-1).content, /web_search call is complete/);
        return {
          choices: [{ message: { role: "assistant", content: "WEB_LOOP_OK" }, finish_reason: "stop" }],
        };
      },
    });

    assert.equal(upstreamBodies.length, 1);
    assert.equal(completion.choices[0].message.content, "WEB_LOOP_OK");
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity internal web loop prefetches explicit search even without injected tools", async () => {
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
        assert.equal(body.tool_choice, "none");
        assert.equal(body.tools, undefined);
        assert.equal(body.messages.at(-3).tool_calls[0].function.name, "web_search");
        assert.match(body.messages.at(-2).content, /https:\/\/example\.com\/codex/);
        return {
          choices: [{ message: { role: "assistant", content: "Codex update summary: https://example.com/codex" }, finish_reason: "stop" }],
        };
      },
    });

    assert.equal(upstreamBodies.length, 1);
    assert.equal(completion._internalWebEvidence, true);
    assert.match(completion.choices[0].message.content, /https:\/\/example\.com\/codex/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity web prefetch continues web-backed artifact tasks instead of stopping at a summary", async () => {
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
    assert.equal(requestNeedsWebBackedArtifactOutput({ input: userText }), true);
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

    assert.match(upstreamBody.messages.at(-1).content, /create the requested local files/i);
    assert.match(upstreamBody.messages.at(-1).content, /report\.md/);
    assert.match(upstreamBody.messages.at(-1).content, /index\.html/);
    assert.match(upstreamBody.messages.at(-1).content, /PowerShell file commands/);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Antigravity web-backed artifact task writes report files when the model only promises work", async () => {
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

    assert.match(completion.choices[0].message.content, new RegExp(marker));
    const report = fs.readFileSync(path.join(dir, "report.md"), "utf8");
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    const done = fs.readFileSync(path.join(dir, "done.txt"), "utf8");
    assert.equal(done, marker);
    assert.match(report, /https:\/\/example\.com\/codex-1/);
    assert.match(report, /[\u4e00-\u9fff]/);
    assert.match(html, /report\.md/);
    assert.match(html, /https:\/\/example\.com\/codex-3/);
    assert.match(html, /<\/html>/i);
  } finally {
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("Responses web-backed artifact path deterministically writes report files before upstream", async () => {
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
    assert.match(response.output[0].content[0].text, new RegExp(marker));
    assert.equal(fs.readFileSync(path.join(dir, "done.txt"), "utf8"), marker);
    assert.match(fs.readFileSync(path.join(dir, "report.md"), "utf8"), /https:\/\/example\.com\/r1/);
    assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /report\.md/);
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
    let upstreamBody;
    const completion = await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "Use web_search to research recent OpenAI Codex updates." }],
    }), {
      callQueued: async (body) => {
        upstreamBody = structuredClone(body);
        return { choices: [{ message: { role: "assistant", content: "Codex evidence: https://example.com/codex-updates" }, finish_reason: "stop" }] };
      },
    });
    assert.equal(sawSearch, true);
    assert.equal(upstreamBody.tools, undefined);
    assert.equal(upstreamBody.tool_choice, "none");
    assert.match(upstreamBody.messages.at(-2).content, /https:\/\/example\.com\/codex-updates/);
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
    let upstreamBody;
    await callAntigravityWithInternalTools(chatBodyWithInternalTools({
      model: "gemini-pro-agent",
      messages: [{ role: "user", content: "GBT5.6什么时候发布啊" }],
    }), {
      callQueued: async (body) => {
        upstreamBody = structuredClone(body);
        return { choices: [{ message: { role: "assistant", content: "证据：https://example.com/release-date" }, finish_reason: "stop" }] };
      },
    });
    assert.equal(sawSearch, true);
    assert.equal(upstreamBody.tools, undefined);
    assert.equal(upstreamBody.tool_choice, "none");
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
