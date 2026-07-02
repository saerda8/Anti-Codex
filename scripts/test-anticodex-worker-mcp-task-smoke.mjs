#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { Client } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const DEFAULT_CONFIG_PATH = "C:/Users/XD/.codex/config.toml";
const DEFAULT_REPORT_ROOT = `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`;
const DEFAULT_WORKER = "opencode-worker";

const WORKERS = {
  "mimo-claude-coworker": { start: "mimo_start_implementation", wait: "mimo_wait_for_job", timeoutMs: 240000 },
  "mimocode-worker": { start: "mimocode_start_implementation", wait: "mimocode_wait_for_job", timeoutMs: 240000 },
  "kilo-worker": { start: "kilo_start_implementation", wait: "kilo_wait_for_job", timeoutMs: 240000 },
  "opencode-worker": { start: "opencode_start_implementation", wait: "opencode_wait_for_job", timeoutMs: 240000 },
  "deepseek-code-worker": { start: "deepseek_start_implementation", wait: "deepseek_wait_for_job", timeoutMs: 240000 },
  "deveco-code-worker": { start: "deveco_start_implementation", wait: "deveco_wait_for_job", timeoutMs: 300000 },
};

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function printUsage() {
  console.log([
    "Usage: node scripts/test-anticodex-worker-mcp-task-smoke.mjs [options]",
    "",
    "Options:",
    "  --scenario json|project       Smoke scenario to run (default: json)",
    "  --workers <list>              Comma-separated worker names (default: opencode-worker)",
    "  --worker-checks               Ask workers to run their own validation command",
    "  --merge-latest                Merge this run into the existing latest report",
    "  --timeout-ms <ms>             Override per-worker timeout",
    "  --config <path>               Codex config containing worker MCP servers",
    "  --report-root <path>          Directory for latest/history reports",
    "  --workspace-root <path>       Directory for generated worker smoke workspaces",
    "  --clean-workspace-root        Clean generated smoke workspaces before running",
    "  --self-test-worker-checks     Validate encoded worker-check command locally",
    "  --help, -h                    Show this help message without starting workers",
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

function reportFileNameForScenario(scenario) {
  return scenario === "project" ? "worker-mcp-project-smoke" : "worker-mcp-task-smoke";
}

function writeSignedReport(payload, reportRoot) {
  if (!reportRoot || hasArg("--no-write-report")) return null;
  mkdirSync(reportRoot, { recursive: true });
  const reportFileName = reportFileNameForScenario(payload.scenario);
  const latest = resolve(reportRoot, `latest-${reportFileName}.json`);
  const history = resolve(reportRoot, `${utcStamp()}-${reportFileName}.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function readLatestReport(reportRoot, scenario) {
  const reportFileName = reportFileNameForScenario(scenario);
  const latest = resolve(reportRoot, `latest-${reportFileName}.json`);
  if (!existsSync(latest)) return null;
  try {
    return JSON.parse(readFileSync(latest, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function mergeLatestResults(payload, reportRoot) {
  if (!hasArg("--merge-latest")) return payload;
  const latest = readLatestReport(reportRoot, payload.scenario);
  if (!latest || latest.scenario !== payload.scenario || !Array.isArray(latest.results)) return payload;

  const byWorker = new Map(latest.results
    .filter((result) => result && typeof result === "object" && result.worker)
    .map((result) => [String(result.worker), result]));
  for (const result of payload.results) {
    if (result && typeof result === "object" && result.worker) {
      byWorker.set(String(result.worker), result);
    }
  }
  const results = [...byWorker.values()];
  return {
    ...latest,
    ...payload,
    mergedFromLatest: true,
    mergedLatestCheckedAt: latest.checkedAt || "",
    workerCount: results.length,
    passedWorkerCount: results.filter((result) => result.ok).length,
    failedWorkers: results.filter((result) => !result.ok).map((result) => result.worker),
    results,
  };
}

function makeWorkspace(workerName, workspaceRoot) {
  const root = resolve(workspaceRoot, `${workerName}-${utcStamp()}-${process.pid}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "README.md"), "Anti-Codex worker MCP task smoke workspace.\n", "utf8");
  return root;
}

function buildTask(workerName, marker, scenario) {
  if (scenario === "project") {
    return [
      "Work only in the current workspace directory.",
      "Create exactly these files: package.json, word-tally.mjs, word-tally.test.mjs, done.txt.",
      "word-tally.mjs must export function tallyWords(text). It must split words by whitespace, lowercase them, ignore empty words, and return a plain object of word counts.",
      "When run as a CLI, word-tally.mjs must print JSON word counts for the remaining command line text.",
      "The CLI code must use process.argv.slice(2); do not reference program.argv or any undeclared program variable.",
      "If word-tally.mjs uses an ESM main-module guard, import pathToFileURL from node:url and compare import.meta.url to pathToFileURL(process.argv[1]).href.",
      "Do not build a file URL by string concatenation from process.argv[1]; that breaks on Windows and produces no CLI JSON.",
      "word-tally.test.mjs must use node:test and assert that tallyWords('red blue red') returns red=2 and blue=1.",
      "package.json must set type module and a test script that runs node --test word-tally.test.mjs.",
      `done.txt must contain exactly ${marker}.`,
      "After writing files, run npm test and node word-tally.mjs red blue red before finishing.",
      "Do not edit files outside this workspace.",
    ].join(" ");
  }
  return [
    "Work only in the current workspace directory.",
    "Create exactly one file: worker-smoke-result.json.",
    "worker-smoke-result.json must be valid JSON with keys:",
    `marker exactly "${marker}", worker exactly "${workerName}", ok exactly true, and notes as a short string.`,
    "After creating the file, read it back once before finishing.",
    "Do not edit files outside this workspace.",
  ].join(" ");
}

function buildValidationCommand(workerName, marker, scenario) {
  const expectedMarker = JSON.stringify(marker);
  const expectedWorker = JSON.stringify(workerName);
  const validationScript = scenario === "project"
    ? [
        'const fs=require("fs");',
        'const cp=require("child_process");',
        `if(fs.readFileSync("done.txt","utf8").trim()!==${expectedMarker}) process.exit(2);`,
        'const t=cp.spawnSync(process.execPath,["--test","word-tally.test.mjs"],{encoding:"utf8"});',
        'if(t.status!==0) process.exit(3);',
        'const c=cp.spawnSync(process.execPath,["word-tally.mjs","red","blue","red"],{encoding:"utf8"});',
        'if(c.status!==0) process.exit(4);',
        'const data=JSON.parse(c.stdout);',
        'if(data.red!==2||data.blue!==1) process.exit(5);',
      ].join("")
    : [
        'const fs=require("fs");',
        'const data=JSON.parse(fs.readFileSync("worker-smoke-result.json","utf8"));',
        `if(data.marker!==${expectedMarker}||data.worker!==${expectedWorker}||data.ok!==true) process.exit(2);`,
      ].join("");
  const encoded = Buffer.from(validationScript, "utf8").toString("base64");
  return [
    "node",
    "-e",
    `"eval(Buffer.from('${encoded}','base64').toString('utf8'))"`,
  ].join(" ");
}

function buildWorkerArgs(workerName, workspace, marker, timeoutMs, scenario) {
  const validation = buildValidationCommand(workerName, marker, scenario);
  const args = {
    cwd: workspace,
    allowed_dirs: [workspace],
    forbidden_paths: [],
    generated_paths: [],
    ignored_dirs: [".git", "node_modules"],
    permission_mode: "acceptEdits",
    safety_mode: "permissive",
    worker_profile: "scoped_patch",
    timeout_ms: timeoutMs,
    check_timeout_ms: 45000,
    task: buildTask(workerName, marker, scenario),
  };
  if (hasArg("--worker-checks")) args.checks = [validation];
  if (workerName === "deepseek-code-worker") {
    args.use_case = "simple_agent_task";
    args.verification_profile = "smoke";
    args.reasoning_effort = "high";
  }
  if (workerName === "mimo-claude-coworker") {
    args.use_case = "simple_agent_task";
    args.verification_profile = "smoke";
    args.reasoning_effort = "high";
  }
  return args;
}

function selfTestWorkerChecksCommand() {
  const command = buildValidationCommand("opencode-worker", "SELF_TEST_MARKER", "json");
  const failures = [];
  if (!command.includes('node -e "eval(Buffer.from(')) failures.push("validation command does not quote node -e script");
  if (!command.includes("base64")) failures.push("validation command does not use shell-safe base64 script transport");
  const encoded = command.match(/Buffer\.from\('([^']+)'/)?.[1] || "";
  const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
  if (!decoded.includes('"SELF_TEST_MARKER"')) failures.push("validation command does not preserve marker literal");
  if (!decoded.includes('"opencode-worker"')) failures.push("validation command does not preserve worker literal");
  if (/\bnode -e const\b/.test(command)) failures.push("validation command is still unquoted");
  return {
    ok: failures.length === 0,
    command,
    failures,
  };
}

function verifyWorkspace(workspace, workerName, marker) {
  const resultPath = resolve(workspace, "worker-smoke-result.json");
  if (!existsSync(resultPath)) {
    return { ok: false, resultPathExists: false, error: "missing output file" };
  }
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    const ok = result.marker === marker && result.worker === workerName && result.ok === true;
    return { ok, resultPathExists: true, result };
  } catch (error) {
    return { ok: false, resultPathExists: true, error: error?.message || String(error) };
  }
}

function verifyProjectWorkspace(workspace, marker) {
  const requiredFiles = ["package.json", "word-tally.mjs", "word-tally.test.mjs", "done.txt"];
  const missingFiles = requiredFiles.filter((file) => !existsSync(resolve(workspace, file)));
  if (missingFiles.length > 0) return { ok: false, missingFiles };
  const doneText = readFileSync(resolve(workspace, "done.txt"), "utf8").trim();
  const test = spawnSync(process.execPath, ["--test", "word-tally.test.mjs"], { cwd: workspace, encoding: "utf8", timeout: 45000 });
  const cli = spawnSync(process.execPath, ["word-tally.mjs", "red", "blue", "red"], { cwd: workspace, encoding: "utf8", timeout: 45000 });
  let cliJson = null;
  try {
    cliJson = JSON.parse(String(cli.stdout || "").trim());
  } catch {
    cliJson = null;
  }
  const ok = doneText === marker && test.status === 0 && cli.status === 0 && cliJson?.red === 2 && cliJson?.blue === 1;
  return {
    ok,
    missingFiles,
    doneTextMatches: doneText === marker,
    testExitCode: test.status,
    cliExitCode: cli.status,
    cliJson,
  };
}

async function runWorker(workerName, options) {
  const def = WORKERS[workerName];
  if (!def) throw new Error(`Unsupported worker for task smoke: ${workerName}`);
  const config = readWorkerConfig(options.configPath, workerName);
  if (!config.command) throw new Error(`Missing command for ${workerName}`);

  const marker = `WORKER_MCP_TASK_SMOKE_${Date.now()}`;
  const workspace = makeWorkspace(workerName, options.workspaceRoot);
  const timeoutMs = Number(options.timeoutMs || def.timeoutMs);
  const workerArgs = buildWorkerArgs(workerName, workspace, marker, timeoutMs, options.scenario);
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: {
      ...process.env,
      ...config.env,
      ANTICODEX_WORKER_SMOKE_MARKER: marker,
      ANTICODEX_WORKER_SMOKE_WORKER: workerName,
    },
  });
  const client = new Client({ name: "anticodex-worker-mcp-task-smoke", version: "1.0.0" });
  const startedAt = Date.now();
  let jobId = "";
  let terminal = null;
  const waitSnapshots = [];
  try {
    await withTimeout(client.connect(transport), config.startupTimeoutMs, `${workerName} connect`);
    const started = await withTimeout(
      client.callTool({ name: def.start, arguments: workerArgs }),
      60000,
      `${workerName} start`,
    );
    jobId = extractJobId(started);
    if (!jobId) throw new Error(`${workerName} start did not return a job id`);

    const deadline = Date.now() + timeoutMs + 30000;
    while (Date.now() < deadline) {
      const waited = await withTimeout(
        client.callTool({
          name: def.wait,
          arguments: {
            job_id: jobId,
            max_wait_ms: 30000,
            poll_interval_ms: 2000,
            include_diff: false,
            include_events: false,
            include_logs: false,
          },
        }),
        60000,
        `${workerName} wait`,
      );
      const data = parseContentJson(waited);
      const progress = data.progress || data.result || data;
      const status = String(data.status || progress.status || progress.phase || "").toLowerCase();
      waitSnapshots.push({
        status: status || "unknown",
        changedFilesSoFar: Number(progress.changed_files_so_far || progress.change_count_so_far || progress.change_count || 0),
      });
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
    } catch {
      // Best-effort close.
    }
  }

  const workspaceVerification = options.scenario === "project"
    ? verifyProjectWorkspace(workspace, marker)
    : verifyWorkspace(workspace, workerName, marker);
  const terminalStatus = String(terminal?.status || terminal?.result?.status || terminal?.progress?.status || "").toLowerCase();
  const ok = isSuccessStatus(terminalStatus) && workspaceVerification.ok;
  return {
    worker: workerName,
    ok,
    jobId,
    marker,
    workspace,
    elapsedMs: Date.now() - startedAt,
    terminalStatus: terminalStatus || "unknown",
    terminalFailureReason: terminal?.result?.failure_reason || terminal?.failure_reason || terminal?.error || "",
    waitSnapshots,
    workspaceVerification,
  };
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    printUsage();
    return;
  }
  if (hasArg("--self-test-worker-checks")) {
    const result = selfTestWorkerChecksCommand();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  const configPath = argValue("--config", DEFAULT_CONFIG_PATH);
  const reportRoot = resolve(argValue("--report-root", DEFAULT_REPORT_ROOT));
  const workspaceRoot = resolve(argValue("--workspace-root", `${process.env.APPDATA || os.tmpdir()}/anticodex/worker-task-smoke`));
  const timeoutMs = Number(argValue("--timeout-ms", "0")) || null;
  const scenario = argValue("--scenario", "json");
  if (!["json", "project"].includes(scenario)) throw new Error(`Unsupported scenario: ${scenario}`);
  const workers = argValue("--workers", DEFAULT_WORKER).split(",").map((item) => item.trim()).filter(Boolean);
  const unsupported = workers.filter((worker) => !WORKERS[worker]);
  if (unsupported.length) throw new Error(`Unsupported workers: ${unsupported.join(", ")}`);
  if (workers.some((worker) => worker === "antigravity-code-worker")) {
    throw new Error("antigravity-code-worker is intentionally excluded until dual-account isolation is proven");
  }

  mkdirSync(workspaceRoot, { recursive: true });
  if (hasArg("--clean-workspace-root") && workspaceRoot.toLowerCase().includes("\\anticodex\\worker-task-smoke")) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    mkdirSync(workspaceRoot, { recursive: true });
  }

  const results = [];
  for (const worker of workers) {
    results.push(await runWorker(worker, { configPath, workspaceRoot, timeoutMs, scenario }));
  }

  const payload = mergeLatestResults({
    reportName: scenario === "project" ? "worker-mcp-project-smoke" : "worker-mcp-task-smoke",
    ok: results.length > 0 && results.every((result) => result.ok),
    requestedRealTraffic: true,
    usedRealTraffic: true,
    behaviorCovered: true,
    coverageKind: "worker-mcp-real-task-smoke",
    scenario,
    checkedAt: new Date().toISOString(),
    configPath,
    antigravityWorkerExcluded: true,
    workerCount: results.length,
    passedWorkerCount: results.filter((result) => result.ok).length,
    failedWorkers: results.filter((result) => !result.ok).map((result) => result.worker),
    results,
  }, reportRoot);
  payload.ok = payload.results.length > 0 && payload.results.every((result) => result.ok);
  payload.workerCount = payload.results.length;
  payload.passedWorkerCount = payload.results.filter((result) => result.ok).length;
  payload.failedWorkers = payload.results.filter((result) => !result.ok).map((result) => result.worker);
  const report = writeSignedReport(payload, reportRoot);
  const output = report ? { ...payload, report } : payload;
  console.log(JSON.stringify(output));
  if (!payload.ok) process.exitCode = 1;
}

main().catch((error) => {
  const scenario = argValue("--scenario", "json");
  const reportRoot = resolve(argValue("--report-root", DEFAULT_REPORT_ROOT));
  const payload = {
    reportName: reportFileNameForScenario(scenario),
    ok: false,
    requestedRealTraffic: true,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "worker-mcp-real-task-smoke",
    scenario,
    checkedAt: new Date().toISOString(),
    configPath: argValue("--config", DEFAULT_CONFIG_PATH),
    antigravityWorkerExcluded: true,
    workerCount: 0,
    passedWorkerCount: 0,
    failedWorkers: [],
    results: [],
    error: error?.message || String(error),
  };
  const report = writeSignedReport(payload, reportRoot);
  console.log(JSON.stringify(report ? { ...payload, report } : payload));
  process.exitCode = 1;
});
