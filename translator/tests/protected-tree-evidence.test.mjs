import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  diffProtectedTreeSnapshots,
  snapshotProtectedTree,
} from "../../scripts/lib/protected-tree-evidence.mjs";

test("protected tree snapshot ignores the one allowed output", () => {
  const root = mkdtempSync(join(os.tmpdir(), "anticodex-protected-tree-"));
  const allowed = join(root, "MODEL_FINAL_AUDIT.md");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "export const ok = true;\n", "utf8");
  writeFileSync(allowed, "old\n", "utf8");
  try {
    const before = snapshotProtectedTree(root, { ignoredPaths: [allowed] });
    writeFileSync(allowed, "new\n", "utf8");
    const after = snapshotProtectedTree(root, { ignoredPaths: [allowed] });
    const diff = diffProtectedTreeSnapshots(before, after);

    assert.equal(diff.ok, true);
    assert.deepEqual(before.entries.map((entry) => entry.path), ["src", "src/app.js"]);
    assert.equal(before.fingerprint, after.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected tree diff reports added, removed, and changed paths", () => {
  const root = mkdtempSync(join(os.tmpdir(), "anticodex-protected-tree-red-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "keep.txt"), "before\n", "utf8");
  writeFileSync(join(root, "remove.txt"), "remove\n", "utf8");
  try {
    const before = snapshotProtectedTree(root);
    writeFileSync(join(root, "keep.txt"), "after\n", "utf8");
    unlinkSync(join(root, "remove.txt"));
    writeFileSync(join(root, "src", "new.txt"), "new\n", "utf8");
    const after = snapshotProtectedTree(root);
    const diff = diffProtectedTreeSnapshots(before, after);

    assert.equal(diff.ok, false);
    assert.deepEqual(diff.added, ["src/new.txt"]);
    assert.deepEqual(diff.removed, ["remove.txt"]);
    assert.deepEqual(diff.changed, ["keep.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real UI smoke can protect a project tree while allowing only the required file", () => {
  const source = readFileSync(new URL("../../scripts/test-anticodex-ui-chat-smoke.mjs", import.meta.url), "utf8");

  assert.match(source, /--protect-root <path>/);
  assert.match(source, /snapshotProtectedTree\(protectedRoot/);
  assert.match(source, /ignoredPaths: requiredFile \? \[requiredFile\] : \[\]/);
  assert.match(source, /diffProtectedTreeSnapshots\(protectedRootBefore, after\)/);
  assert.match(source, /protectedRootEvidence\.ok !== true/);
  assert.match(source, /protected root changed outside the required file/);
});
