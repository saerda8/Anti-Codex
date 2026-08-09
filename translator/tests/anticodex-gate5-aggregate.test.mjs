import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const aggregateScriptUrl = new URL("../../scripts/test-anticodex-gate5-visible-integration.mjs", import.meta.url);
const aggregateScriptPath = fileURLToPath(aggregateScriptUrl);
const releaseGateScriptUrl = new URL("../../scripts/test-anticodex-release-gates.mjs", import.meta.url);
const sourcePreflightScriptUrl = new URL("../../scripts/test-anticodex-source-preflight.ps1", import.meta.url);
const managerActions = [
  "refreshStatus", "refreshModels", "accountSwitch", "accountProxy",
  "syncReadiness", "repairShortcuts", "updateCheck", "sourcePreflight",
  "mcpSkills", "pluginCapabilities", "diagnosticsBundle", "viewLatestReports",
  "syncHost", "upstreamConfig", "refreshFeatures", "stabilitySoak",
  "coldRelaunch", "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull",
];
const safeRealActions = [
  "updateCheck", "repairShortcuts", "mcpSkills", "pluginCapabilities",
  "viewLatestReports", "diagnosticsBundle",
];
const highImpactActions = [
  "syncHost", "refreshFeatures", "stabilitySoak", "coldRelaunch",
  "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull",
];
const sourceRoot = resolve(dirname(aggregateScriptPath), "..");
const virtualManagerActions = new Set(["refreshStatus", "refreshModels", "viewLatestReports"]);
const scriptHandlerByAction = {
  accountSwitch: "open-antigravity-account-switch.ps1", accountProxy: "test-anticodex-account-proxy-readiness.ps1",
  syncReadiness: "test-anticodex-sync-readiness.ps1", repairShortcuts: "repair-anticodex-shortcuts.ps1",
  updateCheck: "check-anticodex-update.ps1", sourcePreflight: "test-anticodex-source-preflight.ps1",
  mcpSkills: "test-anticodex-mcp-skills.ps1", pluginCapabilities: "test-anticodex-plugin-capabilities.ps1",
  diagnosticsBundle: "collect-anticodex-diagnostics.ps1", syncHost: "sync-anticodex-launcher.ps1",
  refreshFeatures: "refresh-anticodex-local-features.ps1", stabilitySoak: "test-anticodex-stability-soak.ps1",
  coldRelaunch: "test-anticodex-cold-relaunch.ps1", fastOverallNoTraffic: "test-anticodex-installed-overall.ps1",
  overallNoTraffic: "test-anticodex-installed-overall.ps1", postVerificationFull: "test-anticodex-post-verification.ps1",
};
const managerHandlerContracts = Object.fromEntries(managerActions.map((action) => [action, {
  verified: true,
  kind: action === "upstreamConfig" ? "ui-function" : (virtualManagerActions.has(action) ? "virtual" : "script"),
  source: action === "upstreamConfig" ? "scripts/anticodex-manager-inject.js" : "scripts/anticodex-manager-service.mjs",
  handler: action === "upstreamConfig" ? "ui-function" : (virtualManagerActions.has(action) ? "virtual" : scriptHandlerByAction[action]),
}]));
const managerContractFiles = [...new Set(Object.values(managerHandlerContracts).flatMap((entry) => [
  entry.source, String(entry.handler).endsWith(".ps1") ? `scripts/${entry.handler}` : "",
]).filter(Boolean))];

test("Gate 5 is an offline explicit-evidence aggregate, not an old traffic/UI runner", async () => {
  const source = await readFile(aggregateScriptUrl, "utf8");
  for (const requiredFlag of [
    "--task-manifest",
    "--manager-evidence",
    "--model-switch-evidence",
    "--shortcut-restore-evidence",
    "--release-binding-evidence",
  ]) assert.match(source, new RegExp(requiredFlag));
  assert.match(source, /args\.has\("--help"\)/);
  assert.doesNotMatch(source, /spawnSync|fetch\s*\(/);
  assert.doesNotMatch(source, /latest-gate5-visible-(?:text|tool|history)/);
  assert.doesNotMatch(source, /gemini-3-flash-agent|1\.2\.36/);
});

test("release validation deeply rechecks every current Gate 5 UI invariant", async () => {
  const source = await readFile(releaseGateScriptUrl, "utf8");
  for (const contract of [
    /Number\(manager\?\.actionCount\) < 20/,
    /manager\?\.zeroSideEffects !== true/,
    /handlerVerification\?\.allFunctionsVerified !== false/,
    /exactStringList\(handlerVerification\?\.realExecutedActionIds, \[\]\)/,
    /protocol\?\.before !== "chatCompletions"/,
    /protocol\?\.alternate !== "responses"/,
    /protocol\?\.restored !== protocol\?\.before/,
    /protocol\?\.profileUnchanged !== true/,
    /Array\.isArray\(manager\?\.closeProbes\)/,
    /switches\.length < 3/,
    /entry\?\.actualMouse !== true/,
    /entry\?\.taskId !== modelSwitch\?\.taskId/,
    /entry\?\.requestCountBefore\) !== Number\(entry\?\.requestCountAfter/,
    /const pidNames = \["supervisor", "codexPlusPlus", "antiCodexMain"\]/,
    /rounds\.length < 3/,
    /round\?\.blankFrameCount/,
    /round\?\.maxVisibleWindowCount/,
    /const sourceTimestampMs = reportTimestampMs\(data\)/,
  ]) assert.match(source, contract);
});

test("release validation rejects skipped, dirty, or old-revision source preflight evidence", async () => {
  const [releaseSource, preflightSource] = await Promise.all([
    readFile(releaseGateScriptUrl, "utf8"),
    readFile(sourcePreflightScriptUrl, "utf8"),
  ]);
  assert.match(preflightSource, /git rev-parse HEAD/);
  assert.match(preflightSource, /git status --porcelain/);
  assert.match(preflightSource, /sourceGitHead\s*=/);
  assert.match(preflightSource, /sourceGitClean\s*=/);
  assert.match(releaseSource, /skipFullRegression/);
  assert.match(releaseSource, /source_preflight_full_regression/);
  assert.match(releaseSource, /source_preflight_git_revision/);
  assert.match(releaseSource, /source_preflight_git_generated_dirty/);
  assert.match(releaseSource, /source_preflight_git_dirty/);
});

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeSigned(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, "utf8");
  writeFileSync(`${path}.sha256`, `sha256:${hash(body)}`, "ascii");
}

function fixture(root) {
  const checkedAt = new Date().toISOString();
  const runtimeRoot = join(root, "runtime");
  mkdirSync(join(runtimeRoot, "scripts"), { recursive: true });
  const runtimeFiles = managerContractFiles.map((relativePath) => {
    const bytes = readFileSync(resolve(sourceRoot, relativePath));
    const runtimePath = resolve(runtimeRoot, relativePath);
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, bytes);
    return { relativePath, fileSha256: hash(bytes), manifestSha256: hash(bytes) };
  });
  const sourceGitHead = String(spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout || "").trim().toLowerCase();
  const manifestPath = join(runtimeRoot, ".anticodex-runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "anticodex-runtime-manifest-v2", state: "validated", activeRuntime: runtimeRoot,
    sourceRoot, sourceGitHead, sourceGitClean: true, sourceRevisionProvenance: "git",
    files: Object.fromEntries(runtimeFiles.map((entry) => [entry.relativePath.replaceAll("/", "\\"), entry.fileSha256])),
  }, null, 2)}\n`, "utf8");
  const taskId = "019f9000-1111-7222-8333-444444444444";
  const releaseBinding = {
    schema: "anticodex-release-binding-v1",
    valid: true,
    officialShellVersion: "26.715.10079.0",
    activeShellVersion: "26.715.10079.0",
    codexPlusPlusVersion: "1.2.39",
    codexPlusPlusPatchCommit: "a".repeat(40),
    codexPlusPlusBinarySha256: "b".repeat(64),
    codexPlusPlusPatchTreeSha256: "c".repeat(64),
    codexPlusPlusPatchCount: 9,
    syncReadinessSha256: "d".repeat(64),
  };
  const artifacts = ["master.mp4", "manifest.json", "README.md"].map((name, index) => {
    const path = join(root, name);
    const body = Buffer.from(`artifact-${index + 1}`);
    writeFileSync(path, body);
    return { name, path, bytes: body.length, sha256: hash(body) };
  });
  const rolloutPath = join(root, "rollout.jsonl");
  const rolloutBody = `${JSON.stringify({
    timestamp: checkedAt,
    type: "event_msg",
    payload: { type: "user_message", message: "只提交一次完整自主总目标。" },
  })}\n`;
  writeFileSync(rolloutPath, rolloutBody, "utf8");
  const taskManifest = {
    schema: "anticodex-native-autonomous-task-manifest-v1",
    reportName: "native-autonomous-task-manifest",
    checkedAt,
    ok: true,
    newTask: true,
    nativeTask: true,
    sameTask: true,
    taskId,
    turnId: "turn-1",
    promptSubmissionCount: 1,
    totalGoalPromptCount: 1,
    continuationPromptCount: 0,
    hostMessageCount: 1,
    hostIntermediatePromptCount: 0,
    continuations: [],
    rollout: {
      path: rolloutPath,
      sha256: hash(rolloutBody),
      bytes: Buffer.byteLength(rolloutBody),
      messageCount: 1,
      userTurnCount: 1,
    },
    requestedRealTraffic: true,
    usedRealTraffic: true,
    route: { state: "ready", provider: "antigravity", model: "gemini-3.1-pro-low", relayProtocol: "chatCompletions", codexPlusPlusVersion: "1.2.39" },
    artifacts,
    releaseBinding,
  };
  const managerEvidence = {
    schema: "anticodex-manager-actual-mouse-matrix-v2",
    checkedAt,
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    actionCount: 20,
    zeroSideEffects: true,
    uiInteraction: {
      scope: "ui-interaction-only",
      verifiedActionIds: managerActions,
      verifiedCount: managerActions.length,
    },
    handlerVerification: {
      offlineContractVerifiedActionIds: managerActions,
      safeRealActionIds: safeRealActions,
      realExecutedActionIds: [],
      pendingAuthorizedActionIds: highImpactActions,
      allFunctionsVerified: false,
      contracts: managerHandlerContracts,
      provenance: {
        schema: "anticodex-manager-handler-provenance-v1", verified: true,
        runtimeRoot, scriptsRoot: join(runtimeRoot, "scripts"), manifestPath,
        manifestSha256: hash(readFileSync(manifestPath)), sourceRoot, sourceGitHead,
        sourceGitClean: true, sourceRevisionProvenance: "git", files: runtimeFiles,
      },
    },
    actualMouse: true,
    profileEntryText: "管理",
    forbiddenEnglishVisible: false,
    trayIconPreserved: true,
    closeProbes: ["upper-center", "center", "lower-center"].map((name) => ({ name, ok: true, actualMouse: true, closed: true, hasTextNode: false })),
    protocolInteraction: {
      before: "chatCompletions",
      alternate: "responses",
      restored: "chatCompletions",
      selectedAlternate: true,
      restoredOriginal: true,
      profileUnchanged: true,
    },
    releaseBinding,
  };
  const switches = ["gemini", "claude", "third-party"].map((provider) => ({
    ok: true,
    provider,
    taskId,
    actualMouse: true,
    requestCountBefore: 7,
    requestCountAfter: 7,
    latestRequestRowIdBefore: 12,
    latestRequestRowIdAfter: 12,
    supervisorPidBefore: 101,
    supervisorPidAfter: 101,
    codexPlusPlusPidBefore: 102,
    codexPlusPlusPidAfter: 102,
    antiCodexMainPidBefore: 103,
    antiCodexMainPidAfter: 103,
    originalCodexAlive: true,
  }));
  const modelSwitchEvidence = {
    schema: "anticodex-frontend-model-hot-switch-v1",
    checkedAt,
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    sameTask: true,
    taskId,
    switches,
    releaseBinding,
  };
  const rounds = [1, 2, 3].map(() => ({
    ok: true,
    expectedMainPid: 103,
    expectedOriginalCodexPid: 201,
    minimizedObserved: true,
    restoredAtMs: 900,
    maxRootProcessCount: 1,
    maxVisibleWindowCount: 1,
    maxAppPageCount: 1,
    appPagesAfter: 1,
    blankFrameCount: 0,
    frameCount: 3,
    originalCodexAlive: true,
    after: { rootProcessIds: [103], visibleWindowProcessIds: [103] },
  }));
  const shortcutRestoreEvidence = {
    schema: "anticodex-shortcut-restore-matrix-v1",
    checkedAt,
    ok: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    rounds,
    releaseBinding,
  };
  const releaseBindingEvidence = { schema: "anticodex-release-binding-report-v1", checkedAt, releaseBinding: structuredClone(releaseBinding) };
  const values = { taskManifest, managerEvidence, modelSwitchEvidence, shortcutRestoreEvidence, releaseBindingEvidence };
  const paths = Object.fromEntries(Object.keys(values).map((name) => [name, join(root, `${name}.json`)]));
  return { values, paths, artifacts, rolloutPath };
}

function addContinuation(state) {
  const continuationAt = new Date().toISOString();
  const rolloutBody = `${readFileSync(state.rolloutPath, "utf8")}${JSON.stringify({
    timestamp: continuationAt,
    type: "event_msg",
    payload: { type: "user_message", message: "继续" },
  })}\n`;
  writeFileSync(state.rolloutPath, rolloutBody, "utf8");
  state.values.taskManifest.continuationPromptCount = 1;
  state.values.taskManifest.hostMessageCount = 2;
  state.values.taskManifest.continuations = [{
    sequence: 1,
    turnId: "turn-2",
    at: continuationAt,
    previousTurnId: "turn-1",
    interruptionAt: continuationAt,
    interruptionKind: "task_complete.error",
    interruptionErrorSha256: hash("unexpected status 503 Service Unavailable"),
    messageSha256: hash("继续"),
  }];
  state.values.taskManifest.rollout = {
    path: state.rolloutPath,
    sha256: hash(rolloutBody),
    bytes: Buffer.byteLength(rolloutBody),
    messageCount: 2,
    userTurnCount: 2,
  };
}

function runFixture(root, mutate = () => {}) {
  const state = fixture(root);
  mutate(state);
  for (const [name, value] of Object.entries(state.values)) writeSigned(state.paths[name], value);
  const reportRoot = join(root, "reports");
  const auditPath = join(root, "gate5-audit.json");
  const child = spawnSync(process.execPath, [
    aggregateScriptPath,
    "--task-manifest", state.paths.taskManifest,
    "--manager-evidence", state.paths.managerEvidence,
    "--model-switch-evidence", state.paths.modelSwitchEvidence,
    "--shortcut-restore-evidence", state.paths.shortcutRestoreEvidence,
    "--release-binding-evidence", state.paths.releaseBindingEvidence,
    "--report-root", reportRoot,
    "--audit-out", auditPath,
    "--compact",
  ], { encoding: "utf8", windowsHide: true });
  const payload = JSON.parse(String(child.stdout || "{}").trim() || "{}");
  return { child, payload, reportRoot, auditPath, state };
}

test("Gate 5 rehashes current artifacts and signs a successful offline aggregate", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-aggregate-"));
  try {
    const result = runFixture(root);
    assert.equal(result.child.status, 0, result.child.stderr || JSON.stringify(result.payload));
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.artifactCount, 3);
    assert.equal(result.payload.managerUiInteractionCount, 20);
    assert.equal(result.payload.modelSwitchCount, 3);
    assert.equal(result.payload.shortcutRestoreRounds, 3);
    const latest = join(result.reportRoot, "latest-gate5-visible-integration.json");
    const body = readFileSync(latest);
    assert.equal(readFileSync(`${latest}.sha256`, "ascii").trim(), `sha256:${hash(body)}`);
    const report = JSON.parse(body);
    assert.equal(report.requestedRealTraffic, false);
    assert.equal(report.usedRealTraffic, false);
    assert.equal(report.sourceEvidenceUsedRealTraffic, true);
    assert.ok(report.artifactEvidence.every((artifact) => artifact.ok && artifact.actualHash === artifact.expectedHash));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gate 5 accepts a signed exact-continuation ledger with consistent counts and turn chain", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-continuation-ledger-"));
  try {
    const result = runFixture(root, addContinuation);
    assert.equal(result.child.status, 0, result.child.stderr || JSON.stringify(result.payload));
    assert.equal(result.payload.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gate 5 fails closed when continuation counts do not match the signed ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-continuation-counts-"));
  try {
    const result = runFixture(root, ({ values }) => {
      values.taskManifest.continuationPromptCount = 1;
      values.taskManifest.hostMessageCount = 2;
    });
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /new_native_task_one_total_goal|continuation/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gate 5 fails closed when a continuation does not chain from the preceding native turn", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-continuation-chain-"));
  try {
    const result = runFixture(root, (state) => {
      addContinuation(state);
      state.values.taskManifest.continuations[0].previousTurnId = "turn-other";
    });
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /new_native_task_one_total_goal|continuation/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gate 5 rehashes the native rollout bound into the signed task manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-rollout-rehash-"));
  try {
    const result = runFixture(root, ({ rolloutPath }) => {
      writeFileSync(rolloutPath, `${readFileSync(rolloutPath, "utf8")}tampered\n`, "utf8");
    });
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /native_rollout_rehashed|rollout/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const rejectionCases = [
  ["old component version", ({ values }) => { values.taskManifest.route.codexPlusPlusVersion = "1.2.36"; }, /new_native_task_one_total_goal|current_antigravity_route_bound/],
  ["protocol not restored", ({ values }) => { values.managerEvidence.protocolInteraction.restored = "responses"; }, /manager_actual_mouse_matrix|manager_protocol_physical_round_trip/],
  ["profile changed", ({ values }) => { values.managerEvidence.protocolInteraction.profileUnchanged = false; }, /manager_actual_mouse_matrix/],
  ["English Manager label", ({ values }) => { values.managerEvidence.profileEntryText = "Manager"; values.managerEvidence.forbiddenEnglishVisible = true; }, /profile_menu_uses_exact_chinese_manager_label/],
  ["Manager has only 19 actions", ({ values }) => { values.managerEvidence.actionCount = 19; }, /manager_actual_mouse_matrix/],
  ["Manager records side effects", ({ values }) => { values.managerEvidence.zeroSideEffects = false; }, /manager_actual_mouse_matrix/],
  ["Manager handler provenance points at the wrong runtime", ({ values }) => {
    values.managerEvidence.handlerVerification.provenance = {
      schema: "anticodex-manager-handler-provenance-v1",
      runtimeRoot: "C:\\wrong-runtime",
      scriptsRoot: "C:\\wrong-runtime\\scripts",
      manifestPath: "C:\\wrong-runtime\\.anticodex-runtime-manifest.json",
      manifestSha256: "a".repeat(64),
      sourceGitHead: "b".repeat(40),
      files: [{ relativePath: "scripts/anticodex-manager-service.mjs", fileSha256: "c".repeat(64) }],
    };
  }, /manager_actual_mouse_matrix|handler.*provenance/i],
  ["UI-only Manager claims all functions verified", ({ values }) => { values.managerEvidence.handlerVerification.allFunctionsVerified = true; }, /manager_actual_mouse_matrix/],
  ["close contains a real text node", ({ values }) => { values.managerEvidence.closeProbes[1].hasTextNode = true; }, /manager_close_full_height_actual_mouse/],
  ["model request count changed", ({ values }) => { values.modelSwitchEvidence.switches[1].requestCountAfter = 8; }, /frontend_model_hot_switch_zero_requests/],
  ["model switch restarted a process", ({ values }) => { values.modelSwitchEvidence.switches[1].antiCodexMainPidAfter = 999; }, /frontend_model_hot_switch_stable_processes/],
  ["model switch used another task", ({ values }) => { values.modelSwitchEvidence.switches[1].taskId = "019f9000-1111-7222-8333-555555555555"; }, /frontend_model_hot_switch_same_task/],
  ["shortcut has fewer than three rounds", ({ values }) => { values.shortcutRestoreEvidence.rounds.pop(); }, /shortcut_restore_three_rounds/],
  ["shortcut shows a blank frame", ({ values }) => { values.shortcutRestoreEvidence.rounds[1].blankFrameCount = 1; }, /shortcut_restore_single_window_no_blank_frames/],
  ["shortcut opens a second window", ({ values }) => { values.shortcutRestoreEvidence.rounds[1].maxVisibleWindowCount = 2; }, /shortcut_restore_single_window_no_blank_frames/],
  ["artifact is missing", ({ artifacts }) => { unlinkSync(artifacts[1].path); }, /current_task_artifacts_rehashed/],
  ["artifact hash is wrong", ({ values }) => { values.taskManifest.artifacts[1].sha256 = "f".repeat(64); }, /current_task_artifacts_rehashed/],
  ["evidence is stale", ({ values }) => { values.managerEvidence.checkedAt = new Date(Date.now() - 72 * 3_600_000).toISOString(); }, /managerEvidence_signed_fresh/],
  ["release binding is old", ({ values }) => { values.releaseBindingEvidence.releaseBinding.codexPlusPlusBinarySha256 = "0".repeat(64); }, /release_binding_current_and_shared/],
];

for (const [name, mutate, expectedFailure] of rejectionCases) {
  test(`Gate 5 fails closed when ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-reject-"));
    try {
      const result = runFixture(root, mutate);
      assert.equal(result.child.status, 1, `${name}: ${result.child.stderr}`);
      assert.equal(result.payload.ok, false);
      assert.match(result.payload.failures.join("\n"), expectedFailure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
