#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";

const DEFAULT_CONFIG_PATH = "C:/Users/XD/.codex/config.toml";
const DEFAULT_WORKERS = [
  "mimo-claude-coworker",
  "mimocode-worker",
  "kilo-worker",
  "opencode-worker",
  "antigravity-code-worker",
  "deepseek-code-worker",
  "deveco-code-worker",
];

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function printHelp() {
  console.log([
    "Usage: node scripts/probe-anticodex-worker-mcp-servers.mjs [options]",
    "",
    "Options:",
    "  --workers a,b,c       Probe only the listed worker MCP servers.",
    "  --config PATH         Read worker MCP server config from PATH.",
    "  --report-root PATH    Write latest/history reports under PATH.",
    "  --no-write-report     Print JSON without writing signed reports.",
    "  --help, -h            Show this help message without starting workers.",
  ].join("\n"));
}

function parseTomlValue(raw) {
  const value = String(raw || "").trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return [...value.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
  }
  const quoted = value.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return quoted[2];
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function parseTomlTable(text, tableName) {
  const lines = text.split(/\r?\n/);
  const header = `[${tableName}]`;
  const table = {};
  let inside = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      if (inside) break;
      inside = line === header;
      continue;
    }
    if (!inside) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*([\s\S]+)$/);
    if (match) table[match[1]] = parseTomlValue(match[2]);
  }
  return table;
}

function readWorkerConfig(configPath, workerName) {
  const text = readFileSync(configPath, "utf8");
  const server = parseTomlTable(text, `mcp_servers.${workerName}`);
  const env = parseTomlTable(text, `mcp_servers.${workerName}.env`);
  return {
    name: workerName,
    command: typeof server.command === "string" ? server.command : "",
    url: typeof server.url === "string" ? server.url : "",
    httpHeaders: (() => {
      const match = text.match(new RegExp(`\\[mcp_servers\\.${workerName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\][\\s\\S]*?^http_headers\\s*=\\s*\\{\\s*Authorization\\s*=\\s*["']([^"']+)["']\\s*\\}`, "m"));
      return match?.[1] ? { Authorization: match[1] } : {};
    })(),
    args: Array.isArray(server.args) ? server.args : [],
    env,
    startupTimeoutMs: Number.isFinite(Number(server.startup_timeout_sec))
      ? Number(server.startup_timeout_sec) * 1000
      : 30000,
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  if (typeof timer?.unref === "function") timer.unref();
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let mcpSdkPromise;
async function loadMcpSdk() {
  if (!mcpSdkPromise) {
    mcpSdkPromise = Promise.all([
      import("file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"),
      import("file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js"),
      import("file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"),
    ]).then(([clientModule, stdioModule, httpModule]) => ({
      Client: clientModule.Client,
      StdioClientTransport: stdioModule.StdioClientTransport,
      StreamableHTTPClientTransport: httpModule.StreamableHTTPClientTransport,
    }));
  }
  return mcpSdkPromise;
}

async function probeWorker(config) {
  if (!config.command && !config.url) {
    return { name: config.name, ok: false, toolCount: 0, toolNames: [], error: "missing command" };
  }

  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await loadMcpSdk();
  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.httpHeaders } })
    : new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env },
    });
  const client = new Client({ name: "anticodex-worker-mcp-probe", version: "1.0.0" });

  try {
    await withTimeout(client.connect(transport), config.startupTimeoutMs, `${config.name} connect`);
    const listed = await withTimeout(client.listTools(), config.startupTimeoutMs, `${config.name} tools/list`);
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    const toolNames = tools.map((tool) => String(tool.name || "")).filter(Boolean);
    const taskTools = classifyTaskTools(toolNames);
    return {
      name: config.name,
      ok: true,
      toolCount: tools.length,
      toolNames,
      ...taskTools,
      error: "",
    };
  } catch (error) {
    return {
      name: config.name,
      ok: false,
      toolCount: 0,
      toolNames: [],
      error: error?.message || String(error),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // Closing a failed stdio transport is best-effort.
    }
  }
}

function classifyTaskTools(toolNames) {
  const startToolNames = toolNames.filter((name) => name.includes("_start_") || name.endsWith("_start_implementation"));
  const waitToolNames = toolNames.filter((name) => name.includes("_wait_") || name.endsWith("_wait_for_job"));
  const syncToolNames = toolNames.filter((name) => name.endsWith("_implement_in_workspace"));
  const cancelToolNames = toolNames.filter((name) => name.includes("_cancel_") || name.endsWith("_cancel_job"));
  return {
    startToolNames,
    waitToolNames,
    syncToolNames,
    cancelToolNames,
    hasStartTool: startToolNames.length > 0,
    hasWaitTool: waitToolNames.length > 0,
    hasSyncTool: syncToolNames.length > 0,
    hasCancelTool: cancelToolNames.length > 0,
  };
}

function writeReport(payload, reportRoot) {
  if (!reportRoot || hasArg("--no-write-report")) return null;
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-worker-mcp-server-probe.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-worker-mcp-server-probe.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function finish(payload, reportRoot) {
  const report = writeReport(payload, reportRoot);
  const output = report ? { ...payload, report } : payload;
  console.log(JSON.stringify(output));
  if (!payload.ok) process.exitCode = 1;
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    printHelp();
    process.exit(0);
    return;
  }

  const configPath = argValue("--config", DEFAULT_CONFIG_PATH);
  const reportRoot = resolve(argValue("--report-root", `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`));
  const workerArg = argValue("--workers", "");
  const workers = workerArg
    ? workerArg.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_WORKERS;

  const servers = [];
  for (const worker of workers) {
    servers.push(await probeWorker(readWorkerConfig(configPath, worker)));
  }

  const payload = {
    reportName: "worker-mcp-server-probe",
    ok: servers.length > 0 && servers.every((server) => server.ok),
    requestedRealTraffic: false,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "worker-mcp-server-probe-list-tools-only",
    codexSessionTransportStatus: "not-tested-by-direct-probe",
    directProbeInterpretation: "local-worker-server-config-and-tools-list-healthy-if-ok; current Codex session MCP transport may still need reload",
    operatorRecoveryAction: "reload Codex MCP/session or open a fresh channel, then run one read-only worker get_job/tools-list check before dispatching real work",
    postReloadVerification: "read-only worker status/list check first; do not start implementation work until the channel transport returns a normal response",
    checkedAt: new Date().toISOString(),
    configPath,
    requiredWorkers: workers,
    passedServerCount: servers.filter((server) => server.ok).length,
    missingServers: workers.filter((worker) => !servers.some((server) => server.name === worker && server.ok)),
    incompleteToolCountServers: servers.filter((server) => Number(server.toolCount || 0) < 1).map((server) => server.name),
    missingStartToolServers: servers.filter((server) => server.ok && server.hasStartTool !== true).map((server) => server.name),
    missingWaitToolServers: servers.filter((server) => server.ok && server.hasWaitTool !== true).map((server) => server.name),
    servers,
  };
  finish(payload, reportRoot);
}

main().catch((error) => {
  const reportRoot = resolve(argValue("--report-root", `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`));
  finish({
    reportName: "worker-mcp-server-probe",
    ok: false,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "worker-mcp-server-probe-list-tools-only",
    codexSessionTransportStatus: "not-tested-by-direct-probe",
    directProbeInterpretation: "probe failed before proving local worker server health; inspect error and config before blaming Codex session transport",
    operatorRecoveryAction: "fix direct worker MCP probe failure first; reload Codex MCP/session only after local server probe is healthy",
    postReloadVerification: "read-only worker status/list check first; do not start implementation work until the channel transport returns a normal response",
    checkedAt: new Date().toISOString(),
    configPath: argValue("--config", DEFAULT_CONFIG_PATH),
    requiredWorkers: [],
    passedServerCount: 0,
    missingServers: [],
    incompleteToolCountServers: [],
    missingStartToolServers: [],
    missingWaitToolServers: [],
    servers: [],
    error: error?.message || String(error),
  }, reportRoot);
});
