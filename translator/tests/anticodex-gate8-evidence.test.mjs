import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditCodexPlusPlusLogSegment,
  buildGate8Report,
  countDuplicateCommands,
  countTurnStaleConflicts,
  createTerminalProviderStopGate,
  detectNativeCompactionEvidence,
  evaluateHistoryReopenEvidence,
  failedLaunchEvidenceProvesSingleAttempt,
  fetchJsonWithRetry,
  allowMigrationIdempotencyDuplicate,
  retainJourneyTurnEvidence,
} from "../../scripts/lib/anticodex-gate8-evidence.mjs";

test("real human journeys use the canonical current fixed-route model before traffic", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  assert.equal(typeof module.resolveFixedRouteModel, "function");
  assert.equal(module.resolveFixedRouteModel({ model: "gemini-3-flash-agent" }, ""), "gemini-3-flash-agent");
  assert.equal(module.resolveFixedRouteModel({ route: { model: "gemini-3-flash-agent" } }, "GEMINI-3-FLASH-AGENT"), "gemini-3-flash-agent");
  assert.throws(
    () => module.resolveFixedRouteModel({ model: "gemini-3-flash-agent" }, "claude-sonnet-4-6"),
    /does not match the fixed Antigravity route/,
  );
  assert.throws(() => module.resolveFixedRouteModel({}, ""), /did not report a model/);

  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /args\.get\("--model"\) \|\| "gemini-3\.5-flash-low"/);
  const preflightIndex = source.indexOf("model = resolveFixedRouteModel(");
  const fixtureIndex = source.indexOf("const tempRoot");
  assert.ok(preflightIndex >= 0 && fixtureIndex > preflightIndex, "fixed-route model preflight must happen before fixture or UI work");
});

test("builds per-turn model proof from selected UI state and marker-scoped request evidence", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  assert.equal(typeof module.buildTurnModelProof, "function");
  const proof = module.buildTurnModelProof({
    ok: true,
    usedRealTraffic: true,
    requiredModel: "claude-sonnet-4-6",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {
      realSubmit: {
        ok: true,
        markerScopedRequestObserved: true,
        requiredModelMatched: true,
        observedModels: ["claude-sonnet-4-6"],
      },
    },
    modelRouteEvidence: { newRouteCount: 0, routes: [] },
  }, "claude-sonnet-4-6");

  assert.equal(proof.proven, true);
  assert.equal(proof.requiredModelMatches, true);
  assert.equal(proof.selectionMatched, true);
  assert.equal(proof.preSubmitSelectionMatched, true);
  assert.deepEqual(proof.proofSources, ["marker-scoped-submit"]);
  assert.deepEqual(proof.observedModels, ["claude-sonnet-4-6"]);
});

test("builds per-turn model proof from native marker-scoped fixed-route evidence", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  const proof = module.buildTurnModelProof({
    ok: true,
    usedRealTraffic: true,
    requiredModel: "gemini-3-flash-agent",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {
      nativeSubmit: {
        ok: true,
        markerScopedRequestObserved: true,
        requiredModelMatched: true,
        observedModels: ["gemini-3-flash-agent"],
      },
    },
    modelRouteEvidence: { newRouteCount: 0, routes: [] },
  }, "gemini-3-flash-agent");

  assert.equal(proof.proven, true);
  assert.deepEqual(proof.proofSources, ["marker-scoped-submit"]);
  assert.deepEqual(proof.observedModels, ["gemini-3-flash-agent"]);
});

test("rejects per-turn model proof without matching raw request evidence", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  assert.equal(typeof module.buildTurnModelProof, "function");
  const proof = module.buildTurnModelProof({
    ok: true,
    usedRealTraffic: true,
    requiredModel: "claude-sonnet-4-6",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {
      realSubmit: {
        ok: true,
        markerScopedRequestObserved: true,
        requiredModelMatched: true,
        observedModels: ["gemini-3.5-flash-low"],
      },
    },
    modelRouteEvidence: { newRouteCount: 0, routes: [] },
  }, "claude-sonnet-4-6");

  assert.equal(proof.proven, false);
  assert.deepEqual(proof.proofSources, []);
  assert.deepEqual(proof.observedModels, ["gemini-3.5-flash-low"]);
});

test("builds per-turn model proof from a new route with real resolvedModel evidence", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  const proof = module.buildTurnModelProof({
    usedRealTraffic: true,
    requiredModel: "claude-sonnet-4-6",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {},
    modelRouteEvidence: {
      newRouteCount: 1,
      routes: [{ requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" }],
    },
  }, "claude-sonnet-4-6");

  assert.equal(proof.proven, true);
  assert.deepEqual(proof.proofSources, ["new-model-route"]);
  assert.deepEqual(proof.observedModels, ["claude-sonnet-4-6"]);
});

test("a terminal provider failure stops the next long-journey turn before dispatch", () => {
  const gate = createTerminalProviderStopGate();
  gate.assertCanStart({ journeyId: "journey-a", turnId: "turn-1" });
  assert.equal(gate.observe({
    journeyId: "journey-a",
    turnId: "turn-1",
    usedRealTraffic: true,
    reconnectOutcome: { terminalProviderError: "RESOURCE_EXHAUSTED (code 429)" },
  })?.turnId, "turn-1");
  assert.throws(
    () => gate.assertCanStart({ journeyId: "journey-a", turnId: "turn-2" }),
    (error) => error.code === "ANTICODEX_TERMINAL_PROVIDER_STOP"
      && error.terminalProviderStop?.turnId === "turn-1"
      && error.nextTurn?.turnId === "turn-2",
  );
});

test("terminal provider failure retains all earlier observed journey turns", () => {
  const first = { journeyId: "journey-a", turnId: "turn-1", marker: "M1", ok: true, usedRealTraffic: true };
  const second = { journeyId: "journey-a", turnId: "turn-2", marker: "M2", ok: true, usedRealTraffic: true };
  const terminal = {
    journeyId: "journey-a",
    turnId: "turn-3",
    marker: "M3",
    ok: false,
    usedRealTraffic: true,
    reconnectOutcome: { terminalProviderError: "quota exhausted" },
  };
  const retained = retainJourneyTurnEvidence([first, second], terminal, terminal);

  assert.deepEqual(retained.map((turn) => turn.turnId), ["turn-1", "turn-2", "turn-3"]);
  assert.equal(retained.filter((turn) => turn.ok).length, 2);
  assert.equal(retained.filter((turn) => turn.turnId === "turn-3").length, 1);
});

test("transient reconnect evidence is not mislabeled as a stale 409 conflict", () => {
  assert.equal(countTurnStaleConflicts([
    { activeReconnectSeen: true, reconnectOutcome: { recovered: true }, failures: [] },
    { activeReconnectSeen: false, failures: ["unexpected status 409 Conflict: stale request"] },
  ]), 1);
});

test("history continuity stays truthful when the same task resumes slower than the UI budget", () => {
  const evidence = evaluateHistoryReopenEvidence({
    initialThreadId: "thread-1",
    historyTurn: {
      ok: false,
      resultDrivenCompletionObserved: true,
      history: {
        threadId: "thread-1",
        toolOutputSeen: true,
        taskCompleteSeen: true,
        assistantFinalMarkerSeen: false,
      },
    },
    sameChatEvidence: {
      actualMouseClick: true,
      navigatedAwayFirst: true,
      openLatencyMs: 5_733,
      visibleIdleAfterClick: { ok: true },
    },
    filesUnchanged: true,
    historyOpenBudgetMs: 5_000,
  });
  assert.equal(evidence.resumedSameTask, true);
  assert.equal(evidence.responsive, false);
  assert.equal(evidence.ok, false);

  const wrongThread = evaluateHistoryReopenEvidence({
    initialThreadId: "thread-1",
    historyTurn: { history: { threadId: "thread-2", toolOutputSeen: true, assistantFinalMarkerSeen: true } },
    sameChatEvidence: {
      actualMouseClick: true,
      navigatedAwayFirst: true,
      openLatencyMs: 200,
      visibleIdleAfterClick: { ok: true },
    },
    filesUnchanged: true,
  });
  assert.equal(wrongThread.resumedSameTask, false);
  assert.equal(wrongThread.responsive, true);
  assert.equal(wrongThread.ok, false);
});

test("failed launch evidence accepts Codex-normalized nonzero exit codes but rejects replay", () => {
  const diagnosis = { state: "failed", reason: "CONFIG_MISSING", attempts: 1 };
  assert.equal(failedLaunchEvidenceProvesSingleAttempt({
    failedLaunchCount: 1,
    commands: [
      { command: "node start-service.mjs", exitCode: 1 },
      { command: "node diagnose.mjs", exitCode: 0 },
    ],
    diagnosis,
  }), true);
  assert.equal(failedLaunchEvidenceProvesSingleAttempt({
    failedLaunchCount: 2,
    commands: [
      { command: "node start-service.mjs", exitCode: 1 },
      { command: "node start-service.mjs", exitCode: 1 },
      { command: "node diagnose.mjs", exitCode: 0 },
    ],
    diagnosis: { ...diagnosis, attempts: 2 },
  }), false);
});

test("the visible inventory task states the same dedupe API contract as its hidden verifier", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  assert.match(source, /dedupeLatest\(records\) 必须返回按 SKU 排序的最终记录数组/);
  assert.match(source, /隐藏函数验收要求 dedupeLatest\(records\) 直接返回数组/);
});

test("migration turns distinguish required idempotency pairs from accidental command loops", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  const evidenceSource = await readFile(new URL("../../scripts/lib/anticodex-gate8-evidence.mjs", import.meta.url), "utf8");
  assert.match(source, /allowMigrationIdempotencyDuplicate,/);
  assert.match(evidenceSource, /export function allowMigrationIdempotencyDuplicate/);
  assert.match(source, /countDuplicateCommands\(scopedCommands, \{ allowDuplicate: allowDuplicateCommand \}\)/);
  assert.ok((source.match(/allowDuplicateCommand: allowMigrationIdempotencyDuplicate/g) || []).length >= 4);
  assert.match(source, /npm test 只运行一次/);
  assert.match(source, /迁移 CLI 恰好运行两次/);
});

test("every migration turn explicitly requires a Chinese action update before commands", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function runMigrationJourney");
  const end = source.indexOf("function createGreenfieldFixture", start);
  const migration = source.slice(start, end);
  assert.ok((migration.match(/命令前先用一句中文说明/g) || []).length >= 6);
});

test("every visible long-task turn rejects program launches and tools after its final marker", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function checkTurn");
  const end = source.indexOf("function createInventoryFixture", start);
  const verifier = source.slice(start, end);
  assert.match(verifier, /launchCommandCount/);
  assert.match(verifier, /postFinalToolCallCount/);
  assert.match(verifier, /postFinalToolOutputCount/);
  assert.match(verifier, /duplicateCommandCount/);
  assert.match(verifier, /preCommandExplanationSeen/);
  assert.match(verifier, /scopedCommands\.length === 0/);
  assert.match(source, /toolOutputSeen:\s*nonEmptyToolOutputs\.length > 0/);
  assert.match(source, /nonEmptyToolOutputHashes:[\s\S]*createHash\("sha256"\)/);
  assert.match(source, /preCommandExplanationHashes:[\s\S]*createHash\("sha256"\)/);
  assert.match(verifier, /rolloutToolOutputEvidence/);
  assert.match(verifier, /rolloutPreCommandEvidence/);
});

test("the inventory host verifier never creates or deletes the delivered summary", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function inspectInventory");
  const end = source.indexOf("function inventoryBusinessEvidence", start);
  const verifier = source.slice(start, end);
  assert.match(verifier, /mkdtempSync\(join\(os\.tmpdir\(\), "anticodex-inventory-inspect-"\)\)/);
  assert.match(verifier, /verificationOutputPath/);
  assert.match(verifier, /defaultRun/);
  assert.match(verifier, /defaultWrittenJson/);
  assert.match(verifier, /\[dryJson, regularJson, verificationWrittenJson, defaultJson, defaultWrittenJson, deliveredJson\]/);
  assert.doesNotMatch(verifier, /unlinkSync\(deliveredOutputPath\)/);
  assert.doesNotMatch(verifier, /--output", "summary\.json"/);
  assert.match(verifier, /copyFileSync\(contractPath, resolve\(verificationRoot, "inventory-contract\.json"\)\)/);
  assert.match(verifier, /spawnNode\(verificationRoot, \["inventory\.mjs", "--input", "data\/inventory\.json"\]\)/);
});

test("the inventory contract defines --output as the six-metric summary target and reports its value", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  const evidenceStart = source.indexOf("function inventoryBusinessEvidence");
  const evidenceEnd = source.indexOf("function ", evidenceStart + 10);
  const evidence = source.slice(evidenceStart, evidenceEnd);

  assert.match(source, /--output \u6307\u5b9a\u7684\u8def\u5f84\u5fc5\u987b\u5199\u5165\u540c\u4e00\u4efd\u516d\u6307\u6807 JSON/);
  assert.match(evidence, /verificationWrittenSummary: result\.verificationWrittenSummary/);
  assert.match(evidence, /defaultWrittenSummary: result\.defaultWrittenSummary/);
  assert.match(source, /node inventory\.mjs --input data\/inventory\.json(?:\s|[`"'])/);
});

test("the visible long journey opens each fixture as the actual native Codex project", async () => {
  const uiSource = await readFile(new URL("../../scripts/test-anticodex-ui-chat-smoke.mjs", import.meta.url), "utf8");
  const journeySource = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");

  assert.match(uiSource, /--project-root <path>/);
  assert.match(uiSource, /electron-add-new-workspace-root-option/);
  assert.match(uiSource, /electron-rename-workspace-root-option/);
  assert.match(journeySource, /"--project-root", artifactDir/);
  assert.match(journeySource, /sessionCwd/);
  assert.match(journeySource, /workspaceCwdMatches/);
  assert.match(journeySource, /workspace-state-restore/);
});

test("the native project task selector recognizes the current Chinese new-task label", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-ui-chat-smoke.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("text.includes('\\\\u65b0\\\\u5efa\\\\u4efb\\\\u52a1')"));
  assert.ok(source.includes("projectText.includes('\\\\u65b0\\\\u5efa\\\\u4efb\\\\u52a1')"));
});

test("the visible long journey settles native rollout evidence after the UI child exits", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  assert.match(source, /function settleMarkerHistoryEvidence/);
  assert.match(source, /preCommandExplanationSeen/);
  assert.match(source, /taskCompleteSeen/);
});

test("the formal Gate 8 context threshold reaches the native compaction verifier", async () => {
  const formal = await readFile(new URL("../../scripts/test-anticodex-gate8-final-long-task.mjs", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../../scripts/test-anticodex-compaction-resume.ps1", import.meta.url), "utf8");
  const native = await readFile(new URL("../../scripts/test-anticodex-native-compaction-resume.mjs", import.meta.url), "utf8");
  assert.match(formal, /"-LongContextChars", String\(longContextChars\)/);
  assert.match(wrapper, /"--min-long-context-bytes", \$LongContextChars/);
  assert.match(native, /const minLongContextBytes = Math\.max\(65_536,/);
  assert.match(native, /if \(longContextBytes < minLongContextBytes\)/);
});

test("the formal Gate 8 run verifies signed-in account readiness before first model traffic", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-gate8-final-long-task.mjs", import.meta.url), "utf8");
  const accountProbe = source.indexOf("const accountBefore = await accountReadiness()");
  const journeyStart = source.indexOf("journeyRun = run(process.execPath");

  assert.match(source, /http:\/\/127\.0\.0\.1:8484\/anticodex\/account/);
  assert.match(source, /accountBefore\?\.signedIn !== true \|\| accountBefore\?\.identityAvailable !== true/);
  assert.ok(accountProbe >= 0 && journeyStart > accountProbe);
});

test("the formal Gate 8 run verifies the selected model exists before first model traffic", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-gate8-final-long-task.mjs", import.meta.url), "utf8");
  const modelProbe = source.indexOf("const modelCatalogBefore = await modelCatalog()");
  const journeyStart = source.indexOf("journeyRun = run(process.execPath");

  assert.match(source, /http:\/\/127\.0\.0\.1:8484\/models/);
  assert.match(source, /if \(!modelIds\.includes\(model\)\)/);
  assert.ok(modelProbe >= 0 && journeyStart > modelProbe);
});

test("the formal Gate 8 run requires a fresh successful one-request quota probe", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-gate8-final-long-task.mjs", import.meta.url), "utf8");
  const quotaProbe = source.indexOf("const quotaProbeBefore = quotaProbePrecondition(model)");
  const journeyStart = source.indexOf("journeyRun = run(process.execPath");

  assert.ok(quotaProbe >= 0 && journeyStart > quotaProbe);
  assert.match(source, /latest-gate8-quota-probe\.json/);
  assert.match(source, /quotaReady !== true/);
  assert.match(source, /requestCount\) !== 1/);
  assert.match(source, /MAX_QUOTA_PROBE_AGE_MS/);
});

test("the formal Gate 8 run is serialized by the shared real-traffic mutex", { timeout: 30_000 }, async (t) => {
  const formalUrl = new URL("../../scripts/test-anticodex-gate8-final-long-task.mjs", import.meta.url);
  const formal = await readFile(formalUrl, "utf8");
  const wrapperUrl = new URL("../../scripts/test-anticodex-gate8-final-long-task.ps1", import.meta.url);
  const wrapper = await readFile(wrapperUrl, "utf8");
  const syncSource = await readFile(new URL("../../scripts/sync-anticodex-runtime.ps1", import.meta.url), "utf8");
  const root = await mkdtemp(join(tmpdir(), "anticodex-gate8-lock-"));
  const holderPath = join(root, "hold-mutex.ps1");
  const lockName = `Local\\AntiCodex.Gate8Test.${process.pid}.${Date.now()}`;
  await writeFile(holderPath, `param([string]$LockName)\n$mutex = [Threading.Mutex]::new($false, $LockName)\n$acquired = $mutex.WaitOne(0)\nif (-not $acquired) { exit 2 }\ntry {\n  [Console]::Out.WriteLine('READY')\n  [Console]::Out.Flush()\n  Start-Sleep -Seconds 30\n} finally {\n  $mutex.ReleaseMutex()\n  $mutex.Dispose()\n}\n`, "utf8");

  const holder = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderPath, "-LockName", lockName], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (holder.exitCode === null) holder.kill();
    await rm(root, { recursive: true, force: true });
  });
  holder.stdout.setEncoding("utf8");
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("mutex holder did not become ready")), 10_000);
    const onData = (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timer);
      holder.stdout.off("data", onData);
      resolveReady();
    };
    holder.stdout.on("data", onData);
    holder.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`mutex holder exited early with ${code}`));
    });
  });

  const formalPath = fileURLToPath(formalUrl);
  const child = spawn(process.execPath, [
    formalPath, "--allow-real-traffic", "--model", "lock-test-model", "--report-root", root,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ANTICODEX_REAL_TRAFFIC_LOCK_NAME: lockName },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  const payload = JSON.parse(stdout.trim());

  assert.match(formal, /ANTICODEX_REAL_TRAFFIC_LOCK_HELD/);
  assert.match(formal, /test-anticodex-gate8-final-long-task\.ps1/);
  assert.match(wrapper, /Enter-AntiCodexRealTrafficLock/);
  assert.match(wrapper, /Exit-AntiCodexRealTrafficLock/);
  assert.match(syncSource, /scripts\\test-anticodex-gate8-final-long-task\.ps1/);
  assert.equal(exitCode, 75, stderr);
  assert.equal(payload.busy, true);
  assert.equal(payload.usedRealTraffic, false);
  assert.equal(payload.longTaskStarted, false);
});

test("direct real human journeys are serialized by the shared real-traffic mutex", { timeout: 30_000 }, async (t) => {
  const journeyUrl = new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url);
  const journeySource = await readFile(journeyUrl, "utf8");
  const wrapperUrl = new URL("../../scripts/test-anticodex-human-long-journey.ps1", import.meta.url);
  const wrapper = await readFile(wrapperUrl, "utf8").catch(() => "");
  const syncSource = await readFile(new URL("../../scripts/sync-anticodex-runtime.ps1", import.meta.url), "utf8");

  assert.match(journeySource, /ANTICODEX_REAL_TRAFFIC_LOCK_HELD/);
  assert.match(journeySource, /test-anticodex-human-long-journey\.ps1/);
  assert.match(wrapper, /Enter-AntiCodexRealTrafficLock/);
  assert.match(wrapper, /Exit-AntiCodexRealTrafficLock/);
  assert.match(syncSource, /scripts\\test-anticodex-human-long-journey\.ps1/);

  const root = await mkdtemp(join(tmpdir(), "anticodex-human-long-lock-"));
  const holderPath = join(root, "hold-mutex.ps1");
  const lockName = `Local\\AntiCodex.HumanLongTest.${process.pid}.${Date.now()}`;
  await writeFile(holderPath, `param([string]$LockName)\n$mutex = [Threading.Mutex]::new($false, $LockName)\n$acquired = $mutex.WaitOne(0)\nif (-not $acquired) { exit 2 }\ntry {\n  [Console]::Out.WriteLine('READY')\n  [Console]::Out.Flush()\n  Start-Sleep -Seconds 30\n} finally {\n  $mutex.ReleaseMutex()\n  $mutex.Dispose()\n}\n`, "utf8");
  const holder = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderPath, "-LockName", lockName], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (holder.exitCode === null) holder.kill();
    await rm(root, { recursive: true, force: true });
  });
  holder.stdout.setEncoding("utf8");
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("mutex holder did not become ready")), 10_000);
    const onData = (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timer);
      holder.stdout.off("data", onData);
      resolveReady();
    };
    holder.stdout.on("data", onData);
    holder.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`mutex holder exited early with ${code}`));
    });
  });

  const child = spawn(process.execPath, [
    fileURLToPath(journeyUrl),
    "--allow-real-traffic",
    "--journey", "interrupted-migration-three-turn",
    "--model", "lock-test-model",
    "--report-root", root,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ANTICODEX_REAL_TRAFFIC_LOCK_NAME: lockName },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  const payload = JSON.parse(stdout.trim());

  assert.equal(exitCode, 75, stderr);
  assert.equal(payload.busy, true);
  assert.equal(payload.usedRealTraffic, false);
  assert.equal(payload.longTaskStarted, false);
});

test("the shared real-traffic mutex recovers an abandoned owner after a crash", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anticodex-gate8-abandoned-lock-"));
  const holderPath = join(root, "abandon-mutex.ps1");
  const contenderPath = join(root, "enter-mutex.ps1");
  const modulePath = fileURLToPath(new URL("../../scripts/anticodex-real-traffic-lock.psm1", import.meta.url));
  const lockName = `Local\\AntiCodex.Gate8Abandoned.${process.pid}.${Date.now()}`;
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(holderPath, `param([string]$LockName)\n$mutex = [Threading.Mutex]::new($false, $LockName)\nif (-not $mutex.WaitOne(0)) { exit 2 }\n[Console]::Out.WriteLine('OWNED')\n[Console]::Out.Flush()\nexit 0\n`, "utf8");
  await writeFile(contenderPath, `param([string]$LockName, [string]$ModulePath)\n$ErrorActionPreference = 'Stop'\nImport-Module $ModulePath -Force\n$lock = Enter-AntiCodexRealTrafficLock -Name $LockName -WaitSeconds 0\ntry {\n  [ordered]@{ acquired = $lock.acquired; name = $lock.name } | ConvertTo-Json -Compress\n} finally {\n  Exit-AntiCodexRealTrafficLock -Lock $lock\n}\n`, "utf8");

  const runPowerShell = async (script, extraArgs = []) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...extraArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, "exit");
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  };

  const owner = await runPowerShell(holderPath, ["-LockName", lockName]);
  assert.equal(owner.exitCode, 0, owner.stderr);
  assert.match(owner.stdout, /OWNED/);
  const recovered = await runPowerShell(contenderPath, ["-LockName", lockName, "-ModulePath", modulePath]);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout), { acquired: true, name: lockName });
});

test("the Gate 8 quota probe is locked, opt-in, and sends exactly one model request", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-gate8-quota-probe.ps1", import.meta.url), "utf8");
  const syncSource = await readFile(new URL("../../scripts/sync-anticodex-runtime.ps1", import.meta.url), "utf8");
  const allowGuard = source.indexOf("if (-not $AllowRealTraffic)");
  const modelRequest = source.indexOf("$chat = Invoke-SingleChatRequest");

  assert.ok(allowGuard >= 0 && modelRequest > allowGuard);
  assert.equal((source.match(/-Method Post/g) || []).length, 1);
  assert.match(source, /Enter-AntiCodexRealTrafficLock/);
  assert.match(source, /Exit-AntiCodexRealTrafficLock/);
  assert.match(source, /\/v1\/chat\/completions/);
  assert.match(source, /requestCount = 1/);
  assert.match(source, /selectedModelPresent/);
  assert.match(source, /\[string\]\$Model = ""/);
  assert.match(source, /fixedRouteModel/);
  assert.match(source, /modelMatchesFixedRoute/);
  assert.match(source, /markerMatched/);
  assert.match(syncSource, /scripts\\test-anticodex-gate8-quota-probe\.ps1/);
});

test("the Gate 8 quota probe completes one redacted request against a loopback fixture", { timeout: 30_000 }, async () => {
  const model = "claude-sonnet-4-6";
  const mismatchModel = "catalog-model-not-fixed";
  const exhaustedModel = "quota-exhausted-fixture";
  const reportRoot = await mkdtemp(join(tmpdir(), "anticodex-gate8-quota-probe-"));
  const canonicalReportRoot = await mkdtemp(join(tmpdir(), "anticodex-gate8-model-canonical-"));
  const mismatchReportRoot = await mkdtemp(join(tmpdir(), "anticodex-gate8-model-mismatch-"));
  const exhaustedReportRoot = await mkdtemp(join(tmpdir(), "anticodex-gate8-quota-exhausted-"));
  let postCount = 0;
  let fixedRouteModel = model;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && url.pathname === "/anticodex/fixed-route/health") {
      send(200, { ok: true, state: "ready", provider: "antigravity", model: fixedRouteModel, ports: { adapter: server.address().port } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/anticodex/account") {
      send(200, { signedIn: true, identityAvailable: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/models") {
      send(200, { object: "list", data: [{ id: model }, { id: mismatchModel }, { id: exhaustedModel }] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      postCount += 1;
      let body = "";
      for await (const chunk of request) body += chunk;
      const requestBody = JSON.parse(body);
      if (requestBody.model === exhaustedModel) {
        send(429, { error: { type: "antigravity_quota_exceeded", code: "quota_exceeded", message: "RESOURCE_EXHAUSTED: quota resets later" } });
        return;
      }
      const prompt = requestBody?.messages?.at(-1)?.content || "";
      const marker = String(prompt).match(/GATE8_QUOTA_READY_\d{8}-\d{6}/)?.[0] || "";
      send(200, {
        id: "chatcmpl-fixture",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: marker }, finish_reason: "stop" }],
      });
      return;
    }
    send(404, { error: { message: "not found" } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const script = fileURLToPath(new URL("../../scripts/test-anticodex-gate8-quota-probe.ps1", import.meta.url));
  const runProbe = async (probeModel, root, suffix) => {
    const childArgs = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-BaseUrl", baseUrl,
      "-FixedRouteHealthUrl", `${baseUrl}/anticodex/fixed-route/health`,
      "-ReportRoot", root,
      "-LockName", `Local\\AntiCodex.Gate8QuotaFixture.${process.pid}.${suffix}`,
      "-TimeoutSec", "10",
      "-AllowRealTraffic",
    ];
    if (probeModel) childArgs.push("-Model", probeModel);
    const child = spawn("powershell.exe", childArgs, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, "close");
    const payload = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    return { exitCode, stdout, stderr, payload };
  };
  try {
    const success = await runProbe("", reportRoot, "success");
    assert.equal(success.exitCode, 0, success.stderr || success.stdout);
    assert.equal(postCount, 1);
    const payload = success.payload;
    assert.equal(payload.ok, true);
    assert.equal(payload.quotaReady, true);
    assert.equal(payload.requestCount, 1);
    assert.equal(payload.markerMatched, true);
    assert.equal(payload.longTaskStarted, false);
    const reportText = await readFile(join(reportRoot, "latest-gate8-quota-probe.json"), "utf8");
    const report = JSON.parse(reportText);
    assert.equal(report.response.statusCode, 200);
    assert.match(report.response.contentSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(reportText, /GATE8_QUOTA_READY_/);

    postCount = 0;
    const canonical = await runProbe(model.toUpperCase(), canonicalReportRoot, "canonical");
    assert.equal(canonical.exitCode, 0, canonical.stderr || canonical.stdout);
    assert.equal(postCount, 1);
    assert.equal(canonical.payload.model, model);
    assert.equal(canonical.payload.preflight.fixedRouteModel, model);

    postCount = 0;
    fixedRouteModel = model;
    const mismatch = await runProbe(mismatchModel, mismatchReportRoot, "mismatch");
    assert.equal(mismatch.exitCode, 1, mismatch.stderr || mismatch.stdout);
    assert.equal(postCount, 0);
    assert.equal(mismatch.payload.usedRealTraffic, false);
    assert.equal(mismatch.payload.requestCount, 0);
    assert.equal(mismatch.payload.failureType, "preflight");

    fixedRouteModel = exhaustedModel;
    const exhausted = await runProbe(exhaustedModel, exhaustedReportRoot, "exhausted");
    assert.equal(exhausted.exitCode, 1, exhausted.stderr || exhausted.stdout);
    assert.equal(postCount, 1);
    assert.equal(exhausted.payload.ok, false);
    assert.equal(exhausted.payload.quotaReady, false);
    assert.equal(exhausted.payload.requestCount, 1);
    assert.equal(exhausted.payload.failureType, "quota_exhausted", JSON.stringify(exhausted.payload));
    assert.equal(exhausted.payload.longTaskStarted, false);
    const exhaustedReport = JSON.parse(await readFile(join(exhaustedReportRoot, "latest-gate8-quota-probe.json"), "utf8"));
    assert.equal(exhaustedReport.response.statusCode, 429);
    assert.equal(exhaustedReport.failureType, "quota_exhausted");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(reportRoot, { recursive: true, force: true });
    await rm(canonicalReportRoot, { recursive: true, force: true });
    await rm(mismatchReportRoot, { recursive: true, force: true });
    await rm(exhaustedReportRoot, { recursive: true, force: true });
  }
});

test("the deterministic Gate 8 rehearsal exits on help before starting its scripted harness", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-gate8-deterministic-rehearsal.mjs", import.meta.url), "utf8");
  const helpGuard = source.indexOf('process.argv.includes("--help")');
  const harnessStart = source.indexOf("await createCodexPlusPlusScriptedChatHarness");
  assert.ok(helpGuard >= 0 && helpGuard < harnessStart);
  assert.match(source, /Usage: node scripts\/test-anticodex-gate8-deterministic-rehearsal\.mjs/);
});

test("the diverse Gate 8 matrix exits on help before starting its scripted harness", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-gate8-diverse-result-matrix.mjs", import.meta.url), "utf8");
  const helpGuard = source.indexOf('process.argv.includes("--help")');
  const harnessStart = source.indexOf("await createCodexPlusPlusScriptedChatHarness");
  assert.ok(helpGuard >= 0 && helpGuard < harnessStart);
  assert.match(source, /Usage: node scripts\/test-anticodex-gate8-diverse-result-matrix\.mjs/);
});

test("the release Gate 8 validator requires all eight turns and quota-safe preflight", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-release-gates.mjs", import.meta.url), "utf8");
  assert.match(source, /report\?\.preflight\?\.accountReady !== true/);
  assert.match(source, /report\?\.preflight\?\.selectedModelPresent !== true/);
  assert.match(source, /report\?\.preflight\?\.quotaProbeReady !== true/);
  assert.match(source, /Number\(report\?\.interaction\?\.dialogueTurns\) < 8/);
  assert.match(source, /Number\(report\?\.interaction\?\.passedDialogueTurns\) < 8/);
  assert.match(source, /Number\(report\?\.interaction\?\.unexpectedLaunchCommands\) !== 0/);
  assert.match(source, /Number\(report\?\.interaction\?\.postFinalToolCalls\) !== 0/);
  assert.match(source, /Number\(report\?\.interaction\?\.postFinalToolOutputs\) !== 0/);
  assert.match(source, /Number\(report\?\.interaction\?\.duplicateCommands\) !== 0/);
  assert.match(source, /Number\(report\?\.interaction\?\.evidencedTurns\) < 8/);
  assert.match(source, /Number\(report\?\.interaction\?\.preCommandExplanations\) < 8/);
  assert.match(source, /Number\(report\?\.interaction\?\.nonEmptyToolResults\) < 8/);
  assert.match(source, /Number\(report\?\.interaction\?\.modelProvenTurns\) < 8/);
  assert.match(source, /report\?\.interaction\?\.turnContractsPassed !== true/);
});

test("multi-style release acceptance requires result-proven migration and greenfield journeys", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  assert.equal(typeof module.validateGate8MultiStyleReport, "function");

  const valid = validMultiStyleReport();
  assert.deepEqual(module.validateGate8MultiStyleReport(valid), []);

  const missingStyle = structuredClone(valid);
  missingStyle.journeyIds = ["interrupted-migration-three-turn"];
  missingStyle.journeys = missingStyle.journeys.slice(0, 1);
  assert.match(module.validateGate8MultiStyleReport(missingStyle).join(" "), /greenfield/);

  const badMigration = structuredClone(valid);
  badMigration.journeys[0].artifactEvidence.idempotent = false;
  assert.match(module.validateGate8MultiStyleReport(badMigration).join(" "), /migration.*idempotent/);

  const unprovenTurn = structuredClone(valid);
  unprovenTurn.journeys[1].turns[0].actualModelProven = false;
  assert.match(module.validateGate8MultiStyleReport(unprovenTurn).join(" "), /model proof/);

  const releaseSource = await readFile(new URL("../../scripts/test-anticodex-release-gates.mjs", import.meta.url), "utf8");
  assert.match(releaseSource, /latest-ui-human-long-journey\.json/);
  assert.match(releaseSource, /validateGate8MultiStyleReport/);
  assert.match(releaseSource, /function gate8NextAction/);
  assert.match(releaseSource, /missingEvidence\.includes\("formalLongTask"\)/);
  assert.match(releaseSource, /missingEvidence\.includes\("multiStyleLongTasks"\)/);
});

test("runtime sync carries every tracked release audit required by the installed Gate 8 preflight", async () => {
  const source = await readFile(new URL("../../scripts/sync-anticodex-runtime.ps1", import.meta.url), "utf8");
  for (const relative of [
    "docs\\audits\\2026-07-14-codexplusplus-runtime-isolation.json",
    "docs\\audits\\2026-07-14-codexplusplus-third-party-route.json",
    "docs\\audits\\2026-07-14-antigravity-chat-adapter-contract.json",
    "docs\\audits\\2026-07-14-gate4-isolated-route-switch.json",
    "docs\\audits\\2026-07-15-gate5-visible-integration.json",
    "docs\\audits\\2026-07-15-gate5-visible-integration.json.sha256",
    "docs\\audits\\2026-07-15-gate6-edge-matrix.json",
    "docs\\audits\\2026-07-15-gate6-edge-matrix.json.sha256",
  ]) {
    assert.ok(source.includes(`"${relative}"`), `runtime sync omitted ${relative}`);
  }
});

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function validMultiStyleReport() {
  const model = "gemini-3-flash-agent";
  const makeTurn = (id, index) => {
    const command = `node verify-${index}.mjs`;
    return {
      turnId: `${id}-turn-${index}`,
      ok: true,
      usedRealTraffic: true,
      requiredModel: model,
      actualModelProven: true,
      workspaceCwdMatches: true,
      modelProof: {
        proven: true,
        expectedModel: model,
        requiredModel: model,
        requiredModelMatches: true,
        selectionMatched: true,
        preSubmitSelectionMatched: true,
        markerScopedSubmitMatched: true,
        newRouteMatched: false,
        proofSources: ["marker-scoped-submit"],
        observedModels: [model],
      },
      history: {
        scopedCommands: [{ command, callId: `${id}-call-${index}` }],
        toolOutputSeen: true,
        nonEmptyToolOutputHashes: [sha256Text(`result:${command}`)],
        scopedCommandResultHashes: [sha256Text(`result:${command}`)],
        chinesePreCommandSeen: true,
        preCommandExplanationSeen: true,
        preCommandExplanationHashes: [sha256Text(`现在验证 ${command}`)],
        assistantFinalMarkerSeen: true,
        launchCommandCount: 0,
        postFinalToolCallCount: 0,
        postFinalToolOutputCount: 0,
        duplicateCommandCount: 0,
        parseErrorSeen: false,
        scopeViolationCount: 0,
      },
    };
  };
  const migrationId = "interrupted-migration-three-turn";
  const greenfieldId = "greenfield-project-three-turn";
  const migrationTurns = Array.from({ length: 3 }, (_, index) => makeTurn(migrationId, index + 1));
  const greenfieldTurns = Array.from({ length: 4 }, (_, index) => makeTurn(greenfieldId, index + 1));
  return {
    reportName: "ui-human-long-journey",
    ok: true,
    requestedRealTraffic: true,
    usedRealTraffic: true,
    behaviorCovered: true,
    coverageKind: "desktop-ui-real-human-long-journey",
    model,
    journeyIds: [migrationId, greenfieldId],
    journeyCount: 2,
    passedJourneyCount: 2,
    totalTurnCount: 7,
    passedTurnCount: 7,
    resultValidatedJourneyCount: 2,
    stoppedAfterTerminalProviderFailure: false,
    failures: [],
    workspaceRestore: { ok: true },
    journeys: [
      {
        id: migrationId,
        ok: true,
        failures: [],
        usedRealTraffic: true,
        turnCount: 3,
        passedTurnCount: 3,
        turns: migrationTurns,
        artifactEvidence: {
          protectedFilesUnchanged: true,
          testsPassed: true,
          firstRunPassed: true,
          secondRunPassed: true,
          outputMatches: true,
          summaryMatches: true,
          rejectsExact: true,
          idempotent: true,
          staleTempAbsent: true,
          recoveryLaunchCommandCount: 0,
          unexpectedFiles: [],
          actualFiles: ["migrate.mjs", "migrate.test.mjs", "normalized.json", "rejects.ndjson", "migration-summary.json"],
        },
      },
      {
        id: greenfieldId,
        ok: true,
        failures: [],
        usedRealTraffic: true,
        turnCount: 4,
        passedTurnCount: 4,
        turns: greenfieldTurns,
        artifactEvidence: {
          protectedFilesUnchanged: true,
          fileCount: 12,
          testPassed: true,
          cliJsonPassed: true,
          cliTextPassed: true,
          cliJsonHasExpectedValues: true,
          readmeHasChinese: true,
          htmlHasChinese: true,
          htmlIsFullPage: true,
          markerInHtml: true,
          summaryPresent: true,
          summaryHasExpectedValues: true,
          reportPresent: true,
          noopHashesUnchanged: true,
          noopLaunchCommandCount: 0,
          noopVerificationCommandCount: 2,
          minimumTurns: true,
          unexpectedFiles: [],
          actualFiles: Array.from({ length: 12 }, (_, index) => `file-${index}.txt`),
        },
      },
    ],
  };
}

function validInput() {
  const route = {
    ok: true,
    schema: "anticodex-fixed-route-status-v1",
    state: "ready",
    provider: "antigravity",
    route: { provider: "antigravity", relayProtocol: "chatCompletions" },
    processes: { managerService: 101, copiedClient: [202] },
  };
  return {
    generatedAt: "2026-07-15T08:00:00.000Z",
    startedAt: "2026-07-15T07:00:00.000Z",
    endedAt: "2026-07-15T08:00:00.000Z",
    model: "gemini-3.5-flash-low",
    routeBefore: route,
    routeAfter: structuredClone(route),
    oldRouteBefore: { count: 4, entriesSha256: "a".repeat(64) },
    oldRouteAfter: { count: 4, entriesSha256: "a".repeat(64) },
    journey: {
      ok: true,
      usedRealTraffic: true,
      turnCount: 8,
      passedTurnCount: 8,
      editRounds: [
        { id: "repair", changedFiles: ["inventory.mjs"] },
        { id: "correction", changedFiles: ["inventory.mjs", "inventory.test.mjs"] },
        { id: "report", changedFiles: ["README.md", "report.md", "index.html"] },
        { id: "recovery", changedFiles: ["summary.json"] },
      ],
      userCorrections: [{ turnId: "turn-2-business-correction" }],
      turns: [
        ["node --test inventory.test.mjs", 2, "gemini-3.5-flash-low"],
        ["node inventory.mjs --dry-run", 2, "gemini-3.5-flash-low"],
        ["node inventory.mjs", 1, "gemini-3.5-flash-low"],
        ["node edge-once.mjs", 1, "gemini-3.5-flash-low"],
        ["node --test inventory.test.mjs", 0, "gemini-3.5-flash-low"],
        ["node inventory.mjs --dry-run", 0, "gemini-3.5-flash-low"],
        ["node --test inventory.test.mjs", 0, "gemini-3.5-flash-low"],
        ["node inventory.mjs --dry-run", 0, "gemini-3.5-flash-low"],
      ].map(([command, progressUpdateCount, requiredModel], index) => ({
        ok: true,
        usedRealTraffic: true,
        requiredModel,
        actualModelProven: true,
        modelProof: {
          proven: true,
          expectedModel: requiredModel,
          requiredModel,
          requiredModelMatches: true,
          selectionMatched: true,
          preSubmitSelectionMatched: true,
          markerScopedSubmitMatched: true,
          newRouteMatched: false,
          proofSources: ["marker-scoped-submit"],
          observedModels: [requiredModel],
        },
        history: {
          scopedCommands: [{ command, callId: `call-${index + 1}` }],
          progressUpdateCount,
          toolOutputSeen: true,
          nonEmptyToolOutputHashes: [sha256Text(`tool-result:${command}`)],
          scopedCommandResultHashes: [sha256Text(`tool-result:${command}`)],
          chinesePreCommandSeen: true,
          preCommandExplanationSeen: true,
          preCommandExplanationHashes: [sha256Text(`现在验证 ${command}`)],
          assistantFinalMarkerSeen: true,
          launchCommandCount: 0,
          postFinalToolCallCount: 0,
          postFinalToolOutputCount: 0,
          duplicateCommandCount: 0,
          parseErrorSeen: false,
          scopeViolationCount: 0,
        },
      })),
      historyReopen: {
        ok: true,
        titleNeedle: "G8I123",
        actualMouseClick: true,
        navigatedAwayFirst: true,
        resumedSameTask: true,
        threadId: "thread-1",
      },
      edgeRecovery: {
        injected: true,
        recovered: true,
        executionCount: 1,
        staleConflictCount: 0,
      },
    },
    compaction: {
      ok: true,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      longContextChars: 100_000,
      compact_summary_length: 800,
      nativeCompactionObserved: true,
      threadId: "thread-1",
      followup: { ok: true, sameThread: true },
    },
    artifacts: Array.from({ length: 6 }, (_, index) => ({
      path: `artifact-${index}.txt`, exists: true, sha256: String(index).repeat(64), bytes: index + 1,
    })),
    tests: [
      { name: "node-test", passed: true, exitCode: 0 },
      { name: "cli-dry-run", passed: true, exitCode: 0 },
    ],
    processBefore: {
      originalCodex: [{ processId: 1, name: "Codex.exe", executablePath: "C:/WindowsApps/Codex.exe" }],
      antiCodexRoots: [{ processId: 202, name: "Anti-Codex.exe" }],
    },
    processAfter: {
      originalCodex: [{ processId: 1, name: "Codex.exe", executablePath: "C:/WindowsApps/Codex.exe" }],
      antiCodexRoots: [{ processId: 202, name: "Anti-Codex.exe" }],
    },
    legacyProcessCount: 0,
    cppAudit: {
      responseRequestCount: 9,
      compactRequestCount: 1,
      upstreamRequestCount: 10,
      allUpstreamChatCompletions: true,
      staleConflictCount: 0,
      duplicateRequestPairs: [],
    },
    evidence: {
      journeyReport: "journey.json",
      compactionReport: "compaction.json",
      accountBefore: { signedIn: true, identityAvailable: true },
      modelCatalogBefore: {
        count: 20,
        selectedModel: "gemini-3.5-flash-low",
        selectedModelPresent: true,
      },
      quotaProbeBefore: {
        ok: true,
        quotaReady: true,
        usedRealTraffic: true,
        requestCount: 1,
        model: "gemini-3.5-flash-low",
        markerMatched: true,
        responseStatusCode: 200,
        ageMs: 30_000,
      },
    },
  };
}

test("audits the fixed CodexPlusPlus log segment", () => {
  const lines = [
    { timestamp_ms: 10, event: "helper.request", detail: { method: "POST", path: "/v1/responses", body_bytes: 100 } },
    { timestamp_ms: 11, event: "protocol_proxy.upstream_request", detail: { endpoint: "http://127.0.0.1:18488/v1/chat/completions", wireApi: "ChatCompletions" } },
    { timestamp_ms: 12, event: "helper.protocol_proxy_stream_ok", detail: { status: "200 OK" } },
    { timestamp_ms: 20, event: "helper.request", detail: { method: "POST", path: "/v1/responses/compact", body_bytes: 200 } },
    { timestamp_ms: 21, event: "protocol_proxy.upstream_request", detail: { endpoint: "http://127.0.0.1:18488/v1/chat/completions", wireApi: "ChatCompletions" } },
  ].map((line) => JSON.stringify(line)).join("\n");
  assert.deepEqual(auditCodexPlusPlusLogSegment(lines), {
    parsedLineCount: 5,
    responseRequestCount: 1,
    compactRequestCount: 1,
    upstreamRequestCount: 2,
    allUpstreamChatCompletions: true,
    staleConflictCount: 0,
    duplicateRequestPairs: [],
    sameSizeRequestPairs: [],
  });
});

test("does not mistake adjacent same-size CodexPlusPlus requests for a replay", () => {
  const lines = [
    { timestamp_ms: 10, event: "helper.request", detail: { method: "POST", path: "/v1/responses", body_bytes: 100, request_id: "turn-a", body_sha256: "a".repeat(64) } },
    { timestamp_ms: 20, event: "helper.request", detail: { method: "POST", path: "/v1/responses", body_bytes: 100, request_id: "turn-b", body_sha256: "b".repeat(64) } },
  ].map((line) => JSON.stringify(line)).join("\n");
  const audit = auditCodexPlusPlusLogSegment(lines);
  assert.deepEqual(audit.duplicateRequestPairs, []);
  assert.deepEqual(audit.sameSizeRequestPairs, [{
    path: "/v1/responses",
    bodyBytes: 100,
    elapsedMs: 10,
  }]);
});

test("detects a replay from a stable CodexPlusPlus request identity", () => {
  const lines = [
    { timestamp_ms: 10, event: "helper.request", detail: { method: "POST", path: "/v1/responses", body_bytes: 100, request_id: "turn-a", body_sha256: "a".repeat(64) } },
    { timestamp_ms: 20, event: "helper.request", detail: { method: "POST", path: "/v1/responses", body_bytes: 100, request_id: "turn-b", body_sha256: "a".repeat(64) } },
  ].map((line) => JSON.stringify(line)).join("\n");
  const audit = auditCodexPlusPlusLogSegment(lines);
  assert.deepEqual(audit.duplicateRequestPairs, [{
    path: "/v1/responses",
    identityKind: "bodySha256",
    elapsedMs: 10,
  }]);
});

test("compares complete normalized commands when detecting duplicates", () => {
  const prefix = "x".repeat(2_500);
  assert.equal(countDuplicateCommands([
    { command: `${prefix} first` },
    { command: `${prefix} second` },
  ]), 0);
  assert.equal(countDuplicateCommands([
    { command: "NODE   task.mjs --FLAG" },
    { command: " node task.mjs --flag " },
  ]), 1);
  assert.equal(countDuplicateCommands([
    { command: "node --test inventory.test.mjs", toolName: "exec_command" },
    { command: "*** Begin Patch\n*** Update File: inventory.mjs", toolName: "apply_patch" },
    { command: "node --test inventory.test.mjs", toolName: "exec_command" },
  ]), 0);
});

test("allows one explicitly required idempotency repeat but still rejects loops", () => {
  const migration = "node migrate.mjs --input records.ndjson --output normalized.json";
  const allowDuplicate = ({ normalized, repeatIndex }) => normalized.startsWith("node migrate.mjs ")
    && repeatIndex === 1;

  assert.equal(countDuplicateCommands([
    { command: migration },
    { command: migration },
  ], { allowDuplicate }), 0);
  assert.equal(countDuplicateCommands([
    { command: migration },
    { command: migration },
    { command: migration },
  ], { allowDuplicate }), 1);
  assert.equal(countDuplicateCommands([
    { command: "npm test" },
    { command: "npm test" },
  ], { allowDuplicate }), 1);
});

test("migration recovery permits one exact read-only Node directory recheck but not a loop or mutation", () => {
  const listing = "node -e \"console.log(require('fs').readdirSync('.'));\"";
  assert.equal(countDuplicateCommands([
    { command: listing },
    { command: listing },
  ], { allowDuplicate: allowMigrationIdempotencyDuplicate }), 0);
  assert.equal(countDuplicateCommands([
    { command: listing },
    { command: listing },
    { command: listing },
  ], { allowDuplicate: allowMigrationIdempotencyDuplicate }), 1);

  const mutation = "node -e \"const fs=require('fs'); console.log(fs.readdirSync('.')); fs.unlinkSync('x');\"";
  assert.equal(countDuplicateCommands([
    { command: mutation },
    { command: mutation },
  ], { allowDuplicate: allowMigrationIdempotencyDuplicate }), 1);
  assert.equal(countDuplicateCommands([
    { command: "npm test" },
    { command: "npm test" },
  ], { allowDuplicate: allowMigrationIdempotencyDuplicate }), 1);
});

test("stored multi-style evidence can be revalidated without model traffic or dropping raw evidence", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  assert.match(source, /--revalidate-report <path>/);
  assert.match(source, /stored report revalidation cannot be combined with real traffic/);
  assert.match(source, /stored human long-journey report signature does not match/);
  assert.match(source, /rawTurnEvidencePreserved: true/);
  assert.match(source, /artifactEvidencePreserved: true/);
  assert.match(source, /usedRealTraffic: false/);
});

test("detects native Codex compaction items without matching prompt text", () => {
  const records = [
    { type: "event_msg", payload: { type: "user_message", message: "please discuss compaction" } },
    { type: "response_item", payload: { type: "context_compaction", summary: "Keep the project marker and continue the existing task." } },
  ];
  assert.deepEqual(detectNativeCompactionEvidence(records), {
    observed: true,
    itemCount: 1,
    summaryLength: 55,
    itemTypes: ["context_compaction"],
  });
});

test("detects the current Codex compacted record and context_compacted event", () => {
  const summary = "Keep the current task and verified inventory state.";
  const records = [
    {
      type: "compacted",
      payload: {
        message: summary,
        replacement_history: [],
        window_number: 1,
      },
    },
    { type: "event_msg", payload: { type: "context_compacted" } },
  ];

  assert.deepEqual(detectNativeCompactionEvidence(records), {
    observed: true,
    itemCount: 2,
    summaryLength: summary.length,
    itemTypes: ["compacted", "context_compacted"],
  });
});

test("Gate 8 resumes a proven journey from existing compaction evidence without compacting twice", async () => {
  const compactionSource = await readFile(new URL("../../scripts/test-anticodex-native-compaction-resume.mjs", import.meta.url), "utf8");
  const compactionWrapper = await readFile(new URL("../../scripts/test-anticodex-compaction-resume.ps1", import.meta.url), "utf8");
  const formalSource = await readFile(new URL("../../scripts/test-anticodex-gate8-final-long-task.mjs", import.meta.url), "utf8");
  const formalWrapper = await readFile(new URL("../../scripts/test-anticodex-gate8-final-long-task.ps1", import.meta.url), "utf8");

  assert.match(compactionSource, /--existing-compaction-offset/);
  assert.match(compactionSource, /reusedExistingCompaction/);
  assert.match(compactionWrapper, /ExistingCompactionOffset/);
  assert.match(formalSource, /--resume-existing/);
  assert.match(formalSource, /latest-ui-human-long-journey\.json/);
  assert.match(formalSource, /latest-compaction-resume\.json/);
  assert.match(formalSource, /-ExistingCompactionOffset/);
  assert.match(formalWrapper, /ResumeExisting/);
});

test("builds a complete Gate 8 report only from complete evidence", () => {
  const report = buildGate8Report(validInput());
  assert.equal(report.ok, true);
  assert.equal(report.gateComplete, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.interaction, {
    editRounds: 4,
    dialogueTurns: 8,
    passedDialogueTurns: 8,
    userCorrections: 1,
    progressUpdates: 6,
    toolCalls: 8,
    unexpectedLaunchCommands: 0,
    postFinalToolCalls: 0,
    postFinalToolOutputs: 0,
    duplicateCommands: 0,
    evidencedTurns: 8,
    modelProvenTurns: 8,
    preCommandExplanations: 8,
    nonEmptyToolResults: 8,
    turnContractsPassed: true,
  });
  assert.equal(report.continuity.compactionTriggered, true);
  assert.equal(report.continuity.historyReopened, true);
  assert.equal(report.recovery.noDuplicateExecution, true);
  assert.equal(report.processes.originalCodexUnchanged, true);
});

test("reports actual real traffic when a later Gate 8 phase is skipped", () => {
  const input = validInput();
  input.journey.ok = false;
  input.compaction.ok = false;
  input.compaction.usedRealTraffic = false;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.usedRealTraffic, true);
});

test("rejects missing account identity or selected-model catalog proof", () => {
  const input = validInput();
  input.evidence.accountBefore.identityAvailable = false;
  input.evidence.modelCatalogBefore.selectedModelPresent = false;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.preflight.accountReady, false);
  assert.equal(report.preflight.selectedModelPresent, false);
  assert.match(report.failures.join("\n"), /signed-in account identity was not proven/);
  assert.match(report.failures.join("\n"), /selected model was not proven in the current model catalog/);
});

test("rejects a stale or mismatched Gate 8 quota probe", () => {
  const input = validInput();
  input.evidence.quotaProbeBefore.model = "another-model";
  input.evidence.quotaProbeBefore.ageMs = 20 * 60_000;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.preflight.quotaProbeReady, false);
  assert.match(report.failures.join("\n"), /fresh successful one-request quota probe was not proven/);
});

test("rejects a shallow or partially passed Gate 8 journey", () => {
  const input = validInput();
  input.journey.turnCount = 4;
  input.journey.passedTurnCount = 3;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.dialogueTurns, 4);
  assert.equal(report.interaction.passedDialogueTurns, 3);
  assert.match(report.failures.join("\n"), /eight visible turns did not all complete/);
});

test("rejects claimed turn counts without eight complete turn-history records", () => {
  const input = validInput();
  input.journey.turns = input.journey.turns.slice(0, 5);
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.evidencedTurns, 5);
  assert.match(report.failures.join("\n"), /fewer than eight complete turn-history records/);
});

test("rejects a turn whose actual model was not proven or whose required model is wrong", () => {
  const input = validInput();
  input.journey.turns[2].actualModelProven = false;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.modelProvenTurns, 7);
  assert.match(report.failures.join("\n"), /model provenance not verified for turn/);
});

test("rejects a turn whose required model does not match the selected model", () => {
  const input = validInput();
  input.journey.turns[0].requiredModel = "wrong-model";
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.modelProvenTurns, 7);
  assert.match(report.failures.join("\n"), /required model.*does not match selected model/);
});

test("rejects a turn without non-empty tool output or a pre-command action explanation", () => {
  const input = validInput();
  input.journey.turns[0].history.toolOutputSeen = false;
  input.journey.turns[0].history.preCommandExplanationSeen = false;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.turnContractsPassed, false);
  assert.match(report.failures.join("\n"), /turn-history contract/);
});

test("rejects unexpected program launches during the formal long task", () => {
  const input = validInput();
  input.journey.turns[0].history.launchCommandCount = 1;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.unexpectedLaunchCommands, 1);
  assert.match(report.failures.join("\n"), /unexpected program launch command/);
});

test("rejects tool calls dispatched after a visible final marker", () => {
  const input = validInput();
  input.journey.turns[0].history.postFinalToolCallCount = 1;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.postFinalToolCalls, 1);
  assert.match(report.failures.join("\n"), /tool call.*after.*final marker/i);
});

test("rejects tool outputs that arrive after a visible final marker", () => {
  const input = validInput();
  input.journey.turns[0].history.postFinalToolOutputCount = 1;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.postFinalToolOutputs, 1);
  assert.match(report.failures.join("\n"), /tool output.*after.*final marker/i);
});

test("rejects repeated identical commands inside one visible turn", () => {
  const input = validInput();
  input.journey.turns[0].history.duplicateCommandCount = 1;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.duplicateCommands, 1);
  assert.match(report.failures.join("\n"), /duplicate command/i);
});

test("rejects stale conflicts, duplicate execution, and process drift", () => {
  const input = validInput();
  input.journey.edgeRecovery.executionCount = 2;
  input.cppAudit.staleConflictCount = 1;
  input.processAfter.originalCodex = [];
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.gateComplete, false);
  assert.match(report.failures.join("\n"), /edge command executed 2 times/);
  assert.match(report.failures.join("\n"), /stale conflict count is 1/);
  assert.match(report.failures.join("\n"), /original Codex process set changed/);
});

test("fixed-route health reads retry a transient local connection failure", async () => {
  let attempts = 0;
  const result = await fetchJsonWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("write ECONNABORTED"), { code: "ECONNABORTED" });
    return {
      ok: true,
      async json() { return { ok: true, state: "ready" }; },
    };
  }, "http://127.0.0.1:18487/anticodex/fixed-route/health", {
    attempts: 3,
    delayMs: 0,
    timeoutMs: 100,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { ok: true, state: "ready" });
});

test("rejects a turn with zero scoped commands even if toolOutputSeen and marker are present", () => {
  const input = validInput();
  input.journey.turns[3].history.scopedCommands = [];
  input.journey.turns[3].history.toolOutputSeen = true;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.turnContractsPassed, false);
  assert.match(report.failures.join("\n"), /turn-history contract/);
  assert.match(report.failures.join("\n"), /no scoped commands/);
});

test("rejects claimed model provenance without the per-turn raw model proof detail", () => {
  const input = validInput();
  delete input.journey.turns[2].modelProof;
  input.journey.turns[2].actualModelProven = true;
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.modelProvenTurns, 7);
  assert.match(report.failures.join("\n"), /model proof detail/);
});

test("rejects claimed tool output and action explanation without rollout-derived hashes", () => {
  const input = validInput();
  input.journey.turns[4].history.toolOutputSeen = true;
  input.journey.turns[4].history.nonEmptyToolOutputHashes = [];
  input.journey.turns[4].history.preCommandExplanationSeen = true;
  input.journey.turns[4].history.preCommandExplanationHashes = [];
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.nonEmptyToolResults, 7);
  assert.equal(report.interaction.preCommandExplanations, 7);
  assert.match(report.failures.join("\n"), /rollout-derived tool result or action explanation/);
});

test("rejects an empty scoped command object", () => {
  const input = validInput();
  input.journey.turns[6].history.scopedCommands = [{ command: "   " }];
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.match(report.failures.join("\n"), /no non-empty scoped command/);
});

test("rejects self-referential model route evidence where only requestedModel is provided", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  const proof = module.buildTurnModelProof({
    usedRealTraffic: true,
    requiredModel: "gemini-3.5-flash-low",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {},
    modelRouteEvidence: {
      newRouteCount: 1,
      routes: [{ requestedModel: "gemini-3.5-flash-low" }],
    },
  }, "gemini-3.5-flash-low");

  assert.equal(proof.proven, false);
  assert.equal(proof.newRouteMatched, false);
  assert.deepEqual(proof.proofSources, []);
  assert.deepEqual(proof.observedModels, ["gemini-3.5-flash-low"]);
});

test("allows model route evidence when resolvedModel differs from requestedModel", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  const proof = module.buildTurnModelProof({
    usedRealTraffic: true,
    requiredModel: "gemini-3.5-flash-low",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {},
    modelRouteEvidence: {
      newRouteCount: 1,
      routes: [{ requestedModel: "gpt-4o", resolvedModel: "gemini-3.5-flash-low" }],
    },
  }, "gemini-3.5-flash-low");

  assert.equal(proof.proven, true);
  assert.equal(proof.newRouteMatched, true);
  assert.deepEqual(proof.proofSources, ["new-model-route"]);
});

test("rejects model route evidence when only requestedModel matches and the resolved model is different", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  const proof = module.buildTurnModelProof({
    usedRealTraffic: true,
    requiredModel: "gemini-3.5-flash-low",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {},
    modelRouteEvidence: {
      newRouteCount: 1,
      routes: [{
        requestedModel: "gemini-3.5-flash-low",
        resolvedModel: "claude-sonnet-4-6",
      }],
    },
  }, "gemini-3.5-flash-low");

  assert.equal(proof.proven, false);
  assert.equal(proof.newRouteMatched, false);
  assert.deepEqual(proof.proofSources, []);
});

test("rejects a marker-scoped observed model that only contains the required model name", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  const proof = module.buildTurnModelProof({
    usedRealTraffic: true,
    requiredModel: "gemini-3.5-flash-low",
    modelSelectionEvidence: { matched: true },
    preSubmitModelSelectionEvidence: { matched: true },
    submitEvidence: {
      realSubmit: {
        ok: true,
        markerScopedRequestObserved: true,
        requiredModelMatched: true,
        observedModels: ["not-gemini-3.5-flash-low-fallback"],
      },
    },
    modelRouteEvidence: { newRouteCount: 0, routes: [] },
  }, "gemini-3.5-flash-low");

  assert.equal(proof.proven, false);
  assert.equal(proof.markerScopedSubmitMatched, false);
  assert.deepEqual(proof.proofSources, []);
});

test("rejects a turn with valid tool output and scoped commands but empty scopedCommandResultHashes (call-id correlation required)", () => {
  const input = validInput();
  input.journey.turns[3].history.scopedCommandResultHashes = [];
  input.journey.turns[3].history.toolOutputSeen = true;
  input.journey.turns[3].history.nonEmptyToolOutputHashes = [sha256Text("tool-result:node edge-once.mjs")];
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.nonEmptyToolResults, 7);
  assert.equal(report.interaction.turnContractsPassed, false);
  const failureText = report.failures.join("\n");
  assert.ok(
    /correlat/i.test(failureText) || /call.id/i.test(failureText) || /callId/i.test(failureText),
    `failure text must mention call-id correlation but got: ${failureText}`,
  );
});

test("correlates non-empty results only to the command that owns the same call id", async () => {
  const module = await import("../../scripts/lib/anticodex-gate8-evidence.mjs");
  assert.equal(typeof module.correlateScopedCommandResultHashes, "function");
  const commands = [
    { callId: "command-1", command: "node --test" },
    { callId: "read-1", command: "   " },
  ];
  const unrelatedOnly = module.correlateScopedCommandResultHashes(commands, [
    { callId: "command-1", text: "   " },
    { callId: "read-1", text: "unrelated read output" },
  ]);
  assert.deepEqual(unrelatedOnly, []);
  assert.deepEqual(module.correlateScopedCommandResultHashes(commands, [
    { callId: "command-1", text: "tests passed" },
    { callId: "read-1", text: "unrelated read output" },
  ]), [sha256Text("tests passed")]);
});

test("rejects command evidence with a missing command call id", () => {
  const input = validInput();
  input.journey.turns[5].history.scopedCommands[0].callId = "";
  const report = buildGate8Report(input);
  assert.equal(report.ok, false);
  assert.equal(report.interaction.turnContractsPassed, false);
  assert.match(report.failures.join("\n"), /missing or duplicate command call-id/);
});

test("the human long-journey source must reference scopedCommandResultHashes and call-id correlation", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  assert.match(source, /scopedCommandResultHashes/);
  assert.ok(
    /call.id|callId|correlat/i.test(source),
    "human long-journey source must reference call_id/callId correlation",
  );
});

test("the formal Gate 8 runner publishes a signed failure report after any unexpected stage error", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-gate8-final-long-task.mjs", import.meta.url), "utf8");
  assert.match(source, /async function runFormalGate8\(\)/);
  assert.match(source, /formalPhase\s*=\s*"visible-journey"/);
  assert.match(source, /realTrafficMayHaveStarted\s*=\s*true/);
  assert.match(source, /failureStage:\s*formalPhase/);
  assert.match(source, /longTaskStarted:\s*realTrafficMayHaveStarted/);
  assert.match(source, /writeSignedReport\(fallbackReport\)/);
});

test("the human long-journey runner publishes a fresh failure report after any unexpected stage error", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-human-long-journey.mjs", import.meta.url), "utf8");
  assert.match(source, /async function runHumanLongJourney\(\)/);
  assert.match(source, /humanPhase\s*=\s*"fixed-route-precondition"/);
  assert.match(source, /realTrafficMayHaveStarted\s*=\s*true/);
  assert.match(source, /failureStage:\s*humanPhase/);
  assert.match(source, /longTaskStarted:\s*realTrafficMayHaveStarted/);
  assert.match(source, /writeReport\(fallbackReport\)/);
  assert.match(source, /behaviorCovered:\s*ok/);
  assert.match(source, /observedTurnsByJourney/);
  assert.match(source, /retainJourneyTurnEvidence/);
});
