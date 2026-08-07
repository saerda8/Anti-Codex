import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const syncScript = resolve(repoRoot, "scripts", "sync-anticodex-runtime.ps1");
const syncSource = readFileSync(syncScript, "utf8");
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function quotedArray(name) {
  const match = syncSource.match(new RegExp(`\\$${name}\\s*=\\s*@\\(([\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `missing ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

const requiredFiles = quotedArray("requiredSourceFiles");
const syntaxFiles = quotedArray("syntaxCheckedJavaScriptFiles");
const publicDocs = quotedArray("publicDocFiles");

function writeFixture(path, text = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function initializeGitFixture(fixture) {
  for (const args of [
    ["init", "-q", fixture.sourceRoot],
    ["-C", fixture.sourceRoot, "add", "-A"],
    ["-C", fixture.sourceRoot, "-c", "user.name=Anti-Codex Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  }
  return spawnSync("git", ["-C", fixture.sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim().toLowerCase();
}

function snapshotTree(root) {
  const entries = [];
  function visit(directory, parent = "") {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const absolute = join(directory, name);
      const relative = parent ? `${parent}\\${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: "link", target: readlinkSync(absolute) });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        visit(absolute, relative);
      } else if (stat.isFile()) {
        entries.push({
          path: relative,
          type: "file",
          length: stat.size,
          sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        });
      } else {
        entries.push({ path: relative, type: "other" });
      }
    }
  }
  visit(root);
  return entries;
}

function manifestInventory(directory) {
  const entries = {};
  for (const entry of snapshotTree(directory)) {
    if (entry.path === ".anticodex-runtime-manifest.json") continue;
    entries[entry.path] = entry.type === "file"
      ? { type: "file", length: entry.length, sha256: entry.sha256 }
      : { type: entry.type };
  }
  return entries;
}

function functionSource(name) {
  const marker = `function ${name}`;
  const start = syncSource.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = syncSource.indexOf("\nfunction ", start + marker.length);
  return syncSource.slice(start, next === -1 ? syncSource.length : next);
}

function createTrustedRuntimeVersion(fixture, name, createdAt) {
  const directory = join(fixture.installRoot, "runtime-versions", name);
  const files = {};
  for (const relative of requiredFiles) {
    const source = join(fixture.sourceRoot, ...relative.split("\\"));
    const destination = join(directory, ...relative.split("\\"));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    files[relative] = createHash("sha256").update(readFileSync(destination)).digest("hex");
  }
  const transactionId = name.startsWith("staged-")
    ? name.slice("staged-".length)
    : `source-${name}`;
  const entries = manifestInventory(directory);
  writeFixture(
    join(directory, ".anticodex-runtime-manifest.json"),
    `${JSON.stringify({
      schema: "anticodex-runtime-manifest-v2",
      state: "validated",
      transactionId,
      sourceRoot: fixture.sourceRoot,
      activeRuntime: fixture.activeRuntime,
      stagedRuntime: directory,
      verifiedFileCount: requiredFiles.length,
      entryCount: Object.keys(entries).length,
      createdAt,
      files,
      entries,
    }, null, 2)}\n`,
  );
  return directory;
}

function createFixture({ repairOk = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "anticodex-runtime-sync-test-"));
  const localAppData = join(root, "Local");
  const appData = join(root, "Roaming");
  const sourceRoot = join(root, "source");
  const installRoot = join(localAppData, "Anti-Codex");
  const activeRuntime = join(installRoot, "runtime");

  for (const relative of new Set([...requiredFiles, ...syntaxFiles, ...publicDocs])) {
    const path = join(sourceRoot, ...relative.split("\\"));
    const extension = relative.toLowerCase().split(".").pop();
    const content = extension === "json"
      ? "{}\n"
      : (extension === "mjs" || extension === "js")
        ? "// valid fixture\n"
        : "fixture\n";
    writeFixture(path, content);
  }
  for (const directory of ["scripts", "translator", "assets", "codex-home-deepseek-app", "third_party"]) {
    mkdirSync(join(sourceRoot, directory), { recursive: true });
  }

  writeFixture(
    join(sourceRoot, "scripts", "repair-anticodex-shortcuts.ps1"),
    [
      "param([string]$InstallRoot)",
      "Set-Content -LiteralPath (Join-Path $InstallRoot 'repair-invoked.txt') -Value 'yes' -Encoding ASCII",
      `[pscustomobject]@{ ok = $${repairOk ? "true" : "false"} } | ConvertTo-Json -Compress`,
      "",
    ].join("\n"),
  );
  writeFixture(
    join(sourceRoot, "scripts", "install-anticodex-shared-mcp.ps1"),
    [
      "param([string]$InstallRoot, [string]$SourceScript)",
      "[pscustomobject]@{ ok = $true; changed = $false; action = 'fixture'; target = $InstallRoot; source = $SourceScript } | ConvertTo-Json -Compress",
      "",
    ].join("\n"),
  );
  writeFixture(
    join(sourceRoot, "scripts", "resolve-anticodex-base-url.ps1"),
    "'http://127.0.0.1:19999'\n",
  );
  writeFixture(join(activeRuntime, "old-active-sentinel.txt"), "old-active\n");
  writeFixture(
    join(activeRuntime, "scripts", "repair-anticodex-shortcuts.ps1"),
    [
      "param([string]$InstallRoot)",
      "Set-Content -LiteralPath (Join-Path $InstallRoot 'restored-repair-invoked.txt') -Value 'legacy-runtime' -Encoding ASCII",
      "[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress",
      "",
    ].join("\n"),
  );
  mkdirSync(appData, { recursive: true });

  const fixture = {
    root,
    localAppData,
    appData,
    sourceRoot,
    installRoot,
    activeRuntime,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
      PSModulePath: [
        join(process.env.USERPROFILE || "C:\\Users\\Default", "Documents", "WindowsPowerShell", "Modules"),
        "C:\\Program Files\\WindowsPowerShell\\Modules",
        join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"),
      ].join(";"),
    },
  };
  fixture.sourceGitHead = initializeGitFixture(fixture);
  return fixture;
}

function runSync(fixture, options = {}) {
  const {
    extraArgs = [],
    timeout = 120_000,
    noRestart = true,
    env: envOverrides = {},
    wrapperPrelude = [],
  } = options;
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const wrapper = join(fixture.root, "run-sync.ps1");
  const forwarded = extraArgs.map((value) => quote(value)).join(" ");
  const noRestartArgument = noRestart ? " -NoRestart" : "";
  writeFixture(
    wrapper,
    [
      "$ErrorActionPreference = 'Stop'",
      "Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop",
      ...wrapperPrelude,
      `& ${quote(syncScript)} -SourceRoot ${quote(fixture.sourceRoot)} -TargetRuntime ${quote(fixture.activeRuntime)}${noRestartArgument} -TimeoutSec 1 ${forwarded}`,
      "",
    ].join("\n"),
  );
  return spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      wrapper,
    ],
    {
      cwd: repoRoot,
      env: {
        ...fixture.env,
        ANTICODEX_RUNTIME_SYNC_TEST_ROOT: fixture.installRoot,
        ANTICODEX_RUNTIME_SYNC_TEST_NO_PROCESSES: "1",
        ANTICODEX_RUNTIME_SYNC_TEST_SKIP_SYNTAX: "1",
        ...envOverrides,
      },
      encoding: "utf8",
      timeout,
      windowsHide: true,
    },
  );
}

function lastJson(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  assert.fail(`no JSON result in stdout: ${stdout}`);
}

async function holdSyncMutex(name = "Global\\AntiCodexHostSync") {
  const escapedName = String(name).replaceAll("'", "''");
  const command = [
    `$mutex = [Threading.Mutex]::new($false, '${escapedName}')`,
    "$null = $mutex.WaitOne()",
    "[Console]::Out.WriteLine('MUTEX_READY')",
    "[Console]::Out.Flush()",
    "Start-Sleep -Seconds 30",
  ].join("; ");
  const child = spawn(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("mutex holder did not become ready")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`mutex holder exited early: ${code}`));
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("MUTEX_READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
}

test("verified process termination binds identity and termination to one Windows handle", () => {
  assert.match(syncSource, /class VerifiedProcessHandle\s*:\s*IDisposable/);
  for (const nativeCall of [
    "OpenProcess",
    "GetProcessTimes",
    "QueryFullProcessImageName",
    "TerminateProcess",
    "WaitForSingleObject",
  ]) {
    assert.match(syncSource, new RegExp(`\\b${nativeCall}\\b`));
  }
  const snapshot = functionSource("Get-AntiCodexScriptProcessSnapshot");
  const stop = functionSource("Stop-AntiCodexVerifiedScriptProcess");
  assert.match(snapshot, /CreationFileTimeUtcTicks/);
  assert.match(stop, /\[AntiCodex\.Native\.VerifiedProcessHandle\]::Open\(\$processId\)/);
  assert.match(stop, /CreationFileTimeUtcTicks/);
  assert.match(stop, /\.TerminateAndWait\(3000\)/);
  assert.doesNotMatch(stop, /\bStop-Process\b/);
});

test("release process snapshots use native creation identity instead of lossy CIM timestamps", () => {
  for (const file of [
    "scripts/sync-anticodex.ps1",
    "scripts/refresh-anticodex-models.ps1",
    "scripts/rollback-anticodex.ps1",
  ]) {
    const source = readFileSync(resolve(repoRoot, file), "utf8");
    const start = source.indexOf("function Get-AntiCodexProcessIdentity");
    const end = source.indexOf("function Stop-AntiCodexVerifiedProcess", start);
    const snapshot = source.slice(start, end);
    assert.match(snapshot, /VerifiedProcessHandle\]::Open\(\$processId\)/);
    assert.match(snapshot, /processHandle\.CreationFileTimeUtcTicks/);
    assert.match(snapshot, /processHandle\.ExecutablePath/);
    assert.match(snapshot, /processHandle\.Dispose\(\)/);
    assert.doesNotMatch(snapshot, /CreationDate|ToFileTimeUtc/);
  }
});

test("verified process handle terminates only a disposable process through the bound handle", async () => {
  const classMatch = syncSource.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(classMatch, "missing VerifiedProcessHandle type source");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "anticodex-handle-test-"));
  const wrapper = join(fixtureRoot, "terminate-temp-process.ps1");
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); Start-Sleep -Seconds 30",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("temporary process did not become ready")), 10_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`temporary process exited early: ${code}`));
      });
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("READY")) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
    });
    writeFixture(
      wrapper,
      [
        "Add-Type -TypeDefinition @'",
        classMatch[1],
        "'@",
        `$handle = [AntiCodex.Native.VerifiedProcessHandle]::Open(${child.pid})`,
        "try {",
        "  $handle.TerminateAndWait(3000)",
        "  [pscustomobject]@{ ok = $true; exited = $handle.HasExited } | ConvertTo-Json -Compress",
        "} finally {",
        "  $handle.Dispose()",
        "}",
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(lastJson(result.stdout), { ok: true, exited: true });
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  } finally {
    stopChild(child);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("runtime sync rejects a concurrent global host sync before touching active", async () => {
  const fixture = createFixture();
  const holder = await holdSyncMutex();
  try {
    const result = runSync(fixture);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /Another Anti-Codex sync is already running/);
    assert.equal(readFileSync(join(fixture.activeRuntime, "old-active-sentinel.txt"), "utf8"), "old-active\n");
    assert.equal(existsSync(join(fixture.installRoot, "runtime-versions")), false);
  } finally {
    stopChild(holder);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime sync rejects a concurrent legacy local host sync before touching active", async () => {
  const fixture = createFixture();
  const holder = await holdSyncMutex("Local\\AntiCodexHostSync");
  try {
    const result = runSync(fixture);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /Another Anti-Codex sync is already running/);
    assert.equal(readFileSync(join(fixture.activeRuntime, "old-active-sentinel.txt"), "utf8"), "old-active\n");
    assert.equal(existsSync(join(fixture.installRoot, "runtime-versions")), false);
  } finally {
    stopChild(holder);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime sync rejects an unverified non-Git source before staging", () => {
  const fixture = createFixture();
  const activeBefore = snapshotTree(fixture.activeRuntime);
  try {
    rmSync(join(fixture.sourceRoot, ".git"), { recursive: true, force: true });
    const result = runSync(fixture);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /clean Git revision/i);
    assert.deepEqual(snapshotTree(fixture.activeRuntime), activeBefore);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("NoRestart with a live runtime process validates a versioned stage but leaves active untouched", () => {
  const fixture = createFixture();
  const obsoleteStage = createTrustedRuntimeVersion(
    fixture,
    "staged-obsolete",
    "2026-07-20T00:00:00.000Z",
  );
  const olderRollback = createTrustedRuntimeVersion(
    fixture,
    "rollback-older",
    "2026-07-19T00:00:00.000Z",
  );
  const newestRollback = createTrustedRuntimeVersion(
    fixture,
    "rollback-newest",
    "2026-07-21T00:00:00.000Z",
  );
  const contaminatedStage = createTrustedRuntimeVersion(
    fixture,
    "staged-contaminated",
    "2026-07-18T00:00:00.000Z",
  );
  writeFixture(join(contaminatedStage, "do-not-delete-extra.txt"), "unknown-extra\n");
  const uncertainStage = join(fixture.installRoot, "runtime-versions", "staged-uncertain");
  const uncertainRollback = join(fixture.installRoot, "runtime-versions", "rollback-uncertain");
  writeFixture(join(uncertainStage, "do-not-delete.txt"), "unknown\n");
  writeFixture(join(uncertainRollback, "do-not-delete.txt"), "unknown\n");
  const liveScript = join(fixture.activeRuntime, "scripts", "live-runtime.mjs");
  writeFixture(liveScript, "setTimeout(() => {}, 30000);\n");
  const activeBefore = snapshotTree(fixture.activeRuntime);
  const live = spawn(process.execPath, [liveScript], { windowsHide: true });
  try {
    const result = runSync(fixture, {
      env: { ANTICODEX_RUNTIME_SYNC_TEST_NO_PROCESSES: "0" },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = lastJson(result.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.mode, "staged_deferred_running");
    assert.equal(receipt.deferred, true);
    assert.equal(receipt.activated, false);
    assert.deepEqual(snapshotTree(fixture.activeRuntime), activeBefore);
    assert.equal(readFileSync(join(fixture.activeRuntime, "old-active-sentinel.txt"), "utf8"), "old-active\n");
    assert.equal(existsSync(join(fixture.installRoot, "repair-invoked.txt")), false);
    assert.equal(existsSync(receipt.stagedRuntime), true);
    assert.equal(existsSync(join(receipt.stagedRuntime, ".anticodex-runtime-manifest.json")), true);
    assert.equal(existsSync(obsoleteStage), false);
    assert.equal(existsSync(olderRollback), false);
    assert.equal(existsSync(newestRollback), true);
    assert.equal(existsSync(contaminatedStage), true);
    assert.equal(existsSync(uncertainStage), true);
    assert.equal(existsSync(uncertainRollback), true);
    assert.ok(receipt.cleanup.removed.includes(obsoleteStage));
    assert.ok(receipt.cleanup.removed.includes(olderRollback));
    assert.ok(receipt.cleanup.kept.includes(receipt.stagedRuntime));
    assert.ok(receipt.cleanup.kept.includes(newestRollback));
    assert.ok(receipt.cleanup.skipped.includes(contaminatedStage));
    assert.ok(receipt.cleanup.skipped.includes(uncertainStage));
    assert.ok(receipt.cleanup.skipped.includes(uncertainRollback));
  } finally {
    stopChild(live);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime sync refuses a reparse-point runtime-versions root without touching its target", () => {
  const fixture = createFixture();
  const externalRoot = mkdtempSync(join(tmpdir(), "anticodex-runtime-versions-external-"));
  const versionsLink = join(fixture.installRoot, "runtime-versions");
  writeFixture(join(externalRoot, "outside-sentinel.txt"), "outside\n");
  let wrapperPrelude = [];
  try {
    symlinkSync(externalRoot, versionsLink, "junction");
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    mkdirSync(versionsLink, { recursive: true });
    wrapperPrelude = [String.raw`
function Get-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [switch]$Force
    )
    $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
    if ([IO.Path]::GetFullPath($LiteralPath).Equals(
        [IO.Path]::GetFullPath($env:ANTICODEX_TEST_REPARSE_PATH),
        [StringComparison]::OrdinalIgnoreCase
    )) {
        return [pscustomobject]@{
            PSIsContainer = $true
            Attributes = ($item.Attributes -bor [IO.FileAttributes]::ReparsePoint)
            FullName = $item.FullName
        }
    }
    return $item
}`];
  }
  try {
    const result = runSync(fixture, {
      env: { ANTICODEX_TEST_REPARSE_PATH: versionsLink },
      wrapperPrelude,
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /reparse|junction/i);
    assert.equal(readFileSync(join(externalRoot, "outside-sentinel.txt"), "utf8"), "outside\n");
    assert.equal(readFileSync(join(fixture.activeRuntime, "old-active-sentinel.txt"), "utf8"), "old-active\n");
    assert.deepEqual(readdirSync(externalRoot), ["outside-sentinel.txt"]);
  } finally {
    rmSync(versionsLink, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failure immediately after the old active rename restores the complete old tree", () => {
  const fixture = createFixture();
  const activeBefore = snapshotTree(fixture.activeRuntime);
  try {
    const result = runSync(fixture, {
      env: { ANTICODEX_RUNTIME_SYNC_TEST_FAULT: "after-active-move" },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /injected failure after active move/i);
    assert.equal(existsSync(fixture.activeRuntime), true);
    assert.deepEqual(snapshotTree(fixture.activeRuntime), activeBefore);
    const state = JSON.parse(readFileSync(join(fixture.installRoot, "runtime-sync-state.json"), "utf8"));
    assert.equal(state.state, "rolled_back");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("activation failure restores the exact old active directory", () => {
  const fixture = createFixture({ repairOk: false });
  try {
    assert.equal(existsSync(join(fixture.activeRuntime, "scripts", "start-anticodex-hidden-node.vbs")), false);
    const result = runSync(fixture);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /shortcuts could not be refreshed/i);
    assert.equal(readFileSync(join(fixture.activeRuntime, "old-active-sentinel.txt"), "utf8"), "old-active\n");
    assert.equal(existsSync(join(fixture.activeRuntime, "scripts", "start-anticodex.ps1")), false);
    assert.equal(readFileSync(join(fixture.installRoot, "restored-repair-invoked.txt"), "utf8").trim(), "legacy-runtime");
    const state = JSON.parse(readFileSync(join(fixture.installRoot, "runtime-sync-state.json"), "utf8"));
    assert.equal(state.state, "rolled_back");
    assert.equal(state.activeRuntime, fixture.activeRuntime);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restart failure restores and relaunches the old runtime before returning failure", () => {
  const fixture = createFixture();
  const launchLog = join(fixture.installRoot, "launch-attempts.jsonl");
  const activeBefore = snapshotTree(fixture.activeRuntime);
  try {
    assert.equal(existsSync(join(fixture.activeRuntime, ".anticodex-runtime-manifest.json")), false);
    const result = runSync(fixture, {
      noRestart: false,
      env: {
        ANTICODEX_RUNTIME_SYNC_TEST_ROOT: fixture.installRoot,
        ANTICODEX_RUNTIME_SYNC_TEST_LAUNCH_LOG: launchLog,
        ANTICODEX_RUNTIME_SYNC_TEST_LAUNCH_MODE: "fail-new-succeed-restored",
        ANTICODEX_RUNTIME_SYNC_TEST_HEALTH_MODE: "ready",
      },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /restart failed/i);
    assert.equal(existsSync(fixture.activeRuntime), true);
    assert.equal(existsSync(join(fixture.activeRuntime, ".anticodex-runtime-manifest.json")), false);
    assert.deepEqual(snapshotTree(fixture.activeRuntime), activeBefore);
    const attempts = readFileSync(launchLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].oldActivePresent, false);
    assert.equal(attempts[0].restoredShortcutRepairPresent, false);
    assert.equal(attempts[1].oldActivePresent, true);
    assert.equal(attempts[1].restoredShortcutRepairPresent, true);
    const state = JSON.parse(readFileSync(join(fixture.installRoot, "runtime-sync-state.json"), "utf8"));
    assert.equal(state.state, "rolled_back");
    assert.equal(state.restoredRuntimeReady, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("idle NoRestart sync atomically activates one complete staged directory", () => {
  const fixture = createFixture();
  try {
    const result = runSync(fixture);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = lastJson(result.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.mode, "synced_without_restart");
    assert.equal(receipt.deferred, false);
    assert.equal(receipt.activated, true);
    assert.equal(existsSync(join(fixture.activeRuntime, "old-active-sentinel.txt")), false);
    assert.equal(existsSync(join(fixture.activeRuntime, "scripts", "start-anticodex.ps1")), true);
    assert.equal(existsSync(join(fixture.activeRuntime, ".anticodex-runtime-manifest.json")), true);
    const manifest = JSON.parse(readFileSync(join(fixture.activeRuntime, ".anticodex-runtime-manifest.json"), "utf8"));
    assert.equal(manifest.sourceGitHead, fixture.sourceGitHead);
    assert.equal(manifest.sourceGitClean, true);
    assert.equal(manifest.sourceRevisionProvenance, "git");
    assert.equal(existsSync(receipt.rollbackRuntime), true);
    assert.equal(
      readFileSync(join(receipt.rollbackRuntime, "old-active-sentinel.txt"), "utf8"),
      "old-active\n",
    );
    const state = JSON.parse(readFileSync(join(fixture.installRoot, "runtime-sync-state.json"), "utf8"));
    assert.equal(state.state, "active");
    assert.equal(state.transactionId, receipt.transactionId);
    assert.equal(state.activeRuntime, fixture.activeRuntime);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
