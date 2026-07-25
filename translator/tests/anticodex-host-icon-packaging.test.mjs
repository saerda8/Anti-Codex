import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
const brandPatcher = readFileSync(resolve(root, "scripts", "brand-patched-asar.mjs"), "utf8");
const shortcutRepair = readFileSync(resolve(root, "scripts", "repair-anticodex-shortcuts.ps1"), "utf8");
const candidateValidator = readFileSync(resolve(root, "scripts", "test-anticodex-host-candidate.ps1"), "utf8");
const updateChecker = readFileSync(resolve(root, "scripts", "check-anticodex-update.ps1"), "utf8");
const rollback = readFileSync(resolve(root, "scripts", "rollback-anticodex.ps1"), "utf8");
const syncReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");
const hostSync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const candidates = [
    source.indexOf("\nfunction ", start + 1),
    source.indexOf("\n$syncMutex", start + 1),
  ].filter((value) => value !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test("host packaging preserves official host bytes and uses external Anti-Codex icons", () => {
  assert.doesNotMatch(installer, /rcedit|Update-ExeVersionInfo/);
  assert.match(installer, /Get-AntiCodexSha256\s+-Path\s+\$sourceDesktopHostPath[\s\S]*?Get-AntiCodexSha256\s+-Path\s+\$antiCodexHost/);
  assert.doesNotMatch(brandPatcher, /exePath|fs\.writeFileSync\([^,]*exe/);
  assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$resourceIcon\s+-Force/);
  assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$trayIcon\s+-Force/);
  assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$appRootIcon\s+-Force/);
  assert.doesNotMatch(installer, /patch-exe-icon\.ps1|PATCH_EXE_ICON_SCRIPT|&\s+\$PATCH_EXE_ICON_SCRIPT/);
});

test("candidate validation requires exactly one primary-window restore repaint", () => {
  assert.match(candidateValidator, /primaryRestoreRepaintPattern/);
  assert.match(candidateValidator, /\[regex\]::Matches\(\$asarText,\s*\$primaryRestoreRepaintPattern\)\.Count -ne 1/);
});

test("shortcuts continue to use the external Anti-Codex icon", () => {
  assert.match(shortcutRepair, /\$hostIcon\s*=\s*Join-Path\s+\$hostRoot\s+"resources\\icon\.ico"/);
  assert.match(shortcutRepair, /\$shortcut\.IconLocation\s*=\s*\[string\]\$Spec\.expectedIconLocation/);
});

test("host packaging repairs and signs every file under app.asar.unpacked", () => {
  const inventory = extractFunction(installer, "Sync-UnpackedNativeModules");
  assert.match(inventory, /Get-ChildItem[\s\S]*?-File[\s\S]*?-Recurse/);
  assert.doesNotMatch(inventory, /-Filter\s+"?\*\.node"?|EndsWith\(["']\.node/);
  assert.match(installer, /\$sourceUnpackedExtended\s*=\s*"\\\\\?\\\$sourceUnpacked"/);
  assert.match(installer, /\[IO\.File\]::Copy\(\$sourceAccessPath,\s*\$destinationAccessPath,\s*\$true\)/);
  assert.match(installer, /unpackedFiles\s*=\s*@\(\$UnpackedFiles\)/);
  for (const verifier of [
    candidateValidator,
    extractFunction(updateChecker, "Test-ActiveHostGuardrails"),
    extractFunction(rollback, "Test-AntiCodexHost"),
    extractFunction(syncReadiness, "Test-UnpackedNativeModuleInventory"),
  ]) {
    assert.match(verifier, /unpackedFiles/);
    assert.doesNotMatch(verifier, /-Filter\s+"?\*\.node"?|EndsWith\(["']\.node/);
  }
});

test("host sync migrates rollback inventory from the rollback tree without changing its files", () => {
  const repair = extractFunction(hostSync, "Repair-RollbackHostUnpackedFileManifest");
  assert.match(repair, /\$rollbackHost/);
  assert.match(repair, /unpackedFiles/);
  assert.match(repair, /Get-ChildItem[\s\S]*?\$rollbackUnpackedRoot/);
  assert.doesNotMatch(repair, /\$activeHost|\$activeMarker|\[IO\.File\]::Copy/);
});

test("installed sync readiness accepts only the current full-inventory host schema", () => {
  assert.match(syncReadiness, /\[string\]\$activeManifest\.schema\s+-ne\s+"anticodex-host-manifest-v2"/);
  assert.match(syncReadiness, /\[string\]\$rollbackManifest\.schema\s+-ne\s+"anticodex-host-manifest-v2"/);
});

test("sync readiness requires local candidate validator hashing", () => {
  assert.match(syncReadiness, /Has-Text \$validatorScript "Get-AntiCodexSha256"/);
  assert.match(syncReadiness, /\$utilityHashCommand\s*=\s*"Get-"\s*\+\s*"FileHash"/);
  assert.match(syncReadiness, /Has-Text \$validatorScript \$utilityHashCommand[\s\S]*?Add-Failure/);
});

test("all PowerShell scripts avoid Utility module hashing", () => {
  const scriptsRoot = resolve(root, "scripts");
  for (const name of readdirSync(scriptsRoot).filter((entry) => entry.endsWith(".ps1"))) {
    const source = readFileSync(resolve(scriptsRoot, name), "utf8");
    assert.doesNotMatch(source, /\bGet-FileHash\b/, name);
  }
});

test("host release and readiness SHA-256 paths work without Utility module autoload", () => {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-sha256-no-autoload-"));
  try {
    const samplePath = join(fixture, "sample.bin");
    const sample = Buffer.from("Anti-Codex clean Windows PowerShell SHA-256");
    writeFileSync(samplePath, sample);
    const expected = createHash("sha256").update(sample).digest("hex").toUpperCase();

    for (const [label, source] of [
      ["installer", installer],
      ["host sync", hostSync],
      ["candidate validator", candidateValidator],
      ["rollback validator", rollback],
      ["sync readiness", syncReadiness],
      ["runtime sync", runtimeSync],
    ]) {
      assert.doesNotMatch(source, /\bGet-FileHash\b/, `${label} must not depend on Utility module hashing`);
      const sha256 = extractFunction(source, "Get-AntiCodexSha256");
      const harness = join(fixture, `${label.replaceAll(" ", "-")}.ps1`);
      writeFileSync(harness, `$ErrorActionPreference = "Stop"
$PSModuleAutoLoadingPreference = "None"
Remove-Module Microsoft.PowerShell.Utility -Force -ErrorAction SilentlyContinue
${sha256}
[Console]::Out.Write((Get-AntiCodexSha256 -Path ${quotePowerShell(samplePath)}))
`);
      const result = spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
      ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.trim(), expected);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
