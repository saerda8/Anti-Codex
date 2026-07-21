# CodexPlusPlus Component Boundary

This directory pins the separately licensed CodexPlusPlus component and carries exactly nine narrow Anti-Codex compatibility patches: product isolation, cancel-aware loopback transport, exact native-helper tool suppression, frontend-model-directed dual-relay and compaction routing, multimodal preservation for image-bearing tool outputs, structured patch-tool priority and guidance, non-interleaved streamed output ordering, metadata-only tool conversion audit, and a bounded long-multimodal helper body limit. It does not vendor CodexPlusPlus source, binaries, provider credentials or user state.

## Upstream

- Repository: `https://github.com/BigPizzaV3/CodexPlusPlus`
- Version: `v1.2.39`
- Commit: `37c628e58b21cd3698b68a72c15133c91ccc5f92`
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

The fourth patch recognizes only reserved Anti-Codex model slots and exact Antigravity models selected by the native frontend. It chooses the resident `anticodex-antigravity` or `anticodex-third-party` relay, resolves generic slots to the saved model, and strips the namespace from an explicit third-party model. When official Codex explicitly marks a request as native compaction, a stale request model is aligned to the current model selected in isolated Anti-Codex state before the same relay selection runs. Directed Anti-Codex requests fail closed instead of rotating to the other provider; ordinary requests and unmarked user turns retain upstream CodexPlusPlus selection.

The fifth patch changes only image-bearing tool output conversion. It keeps ordinary tool output unchanged, replaces textual JSON/Base64 image payloads with standard Chat `image_url` content parts, and preserves the original tool call association. This prevents valid local image results from being counted as hundreds of thousands of text tokens by Chat-only providers.

The sixth patch exposes an exact-name structured `apply_patch` function before the five generated compatibility proxies and ordinary command tools, then appends file-edit guidance only to `exec_command` and `shell_command` when patch tools are present. Existing response reconstruction turns the exact-name function back into the native Codex custom tool. It does not block command execution or change execution, routing, history, retries or task control.

The seventh patch ignores a separate reasoning delta only when visible text has already started. This keeps the Chat stream mapped to one active Responses output item for current Codex clients while preserving reasoning-first streams, all visible text, tools and native task control.

The eighth patch records only native/converted tool counts, names and types for local relay diagnosis. It does not record request content, arguments, credentials or tool results and does not change conversion or routing.

The ninth patch raises the decoded loopback helper request limit from 32 MiB to 128 MiB and the encoded bound from 64 MiB to 256 MiB. Requests above the new explicit bound still return 413; routing, conversion, retries, history and task control are unchanged.

None of the first four patches may change request input other than the fourth patch's model-only rewrite, tools, Responses/Chat conversion, streaming, retries, history or task control. The fourth patch may route only the documented Anti-Codex model namespace between the two named resident relays, rewrite a generic or namespaced slot to its actual upstream model, and align only a canonically marked native compaction request to a known current Anti-Codex selection. The fifth patch may change only image-bearing tool output representation. The sixth patch may add the exact-name structured `apply_patch` schema, place it before compatibility proxies and command tools, reuse the existing native custom-tool reconstruction, and append file-edit guidance to command tools only while `apply_patch` is available. The seventh patch may suppress only late reasoning that would otherwise interleave a second active item after visible text. The eighth patch may emit only no-secret diagnostic metadata. The ninth patch may change only bounded local request-size constants and their boundary tests. None may add retries or task-control behavior.

## Replay

Apply the patch to the pinned upstream commit:

```powershell
git clone https://github.com/BigPizzaV3/CodexPlusPlus.git
git -C CodexPlusPlus checkout 37c628e58b21cd3698b68a72c15133c91ccc5f92
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0001-isolation-scope-Anti-Codex-companion-runtime.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0002-cancel-loopback-streams-without-resets.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0003-native-codex-helper-requests-text-only.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0004-route-anticodex-model-slots.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0005-preserve-image-tool-outputs-for-chat-relays.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0006-guide-models-to-structured-patch-tools.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0007-ignore-late-reasoning-after-visible-text.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0008-chore-audit-Codex-tool-conversion.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0009-fix-allow-long-multimodal-helper-requests.patch
```

`upstream.json` records the patch hash and verification state.

## Current Verification Boundary

- All nine patches replay on the pinned commit to accepted source head `8ac882f55daf80c406e31c9d01803032f4e5daf1`.
- Repository isolation audit: 9/9 checks passed.
- Component regression tests: 16/16 passed.
- Targeted `rustfmt --check` passed for the changed protocol source and test; the pre-existing watcher import-order difference remains outside the protocol patch.
- Pinned `messense/cargo-xwin:0.23.0` Windows cross-check: core and Manager passed.
- Regression tests: the seven-patch baseline passed 190/190 core tests and 54/54 protocol proxy tests; patch 0008 passed its focused no-secret diagnostic test and patch 0009 passed 5/5 decoded/encoded body-boundary tests.
- A real 417 KB contact sheet sent as a standard Chat tool image returned `LARGE_IMAGE_OK`; the same image serialized as ordinary tool text reproduced the provider context-window failure.
- Release launcher build: passed; 16,943,616 bytes; SHA-256 `9ae04c69b65ead219053974a38b4ffa29475a3e9c6f36fd9b032df86556587ce`.
- Runtime isolation proof: 20/20 checks passed against copied Codex `26.715.4045.0`; invalid executable selection failed closed, original Codex and the active Anti-Codex stayed unchanged, and all test processes were removed.
- Installed real-mouse model switching preserves the copied client, CodexPlusPlus process, original Codex process and current visible task. Repeated approximately 35 MiB same-task multimodal third-party requests now pass above the former 32 MiB limit, and the accepted task completed a real 50.342-second live-action video plus a hash-bound 19-entry package without 413 or reconnect.

The isolation component is runtime-ready for Gate 2. The isolated launcher must always receive explicit copied-client paths and child-only state environment variables; provider and long-task readiness remain separate later gates.
