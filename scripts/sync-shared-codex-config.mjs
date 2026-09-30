#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [, , sourcePath, targetPath, ...optionArgs] = process.argv;

if (!sourcePath || !targetPath) {
  console.error("Usage: sync-shared-codex-config.mjs <source-config> <target-config> [--install-root <path>] [--codex-home <path>]");
  process.exit(2);
}

function optionValue(name) {
  const index = optionArgs.indexOf(name);
  return index >= 0 ? optionArgs[index + 1] || "" : "";
}

const installRoot = optionValue("--install-root");
const codexHome = optionValue("--codex-home") || path.dirname(path.resolve(targetPath));
const sharedSectionRe = /^\[(features|marketplaces|plugins|mcp_servers|projects)(\.|\])/;
const workerToolSuffix = "_start_implementation";
const windowsShimCommands = new Set(["npx", "npm", "pnpm", "yarn"]);
const shouldNormalizeWindowsShims = process.platform === "win32" || process.env.DEEPCODEX_FORCE_WINDOWS_SHIM === "1";
const localWebMcpName = "anticodex-web";

function splitTomlBlocks(text) {
  const blocks = [];
  let current = { header: null, lines: [] };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "");
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      blocks.push(current);
      current = { header: line.trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }

  blocks.push(current);
  return blocks;
}

function isShared(block) {
  return Boolean(block.header && sharedSectionRe.test(block.header));
}

function isMcpBlock(block) {
  return Boolean(block.header?.startsWith("[mcp_servers."));
}

function mcpServerName(block) {
  const match = block.header?.match(/^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\.\]]+))(?:\.|\])/);
  return String(match?.[1] || match?.[2] || match?.[3] || "");
}

function mcpBlockSuffix(block) {
  const match = block.header?.match(/^\[mcp_servers\.(?:"[^"]+"|'[^']+'|[^\.\]]+)(?:\.([^\]]+))?\]/);
  return String(match?.[1] || "");
}

function blockHasAssignment(block, key, expected) {
  const pattern = new RegExp(`^${key}\\s*=\\s*${expected}`, "i");
  return block.lines.some((line) => pattern.test(line.trim()));
}

function workerServerNames(blocks, { allowGeneratedHttp = false } = {}) {
  const records = new Map();
  const recordFor = (name) => {
    if (!records.has(name)) records.set(name, { local: false, hasStartTool: false });
    return records.get(name);
  };
  for (const block of blocks) {
    if (!isMcpBlock(block)) continue;
    const name = mcpServerName(block);
    const suffix = mcpBlockSuffix(block);
    if (!name) continue;
    const record = recordFor(name);
    if (!suffix) {
      const disabled = blockHasAssignment(block, "enabled", "false(?:\\s|$)");
      const local = blockHasAssignment(block, "command", "['\"]")
        && !blockHasAssignment(block, "url", "['\"]");
      const generated = allowGeneratedHttp && block.lines.some((line) =>
        /^url\s*=\s*["']http:\/\/127\.0\.0\.1:\d+\/servers\//i.test(line.trim()));
      record.local = !disabled && (local || generated);
      continue;
    }
    if (!suffix.startsWith("tools.") || blockHasAssignment(block, "enabled", "false(?:\\s|$)")) continue;
    const tool = suffix.slice("tools.".length);
    if (tool.endsWith(workerToolSuffix)) record.hasStartTool = true;
  }
  return new Set(
    [...records]
      .filter(([, record]) => record.local && record.hasStartTool)
      .map(([name]) => name),
  );
}

function isWorkerBlock(block, names) {
  return isMcpBlock(block) && names.has(mcpServerName(block));
}

function parseTomlStringArray(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) return null;
  try {
    return JSON.parse(raw.replace(/'/g, '"'));
  } catch {
    return null;
  }
}

function renderTomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(", ")}]`;
}

function normalizeWindowsMcpShim(block) {
  if (!shouldNormalizeWindowsShims || !block.header?.startsWith("[mcp_servers.")) return block;

  let commandLineIndex = -1;
  let argsLineIndex = -1;
  let command = "";

  for (let i = 0; i < block.lines.length; i += 1) {
    const commandMatch = block.lines[i].match(/^command\s*=\s*(['"])(.*?)\1\s*$/);
    if (commandMatch) {
      commandLineIndex = i;
      command = commandMatch[2].trim().toLowerCase();
      continue;
    }
    if (/^args\s*=/.test(block.lines[i])) argsLineIndex = i;
  }

  if (!windowsShimCommands.has(command)) return block;

  let args = [];
  if (argsLineIndex >= 0) {
    const rawArgs = block.lines[argsLineIndex].replace(/^args\s*=\s*/, "");
    const parsed = parseTomlStringArray(rawArgs);
    if (Array.isArray(parsed)) args = parsed;
  }

  const shim = `${command}.cmd`;
  const next = { ...block, lines: [...block.lines] };
  next.lines[commandLineIndex] = `command = "cmd.exe"`;
  const argsLine = `args = ${renderTomlStringArray(["/d", "/s", "/c", shim, ...args])}`;
  if (argsLineIndex >= 0) next.lines[argsLineIndex] = argsLine;
  else next.lines.splice(commandLineIndex + 1, 0, argsLine);
  return next;
}

function findExistingSiblingCommand(command) {
  if (!shouldNormalizeWindowsShims || !command || fs.existsSync(command)) return "";
  if (!path.isAbsolute(command)) return "";
  const commandName = path.basename(command);
  if (!commandName || !/\.exe$/i.test(commandName)) return "";
  const versionDir = path.dirname(command);
  const binRoot = path.dirname(versionDir);
  if (!fs.existsSync(binRoot)) return "";

  const candidates = [];
  for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(binRoot, entry.name, commandName);
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    candidates.push({ candidate, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.candidate.localeCompare(b.candidate));
  return candidates[0]?.candidate || "";
}

function normalizeMissingWindowsMcpCommand(block) {
  if (!shouldNormalizeWindowsShims || !block.header?.startsWith("[mcp_servers.")) return block;

  let commandLineIndex = -1;
  let command = "";
  for (let i = 0; i < block.lines.length; i += 1) {
    const commandMatch = block.lines[i].match(/^command\s*=\s*(['"])(.*?)\1\s*$/);
    if (commandMatch) {
      commandLineIndex = i;
      command = commandMatch[2].trim();
      break;
    }
  }
  if (commandLineIndex < 0) return block;

  const replacement = findExistingSiblingCommand(command);
  if (!replacement) return block;
  const next = { ...block, lines: [...block.lines] };
  next.lines[commandLineIndex] = `command = ${JSON.stringify(replacement)}`;
  return next;
}

function setTomlString(lines, key, value) {
  const next = [...lines];
  const index = next.findIndex((line) => new RegExp(`^${key}\\s*=`).test(line));
  const rendered = `${key} = ${JSON.stringify(value)}`;
  if (index >= 0) next[index] = rendered;
  else next.push(rendered);
  return next;
}

function localizeNodeRepl(block) {
  if (!installRoot || mcpServerName(block) !== "node_repl") return block;
  const resources = path.join(installRoot, "codex-patched-app", "resources");
  const bin = path.join(resources, "cua_node", "bin");
  const next = { ...block, lines: [...block.lines] };

  if (/^\[mcp_servers\.node_repl\]$/.test(block.header)) {
    next.lines = setTomlString(next.lines, "command", path.join(bin, "node_repl.exe"));
  } else if (/^\[mcp_servers\.node_repl\.env\]$/.test(block.header)) {
    next.lines = next.lines.filter((line) => !/^SKY_CUA_NATIVE_PIPE(?:_DIRECTORY)?\s*=/.test(line));
    for (const [key, value] of [
      ["NODE_REPL_NODE_PATH", path.join(bin, "node.exe")],
      ["NODE_REPL_NODE_MODULE_DIRS", path.join(bin, "node_modules")],
      ["NODE_REPL_TRUSTED_CODE_PATHS", codexHome],
      ["CODEX_HOME", codexHome],
      ["CODEX_CLI_PATH", path.join(resources, "codex.exe")],
    ]) next.lines = setTomlString(next.lines, key, value);
  }
  return next;
}

function isLocalWebMcpBlock(block) {
  return isMcpBlock(block) && mcpServerName(block) === localWebMcpName;
}

function localWebMcpBlocks() {
  if (!installRoot) return [];
  const runtimeRoot = fs.existsSync(path.join(installRoot, "runtime"))
    ? path.join(installRoot, "runtime")
    : installRoot;
  const python = process.platform === "win32"
    ? path.join(installRoot, "shared-mcp", ".venv", "Scripts", "python.exe")
    : path.join(installRoot, "shared-mcp", ".venv", "bin", "python");
  const server = path.join(runtimeRoot, "translator", "tools", "web_mcp_stdio.py");
  return [{
    header: `[mcp_servers.${localWebMcpName}]`,
    lines: [
      `[mcp_servers.${localWebMcpName}]`,
      `command = ${JSON.stringify(python)}`,
      `args = [${JSON.stringify(server)}]`,
      "startup_timeout_sec = 30",
    ],
  }];
}

function render(blocks) {
  return blocks
    .map((block) => block.lines.join("\n").replace(/\n+$/g, ""))
    .filter((part) => part.length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

function mergeSharedBlocks(targetBlocks, sourceBlocks) {
  const sourceWorkerNames = workerServerNames(sourceBlocks, { allowGeneratedHttp: true });
  const targetWorkerNames = workerServerNames(targetBlocks, { allowGeneratedHttp: true });
  const sourceShared = sourceBlocks
    .filter(isShared)
    .filter((block) => !isWorkerBlock(block, sourceWorkerNames))
    .filter((block) => !isWorkerBlock(block, targetWorkerNames))
    .map(normalizeWindowsMcpShim)
    .map(normalizeMissingWindowsMcpCommand)
    .map(localizeNodeRepl);
  const sourceHeaders = new Set(sourceShared.map((block) => block.header));
  const sourceHasMcpBlocks = sourceShared.some(isMcpBlock);
  const keptTargetBlocks = targetBlocks.filter(
    (block) => isWorkerBlock(block, targetWorkerNames)
      || (!isShared(block) || (!sourceHeaders.has(block.header) && !(sourceHasMcpBlocks && isMcpBlock(block))))
  );
  const generatedWebMcp = localWebMcpBlocks();
  const merged = generatedWebMcp.length > 0
    ? [...keptTargetBlocks, ...sourceShared].filter((block) => !isLocalWebMcpBlock(block))
    : [...keptTargetBlocks, ...sourceShared];
  return [...merged, ...generatedWebMcp];
}

if (!fs.existsSync(sourcePath)) {
  process.exit(0);
}

if (!fs.existsSync(targetPath)) {
  fs.writeFileSync(targetPath, "");
}

const source = fs.readFileSync(sourcePath, "utf8");
const target = fs.readFileSync(targetPath, "utf8");
const sourceBlocks = splitTomlBlocks(source);
const targetBlocks = splitTomlBlocks(target);

fs.writeFileSync(targetPath, render(mergeSharedBlocks(targetBlocks, sourceBlocks)));
