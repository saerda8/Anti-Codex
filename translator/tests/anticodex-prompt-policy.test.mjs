import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultPromptPolicy,
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

test("prompt policy preserves defaults, saves explicit edits, and restores from one isolated file", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-prompt-policy-"));
  try {
    const original = [
      { title: "Codex system instructions", content: "system default" },
      { title: "Codex developer instructions", content: "developer default" },
      { title: "Prior Chat Completions messages", content: "private-history-sentinel" },
      { title: "Chat Completions structured output contract", content: "private-schema-sentinel" },
      { title: "Codex native custom instructions (AGENTS.md)", content: "private-agents-sentinel" },
    ];
    assert.deepEqual(promptPolicyPayload(root).policy, defaultPromptPolicy());

    savePromptPolicy(root, {
      codexSystem: { enabled: false, content: null },
      codexDeveloper: { enabled: true, content: "developer override" },
      user: { enabled: true, content: "user layer" },
    });
    const saved = promptPolicyPayload(root).policy;
    assert.equal(saved.codexSystem.enabled, false);
    assert.equal(saved.codexDeveloper.content, "developer override");
    assert.equal(saved.user.content, "user layer");

    recordPromptSnapshot(root, original, [...original, {
      title: "Anti-Codex Antigravity tool compatibility",
      content: "required",
    }]);
    const payload = promptPolicyPayload(root);
    assert.equal(payload.providerBase.exposed, false);
    assert.deepEqual(payload.capabilities.nativeCustomInstructions.routes, ["antigravity", "third-party"]);
    assert.deepEqual(payload.capabilities.mergedPromptPolicy.routes, ["antigravity", "third-party"]);
    assert.equal(payload.capabilities.mergedPromptPolicy.independentDeveloper, false);
    assert.equal(payload.snapshot.layers.at(-1).required, true);
    assert.equal(payload.snapshot.layers[0].defaultContent, "system default");
    assert.deepEqual(payload.snapshot.layers.map((layer) => layer.title), [
      "Codex system instructions",
      "Codex developer instructions",
      "Anti-Codex Antigravity tool compatibility",
    ]);
    assert.doesNotMatch(readFileSync(join(root, "prompt-snapshot.json"), "utf8"), /private-(?:history|schema|agents)-sentinel/);
    assert.equal(JSON.parse(readFileSync(join(root, "prompt-policy.json"), "utf8")).schema, "anticodex-prompt-policy-v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt payload migrates legacy snapshots without retaining transcript or request-only layers", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-prompt-snapshot-migration-"));
  const snapshotPath = join(root, "prompt-snapshot.json");
  try {
    writeFileSync(snapshotPath, JSON.stringify({
      schema: "anticodex-prompt-snapshot-v1",
      updatedAt: "2026-08-04T00:00:00.000Z",
      layers: [
        { id: "codexSystem", title: "Codex system instructions", defaultContent: "system", effectiveContent: "system" },
        { id: "history", title: "Prior Chat Completions messages", defaultContent: "legacy-private-history", effectiveContent: "legacy-private-history" },
        { id: "schema", title: "Chat Completions structured output contract", defaultContent: "legacy-private-schema", effectiveContent: "legacy-private-schema" },
        { id: "agents", title: "Codex native custom instructions (AGENTS.md)", defaultContent: "legacy-private-agents", effectiveContent: "legacy-private-agents" },
        { id: "compat", title: "Anti-Codex Antigravity text-only compatibility", defaultContent: null, effectiveContent: "required" },
      ],
    }), "utf8");

    const payload = promptPolicyPayload(root);
    assert.deepEqual(payload.snapshot.layers.map((layer) => layer.title), [
      "Codex system instructions",
      "Anti-Codex Antigravity text-only compatibility",
    ]);
    const migrated = readFileSync(snapshotPath, "utf8");
    assert.doesNotMatch(migrated, /legacy-private-(?:history|schema|agents)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt payload exposes the pre-policy native snapshot and the adapter does not apply policy twice", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-native-prompt-snapshot-"));
  const nativeSnapshot = {
    schema: "anticodex-native-prompt-snapshot-v1",
    updatedAt: 1_785_560_000_000,
    relayId: "anticodex-antigravity",
    protocol: "chatCompletions",
    defaultContent: "native default",
    defaultSha256: "a".repeat(64),
    effectiveContent: "native effective",
    effectiveSha256: "b".repeat(64),
    policyMode: "custom",
  };
  try {
    writeFileSync(join(root, "native-prompt-snapshot.json"), JSON.stringify(nativeSnapshot), "utf8");
    const payload = promptPolicyPayload(root);
    assert.deepEqual(payload.nativePromptSnapshot, nativeSnapshot);
    assert.deepEqual(payload.capabilities.mergedPromptPolicy.routes, ["antigravity", "third-party"]);
    assert.match(payload.providerBase.message, /provider|提供方/i);

    const cascadeSource = readFileSync(new URL("../provider/antigravity-cascade-client.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(cascadeSource, /applyPromptPolicy/);
    assert.match(cascadeSource, /withToolCompatibilitySection\(\s*originalPromptSections,/);
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
    writeFileSync(join(root, "native-prompt-snapshot.json"), JSON.stringify({
      schema: "anticodex-native-prompt-snapshot-v1",
      relayId: "ordinary-relay",
      protocol: "chatCompletions",
      defaultContent: "not trusted",
      effectiveContent: "not trusted",
      defaultSha256: "a".repeat(64),
      effectiveSha256: "b".repeat(64),
      updatedAt: Date.now(),
    }), "utf8");
    assert.equal(promptPolicyPayload(root).nativePromptSnapshot, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
