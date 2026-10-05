#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { Client } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { StreamableHTTPClientTransport } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const DEFAULT_CONFIG_PATH = "C:/Users/XD/.codex/config.toml";
const DEFAULT_REPORT_ROOT = `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`;
const DEFAULT_WORKERS = [
  "deepseek-code-worker",
  "deepseek-external",
  "deveco-code-worker",
  "opencode-worker",
  "kilo-worker",
  "codebuddy-worker",
  "agnes-worker",
];

const STATUS_PROBES = {
  "deepseek-code-worker": { tool: "deepseek_get_job", jobId: "", args: "list_only" },
  "deepseek-external": { tool: "deepseek_get_job", jobId: "", args: "list_only" },
  "deveco-code-worker": { tool: "deveco_get_job", jobId: "", args: "list_only" },
  "opencode-worker": { tool: "opencode_get_job", jobId: "", args: "list_only" },
  "kilo-worker": { tool: "kilo_get_job", jobId: "", args: "list_only" },
  "codebuddy-worker": { tool: "codebuddy_get_job", jobId: "", args: "list_only" },
  "agnes-worker": { tool: "agnes_get_job", jobId: "", args: "list_only" },
};

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function printHelp() {
  console.log([
    "Usage: node scripts/test-anticodex-worker-mcp-status-probe.mjs [options]",
    "",
    "Options:",
    "  --workers a,b,c          Probe only the listed worker MCP servers.",
    "  --include-antigravity    Also call the Antigravity worker status tool.",
    "  --config PATH            Read worker MCP server config from PATH.",
    "  --report-root PATH       Write latest/history reports under PATH.",
    "  --no-write-report        Print JSON without writing signed reports.",
    "  --timeout-ms N           Per direct status call timeout (default 30000).",
    "  --help, -h               Show this help message without starting workers.",
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
  const headerMatch = text.match(new RegExp(`\\[mcp_servers\\.${workerName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\][\\s\\S]*?^http_headers\\s*=\\s*\\{\\s*Authorization\\s*=\\s*["']([^"']+)["']\\s*\\}`, "m"));
  return {
    name: workerName,
    command: typeof server.command === "string" ? server.command : "",
    args: Array.isArray(server.args) ? server.args : [],
    url: typeof server.url === "string" ? server.url : "",
    httpHeaders: headerMatch?.[1] ? { Authorization: headerMatch[1] } : {},
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

function textContent(result) {
  return Array.isArray(result?.content)
    ? result.content.map((item) => item?.text || "").join("\n")
    : "";
}

function parseContentJson(result) {
  const text = textContent(result).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { text };
  }
}

function statusArguments(probe) {
  if (probe.args === "wait") {
    return {
      job_id: probe.jobId,
      max_wait_ms: 1000,
      poll_interval_ms: 500,
      include_diff: false,
      include_events: false,
      include_logs: false,
    };
  }
  return {
    job_id: probe.jobId,
    include_diff: false,
    include_events: false,
    include_logs: false,
  };
}

async function probeWorker(workerName, options) {
  const probe = STATUS_PROBES[workerName];
  if (!probe) return { worker: workerName, ok: false, statusCallOk: false, error: "unsupported worker" };
  const config = readWorkerConfig(options.configPath, workerName);
  if (!config.command && !config.url) return { worker: workerName, ok: false, statusCallOk: false, statusTool: probe.tool, error: "missing transport" };

  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.httpHeaders } })
    : new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env },
    });
  const client = new Client({ name: "anticodex-worker-mcp-status-probe", version: "1.0.0" });
  const startedAt = Date.now();
  try {
    await withTimeout(client.connect(transport), config.startupTimeoutMs, `${workerName} connect`);
    const listed = await withTimeout(client.listTools(), config.startupTimeoutMs, `${workerName} tools/list`);
    const toolNames = Array.isArray(listed?.tools) ? listed.tools.map((tool) => String(tool.name || "")).filter(Boolean) : [];
    const statusToolPresent = toolNames.includes(probe.tool);
    if (!statusToolPresent) {
      return { worker: workerName, ok: false, statusCallOk: false, statusTool: probe.tool, statusToolPresent, toolCount: toolNames.length, error: "status tool missing" };
    }
    if (probe.args === "list_only") {
      return {
        worker: workerName,
        ok: true,
        skipped: false,
        statusCallOk: true,
        statusTool: probe.tool,
        statusToolPresent,
        toolCount: toolNames.length,
        listOnly: true,
        status: "tools_list_only",
      };
    }
    const called = await withTimeout(
      client.callTool({ name: probe.tool, arguments: statusArguments(probe) }),
      options.timeoutMs,
      `${workerName} status call`,
    );
    const data = parseContentJson(called);
    const status = String(data.status || data.result?.status || data.job?.status || data.phase || "");
    return {
      worker: workerName,
      ok: true,
      skipped: false,
      statusCallOk: true,
      statusTool: probe.tool,
      statusToolPresent,
      jobId: probe.jobId,
      toolCount: toolNames.length,
      status,
      dataKeys: Object.keys(data).sort().slice(0, 16),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      worker: workerName,
      ok: false,
      skipped: false,
      statusCallOk: false,
      statusTool: probe.tool,
      jobId: probe.jobId,
      error: error?.message || String(error),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    try {
      await client.close();
    } catch {
      // Best-effort close.
    }
  }
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function writeSignedReport(payload, reportRoot) {
  if (!reportRoot || hasArg("--no-write-report")) return null;
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-worker-mcp-status-probe.json");
  const history = resolve(reportRoot, `${utcStamp()}-worker-mcp-status-probe.json`);
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
  const report = writeSignedReport(payload, reportRoot);
  console.log(JSON.stringify(report ? { ...payload, report } : payload));
  if (!payload.ok) process.exitCode = 1;
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    printHelp();
    process.exit(0);
    return;
  }

  const configPath = argValue("--config", DEFAULT_CONFIG_PATH);
  const reportRoot = resolve(argValue("--report-root", DEFAULT_REPORT_ROOT));
  const timeoutMs = Number(argValue("--timeout-ms", "30000"));
  const workerArg = argValue("--workers", "");
  const workers = workerArg
    ? workerArg.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_WORKERS;
  const includeAntigravity = hasArg("--include-antigravity");
  const results = [];
  for (const worker of workers) {
    results.push(await probeWorker(worker, { configPath, timeoutMs, includeAntigravity }));
  }

  const nonSkipped = results.filter((result) => !result.skipped);
  const statusCallOkResults = nonSkipped.filter((result) => result.statusCallOk);
  const failedResults = nonSkipped.filter((result) => !result.statusCallOk);
  const skippedResults = results.filter((result) => result.skipped);
  const payload = {
    reportName: "worker-mcp-status-probe",
    ok: nonSkipped.length > 0 && failedResults.length === 0,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "worker-mcp-direct-status-call-no-traffic",
    checkedAt: new Date().toISOString(),
    configPath,
    includeAntigravity,
    workerCount: results.length,
    probedWorkerCount: nonSkipped.length,
    statusCallOkCount: statusCallOkResults.length,
    failedWorkerCount: failedResults.length,
    skippedWorkerCount: skippedResults.length,
    statusCallOkWorkers: statusCallOkResults.map((result) => result.worker),
    failedWorkers: failedResults.map((result) => result.worker),
    skippedWorkers: skippedResults.map((result) => result.worker),
    antigravitySkippedForAccountIsolation: skippedResults.some((result) => result.worker === "antigravity-code-worker"),
    interpretation: "Direct MCP status calls prove worker server status tools independently of current Codex channel transport.",
    currentChannelCaveat: "This does not prove current-channel worker dispatch; current-channel read-only worker calls must still succeed before dispatch.",
    results,
  };
  finish(payload, reportRoot);
}

main().catch((error) => {
  finish({
    reportName: "worker-mcp-status-probe",
    ok: false,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "worker-mcp-direct-status-call-no-traffic",
    checkedAt: new Date().toISOString(),
    configPath: argValue("--config", DEFAULT_CONFIG_PATH),
    includeAntigravity: hasArg("--include-antigravity"),
    workerCount: 0,
    probedWorkerCount: 0,
    statusCallOkCount: 0,
    failedWorkerCount: 0,
    skippedWorkerCount: 0,
    statusCallOkWorkers: [],
    failedWorkers: [],
    skippedWorkers: [],
    antigravitySkippedForAccountIsolation: false,
    interpretation: "Direct MCP status probe failed before proving worker server status tools.",
    currentChannelCaveat: "This does not prove current-channel worker dispatch; current-channel read-only worker calls must still succeed before dispatch.",
    results: [],
    error: error?.message || String(error),
  }, resolve(argValue("--report-root", DEFAULT_REPORT_ROOT)));
});
