import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const scriptPath = resolve(root, "scripts", "manage-anticodex.ps1");
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

function nativeTypeSource() {
  const match = source.match(
    /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/,
  );
  assert.ok(match, "missing embedded native process-handle type");
  return match[1];
}

function runPowerShellFixture(body) {
  const encoded = Buffer.from(body, "utf16le").toString("base64");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

test("manager child timeout terminates and waits through its already-bound Process object", () => {
  assert.doesNotMatch(source, /\bStop-Process\b/i);
  const stop = functionSource("Stop-AntiCodexManagerChildProcess");
  assert.match(stop, /\[Diagnostics\.Process\]\$Process/);
  assert.match(stop, /\[void\]\$Process\.Handle/);
  assert.match(stop, /\$Process\.Kill\(\)/);
  assert.match(stop, /\$Process\.WaitForExit\(\$TimeoutMs\)/);
  assert.doesNotMatch(stop, /\$Process\.Id|SilentlyContinue|catch\s*\{\s*\}/);

  const invoke = functionSource("Invoke-ManagerScriptJson");
  assert.match(invoke, /Stop-AntiCodexManagerChildProcess\s+-Process\s+\$proc/);
  assert.match(invoke, /\$proc\.Dispose\(\)/);
  assert.doesNotMatch(invoke, /Stop-Process|SilentlyContinue[\s\S]*?Stop/i);
});

test("stale manager bridge termination binds identity checks and termination to one native handle", () => {
  assert.match(source, /class VerifiedProcessHandle\s*:\s*IDisposable/);
  assert.match(source, /OpenProcess/);
  assert.match(source, /GetProcessTimes/);
  assert.match(source, /QueryFullProcessImageName/);
  assert.match(source, /TerminateProcess/);
  assert.match(source, /WaitForSingleObject/);
  assert.match(source, /CommandLineToArgvW/);

  const stop = functionSource("Stop-StaleEmbeddedManagerBridge");
  assert.match(stop, /\[AntiCodex\.Manager\.Native\.VerifiedProcessHandle\]::Open\(\$processId\)/);
  assert.match(stop, /CreationFileTimeUtcTicks/);
  assert.match(stop, /ExecutablePath/);
  assert.match(stop, /Test-AntiCodexManagerNodePath/);
  assert.match(stop, /Test-StaleEmbeddedManagerBridgeCommandLine/);
  assert.match(stop, /\.TerminateAndWait\(3000\)/);
  assert.doesNotMatch(stop, /Stop-Process|SilentlyContinue|catch\s*\{\s*\}/);

  const opened = stop.indexOf(
    "[AntiCodex.Manager.Native.VerifiedProcessHandle]::Open($processId)",
  );
  const creationCheck = stop.indexOf("CreationFileTimeUtcTicks", opened);
  const liveCommandLine = stop.indexOf("Get-CimInstance Win32_Process", opened);
  const terminated = stop.indexOf("$processHandle.TerminateAndWait(3000)");
  assert.ok(opened >= 0, "the exact PID must be opened as a native handle");
  assert.ok(creationCheck > opened, "PID reuse must be checked after binding the handle");
  assert.ok(
    liveCommandLine > creationCheck,
    "the exact command line must be re-read while the terminating handle is held",
  );
  assert.ok(
    terminated > liveCommandLine,
    "termination must happen only after handle-bound command-line verification",
  );
  assert.match(stop, /handle-bound creation time or executable path changed/);
});

test("bridge command-line matching requires one exact absolute script port and stale base URL", () => {
  const result = runPowerShellFixture(`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
${nativeTypeSource()}
'@
${functionSource("Get-EmbeddedManagerBridgeInvocation")}
${functionSource("Test-StaleEmbeddedManagerBridgeCommandLine")}
$bridge = "C:\\Users\\fixture\\AppData\\Local\\Anti-Codex\\runtime\\scripts\\anticodex-manager-bridge.mjs"
function IsStale([string]$commandLine) {
  return [bool](Test-StaleEmbeddedManagerBridgeCommandLine -CommandLine $commandLine -BridgePath $bridge -Port 47123 -BaseUrl "http://127.0.0.1:44101")
}
[ordered]@{
  exactStale = IsStale ('"C:\\Program Files\\nodejs\\node.exe" "' + $bridge + '" --port 47123 --base-url http://127.0.0.1:44001')
  sameNameOtherDirectory = IsStale ('"C:\\Program Files\\nodejs\\node.exe" "C:\\temp\\anticodex-manager-bridge.mjs" --port 47123 --base-url http://127.0.0.1:44001')
  scriptPrefixSibling = IsStale ('"C:\\Program Files\\nodejs\\node.exe" "' + $bridge + '.evil" --port 47123 --base-url http://127.0.0.1:44001')
  wrongPort = IsStale ('"C:\\Program Files\\nodejs\\node.exe" "' + $bridge + '" --port 47124 --base-url http://127.0.0.1:44001')
  currentBaseUrl = IsStale ('"C:\\Program Files\\nodejs\\node.exe" "' + $bridge + '" --port 47123 --base-url http://127.0.0.1:44101')
  duplicatePort = IsStale ('"C:\\Program Files\\nodejs\\node.exe" "' + $bridge + '" --port 47123 --port 47123 --base-url http://127.0.0.1:44001')
  missingBaseUrl = IsStale ('"C:\\Program Files\\nodejs\\node.exe" "' + $bridge + '" --port 47123')
} | ConvertTo-Json -Compress
`);

  assert.deepEqual(result, {
    exactStale: true,
    sameNameOtherDirectory: false,
    scriptPrefixSibling: false,
    wrongPort: false,
    currentBaseUrl: false,
    duplicatePort: false,
    missingBaseUrl: false,
  });
});

test("node identity guard refuses non-node and native WindowsApps executables", () => {
  const guard = functionSource("Test-AntiCodexManagerNodePath");
  assert.match(guard, /GetFileName\(\$fullPath\)/);
  assert.match(guard, /node\.exe/i);
  assert.match(guard, /WindowsApps/i);
  assert.match(guard, /Codex\|ChatGPT/);
  assert.match(guard, /OrdinalIgnoreCase/);

  const result = runPowerShellFixture(`
$ErrorActionPreference = "Stop"
${guard}
[ordered]@{
  node = Test-AntiCodexManagerNodePath "C:\\Program Files\\nodejs\\node.exe"
  nonNode = Test-AntiCodexManagerNodePath "C:\\Program Files\\nodejs\\npm.exe"
  nativeCodex = Test-AntiCodexManagerNodePath "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.0_x64__test\\node.exe"
  nativeChatGpt = Test-AntiCodexManagerNodePath "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_99.0_x64__test\\node.exe"
} | ConvertTo-Json -Compress
`);
  assert.deepEqual(result, {
    node: true,
    nonNode: false,
    nativeCodex: false,
    nativeChatGpt: false,
  });

  const start = functionSource("Start-EmbeddedManagerBridge");
  assert.match(
    start,
    /Stop-StaleEmbeddedManagerBridge\s+-Port\s+\$Port\s+-BaseUrl\s+\$BaseUrl\s+-Node\s+\$Node\s+-BridgePath\s+\$bridge/,
  );
});
