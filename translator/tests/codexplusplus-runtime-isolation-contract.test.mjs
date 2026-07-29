import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "test-codexplusplus-runtime-isolation.ps1");

async function source() {
  return fs.readFile(scriptPath, "utf8");
}

function extractPowerShellFunction(text, name) {
  const start = text.indexOf(`function ${name} {`);
  assert.ok(start >= 0, `missing PowerShell function ${name}`);
  const end = text.indexOf("\nfunction ", start + 1);
  return text.slice(start, end >= 0 ? end : text.length);
}

test("runtime isolation probe injects every state and port override into the child only", async () => {
  const text = await source();

  for (const name of [
    "CODEX_PLUS_STATE_DIR",
    "CODEX_PLUS_APP_EXECUTABLE",
    "CODEX_PLUS_PROTOCOL_PROXY_PORT",
    "CODEX_PLUS_LAUNCHER_GUARD_PORT",
    "CODEX_PLUS_MANAGER_GUARD_PORT",
    "CODEX_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "--user-data-dir",
  ]) {
    assert.match(text, new RegExp(name.replaceAll("-", "\\-")), name);
  }
  assert.match(text, /ProcessStartInfo/);
  assert.match(text, /PreflightOnly/);
  assert.doesNotMatch(text, /SetEnvironmentVariable\s*\(/i);
});

test("runtime isolation probe verifies real process ownership and fails closed", async () => {
  const text = await source();

  for (const token of [
    "invalid_executable_rejected",
    "candidate_process_exact_path",
    "candidate_parent_is_launcher",
    "original_processes_unchanged",
    "existing_anticodex_processes_unchanged",
    "isolated_status_path",
    "global_watcher_unchanged",
    "test_processes_cleaned",
  ]) {
    assert.match(text, new RegExp(token), token);
  }
});

test("runtime isolation probe avoids an unbounded WMI process-table scan", async () => {
  const text = await source();

  assert.match(text, /Get-Process -ErrorAction SilentlyContinue/);
  assert.doesNotMatch(text, /Get-CimInstance\s+Win32_Process\s+-ErrorAction\s+Stop/);
  assert.match(text, /Get-CimInstance\s+Win32_Process\s+-Filter\s+"ProcessId=/);
});

test("runtime isolation probe never reads or hashes Codex credentials", async () => {
  const text = await source();

  assert.match(text, /auth\.json/i);
  assert.match(text, /MetadataOnly/);
  assert.doesNotMatch(text, /Get-Content[^\r\n]*auth\.json/i);
  assert.doesNotMatch(text, /Get-FileHash[^\r\n]*auth\.json/i);
});

test("runtime isolation artifact cleanup is bounded, exact-root guarded, and reported before success", async () => {
  const text = await source();
  const cleanupStart = text.indexOf("function Remove-IsolationRunRoot");
  const cleanupEnd = text.indexOf("\nfunction ", cleanupStart + 1);
  const cleanup = text.slice(cleanupStart, cleanupEnd);

  assert.ok(cleanupStart >= 0, "missing Remove-IsolationRunRoot");
  assert.match(cleanup, /\$expectedRunRoot\s*=\s*Get-FullPath\s*\(Join-Path\s+\$tempRootFull\s+\$ExpectedRunId\)/);
  assert.match(cleanup, /Test-SamePath\s+\$runRootFull\s+\$expectedRunRoot/);
  assert.match(cleanup, /ReparsePoint/);
  assert.match(cleanup, /for \(\$attempt = 1; \$attempt -le \$MaxAttempts; \$attempt\+\+\)/);
  assert.match(cleanup, /Remove-Item[^\r\n]*-Recurse[^\r\n]*-Force[^\r\n]*-ErrorAction Stop/);
  assert.match(cleanup, /\[IO\.Directory\]::Delete\(\(ConvertTo-ExtendedLengthPath \$runRootFull\), \$true\)/);
  assert.match(cleanup, /Assert-CleanupTarget/g);
  assert.match(cleanup, /Test-CleanupTargetGoneStable/g);
  assert.match(cleanup, /Start-Sleep -Milliseconds \$QuiescenceMilliseconds/);

  const checkIndex = text.indexOf("run_artifacts_cleaned");
  const failureIndex = text.indexOf("$failedChecks =", checkIndex);
  const reportWriteIndex = text.indexOf("[IO.File]::WriteAllText($reportFull", failureIndex);
  assert.ok(checkIndex >= 0 && failureIndex > checkIndex && reportWriteIndex > failureIndex);
  assert.doesNotMatch(text.slice(reportWriteIndex), /Remove-Item\s+-LiteralPath\s+\$script:RunRoot/);
  assert.match(text, /Gate 1 report path must remain outside the disposable run root/);
  assert.match(text, /Gate 1 refused a pre-existing run root/);
});

test("runtime isolation artifact cleanup handles long paths and fails closed on replaced targets", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only cleanup behavior");
    return;
  }

  const text = await source();
  const functions = [
    "Get-FullPath",
    "Test-SamePath",
    "Test-PathUnderRoot",
    "Remove-IsolationRunRoot",
  ].map((name) => extractPowerShellFunction(text, name)).join("\n\n");
  const harnessRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anticodex-gate1-cleanup-"));
  const harnessPath = path.join(harnessRoot, "cleanup-behavior.ps1");
  const body = String.raw`
$ErrorActionPreference = 'Stop'
$caseRoot = Join-Path $env:TEMP ('AntiCodex-Gate1-Cleanup-' + [Guid]::NewGuid().ToString('N'))
$tempRoot = Join-Path $caseRoot 'runs'
New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop | Out-Null
$results = [ordered]@{}
try {
    $longId = 'r1234567890123-abcdef01'
    $longRoot = Join-Path $tempRoot $longId
    New-Item -ItemType Directory -Path $longRoot -ErrorAction Stop | Out-Null
    $deep = $longRoot
    foreach ($index in 1..7) { $deep = Join-Path $deep (('segment-' + $index + '-').PadRight(48, 'x')) }
    $extendedDeep = '\\?\' + [IO.Path]::GetFullPath($deep)
    [void][IO.Directory]::CreateDirectory($extendedDeep)
    [IO.File]::WriteAllText(($extendedDeep + '\sentinel.txt'), 'long-path')
    try {
        $longResult = Remove-IsolationRunRoot -RunRoot $longRoot -TempRoot $tempRoot -ExpectedRunId $longId -QuiescenceMilliseconds 25
        $results.longPath = ($longResult.removed -eq $true -and -not (Test-Path -LiteralPath $longRoot))
    } catch {
        $results.longPath = $false
        $results.longPathError = $_.Exception.Message
    }

    $goneId = 'r1234567890123-abcdef02'
    $goneRoot = Join-Path $tempRoot $goneId
    $goneResult = Remove-IsolationRunRoot -RunRoot $goneRoot -TempRoot $tempRoot -ExpectedRunId $goneId -QuiescenceMilliseconds 25
    $results.alreadyGone = ($goneResult.removed -eq $true)

    $wrongRoot = Join-Path $tempRoot 'r1234567890123-abcdef03'
    New-Item -ItemType Directory -Path $wrongRoot -ErrorAction Stop | Out-Null
    try {
        Remove-IsolationRunRoot -RunRoot $wrongRoot -TempRoot $tempRoot -ExpectedRunId 'r1234567890123-abcdef04' -QuiescenceMilliseconds 25 | Out-Null
        $results.wrongDirectChild = $false
    } catch { $results.wrongDirectChild = $true }
    Remove-Item -LiteralPath $wrongRoot -Recurse -Force -ErrorAction Stop

    $deepId = 'r1234567890123-abcdef05'
    $deepRoot = Join-Path $tempRoot $deepId
    $deepChild = Join-Path $deepRoot 'child'
    New-Item -ItemType Directory -Path $deepChild -Force -ErrorAction Stop | Out-Null
    try {
        Remove-IsolationRunRoot -RunRoot $deepChild -TempRoot $tempRoot -ExpectedRunId $deepId -QuiescenceMilliseconds 25 | Out-Null
        $results.deeperDescendant = $false
    } catch { $results.deeperDescendant = $true }
    Remove-Item -LiteralPath $deepRoot -Recurse -Force -ErrorAction Stop

    try {
        Remove-IsolationRunRoot -RunRoot $tempRoot -TempRoot $tempRoot -ExpectedRunId 'r1234567890123-abcdef08' -QuiescenceMilliseconds 25 | Out-Null
        $results.tempRootRejected = $false
    } catch { $results.tempRootRejected = $true }

    $external = Join-Path $caseRoot 'external-sentinel'
    New-Item -ItemType Directory -Path $external -ErrorAction Stop | Out-Null
    $externalFile = Join-Path $external 'must-survive.txt'
    [IO.File]::WriteAllText($externalFile, 'sentinel')
    $junctionId = 'r1234567890123-abcdef06'
    $junctionRoot = Join-Path $tempRoot $junctionId
    $mockedJunction = $false
    try {
        New-Item -ItemType Junction -Path $junctionRoot -Target $external -ErrorAction Stop | Out-Null
    } catch {
        if ($_.CategoryInfo.Reason -ne 'Win32Exception' -or $_.Exception.NativeErrorCode -ne 5) { throw }
        New-Item -ItemType Directory -Path $junctionRoot -ErrorAction Stop | Out-Null
        $mockedJunction = $true
        $script:MockReparsePath = [IO.Path]::GetFullPath($junctionRoot)
        function Get-Item {
            [CmdletBinding()]
            param(
                [Parameter(Mandatory = $true)][string]$LiteralPath,
                [switch]$Force
            )
            $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
            if ([IO.Path]::GetFullPath($LiteralPath).Equals($script:MockReparsePath, [StringComparison]::OrdinalIgnoreCase)) {
                return [pscustomobject]@{
                    PSIsContainer = $true
                    Attributes = ($item.Attributes -bor [IO.FileAttributes]::ReparsePoint)
                    FullName = $item.FullName
                }
            }
            return $item
        }
    }
    try {
        Remove-IsolationRunRoot -RunRoot $junctionRoot -TempRoot $tempRoot -ExpectedRunId $junctionId -QuiescenceMilliseconds 25 | Out-Null
        $results.junctionRejected = $false
    } catch { $results.junctionRejected = (Test-Path -LiteralPath $externalFile -PathType Leaf) }
    if ($mockedJunction) { Remove-Item Function:\Get-Item -Force -ErrorAction Stop }
    [IO.Directory]::Delete($junctionRoot, $false)

    $lockedId = 'r1234567890123-abcdef07'
    $lockedRoot = Join-Path $tempRoot $lockedId
    New-Item -ItemType Directory -Path $lockedRoot -ErrorAction Stop | Out-Null
    $lockedFile = Join-Path $lockedRoot 'locked.txt'
    [IO.File]::WriteAllText($lockedFile, 'locked')
    $handle = [IO.File]::Open($lockedFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        try {
            Remove-IsolationRunRoot -RunRoot $lockedRoot -TempRoot $tempRoot -ExpectedRunId $lockedId -MaxAttempts 2 -QuiescenceMilliseconds 25 | Out-Null
            $results.lockedFileFailsClosed = $false
        } catch { $results.lockedFileFailsClosed = (Test-Path -LiteralPath $lockedRoot) }
    } finally {
        $handle.Dispose()
    }
    Remove-Item -LiteralPath $lockedRoot -Recurse -Force -ErrorAction Stop

    $results | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $caseRoot) {
        try { [IO.Directory]::Delete(('\\?\' + [IO.Path]::GetFullPath($caseRoot)), $true) } catch {}
    }
}
`;
  await fs.writeFile(harnessPath, `${functions}\n${body}`, "utf8");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", harnessPath,
  ], { encoding: "utf8", timeout: 30_000 });
  try {
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(result, {
      longPath: true,
      alreadyGone: true,
      wrongDirectChild: true,
      deeperDescendant: true,
      tempRootRejected: true,
      junctionRejected: true,
      lockedFileFailsClosed: true,
    });
  } finally {
    await fs.rm(harnessRoot, { recursive: true, force: true });
  }
});
