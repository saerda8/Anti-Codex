# Anti-Codex Core Completion Audit

> **Date:** 2026-06-13 | **Scope:** Gap analysis between current implementation and end-user goals
> **Target State:** Native Codex functionality, only models served by Antigravity, long-term stability, full independence from original Codex.

---

## 2026-06-14 update

- Account switching is no longer only model-catalog based: `/anticodex/account` exposes a privacy-preserving Antigravity account fingerprint, and the translator hot-refreshes models when a comparable account identity changes.
- Branding/UI verification is stronger than this audit originally captured: the installed overall check now validates patched ASAR app identity, Windows process/window identity, and live UI text through CDP.
- The current installed UI proof shows title `Anti-Codex`, no login/reconnect text, and visible model label `Gemini 3.1 Pro (High)`.
- Local diagnostics are now available through `/anticodex/diagnostics` and are included in installed overall verification; it exposes account/circuit/model-route/support state without prompt or tool-output transcripts.
- Lower-right/taskbar identity is now verified at runtime: the installed overall check reads the live main process name, main window title, executable metadata, patched Electron app name, tray tooltip source, and Windows app user model ID. Latest proof shows the visible entry point is `Anti-Codex`, while the original Codex remains separate.
- MCP/skills independence is improved but not complete. Anti-Codex now prefers its own config home and uses the shared original Codex home only as fallback/import source, while duplicate plugins keep the richer skills/MCP/app metadata. Skills, `cache\codex_app_directory`, and `cache\codex_apps_tools` are now installed as Anti-Codex-owned local copies rather than live junctions to the global Codex home. Translator-only recovery refreshes those local snapshots before starting the gateway. Antigravity-mode startup imports shared Codex config without writing plugin registrations or permission defaults back to the original global config. Larger plugin host sidecars still depend on shared-home imports/links, so full independence remains a tracked gap.
- Remaining major gaps are still the native Antigravity tool-event bridge, websocket transport, full Anti-Codex-native MCP/skills independence, and real proxy-off/on validation.
- A live native-tool schema probe now confirms the nuance on the tool bridge: the desktop Cascade endpoint may HTTP-accept `customAgentSpec` and schema-like fields, but current trajectories still show no native tool-event steps. The product must continue to label this as prompt-mediated until a real tool event/result protocol is captured.

---

## How to read this audit

| Priority | Meaning |
|----------|---------|
| **P0** | Blocks basic usability or independence. Must resolve before stable release. |
| **P1** | Degrades user experience or increases maintenance burden. Should resolve before feature freeze. |
| **P2** | Completeness/quality gap. Acceptable in v1 but worth tracking. |

Each item includes: existing evidence 鈫?user impact 鈫?minimum actionable next step.

---

## P0 鈥?Blocks core mission

### 1. Prompt-mediated tool bridge is not native Antigravity tool events

**Existing evidence:**
- `antigravity-upstream.mjs` line 249: sends Antigravity a `toolProtocolHint()` that tells the model to emit XML-like `<tool_calls>` markup, and the translator parses that markup back into Responses `function_call` items.
- `antigravity-agentapi.mjs` lines 27-30: Antigravity's own local tools are disabled via `toolConfig: antigravityModelOnlyToolConfig()` (mcp, exec, find, grep, browser, askPermission all force-disabled).
- `findings.md` line 36: "Codex tool definitions must be forwarded as prompt-level tool-call protocol hints because Antigravity Desktop's native tool execution remains disabled."
- Task plan `Errors Encountered` line 5: "The prompt-mediated tool bridge is compatible with current Codex function, MCP namespace, and custom-tool calls, but it is not yet Antigravity-native tool event transport."
- `findings.md` line 12: "Tool, cancellation, streaming, and full session semantics are still partial compatibility behavior until Codex core/app-server is patched to use the native Antigravity event model directly."
- Tool output JSON encoding (`response-history.mjs`): tool results are serialized as data records, not native event structures.

**User impact:**
- Models hallucinate tool outputs because they're told "you can use tools via markup" rather than receiving native tool events.
- When the Antigravity-side model omits or malforms the `<tool_calls>` XML, the tool loop silently fails (the translator blocks non-tool-call turns that look like fake claims, but the quality gap remains).
- MCP namespace tools require a flat name mapping (`mcp__node_repl__js` 鈫?`js`) that must be maintained as new tools appear.
- The system prompt (`buildSystemBlock()`) is ~10,000 characters of behavioral instructions telling the model how to behave 鈥?this is fragility, not contract compliance.

**Minimum actionable next step:**
> Investigate Antigravity Desktop's native tool execution mode. Re-enable Antigravity-owned tools (`askPermission`, `exec`, `mcp`) one by one and map their results to Codex Response events without prompt-level instructions. Start with `exec_command` since it has the highest usage.

---

### 2. Responses websocket native transport remains disabled (verified 501 fallback)

**Existing evidence:**
- `adaptive-server.mjs` exposes `unsupportedResponsesWebSocketResponse()` for HTTP prewarm and `unsupportedResponsesWebSocketHttpResponse()` for real Upgrade fallback.
- GET `/responses` and `/v1/responses` return 501 JSON with `unsupported_websocket`.
- WebSocket Upgrade requests to `/responses` and `/v1/responses` now return raw `HTTP/1.1 501 Not Implemented` with the same `unsupported_websocket` body, then close the socket.
- `findings.md` line 15: "Codex Desktop attempts a Responses websocket connection before HTTP fallback."
- Task plan `Errors Encountered` line 1: "Responses websocket transport remains intentionally disabled; the installed client is configured to use HTTP and currently shows no reconnect loop."
- `local-projection/index.mjs` line 260: local fake account has `supports_websockets: false`.
- The HTTP fallback works (`findings.md` line 33: "no reconnect text through CDP") but this is a workaround.

**User impact:**
- If a future Codex Desktop version removes the HTTP fallback or makes the websocket mandatory, Anti-Codex breaks immediately.
- All streaming data is currently poll-based (Antigravity's `GetCascadeTrajectory` polling) rather than push-based. This increases latency and server load.
- The status poll interval (1s by default) creates a fundamental latency floor that push-based websockets would not have.

**Minimum actionable next step:**
> Capture the real Codex Responses WebSocket frame protocol before implementing native support. Do not return `101 Switching Protocols` until message shape, event order, cancellation, errors, and heartbeat semantics are known.

---

### 3. MCP/skills are partially local, but not fully independent

**Existing evidence:**
- `local-projection/index.mjs` reads Anti-Codex's own config home before the shared original Codex home, then keeps the shared home as a fallback/import source.
- `sync-shared-codex-plugin-host.mjs --local-snapshots` copies `skills`, `cache\codex_app_directory`, and `cache\codex_apps_tools` into Anti-Codex's state home.
- The installed verifier now fails if connectors exist but `cache\codex_app_directory` is missing locally or is a link/reparse point. Latest proof reports `cacheLinkType:null`, `cacheFileCount:23`, and 1494 connector entries.
- `antigravity-agentapi.mjs` keeps Antigravity's own MCP tools force-disabled; Codex/Anti-Codex still owns the tool surface.
- The original Codex is still needed as an import/update source for shared MCP config and larger plugin host sidecars.

**User impact:**
- Anti-Codex is closer to independent for day-to-day reads because skills, connector directory metadata, and app-tool snapshots are local copies.
- Full independence is still not finished: a clean install still needs a migration/import source for MCP config, plugin metadata, and larger sidecars.
- MCP/skills configuration changes still lack an Anti-Codex-native editor, which is confusing and fragile.

**Minimum actionable next step:**
> Create Anti-Codex's own MCP config editor and plugin/connector registry update path. Keep the local snapshot import as migration/bootstrap only, not the normal source of truth.

---

### 4. Streaming is poll-based, not push-based

**Existing evidence:**
- `antigravity-agentapi.mjs` lines 651-841: `runAntigravityNativeTurnStreamed()` polls `GetCascadeTrajectory` every 1 second while waiting for `WaitForConversationFullyIdle`.
- `adaptive-server.mjs` lines 2272-2407: `pipeAntigravityResponseAsSSE()` receives polled text deltas and emits them as SSE events.
- Test `adaptive-pseudo-tools.test.mjs` line 709: Stream mapper converts Chat text deltas to Responses events 鈥?but only after the Chat API finishes.
- Installed streaming proof (`findings.md` line 28): "first text delta arrived at 8.759s, completion at 13.785s" 鈥?this latency includes both Antigravity processing time AND polling overhead.
- No persistent SSE or websocket connection exists between Anti-Codex translator and Antigravity Desktop; every `GetCascadeTrajectory` call is a separate HTTP POST.

**User impact:**
- Up to 1 second of artificial latency per text delta even when Antigravity has output ready (because of the polling interval).
- Each poll cycle is a separate HTTP request to the Antigravity Desktop service, adding CPU/network overhead.
- No way to get real-time tool execution events or intermediate status.
- The polling approach also means cancellation has higher latency (must wait for next poll to detect abort).

**Minimum actionable next step:**
> Investigate whether Antigravity Desktop's Cascade service supports a SSE/listen endpoint or gRPC server-sent events for `GetCascadeTrajectory`. If not, reduce polling interval dynamically (start at 200ms, back off to 1s) and add event-driven notification when idle watcher completes.

---

### 5. Refresh/update path requires patched Codex host (not independent)

**Existing evidence:**
- `scripts/sync-shared-codex-plugin-host.mjs` patches the original Codex ASAR to create Anti-Codex.exe.
- `findings.md` line 31: "Installed Anti-Codex has a real copied host at `%LOCALAPPDATA%\Anti-Codex\codex-patched-app\Anti-Codex.exe`"
- `progress.md` line 72: the host-sync flow was fixed to prevent races 鈥?but it still copies a patched Codex host.
- The brand patch replaces `Anti-Codex` strings into the Codex Electron bundle (`brand-patched-asar.mjs`).
- Config file `config.adaptive-oneapi.toml` points at the local translator (127.0.0.1:8282).

**User impact:**
- Anti-Codex cannot update itself independently. Every host update depends on patching a new version of Codex Desktop.
- If Codex Desktop's ASAR format changes or the patching logic breaks, Anti-Codex cannot ship updates.
- The update flow is fragile: it starts with the original Codex host, patches it, verifies it. If verification fails, user is left with neither working version.
- Legal/licensing concern: distributing a patched Codex Desktop binary may violate terms.

**Minimum actionable next step:**
> Establish a clean build pipeline that produces an Anti-Codex Electron host from source dependencies rather than patching Codex Desktop's binary. At minimum, document the exact dependencies extracted from Codex and produce a build script that doesn't touch original Codex files.

---

## P1 鈥?Degrades UX or increases maintenance burden

### 6. Account switching requires manual restart

**Existing evidence:**
- `findings.md` line 53: "Account switching now has a dedicated desktop shortcut. After the user changes the signed-in Antigravity account, `Refresh Anti-Codex Models` safely restarts only Anti-Codex."
- `progress.md` line 80: Real refresh verification shows ~5 seconds for model refresh + ~14 seconds for Anti-Codex restart.
- The restart is explicit and closes the Anti-Codex window (user sees window close/reopen).
- Open questions in `findings.md` line 72: "Whether account switching changes the local Cascade endpoint or only the account-visible model catalog."

**User impact:**
- Each account switch costs ~20 seconds of downtime and loses the current Anti-Codex session.
- If the user needs to switch accounts frequently (e.g., personal/work), this is disruptive.
- The current session (in-progress conversation) is lost on restart.
- The refresh shortcut is a `.lnk` file that must exist 鈥?if it gets deleted, user has no refresh path.

**Minimum actionable next step:**
> Implement hot account switching: when Antigravity Desktop changes its signed-in account, detect it via the readiness monitor and automatically refresh the model catalog without restarting Anti-Codex or the translator. The session and open window must survive.

---

### 7. No native web search support in Antigravity mode

**Existing evidence:**
- `compat-rules.mjs` lines 18, 42-48: `HOSTED_ONLY` set includes `web_search`, `web_search_preview`, `image_generation`, `code_interpreter`.
- `adaptive-server.mjs` line 294: Antigravity mode has `hostedTools: false` in the profile.
- Line 296: "No translator-provided web tools are configured."
- `antigravity-agentapi.mjs` line 29: `searchWeb: { forceDisable: true }` 鈥?Antigravity's own web search tool is disabled.
- The system prompt tells the model "If search/fetch fails or returns weak evidence, say that web access is unavailable."

**User impact:**
- Users cannot ask Anti-Codex to search the web, fetch URLs, or browse for current information in Antigravity mode.
- The model may hallucinate search results because it has no real search capability.
- The previous DeepSeek/OpenAI path had internal web tools (web_search, web_fetch), but Antigravity mode disables even those.
- Workaround: user must manually copy-paste web content into the chat.

**Minimum actionable next step:**
> Re-enable Antigravity Desktop's `searchWeb` tool or implement a translator-level web fetch that calls a search API (like the `internalTools` path in non-antigravity mode). The readiness probe already talks to Antigravity Desktop; a controlled web request through the local network is feasible.

---

### 8. Term/compaction safety for long-running agent sessions is unvalidated

**Existing evidence:**
- `adaptive-server.mjs` lines 861-871: `prepareCompactChatBody()` strips tools and disables tool_choice for compaction.
- Lines 1049-1053: `readableCompactionText()` extracts summary from context_compaction items.
- Session-based `shouldInjectEndTurn()` (lines 2212-2225) uses 30-second window + window generation tracking.
- `findings.md` line 40: "Responses history is now persisted under the isolated Anti-Codex state directory with bounded entry and character limits."
- Tests exist for compaction (test lines 63-130) but they're unit tests with static data, not long-running agent sessions.

**User impact:**
- No real validation that compaction preserves task accuracy across 50+ turn agent sessions.
- If compaction loses critical context, the model may restart from scratch (the system prompt already warns against this).
- The end_turn detection heuristic (session_id + window ID + window generation) is fragile and may inject `end_turn: false` incorrectly, causing the UI to not show the response properly.
- The response history store has a 64 entry / 32MB limit 鈥?long sessions will silently drop history, causing `previous_response_id` failures.

**Minimum actionable next step:**
> Run a sustained 100-turn agent session with compaction every 5 turns, then verify end-to-end task completion. Add integration tests that simulate compaction recovery and verify the model doesn't lose task context.

---

### 9. No Antigravity-native reasoning/thinking replay

**Existing evidence:**
- `adaptive-server.mjs` lines 958-967: Reasoning is encoded as `deepcodex.reasoning.hex.v1:` hex blobs, not native Antigravity thinking events.
- `antigravity-model-catalog.mjs` lines 67-101: Reasoning levels (low/medium/high/xhigh) are mapped by display name keywords, not by Antigravity's actual `reasoningLevel` API.
- The Antigravity model receives a text `[REASONING_EFFORT]` hint in the prompt (`antigravity-upstream.mjs` lines 205-215) rather than using `cascadeConfig.plannerConfig.reasoningLevel` or similar native parameter.
- `findings.md` line 40: "Map thinking choices without collapsing model identity" 鈥?listed as completed, but the mapping is purely heuristic based on display name.

**User impact:**
- Reasoning effort hints are unreliable 鈥?the model may ignore the prompt instruction.
- No way to get structured reasoning output from Antigravity models (the hex blob encoding is a lossy workaround).
- Model variants like "Gemini 3.5 Flash (Low)" vs "Gemini 3.5 Flash (High)" are separate catalog entries, but they all receive the same `planModel` enum 鈥?the actual effort differentiation depends on the model ID mapping, not a reasoning parameter.
- Thinking replay across continuation relies on hex-encoded blobs, which Codex can decode but any non-Anti-Codex client cannot.

**Minimum actionable next step:**
> Investigate whether Antigravity Cascade's `cascadeConfig.plannerConfig` accepts a `reasoningLevel` parameter. If so, pass it directly instead of embedding reasoning hints in the prompt. If Antigravity returns thinking tokens, map them to native Responses reasoning items instead of hex encoding.

---

### 10. Tool output guard limits (120K chars) are arbitrary

**Existing evidence:**
- `antigravity-upstream.mjs` line 24: `TOOL_OUTPUT_MAX_CHARS = 120_000`.
- Line 262: `truncateToolOutput()` implements head/tail truncation.
- `adaptive-server.mjs` lines 1090-1108: different limits for different output types (document dumps 900 chars, source dumps 1200 chars, general 4000 chars for history restoration).
- The finding says "preserving long normal context while limiting a single result to 120,000 characters" 鈥?but there's no evidence this is the right limit.

**User impact:**
- Large tool outputs (compiler logs, test results, database dumps) get truncated, potentially losing critical information.
- The truncation is silent in some paths (head/tail without warning) and verbose in others (clipping notices).
- The 120K limit is shared across all tool results in a turn, so multiple large outputs compound the loss.
- No user-configurable limit.

**Minimum actionable next step:**
> Make the tool output limit configurable per-request and document the default. Consider streaming large outputs across multiple turns instead of truncating. Add a warning in the UI when truncation occurs.

---

## P2 鈥?Completeness/quality gaps

### 11. Concurrent request handling is untested

**Existing evidence:**
- `antigravity-request-registry.mjs`: the registry is used to track active cascade IDs for cancellation.
- `adaptive-server.mjs`: a single `ACTIVE_ANTIGRAVITY_REQUESTS` registry handles all concurrent responses.
- No evidence of concurrent request tests or rate limiting.

**User impact:**
- If the user sends multiple requests rapidly, behavior is undefined 鈥?the single Cascade conversation per connection model means concurrent requests may interfere.
- Cancellation of one request may cancel the wrong Cascade.
- No queue or back-pressure mechanism exists.

**Minimum actionable next step:**
> Add integration tests for concurrent requests. Consider queuing non-concurrent Cascade requests since Antigravity Desktop creates one conversation per call.

---

### 12. Model catalog lacks validation at install time

**Existing evidence:**
- `sync-antigravity-model-catalog.mjs`: generates catalog from `GetAvailableModels` payload.
- `antigravity-model-catalog.mjs`: `buildAntigravityModelCatalog()` merges with base template.
- Startup removes invalid models (`findings.md` line 20: "Startup now removes an invalid Antigravity-mode model").
- `progress.md` line 77: "A failed discovery command now preserves the last real Antigravity catalog instead of silently overwriting it."

**User impact:**
- If `GetAvailableModels` returns a model with missing `model` field (the internal enum), the catalog entry is generated but the internal enum is undefined 鈥?the request would fail at runtime.
- The fallback catalog (when discovery fails) is the base template from the Codex bundle, which may have different models than the user's Antigravity account.
- No version pinning of model IDs: if Antigravity renames a model, Anti-Codex generates a new entry and the old session state becomes orphaned.

**Minimum actionable next step:**
> Add a validation step in the catalog sync that verifies every model entry has a valid `model` enum before writing the catalog. Add a schema version field to detect incompatible Antigravity API changes.

---

### 13. Proxy/network failure recovery is untested with real proxies

**Existing evidence:**
- `findings.md` line 72: "Whether a real external proxy interruption produces a distinct desktop-service failure that needs a longer circuit-breaker"
- `shouldRetryAntigravityFailure()` (`antigravity-upstream.mjs` lines 19-22) recognizes various network error patterns.
- `findings.md` line 51: "Proxy and gateway failures may surface through Antigravity as network/proxy errors, gateway status, deadline exceeded, or `Failed to generate plan`."
- Recovery drill (`progress.md` line 67) only tested Antigravity Desktop restart, not actual proxy interruption.

**User impact:**
- Users behind corporate VPNs or proxies may experience unrecoverable failures that look like "no available models" when the actual issue is network connectivity.
- The error messages mention "proxy connection" but offer no diagnostic guidance for different proxy failure modes.
- No automatic recovery when proxy comes back online after interruption (requires manual refresh).

**Minimum actionable next step:**
> Test with a real HTTP/HTTPS proxy failure. Classify proxy-specific errors from Antigravity Desktop and add automatic recovery when proxy connectivity resumes (not just when Antigravity restarts).

---

### 14. No metrics or diagnostics for user-facing troubleshooting

**Existing evidence:**
- `/health` endpoint returns process health + account readiness state (`adaptive-server.mjs` lines 2812-2816).
- `findings.md` line 57: "The installed gateway now returns an actionable sign-in/proxy error."
- No structured logging or metrics export exists.
- No crash report or diagnostic bundle generation.

**User impact:**
- When something goes wrong, the user gets a text error message but no way to export diagnostics for support.
- Debugging requires manually reading Node.js stderr logs (if they're captured).
- No health history or recovery tracking beyond the readiness monitor's current snapshot.
- No way to detect slow degradation (e.g., gradually increasing model response times).

**Minimum actionable next step:**
> Add a structured diagnostics endpoint (`/diagnostics`) that returns the last N readiness changes, recent errors, active configuration, and version info. Add a button in the installed UI to copy diagnostics to clipboard.

---

### 15. No integration test for brand-patched ASAR against real Codex versions

**Existing evidence:**
- `scripts/brand-patched-asar.mjs`: patches the Codex ASAR to replace branding strings.
- `scripts/brand-patch-compat.mjs`: compatibility layer for the patch.
- Codex version was 26.609 (tested). The window title fix targeted specific bundle patterns.
- `findings.md` lines 4-6: show the 26.609 bundle had two distinct title paths that both needed patching.

**User impact:**
- Each Codex Desktop update may change ASAR structure, break the branding patch, and leave users with "Codex" title or missing features.
- No automated test detects a patching failure 鈥?users only notice after the update is installed.
- The host sync flow updates the patched host, but if the patch fails, the user gets an unpatched Codex.
- No fallback if the exact bundle structure changes (the patch targets specific file paths and string patterns).

**Minimum actionable next step:**
> Add a CI step that downloads the latest Codex Desktop release (or a known compatible version), applies the brand patch, and runs a structural validation (Window title set, product name set, no original Codex strings remaining).

---

### 16. Dependency on original Codex home for auth/shared state

**Existing evidence:**
- `local-projection/index.mjs` lines 14-19: reads `DEEPCODEX_SHARED_CODEX_HOME` or `GLOBAL_CODEX_HOME` or `~/.codex`.
- `progress.md` line 49: "MCP inheritance from the global Codex config and skills inheritance through the Anti-Codex skills link."
- The skills link (`progress.md` line 49) references original Codex's skills directory.
- The installer copies the original Codex host (`findings.md` line 31) but the initial config and skill/MCP paths still point to original Codex.

**User impact:**
- Deleting the original Codex installation breaks Anti-Codex's MCP, connectors, and skills.
- Users who want to fully switch to Anti-Codex must keep original Codex installed as a hidden dependency.
- Unclear boundary: modifications to MCP in original Codex affect Anti-Codex, and vice versa (through shared cache).
- The shared user data (`deepcodex-local-user` and `deepcodex-local-account` stubs) means other Codex-aware tools may see Anti-Codex's fake local user.

**Minimum actionable next step:**
> Create Anti-Codex-specific config directories for MCP, skills, and connectors. Use symlinks only for user opt-in imports from original Codex, not for active runtime configuration.

---

## Special section: completeness assessment of stated features

The following evaluates whether each feature from task_plan.md and progress.md truly reaches the target state.

### Prompt-mediated tool bridge
**Claimed:** "completed" (task_plan Phase 5, progress.md Jun 11)
**Actual:** 鉁?Works for basic cases. 鉂?Relies entirely on prompt engineering rather than native tool protocol. Every time a model is updated or a new tool is added, the prompt instructions must be adjusted. Not sustainable long-term.
**Verdict: v1-acceptable, must be P0 for v2**

### Responses websocket
**Claimed:** "intentionally disabled" (task_plan Errors Encountered)
**Actual:** 鉁?HTTP fallback works. 鉁?HTTP prewarm and real Upgrade are explicitly rejected and installed-verified. 鉂?Native frame protocol is still missing, so a future Codex version that requires WebSocket still breaks Anti-Codex.
**Verdict: must fix before any Codex update dependency**

### Compaction/session
**Claimed:** "completed for current bridge" (task_plan Phase 3, progress.md Jun 12)
**Actual:** 鉁?`/responses/compact` works. 鉁?`end_turn` injection works (session_id + window gen tracking). 鉁?`previous_response_id` survives restarts. 鉂?No long-session validation (100+ turns). 鉂?End_turn heuristic may be wrong for some session patterns.
**Verdict: v1-complete, needs stress testing**

### MCP/skills
**Claimed:** "inheritance from the global Codex config" (progress.md Jun 11)
**Actual:** 鉁?Inherited MCP/skills work through shared Codex home. 鉂?NOT independent 鈥?requires original Codex to remain installed. 鉂?No Anti-Codex-native MCP configuration editor.
**Verdict: functional but violates independence goal**

### Update/sync
**Claimed:** "one-click host sync" (task_plan Phase 5, progress.md Jun 12)
**Actual:** 鉁?Host sync preserves rollback, prevents races, reopens Anti-Codex. 鉂?Requires original Codex to be installed (anti-independence). 鉂?Patching is fragile per-Codex-version.
**Verdict: functional but fragile; independence means a non-patched build**

### Model selection/identity
**Claimed:** "completed for v1" (task_plan Phase 3)
**Actual:** 鉁?Eight account-visible models in menu. 鉁?Exact model IDs preserved through requests. 鉁?Invalid models corrected on startup. 鉂?Reasoning levels are heuristic based on display name, not API parameter.
**Verdict: v1-complete**

### Cancellation
**Claimed:** "completed" (task_plan Phase 5)
**Actual:** 鉁?`/v1/responses/{id}/cancel` 鈫?`CancelCascadeInvocation`. 鉁?Verified in installed build. 鉂?Causes best-effort Cascade cancellation 鈥?no guarantee Antigravity respects it.
**Verdict: v1-complete**

### Streaming
**Claimed:** "completed" (task_plan Phase 2, progress.md Jun 11)
**Actual:** 鉁?Text deltas emitted as SSE events. 鉁?Completion gating via `WaitForConversationFullyIdle`. 鉂?Poll-based (1s interval), not push-based. 鉂?Higher latency than native Codex streaming.
**Verdict: v1-functional, P1 for UX**

### Process isolation
**Claimed:** "completed" (task_plan Phase 4, findings.md)
**Actual:** 鉁?Separate executable, state root, ports, shortcuts, user-data directory. 鉁?No ChatGPT OAuth in Anti-Codex state. 鉁?Independent crash recovery.
**Verdict: complete**

### Account/refresh isolation
**Claimed:** "completed" (progress.md Jun 12)
**Actual:** 鉁?Refresh restarts only Anti-Codex. 鉁?Leaves original Codex and Antigravity Desktop running. 鉂?Session lost on refresh.
**Verdict: v1-complete**

---

## Summary

### 2026-06-14 Update

- Translator-only recovery now starts with the real cached/generated Antigravity model catalog, so `/models` and diagnostics show eight account-visible models immediately after gateway recovery.
- App connectors remain directory-visible but not callable unless a connector is `isAccessible:true` and has real cached tool definitions. The current installed state has 1494 connectors, 0 accessible connectors, and 0 tool definitions, so `appToolCount=0` is expected rather than a hidden failure.
- Skills are now an Anti-Codex-owned local copy, while larger plugin/cache sidecars still use shared/imported state. Full independence from the original Codex home is therefore improved but not complete.
- Responses WebSocket still has no native frame protocol implementation, but both HTTP prewarm and real Upgrade requests are now covered by an explicit, installed-verified `501 unsupported_websocket` fallback.

| Area | Status | Priority | Independence? |
|------|--------|----------|:---:|
| Model routing | 鉁?Complete | 鈥?| 鉁?|
| Streaming | 鈿狅笍 Poll-based | P1 | 鉁?|
| Cancellation | 鉁?Complete | 鈥?| 鉁?|
| Tool bridge | 鈿狅笍 Prompt-mediated | P0 (v2) | 鉁?|
| MCP/Skills | 鈿狅笍 Inherited | P0 | 鉂?|
| Compaction | 鉁?Complete (needs testing) | P1 | 鉁?|
| Session end_turn | 鈿狅笍 Heuristic-based | P1 | 鉁?|
| Websocket | Fallback verified; native protocol missing | P0 | 鉁?|
| Update | 鈿狅笍 Patch-based | P0 | 鉂?|
| Account switch | 鈿狅笍 Requires restart | P1 | 鉁?|
| Process isolation | 鉁?Complete | 鈥?| 鉁?|
| Reasoning replay | 鈿狅笍 Heuristic/encoded | P1 | 鉁?|

**Key finding:** The project has made excellent progress on the translation layer (Responses鈫擟hat, streaming, cancellation, tool fidelity), but the independence goal is unmet in three critical areas: MCP/skills (requires original Codex), update mechanism (patches original Codex), and the tool bridge (prompt-engineering workaround).

**Recommendation:** Make Independence the theme of the next development cycle. Specifically:
1. Create standalone MCP/skills config for Anti-Codex
2. Replace the ASAR-patching update flow with a clean build
3. Investigate Antigravity native tool execution to eliminate the prompt-mediated bridge

