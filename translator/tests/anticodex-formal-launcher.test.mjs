import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as taskLauncher from "../../scripts/start-anticodex-task.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
const taskLauncherSource = readFileSync(resolve(root, "scripts", "start-anticodex-task.mjs"), "utf8");
const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
const manager = readFileSync(resolve(root, "scripts", "manage-anticodex.ps1"), "utf8");
const fixedRouteSupervisor = readFileSync(resolve(root, "scripts", "start-anticodex-fixed-route.mjs"), "utf8");
const antigravityDesktop = readFileSync(resolve(root, "scripts", "antigravity-desktop.ps1"), "utf8");
const postVerification = readFileSync(resolve(root, "scripts", "test-anticodex-post-verification.ps1"), "utf8");
const modelRefresh = readFileSync(resolve(root, "scripts", "refresh-anticodex-models.ps1"), "utf8");
const conversationCleanup = readFileSync(resolve(root, "scripts", "clear-anticodex-conversations.ps1"), "utf8");
const hostSync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
const syncLauncher = readFileSync(resolve(root, "scripts", "sync-anticodex-launcher.ps1"), "utf8");
const updateTaskBroker = readFileSync(resolve(root, "scripts", "start-anticodex-update-task.mjs"), "utf8");
const shortcutRepair = readFileSync(resolve(root, "scripts", "repair-anticodex-shortcuts.ps1"), "utf8");
const managerService = readFileSync(resolve(root, "scripts", "anticodex-manager-service.mjs"), "utf8");
const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
const rollback = readFileSync(resolve(root, "scripts", "rollback-anticodex.ps1"), "utf8");

test("controlled route restarts do not accumulate signal listeners", () => {
  assert.equal(typeof taskLauncher.attachForwardedSignalHandlers, "function");
  const signalTarget = new EventEmitter();
  const baselineSigint = signalTarget.listenerCount("SIGINT");
  const baselineSigterm = signalTarget.listenerCount("SIGTERM");
  const child = { kill() {} };

  for (let restart = 0; restart < 12; restart += 1) {
    const detach = taskLauncher.attachForwardedSignalHandlers(child, signalTarget);
    assert.equal(signalTarget.listenerCount("SIGINT"), baselineSigint + 1);
    assert.equal(signalTarget.listenerCount("SIGTERM"), baselineSigterm + 1);
    detach();
  }

  assert.equal(signalTarget.listenerCount("SIGINT"), baselineSigint);
  assert.equal(signalTarget.listenerCount("SIGTERM"), baselineSigterm);
});

test("task launcher acquires and releases the real Windows host sync barriers", {
  skip: process.platform !== "win32",
}, async () => {
  const release = await taskLauncher.acquireHostSyncBarrier({ timeoutMs: 5_000 });
  assert.doesNotThrow(() => release.assertHeld());
  await release();
  await release();
  assert.throws(() => release.assertHeld(), /released before runtime startup/);
});

test("normal launchers hold the host sync publication barrier while runtime startup is committed", () => {
  assert.match(launcher, /Global\\AntiCodexHostSync/);
  assert.match(launcher, /Local\\AntiCodexHostSync/);
  assert.match(launcher, /Enter-AntiCodexHostSyncBarrier/);
  assert.match(launcher, /Exit-AntiCodexHostSyncBarrier/);
  assert.match(launcher, /\[switch\]\$SkipSyncBarrier/);
  assert.doesNotMatch(runtimeSync, /-SkipSyncBarrier/);

  assert.match(taskLauncherSource, /acquireHostSyncBarrier/);
  assert.match(taskLauncherSource, /Global\\\\AntiCodexHostSync/);
  assert.match(taskLauncherSource, /Local\\\\AntiCodexHostSync/);
  const acquire = taskLauncherSource.indexOf("await acquireHostSyncBarrier");
  const spawnSupervisor = taskLauncherSource.indexOf("const child = spawn(process.execPath", acquire);
  const release = taskLauncherSource.indexOf("releaseHostSyncBarrier", spawnSupervisor);
  assert.ok(acquire >= 0, "task launcher must acquire the publication barrier");
  assert.ok(spawnSupervisor > acquire, "task launcher must acquire before spawning the runtime supervisor");
  assert.ok(release > spawnSupervisor, "task launcher must release only after the supervisor exists");
});

test("formal launcher uses the fixed CodexPlusPlus route as the only model path", () => {
  assert.match(launcher, /start-anticodex-fixed-route\.mjs/);
  assert.match(launcher, /18487/);
  assert.match(launcher, /anticodex\/fixed-route\/health/);
  assert.match(launcher, /ANTICODEX_PROVIDER/);
  assert.match(launcher, /ANTICODEX_MODEL/);
  assert.match(launcher, /UPSTREAM_PROTOCOL/);
  assert.match(launcher, /UPSTREAM_URL/);
  assert.match(launcher, /UPSTREAM_API_KEY/);
  assert.match(launcher, /Start-Process -FilePath \$nodeExecutable/);
  assert.match(launcher, /-WindowStyle Hidden/);
  assert.doesNotMatch(launcher, /Test-AntiCodexTranslatorMatchesConfiguredUpstream/);
  assert.doesNotMatch(launcher, /Normalize-AntiCodexAntigravityTransport/);
  assert.doesNotMatch(launcher, /ANTICODEX_NATIVE_TOOL_BRIDGE/);
});

test("formal launcher records startup stages and surfaces hidden-launch failures", () => {
  assert.match(launcher, /launcher-state\.json/);
  assert.match(launcher, /function Write-AntiCodexLauncherState/);
  assert.match(launcher, /trap\s*\{/);
  assert.match(launcher, /System\.Windows\.Forms\.MessageBox/);
});

test("inline supervisor keeps its parent alive and contains native stderr in durable logs", () => {
  const start = launcher.lastIndexOf("if ($InlineSupervisor) {");
  const end = launcher.indexOf("\n}", start);
  const inlineBlock = start >= 0 && end > start ? launcher.slice(start, end + 2) : "";
  assert.match(inlineBlock, /& \$nodeExecutable @inlineSupervisorArgs 1>> \$launcherOutLog 2>> \$launcherErrLog/);
  assert.match(inlineBlock, /\$savedErrorActionPreference\s*=\s*\$ErrorActionPreference/);
  assert.match(inlineBlock, /\$ErrorActionPreference\s*=\s*"Continue"/);
  assert.match(inlineBlock, /finally\s*\{\s*\$ErrorActionPreference\s*=\s*\$savedErrorActionPreference\s*\}/);
  assert.match(inlineBlock, /\$inlineExitCode = \[int\]\$LASTEXITCODE/);
  assert.doesNotMatch(inlineBlock, /Start-Process/);
});

test("every production relaunch keeps the fixed-route supervisor attached", () => {
  const managerLaunches = [...manager.matchAll(/Start-ManagerScript "start-anticodex\.ps1"[^\r\n]*/g)]
    .map((match) => match[0]);
  assert.equal(managerLaunches.length, 3);
  assert.ok(managerLaunches.every((line) => /-Arguments\s+@\("-InlineSupervisor"\)/.test(line)));

  const managerGatewayStart = manager.match(/\$launcher = Join-Path \$scriptRoot "start-anticodex\.ps1"[\s\S]*?return Wait-ManagerHealth/)?.[0] ?? "";
  assert.match(managerGatewayStart, /-InlineSupervisor/);
  assert.match(modelRefresh, /-File[^\r\n]*\$startAntiCodex[^\r\n]*-InlineSupervisor/);
  assert.match(conversationCleanup, /"-SkipUpdateCheck"[\s\S]*?"-InlineSupervisor"/);
  assert.doesNotMatch(rollback, /Start-Process[^\r\n]*\$startAntiCodex[^\r\n]*-InlineSupervisor/);
});

test("standalone model refresh calls the authenticated Manager action before restart fallback", () => {
  assert.match(modelRefresh, /\/anticodex\/manager\/bootstrap/);
  assert.match(modelRefresh, /\/anticodex\/manager\/action/);
  assert.match(modelRefresh, /x-anticodex-manager-token/);
  assert.match(modelRefresh, /action\s*=\s*"refreshModels"/);
  assert.doesNotMatch(modelRefresh, /\/anticodex\/models\/refresh/);
});

test("host sync restarts outside native Codex process ownership", () => {
  const start = hostSync.indexOf("function Start-AntiCodexAfterSync");
  const end = hostSync.indexOf("function Wait-AntiCodexPostSyncReady", start);
  const restart = start >= 0 && end > start ? hostSync.slice(start, end) : "";

  assert.match(restart, /Anti-Codex Launcher/);
  assert.match(restart, /Assert-AntiCodexLaunchTaskContract/);
  assert.match(hostSync, /Schedule\.Service/);
  assert.equal([...hostSync.matchAll(/New-Object -ComObject "Schedule\.Service"/g)].length, 1);
  assert.match(hostSync, /\$script:antiCodexScheduleService/);
  assert.match(restart, /Start-ScheduledTask\s+-TaskName\s+\$launchTaskName/);
  assert.match(restart, /\$task\.State -eq 3[\s\S]*?Start-ScheduledTask/);
  assert.match(restart, /\$task\.State -notin @\(2, 4\)/);
  assert.doesNotMatch(restart, /\.Run\(\$null\)/);
  assert.doesNotMatch(restart, /Start-Process -FilePath \$powershell|cmd\.exe/);
});

test("the built-in Manager sync delegates to an independent updater task", () => {
  const syncAction = managerService.match(/syncHost:\s*\{[\s\S]*?\n\s*\},/)?.[0] ?? "";
  assert.match(managerService, /syncHost:[\s\S]*?script:\s*"sync-anticodex-launcher\.ps1"/);
  assert.match(syncAction, /foregroundSingleton:\s*true/);
  assert.doesNotMatch(syncAction, /background:\s*true|singletonProcessPattern/);
  assert.match(syncLauncher, /param\([\s\S]*?\[switch\]\$FromUpdateTask/);
  assert.match(syncLauncher, /Anti-Codex Updater/);
  assert.match(syncLauncher, /if \(-not \$FromUpdateTask\)/);
  assert.match(syncLauncher, /Schedule\.Service/);
  assert.equal([...syncLauncher.matchAll(/New-Object -ComObject "Schedule\.Service"/g)].length, 1);
  assert.match(syncLauncher, /\$script:antiCodexScheduleService/);
  assert.match(syncLauncher, /Start-ScheduledTask\s+-TaskName\s+\$updateTaskName/);
  assert.doesNotMatch(syncLauncher, /\.Run\(\$null\)/);
  assert.match(syncLauncher, /function Get-AntiCodexUpdateTaskEvidence/);
  assert.match(syncLauncher, /function Wait-AntiCodexUpdateTaskRunning/);
  assert.match(syncLauncher, /\$expectedTaskArguments\s*=\s*"--headless `"\$node`" `"\$updateTaskScript`" --hide-console"/);
  assert.match(syncLauncher, /action\.Path\s+-ieq\s+\$conhost/);
  assert.match(syncLauncher, /action\.Arguments\s+-ceq\s+\$expectedTaskArguments/);
  assert.match(syncLauncher, /alreadyRunning\s*=\s*\$true[\s\S]*?ConvertTo-Json/);
  assert.match(syncLauncher, /alreadyRunning\s*=\s*\$false[\s\S]*?ConvertTo-Json/);
  assert.match(syncLauncher, /if \(\$FromUpdateTask\)[\s\S]*?Get-AntiCodexUpdateTaskEvidence[\s\S]*?stateCode -ne 4[\s\S]*?& \$syncScript -FromUpdateTask/);
  assert.match(hostSync, /\[switch\]\$FromUpdateTask/);
  assert.match(hostSync, /if \(-not \$NoRestart\)[\s\S]*?Assert-AntiCodexUpdateTaskContext/);
  assert.match(shortcutRepair, /\$updateTaskName\s*=\s*"Anti-Codex Updater"/);
  assert.match(shortcutRepair, /Update Anti-Codex outside the running Anti-Codex process job/);
  assert.match(shortcutRepair, /start-anticodex-update-task\.mjs/);
  assert.match(syncLauncher, /start-anticodex-update-task\.mjs/);
  assert.match(hostSync, /start-anticodex-update-task\.mjs/);
  assert.match(updateTaskBroker, /spawnSync\(powershell/);
  assert.match(updateTaskBroker, /sync-anticodex-launcher\.ps1/);
  assert.match(updateTaskBroker, /"-FromUpdateTask"/);
  assert.match(updateTaskBroker, /windowsHide:\s*true/);
  assert.match(updateTaskBroker, /anticodex-updater\.(?:out|err)\.log/);
  assert.match(updateTaskBroker, /process\.exitCode\s*=\s*exitCode/);
  assert.match(syncLauncher, /\$definition\.Triggers\.Count\s+-eq\s+0/);
  assert.match(syncLauncher, /\$definition\.Settings\.AllowDemandStart/);
});

test("the updater handoff publishes guarded status without overwriting detailed sync stages", () => {
  const readyGuard = syncLauncher.indexOf("[int]$taskEvidence.stateCode -ne 3");
  const queuedWrite = syncLauncher.indexOf('-Stage "updater_queued"', readyGuard);
  const taskRun = syncLauncher.indexOf("Start-ScheduledTask -TaskName $updateTaskName", queuedWrite);
  assert.ok(readyGuard >= 0, "the launcher must require a Ready task before publishing queued status");
  assert.ok(queuedWrite > readyGuard, "queued status must be published after the Ready check");
  assert.ok(taskRun > queuedWrite, "queued status must be published immediately before the only task Run");
  assert.equal([...syncLauncher.matchAll(/Start-ScheduledTask -TaskName \$updateTaskName/g)].length, 1);
  const queuedCalls = [...syncLauncher.matchAll(/^[^\r\n]*Set-AntiCodexUpdateOperation[^\r\n]*-Stage "updater_queued"[^\r\n]*$/gm)];
  assert.equal(queuedCalls.length, 2);
  for (const call of queuedCalls) assert.match(call[0], /-NewOperationId \$newOperationId/);

  assert.match(syncLauncher, /Set-AntiCodexUpdateOperation[^\r\n]*-Stage "updater_handoff"[^\r\n]*-ExpectedStates[^\r\n]*-ExpectedStages/);
  assert.match(syncLauncher, /Set-AntiCodexUpdateOperation[^\r\n]*-State "failed"[^\r\n]*-Stage "updater_handoff_failed"[^\r\n]*-ExpectedStates[^\r\n]*-ExpectedStages/);
  assert.match(syncLauncher, /-ExpectedStages @\("updater_queued", "updater_handoff"\)/);

  assert.match(updateTaskBroker, /anticodex-update-status\.psm1/);
  assert.match(updateTaskBroker, /markUpdaterHandoffFailed/);
  assert.match(updateTaskBroker, /ExpectedStates/);
  assert.match(updateTaskBroker, /ExpectedStages/);
  assert.match(updateTaskBroker, /result\.error[\s\S]*markUpdaterHandoffFailed/);
  assert.match(updateTaskBroker, /exitCode[\s\S]*?!== 0[\s\S]*markUpdaterHandoffFailed/);
});

test("the updater broker records an early missing-launcher failure without running a task", { skip: process.platform !== "win32" }, () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "anticodex-updater-broker-"));
  try {
    const localAppData = join(tempRoot, "Local");
    const appData = join(tempRoot, "Roaming");
    const installRoot = join(localAppData, "Anti-Codex");
    const scriptRoot = join(installRoot, "runtime", "scripts");
    const stateRoot = join(appData, "anticodex");
    mkdirSync(scriptRoot, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    const brokerPath = join(scriptRoot, "start-anticodex-update-task.mjs");
    copyFileSync(resolve(root, "scripts", "start-anticodex-update-task.mjs"), brokerPath);
    copyFileSync(resolve(root, "scripts", "anticodex-update-status.psm1"), join(scriptRoot, "anticodex-update-status.psm1"));
    writeFileSync(join(stateRoot, "update-status.json"), JSON.stringify({
      operation: {
        state: "running",
        stage: "updater_queued",
        operationId: "queued-before-broker",
        startedAt: "2001-01-01T00:00:00.000Z",
      },
    }));

    const result = spawnSync(process.execPath, [brokerPath], {
      cwd: installRoot,
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        APPDATA: appData,
        DEEPCODEX_STATE_ROOT: stateRoot,
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });

    assert.notEqual(result.status, 0);
    const status = JSON.parse(readFileSync(join(stateRoot, "update-status.json"), "utf8"));
    assert.equal(status.operation?.state, "failed");
    assert.equal(status.operation?.stage, "updater_handoff_failed");
    assert.equal(status.operation?.operationId, "queued-before-broker");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Manager names the updater queue, handoff, and component candidate stages in Chinese", () => {
  assert.match(managerInject, /updater_queued:\s*"\\u5df2\\u6392\\u961f\\uff0c\\u7b49\\u5f85\\u66f4\\u65b0\\u4efb\\u52a1"/);
  assert.match(managerInject, /updater_handoff:\s*"\\u66f4\\u65b0\\u4efb\\u52a1\\u5df2\\u63a5\\u7ba1"/);
  assert.match(managerInject, /updater_handoff_failed:\s*"\\u66f4\\u65b0\\u4efb\\u52a1\\u4ea4\\u63a5\\u5931\\u8d25"/);
  assert.match(managerInject, /component_candidate:\s*"\\u51c6\\u5907 CodexPlusPlus \\u5019\\u9009\\u7ec4\\u4ef6"/);
});

test("host sync gracefully releases the old launch task before starting the new host", () => {
  const stopHelperStart = hostSync.indexOf("function Stop-AntiCodexLaunchTaskForMaintenance");
  const stopHelperEnd = hostSync.indexOf("function Start-AntiCodexAfterSync", stopHelperStart);
  const stopHelper = stopHelperStart >= 0 && stopHelperEnd > stopHelperStart
    ? hostSync.slice(stopHelperStart, stopHelperEnd)
    : "";
  const stoppingStart = hostSync.indexOf('$updateStage = "stopping_host"');
  const activationStart = hostSync.indexOf('$updateStage = "activation"', stoppingStart);
  const stopping = stoppingStart >= 0 && activationStart > stoppingStart
    ? hostSync.slice(stoppingStart, activationStart)
    : "";

  const graceful = stopHelper.indexOf("Invoke-AntiCodexFixedRouteShutdown");
  const gracefulWait = stopHelper.indexOf("Wait-AntiCodexLaunchTaskStopped", graceful);
  const taskContract = stopHelper.indexOf("Assert-AntiCodexLaunchTaskContract", gracefulWait);
  const forcedStop = stopHelper.indexOf(".Stop(0)", gracefulWait);
  assert.ok(graceful >= 0, "missing graceful fixed-route shutdown");
  assert.ok(gracefulWait > graceful, "launcher wait must follow graceful shutdown");
  assert.ok(taskContract > gracefulWait, "forced task stop must validate the Launcher contract first");
  assert.ok(forcedStop > taskContract, "forced task stop must follow Launcher contract validation");
  assert.match(stopping, /Stop-AntiCodexLaunchTaskForMaintenance[\s\S]*?Wait-AntiCodexHostRelease[\s\S]*?Wait-AntiCodexComponentRelease/);
  assert.match(hostSync, /function Wait-AntiCodexLaunchTaskStopped/);
  assert.match(hostSync, /Start-ScheduledTask\s+-TaskName\s+\$launchTaskName/);
  assert.doesNotMatch(hostSync, /\.Run\(\$null\)/);
  const restartStart = hostSync.indexOf("function Start-AntiCodexAfterSync");
  const restartEnd = hostSync.indexOf("function Get-OriginalCodexProcessSnapshot", restartStart);
  const restart = restartStart >= 0 && restartEnd > restartStart ? hostSync.slice(restartStart, restartEnd) : "";
  const contractStart = hostSync.indexOf("function Assert-AntiCodexLaunchTaskContract");
  const contractEnd = hostSync.indexOf("function Stop-AntiCodexLaunchTaskForMaintenance", contractStart);
  const contract = contractStart >= 0 && contractEnd > contractStart ? hostSync.slice(contractStart, contractEnd) : "";
  assert.match(restart, /Assert-AntiCodexLaunchTaskContract/);
  assert.match(contract, /action\.Path[\s\S]*?\$conhost/);
  assert.match(contract, /--headless[\s\S]*?\$node[\s\S]*?\$launchTaskScript[\s\S]*?--hide-console/);
  assert.match(contract, /Principal\.LogonType[\s\S]*?-ne 3/);
  assert.match(contract, /Settings\.MultipleInstances[\s\S]*?-ne 2/);
  assert.match(contract, /Triggers\.Count[\s\S]*?-ne 0/);
  assert.match(contract, /Settings\.AllowDemandStart/);
});

test("host sync publishes the activated release before the Launcher waits on its barrier", () => {
  const activationEnd = hostSync.indexOf("Remove-Item -LiteralPath $hostSyncMarker");
  const syncErrorBranch = hostSync.indexOf("if ($syncError) {", activationEnd);
  const publication = activationEnd >= 0 && syncErrorBranch > activationEnd
    ? hostSync.slice(activationEnd, syncErrorBranch)
    : "";

  assert.match(publication, /\$syncMutex\.ReleaseMutex\(\)/);
  assert.match(publication, /\$syncMutexAcquired = \$false/);
});

test("host sync binds acceptance and rollback to the activated marker generation", () => {
  const activation = hostSync.indexOf("$activatedMarkerSha256 = Get-AntiCodexSha256");
  const publication = hostSync.indexOf("$syncMutex.ReleaseMutex()", activation);
  const acceptance = hostSync.indexOf("Invoke-AntiCodexPostSyncAcceptance", publication);
  const reclaim = hostSync.indexOf("$syncMutex.WaitOne(", acceptance);
  const generationCheck = hostSync.indexOf("active release changed after activation", reclaim);
  const rollbackRelease = hostSync.indexOf("$syncMutex.ReleaseMutex()", generationCheck);
  const rollbackCall = hostSync.indexOf(
    "& $rollbackScript -ExpectedActiveMarkerSha256 $activatedMarkerSha256",
    rollbackRelease,
  );

  assert.ok(activation >= 0, "activated marker generation is not captured");
  assert.ok(publication > activation, "Launcher publication must follow generation capture");
  assert.ok(reclaim > acceptance, "host sync must reclaim the mutex after acceptance");
  assert.ok(generationCheck > reclaim, "host sync must reject a superseded active generation");
  assert.ok(rollbackRelease > generationCheck, "host sync must release the Launcher barrier before rollback");
  assert.ok(rollbackCall > rollbackRelease, "rollback must receive the accepted marker generation");
  assert.match(rollback, /\[string\]\$ExpectedActiveMarkerSha256/);
  assert.match(rollback, /Get-AntiCodexSha256 -Path \$activeMarker[\s\S]*?ExpectedActiveMarkerSha256/);
});

test("automatic rollback stops and restarts only through the isolated Launcher task", () => {
  assert.match(rollback, /fixed-route\/shutdown/);
  assert.match(rollback, /function Stop-AntiCodexLaunchTaskForMaintenance/);
  assert.match(rollback, /Schedule\.Service/);
  assert.equal([...rollback.matchAll(/New-Object -ComObject "Schedule\.Service"/g)].length, 1);
  assert.match(rollback, /\$script:antiCodexScheduleService/);
  assert.match(rollback, /\.Stop\(0\)/);
  assert.match(rollback, /Wait-AntiCodexLaunchTaskStopped/);
  assert.match(rollback, /Start-ScheduledTask\s+-TaskName\s+\$launchTaskName/);
  assert.match(rollback, /\$expectedArguments\s*=\s*"--headless `"\$node`" `"\$launchTaskScript`" --hide-console"/);
  assert.match(rollback, /action\.Path\s+-ieq\s+\$conhost/);
  assert.match(rollback, /action\.Arguments\s+-ceq\s+\$expectedArguments/);
  assert.doesNotMatch(rollback, /\.Run\(\$null\)/);
  assert.doesNotMatch(rollback, /Start-Process[^\r\n]*\$startAntiCodex[^\r\n]*-InlineSupervisor/);
});

test("rollback binds restart acceptance and recovery to its activated marker generation", () => {
  const activation = rollback.indexOf("$activatedMarkerSha256 = Get-AntiCodexSha256");
  const publication = rollback.indexOf("$syncMutex.ReleaseMutex()", activation);
  const readiness = rollback.indexOf("Wait-AntiCodexPostRollbackReady", publication);
  const reclaim = rollback.indexOf("$syncMutex.WaitOne(", readiness);
  const generationCheck = rollback.indexOf("active release changed after rollback activation", reclaim);
  const recoveryRelease = rollback.indexOf("$syncMutex.ReleaseMutex()", generationCheck);
  const recovery = rollback.indexOf(
    "& $PSCommandPath -RecoveryAttempt -ExpectedActiveMarkerSha256 $activatedMarkerSha256",
    recoveryRelease,
  );
  const hostRollback = hostSync.indexOf(
    "& $rollbackScript -ExpectedActiveMarkerSha256 $activatedMarkerSha256",
  );
  const hostAfterRollback = hostRollback >= 0 ? hostSync.slice(hostRollback) : "";

  assert.ok(activation >= 0, "rollback activation marker generation is not captured");
  assert.ok(publication > activation, "rollback must capture its generation before publishing the Launcher barrier");
  assert.ok(readiness > publication, "rollback readiness must run after publishing the Launcher barrier");
  assert.ok(reclaim > readiness, "rollback must reclaim the mutex after readiness");
  assert.ok(generationCheck > reclaim, "rollback must reject a superseded generation");
  assert.ok(recoveryRelease > generationCheck, "rollback must publish before recursive recovery");
  assert.ok(recovery > recoveryRelease, "recursive recovery must receive the active marker generation");
  assert.doesNotMatch(
    hostAfterRollback,
    /Set-AntiCodexUpdateOperation -State "rolled_back"/,
    "host sync must not overwrite rollback's generation-bound terminal status",
  );
});

test("a failed host sync restores a valid active release before surfacing the error", () => {
  const errorStart = hostSync.indexOf("if ($syncError) {");
  const errorEnd = hostSync.indexOf("\ntry {", errorStart);
  const errorBlock = errorStart >= 0 && errorEnd > errorStart ? hostSync.slice(errorStart, errorEnd) : "";
  const restart = errorBlock.indexOf("Start-AntiCodexAfterSync");
  const rethrow = errorBlock.indexOf("throw $syncError");
  assert.ok(restart >= 0, "sync errors after shutdown must attempt a task-broker recovery restart");
  assert.ok(rethrow > restart, "the original sync error must be surfaced only after the recovery restart attempt");
});

test("host sync accepts only a stable visible Anti-Codex while native Codex is unchanged", () => {
  const snapshotStart = hostSync.indexOf("function Get-OriginalCodexProcessSnapshot");
  const snapshotEnd = hostSync.indexOf("function Test-OriginalCodexProcessesUnchanged", snapshotStart);
  const snapshot = snapshotStart >= 0 && snapshotEnd > snapshotStart
    ? hostSync.slice(snapshotStart, snapshotEnd)
    : "";
  const start = hostSync.indexOf("function Wait-AntiCodexPostSyncReady");
  const end = hostSync.indexOf("function Wait-AntiCodexChildProcess", start);
  const readiness = start >= 0 && end > start ? hostSync.slice(start, end) : "";

  assert.match(hostSync, /function Get-OriginalCodexProcessSnapshot/);
  assert.match(snapshot, /MainWindowHandle/);
  assert.ok(snapshot.includes("\\\\app\\\\(?:ChatGPT|Codex)\\.exe$"));
  assert.match(hostSync, /\$originalCodexBeforeSync\s*=\s*@\(Get-OriginalCodexProcessSnapshot\)/);
  assert.match(readiness, /\[int\]\$StableSeconds/);
  assert.match(readiness, /Get-AntiCodexRegisteredTask/);
  assert.doesNotMatch(readiness, /Get-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask/);
  assert.match(readiness, /MainWindowHandle/);
  assert.match(readiness, /Test-OriginalCodexProcessesUnchanged/);
  assert.match(readiness, /stableSince/);
});

test("launcher gives an auto-started Antigravity desktop durable output handles", () => {
  assert.match(antigravityDesktop, /function Start-AntigravityDesktop/);
  assert.match(antigravityDesktop, /antigravity-desktop\.out\.log/);
  assert.match(antigravityDesktop, /antigravity-desktop\.err\.log/);
  assert.match(antigravityDesktop, /Start-Process -FilePath \$ExecutablePath[\s\S]*?-RedirectStandardOutput \$stdoutPath[\s\S]*?-RedirectStandardError \$stderrPath/);
  assert.match(launcher, /Start-AntigravityDesktop -ExecutablePath \$antigravityPath -StateRoot \$StateRoot/);
  assert.match(launcher, /Ensure-AntigravityDesktop -StateRoot \$stateRoot/);
  assert.doesNotMatch(launcher, /Start-Process -FilePath \$antigravityPath\s*\|/);
  assert.match(postVerification, /Start-AntigravityDesktop -ExecutablePath \$path/);
  assert.doesNotMatch(postVerification, /Start-Process -FilePath \$path\s*\|/);
  assert.doesNotMatch(antigravityDesktop, /Get-CimInstance/);
  assert.match(launcher, /function Test-AntiCodexManagedLaunchBoundary/);
  assert.match(launcher, /Get-CimInstance Win32_Process/);
});

test("launchers prewarm installed Antigravity for a later native model-menu switch", () => {
  assert.match(
    taskLauncherSource,
    /await ensureAntigravityDesktop\(plan, env, \{ required: plan\.provider === "antigravity" \}\)/,
  );
  assert.doesNotMatch(
    taskLauncherSource,
    /if \(plan\.provider === "antigravity"\) \{\s*const desktopPath = await ensureAntigravityDesktop/,
  );
  assert.match(
    launcher,
    /Ensure-AntigravityDesktop -StateRoot \$stateRoot -Optional:\(\$selection\.provider -ne "antigravity"\)/,
  );
});

test("Antigravity fixed route preserves native UI model selection", () => {
  assert.doesNotMatch(fixedRouteSupervisor, /adapterOptions:\s*\{\s*fixedModel:/);
  assert.doesNotMatch(fixedRouteSupervisor, /CODEX_PLUS_FIXED_MODEL/);
});

test("already-running client is reused only when fixed-route health matches", () => {
  const branch = launcher.match(/if \(\$runningMain\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(branch, /Test-AntiCodexFixedRouteMatches/);
  assert.match(branch, /Activate-AntiCodexWindow/);
  assert.match(branch, /Write-Error/);
  assert.doesNotMatch(branch, /-TranslatorOnly|Stop-Process|start-anticodex-fixed-route/);
});

test("a stale persisted supervisor PID cannot block a fresh desktop launch", () => {
  const start = launcher.indexOf("function Get-RunningFixedRouteSupervisor");
  const end = launcher.indexOf("function Activate-AntiCodexWindow", start);
  const block = start >= 0 && end > start ? launcher.slice(start, end) : "";
  assert.match(block, /Get-AntiCodexFixedRouteHealth/);
  assert.match(block, /\[int\]\$health\.pid\s+-ne\s+\$processId/);
  assert.match(block, /return \$null/);
});

test("interactive launch gracefully hands off an existing headless route", () => {
  const functionStart = launcher.indexOf("function Stop-AntiCodexHeadlessFixedRoute");
  const functionEnd = launcher.indexOf("function Ensure-AntigravityDesktop", functionStart);
  const handoff = functionStart >= 0 && functionEnd > functionStart
    ? launcher.slice(functionStart, functionEnd)
    : "";
  assert.match(handoff, /fixed-route\/shutdown/);
  assert.match(handoff, /auth\.json/);
  assert.match(handoff, /Authorization/);
  assert.match(handoff, /Get-Process -Id/);
  assert.doesNotMatch(handoff, /taskkill|Get-CimInstance/);

  const branchStart = launcher.indexOf("$existingSupervisor = Get-RunningFixedRouteSupervisor");
  const branchEnd = launcher.indexOf("$nodeExecutable =", branchStart);
  const branch = branchStart >= 0 && branchEnd > branchStart
    ? launcher.slice(branchStart, branchEnd)
    : "";
  assert.match(branch, /\.headless\s+-eq\s+\$true/);
  assert.match(branch, /Stop-AntiCodexHeadlessFixedRoute/);
  assert.match(branch, /\$existingSupervisor\s*=\s*\$null/);
});

test("launcher delegates Manager ownership to the fixed-route supervisor", () => {
  assert.match(launcher, /ANTICODEX_MANAGER_API/);
  assert.doesNotMatch(launcher, /Ensure-AntiCodexManagerApi/);
  assert.doesNotMatch(launcher, /-TranslatorOnly/);
  assert.doesNotMatch(launcher, /start-deepcodex\.ps1/);
  assert.doesNotMatch(launcher, /translatorLoopbackUrl/);
  assert.doesNotMatch(launcher, /base_url\s*=.*8484/i);
});

test("launcher never contains an automatic visible-client relaunch loop", () => {
  assert.doesNotMatch(launcher, /MAX_RESTARTS|RESTART_BACKOFF|auto-restart|start-deepcodex\.ps1["']?\s*\)$/i);
  assert.match(launcher, /Refusing to launch a second Anti-Codex window/);
});

test("install and runtime sync require every fixed-route production module", () => {
  const required = [
    "scripts\\antigravity-desktop.ps1",
    "scripts\\apply-anticodex-upstream.ps1",
    "scripts\\start-anticodex-task.mjs",
    "scripts\\start-anticodex-shortcut-broker.ps1",
    "scripts\\start-anticodex-update-task.mjs",
    "scripts\\start-anticodex-fixed-route.mjs",
    "scripts\\anticodex-manager-service.mjs",
    "scripts\\build-anticodex-gate5-evidence.mjs",
    "scripts\\build-anticodex-gate8-autonomous-video-evidence.mjs",
    "scripts\\install-codexplusplus-component.ps1",
    "scripts\\test-anticodex-gate8-autonomous-video.mjs",
    "scripts\\test-anticodex-shortcut-restore.ps1",
    "scripts\\lib\\anticodex-fixed-route.mjs",
    "scripts\\lib\\anticodex-gate8-evidence.mjs",
    "scripts\\lib\\anticodex-release-binding.mjs",
    "scripts\\anticodex-report-io.ps1",
    "scripts\\deepcodex-cdp-inject.mjs",
    "scripts\\anticodex-manager-bridge.mjs",
    "scripts\\anticodex-manager-inject.js",
    "scripts\\anticodex-manager-open-inject.js",
    "translator\\antigravity-model-catalog.mjs",
    "translator\\antigravity-contract.mjs",
    "translator\\antigravity-native-mcp-bridge.mjs",
    "translator\\provider\\antigravity-cascade-client.mjs",
    "translator\\provider\\antigravity-chat-adapter.mjs",
    "translator\\provider\\antigravity-chat-server.mjs",
    "translator\\provider\\codexplusplus-upstream-probe.mjs",
    "translator\\provider\\start-antigravity-chat-provider.mjs",
  ];
  for (const path of required) {
    assert.ok(installer.includes(path), `installer missing ${path}`);
    assert.ok(runtimeSync.includes(path), `runtime sync missing ${path}`);
  }
  const syntaxList = runtimeSync.match(/\$syntaxCheckedJavaScriptFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  for (const path of required.filter((path) => /\.m?js$/.test(path))) {
    assert.ok(syntaxList.includes(path), `runtime syntax checks missing ${path}`);
  }
  assert.match(runtimeSync, /-Label "source \$relative"/);
  assert.match(runtimeSync, /-Label "runtime \$relative"/);
  assert.match(runtimeSync, /anticodex-manager-service-v1/);
  assert.match(runtimeSync, /anticodex\/fixed-route\/health/);
  assert.doesNotMatch(runtimeSync, /Wait-AntiCodexSessionLock|antigravitySessionLockPresent/);
});

test("runtime sync restarts only the fixed three-layer supervisor", () => {
  const requiredList = runtimeSync.match(/\$requiredSourceFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  const syntaxList = runtimeSync.match(/\$syntaxCheckedJavaScriptFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  assert.match(requiredList, /scripts\\start-anticodex-update-task\.mjs/);
  assert.doesNotMatch(requiredList, /scripts\\start-anticodex-hidden-node\.vbs/);
  assert.match(runtimeSync, /\$legacyRuntimeFiles[\s\S]*?scripts\\start-anticodex-hidden-node\.vbs/);
  assert.match(syntaxList, /scripts\\start-anticodex-update-task\.mjs/);
  for (const legacy of [
    "translator\\adaptive-server.mjs",
    "translator\\antigravity-upstream.mjs",
    "translator\\upstream-provider.mjs",
    "translator\\compat-rules.mjs",
    "translator\\codex-native-harness-turn.mjs",
    "translator\\codex-native-protocol.mjs",
    "translator\\codex-native-sse.mjs",
    "translator\\codex-native-compact.mjs",
    "translator\\response-history.mjs",
  ]) {
    assert.ok(!requiredList.includes(legacy), `runtime sync still requires ${legacy}`);
    assert.ok(!syntaxList.includes(legacy), `runtime sync still syntax-checks ${legacy}`);
  }
  assert.match(runtimeSync, /Stop-AntiCodexFixedRouteSupervisor/);
  assert.match(runtimeSync, /Invoke-AntiCodexFixedRouteLauncher/);
  assert.match(runtimeSync, /start-anticodex\.ps1/);
  assert.doesNotMatch(runtimeSync, /Start-AntiCodexTranslatorDirect|Set-AntiCodexTranslatorRestartEnvironment|Get-AntiCodexTranslatorProcesses|ANTICODEX_TRANSLATOR_RESTART/);
});

test("runtime sync inventories every local Manager action handler", () => {
  const requiredList = runtimeSync.match(/\$requiredSourceFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  const requiredFiles = new Set(
    [...requiredList.matchAll(/"([^"]+)"/g)].map((match) => match[1].toLowerCase()),
  );
  const managerScripts = [...managerService.matchAll(/\bscript:\s*"([^"]+)"/g)]
    .map((match) => `scripts\\${match[1]}`.toLowerCase());

  assert.ok(managerScripts.length > 0, "Manager action scripts must be discoverable");
  assert.deepEqual(
    managerScripts.filter((relativePath) => !requiredFiles.has(relativePath)),
    [],
    "every local Manager action handler must be cryptographically bound by the runtime manifest",
  );
});

test("runtime sync relaunches through the durable isolated Launcher task", () => {
  const start = runtimeSync.indexOf("function Invoke-AntiCodexFixedRouteLauncher");
  const end = runtimeSync.indexOf("$syntaxCheckedJavaScriptFiles", start);
  const relaunch = start >= 0 && end > start ? runtimeSync.slice(start, end) : "";

  assert.match(relaunch, /Schedule\.Service/);
  assert.match(relaunch, /Anti-Codex Launcher/);
  assert.match(relaunch, /Start-ScheduledTask\s+-TaskName\s+"Anti-Codex Launcher"/);
  assert.doesNotMatch(relaunch, /\.Run\(\$null\)/);
  assert.doesNotMatch(relaunch, /Win32_Process|InlineSupervisor|start-anticodex\.ps1/);
});

test("runtime sync publishes the staged runtime before waiting for the durable Launcher", () => {
  const launch = runtimeSync.indexOf("$launch = Invoke-AntiCodexFixedRouteLauncher");
  const publication = launch >= 0 ? runtimeSync.slice(Math.max(0, launch - 1_200), launch) : "";

  assert.match(publication, /\$compatibilitySyncMutex\.ReleaseMutex\(\)/);
  assert.match(publication, /\$syncMutex\.ReleaseMutex\(\)/);
});

test("runtime sync publishes the restored runtime before its recovery Launcher", () => {
  const launch = runtimeSync.indexOf("$restoredLaunch = Invoke-AntiCodexFixedRouteLauncher");
  const publication = launch >= 0 ? runtimeSync.slice(Math.max(0, launch - 1_200), launch) : "";

  assert.match(publication, /\$compatibilitySyncMutex\.ReleaseMutex\(\)/);
  assert.match(publication, /\$compatibilitySyncMutexAcquired = \$false/);
  assert.match(publication, /\$syncMutex\.ReleaseMutex\(\)/);
  assert.match(publication, /\$syncMutexAcquired = \$false/);
});

test("runtime sync reclaims both locks and binds its active transaction before cleanup", () => {
  const launch = runtimeSync.indexOf("$launch = Invoke-AntiCodexFixedRouteLauncher");
  const activeState = runtimeSync.indexOf('Set-AntiCodexRuntimeSyncState -State "active"', launch);
  const cleanup = runtimeSync.indexOf("Invoke-AntiCodexRuntimeVersionCleanup", activeState);
  const acceptance = launch >= 0 && cleanup > launch ? runtimeSync.slice(launch, cleanup) : "";
  const ownershipStart = runtimeSync.indexOf("function Test-AntiCodexActiveRuntimeOwned");
  const ownershipEnd = runtimeSync.indexOf("function Write-AntiCodexStagedRuntimeManifest", ownershipStart);
  const ownership = ownershipStart >= 0 && ownershipEnd > ownershipStart
    ? runtimeSync.slice(ownershipStart, ownershipEnd)
    : "";

  assert.match(acceptance, /\$syncMutex\.WaitOne\(300000\)/);
  assert.match(acceptance, /\$compatibilitySyncMutex\.WaitOne\(300000\)/);
  assert.match(acceptance, /Test-AntiCodexActiveRuntimeOwned -ExpectedTransactionId \$transactionId/);
  assert.match(ownership, /\.anticodex-runtime-manifest\.json/);
  assert.match(ownership, /Test-AntiCodexRuntimeSyncStateOwned/);
  assert.match(ownership, /\$manifest\.transactionId[\s\S]*?\$ExpectedTransactionId/);
  assert.ok(activeState > launch, "active state must follow generation-bound acceptance");
  assert.ok(cleanup > activeState, "runtime cleanup must remain inside the reclaimed transaction locks");
});

test("runtime recovery verifies transaction ownership before stopping or moving active", () => {
  const recoveryStart = runtimeSync.indexOf("$restoreError =");
  const stop = runtimeSync.indexOf("Stop-AntiCodexFixedRouteSupervisor", recoveryStart);
  const move = runtimeSync.indexOf("Move-AntiCodexRuntimeDirectory", recoveryStart);
  const destructive = Math.min(...[stop, move].filter((value) => value >= 0));
  const beforeDestruction = recoveryStart >= 0 && destructive > recoveryStart
    ? runtimeSync.slice(recoveryStart, destructive)
    : "";

  assert.match(beforeDestruction, /Test-AntiCodexActiveRuntimeOwned -ExpectedTransactionId \$transactionId/);
  assert.match(beforeDestruction, /Test-AntiCodexRuntimeSyncStateOwned -ExpectedTransactionId \$transactionId/);
  assert.match(beforeDestruction, /\$supersededByAnotherSync = \$true/);
});

test("runtime recovery reclaims both locks and binds the restored generation before status", () => {
  const launch = runtimeSync.indexOf("$restoredLaunch = Invoke-AntiCodexFixedRouteLauncher");
  const restoredState = runtimeSync.indexOf("$restoredState =", launch);
  const acceptance = launch >= 0 && restoredState > launch ? runtimeSync.slice(launch, restoredState) : "";

  assert.match(acceptance, /\$restoredRuntimeFingerprint/);
  assert.match(acceptance, /\$syncMutex\.WaitOne\(300000\)/);
  assert.match(acceptance, /\$compatibilitySyncMutex\.WaitOne\(300000\)/);
  assert.match(acceptance, /Get-AntiCodexRuntimeGenerationFingerprint -Directory \$targetRuntimeFull/);
  assert.match(acceptance, /Test-AntiCodexRuntimeSyncStateOwned -ExpectedTransactionId \$transactionId/);
  assert.match(acceptance, /active runtime changed during automatic restoration/);
});

test("runtime sync starts a Ready Launcher or reuses a queued/running Launcher", () => {
  const start = runtimeSync.indexOf("function Invoke-AntiCodexFixedRouteLauncher");
  const end = runtimeSync.indexOf("$syntaxCheckedJavaScriptFiles", start);
  const relaunch = start >= 0 && end > start ? runtimeSync.slice(start, end) : "";
  const stop = relaunch.indexOf("$task.Stop(0)");
  const afterStop = stop >= 0 ? relaunch.slice(stop) : "";

  assert.match(relaunch, /\$task\.State -eq 3[\s\S]*?Start-ScheduledTask/);
  assert.match(relaunch, /\$task\.State -notin @\(2, 4\)/);
  assert.match(relaunch, /\$task\.State -in @\(2, 4\)[\s\S]*?\$task\.Stop\(0\)/);
  assert.match(afterStop, /while \(\[int\]\$task\.State -ne 3/);
});

test("runtime sync accepts verified health through Launcher state transitions", () => {
  const start = runtimeSync.indexOf("function Invoke-AntiCodexFixedRouteLauncher");
  const end = runtimeSync.indexOf("$syntaxCheckedJavaScriptFiles", start);
  const relaunch = start >= 0 && end > start ? runtimeSync.slice(start, end) : "";
  const pollingStart = relaunch.indexOf("$deadline =");
  const pollingEnd = relaunch.indexOf("return [pscustomobject]", pollingStart);
  const polling = relaunch.slice(pollingStart, pollingEnd);

  assert.doesNotMatch(polling, /if \(\[int\]\$task\.State -notin @\(2, 4\)\) \{ break \}/);
  assert.match(polling, /\$ready = \(\$null -ne \$health -and \$null -ne \$fixedRoute\)/);
});

test("runtime sync gives both cold launcher attempts enough time before rollback", () => {
  const minimums = [...runtimeSync.matchAll(/Invoke-AntiCodexFixedRouteLauncher -Seconds \(\[Math\]::Max\((\d+), \$TimeoutSec\)\)/g)]
    .map((match) => Number(match[1]));

  assert.deepEqual(minimums, [60, 60]);
});

test("runtime sync no-restart mode verifies copied files without polling live health", () => {
  assert.match(runtimeSync, /\$runtimeHashMismatches\s*=\s*@\(/);
  assert.match(runtimeSync, /function Get-AntiCodexSha256/);
  assert.doesNotMatch(runtimeSync, /\bGet-FileHash\b/);
  assert.match(runtimeSync, /if \(-not \$NoRestart\) \{[\s\S]*?Wait-AntiCodexHealth/);
  assert.match(runtimeSync, /mode = if \(\$NoRestart\) \{ "synced_without_restart" \}/);
  assert.match(runtimeSync, /verifiedFileCount = \$requiredSourceFiles\.Count/);
});

test("runtime sync revalidates supervisor identity before controlled fallback", () => {
  const verifierStart = runtimeSync.indexOf("function Stop-AntiCodexVerifiedScriptProcess");
  const verifierEnd = runtimeSync.indexOf("function Get-AntiCodexFixedRouteSupervisorProcesses", verifierStart);
  const verifier = runtimeSync.slice(verifierStart, verifierEnd);
  const start = runtimeSync.indexOf("function Stop-AntiCodexFixedRouteSupervisor");
  const end = runtimeSync.indexOf("function Remove-AntiCodexLegacyRuntimeFiles", start);
  const stop = runtimeSync.slice(start, end);
  assert.match(stop, /Get-AntiCodexScriptProcessSnapshot/);
  assert.match(stop, /Stop-AntiCodexVerifiedScriptProcess/);
  assert.match(verifier, /VerifiedProcessHandle\]::Open\(\$processId\)/);
  assert.match(verifier, /CreationFileTimeUtcTicks/);
  assert.match(verifier, /ExecutablePath/);
  assert.match(verifier, /Test-AntiCodexCommandLineHasExactPath/);
  assert.match(verifier, /TerminateAndWait\(3000\)/);
  assert.doesNotMatch(verifier, /Stop-Process|Invoke-CimMethod|\.Terminate\(\)/);
  assert.match(runtimeSync, /OpenProcess/);
  assert.match(runtimeSync, /GetProcessTimes/);
  assert.match(runtimeSync, /QueryFullProcessImageName/);
  assert.match(runtimeSync, /TerminateProcess/);
  assert.match(runtimeSync, /WaitForSingleObject/);
});

test("runtime sync requests graceful fixed-route shutdown before verified fallback", () => {
  const start = runtimeSync.indexOf("function Stop-AntiCodexFixedRouteSupervisor");
  const end = runtimeSync.indexOf("function Remove-AntiCodexLegacyRuntimeFiles", start);
  const stop = runtimeSync.slice(start, end);
  const graceful = stop.indexOf("Invoke-AntiCodexFixedRouteShutdown");
  const force = stop.indexOf("Stop-AntiCodexVerifiedScriptProcess", graceful);
  assert.ok(graceful >= 0, "missing graceful shutdown request");
  assert.ok(force > graceful, "verified process stop must remain a fallback");
  assert.doesNotMatch(stop, /taskkill(?:\.exe)?/i);
  assert.match(runtimeSync, /anticodex\/fixed-route\/shutdown/);
  assert.match(runtimeSync, /Authorization/);
});

test("standalone Manager recovery uses the formal fixed-route launcher", () => {
  assert.match(manager, /start-anticodex\.ps1/);
  assert.doesNotMatch(manager, /start-deepcodex\.ps1|-TranslatorOnly|TRANSLATOR_(?:PORT|HOST|LISTEN_HOST|URL|UPSTREAM_MODE)|ANTICODEX_NATIVE_TOOL_BRIDGE/);
});

test("installer requires fixed-route modules and removes legacy runtime files", () => {
  const requiredRuntimeList = installer.match(/foreach \(\$requiredRuntimePath in @\(([\s\S]*?)\n\s*\)\)/)?.[1] ?? "";
  assert.match(requiredRuntimeList, /scripts\\start-anticodex-update-task\.mjs/);
  assert.doesNotMatch(requiredRuntimeList, /scripts\\start-anticodex-scheduled-node\.ps1/);
  assert.doesNotMatch(requiredRuntimeList, /scripts\\start-anticodex-hidden-node\.vbs/);
  assert.match(requiredRuntimeList, /scripts\\start-anticodex-shortcut-broker\.ps1/);
  for (const legacy of [
    "translator\\adaptive-server.mjs",
    "translator\\codex-native-compact.mjs",
    "translator\\codex-native-harness-turn.mjs",
    "translator\\codex-native-protocol.mjs",
    "translator\\codex-native-sse.mjs",
  ]) {
    assert.ok(!requiredRuntimeList.includes(legacy), `installer still requires ${legacy}`);
  }
  assert.match(installer, /\$legacyRuntimeFiles\s*=\s*@\(/);
  assert.match(installer, /scripts\\start-anticodex-scheduled-node\.ps1/);
  assert.match(installer, /scripts\\start-anticodex-hidden-node\.vbs/);
  assert.match(installer, /scripts\\start-anticodex-task-hidden\.vbs/);
  assert.match(installer, /scripts\\start-anticodex-task-hidden\.ps1/);
  assert.match(installer, /Remove-Item -LiteralPath \$legacyPath -Force/);
});
