#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    "Usage: node scripts/test-anticodex-codex-appserver-freshness.mjs [--report-root PATH] [--compact] [--stale-age-minutes N]",
    "",
    "Reads local Windows process state and existing current-channel worker reports only.",
    "It does not start workers, stop processes, or use model traffic.",
  ].join("\n"));
  process.exit(0);
}

const reportRoot = resolve(args.get("--report-root") || `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`);
const compact = args.has("--compact");
const staleAgeMinutes = Math.max(1, Number(args.get("--stale-age-minutes") || 30) || 30);
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
  const latest = resolve(reportRoot, "latest-codex-appserver-freshness.json");
  const history = resolve(reportRoot, `${utcStamp()}-codex-appserver-freshness.json`);
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

function identifyCodexProcess(item) {
  const name = String(item.Name || "").toLowerCase();
  const text = normalizePathText(item.CommandLine);
  if (name === "codex.exe" && text.includes(" app-server") && text.includes("openai.codex") && !text.includes("--listen stdio://")) {
    return "codex-desktop-app-server";
  }
  if (name === "codex.exe" && text.includes(" app-server") && text.includes("--listen stdio://")) {
    return "codex-stdio-app-server";
  }
  if (name === "codex.exe" && text.includes("anti-codex/codex-patched-app") && text.includes(" app-server")) {
    return "anticodex-app-server";
  }
  if (name === "codex.exe" && text.includes(" app-server")) {
    return "codex-like-app-server";
  }
  if (name === "codex.exe" || name === "codex.exe".toLowerCase()) {
    return "codex-main";
  }
  return "";
}

function runProcessSnapshot() {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$items = Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; Name=$_.Name; CommandLine=$_.CommandLine; CreationDateUtc=if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' } } }",
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

function readJsonReport(fileName) {
  const file = resolve(reportRoot, fileName);
  if (!existsSync(file)) return { present: false, path: file };
  try {
    return { present: true, path: file, parseable: true, report: JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { present: true, path: file, parseable: false, error: error?.message || String(error) };
  }
}

function ageSeconds(creationDateUtc, nowMs) {
  const parsed = Date.parse(creationDateUtc || "");
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

function summarize() {
  const now = new Date();
  const nowMs = now.getTime();
  const processes = runProcessSnapshot();
  const codexProcesses = processes
    .map((item) => {
      const kind = identifyCodexProcess(item);
      if (!kind) return null;
      return {
        pid: Number(item.ProcessId || 0),
        parentPid: Number(item.ParentProcessId || 0),
        name: String(item.Name || ""),
        kind,
        creationDateUtc: String(item.CreationDateUtc || ""),
        ageSeconds: ageSeconds(item.CreationDateUtc, nowMs),
      };
    })
    .filter(Boolean);
  const workerProcesses = processes
    .map((item) => {
      const serverName = identifyWorkerServer(item.CommandLine);
      if (!serverName) return null;
      return {
        pid: Number(item.ProcessId || 0),
        parentPid: Number(item.ParentProcessId || 0),
        serverName,
      };
    })
    .filter(Boolean);
  const desktopAppServers = codexProcesses
    .filter((item) => item.kind === "codex-desktop-app-server")
    .sort((a, b) => String(a.creationDateUtc).localeCompare(String(b.creationDateUtc)));
  const activeDesktopAppServer = desktopAppServers.at(-1) || null;
  const activeDesktopWorkerProcesses = activeDesktopAppServer
    ? workerProcesses.filter((item) => item.parentPid === activeDesktopAppServer.pid)
    : [];
  const transportReport = readJsonReport("latest-current-channel-worker-transport.json");
  const recoveryReport = readJsonReport("latest-current-channel-worker-recovery.json");
  const transport = transportReport.report || {};
  const recovery = recoveryReport.report || {};
  const currentChannelWorkerDispatchUsable = transport.currentChannelWorkerDispatchUsable === true
    || recovery.canDispatchCurrentChannelWorkers === true;
  const genericMcpControlOk = transport.genericMcpControlOk === true || recovery.genericMcpControlOk === true;
  const repeatedCurrentChannelWorkerFailure = recovery.repeatedFailureAudit?.repeatedCurrentChannelWorkerFailure === true
    || recovery.repeatedCurrentChannelWorkerFailure === true
    || transport.currentChannelWorkerDispatchBlocked === true;
  const activeAppServerAgeSeconds = activeDesktopAppServer?.ageSeconds ?? null;
  const activeAppServerOlderThanThreshold = Number.isFinite(activeAppServerAgeSeconds)
    && activeAppServerAgeSeconds >= staleAgeMinutes * 60;
  const staleOrUnrefreshedAppServerLikely = activeAppServerOlderThanThreshold
    && currentChannelWorkerDispatchUsable !== true
    && genericMcpControlOk === true
    && repeatedCurrentChannelWorkerFailure === true;
  return {
    checkedAt: now.toISOString(),
    codexProcesses,
    desktopAppServerCount: desktopAppServers.length,
    activeDesktopAppServer,
    activeDesktopWorkerProcessCount: activeDesktopWorkerProcesses.length,
    activeDesktopWorkerServers: [...new Set(activeDesktopWorkerProcesses.map((item) => item.serverName))],
    staleAgeMinutes,
    activeAppServerOlderThanThreshold,
    staleOrUnrefreshedAppServerLikely,
    transportReportPresent: transportReport.present === true,
    transportReportParseable: transportReport.parseable === true,
    recoveryReportPresent: recoveryReport.present === true,
    recoveryReportParseable: recoveryReport.parseable === true,
    currentChannelWorkerDispatchUsable,
    genericMcpControlOk,
    repeatedCurrentChannelWorkerFailure,
    currentFailedWorkerTools: Array.isArray(recovery.currentFailedWorkerTools) ? recovery.currentFailedWorkerTools : [],
  };
}

let snapshot;
let snapshotError = "";
try {
  snapshot = summarize();
} catch (error) {
  snapshotError = error?.stack || error?.message || String(error);
  snapshot = {
    checkedAt: new Date().toISOString(),
    codexProcesses: [],
    desktopAppServerCount: 0,
    activeDesktopAppServer: null,
    activeDesktopWorkerProcessCount: 0,
    activeDesktopWorkerServers: [],
    staleAgeMinutes,
    activeAppServerOlderThanThreshold: false,
    staleOrUnrefreshedAppServerLikely: false,
    transportReportPresent: false,
    transportReportParseable: false,
    recoveryReportPresent: false,
    recoveryReportParseable: false,
    currentChannelWorkerDispatchUsable: false,
    genericMcpControlOk: false,
    repeatedCurrentChannelWorkerFailure: false,
    currentFailedWorkerTools: [],
  };
}

const processQueryOk = !snapshotError;
const appServerFreshnessOk = processQueryOk && snapshot.staleOrUnrefreshedAppServerLikely !== true;
const payload = {
  reportName: "codex-appserver-freshness",
  ok: appServerFreshnessOk,
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: processQueryOk,
  coverageKind: "codex-appserver-freshness-no-traffic",
  checkedAt: snapshot.checkedAt,
  processQueryOk,
  processQueryError: snapshotError,
  appServerFreshnessOk,
  staleOrUnrefreshedAppServerLikely: snapshot.staleOrUnrefreshedAppServerLikely,
  staleAgeMinutes: snapshot.staleAgeMinutes,
  activeAppServerOlderThanThreshold: snapshot.activeAppServerOlderThanThreshold,
  desktopAppServerCount: snapshot.desktopAppServerCount,
  activeDesktopAppServer: snapshot.activeDesktopAppServer,
  activeDesktopWorkerProcessCount: snapshot.activeDesktopWorkerProcessCount,
  activeDesktopWorkerServers: snapshot.activeDesktopWorkerServers,
  currentChannelWorkerDispatchUsable: snapshot.currentChannelWorkerDispatchUsable,
  genericMcpControlOk: snapshot.genericMcpControlOk,
  repeatedCurrentChannelWorkerFailure: snapshot.repeatedCurrentChannelWorkerFailure,
  currentFailedWorkerTools: snapshot.currentFailedWorkerTools,
  transportReportPresent: snapshot.transportReportPresent,
  transportReportParseable: snapshot.transportReportParseable,
  recoveryReportPresent: snapshot.recoveryReportPresent,
  recoveryReportParseable: snapshot.recoveryReportParseable,
  codexProcesses: snapshot.codexProcesses,
  interpretation: processQueryOk
    ? snapshot.staleOrUnrefreshedAppServerLikely
      ? "the current Codex desktop app-server appears old/unrefreshed while current-channel worker transport is failing and generic MCP still works"
      : "Codex app-server age/process state does not currently explain worker transport state"
    : "Codex app-server freshness could not inspect local process state",
  operatorAction: snapshot.staleOrUnrefreshedAppServerLikely
    ? "fully exit Codex so the desktop app-server pid changes, then record one successful read-only worker call before dispatch"
    : "continue using current-channel worker recovery probes as the authoritative dispatch gate",
};
const report = writeSignedReport(payload);
const output = { ...payload, report };
if (compact) {
  console.log(JSON.stringify({
    ok: output.ok,
    processQueryOk: output.processQueryOk,
    appServerFreshnessOk: output.appServerFreshnessOk,
    staleOrUnrefreshedAppServerLikely: output.staleOrUnrefreshedAppServerLikely,
    activeDesktopAppServer: output.activeDesktopAppServer,
    activeDesktopWorkerProcessCount: output.activeDesktopWorkerProcessCount,
    currentChannelWorkerDispatchUsable: output.currentChannelWorkerDispatchUsable,
    genericMcpControlOk: output.genericMcpControlOk,
    repeatedCurrentChannelWorkerFailure: output.repeatedCurrentChannelWorkerFailure,
    report: output.report,
  }));
} else {
  console.log(JSON.stringify(output));
}
