const CHAT_PROTOCOLS = new Set(["openai-compatible", "chat", "chat-completions", "chatcompletions"]);

export function normalizeCodexPlusPlusProbeProfile(value = {}) {
  const rawProtocol = String(value.protocol ?? "").trim().toLowerCase();
  const protocol = CHAT_PROTOCOLS.has(rawProtocol)
    ? "chatCompletions"
    : rawProtocol === "responses" ? "responses" : "";
  if (!protocol) throw new Error("CodexPlusPlus provider protocol must be Chat Completions or Responses.");

  const baseUrlText = String(value.baseUrl ?? "").trim();
  let baseUrl;
  try {
    baseUrl = new URL(baseUrlText);
  } catch {
    throw new Error("Provider base URL is invalid.");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Provider base URL must use HTTP(S).");
  if (baseUrl.username || baseUrl.password) throw new Error("Provider base URL must not contain credentials.");
  if (baseUrl.search || baseUrl.hash) throw new Error("Provider base URL must not contain a query or fragment.");
  if (baseUrl.protocol === "http:" && !isLoopback(baseUrl.hostname)) {
    throw new Error("Provider HTTP base URL is allowed only on loopback.");
  }

  const model = String(value.model ?? "").trim();
  const apiKey = String(value.apiKey ?? "");
  if (!model) throw new Error("Provider model is required.");
  if (!apiKey) throw new Error("Provider API key is required.");
  return { protocol, baseUrl, model, apiKey };
}

export function buildCodexPlusPlusProbeRequest(value = {}) {
  const profile = normalizeCodexPlusPlusProbeProfile(value);
  const path = probePath(profile.baseUrl.pathname, profile.protocol);
  const url = new URL(profile.baseUrl.href);
  url.pathname = path;
  const body = profile.protocol === "responses"
    ? {
        model: profile.model,
        input: "Reply with OK only.",
        max_output_tokens: 8,
        stream: false,
      }
    : {
        model: profile.model,
        messages: [{ role: "user", content: "Reply with OK only." }],
        max_tokens: 8,
        stream: false,
      };
  return {
    protocol: profile.protocol,
    url: url.href,
    headers: {
      authorization: `Bearer ${profile.apiKey}`,
      "content-type": "application/json",
    },
    body,
    apiKey: profile.apiKey,
  };
}

export async function testCodexPlusPlusUpstreamConnection(value = {}, options = {}) {
  let request;
  try {
    request = buildCodexPlusPlusProbeRequest(value);
  } catch (error) {
    return [{ stage: "配置验证", status: "fail", detail: String(error?.message ?? error) }];
  }
  const timeoutMs = positiveInteger(options.timeoutMs, 10_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const stages = [{
    stage: "CodexPlusPlus 路由",
    status: "ok",
    detail: request.protocol === "responses" ? "Responses" : "Chat Completions",
  }];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Provider probe timed out.", "TimeoutError")), timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      stages.push({
        stage: "模型连通",
        status: "fail",
        detail: `HTTP ${response.status}: ${sanitizeDetail(text, request.apiKey)}`.slice(0, 600),
      });
      return stages;
    }
    const shapeError = protocolResponseShapeError(request.protocol, text);
    if (shapeError) {
      stages.push({
        stage: "模型连通",
        status: "fail",
        detail: `protocol_mismatch: HTTP ${response.status} ${shapeError}`,
      });
      return stages;
    }
    stages.push({
      stage: "模型连通",
      status: "ok",
      detail: `HTTP ${response.status}; ${request.body.model}`,
    });
    return stages;
  } catch (error) {
    stages.push({
      stage: "模型连通",
      status: "fail",
      detail: sanitizeDetail(error?.message ?? error, request.apiKey).slice(0, 600),
    });
    return stages;
  } finally {
    clearTimeout(timer);
  }
}

function probePath(pathname, protocol) {
  const normalized = `/${String(pathname ?? "").replace(/^\/+|\/+$/g, "")}`;
  const chatSuffix = "/chat/completions";
  const responsesSuffix = "/responses";
  if (protocol === "chatCompletions") {
    if (normalized.endsWith(responsesSuffix)) throw new Error("Responses endpoint does not match Chat Completions protocol.");
    if (normalized.endsWith(chatSuffix)) return normalized;
    if (normalized === "/" || normalized === "") return "/v1/chat/completions";
    return `${normalized}${chatSuffix}`.replace(/\/+/g, "/");
  }
  if (normalized.endsWith(chatSuffix)) throw new Error("Chat Completions endpoint does not match Responses protocol.");
  if (normalized.endsWith(responsesSuffix)) return normalized;
  if (normalized === "/" || normalized === "") return "/v1/responses";
  return `${normalized}${responsesSuffix}`.replace(/\/+/g, "/");
}

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(hostname).toLowerCase());
}

function sanitizeDetail(value, secret) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").trim() || "Provider request failed.";
  return secret ? text.replaceAll(secret, "[redacted]") : text;
}

function protocolResponseShapeError(protocol, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return `did not return a valid ${protocol === "responses" ? "Responses" : "Chat Completions"} JSON response.`;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return `did not contain a ${protocol === "responses" ? "Responses" : "Chat Completions"} response object.`;
  }
  if (protocol === "responses") {
    if (body.object === "response" || Array.isArray(body.output) || typeof body.output_text === "string") return "";
    return "did not contain a Responses response object.";
  }
  if (Array.isArray(body.choices)) return "";
  return "did not contain a Chat Completions response object.";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
