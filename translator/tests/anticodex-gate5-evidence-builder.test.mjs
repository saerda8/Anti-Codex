import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const builderPath = fileURLToPath(new URL("../../scripts/build-anticodex-gate5-evidence.mjs", import.meta.url));
const aggregatePath = fileURLToPath(new URL("../../scripts/test-anticodex-gate5-visible-integration.mjs", import.meta.url));
const uiChatPath = fileURLToPath(new URL("../../scripts/test-anticodex-ui-chat-smoke.mjs", import.meta.url));
const liveTrayProbePath = fileURLToPath(new URL("../../scripts/test-anticodex-live-tray-icon.ps1", import.meta.url));
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
const virtualManagerActions = new Set(["refreshStatus", "refreshModels", "viewLatestReports"]);
const scriptHandlerByAction = {
  accountSwitch: "open-antigravity-account-switch.ps1",
  accountProxy: "test-anticodex-account-proxy-readiness.ps1",
  syncReadiness: "test-anticodex-sync-readiness.ps1",
  repairShortcuts: "repair-anticodex-shortcuts.ps1",
  updateCheck: "check-anticodex-update.ps1",
  sourcePreflight: "test-anticodex-source-preflight.ps1",
  mcpSkills: "test-anticodex-mcp-skills.ps1",
  pluginCapabilities: "test-anticodex-plugin-capabilities.ps1",
  diagnosticsBundle: "collect-anticodex-diagnostics.ps1",
  syncHost: "sync-anticodex-launcher.ps1",
  refreshFeatures: "refresh-anticodex-local-features.ps1",
  stabilitySoak: "test-anticodex-stability-soak.ps1",
  coldRelaunch: "test-anticodex-cold-relaunch.ps1",
  fastOverallNoTraffic: "test-anticodex-installed-overall.ps1",
  overallNoTraffic: "test-anticodex-installed-overall.ps1",
  postVerificationFull: "test-anticodex-post-verification.ps1",
};
const managerHandlerContracts = Object.fromEntries(managerActions.map((action) => [action, {
  verified: true,
  kind: action === "upstreamConfig" ? "ui-function" : (virtualManagerActions.has(action) ? "virtual" : "script"),
  source: action === "upstreamConfig" ? "scripts/anticodex-manager-inject.js" : "scripts/anticodex-manager-service.mjs",
  handler: action === "upstreamConfig" ? "ui-function" : (virtualManagerActions.has(action) ? "virtual" : scriptHandlerByAction[action]),
}]));
const sourceRoot = resolve(dirname(builderPath), "..");
const fixtureSupervisorPid = 101;
const fixtureSupervisorCreationDateUtc = "2026-08-09T00:00:00.0000000Z";
const managerContractFiles = [...new Set(["scripts/start-anticodex-fixed-route.mjs", ...Object.values(managerHandlerContracts).flatMap((entry) => [
  entry.source,
  String(entry.handler).endsWith(".ps1") ? `scripts/${entry.handler}` : "",
])].filter(Boolean))];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(path, value, { signed = false } = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, "utf8");
  if (signed) writeFileSync(`${path}.sha256`, `sha256:${sha256(body)}`, "ascii");
  return sha256(body);
}

function queryExactWindowsProcessIdentity(processId) {
  if (!Number.isInteger(processId) || processId <= 0 || process.platform !== "win32") return null;
  const powershellPath = resolve(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}" -ErrorAction Stop); if ($rows.Count -ne 1) { throw "exact process not found" }; $row = $rows[0]; [pscustomobject]@{ processId = [int]$row.ProcessId; creationDateUtc = ([DateTime]$row.CreationDate).ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture) } | ConvertTo-Json -Compress`;
  const result = spawnSync(powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  try { return JSON.parse(String(result.stdout || "").trim()); } catch { return null; }
}

function startSuspendedSupervisor(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, NODE_OPTIONS: "--inspect-brk=0" },
    stdio: "ignore",
    windowsHide: true,
  });
  let snapshot = null;
  for (let attempt = 0; attempt < 20 && !snapshot; attempt += 1) {
    snapshot = queryExactWindowsProcessIdentity(child.pid);
    if (!snapshot) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (!snapshot) {
    child.kill();
    throw new Error("could not observe suspended fixed-route test supervisor");
  }
  return { child, creationDateUtc: snapshot.creationDateUtc };
}

function stopTestSupervisor(supervisor, {
  queryProcess = queryExactWindowsProcessIdentity,
  killProcessTree = (processId) => spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { windowsHide: true, stdio: "ignore" }),
} = {}) {
  const processId = Number(supervisor?.child?.pid || 0);
  const expectedCreationDateUtc = String(supervisor?.creationDateUtc || "");
  if (!Number.isInteger(processId) || processId <= 0 || !expectedCreationDateUtc) return false;
  const liveProcess = queryProcess(processId);
  if (Number(liveProcess?.processId || 0) !== processId
    || String(liveProcess?.creationDateUtc || "") !== expectedCreationDateUtc) return false;
  return killProcessTree(processId)?.status === 0;
}

test("paused builder supervisor cleanup rejects a reused PID identity", () => {
  const supervisor = {
    child: { pid: 999999999 },
    creationDateUtc: "2026-08-09T00:00:00.0000000Z",
  };
  let killCalls = 0;
  const killProcessTree = () => { killCalls += 1; return { status: 0 }; };
  assert.equal(stopTestSupervisor(supervisor, {
    queryProcess: () => ({
      processId: supervisor.child.pid,
      creationDateUtc: "2026-08-09T00:00:01.0000000Z",
    }),
    killProcessTree,
  }), false);
  assert.equal(killCalls, 0);
  assert.equal(stopTestSupervisor(supervisor, {
    queryProcess: () => ({ processId: supervisor.child.pid, creationDateUtc: supervisor.creationDateUtc }),
    killProcessTree,
  }), true);
  assert.equal(killCalls, 1);
});

function replaceFixtureSupervisorIdentity(value, actualPid) {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (["supervisorPid", "supervisorBefore", "supervisorAfter"].includes(key) && Number(entry) === fixtureSupervisorPid) {
      value[key] = actualPid;
    } else {
      replaceFixtureSupervisorIdentity(entry, actualPid);
    }
  }
}

function bindStateToSupervisor(state, supervisor) {
  const evidencePaths = [
    state.paths.taskReceipt,
    state.paths.managerMatrix,
    state.paths.managerProfile,
    state.paths.managerClose,
    state.paths.managerProtocol,
    ...state.paths.modelSwitches,
    ...state.paths.shortcutRounds,
  ];
  for (const path of evidencePaths) {
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    replaceFixtureSupervisorIdentity(evidence, supervisor.child.pid);
    const provenance = evidence?.managerButton?.payload?.handlerContractEvidence?.provenance;
    if (provenance?.taskRuntimePid === fixtureSupervisorPid) provenance.taskRuntimePid = supervisor.child.pid;
    if (provenance?.taskRuntimeCreationDateUtc === fixtureSupervisorCreationDateUtc) {
      provenance.taskRuntimeCreationDateUtc = supervisor.creationDateUtc;
    }
    writeJson(path, evidence, { signed: true });
  }
}

function buildRawEvidence(root) {
  const taskId = "019f9000-1111-7222-8333-444444444444";
  const prompt = "只提交一次完整自主总目标。";
  const taskStartedAt = new Date(Date.now() - 60_000).toISOString();
  const checkedAt = new Date().toISOString();
  const runtimeRoot = join(root, "runtime");
  const runtimeScriptsRoot = join(runtimeRoot, "scripts");
  mkdirSync(runtimeScriptsRoot, { recursive: true });
  const runtimeFiles = managerContractFiles.map((relativePath) => {
    const sourcePath = resolve(sourceRoot, relativePath);
    const runtimePath = resolve(runtimeRoot, relativePath);
    mkdirSync(dirname(runtimePath), { recursive: true });
    const bytes = readFileSync(sourcePath);
    writeFileSync(runtimePath, bytes);
    return { relativePath, fileSha256: sha256(bytes), manifestSha256: sha256(bytes) };
  });
  const sourceGitHead = String(spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout || "").trim().toLowerCase();
  const manifestPath = join(runtimeRoot, ".anticodex-runtime-manifest.json");
  const runtimeManifest = {
    schema: "anticodex-runtime-manifest-v2", state: "validated", activeRuntime: runtimeRoot,
    sourceRoot, sourceGitHead, sourceGitClean: true, sourceRevisionProvenance: "git",
    createdAt: "2026-08-08T23:59:00.000Z",
    files: Object.fromEntries(runtimeFiles.map((entry) => [entry.relativePath.replaceAll("/", "\\"), entry.fileSha256])),
  };
  writeFileSync(manifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, "utf8");
  const projectRoot = join(root, "project");
  const promptPath = join(root, "total-goal.md");
  const rolloutPath = join(root, "rollout.jsonl");
  writeFileSync(promptPath, prompt, "utf8");
  mkdirSync(projectRoot, { recursive: true });

  const artifactPaths = ["master.mp4", "manifest.json", "README.md"].map((name, index) => {
    const path = join(projectRoot, name);
    writeFileSync(path, `artifact-${index + 1}`, "utf8");
    return path;
  });
  writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: taskStartedAt, type: "session_meta", payload: { id: taskId, cwd: projectRoot } }),
    JSON.stringify({ timestamp: taskStartedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ timestamp: taskStartedAt, type: "turn_context", payload: { turn_id: "turn-1", cwd: projectRoot, model: "gemini-3.1-pro-low" } }),
    JSON.stringify({
      timestamp: taskStartedAt,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }),
    JSON.stringify({ timestamp: taskStartedAt, type: "event_msg", payload: { type: "user_message", message: prompt } }),
    JSON.stringify({
      timestamp: checkedAt,
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: JSON.stringify({ created: artifactPaths }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const target = { id: "app-page-1", title: "Anti-Codex", url: "app://codex/index.html" };
  const cdpPort = 18318;
  const runtimeProcessIdentity = {
    supervisorPid: fixtureSupervisorPid,
    codexPlusPlusPid: 102,
    antiCodexMainPid: 103,
    originalCodexPid: 201,
    originalCodexAlive: true,
  };
  const runtimeSessionIdentity = {
    cdpPort,
    targetId: target.id,
    targetUrl: target.url,
  };
  const taskReceipt = {
    ok: true,
    checkedAt,
    taskStartedAt,
    reportName: "ui-new-autonomous-long-task",
    coverageKind: "desktop-ui-single-submit-handoff",
    singleSubmitHandoff: true,
    taskMode: "exact-marker",
    requestedRealTraffic: true,
    usedRealTraffic: true,
    promptFile: promptPath,
    promptSha256: sha256(prompt),
    projectRoot,
    requiredModel: "gemini-3.1-pro-low",
    maximumSendClicks: 1,
    sendClickCount: 1,
    sendDispatched: true,
    waitedForTaskCompletion: false,
    harnessInterruptedTask: false,
    harnessSubmittedAdditionalTurns: false,
    cdpPort,
    target,
    processIdentity: runtimeProcessIdentity,
    startupEvidence: {
      ok: true,
      rollout: {
        ok: true,
        newTask: true,
        sessionId: taskId,
        taskId,
        turnId: "turn-1",
        file: rolloutPath,
        cwd: projectRoot,
        cwdMatched: true,
        model: "gemini-3.1-pro-low",
        modelMatched: true,
        promptSeen: true,
      },
      native: {
        ok: true,
        taskId,
        reason: "task_bound_native_request",
        expectedRequestObserved: true,
        activity: {
          expectedThreadIds: [taskId],
          unexpectedRequestThreadIds: [],
          unexpectedExecutionThreadIds: [],
          titleThreadsUsedTools: false,
          taskSuggestionThreadsUsedTools: false,
        },
      },
      upstream: {
        ok: true,
        request: {
          relayId: "anticodex-antigravity",
          endpoint: "/v1/chat/completions",
          wireApi: "chat-completions",
          attempt: 1,
          candidateCount: 1,
          requestTools: { count: 17 },
          upstreamTools: { count: 17 },
        },
        response: {
          relayId: "anticodex-antigravity",
          endpoint: "/v1/chat/completions",
          statusCode: 200,
          attempt: 1,
          candidateCount: 1,
        },
      },
    },
  };

  const actions = managerActions;
  const managerMatrix = {
    ok: true,
    checkedAt,
    reportName: "manager-ui-only-button-matrix",
    processIdentity: runtimeProcessIdentity,
    sessionIdentity: runtimeSessionIdentity,
    runtimeRoot,
    managerButton: {
      ok: true,
      payload: {
        ok: true,
        mode: "ui-only-matrix",
        target,
        processIdentity: runtimeProcessIdentity,
        sessionIdentity: runtimeSessionIdentity,
        actions,
        zeroSideEffects: true,
        usedRealTraffic: false,
        uiInteractionEvidence: {
          schema: "anticodex-manager-ui-interaction-v1",
          scope: "ui-interaction-only",
          verifiedActions: actions,
          passedCount: actions.length,
        },
        handlerContractEvidence: {
          schema: "anticodex-manager-handler-contract-v1",
          contracts: managerHandlerContracts,
          provenance: {
            schema: "anticodex-manager-handler-provenance-v1", verified: true,
            runtimeRoot, scriptsRoot: runtimeScriptsRoot, manifestPath,
            manifestSha256: sha256(readFileSync(manifestPath)), sourceRoot, sourceGitHead,
            sourceGitClean: true, sourceRevisionProvenance: "git", files: runtimeFiles,
            taskRuntimePid: runtimeProcessIdentity.supervisorPid,
            taskRuntimeScriptPath: join(runtimeScriptsRoot, "start-anticodex-fixed-route.mjs"),
            taskRuntimeCreationDateUtc: fixtureSupervisorCreationDateUtc,
          },
          offlineContractVerifiedActions: actions,
          safeRealActionAllowlist: safeRealActions,
          liveExecutedActions: [],
          pendingAuthorizedActions: highImpactActions,
          allFunctionsVerified: false,
        },
        results: Object.fromEntries(actions.map((action) => [action, {
          ok: true,
          action,
          lastUiOnly: true,
          actionActualMouseOk: true,
          managerOpenedNewPage: false,
        }])),
      },
    },
  };
  const managerProfile = {
    ok: true,
    checkedAt,
    target,
    processIdentity: runtimeProcessIdentity,
    sessionIdentity: runtimeSessionIdentity,
    profileEntry: {
      ok: true,
      phase: "profile-entry-actual-mouse",
      profileEntryText: "管理",
      forbiddenEnglishVisible: false,
      actualMouseOpened: true,
    },
  };
  const managerClose = {
    ok: true,
    checkedAt,
    target,
    processIdentity: runtimeProcessIdentity,
    sessionIdentity: runtimeSessionIdentity,
    finalOverlayClosed: true,
    closeActualMouse: {
      ok: true,
      phase: "actual-click",
      finalOverlayClosed: true,
      probes: ["upper-center", "center", "lower-center"].map((name) => ({
        name,
        ok: true,
        closed: true,
        hasTextNode: false,
      })),
    },
  };
  const managerProtocol = {
    ok: true,
    checkedAt,
    target,
    processIdentity: runtimeProcessIdentity,
    sessionIdentity: runtimeSessionIdentity,
    upstreamConfig: {
      ok: true,
      usedRealTraffic: false,
      profileUnchanged: true,
      closeActualMouse: true,
      closeHasTextNode: false,
      pageTargetCountBefore: 1,
      pageTargetCountAfter: 1,
      protocolInteraction: {
        ok: true,
        selectedAlternate: true,
        restoredOriginal: true,
        before: { value: "chatCompletions" },
        alternate: { value: "responses" },
        restored: { value: "chatCompletions" },
      },
    },
  };

  const processIdentity = {
    supervisorBefore: 101,
    supervisorAfter: 101,
    codexPlusPlusBefore: 102,
    codexPlusPlusAfter: 102,
    antiCodexMainBefore: 103,
    antiCodexMainAfter: 103,
    expectedOriginalCodexPid: 201,
    originalCodexAlive: true,
  };
  const modelSwitches = [
    ["gemini", "gemini-3.1-pro-low"],
    ["claude", "claude-sonnet-4-6"],
    ["third-party", "third-party/gpt-5.6-sol"],
  ].map(([provider, model]) => ({
    ok: true,
    checkedAt,
    frontendModelProbeOnly: true,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    coverageKind: "desktop-ui-physical-model-switch-no-traffic",
    taskId,
    expectedTaskId: taskId,
    sameChatEvidence: { actualMouseClick: true },
    selection: { ok: true, actualMouseClick: true },
    selectedModel: { model, label: model },
    provider,
    requestEvidence: {
      beforeCount: 7,
      afterCount: 7,
      beforeLatestRequestRowId: 12,
      afterLatestRequestRowId: 12,
    },
    processIdentity,
    target,
  }));

  const shortcutRounds = [1, 2, 3].map((probeId) => ({
    ok: true,
    checkedAt,
    probeId,
    schema: "anticodex-shortcut-restore-acceptance-v1",
    activationMode: "taskbar-button",
    actualMouse: true,
    taskbarActivationObserved: true,
    taskbarActivationWaitMs: 120,
    taskbarClickSentAtMs: 25,
    frameCaptureOrigin: "exact-foreground-window",
    frameCaptureOriginMs: 145,
    visibleWindowCriterion: "presentable-exact-executable-v1",
    taskbarElement: {
      name: "Anti-Codex",
      accessibleName: "Anti-Codex - 1 个运行窗口",
      provider: "MSAA",
      role: 43,
      state: 0x40100000,
      childId: 16,
      taskListWindowHandle: 5001,
      taskbarClassName: "MSTaskListWClass",
      candidateCount: 1,
      isEnabled: true,
      isOffscreen: false,
      hitTestMatched: true,
    },
    taskbarRectangle: { left: 100, top: 1000, right: 148, bottom: 1048, width: 48, height: 48 },
    taskbarClickPoint: { x: 124, y: 1024 },
    windowHandleBefore: 7001,
    windowHandleAfter: 7001,
    samePid: true,
    sameHwnd: true,
    sameExecutable: true,
    sameCdpTarget: true,
    firstFrame: { elapsedMs: 160, mean: 180, standardDeviation: 25, darkRatio: 0.5, sampleCount: 640 },
    firstFrameDelayMs: 15,
    maxSampleIntervalMs: 45,
    earlyFrameCount: 12,
    frameSamplingThresholds: {
      maximumFirstFrameDelayMs: 100,
      maximumFrameSampleIntervalMs: 125,
      minimumEarlyFrameCount: 8,
      earlyWindowMs: 750,
    },
    failures: [],
    expectedMainPid: 103,
    expectedOriginalCodexPid: 201,
    minimizedObserved: true,
    reminimizedAfterRestore: false,
    restoredAtMs: 145,
    deadlineState: {
      elapsedMs: 3025,
      visible: true,
      minimized: false,
      foregroundWindowHandle: 7001,
      foregroundProcessId: 103,
      exactForeground: true,
    },
    probeRecoveryApplied: false,
    maxRootProcessCount: 1,
    maxVisibleWindowCount: 1,
    maxVisibleTopLevelWindowCount: 1,
    maxAppPageCount: 1,
    appPagesAfter: 1,
    blankFrameCount: 0,
    frameCount: 3,
    originalCodexAlive: true,
    after: { rootProcessIds: [103], visibleWindowProcessIds: [103], visibleTopLevelWindowHandles: [7001] },
    seenVisibleTopLevelWindowHandles: [7001],
    observedTopLevelWindows: [{
      handle: 7001,
      processId: 103,
      className: "Chrome_WidgetWin_1",
      title: "Anti-Codex",
      auxiliaryWindow: false,
      presentable: true,
      productWindow: true,
    }, {
      handle: 7002,
      processId: 103,
      className: "SoPY_Status",
      title: "",
      auxiliaryWindow: true,
      presentable: false,
      productWindow: false,
    }],
    processIdentity: runtimeProcessIdentity,
    sessionIdentity: runtimeSessionIdentity,
  }));

  const paths = {
    taskReceipt: join(root, "task-receipt.json"),
    managerMatrix: join(root, "manager-matrix.json"),
    managerProfile: join(root, "manager-profile.json"),
    managerClose: join(root, "manager-close.json"),
    managerProtocol: join(root, "manager-protocol.json"),
    modelSwitches: modelSwitches.map((_, index) => join(root, `model-switch-${index + 1}.json`)),
    shortcutRounds: shortcutRounds.map((_, index) => join(root, `shortcut-round-${index + 1}.json`)),
    liveTray: join(root, "live-tray.json"),
    syncReadiness: join(root, "sync-readiness.json"),
    releaseBinding: join(root, "release-binding.json"),
  };

  writeJson(paths.taskReceipt, taskReceipt, { signed: true });
  writeJson(paths.managerMatrix, managerMatrix, { signed: true });
  writeJson(paths.managerProfile, managerProfile, { signed: true });
  writeJson(paths.managerClose, managerClose, { signed: true });
  writeJson(paths.managerProtocol, managerProtocol, { signed: true });
  modelSwitches.forEach((value, index) => writeJson(paths.modelSwitches[index], value, { signed: true }));
  shortcutRounds.forEach((value, index) => writeJson(paths.shortcutRounds[index], value, { signed: true }));
  writeJson(paths.liveTray, {
    schema: "anticodex-live-tray-icon-v2",
    ok: true,
    checkedAt,
    requestedRealTraffic: false,
    usedRealTraffic: false,
    notificationAreaItem: {
      present: true,
      visible: true,
      clickable: true,
      name: "Anti-Codex",
      provider: "MSAA+Shell_NotifyIconGetRect",
      role: 43,
      state: 0,
      childId: 7,
      toolbarWindowHandle: 6001,
      rawNameCandidateCount: 1,
      verifiedAntiCandidateCount: 1,
      expectedMainPid: 103,
      ownerWindowHandle: 7003,
      ownerProcessId: 103,
      ownerWindowClass: "OwlElectron_NotifyIconHostWindow",
      notifyIconId: 3,
      notifyIconGuid: "a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3",
      shellNotifyIconRectMatched: true,
      isEnabled: true,
      isInvisible: false,
      isOffscreen: false,
      hitTestMatched: true,
      rectangle: { x: 100, y: 100, width: 24, height: 24 },
    },
    identity: {
      exactAccessibleName: true,
      expectedMainPidMatched: true,
      ownerWindowClassMatched: true,
      antiGuidRectMatched: true,
      pinkArtwork: true,
      pinkPixels: 12,
      minimumPinkPixels: 8,
    },
  }, { signed: true });

  const syncReadiness = {
    ok: true,
    checkedAt,
    reportName: "sync-readiness",
    noTraffic: true,
    usedRealTraffic: false,
    activeHost: {
      trayIconExists: true,
      trayIconPalette: { ok: true },
    },
  };
  const syncReadinessSha256 = writeJson(paths.syncReadiness, syncReadiness, { signed: true });
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
    syncReadinessSha256,
  };
  writeJson(paths.releaseBinding, {
    schema: "anticodex-release-gates-v1",
    generatedAt: new Date().toISOString(),
    releaseBinding,
  }, { signed: true });

  return {
    taskId,
    artifactPaths,
    rolloutPath,
    projectRoot,
    prompt,
    paths,
    modelSwitches,
    shortcutRounds,
  };
}

function appendContinuationTurn(state, {
  turnId,
  message = "继续",
  previousTurnId,
  previousError = "unexpected status 503 Service Unavailable",
  timestamp = new Date().toISOString(),
} = {}) {
  const records = readFileSync(state.rolloutPath, "utf8").trimEnd().split(/\r?\n/);
  records.push(
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: previousTurnId,
        error: previousError,
      },
    }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({
      timestamp,
      type: "turn_context",
      payload: { turn_id: turnId, cwd: state.projectRoot, model: "gemini-3.1-pro-low" },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message } }),
  );
  writeFileSync(state.rolloutPath, `${records.join("\n")}\n`, "utf8");
}

function appendAbortedContinuationTurn(state, {
  turnId,
  previousTurnId,
  timestamp = new Date().toISOString(),
} = {}) {
  const records = readFileSync(state.rolloutPath, "utf8").trimEnd().split(/\r?\n/);
  const abortedText = [
    "<turn_aborted>",
    "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.",
    "</turn_aborted>",
  ].join("\n");
  records.push(
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: abortedText }],
        internal_chat_message_metadata_passthrough: { turn_id: previousTurnId },
      },
    }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({
      timestamp,
      type: "turn_context",
      payload: { turn_id: turnId, cwd: state.projectRoot, model: "gemini-3.1-pro-low" },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "继续" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message: "继续" } }),
  );
  writeFileSync(state.rolloutPath, `${records.join("\n")}\n`, "utf8");
}

function runBuilder(root, state, extraArgs = []) {
  const outputRoot = join(root, "normalized");
  const args = [
    builderPath,
    "--task-receipt", state.paths.taskReceipt,
    ...state.artifactPaths.flatMap((path) => ["--task-artifact", path]),
    "--manager-matrix", state.paths.managerMatrix,
    "--manager-profile", state.paths.managerProfile,
    "--manager-close", state.paths.managerClose,
    "--manager-protocol", state.paths.managerProtocol,
    ...state.paths.modelSwitches.flatMap((path) => ["--model-switch", path]),
    ...state.paths.shortcutRounds.flatMap((path) => ["--shortcut-restore", path]),
    "--live-tray-evidence", state.paths.liveTray,
    "--release-binding-evidence", state.paths.releaseBinding,
    "--sync-readiness-evidence", state.paths.syncReadiness,
    "--output-root", outputRoot,
    "--compact",
    ...extraArgs,
  ];
  const child = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
  const payload = JSON.parse(String(child.stdout || "{}").trim() || "{}");
  return { child, payload, outputRoot };
}

function extendShortcutRounds(state, count) {
  const template = JSON.parse(readFileSync(state.paths.shortcutRounds.at(-1), "utf8"));
  while (state.paths.shortcutRounds.length < count) {
    const probeId = state.paths.shortcutRounds.length + 1;
    const path = join(dirname(state.paths.shortcutRounds[0]), `shortcut-round-${probeId}.json`);
    const round = structuredClone(template);
    round.probeId = probeId;
    round.taskbarElement.childId = 15 + probeId;
    writeJson(path, round, { signed: true });
    state.paths.shortcutRounds.push(path);
  }
}

function rewriteBoundRuntimeManifestCreatedAt(state, createdAt) {
  const matrix = JSON.parse(readFileSync(state.paths.managerMatrix, "utf8"));
  const provenance = matrix.managerButton.payload.handlerContractEvidence.provenance;
  const manifest = JSON.parse(readFileSync(provenance.manifestPath, "utf8"));
  manifest.createdAt = createdAt;
  writeFileSync(provenance.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  provenance.manifestSha256 = sha256(readFileSync(provenance.manifestPath));
  writeJson(state.paths.managerMatrix, matrix, { signed: true });
}

test("builder converts raw real-probe shapes into five signed inputs accepted by Gate 5", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-"));
  let supervisor = null;
  try {
    const state = buildRawEvidence(root);
    supervisor = startSuspendedSupervisor(join(root, "runtime", "scripts", "start-anticodex-fixed-route.mjs"));
    bindStateToSupervisor(state, supervisor);
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 0, result.child.stderr || JSON.stringify(result.payload));
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.requestedRealTraffic, false);
    assert.equal(result.payload.usedRealTraffic, false);
    assert.equal(result.payload.taskId, state.taskId);
    assert.deepEqual(Object.keys(result.payload.outputs).sort(), [
      "managerEvidence",
      "modelSwitchEvidence",
      "releaseBindingEvidence",
      "shortcutRestoreEvidence",
      "taskManifest",
    ]);
    for (const output of Object.values(result.payload.outputs)) {
      const body = readFileSync(output.path);
      assert.equal(readFileSync(`${output.path}.sha256`, "ascii").trim(), `sha256:${sha256(body)}`);
    }

    const reportRoot = join(root, "aggregate");
    const auditPath = join(root, "gate5.json");
    const aggregate = spawnSync(process.execPath, [
      aggregatePath,
      "--task-manifest", result.payload.outputs.taskManifest.path,
      "--manager-evidence", result.payload.outputs.managerEvidence.path,
      "--model-switch-evidence", result.payload.outputs.modelSwitchEvidence.path,
      "--shortcut-restore-evidence", result.payload.outputs.shortcutRestoreEvidence.path,
      "--release-binding-evidence", result.payload.outputs.releaseBindingEvidence.path,
      "--report-root", reportRoot,
      "--audit-out", auditPath,
      "--compact",
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(aggregate.status, 0, aggregate.stderr || aggregate.stdout);
    assert.equal(JSON.parse(aggregate.stdout).ok, true);
  } finally {
    stopTestSupervisor(supervisor);
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder fails closed when the live tray probe is missing, stale, or failed", () => {
  const mutations = [
    ["missing", (state) => {
      rmSync(state.paths.liveTray);
      rmSync(`${state.paths.liveTray}.sha256`);
    }],
    ["stale", (state) => {
      const tray = JSON.parse(readFileSync(state.paths.liveTray, "utf8"));
      tray.checkedAt = new Date(Date.now() - 6 * 60_000).toISOString();
      writeJson(state.paths.liveTray, tray, { signed: true });
    }],
    ["failed", (state) => {
      const tray = JSON.parse(readFileSync(state.paths.liveTray, "utf8"));
      tray.ok = false;
      writeJson(state.paths.liveTray, tray, { signed: true });
    }],
  ];
  for (const [label, mutate] of mutations) {
    const root = mkdtempSync(join(tmpdir(), `anticodex-gate5-live-tray-${label}-`));
    try {
      const state = buildRawEvidence(root);
      mutate(state);
      const result = runBuilder(root, state);
      assert.equal(result.child.status, 1, `${label}: ${result.child.stderr || JSON.stringify(result.payload)}`);
      assert.match(result.payload.failures.join("\n"), /live.?tray|notification.?area/i, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("builder rejects a supervisor older than its manifest generation beyond the 1ms serialization tolerance", () => {
  for (const [deltaMs, expectedStatus] of [[1, 0], [2, 1]]) {
    const root = mkdtempSync(join(tmpdir(), `anticodex-gate5-builder-runtime-age-${deltaMs}-`));
    let supervisor = null;
    try {
      const state = buildRawEvidence(root);
      supervisor = startSuspendedSupervisor(join(root, "runtime", "scripts", "start-anticodex-fixed-route.mjs"));
      bindStateToSupervisor(state, supervisor);
      rewriteBoundRuntimeManifestCreatedAt(state, new Date(Date.parse(supervisor.creationDateUtc) + deltaMs).toISOString());
      const result = runBuilder(root, state);
      assert.equal(result.child.status, expectedStatus, result.child.stderr || JSON.stringify(result.payload));
      if (expectedStatus !== 0) assert.match(result.payload.failures.join("\n"), /manifest generation|predates/i);
    } finally {
      stopTestSupervisor(supervisor);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("builder does not allow callers to widen the five-minute live tray freshness window", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-live-tray-age-"));
  try {
    const state = buildRawEvidence(root);
    const tray = JSON.parse(readFileSync(state.paths.liveTray, "utf8"));
    tray.checkedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    writeJson(state.paths.liveTray, tray, { signed: true });
    const result = runBuilder(root, state, ["--max-live-tray-age-minutes", "999"]);
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /live.?tray.*stale/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder requires visible clickable notification-area Anti-Codex identity evidence", () => {
  const mutations = [
    ["not present", (tray) => { tray.notificationAreaItem.present = false; }],
    ["hidden", (tray) => { tray.notificationAreaItem.visible = false; }],
    ["not clickable", (tray) => { tray.notificationAreaItem.clickable = false; }],
    ["wrong name", (tray) => { tray.notificationAreaItem.name = "ChatGPT"; }],
    ["wrong provider", (tray) => { tray.notificationAreaItem.provider = "fixture"; }],
    ["wrong role", (tray) => { tray.notificationAreaItem.role = 0; }],
    ["disabled", (tray) => { tray.notificationAreaItem.isEnabled = false; }],
    ["offscreen", (tray) => { tray.notificationAreaItem.isOffscreen = true; }],
    ["hit-test mismatch", (tray) => { tray.notificationAreaItem.hitTestMatched = false; }],
    ["ambiguous verified identity", (tray) => { tray.notificationAreaItem.verifiedAntiCandidateCount = 2; }],
    ["official Codex owner", (tray) => { tray.notificationAreaItem.ownerProcessId = 23788; }],
    ["official Codex GUID", (tray) => { tray.notificationAreaItem.notifyIconGuid = "e5768d8b-6936-4f45-b1ad-4c5fb414cb35"; }],
    ["wrong owner class", (tray) => { tray.notificationAreaItem.ownerWindowClass = "ChatGPT"; }],
    ["unverified shell rect", (tray) => { tray.notificationAreaItem.shellNotifyIconRectMatched = false; }],
    ["legacy schema", (tray) => { tray.schema = "anticodex-live-tray-icon-v1"; }],
    ["wrong artwork", (tray) => { tray.identity.pinkArtwork = false; }],
    ["weak artwork threshold", (tray) => {
      tray.identity.minimumPinkPixels = 1;
      tray.identity.pinkPixels = 1;
    }],
  ];
  for (const [label, mutate] of mutations) {
    const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-live-tray-contract-"));
    try {
      const state = buildRawEvidence(root);
      const tray = JSON.parse(readFileSync(state.paths.liveTray, "utf8"));
      mutate(tray);
      writeJson(state.paths.liveTray, tray, { signed: true });
      const result = runBuilder(root, state);
      assert.equal(result.child.status, 1, `${label}: ${result.child.stderr || JSON.stringify(result.payload)}`);
      assert.match(result.payload.failures.join("\n"), /live.?tray|notification.?area/i, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("live tray probe emits a signed machine-readable accessibility report", () => {
  const source = readFileSync(liveTrayProbePath, "utf8");
  assert.match(source, /\[ValidateRange\(8,\s*2147483647\)\]\s*\[int\]\$MinimumPinkPixels/);
  assert.match(source, /\[Parameter\(Mandatory\s*=\s*\$true\)\]\[ValidateRange\(1,\s*2147483647\)\]\[int\]\$ExpectedMainPid/);
  assert.match(source, /\[string\]\$ReportPath/);
  assert.match(source, /anticodex-live-tray-icon-v2/);
  assert.match(source, /TB_GETBUTTON/);
  assert.match(source, /TRAYDATA/);
  assert.match(source, /Shell_NotifyIconGetRect/);
  assert.match(source, /a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3/i);
  assert.match(source, /checkedAt/);
  assert.match(source, /notificationAreaItem/);
  assert.match(source, /accHitTest/);
  assert.match(source, /Write-AntiCodexTextAtomic/);
});

test("builder accepts one total goal followed by exact continuation turns after explicit native errors", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-continuations-"));
  try {
    const state = buildRawEvidence(root);
    appendContinuationTurn(state, {
      turnId: "turn-2",
      previousTurnId: "turn-1",
      previousError: "exceeded retry limit, last status: 429 Too Many Requests",
    });
    appendContinuationTurn(state, {
      turnId: "turn-3",
      previousTurnId: "turn-2",
      previousError: "unexpected status 503 Service Unavailable",
    });

    const result = runBuilder(root, state);
    assert.equal(result.child.status, 0, result.child.stderr || JSON.stringify(result.payload));
    const manifest = JSON.parse(readFileSync(result.payload.outputs.taskManifest.path, "utf8"));
    assert.equal(manifest.promptSubmissionCount, 1);
    assert.equal(manifest.totalGoalPromptCount, 1);
    assert.equal(manifest.continuationPromptCount, 2);
    assert.equal(manifest.hostMessageCount, 3);
    assert.equal(manifest.hostIntermediatePromptCount, 0);
    assert.equal(manifest.continuations.length, 2);
    assert.deepEqual(manifest.continuations.map((entry) => entry.turnId), ["turn-2", "turn-3"]);
    assert.deepEqual(manifest.continuations.map((entry) => entry.interruptionKind), [
      "task_complete.error",
      "task_complete.error",
    ]);
    assert.match(manifest.rollout.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.rollout.bytes, readFileSync(state.rolloutPath).length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder accepts exact continuation after a native turn_aborted record without counting it as a host prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-aborted-continuation-"));
  try {
    const state = buildRawEvidence(root);
    appendAbortedContinuationTurn(state, { turnId: "turn-2", previousTurnId: "turn-1" });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 0, result.child.stderr || JSON.stringify(result.payload));
    const manifest = JSON.parse(readFileSync(result.payload.outputs.taskManifest.path, "utf8"));
    assert.equal(manifest.hostMessageCount, 2);
    assert.equal(manifest.continuationPromptCount, 1);
    assert.equal(manifest.continuations[0].interruptionKind, "turn_aborted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder fails closed on malformed rollout JSON instead of silently dropping a record", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-rollout-json-"));
  try {
    const state = buildRawEvidence(root);
    writeFileSync(state.rolloutPath, `${readFileSync(state.rolloutPath, "utf8")}not-json\n`, "utf8");
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /rollout.*invalid JSON|invalid JSON.*rollout/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder fails closed when event and response user-message ledgers disagree", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-rollout-ledgers-"));
  try {
    const state = buildRawEvidence(root);
    const records = readFileSync(state.rolloutPath, "utf8").trimEnd().split(/\r?\n/);
    records.push(JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "执行下一个微阶段" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }));
    writeFileSync(state.rolloutPath, `${records.join("\n")}\n`, "utf8");
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /user-message ledgers disagree|rollout.*ledger/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects exact continuation text without an earlier task_complete error", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-continuation-order-"));
  try {
    const state = buildRawEvidence(root);
    appendContinuationTurn(state, {
      turnId: "turn-2",
      previousTurnId: "turn-1",
      previousError: "",
    });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /continuation.*task_complete\.error|explicit.*interruption/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects any host message other than the one total goal or exact continuation text", () => {
  for (const message of ["继续\n", " 继续", "继续一下", "continue", "执行 Stage 4P"]) {
    const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-continuation-text-"));
    try {
      const state = buildRawEvidence(root);
      appendContinuationTurn(state, {
        turnId: "turn-2",
        previousTurnId: "turn-1",
        message,
      });
      const result = runBuilder(root, state);
      assert.equal(result.child.status, 1, `${JSON.stringify(message)}: ${result.child.stderr || JSON.stringify(result.payload)}`);
      assert.match(result.payload.failures.join("\n"), /total-goal|exact continuation|host intermediate/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("builder fails closed when one raw probe is stale and writes no normalized inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-stale-"));
  try {
    const state = buildRawEvidence(root);
    const stale = JSON.parse(readFileSync(state.paths.shortcutRounds[1], "utf8"));
    stale.checkedAt = new Date(Date.now() - 72 * 3_600_000).toISOString();
    writeJson(state.paths.shortcutRounds[1], stale, { signed: true });
    const result = runBuilder(root, state, ["--max-source-age-hours", "48"]);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.failures.join("\n"), /stale/i);
    assert.equal(existsSync(result.outputRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder fails closed when a model switch belongs to another task", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-task-"));
  try {
    const state = buildRawEvidence(root);
    const mismatched = JSON.parse(readFileSync(state.paths.modelSwitches[1], "utf8"));
    mismatched.taskId = "019f9000-1111-7222-8333-555555555555";
    writeJson(state.paths.modelSwitches[1], mismatched, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.failures.join("\n"), /taskId/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder fails closed when the native request is not exclusively bound to the rollout task", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-native-"));
  try {
    const state = buildRawEvidence(root);
    const receipt = JSON.parse(readFileSync(state.paths.taskReceipt, "utf8"));
    receipt.startupEvidence.native.taskId = "019f9000-1111-7222-8333-555555555555";
    receipt.startupEvidence.native.activity.expectedThreadIds = [receipt.startupEvidence.native.taskId];
    writeJson(state.paths.taskReceipt, receipt, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.failures.join("\n"), /native request|taskId/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder requires every real Manager probe instead of inventing missing evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-manager-"));
  try {
    const state = buildRawEvidence(root);
    rmSync(state.paths.managerClose);
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.failures.join("\n"), /manager-close|missing/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects duplicate artifact paths instead of counting one artifact three times", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-artifact-unique-"));
  try {
    const state = buildRawEvidence(root);
    state.artifactPaths = Array(3).fill(state.artifactPaths[0]);
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /artifact.*unique|duplicate artifact/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects one shortcut probe repeated as three restore rounds", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-shortcut-unique-"));
  try {
    const state = buildRawEvidence(root);
    state.paths.shortcutRounds = Array(3).fill(state.paths.shortcutRounds[0]);
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /shortcut.*unique|duplicate shortcut/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder accepts only signed actual-mouse taskbar-button restore rounds", () => {
  const mutations = [
    ["desktop shortcut", (round) => { round.activationMode = "desktop-shortcut"; }],
    ["synthetic activation", (round) => { round.actualMouse = false; }],
    ["activation never foregrounded", (round) => { round.taskbarActivationObserved = false; }],
    ["missing taskbar element", (round) => { delete round.taskbarElement; }],
    ["wrong accessibility provider", (round) => { round.taskbarElement.provider = "UIAutomation"; }],
    ["wrong accessible name", (round) => { round.taskbarElement.accessibleName = "ChatGPT - 1 个运行窗口"; }],
    ["missing hit-test confirmation", (round) => { round.taskbarElement.hitTestMatched = false; }],
    ["missing taskbar rectangle", (round) => { delete round.taskbarRectangle; }],
    ["missing click point", (round) => { delete round.taskbarClickPoint; }],
    ["different PID", (round) => { round.samePid = false; }],
    ["different HWND", (round) => { round.sameHwnd = false; }],
    ["different executable", (round) => { round.sameExecutable = false; }],
    ["different CDP target", (round) => { round.sameCdpTarget = false; }],
    ["missing first frame", (round) => { delete round.firstFrame; }],
    ["wrong capture origin", (round) => { round.frameCaptureOrigin = "taskbar-sendinput"; }],
    ["forged activation wait", (round) => { round.frameCaptureOriginMs = 146; }],
    ["late first frame", (round) => { round.firstFrameDelayMs = 101; }],
    ["forged first-frame delay", (round) => { round.firstFrameDelayMs = 14; }],
    ["missing sample interval", (round) => { delete round.maxSampleIntervalMs; }],
    ["slow frame cadence", (round) => { round.maxSampleIntervalMs = 126; }],
    ["re-minimized after restore", (round) => { round.reminimizedAfterRestore = true; }],
    ["probe needed forced recovery", (round) => { round.probeRecoveryApplied = true; }],
    ["insufficient early frames", (round) => { round.earlyFrameCount = 7; }],
    ["second top-level window", (round) => {
      round.maxVisibleTopLevelWindowCount = 2;
      round.seenVisibleTopLevelWindowHandles = [7001, 7002];
    }],
    ["second presentable non-Chrome window", (round) => {
      round.observedTopLevelWindows[1].auxiliaryWindow = false;
      round.observedTopLevelWindows[1].presentable = true;
    }],
    ["insufficient frame samples", (round) => {
      round.frameCount = 1;
      round.maxSampleIntervalMs = 0;
    }],
  ];
  for (const [label, mutate] of mutations) {
    const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-taskbar-"));
    try {
      const state = buildRawEvidence(root);
      const shortcut = JSON.parse(readFileSync(state.paths.shortcutRounds[1], "utf8"));
      mutate(shortcut);
      writeJson(state.paths.shortcutRounds[1], shortcut, { signed: true });
      const result = runBuilder(root, state);
      assert.equal(result.child.status, 1, `${label}: ${result.child.stderr || JSON.stringify(result.payload)}`);
      assert.match(result.payload.failures.join("\n"), /shortcut.*taskbar|actual mouse|HWND|executable|frame|sample/i, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("builder requires exactly ten signed taskbar-button restore rounds", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-taskbar-count-"));
  let supervisor = null;
  try {
    const state = buildRawEvidence(root);
    supervisor = startSuspendedSupervisor(join(root, "runtime", "scripts", "start-anticodex-fixed-route.mjs"));
    bindStateToSupervisor(state, supervisor);
    extendShortcutRounds(state, 10);
    const accepted = runBuilder(root, state);
    assert.equal(accepted.child.status, 0, accepted.child.stderr || JSON.stringify(accepted.payload));
    assert.equal(accepted.payload.ok, true);

    state.paths.shortcutRounds.pop();
    const rejected = runBuilder(root, state);
    assert.equal(rejected.child.status, 1, rejected.child.stderr || JSON.stringify(rejected.payload));
    assert.match(rejected.payload.failures.join("\n"), /exactly ten.*taskbar|taskbar.*exactly ten/i);
  } finally {
    stopTestSupervisor(supervisor);
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects artifacts older than the native task start", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-artifact-time-"));
  try {
    const state = buildRawEvidence(root);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(state.artifactPaths[0], old, old);
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /artifact.*task start|predates/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects artifacts absent from native rollout tool evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-artifact-rollout-"));
  try {
    const state = buildRawEvidence(root);
    const records = readFileSync(state.paths.taskReceipt, "utf8");
    const receipt = JSON.parse(records);
    const rolloutPath = receipt.startupEvidence.rollout.file;
    const rollout = readFileSync(rolloutPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record?.payload?.type !== "function_call_output");
    writeFileSync(rolloutPath, `${rollout.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /artifact.*tool evidence|rollout/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects signed input without a content-embedded timestamp even when mtime is fresh", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-content-time-"));
  try {
    const state = buildRawEvidence(root);
    const receipt = JSON.parse(readFileSync(state.paths.taskReceipt, "utf8"));
    delete receipt.checkedAt;
    writeJson(state.paths.taskReceipt, receipt, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /embedded timestamp|content timestamp/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder requires signatures for Manager and shortcut raw evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-all-signed-"));
  try {
    const state = buildRawEvidence(root);
    rmSync(`${state.paths.managerClose}.sha256`);
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /signed source sidecar/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder requires the exact 20 unique Manager actions", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-manager-actions-"));
  try {
    const state = buildRawEvidence(root);
    const matrix = JSON.parse(readFileSync(state.paths.managerMatrix, "utf8"));
    const first = matrix.managerButton.payload.actions[0];
    matrix.managerButton.payload.actions = Array(20).fill(first);
    matrix.managerButton.payload.results = {
      [first]: matrix.managerButton.payload.results[first],
    };
    writeJson(state.paths.managerMatrix, matrix, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /20 unique|action coverage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects a UI-only click matrix without separate handler truth", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-manager-truth-"));
  try {
    const state = buildRawEvidence(root);
    const matrix = JSON.parse(readFileSync(state.paths.managerMatrix, "utf8"));
    delete matrix.managerButton.payload.uiInteractionEvidence;
    delete matrix.managerButton.payload.handlerContractEvidence;
    writeJson(state.paths.managerMatrix, matrix, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /UI interaction|handler contract/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects handler truth bound to the wrong runtime root or stale file hash", () => {
  for (const [label, mutate] of [
    ["wrong root", (evidence) => { evidence.provenance.runtimeRoot = "C:\\wrong-runtime"; }],
    ["wrong hash", (evidence) => { evidence.provenance.files[0].fileSha256 = "f".repeat(64); }],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-manager-provenance-"));
    try {
      const state = buildRawEvidence(root);
      const matrix = JSON.parse(readFileSync(state.paths.managerMatrix, "utf8"));
      matrix.managerButton.payload.handlerContractEvidence.provenance = {
        schema: "anticodex-manager-handler-provenance-v1",
        runtimeRoot: join(root, "runtime"),
        scriptsRoot: join(root, "runtime", "scripts"),
        manifestPath: join(root, "runtime", ".anticodex-runtime-manifest.json"),
        manifestSha256: "a".repeat(64),
        sourceGitHead: "b".repeat(40),
        files: [{ relativePath: "scripts/anticodex-manager-service.mjs", fileSha256: "c".repeat(64) }],
      };
      mutate(matrix.managerButton.payload.handlerContractEvidence);
      writeJson(state.paths.managerMatrix, matrix, { signed: true });
      const result = runBuilder(root, state);
      assert.equal(result.child.status, 1, `${label}: ${result.child.stderr || JSON.stringify(result.payload)}`);
      assert.match(result.payload.failures.join("\n"), /handler.*provenance|runtime root|hash/i, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("builder rejects self-consistent handler truth from a runtime copy not owned by the clicked UI supervisor", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-manager-runtime-owner-"));
  try {
    const state = buildRawEvidence(root);
    const matrix = JSON.parse(readFileSync(state.paths.managerMatrix, "utf8"));
    const copiedRuntimeRoot = join(root, "copied-runtime");
    cpSync(join(root, "runtime"), copiedRuntimeRoot, { recursive: true });
    const copiedManifestPath = join(copiedRuntimeRoot, ".anticodex-runtime-manifest.json");
    const copiedManifest = JSON.parse(readFileSync(copiedManifestPath, "utf8"));
    copiedManifest.activeRuntime = copiedRuntimeRoot;
    writeFileSync(copiedManifestPath, `${JSON.stringify(copiedManifest, null, 2)}\n`, "utf8");
    matrix.runtimeRoot = copiedRuntimeRoot;
    Object.assign(matrix.managerButton.payload.handlerContractEvidence.provenance, {
      runtimeRoot: copiedRuntimeRoot,
      scriptsRoot: join(copiedRuntimeRoot, "scripts"),
      manifestPath: copiedManifestPath,
      manifestSha256: sha256(readFileSync(copiedManifestPath)),
    });
    writeJson(state.paths.managerMatrix, matrix, { signed: true });

    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr || JSON.stringify(result.payload));
    assert.match(result.payload.failures.join("\n"), /task runtime pid|fixed-route supervisor|command line/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder requires Manager close evidence to identify the actual-click phase", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-close-phase-"));
  try {
    const state = buildRawEvidence(root);
    const close = JSON.parse(readFileSync(state.paths.managerClose, "utf8"));
    close.closeActualMouse.phase = "synthetic";
    writeJson(state.paths.managerClose, close, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /actual-click/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects evidence collected from another Anti-Codex runtime PID", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-runtime-pid-"));
  try {
    const state = buildRawEvidence(root);
    const shortcut = JSON.parse(readFileSync(state.paths.shortcutRounds[1], "utf8"));
    shortcut.expectedMainPid = 999;
    shortcut.after.rootProcessIds = [999];
    shortcut.after.visibleWindowProcessIds = [999];
    writeJson(state.paths.shortcutRounds[1], shortcut, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /runtime|main pid|process baseline/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rejects shortcut rounds collected across renderer or proxy restarts", () => {
  const mutations = [
    ["renderer target", (round) => { round.sessionIdentity.targetId = "other-app-page"; }],
    ["CDP endpoint", (round) => { round.sessionIdentity.cdpPort = 19999; }],
    ["renderer URL", (round) => { round.sessionIdentity.targetUrl = "app://codex/reloaded.html"; }],
    ["supervisor PID", (round) => { round.processIdentity.supervisorPid = 999; }],
    ["CodexPlusPlus PID", (round) => { round.processIdentity.codexPlusPlusPid = 998; }],
    ["main PID identity", (round) => { round.processIdentity.antiCodexMainPid = 997; }],
    ["original Codex PID identity", (round) => { round.processIdentity.originalCodexPid = 996; }],
  ];
  for (const [label, mutate] of mutations) {
    const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-shortcut-session-"));
    try {
      const state = buildRawEvidence(root);
      const shortcut = JSON.parse(readFileSync(state.paths.shortcutRounds[1], "utf8"));
      mutate(shortcut);
      writeJson(state.paths.shortcutRounds[1], shortcut, { signed: true });
      const result = runBuilder(root, state);
      assert.equal(result.child.status, 1, `${label}: ${result.child.stderr}`);
      assert.match(
        result.payload.failures.join("\n"),
        /shortcut.*(?:runtime|session|PID|target|CDP)/i,
        label,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("builder rejects Manager evidence from another renderer session", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-runtime-session-"));
  try {
    const state = buildRawEvidence(root);
    const profile = JSON.parse(readFileSync(state.paths.managerProfile, "utf8"));
    profile.target.id = "other-app-page";
    writeJson(state.paths.managerProfile, profile, { signed: true });
    const result = runBuilder(root, state);
    assert.equal(result.child.status, 1, result.child.stderr);
    assert.match(result.payload.failures.join("\n"), /target|renderer session/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder binds every Manager probe to the task runtime process and CDP endpoint", () => {
  const mutations = [
    ["manager process", (profile) => { profile.processIdentity.codexPlusPlusPid = 777; }],
    ["manager CDP endpoint", (profile) => { profile.sessionIdentity.cdpPort = 17777; }],
    ["manager session target", (profile) => { profile.sessionIdentity.targetId = "other-app-page"; }],
  ];
  for (const [label, mutate] of mutations) {
    const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-manager-identity-"));
    try {
      const state = buildRawEvidence(root);
      const profile = JSON.parse(readFileSync(state.paths.managerProfile, "utf8"));
      mutate(profile);
      writeJson(state.paths.managerProfile, profile, { signed: true });
      const result = runBuilder(root, state);
      assert.equal(result.child.status, 1, `${label}: ${result.child.stderr}`);
      assert.match(result.payload.failures.join("\n"), /manager-profile.*(?:process|session|CDP)/i, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("failed rebuild invalidates all previously green normalized outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-gate5-builder-invalidate-"));
  try {
    const state = buildRawEvidence(root);
    const first = runBuilder(root, state);
    assert.equal(first.child.status, 0, first.child.stderr || JSON.stringify(first.payload));
    rmSync(state.paths.managerClose);
    rmSync(`${state.paths.managerClose}.sha256`);
    const second = runBuilder(root, state);
    assert.equal(second.child.status, 1, second.child.stderr);
    for (const output of Object.values(first.payload.outputs)) {
      assert.equal(existsSync(output.path), false, `stale output survived: ${output.path}`);
      assert.equal(existsSync(`${output.path}.sha256`), false, `stale sidecar survived: ${output.path}.sha256`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UI harness documents the original Codex PID required for release evidence", () => {
  const source = readFileSync(uiChatPath, "utf8");
  assert.match(source, /--expected-original-codex-pid <pid>/);
  assert.match(source, /--expected-anticodex-main-pid <pid>/);
  assert.match(source, /--expected-supervisor-pid <pid>/);
  assert.match(source, /--expected-codexplusplus-pid <pid>/);
});
