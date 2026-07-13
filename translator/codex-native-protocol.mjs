import { createHash, randomUUID } from "node:crypto";

// The structural conversion rules in this module are equivalent ports of
// CC Switch's transform_codex_chat.rs (MIT, Copyright 2025 Jason Young).

const CHAT_TOOL_NAME_MAX_LEN = 64;
const TOOL_SEARCH_PROXY_NAME = "tool_search";
const CUSTOM_TOOL_INPUT_FIELD = "input";
const CUSTOM_TOOL_PRESERVED_METADATA_HEADING = "Original tool definition:";

export function responsesToAntigravityChat(request = {}) {
  const messages = [];
  const routing = {};
  const input = typeof request.input === "string"
    ? [{ type: "message", role: "user", content: request.input }]
    : Array.isArray(request.input) ? request.input : request.input && typeof request.input === "object" ? [request.input] : [];
  const tools = normalizeTools(request.tools, input, routing);

  if (typeof request.instructions === "string" && request.instructions.trim()) {
    messages.push({ role: "system", content: request.instructions });
  }

  let pendingCalls = null;
  const flushCalls = () => {
    if (!pendingCalls) return;
    messages.push(pendingCalls);
    pendingCalls = null;
  };

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message" || item.role) {
      flushCalls();
      const content = responsesContentToChatContent(item.content);
      if (!isEmptyContent(content)) messages.push({ role: normalizeRole(item.role), content });
      continue;
    }
    if (["input_text", "input_image", "input_file", "input_audio"].includes(item.type)) {
      flushCalls();
      const content = responsesContentToChatContent([item]);
      if (!isEmptyContent(content)) messages.push({ role: normalizeRole(item.role), content });
      continue;
    }
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      if (!pendingCalls) pendingCalls = { role: "assistant", content: null, tool_calls: [] };
      const name = item.type === "tool_search_call" ? TOOL_SEARCH_PROXY_NAME : String(item.name || "");
      const route = routeForCodexName(routing, name, item.namespace);
      const argumentsText = item.type === "custom_tool_call"
        ? canonicalJsonString({ [CUSTOM_TOOL_INPUT_FIELD]: String(item.input ?? "") })
        : item.type === "tool_search_call"
          ? canonicalJsonString(item.arguments ?? {})
        : stringArguments(item.arguments);
      pendingCalls.tool_calls.push({
        id: String(item.call_id || item.id || callId()),
        type: "function",
        function: { name: route?.providerName || name, arguments: argumentsText },
      });
      continue;
    }
    if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)) {
      flushCalls();
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id || item.id || ""),
        content: item.type === "function_call_output"
          ? outputText(item.output)
          : canonicalJsonString(item),
      });
    }
  }
  flushCalls();

  const result = {
    model: request.model,
    messages,
    reasoning: request.reasoning,
    stream: false,
    _routing: routing,
  };
  if (tools.length > 0) {
    result.tools = tools;
    result.tool_choice = normalizeToolChoice(request.tool_choice, routing);
    result.parallel_tool_calls = request.parallel_tool_calls ?? true;
  }
  return result;
}

export function buildAntigravityProtocolPrompt(chat = {}) {
  const tools = Array.isArray(chat.tools) ? chat.tools : [];
  const lines = [
    "[CODEX_PROVIDER_PROTOCOL]",
    "You provide model reasoning for the Codex client. Codex itself owns and executes every local tool.",
    "Use a tool only when it is needed to answer the current user request.",
    "When a tool is needed, return only one explicit tool block in this exact shape and no surrounding prose:",
    '<tool_calls><invoke name="tool_name"><parameter name="argument_name">argument value</parameter></invoke></tool_calls>',
    "Do not claim that it ran, changed files, or completed work until a matching [TOOL_RESULT] appears in the conversation.",
    "If no tool is needed, reply normally.",
  ];

  if (chat.tool_choice === "none") {
    lines.push("[TOOL_CHOICE]", "Codex disabled tools for this request. Reply normally without a tool block.");
  } else if (chat.tool_choice?.type === "function" && chat.tool_choice?.function?.name) {
    lines.push("[TOOL_CHOICE]", `Codex selected the exact tool ${chat.tool_choice.function.name} for this request.`);
  }

  if (tools.length > 0) {
    lines.push("[CODEX_TOOLS]");
    for (const tool of tools) {
      const fn = tool?.function || tool;
      if (!fn?.name) continue;
      lines.push(JSON.stringify({
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || { type: "object", properties: {} },
      }));
    }
  }

  lines.push("[CONVERSATION]");
  const toolNames = new Map();
  for (const message of chat.messages || []) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      if (message.content) lines.push(`[ASSISTANT]\n${contentText(message.content)}`);
      for (const toolCall of message.tool_calls) {
        const id = String(toolCall?.id || "");
        const name = String(toolCall?.function?.name || "");
        if (id) toolNames.set(id, name);
        lines.push(`[ASSISTANT_TOOL_CALL] ${JSON.stringify({
          call_id: id,
          name,
          arguments: stringArguments(toolCall?.function?.arguments),
        })}`);
      }
      continue;
    }
    if (message?.role === "tool") {
      const callIdValue = String(message.tool_call_id || "");
      lines.push(`[TOOL_RESULT] ${JSON.stringify({
        call_id: callIdValue,
        name: toolNames.get(callIdValue) || "",
        output: contentText(message.content),
      })}`);
      continue;
    }
    const text = contentText(message?.content);
    if (text) lines.push(`[${String(message?.role || "user").toUpperCase()}]\n${text}`);
  }
  return lines.join("\n\n");
}

export function antigravityCompletionToResponses(completion = {}, originalRequest = {}, options = {}) {
  if (!Array.isArray(completion?.choices)) throw new Error("Chat completion is missing choices.");
  if (completion.choices.length === 0) throw new Error("Chat completion has empty choices.");
  const choice = completion.choices[0];
  if (!choice?.message || typeof choice.message !== "object") throw new Error("Chat completion is missing message.");
  const message = choice.message;
  const inlineThink = typeof message.content === "string" ? splitLeadingThinkBlock(message.content) : null;
  const responseContent = inlineThink ? inlineThink.answer : message.content;
  const routing = options.routing || responsesToAntigravityChat(originalRequest)._routing;
  const directCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const explicitCalls = directCalls.length > 0
    ? directCalls
    : extractExplicitToolCalls(responseContent, routing);
  const output = [];

  const reasoningText = message.reasoning_content || inlineThink?.reasoning || "";
  if (reasoningText) {
    output.push({
      type: "reasoning",
      id: `rs_${uuid()}`,
      status: "completed",
      summary: [{ type: "summary_text", text: String(reasoningText) }],
    });
  }

  const content = directCalls.length > 0 ? contentText(responseContent) : explicitCalls.length > 0 ? "" : contentText(responseContent);
  if (content) {
    output.push({
      type: "message",
      id: `msg_${uuid()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }

  for (const call of explicitCalls) {
    const providerName = String(call?.function?.name || call?.name || "");
    const route = routing?.[providerName];
    const callIdValue = String(call.id || call.call_id || callId());
    const argumentsText = stringArguments(call?.function?.arguments ?? call.arguments);
    if (route?.type === "tool_search") {
      output.push({
        type: "tool_search_call",
        call_id: callIdValue,
        status: "completed",
        execution: "client",
        arguments: parseToolSearchArguments(argumentsText),
      });
    } else if (route?.type === "custom") {
      output.push({
        type: "custom_tool_call",
        id: `ctc_${callIdValue}`,
        call_id: callIdValue,
        name: route.codexName,
        input: customInput(argumentsText),
        status: "completed",
      });
    } else {
      const item = {
        type: "function_call",
        id: `fc_${callIdValue}`,
        call_id: callIdValue,
        name: route?.codexName || providerName,
        arguments: argumentsText,
        status: "completed",
      };
      if (route?.namespace) item.namespace = route.namespace;
      output.push(item);
    }
  }

  const finishReason = choice.finish_reason;
  return {
    id: completion.id || `resp_${uuid()}`,
    object: "response",
    created_at: completion.created || Math.floor(Date.now() / 1000),
    status: finishReason === "length" || finishReason === "content_filter" ? "incomplete" : "completed",
    error: null,
    incomplete_details: finishReason === "length"
      ? { reason: "max_output_tokens" }
      : finishReason === "content_filter" ? { reason: "content_filter" } : null,
    instructions: originalRequest.instructions ?? null,
    max_output_tokens: originalRequest.max_output_tokens ?? null,
    model: completion.model || originalRequest.model || "",
    output,
    parallel_tool_calls: originalRequest.parallel_tool_calls ?? true,
    previous_response_id: originalRequest.previous_response_id ?? null,
    reasoning: originalRequest.reasoning ?? { effort: null, summary: null },
    store: originalRequest.store ?? false,
    temperature: originalRequest.temperature ?? null,
    text: originalRequest.text ?? { format: { type: "text" } },
    tool_choice: originalRequest.tool_choice ?? "auto",
    tools: originalRequest.tools ?? [],
    top_p: originalRequest.top_p ?? null,
    truncation: originalRequest.truncation ?? "disabled",
    usage: mapUsage(completion.usage),
    user: originalRequest.user ?? null,
    metadata: originalRequest.metadata ?? {},
  };
}

export function chatErrorToResponsesError(body) {
  if (body == null) {
    return responseError("Upstream returned an empty error response");
  }
  if (typeof body === "string") return responseError(body);

  const source = body?.error && typeof body.error === "object" ? body.error : body;
  const message = firstString(
    source?.message,
    source?.detail,
    source?.status_msg,
    source?.base_resp?.status_msg,
  ) || canonicalJsonString(source || "Upstream error");
  return {
    error: {
      message,
      type: firstString(source?.type) || "upstream_error",
      code: source?.code ?? source?.base_resp?.status_code ?? null,
      param: source?.param ?? null,
    },
  };
}

export function extractExplicitToolCalls(content, routing = {}) {
  const original = contentText(content).trim();
  if (!original) return [];
  const normalized = normalizeDsmlTags(original);
  const wrapper = normalized.match(/^<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>$/i);
  if (!wrapper) return [];

  const calls = [];
  const invokePattern = /<invoke\s+name=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/invoke>/gi;
  for (const invoke of wrapper[1].matchAll(invokePattern)) {
    const name = decodeXml(invoke[1] || invoke[2] || "");
    if (!routing?.[name]) continue;
    const args = {};
    const parameterPattern = /<parameter\s+name=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/parameter>/gi;
    for (const parameter of invoke[3].matchAll(parameterPattern)) {
      const key = decodeXml(parameter[1] || parameter[2] || "");
      if (key) args[key] = decodeXml(parameter[3].trim());
    }
    calls.push({
      id: callId(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return calls;
}

function normalizeTools(input, historyInput, routing) {
  const tools = [];
  const used = new Set();
  const addTool = (tool, namespace = null) => {
    if (!tool || typeof tool !== "object") return;
    if (tool.type === "namespace") {
      const namespaceName = String(tool.name || "").trim();
      for (const child of Array.isArray(tool.tools) ? tool.tools : Array.isArray(tool.children) ? tool.children : []) {
        if (child?.type === "function") addTool(child, namespaceName);
      }
      return;
    }

    if (tool.type === "tool_search") {
      const providerName = uniqueToolName(TOOL_SEARCH_PROXY_NAME, used);
      routing[providerName] = {
        providerName,
        codexName: TOOL_SEARCH_PROXY_NAME,
        type: "tool_search",
        namespace: null,
      };
      tools.push({
        type: "function",
        function: {
          name: providerName,
          description: "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query for tools or connectors to load." },
              limit: { type: "integer", description: "Maximum number of tool groups to return." },
            },
            required: ["query"],
          },
        },
      });
      return;
    }

    const codexName = String(tool.name || tool.function?.name || "").trim();
    if (!codexName) return;
    const desiredName = namespace ? flattenNamespaceToolName(namespace, codexName) : codexName;
    const providerName = uniqueToolName(desiredName, used);
    const type = tool.type === "custom" ? "custom" : namespace ? "namespace" : "function";
    routing[providerName] = { providerName, codexName, type, namespace };
    const customDescription = `${CUSTOM_TOOL_PRESERVED_METADATA_HEADING}\n\`\`\`json\n${canonicalJsonString(tool)}\n\`\`\``;
    tools.push({
      type: "function",
      function: {
        name: providerName,
        description: type === "custom"
          ? customDescription
          : String(tool.description || tool.function?.description || ""),
        parameters: type === "custom"
          ? {
              type: "object",
              properties: {
                [CUSTOM_TOOL_INPUT_FIELD]: {
                  type: "string",
                  description: "Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.",
                },
              },
              required: [CUSTOM_TOOL_INPUT_FIELD],
            }
          : tool.parameters || tool.function?.parameters || { type: "object", properties: {} },
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    });
  };

  for (const tool of Array.isArray(input) ? input : []) {
    addTool(tool);
  }
  collectToolSearchOutputTools(historyInput, addTool);
  return tools;
}

function collectToolSearchOutputTools(value, addTool) {
  if (Array.isArray(value)) {
    for (const item of value) collectToolSearchOutputTools(item, addTool);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "tool_search_output") {
    for (const tool of Array.isArray(value.tools) ? value.tools : []) addTool(tool);
  }
  for (const child of Object.values(value)) collectToolSearchOutputTools(child, addTool);
}

function routeForCodexName(routing, codexName, namespace = null) {
  return Object.values(routing).find((route) => (
    route.codexName === codexName
    && (!namespace || route.namespace === namespace)
  )) || null;
}

function normalizeToolChoice(choice, routing) {
  if (choice == null) return "auto";
  if (typeof choice === "string") return choice;
  const codexName = choice.type === "tool_search"
    ? TOOL_SEARCH_PROXY_NAME
    : String(choice.name || choice.function?.name || "");
  const route = routeForCodexName(routing, codexName, choice.namespace);
  if (!route) return "auto";
  return { type: "function", function: { name: route.providerName } };
}

function uniqueToolName(name, used) {
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 60)}_${index++}`;
  used.add(candidate);
  return candidate;
}

function flattenNamespaceToolName(namespace, name) {
  const fullName = `${namespace}__${name}`;
  if (Buffer.byteLength(fullName, "utf8") <= CHAT_TOOL_NAME_MAX_LEN) return fullName;
  const hash = createHash("sha256").update(fullName).digest("hex").slice(0, 16);
  const suffix = `__${hash}`;
  let prefix = "";
  for (const character of fullName) {
    if (Buffer.byteLength(prefix + character + suffix, "utf8") > CHAT_TOOL_NAME_MAX_LEN) break;
    prefix += character;
  }
  return `${prefix}${suffix}`;
}

function normalizeRole(role) {
  const value = String(role || "user").toLowerCase();
  if (value === "developer") return "system";
  return ["system", "user", "assistant", "tool"].includes(value) ? value : "user";
}

function responsesContentToChatContent(content) {
  if (content == null || typeof content === "string") return content ?? "";
  if (!Array.isArray(content)) return content;

  const parts = [];
  let hasNonTextPart = false;
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text"].includes(part.type)) {
      if (typeof part.text === "string" && part.text) parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "refusal") {
      if (typeof part.refusal === "string" && part.refusal) parts.push({ type: "text", text: part.refusal });
      continue;
    }
    if (part.type === "input_image" && part.image_url != null) {
      parts.push({
        type: "image_url",
        image_url: typeof part.image_url === "object"
          ? structuredClone(part.image_url)
          : { url: String(part.image_url) },
      });
      hasNonTextPart = true;
      continue;
    }
    if (part.type === "input_file" && (part.file_id != null || part.file_data != null)) {
      const file = {};
      for (const key of ["file_id", "file_data", "filename"]) {
        if (part[key] != null) file[key] = part[key];
      }
      parts.push({ type: "file", file });
      hasNonTextPart = true;
      continue;
    }
    if (part.type === "input_audio" && part.input_audio != null) {
      parts.push({ type: "input_audio", input_audio: structuredClone(part.input_audio) });
      hasNonTextPart = true;
    }
  }

  if (hasNonTextPart) return parts;
  return parts.map((part) => part.text).filter(Boolean).join("\n");
}

function isEmptyContent(content) {
  return content == null
    || (typeof content === "string" && content.length === 0)
    || (Array.isArray(content) && content.length === 0);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    if (part.type === "image_url") return `[input_image] ${canonicalJsonString(part.image_url)}`;
    if (part.type === "file") return `[input_file] ${canonicalJsonString(part.file)}`;
    if (part.type === "input_audio") return `[input_audio] ${canonicalJsonString(part.input_audio)}`;
    return "";
  }).filter(Boolean).join("\n");
}

function outputText(output) {
  if (typeof output === "string") {
    try { return canonicalJsonString(JSON.parse(output)); } catch { return output; }
  }
  return canonicalJsonString(output ?? null);
}

function stringArguments(value) {
  if (typeof value === "string") {
    if (!value) return "{}";
    try { return canonicalJsonString(JSON.parse(value)); } catch { return value; }
  }
  return canonicalJsonString(value ?? {});
}

function customInput(argumentsText) {
  try {
    const value = JSON.parse(argumentsText);
    if (value && typeof value === "object" && typeof value.input === "string") return value.input;
  } catch {}
  return argumentsText;
}

function parseToolSearchArguments(argumentsText) {
  if (!String(argumentsText || "").trim()) return {};
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { query: argumentsText };
  } catch {
    return { query: argumentsText };
  }
}

function splitLeadingThinkBlock(text) {
  const match = String(text || "").match(/^\s*<think>\s*([\s\S]*?)\s*<\/think>\s*([\s\S]*)$/i);
  if (!match) return null;
  return { reasoning: match[1].trim(), answer: match[2].trim() };
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) || "";
}

function responseError(message) {
  return {
    error: {
      message,
      type: "upstream_error",
      code: null,
      param: null,
    },
  };
}

function canonicalJsonString(value) {
  try { return JSON.stringify(sortJson(value)); } catch { return String(value ?? ""); }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function normalizeDsmlTags(text) {
  return text
    .replace(/<\s*[|｜]?\s*DSML\s*[|｜]?\s*tool_calls\s*>/gi, "<tool_calls>")
    .replace(/<\/\s*[|｜]?\s*DSML\s*[|｜]?\s*tool_calls\s*>/gi, "</tool_calls>")
    .replace(/<\s*[|｜]?\s*DSML\s*[|｜]?\s*invoke\b/gi, "<invoke")
    .replace(/<\/\s*[|｜]?\s*DSML\s*[|｜]?\s*invoke\s*>/gi, "</invoke>")
    .replace(/<\s*[|｜]?\s*DSML\s*[|｜]?\s*parameter\b/gi, "<parameter")
    .replace(/<\/\s*[|｜]?\s*DSML\s*[|｜]?\s*parameter\s*>/gi, "</parameter>");
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function mapUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.prompt_tokens || 0);
  const output = Number(usage.completion_tokens || 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens || 0) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0) },
    total_tokens: Number(usage.total_tokens || input + output),
  };
}

function uuid() {
  return randomUUID().replaceAll("-", "");
}

function callId() {
  return `call_${uuid()}`;
}
