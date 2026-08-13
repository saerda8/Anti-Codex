import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCHEMA = "anticodex-prompt-policy-v1";
const MAX_CONTENT_LENGTH = 100_000;
const NATIVE_SNAPSHOT_SCHEMA = "anticodex-native-prompt-snapshot-v1";
const MAX_SNAPSHOT_CONTENT_LENGTH = 1_000_000;
const EDITABLE_LAYERS = Object.freeze({
  "Codex system instructions": "codexSystem",
  "Codex developer instructions": "codexDeveloper",
});
const REQUIRED_SNAPSHOT_LAYERS = new Set([
  "Anti-Codex Antigravity tool compatibility",
  "Anti-Codex Antigravity text-only compatibility",
]);
const REQUIRED_LOCAL_PROMPT_LAYERS = Object.freeze([Object.freeze({
  id: "codexPlusPlusPatchToolCompatibility",
  title: "CodexPlusPlus apply_patch compatibility",
  source: "Anti-Codex",
  editable: false,
  required: true,
  routes: Object.freeze(["antigravity", "third-party"]),
  activeWhen: "Chat Completions conversion includes an apply_patch tool",
  content: "When editing files, call the provided apply_patch structured function tool directly. Do not invoke apply_patch through exec_command, shell_command, PowerShell, cmd.exe, Bash, or another command wrapper. Use command tools only for inspection, builds, tests, and commands that are not file edits. Windows destructive filesystem safety: never translate or retry a blocked recursive delete or move through another shell. Keep the operation in one shell end-to-end and first verify that every resolved absolute target remains inside the intended workspace or an explicitly named target directory. In PowerShell, use Remove-Item with -LiteralPath; never fall back to cmd.exe /c, rmdir, or rd after a policy rejection. Do not change global toolchain defaults, user environment, PATH, registry state, or installed software unless the user explicitly requested that exact change. Query only specifically named non-secret environment variables; never enumerate all environment variables.",
})]);
const AUDITABLE_SNAPSHOT_LAYERS = new Set([
  ...Object.keys(EDITABLE_LAYERS),
  "Anti-Codex user instructions",
  ...REQUIRED_SNAPSHOT_LAYERS,
]);

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

export function readNativeCustomInstructions(codexHome) {
  const target = nativeCustomInstructionsPath(codexHome);
  try {
    if (!lstatSync(target).isFile()) throw new Error("隔离 AGENTS.md 必须是普通文件。");
    return readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function saveNativeCustomInstructions(codexHome, value) {
  if (typeof value !== "string") throw new Error("原生自定义指令必须是文本。");
  if (value.length > MAX_CONTENT_LENGTH) throw new Error("原生自定义指令不能超过 100000 个字符。");
  const target = nativeCustomInstructionsPath(codexHome);
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error("隔离 AGENTS.md 必须是普通文件。");
  if (!value) {
    rmSync(target, { force: true });
    return "";
  }
  mkdirSync(resolve(codexHome), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, value, "utf8");
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return value;
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

export function promptPolicyPayload(stateRoot, codexHome = join(resolve(stateRoot), "codex-home-deepseek-app")) {
  const snapshot = readPromptSnapshot(stateRoot);
  const nativePromptSnapshot = readNativePromptSnapshot(stateRoot);
  const nativeContent = readNativeCustomInstructions(codexHome);
  return {
    ok: true,
    schema: SCHEMA,
    policy: readPromptPolicy(stateRoot),
    defaults: defaultPromptPolicy(),
    snapshot,
    nativePromptSnapshot,
    requiredLocalLayers: REQUIRED_LOCAL_PROMPT_LAYERS.map((layer) => ({
      ...layer,
      routes: [...layer.routes],
    })),
    nativeCustomInstructions: {
      source: "AGENTS.md",
      enabled: Boolean(nativeContent.trim()),
      content: nativeContent,
      defaultContent: "",
    },
    capabilities: {
      nativeCustomInstructions: {
        routes: ["antigravity", "third-party"],
        effectiveFrom: "next_native_request",
      },
      mergedPromptPolicy: {
        routes: ["antigravity", "third-party"],
        independentDeveloper: false,
        effectiveFrom: "next_native_request",
      },
    },
    providerBase: {
      id: "providerHiddenPrompts",
      source: "Model providers",
      editable: false,
      exposed: false,
      message: "Antigravity 或第三方提供方可能在服务端附加未暴露提示词；本地无法读取、替换或删除这些提供方隐藏内容。",
    },
  };
}

function readNativePromptSnapshot(stateRoot) {
  try {
    const value = JSON.parse(readFileSync(nativeSnapshotPath(stateRoot), "utf8"));
    if (value?.schema !== NATIVE_SNAPSHOT_SCHEMA) return null;
    if (!["anticodex-antigravity", "anticodex-third-party"].includes(value.relayId)) return null;
    if (!["responses", "chatCompletions", "chat_completions"].includes(value.protocol)) return null;
    for (const key of ["defaultContent", "effectiveContent"]) {
      if (typeof value[key] !== "string" || value[key].length > MAX_SNAPSHOT_CONTENT_LENGTH) return null;
    }
    for (const key of ["defaultSha256", "effectiveSha256"]) {
      if (!/^[a-f0-9]{64}$/i.test(String(value[key] || ""))) return null;
    }
    if (typeof value.updatedAt !== "number" && typeof value.updatedAt !== "string") return null;
    return value;
  } catch {
    return null;
  }
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
  return (effectiveSections || []).filter((section) => AUDITABLE_SNAPSHOT_LAYERS.has(String(section?.title || ""))).map((section) => {
    const title = String(section?.title || "");
    const content = String(section?.content || "");
    const original = originals.get(title);
    const originalContent = original ? String(original.content || "") : null;
    return {
      id: EDITABLE_LAYERS[title] || (title === "Anti-Codex user instructions" ? "user" : title),
      title,
      source: title.startsWith("Codex ") ? "Codex" : "Anti-Codex",
      editable: Boolean(EDITABLE_LAYERS[title] || title === "Anti-Codex user instructions"),
      required: REQUIRED_SNAPSHOT_LAYERS.has(title),
      defaultContent: originalContent,
      effectiveContent: content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    };
  });
}

function readPromptSnapshot(stateRoot) {
  const target = snapshotPath(stateRoot);
  let value;
  try {
    value = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return null;
  }
  if (value?.schema !== "anticodex-prompt-snapshot-v1" || !Array.isArray(value.layers)) return null;
  const layers = value.layers.filter((layer) => AUDITABLE_SNAPSHOT_LAYERS.has(String(layer?.title || "")));
  if (layers.length !== value.layers.length) {
    value = { ...value, layers };
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return value;
}

function policyPath(stateRoot) { return join(resolve(stateRoot), "prompt-policy.json"); }
function snapshotPath(stateRoot) { return join(resolve(stateRoot), "prompt-snapshot.json"); }
function nativeSnapshotPath(stateRoot) { return join(resolve(stateRoot), "native-prompt-snapshot.json"); }
function nativeCustomInstructionsPath(codexHome) { return join(resolve(codexHome), "AGENTS.md"); }
