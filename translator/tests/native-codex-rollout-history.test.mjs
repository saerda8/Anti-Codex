import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  markerScopedHistoryEntries,
  summarizeNativeCodexRolloutExecution,
} from "../../scripts/lib/native-codex-rollout-history.mjs";

test("marker history falls back to native Codex rollout items", () => {
  const root = mkdtempSync(join(os.tmpdir(), "anticodex-rollout-history-"));
  const sessions = join(root, "sessions", "2026", "07", "15");
  const marker = "UI_NATIVE_HISTORY_123";
  mkdirSync(sessions, { recursive: true });
  const rows = [
    { type: "session_meta", payload: { id: "session-1" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "turn_context", payload: { turn_id: "turn-1", model: "gemini-3-flash-agent" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "我将只执行一次。" }] } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"Start-Process start.bat -Wait\"}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "launch-count=1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `完成\n${marker}` }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ];
  writeFileSync(join(sessions, "rollout-test.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

  try {
    const entries = markerScopedHistoryEntries(marker, {
      responseHistoryPath: join(root, "missing-response-history.json"),
      rolloutRoot: join(root, "sessions"),
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, "codex-rollout");
    assert.equal(entries[0].contextItems.some((item) => item.type === "function_call"), true);
    assert.equal(entries[0].contextItems.some((item) => item.type === "function_call_output"), true);
    assert.equal(entries[0].contextItems.some((item) => item.role === "assistant" && JSON.stringify(item).includes(marker)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarizes paired multi-turn command work with Chinese pre-command explanations", () => {
  const rows = [
    { type: "session_meta", payload: { id: "thread-clean", cwd: "C:\\work" } },
    { type: "turn_context", payload: { turn_id: "turn-1", model: "gemini-3-flash-agent" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "创建文件" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "我先检查当前目录，再创建并验证文件。" }] } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: JSON.stringify({ cmd: "Get-ChildItem", workdir: "C:\\work" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "empty" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "目录已确认，接下来写入目标文件。" }] } },
    { type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "call-2", arguments: "*** Begin Patch" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-2", output: "Done" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "turn_context", payload: { turn_id: "turn-2", model: "gemini-3-flash-agent" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续验证" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "现在运行测试并核对结果。" }] } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-3", arguments: JSON.stringify({ command: "npm test", workdir: "C:\\work" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-3", output: "pass 2" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } },
  ];

  const summary = summarizeNativeCodexRolloutExecution(rows, { requireCommandPerTurn: true });

  assert.equal(summary.ok, true);
  assert.equal(summary.threadId, "thread-clean");
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.toolCallCount, 3);
  assert.equal(summary.toolOutputCount, 3);
  assert.equal(summary.commandCount, 3);
  assert.equal(summary.failures.length, 0);
  assert.equal(summary.turns.every((turn) => turn.preCommandExplanationSeen), true);
  assert.equal(summary.turns.every((turn) => turn.toolPairsComplete), true);
});

test("rejects silent execution, adjacent command loops, launches, unpaired tools, and post-complete work", () => {
  const rows = [
    { type: "session_meta", payload: { id: "thread-bad", cwd: "C:\\work" } },
    { type: "turn_context", payload: { turn_id: "turn-1", model: "gemini-3-flash-agent" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "启动并检查" }] } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: JSON.stringify({ cmd: "Start-Process app.exe" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "started" } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-2", arguments: JSON.stringify({ cmd: "Start-Process   app.exe" }) } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-3", arguments: JSON.stringify({ cmd: "Get-Process" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "orphan-output", output: "late" } },
  ];

  const summary = summarizeNativeCodexRolloutExecution(rows, { requireCommandPerTurn: true });

  assert.equal(summary.ok, false);
  assert.equal(summary.turns[0].preCommandExplanationSeen, false);
  assert.equal(summary.turns[0].adjacentDuplicateCommandCount, 1);
  assert.equal(summary.turns[0].launchCommandCount, 2);
  assert.equal(summary.turns[0].postCompleteToolCallCount, 1);
  assert.deepEqual(summary.turns[0].unpairedToolCallIds.sort(), ["call-2", "call-3"]);
  assert.deepEqual(summary.turns[0].unpairedToolOutputIds, ["orphan-output"]);
  assert.match(summary.failures.join("\n"), /Chinese pre-command explanation/);
  assert.match(summary.failures.join("\n"), /adjacent duplicate command/);
  assert.match(summary.failures.join("\n"), /unexpected program launch/);
  assert.match(summary.failures.join("\n"), /unpaired tool/);
  assert.match(summary.failures.join("\n"), /after task_complete/);
});
