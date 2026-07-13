import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  antigravityCompletionToResponses,
  buildAntigravityProtocolPrompt,
  chatErrorToResponsesError,
  responsesToAntigravityChat,
} from "../codex-native-protocol.mjs";
import { callAntigravityNativeHarness } from "../antigravity-native-harness-upstream.mjs";
import { runCodexNativeHarnessTurn } from "../codex-native-harness-turn.mjs";

const shellTool = {
  type: "function",
  name: "shell_command",
  description: "Run one command in the Codex client.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      workdir: { type: "string" },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

// Behavior fixtures in this section are equivalent ports of CC Switch's
// transform_codex_chat.rs tests (MIT, Copyright 2025 Jason Young).

test("native protocol omits tool controls when no usable tools remain", () => {
  const mapped = responsesToAntigravityChat({
    model: "gemini-3.5-flash-low",
    input: "hi",
    tools: [{ type: "function" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
  });

  assert.equal(Object.hasOwn(mapped, "tools"), false);
  assert.equal(Object.hasOwn(mapped, "tool_choice"), false);
  assert.equal(Object.hasOwn(mapped, "parallel_tool_calls"), false);
});

test("native protocol exposes tool search and loaded namespace tools", () => {
  const mapped = responsesToAntigravityChat({
    model: "gemini-3.5-flash-low",
    tools: [{ type: "tool_search" }],
    tool_choice: "auto",
    input: [
      {
        type: "tool_search_call",
        call_id: "call_tool_search_1",
        status: "completed",
        execution: "client",
        arguments: { query: "Gmail search emails", limit: 5 },
      },
      {
        type: "tool_search_output",
        call_id: "call_tool_search_1",
        status: "completed",
        execution: "client",
        tools: [{
          type: "namespace",
          name: "mcp__codex_apps__gmail",
          description: "Find and reference emails from your inbox.",
          tools: [{
            type: "function",
            name: "_search_emails",
            description: "Search Gmail for emails matching a query.",
            strict: false,
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
                max_results: { type: "integer" },
              },
              required: ["query"],
            },
          }],
        }],
      },
      { type: "message", role: "user", content: "Search unread inbox mail." },
    ],
  });

  const names = mapped.tools.map((tool) => tool.function.name);
  assert.ok(names.includes("tool_search"));
  assert.ok(names.includes("mcp__codex_apps__gmail___search_emails"));
  assert.equal(mapped.messages[0].tool_calls[0].function.name, "tool_search");
  assert.equal(mapped.messages[1].role, "tool");
  assert.equal(mapped.messages[1].tool_call_id, "call_tool_search_1");
  assert.equal(JSON.parse(mapped.messages[1].content).type, "tool_search_output");
});

test("native protocol restores namespace and tool-search calls in Responses output", () => {
  const namespaceRequest = {
    model: "gemini-3.5-flash-low",
    tools: [{ type: "tool_search" }],
    input: [{
      type: "tool_search_output",
      call_id: "call_tool_search_1",
      status: "completed",
      execution: "client",
      tools: [{
        type: "namespace",
        name: "mcp__codex_apps__gmail",
        tools: [{ type: "function", name: "_search_emails", parameters: { type: "object" } }],
      }],
    }],
  };
  const namespaceResponse = antigravityCompletionToResponses({
    id: "chatcmpl_gmail",
    model: namespaceRequest.model,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_gmail",
          type: "function",
          function: {
            name: "mcp__codex_apps__gmail___search_emails",
            arguments: "{\"query\":\"is:unread\"}",
          },
        }],
      },
    }],
  }, namespaceRequest);

  assert.equal(namespaceResponse.output[0].type, "function_call");
  assert.equal(namespaceResponse.output[0].call_id, "call_gmail");
  assert.equal(namespaceResponse.output[0].namespace, "mcp__codex_apps__gmail");
  assert.equal(namespaceResponse.output[0].name, "_search_emails");

  const searchRequest = {
    model: "gemini-3.5-flash-low",
    tools: [{ type: "tool_search" }],
    input: "Find tools.",
  };
  const searchResponse = antigravityCompletionToResponses({
    id: "chatcmpl_tool_search",
    model: searchRequest.model,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_tool_search_1",
          type: "function",
          function: { name: "tool_search", arguments: "{\"query\":\"Gmail\",\"limit\":10}" },
        }],
      },
    }],
  }, searchRequest);

  assert.deepEqual(searchResponse.output[0], {
    type: "tool_search_call",
    call_id: "call_tool_search_1",
    status: "completed",
    execution: "client",
    arguments: { query: "Gmail", limit: 10 },
  });
});

test("native protocol preserves custom tool metadata and restores freeform input", () => {
  const request = {
    model: "gemini-3.5-flash-low",
    tools: [{
      type: "custom",
      name: "apply_patch",
      description: "Apply a patch to files.",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: begin_patch hunk+ end_patch",
      },
    }],
    tool_choice: { type: "custom", name: "apply_patch" },
    input: [{
      type: "custom_tool_call",
      call_id: "call_patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
    }],
  };

  const mapped = responsesToAntigravityChat(request);
  const description = mapped.tools[0].function.description;
  assert.match(description, /^Original tool definition:/);
  assert.match(description, /\"type\":\"custom\"/);
  assert.match(description, /\"syntax\":\"lark\"/);
  assert.equal(mapped.tool_choice.function.name, "apply_patch");
  assert.equal(
    mapped.messages[0].tool_calls[0].function.arguments,
    "{\"input\":\"*** Begin Patch\\n*** End Patch\"}",
  );

  const response = antigravityCompletionToResponses({
    id: "chatcmpl_custom",
    model: request.model,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "{\"input\":\"*** Begin Patch\\n*** End Patch\"}",
          },
        }],
      },
    }],
  }, request);

  assert.deepEqual(response.output[0], {
    type: "custom_tool_call",
    id: "ctc_call_patch",
    call_id: "call_patch",
    name: "apply_patch",
    input: "*** Begin Patch\n*** End Patch",
    status: "completed",
  });
});

test("native protocol preserves supported image, file, and audio content parts", () => {
  const mapped = responsesToAntigravityChat({
    model: "gemini-3.5-flash-low",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Summarize this." },
        { type: "input_image", image_url: "data:image/png;base64,abc" },
        {
          type: "input_file",
          file_id: "file_123",
          file_url: "https://example.com/spec.pdf",
          filename: "spec.pdf",
        },
        { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
      ],
    }],
  });

  assert.deepEqual(mapped.messages[0].content, [
    { type: "text", text: "Summarize this." },
    { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    { type: "file", file: { file_id: "file_123", filename: "spec.pdf" } },
    { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
  ]);
});

test("native protocol splits inline reasoning and maps an incomplete response", () => {
  const response = antigravityCompletionToResponses({
    id: "chatcmpl_think",
    model: "gemini-3.5-flash-low",
    choices: [{
      finish_reason: "length",
      message: {
        role: "assistant",
        content: "<think>\nI should inspect the result.\n</think>\n\nPartial answer",
      },
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 18 },
    },
  }, { model: "gemini-3.5-flash-low" });

  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(response.output[0].type, "reasoning");
  assert.equal(response.output[0].summary[0].text, "I should inspect the result.");
  assert.equal(response.output[1].content[0].text, "Partial answer");
  assert.equal(response.usage.output_tokens_details.reasoning_tokens, 18);
});

test("native protocol rejects malformed chat completions instead of reporting success", () => {
  assert.throws(
    () => antigravityCompletionToResponses({ id: "chatcmpl_empty", choices: [] }, {}),
    /empty choices/i,
  );
  assert.throws(
    () => antigravityCompletionToResponses({ id: "chatcmpl_missing", choices: [{}] }, {}),
    /missing message/i,
  );
});

test("native protocol normalizes provider errors for the Responses client", () => {
  assert.deepEqual(chatErrorToResponsesError({
    error: {
      message: "Invalid API key",
      type: "invalid_request_error",
      code: "invalid_api_key",
      param: "api_key",
    },
  }), {
    error: {
      message: "Invalid API key",
      type: "invalid_request_error",
      code: "invalid_api_key",
      param: "api_key",
    },
  });

  assert.deepEqual(chatErrorToResponsesError({
    base_resp: { status_code: 2013, status_msg: "invalid params" },
  }), {
    error: {
      message: "invalid params",
      type: "upstream_error",
      code: 2013,
      param: null,
    },
  });

  assert.equal(chatErrorToResponsesError(null).error.message, "Upstream returned an empty error response");
});

test("native protocol maps only Codex-owned request data", () => {
  const mapped = responsesToAntigravityChat({
    model: "gemini-3.5-flash-low",
    instructions: "Work as the Codex coding agent.",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Create hello.txt with hello." }],
    }],
    tools: [shellTool],
    tool_choice: "auto",
  });

  assert.equal(mapped.model, "gemini-3.5-flash-low");
  assert.deepEqual(mapped.messages, [
    { role: "system", content: "Work as the Codex coding agent." },
    { role: "user", content: "Create hello.txt with hello." },
  ]);
  assert.deepEqual(mapped.tools.map((tool) => tool.function.name), ["shell_command"]);
  assert.equal(mapped.tool_choice, "auto");
  assert.doesNotMatch(JSON.stringify(mapped), /web_search|write the requested files now|verification recovery/i);
});

test("native protocol preserves a Codex tool call and its result across turns", () => {
  const mapped = responsesToAntigravityChat({
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Run the check." }] },
      {
        type: "function_call",
        call_id: "call_123",
        name: "shell_command",
        arguments: "{\"command\":\"node --test\"}",
      },
      { type: "function_call_output", call_id: "call_123", output: "exit code 0" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Now summarize it." }] },
    ],
    tools: [shellTool],
  });

  assert.deepEqual(mapped.messages, [
    { role: "user", content: "Run the check." },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_123",
        type: "function",
        function: { name: "shell_command", arguments: "{\"command\":\"node --test\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_123", content: "exit code 0" },
    { role: "user", content: "Now summarize it." },
  ]);
});

test("native protocol converts explicit structured calls without inventing commands", () => {
  const original = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Create hello.txt." }] }],
    tools: [shellTool],
  };
  const response = antigravityCompletionToResponses({
    id: "chatcmpl_1",
    model: "gemini-3.5-flash-low",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_abc",
          type: "function",
          function: { name: "shell_command", arguments: "{\"command\":\"Set-Content hello.txt hello\"}" },
        }],
      },
    }],
  }, original);

  assert.equal(response.status, "completed");
  assert.deepEqual(response.output, [{
    type: "function_call",
    id: "fc_call_abc",
    call_id: "call_abc",
    name: "shell_command",
    arguments: "{\"command\":\"Set-Content hello.txt hello\"}",
    status: "completed",
  }]);
});

test("native protocol accepts a full explicit DSML call but keeps prose as prose", () => {
  const original = {
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Create hello.txt." }] }],
    tools: [shellTool],
  };
  const explicit = antigravityCompletionToResponses({
    id: "chatcmpl_dsml",
    model: "gemini-3.5-flash-low",
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: '<tool_calls><invoke name="shell_command"><parameter name="command">Set-Content hello.txt hello</parameter></invoke></tool_calls>',
      },
    }],
  }, original);
  assert.equal(explicit.output[0].type, "function_call");
  assert.equal(explicit.output[0].name, "shell_command");
  assert.deepEqual(JSON.parse(explicit.output[0].arguments), { command: "Set-Content hello.txt hello" });

  const prose = antigravityCompletionToResponses({
    id: "chatcmpl_prose",
    model: "gemini-3.5-flash-low",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "I will execute the command now and then finish the task." },
    }],
  }, original);
  assert.equal(prose.output.length, 1);
  assert.equal(prose.output[0].type, "message");
  assert.match(prose.output[0].content[0].text, /execute the command/);
});

test("native protocol prompt describes transport syntax without task-control policy", () => {
  const chat = responsesToAntigravityChat({
    model: "gemini-3.5-flash-low",
    instructions: "Use Codex tools when needed.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Create hello.txt." }] }],
    tools: [shellTool],
  });
  const prompt = buildAntigravityProtocolPrompt(chat);

  assert.match(prompt, /\[CODEX_TOOLS\]/);
  assert.match(prompt, /shell_command/);
  assert.match(prompt, /Create hello\.txt/);
  assert.match(prompt, /do not claim that it ran/i);
  assert.doesNotMatch(prompt, /ANTI_CODEX_(?:VERIFICATION|REPAIR|IMPLEMENTATION)|write the requested files now|repeat the authorized edit|post-patch/i);
});

test("native harness upstream sends only the protocol prompt to Antigravity", async () => {
  let receivedPrompt = "";
  const completion = await callAntigravityNativeHarness({
    model: "gemini-3.5-flash-low",
    messages: [{ role: "user", content: "Create hello.txt." }],
    tools: [{ type: "function", function: shellTool }],
    tool_choice: "auto",
  }, {
    transport: "desktop-cascade",
    runTurn: async function* (prompt) {
      receivedPrompt = prompt;
      yield { type: "text_delta", delta: '<tool_calls><invoke name="shell_command">' };
      yield { type: "text_delta", delta: '<parameter name="command">Set-Content hello.txt hello</parameter></invoke></tool_calls>' };
      yield { type: "done", result: { text: '<tool_calls><invoke name="shell_command"><parameter name="command">Set-Content hello.txt hello</parameter></invoke></tool_calls>', model: "gemini-3.5-flash-low" } };
    },
  });

  assert.match(receivedPrompt, /\[CODEX_PROVIDER_PROTOCOL\]/);
  assert.match(receivedPrompt, /shell_command/);
  assert.doesNotMatch(receivedPrompt, /ANTI_CODEX_(?:VERIFICATION|REPAIR|IMPLEMENTATION)|write the requested files now|post-patch/i);
  assert.match(completion.choices[0].message.content, /^<tool_calls>/);
});

test("native harness upstream never exposes the Codex project directory to Antigravity", async () => {
  let receivedOptions = null;
  await callAntigravityNativeHarness({
    model: "gemini-3.5-flash-low",
    messages: [{ role: "user", content: "Reply with pong." }],
  }, {
    cwd: "C:\\Users\\XD\\Desktop\\private-project",
    runTurn: async function* (_prompt, options) {
      receivedOptions = options;
      yield { type: "done", result: { text: "pong", model: "gemini-3.5-flash-low" } };
    },
  });

  assert.equal(receivedOptions.cwd, tmpdir());
  assert.doesNotMatch(receivedOptions.cwd, /private-project/i);
});

test("native harness turn returns the model tool call directly to Codex", async () => {
  let upstreamChat = null;
  const response = await runCodexNativeHarnessTurn({
    model: "gemini-3.5-flash-low",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Create hello.txt." }] }],
    tools: [shellTool],
  }, {
    callUpstream: async (chat) => {
      upstreamChat = structuredClone(chat);
      return {
        id: "chatcmpl_native_turn",
        model: chat.model,
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: '<tool_calls><invoke name="shell_command"><parameter name="command">Set-Content hello.txt hello</parameter></invoke></tool_calls>',
          },
        }],
      };
    },
  });

  assert.deepEqual(upstreamChat.tools.map((tool) => tool.function.name), ["shell_command"]);
  assert.equal("_routing" in upstreamChat, false);
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "shell_command");
});

test("adaptive server defaults normal Antigravity requests to the native Codex harness path", () => {
  const server = readFileSync(resolve("translator", "adaptive-server.mjs"), "utf8");
  assert.match(server, /ANTICODEX_NATIVE_HARNESS_ONLY/);
  assert.match(server, /runCodexNativeHarnessTurn/);
  assert.match(server, /handleCodexNativeHarnessRequest/);

  const nativeBranch = server.indexOf("antigravityMode && NATIVE_HARNESS_ONLY");
  const deterministicBranch = server.indexOf("deterministicTaskTitleCompletion(parsed, chatBody)");
  assert.ok(nativeBranch > 0, "normal Antigravity route must contain the native harness branch");
  assert.ok(deterministicBranch > nativeBranch, "native harness branch must run before legacy task-specific branches");

  const handlerStart = server.indexOf("async function handleCodexNativeHarnessRequest");
  const handlerEnd = server.indexOf("\n}\n", handlerStart);
  const handler = server.slice(handlerStart, handlerEnd + 3);
  assert.match(handler, /runCodexNativeHarnessTurn/);
  assert.match(handler, /pipeCodexNativeSSE/);
  assert.doesNotMatch(handler, /\bpipeSSE\s*\(/);
  assert.doesNotMatch(handler, /deterministic|InternalTools|repair|verification|artifact/i);
});

test("runtime manifests and health make the native protocol path observable", () => {
  const server = readFileSync(resolve("translator", "adaptive-server.mjs"), "utf8");
  const sync = readFileSync(resolve("scripts", "sync-anticodex-runtime.ps1"), "utf8");
  const install = readFileSync(resolve("scripts", "install-anticodex.ps1"), "utf8");
  const requiredModules = [
    "codex-native-protocol.mjs",
    "codex-native-sse.mjs",
    "antigravity-native-harness-upstream.mjs",
    "codex-native-harness-turn.mjs",
  ];

  assert.match(server, /nativeHarnessOnly:\s*antigravityMode\s*&&\s*NATIVE_HARNESS_ONLY/);
  for (const moduleName of requiredModules) {
    assert.match(sync, new RegExp(moduleName.replaceAll(".", "\\.")));
    assert.match(install, new RegExp(moduleName.replaceAll(".", "\\.")));
  }
  assert.match(sync, /test-anticodex-human-long-journey\.mjs/);
});
