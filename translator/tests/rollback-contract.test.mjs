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

function createLegacyRollbackBinaryFixture({ readOnlyMarker = false } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-rollback-binary-"));
  const rollbackHost = join(fixture, "rollback-host");
  const rollbackMarker = join(fixture, "rollback-host.ok");
  const sourceHost = join(rollbackHost, "ChatGPT.exe");
  const antiCodexHost = join(rollbackHost, "Anti-Codex.exe");
  const sourceBytes = Buffer.from("official-codex-host-bytes");
  const legacyBytes = Buffer.from("legacy-rcedit-host-bytes");
  mkdirSync(rollbackHost, { recursive: true });
  writeFileSync(sourceHost, sourceBytes);
  writeFileSync(antiCodexHost, legacyBytes);
  const markerText = JSON.stringify({
    schema: "anticodex-host-manifest-v2",
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
  assert.match(validator, /expectedCriticalPatches/);
  assert.match(validator, /previousCriticalPatches/);
  assert.match(validator, /legacyWithoutConfigWriteCriticalPatches/);
  assert.match(
    validator,
    /\$previousCriticalPatches\s*=\s*@\([\s\S]*?\$_\s+-notin\s+@\("app-server-managed-session-flags",\s*"settings-external-links"\)/,
  );
  assert.match(
    validator,
    /\$legacyWithoutConfigWriteCriticalPatches\s*=\s*@\([\s\S]*?\$_\s+-ne\s+"config-write"/,
  );
  assert.match(validator, /currentManifestCompatible/);
  assert.match(validator, /previousManifestCompatible/);
  assert.match(validator, /legacyWithoutConfigWriteManifestCompatible/);
  assert.match(validator, /if\s*\(\$currentManifestCompatible\s+-or\s+\$previousManifestCompatible\)/);
  assert.match(validator, /Test-AntiCodexAsarPatches/);
  const asarValidator = extractFunction(rollback, "Test-AntiCodexAsarPatches");
  for (const marker of [
    ".app.name=`Anti-Codex`",
    "AntiCodex",
    "icon:`icon.ico`",
    "__ANTICODEX_OPEN_MANAGER__",
    "\\u7ba1\\u7406",
  ]) {
    assert.match(asarValidator, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
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
  assert.match(asarValidator, /\[int\]\$ExpectedPrimaryWindowFocusRestoreRepaintCount/);
  assert.match(asarValidator, /\[int\]\$ExpectedLegacyPrimaryWindowRestoreRepaintCount/);
  assert.match(asarValidator, /primaryFocusRestoreRepaintPattern/);
  assert.match(asarValidator, /\$primaryFocusRestoreRepaintPattern\)\.Count -ne \$ExpectedPrimaryWindowFocusRestoreRepaintCount/);
  assert.match(asarValidator, /anyPrimaryWindowRepaintPattern/);
  assert.match(asarValidator, /\$anyPrimaryWindowRepaintPattern\)\.Count -ne \(\$ExpectedPrimaryWindowFocusRestoreRepaintCount \+ \$ExpectedLegacyPrimaryWindowRestoreRepaintCount\)/);
  assert.match(validator, /-ExpectedPrimaryWindowFocusRestoreRepaintCount 1[\s\S]*?-ExpectedLegacyPrimaryWindowRestoreRepaintCount 0/);
  assert.match(validator, /-ExpectedPrimaryWindowFocusRestoreRepaintCount 0[\s\S]*?-ExpectedLegacyPrimaryWindowRestoreRepaintCount 1/);
  assert.match(validator, /resources\\codex-tray\.ico/);
  assert.match(validator, /trayIcon/);
  assert.match(validator, /Get-AntiCodexSha256/);
  assert.doesNotMatch(rollback, /\bGet-FileHash\b/);
  assert.match(validator, /manifest\.files\.\$name/);
  assert.match(validator, /manifest\.source\.codexHost/);
  assert.match(validator, /manifest\.source\.codexCli/);
  assert.match(validator, /Test-AntiCodexIconPalette/);
  assert.match(validator, /preserve the copied source Codex host bytes/);
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
    const configWriteBridge = '"batch-write-config-value":e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(`config/batchWrite`,e)';
    const patchedBase = `${base};${configWriteBridge}`;
    const hook = "trackPrimaryWindow(e){let t=()=>this.primaryWindowLastActiveAtMs.set(e,Date.now()),n=()=>{try{e.webContents.invalidate()}catch{}};this.primaryWindows.add(e),e.isFocused()?(this.lastActivePrimaryWindow=e,t()):this.lastActivePrimaryWindow??=e,this.emitPrimaryWindowChangeIfNeeded(),e.on(`focus`,()=>{this.lastActivePrimaryWindow=e,t(),this.emitPrimaryWindowChangeIfNeeded(),n()}),e.on(`blur`,t),e.on(`restore`,()=>setImmediate(n))}";
    const restoreOnlyHook = hook.replace(",n()", "");
    const focusOnlyHook = hook.replace(",e.on(`restore`,()=>setImmediate(n))", "");
    const legacyRestoreOnlyHook = "trackPrimaryWindow(e){let t=()=>this.primaryWindowLastActiveAtMs.set(e,Date.now());this.primaryWindows.add(e),e.isFocused()?(this.lastActivePrimaryWindow=e,t()):this.lastActivePrimaryWindow??=e,this.emitPrimaryWindowChangeIfNeeded(),e.on(`focus`,()=>{this.lastActivePrimaryWindow=e,t(),this.emitPrimaryWindowChangeIfNeeded()}),e.on(`blur`,t),e.on(`restore`,()=>e.webContents.invalidate?.())}";
    const paths = {
      zero: join(fixture, "zero.asar"),
      one: join(fixture, "one.asar"),
      two: join(fixture, "two.asar"),
      restoreOnly: join(fixture, "restore-only.asar"),
      focusOnly: join(fixture, "focus-only.asar"),
      splitCross: join(fixture, "split-cross.asar"),
      legacyRestoreOnly: join(fixture, "legacy-restore-only.asar"),
      missingConfigBridge: join(fixture, "missing-config-bridge.asar"),
      duplicateConfigBridge: join(fixture, "duplicate-config-bridge.asar"),
    };
    writeFileSync(paths.zero, patchedBase);
    writeFileSync(paths.one, `${patchedBase};${hook}`);
    writeFileSync(paths.two, `${patchedBase};${hook};${hook}`);
    writeFileSync(paths.restoreOnly, `${patchedBase};${restoreOnlyHook}`);
    writeFileSync(paths.focusOnly, `${patchedBase};${focusOnlyHook}`);
    writeFileSync(paths.splitCross, `${patchedBase};${focusOnlyHook};${restoreOnlyHook}`);
    writeFileSync(paths.legacyRestoreOnly, `${patchedBase};${legacyRestoreOnlyHook}`);
    writeFileSync(paths.missingConfigBridge, `${base};${hook}`);
    writeFileSync(paths.duplicateConfigBridge, `${patchedBase};${configWriteBridge};${hook}`);
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const harness = join(fixture, "matrix.ps1");
    writeFileSync(harness, `$ErrorActionPreference = "Stop"
${asarValidator}
${patchSetValidator}
function Accept-Asar([string]$Path, [int]$ExpectedConfigWrite, [int]$ExpectedCurrent, [int]$ExpectedLegacyRestore) {
    try {
        Test-AntiCodexAsarPatches -Path $Path -PatchProfile "fixed-shell-v1" -ExpectedConfigWriteBridgeCount $ExpectedConfigWrite -ExpectedPrimaryWindowFocusRestoreRepaintCount $ExpectedCurrent -ExpectedLegacyPrimaryWindowRestoreRepaintCount $ExpectedLegacyRestore
        return $true
    } catch {
        return $false
    }
}
$current = @("package-json","webview-html-title","app-name","app-user-model-id","session-title","startup-mcp-config-reload","app-server-managed-session-flags","config-write","auth-requirement","app-route-gate","profile-dropdown-settings","settings-external-links","browser-window-icon","primary-window-restore-repaint","windows-tray-icon","local-model-availability")
$previous = @($current | Where-Object { $_ -notin @("app-server-managed-session-flags", "settings-external-links") })
$legacyWithoutConfigWrite = @($current | Where-Object { $_ -ne "config-write" })
[pscustomobject]@{
    currentHook = Accept-Asar ${quote(paths.one)} 1 1 0
    currentMissingHook = Accept-Asar ${quote(paths.zero)} 1 1 0
    currentDuplicateHook = Accept-Asar ${quote(paths.two)} 1 1 0
    currentRestoreOnlyHook = Accept-Asar ${quote(paths.restoreOnly)} 1 1 0
    currentFocusOnlyHook = Accept-Asar ${quote(paths.focusOnly)} 1 1 0
    currentSplitCrossHook = Accept-Asar ${quote(paths.splitCross)} 1 1 0
    currentMissingConfigBridge = Accept-Asar ${quote(paths.missingConfigBridge)} 1 1 0
    currentDuplicateConfigBridge = Accept-Asar ${quote(paths.duplicateConfigBridge)} 1 1 0
    legacyWithoutConfigWrite = Accept-Asar ${quote(paths.missingConfigBridge)} 0 1 0
    predecessorRejectsCurrent = Accept-Asar ${quote(paths.one)} 0 1 0
    previousNoHook = Accept-Asar ${quote(paths.zero)} 0 1 0
    previousUnexpectedHook = Accept-Asar ${quote(paths.one)} 0 1 0
    previousUnexpectedRestoreOnlyHook = Accept-Asar ${quote(paths.restoreOnly)} 0 1 0
    previousUnexpectedFocusOnlyHook = Accept-Asar ${quote(paths.focusOnly)} 0 1 0
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
      currentHook: true,
      currentMissingHook: false,
      currentDuplicateHook: false,
      currentRestoreOnlyHook: false,
      currentFocusOnlyHook: false,
      currentSplitCrossHook: false,
      currentMissingConfigBridge: false,
      currentDuplicateConfigBridge: false,
      legacyWithoutConfigWrite: true,
      predecessorRejectsCurrent: false,
      previousNoHook: false,
      previousUnexpectedHook: false,
      previousUnexpectedRestoreOnlyHook: false,
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

test("post-sync acceptance uses local health without probing a model provider", () => {
  const acceptance = extractFunction(readSyncScript(), "Invoke-AntiCodexPostSyncAcceptance");

  assert.match(acceptance, /\$health\.modelCount/);
  assert.doesNotMatch(acceptance, /\$baseUrl\/models|\$models\.data/);
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
  assert.match(sync, /\$rollbackRestoreAvailable\s*=\s*\([\s\S]*?\$rollbackHostAvailable[\s\S]*?\$rollbackComponentAvailable[\s\S]*?\[IO\.File\]::Exists\(\$rollbackMarker\)/);
  assert.match(sync, /\$rollbackManifestSchemaCompatible\s*=\s*\[bool\]\(Repair-RollbackHostUnpackedFileManifest\)/);
  assert.match(sync, /if\s*\(\$rollbackRestoreAvailable\s+-and\s+\$rollbackManifestSchemaCompatible\)\s*\{[\s\S]*?Repair-RollbackHostIconManifest[\s\S]*?&\s+\$rollbackScript\s+-ValidateOnly[\s\S]*?\$rollbackAvailable\s*=\s*\$true/);
  assert.match(sync, /if\s*\(\$rollbackRestoreAvailable\)\s*\{[\s\S]*?\$activationRestored\s*=\s*\$true[\s\S]*?\$rollbackAvailable\s*=\s*\$false/);
  assert.match(sync, /if\s*\(\$activationRestored\)\s*\{[\s\S]*?-State\s+"failed"\s+-Stage\s+\$updateStage[\s\S]*?-RollbackAvailable\s+\$false[\s\S]*?-State\s+"rolled_back"\s+-Stage\s+"complete"[\s\S]*?-RollbackAvailable\s+\$false/);
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
