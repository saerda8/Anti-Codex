#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const REPORT_NAME = "xiaoqiang-current-channel-live-proof";
const WORKERS = [
  {
    worker: "xiaoqiang1",
    files: ["done.txt", "package.json", "sum-even.mjs", "sum-even.test.mjs"],
    test: ["--test", "sum-even.test.mjs"],
    cli: ["sum-even.mjs", "1", "2", "3", "4"],
    expectedCli: "{\"sum\":6,\"count\":2}",
    marker: "XIAOQIANG1_LIVE_PROOF_20260707",
  },
  {
    worker: "xiaoqiang2",
    files: ["done.txt", "normalize-token.mjs", "normalize-token.test.mjs", "package.json"],
    test: ["--test", "normalize-token.test.mjs"],
    cli: ["normalize-token.mjs", " Hello, Anti Codex! "],
    expectedCli: "{\"token\":\"hello-anti-codex\"}",
    marker: "XIAOQIANG2_LIVE_PROOF_20260707",
  },
  {
    worker: "xiaoqiang3",
    files: ["bucket-count.mjs", "bucket-count.test.mjs", "done.txt", "package.json"],
    test: ["--test", "bucket-count.test.mjs"],
    cli: ["bucket-count.mjs", "red", "blue", "red", "green", "red"],
    expectedCli: "{\"red\":3,\"blue\":1,\"green\":1}",
    marker: "XIAOQIANG3_LIVE_PROOF_20260707",
  },
  {
    worker: "xiaoqiang4",
    files: ["done.txt", "package.json", "range-summary.mjs", "range-summary.test.mjs"],
    test: ["--test", "range-summary.test.mjs"],
    cli: ["range-summary.mjs", "2", "5"],
    expectedCli: "{\"start\":2,\"end\":5,\"count\":4,\"sum\":14}",
    marker: "XIAOQIANG4_LIVE_PROOF_20260707",
  },
];

function parseArgs() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    if (key === "--help" || key === "-h") {
      console.log(`Usage: node scripts/test-anticodex-xiaoqiang-current-channel-live-proof.mjs --workspace-root <path> [options]

Options:
  --workspace-root <path>   Root containing xiaoqiang1..xiaoqiang4 directories
  --job-ids <csv>           worker=job_id pairs for initial jobs
  --repair-job-ids <csv>    worker=job_id pairs for repair jobs
  --report-root <path>      Report output root (default: %APPDATA%/anticodex/reports)
  --no-write-report         Print JSON only`);
      process.exit(0);
    }
    if (!key.startsWith("--")) continue;
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, "1");
    }
  }
  return args;
}

function parsePairs(text) {
  const result = {};
  for (const part of String(text || "").split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = String(rawKey || "").trim();
    const value = String(rawValue || "").trim();
    if (key && value) result[key] = value;
  }
  return result;
}

function writeTextAtomic(filePath, text, encoding = "utf8") {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text, encoding);
  renameSync(tmp, filePath);
}

function writeSignedReport(payload, reportRoot) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const latest = join(reportRoot, `latest-${REPORT_NAME}.json`);
  const history = join(reportRoot, `${stamp}-${REPORT_NAME}.json`);
  const withReport = { ...payload, report: { latest, history } };
  const json = `${JSON.stringify(withReport, null, 2)}\n`;
  const hash = `sha256:${createHash("sha256").update(json).digest("hex")}`;
  for (const file of [history, latest]) {
    writeTextAtomic(file, json);
    writeTextAtomic(`${file}.sha256`, hash, "ascii");
  }
  return { latest, history };
}

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  return {
    command: `node ${args.join(" ")}`,
    exitCode: result.status,
    stdout: String(result.stdout || "").trim(),
    stderrTail: String(result.stderr || "").trim().slice(-500),
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function validateWorker(spec, workspaceRoot, jobIds, repairJobIds) {
  const dir = resolve(workspaceRoot, spec.worker);
  const actualFiles = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name).sort() : [];
  const expectedFiles = [...spec.files].sort();
  const missingFiles = expectedFiles.filter((file) => !actualFiles.includes(file));
  const extraFiles = actualFiles.filter((file) => !expectedFiles.includes(file));
  const donePath = join(dir, "done.txt");
  const doneText = existsSync(donePath) ? readFileSync(donePath, "utf8").trim() : "";
  const test = missingFiles.length === 0 ? runNode(spec.test, dir) : null;
  const cli = missingFiles.length === 0 ? runNode(spec.cli, dir) : null;
  const ok = existsSync(dir)
    && missingFiles.length === 0
    && extraFiles.length === 0
    && doneText === spec.marker
    && test?.exitCode === 0
    && cli?.exitCode === 0
    && cli?.stdout === spec.expectedCli;
  return {
    worker: spec.worker,
    jobId: jobIds[spec.worker] || "",
    repairJobId: repairJobIds[spec.worker] || "",
    workspacePresent: existsSync(dir),
    fileCount: actualFiles.length,
    expectedFiles,
    actualFiles,
    missingFiles,
    extraFiles,
    doneTextMatches: doneText === spec.marker,
    testExitCode: test?.exitCode ?? null,
    cliExitCode: cli?.exitCode ?? null,
    cliStdout: cli?.stdout || "",
    cliStdoutMatches: cli?.stdout === spec.expectedCli,
    ok,
  };
}

const args = parseArgs();
const startedAt = Date.now();
const workspaceRoot = resolve(args.get("--workspace-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "xiaoqiang-live-proof", "latest"));
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const jobIds = parsePairs(args.get("--job-ids"));
const repairJobIds = parsePairs(args.get("--repair-job-ids"));
const results = WORKERS.map((spec) => validateWorker(spec, workspaceRoot, jobIds, repairJobIds));
const failures = [];
for (const result of results) {
  if (!result.ok) failures.push(`${result.worker}_proof_invalid`);
}

const payload = {
  ok: failures.length === 0,
  reportName: REPORT_NAME,
  requestedRealTraffic: true,
  usedRealTraffic: true,
  realTrafficEvidenceKind: "local-worker-task",
  externalQuotaDecrementProven: false,
  externalQuotaEvidence: "not_collected",
  behaviorCovered: true,
  coverageKind: "current-channel-xiaoqiang-live-worker-projects",
  checkedAt: new Date().toISOString(),
  workspaceRoot,
  workerCount: WORKERS.length,
  passedWorkerCount: results.filter((item) => item.ok).length,
  initialJobIds: jobIds,
  repairJobIds,
  results,
  failures,
  elapsedMs: Date.now() - startedAt,
};

if (!args.has("--no-write-report")) {
  payload.report = writeSignedReport(payload, reportRoot);
}

console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
