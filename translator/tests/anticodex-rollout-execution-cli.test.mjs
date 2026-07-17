import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve("scripts/audit-anticodex-rollout-execution.mjs");

function writeRollout(file, { explained = true } = {}) {
  const rows = [
    { type: "session_meta", payload: { id: "thread-cli", cwd: "C:\\work" } },
    { type: "turn_context", payload: { turn_id: "turn-1", model: "gemini-3-flash-agent" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "运行测试" }] } },
    ...(explained ? [{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "现在运行测试并检查结果。" }] } }] : []),
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: JSON.stringify({ cmd: "npm test" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "pass" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ];
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

test("rollout execution CLI audits files and writes the same JSON report", () => {
  const root = mkdtempSync(join(os.tmpdir(), "anticodex-rollout-cli-"));
  const rollout = join(root, "rollout-clean.jsonl");
  const output = join(root, "report.json");
  writeRollout(rollout);
  try {
    const child = spawnSync(process.execPath, [scriptPath, "--output", output, rollout], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const stdout = JSON.parse(child.stdout);
    const saved = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(saved, stdout);
    assert.equal(stdout.ok, true);
    assert.equal(stdout.taskCount, 1);
    assert.equal(stdout.tasks[0].threadId, "thread-cli");
    assert.equal(stdout.tasks[0].turnCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollout execution CLI exits nonzero for a silent command turn", () => {
  const root = mkdtempSync(join(os.tmpdir(), "anticodex-rollout-cli-red-"));
  const rollout = join(root, "rollout-bad.jsonl");
  writeRollout(rollout, { explained: false });
  try {
    const child = spawnSync(process.execPath, [scriptPath, rollout], { encoding: "utf8" });
    assert.equal(child.status, 1);
    const report = JSON.parse(child.stdout);
    assert.equal(report.ok, false);
    assert.match(report.failures.join("\n"), /Chinese pre-command explanation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
