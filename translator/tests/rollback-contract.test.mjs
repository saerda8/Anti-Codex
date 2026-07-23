import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const next = text.indexOf("\nfunction ", start + marker.length);
  return text.slice(start, next === -1 ? undefined : next);
}

test("rollback host validation covers Anti-Codex branding, icons, manifest, hashes, and critical patches", () => {
  const rollback = readRollbackScript();
  const validator = extractFunction(rollback, "Test-AntiCodexHost");

  assert.match(validator, /anticodex-host-manifest-v2/);
  assert.match(validator, /fixed-shell-v1/);
  assert.doesNotMatch(validator, /anticodex-host-manifest-v1|legacy-full|legacyCriticalPatches/);
  assert.match(validator, /criticalPatches/);
  assert.match(validator, /expectedCriticalPatches/);
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
  for (const patchName of [
    "package-json",
    "webview-html-title",
    "app-name",
    "app-user-model-id",
    "session-title",
    "startup-mcp-config-reload",
    "auth-requirement",
    "app-route-gate",
    "profile-dropdown-settings",
    "browser-window-icon",
    "windows-tray-icon",
    "local-model-availability",
  ]) {
    assert.match(validator, new RegExp(`"${patchName}"`));
  }

  assert.match(validator, /resources\\codex-tray\.ico/);
  assert.match(validator, /trayIcon/);
  assert.match(validator, /Get-FileHash/);
  assert.match(validator, /manifest\.files\.\$name/);
  assert.match(validator, /manifest\.source\.codexHost/);
  assert.match(validator, /manifest\.source\.codexCli/);
  assert.match(validator, /Test-AntiCodexIconPalette/);
  assert.match(validator, /ProductName/);
  assert.match(validator, /FileDescription/);
  assert.match(validator, /OriginalFilename/);
  assert.match(validator, /Anti-Codex\.exe/);
  assert.match(validator, /Anti-Codex/);
});

test("post-sync acceptance reads model availability from the models endpoint", () => {
  const acceptance = extractFunction(readSyncScript(), "Invoke-AntiCodexPostSyncAcceptance");

  assert.match(acceptance, /Invoke-RestMethod[^\r\n]*\$baseUrl\/models/);
  assert.match(acceptance, /@\(\$models\.data\)\.Count/);
  assert.doesNotMatch(acceptance, /\$health\.modelCount/);
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
