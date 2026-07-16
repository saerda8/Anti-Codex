import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { markerScopedHistoryEntries } from "../../scripts/lib/native-codex-rollout-history.mjs";

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
