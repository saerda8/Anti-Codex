import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

test("CodexPlusPlus component installer is hash-pinned and isolated", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  assert.match(installer, /third_party\\codexplusplus\\upstream\.json/);
  assert.match(installer, /verification\.launcherReleaseBuild/);
  assert.match(installer, /Get-FileHash[^\n]+SHA256/);
  assert.match(installer, /Join-Path \$resolvedInstallRoot "components\\codexplusplus"/);
  assert.match(installer, /Join-Path \$componentRoot "codex-plus-plus\.exe"/);
  assert.match(installer, /path = "codex-plus-plus\.exe"/);
  assert.match(installer, /codexplusplus-component-manifest-v1/);
  assert.match(installer, /AGPL-3\.0-only/);
  assert.match(installer, /patchCommit/);
  assert.match(installer, /-ne \$expectedHash/);
  assert.doesNotMatch(installer, /Invoke-WebRequest|Start-BitsTransfer|git clone/i);
});

test("CodexPlusPlus update candidate is staged under the fixed install root only", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  assert.match(installer, /Join-Path \$expectedInstallRoot "update-candidate"/);
  assert.match(installer, /\$resolvedInstallRoot\s+-notin\s+\$allowedInstallRoots/);
  assert.doesNotMatch(installer, /\$resolvedInstallRoot\.StartsWith\(/);
});

test("host sync reuses the pinned active component before any analysis build", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  const activeBinary = installer.indexOf('$activeBinary = Join-Path $expectedInstallRoot');
  const localBuild = installer.indexOf('$localBuild = Join-Path $env:LOCALAPPDATA');
  assert.ok(activeBinary >= 0, "installer must consider the verified active component");
  assert.ok(localBuild > activeBinary, "an analysis build must never override the active pinned component");
  assert.match(installer, /\$actualHash\s+-ne\s+\$expectedHash/);
});

test("host sync stages, activates and recovers CodexPlusPlus with the copied Codex host", () => {
  const sync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
  const componentStage = sync.indexOf("& $componentInstaller");
  const stopStage = sync.lastIndexOf("Stop-AntiCodexLaunchers");
  assert.ok(componentStage >= 0, "sync must stage the CodexPlusPlus component");
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
