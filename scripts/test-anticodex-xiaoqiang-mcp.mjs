#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCodexMcpServerDefinition, runRealMcpListSmoke } from "./anticodex-real-mcp-smoke.mjs";

const DEFAULT_SERVERS = ["xiaoqiang1", "xiaoqiang2", "xiaoqiang3"];
const EXPECTED_TOOLS = [
  "deepseek_implement_in_workspace",
  "deepseek_get_job",
  "deepseek_wait_for_job",
];

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function splitList(value, fallback) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function defaultInstallRoot() {
  return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local"), "Anti-Codex");
}

function defaultStateRoot() {
  return join(process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming"), "anticodex");
}

function printHelp() {
  console.log([
    "Usage: node scripts/test-anticodex-xiaoqiang-mcp.mjs [options]",
    "",
    "Options:",
    "  --servers a,b,c       MCP server names to verify (default: xiaoqiang1,xiaoqiang2,xiaoqiang3).",
    "  --install-root PATH   Anti-Codex install root.",
    "  --state-root PATH     Anti-Codex state root.",
    "  --codex-cli PATH      Patched Codex CLI path.",
    "  --codex-home PATH     Anti-Codex CODEX_HOME path.",
    "  --report-root PATH    Report directory.",
    "  --timeout-ms N        Per-server stdio timeout (default: 30000).",
    "  --no-write-report     Print JSON only.",
    "  --help, -h            Show this help.",
  ].join("\n"));
}

async function writeReports(reportRoot, payload) {
  await mkdir(reportRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const latest = join(reportRoot, "latest-xiaoqiang-mcp.json");
  const history = join(reportRoot, `${stamp}-xiaoqiang-mcp.json`);
  await writeFile(latest, json, "utf8");
  await writeFile(history, json, "utf8");
  return { latest, history };
}

async function verifyServer({ serverName, codexCli, codexHome, timeoutMs }) {
  const startedAt = Date.now();
  try {
    const definition = await getCodexMcpServerDefinition({
      codexCli,
      codexHome,
      serverName,
      timeoutMs,
    });
    const listed = await runRealMcpListSmoke({ definition, timeoutMs });
    const toolNames = Array.isArray(listed.toolNames) ? listed.toolNames : [];
    const missingExpectedTools = EXPECTED_TOOLS.filter((toolName) => !toolNames.includes(toolName));
    return {
      serverName,
      ok: missingExpectedTools.length === 0 && listed.ok === true && Number(listed.toolCount) > 0,
      transport: listed.transport,
      commandName: listed.commandName,
      toolCount: listed.toolCount,
      toolNames,
      expectedToolNames: EXPECTED_TOOLS,
      missingExpectedTools,
      elapsedMs: Date.now() - startedAt,
      error: "",
    };
  } catch (error) {
    return {
      serverName,
      ok: false,
      transport: "stdio",
      commandName: "",
      toolCount: 0,
      toolNames: [],
      expectedToolNames: EXPECTED_TOOLS,
      missingExpectedTools: EXPECTED_TOOLS,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    printHelp();
    return;
  }

  const installRoot = resolve(argValue("--install-root", defaultInstallRoot()));
  const stateRoot = resolve(argValue("--state-root", defaultStateRoot()));
  const reportRoot = resolve(argValue("--report-root", join(stateRoot, "reports")));
  const codexCli = resolve(argValue("--codex-cli", join(installRoot, "codex-patched-app", "resources", "codex.exe")));
  const codexHome = resolve(argValue("--codex-home", join(stateRoot, "codex-home-deepseek-app")));
  const timeoutMs = Math.max(1, Number(argValue("--timeout-ms", "30000")) || 30000);
  const servers = splitList(argValue("--servers", ""), DEFAULT_SERVERS);
  const results = [];
  for (const serverName of servers) {
    results.push(await verifyServer({ serverName, codexCli, codexHome, timeoutMs }));
  }
  const failures = results
    .filter((result) => !result.ok)
    .map((result) => {
      const missing = result.missingExpectedTools.length > 0
        ? ` missing tools: ${result.missingExpectedTools.join(", ")}`
        : "";
      const error = result.error ? ` error: ${result.error}` : "";
      return `${result.serverName}${missing}${error}`.trim();
    });
  const payload = {
    ok: failures.length === 0,
    reportName: "xiaoqiang-mcp",
    noTraffic: true,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "mcp-stdio-tools-list-no-traffic",
    checkedAt: new Date().toISOString(),
    codexHome,
    codexCli,
    servers,
    expectedToolNames: EXPECTED_TOOLS,
    results,
    failures,
  };
  if (!hasArg("--no-write-report")) {
    payload.report = await writeReports(reportRoot, payload);
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!payload.ok) process.exit(1);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
