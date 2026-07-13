import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import {
  runAntigravityNativeTurnStreamed,
  runAntigravityTextTurn,
} from "./antigravity-agentapi.mjs";
import { buildAntigravityProtocolPrompt } from "./codex-native-protocol.mjs";
import { normalizeAntigravityDisplayName } from "./antigravity-model-catalog.mjs";

export async function callAntigravityNativeHarness(chatBody = {}, options = {}) {
  const prompt = buildAntigravityProtocolPrompt(chatBody);
  if (!prompt.trim()) throw new Error("Anti-Codex could not find any protocol input to send to Antigravity.");

  const transport = String(options.transport || process.env.ANTICODEX_ANTIGRAVITY_TRANSPORT || "desktop-cascade").toLowerCase();
  const model = antigravityModelFor(chatBody.model);
  const turnOptions = {
    cwd: options.modelWorkspace || process.env.ANTICODEX_MODEL_WORKSPACE || tmpdir(),
    env: options.env,
    model,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onCascadeStarted: options.onCascadeStarted,
  };

  let text = "";
  let result = null;
  const events = options.runTurn
    ? options.runTurn(prompt, turnOptions)
    : transport === "cli"
      ? textTurnEvents(prompt, turnOptions)
      : runAntigravityNativeTurnStreamed(prompt, turnOptions);

  for await (const event of toAsyncIterable(events)) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException("The operation was aborted", "AbortError");
    if (event?.type === "text_delta") {
      text += String(event.delta || "");
    } else if (event?.type === "text_replace") {
      text = String(event.text || "");
    } else if (event?.type === "done") {
      result = event.result || event;
      if (typeof result.text === "string") text = result.text;
    } else if (event?.type === "tool_call") {
      throw new Error("Antigravity returned a native tool event on the model-only provider path.");
    }
  }

  const responseId = options.responseId || `chatcmpl_${uuid()}`;
  const resolvedModel = result?.model || model;
  options.onModelRouted?.({
    requestId: responseId,
    transport,
    requestedModel: chatBody.model,
    resolvedModel,
    displayName: normalizeAntigravityDisplayName(resolvedModel, result?.displayName),
    internalModel: result?.internalModel,
    cascadeId: result?.cascadeId || result?.conversationId,
    workspaceCwd: turnOptions.cwd,
    workspaceSource: options.workspaceSource,
    codexSessionId: options.codexSessionId,
    status: "success",
  });

  return {
    id: responseId,
    object: "chat.completion",
    created: options.created || Math.floor(Date.now() / 1000),
    model: chatBody.model || resolvedModel,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: result?.usage || {},
  };
}

async function* textTurnEvents(prompt, options) {
  const result = await runAntigravityTextTurn(prompt, options);
  if (result?.text) yield { type: "text_delta", delta: result.text };
  yield { type: "done", result };
}

async function* toAsyncIterable(value) {
  const resolved = await value;
  if (resolved?.[Symbol.asyncIterator]) {
    yield* resolved;
    return;
  }
  if (resolved?.[Symbol.iterator] && typeof resolved !== "string") {
    yield* resolved;
    return;
  }
  if (resolved && typeof resolved === "object") yield { type: "done", result: resolved };
}

function antigravityModelFor(model) {
  const value = String(model || "");
  if (/^(?:gemini-|claude-|gpt-oss-)/i.test(value)) return value;
  if (/(?:gpt-[\w.-]*mini|\bmini\b|flash|fast)/i.test(value)) return "gemini-3.5-flash-low";
  return "gemini-pro-agent";
}

function uuid() {
  return randomUUID().replaceAll("-", "");
}
