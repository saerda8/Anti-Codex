import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeUpstreamProfile,
  publicUpstreamProfile,
  classifyUpstreamConnectionError,
  buildUpstreamChatRequest,
  convertUpstreamChatResponse,
  testUpstreamConnection,
} from "../upstream-provider.mjs";

// ─── normalizeUpstreamProfile ─────────────────────────────────

test("normalizeUpstreamProfile accepts openai-compatible protocol", () => {
  const p = normalizeUpstreamProfile({ protocol: "openai-compatible" });
  assert.equal(p.protocol, "openai-compatible");
  assert.equal(typeof p.baseUrl, "string");
});

test("normalizeUpstreamProfile accepts anthropic protocol", () => {
  const p = normalizeUpstreamProfile({ protocol: "anthropic" });
  assert.equal(p.protocol, "anthropic");
});

test("normalizeUpstreamProfile rejects invalid protocol", () => {
  assert.throws(() => normalizeUpstreamProfile({ protocol: "ollama" }), /invalid protocol/);
  assert.throws(() => normalizeUpstreamProfile({ protocol: "openai" }), /invalid protocol/);
  assert.throws(() => normalizeUpstreamProfile({ protocol: "" }), /invalid protocol/);
});

test("normalizeUpstreamProfile rejects null or non-object", () => {
  assert.throws(() => normalizeUpstreamProfile(null), /non-null object/);
  assert.throws(() => normalizeUpstreamProfile(undefined), /non-null object/);
  assert.throws(() => normalizeUpstreamProfile("string"), /non-null object/);
});

test("normalizeUpstreamProfile preserves provided fields", () => {
  const p = normalizeUpstreamProfile({
    protocol: "openai-compatible",
    baseUrl: "https://custom.example.com/v1",
    apiKey: "sk-test-key-12345",
    model: "gpt-4o",
    extraHeaders: { "X-Custom": "value" },
  });
  assert.equal(p.baseUrl, "https://custom.example.com/v1");
  assert.equal(p.apiKey, "sk-test-key-12345");
  assert.equal(p.model, "gpt-4o");
  assert.deepEqual(p.extraHeaders, { "X-Custom": "value" });
});

test("normalizeUpstreamProfile strips trailing slash from baseUrl", () => {
  const p = normalizeUpstreamProfile({
    protocol: "openai-compatible",
    baseUrl: "https://example.com/v1/",
  });
  assert.equal(p.baseUrl, "https://example.com/v1");
});

test("normalizeUpstreamProfile sets defaults for missing fields", () => {
  const p = normalizeUpstreamProfile({ protocol: "anthropic" });
  assert.equal(p.baseUrl, "");
  assert.equal(p.apiKey, "");
  assert.equal(p.model, "");
  assert.deepEqual(p.extraHeaders, {});
});

// ─── publicUpstreamProfile ────────────────────────────────────

test("publicUpstreamProfile masks the API key", () => {
  const p = publicUpstreamProfile({
    protocol: "openai-compatible",
    apiKey: "sk-secret-key-1234567890",
  });
  assert.equal(p.apiKey.includes("sk-secret-key"), false);
  assert.match(p.apiKey, /^\w{4}\*{4}\w{4}$/);
});

test("publicUpstreamProfile leaves empty API key unchanged", () => {
  const p = publicUpstreamProfile({ protocol: "anthropic", apiKey: "" });
  assert.equal(p.apiKey, "");
});

test("publicUpstreamProfile does not leak API key in detail strings", () => {
  const raw = {
    protocol: "anthropic",
    apiKey: "sk-ant-my-super-secret-key-99999",
    baseUrl: "https://example.com",
  };
  const pub = publicUpstreamProfile(raw);
  assert.equal(pub.apiKey.includes("secret"), false);
  assert.equal(pub.apiKey.includes("sk-ant"), false);
  assert.ok(pub.apiKey.length >= 8, "masked key should be at least 8 chars");
  assert.ok(pub.apiKey.includes("****"), "masked key should contain asterisks");
});

test("publicUpstreamProfile masks extra header values that look like secrets", () => {
  const p = publicUpstreamProfile({
    protocol: "openai-compatible",
    apiKey: "",
    extraHeaders: { "X-API-Key": "some-long-secret-value" },
  });
  assert.equal(p.extraHeaders["X-API-Key"].includes("secret"), false);
  assert.match(p.extraHeaders["X-API-Key"], /\w{4}\*{4}\w{4}/);
});

test("publicUpstreamProfile preserves short extra header values", () => {
  const p = publicUpstreamProfile({
    protocol: "openai-compatible",
    apiKey: "",
    extraHeaders: { "X-Debug": "true" },
  });
  assert.equal(p.extraHeaders["X-Debug"], "true");
});

// ─── buildUpstreamChatRequest (OpenAI-compatible) ──────────────

test("buildUpstreamChatRequest openai: path and auth header", () => {
  const { url, headers } = buildUpstreamChatRequest(
    { protocol: "openai-compatible", baseUrl: "https://openai.example.com/v1", apiKey: "sk-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(url, "https://openai.example.com/v1/chat/completions");
  assert.equal(headers["Authorization"], "Bearer sk-test");
  assert.equal(headers["Content-Type"], "application/json");
});

test("buildUpstreamChatRequest openai: body passes through unchanged", () => {
  const chatBody = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.7,
    max_tokens: 100,
    stream: false,
  };
  const { body } = buildUpstreamChatRequest(
    { protocol: "openai-compatible", apiKey: "sk-test" },
    chatBody,
  );
  assert.deepEqual(body, chatBody);
});

test("buildUpstreamChatRequest openai: includes extra headers", () => {
  const { headers } = buildUpstreamChatRequest(
    { protocol: "openai-compatible", apiKey: "sk-test", extraHeaders: { "X-Organization": "org-123" } },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(headers["X-Organization"], "org-123");
});

test("buildUpstreamChatRequest openai: default baseUrl", () => {
  const { url } = buildUpstreamChatRequest(
    { protocol: "openai-compatible", apiKey: "sk-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(url, "https://api.openai.com/v1/chat/completions");
});

test("buildUpstreamChatRequest openai: accepts a full chat completions URL", () => {
  const { url } = buildUpstreamChatRequest(
    { protocol: "openai-compatible", baseUrl: "https://openai.example.com/v1/chat/completions/", apiKey: "sk-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(url, "https://openai.example.com/v1/chat/completions");
});

// ─── buildUpstreamChatRequest (Anthropic) ──────────────────────

test("buildUpstreamChatRequest anthropic: path and auth headers", () => {
  const { url, headers } = buildUpstreamChatRequest(
    { protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["Content-Type"], "application/json");
});

test("buildUpstreamChatRequest anthropic: default baseUrl", () => {
  const { url } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(url, "https://api.anthropic.com/v1/messages");
});

test("buildUpstreamChatRequest anthropic: accepts /v1 and full messages URLs", () => {
  const fromVersionedBase = buildUpstreamChatRequest(
    { protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  const fromFullEndpoint = buildUpstreamChatRequest(
    { protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1/messages/", apiKey: "sk-ant-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );

  assert.equal(fromVersionedBase.url, "https://api.anthropic.com/v1/messages");
  assert.equal(fromFullEndpoint.url, "https://api.anthropic.com/v1/messages");
});

test("buildUpstreamChatRequest anthropic: converts messages (system, user, assistant)", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-4-20250514" },
    {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    },
  );

  assert.equal(body.model, "claude-sonnet-4-20250514");
  assert.equal(body.system, "You are a helpful assistant.");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content[0].text, "Hello");
  assert.equal(body.messages[1].role, "assistant");
  assert.equal(body.messages[1].content[0].text, "Hi there!");
});

test("buildUpstreamChatRequest anthropic: system content as array is joined", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [
        { role: "system", content: [{ type: "text", text: "Rule one." }, { type: "text", text: "Rule two." }] },
        { role: "user", content: "OK" },
      ],
    },
  );

  assert.equal(body.system, "Rule one.\n\nRule two.");
});

test("buildUpstreamChatRequest anthropic: developer messages join system", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [
        { role: "system", content: "System rule" },
        { role: "developer", content: "Developer note" },
        { role: "user", content: "Hi" },
      ],
    },
  );

  assert.equal(body.system, "System rule\n\nDeveloper note");
});

test("buildUpstreamChatRequest anthropic: assistant with tool_calls", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [{
            id: "call_123",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          }],
        },
      ],
    },
  );

  const assistantMsg = body.messages[1];
  assert.equal(assistantMsg.role, "assistant");
  assert.equal(assistantMsg.content.length, 2);
  assert.equal(assistantMsg.content[0].type, "text");
  assert.equal(assistantMsg.content[0].text, "Let me check.");
  assert.equal(assistantMsg.content[1].type, "tool_use");
  assert.equal(assistantMsg.content[1].id, "call_123");
  assert.equal(assistantMsg.content[1].name, "get_weather");
  assert.deepEqual(assistantMsg.content[1].input, { city: "NYC" });
});

test("buildUpstreamChatRequest anthropic: assistant null content with tool_calls", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_search",
            type: "function",
            function: { name: "web_search", arguments: '{"q":"hello"}' },
          }],
        },
      ],
    },
  );

  const assistantMsg = body.messages[1];
  assert.equal(assistantMsg.content.length, 1);
  assert.equal(assistantMsg.content[0].type, "tool_use");
  assert.equal(assistantMsg.content[0].id, "call_search");
  assert.equal(assistantMsg.content[0].name, "web_search");
  assert.deepEqual(assistantMsg.content[0].input, { q: "hello" });
});

test("buildUpstreamChatRequest anthropic: tool result messages", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_search", type: "function", function: { name: "search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_search", content: "Results here" },
      ],
    },
  );

  // Messages should include: user, assistant(tool_use), user(tool_result)
  const toolResult = body.messages[2];
  assert.equal(toolResult.role, "user");
  assert.equal(toolResult.content[0].type, "tool_result");
  assert.equal(toolResult.content[0].tool_use_id, "call_search");
  assert.equal(toolResult.content[0].content, "Results here");
});

test("buildUpstreamChatRequest anthropic: converts tools", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      }],
    },
  );

  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, "get_weather");
  assert.equal(body.tools[0].description, "Get weather for a city");
  assert.deepEqual(body.tools[0].input_schema, {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  });
});

test("buildUpstreamChatRequest anthropic: converts tool_choice auto", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "test", description: "test", parameters: { type: "object" } } }],
      tool_choice: "auto",
    },
  );
  assert.deepEqual(body.tool_choice, { type: "auto" });
});

test("buildUpstreamChatRequest anthropic: converts tool_choice required", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "test", description: "test", parameters: { type: "object" } } }],
      tool_choice: "required",
    },
  );
  assert.deepEqual(body.tool_choice, { type: "any" });
});

test("buildUpstreamChatRequest anthropic: converts tool_choice specific function", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "test", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    },
  );
  assert.deepEqual(body.tool_choice, { type: "tool", name: "get_weather" });
});

test("buildUpstreamChatRequest anthropic: converts tool_choice none", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "none",
    },
  );
  assert.deepEqual(body.tool_choice, { type: "none" });
});

test("buildUpstreamChatRequest anthropic: passes max_tokens and stream", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 2048,
      stream: true,
    },
  );
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.stream, true);
});

test("buildUpstreamChatRequest anthropic: preserves thinking configuration", () => {
  const direct = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    },
  );
  assert.deepEqual(direct.body.thinking, { type: "enabled", budget_tokens: 1024 });

  const normalized = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: "enabled",
      thinking_budget: 2048,
    },
  );
  assert.deepEqual(normalized.body.thinking, { type: "enabled", budget_tokens: 2048 });
});

test("buildUpstreamChatRequest anthropic: defaults max_tokens when not set", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
    },
  );
  assert.equal(body.max_tokens, 4096);
});

test("buildUpstreamChatRequest anthropic: passes temperature, top_p, stop", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
      top_p: 0.9,
      stop: ["\n\n", "stop"],
    },
  );
  assert.equal(body.temperature, 0.5);
  assert.equal(body.top_p, 0.9);
  assert.deepEqual(body.stop_sequences, ["\n\n", "stop"]);
});

test("buildUpstreamChatRequest anthropic: converts user id to metadata", () => {
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [{ role: "user", content: "hi" }],
      user: "user_abc",
    },
  );
  assert.equal(body.metadata.user_id, "user_abc");
});

test("buildUpstreamChatRequest anthropic: includes extra headers", () => {
  const { headers } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test", extraHeaders: { "X-Trace": "abc" } },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(headers["X-Trace"], "abc");
});

// ─── convertUpstreamChatResponse (Anthropic → OpenAI) ─────────

test("convertUpstreamChatResponse anthropic: text-only response", () => {
  const response = {
    id: "msg_123",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello from Claude!" }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  const converted = convertUpstreamChatResponse(
    { protocol: "anthropic", model: "claude-sonnet-4-20250514" },
    response,
  );

  assert.equal(converted.object, "chat.completion");
  assert.equal(converted.id, "msg_123");
  assert.equal(converted.choices[0].message.content, "Hello from Claude!");
  assert.equal(converted.choices[0].message.role, "assistant");
  assert.equal(converted.choices[0].message.tool_calls, undefined);
  assert.equal(converted.choices[0].finish_reason, "stop");
  assert.equal(converted.usage.prompt_tokens, 10);
  assert.equal(converted.usage.completion_tokens, 5);
  assert.equal(converted.usage.total_tokens, 15);
});

test("convertUpstreamChatResponse anthropic: tool_use only response", () => {
  const response = {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "tu_123",
      name: "get_weather",
      input: { city: "NYC" },
    }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 15 },
  };

  const converted = convertUpstreamChatResponse(
    { protocol: "anthropic" },
    response,
  );

  assert.equal(converted.choices[0].message.content, null);
  assert.equal(converted.choices[0].message.tool_calls.length, 1);
  assert.equal(converted.choices[0].message.tool_calls[0].id, "tu_123");
  assert.equal(converted.choices[0].message.tool_calls[0].type, "function");
  assert.equal(converted.choices[0].message.tool_calls[0].function.name, "get_weather");
  assert.equal(converted.choices[0].message.tool_calls[0].function.arguments, '{"city":"NYC"}');
  assert.equal(converted.choices[0].finish_reason, "tool_calls");
});

test("anthropic tool_use ids round-trip into later tool_result messages", () => {
  const response = {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "toolu_anthropic_assigned_789",
      name: "lookup_order",
      input: { id: "ord_1" },
    }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "tool_use",
  };

  const converted = convertUpstreamChatResponse({ protocol: "anthropic" }, response);
  const toolCall = converted.choices[0].message.tool_calls[0];
  const { body } = buildUpstreamChatRequest(
    { protocol: "anthropic", apiKey: "sk-ant-test" },
    {
      messages: [
        converted.choices[0].message,
        { role: "tool", tool_call_id: toolCall.id, content: "order found" },
      ],
    },
  );

  assert.equal(toolCall.id, "toolu_anthropic_assigned_789");
  assert.equal(body.messages[0].content[0].id, "toolu_anthropic_assigned_789");
  assert.equal(body.messages[1].content[0].tool_use_id, "toolu_anthropic_assigned_789");
});

test("convertUpstreamChatResponse anthropic: mixed text and tool_use", () => {
  const response = {
    id: "msg_mixed",
    content: [
      { type: "text", text: "Let me check the weather." },
      {
        type: "tool_use",
        id: "tu_456",
        name: "get_weather",
        input: { city: "London" },
      },
    ],
    model: "claude-opus-4-20250514",
    stop_reason: "tool_use",
  };

  const converted = convertUpstreamChatResponse(
    { protocol: "anthropic" },
    response,
  );

  assert.equal(converted.choices[0].message.content, "Let me check the weather.");
  assert.equal(converted.choices[0].message.tool_calls.length, 1);
  assert.equal(converted.choices[0].message.tool_calls[0].function.name, "get_weather");
  assert.equal(converted.choices[0].finish_reason, "tool_calls");
});

test("convertUpstreamChatResponse anthropic: multiple tool_uses", () => {
  const response = {
    id: "msg_multi_tool",
    content: [
      { type: "text", text: "Running multiple tools." },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "hello" } },
      { type: "tool_use", id: "tu_2", name: "fetch", input: { url: "https://example.com" } },
    ],
    model: "claude-3-5-sonnet",
    stop_reason: "tool_use",
  };

  const converted = convertUpstreamChatResponse(
    { protocol: "anthropic" },
    response,
  );

  assert.equal(converted.choices[0].message.tool_calls.length, 2);
  assert.equal(converted.choices[0].message.tool_calls[0].function.name, "search");
  assert.equal(converted.choices[0].message.tool_calls[1].function.name, "fetch");
});

test("convertUpstreamChatResponse anthropic: stop_reason max_tokens → length", () => {
  const response = {
    id: "msg_max",
    content: [{ type: "text", text: "Partial response" }],
    model: "claude-sonnet-4",
    stop_reason: "max_tokens",
  };

  const converted = convertUpstreamChatResponse(
    { protocol: "anthropic" },
    response,
  );

  assert.equal(converted.choices[0].finish_reason, "length");
});

test("convertUpstreamChatResponse anthropic: empty content", () => {
  const response = {
    id: "msg_empty",
    content: [],
    model: "claude-sonnet-4",
    stop_reason: "end_turn",
  };

  const converted = convertUpstreamChatResponse(
    { protocol: "anthropic" },
    response,
  );

  assert.equal(converted.choices[0].message.content, null);
  assert.equal(converted.choices[0].message.tool_calls, undefined);
  assert.equal(converted.choices[0].finish_reason, "stop");
});

test("convertUpstreamChatResponse openai: passthrough for openai-compatible", () => {
  const openaiResponse = {
    id: "chatcmpl_abc",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4o",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Hello" },
      finish_reason: "stop",
    }],
  };

  const result = convertUpstreamChatResponse(
    { protocol: "openai-compatible" },
    openaiResponse,
  );

  assert.deepEqual(result, openaiResponse);
});

// ─── classifyUpstreamConnectionError ───────────────────────────

test("classifyUpstreamConnectionError returns invalid_url for URL parse errors", () => {
  assert.equal(classifyUpstreamConnectionError(new Error("Invalid URL")), "invalid_url");
  assert.equal(classifyUpstreamConnectionError({ message: "invalid url" }), "invalid_url");
  assert.equal(classifyUpstreamConnectionError({ code: "ERR_INVALID_URL", message: "bad" }), "invalid_url");
});

test("classifyUpstreamConnectionError returns network for connection errors", () => {
  assert.equal(classifyUpstreamConnectionError(new Error("ECONNREFUSED")), "network");
  assert.equal(classifyUpstreamConnectionError(new Error("ENOTFOUND api.example.com")), "network");
  assert.equal(classifyUpstreamConnectionError(new Error("fetch failed")), "network");
  assert.equal(classifyUpstreamConnectionError(new Error("ECONNRESET")), "network");
  assert.equal(classifyUpstreamConnectionError(new Error("socket hang up")), "network");
  assert.equal(classifyUpstreamConnectionError({ code: "ECONNREFUSED" }), "network");
  assert.equal(classifyUpstreamConnectionError({ code: "ENOTFOUND" }), "network");
  assert.equal(classifyUpstreamConnectionError({ code: "EAI_AGAIN" }), "network");
  assert.equal(classifyUpstreamConnectionError({ status: 503 }), "network");
});

test("classifyUpstreamConnectionError returns tls for certificate errors", () => {
  assert.equal(classifyUpstreamConnectionError(new Error("certificate expired")), "tls");
  assert.equal(classifyUpstreamConnectionError(new Error("TLS handshake failed")), "tls");
  assert.equal(classifyUpstreamConnectionError(new Error("SSL error")), "tls");
  assert.equal(classifyUpstreamConnectionError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "tls");
  assert.equal(classifyUpstreamConnectionError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "tls");
});

test("classifyUpstreamConnectionError returns auth for 401/403", () => {
  assert.equal(classifyUpstreamConnectionError({ status: 401, message: "Unauthorized" }), "auth");
  assert.equal(classifyUpstreamConnectionError({ status: 403, message: "Forbidden" }), "auth");
  assert.equal(classifyUpstreamConnectionError(new Error("authentication failed")), "auth");
  assert.equal(classifyUpstreamConnectionError(new Error("API key invalid")), "auth");
});

test("classifyUpstreamConnectionError returns not_found for 404", () => {
  assert.equal(classifyUpstreamConnectionError({ status: 404, message: "Not Found" }), "not_found");
  assert.equal(classifyUpstreamConnectionError(new Error("404 not found")), "not_found");
});

test("classifyUpstreamConnectionError returns rate_limit for 429", () => {
  assert.equal(classifyUpstreamConnectionError({ status: 429, message: "Too Many Requests" }), "rate_limit");
  assert.equal(classifyUpstreamConnectionError(new Error("rate limit exceeded")), "rate_limit");
});

test("classifyUpstreamConnectionError returns quota_or_billing for balance failures", () => {
  assert.equal(classifyUpstreamConnectionError({ status: 402, message: "payment required" }), "quota_or_billing");
  assert.equal(classifyUpstreamConnectionError(new Error("insufficient quota")), "quota_or_billing");
  assert.equal(classifyUpstreamConnectionError(new Error("required balance is too low")), "quota_or_billing");
});

test("classifyUpstreamConnectionError returns model_not_found for model errors", () => {
  assert.equal(classifyUpstreamConnectionError(new Error("model not found: gpt-5")), "model_not_found");
  assert.equal(classifyUpstreamConnectionError(new Error("Model not found")), "model_not_found");
  assert.equal(classifyUpstreamConnectionError(new Error("model gpt-4 does not exist")), "model_not_found");
});

test("classifyUpstreamConnectionError returns protocol_mismatch for parse errors", () => {
  assert.equal(classifyUpstreamConnectionError(new Error("Unexpected response format")), "protocol_mismatch");
  assert.equal(classifyUpstreamConnectionError(new Error("JSON parse error")), "protocol_mismatch");
  assert.equal(classifyUpstreamConnectionError(new Error("invalid response")), "protocol_mismatch");
});

test("classifyUpstreamConnectionError returns timeout for timeout errors", () => {
  assert.equal(classifyUpstreamConnectionError(new Error("timeout")), "timeout");
  assert.equal(classifyUpstreamConnectionError(new Error("ETIMEOUT")), "timeout");
  assert.equal(classifyUpstreamConnectionError({ name: "TimeoutError", message: "exceeded" }), "timeout");
});

test("classifyUpstreamConnectionError returns unknown for unrecognized errors", () => {
  assert.equal(classifyUpstreamConnectionError(new Error("Something else")), "unknown");
  assert.equal(classifyUpstreamConnectionError({ message: "" }), "unknown");
  assert.equal(classifyUpstreamConnectionError(null), "unknown");
  assert.equal(classifyUpstreamConnectionError(undefined), "unknown");
});

test("classifyUpstreamConnectionError does not leak API key in return value", () => {
  const result = classifyUpstreamConnectionError(new Error("API key sk-ant-my-key is invalid"));
  assert.equal(result, "auth");
  // The classification itself doesn't include the key
  assert.equal(result.includes("sk-ant"), false);
});

// ─── testUpstreamConnection ────────────────────────────────────

/**
 * Helper: create a mock fetch that returns a given response.
 */
function mockFetch(response, opts = {}) {
  return async (_url, _options) => {
    if (opts.throwError) {
      throw opts.throwError;
    }
    return response;
  };
}

function okResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name] || headers[String(name).toLowerCase()] || null;
      },
    },
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

function textResponse(text, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name] || headers[String(name).toLowerCase()] || null;
      },
    },
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
}

test("testUpstreamConnection returns Chinese stage names", async () => {
  const fetchImpl = mockFetch(okResponse({}));
  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  assert.ok(results.length >= 3);
  for (const r of results) {
    assert.equal(typeof r.stage, "string");
    // Stage names should be Chinese
    assert.match(r.stage, /[一-鿿]/);
    assert.ok(["ok", "fail", "skip", "warn"].includes(r.status));
    assert.equal(typeof r.detail, "string");
  }
});

test("testUpstreamConnection returns fail on invalid config", async () => {
  const results = await testUpstreamConnection(
    { protocol: "invalid-proto" },
    { fetchImpl: mockFetch(okResponse({})) },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].stage, "配置验证");
  assert.equal(results[0].status, "fail");
});

test("testUpstreamConnection all stages ok for openai-compatible", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount === 1) return okResponse({ data: [{ id: "gpt-4o" }] });
    if (callCount === 3) return textResponse("data: {}\n\n", 200, { "content-type": "text/event-stream" });
    if (callCount === 4) {
      return okResponse({
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] } }],
      });
    }
    return okResponse({ choices: [{ message: { role: "assistant", content: "hi" } }] });
  };
  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", baseUrl: "https://test.example.com/v1", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const okStages = results.filter(r => r.status === "ok");
  assert.ok(okStages.length >= 5);
  assert.equal(results.find(r => r.stage === "配置验证")?.status, "ok");
  assert.deepEqual(results.find(r => r.stage === "模型探测")?.models, ["gpt-4o"]);
});

test("testUpstreamConnection gives each probe its own timeout budget", async () => {
  const delayedResponse = async (url, options = {}) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 12);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });

    if (String(url).endsWith("/models")) {
      return okResponse({ data: [{ id: "gpt-test" }] });
    }
    if (options.body && JSON.parse(options.body).stream === true) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: {},
        text: async () => "data: [DONE]\n\n",
      };
    }
    const body = JSON.parse(options.body || "{}");
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return okResponse({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_test",
              type: "function",
              function: { name: "get_time", arguments: "{}" },
            }],
          },
        }],
      });
    }
    return okResponse({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  };

  const stages = await testUpstreamConnection(
    {
      protocol: "openai-compatible",
      baseUrl: "https://test.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
    },
    { fetchImpl: delayedResponse, timeoutMs: 25 },
  );

  assert.equal(stages.some((stage) => stage.status === "fail"), false);
  assert.equal(stages.find((stage) => stage.stage === "工具调用")?.status, "ok");
});

test("testUpstreamConnection anthropic skips model probing", async () => {
  const fetchImpl = mockFetch(okResponse({}));
  const results = await testUpstreamConnection(
    { protocol: "anthropic", apiKey: "sk-ant-test", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const modelStage = results.find(r => r.stage === "模型探测");
  assert.ok(modelStage);
  assert.equal(modelStage.status, "skip");
});

test("testUpstreamConnection classifies network error", async () => {
  const fetchImpl = mockFetch(null, { throwError: new Error("ECONNREFUSED 127.0.0.1") });
  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const failStage = results.find(r => r.status === "fail");
  assert.ok(failStage);
  assert.match(failStage.detail, /network/);
  assert.equal(failStage.detail.includes("sk-test"), false);
});

test("testUpstreamConnection classifies auth error", async () => {
  const fetchImpl = mockFetch(okResponse({ error: "unauthorized" }, 401));
  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const failStage = results.find(r => r.status === "fail");
  assert.ok(failStage);
  assert.match(failStage.detail, /auth/);
  assert.equal(failStage.detail.includes("sk-test"), false);
});

test("testUpstreamConnection classifies timeout error", async () => {
  const fetchImpl = mockFetch(null, { throwError: new Error("timeout of 5000ms exceeded") });
  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const failStage = results.find(r => r.status === "fail");
  assert.ok(failStage);
  assert.match(failStage.detail, /timeout/);
});

test("testUpstreamConnection does not leak API key in any detail", async () => {
  const fetchImpl = mockFetch(null, { throwError: new Error("ECONNREFUSED") });
  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-super-secret-key-12345", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  for (const r of results) {
    assert.equal(r.detail.includes("sk-super-secret-key"), false);
    assert.equal(r.detail.includes("12345"), false);
  }
});

test("testUpstreamConnection does not leak API key from auth error body", async () => {
  // Contract: when the upstream server returns 401 with the API key
  // reflected in the response body, the test detail must not contain
  // any fragment of the real key.  This simulates a gateway that
  // echoes the key back in error messages.
  const apiKey = "sk-real-key-should-not-leak-99999";

  const fetchImpl = async (url, _options) => {
    // Let model probe succeed so we reach the chat stage
    if (String(url).includes("/models")) {
      return okResponse({ data: [{ id: "gpt-4o" }] });
    }
    // Chat endpoint returns 401 with the API key in the error body
    return textResponse(
      JSON.stringify({ error: { message: `Invalid API key: ${apiKey}` } }),
      401,
      { "content-type": "application/json" },
    );
  };

  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey, model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  // Core contract: no stage detail contains any part of the real API key
  for (const r of results) {
    assert.equal(
      r.detail.includes("sk-real-key-should-not-leak"),
      false,
      `stage "${r.stage}" detail must not contain the API key`,
    );
    assert.equal(
      r.detail.includes("99999"),
      false,
      `stage "${r.stage}" detail must not contain API key suffix`,
    );
  }
});

test("testUpstreamConnection model probe skip on 404", async () => {
  let callCount = 0;
  const fetchImpl = async (_url, _options) => {
    callCount++;
    if (callCount === 1) {
      // First call is model probe
      return okResponse({}, 404);
    }
    return okResponse({ choices: [{ message: { content: "hi" } }] });
  };

  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", baseUrl: "https://test.example.com/v1", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const modelStage = results.find(r => r.stage === "模型探测");
  assert.ok(modelStage);
  assert.equal(modelStage.status, "skip");
});

test("testUpstreamConnection fails when basic chat shape is invalid", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount === 1) return okResponse({ data: [{ id: "gpt-4o" }] });
    return okResponse({ ok: true, text: "not a chat completion" });
  };

  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", baseUrl: "https://test.example.com/v1", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const chatStage = results.find(r => r.stage === "最小聊天");
  assert.equal(chatStage?.status, "fail");
  assert.match(chatStage?.detail || "", /protocol_mismatch/);
});

test("testUpstreamConnection warns when tool request returns no tool call", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount === 1) return okResponse({ data: [{ id: "gpt-4o" }] });
    return okResponse({ choices: [{ message: { role: "assistant", content: "plain text" } }] });
  };

  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", baseUrl: "https://test.example.com/v1", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const toolStage = results.find(r => r.stage === "工具调用");
  assert.equal(toolStage?.status, "warn");
  assert.match(toolStage?.detail || "", /工具调用/);
});

test("testUpstreamConnection accepts Anthropic tool_use as verified tool call", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount === 2) return textResponse("event: content_block_delta\ndata: {}\n\n", 200, { "content-type": "text/event-stream" });
    if (callCount === 3) {
      return okResponse({
        id: "msg_tool",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "ping", input: { msg: "ok" } }],
        stop_reason: "tool_use",
      });
    }
    return okResponse({
      id: "msg_chat",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
    });
  };

  const results = await testUpstreamConnection(
    { protocol: "anthropic", apiKey: "sk-ant-test", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4" },
    { fetchImpl, timeoutMs: 5000 },
  );

  const toolStage = results.find(r => r.stage === "工具调用");
  assert.equal(toolStage?.status, "ok");
});

test("testUpstreamConnection returns ok with all stages for successful run", async () => {
  const fetchImpl = async (_url, _options) => {
    return okResponse({
      id: "chatcmpl_test",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
    });
  };

  const results = await testUpstreamConnection(
    { protocol: "openai-compatible", apiKey: "sk-test", model: "gpt-4o" },
    { fetchImpl, timeoutMs: 5000 },
  );

  assert.ok(results.every(r => r.status === "ok" || r.status === "skip" || r.status === "warn"));
  assert.ok(results.some(r => r.stage === "配置验证" && r.status === "ok"));
});

// ─── Integration: build request then convert response ─────────

test("end-to-end: anthropic request → response round trip", () => {
  const profile = { protocol: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-4" };

  const { url, headers, body } = buildUpstreamChatRequest(profile, {
    model: "claude-sonnet-4",
    messages: [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "What is the weather in Paris?" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    }],
    tool_choice: "auto",
    max_tokens: 500,
  });

  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(body.model, "claude-sonnet-4");
  assert.equal(body.system, "Be helpful.");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.tools[0].name, "get_weather");
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.equal(body.max_tokens, 500);

  // Simulate Anthropic response
  const rawResponse = {
    id: "msg_roundtrip",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the weather in Paris." },
      {
        type: "tool_use",
        id: "tu_paris",
        name: "get_weather",
        input: { city: "Paris" },
      },
    ],
    model: "claude-sonnet-4",
    stop_reason: "tool_use",
    usage: { input_tokens: 15, output_tokens: 10 },
  };

  const converted = convertUpstreamChatResponse(profile, rawResponse);

  assert.equal(converted.choices[0].message.content, "Let me check the weather in Paris.");
  assert.equal(converted.choices[0].message.tool_calls[0].function.name, "get_weather");
  assert.equal(converted.choices[0].message.tool_calls[0].function.arguments, '{"city":"Paris"}');
  assert.equal(converted.choices[0].finish_reason, "tool_calls");
  assert.equal(converted.usage.prompt_tokens, 15);
  assert.equal(converted.usage.completion_tokens, 10);
});

test("end-to-end: openai-compatible request → response round trip", () => {
  const profile = { protocol: "openai-compatible", apiKey: "sk-test", baseUrl: "https://api.example.com/v1" };

  const chatBody = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  };

  const { url, headers, body } = buildUpstreamChatRequest(profile, chatBody);

  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(headers["Authorization"], "Bearer sk-test");

  // OpenAI response should pass through
  const response = {
    id: "chatcmpl_xyz",
    object: "chat.completion",
    created: 123,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
  };

  const result = convertUpstreamChatResponse(profile, response);
  assert.deepEqual(result, response);
});
