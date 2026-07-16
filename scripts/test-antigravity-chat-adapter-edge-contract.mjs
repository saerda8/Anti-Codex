import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compact = process.argv.includes("--compact");
const formalMode = process.argv.includes("--formal");
const reportPath = resolve(root, "docs", "audits", formalMode
  ? "2026-07-15-gate6-edge-matrix.json"
  : "2026-07-15-gate6-preparatory-edge-matrix.json");
const gate5ReportPath = resolve(root, "docs", "audits", "2026-07-15-gate5-visible-integration.json");
const restartReportPath = resolve(root, "docs", "audits", "2026-07-15-gate6-adapter-restart-recovery.json");
const cancellationReportPath = resolve(root, "docs", "audits", "2026-07-15-gate6-adapter-cancellation.json");
const clientRestartReportPath = resolve(root, "docs", "audits", "2026-07-15-gate6-client-restart-resume.json");
const testPaths = [
  "translator/tests/antigravity-cascade-client.test.mjs",
  "translator/tests/antigravity-chat-adapter.test.mjs",
  "translator/tests/antigravity-chat-server.test.mjs",
  "translator/tests/antigravity-native-mcp-bridge.test.mjs",
  "translator/tests/codexplusplus-antigravity-harness.test.mjs",
];
const syntaxPaths = [
  "translator/provider/antigravity-chat-adapter.mjs",
  "scripts/lib/codexplusplus-antigravity-harness.mjs",
  "scripts/test-antigravity-chat-adapter-restart-recovery.mjs",
  "scripts/test-antigravity-chat-adapter-cancellation.mjs",
  "scripts/test-codexplusplus-antigravity-client-restart.mjs",
];
const checks = [];

function record(id, ok, detail = {}) {
  checks.push({ id, ok: ok === true, ...detail });
}

if (formalMode) {
  const gate5 = readSignedJsonReport(gate5ReportPath);
  record("gate5_visible_integration_signed", gate5.signed === true
    && gate5.data?.ok === true
    && gate5.data?.gateComplete === true
    && gate5.data?.sourceEvidenceUsedRealTraffic === true
    && gate5.data?.checks?.every((check) => check.ok === true), {
    path: gate5ReportPath,
    sha256: gate5.sha256,
    signed: gate5.signed,
    checkCount: gate5.data?.checks?.length ?? 0,
    failedIds: gate5.data?.failures ?? (gate5.error ? [gate5.error] : []),
  });
}

const syntax = syntaxPaths.map((path) => {
  const result = spawnSync(process.execPath, ["--check", path], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { path, ok: result.status === 0, stderr: result.stderr.trim() };
});
record("changed_boundary_syntax", syntax.every((entry) => entry.ok), { files: syntax });

const tests = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testPaths], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
});
const counts = tapCounts(tests.stdout);
const missingTestPaths = testPaths.filter((path) => !existsSync(resolve(root, path)));
record("provider_edge_regression_suite", missingTestPaths.length === 0
  && tests.status === 0
  && counts.tests >= 36
  && counts.fail === 0, {
  exitCode: tests.status,
  missingTestPaths,
  ...counts,
  stderr: tests.stderr.trim(),
});

const requiredTests = {
  quota_no_retry: "maps authentication, quota, network and timeout failures without retrying",
  abort_propagation: "aborted requests reach the Cascade client and emit no terminal chunk",
  parallel_results_complete: "parallel tool continuation requires every result from one pending Cascade",
  malformed_arguments_cancel: "malformed Cascade tool arguments fail closed and cancel the opaque continuation",
  malformed_http_shape: "malformed native tool arguments return a structured 502 and cancel the continuation",
  tool_failure_exact_result: "failed host tool output is preserved exactly for the same Cascade recovery",
  restart_no_replay: "adapter restart continues from complete Chat tool history without replaying the tool",
  visible_launch_guard: "visible candidate launch requires approval and no active Anti-Codex root",
};
for (const [id, name] of Object.entries(requiredTests)) {
  record(`deterministic_${id}`, tests.stdout.includes(name), { testName: name });
}

const restart = readJsonReport(restartReportPath);
record("real_adapter_restart_no_duplicate", restart.ok === true
  && restart.counters?.start === 2
  && restart.counters?.resume === 0
  && restart.counters?.cancel === 1
  && restart.artifact?.hostExecutionCount === 1
  && restart.checks?.every((check) => check.ok === true), {
  generatedAtUtc: restart.generatedAtUtc ?? null,
  counters: restart.counters ?? null,
  artifact: restart.artifact ?? null,
  failedIds: restart.failedIds ?? null,
});

const cancellation = readJsonReport(cancellationReportPath);
const realCancelCalls = cancellation.serviceCalls?.filter((entry) => (
  entry.method === "CancelCascadeInvocation" && entry.status === 200
)) ?? [];
record("real_client_abort_cancel_and_recover", cancellation.ok === true
  && realCancelCalls.length === 1
  && cancellation.counters?.start === 2
  && cancellation.counters?.resume === 0
  && cancellation.requestedRealTraffic === true
  && cancellation.usedRealTraffic === true
  && cancellation.behaviorCovered === true
  && cancellation.formalGateEvidence === true
  && cancellation.checks?.every((check) => check.ok === true), {
  generatedAtUtc: cancellation.generatedAtUtc ?? null,
  realCancelCallCount: realCancelCalls.length,
  counters: cancellation.counters ?? null,
  failedIds: cancellation.failedIds ?? null,
});

const clientRestart = readJsonReport(clientRestartReportPath);
record("real_copied_client_crash_same_task_resume", clientRestart.ok === true
  && clientRestart.thread?.initialTimedOut === true
  && clientRestart.thread?.resumeExitCode === 0
  && clientRestart.thread?.initialId === clientRestart.thread?.resumedId
  && clientRestart.exactlyOnce?.countBeforeResume === 1
  && clientRestart.exactlyOnce?.countAfterResume === 1
  && clientRestart.exactlyOnce?.markerHashBeforeResume === clientRestart.exactlyOnce?.markerHashAfterResume
  && clientRestart.checks?.every((check) => check.ok === true), {
  generatedAtUtc: clientRestart.generatedAtUtc ?? null,
  thread: clientRestart.thread ?? null,
  exactlyOnce: clientRestart.exactlyOnce ?? null,
  artifact: clientRestart.artifact ?? null,
  failedIds: clientRestart.failedIds ?? null,
});

const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
const formalGateAdvanced = formalMode && failedIds.length === 0;
const reportRoot = resolve(process.env.APPDATA || os.tmpdir(), "anticodex", "reports");
const latestPath = formalMode ? resolve(reportRoot, "latest-gate6-edge-matrix.json") : null;
const historyPath = formalMode ? resolve(reportRoot, `${utcStamp()}-gate6-edge-matrix.json`) : null;
const report = {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  gate: formalMode ? "Gate 6 edge and recovery matrix" : "Gate 6 preparatory edge evidence",
  ok: failedIds.length === 0,
  failedIds,
  modelTraffic: "none; consumes existing accepted real reports",
  formalGateAdvanced,
  blockedBy: formalGateAdvanced ? null : (formalMode ? "failed Gate 5 or Gate 6 evidence checks" : "formal mode not requested"),
  checks,
  report: {
    audit: reportPath,
    latest: latestPath,
    history: historyPath,
  },
};
mkdirSync(dirname(reportPath), { recursive: true });
const reportBody = `${JSON.stringify(report, null, 2)}\n`;
writeSignedReport(reportPath, reportBody);
if (formalMode) {
  writeSignedReport(latestPath, reportBody);
  writeSignedReport(historyPath, reportBody);
}
process.stdout.write(`${JSON.stringify(compact ? {
  ok: report.ok,
  failedIds,
  tests: counts,
  checkCount: checks.length,
  formalGateAdvanced,
  reportPath,
} : report, null, compact ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;

function readJsonReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, readError: String(error?.message ?? error), path };
  }
}

function readSignedJsonReport(path) {
  try {
    const bytes = readFileSync(path);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const sidecarPath = `${path}.sha256`;
    const sidecar = existsSync(sidecarPath) ? readFileSync(sidecarPath, "ascii").trim() : "";
    return {
      data: JSON.parse(bytes.toString("utf8")),
      sha256: sha,
      signed: sidecar === `sha256:${sha}` || sidecar === sha,
    };
  } catch (error) {
    return { data: null, sha256: "", signed: false, error: String(error?.message ?? error) };
  }
}

function writeSignedReport(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  writeFileSync(`${path}.sha256`, `sha256:${createHash("sha256").update(body).digest("hex")}`, "ascii");
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

function tapCounts(output) {
  const text = String(output ?? "");
  const count = (name) => Number(text.match(new RegExp(`# ${name} (\\d+)`))?.[1] ?? 0);
  return { tests: count("tests"), pass: count("pass"), fail: count("fail") };
}
