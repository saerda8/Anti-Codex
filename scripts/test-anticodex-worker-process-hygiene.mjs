#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const value = process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[++index] : "1";
  args.set(key, value);
}

if (args.has("--help") || args.has("-h")) {
  console.log([
    "Usage: node scripts/test-anticodex-worker-process-hygiene.mjs [--report-root PATH] [--compact]",
    "",
    "Reads local Windows process state only. It does not start workers, stop workers, or use model traffic.",
  ].join("\n"));
  process.exit(0);
}

const reportRoot = resolve(args.get("--report-root") || `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`);
const compact = args.has("--compact");
const workerServerPatterns = [
  ["mimo-claude-coworker", "mimo-claude-code-worker-mcp-main/src/mimo-worker-mcp.mjs"],
  ["mimocode-worker", "mimocode-worker-mcp-main/src/mimocode-worker-mcp.mjs"],
  ["kilo-worker", "kilo-worker-mcp-main/src/kilo-worker-mcp.mjs"],
  ["opencode-worker", "opencode-worker-mcp-main/src/opencode-worker-mcp.mjs"],
  ["antigravity-code-worker", "antigravity-code-worker-mcp/src/server.mjs"],
  ["deepseek-code-worker", "deepseek-claude-code-worker-mcp-main/src/deepseek-worker-mcp.mjs"],
  ["deveco-code-worker", "deveco-code-worker-mcp-main/src/deveco-code-worker-mcp.mjs"],
  ["codebuddy-worker", "codebuddy-worker-mcp-main/src/deepseek-worker-mcp.mjs"],
  ["agnes-worker", "agnes-worker-mcp-main/src/agnes-worker-mcp.mjs"],
];

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function writeSignedReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-worker-process-hygiene.json");
  const history = resolve(reportRoot, `${utcStamp()}-worker-process-hygiene.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function normalizePathText(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function identifyWorkerServer(commandLine) {
  const text = normalizePathText(commandLine);
  const matches = workerServerPatterns.filter(([, pattern]) => text.includes(pattern.toLowerCase()));
  if (matches.length === 1) return matches[0][0];
  if (matches.length > 1) {
    if (text.includes("codebuddy-worker-mcp-main")) return "codebuddy-worker";
    if (text.includes("deepseek-claude-code-worker-mcp-main")) return "deepseek-code-worker";
  }
  return "";
}

function identifyAppServer(commandLine) {
  const text = normalizePathText(commandLine);
  if (!text.includes("codex.exe") || !text.includes(" app-server")) return "";
  if (text.includes("anti-codex/codex-patched-app")) return "anticodex-app-server";
  if (text.includes("openaicodex") || text.includes("openai.codex")) return "codex-app-server";
  return "codex-like-app-server";
}

function runProcessSnapshot() {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$items = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine",
    "$items | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function summarize() {
  const processes = runProcessSnapshot();
  const appServers = processes
    .map((item) => ({
      pid: Number(item.ProcessId || 0),
      parentPid: Number(item.ParentProcessId || 0),
      name: String(item.Name || ""),
      kind: identifyAppServer(item.CommandLine),
      commandLine: String(item.CommandLine || ""),
    }))
    .filter((item) => item.kind);
  const appServerByPid = new Map(appServers.map((item) => [item.pid, item]));
  const workerProcesses = processes
    .map((item) => {
      const serverName = identifyWorkerServer(item.CommandLine);
      return {
        pid: Number(item.ProcessId || 0),
        parentPid: Number(item.ParentProcessId || 0),
        parentKind: appServerByPid.get(Number(item.ParentProcessId || 0))?.kind || "",
        name: String(item.Name || ""),
        serverName,
        commandLine: String(item.CommandLine || ""),
      };
    })
    .filter((item) => item.serverName);

  const parentGroups = [];
  for (const appServer of appServers) {
    const children = workerProcesses.filter((item) => item.parentPid === appServer.pid);
    const byServer = new Map();
    for (const child of children) {
      if (!byServer.has(child.serverName)) byServer.set(child.serverName, []);
      byServer.get(child.serverName).push(child.pid);
    }
    const duplicateServers = [...byServer.entries()]
      .filter(([, pids]) => pids.length > 1)
      .map(([serverName, pids]) => ({ serverName, count: pids.length, pids }));
    parentGroups.push({
      parentPid: appServer.pid,
      parentKind: appServer.kind,
      workerProcessCount: children.length,
      distinctWorkerServerCount: byServer.size,
      duplicateServers,
      duplicateWorkerProcessCount: duplicateServers.reduce((sum, item) => sum + Math.max(0, item.count - 1), 0),
    });
  }

  const codexGroups = parentGroups.filter((item) => item.parentKind === "codex-app-server");
  const anticodexGroups = parentGroups.filter((item) => item.parentKind === "anticodex-app-server");
  const duplicateWorkerProcessCount = parentGroups.reduce((sum, item) => sum + item.duplicateWorkerProcessCount, 0);
  const codexWorkerProcessCount = codexGroups.reduce((sum, item) => sum + item.workerProcessCount, 0);
  const anticodexWorkerProcessCount = anticodexGroups.reduce((sum, item) => sum + item.workerProcessCount, 0);

  return {
    appServers,
    parentGroups,
    workerProcesses,
    workerProcessCount: workerProcesses.length,
    codexWorkerProcessCount,
    anticodexWorkerProcessCount,
    duplicateWorkerProcessCount,
    duplicateWorkerServers: parentGroups.flatMap((group) =>
      group.duplicateServers.map((item) => ({ ...item, parentPid: group.parentPid, parentKind: group.parentKind }))
    ),
  };
}

let snapshot;
let snapshotError = "";
try {
  snapshot = summarize();
} catch (error) {
  snapshotError = error?.stack || error?.message || String(error);
  snapshot = {
    appServers: [],
    parentGroups: [],
    workerProcesses: [],
    workerProcessCount: 0,
    codexWorkerProcessCount: 0,
    anticodexWorkerProcessCount: 0,
    duplicateWorkerProcessCount: 0,
    duplicateWorkerServers: [],
  };
}

const processQueryOk = !snapshotError;
const payload = {
  reportName: "worker-process-hygiene",
  ok: true,
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: processQueryOk,
  coverageKind: "worker-process-hygiene-no-traffic",
  checkedAt: new Date().toISOString(),
  processQueryOk,
  processQueryError: snapshotError,
  workerProcessHygieneOk: processQueryOk && snapshot.duplicateWorkerProcessCount === 0,
  duplicateWorkerProcessCount: snapshot.duplicateWorkerProcessCount,
  workerProcessCount: snapshot.workerProcessCount,
  codexWorkerProcessCount: snapshot.codexWorkerProcessCount,
  anticodexWorkerProcessCount: snapshot.anticodexWorkerProcessCount,
  appServerCount: snapshot.appServers.length,
  appServers: snapshot.appServers.map((item) => ({
    pid: item.pid,
    parentPid: item.parentPid,
    kind: item.kind,
  })),
  parentGroups: snapshot.parentGroups,
  duplicateWorkerServers: snapshot.duplicateWorkerServers,
  interpretation: processQueryOk
    ? snapshot.duplicateWorkerProcessCount > 0
      ? "duplicate worker MCP child processes are present; this can indicate stale app-server tool handles or repeated MCP startup attempts"
      : "no duplicate worker MCP child processes were observed under Codex app-server parents"
    : "worker process hygiene could not inspect local process state",
  operatorAction: snapshot.duplicateWorkerProcessCount > 0
    ? "close Codex completely, run backup-first thread maintenance, then restart Codex; opening another channel can start another worker set"
    : "process hygiene does not explain current worker transport state; rely on current-channel read-only worker probes",
};
const report = writeSignedReport(payload);
const output = { ...payload, report };
if (compact) {
  console.log(JSON.stringify({
    ok: output.ok,
    processQueryOk: output.processQueryOk,
    workerProcessHygieneOk: output.workerProcessHygieneOk,
    workerProcessCount: output.workerProcessCount,
    duplicateWorkerProcessCount: output.duplicateWorkerProcessCount,
    codexWorkerProcessCount: output.codexWorkerProcessCount,
    anticodexWorkerProcessCount: output.anticodexWorkerProcessCount,
    duplicateWorkerServers: output.duplicateWorkerServers,
    report: output.report,
  }));
} else {
  console.log(JSON.stringify(output));
}
