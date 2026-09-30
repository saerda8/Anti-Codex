import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  patchAddedLinesContaining,
  patchSectionContaining,
  readCodexPlusPlusPatchManifest,
} from "./codexplusplus-patch-manifest.helper.mjs";

const root = join(import.meta.dirname, "..", "..");
const patchManifest = readCodexPlusPlusPatchManifest(root);
const patchBundle = patchManifest.text;
const patch1 = patchBundle;
const patch2 = patchBundle;
const patch10 = patchBundle;
const patch11 = patchBundle;
const patch13 = patchBundle;
const patch14 = patchBundle;
const patch15 = patchBundle;
const patch16 = patchBundle;
const patch18 = patchBundle;
const patch19 = patchBundle;
const patch23 = patchBundle;
const patch1ManagerSection = patchSectionContaining(patchManifest, "stop_validated_restart_targets");
const patch1ManagerAddedLines = patchAddedLinesContaining(patchManifest, "stop_validated_restart_targets");
const patch2HelperAddedLines = patchAddedLinesContaining(patchManifest, "LOCAL_HELPER_BIND_HOST");
const patch19AddedHunkLines = patchAddedLinesContaining(patchManifest, "with_upstream_stream_idle_timeout");

test("accepted CodexPlusPlus metadata pins the manifest-defined patch set", () => {
  const componentRoot = join(root, "third_party", "codexplusplus");
  const metadata = JSON.parse(readFileSync(join(componentRoot, "upstream.json"), "utf8"));

  assert.ok(Array.isArray(metadata.patches));
  assert.ok(metadata.patches.length > 0);
  for (const patch of metadata.patches) {
    assert.match(patch.file, /^patches[\\/]/);
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
  assert.match(patch23, /status_code != 402/);
  assert.match(patch23, /value\.get\("stream"\)/);
  assert.match(patch23, /Some\(true\)/);
  assert.match(patch23, /insufficient_quota/);
  assert.match(patch23, /streamed_payment_required_becomes_terminal_quota_event/);
  assert.ok(
    (patch23.match(/responses_terminal_failure_sse_from_upstream\(/g) ?? []).length >= 3,
    "the helper definition and both streamed proxy branches must be present",
  );
});

test("upstream stream inactivity terminates every helper streaming path without a false success", () => {
  assert.match(patch19, /UPSTREAM_STREAM_IDLE_TIMEOUT/);
  assert.match(patch19, /Duration::from_secs\(120\)/);
  assert.match(patch19, /with_upstream_stream_idle_timeout/);
  assert.match(patch19, /upstream_stream_idle_timeout_rejects_a_pending_item/);
  assert.match(patch19, /upstream_stream_idle_timeout_accepts_a_ready_item/);
  assert.match(patch19, /stream_timeout/);
  assert.match(patch19, /helper\.protocol_proxy_stream_timeout/);
  assert.match(patch19, /helper\.chat_completions_proxy_stream_timeout/);
  assert.ok(
    (patch19.match(/with_upstream_stream_idle_timeout\(/g) ?? []).length >= 8,
    "all cancel-aware and fallback streaming reads must be bounded",
  );
  for (const successEvent of ["helper.protocol_proxy_stream_ok", "helper.chat_completions_proxy_stream_ok"]) {
    const timeoutIndex = patch19AddedHunkLines.indexOf("stream_timeout");
    const successIndex = patch19AddedHunkLines.indexOf(successEvent);
    assert.ok(timeoutIndex >= 0 && successIndex > timeoutIndex);
    assert.match(patch19AddedHunkLines.slice(timeoutIndex, successIndex), /return Ok\(true\)/);
  }
});

test("current task model selection is bounded, thread-scoped, and compaction-only", () => {
  assert.match(patch18, /latest_thread_model_from_rollout/);
  assert.match(patch18, /ANTICODEX_THREAD_SELECTION_TAIL_BYTES/);
  assert.match(patch18, /Uuid::parse_str/);
  assert.match(patch18, /latest_thread_selection_beats_previous_routable_model_for_compaction/);
  assert.match(patch18, /latest_thread_antigravity_selection_beats_previous_third_party_compaction_model/);
  assert.match(patch18, /latest_thread_selection_does_not_rewrite_an_ordinary_turn/);
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
  assert.match(patch15, /chat_completion_response_does_not_enforce_command_policy_without_apply_patch/);
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
  assert.match(patch13, /tests\/installers\.rs/);
  assert.match(patch13, /DreamSkin|dream_skin/i);
  assert.match(patch13, /assert_eq!|assert!\(/);
});

test("v1.2.47 DreamSkin rustfmt compatibility patch changes formatting only", () => {
  assert.match(patch14, /tests\/dream_skin_runtime\.rs/);
  assert.match(patch14, /DreamSkin|dream_skin/i);
  assert.match(patch14, /assert_eq!|assert!\(/);
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
  assert.match(patch10, /if self\.latest_usage\.is_none\(\)/);
  assert.match(patch10, /self\.latest_usage = self\.estimated_usage\(\)/);
  assert.match(patch10, /chat_sse_real_usage_overrides_the_fallback_estimate/);
  assert.match(patch10, /data:image\/png;base64/);
  assert.match(patch10, /base64 image was counted as text/);
});

test("isolated restart validates the exact configured copied app before any stop", () => {
  assert.match(patch1, /validate_isolated_copied_app_dir/);
  assert.match(patch1, /CODEX_PLUS_APP_EXECUTABLE/);
  assert.match(patch1, /symlink_metadata/);
  assert.match(patch1, /stop_validated_restart_targets/);
  assert.match(patch1, /native_or_outside_restart_path_performs_zero_stops/);
});

test("non-isolated Manager restart targets only its companion launcher and debug port", () => {
  const launcherPath = patch1ManagerSection.indexOf("companion_binary_path(SILENT_BINARY)");
  const launcherStop = patch1ManagerSection.indexOf("stop_launcher_processes_and_wait_for_path(&launcher_path)", launcherPath);
  const codexStop = patch1ManagerSection.search(/stop_codex_processes_(?:for_debug_port_and_wait|and_wait_for_app_path)/);

  assert.ok(launcherPath >= 0, "the Manager must resolve its own companion launcher path");
  assert.ok(launcherStop >= 0, "the Manager must stop only that exact launcher path");
  assert.ok(codexStop >= 0, "the restart must retain a scoped Codex stop");
  assert.doesNotMatch(patch1ManagerAddedLines, /stop_launcher_processes_and_wait\(\)/);
});

test("local protocol proxy is loopback-only, authenticated, bounded, and timeout-aware", () => {
  assert.doesNotMatch(patch2HelperAddedLines, /CODEX_PLUS_HELPER_BIND/);
  assert.match(patch2HelperAddedLines, /LOCAL_HELPER_BIND_HOST[^\n]*127\.0\.0\.1/);
  assert.match(patch2, /authorize_local_proxy_request/);
  assert.match(patch2, /experimental_bearer_token/);
  assert.match(patch2, /401 Unauthorized/);
  assert.match(patch2, /403 Forbidden/);
  assert.match(patch2, /MAX_HELPER_CONNECTIONS/);
  assert.match(patch2, /Semaphore/);
  assert.match(patch2, /HELPER_HEADER_IDLE_TIMEOUT/);
  assert.match(patch2, /HELPER_BODY_IDLE_TIMEOUT/);
  assert.match(patch2, /send_upstream_request_for_responses/);
  assert.match(patch2, /unauthorized_proxy_request_never_reaches_upstream/);
  assert.match(patch2, /no_auth_proxy_endpoints_omit_authorization_header/);
  assert.match(patch2, /bearer_token: Option<&str>/);
});

test("proxy bearer auth is enforced after bounded headers but before any body read", () => {
  const headerRead = patch2.indexOf("read_http_request_headers(&mut stream)");
  const authorization = patch2.indexOf("authorize_local_proxy_request(&request_headers, &expected_token)");
  const bodyRead = patch2.indexOf("read_http_request_body(&mut stream, request_head)");

  assert.ok(headerRead >= 0, "the helper must read only a bounded header first");
  assert.ok(authorization > headerRead, "the helper must authorize the parsed proxy route");
  assert.ok(bodyRead > authorization, "the helper must not read a proxy body before bearer auth");
  assert.match(patch2, /MAX_HTTP_HEADER_BYTES: usize = 64 \* 1024/);
  assert.match(patch2, /if buffer\.len\(\) > MAX_HTTP_HEADER_BYTES/);
  assert.match(patch2, /ContentLength\(length\) if \*length > MAX_HTTP_BODY_BYTES/);
  assert.match(patch2, /unauthorized_proxy_headers_are_rejected_before_large_body_is_read/);
  assert.match(patch2, /concurrent_unauthorized_slow_bodies_release_all_helper_permits/);
});
