# Anti-Codex Legacy Removal Manifest

- Status: complete; production zero-hit and final Gates 1-8 pass
- Decision date: 2026-07-14
- Architecture: [`THREE_LAYER_ARCHITECTURE.md`](THREE_LAYER_ARCHITECTURE.md)

Git history is the rollback archive. Removed production code must not be copied into a `legacy`, `old`, `backup` or disabled source directory.

## 1. Delete Entirely After Route-Switch Gate

| Path | Why it leaves the product | Replacement |
|---|---|---|
| `translator/adaptive-server.mjs` | One-megabyte mixed server contains provider routing, UI/manager APIs, deterministic tasks, internal tools, command/Patch rewriting, retry and completion logic | CodexPlusPlus provider integration plus thin Antigravity Chat Adapter and launcher-owned management APIs |
| `translator/server.mjs` | Deprecated home-grown Responses/Chat translator | CodexPlusPlus upstream component |
| `translator/antigravity-upstream.mjs` | Mixes Antigravity transport with task prompts, read/write/test classification, recovery turns and tool-loop control | Extract only transport/session primitives into the new Provider Adapter, then delete this file |
| `translator/upstream-provider.mjs` | Reimplements generic third-party provider routing already supplied by CodexPlusPlus | CodexPlusPlus provider configuration/proxy |
| `translator/compat-rules.mjs` | General compatibility policy for the old mixed translator | CodexPlusPlus protocol behavior and standard Chat Completions contract |
| `translator/codex-native-harness-turn.mjs` | Home-grown Codex-to-chat turn conversion | CodexPlusPlus protocol proxy plus thin Chat-to-Cascade mapping |
| `translator/codex-native-protocol.mjs` | Self-written general Codex protocol conversion duplicates CodexPlusPlus | Upstream CodexPlusPlus protocol proxy; isolation patch must not alter it |
| `translator/codex-native-sse.mjs` | Reimplements Codex Responses event output already supplied by CodexPlusPlus | Upstream CodexPlusPlus protocol proxy; isolation patch must not alter it |
| `translator/codex-native-compact.mjs` | Old native-harness compact wrapper | Native Codex compaction through CodexPlusPlus; no adapter compact endpoint |
| `translator/response-history.mjs` | Reconstructs general Codex history in the gateway | Native Codex/CodexPlusPlus history; adapter keeps only bounded opaque Chat-call-to-Cascade correlation |
| `translator/tools/registry.mjs` | Internal replacement tool registry violates Codex tool ownership | Native Codex tool definitions passed through the Provider Adapter |
| `translator/tools/cache_stability_diff.mjs` | Internal deterministic tool implementation | Native Codex tools; host verifiers remain outside product runtime |
| `translator/antigravity-native-harness-upstream.mjs` | Old response-shaping wrapper around Antigravity transport | `translator/provider/antigravity-cascade-client.mjs` |
| `translator/antigravity-request-registry.mjs` | Old mixed-route request lifecycle and replay state | Bounded call identity inside the new provider adapter |
| `translator/antigravity-request-queue.mjs` | Old gateway-owned scheduling and retry queue | Codex owns task scheduling; the adapter only maps one provider call |
| `translator/antigravity-session-lock.mjs` | Old gateway-owned conversation/session policy | Opaque Cascade identity inside the new provider adapter |
| `translator/antigravity-failure-circuit.mjs` | Old gateway retry/model-switch policy | Provider errors propagate to Codex unchanged |
| `translator/antigravity-readiness.mjs` | Old mixed-server readiness policy | Fixed-route health plus direct provider probes |
| `translator/antigravity-account-tracker.mjs` | Old cross-account task state | Single active Antigravity account queried through native transport |
| `translator/antigravity-model-route-audit.mjs` | Old task-aware model routing audit | Fixed selected model plus provider-level request evidence |
| `translator/probe.mjs` | Probe for the deleted home-grown translator | Current three-layer gate scripts and fixed-route health |

## 2. Delete Obsolete DeepCodex Launch Stack

The copied official Codex host is now installed and supervised by the Anti-Codex launcher. The earlier independent DeepCodex launchers, plugin-unlock injection and macOS setup binaries are a second shell architecture and must be removed:

- `scripts/install-deepcodex.ps1`
- `scripts/start-deepcodex.ps1`
- `scripts/start-adaptive-translator.sh`
- `scripts/deepcodex-translator-watch.sh`
- `scripts/start-deepcodex.sh`
- `scripts/install-deepcodex-app.sh`
- `scripts/deepcodex-setup-ui.mjs`
- `scripts/DeepCodexSetup`
- `scripts/DeepCodexSetup.swift`
- `scripts/enable-deepcodex-plugin-unlock.ps1`
- `scripts/apply-deepcodex-brand.ps1`
- `scripts/deepcodex-plugin-unlock-inject.js`
- `scripts/build-macos-dmg.sh`
- `src/deepcodex-launcher-win.cs`
- `src/deepcodex-launcher.c`

The formal replacements are `scripts/start-anticodex.ps1`, `scripts/start-anticodex-fixed-route.mjs`, `scripts/install-anticodex.ps1` and the copied official Codex executable. Runtime sync and installation keep a cleanup ledger for already-installed copies of these old files; those ledger strings are not active imports.

## 3. Delete Abandoned Multi-Account And Xiaoqiang Product Paths

The released product uses one active Antigravity Desktop account. Development
workers are host-side engineering tools and must not be installed into each
Anti-Codex task. Xiaoqiang1/2/3/4 are sealed and are not product dependencies.

The following obsolete product scripts are deleted from source and retained only
as names in the installed-runtime cleanup ledger:

- `scripts/open-anticodex-windows-user-settings.ps1`
- `scripts/prepare-anticodex-antigravity-cli-profile.ps1`
- `scripts/start-anticodex-antigravity-cli-login.ps1`
- `scripts/start-anticodex-antigravity-cli-login-windows-user.ps1`
- `scripts/start-anticodex-second-antigravity-account-login.ps1`
- `scripts/test-anticodex-antigravity-account-isolation-status.ps1`
- `scripts/test-anticodex-antigravity-cli-dual-account-lanes.ps1`
- `scripts/test-anticodex-antigravity-cli-isolation.ps1`
- `scripts/test-anticodex-antigravity-cli-real-smoke.ps1`
- `scripts/test-anticodex-antigravity-cli-windows-user-readiness.ps1`
- `scripts/test-anticodex-second-account-login-entrypoint.ps1`
- `scripts/test-anticodex-second-account-post-login-proof.ps1`
- `scripts/test-anticodex-second-account-readiness-summary.ps1`
- `scripts/test-anticodex-windows-user-account-prepare.ps1`
- `scripts/test-anticodex-windows-user-setup-guidance.ps1`
- `scripts/test-anticodex-xiaoqiang-current-channel-live-proof.mjs`
- `scripts/test-anticodex-xiaoqiang-mcp.mjs`
- `scripts/test-anticodex-xiaoqiang-usage-ledger.mjs`

Current host-worker diagnostics may remain in the repository for development,
but runtime sync excludes them from the installed product. `node_repl` and
ordinary user-configured MCP servers remain supported.

## 4. Keep Only Extracted Narrow Primitives

| Current path | Allowed extracted behavior | Forbidden behavior to discard |
|---|---|---|
| `translator/antigravity-agentapi.mjs` | Desktop connection discovery, model/status queries, StartCascade, SendUserCascadeMessage, trajectory polling, same-Cascade resume, cancellation | Prompt-marker selection, task-aware response selection, semantic duplicate suppression, workspace exposure, CLI task fallback and any instruction about commands/files/tests |
| `translator/antigravity-native-mcp-bridge.mjs` | MCP initialize, tools/list, one structured tools/call, exact result return, cancellation | Tool execution, command interpretation, task completion or retries |
| `translator/antigravity-model-catalog.mjs` | Model IDs, labels and capabilities | Model task routing heuristics |

The extracted implementation lives in the small `translator/provider/` boundary. It may import no file from either deletion section.

## 5. Keep

These are outside the model task-control path and remain subject to normal cleanup:

- official Codex package copy/sync/rollback/fingerprint scripts;
- independent Anti-Codex state, process ownership and launcher;
- hard guards proving CodexPlusPlus targets only the Anti-Codex client copy and isolated state, never original Codex;
- Anti-Codex icons, shortcuts, product name and minimal Chinese `管理` entry;
- CodexPlusPlus upstream component metadata, pin and license notices;
- CodexPlusPlus's direct ordinary third-party provider routes; they never enter the Antigravity adapter;
- host-side real-task verifiers that inspect artifacts and processes without changing model behavior;
- backup-first conversation cleanup for Anti-Codex-owned state only.

## 6. Tests to Delete or Replace

Delete tests whose required product behavior is itself forbidden:

- deterministic artifact/task/title/marker completion;
- pseudo-tool parsing and internal tool execution;
- command, launch, file, Patch or verification recovery authored by the translator;
- semantic read-loop or write-loop intervention;
- stale report matrices that can be green without a current real task.

Replace them with contract tests for the Chat provider boundary:

- exact Chat Completions request acceptance;
- text/reasoning/tool-call chunk order;
- stable name, arguments, type and `call_id` round trips;
- exact tool-result resume into the same Cascade;
- one terminal completion, error or cancellation outcome;
- quota/auth/network error propagation;
- no workspace access and no tool execution inside the adapter;
- bounded call/session identity and cancellation cleanup;
- Codex++ fake-provider tests proving its existing Responses conversion supplies the client contract.

## 7. Production Source Zero-Hit Gate

After the new route passes real tasks, production source must have zero active hits for these old behavior families:

```text
deterministicArtifact
deterministicTask
artifactMarker
artifactGuard
parsePseudoTool
internalTools
callAntigravityWithInternalTools
implementationRecovery
repeatedReadOnlyInspection
repeatedLaunchCommand
normalizeFullFileBlockPatch
normalizeInlinePathFullReplacementPatch
anchorRelativeCodexPatchPaths
buildAntigravityProtocolPrompt
```

Allowed hits are limited to documentation that explains removal and host-side negative tests that assert the production runtime does not contain them.

## 8. Deletion Order

1. Prove CodexPlusPlus with the approved isolation and loopback-cancellation transport patches against a deterministic fake third-party Chat Completions provider, without Antigravity. **Complete: 27/27.**
2. Build and contract-test the small Antigravity Provider Adapter without importing delete-entire modules. **Complete: 19/19 deterministic tests and one real exact native-tool continuation.**
3. Switch a disposable Anti-Codex state to the new route and prove the old mixed server received zero requests. **Complete: 23/23.**
4. Run the real Gemini, visible-client, restart and edge gates. **Complete: Gate 5
   passes 13/13 and Gate 6 passes 14/14 plus 43/43 deterministic regressions.**
5. Delete the entire-path files, obsolete launch stack, dual-account scripts and
   forbidden tests. **Complete in the final three-layer checkpoint.**
6. Run the zero-hit gate, source/runtime sync, package/rollback checks and full
   shell/UI regression. **Complete: final source preflight passes 369/369; installed fast and sync-readiness checks pass.**
7. Run one final visible long project only after all three product parts and Gate
   7 reach 100%. **Complete: formal inventory plus migration/greenfield result acceptance; release summary is 100% and ready.**

The disposable route switch completed before deletion, so rollback now means
restoring the last packaged three-layer candidate, not reviving the mixed server.
