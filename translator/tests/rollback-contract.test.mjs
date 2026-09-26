import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

function readRollbackScript() {
  return readFileSync(resolve(root, "scripts", "rollback-anticodex.ps1"), "utf8");
}

function readSyncScript() {
  return readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
}

function readRuntimeScript(name) {
  return readFileSync(resolve(root, "scripts", name), "utf8");
}

test("rollback host validation recognizes the branded product marker", () => {
  const script = readRollbackScript();
  assert.match(script, /\$requiredMarkers = @\([\s\S]*?"Anti-Codex"/);
  assert.doesNotMatch(script, /\$requiredMarkers = @\([\s\S]*?"AntiCodex"/);
});

function extractFunction(text, name) {
  const marker = `function ${name}`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const candidates = [
    text.indexOf("\nfunction ", start + marker.length),
    text.indexOf("\nif ($ValidateOnly)", start + marker.length),
    text.indexOf("\n$syncMutex", start + marker.length),
  ].filter((value) => value !== -1);
  return text.slice(start, candidates.length > 0 ? Math.min(...candidates) : undefined);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function snapshotTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        files.push({
          path: relative(root, path).replaceAll("/", "\\"),
          sha256: sha256(readFileSync(path)),
          size: statSync(path).size,
        });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createRollbackRepairFixture({ sameHostCli, legacyInventory }) {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-rollback-inventory-"));
  const rollbackHost = join(fixture, "rollback-host");
  const activeHost = join(fixture, "active-host");
  const rollbackUnpacked = join(rollbackHost, "resources", "app.asar.unpacked");
  const activeUnpacked = join(activeHost, "resources", "app.asar.unpacked");
  const rollbackMarker = join(fixture, "rollback-host.ok");
  const activeMarker = join(fixture, "active-host.ok");
  mkdirSync(rollbackUnpacked, { recursive: true });
  mkdirSync(activeUnpacked, { recursive: true });

  const rollbackFiles = {
    "module-a.node": "rollback-node-a",
    "module-b.node": "rollback-node-b",
    "module-c.node": "rollback-node-c",
    "companion.dll": "rollback-dll",
    "runtime.js": "rollback-js",
  };
  const activeFiles = {
    "module-a.node": "active-node-a",
    "module-b.node": "active-node-b",
    "module-c.node": "active-node-c",
    "companion.dll": "active-dll",
    "runtime.js": "active-js",
  };
  for (const [name, content] of Object.entries(rollbackFiles)) {
    writeFileSync(join(rollbackUnpacked, name), content);
  }
  for (const [name, content] of Object.entries(activeFiles)) {
    writeFileSync(join(activeUnpacked, name), content);
  }

  const rollbackInventory = Object.entries(rollbackFiles).map(([name, content]) => ({
    path: `resources\\app.asar.unpacked\\${name}`,
    sha256: sha256(content),
    size: Buffer.byteLength(content),
  }));
  const rollbackNativeInventory = Object.entries(rollbackFiles)
    .filter(([name]) => name.endsWith(".node"))
    .map(([name, content]) => ({
      path: `resources\\app.asar.unpacked\\${name}`,
      sha256: sha256(content),
      size: Buffer.byteLength(content),
    }));
  const activeNativeInventory = Object.entries(activeFiles)
    .filter(([name]) => name.endsWith(".node"))
    .map(([name, content]) => ({
      path: `resources\\app.asar.unpacked\\${name}`,
      sha256: sha256(content),
      size: Buffer.byteLength(content),
    }));
  writeFileSync(rollbackMarker, JSON.stringify({
    schema: legacyInventory ? "anticodex-host-manifest-v1" : "anticodex-host-manifest-v2",
    source: {
      packageVersion: "1.0.0.0",
      codexHost: "rollback-host-hash",
      codexCli: "rollback-cli-hash",
    },
    unpackedNativeModules: rollbackNativeInventory,
    ...(legacyInventory ? {} : { unpackedFiles: rollbackInventory }),
  }));
  writeFileSync(activeMarker, JSON.stringify({
    schema: "anticodex-host-manifest-v2",
    source: {
      packageVersion: "2.0.0.0",
      codexHost: sameHostCli ? "rollback-host-hash" : "active-host-hash",
      codexCli: sameHostCli ? "rollback-cli-hash" : "active-cli-hash",
    },
    unpackedNativeModules: activeNativeInventory,
  }));

  const syncScript = readSyncScript();
  const sha256Function = extractFunction(syncScript, "Get-AntiCodexSha256");
  const repair = extractFunction(syncScript, "Repair-RollbackHostUnpackedFileManifest");
  const harness = join(fixture, "repair.ps1");
  writeFileSync(harness, `$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$rollbackHost = ${quotePowerShell(rollbackHost)}
$rollbackMarker = ${quotePowerShell(rollbackMarker)}
$activeHost = ${quotePowerShell(activeHost)}
$activeMarker = ${quotePowerShell(activeMarker)}
${sha256Function}
${repair}
Repair-RollbackHostUnpackedFileManifest
`);
  return { fixture, rollbackHost, rollbackMarker, harness };
}

function runRollbackRepair(options) {
  const fixture = createRollbackRepairFixture(options);
  const before = snapshotTree(fixture.rollbackHost);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture.harness],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  const after = snapshotTree(fixture.rollbackHost);
  const manifest = JSON.parse(readFileSync(fixture.rollbackMarker, "utf8"));
  return { ...fixture, before, after, result, manifest };
}

function runRollbackHostPatchMatrix() {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-rollback-host-matrix-"));
  const revision4 = [
    "package-json",
    "webview-html-title",
    "app-name",
    "app-user-model-id",
    "session-title",
    "startup-mcp-config-reload",
    "app-server-managed-session-flags",
    "config-write",
    "auth-requirement",
    "app-route-gate",
    "profile-dropdown-settings",
    "settings-external-links",
    "browser-window-icon",
    "primary-window-restore-repaint",
    "windows-tray-icon",
    "local-model-availability",
  ];
  const revision6 = [...revision4, "crash-recovery-page"];
  const current = revision6.filter((name) => name !== "primary-window-restore-repaint");
  const previous = revision4.filter((name) => ![
    "app-server-managed-session-flags",
    "settings-external-links",
  ].includes(name));
  const legacy = previous.filter((name) => name !== "config-write");
  const cases = [
    ["current", current, true, 7],
    ["revisionSix", revision6, true, 6],
    ["revisionFive", revision6, true, 5],
    ["revision2Current", revision4, true, 2],
    ["legacyCurrent", current, true],
    ["revisionOne", current, true, 1],
    ["revisionFour", revision4, true, 4],
    ["previous", previous, true],
    ["legacy", legacy, false],
    ["previousMissingBridge", previous, false],
    ["fictionalFifteen", current.filter((name) => name !== "config-write"), false],
    ["missingRequired", previous.filter((name) => name !== "browser-window-icon"), true],
    ["extra", [...previous, "unexpected"], true],
  ];
  const paths = {};
  for (const [name, criticalPatches, hasConfigWrite, hostPatchRevision] of cases) {
    const hostRoot = join(fixture, name);
    const markerPath = join(fixture, `${name}.ok`);
    const unpackedRoot = join(hostRoot, "resources", "app.asar.unpacked");
    mkdirSync(unpackedRoot, { recursive: true });
    const hostBytes = Buffer.from(`official-host-${name}`);
    const cliBytes = Buffer.from(`codex-cli-${name}`);
    const nodeRuntimeBytes = Buffer.from(`node-runtime-${name}`);
    const asarBytes = Buffer.from(hasConfigWrite ? "with-config-bridge" : "without-bridge");
    const iconBytes = Buffer.from(`icon-${name}`);
    const unpackedBytes = Buffer.from(`runtime-${name}`);
    mkdirSync(join(hostRoot, "resources", "cua_node", "bin"), { recursive: true });
    writeFileSync(join(hostRoot, "Anti-Codex.exe"), hostBytes);
    writeFileSync(join(hostRoot, "ChatGPT.exe"), hostBytes);
    writeFileSync(join(hostRoot, "resources", "app.asar"), asarBytes);
    writeFileSync(join(hostRoot, "resources", "codex.exe"), cliBytes);
    writeFileSync(join(hostRoot, "resources", "cua_node", "bin", "node.exe"), nodeRuntimeBytes);
    writeFileSync(join(hostRoot, "resources", "icon.ico"), iconBytes);
    writeFileSync(join(hostRoot, "resources", "codex-tray.ico"), iconBytes);
    writeFileSync(join(hostRoot, "icon.ico"), iconBytes);
    writeFileSync(join(unpackedRoot, "runtime.js"), unpackedBytes);
    writeFileSync(markerPath, JSON.stringify({
      schema: "anticodex-host-manifest-v2",
      patchProfile: "fixed-shell-v1",
      source: {
        codexHost: sha256(hostBytes),
        codexCli: sha256(cliBytes),
      },
      ...(hostPatchRevision === undefined ? {} : { hostPatchRevision }),
      criticalPatches,
      unpackedFiles: [{
        path: "resources\\app.asar.unpacked\\runtime.js",
        sha256: sha256(unpackedBytes),
        size: unpackedBytes.length,
      }],
      files: {
        antiCodexExe: sha256(hostBytes),
        appAsar: sha256(asarBytes),
        codexCli: sha256(cliBytes),
        nodeRuntime: sha256(nodeRuntimeBytes),
        hostIcon: sha256(iconBytes),
        trayIcon: sha256(iconBytes),
        appRootIcon: sha256(iconBytes),
      },
    }));
    paths[name] = { hostRoot, markerPath };
  }

  const rollback = readRollbackScript();
  const harness = join(fixture, "matrix.ps1");
  const checks = Object.entries(paths)
    .map(([name, value]) => `${name} = Accept-Host ${quotePowerShell(value.hostRoot)} ${quotePowerShell(value.markerPath)}`)
    .join("\n    ");
  writeFileSync(harness, `$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
${extractFunction(rollback, "Get-AntiCodexSha256")}
${extractFunction(rollback, "Test-AntiCodexCriticalPatchSet")}
function Assert-FixedHostPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path)
}
function Test-AntiCodexIconPalette {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $true
}
function Test-AntiCodexAsarPatches {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$PatchProfile,
        [Parameter(Mandatory = $true)][int]$ExpectedConfigWriteBridgeCount,
        [Parameter(Mandatory = $true)][int]$ExpectedPrimaryWindowDeferredRestoreRepaintCount,
        [Parameter(Mandatory = $true)][int]$ExpectedPrimaryWindowFocusRestoreRepaintCount,
        [Parameter(Mandatory = $true)][int]$ExpectedLegacyPrimaryWindowRestoreRepaintCount,
        [int]$ExpectedHostPatchRevision = 0
    )
    $actualConfigWriteBridgeCount = if ((Get-Content -LiteralPath $Path -Raw) -eq "with-config-bridge") { 1 } else { 0 }
    $shapeMatches = if ($ExpectedHostPatchRevision -eq 7) {
        $ExpectedPrimaryWindowDeferredRestoreRepaintCount -eq 0 -and
        $ExpectedPrimaryWindowFocusRestoreRepaintCount -eq 0 -and
        $ExpectedLegacyPrimaryWindowRestoreRepaintCount -eq 0
    } elseif ($ExpectedHostPatchRevision -in @(3, 4, 5, 6)) {
        $ExpectedPrimaryWindowDeferredRestoreRepaintCount -eq 1 -and
        $ExpectedPrimaryWindowFocusRestoreRepaintCount -eq 0 -and
        $ExpectedLegacyPrimaryWindowRestoreRepaintCount -eq 0
    } else {
        $ExpectedPrimaryWindowDeferredRestoreRepaintCount -eq 0 -and
        $ExpectedPrimaryWindowFocusRestoreRepaintCount -eq 1 -and
        $ExpectedLegacyPrimaryWindowRestoreRepaintCount -eq 0
    }
    if ($actualConfigWriteBridgeCount -ne $ExpectedConfigWriteBridgeCount -or -not $shapeMatches) {
        throw "fixture ASAR contract mismatch"
    }
}
${extractFunction(rollback, "Test-AntiCodexHost")}
function Accept-Host {
    param([string]$HostRoot, [string]$MarkerPath)
    try {
        Test-AntiCodexHost -HostRoot $HostRoot -MarkerPath $MarkerPath
        return $true
    } catch {
        return $false
    }
}
[ordered]@{
    ${checks}
} | ConvertTo-Json -Compress
`);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  return { fixture, result };
}

function createLegacyRollbackBinaryFixture({ readOnlyMarker = false, asar = "" } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-rollback-binary-"));
  const rollbackHost = join(fixture, "rollback-host");
  const rollbackMarker = join(fixture, "rollback-host.ok");
  const sourceHost = join(rollbackHost, "ChatGPT.exe");
  const antiCodexHost = join(rollbackHost, "Anti-Codex.exe");
  const sourceBytes = Buffer.from(asar ? `host-${"a".repeat(64)}-end` : "official-codex-host-bytes");
  const legacyBytes = asar ? Buffer.from(asar === "patched" ? `host-${"b".repeat(64)}-end` : sourceBytes) : Buffer.from("legacy-rcedit-host-bytes");
  mkdirSync(rollbackHost, { recursive: true });
  writeFileSync(sourceHost, sourceBytes);
  writeFileSync(antiCodexHost, legacyBytes);
  const markerText = JSON.stringify({
    schema: "anticodex-host-manifest-v2",
    ...(asar ? { asarIntegrity: { originalHeaderHash: "a".repeat(64), patchedHeaderHash: "b".repeat(64) } } : {}),
    source: {
      desktopHostName: "ChatGPT.exe",
      codexHost: sha256(sourceBytes),
      codexCli: sha256("codex-cli"),
    },
    files: {
      antiCodexExe: sha256(legacyBytes),
    },
  }, null, 2);
  writeFileSync(rollbackMarker, markerText);
  if (asar) writeFileSync(join(fixture, "electron-asar-integrity-host.mjs"), readFileSync(join(root, "scripts", "electron-asar-integrity-host.mjs")));
  if (readOnlyMarker) chmodSync(rollbackMarker, 0o444);

  const rollback = readRollbackScript();
  const sha256Function = extractFunction(rollback, "Get-AntiCodexSha256");
  const repair = extractFunction(rollback, "Repair-LegacyRollbackHostBinaryManifest");
  const harness = join(fixture, "repair-binary.ps1");
  writeFileSync(harness, `$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$rollbackHost = ${quotePowerShell(rollbackHost)}
$rollbackMarker = ${quotePowerShell(rollbackMarker)}
${sha256Function}
${repair}
Repair-LegacyRollbackHostBinaryManifest
`);
  return {
    fixture,
    rollbackHost,
    rollbackMarker,
    sourceHost,
    antiCodexHost,
    sourceBytes,
    legacyBytes,
    markerText,
    harness,
  };
}

function runLegacyRollbackBinaryMigration(options) {
  const fixture = createLegacyRollbackBinaryFixture(options);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture.harness],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  return { ...fixture, result };
}

test("rollback migration preserves required ASAR patches and restores a stripped patch", () => {
  for (const asar of ["patched", "stripped"]) {
    const fixture = runLegacyRollbackBinaryMigration({ asar });
    try {
      assert.equal(fixture.result.status, 0, fixture.result.stderr);
      const expected = Buffer.from(`host-${"b".repeat(64)}-end`);
      assert.deepEqual(readFileSync(fixture.antiCodexHost), expected);
      assert.equal(JSON.parse(readFileSync(fixture.rollbackMarker, "utf8")).files.antiCodexExe, sha256(expected));
    } finally { rmSync(fixture.fixture, { recursive: true, force: true }); }
  }
});

function createRollbackCommitFailureFixture(failStep) {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-rollback-commit-"));
  const slots = {
    activeHost: join(fixture, "active-host"),
    rollbackHost: join(fixture, "rollback-host"),
    swapHost: join(fixture, "swap-host"),
    activeMarker: join(fixture, "active-host.ok"),
    rollbackMarker: join(fixture, "rollback-host.ok"),
    swapMarker: join(fixture, "swap-host.ok"),
    activeComponent: join(fixture, "active-component"),
    rollbackComponent: join(fixture, "rollback-component"),
    swapComponent: join(fixture, "swap-component"),
  };
  for (const [path, version] of [
    [slots.activeHost, "previous"],
    [slots.activeComponent, "previous"],
    [slots.swapHost, "current"],
    [slots.swapComponent, "current"],
  ]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "version.txt"), version);
  }
  writeFileSync(slots.activeMarker, "previous");
  writeFileSync(slots.swapMarker, "current");

  const rollback = readRollbackScript();
  const commit = extractFunction(rollback, "Commit-AntiCodexRollbackCheckpoint");
  const restore = extractFunction(rollback, "Restore-OriginalActiveRelease");
  const harness = join(fixture, "commit-failure.ps1");
  const slotAssignments = Object.entries(slots)
    .map(([name, path]) => `$${name} = ${quotePowerShell(path)}`)
    .join("\n");
  writeFileSync(harness, `$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
${slotAssignments}
$failStep = ${quotePowerShell(failStep)}
$failureInjected = $false
$moveLog = New-Object "System.Collections.Generic.List[string]"

function Get-SlotName {
    param([Parameter(Mandatory = $true)][string]$Path)
    foreach ($name in @("activeHost", "rollbackHost", "swapHost", "activeMarker", "rollbackMarker", "swapMarker", "activeComponent", "rollbackComponent", "swapComponent")) {
        if ([string](Get-Variable -Name $name -ValueOnly) -eq $Path) { return $name }
    }
    throw "Unexpected test path: $Path"
}

function Move-FixedHostDirectory {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    [void]$moveLog.Add("host:$(Get-SlotName $Source)->$(Get-SlotName $Destination)")
    [IO.Directory]::Move($Source, $Destination)
}

function Move-FixedMarker {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    [void]$moveLog.Add("marker:$(Get-SlotName $Source)->$(Get-SlotName $Destination)")
    if (-not $script:failureInjected -and $failStep -eq "marker" -and $Source -eq $swapMarker -and $Destination -eq $rollbackMarker) {
        $script:failureInjected = $true
        throw "Injected marker move failure."
    }
    [IO.File]::Move($Source, $Destination)
}

function Move-FixedComponentDirectory {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    [void]$moveLog.Add("component:$(Get-SlotName $Source)->$(Get-SlotName $Destination)")
    if (-not $script:failureInjected -and $failStep -eq "component" -and $Source -eq $swapComponent -and $Destination -eq $rollbackComponent) {
        $script:failureInjected = $true
        throw "Injected component move failure."
    }
    [IO.Directory]::Move($Source, $Destination)
}

function Get-DirectoryVersion {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-Content -LiteralPath (Join-Path $Path "version.txt") -Raw).Trim()
}

function Test-AntiCodexHost {
    param([Parameter(Mandatory = $true)][string]$HostRoot, [Parameter(Mandatory = $true)][string]$MarkerPath)
    if ((Get-DirectoryVersion $HostRoot) -ne (Get-Content -LiteralPath $MarkerPath -Raw).Trim()) {
        throw "Injected fixture host and marker versions differ."
    }
}

function Test-AntiCodexComponent {
    param([Parameter(Mandatory = $true)][string]$ComponentRoot)
    [void](Get-DirectoryVersion $ComponentRoot)
}

${commit}
${restore}

$caught = $null
try {
    Commit-AntiCodexRollbackCheckpoint
} catch {
    $caught = $_.Exception.Message
    Restore-OriginalActiveRelease
}
if (-not $caught -or -not $failureInjected) { throw "The requested commit failure was not injected." }

[ordered]@{
    caught = $caught
    moves = @($moveLog)
    activeHost = Get-DirectoryVersion $activeHost
    activeMarker = (Get-Content -LiteralPath $activeMarker -Raw).Trim()
    activeComponent = Get-DirectoryVersion $activeComponent
    rollbackHost = Get-DirectoryVersion $rollbackHost
    rollbackMarker = (Get-Content -LiteralPath $rollbackMarker -Raw).Trim()
    rollbackComponent = Get-DirectoryVersion $rollbackComponent
    swapHostExists = [IO.Directory]::Exists($swapHost)
    swapMarkerExists = [IO.File]::Exists($swapMarker)
    swapComponentExists = [IO.Directory]::Exists($swapComponent)
} | ConvertTo-Json -Depth 5 -Compress
`);
  return { fixture, harness };
}

function runRollbackCommitFailure(failStep) {
  const fixture = createRollbackCommitFailureFixture(failStep);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture.harness],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  const output = result.status === 0 ? JSON.parse(result.stdout.trim()) : null;
  return { ...fixture, result, output };
}

function assertOriginalReleasePairRestored(output) {
  assert.equal(output.activeHost, "current");
  assert.equal(output.activeMarker, "current");
  assert.equal(output.activeComponent, "current");
  assert.equal(output.rollbackHost, "previous");
  assert.equal(output.rollbackMarker, "previous");
  assert.equal(output.rollbackComponent, "previous");
  assert.equal(output.swapHostExists, false);
  assert.equal(output.swapMarkerExists, false);
  assert.equal(output.swapComponentExists, false);
}

test("rollback host validation covers Anti-Codex branding, icons, manifest, hashes, and critical patches", () => {
  const installer = readRuntimeScript("install-anticodex.ps1");
  const rollback = readRollbackScript();
  const validator = extractFunction(rollback, "Test-AntiCodexHost");
  const installerCriticalPatches = installer.match(/\$fixedShellCriticalPatches\s*=\s*@\([\s\S]*?\n\)/)?.[0] ?? "";

  assert.match(installerCriticalPatches, /"config-write"/);
  assert.match(installerCriticalPatches, /"app-server-managed-session-flags"/);
  assert.match(installerCriticalPatches, /"settings-external-links"/);
  assert.match(validator, /anticodex-host-manifest-v2/);
  assert.match(validator, /fixed-shell-v1/);
  assert.doesNotMatch(validator, /anticodex-host-manifest-v1|legacy-full/);
  assert.match(validator, /criticalPatches/);
  assert.match(validator, /hostPatchRevision/);
  assert.match(validator, /currentHostPatchRevision/);
  assert.match(validator, /legacyHostPatchRevision/);
  assert.match(validator, /expectedCriticalPatches/);
  assert.match(validator, /previousCriticalPatches/);
  assert.match(validator, /legacyWithoutConfigWriteCriticalPatches/);
  const previousCriticalPatches = validator.match(
    /\$previousCriticalPatches\s*=\s*@\(([\s\S]*?)\n\s*\)/,
  )?.[1] ?? "";
  const legacyWithoutConfigWriteCriticalPatches = validator.match(
    /\$legacyWithoutConfigWriteCriticalPatches\s*=\s*@\(([\s\S]*?)\n\s*\)/,
  )?.[1] ?? "";
  assert.doesNotMatch(previousCriticalPatches, /expectedCriticalPatches|Where-Object/);
  assert.match(previousCriticalPatches, /"config-write"/);
  assert.doesNotMatch(previousCriticalPatches, /app-server-managed-session-flags|settings-external-links/);
  assert.doesNotMatch(legacyWithoutConfigWriteCriticalPatches, /expectedCriticalPatches|Where-Object|config-write|app-server-managed-session-flags|settings-external-links/);
  assert.match(validator, /currentManifestCompatible/);
  assert.match(validator, /revision2To4ManifestCompatible/);
  assert.match(validator, /previousManifestCompatible/);
  assert.match(validator, /legacyWithoutConfigWriteManifestCompatible/);
  assert.doesNotMatch(validator, /legacyCurrentManifestCompatible/);
  assert.match(validator, /if\s*\(\$currentManifestCompatible\)\s*\{/);
  assert.match(validator, /elseif\s*\(\$revision2To4ManifestCompatible\)\s*\{/);
  assert.match(validator, /Test-AntiCodexAsarPatches/);
  const asarValidator = extractFunction(rollback, "Test-AntiCodexAsarPatches");
  for (const marker of [
    "AntiCodex",
    "icon:`icon.ico`",
    "__ANTICODEX_OPEN_MANAGER__",
    "\\u7ba1\\u7406",
  ]) {
    assert.match(asarValidator, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(asarValidator, /appNameDirectCount/);
  assert.match(asarValidator, /productNameMapperPattern/);
  assert.match(asarValidator, /\(\$appNameDirectCount \+ \$productNameMapperCount\) -ne 1/);
  assert.doesNotMatch(asarValidator, /legacyRequiredMarkers|authMethod:`apikey`|requiresAuth:!1|marketplaces:\[\]/);
  assert.match(asarValidator, /fixed shell host contains a retired feature patch/i);
  assert.match(asarValidator, /configWriteBridgePattern/);
  assert.match(asarValidator, /\$configWriteBridgePattern\)\.Count -ne \$ExpectedConfigWriteBridgeCount/);
  for (const patchName of [
    "package-json",
    "webview-html-title",
    "app-name",
    "app-user-model-id",
    "session-title",
    "startup-mcp-config-reload",
    "app-server-managed-session-flags",
    "config-write",
    "auth-requirement",
    "app-route-gate",
    "profile-dropdown-settings",
    "settings-external-links",
    "browser-window-icon",
    "primary-window-restore-repaint",
    "windows-tray-icon",
    "local-model-availability",
  ]) {
    assert.match(validator, new RegExp(`"${patchName}"`));
  }
  assert.match(asarValidator, /\[int\]\$ExpectedPrimaryWindowDeferredRestoreRepaintCount/);
  assert.match(asarValidator, /\[int\]\$ExpectedPrimaryWindowFocusRestoreRepaintCount/);
  assert.match(asarValidator, /\[int\]\$ExpectedLegacyPrimaryWindowRestoreRepaintCount/);
  assert.match(asarValidator, /primaryFocusRestoreRepaintPattern/);
  assert.match(asarValidator, /primaryDeferredRestoreRepaintPattern/);
  assert.match(asarValidator, /\$primaryDeferredRestoreRepaintPattern\)\.Count -ne \$ExpectedPrimaryWindowDeferredRestoreRepaintCount/);
  assert.match(asarValidator, /\$primaryFocusRestoreRepaintPattern\)\.Count -ne \$ExpectedPrimaryWindowFocusRestoreRepaintCount/);
  assert.match(asarValidator, /anyPrimaryWindowRepaintPattern/);
  assert.match(asarValidator, /\$anyPrimaryWindowRepaintPattern\)\.Count -ne \(\$ExpectedPrimaryWindowDeferredRestoreRepaintCount \+ \$ExpectedPrimaryWindowFocusRestoreRepaintCount \+ \$ExpectedLegacyPrimaryWindowRestoreRepaintCount\)/);
  assert.match(validator, /-ExpectedPrimaryWindowDeferredRestoreRepaintCount 1[\s\S]*?-ExpectedPrimaryWindowFocusRestoreRepaintCount 0[\s\S]*?-ExpectedLegacyPrimaryWindowRestoreRepaintCount 0/);
  assert.match(validator, /-ExpectedPrimaryWindowDeferredRestoreRepaintCount 0[\s\S]*?-ExpectedPrimaryWindowFocusRestoreRepaintCount 1[\s\S]*?-ExpectedLegacyPrimaryWindowRestoreRepaintCount 0/);
  assert.match(validator, /resources\\codex-tray\.ico/);
  assert.match(validator, /trayIcon/);
  assert.match(validator, /Get-AntiCodexSha256/);
  assert.doesNotMatch(rollback, /\bGet-FileHash\b/);
  assert.match(validator, /manifest\.files\.\$name/);
  assert.match(validator, /manifest\.source\.codexHost/);
  assert.match(validator, /manifest\.source\.codexCli/);
  assert.match(validator, /Test-AntiCodexIconPalette/);
  assert.match(validator, /asarIntegrity/);
  assert.match(validator, /electron-asar-integrity-host\.mjs/);
  assert.match(validator, /isolated ASAR integrity hash/);
  assert.match(validator, /required\.antiCodexExe/);
  assert.match(validator, /required\.codexHost/);
  assert.match(validator, /Anti-Codex\.exe/);
  assert.match(validator, /Anti-Codex/);
});

test("rollback patch compatibility accepts the current and supported predecessor matrices", () => {
  const rollback = readRollbackScript();
  const asarValidator = extractFunction(rollback, "Test-AntiCodexAsarPatches");
  const patchSetValidator = extractFunction(rollback, "Test-AntiCodexCriticalPatchSet");
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-rollback-patch-matrix-"));
  try {
    const base = [
      ".app.name=`Anti-Codex`",
      "AntiCodex",
      "icon:`icon.ico`",
      "__ANTICODEX_OPEN_MANAGER__",
      "\\u7ba1\\u7406",
      "codex-tray.ico codex-tray.ico codex-tray.ico codex-tray.ico",
    ].join(";");
    const productNameMapper = 'function yT(e){let t=vT(e);return t?`Anti-Codex (${t})`:`Anti-Codex`}';
    const configWriteBridge = '"batch-write-config-value":e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(`config/batchWrite`,e)';
    const officialTrayGuid = "e5768d8b-6936-4f45-b1ad-4c5fb414cb35";
    const antiCodexTrayGuid = "a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3";
    const currentBase = `${base};${antiCodexTrayGuid}`;
    const predecessorBase = `${base};${officialTrayGuid}`;
    const patchedBase = `${currentBase};${configWriteBridge}`;
    const predecessorPatchedBase = `${predecessorBase};${configWriteBridge}`;
    const currentSettingsPatch = 'q={/*anticodex-local-settings-only*/account:{href:`about:blank`,icon:a,message:m.account},securitySettings:{href:`about:blank`,icon:b,message:m.securitySettings}};/*anticodex-hide-external-account*/null;(0,Q.jsx)(Zt,{...e,securitySettingsEnabled:0});Z.securitySettings.message';
    const paddedCurrentSettingsPatch = currentSettingsPatch.replace("securitySettingsEnabled:0}", "securitySettingsEnabled:0          }");
    const missingAccountMessagePatch = currentSettingsPatch.replace("message:m.account", "missing:m.account");
    const missingSecurityMessagePatch = currentSettingsPatch.replace("message:m.securitySettings", "missing:m.securitySettings");
    const previousSettingsPatch = 'q={/*anticodex-local-settings-only*/};Z.securitySettings.message';
    const genericErrorOriginal = 'id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`};id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`}';
    const crashRecoveryPatch = `function C(e){let {fatalError:n,onReset:R}=e;id:\`appServerCrash.title\`,defaultMessage:\`{appName} stopped unexpectedly\`,values:{appName:\`Anti-Codex\`};id:\`appServerCrash.description\`,defaultMessage:\`Restart {appName} to continue. If the problem persists, check your configuration or visit the {documentationLink}\`,values:{appName:\`Anti-Codex\`,documentationLink:x};let d;d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:\`loadingPage.openConfigToml\`,defaultMessage:\`Open Config.toml\`})});let f;f=(0,j.jsx)(Z,{id:\`appServerCrash.restart\`,defaultMessage:\`Restart\`});let p;p=(0,j.jsx)(B,{onClick:R,children:f});/*anticodex-crash-recovery-actions*/children:[d,p]}function O(){return D.dispatchMessage(\`open-config-toml\`,{})}function G(e){let {resetError:n}=e,r=M();id:\`codex.errorBoundary.genericError\`,defaultMessage:\`Oops, an error has occurred\`};let s;s=()=>{n(),r(\`/\`)};let c;c=(0,j.jsx)(Z,{id:\`codex.errorBoundary.goHome\`,defaultMessage:\`Try again\`});/*anticodex-generic-error-actions*/children:[(0,j.jsx)(B,{onClick:s,children:c})]}var R,z,J;${genericErrorOriginal}`;
    const crashRecoveryV2 = `function C(e){let{fatalError:n,onReset:r}=e;id:\`appServerCrash.recoveryTitle\`,defaultMessage:\`Anti-Codex hit a snag\`};id:\`appServerCrash.configurationRecoveryDescription\`,defaultMessage:\`Anti-Codex couldn't load your configuration. Review it, then restart to try again.\`};id:\`appServerCrash.recoveryDescription\`,defaultMessage:\`Something went wrong. Restart Anti-Codex to try again.\`};let p;p=(0,j.jsx)(Z,{id:\`appServerCrash.restartChatGPT\`,defaultMessage:\`Restart Anti-Codex\`});let m;m=(0,j.jsx)(B,{onClick:r,children:p});let h;h=(0,j.jsx)(B,{onClick:F,children:(0,j.jsx)(Z,{id:\`appServerCrash.sendFeedback\`})});let g;g=(0,j.jsx)(B,{onClick:L,children:(0,j.jsx)(Z,{id:\`appServerCrash.reviewConfiguration\`})});let _;_=(0,j.jsx)(j.Fragment,{children:(0,j.jsx)(U,{hideUnavailable:!0})});/*anticodex-crash-recovery-actions-v2*/children:[m,h,g]}function L(){return D.dispatchMessage(\`open-config-toml\`,{})}function G(e){let {resetError:n}=e,r=M();id:\`codex.errorBoundary.genericError\`,defaultMessage:\`Oops, an error has occurred\`};let s;s=()=>{n(),r(\`/\`)};let c;c=(0,j.jsx)(Z,{id:\`codex.errorBoundary.goHome\`,defaultMessage:\`Try again\`});/*anticodex-generic-error-actions*/children:[(0,j.jsx)(B,{onClick:s,children:c})]}var R,z,J;${genericErrorOriginal}`;
    const legacyOriginalFragment = 'id:`appServerCrash.title`,defaultMessage:`{appName} stopped unexpectedly`,description:`title`,values:{appName:X};id:`appServerCrash.description`,defaultMessage:`Restart {appName} to continue. If the problem persists, check your configuration or visit the {documentationLink}`,description:`description`,values:{appName:X,documentationLink:x}';
    const v2OriginalFragment = 'id:`appServerCrash.recoveryTitle`,defaultMessage:`ChatGPT hit a snag`,description:`title`};id:`appServerCrash.configurationRecoveryDescription`,defaultMessage:`ChatGPT couldn\'t load your configuration. Review it, then restart to try again.`,description:`config`};id:`appServerCrash.recoveryDescription`,defaultMessage:`Something went wrong. Restart ChatGPT to try again.`,description:`description`};id:`appServerCrash.restartChatGPT`,defaultMessage:`Restart ChatGPT`,description:`restart`}';
    const crashRecoveryConfigHandlerSwap = crashRecoveryPatch.replace("onClick:O,children:", "onClick:U,children:");
    const crashRecoveryMemoPatch = crashRecoveryPatch
      .replace('let d;d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`,defaultMessage:`Open Config.toml`})});', 'let d;t[6]===n.hostId?d=t[7]:(d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`,defaultMessage:`Open Config.toml`})}),t[6]=n.hostId,t[7]=d);')
      .replace('let p;p=(0,j.jsx)(B,{onClick:R,children:f});', 'let p;t[9]===R?p=t[10]:(p=(0,j.jsx)(B,{onClick:R,children:f}),t[9]=R,t[10]=p);')
      .replace('let s;s=()=>{n(),r(`/`)};', 'let s;t[3]!==r||t[4]!==n?(s=()=>{n(),r(`/`)},t[3]=r,t[4]=n,t[5]=s):s=t[5];');
    const crashRecoveryRestartHandlerSwap = crashRecoveryPatch.replace("onClick:R,children:f", "onClick:U,children:f");
    const genericRetryHandlerSwap = crashRecoveryPatch.replace("onClick:s,children:c", "onClick:U,children:c");
    const crashRecoveryConfigHandlerReassign = crashRecoveryPatch.replace("/*anticodex-crash-recovery-actions*/", "d=(0,j.jsx)(B,{onClick:U,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`,defaultMessage:`Open Config.toml`})});/*anticodex-crash-recovery-actions*/");
    const crashRecoveryRestartHandlerReassign = crashRecoveryPatch.replace("/*anticodex-crash-recovery-actions*/", "p=(0,j.jsx)(B,{onClick:U,children:f});/*anticodex-crash-recovery-actions*/");
    const genericRetryHandlerReassign = crashRecoveryPatch.replace("/*anticodex-generic-error-actions*/", "s=U;/*anticodex-generic-error-actions*/");
    const crashRecoveryConfigCacheDecoy = crashRecoveryPatch.replace("/*anticodex-crash-recovery-actions*/", "d=t[99];t[99]=d;/*anticodex-crash-recovery-actions*/");
    const crashRecoveryRestartCacheDecoy = crashRecoveryPatch.replace("/*anticodex-crash-recovery-actions*/", "p=t[99];t[99]=p;/*anticodex-crash-recovery-actions*/");
    const genericRetryCacheDecoy = crashRecoveryPatch.replace("/*anticodex-generic-error-actions*/", "s=t[99];t[99]=s;/*anticodex-generic-error-actions*/");
    const crashRecoveryConfigCompoundWriteDecoy = crashRecoveryPatch.replace("/*anticodex-crash-recovery-actions*/", "d&&=U;/*anticodex-crash-recovery-actions*/");
    const crashRecoveryRestartCompoundWriteDecoy = crashRecoveryPatch.replace("/*anticodex-crash-recovery-actions*/", "p&&=U;/*anticodex-crash-recovery-actions*/");
    const genericRetryCompoundWriteDecoy = crashRecoveryPatch.replace("/*anticodex-generic-error-actions*/", "s&&=U;/*anticodex-generic-error-actions*/");
    const crashRecoveryConfigDestructureWriteDecoy = crashRecoveryPatch.replace("/*anticodex-crash-recovery-actions*/", "[d]=[U];/*anticodex-crash-recovery-actions*/");
    const genericRetryForOfWriteDecoy = crashRecoveryPatch.replace("/*anticodex-generic-error-actions*/", "for(s of q){}/*anticodex-generic-error-actions*/");
    const crashRecoveryConfigThunkDecoy = crashRecoveryPatch.replace('let d;d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`,defaultMessage:`Open Config.toml`})});', 'let d;x?d=t[99]:(()=>{d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`,defaultMessage:`Open Config.toml`})});t[99]=d});');
    const crashRecoveryRestartThunkDecoy = crashRecoveryPatch.replace('let p;p=(0,j.jsx)(B,{onClick:R,children:f});', 'let p;x?p=t[99]:(()=>{p=(0,j.jsx)(B,{onClick:R,children:f});t[99]=p});');
    const genericRetryThunkDecoy = crashRecoveryPatch.replace('let s;s=()=>{n(),r(`/`)};', 'let s;x?s=t[99]:(()=>{s=()=>{n(),r(`/`)};t[99]=s});');
    const crashRecoveryOriginal = `id:\`appServerCrash.title\`,defaultMessage:\`{appName} stopped unexpectedly\`,description:\`title\`,values:{appName:X};id:\`appServerCrash.description\`,defaultMessage:\`Restart {appName} to continue. If the problem persists, check your configuration or visit the {documentationLink}\`,description:\`description\`,values:{appName:X,documentationLink:x};${genericErrorOriginal};${genericErrorOriginal}`;
    const revision2Hook = "trackPrimaryWindow(e){let t=()=>this.primaryWindowLastActiveAtMs.set(e,Date.now()),n=()=>{try{e.webContents.invalidate()}catch{}};this.primaryWindows.add(e),e.isFocused()?(this.lastActivePrimaryWindow=e,t()):this.lastActivePrimaryWindow??=e,this.emitPrimaryWindowChangeIfNeeded(),e.on(`focus`,()=>{this.lastActivePrimaryWindow=e,t(),this.emitPrimaryWindowChangeIfNeeded(),n()}),e.on(`blur`,t),e.on(`restore`,()=>setImmediate(n))}";
    const hook = revision2Hook.replace(",n()", "");
    const officialTracker = "trackPrimaryWindow(e){this.primaryWindows.add(e),e.isFocused()?(this.lastActivePrimaryWindow=e,this.primaryWindowLastActiveAtMs.set(e,Date.now())):this.lastActivePrimaryWindow??=e,this.emitPrimaryWindowChangeIfNeeded(),e.on(`focus`,()=>{this.lastActivePrimaryWindow=e,this.primaryWindowLastActiveAtMs.set(e,Date.now()),this.emitPrimaryWindowChangeIfNeeded()}),e.on(`blur`,()=>{this.primaryWindowLastActiveAtMs.set(e,Date.now())})}";
    const currentV2Base = `${patchedBase.replace(".app.name=`Anti-Codex`", productNameMapper)};${officialTracker};${currentSettingsPatch};${crashRecoveryV2}`;
    const focusOnlyHook = revision2Hook.replace(",e.on(`restore`,()=>setImmediate(n))", "");
    const legacyRestoreOnlyHook = "trackPrimaryWindow(e){let t=()=>this.primaryWindowLastActiveAtMs.set(e,Date.now());this.primaryWindows.add(e),e.isFocused()?(this.lastActivePrimaryWindow=e,t()):this.lastActivePrimaryWindow??=e,this.emitPrimaryWindowChangeIfNeeded(),e.on(`focus`,()=>{this.lastActivePrimaryWindow=e,t(),this.emitPrimaryWindowChangeIfNeeded()}),e.on(`blur`,t),e.on(`restore`,()=>e.webContents.invalidate?.())}";
    const paths = {
      zero: join(fixture, "zero.asar"),
      one: join(fixture, "one.asar"),
      two: join(fixture, "two.asar"),
      revision5: join(fixture, "revision5.asar"),
      revision2: join(fixture, "revision2.asar"),
      focusOnly: join(fixture, "focus-only.asar"),
      splitCross: join(fixture, "split-cross.asar"),
      legacyRestoreOnly: join(fixture, "legacy-restore-only.asar"),
      missingConfigBridge: join(fixture, "missing-config-bridge.asar"),
      currentMissingConfigBridge: join(fixture, "current-missing-config-bridge.asar"),
      duplicateConfigBridge: join(fixture, "duplicate-config-bridge.asar"),
      currentSettings: join(fixture, "current-settings.asar"),
      paddedCurrentSettings: join(fixture, "padded-current-settings.asar"),
      missingAccountMessage: join(fixture, "missing-account-message.asar"),
      missingSecurityMessage: join(fixture, "missing-security-message.asar"),
      previousSettings: join(fixture, "previous-settings.asar"),
      currentMissingCrash: join(fixture, "current-missing-crash.asar"),
      currentWithOriginalCrash: join(fixture, "current-with-original-crash.asar"),
      revision4PartialCrash: join(fixture, "revision4-partial-crash.asar"),
      currentConfigHandlerSwap: join(fixture, "current-config-handler-swap.asar"),
      currentMemoHandlers: join(fixture, "current-memo-handlers.asar"),
      currentRestartHandlerSwap: join(fixture, "current-restart-handler-swap.asar"),
      currentGenericRetryHandlerSwap: join(fixture, "current-generic-retry-handler-swap.asar"),
      currentConfigHandlerReassign: join(fixture, "current-config-handler-reassign.asar"),
      currentRestartHandlerReassign: join(fixture, "current-restart-handler-reassign.asar"),
      currentGenericRetryHandlerReassign: join(fixture, "current-generic-retry-handler-reassign.asar"),
      currentConfigCacheDecoy: join(fixture, "current-config-cache-decoy.asar"),
      currentRestartCacheDecoy: join(fixture, "current-restart-cache-decoy.asar"),
      currentGenericRetryCacheDecoy: join(fixture, "current-generic-retry-cache-decoy.asar"),
      currentConfigCompoundWriteDecoy: join(fixture, "current-config-compound-write-decoy.asar"),
      currentRestartCompoundWriteDecoy: join(fixture, "current-restart-compound-write-decoy.asar"),
      currentGenericRetryCompoundWriteDecoy: join(fixture, "current-generic-retry-compound-write-decoy.asar"),
      currentConfigDestructureWriteDecoy: join(fixture, "current-config-destructure-write-decoy.asar"),
      currentGenericRetryForOfWriteDecoy: join(fixture, "current-generic-retry-for-of-write-decoy.asar"),
      currentConfigThunkDecoy: join(fixture, "current-config-thunk-decoy.asar"),
      currentRestartThunkDecoy: join(fixture, "current-restart-thunk-decoy.asar"),
      currentGenericRetryThunkDecoy: join(fixture, "current-generic-retry-thunk-decoy.asar"),
      currentV2: join(fixture, "current-v2.asar"),
      currentV2MissingProductName: join(fixture, "current-v2-missing-product-name.asar"),
      currentV2UpdaterDecoy: join(fixture, "current-v2-updater-decoy.asar"),
      currentV2RestartHandlerSwap: join(fixture, "current-v2-restart-handler-swap.asar"),
      currentV2ConfigHandlerSwap: join(fixture, "current-v2-config-handler-swap.asar"),
      currentLegacyWithV2Original: join(fixture, "current-legacy-with-v2-original.asar"),
      currentV2WithLegacyOriginal: join(fixture, "current-v2-with-legacy-original.asar"),
    };
    writeFileSync(paths.zero, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.one, `${patchedBase};${hook};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.two, `${patchedBase};${hook};${hook};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.revision5, `${predecessorPatchedBase};${hook};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.revision2, `${predecessorPatchedBase};${revision2Hook};${currentSettingsPatch};${crashRecoveryOriginal}`);
    writeFileSync(paths.focusOnly, `${patchedBase};${officialTracker};${focusOnlyHook};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.splitCross, `${patchedBase};${officialTracker};${focusOnlyHook};${hook};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.legacyRestoreOnly, `${patchedBase};${legacyRestoreOnlyHook}`);
    writeFileSync(paths.missingConfigBridge, `${base};${revision2Hook}`);
    writeFileSync(paths.currentMissingConfigBridge, `${base};${antiCodexTrayGuid};${officialTracker};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.duplicateConfigBridge, `${patchedBase};${configWriteBridge};${officialTracker};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.currentSettings, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.paddedCurrentSettings, `${patchedBase};${officialTracker};${paddedCurrentSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.missingAccountMessage, `${patchedBase};${officialTracker};${missingAccountMessagePatch};${crashRecoveryPatch}`);
    writeFileSync(paths.missingSecurityMessage, `${patchedBase};${officialTracker};${missingSecurityMessagePatch};${crashRecoveryPatch}`);
    writeFileSync(paths.previousSettings, `${patchedBase};${officialTracker};${previousSettingsPatch};${crashRecoveryPatch}`);
    writeFileSync(paths.currentMissingCrash, `${patchedBase};${officialTracker};${currentSettingsPatch}`);
    writeFileSync(paths.currentWithOriginalCrash, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryPatch};${crashRecoveryOriginal}`);
    writeFileSync(paths.revision4PartialCrash, `${predecessorPatchedBase};${hook};${currentSettingsPatch};${crashRecoveryOriginal.replace('id:`appServerCrash.title`,defaultMessage:`{appName} stopped unexpectedly`,description:`title`,values:{appName:X}', 'id:`appServerCrash.title`,defaultMessage:`{appName} stopped unexpectedly`,values:{appName:`Anti-Codex`}')}`);
    writeFileSync(paths.currentConfigHandlerSwap, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryConfigHandlerSwap}`);
    writeFileSync(paths.currentMemoHandlers, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryMemoPatch}`);
    writeFileSync(paths.currentRestartHandlerSwap, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryRestartHandlerSwap}`);
    writeFileSync(paths.currentGenericRetryHandlerSwap, `${patchedBase};${officialTracker};${currentSettingsPatch};${genericRetryHandlerSwap}`);
    writeFileSync(paths.currentConfigHandlerReassign, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryConfigHandlerReassign}`);
    writeFileSync(paths.currentRestartHandlerReassign, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryRestartHandlerReassign}`);
    writeFileSync(paths.currentGenericRetryHandlerReassign, `${patchedBase};${officialTracker};${currentSettingsPatch};${genericRetryHandlerReassign}`);
    writeFileSync(paths.currentConfigCacheDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryConfigCacheDecoy}`);
    writeFileSync(paths.currentRestartCacheDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryRestartCacheDecoy}`);
    writeFileSync(paths.currentGenericRetryCacheDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${genericRetryCacheDecoy}`);
    writeFileSync(paths.currentConfigCompoundWriteDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryConfigCompoundWriteDecoy}`);
    writeFileSync(paths.currentRestartCompoundWriteDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryRestartCompoundWriteDecoy}`);
    writeFileSync(paths.currentGenericRetryCompoundWriteDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${genericRetryCompoundWriteDecoy}`);
    writeFileSync(paths.currentConfigDestructureWriteDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryConfigDestructureWriteDecoy}`);
    writeFileSync(paths.currentGenericRetryForOfWriteDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${genericRetryForOfWriteDecoy}`);
    writeFileSync(paths.currentConfigThunkDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryConfigThunkDecoy}`);
    writeFileSync(paths.currentRestartThunkDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryRestartThunkDecoy}`);
    writeFileSync(paths.currentGenericRetryThunkDecoy, `${patchedBase};${officialTracker};${currentSettingsPatch};${genericRetryThunkDecoy}`);
    writeFileSync(paths.currentV2, currentV2Base);
    writeFileSync(paths.currentV2MissingProductName, currentV2Base.replace(productNameMapper, "function yT(e){return `ChatGPT`}"));
    writeFileSync(paths.currentV2UpdaterDecoy, currentV2Base.replace("/*anticodex-crash-recovery-actions-v2*/", "children:[m,h,g,_];/*anticodex-crash-recovery-actions-v2*/"));
    writeFileSync(paths.currentV2RestartHandlerSwap, currentV2Base.replace("onClick:r,children:p", "onClick:U,children:p"));
    writeFileSync(paths.currentV2ConfigHandlerSwap, currentV2Base.replace("onClick:L,children:", "onClick:U,children:"));
    writeFileSync(paths.currentLegacyWithV2Original, `${patchedBase};${officialTracker};${currentSettingsPatch};${crashRecoveryPatch};${v2OriginalFragment}`);
    writeFileSync(paths.currentV2WithLegacyOriginal, `${currentV2Base};${legacyOriginalFragment}`);
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const harness = join(fixture, "matrix.ps1");
    writeFileSync(harness, `$ErrorActionPreference = "Stop"
${extractFunction(rollback, "Test-AntiCodexCrashRecoveryV3")}
${asarValidator}
${patchSetValidator}
function Accept-Asar([string]$Path, [int]$ExpectedConfigWrite, [int]$ExpectedDeferred, [int]$ExpectedFocusRestore, [int]$ExpectedLegacyRestore, [int]$ExpectedHostPatchRevision = 0) {
    try {
        Test-AntiCodexAsarPatches -Path $Path -PatchProfile "fixed-shell-v1" -ExpectedConfigWriteBridgeCount $ExpectedConfigWrite -ExpectedPrimaryWindowDeferredRestoreRepaintCount $ExpectedDeferred -ExpectedPrimaryWindowFocusRestoreRepaintCount $ExpectedFocusRestore -ExpectedLegacyPrimaryWindowRestoreRepaintCount $ExpectedLegacyRestore -ExpectedHostPatchRevision $ExpectedHostPatchRevision
        return $true
    } catch {
        return $false
    }
}

function Get-AsarError([string]$Path, [int]$ExpectedConfigWrite, [int]$ExpectedDeferred, [int]$ExpectedFocusRestore, [int]$ExpectedLegacyRestore, [int]$ExpectedHostPatchRevision = 0) {
    try {
        Test-AntiCodexAsarPatches -Path $Path -PatchProfile "fixed-shell-v1" -ExpectedConfigWriteBridgeCount $ExpectedConfigWrite -ExpectedPrimaryWindowDeferredRestoreRepaintCount $ExpectedDeferred -ExpectedPrimaryWindowFocusRestoreRepaintCount $ExpectedFocusRestore -ExpectedLegacyPrimaryWindowRestoreRepaintCount $ExpectedLegacyRestore -ExpectedHostPatchRevision $ExpectedHostPatchRevision
        return ""
    } catch {
        return [string]$_.Exception.Message
    }
}
$current = @("package-json","webview-html-title","app-name","app-user-model-id","session-title","startup-mcp-config-reload","app-server-managed-session-flags","config-write","auth-requirement","app-route-gate","profile-dropdown-settings","settings-external-links","crash-recovery-page","browser-window-icon","windows-tray-icon","local-model-availability")
$revision6 = @($current + "primary-window-restore-repaint")
$revision4 = @($revision6 | Where-Object { $_ -ne "crash-recovery-page" })
$previous = @($revision4 | Where-Object { $_ -notin @("app-server-managed-session-flags", "settings-external-links") })
$legacyWithoutConfigWrite = @($revision4 | Where-Object { $_ -notin @("app-server-managed-session-flags", "config-write", "settings-external-links") })
[pscustomobject]@{
    currentOfficial = Accept-Asar ${quote(paths.zero)} 1 0 0 0 7
    revision6Hook = Accept-Asar ${quote(paths.one)} 1 1 0 0 6
    revision6MissingHook = Accept-Asar ${quote(paths.zero)} 1 1 0 0 6
    currentUnexpectedHook = Accept-Asar ${quote(paths.one)} 1 0 0 0 7
    currentDuplicateHook = Accept-Asar ${quote(paths.two)} 1 0 0 0 7
    revision5Hook = Accept-Asar ${quote(paths.revision5)} 1 1 0 0 5
    currentRevision2Hook = Accept-Asar ${quote(paths.revision2)} 1 0 0 0 7
    currentMissingCrash = Accept-Asar ${quote(paths.currentMissingCrash)} 1 0 0 0 7
    currentWithOriginalCrash = Accept-Asar ${quote(paths.currentWithOriginalCrash)} 1 0 0 0 7
    revision4PartialCrash = Accept-Asar ${quote(paths.revision4PartialCrash)} 1 1 0 0 4
    currentConfigHandlerSwap = Accept-Asar ${quote(paths.currentConfigHandlerSwap)} 1 0 0 0 7
    currentMemoHandlers = Accept-Asar ${quote(paths.currentMemoHandlers)} 1 0 0 0 7
    currentRestartHandlerSwap = Accept-Asar ${quote(paths.currentRestartHandlerSwap)} 1 0 0 0 7
    currentGenericRetryHandlerSwap = Accept-Asar ${quote(paths.currentGenericRetryHandlerSwap)} 1 0 0 0 7
    currentConfigHandlerReassign = Accept-Asar ${quote(paths.currentConfigHandlerReassign)} 1 0 0 0 7
    currentRestartHandlerReassign = Accept-Asar ${quote(paths.currentRestartHandlerReassign)} 1 0 0 0 7
    currentGenericRetryHandlerReassign = Accept-Asar ${quote(paths.currentGenericRetryHandlerReassign)} 1 0 0 0 7
    currentConfigCacheDecoy = Accept-Asar ${quote(paths.currentConfigCacheDecoy)} 1 0 0 0 7
    currentRestartCacheDecoy = Accept-Asar ${quote(paths.currentRestartCacheDecoy)} 1 0 0 0 7
    currentGenericRetryCacheDecoy = Accept-Asar ${quote(paths.currentGenericRetryCacheDecoy)} 1 0 0 0 7
    currentConfigCompoundWriteDecoy = Accept-Asar ${quote(paths.currentConfigCompoundWriteDecoy)} 1 0 0 0 7
    currentRestartCompoundWriteDecoy = Accept-Asar ${quote(paths.currentRestartCompoundWriteDecoy)} 1 0 0 0 7
    currentGenericRetryCompoundWriteDecoy = Accept-Asar ${quote(paths.currentGenericRetryCompoundWriteDecoy)} 1 0 0 0 7
    currentConfigDestructureWriteDecoy = Accept-Asar ${quote(paths.currentConfigDestructureWriteDecoy)} 1 0 0 0 7
    currentGenericRetryForOfWriteDecoy = Accept-Asar ${quote(paths.currentGenericRetryForOfWriteDecoy)} 1 0 0 0 7
    currentConfigThunkDecoy = Accept-Asar ${quote(paths.currentConfigThunkDecoy)} 1 0 0 0 7
    currentRestartThunkDecoy = Accept-Asar ${quote(paths.currentRestartThunkDecoy)} 1 0 0 0 7
    currentGenericRetryThunkDecoy = Accept-Asar ${quote(paths.currentGenericRetryThunkDecoy)} 1 0 0 0 7
    currentV2 = Accept-Asar ${quote(paths.currentV2)} 1 0 0 0 7
    currentV2Error = Get-AsarError ${quote(paths.currentV2)} 1 0 0 0 7
    currentV2MissingProductName = Accept-Asar ${quote(paths.currentV2MissingProductName)} 1 0 0 0 7
    currentV2UpdaterDecoy = Accept-Asar ${quote(paths.currentV2UpdaterDecoy)} 1 0 0 0 7
    currentV2RestartHandlerSwap = Accept-Asar ${quote(paths.currentV2RestartHandlerSwap)} 1 0 0 0 7
    currentV2ConfigHandlerSwap = Accept-Asar ${quote(paths.currentV2ConfigHandlerSwap)} 1 0 0 0 7
    currentLegacyWithV2Original = Accept-Asar ${quote(paths.currentLegacyWithV2Original)} 1 0 0 0 7
    currentV2WithLegacyOriginal = Accept-Asar ${quote(paths.currentV2WithLegacyOriginal)} 1 0 0 0 7
    revision2Hook = Accept-Asar ${quote(paths.revision2)} 1 0 1 0 2
    revision2RejectsCurrent = Accept-Asar ${quote(paths.one)} 1 0 1 0 2
    currentFocusOnlyHook = Accept-Asar ${quote(paths.focusOnly)} 1 0 0 0 7
    currentSplitCrossHook = Accept-Asar ${quote(paths.splitCross)} 1 0 0 0 7
    currentMissingConfigBridge = Accept-Asar ${quote(paths.currentMissingConfigBridge)} 1 0 0 0 7
    currentDuplicateConfigBridge = Accept-Asar ${quote(paths.duplicateConfigBridge)} 1 0 0 0 7
    currentSettingsRevision = Accept-Asar ${quote(paths.currentSettings)} 1 0 0 0 7
    paddedCurrentSettingsRevision = Accept-Asar ${quote(paths.paddedCurrentSettings)} 1 0 0 0 7
    missingAccountMessageRejected = Accept-Asar ${quote(paths.missingAccountMessage)} 1 0 0 0 7
    missingSecurityMessageRejected = Accept-Asar ${quote(paths.missingSecurityMessage)} 1 0 0 0 7
    previousSettingsRejectedAsCurrent = Accept-Asar ${quote(paths.previousSettings)} 1 0 0 0 7
    legacyWithoutConfigWrite = Accept-Asar ${quote(paths.missingConfigBridge)} 0 0 1 0
    predecessorRejectsCurrent = Accept-Asar ${quote(paths.one)} 0 0 1 0
    previousNoHook = Accept-Asar ${quote(paths.zero)} 0 0 1 0
    previousUnexpectedHook = Accept-Asar ${quote(paths.one)} 0 0 1 0
    previousUnexpectedRevision2Hook = Accept-Asar ${quote(paths.revision2)} 0 0 1 0
    previousUnexpectedFocusOnlyHook = Accept-Asar ${quote(paths.focusOnly)} 0 0 1 0
    currentManifest = Test-AntiCodexCriticalPatchSet -Recorded $current -Expected $current
    previousManifest = Test-AntiCodexCriticalPatchSet -Recorded $previous -Expected $previous
    legacyWithoutConfigWriteManifest = Test-AntiCodexCriticalPatchSet -Recorded $legacyWithoutConfigWrite -Expected $legacyWithoutConfigWrite
    missingManifest = Test-AntiCodexCriticalPatchSet -Recorded @($current | Where-Object { $_ -ne "browser-window-icon" }) -Expected $current
    missingConfigManifest = Test-AntiCodexCriticalPatchSet -Recorded @($current | Where-Object { $_ -ne "config-write" }) -Expected $current
    extraManifest = Test-AntiCodexCriticalPatchSet -Recorded @($previous + "unexpected") -Expected $previous
} | ConvertTo-Json -Compress
`);
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      currentOfficial: true,
      revision6Hook: true,
      revision6MissingHook: false,
      currentUnexpectedHook: false,
      currentDuplicateHook: false,
      revision5Hook: true,
      currentRevision2Hook: false,
      currentMissingCrash: false,
      currentWithOriginalCrash: false,
      revision4PartialCrash: false,
      currentConfigHandlerSwap: false,
      currentMemoHandlers: true,
      currentRestartHandlerSwap: false,
      currentGenericRetryHandlerSwap: false,
      currentConfigHandlerReassign: false,
      currentRestartHandlerReassign: false,
      currentGenericRetryHandlerReassign: false,
      currentConfigCacheDecoy: false,
      currentRestartCacheDecoy: false,
      currentGenericRetryCacheDecoy: false,
      currentConfigCompoundWriteDecoy: false,
      currentRestartCompoundWriteDecoy: false,
      currentGenericRetryCompoundWriteDecoy: false,
      currentConfigDestructureWriteDecoy: false,
      currentGenericRetryForOfWriteDecoy: false,
      currentConfigThunkDecoy: false,
      currentRestartThunkDecoy: false,
      currentGenericRetryThunkDecoy: false,
      currentV2: true,
      currentV2Error: "",
      currentV2MissingProductName: false,
      currentV2UpdaterDecoy: false,
      currentV2RestartHandlerSwap: false,
      currentV2ConfigHandlerSwap: false,
      currentLegacyWithV2Original: false,
      currentV2WithLegacyOriginal: false,
      revision2Hook: true,
      revision2RejectsCurrent: false,
      currentFocusOnlyHook: false,
      currentSplitCrossHook: false,
      currentMissingConfigBridge: false,
      currentDuplicateConfigBridge: false,
      currentSettingsRevision: true,
      paddedCurrentSettingsRevision: true,
      missingAccountMessageRejected: false,
      missingSecurityMessageRejected: false,
      previousSettingsRejectedAsCurrent: false,
      legacyWithoutConfigWrite: true,
      predecessorRejectsCurrent: false,
      previousNoHook: false,
      previousUnexpectedHook: false,
      previousUnexpectedRevision2Hook: false,
      previousUnexpectedFocusOnlyHook: false,
      currentManifest: true,
      previousManifest: true,
      legacyWithoutConfigWriteManifest: true,
      missingManifest: false,
      missingConfigManifest: false,
      extraManifest: false,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("complete rollback host validation maps immutable predecessor matrices to their ASAR contracts", () => {
  const fixture = runRollbackHostPatchMatrix();
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
    assert.deepEqual(JSON.parse(fixture.result.stdout.trim()), {
      current: true,
      revisionSix: true,
      revisionFive: true,
      revision2Current: true,
      legacyCurrent: false,
      revisionOne: false,
      revisionFour: true,
      previous: true,
      legacy: true,
      previousMissingBridge: false,
      fictionalFifteen: false,
      missingRequired: false,
      extra: false,
    });
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("post-sync acceptance uses local health without probing a model provider", () => {
  const acceptance = extractFunction(readSyncScript(), "Invoke-AntiCodexPostSyncAcceptance");

  assert.match(acceptance, /\$health\.modelCount/);
  assert.doesNotMatch(acceptance, /\$baseUrl\/models|\$models\.data/);
});

test("host sync keeps a valid predecessor rollback while using the revisionless current host only for activation recovery", () => {
  const sync = readSyncScript();
  const rollback = readRollbackScript();

  assert.match(sync, /\$legacyCurrentRecoveryOnly/);
  assert.match(sync, /\$activationRecoveryHost/);
  assert.match(sync, /\$activationRecoveryComponent/);
  assert.match(sync, /hostPatchRevision/);
  assert.match(sync, /\$activeCriticalPatchFingerprint\s*=\s*\$activeCriticalPatches\s+-join/);
  assert.match(sync, /\$activeCriticalPatchFingerprint\s+-ceq\s+\$candidateCriticalPatchFingerprint/);
  assert.match(sync, /\[Array\]::Sort\(\$activeCriticalPatches\)/);
  assert.match(sync, /active host patch revision is not current/);
  assert.match(sync, /&\s+\$rollbackScript\s+-ValidateOnly/);
  assert.match(sync, /Move-FixedUpdateDirectory\s+-Source\s+\$activeHost\s+-Destination\s+\$activationRecoveryHost/);
  assert.match(sync, /Move-FixedUpdateDirectory\s+-Source\s+\$activationRecoveryHost\s+-Destination\s+\$activeHost/);
  assert.match(sync, /if\s*\(\$legacyCurrentRecoveryOnly\)[\s\S]*?Restore-ActivationRecoveryRelease\s+-State\s+"prepared"/);
  assert.match(sync, /\$activationRecoveryCleanupPending\s*=\s*-not\s*\(Complete-ActivationRecoveryCleanup\)/);
  assert.ok(
    sync.indexOf("$startupRecoveryState = Get-ActivationRecoveryState") <
      sync.indexOf("& $sourcePreflight -SkipFullRegression") &&
      sync.indexOf("& $sourcePreflight -SkipFullRegression") <
      sync.indexOf("Remove-FixedUpdateDirectory -Path $candidateRoot", sync.indexOf("& $sourcePreflight -SkipFullRegression")),
    "interrupted activation recovery must run before source preflight and candidate cleanup",
  );
  assert.doesNotMatch(rollback, /AllowLegacyCurrent/);
});

test("restored activation reports rollback availability only after validating the live rollback pair", () => {
  const sync = readSyncScript();
  const availability = extractFunction(sync, "Test-AntiCodexRollbackReleaseAvailable");
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-restored-rollback-status-"));
  const rollbackHost = join(fixture, "rollback-host");
  const rollbackComponent = join(fixture, "rollback-component");
  const rollbackMarker = join(fixture, "rollback-host.ok");
  const rollbackValidator = join(fixture, "validate-rollback.ps1");
  const harness = join(fixture, "run.ps1");
  try {
    mkdirSync(rollbackHost, { recursive: true });
    mkdirSync(rollbackComponent, { recursive: true });
    writeFileSync(rollbackMarker, "valid\n");
    writeFileSync(
      rollbackValidator,
      "param([switch]$ValidateOnly)\nif ($env:ANTICODEX_TEST_ROLLBACK_INVALID -eq '1') { throw 'invalid rollback' }\n",
    );
    writeFileSync(harness, `$ErrorActionPreference = 'Stop'
$rollbackHost = ${quotePowerShell(rollbackHost)}
$rollbackComponent = ${quotePowerShell(rollbackComponent)}
$rollbackMarker = ${quotePowerShell(rollbackMarker)}
$rollbackScript = ${quotePowerShell(rollbackValidator)}
${availability}
$valid = Test-AntiCodexRollbackReleaseAvailable
Remove-Item -LiteralPath $rollbackMarker -Force
$missing = Test-AntiCodexRollbackReleaseAvailable
Set-Content -LiteralPath $rollbackMarker -Value 'valid'
$env:ANTICODEX_TEST_ROLLBACK_INVALID = '1'
$invalid = Test-AntiCodexRollbackReleaseAvailable
[pscustomobject]@{ valid = [bool]$valid; missing = [bool]$missing; invalid = [bool]$invalid } | ConvertTo-Json -Compress
`);
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      valid: true,
      missing: false,
      invalid: false,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("activation recovery restores the immediate release, preserves the advertised rollback, and keeps cleanup retryable", () => {
  const sync = readSyncScript();
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-activation-recovery-"));
  const paths = Object.fromEntries([
    "activeHost", "activeComponent", "activeMarker",
    "recoveryHost", "recoveryComponent", "recoveryMarker",
    "rollbackHost", "rollbackComponent", "rollbackMarker",
    "preMarkerActiveHost", "preMarkerActiveComponent", "preMarkerActiveMarker",
    "preMarkerRecoveryHost", "preMarkerRecoveryComponent", "preMarkerRecoveryMarker",
    "cleanupActiveHost", "cleanupActiveComponent", "cleanupActiveMarker",
    "cleanupRecoveryHost", "cleanupRecoveryComponent", "cleanupRecoveryMarker",
    "invalidActiveHost", "invalidActiveComponent", "invalidActiveMarker",
    "invalidRecoveryHost", "invalidRecoveryComponent", "invalidRecoveryMarker",
  ].map((name) => [name, join(fixture, name)]));
  try {
    for (const [path, value] of [
      [paths.activeHost, "candidate-host"],
      [paths.activeComponent, "candidate-component"],
      [paths.recoveryHost, "immediate-host"],
      [paths.recoveryComponent, "immediate-component"],
      [paths.rollbackHost, "advertised-host"],
      [paths.rollbackComponent, "advertised-component"],
      [paths.preMarkerRecoveryHost, "pre-marker-host"],
      [paths.preMarkerRecoveryComponent, "pre-marker-component"],
      [paths.cleanupActiveHost, "accepted-host"],
      [paths.cleanupActiveComponent, "accepted-component"],
      [paths.cleanupRecoveryHost, "cleanup-host"],
      [paths.cleanupRecoveryComponent, "cleanup-component"],
      [paths.invalidRecoveryHost, "partial-host"],
    ]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "sentinel.txt"), value);
    }
    for (const [path, value] of [
      [paths.activeMarker, "candidate-marker"],
      [paths.recoveryMarker, "immediate-marker"],
      [paths.rollbackMarker, "advertised-marker"],
      [paths.preMarkerActiveMarker, "pre-marker-active"],
      [paths.cleanupActiveMarker, "accepted-marker"],
      [paths.cleanupRecoveryMarker, "cleanup-marker"],
    ]) writeFileSync(path, value);

    const harness = join(fixture, "recovery.ps1");
    writeFileSync(harness, `$ErrorActionPreference = "Stop"
$WarningPreference = "SilentlyContinue"
function Remove-FixedUpdateDirectory {
    param([string]$Path)
    if ($script:FailCleanup -and $Path -eq $activationRecoveryHost) { throw "injected cleanup failure" }
    if ([IO.Directory]::Exists($Path)) { [IO.Directory]::Delete($Path, $true) }
}
function Move-FixedUpdateDirectory {
    param([string]$Source, [string]$Destination)
    [IO.Directory]::Move($Source, $Destination)
}
${extractFunction(sync, "Get-ActivationRecoveryState")}
${extractFunction(sync, "Restore-ActivationRecoveryRelease")}
${extractFunction(sync, "Complete-ActivationRecoveryCleanup")}
$activeHost = ${quotePowerShell(paths.activeHost)}
$activeComponent = ${quotePowerShell(paths.activeComponent)}
$activeMarker = ${quotePowerShell(paths.activeMarker)}
$activationRecoveryHost = ${quotePowerShell(paths.recoveryHost)}
$activationRecoveryComponent = ${quotePowerShell(paths.recoveryComponent)}
$activationRecoveryMarker = ${quotePowerShell(paths.recoveryMarker)}
$preparedState = Get-ActivationRecoveryState
Restore-ActivationRecoveryRelease -State $preparedState
$restoredHost = Get-Content -LiteralPath (Join-Path $activeHost "sentinel.txt") -Raw
$restoredComponent = Get-Content -LiteralPath (Join-Path $activeComponent "sentinel.txt") -Raw
$restoredMarker = Get-Content -LiteralPath $activeMarker -Raw

$activeHost = ${quotePowerShell(paths.preMarkerActiveHost)}
$activeComponent = ${quotePowerShell(paths.preMarkerActiveComponent)}
$activeMarker = ${quotePowerShell(paths.preMarkerActiveMarker)}
$activationRecoveryHost = ${quotePowerShell(paths.preMarkerRecoveryHost)}
$activationRecoveryComponent = ${quotePowerShell(paths.preMarkerRecoveryComponent)}
$activationRecoveryMarker = ${quotePowerShell(paths.preMarkerRecoveryMarker)}
$preMarkerState = Get-ActivationRecoveryState
Restore-ActivationRecoveryRelease -State $preMarkerState
$preMarkerHost = Get-Content -LiteralPath (Join-Path $activeHost "sentinel.txt") -Raw
$preMarkerComponent = Get-Content -LiteralPath (Join-Path $activeComponent "sentinel.txt") -Raw
$preMarkerActiveMarker = Get-Content -LiteralPath $activeMarker -Raw

$activeHost = ${quotePowerShell(paths.cleanupActiveHost)}
$activeComponent = ${quotePowerShell(paths.cleanupActiveComponent)}
$activeMarker = ${quotePowerShell(paths.cleanupActiveMarker)}
$activationRecoveryHost = ${quotePowerShell(paths.cleanupRecoveryHost)}
$activationRecoveryComponent = ${quotePowerShell(paths.cleanupRecoveryComponent)}
$activationRecoveryMarker = ${quotePowerShell(paths.cleanupRecoveryMarker)}
$cleanupState = Get-ActivationRecoveryState
$script:FailCleanup = $true
$cleanupComplete = Complete-ActivationRecoveryCleanup
$cleanupRetryState = Get-ActivationRecoveryState

$activeHost = ${quotePowerShell(paths.invalidActiveHost)}
$activeComponent = ${quotePowerShell(paths.invalidActiveComponent)}
$activeMarker = ${quotePowerShell(paths.invalidActiveMarker)}
$activationRecoveryHost = ${quotePowerShell(paths.invalidRecoveryHost)}
$activationRecoveryComponent = ${quotePowerShell(paths.invalidRecoveryComponent)}
$activationRecoveryMarker = ${quotePowerShell(paths.invalidRecoveryMarker)}
$invalidState = Get-ActivationRecoveryState
[pscustomobject]@{
    preparedState = $preparedState
    restoredHost = $restoredHost.Trim()
    restoredComponent = $restoredComponent.Trim()
    restoredMarker = $restoredMarker.Trim()
    preMarkerState = $preMarkerState
    preMarkerHost = $preMarkerHost.Trim()
    preMarkerComponent = $preMarkerComponent.Trim()
    preMarkerActiveMarker = $preMarkerActiveMarker.Trim()
    advertisedHost = (Get-Content -LiteralPath ${quotePowerShell(join(paths.rollbackHost, "sentinel.txt"))} -Raw).Trim()
    advertisedComponent = (Get-Content -LiteralPath ${quotePowerShell(join(paths.rollbackComponent, "sentinel.txt"))} -Raw).Trim()
    advertisedMarker = (Get-Content -LiteralPath ${quotePowerShell(paths.rollbackMarker)} -Raw).Trim()
    cleanupState = $cleanupState
    cleanupComplete = $cleanupComplete
    cleanupRetryState = $cleanupRetryState
    invalidState = $invalidState
} | ConvertTo-Json -Compress
`);
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      preparedState: "prepared",
      restoredHost: "immediate-host",
      restoredComponent: "immediate-component",
      restoredMarker: "immediate-marker",
      preMarkerState: "pre_marker",
      preMarkerHost: "pre-marker-host",
      preMarkerComponent: "pre-marker-component",
      preMarkerActiveMarker: "pre-marker-active",
      advertisedHost: "advertised-host",
      advertisedComponent: "advertised-component",
      advertisedMarker: "advertised-marker",
      cleanupState: "prepared",
      cleanupComplete: false,
      cleanupRetryState: "cleanup_pending",
      invalidState: "invalid",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("maintenance process ownership uses exact directory containment, not path prefixes", () => {
  for (const name of ["sync-anticodex.ps1", "rollback-anticodex.ps1", "refresh-anticodex-models.ps1"]) {
    const source = readRuntimeScript(name);
    const containment = extractFunction(source, "Test-AntiCodexPathInsideRoot");
    assert.match(containment, /TrimEnd\(["']\\["']\)\s*\+\s*["']\\["']/);
    assert.match(containment, /StartsWith\(\$rootPrefix,\s*\[StringComparison\]::OrdinalIgnoreCase\)/);
    assert.doesNotMatch(source, /GetFullPath\(\[string\]\$_\.ExecutablePath\)\)\.StartsWith\(\s*\$active(?:Host|Component)/);
  }
});

test("rollback validates both hosts before swapping and again after activation", () => {
  const rollback = readRollbackScript();

  assert.ok(
    rollback.indexOf("Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker") <
      rollback.indexOf("$rollbackStage = \"rollback_stopping_host\""),
    "active host must be validated before rollback stops the app",
  );
  assert.ok(
    rollback.indexOf("Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker") <
      rollback.indexOf("$rollbackStage = \"rollback_stopping_host\""),
    "rollback host must be validated before rollback stops the app",
  );
  assert.ok(
    rollback.indexOf("Move-FixedMarker -Source $rollbackMarker -Destination $activeMarker") <
      rollback.indexOf("Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker", rollback.indexOf("Move-FixedMarker -Source $rollbackMarker -Destination $activeMarker")),
    "new active host must be validated immediately after activation",
  );
  assert.ok(
    rollback.indexOf("Move-FixedMarker -Source $swapMarker -Destination $rollbackMarker") <
      rollback.indexOf("Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker", rollback.indexOf("Move-FixedMarker -Source $swapMarker -Destination $rollbackMarker")),
    "new rollback checkpoint must be validated after the swap completes",
  );
});

test("host sync validates the exact rollback contract and separates activation recovery from advertised rollback", () => {
  const sync = readSyncScript();
  const rollback = readRollbackScript();
  assert.match(rollback, /\[switch\]\$ValidateOnly/);
  assert.match(rollback, /if\s*\(\$ValidateOnly\)\s*\{[\s\S]*?Repair-LegacyRollbackHostBinaryManifest[\s\S]*?Test-AntiCodexHost\s+-HostRoot\s+\$rollbackHost\s+-MarkerPath\s+\$rollbackMarker[\s\S]*?Test-AntiCodexComponent\s+-ComponentRoot\s+\$rollbackComponent[\s\S]*?\$syncMutex\.ReleaseMutex\(\)[\s\S]*?return\s*\}/);
  assert.ok(
    rollback.indexOf("$syncMutex =") <
      rollback.indexOf("if ($ValidateOnly)", rollback.indexOf("$syncMutex =")),
  );
  const normalValidation = rollback.indexOf('if ([IO.Directory]::Exists("\\\\?\\$swapHost")');
  assert.ok(
    rollback.indexOf("Repair-LegacyRollbackHostBinaryManifest", normalValidation) <
      rollback.indexOf("Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker", normalValidation),
    "normal rollback must migrate the legacy host pair before strict rollback-host validation",
  );
  assert.match(rollback, /Test-AntiCodexComponent -ComponentRoot \$rollbackComponent[\s\S]*?try\s*\{[\s\S]*?Test-AntiCodexComponent -ComponentRoot \$activeComponent[\s\S]*?\$activeComponentValid = \$false/);
  assert.match(rollback, /if \(\$activeComponentValid\)\s*\{\s*Commit-AntiCodexRollbackCheckpoint\s*\}\s*else\s*\{\s*Remove-InvalidRollbackSwap\s*\}/);
  assert.match(rollback, /-State "rolled_back" -Stage "complete"[\s\S]*?-RollbackAvailable \$activeComponentValid/);
  assert.doesNotMatch(sync, /Repair-RollbackHostBinaryManifest/);
  assert.match(sync, /\$rollbackRestoreAvailable\s*=\s*if\s*\(\$legacyCurrentRecoveryOnly\)[\s\S]*?\$activationRecoveryHostAvailable[\s\S]*?\$activationRecoveryComponentAvailable[\s\S]*?\$rollbackHostAvailable[\s\S]*?\$rollbackComponentAvailable/);
  assert.match(sync, /\$rollbackManifestSchemaCompatible\s*=\s*\[bool\]\(Repair-RollbackHostUnpackedFileManifest\)/);
  assert.match(sync, /if\s*\(\$rollbackRestoreAvailable\s+-and\s+\$rollbackManifestSchemaCompatible\)\s*\{[\s\S]*?Repair-RollbackHostIconManifest[\s\S]*?&\s+\$rollbackScript\s+-ValidateOnly[\s\S]*?\$rollbackAvailable\s*=\s*\$true/);
  assert.match(sync, /if\s*\(\$rollbackRestoreAvailable\)\s*\{[\s\S]*?\$activationRestored\s*=\s*\$true[\s\S]*?\$rollbackAvailable\s*=\s*\$preservedRollbackAvailable/);
  assert.match(sync, /\$rollbackRestoreAvailable\s*=\s*\(\s*\[IO\.Directory\]::Exists\("\\\\\?\\\$activeHost"\)[\s\S]*?\[IO\.Directory\]::Exists\("\\\\\?\\\$activeComponent"\)[\s\S]*?\[IO\.File\]::Exists\(\$activeMarker\)/);
  assert.match(sync, /\$activationFailure\s*=\s*\[pscustomobject\]@\{[\s\S]*?message\s*=\s*\$activationError/);
  assert.match(sync, /if\s*\(\$activationRestored\)\s*\{[\s\S]*?\$rollbackAvailable\s*=\s*Test-AntiCodexRollbackReleaseAvailable[\s\S]*?-State\s+"failed"\s+-Stage\s+\$updateStage[\s\S]*?-RollbackAvailable\s+\$rollbackAvailable[\s\S]*?-State\s+"rolled_back"\s+-Stage\s+"complete"[\s\S]*?-RollbackAvailable\s+\$rollbackAvailable\s+-OriginalFailure\s+\$activationFailure/);
  assert.match(sync, /if\s*\(-not\s+\$rollbackAvailable\)\s*\{\s*throw[\s\S]*?No compatible rollback release was available\./);
  assert.match(sync, /if\s*\(-not\s+\$rollbackAvailable\)\s*\{[\s\S]*?Remove-Item\s+-LiteralPath\s+\$rollbackMarker[\s\S]*?Remove-FixedUpdateDirectory\s+-Path\s+\$rollbackHost[\s\S]*?Remove-FixedUpdateDirectory\s+-Path\s+\$rollbackComponent/);
  assert.match(sync, /No compatible previous release is available for rollback\./);
});

test("cross-version sync with matching host and CLI hashes leaves the rollback tree byte-identical", () => {
  const fixture = runRollbackRepair({ sameHostCli: true, legacyInventory: false });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
    assert.deepEqual(fixture.after, fixture.before);
    assert.equal(fixture.manifest.source.packageVersion, "1.0.0.0");
    assert.equal(fixture.manifest.unpackedFiles.length, fixture.before.length);
    assert.equal(fixture.result.stdout.trim(), "True");
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("legacy rollback inventory migrates from its own tree even when host and CLI hashes changed", () => {
  const fixture = runRollbackRepair({ sameHostCli: false, legacyInventory: true });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
    assert.deepEqual(fixture.after, fixture.before);
    assert.equal(fixture.manifest.source.packageVersion, "1.0.0.0");
    assert.deepEqual(
      fixture.manifest.unpackedFiles.map(({ path, sha256: hash, size }) => ({ path, sha256: hash, size })),
      fixture.before,
    );
    assert.equal(fixture.result.stdout.trim(), "False");
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("legacy v2 rcedit rollback checkpoint migrates source host bytes and marker together", () => {
  const fixture = runLegacyRollbackBinaryMigration();
  try {
    assert.ifError(fixture.result.error);
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
    assert.deepEqual(readFileSync(fixture.antiCodexHost), fixture.sourceBytes);
    const manifest = JSON.parse(readFileSync(fixture.rollbackMarker, "utf8"));
    assert.equal(manifest.files.antiCodexExe, sha256(fixture.sourceBytes));
    assert.deepEqual(
      readdirSync(fixture.rollbackHost).sort(),
      ["Anti-Codex.exe", "ChatGPT.exe"],
    );
    assert.deepEqual(
      readdirSync(fixture.fixture).sort(),
      ["repair-binary.ps1", "rollback-host", "rollback-host.ok"],
    );
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("legacy rollback binary migration restores byte and marker pair when marker replacement fails", () => {
  const fixture = runLegacyRollbackBinaryMigration({ readOnlyMarker: true });
  try {
    assert.ifError(fixture.result.error);
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /migration failed.*restored/i);
    assert.deepEqual(readFileSync(fixture.antiCodexHost), fixture.legacyBytes);
    assert.equal(readFileSync(fixture.rollbackMarker, "utf8"), fixture.markerText);
    assert.deepEqual(
      readdirSync(fixture.rollbackHost).sort(),
      ["Anti-Codex.exe", "ChatGPT.exe"],
    );
    assert.deepEqual(
      readdirSync(fixture.fixture).sort(),
      ["repair-binary.ps1", "rollback-host", "rollback-host.ok"],
    );
  } finally {
    chmodSync(fixture.rollbackMarker, 0o666);
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("rollback checkpoint reverses a committed host before recovering from marker move failure", () => {
  const fixture = runRollbackCommitFailure("marker");
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
    assert.match(fixture.output.caught, /reverse recovery restored the pre-commit swap state/i);
    assert.deepEqual(fixture.output.moves.slice(0, 3), [
      "host:swapHost->rollbackHost",
      "marker:swapMarker->rollbackMarker",
      "host:rollbackHost->swapHost",
    ]);
    assertOriginalReleasePairRestored(fixture.output);
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("rollback checkpoint reverses marker then host after component move failure", () => {
  const fixture = runRollbackCommitFailure("component");
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
    assert.match(fixture.output.caught, /reverse recovery restored the pre-commit swap state/i);
    assert.deepEqual(fixture.output.moves.slice(0, 5), [
      "host:swapHost->rollbackHost",
      "marker:swapMarker->rollbackMarker",
      "component:swapComponent->rollbackComponent",
      "marker:rollbackMarker->swapMarker",
      "host:rollbackHost->swapHost",
    ]);
    assertOriginalReleasePairRestored(fixture.output);
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});
