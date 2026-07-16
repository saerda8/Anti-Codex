import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const NATIVE_TITLE_PROMPT_PREFIX = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.";
const NATIVE_TASK_SUGGESTIONS_PROMPT_PHRASE = "Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project:";

export function analyzeNativeCodexActivityRows(rows = [], options = {}) {
  const expectedThreadIds = uniqueStrings(options.expectedThreadIds || []);
  const expected = new Set(expectedThreadIds);
  const titleThreads = new Set();
  const taskSuggestionThreads = new Set();
  const requestThreads = new Set();
  const requestCounts = new Map();
  const toolThreads = new Set();
  const requestRowIds = [];
  let latestRowId = 0;

  for (const rawRow of Array.isArray(rows) ? rows : []) {
    const row = normalizeRow(rawRow);
    latestRowId = Math.max(latestRowId, row.id);
    if (isNativeTitlePrompt(row)) titleThreads.add(row.threadId);
    if (isNativeTaskSuggestionsPrompt(row)) taskSuggestionThreads.add(row.threadId);
    if (isNativeModelRequest(row)) {
      requestThreads.add(row.threadId);
      requestCounts.set(row.threadId, Number(requestCounts.get(row.threadId) || 0) + 1);
      requestRowIds.push(row.id);
    }
    if (isCompletedToolCall(row)) toolThreads.add(row.threadId);
  }

  const titleThreadIds = uniqueStrings(titleThreads);
  const titleSet = new Set(titleThreadIds);
  const taskSuggestionThreadIds = uniqueStrings(taskSuggestionThreads);
  const taskSuggestionSet = new Set(taskSuggestionThreadIds);
  const unexpectedExecutionThreadIds = uniqueStrings(
    [...toolThreads].filter((threadId) => !expected.has(threadId)),
  );
  const unexpectedRequestThreadIds = uniqueStrings(
    [...requestThreads].filter((threadId) => !expected.has(threadId)
      && !titleSet.has(threadId)
      && !taskSuggestionSet.has(threadId)),
  );
  const requestCountsByThread = Object.fromEntries(
    [...requestCounts].sort(([left], [right]) => left.localeCompare(right)),
  );
  const titleThreadsRepeated = titleThreadIds.filter((threadId) => Number(requestCounts.get(threadId) || 0) > 1);
  const taskSuggestionThreadsRepeated = taskSuggestionThreadIds
    .filter((threadId) => Number(requestCounts.get(threadId) || 0) > 1);

  return {
    rowCount: Array.isArray(rows) ? rows.length : 0,
    latestRowId,
    requestCount: requestRowIds.length,
    requestRowIds,
    requestThreadIds: uniqueStrings(requestThreads),
    requestCountsByThread,
    expectedThreadIds,
    titleThreadIds,
    taskSuggestionThreadIds,
    toolExecutionThreadIds: uniqueStrings(toolThreads),
    unexpectedRequestThreadIds,
    unexpectedExecutionThreadIds,
    titleThreadsUsedTools: titleThreadIds.some((threadId) => toolThreads.has(threadId)),
    titleThreadsRepeated,
    taskSuggestionThreadsUsedTools: taskSuggestionThreadIds.some((threadId) => toolThreads.has(threadId)),
    taskSuggestionThreadsRepeated,
  };
}

export function nativePreflightCanSubmit(activity = {}) {
  const requestCount = Number(activity.requestCount || 0);
  const toolCount = Array.isArray(activity.toolExecutionThreadIds)
    ? activity.toolExecutionThreadIds.length
    : 0;
  if (requestCount > 0 || toolCount > 0) {
    return {
      ok: false,
      reason: `background native Codex activity observed (${requestCount} request(s), ${toolCount} tool thread(s))`,
    };
  }
  return { ok: true, reason: "quiet" };
}

export function nativeExpectedRequestObserved(activity = {}) {
  const expectedThreadIds = uniqueStrings(activity.expectedThreadIds || []);
  if (expectedThreadIds.length !== 1) return false;
  const requestCounts = activity.requestCountsByThread && typeof activity.requestCountsByThread === "object"
    ? activity.requestCountsByThread
    : {};
  return Number(requestCounts[expectedThreadIds[0]] || 0) > 0;
}

export async function readNativeCodexActivityRows(options = {}) {
  const codexHome = resolve(String(options.codexHome || ""));
  const databasePath = resolve(options.databasePath || join(codexHome, "logs_2.sqlite"));
  if (!existsSync(databasePath)) return [];
  const afterId = Math.max(0, Number(options.afterId || 0));
  const limit = Math.max(1, Math.min(50_000, Number(options.limit || 10_000)));
  const { DatabaseSync } = await importNodeSqliteQuietly();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1500");
    return database.prepare(`
      SELECT id, ts, target, feedback_log_body AS body, thread_id AS threadId
      FROM logs
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(afterId, limit).map(normalizeRow);
  } finally {
    database.close();
  }
}

export async function latestNativeCodexActivityRowId(options = {}) {
  const codexHome = resolve(String(options.codexHome || ""));
  const databasePath = resolve(options.databasePath || join(codexHome, "logs_2.sqlite"));
  if (!existsSync(databasePath)) return 0;
  const { DatabaseSync } = await importNodeSqliteQuietly();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1500");
    return Number(database.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM logs").get()?.id || 0);
  } finally {
    database.close();
  }
}

export async function readNativeCodexRequestSnapshot(options = {}) {
  const codexHome = resolve(String(options.codexHome || ""));
  const databasePath = resolve(options.databasePath || join(codexHome, "logs_2.sqlite"));
  if (!existsSync(databasePath)) {
    return {
      databasePath,
      databasePresent: false,
      requestCount: 0,
      latestRequestRowId: 0,
      latestRowId: 0,
    };
  }
  const { DatabaseSync } = await importNodeSqliteQuietly();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1500");
    const requests = database.prepare(`
      SELECT COUNT(*) AS requestCount, COALESCE(MAX(id), 0) AS latestRequestRowId
      FROM logs
      WHERE instr(target, ?) AND COALESCE(thread_id, '') <> ''
    `).get("codex_http_client::custom_ca");
    const latest = database.prepare("SELECT COALESCE(MAX(id), 0) AS latestRowId FROM logs").get();
    return {
      databasePath,
      databasePresent: true,
      requestCount: Number(requests?.requestCount || 0),
      latestRequestRowId: Number(requests?.latestRequestRowId || 0),
      latestRowId: Number(latest?.latestRowId || 0),
    };
  } finally {
    database.close();
  }
}

export async function waitForNativeCodexRequestQuiet(options = {}) {
  const quietMs = Math.max(500, Number(options.quietMs || 8_000));
  const timeoutMs = Math.max(quietMs, Number(options.timeoutMs || 20_000));
  const pollMs = Math.max(100, Number(options.pollMs || 500));
  let cursor = options.afterId === undefined
    ? await latestNativeCodexActivityRowId(options)
    : Math.max(0, Number(options.afterId || 0));
  let quietStartedAt = Date.now();
  let observedRequestCount = 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const rows = await readNativeCodexActivityRows({ ...options, afterId: cursor });
    if (rows.length > 0) cursor = Math.max(cursor, ...rows.map((row) => Number(row.id || 0)));
    const activity = analyzeNativeCodexActivityRows(rows);
    if (activity.requestCount > 0 || activity.toolExecutionThreadIds.length > 0) {
      observedRequestCount += activity.requestCount;
      quietStartedAt = Date.now();
    }
    if (Date.now() - quietStartedAt >= quietMs) {
      return {
        ok: true,
        reason: "quiet",
        baselineId: cursor,
        quietMs: Date.now() - quietStartedAt,
        observedRequestCount,
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
  }

  return {
    ok: false,
    reason: "background native Codex requests did not stay quiet before submit",
    baselineId: cursor,
    quietMs: Date.now() - quietStartedAt,
    observedRequestCount,
  };
}

function normalizeRow(row = {}) {
  return {
    id: Number(row.id || 0),
    ts: Number(row.ts || 0),
    target: String(row.target || ""),
    threadId: String(row.threadId ?? row.thread_id ?? "").trim(),
    body: String(row.body ?? row.feedback_log_body ?? ""),
  };
}

function isNativeModelRequest(row) {
  return row.threadId !== "" && row.target.includes("codex_http_client::custom_ca");
}

function isNativeTitlePrompt(row) {
  return row.threadId !== ""
    && row.target.includes("codex_core::session::handlers")
    && row.body.includes(NATIVE_TITLE_PROMPT_PREFIX);
}

function isNativeTaskSuggestionsPrompt(row) {
  return row.threadId !== ""
    && row.target.includes("codex_core::session::handlers")
    && row.body.includes(NATIVE_TASK_SUGGESTIONS_PROMPT_PHRASE)
    && row.body.includes("Return 0 to 3 fresh suggestions.");
}

function isCompletedToolCall(row) {
  return row.threadId !== ""
    && row.target.includes("codex_core::tools")
    && /tool call completed|event\.name=codex\.tool_call/i.test(row.body);
}

function uniqueStrings(values) {
  return [...new Set([...values].map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

async function importNodeSqliteQuietly() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function filteredWarning(warning, ...args) {
    const text = String(warning?.message || warning || "");
    if (/SQLite is an experimental feature/i.test(text)) return;
    return emitWarning.call(process, warning, ...args);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}
