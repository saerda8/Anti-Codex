import { randomUUID } from "node:crypto";

import { DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS } from "../antigravity-contract.mjs";

const DEFAULT_SESSION_TTL_MS = DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS;
const DEFAULT_MAX_SESSIONS = 128;
const NATIVE_CODEX_TITLE_PROMPT_PREFIX = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.";
const NATIVE_CODEX_TASK_SUGGESTIONS_PROMPT_PREFIX = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project:";

export class ChatAdapterError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ChatAdapterError";
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "antigravity_adapter_error";
    this.type = options.type ?? "server_error";
  }
}

export function createAntigravityChatAdapter(options = {}) {
  const client = options.client;
  if (!client || typeof client.start !== "function" || typeof client.resume !== "function") {
    throw new TypeError("An Antigravity Cascade client with start() and resume() is required.");
  }

  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? (() => `chatcmpl_${randomUUID().replaceAll("-", "")}`);
  const readNativeCustomInstructions = typeof options.nativeCustomInstructions === "function"
    ? options.nativeCustomInstructions
    : () => options.nativeCustomInstructions;
  const sessions = createSessionStore({
    client,
    maxSessions: positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS),
    ttlMs: positiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS),
    setTimer: options.setTimer ?? setTimeout,
    clearTimer: options.clearTimer ?? clearTimeout,
  });

  async function account(requestOptions = {}) {
    if (typeof client.getReadiness !== "function") {
      throw new ChatAdapterError("Antigravity account readiness is unavailable.", {
        statusCode: 503,
        code: "account_readiness_unavailable",
      });
    }
    try {
      const readiness = await client.getReadiness(requestOptions);
      const fingerprint = String(readiness?.accountFingerprint ?? "");
      return {
        object: "antigravity.account",
        provider: "antigravity",
        signedIn: readiness?.signedIn === true,
        identityAvailable: Boolean(fingerprint),
        fingerprint,
        planName: String(readiness?.planName ?? ""),
        tierName: String(readiness?.tierName ?? ""),
      };
    } catch (error) {
      throw mapAntigravityError(error);
    }
  }

  async function models(requestOptions = {}) {
    try {
      const entries = await client.listModels?.(requestOptions) ?? [];
      const created = Math.floor(now() / 1000);
      return {
        object: "list",
        data: entries.map((entry) => ({
          id: String(entry?.id ?? entry?.model ?? ""),
          object: "model",
          created,
          owned_by: "antigravity",
          ...(entry?.displayName ? { display_name: String(entry.displayName) } : {}),
        })).filter((entry) => entry.id),
      };
    } catch (error) {
      throw mapAntigravityError(error);
    }
  }

  async function* stream(body, requestOptions = {}) {
    const prepared = prepareChatRequest(body, sessions, readNativeCustomInstructions());
    const id = idFactory();
    const created = Math.floor(now() / 1000);
    const model = prepared.model;
    const signal = requestOptions.signal;
    const base = { id, object: "chat.completion.chunk", created, model };
    let continuation = null;
    let terminal = false;
    let roleSent = false;
    let nativeHelperText = "";
    const resumedByOwner = prepared.kind === "resume" && prepared.claimMode === "owner";
    const replayedResume = prepared.kind === "resume" && !resumedByOwner;
    const replayEvents = [];

    try {
      let events;
      if (prepared.kind === "resume") {
        continuation = prepared.record.continuation;
        events = resumedByOwner
          ? client.resume(continuation, prepared.results, {
            model,
            signal,
            tools: prepared.tools,
          })
          : sessions.replay(prepared.record);
      } else {
        events = client.start({
          model,
          userText: prepared.userText,
          userItems: prepared.userItems,
          systemSections: prepared.systemSections,
          tools: prepared.tools,
          toolChoice: prepared.toolChoice,
          parallelToolCalls: prepared.parallelToolCalls,
          reasoningEffort: prepared.reasoningEffort,
          signal,
        });
      }

      for await (const event of events) {
        if (resumedByOwner) replayEvents.push(event);
        if (terminal) {
          throw new ChatAdapterError("Antigravity emitted data after a terminal event.", {
            statusCode: 502,
            code: "multiple_terminal_events",
          });
        }
        if (event?.type === "ready") {
          if (!roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          continue;
        }
        if (event?.type === "text_delta") {
          const delta = String(event.delta ?? "");
          if (delta && !roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          if (delta && prepared.nativeHelperKind) nativeHelperText += delta;
          else if (delta) yield chunk(base, { content: delta }, null);
          continue;
        }
        if (event?.type === "reasoning_delta") {
          const delta = String(event.delta ?? "");
          if (delta && !roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          if (delta) yield chunk(base, { reasoning_content: delta }, null);
          continue;
        }
        if (event?.type === "tool_calls") {
          continuation = event.continuation ?? null;
          if (!continuation) {
            throw new ChatAdapterError("Antigravity tool calls are missing opaque Cascade continuation state.", {
              statusCode: 502,
              code: "cascade_continuation_missing",
            });
          }
          const calls = normalizeCascadeCalls(event.calls);
          if (!replayedResume) {
            await sessions.put(continuation, calls, {
              replacingRecord: resumedByOwner ? prepared.record : null,
            });
          }
          if (resumedByOwner) sessions.complete(prepared.record, replayEvents);
          if (!roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          yield chunk(base, {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.callId,
              type: "function",
              function: {
                name: call.name,
                arguments: call.argumentsJson,
              },
            })),
          }, null);
          terminal = true;
          yield chunk(base, {}, "tool_calls", event.usage);
          return;
        }
        if (event?.type === "done") {
          if (resumedByOwner) sessions.complete(prepared.record, replayEvents);
          const nativeHelperOutput = prepared.nativeHelperKind
            ? normalizeNativeCodexHelperOutput(prepared.nativeHelperKind, nativeHelperText)
            : "";
          if (!roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          if (prepared.nativeHelperKind) {
            yield chunk(base, {
              content: nativeHelperOutput,
            }, null);
          }
          terminal = true;
          yield chunk(base, {}, "stop", event.usage);
          return;
        }
        if (event?.type === "error") throw event.error ?? new Error("Antigravity failed.");
        throw new ChatAdapterError(`Unsupported Antigravity event: ${String(event?.type ?? "missing")}`, {
          statusCode: 502,
          code: "unsupported_cascade_event",
        });
      }
      throw new ChatAdapterError("Antigravity ended without a terminal event.", {
        statusCode: 502,
        code: "cascade_terminal_missing",
      });
    } catch (error) {
      if (resumedByOwner) sessions.fail(prepared.record, error);
      if (continuation && !replayedResume) {
        await Promise.resolve(client.cancel?.(continuation)).catch(() => {});
      }
      if (isAbortError(error) || signal?.aborted) throw signal?.reason ?? error;
      throw mapAntigravityError(error);
    }
  }

  async function complete(body, requestOptions = {}) {
    let id = "";
    let created = 0;
    let model = String(body?.model ?? "");
    let content = "";
    let reasoning = "";
    let toolCalls = [];
    let finishReason = null;
    let usage;

    for await (const item of stream(body, requestOptions)) {
      id = item.id;
      created = item.created;
      model = item.model;
      const choice = item.choices[0];
      if (typeof choice.delta?.content === "string") content += choice.delta.content;
      if (typeof choice.delta?.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
      if (Array.isArray(choice.delta?.tool_calls)) {
        toolCalls = choice.delta.tool_calls.map(({ index: _index, ...call }) => call);
      }
      if (choice.finish_reason !== null) finishReason = choice.finish_reason;
      if (item.usage) usage = item.usage;
    }

    const message = {
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
  }

  return {
    account,
    models,
    stream,
    complete,
    close: () => sessions.close(),
    get sessionCount() {
      return sessions.size;
    },
  };
}

function prepareChatRequest(body, sessions, nativeCustomInstructions) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("Chat Completions body must be an object.");
  }
  const model = String(body.model ?? "").trim();
  if (!model) throw invalidRequest("model is required.");
  if (body.n !== undefined && Number(body.n) !== 1) {
    throw invalidRequest("Only n=1 is supported.", "unsupported_choice_count");
  }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages?.length) throw invalidRequest("messages must be a non-empty array.");
  const requestedTools = normalizeChatTools(body.tools, body.tool_choice);
  const continuation = trailingToolContinuation(messages);
  if (continuation) {
    const hasUserHistory = messages.some((message) => String(message?.role ?? "").toLowerCase() === "user");
    const claim = sessions.claim(continuation.callIds, continuation.results, {
      allowMissing: hasUserHistory,
    });
    if (claim) {
      return {
        kind: "resume",
        model,
        record: claim.record,
        claimMode: claim.mode,
        results: claim.record.calls.map((call) => ({
          callId: call.callId,
          output: continuation.results.get(call.callId),
          isError: false,
        })),
        tools: requestedTools,
      };
    }
    if (!completeToolResultSet(continuation.callIds, continuation.results)) {
      throw new ChatAdapterError("Every pending tool call result is required before restart recovery.", {
        statusCode: 409,
        code: "incomplete_tool_results",
      });
    }
    return prepareRestartContinuation(body, messages, model, requestedTools, nativeCustomInstructions);
  }

  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "").toLowerCase() === "user") {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) throw invalidRequest("A current user message is required.");
  const userContent = normalizeUserContent(messages[currentUserIndex]?.content);
  const userText = userContent.text;
  const systemSections = [];
  const suppliedStructuredOutput = normalizeStructuredOutput(body.response_format);
  const nativeTitleHelper = isNativeCodexTitleRequest(userText, suppliedStructuredOutput);
  const nativeTaskSuggestionsHelper = isNativeCodexTaskSuggestionsRequest(userText, suppliedStructuredOutput);
  const nativeTextOnlyHelper = nativeTitleHelper || nativeTaskSuggestionsHelper;
  const trustedNativeInstructions = addNativeCustomInstructions(
    systemSections,
    nativeCustomInstructions,
    !nativeTextOnlyHelper,
  );
  const structuredOutput = suppliedStructuredOutput
    ?? (body.response_format === undefined || body.response_format === null
      ? nativeTitleHelper
        ? nativeCodexTitleStructuredOutput()
        : nativeTaskSuggestionsHelper
          ? nativeCodexTaskSuggestionsStructuredOutput()
          : null
      : null);
  const tools = nativeTextOnlyHelper ? [] : requestedTools;
  const history = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] ?? {};
    const role = String(message.role ?? "").toLowerCase();
    if (index === currentUserIndex) continue;
    if (role === "system" || role === "developer") {
      const content = messageText(message.content, { allowEmpty: true });
      if (content) systemSections.push({
        kind: "instructions",
        role,
        title: role === "developer" ? "Codex developer instructions" : "Codex system instructions",
        content,
      });
      continue;
    }
    const historyMessage = stripExactNativeCustomInstructions(message, trustedNativeInstructions);
    if (historyMessage) history.push(normalizeHistoryMessage(historyMessage));
  }
  if (history.length) {
    systemSections.push({
      kind: "chat_history",
      role: "internal",
      title: "Prior Chat Completions messages",
      contentTrust: "untrusted_transcript",
      messages: history,
    });
  }
  if (structuredOutput) systemSections.push(structuredOutput.section);
  return {
    kind: "start",
    model,
    userText,
    userItems: userContent.items,
    systemSections,
    tools,
    toolChoice: nativeTextOnlyHelper ? "none" : normalizeToolChoice(body.tool_choice),
    parallelToolCalls: nativeTextOnlyHelper ? false : body.parallel_tool_calls !== false,
    reasoningEffort: String(body.reasoning_effort ?? body.reasoning?.effort ?? "").trim(),
    nativeHelperKind: nativeTitleHelper ? "title" : nativeTaskSuggestionsHelper ? "task_suggestions" : "",
  };
}

function normalizeStructuredOutput(responseFormat) {
  if (responseFormat === undefined || responseFormat === null || responseFormat?.type === "text") return null;
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) {
    throw invalidRequest("response_format must be an object.", "invalid_response_format");
  }
  if (responseFormat.type === "json_object") {
    return {
      type: "json_object",
      schemaName: "",
      schema: null,
      section: {
        kind: "structured_output",
        role: "internal",
        title: "Chat Completions structured output contract",
        content: "Return exactly one valid JSON object and no surrounding prose or markdown.",
      },
    };
  }
  if (responseFormat.type !== "json_schema") {
    throw invalidRequest(`Unsupported response_format type: ${String(responseFormat.type || "missing")}`, "unsupported_response_format");
  }
  const definition = responseFormat.json_schema;
  const schema = definition?.schema;
  if (!definition || typeof definition !== "object" || !schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw invalidRequest("response_format.json_schema.schema must be an object.", "invalid_response_format");
  }
  let schemaJson;
  try {
    schemaJson = JSON.stringify(schema);
  } catch (error) {
    throw invalidRequest(`response_format JSON schema is not serializable: ${error instanceof Error ? error.message : String(error)}`, "invalid_response_format");
  }
  return {
    type: "json_schema",
    schemaName: String(definition.name || ""),
    schema,
    section: {
      kind: "structured_output",
      role: "internal",
      title: "Chat Completions structured output contract",
      content: `Return exactly one JSON object matching this schema and no surrounding prose or markdown:\n${schemaJson}`,
    },
  };
}

function nativeCodexTitleStructuredOutput() {
  return normalizeStructuredOutput({
    type: "json_schema",
    json_schema: {
      name: "task_title",
      strict: true,
      schema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 36 },
          description: { type: "string", maxLength: 100 },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
    },
  });
}

function nativeCodexTaskSuggestionsStructuredOutput() {
  const properties = {
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    prompt: { type: "string", minLength: 1 },
    appId: { type: "string" },
  };
  return normalizeStructuredOutput({
    type: "json_schema",
    json_schema: {
      name: "task_suggestions",
      strict: true,
      schema: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties,
              required: Object.keys(properties),
              additionalProperties: false,
            },
          },
        },
        required: ["suggestions"],
        additionalProperties: false,
      },
    },
  });
}

function normalizeNativeCodexHelperOutput(kind, value) {
  const text = String(value || "").trim();
  const parsed = parseJsonObject(text);
  if (kind === "task_suggestions") {
    const suggestions = Array.isArray(parsed?.suggestions)
      ? parsed.suggestions.slice(0, 3).flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const normalized = {
          title: compactHelperText(entry.title, 200),
          description: compactHelperText(entry.description, 500),
          prompt: compactHelperText(entry.prompt, 2000),
          appId: compactHelperText(entry.appId, 200),
        };
        return normalized.title && normalized.description && normalized.prompt ? [normalized] : [];
      })
      : [];
    return JSON.stringify({ suggestions });
  }

  const parsedTitle = compactHelperText(parsed?.title, 36);
  const parsedDescription = compactHelperText(parsed?.description, 100);
  if (parsedTitle || parsedDescription) {
    return JSON.stringify({
      title: parsedTitle || parsedDescription,
      description: parsedDescription || parsedTitle,
    });
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const titleLine = lines.find((line) => /^(?:title|标题)\s*[:：]/i.test(line));
  const descriptionLine = lines.find((line) => /^(?:description|描述|摘要)\s*[:：]/i.test(line));
  const unlabeled = lines.filter((line) => !/^(?:title|标题|description|描述|摘要)\s*[:：]/i.test(line));
  const title = compactHelperText(
    titleLine?.replace(/^(?:title|标题)\s*[:：]\s*/i, "") || unlabeled[0] || text,
    36,
  );
  const description = compactHelperText(
    descriptionLine?.replace(/^(?:description|描述|摘要)\s*[:：]\s*/i, "")
      || unlabeled.slice(title ? 1 : 0).join(" ")
      || title,
    100,
  );
  return JSON.stringify({ title, description });
}

function parseJsonObject(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate || !candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function compactHelperText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "");
  return [...text].slice(0, maxLength).join("");
}

function isNativeCodexTitleRequest(userText, structuredOutput) {
  const text = String(userText || "");
  const promptPrefixMatches = text.startsWith(NATIVE_CODEX_TITLE_PROMPT_PREFIX)
    && /Do NOT respond to the user, answer questions, or attempt to solve the problem; just write a title/i.test(text);
  if (!promptPrefixMatches) return false;
  const currentPromptContractMatches = [
    "Generate a concise UI title (up to 36 characters) for this task.",
    "Fill the structured title field with plain text.",
    "Fill the structured description field with a compact, search-oriented summary (up to 100 characters).",
    "User prompt:",
  ].every((marker) => text.includes(marker));
  if (currentPromptContractMatches) return true;

  const properties = structuredOutput?.schema?.properties;
  return structuredOutput?.type === "json_schema"
    && properties && typeof properties === "object"
    && Object.hasOwn(properties, "title")
    && Object.hasOwn(properties, "description");
}

function isNativeCodexTaskSuggestionsRequest(userText, structuredOutput) {
  const text = String(userText || "");
  const promptPrefixMatches = text.startsWith(NATIVE_CODEX_TASK_SUGGESTIONS_PROMPT_PREFIX)
    && /Return 0 to 3 fresh suggestions\./i.test(text);
  if (!promptPrefixMatches) return false;
  const currentPromptContractMatches = [
    "# Response format",
    "Each suggestion must include:",
    "- prompt: the user message to send",
    "- appId: the single most relevant app id",
    "- write the prompt as something that should launch as a new Codex task in this project",
  ].every((marker) => text.includes(marker));
  if (currentPromptContractMatches) return true;

  const suggestions = structuredOutput?.schema?.properties?.suggestions;
  const itemProperties = suggestions?.items?.properties;
  return structuredOutput?.type === "json_schema"
    && suggestions?.type === "array"
    && Number(suggestions?.maxItems) === 3
    && itemProperties && typeof itemProperties === "object"
    && ["title", "description", "prompt", "appId"].every((name) => Object.hasOwn(itemProperties, name));
}

function prepareRestartContinuation(body, messages, model, tools, nativeCustomInstructions) {
  const systemSections = [];
  const trustedNativeInstructions = addNativeCustomInstructions(systemSections, nativeCustomInstructions);
  const history = [];
  for (const message of messages) {
    const role = String(message?.role ?? "").toLowerCase();
    if (role === "system" || role === "developer") {
      const content = messageText(message?.content, { allowEmpty: true });
      if (content) systemSections.push({
        kind: "instructions",
        role,
        title: role === "developer" ? "Codex developer instructions" : "Codex system instructions",
        content,
      });
      continue;
    }
    const historyMessage = stripExactNativeCustomInstructions(message, trustedNativeInstructions);
    if (historyMessage) history.push(normalizeHistoryMessage(historyMessage));
  }
  systemSections.push({
    kind: "tool_restart_continuation",
    role: "internal",
    title: "Chat tool continuation after local adapter restart",
    content: "The supplied Chat transcript ends with completed tool results. Continue with the next assistant response. A tool call whose completed result is already present must not be requested again solely to reproduce that result.",
  });
  systemSections.push({
    kind: "chat_history",
    role: "internal",
    title: "Prior Chat Completions messages",
    contentTrust: "untrusted_transcript",
    messages: history,
  });
  return {
    kind: "start",
    model,
    userText: "Continue the Chat Completions turn after the completed tool results in the supplied transcript.",
    systemSections,
    tools,
    toolChoice: normalizeToolChoice(body.tool_choice),
    parallelToolCalls: body.parallel_tool_calls !== false,
    reasoningEffort: String(body.reasoning_effort ?? body.reasoning?.effort ?? "").trim(),
  };
}

function addNativeCustomInstructions(systemSections, value, include = true) {
  const content = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (content && include) systemSections.push({
    kind: "native_custom_instructions",
    role: "user",
    title: "Codex native custom instructions (AGENTS.md)",
    content,
  });
  return content;
}

function stripExactNativeCustomInstructions(message, content) {
  if (!content || String(message?.role ?? "").toLowerCase() !== "user") return message;
  const text = messageText(message?.content, { allowEmpty: true }).replace(/\r\n?/g, "\n");
  const wrapper = `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${content}\n</INSTRUCTIONS>`;
  if (text === wrapper) return null;
  const joinedPrefix = `${wrapper}\n`;
  return text.startsWith(joinedPrefix) ? { ...message, content: text.slice(joinedPrefix.length) } : message;
}

function completeToolResultSet(callIds, results) {
  const expected = new Set(callIds);
  return expected.size === results.size && [...expected].every((id) => results.has(id));
}

function trailingToolContinuation(messages) {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role ?? "").toLowerCase() === "assistant"
        && Array.isArray(message?.tool_calls)
        && message.tool_calls.length > 0) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return null;
  const tail = messages.slice(assistantIndex + 1);
  if (!tail.length || tail.some((message) => String(message?.role ?? "").toLowerCase() !== "tool")) {
    return null;
  }
  const callIds = messages[assistantIndex].tool_calls.map((call) => String(call?.id ?? "").trim());
  if (callIds.some((id) => !id) || new Set(callIds).size !== callIds.length) {
    throw invalidRequest("Assistant tool calls require unique IDs.", "invalid_tool_call_ids");
  }
  const results = new Map();
  for (const message of tail) {
    const callId = String(message?.tool_call_id ?? "").trim();
    if (!callId || results.has(callId)) {
      throw invalidRequest("Tool results require unique tool_call_id values.", "invalid_tool_results");
    }
    results.set(callId, normalizeToolResultContent(message.content));
  }
  return { callIds, results };
}

function normalizeHistoryMessage(message) {
  const role = String(message?.role ?? "").toLowerCase();
  if (!role) throw invalidRequest("Every message requires a role.");
  const historyContent = role === "tool"
    ? { value: normalizeToolResultContent(message?.content), hasImage: false }
    : normalizeUserContent(message?.content, { allowEmpty: true });
  const normalized = {
    role,
    content: historyContent.hasImage ? historyContent.parts : historyContent.value ?? historyContent.text,
  };
  if (role === "assistant" && Array.isArray(message?.tool_calls)) {
    normalized.tool_calls = message.tool_calls.map((call) => ({
      id: String(call?.id ?? ""),
      type: "function",
      function: {
        name: String(call?.function?.name ?? ""),
        arguments: String(call?.function?.arguments ?? "{}"),
      },
    }));
  }
  if (role === "tool") normalized.tool_call_id = String(message?.tool_call_id ?? "");
  return normalized;
}

function normalizeToolResultContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw invalidRequest("Tool result content must be text or text/image parts.", "unsupported_tool_result_content");
  }
  return content.map((part) => {
    const type = String(part?.type ?? "");
    if (type === "text" || type === "input_text") {
      return { type: "text", text: String(part?.text ?? "") };
    }
    if (type === "image_url") {
      const source = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
      const url = String(source ?? "");
      if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+$/i.test(url)) {
        throw invalidRequest(
          "Tool result image_url must be a base64 data image.",
          "unsupported_tool_result_image",
        );
      }
      return {
        type: "image_url",
        image_url: {
          url,
          ...(part?.image_url?.detail ? { detail: String(part.image_url.detail) } : {}),
        },
      };
    }
    throw invalidRequest(`Unsupported tool result content part: ${type || "missing"}`, "unsupported_tool_result_content");
  });
}

function messageText(content, options = {}) {
  if (content === null || content === undefined) {
    if (options.allowEmpty) return "";
    throw invalidRequest("Message content must contain text.", "unsupported_message_content");
  }
  if (typeof content === "string") {
    if (content || options.allowEmpty) return content;
    throw invalidRequest("Message content must contain text.", "unsupported_message_content");
  }
  if (!Array.isArray(content)) {
    throw invalidRequest("Only textual Chat message content is supported.", "unsupported_message_content");
  }
  const text = content.map((part) => {
    const type = String(part?.type ?? "text");
    if (type !== "text" && type !== "input_text") {
      throw invalidRequest(`Unsupported Chat content part: ${type}`, "unsupported_message_content");
    }
    return String(part?.text ?? "");
  }).join("");
  if (text || options.allowEmpty) return text;
  throw invalidRequest("Message content must contain text.", "unsupported_message_content");
}

function normalizeUserContent(content, options = {}) {
  if (typeof content === "string") {
    if (content || options.allowEmpty) return {
      text: content,
      parts: content ? [{ type: "text", text: content }] : [],
      items: content ? [{ text: content }] : [],
      hasImage: false,
      value: content,
    };
    throw invalidRequest("Message content must contain text.", "unsupported_message_content");
  }
  if (content === null || content === undefined) {
    if (options.allowEmpty) return { text: "", parts: [], items: [], hasImage: false, value: "" };
    throw invalidRequest("Message content must contain text or an image.", "unsupported_message_content");
  }
  if (!Array.isArray(content)) throw invalidRequest("Only textual or image Chat message content is supported.", "unsupported_message_content");
  const parts = [];
  const items = [];
  let text = "";
  for (const part of content) {
    const type = String(part?.type ?? "text");
    if (type === "text" || type === "input_text") {
      const value = String(part?.text ?? "");
      text += value;
      if (value) {
        parts.push({ type: "text", text: value });
        items.push({ text: value });
      }
      continue;
    }
    if (type === "image_url" || type === "input_image") {
      const image = normalizeImagePart(part);
      parts.push(image.chatPart);
      items.push(image.cascadeItem);
      continue;
    }
    throw invalidRequest(`Unsupported Chat content part: ${type}`, "unsupported_message_content");
  }
  if (!parts.length && !options.allowEmpty) throw invalidRequest("Message content must contain text or an image.", "unsupported_message_content");
  return { text, parts, items, hasImage: parts.some((part) => part.type === "image_url"), value: text };
}

function normalizeImagePart(part) {
  const source = typeof part?.image_url === "string"
    ? part.image_url
    : part?.image_url?.url ?? part?.url;
  const match = String(source ?? "").match(/^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw invalidRequest("Image content must be a base64 data image.", "unsupported_message_image");
  const data = match[2].replace(/\s+/g, "");
  const mimeType = match[1].toLowerCase();
  return {
    chatPart: { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
    cascadeItem: { image: { data, mimeType } },
  };
}

function normalizeChatTools(tools, toolChoice) {
  if (toolChoice === "none") return [];
  const input = tools === undefined ? [] : tools;
  if (!Array.isArray(input)) throw invalidRequest("tools must be an array.", "invalid_tools");
  const names = new Set();
  const normalized = input.map((tool) => {
    if (tool?.type !== "function" || !tool.function || typeof tool.function !== "object") {
      throw invalidRequest("Only function tools are supported.", "unsupported_tool_type");
    }
    const name = String(tool.function.name ?? "").trim();
    if (!name || names.has(name)) throw invalidRequest("Tool names must be non-empty and unique.", "invalid_tools");
    names.add(name);
    return {
      type: "function",
      function: {
        name,
        description: String(tool.function.description ?? ""),
        parameters: tool.function.parameters && typeof tool.function.parameters === "object"
          ? tool.function.parameters
          : { type: "object", properties: {}, additionalProperties: true },
      },
    };
  });
  const forced = typeof toolChoice === "object"
    ? String(toolChoice?.function?.name ?? "").trim()
    : "";
  if (forced) {
    const match = normalized.find((tool) => tool.function.name === forced);
    if (!match) throw invalidRequest(`Forced tool is not defined: ${forced}`, "invalid_tool_choice");
    return [match];
  }
  if (toolChoice === "required") {
    throw invalidRequest("Antigravity does not expose a protocol-level required tool mode.", "unsupported_tool_choice");
  }
  return normalized;
}

function normalizeToolChoice(value) {
  if (value === undefined || value === null || value === "auto") return "auto";
  if (value === "none") return "none";
  if (typeof value === "object") return { type: "function", function: { name: String(value?.function?.name ?? "") } };
  return String(value);
}

function normalizeCascadeCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new ChatAdapterError("Antigravity tool event contains no calls.", {
      statusCode: 502,
      code: "empty_tool_calls",
    });
  }
  const ids = new Set();
  return calls.map((call) => {
    const callId = String(call?.callId ?? "").trim();
    const name = String(call?.name ?? "").trim();
    if (!callId || !name || ids.has(callId)) {
      throw new ChatAdapterError("Antigravity tool calls require stable unique IDs and names.", {
        statusCode: 502,
        code: "invalid_cascade_tool_call",
      });
    }
    const argumentsValue = call?.arguments ?? {};
    if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
      throw new ChatAdapterError("Antigravity tool call arguments must be a JSON object.", {
        statusCode: 502,
        code: "invalid_cascade_tool_arguments",
      });
    }
    let argumentsJson;
    try {
      argumentsJson = JSON.stringify(argumentsValue);
    } catch (error) {
      throw new ChatAdapterError("Antigravity tool call arguments must be JSON serializable.", {
        cause: error,
        statusCode: 502,
        code: "invalid_cascade_tool_arguments",
      });
    }
    ids.add(callId);
    return { callId, name, arguments: argumentsValue, argumentsJson };
  });
}

function createSessionStore({ client, maxSessions, ttlMs, setTimer, clearTimer }) {
  const records = new Map();
  const byCallId = new Map();
  let sequence = 0;

  function remove(record) {
    if (!record || !records.delete(record.id)) return false;
    clearTimer(record.timer);
    for (const call of record.calls) byCallId.delete(call.callId);
    return true;
  }

  async function cancel(record) {
    const shouldCancel = record?.state !== "completed";
    if (record?.state === "claimed") {
      record.replayDeferred?.reject(new ChatAdapterError("The opaque Cascade continuation expired before completion.", {
        statusCode: 409,
        code: "cascade_session_expired",
      }));
    }
    if (!remove(record)) return;
    if (shouldCancel) await Promise.resolve(client.cancel?.(record.continuation)).catch(() => {});
  }

  async function put(continuation, calls, options = {}) {
    for (const call of calls) {
      if (byCallId.has(call.callId)) {
        throw new ChatAdapterError(`Duplicate pending tool call ID: ${call.callId}`, {
          statusCode: 409,
          code: "duplicate_tool_call_id",
        });
      }
    }
    const replacingRecord = options.replacingRecord || null;
    const activeRecords = () => [...records.values()]
      .filter((record) => record.state !== "completed" && record !== replacingRecord);
    while (activeRecords().length >= maxSessions) {
      await cancel(activeRecords()[0]);
    }
    const completedRecords = [...records.values()].filter((record) => record.state === "completed");
    while (completedRecords.length >= maxSessions) {
      remove(completedRecords.shift());
    }
    const record = {
      id: ++sequence,
      continuation,
      calls,
      timer: null,
      state: "pending",
      claimedResults: null,
      replayDeferred: null,
      replayEvents: null,
    };
    record.timer = setTimer(() => cancel(record), ttlMs);
    record.timer?.unref?.();
    records.set(record.id, record);
    for (const call of calls) byCallId.set(call.callId, record);
  }

  function claim(callIds, results, options = {}) {
    const record = callIds.map((id) => byCallId.get(id)).find(Boolean);
    if (!record) {
      if (options.allowMissing === true) return null;
      throw new ChatAdapterError("The opaque Cascade continuation is missing or expired.", {
        statusCode: 409,
        code: "cascade_session_missing",
      });
    }
    const expected = new Set(record.calls.map((call) => call.callId));
    const supplied = new Set(results.keys());
    const complete = expected.size === supplied.size
      && [...expected].every((id) => supplied.has(id))
      && callIds.length === expected.size
      && callIds.every((id) => expected.has(id));
    if (!complete) {
      throw new ChatAdapterError("Every pending tool call result from the same Cascade is required.", {
        statusCode: 409,
        code: "incomplete_tool_results",
      });
    }
    if (record.state === "pending") {
      record.state = "claimed";
      record.claimedResults = new Map(results);
      record.replayDeferred = createDeferred();
      record.replayDeferred.promise.catch(() => {});
      return { mode: "owner", record };
    }
    const sameResults = record.claimedResults instanceof Map
      && record.claimedResults.size === results.size
      && [...record.claimedResults].every(([id, value]) => toolResultEqual(results.get(id), value));
    if (!sameResults) {
      throw new ChatAdapterError("The same tool call IDs were continued with different results.", {
        statusCode: 409,
        code: "conflicting_tool_results",
      });
    }
    return { mode: record.state === "completed" ? "replay" : "wait", record };
  }

  function complete(record, events) {
    if (!record || record.state !== "claimed" || !records.has(record.id)) return false;
    record.state = "completed";
    record.replayEvents = [...events];
    clearTimer(record.timer);
    record.timer = setTimer(() => remove(record), ttlMs);
    record.timer?.unref?.();
    record.replayDeferred.resolve(record.replayEvents);
    const completedRecords = [...records.values()].filter((item) => item.state === "completed");
    while (completedRecords.length > maxSessions) remove(completedRecords.shift());
    return true;
  }

  function fail(record, error) {
    if (!record || record.state !== "claimed" || !records.has(record.id)) return false;
    record.replayDeferred.reject(error);
    return remove(record);
  }

  async function* replay(record) {
    if (!record || !records.has(record.id)) {
      throw new ChatAdapterError("The opaque Cascade continuation replay is missing or expired.", {
        statusCode: 409,
        code: "cascade_session_missing",
      });
    }
    const events = record.state === "completed"
      ? record.replayEvents
      : await record.replayDeferred.promise;
    for (const event of events || []) yield event;
  }

  async function close() {
    for (const record of [...records.values()]) {
      if (record.state === "completed") remove(record);
      else await cancel(record);
    }
  }

  return {
    put,
    claim,
    complete,
    fail,
    replay,
    close,
    get size() {
      return [...records.values()].filter((record) => record.state !== "completed").length;
    },
  };
}

function toolResultEqual(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function chunk(base, delta, finishReason, usage) {
  return {
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function invalidRequest(message, code = "invalid_request") {
  return new ChatAdapterError(message, { statusCode: 400, code, type: "invalid_request_error" });
}

export function mapAntigravityError(error) {
  if (error instanceof ChatAdapterError) return error;
  const message = String(error?.message ?? error ?? "Antigravity request failed.");
  const statusCode = Number(error?.statusCode ?? error?.status ?? 0);
  if (statusCode === 401 || statusCode === 403 || /(?:login|sign[ -]?in|unauthori[sz]ed|forbidden)/i.test(message)) {
    return new ChatAdapterError(message, { cause: error, statusCode: 401, code: "authentication_error" });
  }
  if (statusCode === 400 && /(?:user\s+)?location is not supported|unsupported (?:user\s+)?location/i.test(message)) {
    return new ChatAdapterError(message, {
      cause: error,
      statusCode: 400,
      code: "unsupported_location",
      type: "invalid_request_error",
    });
  }
  if (statusCode === 429 || /(?:RESOURCE_EXHAUSTED|quota|usage limit|rate limit)/i.test(message)) {
    return new ChatAdapterError(message, { cause: error, statusCode: 429, code: "quota_exceeded" });
  }
  if (statusCode === 504 || error?.name === "TimeoutError" || /timed? out|timeout/i.test(message)) {
    return new ChatAdapterError(message, { cause: error, statusCode: 504, code: "upstream_timeout" });
  }
  if (isNetworkError(error)) {
    return new ChatAdapterError(message, { cause: error, statusCode: 502, code: "upstream_network_error" });
  }
  if (statusCode >= 500) {
    return new ChatAdapterError(message, { cause: error, statusCode: 503, code: "upstream_service_error" });
  }
  return new ChatAdapterError(message, { cause: error, statusCode: 502, code: "upstream_error" });
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function isNetworkError(error) {
  return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]
    .includes(String(error?.code ?? error?.cause?.code ?? ""))
    || /fetch failed|connection (?:refused|reset)|socket hang up/i.test(String(error?.message ?? ""));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
