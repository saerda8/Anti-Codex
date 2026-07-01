#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { Client } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

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
    checkedAt: new Date().toISOString(),
    configPath,
    requiredWorkers: workers,
    passedServerCount: servers.filter((server) => server.ok).length,
    missingServers: workers.filter((worker) => !servers.some((server) => server.name === worker && server.ok)),
    incompleteToolCountServers: servers.filter((server) => Number(server.toolCount || 0) < 1).map((server) => server.name),
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
    checkedAt: new Date().toISOString(),
    configPath: argValue("--config", DEFAULT_CONFIG_PATH),
    requiredWorkers: [],
    passedServerCount: 0,
    missingServers: [],
    incompleteToolCountServers: [],
    servers: [],
    error: error?.message || String(error),
  }, reportRoot);
});
