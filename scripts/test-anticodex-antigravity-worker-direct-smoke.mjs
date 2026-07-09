#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { Client } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const DEFAULT_CONFIG_PATH = "C:/Users/XD/.codex/config.toml";
const DEFAULT_REPORT_ROOT = `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`;
const WORKER = "antigravity-code-worker";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function parseTomlValue(raw) {
  const value = String(raw || "").trim();
  if (value.startsWith("[") && value.endsWith("]")) return [...value.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
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

function readWorkerConfig(configPath) {
  const text = readFileSync(configPath, "utf8");
  const server = parseTomlTable(text, `mcp_servers.${WORKER}`);
  const env = parseTomlTable(text, `mcp_servers.${WORKER}.env`);
  return {
    command: typeof server.command === "string" ? server.command : "",
    args: Array.isArray(server.args) ? server.args : [],
    env,
    startupTimeoutMs: Number.isFinite(Number(server.startup_timeout_sec)) ? Number(server.startup_timeout_sec) * 1000 : 60000,
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
  return Array.isArray(result?.content) ? result.content.map((item) => item?.text || "").join("\n") : "";
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

function extractJobId(result) {
  const data = parseContentJson(result);
  return data.job_id || data.jobId || data.id || data.job?.id || "";
}

function isTerminalStatus(status) {
  return ["completed", "succeeded", "success", "failed", "error", "cancelled", "canceled", "timeout"].includes(String(status || "").toLowerCase());
}

function isSuccessStatus(status) {
  return ["completed", "succeeded", "success"].includes(String(status || "").toLowerCase());
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function writeReport(payload, reportRoot) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-antigravity-worker-direct-smoke.json");
  const history = resolve(reportRoot, `${utcStamp()}-antigravity-worker-direct-smoke.json`);
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
  const output = { ...payload, report };
  console.log(JSON.stringify(output));
  if (!payload.ok) process.exitCode = 1;
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log("Usage: node scripts/test-anticodex-antigravity-worker-direct-smoke.mjs [--allow-real-traffic] [--model flash|flash_lite|pro] [--timeout-ms N]");
    return;
  }

  const startedAt = Date.now();
  const reportRoot = resolve(argValue("--report-root", DEFAULT_REPORT_ROOT));
  const timeoutMs = Number(argValue("--timeout-ms", "180000"));
  const model = argValue("--model", "flash");
  const requestedRealTraffic = hasArg("--allow-real-traffic") || hasArg("--AllowRealTraffic");
  const stamp = `ag_direct_${Date.now()}`;
  const marker = `ANTIGRAVITY_DIRECT_WORKER_MARKER_${stamp}`;
  const workspace = resolve(argValue("--workspace-root", `${reportRoot}/antigravity-worker-direct/${stamp}`));

  if (!requestedRealTraffic) {
    finish({
      ok: true,
      reportName: "antigravity-worker-direct-smoke",
      skipped: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: false,
      coverageKind: "skipped-no-real-traffic",
      reason: "Antigravity direct worker smoke is opt-in; rerun with --allow-real-traffic.",
      marker,
      elapsedMs: Date.now() - startedAt,
    }, reportRoot);
    return;
  }

  const config = readWorkerConfig(argValue("--config", DEFAULT_CONFIG_PATH));
  if (!config.command) throw new Error(`Missing command for ${WORKER}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, "README.md"), "Anti-Codex Antigravity direct worker smoke workspace.\n", "utf8");

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
  });
  const client = new Client({ name: "anticodex-antigravity-worker-direct-smoke", version: "1.0.0" });
  let jobId = "";
  let terminal = null;
  const snapshots = [];
  try {
    await withTimeout(client.connect(transport, { timeout: config.startupTimeoutMs }), config.startupTimeoutMs, "Antigravity direct worker connect");
    const tools = await withTimeout(client.listTools(), config.startupTimeoutMs, "Antigravity direct worker tools/list");
    const toolNames = Array.isArray(tools?.tools) ? tools.tools.map((tool) => String(tool.name || "")) : [];
    for (const requiredTool of ["antigravity_start_implementation", "antigravity_get_job"]) {
      if (!toolNames.includes(requiredTool)) throw new Error(`Missing Antigravity tool: ${requiredTool}`);
    }

    const task = [
      "Work only in the current workspace directory.",
      "Create exactly one new file named antigravity-worker-proof.txt.",
      `The file must contain exactly this marker and nothing else: ${marker}`,
      "Do not edit README.md. Do not create any other files.",
      "After writing the file, finish with a short status message mentioning the marker.",
    ].join(" ");
    const started = await withTimeout(
      client.callTool({
        name: "antigravity_start_implementation",
        arguments: { cwd: workspace, task, model, timeout_ms: timeoutMs },
      }, undefined, { timeout: Math.max(config.startupTimeoutMs, 120000) }),
      Math.max(config.startupTimeoutMs, 120000),
      "Antigravity direct worker start",
    );
    jobId = extractJobId(started);
    if (!jobId) throw new Error("Antigravity direct worker start did not return a job id");

    const deadline = Date.now() + timeoutMs + 30000;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
      const got = await withTimeout(
        client.callTool({
          name: "antigravity_get_job",
          arguments: { job_id: jobId, include_logs: false },
        }, undefined, { timeout: 30000 }),
        30000,
        "Antigravity direct worker get_job",
      );
      const data = parseContentJson(got);
      const status = String(data.status || data.result?.status || "").toLowerCase();
      snapshots.push({ status: status || "unknown", exitCode: data.exit_code ?? data.result?.exit_code ?? null });
      if (isTerminalStatus(status)) {
        terminal = data;
        break;
      }
    }
  } catch (error) {
    terminal = { status: "error", error: error?.message || String(error) };
  } finally {
    try {
      await client.close();
    } catch {}
  }

  const proofPath = resolve(workspace, "antigravity-worker-proof.txt");
  const proofExists = existsSync(proofPath);
  const proofText = proofExists ? readFileSync(proofPath, "utf8").trim() : "";
  const terminalStatus = String(terminal?.status || terminal?.result?.status || "").toLowerCase();
  const workspaceOk = proofExists && proofText === marker;
  const ok = workspaceOk && (isSuccessStatus(terminalStatus) || snapshots.some((item) => isSuccessStatus(item.status)) || terminalStatus === "unknown");

  finish({
    ok,
    reportName: "antigravity-worker-direct-smoke",
    requestedRealTraffic: true,
    usedRealTraffic: true,
    behaviorCovered: true,
    coverageKind: "direct-antigravity-worker-same-account-real-traffic",
    accountLaneRole: "same-account-antigravity-worker-proof",
    separateAccountVerified: false,
    countsAsSecondAccountProof: false,
    model,
    marker,
    jobId,
    workspace,
    elapsedMs: Date.now() - startedAt,
    terminalStatus: terminalStatus || "unknown",
    terminalError: terminal?.error || "",
    snapshots,
    artifact: {
      proofPath,
      proofExists,
      proofTextMatches: proofText === marker,
    },
  }, reportRoot);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
