import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const plan = readFileSync(resolve(root, "task_plan.md"), "utf8");

test("current revision truth cannot coexist with superseded unchecked activation instructions", () => {
  assert.match(plan, /\[x\].*revision 7 is the current installed shell/i);

  const unchecked = plan.split(/\r?\n/).filter((line) => /^\s*- \[ \]/.test(line));
  const supersededActivationPatterns = [
    /wait for the current Anti-Codex to exit naturally, then build and activate/i,
    /at the first all-zero Anti-Codex process window, build and activate exactly one fresh current candidate/i,
    /same 15-process owned product tree[\s\S]*run the source runtime sync once/i,
    /commit the current source[\s\S]*activate revision 6/i,
    /commit and activate the narrow trusted-root verifier correction/i,
  ];
  const conflicts = unchecked.filter((line) => supersededActivationPatterns.some((pattern) => pattern.test(line)));

  assert.deepEqual(conflicts, [], `superseded activation instructions remain unchecked:\n${conflicts.join("\n")}`);
});
