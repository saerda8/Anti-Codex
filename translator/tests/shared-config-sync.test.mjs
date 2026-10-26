import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const syncSharedConfig = path.join(repoRoot, "scripts", "sync-shared-codex-config.mjs");
const syncRegistrations = path.join(repoRoot, "scripts", "sync-deepcodex-plugin-registrations.mjs");
const mcpSkillsVerifier = path.join(repoRoot, "scripts", "test-anticodex-mcp-skills.ps1");

const tempDirs = new Set();

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-config-sync-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

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
  fs.mkdirSync(path.join(installRoot, "runtime"), { recursive: true });
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

test("shared config sync registers the Anti-Codex web stdio MCP server", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "state", "config.toml");
  const installRoot = path.join(dir, "Anti-Codex");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.join(installRoot, "runtime"), { recursive: true });
  fs.writeFileSync(source, 'model = "gpt"\n');

  execFileSync(process.execPath, [
    syncSharedConfig,
    source,
    target,
    "--install-root",
    installRoot,
  ]);
  const next = fs.readFileSync(target, "utf8");
  const python = process.platform === "win32"
    ? path.join(installRoot, "shared-mcp", ".venv", "Scripts", "python.exe")
    : path.join(installRoot, "shared-mcp", ".venv", "bin", "python");
  const server = path.join(installRoot, "runtime", "translator", "tools", "web_mcp_stdio.py");
  assert.match(next, /\[mcp_servers\.anticodex-web\]/);
  assert.match(next, new RegExp(`command = ${escapeRegExp(JSON.stringify(python))}`));
  assert.match(next, new RegExp(`args = \\[${escapeRegExp(JSON.stringify(server))}\\]`));
  assert.match(next, /startup_timeout_sec = 30/);
});

test("MCP verification accepts only a live Anti-Codex pipe distinct from the shared Codex pipe", () => {
  const verifier = fs.readFileSync(mcpSkillsVerifier, "utf8");

  assert.doesNotMatch(verifier, /if \(\$nodeReplEnv -match [^\n]+SKY_CUA_NATIVE_PIPE[\s\S]*?must not inherit the native Codex computer-use pipe/);
  assert.match(verifier, /\$localNativePipeDirectory\s*=\s*Get-TomlQuotedFieldValue/);
  assert.match(verifier, /\$sharedNativePipeDirectory\s*=\s*Get-TomlQuotedFieldValue/);
  assert.match(verifier, /\$localNativePipeDirectory\s*-ieq\s*\$sharedNativePipeDirectory/);
  assert.match(verifier, /Test-Path -LiteralPath \$localNativePipeDirectory/);
});

test("MCP verification accepts only isolated node_repl trusted roots", {
  skip: process.platform !== "win32",
}, () => {
  const verifier = fs.readFileSync(mcpSkillsVerifier, "utf8");
  const start = verifier.indexOf("function Test-NodeReplTrustedCodePaths");
  const end = verifier.indexOf("\nfunction ", start + 10);
  assert.ok(start >= 0 && end > start, "trusted-path validator must be independently testable");
  const validator = verifier.slice(start, end);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const codexHome = path.join(tempDir(), "state", "codex-home");
  const nodeModules = path.join(tempDir(), "install", "resources", "cua_node", "bin", "node_modules");
  const sharedCodexHome = path.join(tempDir(), ".codex");
  const pathList = (...values) => values.join(path.delimiter);
  const script = [
    validator,
    "$result = [ordered]@{",
    `  homeOnly = Test-NodeReplTrustedCodePaths -Actual ${quote(codexHome)} -CodexHome ${quote(codexHome)} -NodeModulesPath ${quote(nodeModules)}`,
    `  homeAndModules = Test-NodeReplTrustedCodePaths -Actual ${quote(pathList(codexHome, nodeModules))} -CodexHome ${quote(codexHome)} -NodeModulesPath ${quote(nodeModules)}`,
    `  modulesOnly = Test-NodeReplTrustedCodePaths -Actual ${quote(nodeModules)} -CodexHome ${quote(codexHome)} -NodeModulesPath ${quote(nodeModules)}`,
    `  sharedExtra = Test-NodeReplTrustedCodePaths -Actual ${quote(pathList(codexHome, sharedCodexHome))} -CodexHome ${quote(codexHome)} -NodeModulesPath ${quote(nodeModules)}`,
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("\n");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    homeOnly: true,
    homeAndModules: true,
    modulesOnly: false,
    sharedExtra: false,
  });
});

test("MCP env comparison ignores generated node_repl instructions but detects other env changes", {
  skip: process.platform !== "win32",
}, () => {
  const verifier = fs.readFileSync(mcpSkillsVerifier, "utf8");
  const start = verifier.indexOf("function Normalize-McpEnvForCompare");
  const end = verifier.indexOf("\nfunction ", start + 10);
  assert.ok(start >= 0 && end > start, "MCP env normalizer must be independently testable");
  const normalize = verifier.slice(start, end);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const shared = [
    'NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER = ""',
    'NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME = ""',
    'NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE = ""',
    'CUSTOM_ENV = "same"',
  ].join("\n");
  const local = [
    'NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER = "generated browser instruction"',
    'NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME = "generated Chrome instruction"',
    'NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE = "generated computer-use instruction"',
    'CUSTOM_ENV = "same"',
  ].join("\n");
  const script = [
    normalize,
    "$result = [ordered]@{",
    `  runtimeInstructionDifferencesIgnored = (Normalize-McpEnvForCompare -ServerName ${quote("node_repl")} -Text ${quote(shared)}) -eq (Normalize-McpEnvForCompare -ServerName ${quote("node_repl")} -Text ${quote(local)})`,
    `  ordinaryEnvDifferencesDetected = (Normalize-McpEnvForCompare -ServerName ${quote("node_repl")} -Text ${quote('CUSTOM_ENV = "shared"')}) -ne (Normalize-McpEnvForCompare -ServerName ${quote("node_repl")} -Text ${quote('CUSTOM_ENV = "local"')})`,
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("\n");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    runtimeInstructionDifferencesIgnored: true,
    ordinaryEnvDifferencesDetected: true,
  });
});

test("shared config sync excludes Anti-Codex development workers by default", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "anticodex.toml");
  const developmentWorkers = [
    "deepseek-external",
    "future-autonomous-worker",
  ];

  const sourceLines = ['model = "gpt"', ""];
  for (const worker of developmentWorkers) {
    const prefix = worker.replaceAll("-", "_");
    sourceLines.push(`[mcp_servers.${worker}]`);
    if (worker === "deepseek-external") {
      sourceLines.push(
        `url = "http://127.0.0.1:47622/servers/${worker}/mcp"`,
        'http_headers = { Authorization = "Bearer test-token" }',
      );
    } else {
      sourceLines.push(
        'command = "node"',
        'args = ["arbitrary-entrypoint.mjs"]',
        "",
        `[mcp_servers.${worker}.env]`,
        'WORKER_TEST = "1"',
      );
    }
    sourceLines.push(
      "",
      `[mcp_servers.${worker}.tools.${prefix}_start_implementation]`,
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

  execFileSync(process.execPath, [syncSharedConfig, source, target]);
  const next = fs.readFileSync(target, "utf8");
  for (const worker of developmentWorkers) {
    assert.doesNotMatch(next, new RegExp(`\\[mcp_servers\\.${worker.replaceAll("-", "\\-")}([.\\]])`));
  }
  assert.match(next, /\[mcp_servers\.node_repl\]\ncommand = "node_repl\.exe"/);
  assert.match(next, /\[mcp_servers\.customer-mcp\]\ncommand = "customer\.exe"/);
  const synchronizer = fs.readFileSync(syncSharedConfig, "utf8");
  assert.doesNotMatch(synchronizer, /"deepseek-external"/);
  assert.match(synchronizer, /start_implementation/);
});

test("shared config sync can explicitly include development workers", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "anticodex.toml");
  fs.writeFileSync(source, [
    "[mcp_servers.deepseek-external]",
    'url = "http://127.0.0.1:47622/servers/deepseek-external/mcp"',
    'http_headers = { Authorization = "Bearer test-token" }',
    "",
    "[mcp_servers.deepseek-external.tools.deepseek_start_implementation]",
    'approval_mode = "approve"',
  ].join("\n"));
  fs.writeFileSync(target, "model = \"anticodex\"\n");

  execFileSync(process.execPath, [syncSharedConfig, source, target, "--include-development-workers"]);
  const next = fs.readFileSync(target, "utf8");
  assert.match(next, /\[mcp_servers\.deepseek-external\]/);
  assert.match(next, /deepseek_start_implementation/);
});

test("shared config sync excludes the native CUA server from Anti-Codex", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "anticodex.toml");
  fs.writeFileSync(source, [
    "[mcp_servers.cua_repl]",
    'command = "cua_repl.exe"',
    "args = []",
    "",
    "[mcp_servers.node_repl]",
    'command = "node_repl.exe"',
    "args = []",
    "",
  ].join("\n"));
  fs.writeFileSync(target, "model = \"anticodex\"\n");

  execFileSync(process.execPath, [syncSharedConfig, source, target]);
  const next = fs.readFileSync(target, "utf8");
  assert.doesNotMatch(next, /\[mcp_servers\.cua_repl\]/);
  assert.match(next, /\[mcp_servers\.node_repl\]/);
});

test("MCP verifier keeps development workers opt-in", () => {
  const verifier = fs.readFileSync(mcpSkillsVerifier, "utf8");
  assert.doesNotMatch(verifier, /deepseek-external/);
  assert.match(verifier, /Get-WorkerMcpNamesFromToml/);
  assert.match(verifier, /AllowGeneratedHttp/);
  assert.match(verifier, /start_implementation/);
  assert.doesNotMatch(verifier, /worker\[-_\]mcp/);
  assert.match(verifier, /must not include development MCP worker/);
  assert.match(verifier, /developmentWorkersAllowed/);
});

test("MCP verifier probes only enabled local servers and preserves shared names", () => {
  const verifier = fs.readFileSync(mcpSkillsVerifier, "utf8");
  const localMcpNames = verifier.match(/\$mcpNames = @\(\$mcpNamesAll \| Where-Object \{[\s\S]*?\}\)/)?.[0] ?? "";

  assert.match(localMcpNames, /Get-McpSectionText \$configText \$_/);
  assert.match(localMcpNames, /Get-TomlFieldRaw[\s\S]*?"enabled"[\s\S]*?-notmatch[\s\S]*?false/);
  assert.match(verifier, /\$sharedMcpNamesAll = @\(Get-McpServerNamesFromToml \$sharedConfigText\)/);
  assert.match(verifier, /MCP '\$mcpName' real stdio tools\/list failed:/);
});

test("MCP verifier separates disabled registrations from probes and detects missing enabled servers", {
  skip: process.platform !== "win32",
}, () => {
  const verifier = fs.readFileSync(mcpSkillsVerifier, "utf8");
  const functions = [
    "Get-McpServerNamesFromToml", "Normalize-McpServerName", "Get-McpTomlKeyPattern",
    "Get-McpSectionText", "Get-McpNestedSectionText", "Get-TomlFieldRaw",
    "Get-TomlQuotedFieldValue", "Normalize-McpCommandCompareValue", "Normalize-McpEnvForCompare",
  ].map((name) => {
    const start = verifier.indexOf(`function ${name} {`);
    const end = verifier.indexOf("\nfunction ", start + 10);
    assert.ok(start >= 0 && end > start, `${name} must be independently testable`);
    return verifier.slice(start, end);
  });
  const start = verifier.indexOf("$mcpNames = @()");
  const end = verifier.indexOf("\n$expectedMcpToolNames =", start);
  assert.ok(start >= 0 && end > start, "MCP registration and probe checks must be testable without starting servers");
  const checks = verifier.slice(start, end);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const server = (name, enabled) => `[mcp_servers.${name}]\ncommand = "${name}.exe"\n${enabled === undefined ? "" : `enabled = ${enabled}\n`}`;
  const enabled = server("active", true);
  const disabled = server("inactive", false);
  const cases = [
    { name: "sameDisabled", shared: enabled + disabled, local: enabled + disabled },
    { name: "missingEnabled", shared: enabled + disabled, local: disabled },
    { name: "disabledLocally", shared: enabled + disabled, local: server("active", false) + disabled },
    { name: "implicitEnabled", shared: server("active"), local: enabled },
  ];
  const script = [
    ...functions,
    "function Add-Failure { param([string]$Message) $script:fixtureFailures += $Message }",
    "function Resolve-McpCommand { param([string]$Command) $script:fixtureResolved += $Command; return $true }",
    "function Invoke-Fixture { param([string]$configText, [string]$sharedConfigPath)",
    "$script:fixtureFailures = @(); $script:fixtureResolved = @()",
    "$developmentWorkersAllowed = $true; $mcpSmokeChecks = @(); $changedSharedMcpNames = @(); $changedSharedMcpDetails = @()",
    checks,
    "[ordered]@{ probes = @($mcpNames); resolved = @($script:fixtureResolved); missing = @($missingSharedMcpNames); changed = @($changedSharedMcpDetails); failures = @($script:fixtureFailures) }",
    "}",
    "$result = [ordered]@{}",
    ...cases.map(({ name, shared, local }) => {
      const sharedPath = path.join(tempDir(), "shared.toml");
      fs.writeFileSync(sharedPath, shared);
      return `$result.${name} = Invoke-Fixture -configText ${quote(local)} -sharedConfigPath ${quote(sharedPath)}`;
    }),
    "$result | ConvertTo-Json -Depth 8 -Compress",
  ].join("\n");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const scriptPath = path.join(tempDir(), "verify-mcp-fixtures.ps1");
  fs.writeFileSync(scriptPath, `\uFEFF${script}`);
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const actual = JSON.parse(result.stdout.trim());
  assert.deepEqual(actual.sameDisabled, { probes: ["active"], resolved: ["active.exe"], missing: [], changed: [], failures: [] });
  assert.deepEqual(actual.missingEnabled.probes, []);
  assert.deepEqual(actual.missingEnabled.resolved, []);
  assert.deepEqual(actual.missingEnabled.missing, ["active"]);
  assert.match(actual.missingEnabled.failures.join("\n"), /server 'active'.*missing it/);
  assert.deepEqual(actual.disabledLocally.probes, []);
  assert.deepEqual(actual.disabledLocally.resolved, []);
  assert.deepEqual(actual.disabledLocally.missing, []);
  assert.deepEqual(actual.disabledLocally.changed, [{ name: "active", fields: ["enabled"] }]);
  assert.match(actual.disabledLocally.failures.join("\n"), /server 'active'.*differs.*enabled/);
  assert.deepEqual(actual.implicitEnabled, { probes: ["active"], resolved: ["active.exe"], missing: [], changed: [], failures: [] });
});

test("development worker opt-in migrates out of native config and survives refresh", () => {
  for (const enabled of [true, false]) {
    const dir = tempDir();
    const source = path.join(dir, "global.toml");
    const target = path.join(dir, "config.toml");
    fs.writeFileSync(source, '[mcp_servers.audit-worker]\ncommand = "worker.exe"\n[mcp_servers.audit-worker.tools.audit_start_implementation]\napproval_mode = "approve"\n');
    fs.writeFileSync(target, `model = "anticodex"\n[anticodex.development_workers]\nenabled = ${enabled}\n[features]\nunified_exec = true\n`);
    execFileSync(process.execPath, [syncSharedConfig, source, target]);
    const first = fs.readFileSync(target, "utf8");
    assert.doesNotMatch(first, /\[anticodex\./);
    assert.equal(first.includes('[mcp_servers.audit-worker]'), enabled);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "anticodex-features.json"), "utf8")).developmentWorkers, enabled);
    execFileSync(process.execPath, [syncSharedConfig, source, target]);
    assert.equal(fs.readFileSync(target, "utf8"), first);
  }
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
