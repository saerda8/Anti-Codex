import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..");
const installerSource = resolve(root, "scripts", "install-codexplusplus-component.ps1");
const trustedBinary = Buffer.from("trusted CodexPlusPlus release binary\n", "utf8");
const candidateInputFiles = {
  prepareScript: "prepare-codexplusplus-candidate.ps1",
  isolationAudit: "test-codexplusplus-isolation-compatibility.mjs",
  managedCargoRunner: "invoke-anticodex-cargo-xwin.ps1",
  hygieneVerifier: "test-anticodex-docker-build-hygiene.ps1",
};
const candidateBuildCommands = [
  "fmt --all -- --check",
  "test --locked -p codex-plus-core --test protocol_proxy",
  "test --locked -p codex-plus-core --test watcher",
  "xwin check --locked --release --target x86_64-pc-windows-msvc -p codex-plus-manager",
  "xwin build --locked --release --target x86_64-pc-windows-msvc -p codex-plus-launcher",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeBytes(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, value);
}

function createMetadata(expectedHash) {
  return {
    component: "CodexPlusPlus",
    license: "AGPL-3.0-only",
    repository: "https://example.invalid/CodexPlusPlus",
    version: "test-only",
    tag: "vtest-only",
    upstreamCommit: "0".repeat(40),
    isolationPatchCommit: "1".repeat(40),
    patchCommit: "2".repeat(40),
    verification: {
      launcherReleaseBuild: `sha256:${expectedHash}`,
    },
    patches: [],
  };
}

function writeJson(path, value) {
  writeBytes(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createInstallerSandbox(t) {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "anticodex-component-install-"));
  t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }));

  const sourceRoot = join(sandboxRoot, "source");
  const installerPath = join(sourceRoot, "scripts", "install-codexplusplus-component.ps1");
  const localAppData = join(sandboxRoot, "local-app-data");
  const activeRoot = join(localAppData, "Anti-Codex");
  const candidateRoot = join(activeRoot, "update-candidate");
  const activeComponent = join(activeRoot, "components", "codexplusplus");
  const candidateComponent = join(candidateRoot, "components", "codexplusplus");
  const preparedCandidateRoot = join(
    localAppData,
    "Anti-Codex",
    "component-sources",
    "codexplusplus",
    "candidates",
    "test-only",
    "0".repeat(40),
    "2".repeat(40),
  );

  mkdirSync(resolve(installerPath, ".."), { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  copyFileSync(installerSource, installerPath);
  for (const file of Object.values(candidateInputFiles)) {
    copyFileSync(resolve(root, "scripts", file), join(sourceRoot, "scripts", file));
  }

  return {
    sandboxRoot,
    sourceRoot,
    installerPath,
    localAppData,
    activeRoot,
    candidateRoot,
    activeBinary: join(activeComponent, "codex-plus-plus.exe"),
    activeMetadata: join(activeComponent, "upstream.json"),
    candidateBinary: join(candidateComponent, "codex-plus-plus.exe"),
    candidateMetadata: join(candidateComponent, "upstream.json"),
    candidateManifest: join(candidateComponent, "component-manifest.json"),
    candidatePendingBinary: join(candidateComponent, "codex-plus-plus.exe.anticodex-pending"),
    preparedCandidateBinary: join(preparedCandidateRoot, "codex-plus-plus.exe"),
    preparedCandidateMetadata: join(preparedCandidateRoot, "upstream.proposed.json"),
    preparedCandidateReport: join(preparedCandidateRoot, "candidate.json"),
    sourceMetadata: join(sourceRoot, "third_party", "codexplusplus", "upstream.json"),
  };
}

function writePreparedCandidate(
  fixture,
  binary,
  metadata,
  sourceMetadataHash = sha256(readFileSync(fixture.sourceMetadata)),
) {
  const scriptsRoot = join(fixture.sourceRoot, "scripts");
  const runnerText = readFileSync(
    join(scriptsRoot, candidateInputFiles.managedCargoRunner),
    "utf8",
  );
  const runnerImage = runnerText.match(/^\s*\$image\s*=\s*"(?<value>[^"]+)"\s*$/m)?.groups?.value;
  assert.ok(runnerImage, "managed candidate runner must expose a fixed image");
  writeBytes(fixture.preparedCandidateBinary, binary);
  writeJson(fixture.preparedCandidateMetadata, metadata);
  writeJson(fixture.preparedCandidateReport, {
    ok: true,
    schema: "codexplusplus-candidate-v1",
    version: metadata.version,
    tag: metadata.tag,
    upstreamCommit: metadata.upstreamCommit,
    isolationPatchCommit: metadata.isolationPatchCommit,
    patchCommit: metadata.patchCommit,
    binary: {
      path: "codex-plus-plus.exe",
      sha256: sha256(binary),
      length: binary.length,
    },
    inputs: {
      sourceMetadata: {
        path: "upstream.input.json",
        sha256: sourceMetadataHash,
      },
      ...Object.fromEntries(
        Object.entries(candidateInputFiles).map(([key, file]) => [key, {
          path: `scripts/${file}`,
          sha256: sha256(readFileSync(join(scriptsRoot, file))),
        }]),
      ),
    },
    build: {
      runnerImage,
      lockedDependencies: true,
      commands: candidateBuildCommands,
    },
  });
}

function runInstaller(fixture, extraArgs = [], envOverrides = {}) {
  const env = { ...process.env, LOCALAPPDATA: fixture.localAppData };
  delete env.ANTICODEX_CODEXPLUSPLUS_BINARY;
  env.PSModulePath = [
    join(process.env.ProgramFiles, "WindowsPowerShell", "Modules"),
    join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  ].join(";");
  Object.assign(env, envOverrides);
  return spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fixture.installerPath,
      "-InstallRoot",
      fixture.candidateRoot,
      ...extraArgs,
    ],
    {
      cwd: fixture.sourceRoot,
      env,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function assertSucceeded(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, combinedOutput(result));
}

function assertFailed(result, pattern) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "installer unexpectedly succeeded");
  assert.match(combinedOutput(result), pattern);
}

test("CodexPlusPlus component installer is hash-pinned and isolated", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  assert.match(installer, /third_party\\codexplusplus\\upstream\.json/);
  assert.match(installer, /verification\.launcherReleaseBuild/);
  assert.match(installer, /function Get-AntiCodexSha256/);
  assert.doesNotMatch(installer, /\bGet-FileHash\b/);
  assert.match(installer, /Join-Path \$resolvedInstallRoot "components\\codexplusplus"/);
  assert.match(installer, /Join-Path \$componentRoot "codex-plus-plus\.exe"/);
  assert.match(installer, /path = "codex-plus-plus\.exe"/);
  assert.match(installer, /codexplusplus-component-manifest-v1/);
  assert.match(installer, /AGPL-3\.0-only/);
  assert.match(installer, /patchCommit/);
  assert.match(installer, /-ne \$expectedHash/);
  assert.doesNotMatch(installer, /Invoke-WebRequest|Start-BitsTransfer|git clone/i);
});

test("CodexPlusPlus component SHA-256 works without Utility module autoload", (t) => {
  const installer = readFileSync(installerSource, "utf8");
  const helper = installer.match(/^function Get-AntiCodexSha256 \{[\s\S]*?^\}/m)?.[0];
  assert.ok(helper, "installer must define a local SHA-256 helper");

  const fixture = createInstallerSandbox(t);
  const samplePath = join(fixture.sandboxRoot, "hash-sample.bin");
  const harnessPath = join(fixture.sandboxRoot, "hash-without-utility.ps1");
  writeBytes(samplePath, trustedBinary);
  writeFileSync(
    harnessPath,
    `$ErrorActionPreference = "Stop"
$PSModuleAutoLoadingPreference = "None"
Remove-Module Microsoft.PowerShell.Utility -Force -ErrorAction SilentlyContinue
${helper}
[Console]::Out.Write((Get-AntiCodexSha256 -Path '${samplePath.replaceAll("'", "''")}'))
`,
  );

  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  assert.equal(result.status, 0, combinedOutput(result));
  assert.equal(result.stdout.trim(), sha256(trustedBinary).toUpperCase());
});

test("CodexPlusPlus update candidate is staged under the fixed install root only", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  assert.match(installer, /Join-Path \$expectedInstallRoot "update-candidate"/);
  assert.match(installer, /\$resolvedInstallRoot\s+-notin\s+\$allowedInstallRoots/);
  assert.doesNotMatch(installer, /\$resolvedInstallRoot\.StartsWith\(/);
});

test("host sync reuses the pinned active component before an accepted prepared candidate", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  const destinationBinary = installer.indexOf("$sourceCandidates.Add($destinationBinary)");
  const activeBinary = installer.indexOf('$activeBinary = Join-Path $expectedInstallRoot');
  const preparedCandidate = installer.indexOf("$preparedCandidateRoot =");
  assert.ok(destinationBinary >= 0, "installer must consider the staged destination first");
  assert.ok(activeBinary >= 0, "installer must consider the verified active component");
  assert.ok(destinationBinary < activeBinary, "the staged destination must be checked before the active component");
  assert.ok(preparedCandidate > activeBinary, "a prepared candidate must never override the active pinned component");
  assert.doesNotMatch(installer, /CodexPlusPlus-analysis-20260714/);
  assert.match(installer, /if \(\$candidateHash -eq \$expectedHash\)/);
  assert.match(installer, /\$rejectedSourceHashes \+=/);
  assert.match(installer, /if \(\$explicitSourceBinary\)[\s\S]*?SHA256 mismatch/);
});

test("installer rejects destination-owned metadata when trusted source metadata is missing", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  writeBytes(fixture.candidateBinary, trustedBinary);
  writeJson(fixture.candidateMetadata, createMetadata(expectedHash));

  const binaryBefore = readFileSync(fixture.candidateBinary);
  const metadataBefore = readFileSync(fixture.candidateMetadata);
  const result = runInstaller(fixture, ["-VerifyOnly"]);

  assertFailed(result, /metadata is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), binaryBefore);
  assert.deepEqual(readFileSync(fixture.candidateMetadata), metadataBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("explicit wrong-hash source fails closed without falling back or changing destination", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const wrongExplicitBinary = join(fixture.sourceRoot, "wrong-explicit.exe");
  const destinationBefore = Buffer.from("candidate destination must stay unchanged\n", "utf8");
  const metadataBefore = Buffer.from("destination metadata must stay unchanged\n", "utf8");
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, destinationBefore);
  writeBytes(fixture.candidateMetadata, metadataBefore);
  writeBytes(fixture.activeBinary, trustedBinary);
  writePreparedCandidate(fixture, trustedBinary, createMetadata(expectedHash));
  writeBytes(wrongExplicitBinary, Buffer.from("wrong explicit binary\n", "utf8"));

  const result = runInstaller(fixture, ["-SourceBinary", wrongExplicitBinary]);

  assertFailed(result, /SHA256 mismatch/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.deepEqual(readFileSync(fixture.candidateMetadata), metadataBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
  assert.equal(existsSync(fixture.candidatePendingBinary), false);
});

test("explicit environment source with a wrong hash fails closed without fallback", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const wrongEnvironmentBinary = join(fixture.sourceRoot, "wrong-environment.exe");
  const destinationBefore = Buffer.from("candidate destination must stay unchanged\n", "utf8");
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, destinationBefore);
  writeBytes(fixture.activeBinary, trustedBinary);
  writePreparedCandidate(fixture, trustedBinary, createMetadata(expectedHash));
  writeBytes(wrongEnvironmentBinary, Buffer.from("wrong environment binary\n", "utf8"));

  const result = runInstaller(fixture, [], {
    ANTICODEX_CODEXPLUSPLUS_BINARY: wrongEnvironmentBinary,
  });

  assertFailed(result, /SHA256 mismatch/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("automatic selection skips a wrong destination and installs the pinned active binary", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, Buffer.from("wrong candidate binary\n", "utf8"));
  writeBytes(fixture.activeBinary, trustedBinary);

  const result = runInstaller(fixture);

  assertSucceeded(result);
  assert.deepEqual(readFileSync(fixture.candidateBinary), trustedBinary);
  assert.equal(existsSync(fixture.candidateManifest), true);
  assert.equal(existsSync(fixture.candidatePendingBinary), false);
});

test("automatic selection skips wrong destination and active binaries then installs the accepted prepared candidate", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, Buffer.from("wrong candidate binary\n", "utf8"));
  writeBytes(fixture.activeBinary, Buffer.from("wrong active binary\n", "utf8"));
  writePreparedCandidate(fixture, trustedBinary, createMetadata(expectedHash));

  const result = runInstaller(fixture);

  assertSucceeded(result);
  assert.deepEqual(readFileSync(fixture.candidateBinary), trustedBinary);
  assert.equal(existsSync(fixture.candidateManifest), true);
  assert.equal(existsSync(fixture.candidatePendingBinary), false);
});

test("automatic selection accepts promoted metadata while preserving the historical source-input hash", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const metadata = createMetadata(expectedHash);
  const historicalInputHash = sha256(Buffer.from('{"version":"previous"}\n', "utf8"));
  writeJson(fixture.sourceMetadata, metadata);
  writeBytes(fixture.candidateBinary, Buffer.from("wrong candidate binary\n", "utf8"));
  writeBytes(fixture.activeBinary, Buffer.from("wrong active binary\n", "utf8"));
  writePreparedCandidate(fixture, trustedBinary, metadata, historicalInputHash);

  const result = runInstaller(fixture);

  assertSucceeded(result);
  assert.deepEqual(readFileSync(fixture.candidateBinary), trustedBinary);
  assert.equal(existsSync(fixture.candidateManifest), true);
});

test("automatic selection rejects a prepared candidate after verifier inputs change", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const destinationBefore = Buffer.from("destination must remain\n", "utf8");
  const metadata = createMetadata(expectedHash);
  writeJson(fixture.sourceMetadata, metadata);
  writeBytes(fixture.candidateBinary, destinationBefore);
  writeBytes(fixture.activeBinary, Buffer.from("wrong active binary\n", "utf8"));
  writePreparedCandidate(fixture, trustedBinary, metadata);
  const auditPath = join(
    fixture.sourceRoot,
    "scripts",
    candidateInputFiles.isolationAudit,
  );
  writeBytes(
    auditPath,
    Buffer.from(`${readFileSync(auditPath, "utf8")}\n// verifier changed\n`, "utf8"),
  );

  const result = runInstaller(fixture);

  assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("automatic selection rejects a prepared candidate whose identity is not accepted", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const destinationBefore = Buffer.from("wrong candidate binary that must remain\n", "utf8");
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, destinationBefore);
  const mismatchedMetadata = createMetadata(expectedHash);
  mismatchedMetadata.isolationPatchCommit = "9".repeat(40);
  writePreparedCandidate(fixture, trustedBinary, mismatchedMetadata);

  const result = runInstaller(fixture);

  assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("automatic selection rejects a prepared candidate whose report uses string false", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const destinationBefore = Buffer.from("wrong candidate binary that must remain\n", "utf8");
  const metadata = createMetadata(expectedHash);
  writeJson(fixture.sourceMetadata, metadata);
  writeBytes(fixture.candidateBinary, destinationBefore);
  writePreparedCandidate(fixture, trustedBinary, metadata);
  const report = JSON.parse(readFileSync(fixture.preparedCandidateReport, "utf8"));
  report.ok = "false";
  writeJson(fixture.preparedCandidateReport, report);

  const result = runInstaller(fixture);

  assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("trusted source metadata rejects array-valued identity fields", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const metadata = createMetadata(expectedHash);
  metadata.component = [metadata.component];
  writeJson(fixture.sourceMetadata, metadata);
  writeBytes(fixture.candidateBinary, Buffer.from("destination must remain\n", "utf8"));
  writeBytes(fixture.activeBinary, trustedBinary);

  const result = runInstaller(fixture);

  assertFailed(result, /string/i);
  assert.deepEqual(
    readFileSync(fixture.candidateBinary),
    Buffer.from("destination must remain\n", "utf8"),
  );
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("prepared candidate rejects array-valued proposed and report identities", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const destinationBefore = Buffer.from("destination must remain\n", "utf8");
  const metadata = createMetadata(expectedHash);
  writeJson(fixture.sourceMetadata, metadata);
  writeBytes(fixture.candidateBinary, destinationBefore);
  writePreparedCandidate(fixture, trustedBinary, metadata);
  const proposed = JSON.parse(readFileSync(fixture.preparedCandidateMetadata, "utf8"));
  const report = JSON.parse(readFileSync(fixture.preparedCandidateReport, "utf8"));
  proposed.isolationPatchCommit = [proposed.isolationPatchCommit];
  report.isolationPatchCommit = [report.isolationPatchCommit];
  writeJson(fixture.preparedCandidateMetadata, proposed);
  writeJson(fixture.preparedCandidateReport, report);

  const result = runInstaller(fixture);

  assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("prepared candidate report cannot hide changed binary bytes", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const destinationBefore = Buffer.from("destination must remain\n", "utf8");
  const metadata = createMetadata(expectedHash);
  writeJson(fixture.sourceMetadata, metadata);
  writeBytes(fixture.candidateBinary, destinationBefore);
  writePreparedCandidate(fixture, trustedBinary, metadata);
  writeBytes(fixture.preparedCandidateBinary, Buffer.from("changed after report\n", "utf8"));

  const result = runInstaller(fixture);

  assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
});

test("VerifyOnly preflight fails when every candidate hash is wrong and leaves destination untouched", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const destinationBefore = Buffer.from("wrong candidate binary that must remain\n", "utf8");
  const metadataBefore = Buffer.from("destination metadata that must remain\n", "utf8");
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, destinationBefore);
  writeBytes(fixture.candidateMetadata, metadataBefore);
  writeBytes(fixture.activeBinary, Buffer.from("wrong active binary\n", "utf8"));
  writePreparedCandidate(
    fixture,
    Buffer.from("wrong prepared candidate\n", "utf8"),
    createMetadata(expectedHash),
  );

  const result = runInstaller(fixture, ["-VerifyOnly"]);

  assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.deepEqual(readFileSync(fixture.candidateMetadata), metadataBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
  assert.equal(existsSync(fixture.candidatePendingBinary), false);
});

test("post-commit backup cleanup failure keeps the verified new component active", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const oldBinary = Buffer.from("locked old component\n", "utf8");
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, oldBinary);
  writeBytes(fixture.activeBinary, trustedBinary);
  const undeletable = join(resolve(fixture.candidateBinary, ".."), "undeletable.tmp");
  writeBytes(undeletable, Buffer.from("keep old backup\n", "utf8"));

  const user = process.env.USERNAME;
  assert.ok(user, "USERNAME is required for the delete-deny fixture");
  const deny = spawnSync(
    "icacls.exe",
    [undeletable, "/deny", `${user}:(D)`],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(deny.status, 0, `${deny.stdout}\n${deny.stderr}`);

  const componentsRoot = resolve(fixture.candidateBinary, "..", "..");
  try {
    const result = runInstaller(fixture);
    assertSucceeded(result);
    const output = JSON.parse(result.stdout);
    assert.match(output.backupCleanupWarning, /cleanup failed/i);
    assert.deepEqual(readFileSync(fixture.candidateBinary), trustedBinary);
    assert.ok(
      readdirSync(componentsRoot).some((name) => name.startsWith("codexplusplus.anticodex-backup-")),
      "undeletable backup must remain for later cleanup",
    );
  } finally {
    spawnSync(
      "icacls.exe",
      [componentsRoot, "/remove:d", user, "/T", "/C", "/Q"],
      { encoding: "utf8", windowsHide: true },
    );
  }
});

test("installer rejects a component junction before writing outside the fixed root", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const outsideComponent = join(fixture.sandboxRoot, "outside-component");
  const outsideMarker = join(outsideComponent, "keep.txt");
  const junction = resolve(fixture.candidateBinary, "..");
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.activeBinary, trustedBinary);
  writeBytes(outsideMarker, Buffer.from("outside must remain unchanged\n", "utf8"));
  mkdirSync(resolve(junction, ".."), { recursive: true });
  try {
    symlinkSync(outsideComponent, junction, "junction");
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    const installer = readFileSync(installerSource, "utf8");
    const guard = installer.indexOf("Assert-NoInstallReparsePoint -Path $componentRoot");
    const firstWrite = installer.indexOf("Copy-Item -LiteralPath $resolvedSourceBinary");
    assert.match(installer, /FileAttributes\]::ReparsePoint/);
    assert.ok(guard >= 0 && guard < firstWrite, "component reparse guard must run before the first write");
    return;
  }

  const markerBefore = readFileSync(outsideMarker);
  const result = runInstaller(fixture);

  assertFailed(result, /reparse point/i);
  assert.deepEqual(readFileSync(outsideMarker), markerBefore);
  assert.equal(existsSync(join(outsideComponent, "component-manifest.json")), false);
});

test("component activation is whole-directory transactional and metadata uses the verified snapshot", () => {
  const installer = readFileSync(installerSource, "utf8");
  const snapshotWrite = installer.indexOf("Write-Utf8NoBomAtomic -Path $stagingMetadata -Text $metadataRaw");
  const manifestWrite = installer.indexOf("Write-Utf8NoBomAtomic -Path $stagingManifest");
  const oldMove = installer.indexOf("Move-Item -LiteralPath $componentRoot -Destination $backupComponent");
  const activationMove = installer.indexOf("Move-Item -LiteralPath $stagingComponent -Destination $componentRoot");
  const rollbackMove = installer.indexOf("Move-Item -LiteralPath $backupComponent -Destination $componentRoot");
  assert.ok(snapshotWrite >= 0, "verified metadata snapshot must be written to staging");
  assert.ok(manifestWrite > snapshotWrite, "manifest must be the final staged metadata file");
  assert.ok(oldMove > manifestWrite, "the old component cannot move before staging is complete");
  assert.ok(activationMove > oldMove, "the complete staged directory must activate after backup");
  assert.ok(rollbackMove > activationMove, "failure handling must restore the complete old directory");
  assert.doesNotMatch(installer, /Copy-Item -LiteralPath \$sourceMetadata/);
  assert.match(installer, /AntiCodexCodexPlusPlusInstall/);
  assert.match(installer, /FileAttributes\]::ReparsePoint/);
});

test("host sync stages, activates and recovers CodexPlusPlus with the copied Codex host", () => {
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
  const componentStage = sync.indexOf("& $componentInstaller");
  const stopStage = sync.indexOf("Stop-AntiCodexLaunchTaskForMaintenance", componentStage);
  assert.ok(componentStage >= 0, "sync must stage the CodexPlusPlus component");
  assert.ok(stopStage >= 0, "sync must enter maintenance only after staging succeeds");
  assert.ok(componentStage < stopStage, "component validation must finish before Anti-Codex is stopped");
  assert.match(sync, /-InstallRoot \$candidateRoot/);
  assert.match(sync, /Test-AntiCodexComponentLaunchability -ComponentRoot \$candidateComponent/);
  assert.ok(sync.indexOf("Test-AntiCodexComponentLaunchability -ComponentRoot $candidateComponent") < stopStage);
  assert.match(sync, /EnvironmentVariables\["CODEX_PLUS_STATE_DIR"\]/);
  assert.match(sync, /codexplusplus-launch-probe-/);
  assert.match(sync, /Wait-AntiCodexComponentRelease/);
  assert.match(sync, /Move-FixedUpdateDirectory -Source \$candidateComponent -Destination \$activeComponent/);
  assert.match(sync, /Move-FixedUpdateDirectory -Source \$rollbackComponent -Destination \$activeComponent/);
  assert.match(sync, /ANTICODEX_REFRESH_LOCAL_FEATURES_DURING_SYNC/);
  assert.match(sync, /if \(\$syncCompleted -and \$refreshFeaturesDuringSync\)/);
  assert.match(sync, /\$provider -eq "antigravity"/);
  assert.match(sync, /\$provider -eq "third-party"/);
  assert.match(sync, /"antigravity-desktop"/);
  assert.match(sync, /"codexplusplus-third-party"/);
  assert.match(sync, /\$health\.routeReady -eq \$true/);
  assert.match(sync, /\$acceptedPatches\.Count -eq 0/);
  assert.match(sync, /\$installedPatches\.Count -ne \$acceptedPatches\.Count/);
});

test("host sync probes the trusted active path for a byte-identical component candidate", () => {
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
  const resolverStart = sync.indexOf("function Resolve-AntiCodexComponentLaunchProbeBinary");
  const resolverEnd = sync.indexOf("function Test-AntiCodexComponentLaunchability", resolverStart);
  const resolver = resolverStart >= 0 && resolverEnd > resolverStart
    ? sync.slice(resolverStart, resolverEnd)
    : "";

  assert.ok(resolverStart >= 0, "sync must resolve a safe launch-probe binary");
  assert.match(resolver, /Test-AntiCodexComponent -ComponentRoot \$activeComponent/);
  assert.match(resolver, /\$candidateHash -eq \$activeHash/);
  assert.match(resolver, /return \$activeBinary/);
  assert.match(sync, /Resolve-AntiCodexComponentLaunchProbeBinary -ComponentRoot \$ComponentRoot/);
});

test("host sync rejects a missing CodexPlusPlus source before building or stopping the host", () => {
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
  const execution = sync.slice(sync.indexOf('$syncMutex = New-Object Threading.Mutex'));
  const candidateCleanup = execution.indexOf("Remove-FixedUpdateDirectory -Path $candidateRoot");
  const preflightStatus = execution.indexOf('-Stage "component_preflight" -Message "Verifying the pinned CodexPlusPlus component before building the copied host."');
  const componentPreflight = execution.indexOf("& $componentInstaller -InstallRoot $candidateRoot -VerifyOnly");
  const buildStatus = execution.indexOf('-Stage "candidate_build" -Message "Building a candidate from the installed Codex version."');
  const hostBuild = execution.indexOf("& $installer -InstallTarget $candidateRoot -SourceRoot $selectedSourceRoot -HostOnly");
  const hostStop = execution.indexOf("Stop-AntiCodexLaunchTaskForMaintenance", componentPreflight);

  assert.ok(candidateCleanup >= 0, "sync must clear the stale candidate before verifying reusable component input");
  assert.ok(preflightStatus >= 0 && preflightStatus < componentPreflight, "sync status must describe component preflight before it starts");
  assert.ok(componentPreflight > candidateCleanup, "component preflight must not trust the stale candidate being replaced");
  assert.ok(buildStatus > componentPreflight && buildStatus < hostBuild, "host build status must begin only after component preflight succeeds");
  assert.ok(componentPreflight < hostBuild, "missing component input must fail before the copied host is built");
  assert.ok(componentPreflight < hostStop, "missing component input must fail before Anti-Codex maintenance begins");
});

test("manual rollback swaps CodexPlusPlus and host as one release", () => {
  const rollback = readFileSync(resolve(root, "scripts", "rollback-anticodex.ps1"), "utf8");
  assert.match(rollback, /\$activeComponent\s*=\s*Join-Path \$installRoot "components\\codexplusplus"/);
  assert.match(rollback, /\$rollbackComponent\s*=\s*Join-Path \$installRoot "rollback-codexplusplus"/);
  assert.match(rollback, /Wait-AntiCodexComponentRelease/);
  assert.match(rollback, /Move-FixedComponentDirectory -Source \$rollbackComponent -Destination \$activeComponent/);
  assert.match(rollback, /Test-AntiCodexComponent -ComponentRoot \$activeComponent/);
  assert.match(rollback, /\$acceptedPatches\.Count -eq 0/);
  assert.match(rollback, /\$installedPatches\.Count -ne \$acceptedPatches\.Count/);
});

test("runtime requires the complete metadata-defined CodexPlusPlus patch set", () => {
  const supervisor = readFileSync(resolve(root, "scripts", "start-anticodex-fixed-route.mjs"), "utf8");
  assert.match(supervisor, /const metadataPath = join\(componentRoot, "upstream\.json"\)/);
  assert.match(supervisor, /acceptedPatches\.length === 0/);
  assert.match(supervisor, /installedPatches\.length !== acceptedPatches\.length/);
  assert.match(supervisor, /installedPatch\?\.sha256/);
});

test("installed audit resolves the movable component and requires its metadata-defined patch set", () => {
  const audit = readFileSync(resolve(root, "scripts", "test-anticodex-installed-overall.ps1"), "utf8");
  assert.match(audit, /\[IO\.Path\]::IsPathRooted\(\$componentBinaryReference\)/);
  assert.match(audit, /Join-Path \(Split-Path -Parent \$componentManifestPath\) \$componentBinaryReference/);
  assert.match(audit, /\$componentPatchSetOk = \$acceptedPatches\.Count -gt 0/);
  assert.match(audit, /\$installedPatches\.Count -eq \$acceptedPatches\.Count/);
});

test("runtime sync carries the pinned CodexPlusPlus metadata and all accepted patches", () => {
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  assert.match(runtimeSync, /third_party\\codexplusplus\\upstream\.json/);
  assert.match(runtimeSync, /0001-isolation-scope-Anti-Codex-companion-runtime\.patch/);
  assert.match(runtimeSync, /0002-cancel-loopback-streams-without-resets\.patch/);
  assert.match(runtimeSync, /0003-native-codex-helper-requests-text-only\.patch/);
  assert.match(runtimeSync, /0004-route-anticodex-model-slots\.patch/);
  assert.match(runtimeSync, /0005-preserve-image-tool-outputs-for-chat-relays\.patch/);
  assert.match(runtimeSync, /0006-guide-models-to-structured-patch-tools\.patch/);
  assert.match(runtimeSync, /0007-ignore-late-reasoning-after-visible-text\.patch/);
  assert.match(runtimeSync, /0008-chore-audit-Codex-tool-conversion\.patch/);
  assert.match(runtimeSync, /0009-fix-allow-long-multimodal-helper-requests\.patch/);
  assert.match(runtimeSync, /0010-fix-estimate-missing-chat-usage-for-native-compaction\.patch/);
  assert.match(runtimeSync, /0011-apply-anticodex-prompt-policy-at-common-request-entry\.patch/);
  assert.match(runtimeSync, /0013-fix-format-dreamskin-installer-test\.patch/);
  assert.match(runtimeSync, /0014-fix-format-dreamskin-runtime-test\.patch/);
  assert.match(runtimeSync, /0015-enforce-Anti-Codex-command-tool-safety\.patch/);
  assert.match(runtimeSync, /0016-block-forced-Docker-interruption\.patch/);
  assert.match(runtimeSync, /foreach \(\$dir in @\([^\r\n]*"third_party"\)\)/);
});

test("Anti-Codex routing patch follows native model slots without overriding ordinary CodexPlusPlus", () => {
  const patch = readFileSync(
    resolve(root, "third_party", "codexplusplus", "patches", "0004-route-anticodex-model-slots.patch"),
    "utf8",
  );
  assert.match(patch, /select_anticodex_relay_for_model/);
  assert.match(patch, /anticodex\/antigravity/);
  assert.match(patch, /anticodex\/third-party/);
  assert.match(patch, /directed_relay\.is_none\(\)/);
  assert.doesNotMatch(patch, /CODEX_PLUS_FIXED_MODEL|apply_fixed_model_override/);
  assert.doesNotMatch(patch, /tool_choice|previous_response_id|retry/i);
});

test("image tool output patch preserves images as multimodal Chat content", () => {
  const patch = readFileSync(
    resolve(root, "third_party", "codexplusplus", "patches", "0005-preserve-image-tool-outputs-for-chat-relays.patch"),
    "utf8",
  );
  assert.match(patch, /response_output_to_chat_content/);
  assert.match(patch, /TOOL_IMAGE_PLACEHOLDER/);
  assert.match(patch, /"type": "image_url"/);
  assert.match(patch, /responses_input_preserves_mcp_image_tool_output_as_multimodal_content/);
  assert.match(patch, /responses_input_preserves_direct_view_image_output_without_textual_base64/);
  assert.doesNotMatch(patch, /previous_response_id|retry|task control/i);
});

test("structured patch guidance tells chat providers to avoid Windows shell wrappers", () => {
  const patch = readFileSync(
    resolve(root, "third_party", "codexplusplus", "patches", "0006-guide-models-to-structured-patch-tools.patch"),
    "utf8",
  );
  assert.match(patch, /Call this structured function tool directly/);
  assert.match(patch, /Do not run apply_patch through shell_command/);
  assert.match(patch, /especially on Windows/);
  assert.match(patch, /let mut apply_patch_tools = Vec::new\(\)/);
  assert.match(patch, /apply_patch_raw_schema/);
  assert.match(patch, /"required": \["patch"\]/);
  assert.match(patch, /chat_completion_response_reconstructs_exact_apply_patch_function_call/);
  assert.match(patch, /let action = name\.strip_prefix\("apply_patch_"\)\?/);
  assert.match(patch, /chat_completion_response_keeps_ordinary_suffix_named_custom_tools/);
  assert.match(patch, /artifact_delete_file/);
  assert.match(patch, /database_batch/);
  assert.match(patch, /accumulate_streamed_identity/);
  assert.match(patch, /chat_sse_accumulates_fragmented_tool_identity_before_emitting_added/);
  assert.match(patch, /guide_command_tools_away_from_file_edits/);
  assert.match(patch, /Do not use this command tool for file edits/);
  assert.match(patch, /"exec_command" \| "shell_command"/);
  assert.doesNotMatch(patch, /previous_response_id|session reset|retry policy/i);
});

test("late reasoning patch preserves one active streamed output item", () => {
  const patch = readFileSync(
    resolve(root, "third_party", "codexplusplus", "patches", "0007-ignore-late-reasoning-after-visible-text.patch"),
    "utf8",
  );
  assert.match(patch, /if self\.text\.added/);
  assert.match(patch, /chat_sse_does_not_interleave_late_reasoning_with_started_text/);
  assert.match(patch, /matches\("event: response\.output_item\.added"\)/);
  assert.doesNotMatch(patch, /previous_response_id|session reset|retry policy|task control/i);
});

test("loopback cancellation transport preserves graceful normal completion", () => {
  const patch = readFileSync(
    resolve(root, "third_party", "codexplusplus", "patches", "0002-cancel-loopback-streams-without-resets.patch"),
    "utf8",
  );
  assert.match(patch, /wait_for_downstream_disconnect/);
  assert.match(patch, /pool_max_idle_per_host\(0\)/);
  assert.match(patch, /cancel_aware_loopback/);
  assert.doesNotMatch(patch, /set_zero_linger/);
  assert.doesNotMatch(patch, /"abortive_loopback"/);
});

test("update check reports CodexPlusPlus drift as part of the same release", () => {
  const checker = readFileSync(resolve(root, "scripts", "check-anticodex-update.ps1"), "utf8");
  assert.match(checker, /\$componentDrift/);
  assert.match(checker, /"codexplusplus_component_changed"/);
  assert.match(checker, /components = \[pscustomobject\]@\{/);
  assert.match(checker, /\$guardrailDrift -or \$componentDrift/);
  assert.match(checker, /\$sourceComponentPatches\s*=\s*Get-ObjectPropertyValue/);
  assert.match(checker, /@\(\$activeComponentPatches\)\.Count\s+-ne\s+@\(\$sourceComponentPatches\)\.Count/);
  assert.doesNotMatch(checker, /@\(\$activeComponentPatches\)\.Count\s+-ne\s+\d+/);
});

test("release Gate 1 follows the pinned CodexPlusPlus patch commit", () => {
  const releaseGate = readFileSync(resolve(root, "scripts", "test-anticodex-release-gates.mjs"), "utf8");
  assert.match(releaseGate, /third_party["',\s]+codexplusplus["',\s]+upstream\.json/);
  assert.match(releaseGate, /expectedCodexPlusPlusPatchCommit/);
  assert.match(releaseGate, /report\?\.launcher\?\.patchCommit !== expectedCodexPlusPlusPatchCommit/);
  assert.doesNotMatch(releaseGate, /report\?\.launcher\?\.patchCommit !== "[0-9a-f]{40}"/);
});

test("main installer wires the separately verified component on full installs only", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  assert.match(installer, /install-codexplusplus-component\.ps1/);
  assert.match(installer, /if \(-not \$HostOnly\)[\s\S]*?install-codexplusplus-component/i);
});
