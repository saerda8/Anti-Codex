import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const scriptPath = resolve(root, "scripts", "clear-anticodex-conversations.ps1");
const source = readFileSync(scriptPath, "utf8");
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function functionSource(name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = source.indexOf("\nfunction ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function embeddedCSharp() {
  const start = source.indexOf("using System;");
  assert.notEqual(start, -1, "missing embedded C#");
  const end = source.indexOf("\n'@", start);
  assert.ok(end > start, "unterminated embedded C#");
  return source.slice(start, end);
}

function runPowerShellFixture(body) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "anticodex-clear-process-safety-"));
  const fixturePath = join(fixtureRoot, "fixture.ps1");
  try {
    writeFileSync(fixturePath, body, "utf8");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", fixturePath], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("conversation cleanup binds identity query and termination to one native process handle", () => {
  assert.match(source, /class VerifiedProcessHandle\s*:\s*IDisposable/);
  assert.match(source, /OpenProcess/);
  assert.match(source, /GetProcessTimes/);
  assert.match(source, /QueryFullProcessImageName/);
  assert.match(source, /TerminateProcess/);
  assert.match(source, /WaitForSingleObject/);
  assert.match(source, /CommandLineToArgvW/);
  assert.doesNotMatch(source, /\bStop-Process\b|\btaskkill(?:\.exe)?\b/i);

  const stop = functionSource("Stop-AntiCodexVerifiedProcess");
  const opened = stop.indexOf("[AntiCodex.Native.VerifiedProcessHandle]::Open($processId)");
  const terminated = stop.indexOf("$processHandle.TerminateAndWait(");
  assert.ok(opened >= 0, "stop must open the exact PID as a native process handle");
  assert.ok(terminated > opened, "the same bound handle must perform termination and wait");
  assert.match(stop, /CreationFileTimeUtcTicks/);
  assert.match(stop, /ExecutablePath/);
  assert.match(stop, /Test-AntiCodexNativeCodexPath/);
  assert.match(stop, /ExpectedScriptPath/);
  assert.match(stop, /Test-AntiCodexCommandLineHasExactPath/);
  assert.match(stop, /throw "Refusing to stop PID \$processId because its handle-bound identity changed\."/);
});

test("conversation cleanup clears nested thread references after moving rollout sessions", () => {
  assert.match(source, /\$conversationStatePropertyPattern\s*=\s*['\"]\^\(\?:thread-/);
  assert.match(source, /electron-persisted-atom-state/);
  assert.match(source, /codex-writing-block-deleted-thread-v1/);
  assert.match(source, /queued-follow-ups/);
  assert.match(source, /sidebar-project-thread-orders/);
  assert.match(source, /pinned-thread-ids/);
});

test("candidate ownership is strict and script hosts require an explicit canonical script path", () => {
  const candidates = functionSource("Get-AntiCodexProcesses");
  const ownership = functionSource("Get-AntiCodexProcessOwnership");
  const hostedScript = functionSource("Get-AntiCodexHostedScriptPath");
  assert.match(source, /function Test-AntiCodexCommandLineHasExactPath/);
  assert.match(source, /function Test-AntiCodexNativeCodexPath/);
  assert.match(source, /\$allowedScriptPaths\s*=\s*@\(/);
  for (const name of [
    "start-anticodex.ps1",
    "start-anticodex-fixed-route.mjs",
    "deepcodex-cdp-inject.mjs",
    "anticodex-manager-bridge.mjs",
  ]) {
    assert.match(source, new RegExp(name.replaceAll(".", "\\."), "i"));
  }
  assert.match(candidates, /Get-AntiCodexProcessSnapshot/);
  const preclassified = candidates.indexOf("Get-AntiCodexProcessOwnership");
  const opened = candidates.indexOf("Get-AntiCodexProcessSnapshot");
  assert.ok(preclassified >= 0 && opened > preclassified, "only strict preliminary candidates may request a terminating handle");
  assert.match(ownership, /Test-IsUnderPath/);
  assert.match(ownership, /Get-AntiCodexHostedScriptPath/);
  assert.doesNotMatch(ownership, /Test-AntiCodexCommandLineHasExactPath/);
  assert.match(hostedScript, /WindowsCommandLine\]::Parse/);
  assert.match(hostedScript, /node\.exe/);
  assert.match(hostedScript, /powershell\.exe/);
  assert.match(hostedScript, /pwsh\.exe/);
  assert.match(hostedScript, /-file/i);
  assert.match(ownership, /Test-AntiCodexNativeCodexPath/);
  assert.doesNotMatch(
    ownership,
    /IndexOf\(\$(?:StateRootFull|RuntimeRootFull)|AppData\\Roaming\\anticodex|AppData\\Local\\Anti-Codex/i,
  );
});

test("pure ownership fixture rejects prefix siblings directory mentions and WindowsApps Codex", () => {
  const fixture = runPowerShellFixture(`
$ErrorActionPreference = "Stop"
if (-not ("AntiCodex.Native.WindowsCommandLine" -as [type])) {
  Add-Type -TypeDefinition @'
${embeddedCSharp()}
'@
}
${functionSource("Normalize-Path")}
${functionSource("Test-IsUnderPath")}
${functionSource("Test-AntiCodexNativeCodexPath")}
${functionSource("Test-AntiCodexCommandLineHasExactPath")}
${functionSource("Get-AntiCodexHostedScriptPath")}
${functionSource("Get-AntiCodexProcessOwnership")}
$install = "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex"
$runtime = Join-Path $install "runtime"
$hostRoot = Join-Path $install "codex-patched-app"
$componentRoot = Join-Path $install "components"
$script = Join-Path $runtime "scripts\\start-anticodex-fixed-route.mjs"
$powerShellScript = Join-Path $runtime "scripts\\start-anticodex.ps1"
$allowedExecutables = @($hostRoot, $componentRoot)
$allowedScripts = @($script, $powerShellScript)
function Own([string]$exe, [string]$commandLine) {
  $value = Get-AntiCodexProcessOwnership -ExecutablePath $exe -CommandLine $commandLine -AllowedExecutableRoots $allowedExecutables -AllowedScriptPaths $allowedScripts
  if ($null -eq $value) { return $null }
  return [ordered]@{ kind = [string]$value.Kind; script = [string]$value.ExpectedScriptPath }
}
[ordered]@{
  exactExecutable = Own (Join-Path $hostRoot "Anti-Codex.exe") '"C:\\...\\Anti-Codex.exe"'
  executablePrefixSibling = Own (Join-Path ($hostRoot + "-evil") "Anti-Codex.exe") ""
  exactQuotedScript = Own "C:\\Program Files\\nodejs\\node.exe" ('node.exe "' + $script + '"')
  nodeFlagsBeforeScript = Own "C:\\Program Files\\nodejs\\node.exe" ('node.exe --no-warnings --require "C:\\helper.js" "' + $script + '"')
  nodeUnrelatedEntryWithAllowedDummy = Own "C:\\Program Files\\nodejs\\node.exe" ('node.exe "C:\\unrelated.js" "' + $script + '"')
  nodeEvalWithAllowedDummy = Own "C:\\Program Files\\nodejs\\node.exe" ('node.exe --eval "console.log(1)" "' + $script + '"')
  nodeCheckWithAllowedDummy = Own "C:\\Program Files\\nodejs\\node.exe" ('node.exe -c "C:\\unrelated.js" "' + $script + '"')
  powerShellFile = Own "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $powerShellScript + '"')
  powerShellCommandMention = Own "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ('powershell.exe -NoProfile -Command "Get-Content ''' + $powerShellScript + '''"')
  powerShellOrdinaryArgumentMention = Own "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ('powershell.exe -NoProfile "' + $powerShellScript + '"')
  scriptHostUnderRootWithoutExactScript = Own (Join-Path $hostRoot "node.exe") ('node.exe --note "' + $runtime + '"')
  directoryMentionOnly = Own "C:\\Program Files\\nodejs\\node.exe" ('node.exe --note "' + $runtime + '"')
  editorMentionExactScript = Own "C:\\Program Files\\Microsoft VS Code\\Code.exe" ('Code.exe "' + $script + '"')
  scriptPrefixSibling = Own "C:\\Program Files\\nodejs\\node.exe" ('node.exe "' + $script + '.evil"')
  nativeCodex = Own "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.0_x64__test\\Codex.exe" ('"' + $script + '"')
  nativeStoreChatGPT = Own "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_99.0_x64__test\\ChatGPT.exe" ('"' + $script + '"')
} | ConvertTo-Json -Depth 5 -Compress
`);

  assert.deepEqual(fixture.exactExecutable, { kind: "executable", script: "" });
  assert.equal(fixture.executablePrefixSibling, null);
  assert.deepEqual(fixture.exactQuotedScript, {
    kind: "script",
    script: "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex\\runtime\\scripts\\start-anticodex-fixed-route.mjs",
  });
  assert.deepEqual(fixture.nodeFlagsBeforeScript, {
    kind: "script",
    script: "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex\\runtime\\scripts\\start-anticodex-fixed-route.mjs",
  });
  assert.equal(fixture.nodeUnrelatedEntryWithAllowedDummy, null);
  assert.equal(fixture.nodeEvalWithAllowedDummy, null);
  assert.equal(fixture.nodeCheckWithAllowedDummy, null);
  assert.deepEqual(fixture.powerShellFile, {
    kind: "script",
    script: "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex\\runtime\\scripts\\start-anticodex.ps1",
  });
  assert.equal(fixture.powerShellCommandMention, null);
  assert.equal(fixture.powerShellOrdinaryArgumentMention, null);
  assert.equal(fixture.scriptHostUnderRootWithoutExactScript, null);
  assert.equal(fixture.directoryMentionOnly, null);
  assert.equal(fixture.editorMentionExactScript, null);
  assert.equal(fixture.scriptPrefixSibling, null);
  assert.equal(fixture.nativeCodex, null);
  assert.equal(fixture.nativeStoreChatGPT, null);
});

test("candidate snapshots carry immutable identity evidence into fail-closed termination", () => {
  const snapshot = functionSource("Get-AntiCodexProcessSnapshot");
  const stop = functionSource("Stop-AntiCodexVerifiedProcess");
  assert.match(snapshot, /\[AntiCodex\.Native\.VerifiedProcessHandle\]::Open\(\$ProcessId\)/);
  assert.match(snapshot, /CreationFileTimeUtcTicks/);
  assert.match(snapshot, /ExecutablePath/);
  assert.match(snapshot, /OwnershipKind/);
  assert.match(snapshot, /ExpectedScriptPath/);
  assert.match(snapshot, /NativeErrorCode -in @\(87, 1168\)/);
  assert.match(snapshot, /throw "Could not bind strict Anti-Codex candidate PID \$ProcessId/);
  assert.match(stop, /\[long\]\$Snapshot\.CreationFileTimeUtcTicks/);
  assert.match(stop, /\[string\]\$Snapshot\.ExecutablePath/);
  assert.match(stop, /\[string\]\$Snapshot\.OwnershipKind/);
  assert.match(stop, /\[string\]\$Snapshot\.ExpectedScriptPath/);
  assert.match(stop, /if \(\$processHandle\.HasExited\) \{ return \$true \}/);
  assert.match(stop, /\$processHandle\.TerminateAndWait\(\$timeoutMilliseconds\)/);
  assert.doesNotMatch(stop, /catch\s*\{\s*\}/);
});
