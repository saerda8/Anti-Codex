#!/usr/bin/env node
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getProcessSnapshot,
  fetchOldRouteFingerprint,
} from "./lib/codexplusplus-antigravity-harness.mjs";
import {
  auditCodexPlusPlusLogSegment,
  buildGate8Report,
  fetchJsonWithRetry,
} from "./lib/anticodex-gate8-evidence.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-gate8-final-long-task.mjs [options]

Options:
  --allow-real-traffic     Run the final real Antigravity acceptance task.
  --model <id>             Antigravity model override (default: current fixed-route model).
  --timeout-ms <ms>        Per visible task turn timeout (default: 300000).
  --long-context-chars <n> Context pressure before compaction (default: 100000).
  --report-root <path>     Anti-Codex report directory.
  --resume-existing        Reuse the latest passed inventory journey and existing compaction evidence.
  --help, -h               Show help.`);
    process.exit(0);
  }
  if (!key.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "..");
const lockedRunnerScript = resolve(scriptRoot, "test-anticodex-gate8-final-long-task.ps1");
const realTrafficLockName = String(process.env.ANTICODEX_REAL_TRAFFIC_LOCK_NAME || "Local\\AntiCodex.RealTrafficBridge");
const stateRoot = resolve(process.env.ANTICODEX_STATE_ROOT || join(process.env.APPDATA || os.tmpdir(), "anticodex"));
const reportRoot = resolve(args.get("--report-root") || join(stateRoot, "reports"));
let model = String(args.get("--model") || "").trim();
const timeoutMs = Math.max(60_000, Number(args.get("--timeout-ms") || 300_000));
const longContextChars = Math.max(65_536, Number(args.get("--long-context-chars") || 100_000));
const allowRealTraffic = args.has("--allow-real-traffic");
const resumeExisting = args.has("--resume-existing");
const humanJourneyScript = resolve(scriptRoot, "test-anticodex-human-long-journey.mjs");
const compactionScript = resolve(scriptRoot, "test-anticodex-compaction-resume.ps1");
const releaseGateScript = resolve(scriptRoot, "test-anticodex-release-gates.mjs");
const cppLogPath = resolve(stateRoot, "codexplusplus", "codex-plus.log");
const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[-:.TZ]/g, "");
const MAX_QUOTA_PROBE_AGE_MS = 10 * 60_000;

if (!allowRealTraffic) {
  console.log(JSON.stringify({
    ok: true,
    reportName: "gate8-final-long-task",
    gate: 8,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    skipped: true,
    requiresExplicitUserApproval: true,
    approvalReason: "real_traffic_required",
    model: model || "fixed-route-default",
    commandPreview: model
      ? `node scripts/test-anticodex-gate8-final-long-task.mjs --allow-real-traffic --model ${model}`
      : "node scripts/test-anticodex-gate8-final-long-task.mjs --allow-real-traffic",
  }));
  process.exit(0);
}

if (process.env.ANTICODEX_REAL_TRAFFIC_LOCK_HELD !== "1") {
  const lockedRun = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", lockedRunnerScript,
    "-AllowRealTraffic",
    "-Model", model,
    "-TimeoutMs", String(timeoutMs),
    "-LongContextChars", String(longContextChars),
    "-ReportRoot", reportRoot,
    "-NodePath", process.execPath,
    "-LockName", realTrafficLockName,
    ...(resumeExisting ? ["-ResumeExisting"] : []),
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (lockedRun.stdout) process.stdout.write(lockedRun.stdout);
  if (lockedRun.stderr) process.stderr.write(lockedRun.stderr);
  if (lockedRun.error) {
    process.stderr.write(`${lockedRun.error.message}\n`);
  }
  process.exit(Number.isInteger(lockedRun.status) ? lockedRun.status : 1);
}

function parseLastJson(text = "") {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || sourceRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
  });
  return {
    ...result,
    parsed: parseLastJson(result.stdout),
    stderrSummary: compactText(result.stderr, 1600),
  };
}

function compactText(value, max = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeSignedReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-gate8-final-long-task.json");
  const history = resolve(reportRoot, `${runId}-gate8-final-long-task.json`);
  const body = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const path of [latest, history]) {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, body, "utf8");
    renameSync(temporary, path);
    writeFileSync(`${path}.sha256`, `sha256:${sha256(body)}\n`, "ascii");
  }
  return { ...payload, report: { latest, history } };
}

async function fixedRouteHealth() {
  return fetchJsonWithRetry(fetch, "http://127.0.0.1:18487/anticodex/fixed-route/health", {
    attempts: 3,
    delayMs: 300,
    timeoutMs: 8_000,
  });
}

async function accountReadiness() {
  return fetchJsonWithRetry(fetch, "http://127.0.0.1:8484/anticodex/account", {
    attempts: 3,
    delayMs: 300,
    timeoutMs: 8_000,
  });
}

async function modelCatalog() {
  return fetchJsonWithRetry(fetch, "http://127.0.0.1:8484/models", {
    attempts: 3,
    delayMs: 300,
    timeoutMs: 8_000,
  });
}

function quotaProbePrecondition(selectedModel) {
  const reportPath = resolve(reportRoot, "latest-gate8-quota-probe.json");
  if (!existsSync(reportPath)) {
    throw new Error("Gate 8 requires a fresh successful bounded quota probe before the long task");
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Gate 8 quota probe report is unreadable: ${compactText(error?.message)}`);
  }
  const generatedAtMs = Date.parse(String(report?.generatedAt || ""));
  const ageMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : Number.POSITIVE_INFINITY;
  const responseStatusCode = Number(report?.response?.statusCode || 0);
  const failures = [];
  if (report?.schema !== "anticodex-gate8-quota-probe-v1" || report?.reportName !== "gate8-quota-probe") failures.push("schema");
  if (report?.ok !== true || report?.quotaReady !== true) failures.push("quota_ready");
  if (report?.usedRealTraffic !== true || Number(report?.requestCount) !== 1) failures.push("single_request");
  if (String(report?.model || "") !== selectedModel) failures.push("model");
  if (report?.markerMatched !== true || responseStatusCode !== 200) failures.push("response");
  if (report?.longTaskStarted !== false || report?.formalGateEvidence !== false) failures.push("scope");
  if (ageMs < -60_000 || ageMs > MAX_QUOTA_PROBE_AGE_MS) failures.push("freshness");
  if (failures.length > 0) {
    throw new Error(`Gate 8 quota probe precondition failed: ${failures.join(",")}`);
  }
  return {
    ok: true,
    quotaReady: true,
    usedRealTraffic: true,
    requestCount: 1,
    model: selectedModel,
    markerMatched: true,
    responseStatusCode,
    generatedAt: report.generatedAt,
    ageMs,
    reportPath,
  };
}

function releasePrecondition() {
  const result = run(process.execPath, [releaseGateScript, "--summary"], { timeoutMs: 30_000 });
  const report = result.parsed;
  const completed = new Set(Array.isArray(report?.completedGates) ? report.completedGates : []);
  const ready = result.status === 0
    && ["gate1", "gate2", "gate3", "gate4", "gate5", "gate6", "gate7"].every((gate) => completed.has(gate))
    && Number(report?.shellProgress) === 100
    && Number(report?.codexPlusPlusProgress) === 100
    && Number(report?.antigravityAdapterProgress) === 100;
  return { ready, status: result.status, report, stderr: result.stderrSummary };
}

function legacyProcessCount() {
  const script = [
    "$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "$legacy = @($rows | Where-Object { ([string]$_.CommandLine) -match 'adaptive-server\\.mjs|deepcodex-translator\\.exe|start-deepcodex\\.(?:ps1|sh)' })",
    "[Console]::Out.Write($legacy.Count)",
  ].join("\n");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  return Number(String(output).trim());
}

function verifyFinalProject(root) {
  if (!root || !existsSync(root)) {
    return { tests: [], error: "final inventory project is missing" };
  }
  const nodeTest = run(process.execPath, ["--test", "inventory.test.mjs"], { cwd: root, timeoutMs: 60_000 });
  const dryRun = run(process.execPath, ["inventory.mjs", "--input", "data/inventory.json", "--output", "summary.json", "--dry-run"], {
    cwd: root,
    timeoutMs: 30_000,
  });
  return {
    tests: [
      {
        name: "node --test inventory.test.mjs",
        passed: nodeTest.status === 0,
        exitCode: Number(nodeTest.status),
        output: compactText(nodeTest.stdout || nodeTest.stderr),
      },
      {
        name: "inventory CLI dry-run",
        passed: dryRun.status === 0,
        exitCode: Number(dryRun.status),
        output: compactText(dryRun.stdout || dryRun.stderr),
      },
    ],
  };
}

function artifactManifest(root) {
  if (!root || !existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const stat = statSync(path);
        if (stat.size <= 0) continue;
        result.push({
          path,
          relativePath: relative(root, path).replaceAll("\\", "/"),
          exists: true,
          sha256: sha256(readFileSync(path)),
          bytes: stat.size,
        });
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function cppLogSegment(offset) {
  if (!existsSync(cppLogPath)) return { offset, end: 0, rotated: false, text: "" };
  const body = readFileSync(cppLogPath);
  const rotated = body.length < offset;
  const effectiveOffset = rotated ? 0 : offset;
  return { offset: effectiveOffset, end: body.length, rotated, text: body.subarray(effectiveOffset).toString("utf8") };
}

let formalPhase = "release-precondition";
let realTrafficMayHaveStarted = false;

async function runFormalGate8() {
const precondition = releasePrecondition();
if (!precondition.ready) {
  throw new Error(`Gate 8 cannot start before Gates 1-7 and all three components are at 100%: ${compactText(JSON.stringify(precondition))}`);
}

formalPhase = "route-precondition";
const routeBefore = await fixedRouteHealth();
const accountBefore = await accountReadiness();
if (accountBefore?.signedIn !== true || accountBefore?.identityAvailable !== true) {
  throw new Error(`Gate 8 requires a signed-in Antigravity account before model traffic: ${compactText(JSON.stringify(accountBefore))}`);
}
if (!model) model = String(routeBefore?.route?.model || routeBefore?.model || "").trim();
if (!model) throw new Error("fixed-route health did not provide an Antigravity model for Gate 8");
const modelCatalogBefore = await modelCatalog();
const modelIds = Array.isArray(modelCatalogBefore?.data)
  ? modelCatalogBefore.data.map((entry) => String(entry?.id || "").trim()).filter(Boolean)
  : [];
if (!modelIds.includes(model)) {
  throw new Error(`Gate 8 selected model is absent from the current model catalog: ${model}`);
}
formalPhase = "quota-precondition";
const quotaProbeBefore = quotaProbePrecondition(model);
formalPhase = "route-snapshot";
const oldRouteBefore = await fetchOldRouteFingerprint();
const processBefore = getProcessSnapshot();
const cppLogOffset = existsSync(cppLogPath) ? statSync(cppLogPath).size : 0;

let journeyRun = null;
let journeyPayload = null;
let recoveryCompactionSource = null;
if (resumeExisting) {
  formalPhase = "resume-existing-evidence";
  journeyPayload = readJsonFile(resolve(reportRoot, "latest-ui-human-long-journey.json"));
  recoveryCompactionSource = readJsonFile(resolve(reportRoot, "latest-compaction-resume.json"));
  if (journeyPayload?.ok !== true || journeyPayload?.usedRealTraffic !== true) {
    throw new Error("Gate 8 resume requires the latest passed real inventory journey report");
  }
  if (!recoveryCompactionSource
    || !Number.isInteger(Number(recoveryCompactionSource.rolloutOffset))
    || Number(recoveryCompactionSource.rolloutOffset) < 0) {
    throw new Error("Gate 8 resume requires a prior compaction report with a rollout offset");
  }
} else {
  formalPhase = "visible-journey";
  realTrafficMayHaveStarted = true;
  journeyRun = run(process.execPath, [
    humanJourneyScript,
    "--allow-real-traffic",
    "--journey", "messy-inventory-four-turn",
    "--model", model,
    "--timeout-ms", String(timeoutMs),
    "--report-root", reportRoot,
    "--keep-artifacts",
  ], { timeoutMs: timeoutMs * 14 + 900_000 });
  journeyPayload = journeyRun.parsed;
}
const journey = journeyPayload?.journeys?.find((entry) => entry?.id === "messy-inventory-four-turn") || {
  ok: false,
  usedRealTraffic: journeyPayload?.usedRealTraffic === true,
  turnCount: 0,
  passedTurnCount: 0,
  turns: [],
  editRounds: [],
  userCorrections: [],
  historyReopen: null,
  edgeRecovery: null,
  failures: [journeyRun?.stderrSummary || "visible journey produced no parseable report"],
};
const sourceFixtureRoot = journeyPayload?.fixtureRoot
  ? resolve(journeyPayload.fixtureRoot, "messy-inventory-four-turn")
  : "";
if (resumeExisting) {
  if (journey.ok !== true || journey.historyReopen?.threadId !== recoveryCompactionSource.threadId) {
    throw new Error("Gate 8 resume journey and compaction thread evidence do not match");
  }
  if (resolve(journey.historyReopen?.rolloutFile || "") !== resolve(recoveryCompactionSource.rolloutFile || "")) {
    throw new Error("Gate 8 resume journey and compaction rollout files do not match");
  }
  if (!sourceFixtureRoot || !existsSync(sourceFixtureRoot)
    || resolve(sourceFixtureRoot) !== resolve(recoveryCompactionSource.artifactDir || "")) {
    throw new Error("Gate 8 resume journey and compaction artifact directories do not match");
  }
}

let compaction = {
  ok: false,
  requestedRealTraffic: true,
  usedRealTraffic: false,
  longContextChars,
  compact_summary_length: 0,
  nativeCompactionObserved: false,
  threadId: journey.historyReopen?.threadId || "",
  followup: { ok: false, sameThread: false },
  failures: ["compaction skipped because the visible journey failed"],
};
let compactionRun = null;
if (journey.ok === true
  && journey.historyReopen?.threadId
  && journey.historyReopen?.rolloutFile
  && sourceFixtureRoot
  && existsSync(sourceFixtureRoot)) {
  formalPhase = "native-compaction";
  realTrafficMayHaveStarted = true;
  const compactionContextLogOffset = resumeExisting
    ? Number(recoveryCompactionSource.cppLogOffset || 0)
    : cppLogOffset;
  const compactionArgs = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", compactionScript,
    "-AllowRealTraffic",
    "-TimeoutSec", String(Math.ceil(timeoutMs / 1000)),
    "-LongContextChars", String(longContextChars),
    "-ThreadId", journey.historyReopen.threadId,
    "-RolloutFile", journey.historyReopen.rolloutFile,
    "-TitleContains", journey.historyReopen.titleNeedle,
    "-ExpectedMarker", journey.historyReopen.marker,
    "-ArtifactDir", sourceFixtureRoot,
    "-Model", model,
    "-CppLogOffset", String(compactionContextLogOffset),
    "-ReportRoot", reportRoot,
  ];
  if (resumeExisting) {
    compactionArgs.push("-ExistingCompactionOffset", String(recoveryCompactionSource.rolloutOffset));
  }
  compactionRun = run("powershell.exe", compactionArgs, { timeoutMs: 15 * 60_000 });
  compaction = compactionRun.parsed || {
    ...compaction,
    usedRealTraffic: true,
    failures: [compactionRun.stderrSummary || "compaction verifier produced no parseable report"],
  };
}

formalPhase = "host-result-verification";
const hostVerification = verifyFinalProject(sourceFixtureRoot);
let artifactRoot = sourceFixtureRoot;
if (journey.ok === true && sourceFixtureRoot && existsSync(sourceFixtureRoot)) {
  artifactRoot = resolve(reportRoot, `gate8-final-project-${runId}`);
  cpSync(sourceFixtureRoot, artifactRoot, { recursive: true, errorOnExist: true });
}
const artifacts = artifactManifest(artifactRoot);

const routeAfter = await fixedRouteHealth();
const oldRouteAfter = await fetchOldRouteFingerprint();
const processAfter = getProcessSnapshot();
const liveLegacyProcessCount = legacyProcessCount();
const logSegment = cppLogSegment(cppLogOffset);
const cppAudit = auditCodexPlusPlusLogSegment(logSegment.text);
if (logSegment.rotated) cppAudit.logRotatedDuringRun = true;

formalPhase = "report-publication";
const report = buildGate8Report({
  generatedAt: new Date().toISOString(),
  startedAt: startedAt.toISOString(),
  endedAt: new Date().toISOString(),
  model,
  routeBefore,
  routeAfter,
  oldRouteBefore,
  oldRouteAfter,
  journey,
  compaction,
  artifacts,
  tests: hostVerification.tests,
  processBefore,
  processAfter,
  legacyProcessCount: liveLegacyProcessCount,
  cppAudit,
  evidence: {
    releasePrecondition: precondition.report,
    journeyReport: journeyPayload?.report || null,
    journeyFailures: journey.failures || [],
    compactionReport: compaction?.report || null,
    compactionFailures: compaction.failures || [],
    artifactRoot,
    sourceFixtureRoot,
    cppLog: { path: cppLogPath, offset: logSegment.offset, end: logSegment.end, rotated: logSegment.rotated },
    routeBefore,
    routeAfter,
    accountBefore,
    modelCatalogBefore: {
      count: modelIds.length,
      selectedModel: model,
      selectedModelPresent: true,
    },
    quotaProbeBefore,
    oldRouteBefore,
    oldRouteAfter,
  },
});

return writeSignedReport(report);
}

try {
  const finalReport = await runFormalGate8();
  console.log(JSON.stringify(finalReport));
  process.exitCode = finalReport.ok ? 0 : 1;
} catch (error) {
  const failureMessage = compactText(error instanceof Error ? error.message : String(error), 1800)
    || "unexpected Gate 8 runner failure";
  const fallbackReport = {
    schema: "anticodex-gate8-final-long-task-v1",
    reportName: "gate8-final-long-task",
    gate: 8,
    ok: false,
    gateComplete: false,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    model: model || "fixed-route-unresolved",
    requestedRealTraffic: true,
    usedRealTraffic: realTrafficMayHaveStarted,
    longTaskStarted: realTrafficMayHaveStarted,
    behaviorCovered: false,
    coverageKind: "desktop-ui-real-antigravity-gate8",
    resultBasedVerification: false,
    failureStage: formalPhase,
    route: { fixed: false },
    artifacts: [],
    tests: [],
    interaction: {},
    continuity: {},
    recovery: {},
    processes: {},
    evidence: {
      unexpectedFailure: {
        name: error instanceof Error ? error.name : "Error",
        phase: formalPhase,
      },
    },
    failures: [`${formalPhase}: ${failureMessage}`],
  };
  try {
    const publishedFailure = writeSignedReport(fallbackReport);
    console.log(JSON.stringify(publishedFailure));
  } catch (reportError) {
    process.stderr.write(`Gate 8 failed before its fallback report could be published: ${compactText(reportError?.message || reportError)}\n`);
  }
  process.exitCode = 1;
}
