import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeNativeCodexActivityRows,
  nativeExpectedRequestObserved,
  nativePreflightCanSubmit,
} from "../../scripts/lib/anticodex-native-request-activity.mjs";

test("native activity separates the expected task, text-only title work and hidden execution", () => {
  const titlePrompt = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.";
  const activity = analyzeNativeCodexActivityRows([
    row(1, "codex_core::session::handlers", "title", `session event UserInput: ${titlePrompt}\nUser prompt: MARKER`),
    row(2, "codex_http_client::custom_ca", "title", "MARKER model=gemini-low"),
    row(3, "codex_http_client::custom_ca", "expected", "MARKER model=claude"),
    row(4, "codex_core::tools::parallel", "expected", "tool call completed event.name=codex.tool_call"),
    row(5, "codex_http_client::custom_ca", "hidden", "model=gemini-low"),
    row(6, "codex_core::tools::parallel", "hidden", "tool call completed event.name=codex.tool_call"),
  ], {
    marker: "MARKER",
    expectedThreadIds: ["expected"],
  });

  assert.equal(activity.requestCount, 3);
  assert.deepEqual(activity.titleThreadIds, ["title"]);
  assert.deepEqual(activity.expectedThreadIds, ["expected"]);
  assert.deepEqual(activity.unexpectedExecutionThreadIds, ["hidden"]);
  assert.equal(activity.titleThreadsUsedTools, false);
});

test("wrapped native title activity flags repeated requests and tool execution", () => {
  const titlePrompt = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.";
  const activity = analyzeNativeCodexActivityRows([
    row(20, "codex_core::session::handlers", "title", `session event UserInput: ${titlePrompt}\nUser prompt: MARKER`),
    row(21, "codex_http_client::custom_ca", "title", "MARKER model=gemini-low"),
    row(22, "codex_http_client::custom_ca", "title", "MARKER model=gemini-low"),
    row(23, "codex_core::tools::parallel", "title", "tool call completed event.name=codex.tool_call"),
  ]);

  assert.deepEqual(activity.titleThreadIds, ["title"]);
  assert.deepEqual(activity.titleThreadsRepeated, ["title"]);
  assert.equal(activity.titleThreadsUsedTools, true);
  assert.deepEqual(activity.unexpectedExecutionThreadIds, ["title"]);
  assert.deepEqual(activity.unexpectedRequestThreadIds, []);
});

test("native task suggestions allow one text-only request and are not generic hidden work", () => {
  const suggestionPrompt = String.raw`Submission UserInput Text { text: "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: C:\\fixture\n\nReturn 0 to 3 fresh suggestions." }`;
  const activity = analyzeNativeCodexActivityRows([
    row(24, "codex_core::session::handlers", "suggestions", `session event UserInput: ${suggestionPrompt}`),
    row(25, "codex_http_client::custom_ca", "suggestions", "model=gemini"),
  ]);

  assert.deepEqual(activity.taskSuggestionThreadIds, ["suggestions"]);
  assert.deepEqual(activity.taskSuggestionThreadsRepeated, []);
  assert.equal(activity.taskSuggestionThreadsUsedTools, false);
  assert.deepEqual(activity.unexpectedRequestThreadIds, []);
  assert.deepEqual(activity.unexpectedExecutionThreadIds, []);
});

test("native task suggestions fail closed when they repeat or execute tools", () => {
  const suggestionPrompt = String.raw`Submission UserInput Text { text: "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: C:\\fixture\n\nReturn 0 to 3 fresh suggestions." }`;
  const activity = analyzeNativeCodexActivityRows([
    row(26, "codex_core::session::handlers", "suggestions", `session event UserInput: ${suggestionPrompt}`),
    row(27, "codex_http_client::custom_ca", "suggestions", "model=gemini"),
    row(28, "codex_http_client::custom_ca", "suggestions", "model=gemini"),
    row(29, "codex_core::tools::parallel", "suggestions", "tool call completed event.name=codex.tool_call"),
  ]);

  assert.deepEqual(activity.taskSuggestionThreadIds, ["suggestions"]);
  assert.deepEqual(activity.taskSuggestionThreadsRepeated, ["suggestions"]);
  assert.equal(activity.taskSuggestionThreadsUsedTools, true);
  assert.deepEqual(activity.unexpectedRequestThreadIds, []);
  assert.deepEqual(activity.unexpectedExecutionThreadIds, ["suggestions"]);
});

test("pre-submit native activity fails closed when another Codex task is requesting or executing", () => {
  const idle = analyzeNativeCodexActivityRows([]);
  assert.deepEqual(nativePreflightCanSubmit(idle), { ok: true, reason: "quiet" });

  const busy = analyzeNativeCodexActivityRows([
    row(10, "codex_http_client::custom_ca", "background", "model=gemini-low"),
  ]);
  assert.equal(nativePreflightCanSubmit(busy).ok, false);
  assert.match(nativePreflightCanSubmit(busy).reason, /background/);
});

test("marker-scoped native evidence requires exactly one expected requesting thread", () => {
  const observed = analyzeNativeCodexActivityRows([
    row(30, "codex_http_client::custom_ca", "expected", "MARKER model=gemini"),
    row(31, "codex_http_client::custom_ca", "title", "MARKER model=gemini"),
  ], { expectedThreadIds: ["expected"] });
  assert.equal(nativeExpectedRequestObserved(observed), true);

  assert.equal(nativeExpectedRequestObserved({
    ...observed,
    expectedThreadIds: ["expected", "other"],
  }), false);
  assert.equal(nativeExpectedRequestObserved({
    ...observed,
    requestCountsByThread: { expected: 0, title: 1 },
  }), false);
});

test("readNativeCodexRequestSnapshot reads request-only totals from a real logs_2.sqlite", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readNativeCodexRequestSnapshot } = await import(
    "../../scripts/lib/anticodex-native-request-activity.mjs"
  );

  const tmpDir = await mkdtemp(join(tmpdir(), "anticodex-snapshot-test-"));
  const databasePath = join(tmpDir, "logs_2.sqlite");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        target TEXT NOT NULL,
        feedback_log_body TEXT,
        thread_id TEXT
      )
    `);

    // Request rows contain codex_http_client::custom_ca.
    db.prepare(
      "INSERT INTO logs (id, ts, target, feedback_log_body, thread_id) VALUES (?, ?, ?, ?, ?)"
    ).run(1, 1000, "codex_http_client::custom_ca", "req-body-1", "t1");
    db.prepare(
      "INSERT INTO logs (id, ts, target, feedback_log_body, thread_id) VALUES (?, ?, ?, ?, ?)"
    ).run(3, 1002, "codex_http_client::custom_ca", "req-body-2", "t2");
    db.prepare(
      "INSERT INTO logs (id, ts, target, feedback_log_body, thread_id) VALUES (?, ?, ?, ?, ?)"
    ).run(5, 1004, "codex_http_client::custom_ca", "req-body-3", "t3");

    // Non-request rows do not contain codex_http_client::custom_ca.
    db.prepare(
      "INSERT INTO logs (id, ts, target, feedback_log_body, thread_id) VALUES (?, ?, ?, ?, ?)"
    ).run(2, 1001, "codex_core::session::handlers", "session-body", "t1");
    db.prepare(
      "INSERT INTO logs (id, ts, target, feedback_log_body, thread_id) VALUES (?, ?, ?, ?, ?)"
    ).run(4, 1003, "codex_core::tools::parallel", "tool-body", "t2");
    db.prepare(
      "INSERT INTO logs (id, ts, target, feedback_log_body, thread_id) VALUES (?, ?, ?, ?, ?)"
    ).run(6, 1005, "codex_http_client::custom_ca", "plugin-list-without-task-thread", null);

    db.close();

    const snapshot = await readNativeCodexRequestSnapshot({ databasePath });

    assert.equal(snapshot.requestCount, 3, "should count only rows with target containing codex_http_client::custom_ca");
    assert.equal(snapshot.latestRequestRowId, 5, "latestRequestRowId should be the max id among request rows");
    assert.equal(snapshot.latestRowId, 6, "latestRowId should include non-task log rows");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("idle stability fails closed on native request-count drift", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dirname, "..", "..");
  const source = await readFile(resolve(root, "scripts", "test-anticodex-ui-idle-stability.ps1"), "utf8");

  assert.match(source, /read-anticodex-native-request-snapshot\.mjs/);
  assert.match(source, /nativeRequestDelta/);
  assert.match(source, /native request count changed during idle/i);
});

function row(id, target, threadId, body) {
  return { id, ts: 1_700_000_000 + id, target, threadId, body };
}
