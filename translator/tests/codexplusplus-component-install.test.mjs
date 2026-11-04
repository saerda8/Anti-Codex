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

import {
  readCodexPlusPlusAcceptedSource,
  readCodexPlusPlusPatchManifest,
} from "./codexplusplus-patch-manifest.helper.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const codexPlusPlusPatches = readCodexPlusPlusPatchManifest(root);
const codexPlusPlusSource = readCodexPlusPlusAcceptedSource(root, codexPlusPlusPatches.metadata);
const acceptedProtocolProxySource = codexPlusPlusSource.read("crates/codex-plus-core/src/protocol_proxy.rs")
  + "\n" + codexPlusPlusSource.read("crates/codex-plus-core/src/protocol_proxy/anticodex.rs");
const acceptedProtocolProxyTests = codexPlusPlusSource.read("crates/codex-plus-core/tests/all/protocol_proxy.rs");
const acceptedLauncherSource = codexPlusPlusSource.read("crates/codex-plus-core/src/launcher.rs");
const acceptedHistoryObserverSource = codexPlusPlusSource.read("crates/codex-plus-core/src/protocol_proxy/response_history_sse.rs");
const acceptedNativeInspectorSource = codexPlusPlusSource.read("assets/native-browser/inspect-service.mjs");
const installerSource = resolve(root, "scripts", "install-codexplusplus-component.ps1");
const trustedBinary = Buffer.from("trusted CodexPlusPlus release binary\n", "utf8");
const candidateInputFiles = {
  prepareScript: "prepare-codexplusplus-candidate.ps1",
  isolationAudit: "test-codexplusplus-isolation-compatibility.mjs",
  managedCargoRunner: "invoke-anticodex-cargo-xwin.ps1",
  hygieneVerifier: "test-anticodex-docker-build-hygiene.ps1",
};
const responseHistoryPatchFile = "patches/0013-v171-response-history.patch";
const responseHistoryBuildCommand = "test --locked -p codex-plus-core --test response_history -- --test-threads=2";
const responseHistoryPatchSource = resolve(root, "third_party", "codexplusplus", responseHistoryPatchFile);
const responseHistoryPatchHash = sha256(readFileSync(responseHistoryPatchSource));
const candidateBuildCommands = [
  "fmt --all -- --check",
  "test --locked -p codex-plus-core --test protocol_proxy -- --test-threads=2",
  responseHistoryBuildCommand,
  "test --locked -p codex-plus-core --lib response_history -- --test-threads=1",
  "test --locked -p codex-plus-core --lib proxy_stream_tests -- --test-threads=1",
    "test --locked -p codex-plus-core --lib launcher::tests:: -- --test-threads=1",
  "test --locked -p codex-plus-core --test watcher -- --test-threads=2",
  "xwin check --locked --release --target x86_64-pc-windows-msvc -p codex-plus-manager",
  "xwin build --locked --release --target x86_64-pc-windows-msvc -p codex-plus-launcher",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function patchWindow(marker, before = 500, after = 1800) {
  const index = codexPlusPlusPatches.text.indexOf(marker);
  if (index < 0) return "";
  return codexPlusPlusPatches.text.slice(Math.max(0, index - before), index + after);
}

function writeBytes(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, value);
}

function createMetadata(expectedHash, { responseHistoryPatch = true } = {}) {
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
    patches: responseHistoryPatch ? [{
      file: responseHistoryPatchFile,
      sha256: responseHistoryPatchHash,
      scope: "response history",
    }] : [],
  };
}

function writeJson(path, value) {
  writeBytes(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createInstallerSandbox(t, version = "test-only") {
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
    version,
    "0".repeat(40),
    "2".repeat(40),
  );

  mkdirSync(resolve(installerPath, ".."), { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  copyFileSync(installerSource, installerPath);
  for (const file of Object.values(candidateInputFiles)) {
    copyFileSync(resolve(root, "scripts", file), join(sourceRoot, "scripts", file));
  }
  writeBytes(
    join(sourceRoot, "third_party", "codexplusplus", responseHistoryPatchFile),
    readFileSync(responseHistoryPatchSource),
  );

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
          ...(key === "isolationAudit" ? {bundleSha256: sha256(readFileSync(join(scriptsRoot, file)))} : {}),
        }]),
      ),
    },
    build: {
      runnerImage,
      lockedDependencies: true,
      commands: metadata.patches.some((patch) => patch?.file === responseHistoryPatchFile)
        ? candidateBuildCommands
        : candidateBuildCommands.filter((command) => !command.includes("response_history") && !command.includes("proxy_stream_tests") && !command.includes("launcher::tests::")),
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

test("automatic selection accepts an old patch baseline without a response history test command", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const metadata = createMetadata(expectedHash, { responseHistoryPatch: false });
  writeJson(fixture.sourceMetadata, metadata);
  writeBytes(fixture.candidateBinary, Buffer.from("wrong candidate binary\n", "utf8"));
  writeBytes(fixture.activeBinary, Buffer.from("wrong active binary\n", "utf8"));
  writePreparedCandidate(fixture, trustedBinary, metadata);

  const report = JSON.parse(readFileSync(fixture.preparedCandidateReport, "utf8"));
  assert.equal(report.build.commands.includes(responseHistoryBuildCommand), false);
  const result = runInstaller(fixture);

  assertSucceeded(result);
  assert.deepEqual(readFileSync(fixture.candidateBinary), trustedBinary);
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

test("installer validates integrated test commands and the audit dependency bundle", (t) => {
  for (const mode of ["valid", "changed", "missing"]) {
    const fixture = createInstallerSandbox(t, "2.2.0");
    const metadata = {...createMetadata(sha256(trustedBinary), {responseHistoryPatch: false}), version: "2.2.0", tag: "v2.2.0"};
    writeJson(fixture.sourceMetadata, metadata);
    writePreparedCandidate(fixture, trustedBinary, metadata);
    const module = join(fixture.sourceRoot, "scripts", "lib", "codexplusplus-isolation-audit.mjs");
    writeBytes(module, Buffer.from("export const revision = 1;\n"));
    const report = JSON.parse(readFileSync(fixture.preparedCandidateReport, "utf8"));
    const audit = report.inputs.isolationAudit;
    audit.bundleSha256 = sha256(Buffer.from(`${audit.sha256}\n${sha256(readFileSync(module))}`));
    report.build.commands = candidateBuildCommands.map(command => command
      .replace("--test protocol_proxy", "--test all protocol_proxy::")
      .replace("--test watcher", "--test all watcher::"));
    report.build.commands.splice(report.build.commands.length - 3, 0, "test --locked -p codex-plus-core --lib anticodex_ -- --test-threads=1");
    if (mode === "missing") delete audit.bundleSha256;
    writeJson(fixture.preparedCandidateReport, report);
    if (mode === "changed") writeBytes(module, Buffer.from("export const revision = 2;\n"));
    const result = runInstaller(fixture);
    if (mode !== "valid") assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
    else assertSucceeded(result);
  }
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
  assert.match(sync, /EnvironmentVariables\["ANTICODEX_ISOLATED_INSTANCE"\]\s*=\s*"1"/);
  assert.match(sync, /EnvironmentVariables\["CODEX_HOME"\]\s*=\s*\$probeCodexHome/);
  assert.match(sync, /EnvironmentVariables\["CODEX_HOME_DIR"\]\s*=\s*\$probeCodexHome/);
  assert.ok(sync.includes('EnvironmentVariables["CODEX_SQLITE_HOME"] = $probeCodexHome'));
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

test("runtime sync carries the manifest-defined CodexPlusPlus patch set", () => {
  const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
  assert.match(runtimeSync, /third_party\\codexplusplus\\upstream\.json/);
  assert.match(runtimeSync, /ConvertFrom-Json/);
  assert.match(runtimeSync, /\.patches/);
  assert.match(runtimeSync, /requiredSourceFiles/);
  assert.match(runtimeSync, /foreach \(\$relative in \$requiredSourceFiles\)/);
  assert.ok(codexPlusPlusPatches.patches.length > 0);
});

test("Anti-Codex routing patch follows native model slots without overriding ordinary CodexPlusPlus", () => {
  const patch = codexPlusPlusPatches.text;
  const start = acceptedProtocolProxySource.indexOf("pub(crate) fn select_anticodex_relay_for_model(");
  const end = acceptedProtocolProxySource.indexOf("\n#[cfg(test)]", start);
  assert.ok(start >= 0 && end > start, "reserved-slot selection must have an inspectable production body");
  const selection = acceptedProtocolProxySource.slice(start, end);
  assert.match(patch, /select_anticodex_relay_for_model/);
  assert.match(patch, /anticodex\/antigravity/);
  assert.match(patch, /anticodex\/third-party/);
  assert.match(patch, /directed_relay\.is_none\(\)/);
  assert.doesNotMatch(patch, /CODEX_PLUS_FIXED_MODEL|apply_fixed_model_override/);
  assert.doesNotMatch(selection, /tool_choice|previous_response_id|retry/i);
});

test("native compaction routing consumes the current Codex HTTP metadata header", () => {
  assert.match(acceptedNativeInspectorSource, /x-codex-turn-metadata/);
  assert.match(acceptedNativeInspectorSource, /codex_browser_use_agent_request_header/);
  assert.match(acceptedProtocolProxySource, /pub const CODEX_TURN_METADATA_KEY: &str = "x-codex-turn-metadata"/);
  assert.match(
    acceptedProtocolProxySource,
    /fn request_is_codex_compaction\([\s\S]{0,180}turn_metadata\.is_some_and\(serialized_metadata_marks_codex_compaction\)/,
  );
  assert.match(acceptedProtocolProxySource, /fn http_compaction_metadata_uses_current_thread_over_old_routable_request/);
  assert.match(acceptedProtocolProxySource, /fn direct_provider_keeps_local_compaction_metadata_without_forwarding_identity/);
  assert.match(acceptedLauncherSource, /session_headers\.clear_forwarded_client_identity\(\)/);
});

test("native compaction routing follows the current task model without restart", () => {
  assert.match(acceptedProtocolProxySource, /latest_thread_model_from_rollout/);
  assert.match(acceptedProtocolProxySource, /ANTICODEX_THREAD_SELECTION_TAIL_BYTES/);
  assert.match(acceptedProtocolProxySource, /Uuid::parse_str/);
  assert.match(acceptedProtocolProxySource, /fn http_compaction_metadata_uses_current_thread_over_old_routable_request/);
  assert.match(acceptedProtocolProxySource, /fn antigravity_thread_selection_overrides_old_third_party_compaction_model/);
  assert.match(acceptedProtocolProxySource, /fn global_model_is_last_fallback_and_ordinary_requests_are_unchanged/);
});

test("image tool output patch preserves images as multimodal Chat content", () => {
  assert.match(acceptedProtocolProxySource, /relocate_tool_output_images/);
  assert.match(acceptedProtocolProxySource, /take_images_from_tool_message/);
  assert.match(acceptedProtocolProxySource, /"type": "image_url"/);
  assert.match(acceptedProtocolProxyTests, /fn tool_output_image_becomes_image_url_part_not_text/);
  assert.match(acceptedProtocolProxyTests, /fn custom_tool_call_output_image_is_also_converted/);
});

test("structured patch guidance tells chat providers to avoid Windows shell wrappers", () => {
  assert.match(acceptedProtocolProxySource, /Do not invoke apply_patch through exec_command, shell_command/);
  assert.match(acceptedProtocolProxySource, /Windows destructive filesystem safety/);
  assert.match(acceptedProtocolProxySource, /generic_custom_proxy_tool/);
  assert.match(acceptedProtocolProxySource, /"required": \["input"\]/);
  assert.match(acceptedProtocolProxyTests, /fn chat_completion_response_reconstructs_apply_patch_proxy_call/);
  assert.match(acceptedProtocolProxyTests, /fn chat_sse_waits_for_custom_tool_name_before_assigning_item_id/);
  assert.match(acceptedProtocolProxySource, /guide_command_tools_away_from_file_edits/);
  assert.match(acceptedProtocolProxySource, /Do not use this command tool for file edits/);
  assert.match(acceptedProtocolProxySource, /command_policy_checked_arguments/);
  assert.match(acceptedProtocolProxySource, /"exec_command" \| "shell_command"/);
});

test("late reasoning patch preserves one active streamed output item", () => {
  assert.match(
    acceptedProtocolProxySource,
    /fn push_reasoning_delta_into\([^\{]*\{\s*(?:\/\/[^\n]*\n\s*)*if self\.text\.added \{\s*return;/,
  );
  const testStart = acceptedProtocolProxyTests.indexOf(
    "fn anticodex_chat_sse_does_not_interleave_late_reasoning_with_started_text",
  );
  const testEnd = acceptedProtocolProxyTests.indexOf("\n#[test]", testStart + 1);
  const focusedTest = acceptedProtocolProxyTests.slice(testStart, testEnd);
  assert.ok(testStart >= 0 && testEnd > testStart);
  assert.match(focusedTest, /matches\("event: response\.output_item\.added"\)[\s\S]*\.count\(\),\s*if early_reasoning \{\s*2\s*\} else \{\s*1\s*\}/);
  assert.match(focusedTest, /Starting work\. Continuing now\./);
  assert.match(focusedTest, /assert!\(!converted\.contains\("This arrived after visible text\."\)\)/);
});

test("loopback cancellation transport preserves graceful normal completion", () => {
  assert.match(acceptedLauncherSource, /async fn wait_for_tcp_downstream_disconnect[\s\S]{0,400}stream\.peek\(/);
  assert.match(acceptedLauncherSource, /async fn await_tcp_upstream_or_downstream_disconnect[\s\S]{0,500}tokio::select!/);
  assert.match(acceptedLauncherSource, /async fn await_upstream_or_downstream_disconnect[\s\S]{0,500}downstream\.wait_for_disconnect/);
  assert.match(acceptedLauncherSource, /await_tcp_upstream_or_downstream_disconnect\(\s*downstream,\s*opening\s*,?\s*\)/);
  assert.match(acceptedLauncherSource, /await_upstream_or_downstream_disconnect\(\s*stream,\s*upstream\.read_body\(\)/);
  assert.equal(
    (acceptedLauncherSource.match(/(?:while let Some\(chunk\)\s*=\s*await_upstream_or_downstream_disconnect\(stream, chunks\.next\(\)\)|await_upstream_or_downstream_disconnect\(\s*stream,\s*with_upstream_stream_idle_timeout\(chunks\.next\(\),\s*idle_timeout\),?\s*\))/g) ?? []).length,
    3,
    "native passthrough, observed Responses and Chat streaming must all monitor disconnects",
  );
  assert.match(acceptedLauncherSource, /async fn stalled_native_and_chat_upstreams_stop_after_downstream_disconnect/);
  assert.match(acceptedLauncherSource, /async fn stalled_headers_and_nonstream_body_stop_when_client_closes/);
  assert.match(acceptedLauncherSource, /async fn successful_native_passthrough_and_chat_completion_are_preserved/);
  assert.match(acceptedHistoryObserverSource, /fn failure_or_truncation_after_completed_wins_over_success/);
  assert.match(acceptedHistoryObserverSource, /fn incomplete_or_missing_response_cannot_commit/);
  assert.match(acceptedLauncherSource, /async fn completed_event_with_failed_response_cannot_commit/);
  const transportSource = `${acceptedProtocolProxySource}\n${acceptedLauncherSource}`;
  assert.doesNotMatch(transportSource, /set_zero_linger|"abortive_loopback"/);
});

test("update check reports CodexPlusPlus drift as part of the same release", () => {
  const checker = readFileSync(resolve(root, "scripts", "check-anticodex-update.ps1"), "utf8");
  assert.match(checker, /\$componentDrift/);
  assert.match(checker, /"codexplusplus_component_changed"/);
  assert.match(checker, /components = \[pscustomobject\]@\{/);
  assert.match(checker, /\$guardrailDrift -or \$componentDrift/);
  assert.match(checker, /\$sourceComponentPatches\s*=\s*Get-ObjectPropertyValue/);
  assert.match(checker, /function Test-CodexPlusPlusPatchSet/);
  assert.match(checker, /\$componentPatchSetMatches\s*=\s*Test-CodexPlusPlusPatchSet/);
  assert.match(checker, /-not\s+\$componentPatchSetMatches/);
  assert.match(checker, /Get-ObjectPropertyValue\s+-InputObject\s+\$expectedPatch\s+-Name\s+"file"/);
  assert.match(checker, /Get-ObjectPropertyValue\s+-InputObject\s+\$expectedPatch\s+-Name\s+"sha256"/);
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
