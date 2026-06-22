import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, "1");
  }
}

const baseUrl = String(args.get("--base-url") || "http://127.0.0.1:8484").replace(/\/+$/, "");
const defaultReportRoot = process.env.APPDATA
  ? join(process.env.APPDATA, "anticodex", "reports")
  : join(os.tmpdir(), "anticodex-reports");
const reportRoot = resolve(args.get("--report-root") || defaultReportRoot);
const timeoutMs = Math.max(3_000, Number(args.get("--timeout-ms") || 10_000));
const startedAt = Date.now();
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");

function writeTextAtomic(filePath, text, encoding = "utf8") {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, encoding);
    renameSync(tmp, filePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeHashSidecar(filePath) {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  writeTextAtomic(`${filePath}.sha256`, `sha256:${hash}`, "ascii");
}

function writeReport(payload) {
  const latest = join(reportRoot, "latest-missing-history.json");
  const history = join(reportRoot, `${stamp}-missing-history.json`);
  const text = JSON.stringify({ ...payload, report: { latest, history } }, null, 2);
  JSON.parse(text);
  writeTextAtomic(history, text);
  writeTextAtomic(latest, text);
  writeHashSidecar(history);
  writeHashSidecar(latest);
}

async function getJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

function routeFingerprint(payload) {
  return {
    count: Array.isArray(payload?.entries) ? payload.entries.length : 0,
    latestRequestId: String(payload?.latest?.requestId || ""),
    latestTransport: String(payload?.latest?.transport || ""),
    latestStatus: String(payload?.latest?.status || ""),
  };
}

let result;
try {
  const healthResult = await getJson("/health");
  assert.equal(healthResult.response.ok, true, "Anti-Codex health is not ready");
  const model = String(healthResult.json?.upstreamProfile?.model || healthResult.json?.profile || "");
  assert.ok(model, "Anti-Codex health did not expose an active model");

  const routeBeforeResult = await getJson("/anticodex/model-routes");
  assert.equal(routeBeforeResult.response.ok, true, "model route audit is unavailable before the probe");
  const routeBefore = routeFingerprint(routeBeforeResult.json);
  const missingId = `resp_missing_${randomUUID()}`;

  const missingResult = await getJson("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      previous_response_id: missingId,
      input: "continue unavailable local response history",
    }),
  });
  const error = missingResult.json?.error || {};
  const details = error.details || {};

  assert.equal(missingResult.response.status, 410);
  assert.equal(error.type, "response_history_missing");
  assert.equal(details.status, 410);
  assert.equal(details.retryable, false);
  assert.equal(details.previous_response_id, missingId);
  assert.match(String(error.message || ""), /Start a fresh request or reopen the original conversation context/);

  const routeAfterResult = await getJson("/anticodex/model-routes");
  assert.equal(routeAfterResult.response.ok, true, "model route audit is unavailable after the probe");
  const routeAfter = routeFingerprint(routeAfterResult.json);
  const noRouteChange = JSON.stringify(routeAfter) === JSON.stringify(routeBefore);
  assert.equal(noRouteChange, true, "missing-history probe changed model route evidence");

  result = {
    ok: true,
    reportName: "missing-history",
    behaviorCovered: true,
    coverageKind: "installed-no-traffic",
    usedRealTraffic: false,
    status: missingResult.response.status,
    errorType: error.type,
    retryable: details.retryable,
    previousResponseIdMatched: details.previous_response_id === missingId,
    recoveryGuidancePresent: /Start a fresh request or reopen the original conversation context/.test(String(error.message || "")),
    routeBefore,
    routeAfter,
    noRouteChange,
    model,
    elapsedMs: Date.now() - startedAt,
  };
} catch (error) {
  result = {
    ok: false,
    reportName: "missing-history",
    behaviorCovered: false,
    coverageKind: "failed",
    usedRealTraffic: false,
    failures: [String(error?.message || error || "missing-history verification failed")],
    elapsedMs: Date.now() - startedAt,
  };
}

writeReport(result);
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
