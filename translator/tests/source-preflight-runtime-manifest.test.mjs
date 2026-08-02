import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const preflightPath = join(repoRoot, "scripts", "test-anticodex-source-preflight.ps1");
const preflightSource = readFileSync(preflightPath, "utf8");
const helperStart = preflightSource.indexOf("function Test-SourcePathInsideRoot");
const helperEnd = preflightSource.indexOf("function Get-RelativeSourcePath", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "runtime manifest helpers are missing");
const manifestHelpers = preflightSource.slice(helperStart, helperEnd);
const revisionStart = preflightSource.indexOf("function Test-SourceGitRevision");
const revisionEnd = preflightSource.indexOf("function New-ReportPaths", revisionStart);
assert.ok(revisionStart >= 0 && revisionEnd > revisionStart, "source revision check is missing");
const revisionHelper = preflightSource.slice(revisionStart, revisionEnd);
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inventory(root) {
  const result = {};
  function visit(directory, parent = "") {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".anticodex-runtime-manifest.json") continue;
      const absolute = join(directory, name);
      const relative = parent ? `${parent}\\${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        result[relative] = { type: "directory" };
        visit(absolute, relative);
      } else {
        result[relative] = { type: "file", length: stat.size, sha256: sha256(absolute) };
      }
    }
  }
  visit(root);
  return result;
}

function createRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "anticodex-manifest-test-"));
  const runtime = join(root, "runtime");
  const payload = join(runtime, "payload.txt");
  mkdirSync(join(runtime, "scripts"), { recursive: true });
  writeFileSync(payload, "trusted\n", "utf8");
  writeFileSync(join(runtime, "scripts", "check.ps1"), "'ok'\n", "utf8");
  const entries = inventory(runtime);
  const manifest = {
    schema: "anticodex-runtime-manifest-v2",
    state: "validated",
    transactionId: "fixture",
    sourceRoot: repoRoot,
    activeRuntime: runtime,
    stagedRuntime: runtime,
    sourceGitHead: "a".repeat(40),
    sourceGitClean: true,
    sourceRevisionProvenance: "git",
    verifiedFileCount: 1,
    entryCount: Object.keys(entries).length,
    createdAt: new Date().toISOString(),
    files: { "payload.txt": entries["payload.txt"].sha256 },
    entries,
  };
  return { root, runtime, payload, manifest, wrapperPrelude: "" };
}

function verify(fixture) {
  const manifestPath = join(fixture.runtime, ".anticodex-runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
  const wrapper = join(fixture.root, "verify.ps1");
  const quotedRoot = fixture.runtime.replaceAll("'", "''");
  writeFileSync(
    wrapper,
    `$ErrorActionPreference='Stop'\n$SourceRoot='${quotedRoot}'\n${fixture.wrapperPrelude}${manifestHelpers}\nGet-SourceRuntimeManifestRevision | ConvertTo-Json -Depth 6 -Compress\n`,
    "utf8",
  );
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    wrapper,
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test("installed runtime manifest accepts only the exact hashed tree", () => {
  const valid = createRuntimeFixture();
  try {
    const result = verify(valid);
    assert.equal(result.ok, true);
    assert.equal(result.verifiedEntryCount, Object.keys(valid.manifest.entries).length);
  } finally {
    rmSync(valid.root, { recursive: true, force: true });
  }

  for (const [name, mutate, expectedReason] of [
    ["tampered file", (fixture) => writeFileSync(fixture.payload, "changed\n", "utf8")],
    ["extra file", (fixture) => writeFileSync(join(fixture.runtime, "extra.txt"), "extra\n", "utf8")],
    ["missing file", (fixture) => rmSync(fixture.payload)],
    ["fake provenance", (fixture) => { fixture.manifest.sourceRevisionProvenance = "runtime"; }],
    ["wrong active root", (fixture) => { fixture.manifest.activeRuntime = dirname(fixture.runtime); }],
    ["traversal entry", (fixture) => {
      fixture.manifest.entries["..\\outside.txt"] = fixture.manifest.entries["payload.txt"];
      delete fixture.manifest.entries["payload.txt"];
    }],
    ["reparse point", (fixture) => {
      const external = join(fixture.root, "external");
      const linked = join(fixture.runtime, "linked");
      mkdirSync(external);
      try {
        symlinkSync(external, linked, "junction");
      } catch (error) {
        if (error?.code !== "EPERM") throw error;
        mkdirSync(linked);
        const quotedLinked = linked.replaceAll("'", "''");
        fixture.wrapperPrelude = String.raw`
function Get-ChildItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [switch]$Recurse,
        [switch]$Force
    )
    foreach ($item in @(Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force -ErrorAction Stop)) {
        if ([IO.Path]::GetFullPath($item.FullName).Equals(
            '${quotedLinked}',
            [StringComparison]::OrdinalIgnoreCase
        )) {
            [pscustomobject]@{
                PSIsContainer = $true
                Attributes = ($item.Attributes -bor [IO.FileAttributes]::ReparsePoint)
                FullName = $item.FullName
            }
        } else {
            $item
        }
    }
}
`;
      }
    }, /reparse point/i],
  ]) {
    const fixture = createRuntimeFixture();
    try {
      mutate(fixture);
      const result = verify(fixture);
      assert.equal(result.ok, false, name);
      if (expectedReason) assert.match(result.reason, expectedReason, name);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("a runtime nested below an unrelated Git repository still requires its manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "anticodex-parent-git-test-"));
  const runtime = join(root, "runtime");
  const wrapper = join(root, "verify-parent.ps1");
  try {
    mkdirSync(runtime);
    writeFileSync(join(root, "tracked.txt"), "parent\n", "utf8");
    for (const args of [
      ["init", "-q", root],
      ["-C", root, "add", "tracked.txt"],
      ["-C", root, "-c", "user.name=Anti-Codex Test", "-c", "user.email=test@localhost", "commit", "-qm", "parent"],
    ]) {
      const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    }
    const quotedRoot = runtime.replaceAll("'", "''");
    writeFileSync(wrapper, [
      "$ErrorActionPreference='Stop'",
      `$SourceRoot='${quotedRoot}'`,
      "$failures=New-Object System.Collections.Generic.List[string]",
      "function Add-Failure { param([string]$Message); $failures.Add($Message) | Out-Null }",
      "function Get-SourceRuntimeManifestRevision { [pscustomobject]@{ ok=$false; head=''; clean=$false; provenance='runtime-manifest'; reason='trusted runtime manifest is missing' } }",
      "function Invoke-SourceProcess { param([string]$Name,[string]$FilePath,[string[]]$Arguments,[int]$TimeoutSec); $old=$ErrorActionPreference; try { $ErrorActionPreference='SilentlyContinue'; $output=@(& $FilePath @Arguments 2>$null); $code=$LASTEXITCODE } finally { $ErrorActionPreference=$old }; [pscustomobject]@{ ok=($code -eq 0); stdoutTail=$output; stderrTail=@(); exitCode=$code } }",
      revisionHelper,
      "[pscustomobject]@{ result=(Test-SourceGitRevision); failures=@($failures) } | ConvertTo-Json -Depth 6 -Compress",
      "",
    ].join("\n"), "utf8");
    const result = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
    ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(report.result.provenance, "runtime-manifest");
    assert.equal(report.result.ok, false);
    assert.equal(report.failures.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
