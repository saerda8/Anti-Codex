import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyPromptPolicy,
  promptPolicyPayload,
  recordPromptSnapshot,
  savePromptPolicy,
} from "../provider/anticodex-prompt-policy.mjs";

test("prompt policy preserves defaults, applies explicit edits, and restores from one isolated file", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-prompt-policy-"));
  try {
    const original = [
      { title: "Codex system instructions", content: "system default" },
      { title: "Codex developer instructions", content: "developer default" },
      { title: "Prior messages", content: "history" },
    ];
    assert.deepEqual(applyPromptPolicy(original, root), original);

    savePromptPolicy(root, {
      codexSystem: { enabled: false, content: null },
      codexDeveloper: { enabled: true, content: "developer override" },
      user: { enabled: true, content: "user layer" },
    });
    const effective = applyPromptPolicy(original, root);
    assert.deepEqual(effective.map(({ title, content }) => ({ title, content })), [
      { title: "Codex developer instructions", content: "developer override" },
      { title: "Prior messages", content: "history" },
      { title: "Anti-Codex user instructions", content: "user layer" },
    ]);

    recordPromptSnapshot(root, original, [...effective, {
      title: "Anti-Codex Antigravity tool compatibility",
      content: "required",
    }]);
    const payload = promptPolicyPayload(root);
    assert.equal(payload.providerBase.exposed, false);
    assert.equal(payload.snapshot.layers.at(-1).required, true);
    assert.equal(payload.snapshot.layers[0].defaultContent, "developer default");
    assert.equal(JSON.parse(readFileSync(join(root, "prompt-policy.json"), "utf8")).schema, "anticodex-prompt-policy-v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt policy rejects non-text and oversized edits", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-prompt-policy-invalid-"));
  try {
    assert.throws(() => savePromptPolicy(root, {
      codexSystem: { enabled: true, content: 42 },
      codexDeveloper: { enabled: true, content: null },
      user: { enabled: false, content: "" },
    }), /must be text|必须是文本/);
    assert.throws(() => savePromptPolicy(root, {
      codexSystem: { enabled: true, content: null },
      codexDeveloper: { enabled: true, content: null },
      user: { enabled: true, content: "x".repeat(100_001) },
    }), /100000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
