import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..");
const scriptPath = resolve(root, "scripts", "prepare-codexplusplus-candidate.ps1");
const hygienePath = resolve(root, "scripts", "test-anticodex-docker-build-hygiene.ps1");
const cargoRunnerPath = resolve(root, "scripts", "invoke-anticodex-cargo-xwin.ps1");
const responseHistoryPatchFile = "patches/0013-v171-response-history.patch";
const responseHistoryBuildCommand = "test --locked -p codex-plus-core --test response_history -- --test-threads=2";

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(repository, ...args) {
  return run("git.exe", ["-C", repository, ...args]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createSuccessFixture(t, { annotatedTag = false, plainPatch = false, responseHistoryPatch = true } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "anticodex-cpp-candidate-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const project = join(sandbox, "project");
  const repository = join(sandbox, "upstream");
  const stateRoot = join(sandbox, "state");
  const logPath = join(sandbox, "calls.log");
  const activeSentinel = join(sandbox, "local-app-data", "Anti-Codex", "active-sentinel.txt");
  const patchFile = responseHistoryPatch ? responseHistoryPatchFile : "patches/0001-test.patch";
  const patchPath = join(project, "third_party", "codexplusplus", patchFile);

  write(activeSentinel, "active-unchanged\n");
  write(join(repository, "Cargo.toml"), '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.2.44"\n');
  write(join(repository, "marker.txt"), "base\n");
  run("git.exe", ["init", repository]);
  git(repository, "config", "user.email", "candidate-test@example.invalid");
  git(repository, "config", "user.name", "Candidate Test");
  git(repository, "config", "core.autocrlf", "false");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "upstream");
  const upstreamCommit = git(repository, "rev-parse", "HEAD");
  if (annotatedTag) {
    git(repository, "tag", "-a", "v1.2.44", "-m", "release v1.2.44");
  } else {
    git(repository, "tag", "v1.2.44");
  }
  const upstreamTagObject = git(repository, "rev-parse", "v1.2.44");
  write(join(repository, "marker.txt"), "patched\n");
  git(repository, "add", "marker.txt");
  git(repository, "commit", "-m", "isolation patch");
  const patch = plainPatch
    ? git(repository, "diff", "v1.2.44..HEAD")
    : git(repository, "format-patch", "-1", "--stdout");
  git(repository, "reset", "--hard", "v1.2.44");
  write(join(repository, "default-only.txt"), "must not be fetched\n");
  git(repository, "add", "default-only.txt");
  git(repository, "commit", "-m", "default branch only");
  const defaultHead = git(repository, "rev-parse", "HEAD");

  write(patchPath, `${patch}\n`);
  write(
    join(project, "third_party", "codexplusplus", "upstream.json"),
    `${JSON.stringify({
      component: "CodexPlusPlus",
      repository,
      license: "AGPL-3.0-only",
      version: "1.2.43",
      tag: "v1.2.43",
      upstreamCommit: "0".repeat(40),
      isolationPatchCommit: "1".repeat(40),
      patchCommit: "2".repeat(40),
      patches: [{
        file: patchFile,
        sha256: sha256(Buffer.from(`${patch}\n`)),
        scope: "test isolation",
      }],
      verification: {},
    }, null, 2)}\n`,
  );
  mkdirSync(join(project, "scripts"), { recursive: true });
  copyFileSync(scriptPath, join(project, "scripts", "prepare-codexplusplus-candidate.ps1"));
  write(
    join(project, "scripts", "test-codexplusplus-isolation-compatibility.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.ANTICODEX_TEST_LOG, \`audit \${process.argv.slice(2).join(" ")}\\n\`);
if (!process.argv.includes("--source")) process.exit(2);
`,
  );
  write(
    join(project, "scripts", "invoke-anticodex-cargo-xwin.ps1"),
    `[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Worktree,
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$CargoArguments
)
$image = "test/cargo-xwin:fixed"
Add-Content -LiteralPath $env:ANTICODEX_TEST_LOG -Value ("cargo " + ($CargoArguments -join " "))
if ($env:ANTICODEX_TEST_FAIL -and $CargoArguments -contains $env:ANTICODEX_TEST_FAIL) {
  throw "managed $env:ANTICODEX_TEST_FAIL failed"
}
if ($CargoArguments -contains "build") {
  $binary = Join-Path $Worktree "target\\x86_64-pc-windows-msvc\\release\\codex-plus-plus.exe"
  New-Item -ItemType Directory -Path (Split-Path -Parent $binary) -Force | Out-Null
  if ($env:ANTICODEX_TEST_INVALID_BINARY) {
    [IO.File]::WriteAllText($binary, "candidate-binary", [Text.UTF8Encoding]::new($false))
  } else {
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot "System32\\where.exe") -Destination $binary
  }
}
`,
  );
  write(
    join(project, "scripts", "test-anticodex-docker-build-hygiene.ps1"),
    `param([switch]$RequireRuntimeClean)
if (-not $RequireRuntimeClean) { throw "runtime clean switch is required" }
if ($env:ANTICODEX_TEST_HYGIENE_FAIL) { throw "stale build container" }
Add-Content -LiteralPath $env:ANTICODEX_TEST_LOG -Value "hygiene runtime-clean"
`,
  );

  return {
    sandbox,
    project,
    repository,
    stateRoot,
    logPath,
    activeSentinel,
    upstreamCommit,
    upstreamTagObject,
    defaultHead,
  };
}

function runCandidate(fixture, env = {}, stateRoot = fixture.stateRoot) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(fixture.project, "scripts", "prepare-codexplusplus-candidate.ps1"),
      "-Tag",
      "v1.2.44",
      "-StateRoot",
      stateRoot,
    ],
    {
      cwd: fixture.project,
      env: {
        ...process.env,
        LOCALAPPDATA: join(fixture.sandbox, "local-app-data"),
        ANTICODEX_TEST_LOG: fixture.logPath,
        ...env,
      },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("CodexPlusPlus candidate preparation cannot activate or restart Anti-Codex", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /\[string\]\$Tag/);
  assert.match(script, /third_party\\codexplusplus\\upstream\.json/);
  assert.match(script, /test-codexplusplus-isolation-compatibility\.mjs/);
  assert.match(script, /invoke-anticodex-cargo-xwin\.ps1/);
  assert.match(script, /-CargoArguments\s+\$command/);
  assert.match(script, /foreach \(\$command in \$commands\)[\s\S]{0,120}\n\s*& \$managedCargoRunner/);
  assert.match(script, /test-anticodex-docker-build-hygiene\.ps1/);
  assert.match(script, /-RequireRuntimeClean/);
  assert.match(script, /upstream\.proposed\.json/);
  assert.match(script, /candidate\.json/);
  assert.doesNotMatch(script, /& \$managedCargoRunner[\s\S]{0,160}\$LASTEXITCODE/);
  assert.match(script, /Get-Command[\s\S]{0,160}-CommandType Application/);
  assert.match(script, /Copy-Item[\s\S]{0,200}\$patchSnapshot/);
  assert.doesNotMatch(script, /"clone",\s*"--no-checkout"/);
  assert.match(script, /"init",\s*\$worktree/);
  assert.match(script, /refs\/tags\/\$\{Tag\}:refs\/tags\/\$\{Tag\}/);
  assert.match(script, /"core\.autocrlf",\s*"false"/);
  assert.match(script, /"commit\.gpgSign",\s*"false"/);
  assert.match(script, /"apply\.whitespace",\s*"nowarn"/);
  assert.match(script, /\[Threading\.Mutex\]/);
  assert.match(script, /WaitOne/);
  assert.match(script, /ReleaseMutex/);
  assert.match(script, /\$stage\s*=\s*"candidate_binary_copy"/);
  assert.match(script, /\$stage\s*=\s*"candidate_launchability"/);
  assert.match(script, /--helper-only --helper-port 0/);
  assert.match(script, /CODEX_PLUS_STATE_DIR/);
  assert.match(script, /function Remove-DirectoryTree/);
  assert.match(script, /for \(\$attempt = 1; \$attempt -le 30;/);
  assert.match(script, /\[IO\.Directory\]::Delete\(\$deletePath, \$true\)/);
  assert.match(script, /\[IO\.File\]::SetAttributes/);
  assert.match(script, /cargo-xwin container exited with code -1\$/);
  assert.doesNotMatch(
    script,
    /\bdocker(?:\.exe)?\s+(?:run|ps|container|rm|create)\b|sync-anticodex|install-codexplusplus|Stop-Process|Restart-Computer|schtasks/i,
  );
});

test("managed Cargo runner treats an absent ephemeral container as clean", () => {
  const script = readFileSync(cargoRunnerPath, "utf8");

  assert.match(script, /\$CargoArguments\[0\]\s+-ceq\s+"fmt"/);
  assert.match(script, /Push-Location\s+\$resolvedWorktree/);
  assert.match(script, /docker container ls --all --quiet --filter/);
  assert.doesNotMatch(script, /docker container inspect/);
});

test("Docker build hygiene can require zero labeled build containers", () => {
  const hygiene = readFileSync(hygienePath, "utf8");
  assert.match(hygiene, /\[switch\]\$RequireRuntimeClean/);
  assert.match(hygiene, /ps",\s*"-a"/);
  assert.match(hygiene, /label=com\.anticodex\.ephemeral-build=true/);
  assert.match(hygiene, /throw \(\$failures -join/);
  assert.doesNotMatch(hygiene, /\bexit\s+1\b/);
});

test("managed Cargo builds cap worker concurrency at one", () => {
  const runner = readFileSync(cargoRunnerPath, "utf8");
  assert.match(runner, /"--env",\s*"CARGO_BUILD_JOBS=1"/);
});

test("CodexPlusPlus candidate preparation peels and verifies an exact annotated tag", (t) => {
  const fixture = createSuccessFixture(t, { annotatedTag: true });
  const result = runCandidate(fixture);

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.version, "1.2.44");
  assert.notEqual(fixture.upstreamTagObject, fixture.upstreamCommit);
  assert.equal(git(fixture.repository, "cat-file", "-t", fixture.upstreamTagObject), "tag");
  assert.equal(output.upstreamCommit, fixture.upstreamCommit);
  assert.notEqual(output.upstreamCommit, fixture.upstreamTagObject);
  assert.match(output.patchCommit, /^[0-9a-f]{40}$/);

  const candidateRoot = join(
    fixture.stateRoot,
    "candidates",
    "1.2.44",
    fixture.upstreamCommit,
    output.patchCommit,
  );
  const report = JSON.parse(readFileSync(join(candidateRoot, "candidate.json"), "utf8"));
  const proposed = JSON.parse(readFileSync(join(candidateRoot, "upstream.proposed.json"), "utf8"));
  const binary = readFileSync(join(candidateRoot, "codex-plus-plus.exe"));
  assert.equal(report.upstreamCommit, fixture.upstreamCommit);
  assert.equal(report.binary.sha256, sha256(binary));
  assert.ok(report.checks.includes("clean_source"));
  assert.ok(report.checks.includes("build_hygiene_preflight"));
  assert.ok(report.checks.includes("build_hygiene_postflight"));
  assert.ok(report.checks.includes("windows_process_creation"));
  assert.ok(report.checks.includes("response_history"));
  assert.equal(
    report.inputs.sourceMetadata.sha256,
    sha256(readFileSync(join(fixture.project, "third_party", "codexplusplus", "upstream.json"))),
  );
  assert.equal(
    report.inputs.prepareScript.sha256,
    sha256(readFileSync(join(fixture.project, "scripts", "prepare-codexplusplus-candidate.ps1"))),
  );
  assert.equal(report.build.runnerImage, "test/cargo-xwin:fixed");
  assert.deepEqual(report.build.commands, [
    "fmt --all -- --check",
    "test --locked -p codex-plus-core --test protocol_proxy -- --test-threads=2",
    "test --locked -p codex-plus-core --test response_history -- --test-threads=2",
    "test --locked -p codex-plus-core --lib response_history -- --test-threads=1",
    "test --locked -p codex-plus-core --lib proxy_stream_tests -- --test-threads=1",
    "test --locked -p codex-plus-core --test watcher -- --test-threads=2",
    "xwin check --locked --release --target x86_64-pc-windows-msvc -p codex-plus-manager",
    "xwin build --locked --release --target x86_64-pc-windows-msvc -p codex-plus-launcher",
  ]);
  assert.equal(proposed.version, "1.2.44");
  assert.equal(proposed.tag, "v1.2.44");
  assert.equal(proposed.upstreamCommit, fixture.upstreamCommit);
  assert.equal(proposed.verification.launcherReleaseBuild, `sha256:${sha256(binary)}`);
  assert.match(
    proposed.verification.patchReplay,
    new RegExp(`${output.patchCommit}.*tree ${report.patchTree}$`),
  );
  assert.match(proposed.verification.auditRegressionTests, /promotion preflight/i);
  const patchSnapshot = join(candidateRoot, "patches", `0001-${responseHistoryPatchFile.split("/").at(-1)}`);
  assert.equal(sha256(readFileSync(patchSnapshot)), proposed.patches[0].sha256);
  assert.equal(
    readFileSync(join(candidateRoot, "source", "marker.txt"), "utf8").replaceAll("\r\n", "\n"),
    "patched\n",
  );
  assert.equal(existsSync(join(candidateRoot, "source", "target")), false);
  const defaultObject = spawnSync(
    "git.exe",
    ["-C", join(candidateRoot, "source"), "cat-file", "-e", fixture.defaultHead],
    { encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(defaultObject.status, 0, "unrelated default-branch commit was fetched");
  assert.equal(git(join(candidateRoot, "source"), "for-each-ref", "--format=%(refname)", "refs/remotes"), "");
  const calls = readFileSync(fixture.logPath, "utf8").trim().split(/\r?\n/);
  assert.match(calls.shift(), /^audit --source /);
  assert.deepEqual(calls, [
    "hygiene runtime-clean",
    "cargo fmt --all -- --check",
    "cargo test --locked -p codex-plus-core --test protocol_proxy -- --test-threads=2",
    "cargo test --locked -p codex-plus-core --test response_history -- --test-threads=2",
    "cargo test --locked -p codex-plus-core --lib response_history -- --test-threads=1",
    "cargo test --locked -p codex-plus-core --lib proxy_stream_tests -- --test-threads=1",
    "cargo test --locked -p codex-plus-core --test watcher -- --test-threads=2",
    "cargo xwin check --locked --release --target x86_64-pc-windows-msvc -p codex-plus-manager",
    "cargo xwin build --locked --release --target x86_64-pc-windows-msvc -p codex-plus-launcher",
    "hygiene runtime-clean",
  ]);
  assert.equal(readFileSync(fixture.activeSentinel, "utf8"), "active-unchanged\n");
});

test("old CodexPlusPlus patch baselines do not request the response history test target", (t) => {
  const fixture = createSuccessFixture(t, { responseHistoryPatch: false });
  const result = runCandidate(fixture);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const report = JSON.parse(readFileSync(join(
    fixture.stateRoot,
    "candidates",
    "1.2.44",
    fixture.upstreamCommit,
    output.patchCommit,
    "candidate.json",
  ), "utf8"));
  const calls = readFileSync(fixture.logPath, "utf8").trim().split(/\r?\n/);
  assert.equal(report.build.commands.includes(responseHistoryBuildCommand), false);
  assert.equal(report.checks.includes("response_history"), false);
  assert.ok(report.checks.every((check) => typeof check === "string"));
  assert.equal(calls.includes(`cargo ${responseHistoryBuildCommand}`), false);
});

test("CodexPlusPlus candidate preparation replays a plain unified diff", (t) => {
  const fixture = createSuccessFixture(t, { plainPatch: true });
  const result = runCandidate(fixture);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const candidateRoot = join(
    fixture.stateRoot,
    "candidates",
    "1.2.44",
    fixture.upstreamCommit,
    output.patchCommit,
  );
  assert.equal(readFileSync(join(candidateRoot, "source", "marker.txt"), "utf8").replaceAll("\r\n", "\n"), "patched\n");
  assert.match(output.patchCommit, /^[0-9a-f]{40}$/);
});

test("preparing the same accepted candidate twice reuses it without rebuilding", (t) => {
  const fixture = createSuccessFixture(t);
  const first = runCandidate(fixture);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const firstOutput = JSON.parse(first.stdout);
  const candidateRoot = join(
    fixture.stateRoot,
    "candidates",
    "1.2.44",
    fixture.upstreamCommit,
    firstOutput.patchCommit,
  );
  const reportBefore = readFileSync(join(candidateRoot, "candidate.json"));
  const callsBefore = readFileSync(fixture.logPath, "utf8");

  const second = runCandidate(fixture);

  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.deepEqual(JSON.parse(second.stdout), firstOutput);
  assert.deepEqual(readFileSync(join(candidateRoot, "candidate.json")), reportBefore);
  assert.equal(readFileSync(fixture.logPath, "utf8"), callsBefore);
  assert.equal(existsSync(join(fixture.stateRoot, "failures", "latest.json")), false);
});

test("an incomplete accepted candidate is rebuilt instead of blocking the update lane", (t) => {
  const fixture = createSuccessFixture(t);
  const first = runCandidate(fixture);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const firstOutput = JSON.parse(first.stdout);
  const candidateRoot = join(
    fixture.stateRoot,
    "candidates",
    "1.2.44",
    fixture.upstreamCommit,
    firstOutput.patchCommit,
  );
  const binaryPath = join(candidateRoot, "codex-plus-plus.exe");
  const callsBefore = readFileSync(fixture.logPath, "utf8");
  rmSync(binaryPath);

  const second = runCandidate(fixture);

  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(existsSync(binaryPath), true);
  assert.deepEqual(JSON.parse(second.stdout).binary, firstOutput.binary);
  assert.notEqual(readFileSync(fixture.logPath, "utf8"), callsBefore);
});

test("changed verification inputs reject an existing candidate instead of reusing it", (t) => {
  const fixture = createSuccessFixture(t);
  const first = runCandidate(fixture);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const firstOutput = JSON.parse(first.stdout);
  const candidateRoot = join(
    fixture.stateRoot,
    "candidates",
    "1.2.44",
    fixture.upstreamCommit,
    firstOutput.patchCommit,
  );
  const reportBefore = readFileSync(join(candidateRoot, "candidate.json"));
  const callsBefore = readFileSync(fixture.logPath, "utf8");
  const auditPath = join(fixture.project, "scripts", "test-codexplusplus-isolation-compatibility.mjs");
  write(auditPath, `${readFileSync(auditPath, "utf8")}\n// verification contract changed\n`);

  const second = runCandidate(fixture);

  assert.notEqual(second.status, 0, "stale candidate unexpectedly reused");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "candidate_reuse");
  assert.match(failure.error, /verified identity/i);
  assert.deepEqual(readFileSync(join(candidateRoot, "candidate.json")), reportBefore);
  assert.equal(readFileSync(fixture.logPath, "utf8"), callsBefore);
});

test("independent state roots produce the same candidate identities and binary", (t) => {
  const fixture = createSuccessFixture(t);
  const first = runCandidate(fixture, {}, join(fixture.sandbox, "state-a"));
  const second = runCandidate(fixture, {}, join(fixture.sandbox, "state-b"));

  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const left = JSON.parse(first.stdout);
  const right = JSON.parse(second.stdout);
  assert.equal(right.upstreamCommit, left.upstreamCommit);
  assert.equal(right.isolationPatchCommit, left.isolationPatchCommit);
  assert.equal(right.patchCommit, left.patchCommit);
  assert.equal(right.patchTree, left.patchTree);
  assert.deepEqual(right.binary, left.binary);
});

test("an existing candidate with dirty source is rejected instead of reused", (t) => {
  const fixture = createSuccessFixture(t);
  const first = runCandidate(fixture);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const firstOutput = JSON.parse(first.stdout);
  const candidateRoot = join(
    fixture.stateRoot,
    "candidates",
    "1.2.44",
    fixture.upstreamCommit,
    firstOutput.patchCommit,
  );
  const callsBefore = readFileSync(fixture.logPath, "utf8");
  write(join(candidateRoot, "source", "untracked.txt"), "tampered\n");

  const second = runCandidate(fixture);

  assert.notEqual(second.status, 0, "dirty existing candidate unexpectedly reused");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "candidate_reuse");
  assert.match(failure.error, /clean/i);
  assert.equal(readFileSync(fixture.logPath, "utf8"), callsBefore);
});

test("CodexPlusPlus patch conflicts stop before verification and publish no candidate", (t) => {
  const fixture = createSuccessFixture(t);
  const metadataPath = join(fixture.project, "third_party", "codexplusplus", "upstream.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const patchPath = join(fixture.project, "third_party", "codexplusplus", metadata.patches[0].file);
  const conflictingPatch = readFileSync(patchPath, "utf8").replace(/^-base\r?$/m, "-missing");
  write(patchPath, conflictingPatch);
  metadata.patches[0].sha256 = sha256(Buffer.from(conflictingPatch));
  write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const result = runCandidate(fixture);
  assert.notEqual(result.status, 0, "conflicting patch unexpectedly succeeded");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "patch_replay");
  assert.equal(existsSync(fixture.logPath), false);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
  assert.equal(readFileSync(fixture.activeSentinel, "utf8"), "active-unchanged\n");
});

test("CodexPlusPlus candidate preparation rejects array-valued source identity fields", (t) => {
  const fixture = createSuccessFixture(t);
  const metadataPath = join(fixture.project, "third_party", "codexplusplus", "upstream.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.component = [metadata.component];
  write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const result = runCandidate(fixture);

  assert.notEqual(result.status, 0, "array-valued source identity unexpectedly succeeded");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "preflight");
  assert.match(failure.error, /string/i);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
});

test("CodexPlusPlus candidate preparation fails when the isolation audit executable cannot start", (t) => {
  const fixture = createSuccessFixture(t);
  const candidateScript = join(fixture.project, "scripts", "prepare-codexplusplus-candidate.ps1");
  write(
    candidateScript,
    readFileSync(candidateScript, "utf8").replace('"node.exe"', '"missing-anticodex-node.exe"'),
  );

  const result = runCandidate(fixture);
  assert.notEqual(result.status, 0, "missing audit executable unexpectedly succeeded");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "isolation_audit");
  assert.equal(existsSync(fixture.logPath), false);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
});

test("stale build containers stop candidate preparation before any Cargo command", (t) => {
  const fixture = createSuccessFixture(t);
  const result = runCandidate(fixture, { ANTICODEX_TEST_HYGIENE_FAIL: "1" });

  assert.notEqual(result.status, 0, "stale build container unexpectedly allowed preparation");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "build_hygiene_preflight");
  const calls = readFileSync(fixture.logPath, "utf8").trim().split(/\r?\n/);
  assert.equal(calls.some((line) => line.startsWith("cargo ")), false);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
});

test("CodexPlusPlus build failures publish only a failure report", (t) => {
  const fixture = createSuccessFixture(t);
  const result = runCandidate(fixture, { ANTICODEX_TEST_FAIL: "build" });

  assert.notEqual(result.status, 0, "failed build unexpectedly succeeded");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "verification", failure.error);
  assert.match(failure.error, /build/);
  const calls = readFileSync(fixture.logPath, "utf8").trim().split(/\r?\n/);
  assert.equal(calls.at(-1), "hygiene runtime-clean");
  assert.equal(calls.filter((line) => line === "hygiene runtime-clean").length, 2);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
  assert.equal(readFileSync(fixture.activeSentinel, "utf8"), "active-unchanged\n");
});

test("candidate preparation rejects a binary changed after the build copy", (t) => {
  const fixture = createSuccessFixture(t);
  const candidateScript = join(fixture.project, "scripts", "prepare-codexplusplus-candidate.ps1");
  const original = readFileSync(candidateScript, "utf8");
  const injected = original.replace(
    /(Copy-Item -LiteralPath \$builtBinary[^\r\n]*\r?\n)/,
    `$1    [IO.File]::AppendAllText((Join-Path $stagingRoot "codex-plus-plus.exe"), "tampered")\n`,
  );
  assert.notEqual(injected, original, "binary-copy fault injection was not installed");
  write(candidateScript, injected);

  const result = runCandidate(fixture);

  assert.notEqual(result.status, 0, "post-copy binary tampering unexpectedly succeeded");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "candidate_binary_copy");
  assert.match(failure.error, /changed during candidate staging/i);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
});

test("candidate preparation rejects an executable Windows cannot start", (t) => {
  const fixture = createSuccessFixture(t);

  const result = runCandidate(fixture, { ANTICODEX_TEST_INVALID_BINARY: "1" });

  assert.notEqual(result.status, 0, "unlaunchable candidate unexpectedly succeeded");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "candidate_launchability");
  assert.match(failure.error, /Windows refused to start|security software|quarantined/i);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
  assert.equal(readFileSync(fixture.activeSentinel, "utf8"), "active-unchanged\n");
});

test("candidate launchability reports a binary removed before process creation", (t) => {
  const fixture = createSuccessFixture(t);
  const candidateScript = join(fixture.project, "scripts", "prepare-codexplusplus-candidate.ps1");
  const original = readFileSync(candidateScript, "utf8");
  const injected = original.replace(
    /(\$stage = "candidate_launchability"\r?\n\s+)(Assert-CandidateWindowsLaunchable -BinaryPath \$stagedBinary)/,
    `$1Remove-Item -LiteralPath $stagedBinary -Force\n    $2`,
  );
  assert.notEqual(injected, original, "pre-launch removal injection was not installed");
  write(candidateScript, injected);

  const result = runCandidate(fixture);

  assert.notEqual(result.status, 0, "missing candidate unexpectedly succeeded");
  const failure = JSON.parse(readFileSync(join(fixture.stateRoot, "failures", "latest.json"), "utf8"));
  assert.equal(failure.stage, "candidate_launchability");
  assert.match(failure.error, /disappeared|security software|quarantined/i);
  assert.equal(existsSync(join(fixture.stateRoot, "candidates")), false);
});
