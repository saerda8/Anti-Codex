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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..");
const installerSource = resolve(root, "scripts", "install-codexplusplus-component.ps1");
const trustedBinary = Buffer.from("trusted CodexPlusPlus release binary\n", "utf8");

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
  const localBuild = join(
    localAppData,
    "Temp",
    "CodexPlusPlus-analysis-20260714",
    "target",
    "x86_64-pc-windows-msvc",
    "release",
    "codex-plus-plus.exe",
  );

  mkdirSync(resolve(installerPath, ".."), { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  copyFileSync(installerSource, installerPath);

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
    localBuild,
    sourceMetadata: join(sourceRoot, "third_party", "codexplusplus", "upstream.json"),
  };
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

test("host sync reuses the pinned active component before any analysis build", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  const destinationBinary = installer.indexOf("$sourceCandidates.Add($destinationBinary)");
  const activeBinary = installer.indexOf('$activeBinary = Join-Path $expectedInstallRoot');
  const localBuild = installer.indexOf('$localBuild = Join-Path $env:LOCALAPPDATA');
  assert.ok(destinationBinary >= 0, "installer must consider the staged destination first");
  assert.ok(activeBinary >= 0, "installer must consider the verified active component");
  assert.ok(destinationBinary < activeBinary, "the staged destination must be checked before the active component");
  assert.ok(localBuild > activeBinary, "an analysis build must never override the active pinned component");
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
  writeBytes(fixture.localBuild, trustedBinary);
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
  writeBytes(fixture.localBuild, trustedBinary);
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

test("automatic selection skips wrong destination and active binaries then installs the pinned local build", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, Buffer.from("wrong candidate binary\n", "utf8"));
  writeBytes(fixture.activeBinary, Buffer.from("wrong active binary\n", "utf8"));
  writeBytes(fixture.localBuild, trustedBinary);

  const result = runInstaller(fixture);

  assertSucceeded(result);
  assert.deepEqual(readFileSync(fixture.candidateBinary), trustedBinary);
  assert.equal(existsSync(fixture.candidateManifest), true);
  assert.equal(existsSync(fixture.candidatePendingBinary), false);
});

test("automatic selection fails when every candidate hash is wrong and leaves destination untouched", (t) => {
  const fixture = createInstallerSandbox(t);
  const expectedHash = sha256(trustedBinary);
  const destinationBefore = Buffer.from("wrong candidate binary that must remain\n", "utf8");
  const metadataBefore = Buffer.from("destination metadata that must remain\n", "utf8");
  writeJson(fixture.sourceMetadata, createMetadata(expectedHash));
  writeBytes(fixture.candidateBinary, destinationBefore);
  writeBytes(fixture.candidateMetadata, metadataBefore);
  writeBytes(fixture.activeBinary, Buffer.from("wrong active binary\n", "utf8"));
  writeBytes(fixture.localBuild, Buffer.from("wrong local build\n", "utf8"));

  const result = runInstaller(fixture);

  assertFailed(result, /pinned CodexPlusPlus release binary is missing/i);
  assert.deepEqual(readFileSync(fixture.candidateBinary), destinationBefore);
  assert.deepEqual(readFileSync(fixture.candidateMetadata), metadataBefore);
  assert.equal(existsSync(fixture.candidateManifest), false);
  assert.equal(existsSync(fixture.candidatePendingBinary), false);
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
  symlinkSync(outsideComponent, junction, "junction");

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
