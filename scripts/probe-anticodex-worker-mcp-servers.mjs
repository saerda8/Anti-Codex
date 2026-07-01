#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Client } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const DEFAULT_CONFIG_PATH = "C:/Users/XD/.codex/config.toml";
const DEFAULT_WORKERS = [
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

async function probeWorker(config) {
  if (!config.command) {
    return { name: config.name, ok: false, toolCount: 0, toolNames: [], error: "missing command" };
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
  });
  const client = new Client({ name: "anticodex-worker-mcp-probe", version: "1.0.0" });

  try {
    await withTimeout(client.connect(transport), config.startupTimeoutMs, `${config.name} connect`);
    const listed = await withTimeout(client.listTools(), config.startupTimeoutMs, `${config.name} tools/list`);
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return {
      name: config.name,
      ok: true,
      toolCount: tools.length,
      toolNames: tools.map((tool) => String(tool.name || "")).filter(Boolean),
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

async function main() {
  const configPath = argValue("--config", DEFAULT_CONFIG_PATH);
  const workerArg = argValue("--workers", "");
  const workers = workerArg
    ? workerArg.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_WORKERS;

  const servers = [];
  for (const worker of workers) {
    servers.push(await probeWorker(readWorkerConfig(configPath, worker)));
  }

  const payload = {
    ok: servers.length > 0 && servers.every((server) => server.ok),
    checkedAt: new Date().toISOString(),
    configPath,
    servers,
  };
  console.log(JSON.stringify(payload));
  if (!payload.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    configPath: argValue("--config", DEFAULT_CONFIG_PATH),
    servers: [],
    error: error?.message || String(error),
  }));
  process.exitCode = 1;
});
