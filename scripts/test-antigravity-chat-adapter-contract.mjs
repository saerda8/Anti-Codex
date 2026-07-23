import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createAntigravityCascadeClient } from "../translator/provider/antigravity-cascade-client.mjs";
import { startAntigravityChatProvider } from "../translator/provider/start-antigravity-chat-provider.mjs";
import { createCurrentReleaseBinding } from "./lib/anticodex-release-binding.mjs";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const args = new Set(argv);
const allowRealTraffic = args.has("--allow-real-traffic");
const compact = args.has("--compact");
const offlineFixture = args.has("--offline-fixture");
const reportRoot = resolve(optionValue("--report-root") || resolve(root, "docs", "audits"));
const releaseReportRoot = resolve(
  optionValue("--release-report-root")
    || resolve(process.env.APPDATA || ".", "anticodex", "reports"),
);
const formalReportPath = resolve(reportRoot, "2026-07-14-antigravity-chat-adapter-contract.json");
const readinessReportPath = resolve(reportRoot, "2026-07-14-antigravity-chat-adapter-readiness.json");
const reportPath = allowRealTraffic ? formalReportPath : readinessReportPath;
const providerPaths = [
  "translator/provider/antigravity-chat-adapter.mjs",
  "translator/provider/antigravity-chat-server.mjs",
  "translator/provider/antigravity-cascade-client.mjs",
  "translator/provider/start-antigravity-chat-provider.mjs",
];
const testPaths = [
  "translator/tests/antigravity-chat-adapter.test.mjs",
  "translator/tests/antigravity-chat-server.test.mjs",
  "translator/tests/antigravity-cascade-client.test.mjs",
];
const checks = [];
const childTestEnv = { ...process.env };
delete childTestEnv.NODE_TEST_CONTEXT;

function record(id, ok, detail = {}) {
  checks.push({ id, ok: ok === true, ...detail });
}

const releaseBinding = createCurrentReleaseBinding({ sourceRoot: root, reportRoot: releaseReportRoot });
record("current_release_binding_available", releaseBinding.valid === true, { releaseBinding });

const syntax = providerPaths.map((path) => {
  const result = spawnSync(process.execPath, ["--check", path], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  return { path, ok: result.status === 0, stderr: result.stderr.trim() };
});
record("provider_syntax", syntax.every((item) => item.ok), { files: syntax });

const testRun = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testPaths], {
  cwd: root,
  encoding: "utf8",
  env: childTestEnv,
  timeout: 60000,
});
const testCounts = parseTapCounts(testRun.stdout);
record("deterministic_contract_tests", testRun.status === 0 && testCounts.fail === 0 && testCounts.tests >= 18, {
  exitCode: testRun.status,
  ...testCounts,
  stderr: testRun.stderr.trim(),
});

const forbiddenImport = /from\s+["']\.\.\/(?:adaptive-server|server|antigravity-upstream|codex-native-(?:harness-turn|protocol|sse|compact)|response-history)\.mjs["']/;
const forbiddenSemantics = /internalDeterministicTasks|runInternalToolLoop|synthesizeDeterministicTask|buildVerificationRecoveryMessages/;
const sources = providerPaths.map((path) => {
  const content = readFileSync(resolve(root, path), "utf8");
  return {
    path,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    forbiddenImport: forbiddenImport.test(content),
    forbiddenSemantics: forbiddenSemantics.test(content),
  };
});
record("legacy_import_zero_hit", sources.every((item) => !item.forbiddenImport), { sources });
record("task_semantics_zero_hit", sources.every((item) => !item.forbiddenSemantics));
record("provider_boundary_small", sources.reduce((sum, item) => sum + item.bytes, 0) < 100_000, {
  totalBytes: sources.reduce((sum, item) => sum + item.bytes, 0),
});

let readOnlyProbe;
if (offlineFixture) {
  readOnlyProbe = {
    ok: true,
    modelCount: 1,
    modelIds: ["fixture-model"],
    signedIn: true,
    identityAvailable: true,
    planName: "Fixture",
  };
} else try {
  const client = createAntigravityCascadeClient({ timeoutMs: 15000 });
  const [models, readiness] = await Promise.all([
    client.listModels({ timeoutMs: 10000 }),
    client.getReadiness({ timeoutMs: 10000 }),
  ]);
  readOnlyProbe = {
    ok: models.length > 0 && readiness.signedIn === true,
    modelCount: models.length,
    modelIds: models.map((model) => model.id),
    signedIn: readiness.signedIn,
    identityAvailable: Boolean(readiness.accountFingerprint),
    planName: readiness.planName,
  };
} catch (error) {
  readOnlyProbe = { ok: false, error: String(error?.message ?? error) };
}
record("real_desktop_read_only_discovery", readOnlyProbe.ok, readOnlyProbe);

let realTraffic = {
  requested: allowRealTraffic,
  used: false,
  ok: !allowRealTraffic,
  reason: allowRealTraffic ? "not_started" : "not_requested",
};
if (allowRealTraffic && releaseBinding.valid) {
  realTraffic = await runRealToolRoundTrip();
  record("real_native_tool_round_trip", realTraffic.ok, realTraffic);
} else if (allowRealTraffic) {
  realTraffic = {
    requested: true,
    used: false,
    ok: false,
    reason: "current_release_binding_unavailable",
  };
  record("real_native_tool_round_trip", false, realTraffic);
}

const failedIds = checks.filter((check) => !check.ok).map((check) => check.id);
const report = {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  gate: "Gate 3 thin Antigravity Chat adapter contract",
  ok: failedIds.length === 0,
  failedIds,
  requestedRealTraffic: allowRealTraffic,
  usedRealTraffic: realTraffic.used === true,
  behaviorCovered: allowRealTraffic && realTraffic.ok === true,
  formalGateEvidence: allowRealTraffic && realTraffic.ok === true,
  coverageKind: allowRealTraffic ? "real-traffic" : "no-traffic",
  modelTraffic: allowRealTraffic ? "one bounded real native tool round trip" : "none",
  checks,
  readOnlyProbe,
  realTraffic,
  providerSources: sources,
  releaseBinding,
  workerReview: {
    jobId: "ag-8132d815-31ef-4895-a55d-453bdcdef9d2",
    accepted: [
      "standalone loopback Chat server",
      "structured Cascade mapping",
      "native MCP exact-result continuation",
      "connection rediscovery only for read-only discovery",
    ],
    rejected: [
      "prompt-marker assistant selection",
      "old response-id request registry",
      "any task retry or completion policy",
    ],
  },
};

mkdirSync(dirname(reportPath), { recursive: true });
const reportBody = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(reportPath, reportBody, "utf8");
if (allowRealTraffic && report.ok) {
  writeFileSync(
    `${reportPath}.sha256`,
    `sha256:${createHash("sha256").update(reportBody).digest("hex")}`,
    "ascii",
  );
} else {
  rmSync(`${reportPath}.sha256`, { force: true });
}
process.stdout.write(`${JSON.stringify(compact ? {
  ok: report.ok,
  failedIds,
  tests: testCounts,
  readOnly: readOnlyProbe,
  realTraffic,
  reportPath,
} : report, null, compact ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;

async function runRealToolRoundTrip() {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const inputMarker = `REAL_ADAPTER_TOOL_INPUT_${runId}`;
  const resultMarker = `REAL_ADAPTER_TOOL_RESULT_OK_${runId}`;
  const exactToolResult = `HOST_RESULT_${runId}\r\nsecond-line`;
  const counters = { start: 0, resume: 0, cancel: 0 };
  const observedResults = [];
  const baseClient = createAntigravityCascadeClient({ timeoutMs: 180000 });
  const client = {
    listModels: (...values) => baseClient.listModels(...values),
    getReadiness: (...values) => baseClient.getReadiness(...values),
    start(request) {
      counters.start += 1;
      return baseClient.start(request);
    },
    resume(continuation, results, request) {
      counters.resume += 1;
      observedResults.push(...results.map((result) => ({ ...result })));
      return baseClient.resume(continuation, results, request);
    },
    async cancel(continuation) {
      counters.cancel += 1;
      return baseClient.cancel(continuation);
    },
  };
  let provider;
  try {
    provider = await startAntigravityChatProvider({
      client,
      adapterOptions: { sessionTtlMs: 180000, maxSessions: 8 },
    });
    const model = readOnlyProbe.modelIds.includes("gemini-3.5-flash-low")
      ? "gemini-3.5-flash-low"
      : readOnlyProbe.modelIds[0];
    const system = [
      "This is a bounded protocol verification.",
      `Call echo_probe exactly once with {\"value\":\"${inputMarker}\"}.`,
      "Do not claim a result before the tool response.",
      `After the tool response, answer exactly ${resultMarker} and nothing else.`,
    ].join(" ");
    const tools = [{
      type: "function",
      function: {
        name: "echo_probe",
        description: "Returns one exact host-provided string for protocol verification.",
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
        { role: "user", content: `Begin the echo_probe verification with ${inputMarker}.` },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "echo_probe" } },
    };
    const first = await postJson(`${provider.url}/chat/completions`, firstBody, 180000, provider.authToken);
    const toolCalls = first.body?.choices?.[0]?.message?.tool_calls ?? [];
    const call = toolCalls[0];
    let parsedArguments = null;
    try {
      parsedArguments = JSON.parse(call?.function?.arguments ?? "null");
    } catch {}
    if (first.status !== 200 || first.body?.choices?.[0]?.finish_reason !== "tool_calls"
        || toolCalls.length !== 1 || call?.function?.name !== "echo_probe"
        || parsedArguments?.value !== inputMarker) {
      return {
        requested: true,
        used: true,
        ok: false,
        reason: "model_did_not_return_exact_tool_call",
        model,
        firstStatus: first.status,
        firstBody: first.body,
        counters,
      };
    }
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
    const second = await postJson(`${provider.url}/chat/completions`, secondBody, 180000, provider.authToken);
    const finalText = String(second.body?.choices?.[0]?.message?.content ?? "").trim();
    const exactResume = observedResults.length === 1
      && observedResults[0].callId === call.id
      && observedResults[0].output === exactToolResult
      && observedResults[0].isError === false;
    const ok = second.status === 200
      && second.body?.choices?.[0]?.finish_reason === "stop"
      && finalText === resultMarker
      && counters.start === 1
      && counters.resume === 1
      && counters.cancel === 0
      && exactResume;
    return {
      requested: true,
      used: true,
      ok,
      reason: ok ? "passed" : "final_or_resume_mismatch",
      model,
      inputMarker,
      resultMarker,
      firstStatus: first.status,
      secondStatus: second.status,
      firstFinishReason: first.body?.choices?.[0]?.finish_reason,
      secondFinishReason: second.body?.choices?.[0]?.finish_reason,
      ...(second.status === 200 ? {} : { secondBody: second.body }),
      toolName: call?.function?.name,
      toolCallId: call?.id,
      exactArguments: parsedArguments?.value === inputMarker,
      exactToolResultObserved: exactResume,
      finalText,
      counters,
    };
  } catch (error) {
    return {
      requested: true,
      used: true,
      ok: false,
      reason: "exception",
      error: String(error?.stack ?? error),
      counters,
    };
  } finally {
    await provider?.close?.().catch(() => {});
  }
}

async function postJson(url, body, timeoutMs, authToken) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.json() };
}

function parseTapCounts(output) {
  const value = String(output ?? "");
  const number = (name) => Number(value.match(new RegExp(`# ${name} (\\d+)`))?.[1] ?? 0);
  return { tests: number("tests"), pass: number("pass"), fail: number("fail") };
}

function optionValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] ?? "") : "";
}
