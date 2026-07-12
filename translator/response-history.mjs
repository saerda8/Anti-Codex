import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_TOTAL_CHARS = 12_000_000;

export function createResponseHistoryStore(options = {}) {
  const filePath = options.filePath || "";
  const fileSystem = options.fileSystem || fs;
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxTotalChars = positiveInteger(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
  const measureEntryChars = typeof options.measureEntryChars === "function"
    ? options.measureEntryChars
    : serializedEntrySize;
  const entries = new Map();
  const entryChars = new Map();
  let totalChars = 0;

  load();

  function has(responseId) {
    return entries.has(String(responseId || ""));
  }

  function hydrate(request) {
    const previousId = String(request?.previous_response_id || "");
    const previous = entries.get(previousId);
    if (!previous) {
      if (!previousId) return request;
      const error = new Error(`Response history for previous_response_id '${previousId}' has expired or is unavailable. Start a fresh request or reopen the original conversation context before continuing.`);
      error.statusCode = 410;
      error.type = "response_history_missing";
      error.retryable = false;
      error.previous_response_id = previousId;
      throw error;
    }
    return {
      ...request,
      input: [
        ...clone(previous.contextItems),
        ...normalizeInput(request?.input),
      ],
    };
  }

  function remember(response, request) {
    const responseId = String(response?.id || "");
    if (!responseId) return;
    const inputItems = normalizeInput(request?.input);
    const outputItems = Array.isArray(response?.output) ? clone(response.output) : [];
    setEntry(responseId, {
      id: responseId,
      createdAt: Date.now(),
      inputItemCount: inputItems.length,
      contextItems: [...clone(inputItems), ...outputItems],
    });
    prune();
    persist();
  }

  function listInputItems(responseId, options = {}) {
    const entry = entries.get(String(responseId || ""));
    if (!entry) return emptyList();

    const order = options.order === "desc" ? "desc" : "asc";
    const limit = Math.min(100, positiveInteger(options.limit, 20));
    let data = clone(entry.contextItems.slice(0, entry.inputItemCount));
    if (order === "desc") data.reverse();

    const after = String(options.after || "");
    if (after) {
      const index = data.findIndex((item) => item?.id === after);
      if (index >= 0) data = data.slice(index + 1);
    }

    const hasMore = data.length > limit;
    data = data.slice(0, limit);
    return {
      object: "list",
      data,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
      has_more: hasMore,
    };
  }

  function prune() {
    while (entries.size > maxEntries || (entries.size > 1 && totalChars > maxTotalChars)) {
      const oldest = entries.keys().next().value;
      if (!oldest) break;
      deleteEntry(oldest);
    }
  }

  function setEntry(id, entry) {
    deleteEntry(id);
    const measured = Number(measureEntryChars(entry));
    const chars = Number.isFinite(measured) && measured > 0 ? measured : 0;
    entries.set(id, entry);
    entryChars.set(id, chars);
    totalChars += chars;
  }

  function deleteEntry(id) {
    if (!entries.has(id)) return;
    totalChars = Math.max(0, totalChars - (entryChars.get(id) || 0));
    entryChars.delete(id);
    entries.delete(id);
  }

  function load() {
    if (!filePath) return;
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(filePath, "utf8"));
      for (const rawEntry of parsed?.entries ?? []) {
        const entry = compactPersistedEntry(rawEntry);
        if (!entry) continue;
        setEntry(entry.id, entry);
      }
      prune();
    } catch {
      // Missing or damaged local history starts clean.
    }
  }

  function persist() {
    if (!filePath) return;
    let temporary = "";
    try {
      fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
      temporary = `${filePath}.${process.pid}.tmp`;
      fileSystem.writeFileSync(temporary, JSON.stringify({ version: 2, entries: [...entries.values()] }), "utf8");
      try {
        fileSystem.renameSync(temporary, filePath);
      } catch {
        fileSystem.copyFileSync(temporary, filePath);
      }
    } catch (error) {
      try { options.onPersistError?.(error); } catch {}
      // Response history is a recovery aid; request completion must not fail if persistence fails.
    } finally {
      if (temporary) {
        try { fileSystem.rmSync(temporary, { force: true }); } catch {}
      }
    }
  }

  return { has, hydrate, remember, listInputItems };
}

function normalizeInput(input) {
  if (typeof input === "string") {
    return [messageItem("user", input)];
  }
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === "object")
    .map((item) => normalizeItem(item));
}

function normalizeItem(item) {
  const next = clone(item);
  if (!next.id) next.id = `item_${randomUUID().replaceAll("-", "")}`;
  if (next.type === "message" && typeof next.content === "string") {
    const type = next.role === "assistant" ? "output_text" : "input_text";
    next.content = [{ type, text: next.content }];
  }
  return next;
}

function messageItem(role, text) {
  return {
    type: "message",
    id: `item_${randomUUID().replaceAll("-", "")}`,
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}

function clone(value) {
  return structuredClone(value);
}

function compactPersistedEntry(entry) {
  if (!entry?.id || !Array.isArray(entry.contextItems)) return null;
  const legacyInputCount = Array.isArray(entry.inputItems) ? entry.inputItems.length : 0;
  const requestedInputCount = Number.isInteger(entry.inputItemCount)
    ? entry.inputItemCount
    : legacyInputCount;
  return {
    id: String(entry.id),
    createdAt: Number(entry.createdAt) || Date.now(),
    inputItemCount: Math.max(0, Math.min(entry.contextItems.length, requestedInputCount)),
    contextItems: entry.contextItems,
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function serializedEntrySize(entry) {
  return JSON.stringify(entry).length;
}

function emptyList() {
  return {
    object: "list",
    data: [],
    first_id: null,
    last_id: null,
    has_more: false,
  };
}
