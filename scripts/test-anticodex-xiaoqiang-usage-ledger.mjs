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
const REQUIRED_FOUR_WORKER_PROJECT_PROOF = [
  { worker: "xiaoqiang1", jobId: "xqw_mr827db3_uu3kmt" },
  { worker: "xiaoqiang2", jobId: "xqw_mr818o4v_nc4767" },
  { worker: "xiaoqiang3", jobId: "xqw_mr81ur4n_0asegt" },
  { worker: "xiaoqiang4", jobId: "xqw_mr821q8h_uhxspf" },
];
const XIAOQIANG_PROJECT_REPORT = "latest-xiaoqiang-worker-mcp-project-smoke.json";

function parseArgs() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (key === "--help" || key === "-h") {
      console.log(`Usage: node scripts/test-anticodex-xiaoqiang-usage-ledger.mjs [options]

Verifies the no-traffic documentation ledger for forced xiaoqiang1/2/3/4 usage evidence.

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

function readJson(filePath) {
  if (!existsSync(filePath)) return { ok: false, exists: false, filePath, value: null, error: "" };
  try {
    return { ok: true, exists: true, filePath, value: JSON.parse(readFileSync(filePath, "utf8")), error: "" };
  } catch (error) {
    return { ok: false, exists: true, filePath, value: null, error: error instanceof Error ? error.message : String(error) };
  }
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

  const fourWorkerStatusEvidence = REQUIRED_FOUR_WORKER_PROJECT_PROOF.map((expected) => ({
    ...expected,
    presentInStatus: authoritativeStatusText.includes(expected.jobId) && authoritativeStatusText.includes(expected.worker),
  }));
  for (const evidence of fourWorkerStatusEvidence) {
    if (!evidence.presentInStatus) {
      addFailure(failures, "four_worker_project_job_id_missing", `Missing four-worker xiaoqiang project proof for ${evidence.worker} job ${evidence.jobId}.`, {
        worker: evidence.worker,
        jobId: evidence.jobId,
      });
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

  const projectReportPath = join(reportRoot, XIAOQIANG_PROJECT_REPORT);
  const projectReport = readJson(projectReportPath);
  const projectResults = Array.isArray(projectReport.value?.results) ? projectReport.value.results : [];
  const projectResultEvidence = REQUIRED_FOUR_WORKER_PROJECT_PROOF.map((expected) => {
    const result = projectResults.find((candidate) => candidate?.worker === expected.worker) || null;
    const cliJson = result?.workspaceVerification?.cliJson || {};
    const evidence = {
      ...expected,
      present: Boolean(result),
      ok: result?.ok === true,
      jobIdMatches: result?.jobId === expected.jobId,
      terminalCompleted: result?.terminalStatus === "completed",
      markerPresent: typeof result?.marker === "string" && result.marker.length > 0,
      workspaceVerificationOk: result?.workspaceVerification?.ok === true,
      doneTextMatches: result?.workspaceVerification?.doneTextMatches === true,
      testPassed: Number(result?.workspaceVerification?.testExitCode) === 0,
      cliPassed: Number(result?.workspaceVerification?.cliExitCode) === 0,
      cliJsonMatches: Number(cliJson.red) === 2 && Number(cliJson.blue) === 1,
    };
    if (!evidence.present) {
      addFailure(failures, "four_worker_project_result_missing", `Missing xiaoqiang-project result for ${expected.worker}.`, { worker: expected.worker });
      return evidence;
    }
    for (const [key, passed] of Object.entries({
      ok: evidence.ok,
      jobIdMatches: evidence.jobIdMatches,
      terminalCompleted: evidence.terminalCompleted,
      markerPresent: evidence.markerPresent,
      workspaceVerificationOk: evidence.workspaceVerificationOk,
      doneTextMatches: evidence.doneTextMatches,
      testPassed: evidence.testPassed,
      cliPassed: evidence.cliPassed,
      cliJsonMatches: evidence.cliJsonMatches,
    })) {
      if (!passed) {
        addFailure(failures, "four_worker_project_result_invalid", `Invalid xiaoqiang-project result for ${expected.worker}: ${key}.`, {
          worker: expected.worker,
          jobId: expected.jobId,
          field: key,
        });
      }
    }
    return evidence;
  });

  const fourWorkerProjectProof = {
    reportPath: projectReportPath,
    reportExists: projectReport.exists,
    reportParseable: projectReport.ok,
    reportError: projectReport.error,
    reportName: projectReport.value?.reportName || "",
    scenario: projectReport.value?.scenario || "",
    requestedRealTraffic: projectReport.value?.requestedRealTraffic === true,
    usedRealTraffic: projectReport.value?.usedRealTraffic === true,
    realTrafficEvidenceKind: typeof projectReport.value?.realTrafficEvidenceKind === "string" ? projectReport.value.realTrafficEvidenceKind : "local-worker-task",
    externalQuotaDecrementProven: projectReport.value?.externalQuotaDecrementProven === true,
    externalQuotaEvidence: typeof projectReport.value?.externalQuotaEvidence === "string" ? projectReport.value.externalQuotaEvidence : "not_collected",
    workerCount: Number(projectReport.value?.workerCount || 0),
    passedWorkerCount: Number(projectReport.value?.passedWorkerCount || 0),
    failedWorkers: Array.isArray(projectReport.value?.failedWorkers) ? projectReport.value.failedWorkers : [],
    statusJobIds: fourWorkerStatusEvidence,
    results: projectResultEvidence,
  };
  if (!projectReport.exists) {
    addFailure(failures, "four_worker_project_report_missing", `Missing ${XIAOQIANG_PROJECT_REPORT} in the report root.`, { reportPath: projectReportPath });
  } else if (!projectReport.ok) {
    addFailure(failures, "four_worker_project_report_unparseable", `Could not parse ${XIAOQIANG_PROJECT_REPORT}.`, { reportPath: projectReportPath, error: projectReport.error });
  } else {
    if (projectReport.value?.reportName !== "xiaoqiang-worker-mcp-project-smoke") {
      addFailure(failures, "four_worker_project_report_name", "Unexpected xiaoqiang project proof report name.", { reportName: projectReport.value?.reportName || "" });
    }
    if (projectReport.value?.scenario !== "xiaoqiang-project") {
      addFailure(failures, "four_worker_project_scenario", "Xiaoqiang project proof did not use the xiaoqiang-project scenario.", { scenario: projectReport.value?.scenario || "" });
    }
    if (Number(projectReport.value?.workerCount || 0) !== 4 || Number(projectReport.value?.passedWorkerCount || 0) !== 4) {
      addFailure(failures, "four_worker_project_count", "Xiaoqiang project proof did not pass exactly 4/4 workers.", {
        workerCount: Number(projectReport.value?.workerCount || 0),
        passedWorkerCount: Number(projectReport.value?.passedWorkerCount || 0),
      });
    }
    if (Array.isArray(projectReport.value?.failedWorkers) && projectReport.value.failedWorkers.length > 0) {
      addFailure(failures, "four_worker_project_failed_workers", "Xiaoqiang project proof contains failed workers.", { failedWorkers: projectReport.value.failedWorkers });
    }
  }

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
    fourWorkerProjectProof,
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
