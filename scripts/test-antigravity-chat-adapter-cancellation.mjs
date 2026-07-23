import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  fetchOldRouteFingerprint,
  getProcessSnapshot,
  sameProcessRows,
} from "./lib/codexplusplus-antigravity-harness.mjs";
import { createAntigravityCascadeClient } from "../translator/provider/antigravity-cascade-client.mjs";
import { startAntigravityChatProvider } from "../translator/provider/start-antigravity-chat-provider.mjs";

const root = resolve(import.meta.dirname, "..");
const compact = process.argv.includes("--compact");
const allowRealTraffic = process.argv.includes("--allow-real-traffic");
const requestedModel = argumentValue("--model") || "gemini-3.5-flash-low";
const timeoutMs = positiveInteger(argumentValue("--timeout-ms"), 240_000);
const reportRootArg = argumentValue("--report-root") || argumentValue("-ReportRoot");
const auditRoot = resolve(root, "docs", "audits");
const formalReportPath = resolve(auditRoot, "2026-07-15-gate6-adapter-cancellation.json");
const readinessReportPath = resolve(auditRoot, "2026-07-15-gate6-adapter-cancellation-readiness.json");
let reportPath = allowRealTraffic ? formalReportPath : readinessReportPath;
let reportHistoryPath = null;
if (reportRootArg) {
  const reportRoot = resolve(reportRootArg);
  reportPath = resolve(reportRoot, "latest-cancellation.json");
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  reportHistoryPath = resolve(reportRoot, `${stamp}-cancellation.json`);
}
const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const recoveryMarker = `CANCEL_RECOVERY_OK_${runId}`;
const checks = [];
const serviceCalls = [];
const counters = { start: 0, resume: 0, cancel: 0 };
let provider = null;
let model = requestedModel;
let cancelledRequest = null;
let recovery = null;

function record(id, ok, detail = {}) {
  checks.push({ id, ...detail, ok: ok === true });
}

const processBefore = getProcessSnapshot();
const oldRouteBefore = await optionalOldRouteFingerprint();
let readOnly = { ok: false, skipped: true, reason: "real traffic was not requested", selectedModel: model };
if (allowRealTraffic) {
  try {
    const discovery = createAntigravityCascadeClient({ timeoutMs: 15_000 });
    const [models, readiness] = await Promise.all([
      discovery.listModels({ timeoutMs: 10_000 }),
      discovery.getReadiness({ timeoutMs: 10_000 }),
    ]);
    const modelIds = models.map((entry) => entry.id);
    if (!modelIds.includes(model)) model = modelIds[0] || model;
    readOnly = {
      ok: modelIds.length > 0 && readiness.signedIn === true,
      modelCount: modelIds.length,
      signedIn: readiness.signedIn,
      selectedModel: model,
    };
  } catch (error) {
    readOnly = { ok: false, error: String(error?.message ?? error), selectedModel: model };
  }
}
record("antigravity_read_only_ready", allowRealTraffic ? readOnly.ok : true, readOnly);

if (!allowRealTraffic) {
  record("real_cancellation_probe_authorized", true, {
    reason: "Report-only/summary mode. Real traffic probe skipped to prevent burning quota.",
  });
} else if (!readOnly.ok) {
  record("real_cancellation_probe_authorized", false, { reason: "Antigravity is not ready." });
} else {
  record("real_cancellation_probe_authorized", true, { model });
  try {
    const instrumentedFetch = async (url, options) => {
      const method = new URL(url).pathname.split("/").at(-1);
      const entry = { method, startedAt: new Date().toISOString(), status: null, error: null };
      serviceCalls.push(entry);
      try {
        const response = await fetch(url, options);
        entry.status = response.status;
        return response;
      } catch (error) {
        entry.error = String(error?.name ?? error);
        throw error;
      }
    };
    const baseClient = createAntigravityCascadeClient({ timeoutMs, fetchImpl: instrumentedFetch });
    const client = {
      listModels: (...values) => baseClient.listModels(...values),
      getReadiness: (...values) => baseClient.getReadiness(...values),
      start(request) {
        counters.start += 1;
        return baseClient.start(request);
      },
      resume(continuation, results, request) {
        counters.resume += 1;
        return baseClient.resume(continuation, results, request);
      },
      async cancel(continuation) {
        counters.cancel += 1;
        return baseClient.cancel(continuation);
      },
    };
    provider = await startAntigravityChatProvider({
      client,
      adapterOptions: { sessionTtlMs: timeoutMs, maxSessions: 4 },
    });

    const controller = new AbortController();
    const pending = fetch(`${provider.url}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.authToken}`,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: `Begin cancellation probe ${runId}. Continue reasoning until the client disconnects.`,
        }],
      }),
      signal: controller.signal,
    }).then(async (response) => ({
      resolved: true,
      status: response.status,
      body: await response.text(),
    })).catch((error) => ({
      resolved: false,
      name: String(error?.name ?? "Error"),
      message: String(error?.message ?? error),
    }));

    await waitFor(() => serviceCalls.some((entry) => (
      entry.method === "SendUserCascadeMessage" && entry.status === 200
    )), timeoutMs, "Cascade user message submission");
    controller.abort(new DOMException("Gate 6 client cancellation probe.", "AbortError"));
    cancelledRequest = await pending;
    await waitFor(() => serviceCalls.some((entry) => (
      entry.method === "CancelCascadeInvocation" && entry.status === 200
    )), 15_000, "real Cascade cancellation");

    const cancelCalls = serviceCalls.filter((entry) => entry.method === "CancelCascadeInvocation");
    record("client_abort_reached_real_cascade_cancel", cancelledRequest.resolved === false
      && cancelledRequest.name === "AbortError"
      && cancelCalls.length === 1
      && cancelCalls[0].status === 200, {
      cancelledRequest,
      cancelCalls,
    });
    record("cancelled_request_left_no_adapter_session", provider.adapter.sessionCount === 0, {
      sessionCount: provider.adapter.sessionCount,
    });

    recovery = await postJson(`${provider.url}/chat/completions`, {
      model,
      messages: [
        {
          role: "system",
          content: `This is a post-cancellation transport check. Answer exactly ${recoveryMarker} and nothing else.`,
        },
        { role: "user", content: "Return the required marker now." },
      ],
      tool_choice: "none",
    }, timeoutMs, provider.authToken);
    const recoveryText = String(recovery.body?.choices?.[0]?.message?.content ?? "").trim();
    record("fresh_request_after_cancel_has_no_stale_409", recovery.status === 200
      && recovery.body?.choices?.[0]?.finish_reason === "stop", {
      status: recovery.status,
      errorCode: recovery.body?.error?.code ?? null,
      finishReason: recovery.body?.choices?.[0]?.finish_reason,
      ...(recovery.status === 200 ? {} : { body: recovery.body }),
    });
    record("fresh_request_after_cancel_completes", recoveryText === recoveryMarker, {
      finalText: recoveryText,
      expected: recoveryMarker,
    });
    record("cancellation_did_not_enter_tool_session_path", counters.start === 2
      && counters.resume === 0
      && counters.cancel === 0, { counters });
  } catch (error) {
    record("real_cancellation_probe_completed", false, {
      error: String(error?.stack ?? error),
      counters,
      serviceCalls,
    });
  } finally {
    await provider?.close?.().catch(() => {});
  }
}

const processAfter = getProcessSnapshot();
const oldRouteAfter = await optionalOldRouteFingerprint();
record("desktop_roots_unchanged", sameProcessRows(processBefore.originalCodex, processAfter.originalCodex)
  && sameProcessRows(processBefore.antiCodexRoots, processAfter.antiCodexRoots), {
  before: processBefore,
  after: processAfter,
});
const oldRouteMatch = (oldRouteBefore.unavailable === true && oldRouteAfter.unavailable === true)
  || (oldRouteBefore.unavailable !== true
    && oldRouteAfter.unavailable !== true
    && oldRouteBefore.entriesSha256 === oldRouteAfter.entriesSha256);
record("background_probe_did_not_touch_old_route", oldRouteMatch, {
  oldRouteBefore,
  oldRouteAfter,
  providerUrl: provider?.url ?? null,
});

const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
const usedRealTraffic = serviceCalls.some((entry) => entry.method === "SendUserCascadeMessage" && entry.status === 200);
const cancelCovered = checks.find((check) => check.id === "client_abort_reached_real_cascade_cancel")?.ok === true;
const recoveryCovered = checks.find((check) => check.id === "fresh_request_after_cancel_completes")?.ok === true;
const behaviorCovered = allowRealTraffic && failedIds.length === 0 && cancelCovered && recoveryCovered;
const report = {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  gate: allowRealTraffic ? "Gate 6 client cancellation evidence" : "Gate 6 client cancellation readiness",
  ok: failedIds.length === 0,
  failedIds,
  modelTraffic: usedRealTraffic ? "one aborted and one bounded recovery Gemini turn" : "none",
  model,
  recoveryMarker,
  counters,
  serviceCalls,
  checks,

  // Compatible fields for release gate
  reportName: "cancellation",
  requestedRealTraffic: allowRealTraffic,
  usedRealTraffic,
  behaviorCovered,
  formalGateEvidence: behaviorCovered,
  coverageKind: allowRealTraffic ? "real-traffic" : "no-traffic",
  responseId: runId,
  cancelStatus: cancelCovered ? "cancelled" : (allowRealTraffic ? "failed" : "not-run"),
  cancelError: allowRealTraffic && !cancelCovered ? failedIds.join(",") || "cancellation_not_observed" : null,
  hasCancelled: cancelCovered,
  hasCompleted: false,
  hasFailed: allowRealTraffic && failedIds.length > 0,
  eventNames: cancelCovered ? ["client.abort", "cascade.cancelled"] : [],
  providerReady: readOnly.ok === true,
  preHealthReady: readOnly.ok === true,
  postHealthReady: readOnly.ok === true,
  mode: "antigravity",
};
mkdirSync(dirname(reportPath), { recursive: true });
const jsonText = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(reportPath, jsonText, "utf8");

// Generate .sha256 sidecar
const hash = createHash("sha256").update(jsonText).digest("hex");
writeFileSync(`${reportPath}.sha256`, `sha256:${hash}`, "ascii");

if (reportHistoryPath) {
  writeFileSync(reportHistoryPath, jsonText, "utf8");
  writeFileSync(`${reportHistoryPath}.sha256`, `sha256:${hash}`, "ascii");
}

process.stdout.write(`${JSON.stringify(compact ? {
  ok: report.ok,
  failedIds,
  model,
  cancellation: cancelledRequest,
  recoveryStatus: recovery?.status ?? null,
  serviceMethods: serviceCalls.map((entry) => `${entry.method}:${entry.status ?? entry.error}`),
  counters,
  reportPath,
} : report, null, compact ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;

async function postJson(url, body, requestTimeoutMs, authToken) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return { status: response.status, body: await response.json() };
}

async function optionalOldRouteFingerprint() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return { ...(await fetchOldRouteFingerprint()), unavailable: false, attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  return { unavailable: true, error: String(lastError?.message ?? lastError) };
}

async function waitFor(predicate, waitTimeoutMs, description) {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
