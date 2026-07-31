import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCHEMA = "anticodex-prompt-policy-v1";
const MAX_CONTENT_LENGTH = 100_000;
const EDITABLE_LAYERS = Object.freeze({
  "Codex system instructions": "codexSystem",
  "Codex developer instructions": "codexDeveloper",
});

export function defaultPromptPolicy() {
  return {
    schema: SCHEMA,
    codexSystem: { enabled: true, content: null },
    codexDeveloper: { enabled: true, content: null },
    user: { enabled: false, content: "" },
  };
}

export function readPromptPolicy(stateRoot) {
  const defaults = defaultPromptPolicy();
  try {
    const value = JSON.parse(readFileSync(policyPath(stateRoot), "utf8"));
    return normalizePromptPolicy(value, defaults);
  } catch {
    return defaults;
  }
}

export function savePromptPolicy(stateRoot, value) {
  const policy = normalizePromptPolicy(value, defaultPromptPolicy(), { strict: true });
  const target = policyPath(stateRoot);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(resolve(stateRoot), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return policy;
}

export function applyPromptPolicy(sections, stateRoot) {
  const policy = readPromptPolicy(stateRoot);
  const effective = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    const key = EDITABLE_LAYERS[String(section?.title || "")];
    if (!key) {
      effective.push(section);
      continue;
    }
    const layer = policy[key];
    if (!layer.enabled) continue;
    effective.push(layer.content === null ? section : { ...section, content: layer.content });
  }
  if (policy.user.enabled && policy.user.content) {
    effective.push({
      title: "Anti-Codex user instructions",
      content: policy.user.content,
      metadata: { isInternal: true, userConfigured: true },
    });
  }
  return effective;
}

export function recordPromptSnapshot(stateRoot, originalSections, effectiveSections) {
  const target = snapshotPath(stateRoot);
  const layers = snapshotLayers(originalSections, effectiveSections);
  const value = {
    schema: "anticodex-prompt-snapshot-v1",
    updatedAt: new Date().toISOString(),
    layers,
  };
  const comparable = JSON.stringify(layers);
  try {
    if (existsSync(target)) {
      const current = JSON.parse(readFileSync(target, "utf8"));
      if (JSON.stringify(current?.layers || []) === comparable) return current;
    }
  } catch {}
  mkdirSync(resolve(stateRoot), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return value;
}

export function promptPolicyPayload(stateRoot) {
  let snapshot = null;
  try { snapshot = JSON.parse(readFileSync(snapshotPath(stateRoot), "utf8")); } catch {}
  return {
    ok: true,
    schema: SCHEMA,
    policy: readPromptPolicy(stateRoot),
    defaults: defaultPromptPolicy(),
    snapshot,
    providerBase: {
      id: "antigravityProviderBase",
      source: "Antigravity",
      editable: false,
      exposed: false,
      message: "Antigravity 自带基础提示词未通过本地接口暴露；Anti-Codex 当前不会替换或删除它。",
    },
  };
}

function normalizePromptPolicy(value, defaults, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (options.strict) throw new Error("提示词配置格式无效。");
    return defaults;
  }
  return {
    schema: SCHEMA,
    codexSystem: normalizeLayer(value.codexSystem, defaults.codexSystem, true),
    codexDeveloper: normalizeLayer(value.codexDeveloper, defaults.codexDeveloper, true),
    user: normalizeLayer(value.user, defaults.user, false),
  };
}

function normalizeLayer(value, fallback, nullable) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const raw = Object.hasOwn(value, "content") ? value.content : fallback.content;
  if (raw !== null && typeof raw !== "string") throw new Error("提示词内容必须是文本。");
  if (!nullable && raw === null) throw new Error("用户提示词内容必须是文本。");
  if (typeof raw === "string" && raw.length > MAX_CONTENT_LENGTH) throw new Error("单层提示词不能超过 100000 个字符。");
  return { enabled: value.enabled !== false, content: raw };
}

function snapshotLayers(originalSections, effectiveSections) {
  const originals = new Map((originalSections || []).map((section) => [String(section?.title || ""), section]));
  return (effectiveSections || []).map((section) => {
    const title = String(section?.title || "");
    const content = String(section?.content || "");
    const original = originals.get(title);
    const originalContent = original ? String(original.content || "") : null;
    return {
      id: EDITABLE_LAYERS[title] || (title === "Anti-Codex user instructions" ? "user" : title),
      title,
      source: title.startsWith("Codex ") ? "Codex" : "Anti-Codex",
      editable: Boolean(EDITABLE_LAYERS[title] || title === "Anti-Codex user instructions"),
      required: title.includes("tool compatibility") || title.includes("text-only compatibility"),
      defaultContent: originalContent,
      effectiveContent: content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    };
  });
}

function policyPath(stateRoot) { return join(resolve(stateRoot), "prompt-policy.json"); }
function snapshotPath(stateRoot) { return join(resolve(stateRoot), "prompt-snapshot.json"); }
