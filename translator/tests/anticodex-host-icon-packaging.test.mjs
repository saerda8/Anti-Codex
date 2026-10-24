import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const asarIntegrityHostHelper = resolve(root, "scripts", "electron-asar-integrity-host.mjs");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const candidates = [
    source.indexOf("\nfunction ", start + 1),
    source.indexOf("\n$syncMutex", start + 1),
    source.indexOf("\n$candidate", start + 1),
  ].filter((value) => value !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test("host packaging preserves the copied source host and patches only the isolated launcher ASAR hash", () => {
  assert.doesNotMatch(installer, /rcedit|Update-ExeVersionInfo/);
  assert.match(installer, /electron-asar-integrity-host\.mjs/);
  assert.match(installer, /--patch\s+\$sourceDesktopHostPath\s+\$antiCodexHost/);
  assert.match(candidateValidator, /--verify\s+\$copiedSourceHost\s+\$antiCodex/);
  assert.match(rollback, /--verify\s+\$required\.codexHost\s+\$required\.antiCodexExe/);
  assert.match(updateChecker, /--verify\s+\$sourceHostPath\s+\$required\.antiCodexExe/);
  assert.doesNotMatch(installer, /copied host bytes changed during activation/);
  assert.doesNotMatch(brandPatcher, /exePath|fs\.writeFileSync\([^,]*exe/);
  assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$resourceIcon\s+-Force/);
  assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$trayIcon\s+-Force/);
  assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$appRootIcon\s+-Force/);
  assert.doesNotMatch(installer, /patch-exe-icon\.ps1|PATCH_EXE_ICON_SCRIPT|&\s+\$PATCH_EXE_ICON_SCRIPT/);
  assert.match(runtimeSync, /scripts\\electron-asar-integrity-host\.mjs/);
});

test("host gates require the local node_repl runtime and sandbox helper", () => {
  for (const source of [installer, candidateValidator, updateChecker]) {
    assert.match(source, /resources\\codex-windows-sandbox-setup\.exe/);
    assert.match(source, /resources\\cua_node\\bin\\node_repl\.exe/);
    assert.match(source, /resources\\cua_node\\bin\\node\.exe/);
  }
  for (const source of [installer, candidateValidator, updateChecker]) {
    assert.match(source, /sandboxHelper/);
    assert.match(source, /nodeRepl/);
    assert.match(source, /nodeRuntime/);
  }
});

test("revision 7 candidate validation requires the official no-repaint tracker", () => {
  assert.match(candidateValidator, /"config-write"/);
  assert.match(candidateValidator, /"app-server-managed-session-flags"/);
  assert.match(candidateValidator, /"settings-external-links"/);
  assert.match(candidateValidator, /configWriteBridgePattern/);
  assert.match(candidateValidator, /\$legacyConfigWriteBridgeCount\s*=\s*\[regex\]::Matches\(\$asarText,\s*\$configWriteBridgePattern\)\.Count/);
  assert.match(candidateValidator, /\$modernConfigWriteBridgeValid\s*=\s*\[regex\]::Matches\(\$asarText,\s*'configWriteTarget'\)\.Count\s+-ge\s+1\s+-and\s+\[regex\]::Matches\(\$asarText,\s*'config\/batchWrite'\)\.Count\s+-ge\s+1\s+-and\s+\[regex\]::Matches\(\$asarText,\s*'reloadUserConfig'\)\.Count\s+-ge\s+1/);
  assert.match(candidateValidator, /if\s*\(\$legacyConfigWriteBridgeCount\s+-ne\s+1\s+-and\s+-not\s+\$modernConfigWriteBridgeValid\)/);
  assert.match(candidateValidator, /primaryDeferredRestoreRepaintPattern/);
  assert.match(candidateValidator, /\[regex\]::Matches\(\$asarText,\s*\$primaryDeferredRestoreRepaintPattern\)\.Count -ne 0/);
  assert.match(candidateValidator, /primaryFocusRestoreRepaintPattern/);
  assert.match(candidateValidator, /\[regex\]::Matches\(\$asarText,\s*\$primaryFocusRestoreRepaintPattern\)\.Count -ne 0/);
  assert.match(candidateValidator, /anyPrimaryWindowRepaintPattern/);
  assert.match(candidateValidator, /\[regex\]::Matches\(\$asarText,\s*\$anyPrimaryWindowRepaintPattern\)\.Count -ne 0/);
  assert.match(candidateValidator, /legacyPrimaryRestoreRepaintPattern/);
  assert.match(candidateValidator, /\[regex\]::Matches\(\$asarText,\s*\$legacyPrimaryRestoreRepaintPattern\)\.Count -ne 0/);
});

test("host patch revision is release-bound without changing the fixed-shell profile", () => {
  assert.match(brandPatcher, /const hostPatchRevision = 7/);
  assert.match(brandPatcher, /hostPatchRevision,/);
  assert.match(installer, /hostPatchRevision\s*=\s*\$HostPatchRevision/);
  assert.match(installer, /\[string\]\$brandResult\.hostPatchRevision\s+-ne\s+"7"/);
  assert.match(updateChecker, /\$expectedHostPatchRevision\s*=\s*7/);
  assert.match(updateChecker, /active host patch revision is not current/);
  assert.match(updateChecker, /\$sourceFingerprint[\s\S]{0,260}hostPatchRevision=/);
  assert.match(candidateValidator, /\[string\]\$manifest\.hostPatchRevision\s+-ne\s+"7"/);
  assert.match(candidateValidator, /anticodex-local-settings-only/);
  assert.match(candidateValidator, /securitySettingsEnabled:0/);
  assert.match(candidateValidator, /anticodex-crash-recovery-actions/);
  assert.match(candidateValidator, /appServerCrash\\\.title/);
  assert.match(installer, /"crash-recovery-page"/);
  assert.match(rollback, /\$currentHostPatchRevision\s*=\s*7/);
  assert.match(rollback, /\$revision6ManifestCompatible/);
  assert.match(rollback, /\$revision5ManifestCompatible/);
  assert.match(rollback, /\$revision4CriticalPatches/);
  for (const source of [brandPatcher, installer, candidateValidator, updateChecker, rollback]) {
    assert.match(source, /fixed-shell-v1/);
  }
});

test("candidate and rollback validators bind the Windows tray resource to an Anti-Codex-only GUID", () => {
  for (const source of [candidateValidator, rollback]) {
    assert.match(source, /e5768d8b-6936-4f45-b1ad-4c5fb414cb35/);
    assert.match(source, /a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3/);
    assert.match(source, /officialTrayGuidCount/);
    assert.match(source, /antiCodexTrayGuidCount/);
  }
});

test("candidate crash-page validation binds both error surfaces to their safe actions", () => {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-candidate-crash-"));
  try {
    const validator = extractFunction(candidateValidator, "Test-AntiCodexCrashRecoveryPage");
    const fallback = 'id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`};id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`}';
    const app = 'function C(e){let {fatalError:n,onReset:R}=e;id:`appServerCrash.title`,defaultMessage:`{appName} stopped unexpectedly`,values:{appName:`Anti-Codex`};id:`appServerCrash.description`,defaultMessage:`Restart {appName} to continue. If the problem persists, check your configuration or visit the {documentationLink}`,values:{appName:`Anti-Codex`,documentationLink:x};let d;d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`})});let f;f=(0,j.jsx)(Z,{id:`appServerCrash.restart`,defaultMessage:`Restart`});let p;p=(0,j.jsx)(B,{onClick:R,children:f});/*anticodex-crash-recovery-actions*/children:[d,p]}function O(){return A.dispatchMessage(`open-config-toml`,{})}';
    const generic = 'function G(e){let {resetError:n}=e,r=M();let s;s=()=>{n(),r(`/`)};id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`};let c;c=(0,j.jsx)(Z,{id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`});/*anticodex-generic-error-actions*/children:[(0,j.jsx)(B,{onClick:s,children:c})]}var R,z,J;';
    const valid = `${app}${generic}${fallback}`;
    const memoValid = `${app
      .replace('let d;d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`})});', 'let d;t[6]===n.hostId?d=t[7]:(d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`})}),t[6]=n.hostId,t[7]=d);')
      .replace('let p;p=(0,j.jsx)(B,{onClick:R,children:f});', 'let p;t[9]===R?p=t[10]:(p=(0,j.jsx)(B,{onClick:R,children:f}),t[9]=R,t[10]=p);')}${generic
      .replace('let s;s=()=>{n(),r(`/`)};', 'let s;t[3]!==r||t[4]!==n?(s=()=>{n(),r(`/`)},t[3]=r,t[4]=n,t[5]=s):s=t[5];')}${fallback}`;
    const roleSwap = valid.replace("children:[d,p]", "children:[u,p]");
    const restartHandlerSwap = valid.replace("onClick:R,children:f", "onClick:U,children:f");
    const genericHandlerSwap = valid.replace("onClick:s,children:c", "onClick:U,children:c");
    const configHandlerReassign = valid.replace("/*anticodex-crash-recovery-actions*/", "d=(0,j.jsx)(B,{onClick:U,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`})});/*anticodex-crash-recovery-actions*/");
    const restartHandlerReassign = valid.replace("/*anticodex-crash-recovery-actions*/", "p=(0,j.jsx)(B,{onClick:U,children:f});/*anticodex-crash-recovery-actions*/");
    const genericHandlerReassign = valid.replace("/*anticodex-generic-error-actions*/", "s=U;/*anticodex-generic-error-actions*/");
    const configCacheDecoy = valid.replace("/*anticodex-crash-recovery-actions*/", "d=t[99];t[99]=d;/*anticodex-crash-recovery-actions*/");
    const restartCacheDecoy = valid.replace("/*anticodex-crash-recovery-actions*/", "p=t[99];t[99]=p;/*anticodex-crash-recovery-actions*/");
    const genericCacheDecoy = valid.replace("/*anticodex-generic-error-actions*/", "s=t[99];t[99]=s;/*anticodex-generic-error-actions*/");
    const configCompoundWriteDecoy = valid.replace("/*anticodex-crash-recovery-actions*/", "d&&=U;/*anticodex-crash-recovery-actions*/");
    const restartCompoundWriteDecoy = valid.replace("/*anticodex-crash-recovery-actions*/", "p&&=U;/*anticodex-crash-recovery-actions*/");
    const genericCompoundWriteDecoy = valid.replace("/*anticodex-generic-error-actions*/", "s&&=U;/*anticodex-generic-error-actions*/");
    const configDestructureWriteDecoy = valid.replace("/*anticodex-crash-recovery-actions*/", "[d]=[U];/*anticodex-crash-recovery-actions*/");
    const genericForOfWriteDecoy = valid.replace("/*anticodex-generic-error-actions*/", "for(s of q){}/*anticodex-generic-error-actions*/");
    const configThunkDecoy = valid.replace('let d;d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`})});', 'let d;x?d=t[99]:(()=>{d=(0,j.jsx)(B,{onClick:O,children:(0,j.jsx)(Z,{id:`loadingPage.openConfigToml`})});t[99]=d});');
    const restartThunkDecoy = valid.replace('let p;p=(0,j.jsx)(B,{onClick:R,children:f});', 'let p;x?p=t[99]:(()=>{p=(0,j.jsx)(B,{onClick:R,children:f});t[99]=p});');
    const genericThunkDecoy = valid.replace('let s;s=()=>{n(),r(`/`)};', 'let s;x?s=t[99]:(()=>{s=()=>{n(),r(`/`)};t[99]=s});');
    const appDecoy = valid.replace("/*anticodex-crash-recovery-actions*/", "children:[u,d,p];/*anticodex-crash-recovery-actions*/");
    const genericDecoy = valid.replace("/*anticodex-generic-error-actions*/", "children:[q,(0,j.jsx)(B,{onClick:s,children:c})];/*anticodex-generic-error-actions*/");
    const harness = join(fixture, "candidate-crash.ps1");
    writeFileSync(harness, `$ErrorActionPreference = "Stop"
${validator}
function Accept-Crash([string]$Text) {
  try { Test-AntiCodexCrashRecoveryPage -Text $Text | Out-Null; return $true } catch { return $false }
}
[pscustomobject]@{
  valid = Accept-Crash ${quotePowerShell(valid)}
  memoValid = Accept-Crash ${quotePowerShell(memoValid)}
  roleSwap = Accept-Crash ${quotePowerShell(roleSwap)}
  restartHandlerSwap = Accept-Crash ${quotePowerShell(restartHandlerSwap)}
  genericHandlerSwap = Accept-Crash ${quotePowerShell(genericHandlerSwap)}
  configHandlerReassign = Accept-Crash ${quotePowerShell(configHandlerReassign)}
  restartHandlerReassign = Accept-Crash ${quotePowerShell(restartHandlerReassign)}
  genericHandlerReassign = Accept-Crash ${quotePowerShell(genericHandlerReassign)}
  configCacheDecoy = Accept-Crash ${quotePowerShell(configCacheDecoy)}
  restartCacheDecoy = Accept-Crash ${quotePowerShell(restartCacheDecoy)}
  genericCacheDecoy = Accept-Crash ${quotePowerShell(genericCacheDecoy)}
  configCompoundWriteDecoy = Accept-Crash ${quotePowerShell(configCompoundWriteDecoy)}
  restartCompoundWriteDecoy = Accept-Crash ${quotePowerShell(restartCompoundWriteDecoy)}
  genericCompoundWriteDecoy = Accept-Crash ${quotePowerShell(genericCompoundWriteDecoy)}
  configDestructureWriteDecoy = Accept-Crash ${quotePowerShell(configDestructureWriteDecoy)}
  genericForOfWriteDecoy = Accept-Crash ${quotePowerShell(genericForOfWriteDecoy)}
  configThunkDecoy = Accept-Crash ${quotePowerShell(configThunkDecoy)}
  restartThunkDecoy = Accept-Crash ${quotePowerShell(restartThunkDecoy)}
  genericThunkDecoy = Accept-Crash ${quotePowerShell(genericThunkDecoy)}
  appDecoy = Accept-Crash ${quotePowerShell(appDecoy)}
  genericDecoy = Accept-Crash ${quotePowerShell(genericDecoy)}
  missingFallback = Accept-Crash ${quotePowerShell(`${app}${generic}`)}
} | ConvertTo-Json -Compress
`, "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    ], { cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      valid: true,
      memoValid: true,
      roleSwap: false,
      restartHandlerSwap: false,
      genericHandlerSwap: false,
      configHandlerReassign: false,
      restartHandlerReassign: false,
      genericHandlerReassign: false,
      configCacheDecoy: false,
      restartCacheDecoy: false,
      genericCacheDecoy: false,
      configCompoundWriteDecoy: false,
      restartCompoundWriteDecoy: false,
      genericCompoundWriteDecoy: false,
      configDestructureWriteDecoy: false,
      genericForOfWriteDecoy: false,
      configThunkDecoy: false,
      restartThunkDecoy: false,
      genericThunkDecoy: false,
      appDecoy: false,
      genericDecoy: false,
      missingFallback: false,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("isolated launcher replaces only the embedded Electron ASAR header hash", () => {
  assert.equal(existsSync(asarIntegrityHostHelper), true);
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-asar-host-hash-"));
  try {
    const originalHash = "a".repeat(64);
    const patchedHash = "b".repeat(64);
    const sourcePath = join(fixture, "ChatGPT.exe");
    const targetPath = join(fixture, "Anti-Codex.exe");
    const source = Buffer.from(`prefix-${originalHash}-suffix`, "ascii");
    writeFileSync(sourcePath, source);
    writeFileSync(targetPath, source);

    const patched = spawnSync(process.execPath, [
      asarIntegrityHostHelper, "--patch", sourcePath, targetPath, originalHash, patchedHash,
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(patched.status, 0, patched.stderr || patched.stdout);
    const target = readFileSync(targetPath);
    assert.equal(target.length, source.length);
    assert.equal(target.toString("ascii"), `prefix-${patchedHash}-suffix`);
    assert.deepEqual(readFileSync(sourcePath), source);

    const verified = spawnSync(process.execPath, [
      asarIntegrityHostHelper, "--verify", sourcePath, targetPath, originalHash, patchedHash,
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);

    target[0] ^= 1;
    writeFileSync(targetPath, target);
    const rejected = spawnSync(process.execPath, [
      asarIntegrityHostHelper, "--verify", sourcePath, targetPath, originalHash, patchedHash,
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.notEqual(rejected.status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("candidate and rollback settings validators accept the Codex 26.901 trailing Mini label prop", () => {
  for (const source of [candidateValidator, rollback]) {
    assert.ok(source.includes("securitySettingsEnabled:0\\s*(?:,showMiniPetsLabel:"));
    assert.ok(source.includes("securitySettingsEnabled:[A-Za-z_$][\\w$]*\\s*(?:,showMiniPetsLabel:"));
  }
});

test("candidate crash-page validation accepts only the split Codex 26.901 safe-action shape", () => {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-candidate-crash-v3-"));
  try {
    const validator = extractFunction(candidateValidator, "Test-AntiCodexCrashRecoveryPage");
    const title = 'function T(e){return q({id:`appServerCrash.recoveryTitle`,defaultMessage:`Anti-Codex hit a snag` })}';
    const app = 'function C(e){let{fatalError:n,onReset:r}=e;let c;c=q({id:`appServerCrash.configurationRecoveryDescription`,defaultMessage:`Anti-Codex couldn\'t load your configuration. Review it, then restart to try again.` });c=q({id:`appServerCrash.recoveryDescription`,defaultMessage:`Something went wrong. Restart Anti-Codex to try again.` });let d;d=q({id:`appServerCrash.restartChatGPT`,defaultMessage:`Restart Anti-Codex` });let f;f=b({onClick:r,children:d});let p;p=b({onClick:F,children:q({id:`appServerCrash.sendFeedback`})});let m;m=b({onClick:L,children:q({id:`appServerCrash.reviewConfiguration`})});let h;h=x(U,{hideUnavailable:!0});/*anticodex-crash-recovery-actions-v3*/children:[f,p,m]}function L(){return A.dispatchMessage(`open-config-toml`,{})}';
    const valid = `${title}${app}`;
    const harness = join(fixture, "candidate-crash-v3.ps1");
    writeFileSync(harness, `$ErrorActionPreference = "Stop"
${validator}
function Accept-Crash([string]$Text) {
  try { Test-AntiCodexCrashRecoveryPage -Text $Text | Out-Null; return $true } catch { return $false }
}
[pscustomobject]@{
  valid = Accept-Crash ${quotePowerShell(valid)}
  updaterDecoy = Accept-Crash ${quotePowerShell(valid.replace("/*anticodex-crash-recovery-actions-v3*/", "children:[f,p,m,h];/*anticodex-crash-recovery-actions-v3*/"))}
  roleSwap = Accept-Crash ${quotePowerShell(valid.replace("children:[f,p,m]", "children:[f,m,p]"))}
  restartHandlerSwap = Accept-Crash ${quotePowerShell(valid.replace("onClick:r,children:d", "onClick:U,children:d"))}
  configHandlerSwap = Accept-Crash ${quotePowerShell(valid.replace("onClick:L,children:q({id:`appServerCrash.reviewConfiguration`})", "onClick:U,children:q({id:`appServerCrash.reviewConfiguration`})"))}
  missingBrand = Accept-Crash ${quotePowerShell(valid.replace("defaultMessage:`Anti-Codex hit a snag`", "defaultMessage:`ChatGPT hit a snag`"))}
} | ConvertTo-Json -Compress
`, "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    ], { cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      valid: true,
      updaterDecoy: false,
      roleSwap: false,
      restartHandlerSwap: false,
      configHandlerSwap: false,
      missingBrand: false,
    });

    const rollbackValidator = extractFunction(rollback, "Test-AntiCodexCrashRecoveryV3");
    const rollbackHarness = join(fixture, "rollback-crash-v3.ps1");
    writeFileSync(rollbackHarness, `$ErrorActionPreference = "Stop"
${rollbackValidator}
[pscustomobject]@{
  valid = Test-AntiCodexCrashRecoveryV3 ${quotePowerShell(valid)}
  updaterDecoy = Test-AntiCodexCrashRecoveryV3 ${quotePowerShell(valid.replace("/*anticodex-crash-recovery-actions-v3*/", "children:[f,p,m,h];/*anticodex-crash-recovery-actions-v3*/"))}
  roleSwap = Test-AntiCodexCrashRecoveryV3 ${quotePowerShell(valid.replace("children:[f,p,m]", "children:[f,m,p]"))}
  restartHandlerSwap = Test-AntiCodexCrashRecoveryV3 ${quotePowerShell(valid.replace("onClick:r,children:d", "onClick:U,children:d"))}
  configHandlerSwap = Test-AntiCodexCrashRecoveryV3 ${quotePowerShell(valid.replace("onClick:L,children:q({id:`appServerCrash.reviewConfiguration`})", "onClick:U,children:q({id:`appServerCrash.reviewConfiguration`})"))}
  missingBrand = Test-AntiCodexCrashRecoveryV3 ${quotePowerShell(valid.replace("defaultMessage:`Anti-Codex hit a snag`", "defaultMessage:`ChatGPT hit a snag`"))}
} | ConvertTo-Json -Compress
`, "utf8");
    const rollbackResult = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", rollbackHarness,
    ], { cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(rollbackResult.status, 0, rollbackResult.stderr || rollbackResult.stdout);
    assert.deepEqual(JSON.parse(rollbackResult.stdout.trim()), {
      valid: true,
      updaterDecoy: false,
      roleSwap: false,
      restartHandlerSwap: false,
      configHandlerSwap: false,
      missingBrand: false,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("candidate crash-page validation accepts only the patched 26.825 safe-action shape", () => {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-candidate-crash-v2-"));
  try {
    const validator = extractFunction(candidateValidator, "Test-AntiCodexCrashRecoveryPage");
    const app = 'function C(e){let{fatalError:n,onReset:r}=e;id:`appServerCrash.recoveryTitle`,defaultMessage:`Anti-Codex hit a snag`};id:`appServerCrash.configurationRecoveryDescription`,defaultMessage:`Anti-Codex couldn\'t load your configuration. Review it, then restart to try again.`};id:`appServerCrash.recoveryDescription`,defaultMessage:`Something went wrong. Restart Anti-Codex to try again.`};let p;p=(0,j.jsx)(Z,{id:`appServerCrash.restartChatGPT`,defaultMessage:`Restart Anti-Codex`});let m;m=(0,j.jsx)(B,{onClick:r,children:p});let h;h=(0,j.jsx)(B,{onClick:F,children:(0,j.jsx)(Z,{id:`appServerCrash.sendFeedback`})});let g;g=(0,j.jsx)(B,{onClick:L,children:(0,j.jsx)(Z,{id:`appServerCrash.reviewConfiguration`})});let _;_=(0,j.jsx)(j.Fragment,{children:(0,j.jsx)(U,{hideUnavailable:!0})});/*anticodex-crash-recovery-actions-v2*/children:[m,h,g]}function L(){return A.dispatchMessage(`open-config-toml`,{})}';
    const generic = 'function G(e){let {resetError:n}=e,r=M();let s;s=()=>{n(),r(`/`)};id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`};let c;c=(0,j.jsx)(Z,{id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`});/*anticodex-generic-error-actions*/children:[(0,j.jsx)(B,{onClick:s,children:c})]}var R,z,J;';
    const fallback = 'id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`};id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`}';
    const valid = `${app}${generic}${fallback}`;
    const harness = join(fixture, "candidate-crash-v2.ps1");
    writeFileSync(harness, `$ErrorActionPreference = "Stop"
${validator}
function Accept-Crash([string]$Text) {
  try { Test-AntiCodexCrashRecoveryPage -Text $Text | Out-Null; return $true } catch { return $false }
}
[pscustomobject]@{
  valid = Accept-Crash ${quotePowerShell(valid)}
  updaterDecoy = Accept-Crash ${quotePowerShell(valid.replace("/*anticodex-crash-recovery-actions-v2*/", "children:[m,h,g,_];/*anticodex-crash-recovery-actions-v2*/"))}
  roleSwap = Accept-Crash ${quotePowerShell(valid.replace("children:[m,h,g]", "children:[m,g,h]"))}
  restartHandlerSwap = Accept-Crash ${quotePowerShell(valid.replace("onClick:r,children:p", "onClick:U,children:p"))}
  configHandlerSwap = Accept-Crash ${quotePowerShell(valid.replace("onClick:L,children:(0,j.jsx)(Z,{id:`appServerCrash.reviewConfiguration`})", "onClick:U,children:(0,j.jsx)(Z,{id:`appServerCrash.reviewConfiguration`})"))}
  missingBrand = Accept-Crash ${quotePowerShell(valid.replace("defaultMessage:`Anti-Codex hit a snag`", "defaultMessage:`ChatGPT hit a snag`"))}
} | ConvertTo-Json -Compress
`, "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    ], { cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      valid: true,
      updaterDecoy: false,
      roleSwap: false,
      restartHandlerSwap: false,
      configHandlerSwap: false,
      missingBrand: false,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("candidate and rollback validators require both preserved Settings messages", () => {
  for (const source of [candidateValidator, rollback]) {
    const pattern = source.match(/\$settingsDefinitionPattern\s*=\s*'([^']+)'/)?.[1] ?? "";
    assert.match(pattern, /message:\(\?<messages>/);
    assert.match(pattern, /message:\\k<messages>\\\.securitySettings/);
    assert.match(source, /securitySettingsEnabled:0\\s\*\(\?:,showMiniPetsLabel:/);
  }
});

test("candidate and rollback accept v1002 Settings and reject incomplete or ambiguous patches", () => {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-settings-v1002-"));
  const definition = "/*anticodex-local-settings-only*/account:{href:`about:blank`,icon:q,message:k.account},securitySettings:{href:`about:blank`,icon:n,message:k.securitySettings}";
  const security = "(0,Q.jsx)(kr,{...e,securitySettingsEnabled:0});hn.securitySettings.message;";
  const item = "{href:hn.securitySettings.href,id:`external:security-settings`,kind:`external`,label:i}";
  const modern = definition + security + item;
  const legacy = definition + security + "/*anticodex-hide-external-account*/null";
  try {
    for (const [index, source] of [candidateValidator, rollback].entries()) {
      const block = source.match(/\$settingsDefinitionPattern\s*=[\s\S]*?throw "[^"\r\n]+Settings compatibility patch is invalid\."\s*\}/)?.[0];
      assert.ok(block, "Settings validation block not found");
      const harness = join(fixture, `settings-${index}.ps1`);
      writeFileSync(harness, `$ErrorActionPreference = "Stop"
function Accept-Settings([string]$text) {
  $asarText = $text
  try { ${block}; return $true } catch { return $false }
}
[pscustomobject]@{
  modern = Accept-Settings ${quotePowerShell(modern)}
  legacy = Accept-Settings ${quotePowerShell(legacy)}
  legacySecurityItem = Accept-Settings ${quotePowerShell(legacy + item)}
  unpatched = Accept-Settings ${quotePowerShell(modern.replace("securitySettingsEnabled:0", "securitySettingsEnabled:n"))}
  ambiguous = Accept-Settings ${quotePowerShell(modern + "/*anticodex-hide-external-account*/null/*anticodex-hide-external-account*/null")}
  duplicate = Accept-Settings ${quotePowerShell(modern + item)}
  noMessages = Accept-Settings ${quotePowerShell(modern.replace("message:k.securitySettings", "message:k.account"))}
} | ConvertTo-Json -Compress
`, "utf8");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true});
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {modern: true, legacy: true, legacySecurityItem: true, unpatched: false, ambiguous: false, duplicate: false, noMessages: false});
    }
  } finally { rmSync(fixture, {recursive: true, force: true}); }
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

    const snippets = [];
    const expectedLines = [];
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
      snippets.push(`${sha256}
[Console]::Out.WriteLine(${quotePowerShell(`${label}=`)} + (Get-AntiCodexSha256 -Path ${quotePowerShell(samplePath)}))`);
      expectedLines.push(`${label}=${expected}`);
    }

    const harness = join(fixture, "all-sha256-paths.ps1");
    writeFileSync(harness, `$ErrorActionPreference = "Stop"
$PSModuleAutoLoadingPreference = "None"
Remove-Module Microsoft.PowerShell.Utility -Force -ErrorAction SilentlyContinue
${snippets.join("\n")}
`);
    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n"));
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), expectedLines);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
