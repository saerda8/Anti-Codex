import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyPromptPolicy,
  promptPolicyPayload,
  readNativeCustomInstructions,
  recordPromptSnapshot,
  saveNativeCustomInstructions,
  savePromptPolicy,
} from "../provider/anticodex-prompt-policy.mjs";

test("native custom instructions use only the isolated AGENTS file and empty content restores the default", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-native-custom-instructions-"));
  const codexHome = join(root, "codex-home");
  const agentsPath = join(codexHome, "AGENTS.md");
  try {
    assert.equal(readNativeCustomInstructions(codexHome), "");
    saveNativeCustomInstructions(codexHome, "local user preference");
    assert.equal(readNativeCustomInstructions(codexHome), "local user preference");
    assert.deepEqual(promptPolicyPayload(root, codexHome).nativeCustomInstructions, {
      source: "AGENTS.md",
      enabled: true,
      content: "local user preference",
      defaultContent: "",
    });

    saveNativeCustomInstructions(codexHome, "");
    assert.equal(existsSync(agentsPath), false);
    assert.equal(promptPolicyPayload(root, codexHome).nativeCustomInstructions.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(payload.capabilities.nativeCustomInstructions.routes, ["antigravity", "third-party"]);
    assert.deepEqual(payload.capabilities.mergedPromptPolicy.routes, ["antigravity"]);
    assert.equal(payload.capabilities.mergedPromptPolicy.independentDeveloper, false);
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
    assert.throws(() => saveNativeCustomInstructions(join(root, "codex-home"), 42), /must be text|必须是文本/);
    assert.throws(() => saveNativeCustomInstructions(join(root, "codex-home"), "x".repeat(100_001)), /100000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
