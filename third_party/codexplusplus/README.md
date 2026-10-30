# CodexPlusPlus Component Boundary

This directory pins the separately licensed CodexPlusPlus component and carries the compatibility patches listed in `upstream.json`. That manifest is authoritative for the current source identity, patch order and hashes. This directory does not vendor source, binaries, provider credentials or user state.

## Upstream

- Repository: `https://github.com/BigPizzaV3/CodexPlusPlus`
- Accepted version: `v1.12.1`
- Accepted commit: `ca1b212db8c2baca87fc2bd5b7fad460c437159c`
- License: `AGPL-3.0-only`

The cloned/built component and this derived patch remain under the upstream AGPL license. Anti-Codex keeps this component at a separate source/build boundary.

## Allowed Patch Scope

The user approved a further Layer 2 exception on 2026-10-14: bounded persistent response history for `previous_response_id`, with credential isolation, explicit missing-history failures and native-provider continuation preserved. See the [approved contract](../../docs/superpowers/specs/2026-10-14-response-history-design.md). Approval does not imply that the new candidate has passed build or runtime acceptance.

The isolation patch may change only isolation behavior:

- explicit absolute `CODEX_PLUS_STATE_DIR` for CodexPlusPlus settings, logs and locks;
- configurable `CODEX_PLUS_PROTOCOL_PROXY_PORT`;
- explicit `CODEX_PLUS_APP_EXECUTABLE` selection restricted to an existing `.exe` in the copied app directory, with invalid configuration failing closed;
- copied-app-path-scoped process discovery, activation, waiting and restart;
- fail-closed launch/restart when isolated mode has no absolute copied app path;
- exact-path manager activation;
- refusal to install or remove the shared current-user logon watcher in isolated mode.

The second patch changes only plain-HTTP loopback model transport. It uses a one-shot connection and drops the request when the downstream Codex client actually cancels, while normal streams finish and close gracefully. Authenticated relays retain their bearer header and explicit no-auth relays omit it. It must not enable zero-linger or reset a successful response. HTTPS and non-loopback providers retain the upstream request path.

The third patch removes tools only from exact official Codex title and task-suggestion helper requests. Ordinary user turns and all upstream conversion behavior remain unchanged.

The fourth patch recognizes only reserved Anti-Codex model slots and exact Antigravity models selected by the native frontend. It chooses the resident `anticodex-antigravity` or `anticodex-third-party` relay, resolves generic slots to the saved model, and strips the namespace from an explicit third-party model. When official Codex explicitly marks a request as native compaction, an explicit routable request model remains authoritative; isolated config is only a fallback for a missing or unknown request model. Directed Anti-Codex requests take precedence and fail closed instead of rotating to another provider; ordinary v1.2.56 provider-scoped per-model routes remain available on both direct and cancel-aware transports.

The fifth patch changes only image-bearing tool output conversion. It keeps ordinary tool output unchanged, replaces textual JSON/Base64 image payloads with standard Chat `image_url` content parts, and preserves the original tool call association. This prevents valid local image results from being counted as hundreds of thousands of text tokens by Chat-only providers.

The sixth patch exposes an exact-name structured `apply_patch` function before the five generated compatibility proxies and ordinary command tools, then appends file-edit and Windows destructive-operation guidance only to `exec_command` and `shell_command` when patch tools are present. The immutable guidance forbids cross-shell retries after a blocked recursive delete or move, requires resolved-target verification, and forbids unrequested global toolchain/environment changes. Existing response reconstruction turns the exact-name function back into the native Codex custom tool. It does not block command execution or change execution, routing, history, retries or task control.

The seventh patch ignores a separate reasoning delta only when visible text has already started. This keeps the Chat stream mapped to one active Responses output item for current Codex clients while preserving reasoning-first streams, all visible text, tools and native task control.

The eighth patch records only native/converted tool counts, names and types for local relay diagnosis. It does not record request content, arguments, credentials or tool results and does not change conversion or routing.

The ninth patch raises the decoded loopback helper request limit from 32 MiB to 128 MiB and the encoded bound from 64 MiB to 256 MiB. Requests above the new explicit bound still return 413; routing, conversion, retries, history and task control are unchanged.

The tenth patch estimates nonzero Responses usage only when a completed Chat SSE stream omitted real usage. It counts text and tool context conservatively, excludes embedded image Base64, and never overrides upstream usage.

The eleventh patch reads only the explicitly configured absolute `prompt-policy.json` path for the exact `anticodex-antigravity` and `anticodex-third-party` relays. Default mode preserves request JSON unchanged; disabled and custom modes operate on the merged system/developer carriers before the Responses/Chat branch while preserving every user message, including the native AGENTS wrapper. It adds the optional user instruction once, keeps existing tool compatibility guidance intact, and atomically records only the original/effective merged instruction text, hashes and local route metadata in `native-prompt-snapshot.json`; an unchanged snapshot is not rewritten. Missing, malformed or out-of-scope policy input passes the original request through unchanged.

The twelfth patch wraps one upstream v1.2.46 DreamSkin installer metadata assertion in the stable rustfmt form. Removing whitespace leaves the expression unchanged; it changes no installer, Manager, helper, provider or runtime behavior.

The thirteenth patch normalizes one upstream v1.2.47 DreamSkin runtime layout assertion into the stable rustfmt form. Removing whitespace leaves the expression unchanged; it changes no Manager, helper, provider or runtime behavior.

The fourteenth patch enforces the sixth patch's command guidance only when an exact structured `apply_patch` tool is available. At both nonstream and streaming tool-call exits, it replaces wrapped patch calls, direct source or evidence writes, stdin-fed Python source writers, Git worktree rewrites, test pipelines that mask the producer exit status, Docker creation without automatic cleanup or the deterministic `anticodex-<task-id>` name and matching ownership label, and global Docker cleanup with a deterministic local rejection. Binding one container name to each task prevents a timed-out build from being retried under a randomized replacement name. It preserves read-only Python and Git checks, test pipelines that preserve producer status, ordinary inspection and build commands, and leaves requests without `apply_patch` unchanged.

The fifteenth patch closes the timeout-retry gap by rejecting Docker stop, kill, restart and force-remove calls while structured patching is available. A timed-out container must be observed with `docker wait`; non-forced removal remains available only after Docker itself confirms that the container has exited.

The sixteenth patch reads only the canonical `x-codex-turn-metadata` request header at the helper boundary so current Codex HTTP compaction requests follow the active isolated model selection. The header value is used only for compaction classification, is neither logged nor forwarded, and ordinary turns plus the older body metadata form remain unchanged on direct and cancel-aware transports.

The seventeenth patch validates the canonical current thread or session UUID on a marked compaction request, searches only the exact isolated Codex session hierarchy, and reads at most the latest 512 KiB of the newest matching rollout to find that task's most recent model-bearing settings event. That current task selection may replace a stale routable compaction model in either direction between third-party, Claude and Gemini routes, so the next request follows the native model menu without a restart or global configuration change. Ordinary turns, other tasks, missing or invalid state, request conversion, retries and task control remain unchanged, and rollout content is neither logged nor forwarded.

The eighteenth patch bounds every successful Responses and Chat streaming helper read to 120 seconds without upstream data. Converted Chat streams emit a `stream_timeout` Responses failure; direct streams close deterministically. Timeout paths are logged separately and return before the normal success event, without retrying a partially started answer or changing routing, history, tools or task control.

The nineteenth patch normalizes only upstream v1.2.48 and merged isolation layout into the stable rustfmt form. Removing whitespace leaves the expressions unchanged; it changes no Manager, helper, provider or runtime behavior.

The twentieth patch normalizes only upstream v1.2.50 layout into the stable rustfmt form. Removing whitespace leaves the expressions unchanged; it changes no Manager, helper, provider or runtime behavior.

The twenty-first patch normalizes upstream v1.2.56 and merged compatibility layout into the stable rustfmt form, with no intended Manager, helper, provider or runtime behavior change.

The twenty-second patch handles only streamed Responses requests whose upstream provider returns HTTP 402 before streaming begins. It preserves the upstream payment message and the original 402 diagnostic, but returns one standard `response.failed` event with code `insufficient_quota` so native Codex treats the failure as terminal instead of reconnecting five times. Nonstream requests and every other status code remain unchanged.

None of the first four patches may change request input other than the fourth patch's model-only rewrite, tools, Responses/Chat conversion, streaming, retries, history or task control. The fourth patch may route only the documented Anti-Codex model namespace between the two named resident relays, rewrite a generic or namespaced slot to its actual upstream model, preserve an explicit routable model on canonically marked native compaction, and use isolated config only when that model is missing or unknown. It must preserve ordinary upstream provider-scoped routes on both transports. The fifth patch may change only image-bearing tool output representation. The sixth patch may add the exact-name structured `apply_patch` schema, place it before compatibility proxies and command tools, reuse the existing native custom-tool reconstruction, and append file-edit plus destructive-operation safety guidance to command tools only while `apply_patch` is available. It may not execute or block commands itself. The seventh patch may suppress only late reasoning that would otherwise interleave a second active item after visible text. The eighth patch may emit only no-secret diagnostic metadata. The ninth patch may change only bounded local request-size constants and their boundary tests. The tenth patch may add only the missing-usage fallback and its tests. The eleventh patch may change only the two reserved Anti-Codex relays at the common request entry, read only the explicit absolute policy path, preserve user messages, and record only local merged prompt text, hashes and routing metadata. The twelfth and thirteenth patches may change only the whitespace layout of their respective upstream DreamSkin test assertions. The fourteenth patch may replace only unsafe command-tool arguments at response conversion boundaries while the exact structured patch tool is available, including test pipelines that do not preserve the producer exit status and Docker creation whose deterministic task name does not match its ownership label; it must preserve safe commands and compatibility requests and may not add retries or task-control behavior. The fifteenth patch may only prevent command-driven interruption of Docker work; it must retain passive waiting and non-forced cleanup of exited containers. The sixteenth patch may only consume the canonical Codex HTTP compaction marker and pass it to existing model-only alignment; it may not log or forward the marker, alter ordinary turns, or change tools, conversion, retries, history or task control. The seventeenth patch may only use a validated current thread or session identity and bounded isolated rollout tail to align marked compaction with that task's latest model-bearing settings event; it may not inspect another task, alter ordinary turns, log or forward rollout content, or change tools, conversion, retries, history or task control. The eighteenth patch may only bound inactivity while waiting for the next upstream stream item, fail or close that same stream, and emit no-secret timeout diagnostics; it may not retry, reroute, alter completed streams or change task control. The nineteenth through twenty-first patches are limited to stable rustfmt normalization and must not intentionally change runtime behavior. The twenty-second patch may only turn a pre-stream HTTP 402 on a streamed Responses request into one terminal quota event; it may not alter other statuses, nonstream behavior, routing, failover, history, tools or task control.

## Historical Replay Example

The manual sequence below belongs to an older patch series. For the current accepted version, use the managed candidate workflow below, which reads the exact patch order and hashes from `upstream.json`.

Apply the patch to the pinned upstream commit:

```powershell
git clone https://github.com/BigPizzaV3/CodexPlusPlus.git
git -C CodexPlusPlus checkout 696d3ef1714b55ec5eb14b0828ae682b55eb9252
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0001-isolation-scope-Anti-Codex-companion-runtime.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0002-cancel-loopback-streams-without-resets.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0003-native-codex-helper-requests-text-only.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0004-route-anticodex-model-slots.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0005-preserve-image-tool-outputs-for-chat-relays.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0006-guide-models-to-structured-patch-tools.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0007-ignore-late-reasoning-after-visible-text.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0008-chore-audit-Codex-tool-conversion.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0009-fix-allow-long-multimodal-helper-requests.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0010-fix-estimate-missing-chat-usage-for-native-compaction.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0011-apply-anticodex-prompt-policy-at-common-request-entry.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0013-fix-format-dreamskin-installer-test.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0014-fix-format-dreamskin-runtime-test.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0015-enforce-Anti-Codex-command-tool-safety.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0016-block-forced-Docker-interruption.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0017-route-native-compaction-header.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0018-route-compaction-by-current-thread-model.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0019-bound-upstream-stream-inactivity.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0020-fix-format-v1.2.48-upstream.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0021-fix-format-v1.2.50-upstream.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0022-fix-format-v1.2.56-upstream.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0023-fix-proxy-stop-retries-on-payment-errors.patch
```

`upstream.json` records the patch hash and verification state.

## Preparing a New Upstream Candidate

Run `scripts\prepare-codexplusplus-candidate.ps1 -Tag vX.Y.Z` from the Anti-Codex source tree. The script fetches only that exact tag, verifies the current project patch hashes, replays them without automatic conflict resolution, runs the isolation audit and the existing managed Cargo checks, then writes a content-addressed candidate under `%LOCALAPPDATA%\Anti-Codex\component-sources\codexplusplus\candidates`.

The candidate contains clean patched source, the release launcher, `candidate.json` and `upstream.proposed.json`. It never changes the project patches or `upstream.json`, never installs or activates a component, and never stops or restarts Anti-Codex. A patch conflict therefore requires an explicit patch review and project commit. After that commit, the component installer accepts only the candidate whose version, upstream commit, patch commit and binary hash exactly match the committed metadata; the existing guarded sync remains the sole activation and rollback path.

The security-boundary integration test reads the accepted version from that content-addressed source cache. Before running it, prepare the accepted tag with the command above. The test verifies that the cached repository has the exact accepted patch commit and replay tree and that its worktree is clean; it fails with a prepare-first message when the cache is absent.

`docs/audits/codexplusplus/v1.2.46-source-replay/source-replay.json` is the historical source-replay record that preceded the managed build. It remains immutable and truthfully says that its own run did not build, publish, install or activate anything. Runtime synchronization trusts only the promoted `upstream.json` identity and its content-addressed managed candidate.

## Historical v1.3.0 Verification

These records describe the older v1.3.0 candidate, not the current accepted or installed component. Current source identity and candidate verification are recorded in `upstream.json`; installation and live-request evidence are recorded in the latest `MAINTENANCE.md` entries.

- All twenty-five patches replayed after manual v1.3.0 context adaptation; the managed promotion candidate commit is `a095b85016806e66802a4d9ce8811814f701108b`.
- The candidate-local build and Windows launchability checks passed through the fixed runner image and Docker pre/postflight checks. The launcher has SHA-256 `19ae4b18e64ac0e4de34273ad5c8cdbb5a7e38f06fc24ce6289f33efd349a16c`; its immutable guidance treats a command timeout as an unknown process/container lifetime, preserves a still-running timed-out instance until its result can be collected, requires an explicit name and current-task ownership label on every created container, and forbids global Docker cleanup without exact current-task ownership. The response conversion boundary now enforces those Docker rules and structured source editing, including rejection of stop, restart and forced removal while retaining passive wait on the same container, before an unsafe command can reach the command tool. Canonically marked HTTP compaction now validates the current task identity and follows that task's most recent model-bearing selection in either direction among third-party, Claude and Gemini routes, while ordinary turns remain unchanged. Successful helper streams now terminate after 120 seconds without upstream data instead of hanging indefinitely, and converted Chat streams surface `stream_timeout`; streamed HTTP 402 payment failures now end with one `insufficient_quota` event instead of native reconnects. Explicit no-auth relays omit the Authorization header on both direct and cancel-aware loopback paths. The focused payment-failure unit test, two focused timeout unit tests, protocol proxy suite 115/115 and watcher suite 13/13 passed with Rust test threads capped at two.
- Complete project regression and promotion preflight remain required before activation.
- A real 417 KB contact sheet sent as a standard Chat tool image returned `LARGE_IMAGE_OK`; the same image serialized as ordinary tool text reproduced the provider context-window failure.
- The prior v1.2.45 launcher SHA-256 `da45c0cfe2a07e9a9016793371ff484cb5a79ccc69c7e35e3dd492ab1fa49922` is historical evidence only and is not accepted for the current source.
- At that historical checkpoint, the project metadata was `v1.3.0` with twenty-five accepted patches, and the managed launcher above was pending guarded activation.

The isolated launcher must always receive explicit copied-client paths and child-only state environment variables. Provider and long-task readiness remain separate later gates.
