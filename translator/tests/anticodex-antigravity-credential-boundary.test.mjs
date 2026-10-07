import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { createAntigravityAccountDriver } from "../../scripts/anticodex-antigravity-accounts-driver.mjs";

const scriptsRoot = path.resolve(import.meta.dirname, "../../scripts");
const helper = path.join(scriptsRoot, "anticodex-antigravity-credentials.ps1");
const psLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
const runPowerShell = (script, input = "") => childProcess.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });

test("driver checks whether a saved official credential exists without capturing it", async () => {
  const requests = [];
  const driver = createAntigravityAccountDriver({ scriptsRoot, env: { LOCALAPPDATA: os.tmpdir() }, runner: async (request) => { requests.push(request.action); return { exists: true }; } });
  assert.equal(typeof driver.hasCredential, "function");
  assert.equal(await driver.hasCredential(), true);
  assert.deepEqual(requests, ["HasCredential"]);
});

test("uncertain Desktop resume forbids restoring credentials under a potentially live process", async () => {
  const driver = createAntigravityAccountDriver({ scriptsRoot, env: { LOCALAPPDATA: os.tmpdir() }, runner: async () => { throw new Error("synthetic-private-failure"); } });
  await assert.rejects(driver.endChange({ wasRunning: true }), (error) => {
    assert.equal(error.credentialRestoreUnsafe, true);
    assert.doesNotMatch(error.message, /synthetic-private/);
    return true;
  });
});

test("driver preserves the unsafe cleanup signal from official login", async () => {
  const failure = Object.assign(new Error("synthetic-private-failure"), { credentialRestoreUnsafe: true });
  const driver = createAntigravityAccountDriver({ scriptsRoot, env: { LOCALAPPDATA: os.tmpdir() }, runner: async () => ({}), login: async () => { throw failure; } });
  await assert.rejects(driver.login({ acknowledgeRestart: true }), (error) => {
    assert.equal(error.credentialRestoreUnsafe, true);
    assert.doesNotMatch(error.message, /synthetic-private/);
    return true;
  });
});

test("child pipe failures are handled without crashing the account service", async (t) => {
  let inputErrors = 0;
  let outputErrors = 0;
  const stub = t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.end = () => {
      inputErrors = child.stdin.listenerCount("error");
      outputErrors = child.stdout.listenerCount("error");
      child.emit("error", new Error("synthetic-pipe-failure"));
    };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
  const driver = createAntigravityAccountDriver({ scriptsRoot, env: { ...process.env, LOCALAPPDATA: os.tmpdir() } });
  await assert.rejects(driver.capture(), /credential capture failed/);
  assert.ok(inputErrors > 0 && outputErrors > 0, "Both child pipes need error listeners");
});

test("short email addresses are still masked", { skip: process.platform !== "win32" }, () => {
  const result = runPowerShell(`$ast=[Management.Automation.Language.Parser]::ParseFile(${psLiteral(helper)},[ref]$null,[ref]$null); $fn=$ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Get-MaskedEmail' }; . ([scriptblock]::Create($fn.Extent.Text)); @((Get-MaskedEmail 'a@example.test'),(Get-MaskedEmail 'ab@example.test')) | ConvertTo-Json -Compress`);
  assert.equal(result.status, 0);
  for (const value of JSON.parse(result.stdout)) assert.ok(value.includes("*"), "A masked email must not disclose its complete local part");
});

test("Desktop opener finishes after successful helper exit and complete JSON without inherited pipe close", async (t) => {
  let child;
  const stub = t.mock.method(childProcess, "spawn", () => {
    child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.once("finish", () => {
      child.stdout.write('{"ok":');
      child.emit("exit", 0);
      setImmediate(() => child.stdout.write('true,"launched":true}'));
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { child?.emit("close", 0); stub.mock.restore(); syncBuiltinESMExports(); });
  const driver = createAntigravityAccountDriver({ scriptsRoot, env: { ...process.env, LOCALAPPDATA: os.tmpdir() } });
  const result = await Promise.race([driver.openDesktop().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 150))]);
  assert.equal(result, true);
});

test("credential driver waits for closed stdout rather than the earlier process exit", async (t) => {
  const capture = { id: `sha256:${"a".repeat(64)}`, maskedEmail: "te***@example.test", sealed: "dpapi:v1:AA==", credentialHash: "b".repeat(64) };
  const stub = t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.once("finish", () => {
      const value = JSON.stringify(capture);
      child.stdout.write(value.slice(0, 20));
      child.emit("exit", 0);
      setImmediate(() => { child.stdout.end(value.slice(20)); child.stderr.end(); child.emit("close", 0); });
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
  const driver = createAntigravityAccountDriver({ scriptsRoot, env: { ...process.env, LOCALAPPDATA: os.tmpdir() } });
  assert.deepEqual(await driver.capture(), capture);
});

test("desktop helper definitions remain visible after resolving the executable", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-credential-scope-"));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.copyFileSync(helper, path.join(dir, "helper.ps1"));
  fs.writeFileSync(path.join(dir, "Antigravity.exe"), "not executable; fixture only");
  fs.writeFileSync(path.join(dir, "antigravity-desktop.ps1"), `function Resolve-AntigravityDesktopPath { ${psLiteral(path.join(dir, "Antigravity.exe"))} }\nfunction Get-AntigravityMainProcess { param($ExecutablePath) return $null }\n`);
  const result = runPowerShell(`function global:Get-Process { param($Name,$Id,$ErrorAction) return $null }; & ${psLiteral(path.join(dir, "helper.ps1"))} -Action PauseDesktop`, '{"acknowledgeRestart":true}');
  assert.equal(result.status, 0, "PauseDesktop must load its helpers into a usable scope");
  assert.equal(JSON.parse(result.stdout).wasRunning, false);
});

test("a running Desktop with an unverifiable identity cannot be treated as stopped", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-credential-identity-"));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.copyFileSync(helper, path.join(dir, "helper.ps1"));
  fs.writeFileSync(path.join(dir, "Antigravity.exe"), "fixture only");
  fs.writeFileSync(path.join(dir, "antigravity-desktop.ps1"), `function Resolve-AntigravityDesktopPath { ${psLiteral(path.join(dir, "Antigravity.exe"))} }\nfunction Get-AntigravityMainProcess { param($ExecutablePath) return $null }\n`);
  const result = runPowerShell(`function global:Get-Process { param($Name,$Id,$ErrorAction) if($Name -eq 'Antigravity'){[pscustomobject]@{Id=12345}} }; & ${psLiteral(path.join(dir, "helper.ps1"))} -Action PauseDesktop`, '{"acknowledgeRestart":true}');
  assert.notEqual(result.status, 0, "Unknown running Antigravity process must refuse credential changes");
});

test("credential schema accepts optional identity token but rejects unknown or malformed fields", { skip: process.platform !== "win32" }, () => {
  const token = { access_token: "synthetic", token_type: "Bearer", refresh_token: "synthetic-refresh", expiry: "2099-01-01T00:00:00Z" };
  const old = { token, auth_method: "oauth" };
  const modern = { ...old, id_token: "synthetic-id" };
  const cases = [old, modern, { ...modern, extra: "unknown" }, ...[{}, 1, null].map(id_token => ({ ...old, id_token })), { token }, { ...old, token: { ...token, access_token: "" } }];
  const result = runPowerShell(`
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$ast=[Management.Automation.Language.Parser]::ParseFile(${psLiteral(helper)},[ref]$null,[ref]$null)
$fn=$ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Assert-OfficialCredentialJson' }
. ([scriptblock]::Create($fn.Extent.Text))
$cases=[Console]::In.ReadToEnd() | ConvertFrom-Json
$result=@($cases | ForEach-Object {try {Assert-OfficialCredentialJson ([Text.Encoding]::UTF8.GetBytes(($_ | ConvertTo-Json -Depth 8 -Compress))) | Out-Null; $true} catch {$false}})
ConvertTo-Json -InputObject $result -Compress`, JSON.stringify(cases));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), [true, true, false, false, false, false, false, false]);
});

test("DPAPI restore decodes only the supplied synthetic credential without touching the keyring", { skip: process.platform !== "win32" }, () => {
  const fake = JSON.stringify({ token: { access_token: "synthetic-access", token_type: "Bearer", refresh_token: "synthetic-refresh", expiry: "2030-01-01T00:00:00Z" }, auth_method: "oauth" });
  const sealed = runPowerShell("Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $e=[Text.Encoding]::UTF8.GetBytes('anticodex-antigravity-accounts-v1'); [Console]::Write('dpapi:v1:'+[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))", fake);
  assert.equal(sealed.status, 0);
  const script = `$ast=[Management.Automation.Language.Parser]::ParseFile(${psLiteral(helper)},[ref]$null,[ref]$null); $defs=($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] } | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine; . ([scriptblock]::Create($defs)); $EntropyText='anticodex-antigravity-accounts-v1'; $script:restored=$null; function Write-ExactCredential([byte[]]$Blob) { $script:restored=[Text.Encoding]::UTF8.GetString($Blob) }; function Write-JsonResult($Value) {}; Invoke-Restore ([pscustomobject]@{sealed=[Console]::In.ReadToEnd()}); if(-not $script:restored){exit 2}; [Console]::Write($script:restored)`;
  const restored = runPowerShell(script, sealed.stdout.trim());
  assert.equal(restored.status, 0, "Restore must initialize its own cryptographic dependencies");
  assert.equal(restored.stdout, fake);
});

test("Windows credential marshaling roundtrips a disposable synthetic slot and removes it", { skip: process.platform !== "win32" }, () => {
  const target = `AntiCodexValidation:${randomUUID()}`;
  const fake = JSON.stringify({ token: { access_token: "synthetic-access", token_type: "Bearer", refresh_token: "synthetic-refresh", expiry: "2030-01-01T00:00:00Z" }, auth_method: "oauth" });
  const script = `
$ErrorActionPreference='Stop';
$ast=[Management.Automation.Language.Parser]::ParseFile(${psLiteral(helper)},[ref]$null,[ref]$null);
$defs=($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] } | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine;
. ([scriptblock]::Create($defs));
$TargetName=${psLiteral(target)};
Ensure-NativeCredentialApi;
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ValidationCleanup{[DllImport("advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool Delete(string target,uint type,uint flags);}';
$pointer=[IntPtr]::Zero;
if([AntiCodex.Antigravity.CredentialNative]::CredReadW($TargetName,1,0,[ref]$pointer)){[AntiCodex.Antigravity.CredentialNative]::CredFree($pointer);throw 'Unexpected existing validation slot.'};
if([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168){throw 'Validation slot cannot be checked.'};
$blob=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());
$copied=$null;
try{
 Write-ExactCredential $blob;
 $copied=Read-ExactCredential;
 $same=(Get-Sha256Hex $blob) -eq (Get-Sha256Hex $copied.Blob);
 if(-not $same){throw 'Credential roundtrip mismatch.'};
}finally{
 Clear-Bytes $blob;
 if($copied){Clear-Bytes $copied.Blob};
 if(-not [ValidationCleanup]::Delete($TargetName,1,0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168){throw 'Validation cleanup failed.'};
};
[Console]::Write('roundtrip-and-cleanup-ok');`;
  const result = runPowerShell(script, fake);
  assert.equal(result.status, 0, "Synthetic Windows credential roundtrip or cleanup failed");
  assert.equal(result.stdout, "roundtrip-and-cleanup-ok");
});
