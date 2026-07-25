import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const repairScript = readFileSync(resolve(root, "scripts", "repair-anticodex-shortcuts.ps1"), "utf8");
const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
const productSync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
const productRollback = readFileSync(resolve(root, "scripts", "rollback-anticodex.ps1"), "utf8");
const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
const syncReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
const startScript = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
const launchTask = readFileSync(resolve(root, "scripts", "start-anticodex-task.mjs"), "utf8");
const consoleHideScript = readFileSync(resolve(root, "scripts", "hide-anticodex-console.ps1"), "utf8");
const shortcutBrokerPath = resolve(root, "scripts", "start-anticodex-shortcut-broker.ps1");
const shortcutBroker = existsSync(shortcutBrokerPath) ? readFileSync(shortcutBrokerPath, "utf8") : "";
const shortcutRestoreAcceptancePath = resolve(root, "scripts", "test-anticodex-shortcut-restore.ps1");
const shortcutRestoreAcceptance = existsSync(shortcutRestoreAcceptancePath)
  ? readFileSync(shortcutRestoreAcceptancePath, "utf8")
  : "";

test("interactive shortcut broker recovers the exact hidden main window without selecting an overlay", () => {
  assert.equal(existsSync(shortcutBrokerPath), true);
  assert.match(shortcutBroker, /codex-patched-app[\\/]Anti-Codex\.exe/);
  assert.match(shortcutBroker, /Get-Process\s+-Name\s+"Anti-Codex"/);
  assert.match(shortcutBroker, /\.Path/);
  assert.match(shortcutBroker, /-ieq\s+\$expectedExecutable/);
  assert.match(shortcutBroker, /\.StartTime/);
  assert.doesNotMatch(shortcutBroker, /Get-CimInstance|Win32_Process/);
  assert.doesNotMatch(shortcutBroker, /MainWindowHandle/);
  assert.match(shortcutBroker, /EnumWindows/);
  assert.match(shortcutBroker, /GetWindowLong/);
  assert.match(shortcutBroker, /GetWindowText/);
  assert.match(shortcutBroker, /GetClassName/);
  assert.match(shortcutBroker, /Chrome_WidgetWin_1/);
  assert.match(shortcutBroker, /StringComparison\.Ordinal/);
  assert.match(shortcutBroker, /0x00C00000/);
  assert.match(shortcutBroker, /FindMainWindows/);
  assert.match(
    shortcutBroker,
    /candidateCount\+\+;[\s\S]*?return new long\[\] \{ candidateCount, result\.ToInt64\(\) \};/,
  );
  assert.match(shortcutBroker, /Test-ExactAntiCodexProcessIdentity/);
  assert.match(shortcutBroker, /ShowWindowAsync/);
  assert.match(shortcutBroker, /ShowWindowAsync\(\$window,\s*4\)/);
  assert.match(shortcutBroker, /RedrawWindow/);
  assert.match(shortcutBroker, /DwmFlush/);
  assert.match(shortcutBroker, /SetForegroundWindow/);
  assert.match(shortcutBroker, /GetForegroundWindow/);
  assert.match(shortcutBroker, /GetWindowThreadProcessId/);
  assert.match(shortcutBroker, /IsIconic/);
  assert.match(shortcutBroker, /IsWindowVisible/);
  assert.match(shortcutBroker, /Get-ForegroundProcessId/);
  assert.match(shortcutBroker, /foregroundStableSince/);
  assert.doesNotMatch(shortcutBroker, /if \(\[AntiCodexShortcutWindow\]::SetForegroundWindow\(\$window\)\) \{ return \$true \}/);
  const runningBranch = shortcutBroker.match(/if \(\$matchingProcesses\.Count -gt 0\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(runningBranch, /\$matchingProcesses\.Count -eq 1/);
  assert.match(runningBranch, /Focus-ExactAntiCodexWindow -Processes \$matchingProcesses/);
  assert.match(shortcutBroker, /\$eligibleWindowCount \+= \$candidateCount/);
  assert.match(shortcutBroker, /\$eligibleWindowCount -ne 1 -or \$eligibleWindows\.Count -ne 1/);
  assert.match(runningBranch, /exit 0/);
  assert.match(runningBranch, /throw "An exact Anti-Codex process is running, but its unique main window could not be restored\."/);
  assert.doesNotMatch(runningBranch, /\[void\]\(Focus-ExactAntiCodexWindow/);
  assert.doesNotMatch(runningBranch, /Start-ScheduledTask/);
  assert.doesNotMatch(runningBranch, /\.Run\(/);
  assert.match(shortcutBroker, /Start-ScheduledTask\s+-TaskName\s+"Anti-Codex Launcher"/);
  assert.doesNotMatch(shortcutBroker, /Schedule\.Service|GetTask\(|\.Run\(\$null\)/);
});

test("installed shortcut restore acceptance proves one process, one page, and no blank frame", () => {
  assert.equal(existsSync(shortcutRestoreAcceptancePath), true);
  assert.match(shortcutRestoreAcceptance, /codex-patched-app[\\/]Anti-Codex\.exe/);
  assert.match(shortcutRestoreAcceptance, /\[int\]\$ExpectedMainPid/);
  assert.match(shortcutRestoreAcceptance, /\[int\]\$ExpectedOriginalCodexPid/);
  assert.match(shortcutRestoreAcceptance, /\[int\]\$SampleDurationMs\s*=\s*3000/);
  assert.match(shortcutRestoreAcceptance, /ShowWindowAsync\(\$windowHandle,\s*6\)/);
  assert.match(shortcutRestoreAcceptance, /IsIconic/);
  assert.match(shortcutRestoreAcceptance, /Anti-Codex\.lnk/);
  assert.match(shortcutRestoreAcceptance, /Start-Process\s+-FilePath\s+\$desktopShortcut/);
  assert.equal([...shortcutRestoreAcceptance.matchAll(/Start-Process\s+-FilePath\s+\$desktopShortcut/g)].length, 1);
  assert.match(shortcutRestoreAcceptance, /Get-ExactAntiCodexSnapshot/);
  assert.match(shortcutRestoreAcceptance, /app:\/\//);
  assert.match(shortcutRestoreAcceptance, /StretchBlt/);
  assert.match(
    shortcutRestoreAcceptance,
    /\$foregroundWindowHandle\s*=\s*\[AntiCodexShortcutRestoreProbe\]::GetForegroundWindow\(\)[\s\S]*?\$isExactForeground\s*=\s*\[int64\]\$foregroundWindowHandle\s+-eq\s+\[int64\]\$windowHandle/,
  );
  assert.match(
    shortcutRestoreAcceptance,
    /if \(\$null -eq \$frameCaptureOriginMs -and \$isVisible -and -not \$isMinimized -and \$isExactForeground\) \{\s*\$frameCaptureOriginMs = \$observationAtMs/,
  );
  assert.match(
    shortcutRestoreAcceptance,
    /if \(\$null -ne \$frameCaptureOriginMs -and \$isVisible -and -not \$isMinimized -and \$isExactForeground\) \{\s*\$frameStartedAtMs = \[int\]\$stopwatch\.ElapsedMilliseconds\s*\$metric = Get-FrameMetric -WindowHandle \$windowHandle/,
  );
  assert.match(shortcutRestoreAcceptance, /\$sampleDeadlineMs\s*=\s*\[int\]\$activationSentAtMs\s*\+\s*\$SampleDurationMs/);
  assert.match(shortcutRestoreAcceptance, /while \(\$stopwatch\.ElapsedMilliseconds -lt \$sampleDeadlineMs\)/);
  assert.match(shortcutRestoreAcceptance, /\$taskbarActivationWaitMs\s*=\s*\$observationAtMs\s*-\s*\[int\]\$taskbarClickSentAtMs/);
  assert.match(shortcutRestoreAcceptance, /frameCaptureOrigin = "exact-foreground-window"/);
  assert.match(shortcutRestoreAcceptance, /frameCaptureOriginMs = \$frameCaptureOriginMs/);
  assert.match(shortcutRestoreAcceptance, /deadlineState = \$deadlineState/);
  assert.match(shortcutRestoreAcceptance, /probeRecoveryApplied = \$probeRecoveryApplied/);
  assert.match(
    shortcutRestoreAcceptance,
    /if \(\$null -eq \$deadlineState -or -not \$deadlineState\.visible -or \$deadlineState\.minimized -or -not \$deadlineState\.exactForeground\) \{ \$failures\.Add\("Anti-Codex was not visible, restored, and exactly foreground at the sampling deadline"\)/,
  );
  assert.match(
    shortcutRestoreAcceptance,
    /if \(\$probeRecoveryApplied\) \{ \$failures\.Add\("the restore probe applied recovery after the sampling deadline"\)/,
  );
  assert.match(shortcutRestoreAcceptance, /if \(\$maxVisibleWindowCount -gt 1\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$maxVisibleTopLevelWindowCount -gt 1\)/);
  assert.doesNotMatch(shortcutRestoreAcceptance, /\$maxVisible(?:TopLevel)?WindowCount -ne 1/);
  assert.match(
    shortcutRestoreAcceptance,
    /\$blankFrames = @\(\$frames \| Where-Object \{ \$_.standardDeviation -lt 5 -or \$_.darkRatio -lt 0\.005 \}\)/,
  );
  assert.match(shortcutRestoreAcceptance, /blankFrameCount/);
  assert.match(shortcutRestoreAcceptance, /Get-MainAppPages/);
  assert.match(shortcutRestoreAcceptance, /response\.GetEnumerator\(\)/);
  assert.match(shortcutRestoreAcceptance, /initialRoute=%2Favatar-overlay/);
  assert.match(shortcutRestoreAcceptance, /originalCodexAlive/);
  assert.doesNotMatch(shortcutRestoreAcceptance, /Stop-Process|taskkill|TerminateProcess/);
});

test("taskbar restore keeps the cursor off hover-activated apps until the sampling deadline", () => {
  const samplingStart = shortcutRestoreAcceptance.indexOf("while ($stopwatch.ElapsedMilliseconds -lt $sampleDeadlineMs)");
  const finallyStart = shortcutRestoreAcceptance.indexOf("} finally {", samplingStart);
  const deadlineStart = shortcutRestoreAcceptance.indexOf(
    "$deadlineForegroundWindowHandle = [AntiCodexShortcutRestoreProbe]::GetForegroundWindow()",
    finallyStart,
  );
  const cursorRestore = shortcutRestoreAcceptance.indexOf(
    "SetCursorPos($savedTaskbarCursorX, $savedTaskbarCursorY)",
    finallyStart,
  );

  assert.ok(samplingStart >= 0 && finallyStart > samplingStart);
  assert.doesNotMatch(
    shortcutRestoreAcceptance.slice(samplingStart, finallyStart),
    /SetCursorPos\(\$savedTaskbarCursorX,\s*\$savedTaskbarCursorY\)/,
  );
  assert.match(
    shortcutRestoreAcceptance.slice(samplingStart, finallyStart),
    /SetCursorPos\(\$safeCursorX,\s*\$safeCursorY\)/,
  );
  assert.ok(deadlineStart >= 0 && cursorRestore > deadlineStart);
});

test("taskbar restore captures two exact-foreground frames before moving the cursor", () => {
  const samplingStart = shortcutRestoreAcceptance.indexOf("while ($stopwatch.ElapsedMilliseconds -lt $sampleDeadlineMs)");
  const finallyStart = shortcutRestoreAcceptance.indexOf("} finally {", samplingStart);
  const sampling = samplingStart >= 0 && finallyStart > samplingStart
    ? shortcutRestoreAcceptance.slice(samplingStart, finallyStart)
    : "";
  const origin = sampling.indexOf("$frameCaptureOriginMs = $observationAtMs");
  const frame = sampling.indexOf("Get-FrameMetric -WindowHandle $windowHandle");
  const cursorMove = sampling.indexOf("SetCursorPos($safeCursorX, $safeCursorY)");

  assert.match(shortcutRestoreAcceptance, /\$safeCursorX = \$null\s*\$safeCursorY = \$null/);
  assert.match(
    sampling,
    /if \(\$taskbarActivationObserved -and \$frames\.Count -gt 1 -and \$null -eq \$safeCursorX\)/,
  );
  assert.ok(origin >= 0 && frame > origin);
  assert.ok(cursorMove > frame, "two exact-foreground frames must precede the safe-cursor move");
});

test("taskbar restore nudges and reconfirms the exact cursor target before clicking", () => {
  const clickStart = shortcutRestoreAcceptance.indexOf("function Invoke-TaskbarButtonActualMouseClick");
  const clickEnd = shortcutRestoreAcceptance.indexOf("\nfunction Get-MainAppPages", clickStart);
  const click = clickStart >= 0 && clickEnd > clickStart
    ? shortcutRestoreAcceptance.slice(clickStart, clickEnd)
    : "";
  const nudge = click.indexOf("[int]$Target.clickPoint.x - 1");
  const exactTarget = click.indexOf("[int]$Target.clickPoint.x,", nudge + 1);
  const cursorCheck = click.indexOf("GetCursorPos([ref]$confirmedCursor)");
  const send = click.indexOf("SendLeftClick()");

  assert.ok(nudge >= 0 && exactTarget > nudge);
  assert.match(click, /Start-Sleep -Milliseconds 40/);
  assert.match(click, /GetCursorPos\(\[ref\]\$confirmedCursor\)/);
  assert.match(click, /\$confirmedCursor\.X\s+-ne\s+\[int\]\$Target\.clickPoint\.x/);
  assert.ok(cursorCheck > exactTarget && send > cursorCheck);
  assert.doesNotMatch(click, /hotTrackDeadline|hotTracked/);
});

test("taskbar restore samples transient topology outside the frame loop", () => {
  const samplingStart = shortcutRestoreAcceptance.indexOf("while ($stopwatch.ElapsedMilliseconds -lt $sampleDeadlineMs)");
  const finallyStart = shortcutRestoreAcceptance.indexOf("} finally {", samplingStart);
  const sampling = samplingStart >= 0 && finallyStart > samplingStart
    ? shortcutRestoreAcceptance.slice(samplingStart, finallyStart)
    : "";
  const watcherReady = shortcutRestoreAcceptance.indexOf("$topologyWatcherReadyBeforeActivation = $true");
  const minimize = shortcutRestoreAcceptance.indexOf("[AntiCodexShortcutRestoreProbe]::ShowWindowAsync($windowHandle, 6)");
  const after = shortcutRestoreAcceptance.indexOf("$after = Get-ExactAntiCodexSnapshot");
  const watcherStop = shortcutRestoreAcceptance.indexOf("$topologyWatcherState.Stop = $true");

  assert.doesNotMatch(sampling, /Get-ExactAntiCodexSnapshot/);
  assert.doesNotMatch(sampling, /GetExactProcessSnapshot/);
  assert.match(shortcutRestoreAcceptance, /\$topologyWatcherState = \[hashtable\]::Synchronized/);
  assert.match(shortcutRestoreAcceptance, /\$topologyWatcherPowerShell\.BeginInvoke\(\)/);
  assert.match(shortcutRestoreAcceptance, /\$topologyWatcherPowerShell\.EndInvoke\(\$topologyWatcherAsync\)/);
  assert.match(shortcutRestoreAcceptance, /GetExactProcessSnapshot\(\$ExpectedExecutable\)/);
  assert.match(shortcutRestoreAcceptance, /\$State\.Result = \[pscustomobject\]@\{/);
  assert.doesNotMatch(shortcutRestoreAcceptance, /SeenRootProcessIds = \[System\.Collections\.Generic\.HashSet/);
  assert.match(shortcutRestoreAcceptance, /\.AsyncWaitHandle\.WaitOne\(\$topologyWatcherStopTimeoutMs\)/);
  assert.match(
    shortcutRestoreAcceptance,
    /\$topologyWatcherStopAsync\s*=\s*\$topologyWatcherPowerShell\.BeginStop\(\$null,\s*\$null\)[\s\S]*?\$topologyWatcherStopAsync\.AsyncWaitHandle\.WaitOne\(\$topologyWatcherStopTimeoutMs\)[\s\S]*?\$topologyWatcherPowerShell\.EndStop\(\$topologyWatcherStopAsync\)/,
  );
  assert.match(
    shortcutRestoreAcceptance,
    /if \(\$topologyWatcherStopCompleted\) \{\s*\$topologyWatcherPowerShell\.EndStop\(\$topologyWatcherStopAsync\)\s*\$topologyWatcherTerminated = \$true\s*\} else \{/,
  );
  assert.ok(watcherReady >= 0 && watcherReady < minimize, "the topology watcher must sample before activation");
  assert.ok(watcherStop >= 0 && after > watcherStop, "the final exact snapshot must bridge the bounded watcher stop");
  assert.match(
    shortcutRestoreAcceptance,
    /if \(\$topologyWatcherTerminated\) \{\s*\$after = Get-ExactAntiCodexSnapshot/,
  );
  assert.match(
    shortcutRestoreAcceptance,
    /if \(-not \$topologyWatcherFinalSnapshotTaken\) \{\s*\$failures\.Add\("Anti-Codex final topology snapshot was skipped because the watcher did not terminate"\)/,
  );
  assert.match(shortcutRestoreAcceptance, /if \(\$topologyWatcherError\)/);
  assert.match(shortcutRestoreAcceptance, /if \(-not \$topologyWatcherReadyBeforeActivation\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$topologyWatcherSampleCount -lt 2\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$topologyWatcherMaxIntervalMs -gt \$maximumTopologySampleIntervalMs\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$null -eq \$topologyWatcherTailGapMs -or \$topologyWatcherTailGapMs -gt \$maximumTopologySampleIntervalMs\)/);
  assert.match(shortcutRestoreAcceptance, /\$maxRootProcessCount = \[Math\]::Max\(\$maxRootProcessCount, @\(\$after\.rootProcessIds\)\.Count\)/);
  assert.match(shortcutRestoreAcceptance, /\$maximumTopologySampleIntervalMs = 250/);
  assert.match(shortcutRestoreAcceptance, /topologyWatcherSampleCount = \$topologyWatcherSampleCount/);
  assert.match(shortcutRestoreAcceptance, /topologyWatcherMaxIntervalMs = \$topologyWatcherMaxIntervalMs/);
  assert.match(shortcutRestoreAcceptance, /topologyWatcherTailGapMs = \$topologyWatcherTailGapMs/);
  assert.match(shortcutRestoreAcceptance, /topologyWatcherReadyBeforeActivation = \$topologyWatcherReadyBeforeActivation/);
  assert.match(shortcutRestoreAcceptance, /topologyWatcherError = \$topologyWatcherError/);
  assert.match(shortcutRestoreAcceptance, /topologyWatcherFinalSnapshotTaken = \$topologyWatcherFinalSnapshotTaken/);
  assert.match(shortcutRestoreAcceptance, /\$maximumFrameSampleIntervalMs = 125/);
});

test("taskbar restore continuously samples app pages without blocking the frame loop", () => {
  const samplingStart = shortcutRestoreAcceptance.indexOf("while ($stopwatch.ElapsedMilliseconds -lt $sampleDeadlineMs)");
  const finallyStart = shortcutRestoreAcceptance.indexOf("} finally {", samplingStart);
  const sampling = samplingStart >= 0 && finallyStart > samplingStart
    ? shortcutRestoreAcceptance.slice(samplingStart, finallyStart)
    : "";
  const watcherReady = shortcutRestoreAcceptance.indexOf("$appPageWatcherReadyBeforeActivation = $true");
  const minimize = shortcutRestoreAcceptance.indexOf("[AntiCodexShortcutRestoreProbe]::ShowWindowAsync($windowHandle, 6)");
  const pagesAfter = shortcutRestoreAcceptance.indexOf("$pagesAfter = Get-AppPageCount -CdpPort $cdpPort");
  const watcherStop = shortcutRestoreAcceptance.indexOf("$appPageWatcherState.Stop = $true");

  assert.doesNotMatch(sampling, /Get-AppPageCount -CdpPort \$cdpPort/);
  assert.doesNotMatch(sampling, /Get-MainAppPages -CdpPort \$cdpPort/);
  assert.doesNotMatch(sampling, /Invoke-RestMethod/);
  assert.match(shortcutRestoreAcceptance, /\$pagesBefore = Get-AppPageCount -CdpPort \$cdpPort/);
  assert.match(shortcutRestoreAcceptance, /\$pagesAfter = Get-AppPageCount -CdpPort \$cdpPort/);
  assert.match(shortcutRestoreAcceptance, /\[hashtable\]::Synchronized/);
  assert.match(shortcutRestoreAcceptance, /\[System\.Management\.Automation\.PowerShell\]::Create\(\)/);
  assert.match(shortcutRestoreAcceptance, /\$appPageWatcherPowerShell\.BeginInvoke\(\)/);
  assert.match(shortcutRestoreAcceptance, /\$appPageWatcherPowerShell\.EndInvoke\(\$appPageWatcherAsync\)/);
  assert.match(shortcutRestoreAcceptance, /Get-MainAppPages -CdpPort \$CdpPort -TimeoutSec 1/);
  assert.ok(watcherReady >= 0 && watcherReady < minimize, "the async watcher must complete one sample before activation");
  assert.ok(pagesAfter >= 0 && watcherStop > pagesAfter, "the async watcher must cover the final page sample");
  assert.match(shortcutRestoreAcceptance, /\$ErrorActionPreference = "Stop"/);
  assert.match(shortcutRestoreAcceptance, /\$State\.MinCount = \[Math\]::Min\(\[int\]\$State\.MinCount, \$count\)/);
  assert.match(shortcutRestoreAcceptance, /\$maxAppPageCount = \[Math\]::Max\(\$maxAppPageCount, \$appPageWatcherMaxCount\)/);
  assert.match(shortcutRestoreAcceptance, /\$maxAppPageCount = \[Math\]::Max\(\$maxAppPageCount, \$pagesAfter\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$appPageWatcherError\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$appPageSampleCount -lt 2\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$appPageWatcherMinCount -ne 1 -or \$appPageWatcherMaxCount -ne 1\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$appPageWatcherMaxIntervalMs -gt \$maximumAppPageSampleIntervalMs\)/);
  assert.match(shortcutRestoreAcceptance, /if \(\$appPageWatcherTailGapMs -gt \$maximumAppPageSampleIntervalMs\)/);
  assert.match(shortcutRestoreAcceptance, /appPageSampleCount = \$appPageSampleCount/);
  assert.match(shortcutRestoreAcceptance, /appPageWatcherMinCount = \$appPageWatcherMinCount/);
  assert.match(shortcutRestoreAcceptance, /appPageWatcherError = \$appPageWatcherError/);
  assert.match(shortcutRestoreAcceptance, /appPageWatcherMaxIntervalMs = \$appPageWatcherMaxIntervalMs/);
  assert.match(shortcutRestoreAcceptance, /MaxIntervalStartUtcTicks = \[int64\]0/);
  assert.match(shortcutRestoreAcceptance, /MaxIntervalEndUtcTicks = \[int64\]0/);
  assert.match(shortcutRestoreAcceptance, /\$State\.MaxIntervalStartUtcTicks = \$lastSampleUtcTicks/);
  assert.match(shortcutRestoreAcceptance, /\$State\.MaxIntervalEndUtcTicks = \$sampleAtUtcTicks/);
  assert.match(shortcutRestoreAcceptance, /appPageWatcherMaxIntervalStartedAtUtc = \$appPageWatcherMaxIntervalStartedAtUtc/);
  assert.match(shortcutRestoreAcceptance, /appPageWatcherMaxIntervalEndedAtUtc = \$appPageWatcherMaxIntervalEndedAtUtc/);
  assert.match(shortcutRestoreAcceptance, /appPageWatcherTailGapMs = \$appPageWatcherTailGapMs/);
});

test("taskbar restore reports the early blank-to-painted transition without recovery", () => {
  assert.match(shortcutRestoreAcceptance, /\$firstNonBlankFrame\s*=/);
  assert.match(shortcutRestoreAcceptance, /\$lastBlankFrame\s*=/);
  assert.match(shortcutRestoreAcceptance, /\$firstNonBlankFrameDelayMs\s*=/);
  assert.match(shortcutRestoreAcceptance, /\$lastBlankFrameDelayMs\s*=/);
  assert.match(shortcutRestoreAcceptance, /\$restoreDurationMs\s*=/);
  assert.match(shortcutRestoreAcceptance, /\[int\]\$firstVisibleAtMs - \[int\]\$activationSentAtMs/);
  assert.match(shortcutRestoreAcceptance, /\$earlyFrameTimeline\s*=/);
  assert.match(shortcutRestoreAcceptance, /isBlank\s*=\s*\(\$frame\.standardDeviation -lt 5 -or \$frame\.darkRatio -lt 0\.005\)/);
  assert.match(shortcutRestoreAcceptance, /earlyFrameTimeline = \$earlyFrameTimeline/);
});

test("shortcut repair resolves PowerShell without relying on a populated WINDIR", () => {
  assert.match(repairScript, /\[Environment\]::SystemDirectory/);
  assert.doesNotMatch(repairScript, /\$env:WINDIR/);
});

test("interactive restore shortcuts prefer the stable PowerShell 7 alias with a Windows PowerShell fallback", () => {
  for (const source of [repairScript, syncReadiness]) {
    assert.match(source, /Microsoft[\\/]WindowsApps[\\/]pwsh\.exe/);
    assert.match(source, /Test-Path\s+-LiteralPath\s+\$interactivePowerShellCandidate/);
    assert.match(source, /\$interactivePowerShell\s*=\s*\$powershell/);
    assert.match(source, /expectedTarget\s*=\s*if \(\$UseLaunchTask\) \{ \$interactivePowerShell \} else \{ \$powershell \}/);
  }
});

test("interactive Anti-Codex shortcuts use a short focus broker before the isolated launch task", () => {
  const mainSpecs = repairScript.match(/\$shortcutSpecs\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  const launchTaskEvidence = repairScript.match(/function Get-AntiCodexLaunchTaskEvidence[\s\S]*?\n\}/)?.[0] ?? "";
  const launchTaskRegistration = repairScript.match(/function Set-AntiCodexLaunchTask[\s\S]*?return Get-AntiCodexLaunchTaskEvidence\s*\n\}/)?.[0] ?? "";
  const interactiveSpecs = mainSpecs.split(/\r?\n/).filter((entry) => /-UseLaunchTask\b/.test(entry));
  assert.equal(interactiveSpecs.length, 2);
  assert.ok(interactiveSpecs.every((entry) => /-UseLaunchTask\b/.test(entry)));
  assert.doesNotMatch(mainSpecs, /KeepLauncherAlive|Anti-Codex Launcher\.exe/);
  assert.doesNotMatch(repairScript, /Register-ScheduledTask/);
  assert.match(repairScript, /Schedule\.Service/);
  assert.equal([...repairScript.matchAll(/New-Object -ComObject "Schedule\.Service"/g)].length, 1);
  assert.match(repairScript, /\$script:antiCodexScheduleService/);
  assert.doesNotMatch(repairScript, /Get-ScheduledTask/);
  assert.match(repairScript, /\/Create[\s\S]*\/XML[\s\S]*\/F/);
  assert.match(repairScript, /Remove-Item -LiteralPath \$taskXmlPath -Force/);
  assert.match(repairScript, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(repairScript, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(launchTaskRegistration, /<Priority>4<\/Priority>/);
  assert.match(repairScript, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.doesNotMatch(launchTaskRegistration, /<RestartOnFailure>/);
  assert.match(launchTaskEvidence, /\$definition\.Settings\.Priority\s+-eq\s+4/);
  assert.match(launchTaskEvidence, /\$definition\.Settings\.RestartCount\s+-eq\s+0/);
  assert.doesNotMatch(launchTaskEvidence, /RestartInterval\s+-eq\s+"PT1M"/);
  assert.match(repairScript, /\$definition\.Triggers\.Count\s+-eq\s+0/);
  assert.match(repairScript, /\$definition\.Settings\.AllowDemandStart/);
  assert.match(repairScript, /<Command>\$nodeXml<\/Command>/);
  assert.match(repairScript, /\$launchTaskActionArguments\s*=\s*"`"\$launchTaskScript`" --hide-console"/);
  assert.doesNotMatch(repairScript, /New-ScheduledTaskAction/);
  assert.match(repairScript, /\$shortcut\.TargetPath\s*=\s*\[string\]\$Spec\.expectedTarget/);
  assert.match(repairScript, /schtasks\.exe/);
  assert.match(repairScript, /Schedule\.Service/);
  assert.doesNotMatch(repairScript, /\.Run\(`\$null\)/);
  assert.match(shortcutBroker, /Start-ScheduledTask\s+-TaskName\s+"Anti-Codex Launcher"/);
  assert.doesNotMatch(repairScript, /Start-ScheduledTask -TaskName/);
  assert.match(repairScript, /-WindowStyle Hidden/);
  assert.doesNotMatch(repairScript, /\/Run \/TN/);
  assert.match(repairScript, /expectedArguments/);
  assert.match(launchTask, /start-anticodex-fixed-route\.mjs/);
  assert.match(launchTask, /spawn\(process\.execPath, plan\.supervisorArgs/);
  assert.doesNotMatch(launchTaskRegistration, /<Command>\$powershell/);
  assert.match(launchTask, /hide-anticodex-console\.ps1/);
  assert.match(launchTask, /spawnSync\(powershell/);
  assert.match(consoleHideScript, /AttachConsole/);
  assert.match(consoleHideScript, /ShowWindow/);
  assert.match(repairScript, /start-anticodex-shortcut-broker\.ps1/);
  assert.match(repairScript, /mode = "shortcut-focus-broker"/);
});

test("launch and Manager update tasks never retry failed product operations", () => {
  const launchTaskEvidence = repairScript.match(/function Get-AntiCodexLaunchTaskEvidence[\s\S]*?\n\}/)?.[0] ?? "";
  const updateTaskEvidence = repairScript.match(/function Get-AntiCodexUpdateTaskEvidence[\s\S]*?\n\}/)?.[0] ?? "";
  const updateTaskRegistration = repairScript.match(/function Set-AntiCodexUpdateTask[\s\S]*?return Get-AntiCodexUpdateTaskEvidence\s*\n\}/)?.[0] ?? "";
  const requiredTargets = repairScript.match(/\$failures\s*=\s*New-Object[\s\S]*?foreach \(\$path in @\(([^)]*)\)\) \{/)?.[1] ?? "";
  const readinessLaunchTaskEvidence = syncReadiness.match(/function Get-AntiCodexLaunchTaskEvidence[\s\S]*?\n\}/)?.[0] ?? "";
  const readinessUpdateTaskEvidence = syncReadiness.match(/function Get-AntiCodexUpdateTaskEvidence[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(repairScript, /\$updateTaskName\s*=\s*"Anti-Codex Updater"/);
  assert.match(updateTaskRegistration, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.doesNotMatch(updateTaskRegistration, /<RestartOnFailure>/);
  assert.match(updateTaskRegistration, /<Command>\$nodeXml<\/Command>/);
  assert.match(updateTaskRegistration, /expectedScript\s*=\s*\$updateTaskScript/);
  assert.match(requiredTargets, /\$updateTaskScript/);
  assert.match(repairScript, /\$updateTaskActionArguments\s*=\s*"`"\$updateTaskScript`" --hide-console"/);
  assert.match(launchTaskEvidence, /\$task\.Enabled/);
  assert.match(updateTaskEvidence, /\$task\.Enabled/);
  assert.match(launchTaskEvidence, /\$definition\.Settings\.RestartCount\s+-eq\s+0/);
  assert.match(updateTaskEvidence, /\$definition\.Settings\.RestartCount\s+-eq\s+0/);
  assert.match(updateTaskEvidence, /\[string\]\$definition\.Settings\.ExecutionTimeLimit\s+-eq\s+"PT0S"/);
  assert.match(updateTaskEvidence, /\$definition\.Triggers\.Count\s+-eq\s+0/);
  assert.match(updateTaskEvidence, /\$definition\.Settings\.AllowDemandStart/);
  assert.match(launchTaskEvidence, /if \(\$action\) \{ \[string\]\$action\.Arguments \} else \{ "" \}/);
  assert.match(updateTaskEvidence, /if \(\$action\) \{ \[string\]\$action\.Arguments \} else \{ "" \}/);
  assert.match(repairScript, /function Get-AntiCodexUpdateTaskEvidence/);
  assert.match(repairScript, /function Set-AntiCodexUpdateTask/);
  assert.match(syncReadiness, /\$updateTaskName\s*=\s*"Anti-Codex Updater"/);
  assert.match(syncReadiness, /function Get-AntiCodexUpdateTaskEvidence/);
  assert.match(readinessLaunchTaskEvidence, /\$task\.Enabled/);
  assert.match(readinessUpdateTaskEvidence, /\$task\.Enabled/);
  assert.match(readinessLaunchTaskEvidence, /\$definition\.Settings\.RestartCount\s+-eq\s+0/);
  assert.match(readinessLaunchTaskEvidence, /\$definition\.Settings\.Priority\s+-eq\s+4/);
  assert.match(readinessUpdateTaskEvidence, /\$definition\.Settings\.RestartCount\s+-eq\s+0/);
  assert.match(readinessUpdateTaskEvidence, /\[string\]\$definition\.Settings\.ExecutionTimeLimit\s+-eq\s+"PT0S"/);
  assert.match(productSync, /\[int\]\$definition\.Settings\.RestartCount\s+-ne\s+0/);
  assert.doesNotMatch(productSync, /RestartInterval\s+-ne\s+"PT1M"/);
  assert.match(productRollback, /\[int\]\$definition\.Settings\.RestartCount\s+-eq\s+0/);
  assert.doesNotMatch(productRollback, /RestartInterval\s+-eq\s+"PT1M"/);
});

test("interactive startup rejects only a verified Codex-owned parent chain", () => {
  assert.match(startScript, /IsProcessInJob\(GetCurrentProcess\(\), IntPtr\.Zero, out result\)/);
  assert.match(startScript, /Get-CimInstance Win32_Process/);
  assert.match(startScript, /OpenAI\\\.Codex_/);
  assert.match(startScript, /\$processName -ieq "codex\.exe"/);
  assert.match(startScript, /\$inspectedAncestorCount\s*=\s*0/);
  assert.match(startScript, /if \(\$lookupFailed -and \$inspectedAncestorCount -eq 0\)[\s\S]*IsCurrentProcessInJob/);
  assert.match(startScript, /if \(Test-AntiCodexManagedLaunchBoundary\)/);
  assert.doesNotMatch(startScript, /-not \$InlineSupervisor -and \(Test-AntiCodexManagedLaunchBoundary\)/);
  assert.match(startScript, /Use the Anti-Codex desktop shortcut so it cannot share Codex process ownership/);
});

test("shortcut refresh stages a unique link before replacing the visible entry", () => {
  assert.match(repairScript, /Get-AntiCodexShortcutEvidence -Spec \$Spec/);
  assert.match(repairScript, /if \(\$existingEvidence -and \$existingEvidence\.ok\) \{ return \$existingEvidence \}/);
  assert.match(repairScript, /\$pendingShortcut\s*=\s*Join-Path \$parent/);
  assert.match(repairScript, /\.pending\." \+ \[Guid\]::NewGuid\(\)\.ToString\("N"\)/);
  assert.match(repairScript, /\[IO\.File\]::Copy\(\$pendingShortcut, \$shortcutPath, \$true\)/);
  assert.match(repairScript, /for \(\$attempt = 0; \$attempt -lt 10/);
  assert.match(repairScript, /FinalReleaseComObject\(\$shortcut\)/);
});

test("sync readiness verifies the short focus broker and isolated launch task", () => {
  assert.doesNotMatch(syncReadiness, /ExpectedNativeLauncher|Anti-Codex Launcher\.exe/);
  assert.match(syncReadiness, /Schedule\.Service/);
  assert.equal([...syncReadiness.matchAll(/New-Object -ComObject "Schedule\.Service"/g)].length, 1);
  assert.match(syncReadiness, /\$script:antiCodexScheduleService/);
  assert.doesNotMatch(syncReadiness, /Get-ScheduledTask/);
  assert.doesNotMatch(syncReadiness, /\.Run\(`\$null\)/);
  assert.doesNotMatch(syncReadiness, /Start-ScheduledTask -TaskName/);
  assert.match(syncReadiness, /\$actualExecute\s+-ieq\s+\$node/);
  assert.match(syncReadiness, /expectedTarget = if \(\$UseLaunchTask\) \{ \$interactivePowerShell \} else \{ \$powershell \}/);
  assert.match(syncReadiness, /\$shortcutBrokerScript\s*=\s*Join-Path \$scriptsRoot "start-anticodex-shortcut-broker\.ps1"/);
  assert.match(syncReadiness, /launchMode = if \(\$UseLaunchTask\) \{ "shortcut-broker" \}/);
  assert.match(syncReadiness, /expectedLauncherTarget = \$ExpectedScript/);
  assert.match(syncReadiness, /expectedArguments/);
  assert.match(syncReadiness, /argumentsMatches/);
  assert.match(syncReadiness, /-InlineSupervisor/);
  assert.match(syncReadiness, /\$target -ieq \[string\]\$Spec\.expectedTarget/);
  assert.match(syncReadiness, /\$actualLauncherTarget\s+-ieq\s+\[string\]\$Spec\.expectedLauncherTarget/);
});
test("runtime sync removes the retired native bootstrap source", () => {
  const requiredList = runtimeSync.match(/\$requiredSourceFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  assert.doesNotMatch(requiredList, /AntiCodexLauncher\.cs/);
  const legacyList = runtimeSync.match(/\$legacyRuntimeFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  assert.match(legacyList, /scripts\\AntiCodexLauncher\.cs/);
  assert.match(legacyList, /scripts\\start-anticodex-task-hidden\.vbs/);
  assert.match(legacyList, /scripts\\start-anticodex-task-hidden\.ps1/);
  assert.match(requiredList, /scripts\\repair-anticodex-shortcuts\.ps1/);
  assert.match(requiredList, /scripts\\sync-anticodex-launcher\.ps1/);
  assert.match(requiredList, /scripts\\hide-anticodex-console\.ps1/);
  assert.match(requiredList, /scripts\\start-anticodex-task\.mjs/);
  assert.match(requiredList, /scripts\\start-anticodex-shortcut-broker\.ps1/);
  assert.match(requiredList, /scripts\\start-anticodex-update-task\.mjs/);
});

test("install and runtime sync both rebuild shortcuts through the canonical repair script", () => {
  assert.match(installer, /repair-anticodex-shortcuts\.ps1/);
  assert.match(installer, /hide-anticodex-console\.ps1/);
  assert.match(runtimeSync, /repair-anticodex-shortcuts\.ps1/);
  assert.match(runtimeSync, /shortcutRepairResult\.ok/);

  const installShortcutBlock = installer.match(/if \(-not \$HostOnly\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(installShortcutBlock, /CreateShortcut/);
  assert.doesNotMatch(installShortcutBlock, /TargetPath\s*=\s*\$powershell/);
});

function extractPowerShellStringArray(source, variableName) {
  const marker = `$${variableName} = @(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${variableName}`);
  const close = source.indexOf("\n)", start);
  assert.notEqual(close, -1, `missing ${variableName} close`);
  return [...source.slice(start, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("shortcut repair searches known Codex and DeepCodex residual shortcut names", () => {
  const names = extractPowerShellStringArray(repairScript, "residualShortcutNames");

  assert.ok(names.includes("Anti-Codex.lnk"));
  assert.ok(names.includes("Codex.lnk"));
  assert.ok(names.includes("Codex Desktop.lnk"));
  assert.ok(names.includes("DeepCodex.lnk"));
  assert.ok(names.includes("DeepCodex Desktop.lnk"));
  assert.ok(!names.includes("Sync Anti-Codex with Codex.lnk"));
  assert.ok(!names.includes("Rollback Anti-Codex.lnk"));
  assert.ok(!names.includes("Manage Anti-Codex.lnk"));
});

test("shortcut repair removes the unprotected root Start Menu Anti-Codex bypass only with ownership evidence", () => {
  assert.match(
    repairScript,
    /\[pscustomobject\]@\{ path = \$programs; location = "start-menu-root"; removeCodexByName = \$false \}/,
  );
  assert.match(repairScript, /"Anti-Codex\.lnk"/);
  assert.match(repairScript, /\[bool\]\$info\.ownedByAntiCodexOrDeepCodex/);
});

test("shortcut repair protects official Anti-Codex entries before deleting residual shortcuts", () => {
  const requiredEntries = [
    "Anti-Codex.lnk",
    "Sync Anti-Codex with Codex.lnk",
    "Rollback Anti-Codex.lnk",
    "Manage Anti-Codex.lnk",
  ];

  for (const entry of requiredEntries) {
    assert.ok(repairScript.includes(entry), `missing official shortcut entry ${entry}`);
  }
  assert.match(repairScript, /\$protectedShortcutPaths\[/);
  assert.match(repairScript, /\$protectedShortcutPaths\.ContainsKey\(\$pathKey\)/);

  const protectionCheck = repairScript.indexOf("$protectedShortcutPaths.ContainsKey($pathKey)");
  const deletion = repairScript.indexOf("Remove-Item -LiteralPath $path -Force");
  assert.ok(protectionCheck > 0, "missing protected shortcut guard");
  assert.ok(deletion > protectionCheck, "residual deletion must happen after protected shortcut guard");
});

test("shortcut repair reports any residual shortcut that cannot be removed safely", () => {
  assert.match(repairScript, /residualShortcutRoots/);
  assert.match(repairScript, /legacyDeepCodexStartMenuDir/);
  assert.match(repairScript, /Repair-AntiCodexResidualShortcuts/);
  assert.match(repairScript, /Residual shortcut requires manual review/);
  assert.match(repairScript, /Residual shortcut could not be removed/);
  assert.match(repairScript, /residualShortcutCount/);
  assert.match(repairScript, /removedResidualShortcutCount/);
  assert.match(repairScript, /reportedResidualShortcutCount/);
  assert.match(repairScript, /residualShortcuts/);
});

test("shortcut repair does not delete the user's normal desktop Codex shortcut by name alone", () => {
  const shouldRemoveIndex = repairScript.indexOf("$shouldRemove = (");
  assert.notEqual(shouldRemoveIndex, -1, "missing residual removal decision");
  const shouldRemoveBlock = repairScript.slice(shouldRemoveIndex, repairScript.indexOf(")", shouldRemoveIndex) + 1);

  assert.match(shouldRemoveBlock, /ownedByAntiCodexOrDeepCodex/);
  assert.match(shouldRemoveBlock, /removeCodexByName/);
  assert.match(shouldRemoveBlock, /isDeepCodexName/);
  assert.doesNotMatch(shouldRemoveBlock, /isCodexDesktopName/);
  assert.doesNotMatch(repairScript, /\$isCodexDesktopName\s*=/);
});

test("desktop Codex and Codex Desktop entries are not removed by name alone", () => {
  const desktopRoot = repairScript.match(
    /\[pscustomobject\]@\{ path = \$desktop; location = "desktop"; removeCodexByName = \$(true|false) \}/,
  );
  assert.ok(desktopRoot, "missing desktop residual shortcut root");
  assert.equal(desktopRoot[1], "false");

  assert.doesNotMatch(
    repairScript,
    /\$isCodexDesktopName\s*=\s*[\s\S]*?\$shouldRemove\s*=\s*\([\s\S]*?\$isCodexDesktopName[\s\S]*?\)/,
    "Codex Desktop shortcuts must require Anti-Codex or DeepCodex ownership evidence before removal",
  );
});

test("desktop residual ownership is based on shortcut target evidence, not its name or location", () => {
  const ownershipFunction = repairScript.match(
    /function Test-AntiCodexOwnedResidualShortcut \{[\s\S]*?\n\}/,
  );
  assert.ok(ownershipFunction, "missing ownership test helper");

  assert.doesNotMatch(ownershipFunction[0], /\[string\]\$ShortcutInfo\.path/);
  assert.doesNotMatch(ownershipFunction[0], /\[string\]\$ShortcutInfo\.displayName/);
  assert.match(ownershipFunction[0], /\[string\]\$ShortcutInfo\.actualTarget/);
  assert.match(ownershipFunction[0], /\[string\]\$ShortcutInfo\.actualArguments/);
  assert.match(ownershipFunction[0], /\[string\]\$ShortcutInfo\.actualLauncherTarget/);
});
