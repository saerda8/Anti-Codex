import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const syncSharedConfig = path.join(repoRoot, "scripts", "sync-shared-codex-config.mjs");
const syncRegistrations = path.join(repoRoot, "scripts", "sync-deepcodex-plugin-registrations.mjs");
const mcpSkillsVerifier = path.join(repoRoot, "scripts", "test-anticodex-mcp-skills.ps1");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-config-sync-"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("shared config sync preserves DeepCodex-only plugin registrations", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "deepcodex.toml");

  fs.writeFileSync(source, [
    'model = "gpt"',
    "",
    '[plugins."remotion@openai-curated"]',
    "enabled = false",
    "",
    '[plugins."hyperframes@openai-curated"]',
    "enabled = true",
    "",
  ].join("\n"));

  fs.writeFileSync(target, [
    'model = "deepseek"',
    "",
    '[plugins."remotion@openai-curated"]',
    "enabled = true",
    "",
    '[plugins."game-studio@openai-curated"]',
    "enabled = true",
    "",
    "[projects.foo]",
    'trust_level = "trusted"',
    "",
  ].join("\n"));

  execFileSync(process.execPath, [syncSharedConfig, source, target]);
  const next = fs.readFileSync(target, "utf8");

  assert.match(next, /\[plugins\."remotion@openai-curated"\]\nenabled = false/);
  assert.match(next, /\[plugins\."hyperframes@openai-curated"\]\nenabled = true/);
  assert.match(next, /\[plugins\."game-studio@openai-curated"\]\nenabled = true/);
  assert.match(next, /\[projects\.foo\]\ntrust_level = "trusted"/);
});

test("shared config sync removes stale local MCP server blocks", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "deepcodex.toml");

  fs.writeFileSync(source, [
    'model = "gpt"',
    "",
    "[mcp_servers.node_repl]",
    'command = "node"',
    "args = []",
    "",
    "[mcp_servers.node_repl.env]",
    'NODE_REPL = "1"',
    "",
    "[mcp_servers.shared_worker]",
    'command = "node"',
    'args = ["shared.mjs"]',
    "",
  ].join("\n"));

  fs.writeFileSync(target, [
    'model = "deepseek"',
    "",
    "[mcp_servers.stale_worker]",
    'command = "node"',
    'args = ["missing.mjs"]',
    "",
    "[mcp_servers.stale_worker.env]",
    'OLD = "1"',
    "",
    "[mcp_servers.stale_worker.tools.old_call]",
    "enabled = true",
    "",
    "[mcp_servers.node_repl]",
    'command = "old-node"',
    "",
    "[features]",
    "web_search = true",
    "",
  ].join("\n"));

  execFileSync(process.execPath, [syncSharedConfig, source, target]);
  const next = fs.readFileSync(target, "utf8");

  assert.doesNotMatch(next, /\[mcp_servers\.stale_worker\]/);
  assert.doesNotMatch(next, /\[mcp_servers\.stale_worker\.env\]/);
  assert.doesNotMatch(next, /\[mcp_servers\.stale_worker\.tools\.old_call\]/);
  assert.match(next, /\[mcp_servers\.node_repl\]\ncommand = "node"\nargs = \[\]/);
  assert.match(next, /\[mcp_servers\.shared_worker\]\ncommand = "node"\nargs = \["shared\.mjs"\]/);
});

test("shared config sync localizes node_repl and removes the native Codex pipe", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const codexHome = path.join(dir, "state", "codex-home");
  const target = path.join(codexHome, "config.toml");
  const installRoot = path.join(dir, "Anti-Codex");
  fs.mkdirSync(codexHome, { recursive: true });

  fs.writeFileSync(source, [
    "[mcp_servers.node_repl]",
    'command = "C:\\\\Users\\\\XD\\\\AppData\\\\Local\\\\OpenAI\\\\Codex\\\\runtimes\\\\cua_node\\\\bin\\\\node_repl.exe"',
    "args = []",
    "",
    "[mcp_servers.node_repl.env]",
    'NODE_REPL_NODE_PATH = "C:\\\\Users\\\\XD\\\\AppData\\\\Local\\\\OpenAI\\\\Codex\\\\runtimes\\\\cua_node\\\\bin\\\\node.exe"',
    'NODE_REPL_NODE_MODULE_DIRS = "C:\\\\Users\\\\XD\\\\AppData\\\\Local\\\\OpenAI\\\\Codex\\\\runtimes\\\\cua_node\\\\bin\\\\node_modules"',
    'NODE_REPL_TRUSTED_CODE_PATHS = "C:\\\\Users\\\\XD\\\\.codex"',
    'CODEX_HOME = "C:\\\\Users\\\\XD\\\\.codex"',
    'CODEX_CLI_PATH = "G:\\\\Trae-Project\\\\Coexconfig\\\\codex.exe"',
    'SKY_CUA_NATIVE_PIPE = "1"',
    'SKY_CUA_NATIVE_PIPE_DIRECTORY = "\\\\\\\\.\\\\pipe\\\\codex-computer-use-native"',
    'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
    "",
  ].join("\n"));
  fs.writeFileSync(target, "");

  execFileSync(process.execPath, [
    syncSharedConfig,
    source,
    target,
    "--install-root",
    installRoot,
    "--codex-home",
    codexHome,
  ]);
  const next = fs.readFileSync(target, "utf8");
  const resources = path.join(installRoot, "codex-patched-app", "resources");

  assert.match(next, new RegExp(`command = ${escapeRegExp(JSON.stringify(path.join(resources, "cua_node", "bin", "node_repl.exe")))}`));
  assert.match(next, new RegExp(`NODE_REPL_NODE_PATH = ${escapeRegExp(JSON.stringify(path.join(resources, "cua_node", "bin", "node.exe")))}`));
  assert.match(next, new RegExp(`NODE_REPL_NODE_MODULE_DIRS = ${escapeRegExp(JSON.stringify(path.join(resources, "cua_node", "bin", "node_modules")))}`));
  assert.match(next, new RegExp(`NODE_REPL_TRUSTED_CODE_PATHS = ${escapeRegExp(JSON.stringify(codexHome))}`));
  assert.match(next, new RegExp(`CODEX_HOME = ${escapeRegExp(JSON.stringify(codexHome))}`));
  assert.match(next, new RegExp(`CODEX_CLI_PATH = ${escapeRegExp(JSON.stringify(path.join(resources, "codex.exe")))}`));
  assert.match(next, /BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"/);
  assert.doesNotMatch(next, /SKY_CUA_NATIVE_PIPE/);
  assert.doesNotMatch(next, /C:\\\\Users\\\\XD\\\\\.codex|Coexconfig|OpenAI\\\\Codex\\\\runtimes/);
});

test("shared config sync excludes Anti-Codex development workers by default", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "anticodex.toml");
  const includeTarget = path.join(dir, "include-workers.toml");
  const developmentWorkers = [
    "deepseek-code-worker",
    "mimo-claude-coworker",
    "mimocode-worker",
    "deveco-code-worker",
    "opencode-worker",
    "kilo-worker",
    "codebuddy-worker",
    "agnes-worker",
    "antigravity-code-worker",
    "xiaoqiang1",
    "xiaoqiang2",
    "xiaoqiang3",
    "xiaoqiang4",
  ];

  const sourceLines = ['model = "gpt"', ""];
  for (const worker of developmentWorkers) {
    sourceLines.push(
      `[mcp_servers.${worker}]`,
      'command = "node"',
      `args = ["${worker}.mjs"]`,
      "",
      `[mcp_servers.${worker}.env]`,
      'WORKER_TEST = "1"',
      "",
      `[mcp_servers.${worker}.tools.start]`,
      "enabled = true",
      "",
    );
  }
  sourceLines.push(
    "[mcp_servers.node_repl]",
    'command = "node_repl.exe"',
    "args = []",
    "",
    "[mcp_servers.customer-mcp]",
    'command = "customer.exe"',
    "args = []",
    "",
  );
  fs.writeFileSync(source, sourceLines.join("\n"));
  fs.writeFileSync(target, 'model = "anticodex"\n');
  fs.writeFileSync(includeTarget, 'model = "anticodex"\n');

  execFileSync(process.execPath, [syncSharedConfig, source, target]);
  const next = fs.readFileSync(target, "utf8");
  for (const worker of developmentWorkers) {
    assert.doesNotMatch(next, new RegExp(`\\[mcp_servers\\.${worker.replaceAll("-", "\\-")}([.\\]])`));
  }
  assert.match(next, /\[mcp_servers\.node_repl\]\ncommand = "node_repl\.exe"/);
  assert.match(next, /\[mcp_servers\.customer-mcp\]\ncommand = "customer\.exe"/);

  execFileSync(process.execPath, [syncSharedConfig, source, includeTarget, "--include-development-workers"]);
  const included = fs.readFileSync(includeTarget, "utf8");
  for (const worker of developmentWorkers) {
    assert.doesNotMatch(included, new RegExp(`\\[mcp_servers\\.${worker.replaceAll("-", "\\-")}([.\\]])`));
  }
});

test("MCP verifier rejects development workers inside the Anti-Codex product config", () => {
  const verifier = fs.readFileSync(mcpSkillsVerifier, "utf8");
  for (const worker of [
    "deepseek-code-worker",
    "mimo-claude-coworker",
    "mimocode-worker",
    "deveco-code-worker",
    "opencode-worker",
    "kilo-worker",
    "codebuddy-worker",
    "agnes-worker",
    "antigravity-code-worker",
    "xiaoqiang1",
    "xiaoqiang2",
    "xiaoqiang3",
    "xiaoqiang4",
  ]) {
    assert.equal(verifier.includes(worker), true, `verifier must classify ${worker}`);
  }
  assert.match(verifier, /excludedSharedDevelopmentMcpNames/);
  assert.match(verifier, /must not include development MCP worker/);
});

test("DeepCodex-only plugin registrations stay local and cannot restore development MCP workers", () => {
  const dir = tempDir();
  const current = path.join(dir, "current.toml");
  const previous = path.join(dir, "previous.toml");
  const global = path.join(dir, "global.toml");

  fs.writeFileSync(current, [
    'model = "deepseek"',
    "",
    '[plugins."hyperframes@openai-curated"]',
    "enabled = true",
    "",
  ].join("\n"));

  fs.writeFileSync(previous, [
    'model = "deepseek"',
    "",
    '[plugins."remotion@openai-curated"]',
    "enabled = true",
    "",
    '[plugins."hyperframes@openai-curated"]',
    "enabled = true",
    "",
    "[mcp_servers.deepseek-code-worker]",
    'command = "worker.exe"',
    "",
  ].join("\n"));

  fs.writeFileSync(global, [
    'model = "gpt"',
    "",
    '[plugins."github@openai-curated"]',
    "enabled = true",
    "",
  ].join("\n"));

  const output = execFileSync(process.execPath, [syncRegistrations, current, previous, global], { encoding: "utf8" });
  const result = JSON.parse(output);
  const currentNext = fs.readFileSync(current, "utf8");
  const globalNext = fs.readFileSync(global, "utf8");

  assert.deepEqual(result.restored, ['[plugins."remotion@openai-curated"]']);
  assert.match(currentNext, /\[plugins\."remotion@openai-curated"\]\nenabled = true/);
  assert.doesNotMatch(currentNext, /\[mcp_servers\.deepseek-code-worker\]/);
  assert.doesNotMatch(globalNext, /\[plugins\."remotion@openai-curated"\]\nenabled = true/);
  assert.doesNotMatch(globalNext, /\[mcp_servers\.deepseek-code-worker\]/);
  assert.doesNotMatch(globalNext, /\[plugins\."hyperframes@openai-curated"\]\nenabled = true/);
});
