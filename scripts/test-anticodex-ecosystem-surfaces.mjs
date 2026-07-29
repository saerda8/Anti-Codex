#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_REPORTS = [
  {
    id: "refreshFeatures",
    file: "latest-refresh-features.json",
    surface: "skills",
    maxAgeHours: 24,
    validate(report, fail) {
      if (report.ok !== true) fail("refresh-features ok=false");
      if (report.verifyOnly !== true) fail("refresh-features should be verify-only for ecosystem rollup");
      if (report.connectorParity?.contentMatches !== true) fail("refresh-features connector parity not clean");
      if (report.appToolParity?.contentMatches !== true) fail("refresh-features app-tool parity not clean");
      if (Number(report.mcp?.count || 0) < 1) fail("refresh-features missing MCP inventory");
      if (Number(report.skills?.count || 0) < 1) fail("refresh-features missing skill inventory");
    },
  },
  {
    id: "mcpSkills",
    file: "latest-mcp-skills.json",
    surface: "skills-mcp",
    maxAgeHours: 24,
    validate(report, fail) {
      if (report.ok !== true) fail("mcp-skills ok=false");
      if (report.mcp?.smoke?.passed !== true) fail("mcp-skills smoke not passed");
      if (Number(report.mcp?.count || 0) < 1 || report.mcp?.hasNodeRepl !== true) fail("mcp-skills node_repl missing");
      if (report.mcp?.developmentWorkersAllowed === true
        || (report.mcp?.unexpectedLocalDevelopmentMcpNames || []).length > 0) {
        fail("mcp-skills development workers leaked into the product");
      }
      if (Number(report.skills?.count || 0) < 1) fail("mcp-skills missing skill inventory");
      if (report.skills?.smoke?.readable !== true) fail("mcp-skills skill smoke not readable");
    },
  },
  {
    id: "pluginCapabilities",
    file: "latest-plugin-capabilities.json",
    surface: "plugins-connectors",
    maxAgeHours: 24,
    validate(report, fail) {
      if (report.ok !== true) fail("plugin-capabilities ok=false");
      if (Number(report.capabilities?.installedPluginCount || 0) < 1) fail("plugin-capabilities missing installed plugins");
      if (Number(report.capabilities?.connectorCount || 0) < 1) fail("plugin-capabilities missing connector inventory");
      if (report.capabilities?.connectorParity?.checked !== true) fail("plugin-capabilities connector parity not checked");
      if (report.capabilities?.appToolParity?.checked !== true) fail("plugin-capabilities app-tool parity not checked");
      if (Number(report.capabilities?.unauthorizedAppToolCount || 0) !== 0) fail("plugin-capabilities found unauthorized app tools");
    },
  },
  {
    id: "workerMcpSourceHygiene",
    file: "latest-worker-mcp-source-hygiene.json",
    surface: "agent-workers",
    requiredForProduct: false,
    maxAgeHours: 24,
    validate(report, fail) {
      if (report.ok !== true) fail("worker-mcp-source-hygiene ok=false");
      if (report.usedRealTraffic !== false) fail("worker-mcp-source-hygiene used real traffic");
      if (Number(report.passedWorkerCount || 0) < 1) fail("worker-mcp-source-hygiene passed worker count low");
      if ((Array.isArray(report.nulByteWorkers) ? report.nulByteWorkers : []).length !== 0) fail("worker source hygiene has NUL byte workers");
    },
  },
  {
    id: "workerMcpServerProbe",
    file: "latest-worker-mcp-server-probe.json",
    surface: "agent-workers",
    requiredForProduct: false,
    maxAgeHours: 24,
    validate(report, fail) {
      if (report.ok !== true) fail("worker-mcp-server-probe ok=false");
      if (report.usedRealTraffic !== false) fail("worker-mcp-server-probe used real traffic");
      if (Number(report.passedServerCount || 0) < 6) fail("worker-mcp-server-probe passed server count below 6");
      if ((Array.isArray(report.missingServers) ? report.missingServers : []).length !== 0) fail("worker-mcp-server-probe has missing servers");
    },
  },
  {
    id: "workerMcpStatusProbe",
    file: "latest-worker-mcp-status-probe.json",
    surface: "agent-workers",
    requiredForProduct: false,
    maxAgeHours: 24,
    validate(report, fail) {
      if (report.ok !== true) fail("worker-mcp-status-probe ok=false");
      if (report.usedRealTraffic !== false) fail("worker-mcp-status-probe used real traffic");
      if (Number(report.statusCallOkCount || report.passedWorkerCount || 0) < 1) fail("worker-mcp-status-probe status success count low");
    },
  },
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
    "Usage: node scripts/test-anticodex-ecosystem-surfaces.mjs [options]",
    "",
    "Options:",
    "  --report-root PATH       Report directory (default: %APPDATA%/anticodex/reports).",
    "  --max-age-hours N        Override per-report freshness max age.",
    "  --no-write-report        Print JSON only.",
    "  --help, -h               Show this help.",
  ].join("\n"));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function compactWorkerFailureDetails(report) {
  if (!report || !Array.isArray(report.results)) return [];
  return report.results
    .filter((result) => result && result.ok !== true)
    .map((result) => ({
      worker: result.worker || "",
      jobId: result.jobId || "",
      terminalStatus: result.terminalStatus || "",
      terminalFailureReason: result.terminalFailureReason || "",
      terminalErrorSummary: result.terminalErrorSummary || "",
      missingFiles: Array.isArray(result.workspaceVerification?.missingFiles)
        ? result.workspaceVerification.missingFiles
        : [],
      changedFilesSoFar: Array.isArray(result.waitSnapshots) && result.waitSnapshots.length
        ? result.waitSnapshots[result.waitSnapshots.length - 1]?.changedFilesSoFar ?? null
        : null,
    }));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function writeReport(payload, reportRoot) {
  if (hasArg("--no-write-report")) return null;
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-ecosystem-surfaces.json");
  const history = resolve(reportRoot, `${stamp()}-ecosystem-surfaces.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, file);
    writeFileSync(`${file}.sha256`, `sha256:${createHash("sha256").update(json).digest("hex")}`, "ascii");
  }
  return { latest, history };
}

function main() {
  if (hasArg("--help") || hasArg("-h")) {
    printHelp();
    return;
  }
  if (hasArg("--self-test")) {
    const failures = [];
    REQUIRED_REPORTS.find((spec) => spec.id === "mcpSkills").validate({
      ok: true,
      mcp: {
        count: 1,
        hasNodeRepl: true,
        developmentWorkersAllowed: false,
        unexpectedLocalDevelopmentMcpNames: [],
        smoke: { passed: true },
      },
      skills: { count: 1, smoke: { readable: true } },
    }, (message) => failures.push(message));
    const leakFailures = [];
    REQUIRED_REPORTS.find((spec) => spec.id === "mcpSkills").validate({
      ok: true,
      mcp: {
        count: 2,
        hasNodeRepl: true,
        developmentWorkersAllowed: false,
        unexpectedLocalDevelopmentMcpNames: ["deepseek-code-worker"],
        smoke: { passed: true },
      },
      skills: { count: 1, smoke: { readable: true } },
    }, (message) => leakFailures.push(message));
    if (!leakFailures.some((message) => message.includes("development workers leaked"))) {
      failures.push("mcp-skills self-test accepted a leaked development worker");
    }
    const output = { ok: failures.length === 0, failures };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (!output.ok) process.exit(1);
    return;
  }
  const startedAt = Date.now();
  const reportRoot = resolve(argValue("--report-root", join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports")));
  const overrideMaxAgeHours = Number(argValue("--max-age-hours", ""));
  const results = [];
  const failures = [];
  const optionalDevelopmentFailures = [];
  const now = Date.now();
  for (const spec of REQUIRED_REPORTS) {
    const filePath = resolve(reportRoot, spec.file);
    const reportFailures = [];
    const fail = (message) => reportFailures.push(`${spec.id}: ${message}`);
    let report = null;
    let parseable = false;
    let ageHours = null;
    if (!existsSync(filePath)) {
      fail(`missing ${spec.file}`);
    } else {
      try {
        report = readJson(filePath);
        parseable = true;
        const mtimeMs = new Date(report.checkedAt || report.startedAt || 0).getTime();
        const statAgeMs = now - statSync(filePath).mtimeMs;
        ageHours = Number.isFinite(mtimeMs) && mtimeMs > 0
          ? (now - mtimeMs) / 3600000
          : statAgeMs / 3600000;
        spec.validate(report, fail);
      } catch (error) {
        fail(`parse/validate failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const maxAgeHours = Number.isFinite(overrideMaxAgeHours) && overrideMaxAgeHours > 0
      ? overrideMaxAgeHours
      : spec.maxAgeHours;
    if (ageHours !== null && ageHours > maxAgeHours) {
      fail(`stale report age ${ageHours.toFixed(2)}h > ${maxAgeHours}h`);
    }
    const requiredForProduct = spec.requiredForProduct !== false;
    results.push({
      id: spec.id,
      surface: spec.surface,
      file: spec.file,
      requiredForProduct,
      present: existsSync(filePath),
      parseable,
      ageHours,
      maxAgeHours,
      ok: reportFailures.length === 0,
      failures: reportFailures,
      localReportFreshnessOnly: false,
      externalQuotaDecrementProven: report?.externalQuotaDecrementProven === true,
      externalQuotaEvidence: typeof report?.externalQuotaEvidence === "string" ? report.externalQuotaEvidence : "not_collected",
      workerFailureDetails: spec.surface === "agent-workers" ? compactWorkerFailureDetails(report) : [],
    });
    (requiredForProduct ? failures : optionalDevelopmentFailures).push(...reportFailures);
  }
  const requiredResults = results.filter((result) => result.requiredForProduct);
  const optionalDevelopmentResults = results.filter((result) => !result.requiredForProduct);
  const coveredSurfaces = [...new Set(requiredResults.filter((result) => result.ok).map((result) => result.surface))].sort();
  const payload = {
    ok: failures.length === 0,
    reportName: "ecosystem-surfaces",
    noTraffic: true,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "ecosystem-report-rollup-no-traffic",
    checkedAt: new Date().toISOString(),
    reportRoot,
    coveredSurfaces,
    requiredSurfaceCount: new Set(REQUIRED_REPORTS.filter((spec) => spec.requiredForProduct !== false).map((spec) => spec.surface)).size,
    requiredReportCount: requiredResults.length,
    requiredPassedReportCount: requiredResults.filter((result) => result.ok).length,
    passedReportCount: results.filter((result) => result.ok).length,
    totalReportCount: results.length,
    optionalDevelopmentReportCount: optionalDevelopmentResults.length,
    optionalDevelopmentPassedReportCount: optionalDevelopmentResults.filter((result) => result.ok).length,
    optionalDevelopmentFailures,
    results,
    failures,
    elapsedMs: Date.now() - startedAt,
  };
  payload.report = writeReport(payload, reportRoot);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!payload.ok) process.exit(1);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
