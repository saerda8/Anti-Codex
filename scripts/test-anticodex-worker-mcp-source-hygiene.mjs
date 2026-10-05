#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { dirname, resolve } from "node:path";

const DEFAULT_CONFIG_PATH = "C:/Users/XD/.codex/config.toml";
const DEFAULT_WORKERS = [
  "deepseek-code-worker",
  "deepseek-external",
  "deveco-code-worker",
  "opencode-worker",
  "kilo-worker",
  "codebuddy-worker",
  "agnes-worker",
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
    "Usage: node scripts/test-anticodex-worker-mcp-source-hygiene.mjs [options]",
    "",
    "Options:",
    "  --workers a,b,c       Check only listed worker MCP servers.",
    "  --config PATH         Read worker MCP server config from PATH.",
    "  --report-root PATH    Write latest/history reports under PATH.",
    "  --no-write-report     Print JSON without writing signed reports.",
    "  --help, -h            Show help.",
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
  if (!server.command && server.url) {
    const runtimePath = resolve(dirname(configPath), "..", "shared-mcp", "servers.json");
    try {
      const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
      const source = runtime?.mcpServers?.[workerName];
      if (source?.command) {
        const args = Array.isArray(source.args) ? source.args : [];
        return { name: workerName, command: source.command, args, entrypoint: args.find((item) => typeof item === "string" && /\.(mjs|js|cjs)$/i.test(item)) || "" };
      }
    } catch {}
  }
  const args = Array.isArray(server.args) ? server.args : [];
  const entrypoint = args.find((item) => typeof item === "string" && /\.(mjs|js|cjs)$/i.test(item)) || "";
  return {
    name: workerName,
    command: typeof server.command === "string" ? server.command : "",
    args,
    entrypoint,
  };
}

function checkWorkerSource(config) {
  const entrypointPath = config.entrypoint ? resolve(config.entrypoint) : "";
  const exists = !!entrypointPath && existsSync(entrypointPath);
  const bytes = exists ? readFileSync(entrypointPath) : Buffer.alloc(0);
  const nulIndex = exists ? bytes.indexOf(0) : -1;
  const nulCount = exists ? bytes.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0) : 0;
  let syntaxExitCode = null;
  let syntaxOk = false;
  let syntaxError = "";
  if (exists && /\.(mjs|js|cjs)$/i.test(entrypointPath)) {
    const result = spawnSync("node", ["--check", entrypointPath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    syntaxExitCode = result.status;
    syntaxOk = result.status === 0;
    syntaxError = String(result.stderr || result.error?.message || "").trim().slice(0, 500);
  }
  return {
    name: config.name,
    commandPresent: !!config.command,
    entrypoint: entrypointPath,
    entrypointPresent: exists,
    entrypointIsJavaScript: /\.(mjs|js|cjs)$/i.test(entrypointPath),
    hasNulBytes: nulCount > 0,
    nulCount,
    nulIndex,
    syntaxOk,
    syntaxExitCode,
    syntaxError,
    ok: !!config.command && exists && nulCount === 0 && syntaxOk,
  };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function writeReport(payload, reportRoot) {
  if (!reportRoot || hasArg("--no-write-report")) return null;
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-worker-mcp-source-hygiene.json");
  const history = resolve(reportRoot, `${stamp()}-worker-mcp-source-hygiene.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function main() {
  if (hasArg("--help") || hasArg("-h")) {
    printHelp();
    return;
  }

  const startedAt = Date.now();
  const configPath = resolve(argValue("--config", DEFAULT_CONFIG_PATH));
  const reportRoot = resolve(argValue("--report-root", `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`));
  const workerArg = argValue("--workers", "");
  const workers = workerArg ? workerArg.split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_WORKERS;
  const configPresent = existsSync(configPath);
  const results = configPresent ? workers.map((worker) => checkWorkerSource(readWorkerConfig(configPath, worker))) : [];
  const failedWorkers = results.filter((item) => !item.ok).map((item) => item.name);
  const nulByteWorkers = results.filter((item) => item.hasNulBytes).map((item) => item.name);
  const missingEntrypointWorkers = results.filter((item) => !item.entrypointPresent).map((item) => item.name);
  const syntaxFailedWorkers = results.filter((item) => item.entrypointPresent && !item.syntaxOk).map((item) => item.name);
  const payload = {
    reportName: "worker-mcp-source-hygiene",
    ok: configPresent && results.length === workers.length && failedWorkers.length === 0,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "worker-mcp-source-hygiene-no-traffic",
    checkedAt: new Date().toISOString(),
    configPath,
    configPresent,
    requiredWorkers: workers,
    workerCount: results.length,
    passedWorkerCount: results.filter((item) => item.ok).length,
    failedWorkers,
    nulByteWorkers,
    missingEntrypointWorkers,
    syntaxFailedWorkers,
    results,
    elapsedMs: Date.now() - startedAt,
  };
  const report = writeReport(payload, reportRoot);
  console.log(JSON.stringify(report ? { ...payload, report } : payload));
  if (!payload.ok) process.exitCode = 1;
}

main();
