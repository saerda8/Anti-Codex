import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const names = [
  "sync-anticodex-runtime.ps1",
  "apply-anticodex-upstream.ps1",
  "start-anticodex.ps1",
  "rollback-anticodex.ps1",
  "sync-anticodex.ps1",
  "refresh-anticodex-models.ps1",
];
const scripts = Object.fromEntries(names.map((name) => [
  name,
  readFileSync(resolve(root, "scripts", name), "utf8"),
]));
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

function extractTypeDefinition(source, typeName) {
  const guard = source.indexOf(`if (-not ("${typeName}" -as [type]))`);
  assert.ok(guard >= 0, `missing ${typeName} guard`);
  const marker = "Add-Type -TypeDefinition @'";
  const markerIndex = source.indexOf(marker, guard);
  assert.ok(markerIndex >= 0, `missing ${typeName} Add-Type`);
  const start = source.indexOf("\n", markerIndex + marker.length) + 1;
  const end = source.indexOf("\n'@", start);
  assert.ok(start > 0 && end > start, `unterminated ${typeName} Add-Type`);
  return source.slice(start, end);
}

function runPowerShellFixture(body) {
  const encoded = Buffer.from(body, "utf16le").toString("base64");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

test("maintenance scripts never use taskkill trees or silently ignore forced-stop failures", () => {
  for (const [name, source] of Object.entries(scripts)) {
    assert.doesNotMatch(source, /\btaskkill(?:\.exe)?\b/i, `${name} must not delegate termination to taskkill`);
    assert.doesNotMatch(source, /Stop-Process[^\r\n]*-ErrorAction\s+SilentlyContinue/i, `${name} must not hide Stop-Process failure`);
    assert.doesNotMatch(source, /\/(?:IM|T)\b/i, `${name} must not use name or tree termination`);
  }
});

test("Gate 1 candidate cleanup is graceful-first and revalidates exact PID identity before force", () => {
  const source = readFileSync(resolve(root, "scripts", "test-codexplusplus-runtime-isolation.ps1"), "utf8");
  const cleanup = extractFunction(source, "Stop-TestProcesses");
  const verifiedStop = extractFunction(source, "Stop-TestProcessVerified");
  assert.match(cleanup, /CloseMainWindow\(\)/);
  assert.match(cleanup, /Stop-TestProcessVerified/);
  assert.doesNotMatch(cleanup, /Stop-Process[\s\S]*SilentlyContinue/i);
  assert.match(verifiedStop, /Get-CimInstance\s+Win32_Process\s+-Filter\s+"ProcessId=\$ProcessId"/);
  assert.match(verifiedStop, /CreationDate/);
  assert.match(verifiedStop, /CreatedMicrosecondTicks/);
  assert.doesNotMatch(verifiedStop, /TotalMilliseconds\)\s+-gt\s+1/);
  assert.match(verifiedStop, /ExecutablePath/);
  assert.match(verifiedStop, /Test-PathUnderRoot/);
  assert.match(verifiedStop, /Stop-Process\s+-Id\s+\$ProcessId\s+-Force\s+-ErrorAction\s+Stop/);
});

test("prefix siblings and native WindowsApps Codex fail the isolation guards", () => {
  for (const [name, source] of Object.entries(scripts)) {
    const containment = extractFunction(source, "Test-AntiCodexPathInsideRoot");
    const nativeGuard = extractFunction(source, "Test-AntiCodexNativeCodexPath");
    assert.match(containment, /TrimEnd\("\\"\)\s*\+\s*"\\"/, `${name} must append a separator before prefix comparison`);
    assert.match(containment, /StartsWith\(\$rootPrefix,\s*\[StringComparison\]::OrdinalIgnoreCase\)/);
    assert.match(nativeGuard, /\\WindowsApps\\OpenAI\.Codex_/i, `${name} must explicitly reject native Codex`);
  }
});

test("launcher liveness uses parsed PowerShell -File semantics instead of path mentions", () => {
  for (const name of ["rollback-anticodex.ps1", "refresh-anticodex-models.ps1"]) {
    const source = scripts[name];
    const predicate = extractFunction(source, "Test-AntiCodexPowerShellFileInvocation");
    const launchers = extractFunction(source, "Get-AntiCodexLaunchers");
    assert.match(source, /CommandLineToArgvW/);
    assert.match(predicate, /\[AntiCodex\.Native\.WindowsCommandLine\]::Parse\(\$CommandLine\)/);
    assert.match(predicate, /"-file", "-f"/);
    assert.match(predicate, /"-command", "-c", "-encodedcommand", "-e", "-ec"/);
    assert.match(predicate, /\$actualScript\.Equals\(\$expectedScript/);
    assert.match(launchers, /Test-AntiCodexPowerShellFileInvocation/);
    assert.doesNotMatch(launchers, /\[regex\]|-match|IndexOf|Contains/);
  }
});

test("host and component stops bind identity and termination to one Windows process handle", () => {
  for (const name of ["rollback-anticodex.ps1", "refresh-anticodex-models.ps1"]) {
    const source = scripts[name];
    const stop = extractFunction(source, "Stop-AntiCodexVerifiedProcess");
    assert.match(source, /class VerifiedProcessHandle/);
    assert.match(source, /OpenProcess/);
    assert.match(source, /GetProcessTimes/);
    assert.match(source, /QueryFullProcessImageName/);
    assert.match(source, /TerminateProcess/);
    assert.match(source, /WaitForSingleObject/);
    assert.match(stop, /\[AntiCodex\.Native\.VerifiedProcessHandle\]::Open\(\$processId\)/);
    assert.match(stop, /CreationFileTimeUtcTicks/);
    assert.match(stop, /ExecutablePath/);
    assert.match(stop, /Test-AntiCodexPathInsideRoot/);
    assert.match(stop, /Test-AntiCodexNativeCodexPath/);
    assert.match(stop, /\.TerminateAndWait\(3000\)/);
    assert.doesNotMatch(stop, /Stop-Process|Get-CimInstance/);
    assert.match(stop, /throw/);
    const opened = stop.indexOf("[AntiCodex.Native.VerifiedProcessHandle]::Open($processId)");
    const terminated = stop.indexOf("$processHandle.TerminateAndWait(3000)");
    assert.ok(opened >= 0 && terminated > opened, `${name} must hold one handle from identity query through termination`);
  }
});

test("script-hosted supervisor stops hold one handle while checking exact script identity", () => {
  for (const name of ["sync-anticodex-runtime.ps1", "apply-anticodex-upstream.ps1"]) {
    const source = scripts[name];
    const stop = extractFunction(source, "Stop-AntiCodexVerifiedScriptProcess");
    assert.match(source, /class VerifiedProcessHandle/);
    assert.match(source, /OpenProcess/);
    assert.match(source, /GetProcessTimes/);
    assert.match(source, /QueryFullProcessImageName/);
    assert.match(source, /TerminateProcess/);
    assert.match(source, /WaitForSingleObject/);
    assert.match(stop, /\[AntiCodex\.Native\.VerifiedProcessHandle\]::Open\(\$processId\)/);
    assert.match(stop, /Get-CimInstance\s+Win32_Process\s+-Filter\s+"ProcessId = \$processId"/);
    assert.match(stop, /CreationFileTimeUtcTicks/);
    assert.match(stop, /ExecutablePath/);
    assert.match(stop, /ExpectedScriptPath/);
    assert.match(stop, /AllowedScriptRoot/);
    assert.match(stop, /Test-AntiCodexPathInsideRoot/);
    assert.match(stop, /Test-AntiCodexNativeCodexPath/);
    if (name === "apply-anticodex-upstream.ps1") {
      assert.match(source, /CommandLineToArgvW/);
      assert.match(stop, /Test-AntiCodexFixedRouteInvocation/);
      assert.match(stop, /ExpectedStateRoot/);
      assert.match(stop, /Get-AntiCodexTrustedNodeExecutablePaths/);
    } else {
      assert.match(stop, /Test-AntiCodexCommandLineHasExactPath/);
    }
    assert.match(stop, /\.TerminateAndWait\(3000\)/);
    assert.doesNotMatch(stop, /Stop-Process/);
    const opened = stop.indexOf("[AntiCodex.Native.VerifiedProcessHandle]::Open($processId)");
    const commandLineCheck = stop.indexOf("Get-CimInstance Win32_Process", opened);
    const terminated = stop.indexOf("$processHandle.TerminateAndWait(3000)");
    assert.ok(
      opened >= 0 && commandLineCheck > opened && terminated > commandLineCheck,
      `${name} must verify the exact script command line while the terminating handle is held`,
    );
  }
});

test("fixed-route invocation rejects dummy mentions wrong Node and ambiguous state roots", () => {
  const source = scripts["apply-anticodex-upstream.ps1"];
  const invocation = extractFunction(source, "Test-AntiCodexFixedRouteInvocation");
  const trustedNodes = extractFunction(source, "Get-AntiCodexTrustedNodeExecutablePaths");
  assert.match(invocation, /\[string\]\$arguments\[1\]/);
  assert.match(invocation, /\$token -ceq "--state-root"/);
  assert.match(invocation, /\$stateRootValues\.Count -ne 1/);
  assert.match(invocation, /\$commandExecutable\.Equals\(\$liveExecutable/);
  assert.match(invocation, /TrustedNodeExecutablePaths/);
  assert.match(trustedNodes, /Get-Command \$name -All -CommandType Application/);
  assert.doesNotMatch(source, /function Test-AntiCodexCommandLineHasExactPath/);
  const fixture = runPowerShellFixture(`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
${extractTypeDefinition(source, "AntiCodex.Native.WindowsCommandLine")}
'@
${extractFunction(source, "Test-AntiCodexNativeCodexPath")}
${extractFunction(source, "Test-AntiCodexFixedRouteInvocation")}
$node = "C:\\Program Files\\nodejs\\node.exe"
$otherNode = "C:\\Tools\\node.exe"
$script = "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex\\runtime\\scripts\\start-anticodex-fixed-route.mjs"
$otherScript = "C:\\temp\\unrelated.mjs"
$state = "C:\\Users\\fixture\\AppData\\Roaming\\anticodex"
function Match([string]$CommandLine, [string]$LiveNode = $node, [string[]]$TrustedNodes = @($node)) {
    return [bool](Test-AntiCodexFixedRouteInvocation -CommandLine $CommandLine -LiveExecutablePath $LiveNode -ExpectedScriptPath $script -ExpectedStateRoot $state -TrustedNodeExecutablePaths $TrustedNodes)
}
[ordered]@{
    exact = Match ('"' + $node + '" "' + $script + '" --install-root "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex" --state-root "' + $state + '" --provider antigravity --model gemini')
    unrelatedEntryDummyScript = Match ('"' + $node + '" "' + $otherScript + '" --state-root "' + $state + '" --model "' + $script + '"')
    missingModelValueDummyState = Match ('"' + $node + '" "' + $script + '" --model --state-root "' + $state + '"')
    duplicateStateRoot = Match ('"' + $node + '" "' + $script + '" --state-root "' + $state + '" --state-root "' + $state + '"')
    wrongStateRoot = Match ('"' + $node + '" "' + $script + '" --state-root "C:\\temp\\other-state"')
    untrustedNode = Match ('"' + $otherNode + '" "' + $script + '" --state-root "' + $state + '"') $otherNode @($node)
    argvZeroMismatch = Match ('"' + $otherNode + '" "' + $script + '" --state-root "' + $state + '"') $node @($node, $otherNode)
    nativeCodexNode = Match ('"C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.0_x64__test\\node.exe" "' + $script + '" --state-root "' + $state + '"') "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.0_x64__test\\node.exe" @("C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.0_x64__test\\node.exe")
} | ConvertTo-Json -Compress
`);
  assert.deepEqual(fixture, {
    exact: true,
    unrelatedEntryDummyScript: false,
    missingModelValueDummyState: false,
    duplicateStateRoot: false,
    wrongStateRoot: false,
    untrustedNode: false,
    argvZeroMismatch: false,
    nativeCodexNode: false,
  });
});

test("launcher invocation rejects command strings ordinary mentions and prefix siblings", () => {
  const source = scripts["rollback-anticodex.ps1"];
  const fixture = runPowerShellFixture(`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
${extractTypeDefinition(source, "AntiCodex.Native.WindowsCommandLine")}
'@
${extractFunction(source, "Test-AntiCodexNativeCodexPath")}
${extractFunction(source, "Test-AntiCodexPowerShellFileInvocation")}
$powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
$script = "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex\\runtime\\scripts\\start-anticodex.ps1"
function Match([string]$CommandLine, [string]$LiveExecutable = $powershell) {
    return [bool](Test-AntiCodexPowerShellFileInvocation -CommandLine $CommandLine -LiveExecutablePath $LiveExecutable -ExpectedScriptPath $script)
}
[ordered]@{
    exactFile = Match ('"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"')
    exactShortFile = Match ('"' + $powershell + '" -NoProfile -f "' + $script + '"')
    commandMention = Match ('"' + $powershell + '" -NoProfile -Command "Get-Content ''' + $script + '''"')
    ordinaryMention = Match ('"' + $powershell + '" -NoProfile "' + $script + '"')
    encodedThenFile = Match ('"' + $powershell + '" -EncodedCommand ZgBvAG8A -File "' + $script + '"')
    prefixSibling = Match ('"' + $powershell + '" -File "' + $script + '.evil"')
    argvZeroMismatch = Match ('"C:\\temp\\powershell.exe" -File "' + $script + '"')
    wrongHost = Match ('"C:\\Program Files\\nodejs\\node.exe" -File "' + $script + '"') "C:\\Program Files\\nodejs\\node.exe"
} | ConvertTo-Json -Compress
`);
  assert.deepEqual(fixture, {
    exactFile: true,
    exactShortFile: true,
    commandMention: false,
    ordinaryMention: false,
    encodedThenFile: false,
    prefixSibling: false,
    argvZeroMismatch: false,
    wrongHost: false,
  });
});

test("PID reuse or executable-path changes abort without expanding the target", () => {
  const directNames = ["rollback-anticodex.ps1", "refresh-anticodex-models.ps1"];
  const scriptNames = ["sync-anticodex-runtime.ps1", "apply-anticodex-upstream.ps1"];
  for (const name of directNames) {
    const stop = extractFunction(scripts[name], "Stop-AntiCodexVerifiedProcess");
    assert.match(stop, /CreationFileTimeUtcTicks\s+-ne\s+\$expectedCreationFileTimeUtcTicks/);
    assert.match(stop, /\$liveExecutablePath\.Equals\(\$expectedExecutablePath/);
    assert.match(stop, /handle-bound creation time or executable path changed/);
    assert.match(stop, /no broader target was attempted/);
  }
  for (const name of scriptNames) {
    const stop = extractFunction(scripts[name], "Stop-AntiCodexVerifiedScriptProcess");
    assert.match(stop, /CreationFileTimeUtcTicks\s+-ne\s+\$expectedCreationFileTimeUtcTicks/);
    assert.match(stop, /\$liveExecutablePath\.Equals\(\$expectedExecutablePath/);
    assert.match(stop, /handle-bound creation time or executable path changed/);
    assert.match(stop, /no descendants were targeted/);
  }
});

test("NoRestart host sync refuses a live release without stopping its task or processes", () => {
  const sync = scripts["sync-anticodex.ps1"];
  assert.match(sync, /if \(\$NoRestart\) \{[\s\S]*?Assert-AntiCodexNoRunningReleaseProcesses[\s\S]*?\}\s*else\s*\{[\s\S]*?Stop-AntiCodexLaunchTaskForMaintenance/);

  const runtime = scripts["sync-anticodex-runtime.ps1"];
  const stopCall = runtime.lastIndexOf("Stop-AntiCodexFixedRouteSupervisor");
  const restartGuard = runtime.lastIndexOf("if (-not $NoRestart)", stopCall);
  assert.ok(stopCall > restartGuard && restartGuard >= 0, "runtime termination must remain under the restart guard");
  assert.doesNotMatch(extractFunction(runtime, "Test-AntiCodexJavaScriptSyntax"), /Stop-Process|taskkill/i);
});

test("route-switch fallback never expands from a failed supervisor stop to stale descendants", () => {
  const apply = scripts["apply-anticodex-upstream.ps1"];
  assert.doesNotMatch(apply, /Get-DescendantProcessRows|remainingDescendantPids/);
  assert.doesNotMatch(apply, /Stop-ProcessByIdVerified/);
  assert.match(apply, /Stop-AntiCodexVerifiedScriptProcess[\s\S]{0,160}-Snapshot\s+\$supervisor/);
});

test("fixed-route cleanup revalidates owned identities and never uses a name or tree kill", () => {
  const source = readFileSync(resolve(root, "scripts", "start-anticodex-fixed-route.mjs"), "utf8");
  assert.doesNotMatch(source, /taskkill(?:\.exe)?/i);
  assert.match(source, /revalidatedOwnedClientPids/);
  assert.match(source, /createdAtMs/);
  assert.match(source, /creationFileTimeUtcTicks/);
  assert.match(source, /expectedExecutablePath/);
  assert.match(source, /parentProcessId/);
  const startupStart = source.indexOf("const spawnCopiedClient =");
  const startupEnd = source.indexOf("let clientMissingSince", startupStart);
  assert.ok(startupStart >= 0, "missing current spawnCopiedClient implementation");
  assert.ok(startupEnd > startupStart, "could not bound current copied-client startup implementation");
  const startup = source.slice(startupStart, startupEnd);
  assert.doesNotMatch(startup, /for \(const row of clients\) ownedClients\.add\(row\.processId\)/);
  assert.match(source, /function stopOwnedProcess\([\s\S]*?stopExactProcess/);
  const stopExact = source.slice(
    source.indexOf("export function stopExactProcess"),
    source.indexOf("export async function waitForOwnedProcessExit"),
  );
  assert.match(stopExact, /terminateExactWindowsProcessWithHandle/);
  assert.doesNotMatch(stopExact, /process\.kill|child\.kill|scanClientProcessTableSafely/);
  assert.match(source, /exactProcessIdentityMatches/);
  assert.match(source, /OpenProcess/);
  assert.match(source, /GetProcessTimes/);
  assert.match(source, /QueryFullProcessImageName/);
  assert.match(source, /TerminateProcess/);
  assert.match(source, /WaitForSingleObject/);
  assert.doesNotMatch(source, /Get-CimInstance Win32_Process/);
  assert.match(source, /Get-Process -Name ["']Anti-Codex["']/);
  assert.match(source, /NtQueryInformationProcess/);
  assert.match(source, /InheritedFromUniqueProcessId/);
  assert.match(source, /GetProcessTimes/);
  assert.match(source, /ANTICODEX_SCAN_SEED_PIDS/);
  assert.match(source, /getClientProcessTableRows\(\[processId\]\)/);
});

test("all maintenance force-stops query identity and terminate through the same Windows handle", () => {
  const contracts = [
    ["start-anticodex.ps1", "Stop-AntiCodexVerifiedScriptProcess", true],
    ["sync-anticodex-runtime.ps1", "Stop-AntiCodexVerifiedScriptProcess", true],
    ["apply-anticodex-upstream.ps1", "Stop-AntiCodexVerifiedScriptProcess", true],
    ["sync-anticodex.ps1", "Stop-AntiCodexVerifiedProcess", false],
    ["rollback-anticodex.ps1", "Stop-AntiCodexVerifiedProcess", false],
    ["refresh-anticodex-models.ps1", "Stop-AntiCodexVerifiedProcess", false],
  ];
  for (const [name, functionName, checksScriptCommandLine] of contracts) {
    const source = scripts[name];
    const stop = extractFunction(source, functionName);
    assert.match(source, /class VerifiedProcessHandle/);
    assert.match(source, /OpenProcess/);
    assert.match(source, /GetProcessTimes/);
    assert.match(source, /QueryFullProcessImageName/);
    assert.match(source, /TerminateProcess/);
    assert.match(source, /WaitForSingleObject/);
    assert.match(stop, /\[AntiCodex\.Native\.VerifiedProcessHandle\]::Open\(\$processId\)/);
    assert.match(stop, /CreationFileTimeUtcTicks/);
    assert.match(stop, /\.TerminateAndWait\(3000\)/);
    assert.doesNotMatch(stop, /Stop-Process/);
    const opened = stop.indexOf("[AntiCodex.Native.VerifiedProcessHandle]::Open($processId)");
    const terminated = stop.indexOf("$processHandle.TerminateAndWait(3000)");
    assert.ok(opened >= 0 && terminated > opened, `${name} must hold one handle from identity query through termination`);
    if (checksScriptCommandLine) {
      const commandLineCheck = stop.indexOf("Get-CimInstance Win32_Process", opened);
      assert.ok(
        commandLineCheck > opened && commandLineCheck < terminated,
        "script command-line evidence must be read only while the exact process handle is held",
      );
    }
  }
});
