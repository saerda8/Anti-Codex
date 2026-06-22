/**
 * Upstream provider protocol adapter.
 *
 * Supports:
 *   - openai-compatible  → /chat/completions, Bearer auth
 *   - anthropic          → /v1/messages, x-api-key + anthropic-version
 *
 * Pure functions + testUpstreamConnection (mocked fetch).
 * No side effects, no filesystem, no config reads.
 *
 * @module upstream-provider
 */

// ─── Constants ─────────────────────────────────────────────────

const VALID_PROTOCOLS = new Set(["openai-compatible", "anthropic"]);

const ANTHROPIC_DEFAULT_BASE  = "https://api.anthropic.com";
const OPENAI_DEFAULT_BASE     = "https://api.openai.com/v1";

const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

// ─── Profile helpers ──────────────────────────────────────────

/**
 * Normalize and validate an upstream profile.
 *
 * @param {object} profile
 * @param {string} profile.protocol       – "openai-compatible" | "anthropic"
 * @param {string} [profile.baseUrl]
 * @param {string} [profile.apiKey]
 * @param {string} [profile.model]
 * @param {object} [profile.extraHeaders]
 * @returns {object} Normalised profile
 * @throws {Error}  When protocol is missing / invalid
 */
export function normalizeUpstreamProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("upstream profile must be a non-null object");
  }
  if (!VALID_PROTOCOLS.has(profile.protocol)) {
    throw new Error(
      `invalid protocol "${profile.protocol}"; must be one of: ${[...VALID_PROTOCOLS].join(", ")}`,
    );
  }

  const normalized = {
    protocol: profile.protocol,
    baseUrl: typeof profile.baseUrl === "string" ? profile.baseUrl : "",
    apiKey:  typeof profile.apiKey === "string" ? profile.apiKey : "",
    model:   typeof profile.model === "string" ? profile.model : "",
    extraHeaders: { ...(profile.extraHeaders ?? {}) },
  };

  // Strip trailing slash so URL concatenation is clean.
  if (normalized.baseUrl.endsWith("/")) {
    normalized.baseUrl = normalized.baseUrl.slice(0, -1);
  }

  return normalized;
}

/**
 * Return a public-safe copy of a profile: secrets are masked.
 *
 * @param {object} profile
 * @returns {object}
 */
export function publicUpstreamProfile(profile) {
  const p = normalizeUpstreamProfile(profile);
  if (p.apiKey) {
    p.apiKey = maskSecret(p.apiKey);
  }
  for (const [k, v] of Object.entries(p.extraHeaders)) {
    if (typeof v === "string" && v.length > 8) {
      p.extraHeaders[k] = maskSecret(v);
    }
  }
  return p;
}

function maskSecret(s) {
  if (s.length <= 4) return "****";
  if (s.length <= 8) return s.slice(0, 2) + "****";
  // Extract first 4 word characters (skip non-\w chars like hyphens)
  // so the prefix is always 4 alphanumeric / underscore chars.
  let prefix = "";
  for (const ch of s) {
    if (/^\w$/.test(ch)) {
      prefix += ch;
      if (prefix.length === 4) break;
    }
  }
  while (prefix.length < 4) prefix += "x";
  return prefix + "****" + s.slice(-4);
}

// ─── Error classification ─────────────────────────────────────

/**
 * Classify an upstream connection error into a stable category string.
 *
 * Categories: invalid_url | network | tls | auth | not_found |
 *             rate_limit | model_not_found | protocol_mismatch |
 *             timeout | unknown
 *
 * The returned string never contains the original error message,
 * so API keys can never leak.
 *
 * @param {Error|object|null} error
 * @returns {string}
 */
export function classifyUpstreamConnectionError(error) {
  if (!error) return "unknown";

  const msg  = String(error.message ?? error);
  const code = error.code ?? "";
  const status = error.status ?? error.statusCode ?? 0;
  const name = error.name ?? "";

  // ── timeout ──
  if (
    name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("TIMEOUT") ||
    code === "ETIMEOUT"
  ) {
    return "timeout";
  }

  // ── invalid_url (URL parse errors) ──
  if (
    code === "ERR_INVALID_URL" ||
    msg.includes("Invalid URL") ||
    msg.includes("invalid url")
  ) {
    return "invalid_url";
  }

  // ── tls ──
  if (
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "ERR_TLS_CERTIFICATE" ||
    msg.includes("certificate") ||
    msg.includes("CERT") ||
    msg.includes("TLS") ||
    msg.includes("tls") ||
    msg.includes("SSL") ||
    msg.includes("ssl")
  ) {
    return "tls";
  }

  // ── network ──
  const NETWORK_CODES = new Set([
    "ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN",
    "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN",
    "ECONNABORTED", "EADDRINUSE", "EADDRNOTAVAIL",
  ]);
  if (
    NETWORK_CODES.has(code) ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("socket closed") ||
    msg.includes("broken pipe") ||
    status >= 500
  ) {
    return "network";
  }

  // ── rate_limit ──
  if (status === 429 || msg.includes("rate limit")) {
    return "rate_limit";
  }

  // ── auth ──
  if (
    status === 401 ||
    status === 403 ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("authentication") ||
    msg.includes("x-api-key") ||
    msg.includes("API key")
  ) {
    return "auth";
  }

  // ── model_not_found (check BEFORE generic not_found) ──
  if (
    msg.includes("model not found") ||
    msg.includes("Model not found") ||
    msg.includes("model_not_found") ||
    msg.includes("does not exist") ||
    msg.includes("is not supported")
  ) {
    return "model_not_found";
  }

  // ── not_found ──
  if (status === 404 || msg.includes("404") || msg.includes("not found")) {
    return "not_found";
  }

  // ── protocol_mismatch ──
  if (
    msg.includes("unexpected") ||
    msg.includes("Unexpected") ||
    msg.includes("parse") ||
    msg.includes("JSON") ||
    msg.includes("invalid response")
  ) {
    return "protocol_mismatch";
  }

  return "unknown";
}

// ─── Request builder ──────────────────────────────────────────

/**
 * Build an upstream chat request config from a profile and
 * an OpenAI-style chat completion body.
 *
 * @param {object} profile   – upstream profile (protocol, baseUrl, apiKey, …)
 * @param {object} chatBody  – OpenAI chat completion request body
 * @returns {{ url: string, headers: Record<string,string>, body: object }}
 */
export function buildUpstreamChatRequest(profile, chatBody) {
  const p = normalizeUpstreamProfile(profile);

  if (p.protocol === "openai-compatible") {
    return buildOpenAIRequest(p, chatBody);
  }
  if (p.protocol === "anthropic") {
    return buildAnthropicRequest(p, chatBody);
  }

  throw new Error(`unsupported protocol: ${p.protocol}`);
}

// ── OpenAI-compatible ──────────────────────────────────────────

function buildOpenAIRequest(profile, chatBody) {
  const base = openAICompatibleBaseUrl(profile.baseUrl || OPENAI_DEFAULT_BASE);
  const url  = `${base}/chat/completions`;

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${profile.apiKey}`,
    ...profile.extraHeaders,
  };

  return { url, headers, body: { ...chatBody } };
}

function openAICompatibleBaseUrl(baseUrl) {
  return String(baseUrl || OPENAI_DEFAULT_BASE)
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");
}

// ── Anthropic ──────────────────────────────────────────────────

function buildAnthropicRequest(profile, chatBody) {
  const base = anthropicBaseUrl(profile.baseUrl || ANTHROPIC_DEFAULT_BASE);
  const url  = `${base}/v1/messages`;

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": profile.apiKey,
    "anthropic-version": "2023-06-01",
    ...profile.extraHeaders,
  };

  return { url, headers, body: convertChatBodyToAnthropic(chatBody) };
}

function anthropicBaseUrl(baseUrl) {
  return String(baseUrl || ANTHROPIC_DEFAULT_BASE)
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/i, "")
    .replace(/\/v1$/i, "");
}

function convertChatBodyToAnthropic(chatBody) {
  const body = {};

  // model
  if (chatBody.model) body.model = chatBody.model;

  // system (top-level in Anthropic) – merge system + developer
  const systemMsgs = (chatBody.messages ?? []).filter(
    (m) => m.role === "system" || m.role === "developer",
  );
  if (systemMsgs.length > 0) {
    body.system = systemMsgs
      .map((m) => extractTextContent(m.content))
      .filter(Boolean)
      .join("\n\n");
  }

  // messages (everything except system / developer)
  body.messages = (chatBody.messages ?? [])
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map(convertOpenAIMessageToAnthropic);

  // scalar passthrough
  if (chatBody.max_tokens !== undefined) body.max_tokens = chatBody.max_tokens;
  if (chatBody.stream !== undefined) body.stream = chatBody.stream;
  if (chatBody.temperature !== undefined) body.temperature = chatBody.temperature;
  if (chatBody.top_p !== undefined) body.top_p = chatBody.top_p;

  // stop sequences
  if (chatBody.stop) {
    body.stop_sequences = Array.isArray(chatBody.stop)
      ? chatBody.stop
      : [chatBody.stop];
  }

  // tools
  if (chatBody.tools && chatBody.tools.length > 0) {
    body.tools = chatBody.tools.map(convertOpenAIToolToAnthropic);
  }

  // tool_choice
  if (chatBody.tool_choice !== undefined) {
    body.tool_choice = convertOpenAIToolChoiceToAnthropic(chatBody.tool_choice);
  }

  // metadata (user_id)
  if (chatBody.user) {
    body.metadata = { ...(body.metadata ?? {}), user_id: chatBody.user };
  }

  // Anthropic requires max_tokens – supply a sensible default
  if (body.max_tokens === undefined) {
    body.max_tokens = ANTHROPIC_DEFAULT_MAX_TOKENS;
  }

  return body;
}

// ── Anthropic-internal converters ──────────────────────────────

function extractTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return String(content);
}

function convertOpenAIMessageToAnthropic(msg) {
  if (msg.role === "user") {
    return {
      role: "user",
      content: normalizeContent(msg.content, "user"),
    };
  }

  if (msg.role === "assistant") {
    const content = [];

    // text content
    if (msg.content) {
      if (typeof msg.content === "string") {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "image_url") {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: block.image_url.url,
              },
            });
          }
        }
      }
    }

    // tool_calls → tool_use blocks
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let parsed;
        try {
          parsed = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsed = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parsed,
        });
      }
    }

    return { role: "assistant", content };
  }

  if (msg.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
        },
      ],
    };
  }

  // fallback – treat as user
  return {
    role: "user",
    content: normalizeContent(msg.content, msg.role),
  };
}

function normalizeContent(content, _role) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "image_url") {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: block.image_url.url,
          },
        };
      }
      return { type: "text", text: JSON.stringify(block) };
    });
  }
  return [{ type: "text", text: String(content ?? "") }];
}

function convertOpenAIToolToAnthropic(tool) {
  if (tool.type === "function") {
    return {
      name: tool.function.name,
      description: tool.function.description ?? "",
      input_schema: tool.function.parameters ?? { type: "object", properties: {} },
    };
  }
  // pass through non-function tools as-is
  return tool;
}

function convertOpenAIToolChoiceToAnthropic(toolChoice) {
  if (toolChoice === "auto" || toolChoice === undefined || toolChoice === null) {
    return { type: "auto" };
  }
  if (toolChoice === "required" || toolChoice === "any") {
    return { type: "any" };
  }
  if (toolChoice === "none") {
    return { type: "none" };
  }
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "tool", name: toolChoice.function?.name ?? "" };
  }
  return { type: "auto" };
}

// ─── Response converter ───────────────────────────────────────

/**
 * Convert an upstream API response into the OpenAI chat.completion
 * shape.  For openai-compatible this is a passthrough; for anthropic
 * it translates content blocks and tool_use into message.tool_calls.
 *
 * @param {object} profile       – upstream profile (for model)
 * @param {object} rawResponse   – body returned by upstream
 * @returns {object} OpenAI chat.completion object
 */
export function convertUpstreamChatResponse(profile, rawResponse) {
  const p = normalizeUpstreamProfile(profile);

  if (p.protocol === "anthropic") {
    return convertAnthropicResponseToOpenAI(rawResponse, p.model);
  }

  // openai-compatible – return the response as-is
  return rawResponse;
}

function convertAnthropicResponseToOpenAI(response, model) {
  const contentBlocks = response.content ?? [];

  // Extract text
  const textParts = contentBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  const text = textParts.join("");

  // Extract tool_use blocks
  const toolUses = contentBlocks.filter((b) => b.type === "tool_use");

  const message = { role: "assistant" };

  if (text) {
    message.content = text;
  } else {
    message.content = null;
  }

  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
    }));
  }

  // finish_reason mapping
  let finishReason = "stop";
  if (response.stop_reason === "tool_use") {
    finishReason = "tool_calls";
  } else if (response.stop_reason === "max_tokens") {
    finishReason = "length";
  } else if (response.stop_reason === "end_turn" || !response.stop_reason) {
    finishReason = "stop";
  }

  // usage mapping
  const usage = {};
  if (response.usage) {
    const inTk  = response.usage.input_tokens ?? 0;
    const outTk = response.usage.output_tokens ?? 0;
    usage.prompt_tokens     = inTk;
    usage.completion_tokens = outTk;
    usage.total_tokens      = inTk + outTk;
  }

  return {
    id: response.id ?? `msg_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || response.model || "unknown",
    choices: [
      { index: 0, message, finish_reason: finishReason },
    ],
    usage,
  };
}

// ─── Connection tester ─────────────────────────────────────────

/**
 * Run a multi-stage connection test against an upstream provider.
 *
 * Stages (in order):
 *   1. 配置验证   – profile validation
 *   2. 模型探测   – model listing (openai-compatible only)
 *   3. 最小聊天   – minimal non-streaming chat
 *   4. 流式响应   – streaming request
 *   5. 工具调用   – tool-calling request
 *
 * Every stage result is an object:
 *   { stage: string, status: "ok"|"fail"|"skip"|"warn", detail: string }
 *
 * On failure the stage's detail contains a stable error category
 * (see classifyUpstreamConnectionError) — never the raw error text,
 * so API keys cannot leak.
 *
 * @param {object}   profile
 * @param {Function} [fetchImpl]       – fetch substitute (default: globalThis.fetch)
 * @param {number}   [timeoutMs]       – per-request timeout in ms (default: 10000)
 * @returns {Promise<Array<{stage:string,status:string,detail:string}>>}
 */
export async function testUpstreamConnection(
  profile,
  { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {},
) {
  const results = [];

  // ── Stage 1: 配置验证 ──────────────────────────────────────
  let p;
  try {
    p = normalizeUpstreamProfile(profile);
    results.push({ stage: "配置验证", status: "ok", detail: "配置格式正确" });
  } catch (err) {
    results.push({
      stage: "配置验证",
      status: "fail",
      detail: `配置错误: ${err.message}`,
    });
    return results;
  }

  const readJson = async (res) => {
    if (!res) return null;
    if (typeof res.json === "function") {
      try { return await res.json(); } catch { /* fall through */ }
    }
    if (typeof res.text === "function") {
      try {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch { /* ignore */ }
    }
    return null;
  };

  const readText = async (res) => {
    if (!res || typeof res.text !== "function") return "";
    try { return await res.text(); } catch { return ""; }
  };

  const getHeader = (res, name) => {
    const lower = String(name).toLowerCase();
    if (typeof res?.headers?.get === "function") return String(res.headers.get(name) || "");
    if (res?.headers && typeof res.headers === "object") {
      return String(res.headers[name] || res.headers[lower] || "");
    }
    return "";
  };

  const validateBasicChatResponse = (raw) => {
    if (p.protocol === "anthropic") {
      return raw && Array.isArray(raw.content);
    }
    return raw && Array.isArray(raw.choices) && raw.choices[0]?.message && typeof raw.choices[0].message === "object";
  };

  const hasToolCallResponse = (raw) => {
    if (p.protocol === "anthropic") {
      return Array.isArray(raw?.content) && raw.content.some((block) => block?.type === "tool_use");
    }
    return Array.isArray(raw?.choices?.[0]?.message?.tool_calls)
      && raw.choices[0].message.tool_calls.length > 0;
  };

  // Helper: safe fetch wrapper that classifies errors
  const doFetch = async (url, opts) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetchImpl(url, { ...opts, signal });
      return res;
    } catch (err) {
      // Map abort errors to timeout
      if (err.name === "AbortError") throw new Error("timeout");
      throw err;
    }
  };

  // ── Stage 2: 模型探测 ──────────────────────────────────────
  if (p.protocol === "openai-compatible") {
    try {
      const modelUrl = `${openAICompatibleBaseUrl(p.baseUrl || OPENAI_DEFAULT_BASE)}/models`;
      const modelRes = await doFetch(modelUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${p.apiKey}`,
        },
      });

      if (modelRes.ok) {
        const body = await readJson(modelRes);
        const models = Array.isArray(body?.data)
          ? body.data.map((item) => String(item?.id || "")).filter(Boolean)
          : [];
        results.push({
          stage: "模型探测",
          status: "ok",
          detail: models.length
            ? `成功获取模型列表: ${models.slice(0, 8).join(", ")}`
            : "成功访问模型列表，但没有解析到模型名称",
          models,
        });
      } else if (modelRes.status === 404) {
        results.push({ stage: "模型探测", status: "skip", detail: "端点不支持模型列表" });
      } else if (modelRes.status === 401 || modelRes.status === 403) {
        results.push({ stage: "模型探测", status: "fail", detail: "认证失败: auth" });
        return results;
      } else {
        results.push({
          stage: "模型探测",
          status: "warn",
          detail: `返回状态码 ${modelRes.status}`,
        });
      }
    } catch (err) {
      const cat = classifyUpstreamConnectionError(err);
      results.push({ stage: "模型探测", status: "fail", detail: `连接失败: ${cat}` });
      return results;
    }
  } else {
    results.push({ stage: "模型探测", status: "skip", detail: "Anthropic 无公开模型列表" });
  }

  // Shared helper for chat stages
  const chatStage = async (stageName, bodyOverrides, options = {}) => {
    const chatBody = {
      model: p.model || (p.protocol === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini"),
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 10,
      ...bodyOverrides,
    };

    try {
      const req = buildUpstreamChatRequest(p, chatBody);
      const res = await doFetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
      });

      if (!res.ok) {
        const errorText = await readText(res);
        const cat = classifyUpstreamConnectionError({
          status: res.status,
          message: errorText,
        });
        const status = options.optional ? "warn" : "fail";
        const detailPrefix = options.optional ? "能力未验证" : "请求失败";
        results.push({ stage: stageName, status, detail: `${detailPrefix}: ${cat}` });
        return options.optional;
      }

      if (options.kind === "stream") {
        const contentType = getHeader(res, "content-type").toLowerCase();
        if (contentType.includes("text/event-stream") || res.body) {
          results.push({ stage: stageName, status: "ok", detail: "流式响应可用" });
          return true;
        }
        const text = await readText(res);
        if (/\bdata\s*:/.test(text)) {
          results.push({ stage: stageName, status: "ok", detail: "流式响应可用" });
        } else {
          results.push({ stage: stageName, status: "warn", detail: "基础聊天可用，但流式响应未验证或不支持" });
        }
        return true;
      }

      const raw = await readJson(res);
      if (options.kind === "tool") {
        if (hasToolCallResponse(raw)) {
          results.push({ stage: stageName, status: "ok", detail: "工具调用可用" });
        } else {
          results.push({ stage: stageName, status: "warn", detail: "基础聊天可用，但工具调用未验证或不支持" });
        }
        return true;
      }

      if (!validateBasicChatResponse(raw)) {
        results.push({ stage: stageName, status: "fail", detail: "协议不匹配: protocol_mismatch" });
        return false;
      }
      results.push({ stage: stageName, status: "ok", detail: "基础聊天响应结构正确" });
      return true;
    } catch (err) {
      const cat = classifyUpstreamConnectionError(err);
      const status = options.optional ? "warn" : "fail";
      const detailPrefix = options.optional ? "能力未验证" : "连接失败";
      results.push({ stage: stageName, status, detail: `${detailPrefix}: ${cat}` });
      return options.optional;
    }
  };

  // ── Stage 3: 最小聊天 ──────────────────────────────────────
  const chatOk = await chatStage("最小聊天", {}, { kind: "chat" });
  if (!chatOk) return results;

  // ── Stage 4: 流式响应 ──────────────────────────────────────
  const streamOk = await chatStage("流式响应", { stream: true }, { kind: "stream", optional: true });
  if (!streamOk) return results;

  // ── Stage 5: 工具调用 ──────────────────────────────────────
  const toolsOk = await chatStage("工具调用", {
    tools: [
      {
        type: "function",
        function: {
          name: "ping",
          description: "Simple test tool",
          parameters: { type: "object", properties: { msg: { type: "string" } } },
        },
      },
    ],
    tool_choice: "required",
  }, { kind: "tool", optional: true });
  if (!toolsOk) return results;

  return results;
}
