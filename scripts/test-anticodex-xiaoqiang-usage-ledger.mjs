#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPORT_NAME = "xiaoqiang-usage-ledger";
const COVERAGE_KIND = "xiaoqiang-forced-usage-doc-ledger-no-traffic";
const REQUIRED_DOCS = [
  {
    id: "xq1",
    path: "docs/audits/2026-07-05-xiaoqiang1-post-diagnostics-review.md",
    marker: "XQ1_POST_DIAGNOSTICS_REVIEW_DONE",
    successJobId: "xqw_mr7tlcx1_c2wwvj",
    keywordPatterns: [/workerMcpComplexProjectSmokeEvidence/],
  },
  {
    id: "xq2",
    path: "docs/audits/2026-07-05-xiaoqiang2-release-proof-review.md",
    marker: "XQ2_RELEASE_PROOF_REVIEW_DONE",
    successJobId: "xqw_mr7tlnn6_m2kk5l",
    keywordPatterns: [/releaseReady/],
  },
  {
    id: "xq3",
    path: "docs/audits/2026-07-05-xiaoqiang3-worker-usage-review.md",
    marker: "XQ3_WORKER_USAGE_REVIEW_DONE",
    successJobId: "xqw_mr7ti03a_p1l0iy",
    keywordPatterns: [/job-id-bearing/i, /job ids/i],
  },
];
const REQUIRED_FAILED_JOB_IDS = ["xqw_mr7thgfo_d32uga", "xqw_mr7thq3o_915pb8"];
const REQUIRED_SUCCESS_JOB_IDS = REQUIRED_DOCS.map((doc) => doc.successJobId);

function parseArgs() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (key === "--help" || key === "-h") {
      console.log(`Usage: node scripts/test-anticodex-xiaoqiang-usage-ledger.mjs [options]

Verifies the no-traffic documentation ledger for forced xiaoqiang1/2/3 usage evidence.

Options:
  --repo-root <path>      Repository root to inspect (default: current working directory)
  --report-root <path>    Report output root (default: %APPDATA%/anticodex/reports, or temp fallback)
  --no-write-report       Print JSON only; do not write report files
  --help, -h              Show this help`);
      process.exit(0);
    }
    if (!key.startsWith("--")) continue;
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "1");
    }
  }
  return args;
}

function readText(repoRoot, relativePath) {
  const filePath = resolve(repoRoot, relativePath);
  if (!existsSync(filePath)) return { ok: false, filePath, text: "" };
  return { ok: true, filePath, text: readFileSync(filePath, "utf8") };
}

function writeTextAtomic(filePath, text, encoding = "utf8") {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text, encoding);
  renameSync(tmp, filePath);
}

function writeReport(payload, reportRoot) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const latest = join(reportRoot, `latest-${REPORT_NAME}.json`);
  const history = join(reportRoot, `${stamp}-${REPORT_NAME}.json`);
  const reportPaths = { latest, history };
  const body = `${JSON.stringify({ ...payload, report: reportPaths }, null, 2)}\n`;
  const sha = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  for (const file of [history, latest]) {
    writeTextAtomic(file, body);
    writeTextAtomic(`${file}.sha256`, sha, "ascii");
  }
  return reportPaths;
}

function addFailure(failures, code, message, details = {}) {
  failures.push({ code, message, ...details });
}

function main() {
  const args = parseArgs();
  const startedAt = Date.now();
  const repoRoot = resolve(args.get("--repo-root") || process.cwd());
  const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
  const noWriteReport = args.has("--no-write-report");
  const failures = [];

  const sourceStatusFiles = ["task_plan.md", "findings.md"].map((relativePath) => {
    const source = readText(repoRoot, relativePath);
    return {
      path: relativePath,
      exists: source.ok,
      text: source.text,
      bytes: Buffer.byteLength(source.text, "utf8"),
    };
  });

  const authoritativeStatusText = sourceStatusFiles
    .filter((source) => source.exists)
    .map((source) => source.text)
    .join("\n");

  if (!sourceStatusFiles.some((source) => source.exists)) {
    addFailure(failures, "status_files_missing", "Neither task_plan.md nor findings.md exists at the repository root.");
  }

  const failedJobEvidence = REQUIRED_FAILED_JOB_IDS.map((jobId) => ({
    jobId,
    presentInStatus: authoritativeStatusText.includes(jobId),
  }));
  for (const evidence of failedJobEvidence) {
    if (!evidence.presentInStatus) {
      addFailure(failures, "failed_job_id_missing", `Missing failed xiaoqiang job id ${evidence.jobId} in task_plan.md or findings.md.`, { jobId: evidence.jobId });
    }
  }

  const successfulJobEvidence = REQUIRED_SUCCESS_JOB_IDS.map((jobId) => ({
    jobId,
    presentInStatus: authoritativeStatusText.includes(jobId),
  }));
  for (const evidence of successfulJobEvidence) {
    if (!evidence.presentInStatus) {
      addFailure(failures, "success_job_id_missing", `Missing successful xiaoqiang job id ${evidence.jobId} in task_plan.md or findings.md.`, { jobId: evidence.jobId });
    }
  }

  const docEvidence = REQUIRED_DOCS.map((doc) => {
    const source = readText(repoRoot, doc.path);
    const markerPresent = source.text.includes(doc.marker);
    const matchedKeyword = doc.keywordPatterns.find((pattern) => pattern.test(source.text));
    const keywordPresent = Boolean(matchedKeyword);
    const evidence = {
      id: doc.id,
      path: doc.path,
      exists: source.ok,
      marker: doc.marker,
      markerPresent,
      statusJobId: doc.successJobId,
      keywordPresent,
      matchedKeyword: matchedKeyword ? String(matchedKeyword) : null,
      bytes: Buffer.byteLength(source.text, "utf8"),
    };

    if (!source.ok) {
      addFailure(failures, "audit_doc_missing", `Missing required audit document ${doc.path}.`, { id: doc.id, path: doc.path });
    }
    if (source.ok && !markerPresent) {
      addFailure(failures, "audit_doc_marker_missing", `Missing marker ${doc.marker} in ${doc.path}.`, { id: doc.id, path: doc.path, marker: doc.marker });
    }
    if (source.ok && !keywordPresent) {
      addFailure(failures, "audit_doc_domain_keyword_missing", `Missing required domain keyword in ${doc.path}.`, {
        id: doc.id,
        path: doc.path,
        expectedKeywords: doc.keywordPatterns.map((pattern) => String(pattern)),
      });
    }
    return evidence;
  });

  const payload = {
    ok: failures.length === 0,
    reportName: REPORT_NAME,
    noTraffic: true,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: COVERAGE_KIND,
    checkedAt: new Date().toISOString(),
    repoRoot,
    checkedStatusFiles: sourceStatusFiles.map(({ path, exists, bytes }) => ({ path, exists, bytes })),
    requiredFailedJobIds: failedJobEvidence,
    requiredSuccessJobIds: successfulJobEvidence,
    auditDocs: docEvidence,
    failures,
    elapsedMs: Date.now() - startedAt,
  };

  if (!noWriteReport) payload.report = writeReport(payload, reportRoot);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!payload.ok) process.exit(1);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
