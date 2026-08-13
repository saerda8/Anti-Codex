import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..");
const patch1 = readFileSync(join(root, "third_party", "codexplusplus", "patches", "0001-isolation-scope-Anti-Codex-companion-runtime.patch"), "utf8");
const patch2 = readFileSync(join(root, "third_party", "codexplusplus", "patches", "0002-cancel-loopback-streams-without-resets.patch"), "utf8");
const patch10 = readFileSync(join(root, "third_party", "codexplusplus", "patches", "0010-fix-estimate-missing-chat-usage-for-native-compaction.patch"), "utf8");
const patch11Path = join(root, "third_party", "codexplusplus", "patches", "0011-apply-anticodex-prompt-policy-at-common-request-entry.patch");
const patch11 = existsSync(patch11Path) ? readFileSync(patch11Path, "utf8") : "";
const patch12Path = join(root, "third_party", "codexplusplus", "patches", "0012-fix-format-relay-auth-fallback-chain.patch");
const patch12 = existsSync(patch12Path) ? readFileSync(patch12Path, "utf8") : "";
const patch13Path = join(root, "third_party", "codexplusplus", "patches", "0013-fix-format-dreamskin-installer-test.patch");
const patch13 = existsSync(patch13Path) ? readFileSync(patch13Path, "utf8") : "";
const patch1AddedLines = patch1
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .join("\n");
const patch2AddedLines = patch2
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .join("\n");

test("accepted CodexPlusPlus metadata pins the complete patch series", () => {
  const componentRoot = join(root, "third_party", "codexplusplus");
  const metadata = JSON.parse(readFileSync(join(componentRoot, "upstream.json"), "utf8"));

  assert.equal(metadata.patches.length, 13);
  assert.equal(
    metadata.patches.at(-1).file,
    "patches/0013-fix-format-dreamskin-installer-test.patch",
  );
  for (const patch of metadata.patches) {
    const actualHash = createHash("sha256")
      .update(readFileSync(join(componentRoot, patch.file)))
      .digest("hex");
    assert.equal(actualHash, patch.sha256, patch.file);
  }
  assert.match(metadata.patchCommit, /^[0-9a-f]{40}$/);
  assert.match(metadata.verification.patchReplay, new RegExp(metadata.patchCommit));
  assert.match(metadata.verification.patchReplay, /tree [0-9a-f]{40}$/);
});

test("v1.2.45 rustfmt compatibility patch changes indentation only", () => {
  assert.match(patch12, /^From [0-9a-f]{40} /m);
  assert.match(patch12, /^Subject: \[PATCH 12\/12\] fix: format relay auth fallback chain$/m);
  assert.deepEqual(
    [...patch12.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => [match[1], match[2]]),
    [[
      "crates/codex-plus-core/src/relay_config.rs",
      "crates/codex-plus-core/src/relay_config.rs",
    ]],
  );
  const added = patch12
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const removed = patch12
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---") && line !== "-- ")
    .map((line) => line.slice(1));
  assert.equal(added.length, 3);
  assert.equal(removed.length, 3);
  assert.deepEqual(added.map((line) => line.trimStart()), removed.map((line) => line.trimStart()));
  assert.ok(added.every((line) => line.startsWith("            .")));
  assert.ok(removed.every((line) => line.startsWith("        .")));
});

test("v1.2.46 DreamSkin rustfmt compatibility patch changes formatting only", () => {
  assert.match(patch13, /^From [0-9a-f]{40} /m);
  assert.match(patch13, /^Subject: \[PATCH 13\/13\] fix: format DreamSkin installer metadata test$/m);
  assert.deepEqual(
    [...patch13.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => [match[1], match[2]]),
    [[
      "crates/codex-plus-core/tests/installers.rs",
      "crates/codex-plus-core/tests/installers.rs",
    ]],
  );
  const added = patch13
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("")
    .replaceAll(/\s/g, "");
  const removed = patch13
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---") && line !== "-- ")
    .map((line) => line.slice(1))
    .join("")
    .replaceAll(/\s/g, "");
  assert.equal(added, removed);
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
  assert.doesNotMatch(patch11, /retry|task control|session reset/i);
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
  const launcherPath = patch1AddedLines.indexOf("companion_binary_path(SILENT_BINARY)");
  const launcherStop = patch1AddedLines.indexOf("stop_launcher_processes_and_wait_for_path(&launcher_path)", launcherPath);
  const codexStop = patch1AddedLines.indexOf("stop_codex_processes_for_debug_port_and_wait(request.debug_port)", launcherStop);

  assert.ok(launcherPath >= 0, "the Manager must resolve its own companion launcher path");
  assert.ok(launcherStop > launcherPath, "the Manager must stop only that exact launcher path");
  assert.ok(codexStop > launcherStop, "the existing debug-port-scoped Codex stop must remain intact");
  assert.doesNotMatch(patch1AddedLines, /stop_launcher_processes_and_wait\(\)/);
});

test("local protocol proxy is loopback-only, authenticated, bounded, and timeout-aware", () => {
  assert.doesNotMatch(patch2AddedLines, /CODEX_PLUS_HELPER_BIND/);
  assert.match(patch2AddedLines, /LOCAL_HELPER_BIND_HOST[^\n]*127\.0\.0\.1/);
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
  assert.match(patch2, /helper_header_and_body_reads_have_distinct_idle_timeouts/);
  assert.match(patch2, /unauthorized_proxy_headers_are_rejected_before_large_body_is_read/);
  assert.match(patch2, /concurrent_unauthorized_slow_bodies_release_all_helper_permits/);
});
