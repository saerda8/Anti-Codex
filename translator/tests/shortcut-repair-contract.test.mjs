import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const repairScript = readFileSync(resolve(root, "scripts", "repair-anticodex-shortcuts.ps1"), "utf8");
const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
const syncReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
const startScript = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
const launchTask = readFileSync(resolve(root, "scripts", "start-anticodex-task.mjs"), "utf8");
const consoleHideScript = readFileSync(resolve(root, "scripts", "hide-anticodex-console.ps1"), "utf8");

test("shortcut repair resolves PowerShell without relying on a populated WINDIR", () => {
  assert.match(repairScript, /\[Environment\]::SystemDirectory/);
  assert.doesNotMatch(repairScript, /\$env:WINDIR/);
});

test("interactive Anti-Codex shortcuts use an isolated Windows task broker", () => {
  const mainSpecs = repairScript.match(/\$shortcutSpecs\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  const interactiveSpecs = mainSpecs.split(/\r?\n/).filter((entry) => /-UseLaunchTask\b/.test(entry));
  assert.equal(interactiveSpecs.length, 2);
  assert.ok(interactiveSpecs.every((entry) => /-UseLaunchTask\b/.test(entry)));
  assert.doesNotMatch(mainSpecs, /KeepLauncherAlive|Anti-Codex Launcher\.exe/);
  assert.doesNotMatch(repairScript, /Register-ScheduledTask/);
  assert.match(repairScript, /\/Create[\s\S]*\/XML[\s\S]*\/F/);
  assert.match(repairScript, /Remove-Item -LiteralPath \$taskXmlPath -Force/);
  assert.match(repairScript, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(repairScript, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(repairScript, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(repairScript, /<RestartOnFailure>[\s\S]*?<Interval>PT1M<\/Interval>[\s\S]*?<Count>1<\/Count>[\s\S]*?<\/RestartOnFailure>/);
  assert.match(repairScript, /\$task\.Settings\.RestartCount\s+-eq\s+1/);
  assert.match(repairScript, /\[string\]\$task\.Settings\.RestartInterval\s+-eq\s+"PT1M"/);
  assert.match(repairScript, /<Command>\$nodeXml<\/Command>/);
  assert.match(repairScript, /\$launchTaskActionArguments\s*=\s*"`"\$launchTaskScript`" --hide-console"/);
  assert.doesNotMatch(repairScript, /New-ScheduledTaskAction/);
  assert.match(repairScript, /\$shortcut\.TargetPath\s*=\s*\[string\]\$Spec\.expectedTarget/);
  assert.match(repairScript, /schtasks\.exe/);
  assert.match(repairScript, /Start-ScheduledTask -TaskName/);
  assert.match(repairScript, /-WindowStyle Hidden/);
  assert.doesNotMatch(repairScript, /\/Run \/TN/);
  assert.match(repairScript, /expectedArguments/);
  assert.match(launchTask, /start-anticodex-fixed-route\.mjs/);
  assert.match(launchTask, /spawn\(process\.execPath, plan\.supervisorArgs/);
  assert.doesNotMatch(repairScript, /<Command>\$powershell/);
  assert.match(launchTask, /hide-anticodex-console\.ps1/);
  assert.match(launchTask, /spawnSync\(powershell/);
  assert.match(consoleHideScript, /AttachConsole/);
  assert.match(consoleHideScript, /ShowWindow/);
  assert.match(repairScript, /mode = "scheduled-task-broker"/);
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

test("sync readiness verifies the isolated task broker for interactive shortcuts", () => {
  assert.doesNotMatch(syncReadiness, /ExpectedNativeLauncher|Anti-Codex Launcher\.exe/);
  assert.match(syncReadiness, /Get-ScheduledTask/);
  assert.match(syncReadiness, /\$actualExecute\s+-ieq\s+\$node/);
  assert.match(syncReadiness, /expectedTarget = \$powershell/);
  assert.match(syncReadiness, /launchMode = if \(\$UseLaunchTask\) \{ "scheduled-task" \}/);
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
  assert.match(requiredList, /scripts\\hide-anticodex-console\.ps1/);
  assert.match(requiredList, /scripts\\start-anticodex-task\.mjs/);
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
