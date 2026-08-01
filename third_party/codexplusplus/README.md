# CodexPlusPlus Component Boundary

This directory pins the separately licensed CodexPlusPlus component and carries exactly eleven narrow Anti-Codex compatibility patches: product isolation, cancel-aware loopback transport, exact native-helper tool suppression, frontend-model-directed dual-relay and compaction routing, multimodal preservation for image-bearing tool outputs, structured patch-tool priority and guidance, non-interleaved streamed output ordering, metadata-only tool conversion audit, a bounded long-multimodal helper body limit, conservative missing-usage estimation for native compaction, and common-entry editable prompt policy for the two reserved Anti-Codex relays. It does not vendor CodexPlusPlus source, binaries, provider credentials or user state.

## Upstream

- Repository: `https://github.com/BigPizzaV3/CodexPlusPlus`
- Version: `v1.2.44`
- Commit: `77091ccaee4423f35a1b2c51c4ecd703e6201092`
- License: `AGPL-3.0-only`

The cloned/built component and this derived patch remain under the upstream AGPL license. Anti-Codex keeps this component at a separate source/build boundary.

## Allowed Patch Scope

The patch may change only isolation behavior:

- explicit absolute `CODEX_PLUS_STATE_DIR` for CodexPlusPlus settings, logs and locks;
- configurable `CODEX_PLUS_PROTOCOL_PROXY_PORT`;
- explicit `CODEX_PLUS_APP_EXECUTABLE` selection restricted to an existing `.exe` in the copied app directory, with invalid configuration failing closed;
- copied-app-path-scoped process discovery, activation, waiting and restart;
- fail-closed launch/restart when isolated mode has no absolute copied app path;
- exact-path manager activation;
- refusal to install or remove the shared current-user logon watcher in isolated mode.

The second patch changes only plain-HTTP loopback model transport. It uses a one-shot connection and drops the request when the downstream Codex client actually cancels, while normal streams finish and close gracefully. It must not enable zero-linger or reset a successful response. HTTPS and non-loopback providers retain the upstream request path.

The third patch removes tools only from exact official Codex title and task-suggestion helper requests. Ordinary user turns and all upstream conversion behavior remain unchanged.

The fourth patch recognizes only reserved Anti-Codex model slots and exact Antigravity models selected by the native frontend. It chooses the resident `anticodex-antigravity` or `anticodex-third-party` relay, resolves generic slots to the saved model, and strips the namespace from an explicit third-party model. When official Codex explicitly marks a request as native compaction, an explicit routable request model remains authoritative; isolated config is only a fallback for a missing or unknown request model. Directed Anti-Codex requests fail closed instead of rotating to the other provider; ordinary requests and unmarked user turns retain upstream CodexPlusPlus selection.

The fifth patch changes only image-bearing tool output conversion. It keeps ordinary tool output unchanged, replaces textual JSON/Base64 image payloads with standard Chat `image_url` content parts, and preserves the original tool call association. This prevents valid local image results from being counted as hundreds of thousands of text tokens by Chat-only providers.

The sixth patch exposes an exact-name structured `apply_patch` function before the five generated compatibility proxies and ordinary command tools, then appends file-edit guidance only to `exec_command` and `shell_command` when patch tools are present. Existing response reconstruction turns the exact-name function back into the native Codex custom tool. It does not block command execution or change execution, routing, history, retries or task control.

The seventh patch ignores a separate reasoning delta only when visible text has already started. This keeps the Chat stream mapped to one active Responses output item for current Codex clients while preserving reasoning-first streams, all visible text, tools and native task control.

The eighth patch records only native/converted tool counts, names and types for local relay diagnosis. It does not record request content, arguments, credentials or tool results and does not change conversion or routing.

The ninth patch raises the decoded loopback helper request limit from 32 MiB to 128 MiB and the encoded bound from 64 MiB to 256 MiB. Requests above the new explicit bound still return 413; routing, conversion, retries, history and task control are unchanged.

The tenth patch estimates nonzero Responses usage only when a completed Chat SSE stream omitted real usage. It counts text and tool context conservatively, excludes embedded image Base64, and never overrides upstream usage.

The eleventh patch reads only the explicitly configured absolute `prompt-policy.json` path for the exact `anticodex-antigravity` and `anticodex-third-party` relays. Default mode preserves request JSON unchanged; disabled and custom modes operate on the merged system/developer carriers before the Responses/Chat branch while preserving every user message, including the native AGENTS wrapper. It adds the optional user instruction once, keeps existing tool compatibility guidance intact, and atomically records only the original/effective merged instruction text, hashes and local route metadata in `native-prompt-snapshot.json`; an unchanged snapshot is not rewritten. Missing, malformed or out-of-scope policy input passes the original request through unchanged.

None of the first four patches may change request input other than the fourth patch's model-only rewrite, tools, Responses/Chat conversion, streaming, retries, history or task control. The fourth patch may route only the documented Anti-Codex model namespace between the two named resident relays, rewrite a generic or namespaced slot to its actual upstream model, preserve an explicit routable model on canonically marked native compaction, and use isolated config only when that model is missing or unknown. The fifth patch may change only image-bearing tool output representation. The sixth patch may add the exact-name structured `apply_patch` schema, place it before compatibility proxies and command tools, reuse the existing native custom-tool reconstruction, and append file-edit guidance to command tools only while `apply_patch` is available. The seventh patch may suppress only late reasoning that would otherwise interleave a second active item after visible text. The eighth patch may emit only no-secret diagnostic metadata. The ninth patch may change only bounded local request-size constants and their boundary tests. The tenth patch may add only the missing-usage fallback and its tests. The eleventh patch may change only the two reserved Anti-Codex relays at the common request entry, read only the explicit absolute policy path, preserve user messages, and record only local merged prompt text, hashes and routing metadata. None may add retries or task-control behavior.

## Replay

Apply the patch to the pinned upstream commit:

```powershell
git clone https://github.com/BigPizzaV3/CodexPlusPlus.git
git -C CodexPlusPlus checkout 77091ccaee4423f35a1b2c51c4ecd703e6201092
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
```

`upstream.json` records the patch hash and verification state.

## Preparing a New Upstream Candidate

Run `scripts\prepare-codexplusplus-candidate.ps1 -Tag vX.Y.Z` from the Anti-Codex source tree. The script fetches only that exact tag, verifies the current project patch hashes, replays them without automatic conflict resolution, runs the isolation audit and the existing managed Cargo checks, then writes a content-addressed candidate under `%LOCALAPPDATA%\Anti-Codex\component-sources\codexplusplus\candidates`.

The candidate contains clean patched source, the release launcher, `candidate.json` and `upstream.proposed.json`. It never changes the project patches or `upstream.json`, never installs or activates a component, and never stops or restarts Anti-Codex. A patch conflict therefore requires an explicit patch review and project commit. After that commit, the component installer accepts only the candidate whose version, upstream commit, patch commit and binary hash exactly match the committed metadata; the existing guarded sync remains the sole activation and rollback path.

## Current Verification Boundary

- All eleven patches replay without conflict on pinned upstream `v1.2.44` to head `762340c825c64d2e6fffb4f41067fcf117dcd372` and tree `0c00227e79930b7d7a917f0867594f6569bb6673`.
- The managed candidate runner passes format, protocol-proxy, watcher, Windows x64 Manager check, release build, Windows process creation, source cleanliness and Docker pre/postflight checks. The resulting 18,040,320-byte launcher has SHA-256 `4e851bd88b526d3ac21ec47d3f890f1031e4cfaef3fe638af493f287bd7ca1ab`.
- The focused supervisor, component-install, security-boundary and candidate-preparation source contracts pass 101/101. Complete project regression and promotion preflight remain required before activation.
- A real 417 KB contact sheet sent as a standard Chat tool image returned `LARGE_IMAGE_OK`; the same image serialized as ordinary tool text reproduced the provider context-window failure.
- The prior 10-patch release launcher SHA-256 `f508f3bf6b6a9e28ea5f632839ec83678b99e9937d7bd62606feafb09dcab2be` is historical evidence only and is not accepted for this 11-patch source.
- The 11-patch candidate is built but not installed or activated. The active installed component remains `v1.2.43`; current-client release gates remain separate later verification.

The isolated launcher must always receive explicit copied-client paths and child-only state environment variables. Provider and long-task readiness remain separate later gates.
