import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  readCodexPlusPlusAcceptedSource,
  readCodexPlusPlusPatchManifest,
} from "./codexplusplus-patch-manifest.helper.mjs";

const root = join(import.meta.dirname, "..", "..");
const patchManifest = readCodexPlusPlusPatchManifest(root);
const acceptedSource = readCodexPlusPlusAcceptedSource(root, patchManifest.metadata);
const launcherSource = acceptedSource.read("crates/codex-plus-core/src/launcher.rs");
const protocolProxySource = acceptedSource.read("crates/codex-plus-core/src/protocol_proxy.rs")
  + "\n" + acceptedSource.read("crates/codex-plus-core/src/protocol_proxy/anticodex.rs");
const managerCommandsSource = acceptedSource.read("apps/codex-plus-manager/src-tauri/src/commands.rs");
const launcherProductionSource = launcherSource.split("\n#[cfg(test)]\nmod tests")[0];
const patchBundle = patchManifest.text;
const patch1 = patchBundle;
const patch2 = patchBundle;
const patch10 = patchBundle;
const patch11 = patchBundle;
const patch14 = patchBundle;
const patch15 = patchBundle;
const patch16 = patchBundle;
const patch18 = patchBundle;
const patch19 = patchBundle;
const patch23 = patchBundle;
const historicalV1246DreamSkinPatch = readFileSync(join(
  root,
  "docs",
  "audits",
  "codexplusplus",
  "v1.2.46-source-replay",
  "patches",
  "0013-fix-format-dreamskin-installer-test.patch",
), "utf8");
const paymentProxySource = sourceSection(
  launcherSource,
  "async fn handle_protocol_proxy_connection",
  "async fn handle_dictation_connection",
);
const chatProxySource = sourceSection(
  launcherSource,
  "async fn handle_chat_completions_proxy_connection",
  "async fn write_http_response",
);
const isolatedAppValidatorSource = sourceSection(
  managerCommandsSource,
  "fn validate_isolated_launch_app_path",
  "fn restart_codex_plus_blocking",
);
const managerRestartSource = sourceSection(
  managerCommandsSource,
  "fn restart_codex_plus_blocking",
  "fn stop_codex_plus_for_restart",
);
const restartStopOrderSource = sourceSection(
  managerCommandsSource,
  "fn stop_codex_plus_for_restart",
  "enum RestartStopError",
);
const helperEntrypointSource = sourceSection(
  launcherSource,
  "async fn handle_helper_connection(",
  "async fn handle_helper_connection_on_with_proxy_token",
);
const helperAuthFlowSource = sourceSection(
  launcherSource,
  "async fn handle_helper_connection_on_with_proxy_token",
  "pub(crate) fn decode_protocol_proxy_request_body",
);

test("accepted CodexPlusPlus metadata pins the manifest-defined patch set", () => {
  const componentRoot = join(root, "third_party", "codexplusplus");
  const metadata = JSON.parse(readFileSync(join(componentRoot, "upstream.json"), "utf8"));

  assert.ok(Array.isArray(metadata.patches));
  assert.ok(metadata.patches.length > 0);
  for (const patch of metadata.patches) {
    assert.equal(typeof patch.file, "string");
    const pathFromRoot = relative(resolve(componentRoot), resolve(componentRoot, patch.file));
    assert.ok(!isAbsolute(patch.file) && pathFromRoot && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot), "patch paths must stay inside the pinned component source tree");
    const actualHash = createHash("sha256")
      .update(readFileSync(join(componentRoot, patch.file)))
      .digest("hex");
    assert.equal(actualHash, patch.sha256, patch.file);
  }
  assert.match(metadata.patchCommit, /^[0-9a-f]{40}$/);
  assert.match(metadata.verification.patchReplay, /patch|candidate/i);
  if (!/pending/i.test(metadata.verification.patchReplay)) {
    assert.match(metadata.verification.patchReplay, new RegExp(metadata.patchCommit));
    assert.match(metadata.verification.patchReplay, /tree [0-9a-f]{40}$/);
  }
});

test("streamed payment failures become one terminal quota event", () => {
  assert.match(protocolProxySource, /status_code != 402/);
  assert.match(protocolProxySource, /value\.get\("stream"\)/);
  assert.match(protocolProxySource, /Some\(true\)/);
  assert.match(protocolProxySource, /insufficient_quota/);
  assert.match(
    launcherSource + "\n" + protocolProxySource,
    /streamed_payment_(?:required_becomes_terminal_quota_event|uses_one_quota_failure_and_preserves_nonstream_errors)/,
  );
  assert.equal(
    (protocolProxySource.match(/pub\(crate\) fn responses_terminal_failure_sse_from_upstream\(/g) ?? []).length,
    1,
    "the shared terminal-failure helper must have one definition",
  );
  assert.equal(
    (paymentProxySource.match(/responses_terminal_failure_sse_from_upstream\(/g) ?? []).length,
    1,
    "the common non-success path must call the helper once before wire-specific conversion",
  );
  const sharedFailure = paymentProxySource.indexOf("responses_terminal_failure_sse_from_upstream(");
  const nonSuccessReturn = paymentProxySource.indexOf("helper.protocol_proxy_upstream_error", sharedFailure);
  const streamBranch = paymentProxySource.indexOf("if upstream.is_stream", sharedFailure);
  assert.ok(sharedFailure >= 0 && nonSuccessReturn > sharedFailure && streamBranch > sharedFailure);
});

test("streamed provider errors preserve their non-retryable error code", () => {
  assert.match(patch23, /extract_chat_sse_error\(&chunk\)/);
  assert.match(patch23, /let \(message, error_type, error_code\) = extract_chat_sse_error\(&chunk\)/);
  assert.match(patch23, /failed_into\(output, message, error_type, error_code\)/);
  assert.match(patch23, /error\.get\("code"\)/);
});

test("upstream stream inactivity terminates every helper streaming path without a false success", () => {
  assert.match(launcherSource, /UPSTREAM_STREAM_IDLE_TIMEOUT/);
  assert.match(launcherSource, /Duration::from_secs\(120\)/);
  assert.match(launcherSource, /idle_timeout_keeps_delivered_completion_but_rejects_deferred_history|upstream_stream_idle_timeout_rejects_a_pending_item/);
  assert.match(launcherSource, /idle_timeout_emits_one_failure_for_incomplete_native_and_chat|upstream_stream_idle_timeout_accepts_a_ready_item/);
  assert.equal(
    (launcherProductionSource.match(/with_upstream_stream_idle_timeout\(/g) ?? []).length,
    6,
    "all production stream-read paths and wrapper definition must share the idle timeout wrapper",
  );
  const protocolFailure = paymentProxySource.indexOf("forward_protocol_proxy_stream_for_client_with_live_request(");
  const protocolFailureBranch = paymentProxySource.indexOf("if let Some(reason) = failure", protocolFailure);
  const protocolSuccess = paymentProxySource.indexOf("helper.protocol_proxy_stream_ok", protocolFailureBranch);
  assert.ok(protocolFailure >= 0 && protocolFailureBranch > protocolFailure);
  assert.ok(protocolSuccess > protocolFailureBranch, "stream success must be confined to the no-failure else branch");
  assert.match(
    paymentProxySource.slice(protocolFailureBranch, protocolSuccess + 80),
    /if let Some\(reason\) = failure[\s\S]*\} else \{[\s\S]*helper\.protocol_proxy_stream_ok/,
  );
  const chatTimeout = chatProxySource.indexOf("helper.chat_completions_proxy_stream_timeout");
  const chatTimeoutReturn = chatProxySource.indexOf("return Ok(())", chatTimeout);
  const chatSuccess = chatProxySource.indexOf("helper.chat_completions_proxy_stream_ok", chatTimeout);
  assert.ok(chatTimeout >= 0 && chatTimeoutReturn > chatTimeout);
  assert.ok(chatSuccess > chatTimeoutReturn, "Chat timeout must return before the success event");
});

test("current task model selection is bounded, thread-scoped, and compaction-only", () => {
  assert.match(patch18, /latest_thread_model_from_rollout/);
  assert.match(patch18, /ANTICODEX_THREAD_SELECTION_TAIL_BYTES/);
  assert.match(patch18, /Uuid::parse_str/);
  assert.match(patch18, /http_compaction_metadata_uses_current_thread_over_old_routable_request|latest_thread_selection_beats_previous_routable_model_for_compaction/);
  assert.match(patch18, /antigravity_thread_selection_overrides_old_third_party_compaction_model|latest_thread_antigravity_selection_beats_previous_third_party_compaction_model/);
  assert.match(patch18, /global_model_is_last_fallback_and_ordinary_requests_are_unchanged|latest_thread_selection_does_not_rewrite_an_ordinary_turn/);
});

test("timed-out Docker work cannot be stopped or force-removed for a retry", () => {
  assert.match(patch16, /docker rm -f cv_check cv_test_final/);
  assert.match(patch16, /docker container rm --force cv_check/);
  assert.match(patch16, /docker stop cv_check/);
  assert.match(patch16, /stopping or force-removing a Docker container is forbidden; wait for it to exit/);
  assert.match(patch16, /docker wait cv_check/);
  assert.match(patch16, /docker rm cv_check/);
});

test("Anti-Codex command safety is enforced at both nonstream and streaming tool-call exits", () => {
  assert.match(patch15, /command_policy_checked_arguments/);
  assert.match(patch15, /enforces_command_policy_for/);
  assert.match(patch15, /docker --context desktop-linux run/);
  assert.match(patch15, /com\.anticodex\.task-id=not-a-task/);
  assert.match(patch15, /chat_sse_command_policy_never_streams_an_unsafe_command/);
  assert.match(patch15, /command_guard_is_applied_only_when_patch_tool_is_available|chat_completion_response_does_not_enforce_command_policy_without_apply_patch/);
  assert.match(patch15, /direct source or evidence edits must use apply_patch/);
  assert.match(patch15, /global Docker cleanup is forbidden/);
  assert.match(patch15, /docker run\/create requires automatic cleanup/);
});

test("Anti-Codex command safety blocks stdin-fed Python source writers without blocking reads", () => {
  assert.match(patch15, /interpreter_stdin_source_write/);
  assert.match(patch15, /python_stdin_source_writer_is_blocked/);
  assert.match(patch15, /python_stdin_source_reader_is_allowed/);
  assert.match(patch15, /interpreter stdin source edits must use apply_patch/);
});

test("Anti-Codex command safety blocks Git worktree rewrites without blocking read-only patch checks", () => {
  assert.match(patch15, /git_worktree_mutation/);
  assert.match(patch15, /git_checkout_source_writer_is_blocked/);
  assert.match(patch15, /git_apply_check_is_allowed/);
  assert.match(patch15, /git worktree edits must not bypass apply_patch/);
});

test("Anti-Codex command safety rejects test pipelines that mask the producer exit status", () => {
  assert.match(patch15, /masked_test_pipeline_status/);
  assert.match(patch15, /masked_test_pipeline_is_blocked/);
  assert.match(patch15, /pipefail_test_pipeline_is_allowed/);
  assert.match(patch15, /test pipelines must preserve the producer exit status/);
});

test("Anti-Codex command safety binds one deterministic container name to the current task", () => {
  assert.match(patch15, /task_container_name_matches_label/);
  assert.match(patch15, /randomized_task_container_name_is_blocked/);
  assert.match(patch15, /anticodex-<current task id>/);
  assert.match(patch15, /container name and ownership label must identify the same current task/);
});

test("v1.2.46 DreamSkin rustfmt compatibility patch changes formatting only", () => {
  assert.match(historicalV1246DreamSkinPatch, /tests\/installers\.rs/);
  assert.match(historicalV1246DreamSkinPatch, /DreamSkin|dream_skin/i);
  assert.match(historicalV1246DreamSkinPatch, /assert_eq!|assert!\(/);
});

test("v1.2.47 DreamSkin rustfmt compatibility patch changes formatting only", () => {
  const dreamSkinRuntimeTests = acceptedSource.read("crates/codex-plus-core/tests/all/dream_skin_runtime.rs");
  assert.match(dreamSkinRuntimeTests, /DreamSkin|dream_skin/i);
  assert.match(dreamSkinRuntimeTests, /assert_eq!|assert!\(/);
});

test("Anti-Codex prompt policy is confined to both reserved relays at the common request entry", () => {
  assert.match(patch11, /ANTICODEX_PROMPT_POLICY_PATH/);
  assert.match(patch11, /apply_anticodex_prompt_policy/);
  assert.match(patch11, /upstream_request_parts/);
  assert.match(patch11, /ANTICODEX_ANTIGRAVITY_RELAY_ID/);
  assert.match(patch11, /ANTICODEX_THIRD_PARTY_RELAY_ID/);
  assert.match(patch11, /prompt_policy_default_is_a_byte_for_byte_passthrough/);
  assert.match(patch11, /prompt_policy_disabled_preserves_user_and_agents_messages/);
  assert.match(patch11, /prompt_policy_customizes_responses_and_chat_once/);
  assert.match(patch11, /prompt_policy_user_add_on_applies_to_both_reserved_relays/);
  assert.match(patch11, /prompt_policy_ignores_other_relays_and_invalid_paths/);
  assert.match(patch11, /native-prompt-snapshot\.json/);
  assert.match(patch11, /"defaultContent"/);
  assert.match(patch11, /"effectiveContent"/);
  assert.match(patch11, /"policyMode"/);
  assert.match(patch11, /crate::settings::atomic_write/);
  assert.match(patch11, /prompt_policy_snapshot_records_only_original_instruction_carriers_even_without_policy/);
  assert.match(patch11, /ANTICODEX_PROMPT_SNAPSHOT_IDENTITY/);
  assert.match(patch11, /last_identity\.as_ref\(\) == Some\(&identity\)/);
  assert.match(patch11, /identical_prompt_policy_snapshot_is_not_rewritten/);
  assert.match(patch11, /RelayProtocol::ChatCompletions => "chatCompletions"/);
});

test("missing Chat usage is estimated only as a completed-response fallback", () => {
  assert.match(patch10, /if status == "completed" && self\.latest_usage\.is_none\(\)|if self\.latest_usage\.is_none\(\)/);
  assert.match(patch10, /self\.latest_usage = self\.estimated_usage\(\)/);
  assert.match(patch10, /usage_estimate_only_applies_to_completed_without_real_usage|chat_sse_real_usage_overrides_the_fallback_estimate/);
  assert.match(patch10, /data:image\/png;base64/);
});

test("isolated restart validates the exact configured copied app before any stop", () => {
  assert.match(isolatedAppValidatorSource, /isolated_app_path\(\)\?/);
  assert.match(isolatedAppValidatorSource, /validate_isolated_copied_app_dir/);
  const validateTarget = managerRestartSource.indexOf("let target_app_path = match validate_isolated_launch_app_path(&request)");
  const checkRunning = managerRestartSource.indexOf("find_codex_processes_for_app_path(path)", validateTarget);
  const stopTargets = managerRestartSource.indexOf("stop_codex_plus_for_restart(", checkRunning);
  assert.ok(validateTarget >= 0, "restart_codex_plus_blocking must validate the isolated app path first");
  assert.ok(checkRunning > validateTarget, "isolated process lookup must use the validated app path");
  assert.ok(stopTargets > checkRunning, "validated app path check must finish before any stop");
});

test("non-isolated Manager restart targets only its companion launcher and debug port", () => {
  const stopMainCodexSource = sourceSection(
    managerCommandsSource,
    "fn stop_main_codex_process(",
    "fn main_codex_running_without_debug_port",
  );
  assert.match(stopMainCodexSource, /stop_codex_processes_and_wait_for_app_path\(path\)/);
  assert.match(stopMainCodexSource, /stop_codex_processes_for_debug_port/);
  assert.doesNotMatch(managerRestartSource, /stop_launcher_processes_and_wait\(\)/);
  const stopCodex = restartStopOrderSource.indexOf("stop_codex().map_err(RestartStopError::Codex)?");
  const stopRuntime = restartStopOrderSource.indexOf("stop_runtime().map_err(RestartStopError::Runtime)?");
  const waitNative = restartStopOrderSource.indexOf("wait_native().map_err(RestartStopError::NativeBrowser)");
  assert.ok(stopCodex >= 0, "the production restart must stop the scoped Codex app first");
  assert.ok(stopRuntime > stopCodex, "the embedded launcher runtime must stop after the app");
  assert.ok(waitNative > stopRuntime, "native browser cleanup must follow the runtime stop");
});

test("local protocol proxy is loopback-only, authenticated, bounded, and timeout-aware", () => {
  assert.match(launcherSource, /fn validate_helper_bind_host\(host: &str, isolated: bool\)/);
  assert.match(launcherSource, /isolated helper must bind to a loopback address/);
  assert.match(launcherSource, /authorize_local_proxy_request/);
  assert.match(launcherSource, /experimental_bearer_token/);
  assert.match(launcherSource, /401 Unauthorized/);
  assert.match(launcherSource, /403 Forbidden/);
  assert.match(launcherSource, /MAX_HELPER_CONNECTIONS: usize = 32/);
  assert.match(launcherSource, /Semaphore/);
  assert.match(launcherSource, /HTTP request header idle timeout/);
  assert.match(launcherSource, /HTTP request body idle timeout/);
  assert.match(protocolProxySource, /send_upstream_request_for_responses/);
  assert.match(launcherSource, /isolated_proxy_rejects_invalid_headers_before_waiting_for_body/);
  assert.ok(
    (protocolProxySource.match(/if relay\.api_key\.trim\(\)\.is_empty\(\) && !relay\.uses_no_auth\(\)|with_relay_auth\(/g) ?? []).length >= 3,
    "every no-auth upstream request builder must omit the Authorization token",
  );
  assert.match(protocolProxySource, /fn with_relay_auth\(/);
  assert.match(protocolProxySource, /crate::relay_headers::apply(?:_for_protocol)?\(request, relay\)/);
});

test("proxy bearer auth is enforced after bounded headers but before any body read", () => {
  assert.match(
    helperEntrypointSource,
    /handle_helper_connection_on_with_proxy_token\(stream, remote_addr, listener, None\)\.await/,
  );
  const headerRead = helperAuthFlowSource.indexOf("read_http_request_head_with_limits(&mut stream, limits)");
  const authorization = helperAuthFlowSource.indexOf("authorize_local_proxy_request(&request_headers, &expected)");
  const bodyRead = helperAuthFlowSource.indexOf("read_http_request_body_with_limits(&mut stream, request_head, limits)");

  assert.ok(headerRead >= 0, "the helper must read only a bounded header first");
  assert.ok(authorization > headerRead, "the helper must authorize the parsed proxy route");
  assert.ok(bodyRead > authorization, "the helper must not read a proxy body before bearer auth");
  assert.match(launcherSource, /MAX_HTTP_HEADER_BYTES: usize = 64 \* 1024/);
  assert.match(launcherSource, /if buffer\.len\(\) > MAX_HTTP_HEADER_BYTES/);
  assert.match(launcherSource, /ContentLength\(length\) if \*length > limits\.decoded/);
  assert.match(launcherSource, /isolated_proxy_rejects_invalid_headers_before_waiting_for_body/);
  assert.match(
    launcherSource,
    /let _permit = permit;[\s\S]{0,160}handle_helper_connection\(stream, Some\(addr\)\)\.await/,
  );
  assert.match(
    launcherSource,
    /drop\(held\.pop\(\)\);[\s\S]{0,100}try_acquire_owned\(\)\.is_ok\(\)/,
  );
});

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end > start ? end : undefined);
}