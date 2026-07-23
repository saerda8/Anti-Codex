import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const reportPath = resolve(root, "docs", "audits", "2026-07-15-gate6-adapter-restart-recovery.json");
const validationRoot = resolve(
  process.env.LOCALAPPDATA || resolve(process.env.USERPROFILE || "C:\\Users\\XD", "AppData", "Local"),
  "Anti-Codex",
  "validation-artifacts",
);
const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const inputMarker = `RESTART_PROBE_INPUT_${runId}`;
const resultMarker = `RESTART_PROBE_FINAL_OK_${runId}`;
const exactToolResult = `HOST_EXECUTION_RESULT_${runId}\r\nexecution-count=1`;
const artifactPath = resolve(validationRoot, `gate6-adapter-restart-${runId}.txt`);
const checks = [];
const counters = { start: 0, resume: 0, cancel: 0 };
const requests = [];
let hostExecutionCount = 0;
let provider1 = null;
let provider2 = null;
let first = null;
let second = null;
let call = null;
let parsedArguments = null;
let hashBeforeRestart = "";
let hashAfterRestart = "";
let artifactBytes = 0;
let model = requestedModel;
let firstProviderUrl = "";
let secondProviderUrl = "";

function record(id, ok, detail = {}) {
  checks.push({ id, ok: ok === true, ...detail });
}

const processBefore = getProcessSnapshot();
let oldRouteBefore = null;
let oldRouteAfter = null;
try {
  oldRouteBefore = await fetchOldRouteFingerprint();
} catch (error) {
  oldRouteBefore = { unavailable: true, error: String(error?.message ?? error) };
}

let readOnly = null;
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
    modelIds,
    signedIn: readiness.signedIn,
    selectedModel: model,
  };
} catch (error) {
  readOnly = { ok: false, error: String(error?.message ?? error), selectedModel: model };
}
record("antigravity_read_only_ready", readOnly.ok, readOnly);

if (!allowRealTraffic) {
  record("real_restart_probe_authorized", false, {
    reason: "Pass --allow-real-traffic to run the bounded two-turn Gemini recovery probe.",
  });
} else if (!readOnly.ok) {
  record("real_restart_probe_authorized", false, { reason: "Antigravity read-only discovery is not ready." });
} else {
  record("real_restart_probe_authorized", true, { model });
  try {
    const firstClient = instrumentClient("before_restart");
    provider1 = await startAntigravityChatProvider({
      client: firstClient,
      adapterOptions: { sessionTtlMs: timeoutMs, maxSessions: 4 },
    });
    firstProviderUrl = provider1.url;

    const system = [
      "This is a bounded adapter restart recovery verification.",
      `Call restart_probe exactly once with {\"value\":\"${inputMarker}\"}.`,
      "Do not claim a result before the tool response.",
      "If the transcript already contains the completed restart_probe result, never call the tool again.",
      `After the tool response, answer exactly ${resultMarker} and nothing else.`,
    ].join(" ");
    const tools = [{
      type: "function",
      function: {
        name: "restart_probe",
        description: "Records one exact host-side execution for adapter restart verification.",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    }];
    const firstBody = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Begin the restart_probe verification with ${inputMarker}.` },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "restart_probe" } },
    };
    first = await postJson(`${provider1.url}/chat/completions`, firstBody, timeoutMs, provider1.authToken);
    const toolCalls = first.body?.choices?.[0]?.message?.tool_calls ?? [];
    call = toolCalls[0] ?? null;
    try {
      parsedArguments = JSON.parse(call?.function?.arguments ?? "null");
    } catch {}
    const exactFirstCall = first.status === 200
      && first.body?.choices?.[0]?.finish_reason === "tool_calls"
      && toolCalls.length === 1
      && call?.function?.name === "restart_probe"
      && parsedArguments?.value === inputMarker;
    record("first_turn_exact_single_tool_call", exactFirstCall, {
      status: first.status,
      finishReason: first.body?.choices?.[0]?.finish_reason,
      toolCallCount: toolCalls.length,
      toolName: call?.function?.name,
      exactArguments: parsedArguments?.value === inputMarker,
      ...(exactFirstCall ? {} : { body: first.body }),
    });
    if (!exactFirstCall) throw new Error("The first turn did not return the exact single restart_probe call.");

    mkdirSync(validationRoot, { recursive: true });
    hostExecutionCount += 1;
    writeFileSync(artifactPath, exactToolResult, { encoding: "utf8", flag: "wx" });
    hashBeforeRestart = sha256(readFileSync(artifactPath));
    artifactBytes = statSync(artifactPath).size;

    const port = Number(new URL(provider1.url).port);
    await provider1.close();
    provider1 = null;

    const secondClient = instrumentClient("after_restart");
    provider2 = await startAntigravityChatProvider({
      client: secondClient,
      host: "127.0.0.1",
      port,
      adapterOptions: { sessionTtlMs: timeoutMs, maxSessions: 4 },
    });
    secondProviderUrl = provider2.url;
    const secondBody = {
      model,
      messages: [
        ...firstBody.messages,
        first.body.choices[0].message,
        { role: "tool", tool_call_id: call.id, content: exactToolResult },
      ],
      tools,
      tool_choice: "none",
    };
    second = await postJson(`${provider2.url}/chat/completions`, secondBody, timeoutMs, provider2.authToken);
    const finalMessage = second.body?.choices?.[0]?.message ?? {};
    const finalText = String(finalMessage.content ?? "").trim();
    const repeatedToolCalls = Array.isArray(finalMessage.tool_calls) ? finalMessage.tool_calls.length : 0;
    hashAfterRestart = sha256(readFileSync(artifactPath));

    record("restart_continuation_avoids_409", second.status === 200, {
      status: second.status,
      errorCode: second.body?.error?.code ?? null,
      ...(second.status === 200 ? {} : { body: second.body }),
    });
    record("completed_tool_not_replayed", repeatedToolCalls === 0 && hostExecutionCount === 1, {
      repeatedToolCalls,
      hostExecutionCount,
    });
    record("restart_returns_exact_final_result", second.status === 200
      && second.body?.choices?.[0]?.finish_reason === "stop"
      && finalText === resultMarker, {
      finishReason: second.body?.choices?.[0]?.finish_reason,
      finalText,
      expected: resultMarker,
    });
    record("host_artifact_written_once_and_unchanged", hostExecutionCount === 1
      && hashBeforeRestart === hashAfterRestart, {
      hostExecutionCount,
      artifactPath,
      artifactBytes,
      sha256BeforeRestart: hashBeforeRestart,
      sha256AfterRestart: hashAfterRestart,
    });
    record("adapter_restarted_instead_of_resuming_stale_session", counters.start === 2
      && counters.resume === 0
      && counters.cancel === 1, { counters, requests });
  } catch (error) {
    record("real_restart_recovery_completed", false, {
      error: String(error?.stack ?? error),
      firstStatus: first?.status ?? null,
      secondStatus: second?.status ?? null,
      counters,
    });
  } finally {
    await provider1?.close?.().catch(() => {});
    await provider2?.close?.().catch(() => {});
  }
}

const processAfter = getProcessSnapshot();
try {
  oldRouteAfter = await fetchOldRouteFingerprint();
} catch (error) {
  oldRouteAfter = { unavailable: true, error: String(error?.message ?? error) };
}
record("desktop_roots_unchanged", sameProcessRows(processBefore.originalCodex, processAfter.originalCodex)
  && sameProcessRows(processBefore.antiCodexRoots, processAfter.antiCodexRoots), {
  before: processBefore,
  after: processAfter,
});
record("probe_used_background_loopback_only", firstProviderUrl !== ""
  && secondProviderUrl !== ""
  && new URL(firstProviderUrl).port !== "8484"
  && new URL(secondProviderUrl).port !== "8484", {
  firstProviderUrl,
  secondProviderUrl,
  oldRouteBefore,
  oldRouteAfter,
  oldRouteFingerprintUnchanged: JSON.stringify(oldRouteBefore) === JSON.stringify(oldRouteAfter),
});

const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
const report = {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  gate: "Gate 6 adapter restart recovery edge",
  ok: failedIds.length === 0,
  failedIds,
  modelTraffic: allowRealTraffic ? "two bounded Gemini turns" : "none",
  model,
  markers: { inputMarker, resultMarker },
  artifact: artifactPath ? {
    path: artifactPath,
    bytes: artifactBytes,
    sha256: hashAfterRestart || hashBeforeRestart,
    hostExecutionCount,
  } : null,
  counters,
  providerUrls: { beforeRestart: firstProviderUrl, afterRestart: secondProviderUrl },
  checks,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(compact ? {
  ok: report.ok,
  failedIds,
  model,
  artifact: report.artifact,
  counters,
  statuses: { first: first?.status ?? null, second: second?.status ?? null },
  reportPath,
} : report, null, compact ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;

function instrumentClient(label) {
  const base = createAntigravityCascadeClient({ timeoutMs });
  return {
    listModels: (...values) => base.listModels(...values),
    getReadiness: (...values) => base.getReadiness(...values),
    start(request) {
      counters.start += 1;
      requests.push({ label, operation: "start", toolCount: request?.tools?.length ?? 0 });
      return base.start(request);
    },
    resume(continuation, results, request) {
      counters.resume += 1;
      requests.push({ label, operation: "resume", resultCount: results?.length ?? 0 });
      return base.resume(continuation, results, request);
    },
    async cancel(continuation) {
      counters.cancel += 1;
      requests.push({ label, operation: "cancel" });
      return base.cancel(continuation);
    },
  };
}

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
