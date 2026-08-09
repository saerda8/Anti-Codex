import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

function normalizedPromptSettingsState(value = {}) {
  const editor = (entry = {}) => ({
    enabled: entry.enabled === true,
    useDefault: entry.useDefault === true,
    content: String(entry.content ?? ""),
  });
  return {
    codexSystem: editor(value.codexSystem),
    codexDeveloper: editor(value.codexDeveloper),
    user: {
      enabled: value.user?.enabled === true,
      content: String(value.user?.content ?? ""),
    },
    nativeCustomInstructions: {
      content: String(value.nativeCustomInstructions?.content ?? ""),
      existed: value.nativeCustomInstructions?.existed === true,
    },
  };
}

export function promptSettingsStatesEqual(left, right) {
  return JSON.stringify(normalizedPromptSettingsState(left)) === JSON.stringify(normalizedPromptSettingsState(right));
}

export function promptSettingsStatesSemanticallyEqual(left, right) {
  const normalizedLeft = normalizedPromptSettingsState(left);
  const normalizedRight = normalizedPromptSettingsState(right);
  normalizedLeft.nativeCustomInstructions.existed = false;
  normalizedRight.nativeCustomInstructions.existed = false;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

export function captureExactFileSnapshot(filePath) {
  const target = resolve(String(filePath || ""));
  if (!existsSync(target)) return { target, existed: false, bytes: null };
  if (!lstatSync(target).isFile()) throw new Error(`Acceptance state path is not a regular file: ${target}`);
  return { target, existed: true, bytes: readFileSync(target) };
}

export function restoreExactFileSnapshot(snapshot) {
  const target = resolve(String(snapshot?.target || ""));
  if (!snapshot?.existed) {
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`Refusing to remove a non-file acceptance state path: ${target}`);
    rmSync(target, { force: true });
    return;
  }
  if (!Buffer.isBuffer(snapshot.bytes)) throw new Error(`Acceptance snapshot bytes are missing: ${target}`);
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`Refusing to replace a non-file acceptance state path: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.acceptance-restore.tmp`;
  try {
    writeFileSync(temporary, snapshot.bytes);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function exactFileSnapshotMatches(snapshot) {
  const target = resolve(String(snapshot?.target || ""));
  if (!snapshot?.existed) return !existsSync(target);
  if (!existsSync(target) || !lstatSync(target).isFile() || !Buffer.isBuffer(snapshot.bytes)) return false;
  return readFileSync(target).equals(snapshot.bytes);
}

export function resolveNativeSettingsAsarPath({ explicitPath = "", scriptDirectory = "" } = {}) {
  if (explicitPath) return resolve(String(explicitPath));
  const scripts = resolve(String(scriptDirectory || ""));
  const candidates = [
    join(scripts, "..", "codex-patched-app", "resources", "app.asar"),
    join(scripts, "..", "..", "codex-patched-app", "resources", "app.asar"),
  ].map((value) => resolve(value));
  const matches = [...new Set(candidates.filter((value) => existsSync(value)))];
  if (matches.length !== 1) throw new Error(`Expected one native Settings ASAR candidate, found ${matches.length}.`);
  return matches[0];
}

export function extractNativeSettingsRegistrationSlugs(source = "") {
  const candidates = [];
  for (const match of String(source).matchAll(/(?:^|[;,])(?:var |let |const )?[A-Za-z_$][\w$]*\s*=\s*\{([^{}]{1,1200})\}/g)) {
    const keys = [...match[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:\s*[A-Za-z_$][\w$]*/g)]
      .map((entry) => String(entry[1] || entry[2] || ""))
      .filter(Boolean);
    if (!keys.includes("agent") || !keys.some((key) => key === "personalization" || key.endsWith("-settings"))) continue;
    if (new Set(keys).size !== keys.length) continue;
    candidates.push(keys);
  }
  const unique = [...new Map(candidates.map((keys) => [JSON.stringify(keys), keys])).values()];
  if (unique.length > 1) throw new Error("Ambiguous native Settings registration contract.");
  return unique[0] || [];
}

export function compareNativeSettingsSlugSets(expectedSlugs = [], visibleSlugs = []) {
  const expected = [...new Set(expectedSlugs.map(String))].sort();
  const visible = visibleSlugs.map(String);
  const counts = new Map();
  for (const slug of visible) counts.set(slug, (counts.get(slug) || 0) + 1);
  const visibleSet = new Set(visible);
  const expectedSet = new Set(expected);
  const gated = expected.filter((slug) => !visibleSet.has(slug));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([slug]) => slug).sort();
  const unexpected = [...visibleSet].filter((slug) => !expectedSet.has(slug)).sort();
  return { ok: duplicates.length === 0 && unexpected.length === 0, expected, visible, gated, duplicates, unexpected };
}

function alignedAsarDataOffset(headerSize) {
  const prefixSize = 16;
  return prefixSize + headerSize + ((4 - ((prefixSize + headerSize) % 4)) % 4);
}

function walkAsarFiles(node, prefix, entries) {
  for (const [name, child] of Object.entries(node?.files || {})) {
    const itemPath = prefix ? `${prefix}/${name}` : name;
    if (child?.files) walkAsarFiles(child, itemPath, entries);
    else if (!child?.unpacked && /\.js$/i.test(itemPath)) entries.push({
      path: itemPath,
      offset: Number(child?.offset || 0),
      size: Number(child?.size || 0),
    });
  }
}

export function readNativeSettingsRegistrationSlugs(asarPath) {
  const fd = openSync(asarPath, "r");
  try {
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, prefix.length, 0);
    const headerSize = prefix.readUInt32LE(12);
    const headerBuffer = Buffer.alloc(headerSize);
    readSync(fd, headerBuffer, 0, headerSize, 16);
    const header = JSON.parse(headerBuffer.toString("utf8"));
    const dataOffset = alignedAsarDataOffset(headerSize);
    const entries = [];
    walkAsarFiles(header, "", entries);
    const contracts = [];
    for (const entry of entries) {
      if (entry.size <= 0 || entry.size > 20 * 1024 * 1024) continue;
      const buffer = Buffer.alloc(entry.size);
      readSync(fd, buffer, 0, buffer.length, dataOffset + entry.offset);
      const text = buffer.toString("utf8");
      if (!text.includes("settings") || !text.includes("agent")) continue;
      const slugs = extractNativeSettingsRegistrationSlugs(text);
      if (slugs.length > 0) contracts.push(slugs);
    }
    const unique = [...new Map(contracts.map((slugs) => [JSON.stringify(slugs), slugs])).values()];
    if (unique.length !== 1) throw new Error(`Expected one native Settings registration contract, found ${unique.length}.`);
    return unique[0];
  } finally {
    closeSync(fd);
  }
}

export function classifyUnsupportedExternalSettingsTarget({ href = "", label = "" } = {}) {
  const normalizedHref = String(href).trim();
  const normalizedLabel = String(label).replace(/\s+/g, " ").trim();
  const lowerHref = normalizedHref.toLowerCase();
  const knownSettingsHref = lowerHref.includes("chatgpt.com/#settings")
    || lowerHref.includes("chatgpt.com/open-security-settings");
  const providerHref = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)(?:[/:?#]|$)/i.test(normalizedHref);
  const accountSurfaceLabel = /^(?:(?:ChatGPT|OpenAI)\s+)?(?:Account|Account Settings|Security Settings|Usage|Profile)$|^(?:Manage|Open)\s+(?:Account|Account Settings|Security Settings|Usage|Profile)$|^(?:(?:ChatGPT|OpenAI)\s*)?(?:账户|账号|账户设置|账号设置|安全设置|用量|使用情况|个人资料|个人档案)$|^(?:管理|打开)(?:账户|账号|账户设置|账号设置|安全设置|用量|使用情况|个人资料|个人档案)$/i.test(normalizedLabel);

  if (knownSettingsHref) {
    return { href: normalizedHref, label: normalizedLabel, reason: "known-chatgpt-settings" };
  }
  if (accountSurfaceLabel && (providerHref || normalizedHref.length === 0)) {
    return { href: normalizedHref, label: normalizedLabel, reason: providerHref ? "provider-account-surface" : "button-account-surface" };
  }
  return null;
}

export function classifyNativeSettingsCrashSnapshot({
  headings = [],
  buttons = [],
  bodyText = "",
  hasComposer = false,
} = {}) {
  if (hasComposer === true) return false;
  const normalizedHeadings = Array.isArray(headings)
    ? headings.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const normalizedButtons = Array.isArray(buttons)
    ? buttons.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const normalizedBody = String(bodyText ?? "").replace(/\s+/g, " ").trim();
  const fatalHeading = normalizedHeadings.some((heading) => /^(?:(?:ChatGPT|Anti-Codex)\s*)?(?:已意外停止|unexpectedly\s+(?:stopped|quit|closed)|has\s+unexpectedly\s+(?:stopped|crashed)|(?:quit|stopped|closed)\s+unexpectedly)[.!。！]?$/i.test(heading));
  const genericError = normalizedBody.length > 0
    && normalizedBody.length <= 1_600
    && /(?:^|\s)(?:糟糕[，,]\s*出错了|Oops,?\s+an error has occurred|Something went wrong)[.!。！]?(?:\s|$)/i.test(normalizedBody);
  const recoveryAction = normalizedButtons.some((label) => /^(?:重试|重新加载|重新启动|重启|再试一次|retry|reload|restart|try again)$/i.test(label));
  return recoveryAction && (fatalHeading || genericError);
}
