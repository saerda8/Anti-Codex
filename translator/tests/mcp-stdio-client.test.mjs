import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runMcpStdioCall, runMcpStdioList } from "../../scripts/mcp-stdio-client.mjs";

const SERVER_NAME = "fake-mcp-test-server";
const MARKER = "mcp-echo-red-20260620";

function createFakeMcpServer(dir) {
  const source = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "${SERVER_NAME}", version: "0.1.0" }
      }
    }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "echo",
          description: "Echo back input",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"]
          }
        }]
      }
    }) + "\\n");
  } else if (message.method === "tools/call") {
    const text = message.params?.arguments?.envName
      ? process.env[message.params.arguments.envName] || ""
      : message.params?.arguments?.text || "";
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text }]
      }
    }) + "\\n");
  }
});
`;
  const serverPath = join(dir, "fake-mcp-server.mjs");
  writeFileSync(serverPath, source, "utf8");
  return serverPath;
}

test("runMcpStdioCall handshakes, lists tools, and calls echo", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-stdio-test-"));
  try {
    const result = await runMcpStdioCall({
      command: process.execPath,
      args: [createFakeMcpServer(tempDir)],
      toolName: "echo",
      arguments: { text: MARKER },
      timeoutMs: 5000,
    });

    assert.equal(result.serverInfo.name, SERVER_NAME);
    assert.ok(result.tools.some((tool) => tool.name === "echo"));
    assert.match(result.content.map((item) => item.text).join(""), new RegExp(MARKER));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runMcpStdioList handshakes and lists tools without calling one", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-stdio-list-test-"));
  try {
    const result = await runMcpStdioList({
      command: process.execPath,
      args: [createFakeMcpServer(tempDir)],
      timeoutMs: 5000,
    });

    assert.equal(result.serverInfo.name, SERVER_NAME);
    assert.ok(result.tools.some((tool) => tool.name === "echo"));
    assert.equal(result.isError, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getCodexMcpServerDefinition reads structured stdio config from Codex", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-mcp-config-test-"));
  try {
    const fakeCli = join(tempDir, "fake-codex.mjs");
    writeFileSync(fakeCli, `
const args = process.argv.slice(2);
if (args.join(" ") !== "mcp get node_repl --json") process.exit(3);
process.stdout.write(JSON.stringify({
  name: "node_repl",
  enabled: true,
  transport: {
    type: "stdio",
    command: "C:/fake/node_repl.exe",
    args: ["--probe"],
    env: { CODEX_HOME: "C:/fake/home" },
    env_vars: [],
    cwd: null
  }
}));
`, "utf8");
    const { getCodexMcpServerDefinition } = await import(
      "../../scripts/anticodex-real-mcp-smoke.mjs"
    );

    const definition = await getCodexMcpServerDefinition({
      codexCli: process.execPath,
      codexArgsPrefix: [fakeCli],
      codexHome: tempDir,
      serverName: "node_repl",
      timeoutMs: 5000,
    });

    assert.equal(definition.transport.command, "C:/fake/node_repl.exe");
    assert.deepEqual(definition.transport.args, ["--probe"]);
    assert.equal(definition.transport.env.CODEX_HOME, "C:/fake/home");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runRealMcpSmoke reports a real stdio tool call result", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "real-mcp-smoke-test-"));
  try {
    const fakeServer = createFakeMcpServer(tempDir);
    const { buildMcpProductEnvironment, runRealMcpSmoke } = await import("../../scripts/anticodex-real-mcp-smoke.mjs");
    const installRoot = join(tempDir, "install");
    const stateRoot = join(tempDir, "state");
    const codexHome = join(stateRoot, "codex-home");
    const productEnvironment = buildMcpProductEnvironment({
      installRoot,
      stateRoot,
      codexHome,
      baseEnvironment: { PATH: "C:\\base" },
    });

    const report = await runRealMcpSmoke({
      definition: {
        name: "node_repl",
        enabled: true,
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [fakeServer],
          env: { ANTICODEX_ENV_PRECEDENCE: "definition" },
          cwd: null,
        },
      },
      productEnvironment: {
        ...productEnvironment,
        ANTICODEX_ENV_PRECEDENCE: "product",
      },
      toolName: "echo",
      toolArguments: { envName: "ANTICODEX_ENV_PRECEDENCE" },
      expectedMarker: "definition",
      timeoutMs: 5000,
    });

    assert.equal(productEnvironment.Path.split(";")[0], join(codexHome, "plugins", ".plugin-appserver"));
    assert.equal(productEnvironment.CODEX_HOME, codexHome);
    assert.equal(productEnvironment.APPDATA, join(stateRoot, "windows-appdata"));
    assert.equal(report.ok, true);
    assert.equal(report.serverName, "node_repl");
    assert.equal(report.toolName, "echo");
    assert.equal(report.markerObserved, true);
    assert.equal(report.text, "definition");
    assert.equal(report.commandName, process.platform === "win32" ? "node.exe" : "node");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runRealMcpListSmoke reports stdio tools without invoking one", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "real-mcp-list-smoke-test-"));
  try {
    const fakeServer = createFakeMcpServer(tempDir);
    const { runRealMcpListSmoke } = await import("../../scripts/anticodex-real-mcp-smoke.mjs");

    const report = await runRealMcpListSmoke({
      definition: {
        name: "deepseek-code-worker",
        enabled: true,
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [fakeServer],
          env: {},
          cwd: null,
        },
      },
      timeoutMs: 5000,
    });

    assert.equal(report.ok, true);
    assert.equal(report.serverName, "deepseek-code-worker");
    assert.equal(report.toolCount, 1);
    assert.deepEqual(report.toolNames, ["echo"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
