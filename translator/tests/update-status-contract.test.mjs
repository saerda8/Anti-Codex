import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
const targetModule = resolve(projectRoot, "scripts", "anticodex-update-status.psm1");
const updateChecker = resolve(projectRoot, "scripts", "check-anticodex-update.ps1");
const installer = resolve(projectRoot, "scripts", "install-anticodex.ps1");
const hostSync = resolve(projectRoot, "scripts", "sync-anticodex.ps1");
const POWERSHELL_TIMEOUT_MS = 10_000;

test("installer and host sync delegate Appx work when hosted by PowerShell Core", () => {
  for (const scriptPath of [installer, hostSync]) {
    const script = fs.readFileSync(scriptPath, "utf8");
    assert.match(script, /\$PSVersionTable\.PSEdition\s+-eq\s+["']Core["']/);
    assert.match(script, /\[Environment\]::SystemDirectory/);
    assert.match(script, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
    assert.match(script, /\$PSCommandPath/);
    assert.match(script, /\$delegateExitCode\s+-ne\s+0/);
  }
});

test("update checker delegates Appx discovery when hosted by PowerShell Core", () => {
  const checker = fs.readFileSync(updateChecker, "utf8");
  assert.match(checker, /\$PSVersionTable\.PSEdition\s+-eq\s+["']Core["']/);
  assert.match(checker, /\[Environment\]::SystemDirectory/);
  assert.match(checker, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(checker, /\$PSCommandPath/);
  assert.match(checker, /-NoPersist/);
});

test("update checker hashes files without PowerShell module autoloading", () => {
  const checker = fs.readFileSync(updateChecker, "utf8");
  assert.match(checker, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(checker, /\[BitConverter\]::ToString\(\$hash\)\.Replace\("-", ""\)/);
  assert.doesNotMatch(checker, /Get-FileHash/);
});

test("official package version drift forces a shell sync even when host hashes match", () => {
  const checker = fs.readFileSync(updateChecker, "utf8");
  assert.match(checker, /Get-AppxPackage[\s\S]{0,180}Sort-Object\s+Version\s+-Descending/);
  assert.match(checker, /\$packageVersionChanged\s*=\s*\[bool\]/);
  assert.match(checker, /\$updateNeeded[\s\S]{0,220}\$packageVersionChanged/);
  assert.match(checker, /"source_package_version_changed"/);
  assert.match(checker, /\$sourceFingerprint[\s\S]{0,220}\$source\.packageVersion/);
});

test("checker, installer and sync use the same newest official package root", () => {
  const checker = fs.readFileSync(updateChecker, "utf8");
  const install = fs.readFileSync(installer, "utf8");
  const sync = fs.readFileSync(hostSync, "utf8");

  assert.match(checker, /\$packages\s*=\s*@\([\s\S]*?OpenAI\.Codex[\s\S]*?OpenAI\.Codex_8wekyb3d8bbwe[\s\S]*?Sort-Object\s+Version\s+-Descending/);
  assert.match(install, /\[string\]\$SourceRoot\s*=\s*""/);
  assert.match(install, /if \(\$SourceRoot\)[\s\S]*?GetFullPath\(\$SourceRoot\)[\s\S]*?Find-CodexAppRoot/);
  assert.match(sync, /\$sourceSelection\s*=\s*&\s*\$updateChecker\s+-InstallRoot\s+\$installRoot\s+-StateRoot\s+\$stateRoot\s+-NoPersist/);
  assert.match(sync, /\$selectedSourceRoot\s*=\s*\[IO\.Path\]::GetFullPath\(\[string\]\$sourceSelection\.source\.root\)/);
  assert.match(sync, /&\s*\$installer\s+-InstallTarget\s+\$candidateRoot\s+-SourceRoot\s+\$selectedSourceRoot\s+-HostOnly/);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

test("Get-AntiCodexUpdateStatus returns idle/none on empty StateRoot (RED - module absent)", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-contract-"));
  try {
    const psScript = resolve(tempDir, "run-test.ps1");
    fs.writeFileSync(
      psScript,
      `$ErrorActionPreference = "Stop"
$env:DEEPCODEX_STATE_ROOT = '${tempDir.replace(/\\/g, '\\\\')}'
Import-Module '${targetModule.replace(/\\/g, '\\\\')}'
Get-AntiCodexUpdateStatus | ConvertTo-Json -Depth 8 -Compress`
    );

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(
        `PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`
      );
    }

    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed, "Must return an object");
    assert.ok(parsed.operation, "Must contain .operation");
    assert.equal(parsed.operation.state, "idle", "Initial state must be idle");
    assert.equal(parsed.operation.stage, "none", "Initial stage must be none");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RED: Get-AntiCodexUpdateStatus fills idle/none when update-status.json has updateNeeded=true but no operation", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-contract-"));
  try {
    const stateFile = resolve(tempDir, "update-status.json");
    fs.writeFileSync(stateFile, JSON.stringify({ updateNeeded: true }));

    const psScript = resolve(tempDir, "run-test.ps1");
    fs.writeFileSync(
      psScript,
      `$ErrorActionPreference = "Stop"
$env:DEEPCODEX_STATE_ROOT = '${tempDir.replace(/\\/g, '\\\\')}'
Import-Module '${targetModule.replace(/\\/g, '\\\\')}'
Get-AntiCodexUpdateStatus | ConvertTo-Json -Depth 8 -Compress`
    );

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(
        `PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`
      );
    }

    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed, "Must return an object");
    assert.equal(parsed.updateNeeded, true, "updateNeeded must be preserved as true");
    assert.ok(parsed.operation, "Must contain .operation (filled by default)");
    assert.equal(parsed.operation.state, "idle", "operation.state must be idle");
    assert.equal(parsed.operation.stage, "none", "operation.stage must be none");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RED: Set-AntiCodexUpdateOperation state=running stage=candidate_build then Get-AntiCodexUpdateStatus reflects the values", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-contract-"));
  try {
    const psScript = resolve(tempDir, "run-test.ps1");
    fs.writeFileSync(
      psScript,
      `$ErrorActionPreference = "Stop"
$env:DEEPCODEX_STATE_ROOT = '${tempDir.replace(/\\/g, '\\\\')}'
Import-Module '${targetModule.replace(/\\/g, '\\\\')}'
Set-AntiCodexUpdateOperation -State 'running' -Stage 'candidate_build'
Get-AntiCodexUpdateStatus | ConvertTo-Json -Depth 8 -Compress`
    );

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(
        `PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`
      );
    }

    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed, "Must return an object");
    assert.ok(parsed.operation, "Must contain .operation");
    assert.equal(parsed.operation.state, "running", "operation.state must be 'running' after Set-AntiCodexUpdateOperation");
    assert.equal(parsed.operation.stage, "candidate_build", "operation.stage must be 'candidate_build' after Set-AntiCodexUpdateOperation");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RED: update check preserves an existing running operation", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-check-"));
  try {
    const sourceRoot = resolve(tempDir, "source");
    const installRoot = resolve(tempDir, "install");
    const stateRoot = resolve(tempDir, "state");
    const activeRoot = resolve(installRoot, "codex-patched-app");
    for (const root of [sourceRoot, activeRoot]) {
      fs.mkdirSync(resolve(root, "resources"), { recursive: true });
      fs.writeFileSync(resolve(root, "Codex.exe"), "same-host");
      fs.writeFileSync(resolve(root, "resources", "codex.exe"), "same-cli");
    }
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(resolve(stateRoot, "update-status.json"), JSON.stringify({
      updateNeeded: true,
      operation: { state: "running", stage: "candidate_validation" }
    }));

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updateChecker,
      "-InstallRoot", installRoot, "-SourceRoot", sourceRoot, "-StateRoot", stateRoot
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(
        `PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`
      );
    }

    const persisted = JSON.parse(fs.readFileSync(resolve(stateRoot, "update-status.json"), "utf8"));
    assert.equal(persisted.operation?.state, "running");
    assert.equal(persisted.operation?.stage, "candidate_validation");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("update check clears stale running operation when active host is already synced", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-stale-running-"));
  try {
    const sourceRoot = resolve(tempDir, "source");
    const installRoot = resolve(tempDir, "install");
    const stateRoot = resolve(tempDir, "state");
    const activeRoot = resolve(installRoot, "codex-patched-app");
    const fileContents = {
      antiCodexExe: "same-host",
      appAsar: "patched-asar",
      codexCli: "same-cli",
      hostIcon: "fake-icon",
      trayIcon: "fake-tray-icon",
      appRootIcon: "fake-root-icon",
    };
    fs.mkdirSync(resolve(sourceRoot, "resources"), { recursive: true });
    fs.mkdirSync(resolve(activeRoot, "resources"), { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(resolve(sourceRoot, "Codex.exe"), fileContents.antiCodexExe);
    fs.writeFileSync(resolve(sourceRoot, "resources", "codex.exe"), fileContents.codexCli);
    fs.writeFileSync(resolve(activeRoot, "Codex.exe"), fileContents.antiCodexExe);
    fs.writeFileSync(resolve(activeRoot, "Anti-Codex.exe"), fileContents.antiCodexExe);
    fs.writeFileSync(resolve(activeRoot, "resources", "app.asar"), fileContents.appAsar);
    fs.writeFileSync(resolve(activeRoot, "resources", "codex.exe"), fileContents.codexCli);
    fs.writeFileSync(resolve(activeRoot, "resources", "icon.ico"), fileContents.hostIcon);
    fs.writeFileSync(resolve(activeRoot, "resources", "codex-tray.ico"), fileContents.trayIcon);
    fs.writeFileSync(resolve(activeRoot, "icon.ico"), fileContents.appRootIcon);
    fs.writeFileSync(resolve(installRoot, "codex-patched-app.ok"), JSON.stringify({
      schema: "anticodex-host-manifest-v1",
      source: {
        packageName: "explicit",
        packageVersion: "test-version",
        codexHost: sha256(fileContents.antiCodexExe),
        codexCli: sha256(fileContents.codexCli),
      },
      files: {
        antiCodexExe: sha256(fileContents.antiCodexExe),
        appAsar: sha256(fileContents.appAsar),
        codexCli: sha256(fileContents.codexCli),
        hostIcon: sha256(fileContents.hostIcon),
        trayIcon: sha256(fileContents.trayIcon),
        appRootIcon: sha256(fileContents.appRootIcon),
      },
    }));
    fs.writeFileSync(resolve(stateRoot, "update-status.json"), JSON.stringify({
      updateNeeded: false,
      operation: {
        state: "running",
        stage: "feature_refresh",
        updatedAt: "2001-01-01T00:00:00.000Z",
        rollbackAvailable: true,
      },
    }));

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updateChecker,
      "-InstallRoot", installRoot, "-SourceRoot", sourceRoot, "-StateRoot", stateRoot,
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(`PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`);
    }

    const parsed = JSON.parse(result.stdout.trim());
    const persisted = JSON.parse(fs.readFileSync(resolve(stateRoot, "update-status.json"), "utf8"));
    assert.equal(parsed.updateNeeded, false);
    assert.equal(parsed.operation?.state, "succeeded");
    assert.equal(parsed.operation?.stage, "complete");
    assert.equal(persisted.operation?.state, "succeeded");
    assert.equal(persisted.operation?.stage, "complete");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("update check recognizes stale failed operations only through the synced-host cleanup path", () => {
  const checker = fs.readFileSync(updateChecker, "utf8");
  assert.match(checker, /function Test-StaleFailedUpdateOperation/);
  assert.match(checker, /Test-StaleFailedUpdateOperation -Operation \$existingOperation/);
  assert.match(checker, /Anti-Codex is synced; cleared a stale sync operation\./);
});

test("RED: update check reports version drift and brand/icon protection guardrails", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-drift-"));
  try {
    const sourceRoot = resolve(tempDir, "source");
    const installRoot = resolve(tempDir, "install");
    const stateRoot = resolve(tempDir, "state");
    const activeRoot = resolve(installRoot, "codex-patched-app");
    for (const root of [sourceRoot, activeRoot]) {
      fs.mkdirSync(resolve(root, "resources"), { recursive: true });
    }
    fs.writeFileSync(resolve(sourceRoot, "Codex.exe"), "new-host");
    fs.writeFileSync(resolve(sourceRoot, "resources", "codex.exe"), "new-cli");
    fs.writeFileSync(resolve(activeRoot, "Codex.exe"), "old-host");
    fs.writeFileSync(resolve(activeRoot, "resources", "codex.exe"), "old-cli");
    fs.writeFileSync(resolve(installRoot, "codex-patched-app.ok"), JSON.stringify({
      schema: "anticodex-host-manifest-v1",
      source: { packageName: "OpenAI.Codex", packageVersion: "1.2.3.4" },
      files: {}
    }));

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updateChecker,
      "-InstallRoot", installRoot, "-SourceRoot", sourceRoot, "-StateRoot", stateRoot
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(
        `PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`
      );
    }

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.updateNeeded, true);
    assert.equal(parsed.drift?.state, "drifted");
    assert.equal(parsed.drift?.hostChanged, true);
    assert.equal(parsed.drift?.cliChanged, true);
    assert.equal(parsed.drift?.activePackageVersion, "1.2.3.4");
    assert.equal(parsed.guardrails?.brandPreserved, false);
    assert.equal(parsed.guardrails?.iconPreserved, false);
    assert.equal(parsed.guardrails?.activeHostValid, false);
    assert.ok(parsed.guardrails?.failures?.length > 0);
    assert.match(parsed.guardrails?.message ?? "", /guardrails need validation/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RED: update check delegates persistence to the locked status writer", () => {
  const checker = fs.readFileSync(updateChecker, "utf8");
  assert.match(checker, /Save-AntiCodexUpdateStatus/);
  assert.doesNotMatch(checker, /WriteAllText\(\$statusPath/);
});

test("cached-looking active host is rejected when source fingerprints are missing", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-missing-source-"));
  try {
    const sourceRoot = resolve(tempDir, "source");
    const installRoot = resolve(tempDir, "install");
    const stateRoot = resolve(tempDir, "state");
    const activeRoot = resolve(installRoot, "codex-patched-app");
    const fileContents = {
      antiCodexExe: "same-host",
      appAsar: "patched-asar",
      codexCli: "same-cli",
      hostIcon: "fake-icon",
      trayIcon: "fake-tray-icon",
      appRootIcon: "fake-root-icon",
    };
    fs.mkdirSync(resolve(sourceRoot, "resources"), { recursive: true });
    fs.mkdirSync(resolve(activeRoot, "resources"), { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(resolve(sourceRoot, "Codex.exe"), fileContents.antiCodexExe);
    fs.writeFileSync(resolve(sourceRoot, "resources", "codex.exe"), fileContents.codexCli);
    fs.writeFileSync(resolve(activeRoot, "Codex.exe"), fileContents.antiCodexExe);
    fs.writeFileSync(resolve(activeRoot, "Anti-Codex.exe"), fileContents.antiCodexExe);
    fs.writeFileSync(resolve(activeRoot, "resources", "app.asar"), fileContents.appAsar);
    fs.writeFileSync(resolve(activeRoot, "resources", "codex.exe"), fileContents.codexCli);
    fs.writeFileSync(resolve(activeRoot, "resources", "icon.ico"), fileContents.hostIcon);
    fs.writeFileSync(resolve(activeRoot, "resources", "codex-tray.ico"), fileContents.trayIcon);
    fs.writeFileSync(resolve(activeRoot, "icon.ico"), fileContents.appRootIcon);
    fs.writeFileSync(resolve(installRoot, "codex-patched-app.ok"), JSON.stringify({
      schema: "anticodex-host-manifest-v1",
      source: { packageName: "OpenAI.Codex", packageVersion: "cached-version" },
      files: {
        antiCodexExe: sha256(fileContents.antiCodexExe),
        appAsar: sha256(fileContents.appAsar),
        codexCli: sha256(fileContents.codexCli),
        hostIcon: sha256(fileContents.hostIcon),
        trayIcon: sha256(fileContents.trayIcon),
        appRootIcon: sha256(fileContents.appRootIcon),
      },
    }));

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updateChecker,
      "-InstallRoot", installRoot, "-SourceRoot", sourceRoot, "-StateRoot", stateRoot,
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(`PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`);
    }

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.updateNeeded, true);
    assert.equal(parsed.reason, "active_host_guardrail_failed");
    assert.equal(parsed.guardrails?.activeHostValid, false);
    assert.ok(parsed.guardrails?.failures?.some((failure) => /source .*fingerprint is missing/.test(failure)));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RED: cached up-to-date update check still depends on active manifest, brand, icon, and hash guardrails", () => {
  const checker = fs.readFileSync(updateChecker, "utf8");
  assert.match(checker, /function\s+Test-ActiveHostGuardrails/);
  assert.match(checker, /\$activeGuardrails\s*=\s*Test-ActiveHostGuardrails/);

  const cachedReasonIndex = checker.indexOf('"up_to_date_cached"');
  assert.notEqual(cachedReasonIndex, -1, "cached path must still be present");
  const cachedGate = checker.slice(Math.max(0, cachedReasonIndex - 800), cachedReasonIndex);
  assert.match(cachedGate, /\$cachedStatus/);
  assert.match(cachedGate, /\$activeGuardrails\.ok\s+-eq\s+\$true/);
  assert.match(checker, /\$guardrailDrift\s*=\s*\[bool\]\(\$source\s+-and\s+\$comparable\s+-and\s+\$activeGuardrails\.ok\s+-ne\s+\$true\)/);
  assert.match(checker, /\$updateNeeded\s*=\s*\[bool\]\(\$comparable\s+-and\s+\(\$hostChanged\s+-or\s+\$cliChanged\s+-or\s+\$packageVersionChanged\s+-or\s+\$guardrailDrift\s+-or\s+\$componentDrift\)\)/);

  const guardrailStart = checker.indexOf("function Test-ActiveHostGuardrails");
  assert.notEqual(guardrailStart, -1, "active guardrail function must exist");
  const guardrailBody = checker.slice(guardrailStart, checker.indexOf("$source =", guardrailStart));
  for (const required of [
    "anticodex-host-manifest-v1",
    "ProductName",
    "FileDescription",
    "OriginalFilename",
    "hostIcon",
    "trayIcon",
    "appRootIcon",
    "codexHost",
    "codexCli",
    "Test-AntiCodexIconPalette",
    "antiCodexExe",
    "appAsar",
  ]) {
    assert.match(guardrailBody, new RegExp(required), `guardrail function must check ${required}`);
  }
});

test("locked status save keeps the latest operation instead of a stale caller copy", () => {
  const tempDir = fs.mkdtempSync(resolve(os.tmpdir(), "update-status-locked-save-"));
  try {
    const psScript = resolve(tempDir, "run-test.ps1");
    fs.writeFileSync(
      psScript,
      `$ErrorActionPreference = "Stop"
$env:DEEPCODEX_STATE_ROOT = '${tempDir.replace(/\\/g, '\\\\')}'
Import-Module '${targetModule.replace(/\\/g, '\\\\')}'
Set-AntiCodexUpdateOperation -State 'running' -Stage 'candidate_validation'
$stale = [pscustomobject]@{ updateNeeded = $false; operation = [pscustomobject]@{ state = 'idle'; stage = 'none' } }
Save-AntiCodexUpdateStatus -Status $stale
Get-AntiCodexUpdateStatus | ConvertTo-Json -Depth 8 -Compress`
    );

    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript
    ], { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(
        `PowerShell exited code ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`
      );
    }

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.updateNeeded, false);
    assert.equal(parsed.operation.state, "running");
    assert.equal(parsed.operation.stage, "candidate_validation");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RED: sync script records persistent lifecycle stages and terminal states", () => {
  const syncScript = fs.readFileSync(resolve(projectRoot, "scripts", "sync-anticodex.ps1"), "utf8");
  assert.match(syncScript, /Import-Module[^\r\n]*anticodex-update-status\.psm1/);
  for (const stage of ["candidate_build", "component_candidate", "candidate_validation", "stopping_host", "activation", "feature_refresh", "restart", "acceptance"]) {
    assert.match(syncScript, new RegExp(`Set-AntiCodexUpdateOperation[^\\r\\n]*-Stage ["']${stage}["']`));
  }
  for (const state of ["succeeded", "failed", "rolled_back"]) {
    assert.match(syncScript, new RegExp(`Set-AntiCodexUpdateOperation[^\\r\\n]*-State ["']${state}["']`));
  }
});

test("host sync has an explicit no-restart maintenance mode with offline acceptance", () => {
  const syncScript = fs.readFileSync(resolve(projectRoot, "scripts", "sync-anticodex.ps1"), "utf8");
  assert.match(syncScript, /\[switch\]\$NoRestart/);
  assert.match(syncScript, /if\s*\(\$NoRestart\)\s*\{[\s\S]*?\$updateChecker[\s\S]*?-NoPersist/);
  assert.match(syncScript, /if\s*\(-not\s+\$NoRestart\)\s*\{[\s\S]*?Start-AntiCodexAfterSync/);
  assert.match(syncScript, /synced_without_restart/);
});

test("RED: rollback script records persistent lifecycle and terminal states", () => {
  const rollbackScript = fs.readFileSync(resolve(projectRoot, "scripts", "rollback-anticodex.ps1"), "utf8");
  assert.match(rollbackScript, /Import-Module[^\r\n]*anticodex-update-status\.psm1/);
  for (const stage of ["rollback_validation", "rollback_stopping_host", "rollback_activation", "rollback_restart", "rollback_acceptance"]) {
    assert.match(rollbackScript, new RegExp(`Set-AntiCodexUpdateOperation[^\\r\\n]*-Stage ["']${stage}["']`));
  }
  assert.match(rollbackScript, /Set-AntiCodexUpdateOperation[^\r\n]*-State ["']rolled_back["']/);
  assert.match(rollbackScript, /Set-AntiCodexUpdateOperation[^\r\n]*-State ["']failed["']/);
});
