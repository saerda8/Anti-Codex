import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const helper = resolve(root, "scripts/electron-asar-integrity-host.mjs");
const emptyHash = "0".repeat(64);
const execute = (...args) => spawnSync(process.execPath, [helper, ...args], {
  encoding: "utf8", windowsHide: true,
});

test("brands an isolated Windows executable while rejecting unrelated changes", { skip: process.platform !== "win32" }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "anticodex-exe-identity-"));
  const source = join(fixture, "source.exe");
  const target = join(fixture, "Anti-Codex.exe");
  const originalHash = process.env.IDENTITY_ORIGINAL_HASH || emptyHash;
  const patchedHash = process.env.IDENTITY_PATCHED_HASH || emptyHash;
  try {
    copyFileSync(process.env.IDENTITY_FIXTURE_EXE || join(process.env.SystemRoot, "System32", "where.exe"), source);
    copyFileSync(source, target);
    mkdirSync(join(fixture, "resources"));
    copyFileSync(resolve(root, "assets/anticodex.ico"), join(fixture, "resources", "icon.ico"));
    const before = readFileSync(source);
    if (originalHash === patchedHash) {
      assert.equal(execute("--verify", source, target, originalHash, patchedHash).status, 0);
      assert.notEqual(execute("--verify", source, target, originalHash, patchedHash, "--brand").status, 0);
    }
    const patched = execute("--patch", source, target, originalHash, patchedHash, "--brand");
    assert.equal(patched.status, 0, patched.stderr || patched.stdout);
    const version = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:IDENTITY_TEST_EXE); $original=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:IDENTITY_TEST_SOURCE); $preserved=($v.CompanyName -ceq $original.CompanyName -and $v.FileVersion -ceq $original.FileVersion -and $v.ProductVersion -ceq $original.ProductVersion -and $v.OriginalFilename -ceq $original.OriginalFilename); Add-Type -AssemblyName System.Drawing; $icon=[Drawing.Icon]::ExtractAssociatedIcon($env:IDENTITY_TEST_EXE); $bmp=$icon.ToBitmap(); $pink=0; for($x=0;$x -lt $bmp.Width;$x++){for($y=0;$y -lt $bmp.Height;$y++){ $c=$bmp.GetPixel($x,$y); if($c.A -gt 0 -and $c.R -gt 140 -and $c.G -lt 150 -and $c.B -gt 80){$pink++}}}; $bmp.Dispose(); $icon.Dispose(); [pscustomobject]@{FileDescription=$v.FileDescription;ProductName=$v.ProductName;PinkPixels=$pink;MetadataPreserved=$preserved} | ConvertTo-Json -Compress",
    ], { encoding: "utf8", windowsHide: true, env: { ...process.env, IDENTITY_TEST_EXE: target, IDENTITY_TEST_SOURCE: source } });
    assert.equal(version.status, 0, version.stderr || version.stdout);
    const identity = JSON.parse(version.stdout);
    assert.equal(identity.FileDescription, "Anti-Codex");
    assert.equal(identity.ProductName, "Anti-Codex");
    assert.equal(identity.MetadataPreserved, true);
    assert.ok(identity.PinkPixels > 0);
    if (originalHash !== patchedHash) {
      assert.equal(readFileSync(target).includes(Buffer.from(originalHash)), false);
      assert.equal(readFileSync(target).includes(Buffer.from(patchedHash)), true);
    }
    const verified = execute("--verify", source, target, originalHash, patchedHash, "--brand");
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const changed = readFileSync(target);
    changed[changed.length - 1] ^= 1;
    writeFileSync(target, changed);
    assert.notEqual(execute("--verify", source, target, originalHash, patchedHash, "--brand").status, 0);
    assert.deepEqual(readFileSync(source), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
