# Anti-Codex Core Stability Rebuild

## Current Status
- Primary external-tool transport: native Antigravity MCP with same-Cascade continuation. External MCP permission interactions are answered automatically as soon as the structured waiting event appears, before Codex executes the tool.
- Prompt-mediated tool transport is now a compatibility fallback only. It is used when native MCP fails before any Codex-visible event, or when `ANTICODEX_NATIVE_TOOL_BRIDGE=0` explicitly disables the native bridge.
- Current installed proof: diagnostics require `toolBridge.mode:"native-mcp-same-cascade"`, `nativeBridgeDefaultEnabled:true`, `nativeAntigravityToolEvents:true`, and `nativeMcpPermissionMode:"automatic-before-codex-execution"`.
- Recent deployment note: most core runtime hardening has already been deployed and verified in the installed Anti-Codex runtime. For new source changes, deploy only when the change is intentionally ready for an installed sync/verification pass.
- Current source-development batch completed: shared Codex guidance inheritance, two-observation account-change confirmation, bounded/exclusive Antigravity request scheduling, graceful shutdown cancellation, transactional/concurrency-safe local snapshots, lightweight routine startup, Manager diagnostics, exact model-name verification, rollback safety, shortcut/icon identity checks, shortcut repair evidence, and embedded Manager close-hit-area hardening.
- Latest source gate passed: full translator regression 585 tests total, 551 passed, 34 skipped, 0 failed; touched Manager/shortcut PowerShell scripts parsed successfully; Manager button self-test passed.
- Current traffic status: Anti-Codex separates local gateway/model-catalog readiness from real Antigravity traffic readiness. When Antigravity Desktop blocks requests with account verification or token-refresh failures, Manager surfaces `account_verification_required` or `account_verification_with_missing_token` with a direct action instead of treating the gateway as crashed.
- Current icon asset: the user-provided 2026-06-17 02:34 white-background pink Codex-style asset has replaced the earlier provisional icon in source. It is converted into transparent `assets/anticodex-icon.png` and multi-size `assets/anticodex.ico`; do not redesign it unless the user provides another replacement asset.
- Current startup optimization: re-launching an already-open Anti-Codex uses a pre-update/pre-Antigravity-helper fast path with loopback health checks; cold/translator-only startup skips lightweight MCP/skills snapshot refresh when the local startup snapshot marker and required local copies already exist. Full refresh remains available through install/sync/Manager refresh, and stale snapshot locks now recover after a configurable 60-second default.
- Current Manager direction: the Manager should be an in-app Anti-Codex surface, not a standalone browser page. Source now injects the native overlay panel directly into the existing Anti-Codex window; the Start Menu manager action opens that same embedded panel and source tests reject iframe/new-page regressions.
- Current Manager validation: `native-panel-v85` is deployed to the installed runtime. Fast and full no-traffic UI checks pass, the short non-fast UI probe records `dynamicProbeUnavailable` instead of hanging when the browser overlay probe times out, and installed overall no-traffic passes. The installed UI proof shows no login/reconnect text, eight visible Antigravity models, the embedded Manager entry, the local connector allowlist card, latest-report freshness/stale state, and the new stability-soak Manager action.
- Current real-traffic recovery: fixed the installed verifier race that matched `/anticodex/model-routes.latest` from unrelated requests, fixed Manager reset probing so stale Antigravity session locks can be cleared when diagnostics show zero active upstream requests, and raised full real-traffic subcheck timeouts to realistic Gemini/Antigravity latency. Individual installed real-traffic gates now pass for tool loop, native multi-tool loop, web tools, MCP tool loop, custom tool loop, compaction resume, account/proxy readiness, real mini-tool, and real work. Full installed post-verification also passes with real traffic in about 419 seconds, zero failures, clean session lock, and no Manager long-task attention.
- Current verifier update: `scripts/test-anticodex-local-connectors.mjs` starts an isolated temporary translator and proves local connector/app-tool allowlist filtering over real HTTP endpoints while keeping link/noauth/oauth responses metadata-only unsupported. `scripts/test-anticodex-plugin-capabilities.ps1` now adds full shared-to-local connector/app-tool cache parity, and `scripts/test-anticodex-third-party-provider.mjs` verifies nine-turn continuity across provider save, translator restart, OpenAI-compatible provider switch, OpenAI-compatible to Anthropic protocol switch, and Anthropic back to OpenAI-compatible switch. It also checks provider requests never use stale Antigravity model IDs and saved/restored/report/error payloads do not leak API keys. The installed runtime is synced, and installed overall no-traffic verification passes with local connector/app-tool, third-party provider continuity, UI state, and UI idle stability checks green.
- Current source-snapshot optimization: `anticodex-source-snapshot.ps1` now caches unchanged file hashes by path, size, and mtime under the Anti-Codex state cache. Repeated refresh/MCP/plugin/source-preflight snapshots can reuse hashes without changing the report fingerprint contract; regression coverage proves the second unchanged snapshot is all cache hits, and report summaries/Manager surfaces show cache hit/miss counts. `refresh-anticodex-local-features.ps1` also caches its own per-file directory hash work across verify-only runs and reports hashCache hit/miss evidence.
- Current skill migration check: installed Anti-Codex local skills match the union of the shared `.codex\skills` and `.agents\skills` roots on this machine, including dot-prefixed `.system` skills. A focused sync regression now proves `--skills-only` imports `.system\...` directories as real local copies.
- Current MCP/Skill verifier optimization: `test-anticodex-mcp-skills.ps1` now caches inherited skill/guidance file hashes, exposes `hashCache` evidence through reports, diagnostics summaries, and Manager surfaces, and bounds short-budget behavior. With `-TimeoutSec 5`, it reuses the previous full source snapshot while still running real `node_repl` smoke plus Antigravity/DeepSeek MCP tools/list checks; it writes a signed degraded/ready report instead of timing out without evidence.
- Current connector boundary update: local connector allowlists are now metadata previews only. They set `locallyAllowlisted`/`localAuthorization` evidence, but they no longer turn a connector into `isAccessible:true` or expose app tools. App tools are exposed only for connectors whose cached remote state is already `isAccessible:true`; diagnostics now separates `remoteAuthorizedCount`, `localAllowlistedCount`, and `callableToolCount`. Installed no-traffic overall passes with the Manager non-authorization warning visible.
- Current branding residue update: user-visible legacy DeepCodex wording in the shared launcher prompts and fallback third-party setup UI has been replaced with Anti-Codex branding. The restored-history target-hint extractor now keeps real `deepcodex\...` paths but no longer injects bare `deepcodex-*` legacy brand tokens into model-visible compaction context. Internal compatibility names such as `DEEPCODEX_*`, `start-deepcodex.ps1`, `deepcodex-translator.exe`, local state paths, and Antigravity `CORTEX_*` protocol constants remain intentionally unchanged.

## Goal
Build an independent Anti-Codex desktop client that preserves Codex desktop capabilities while using the signed-in Antigravity account, with stable model selection, protocol compatibility, process isolation, account switching after restart, and predictable recovery.

## Baseline Principles
- Do not modify or depend on the running state of the original Codex installation.
- Treat Codex app-server behavior and schemas as the client contract.
- Treat Antigravity Desktop/CLI discovery as an adapter boundary, not as UI automation.
- Preserve the native Codex event, tool, MCP, skill, cancellation, compaction, and session semantics; a visual shell is not an acceptable deliverable.
- Model names and IDs must come from the active Antigravity account and must be provably used by the execution layer.
- No feature is complete until installed-build validation passes.
- Do not restart the user's original Codex during development or validation.

## Phases

### Phase 1: Protocol and Architecture Audit
Status: completed_for_v1_transport
- Inventory every endpoint and transport used by Codex Desktop.
- Render the model catalog through the bundled Codex CLI.
- Identify reconnect causes from app-server and gateway logs.
- Compare Antigravity Desktop HTTP service, CLI, and persistent-process options.
- Decide the supported v1 architecture and explicit unsupported surfaces.
- Chosen v1 transport: Antigravity Desktop local Cascade service, with CLI retained only as fallback.

### Phase 2: Stable Gateway Core
Status: mostly_complete_for_v1
- Split lifecycle, protocol projection, model catalog, and Antigravity transport responsibilities.
- Add deterministic startup/readiness/shutdown behavior.
- Implement the required HTTP and websocket contracts or disable them before client startup.
- Make plugin endpoints schema-correct or cleanly unavailable without retry storms.
- Keep the native desktop-service route as default and verify it through installed Anti-Codex startup.
- Completed for current bridge: real SSE text deltas, final completion gating, cancellation, local-health startup recovery, and no websocket reconnect storm in the tested HTTP path.

### Phase 3: Model and Session Contract
Status: completed_for_v1
- Show each available Antigravity model as a distinct Codex model.
- Select a valid default model from the dynamic catalog.
- Preserve exact model IDs through every request.
- Map thinking choices without collapsing model identity.
- Preserve long context without command-line truncation.
- Completed for current bridge: 8 account-visible models are generated into the installed catalog; invalid `gpt-5.5` is corrected on startup; selected public IDs resolve to Antigravity internal `planModel` enums.
- Completed for current bridge: every current account-visible model was routed through a real installed request with the exact selected model ID.
- Completed for current bridge: native Cascade transport accepted a single 900,013-character message without local truncation.

### Phase 4: Failure Recovery and Isolation
Status: mostly_complete_for_v1
- Recover from Antigravity Desktop restart, account switch, proxy interruption, and CLI failure.
- Prevent duplicate launchers, translators, and orphan processes.
- Keep original Codex files, processes, state, ports, and shortcuts isolated.
- Add bounded retries, circuit breaking, and useful local diagnostics.
- Completed for current bridge: translator-only recovery for an already-open Anti-Codex window, avoiding desktop process kill/restart and avoiding the shared launcher mutex.
- Completed for current bridge: bounded Anti-Codex main-process restart, translator watchdog recovery, and Antigravity Desktop watchdog recovery.
- Antigravity Desktop recovery now adopts an already-running supported desktop process, resolves installed candidates from Windows uninstall metadata, matches the exact executable path, requires a stable process window, and applies a 60-second failure cooldown.
- Installed failure drill passed: Antigravity Desktop restarted from PID 22128 to PID 34764 while Anti-Codex stayed on PID 17428, followed by a successful real model response.
- Antigravity local-service discovery is cached inside the translator and refreshed after connection failure, avoiding a blocking Windows process scan on every readiness check and model turn.
- Translator watchdog health checks now allow three bounded failures before restart, preventing a busy but healthy gateway from being mistaken for a crashed process.
- Account/model refresh no longer requires closing Anti-Codex in the healthy path. The translator exposes `/anticodex/models/refresh`, the installed shortcut calls it first, and the restart-based refresh remains only as fallback.
- Antigravity account-backed requests now pass through one shared FIFO queue across chat completions, compact/non-streaming Responses, and streamed Responses. Queued streamed requests can be cancelled before entering upstream, preventing overlapping Cascade turns and reducing reconnect/stale-session risk.
- Installed compaction/session-resume verification now proves readable context compaction, tool suppression during compact mode, direct compaction-item replay, and persisted response-ID continuation. Compaction-state recall no longer trips the fake-tool-claim guard, while genuine future tool promises remain blocked.
- Installed overall now includes a fast mandatory streaming-cancellation contract check with matching response IDs, cancelled terminal status, no completed/failed terminal event, and healthy post-cancel readiness.
- Repeated proxy/network failures now open a short Antigravity failure circuit. New requests fail fast with retryable metadata instead of piling into the Cascade queue, while `/health.ok` remains process-healthy so the launcher does not restart the translator for account/proxy readiness failures.
- Re-launching an already-open installed Anti-Codex now resolves the real install root from `runtime\scripts`, detects the existing main window, activates it, and exits quickly instead of falling into full startup monitoring.
- Normal startup now reuses the last successful Antigravity model catalog when available, avoiding blocking live model discovery on every launch. Explicit account/model refresh remains available through the shortcut and `ANTICODEX_FORCE_STARTUP_MODEL_REFRESH=1`.
- Cold relaunch is now covered by an installed verifier that stops only Anti-Codex host/launcher/translator processes, restarts through the installed launcher, and checks original Codex isolation.
- Account switching now has a privacy-preserving fingerprint proof through `/anticodex/account`; the installed translator hot-refreshes models when the comparable Antigravity account identity changes.
- Installed branding isolation now covers the executable name, visible window title, patched Electron app name, tray tooltip source, and Windows app user model ID, so the lower-right/taskbar identity no longer falls back to Codex.
- Installed external branding verification now checks the live Windows process name, window title, and executable metadata, so a future Codex sync cannot silently expose the main Anti-Codex entry point as `Codex`.
- Local plugin/connector projection now prefers Anti-Codex's own config home before the shared original Codex home, while preserving richer shared metadata for duplicate plugin records.
- Skills, connector directory metadata, and local app-tool cache snapshots have moved from live shared-home dependency to Anti-Codex-owned local copies. This reduces dependency on the original Codex home while keeping only larger plugin host sidecars on the current staged import/link path.
- Translator-only recovery now refreshes those local snapshots before starting the gateway, so MCP/skills and connector metadata recover with the gateway rather than waiting for a full desktop relaunch.
- Antigravity-mode startup now treats the original Codex config as import-only: shared MCP/config blocks may be copied into Anti-Codex's own config, but plugin registration restoration and permission defaults no longer write back to the original global Codex config.

### Phase 5: Installed-Build Verification
Status: completed_for_autonomous_v1_checks; pending_next_development_batch_deploy
- Run unit and protocol contract tests.
- Verify model menu and selected model in the actual desktop UI.
- Verify Chinese, long context, MCP/skills, tools, and cancellation.
- Run reconnect, Antigravity restart, and proxy interruption scenarios.
- Run a sustained stability soak and verify clean shutdown/relaunch.
- Next combined gate for the 2026-06-17 source batch: deploy/sync the installed runtime, verify the in-app Manager button and overlay in the real Anti-Codex window, verify taskbar/tray icon/title after relaunch, run no-traffic installed overall, then run real account/proxy, model-routing, tool-loop, and stability checks.
- Completed current checks: installed translator health, Chinese response, long streaming delta timing, cancellation, and full unit/protocol regression.
- Completed current checks: custom/freeform tool projection, mixed six-turn installed soak, persistent `previous_response_id` continuation across translator and full desktop restarts, Anti-Codex main-process crash recovery, and Antigravity Desktop crash recovery.
- Completed current checks: transient desktop-service failures use at most three total attempts with progressive delay before any Codex-visible stream event, with no duplicate output after an event is visible.
- Completed current checks: one-click host sync builds and validates a candidate, prevents the old launcher from racing the update, preserves rollback, and automatically reopens Anti-Codex.
- Completed current checks: post-sync UI title, auth isolation, eight-model menu, selected-model routing, Chinese response, original Codex isolation, and full regression.
- Completed current checks: one-click account-model refresh safely restarts only Anti-Codex, refreshes the signed-in Antigravity model catalog, and leaves original Codex and Antigravity Desktop running.
- Completed current checks: account-model discovery failure preserves the last real catalog instead of silently replacing it with the bundled fallback.
- Completed current checks: assistant tool calls and completed results retain call identity, arguments, tool names, and out-of-order pairing across Responses continuation.
- Completed current checks: tool results are encoded as bounded untrusted JSON data, preserving long normal context while limiting a single result to 120,000 characters.
- Completed current checks: the installed two-turn tool loop succeeded after account recovery, preserving the call ID and returning the tool value in the second turn.
- Completed current checks: Antigravity-mode tool markup is now strict-routed through the real Codex tool map; unknown tools are rejected, required and forbidden-extra parameters are enforced, and schema types are coerced before any Codex-visible tool call is emitted.
- Completed current checks: installed streaming refreshes the final Cascade trajectory after idle, uses the completed planner response as final text, supports cancellation, and passed a 90-second mixed health/request soak without translator restart.
- Completed current checks: repeatable installed soak script now covers Chinese turns, long-context preservation, two-turn tool continuation, streaming final text, cancellation, and looped health checks. The latest installed run passed for 90 seconds with 17 health checks, stable translator PID 2252, and zero failures.
- Completed current checks: installed model hot-refresh returned the current eight Antigravity model IDs, preserved translator PID 9068, kept `/models` correct, and passed a post-refresh stability soak with zero failures.
- Completed current checks: Antigravity request queue, queued-stream cancellation, and long-context marker guard passed full translator regression and installed stability soak; latest installed run kept translator PID 25684 stable with zero failures.
- Completed current checks: proxy/circuit hardening passed full translator regression and installed soak; installed health exposes circuit state and the launcher watchdog is covered against restarting on transient account/proxy readiness failures.
- Completed current checks: installed MCP/skills verification is now repeatable through `test-anticodex-mcp-skills.ps1`; the runtime copy passed with Antigravity health ready, three MCP servers, local copied skills, 178 installed local plugins, and 1494 cached connectors.
- Completed current checks: plugin capability grading is now repeatable through `test-anticodex-plugin-capabilities.ps1`; the runtime copy passed with 178 plugins, 69 skill-bearing plugins, 151 app-bound plugins, 3 MCP-declaring plugins, 1494 connector directory entries, 0 accessible linked connectors, and 0 exposed app tools after filtering inaccessible connectors (with 52 cached app tools recognized as a historical cache finding, not currently exposed or active capabilities).
- Completed current checks: translator-only recovery is now repeatable through `test-anticodex-translator-recovery.ps1`; the runtime copy passed after invoking the installed recovery path, with Antigravity health ready, eight models, 178 installed plugins, and 0 exposed app tools.
- Completed current checks: `start-deepcodex.ps1 -TranslatorOnly` now exits through an early gateway-only path, avoiding full desktop startup work before local translator recovery.
- Completed current checks: installed repeated-launch returned in about 1.3s, kept one visible `Anti-Codex` main process, and preserved healthy Antigravity gateway state.
- Completed current checks: post-launch-fix installed 60-second soak passed with Chinese, long-context, two-turn tool continuation, streaming, cancellation, loop health, and stable translator PID.
- Completed current checks: installed cold relaunch passed in about 29.5s, preserved original Codex isolation, returned one Anti-Codex main process, one translator, one launcher, and passed a follow-up 45-second soak with stable translator PID.
- Completed current checks: installed overall verifier now covers health, eight-model catalog exposure, exact Anti-Codex main-window count, host child process reporting, translator/launcher presence, original Codex isolation, MCP/skills inheritance, plugin capability grading, and optional stability soak. Latest installed runs passed both before and after cold relaunch.
- Completed current checks: installed real-work verifier passed with real Antigravity traffic. The model created a probe file, executed the local `node_repl` MCP tool, matched the real-work marker, and returned normal Chinese final text.
- Completed current checks: installed account/proxy readiness verifier now hot-refreshes models, sends a real marker request, proves local Anti-Codex traffic bypasses proxy, classifies account/proxy/circuit failures, and is included in the default installed overall verifier.
- Completed current checks: manual verification, account switching, and proxy-drill scripts remain installed under the Anti-Codex runtime, but the desktop now intentionally exposes only `Anti-Codex.lnk` to avoid confusing duplicate helper entries.
- Completed current checks: the installed account-switch workflow can still refresh Anti-Codex models and run the installed overall verifier without touching original Codex; it is no longer exposed as a desktop shortcut.
- Completed current checks: the installed proxy-drill workflow can still collect baseline/outage/recovery evidence; it is no longer exposed as a desktop shortcut.
- Completed current checks: the installed overall check, account-switch workflow, and proxy drill now write latest and timestamped JSON reports under `%APPDATA%\anticodex\reports`, so results survive closing the console window.
- Completed current checks: every successful Antigravity request now writes bounded model-route metadata to `%APPDATA%\anticodex\model-route-audit.json`, and `/anticodex/model-routes` exposes the latest entries for local verification without storing prompts.
- Completed current checks: the installed account/proxy verifier now validates that a real request's selected model ID matches the resolved Antigravity route and includes the internal `planModel` enum in its result.
- Completed current checks: full-model route verification is now repeatable through `test-anticodex-model-routing.ps1`. Latest installed run sent real marker requests through all eight visible models and each selected ID matched the resolved Antigravity route with an internal model enum.
- Completed current checks: installed overall verification now includes a real two-turn tool-loop check. It proves Antigravity can request a Codex tool call, Anti-Codex can return the tool result by `call_id`, and the follow-up turn consumes the result without leaking prompt-level tool markup.
- Completed current checks: installed overall verification now includes an MCP namespace tool-loop check through `test-anticodex-mcp-tool-loop.ps1`. It proves the Antigravity prompt-mediated bridge reverse-maps the flattened MCP namespace tool `mcp__node_repl__js` back to Codex subtool name `js` in the first `function_call`, and that `function_call_output` continuation consumes the result without duplicate invocation. No real MCP tools are executed; only Responses protocol output is inspected.
- Completed current checks: account switching now records before/after model snapshots and fingerprints, added/removed models, full-model route verification, and installed overall verification. It explicitly avoids claiming an account identity change when the visible catalogs are identical.
- Completed current checks: the restart fallback used when hot model refresh is unavailable now launches Anti-Codex detached and waits for bounded gateway recovery. A forced installed drill returned successfully, restored eight models, and preserved original Codex isolation.
- Completed current checks: installed ASAR inspection proves the app-name patch, removed dynamic Codex app-name setter, tray tooltip source, `AntiCodex` app user model ID, and window title patch. Windows process inspection shows Anti-Codex and original Codex as separate visible windows.
- Completed current checks: installed overall verification after the latest deployment passed with eight models, account/proxy readiness, MCP/skills, plugin capability grading, tool-loop continuation, single true Anti-Codex main window, one translator, one launcher, and original Codex isolation.
- Completed current checks: installed overall verification now also reads the real Anti-Codex UI through CDP and fails on ChatGPT login text, reconnect text, missing `Anti-Codex` page title, or missing current Antigravity model label/ID.
- Completed current checks: installed overall verification now includes `/anticodex/diagnostics`, proving local troubleshooting data is available without exposing prompts, messages, tool outputs, or input items. The diagnostics payload now exposes the default tool bridge as `toolBridge.mode:"codex-owned-tools-prompt-mediated"` with `nativeBridgeDefaultEnabled:false`.
- Completed current checks: installed overall verification now also includes `test-anticodex-tool-bridge-mode.ps1`. The verifier treats native MCP as an opt-in diagnostic path and the normal Codex-owned tool loop as the default health proof.
- Completed current checks: local connector projection scrubs cached ChatGPT install URLs; installed verification after translator restart showed zero `chatgpt.com` install URLs across 1494 connector entries.
- Completed current checks: installed overall verification now also includes external branding proof. Latest installed run passed with `Anti-Codex.exe`, `MainWindowTitle: Anti-Codex`, executable metadata `Anti-Codex`, eight models, MCP/skills, plugin capability grading, diagnostics, UI state, tool loop, and account/proxy readiness.
- Completed current checks: local projection home priority and richer duplicate metadata are covered by regression tests and installed capability proof; latest installed capability counts are 178 plugins, 69 skill-bearing plugins, 151 app-bound plugins, 3 MCP-declaring plugins, and 1494 connectors.
- Completed current checks: installed MCP/skills verification now fails if `skills` is a junction/symlink. The installed runtime was converted to a local skills copy and passed with `skills.linkType:null`, 50 sampled skills, three MCP servers, and plugin capability counts unchanged.
- Completed current checks: after deploying the no-global-write startup path, a translator-only installed restart left `%USERPROFILE%\.codex\config.toml` length and `LastWriteTime` unchanged while Anti-Codex health and the installed overall verifier both passed.
- Completed current checks: installed overall verification now includes `test-anticodex-runtime-config.ps1`, proving Anti-Codex's isolated runtime config points to the local gateway/model catalog, uses file auth, and keeps Responses WebSocket plus remote plugin features disabled.
- Completed current checks: translator-only recovery now loads the cached/generated Antigravity model catalog before starting the gateway. Installed `/models` and diagnostics report the eight real account-visible models immediately after a recovery restart.
- Completed current checks: account-verification failures from Antigravity Desktop are now explicit and non-retryable. Installed account/proxy readiness reports `account_verification_required` for the observed `PERMISSION_DENIED (code 403): Verify your account to continue` path, instead of treating it as a proxy or transient failure.
- Completed current checks: translator diagnostics now infer the Anti-Codex state root from the local Codex home when needed, so update status, response history, and model-route audit remain stable after direct translator-only restarts.
- Completed current checks: Antigravity traffic health now has race-safe failure persistence. A queued success that started before a later failure cannot clear the later failure state; only a newer successful request can restore `accountTrafficReady:true`.
- Completed current checks: Antigravity account-traffic status is now source-gated. Generic local errors such as invalid JSON do not overwrite account/proxy diagnostics; only Antigravity/Cascade/account/proxy-looking failures are recorded as Antigravity traffic state.
- Completed current checks: Manager status now shows distinct actions for account verification, unavailable Antigravity Desktop/account state, and retryable transient/proxy failures.
- Verified: focused translator/launcher regressions passed with 254/254 tests, parser checks passed, installed no-traffic overall passed with eight models and no login/reconnect UI text, and installed health shows `accountReady:true` plus `accountTrafficReady:false/account_verification_required`.
- Next required real-traffic gate: after the user completes the Antigravity Desktop verification prompt, rerun account/proxy readiness, real two-turn tool loop, native tool loop, full model routing, and then full installed overall without `-NoTraffic`.
- Completed current checks: the installed Manager now includes `Full Check After Verify`. It waits for the real account/proxy verifier to report `ready`, optionally opens Antigravity Desktop for verification, then runs the full installed real-traffic suite. It records a bounded report and never treats the no-traffic suite as proof of real model readiness.
- Verified: the new post-verification script correctly stops with `account_verification_required` while the external Antigravity block remains, launcher regression passed 65/65, installed scripts parse, and installed no-traffic overall still passes.
- Completed current checks: app tools are now explicitly graded as a capability boundary. `appToolCount=0` is valid when `accessibleConnectorCount=0`, and the verifier fails only if accessible connectors exist but no tools are exposed.
- Completed current checks: `/backend-api/wham/apps` now keeps directory apps visible but filters tool entries to `isAccessible:true` connector IDs only, preventing cached but unauthorized app tools from entering the Codex tool surface.
- Completed current checks: Responses WebSocket fallback now covers real Upgrade requests, not only HTTP prewarm. Installed `Check Anti-Codex` includes a TCP Upgrade probe and passed with explicit `501 unsupported_websocket`.
- Completed current checks: installed local-snapshot verification now proves `skills`, `cache\codex_app_directory`, and `cache\codex_apps_tools` are Anti-Codex local copies. Latest installed overall passed with `connectorDirectory` local, `cacheLinkType:null`, `cacheFileCount:23`, 1494 connectors, 178 plugins, three MCP servers, eight models, no login/reconnect UI text, and taskbar/window branding as `Anti-Codex`.
- Completed current checks: the Manager now has explicit `Check MCP/Skills`, `Check Plugins/Apps`, and `Refresh MCP/Skills` actions. `Refresh MCP/Skills` updates shared MCP config blocks plus local Skills/plugin/cache snapshots, then restores Anti-Codex safety flags so ChatGPT login, remote plugins, and Responses WebSocket remain disabled.
- Completed current checks: local projection now reads connector directory and app-tool cache from the first available snapshot home only. When Anti-Codex has a local snapshot, shared original Codex connector/app-tool caches are no longer mixed into runtime responses; installed overall passed after deploying this projection tightening.
- Completed current checks: installed overall now includes a read-only independence audit. Latest installed run passed with required local snapshots present and not linked, and `remainingSharedLinks:[]` on the current machine.
- Completed current checks: mixed Cascade trajectory selection now avoids stale Antigravity readiness/welcome replies by preferring current prompt markers and skipping readiness boilerplate when a better completed planner response exists.
- Completed current checks: the installed UI exposes exactly the eight desktop-menu models with their live Antigravity display names; internal-only model entries are excluded from the readiness count.
- Completed current checks: five real Chinese requests across multiple readiness cycles completed with stable translator PID, stable health, and no new watchdog restart.
- Completed current checks: Codex 26.609 window creation is patched at both the BrowserWindow fallback and primary-window call site, and Windows reports the real taskbar title as `Anti-Codex`.

## Completion Criteria
- No recurring "reconnecting" state during normal idle or use.
- Installed Anti-Codex shows the current account's exact model names.
- A selected model ID is visible in gateway logs and reaches Antigravity unchanged.
- Tool calls, MCP calls, skills, cancellation, compaction, session resume, and streaming use native Codex contracts rather than prompt simulation.
- Any capability that cannot be implemented natively is visibly disabled and documented, not silently faked.
- Original Codex remains usable and unchanged.
- All protocol tests pass and the installed application passes failure-recovery checks.

## Errors Encountered
- 2026-06-20: the first UI-state test patch assumed an inline `const managerPage` declaration; the file declares it earlier and assigns later. The patch was rejected with no partial edit, then split against the exact assignment site.
- 2026-06-20: a combined PowerShell/regex source search failed because an embedded quote terminated the command string. No files changed; subsequent searches use separate simple patterns instead of one quoted alternation.
- Responses websocket native transport remains intentionally disabled; the installed client is configured to use HTTP and currently shows no reconnect loop. Real WebSocket Upgrade requests are now explicitly rejected with verified `501 unsupported_websocket` instead of falling through default socket handling.
- Remote plugin marketplace support remains disabled; local skills and MCP inheritance are available.
- Remote app connector linking is not yet available without ChatGPT account flow; cached connector directory entries can be displayed/graded, but `isAccessible:false` means they must not be advertised as already usable.
- Historical boundary resolved again: verified native MCP was demoted from default to opt-in because Antigravity's native permission UI is hostile to the intended Anti-Codex experience. The Codex-owned prompt-mediated bridge is the stable default until the native event protocol can be used without Antigravity approval prompts.
- Antigravity's public Python SDK cannot become the primary transport because it requires a Gemini API key or Vertex credentials instead of using the signed-in Antigravity account allowance.
- Desktop Cascade exposes internal structured tool types, but arbitrary custom tool definitions are gated to SDK executables and are not accepted from the ordinary account-backed Cascade client path.
- Antigravity CLI/SQLite remains emergency fallback only; the default execution path is the desktop Cascade service.
- Actual account switching and a real external proxy-off drill require the user's signed-in account/proxy controls; the one-click refresh path, transient proxy/network recovery behavior, and installed account/proxy diagnostic evidence collector are implemented.
- The circuit breaker covers repeated transient failures, and the account/proxy readiness verifier now classifies the observed failure type; a real proxy-off/on drill is still the only way to observe the exact errors produced by the user's proxy stack.
- Antigravity CLI worker and DeepSeek worker remain useful for narrow assistance, but their edits must be treated as untrusted; this run had one Antigravity worker failure and one DeepSeek scope overrun that required main-agent cleanup/review.
- Added `test-anticodex-sync-readiness.ps1` as a read-only installed sync readiness verifier. Checks sync entry, host candidate validator, active/rollback markers, maintenance marker absence, and `Anti-Codex.exe` identity without executing sync or modifying the host. Included in installed overall check. Removed duplicate `$checks.toolBridgeMode` line.
- Added `test-anticodex-mcp-tool-loop.ps1` as an installed MCP namespace tool-loop verifier. Uses namespace `mcp__node_repl__` + subtool `js`, verifies reverse-mapping of flattened `mcp__node_repl__js` back to `js` in `function_call`, and proves `function_call_output` continuation without duplicate invocation. No real MCP tools are executed; only Responses protocol output is inspected. Included in installed overall check as `$checks.mcpToolLoop`. Static regression added to launcher test suite.
- Added `test-anticodex-custom-tool-loop.ps1` as an installed custom/freeform tool-loop verifier. Uses `apply_patch` custom tool with `type="custom"` and grammar metadata (`syntax="lark"`), verifies bridge returns `custom_tool_call` with name=apply_patch and input equal to the full patch body (with `*** Begin Patch`/`*** End Patch` markers), and proves `custom_tool_call_output` continuation without duplicate invocation. No real patches are executed; only Responses protocol output is inspected. Included in installed overall check as `$checks.customToolLoop`. Static regression added to launcher test suite. Latest installed overall passed with `customToolLoop.ok:true`.
- Model display names now preserve exact model/version numbers and use explicit public model-ID reasoning suffixes as the authority. The catalog, native Cascade resolver, and route audits all normalize mismatched names. Installed full-model routing now fails on reasoning-label drift and passed all eight visible models after deployment.
- Installed overall now includes non-streaming and streaming parallel multi-tool loop verifiers. Both require exactly two calls, unique call IDs, preserved arguments, reverse-order result continuation, no duplicate calls, and no prompt-protocol leakage. The streaming verifier additionally requires SSE output-item calls to match the completed response by name and call ID.
- Completed current checks: one-click sync now uses a hash-bound manifest, rejects stale or mismatched candidates, and passed a forced critical-patch failure drill without changing the active host.
- Completed current checks: restart-refresh fallback forces live account model discovery and passed an installed forced-fallback recovery drill with eight models and original Codex isolation.
- Completed current checks: all operation and verification entry points resolve the current Anti-Codex local gateway dynamically; no script retains the old pinned `192.168.1.2:8484` default.
- Completed current checks: failed translator watchdog restarts use a 30-second cooldown; installed translator recovery and cold relaunch passed after deployment.
- Completed current checks: Manager MCP/Skill and plugin/app buttons are now verified through the real embedded panel after waiting for the visible Anti-Codex page context and rendered action buttons. Latest installed no-traffic overall passed with `managerButtonMcpSkills.ok:true`, `managerButtonPluginCapabilities.ok:true`, eight visible models, no login/reconnect text, and original Codex isolation.
- Completed current checks: the in-app Manager `Fast Check (No Traffic)` action passed from the real embedded panel in about 19.4 seconds, giving a practical daily health-check path that does not consume Antigravity model traffic.
- Completed current checks: a 60-second installed idle-stability run passed with five samples, stable Anti-Codex main PID, stable translator PID, no reconnect text, no ChatGPT login text, and the selected Antigravity model label still visible.
- Completed current checks: fast installed overall reports are now separated from full installed overall evidence. A deployed fast run returned `reportName:"installed-overall-fast"` in about 20.4 seconds, created `latest-installed-overall-fast.json`, and left the existing `latest-installed-overall.json` SHA-256 unchanged.
- Completed current checks: diagnostic bundles now include both full and fast installed-overall summaries. A deployed diagnostic bundle was generated successfully and its `reports-summary.json` contained both `latest-installed-overall.json` and `latest-installed-overall-fast.json`.

## Latest Completion Audit - 2026-06-14
- Completed: translator-owned Antigravity web fetch/search capability, deterministic explicit URL fetch, real installed web verifier, prompt scoping, compaction recall fallback, log-lock-safe translator recovery, desktop helper cleanup, and installed runtime-config verification for WebSocket/plugin/account-flow guardrails.
- Verified: focused launcher/local-access regression passed, runtime config verifier passed, and installed overall verifier passed after relaunching the installed Anti-Codex gateway.
- Completed: compaction direct-resume now treats pseudo `<tool_call>` output and "missing/unavailable tool" detours as invalid recall answers, replacing them with the saved context summary before UI exposure.
- Verified: 188 focused translator/launcher/local-access tests passed, installed compaction-resume verifier passed, and installed overall verifier passed with eight models, Anti-Codex taskbar/window branding, no ChatGPT login text, no reconnect text, MCP/skills inheritance, and original Codex isolation.
- Completed: long-term Codex host update access no longer depends on remembering scripts. The installer now creates a Start Menu `Anti-Codex` folder with the main launcher plus `Sync Anti-Codex with Codex`, while keeping the desktop surface to one main shortcut.
- Verified: focused launcher/local-access tests passed, sync readiness proved the Start Menu sync shortcut targets the guarded launcher, desktop inspection still shows only `Anti-Codex.lnk`, and installed overall passed after deployment.
- Completed: installed UI idle-stability is now a default verification gate. It distinguishes "app is closed" from "UI is reconnecting", checks the real page text repeatedly, and proves both the Anti-Codex host and local translator process stay stable during idle.
- Verified: after relaunch, the installed idle verifier passed a 20-second four-sample run with no reconnect/login text and stable PIDs; the installed overall verifier passed with the new idle-stability check included.
- Completed: Responses WebSocket fallback is now observable, not only rejected. The translator diagnostics expose `responsesWebSocket` with support state, fallback type/status, attempt count, and the latest Upgrade/prewarm metadata.
- Verified: focused local-access/launcher tests passed, the installed WebSocket verifier proved `lastUpgrade` for `/v1/responses`, and installed overall passed after deploying and restarting only the translator.
- Completed: native Antigravity tool capability is now explicitly bounded in diagnostics. Anti-Codex proves the current desktop Cascade envelope has model selection and Antigravity-owned tool disablement, but no verified arbitrary external tool schema field or native tool event stream.
- Completed: compaction recall now rejects partial recall that keeps only the marker but drops the required next action.
- Verified: focused Antigravity agent API, local-access, launcher, and compaction regression tests passed; installed tool-bridge verifier passed; installed compaction-resume verifier passed; installed overall passed after deploying and restarting only the translator.
- Completed: translator-only recovery now self-selects Anti-Codex's installed 8484/private-address endpoint when invoked directly from the installed runtime, not only through the outer launcher wrapper.
- Verified: focused launcher tests passed, installed translator recovery passed, runtime config passed, and installed overall passed with stable UI, translator PID, model catalog, and original Codex isolation.
- Completed: installed WebSocket protocol audit now scans the copied Codex `app.asar` and separates app-server WebSocket, dictation WebSocket, feature-gate flags, and `/codex/responses` HTTP/SSE evidence.
- Verified: focused audit passed against the installed host and is now part of installed overall. Current result: no native model Responses WebSocket evidence, so the fallback remains explicit and intentional.
- Verified: installed overall passed after deploying the audit and fixing direct invocation of the overall script's dynamic gateway resolver.
- Completed: live native-tool schema probe now distinguishes HTTP acceptance from usable native tool events. Current desktop Cascade accepts several schema-like fields without rejection, but trajectory summaries show no native tool-event steps.
- Verified: installed tool-bridge verifier passed with the refined diagnostics, the live schema probe passed with `nativeToolEventEvidence:false`, and installed overall passed after restarting the translator.
- Remaining non-native boundary: Responses WebSocket remains an explicit verified `501` fallback. Antigravity native MCP same-Cascade continuation is verified but opt-in only; default tool handling stays on the Codex-owned prompt-mediated bridge.
- Completed: bounded three-attempt transient recovery was deployed and the installed overall verifier passed in about 103 seconds with no reconnect/login text, stable UI/translator PIDs, all tool-loop variants, compaction, cancellation, MCP/skills, eight live models, and original Codex isolation.
- Completed: privacy-safe retry observability is available through local diagnostics. It exposes coarse retry metadata without prompts, messages, input items, responses, or tool outputs; the final installed overall verifier passed in about 109 seconds with zero retries observed.
- Completed: startup now detects when installed Codex has changed and offers a one-click guarded sync. Normal launches reuse a version-bound cached result, while sync readiness and diagnostics expose whether an update is required.
- Completed: host candidates are bound to the source Codex package version and source host/CLI fingerprints. A real sync activated the new manifest, retained rollback, reopened Anti-Codex, and passed the post-sync installed overall verifier.
- Completed: guarded host candidate construction now survives the current Codex WindowsApps package's unreadable phantom directory and protected top-level DLL behavior without weakening copy failure handling.
- Completed: sync transaction safety is independently proven. The forced-failure drill reached the requested critical patch failure and verified the active Anti-Codex host and marker stayed unchanged.
- Completed: current Antigravity account/proxy and real traffic are ready. Full installed verification passed with all major Codex-facing behavior and native tool/MCP paths green.
- Completed: final three-minute installed stability soak passed with stable translator PID, 33 health checks, Chinese/long-context/tool/stream/cancel coverage, and no failures.

## Latest Native Tool Audit - 2026-06-15
- Completed: discovered and verified the account-backed desktop Cascade native MCP customization channel at `StartCascade.customAgentSpec.customizationConfig.customizationServerUrl`.
- Completed: Antigravity now receives Codex function schemas through a local MCP server and emits real structured `CORTEX_STEP_TYPE_MCP_TOOL` waiting events. Anti-Codex returns those calls to Codex using Antigravity-generated call IDs instead of `pseudo_` IDs.
- Completed: non-streaming and streaming entry points default to the Codex-owned prompt-mediated bridge. Live native protocol probing remains documented and covered by opt-in scripts, but it must not run in the normal installed overall gate unless the runtime was explicitly started with `ANTICODEX_NATIVE_TOOL_BRIDGE=1`.
- Completed: Antigravity's duplicate MCP permission wait is bypassed by returning the structured waiting event to Codex and cancelling that Cascade; Codex remains the approval and execution authority.
- Completed: because the Antigravity permission boundary exposes one waiting native call at a time, multi-tool work is verified as stable serialized native calls rather than fake same-response parallel calls.
- Verified: native single-tool loop returned call ID `9wfg8wkd`; native serialized multi-tool loop returned distinct call IDs `81yenywi` and `xm8a3w4x`; both continuations completed successfully.
- Verified: full translator regression passed with 412 tests, 378 passed, 34 skipped, 0 failed.
- Verified: installed overall passed in about 112 seconds with native single/multi-tool calls, MCP, skills, plugins, eight models, account/proxy readiness, cancellation, compaction, stable UI, no login/reconnect text, Anti-Codex branding, and original Codex isolation.
- Remaining explicit boundary: Responses WebSocket is still a verified `501 unsupported_websocket` fallback. Native Antigravity tool-result injection is opt-in only; the default bridge keeps tool execution and permission handling on the Anti-Codex/Codex side.

## Final Reliability Closure - 2026-06-16
- Completed: default install entry and documentation now describe and install Anti-Codex, not legacy DeepCodex.
- Completed: account switching no longer claims success unless an account identity/catalog change is observable; maintenance checks can explicitly allow an unchanged identity.
- Completed: real rollback now has a post-start health gate and automatic recovery to the prior active host if the rolled-back host cannot become ready.
- Verified: real rollback, real guarded sync, installed overall real-traffic verification, all-eight-model live routing, and a final three-minute stability soak all passed.
- Verified: source regression passed with 435 tests, 401 passed, 34 skipped, and 0 failed.
- Explicit external/manual boundaries: changing to a different Antigravity account and deliberately breaking/restoring Antigravity's external proxy still require user interaction. The guided workflows and diagnostics for both are implemented.
- Completed current checks: user-provided pink Codex cloud icon has been deployed through the guarded host sync, not only copied into assets. Active host, rollback host, desktop shortcut, and Start Menu shortcuts now validate against the same installed `resources\icon.ico`.
- Completed current checks: installed account/proxy readiness now distinguishes cached model-catalog availability from live Antigravity account traffic. With the current external failure it reports `proxy_or_network_transient / antigravity_oauth_network_failure`, while the no-traffic UI/model/plugin/MCP checks continue to pass.
- Next required real-traffic gate: after Antigravity Desktop can reach Google account services through its proxy again, rerun account/proxy readiness without `-AllowUnready`, full model routing, tool/MCP/custom/native checks, installed overall without `-NoTraffic`, and a stability soak.
- Current status: no-traffic Anti-Codex product surface is verified and usable; real Antigravity traffic is not verified because the live Desktop account path is returning account/no-model or OAuth/proxy failures. Do not claim final real-traffic completion until the external Antigravity account/proxy path is green again.
- Completed current checks: the in-app Manager now raises a clickable main-window notice for Antigravity quota, verification, account-unavailable, and retryable proxy states. The notice is removed automatically when traffic health recovers and never redirects to ChatGPT login.
- Completed current checks: Manager endpoint reads now prefer the live local gateway and use the bridge snapshot only as an outage fallback. Installed UI verification on `native-panel-v39` showed both fast and full installed-check reports instead of stale `no record` values.
- Completed current checks: the in-app account-switch action now captures an anonymous account/model baseline, opens Antigravity Desktop, watches for up to two minutes, and automatically refreshes Anti-Codex models only after a provable account fingerprint or model-ID-set change. Installed `native-panel-v40` validation kept all 14 actions, eight models, and the embedded close interaction healthy.
- Completed current checks: the main in-app Manager button now reflects guarded Codex update status. Its priority is account quota `限额`, then host update `更新`, then normal `管理`; installed `native-panel-v41` validation correctly remained on `管理` because source Codex and Anti-Codex are currently synchronized.
- Completed source work: Manager `native-panel-v45` now cancels account-switch observation immediately when the embedded Manager closes, reads app-tool capability live through the local GET-compatible wham endpoint, and labels plugin capability as local directly usable Skill/MCP versus remote connector directory visibility.
- Completed installed check: v45 runtime was deployed and verified after restarting only the local translator. The in-app Manager is embedded, not a separate page; it shows no endpoint fetch failure, no ChatGPT login/reconnect text, exact eight-model catalog, local Skill/MCP counts, and the current Anti-Codex host is synced with Codex package `26.616.3309.0` / `codex-cli 0.142.0-alpha.1`.
- Completed current checks: installed overall verification now has bounded per-subcheck timeouts, so a stuck child verifier reports a clear timeout instead of making the whole command look frozen. Deployed runtime passed fast no-traffic overall in about 19.1 seconds.
- Completed current checks: the right-bottom tray icon is restored to the pink Anti-Codex icon and protected against future Codex sync overwrite through `resources\codex-tray.ico` hashes and palette checks on active and rollback hosts.
- Completed current checks: Manager `native-panel-v50` is deployed. The embedded panel no longer exposes `Failed to fetch` for optional app-tool status, still reports 0 real callable app tools when connectors are unauthorized, and installed UI verification passes with no login/reconnect text.
- Completed current checks: installed UI state verification now retries the embedded Manager probe and reports a clear probe error instead of treating a first CDP empty read as a reconnect/product failure. The installed fast no-traffic overall check with `-EnsureRunning` passed in about 18.4 seconds and refreshed Manager's last fast-check status to passed.
- Completed current checks: Manager button verification now serializes concurrent probes and waits for the requested action result with an empty queue, preventing MCP/Skill and plugin/application smoke checks from racing on the shared embedded panel. The installed full no-traffic overall check passed in about 68.9 seconds with both button checks, UI idle stability, sync readiness, exact eight-model catalog, and pink icon palette checks green.
- Completed current checks: Manager `native-panel-v50` now adds an explicit plugin/application explanation: local plugin/MCP features are directly usable, while remote connectors are directory-visible only and are not presented as callable tools unless authorized. Installed UI state and sync readiness both passed after deployment.
- Completed current checks: Manager `native-panel-v50` also makes account/proxy notices actionable. The notice now has separate in-window actions for opening Manager and re-running the account/proxy check, without opening ChatGPT login or an external web page. Installed UI state, sync readiness, and fast no-traffic overall all passed after deployment.
- Completed current checks: Manager `native-panel-v50` now shows elapsed time and staged progress text while long actions run, including fast/full no-traffic checks, sync readiness, guarded host sync, account/proxy diagnostics, and real post-verification. Installed UI state passed, the real MCP/Skill button smoke showed the new `已用时/阶段` running text, sync readiness passed, and fast no-traffic overall passed in about 19.1 seconds.
- Completed current checks: Manager `native-panel-v50` now writes clearer completed-action summaries for fast/full no-traffic checks and diagnostics, including the evidence name, latest report path, history report path, and first failure items. The installed Manager fast-check button showed `installed-overall-fast`, latest/history report paths, staged running text, and completed in about 16.7 seconds.
- Completed current checks: Manager-triggered fast/full overall checks now pass `-SkipUiStateProbe` so the embedded Manager does not recursively reopen and test itself while an action is already running. External fast no-traffic overall still performs the normal UI-state check and passed in about 19.7 seconds.
- Completed current checks: the backend `/anticodex/manager` page now uses the same report/failure summary helpers as the injected Manager and bridge, so fast/full no-traffic and diagnostic results stay consistent across all Manager entry points. Installed UI state passed, the backend page exposes the helper functions, and the real Manager fast-check button passed in about 15.4 seconds with latest/history report paths.
- Completed current checks: fixed the embedded Manager auto-close regression. Root cause was the CDP manager watcher reinstall path removing `#anticodex-manager-overlay` before each repeated manager injection; manager reinjection is now idempotent and the opener no longer removes an already-open overlay. Runtime was redeployed and the watcher restarted. Verified with real CDP click: panel stayed open after 2.6s with no overlay-remove logs; close button hit area closed correctly; reopen stayed stable. Source tests passed, Manager button verifier passed, and installed UI state passed on `native-panel-v51`.
- Completed current checks: Manager script version was bumped to `native-panel-v51` so the current window cannot silently keep the old v50 injected code after a runtime file update. Runtime v51 injection was verified in the live Anti-Codex page, with overlay/button both reporting v51.
- Completed current checks: UI state verification now shares the same `anticodex-manager-button.lock` as the Manager button verifier. A deliberate parallel run of UI-state plus Manager-button verification passed, proving embedded Manager probes no longer race each other on the shared panel.
- Completed current checks: refreshed installed fast no-traffic overall after v51 and verifier-lock deployment. The run passed in about 18.7 seconds with Manager `native-panel-v51`, eight visible models, no ChatGPT login/reconnect text, pink icon checks green, local Skill/MCP inheritance visible, and original Codex still running separately.
- Completed current checks: Manager `native-panel-v53` now prevents duplicate submission of the same pending background action and no longer lets stale `运行失败：Anti-Codex manager bridge timed out` summaries occupy the panel after state recovery. Targeted CDP checks proved duplicate `updateCheck` clicks do not increase queue/pending counts, and stale failure state is overwritten by fresh status on reopen. Installed UI state and fast no-traffic overall passed after deployment; fast overall completed in about 17.6 seconds.
- Completed current checks: refreshed the full installed no-traffic overall gate after v53 deployment. It passed in about 85.6 seconds with no failure items, keeping `latest-installed-overall.json` as the release-grade evidence while the separate fast gate remains in `latest-installed-overall-fast.json`.
- Completed current checks: core JSON report writers now use explicit UTF-8 without BOM for Node compatibility. Updated the installed runtime scripts for installed overall, model routing, sync readiness, tool bridge mode, UI idle stability, post-verification, and diagnostic bundles. Source parser checks passed, the focused launcher regression passed 73/73, installed fast no-traffic overall passed in about 20.2 seconds, and freshly written reports parsed directly with Node with `bom:false`.
- Completed current checks: refreshed the real account/proxy readiness gate. It passed in about 2.1 seconds with signed-in Antigravity account, plan `Pro / Google AI Pro`, local proxy bypass confirmed, eight models visible, real marker response returned through `gemini-3.5-flash-low`, model-route audit updated, and `/health` now reports `accountTrafficReady:true`.
- Completed current checks: refreshed full real model routing across all eight visible models. The run passed in about 24.9 seconds and proved exact requested/resolved model pairs for Gemini 3.5 Flash Low/High/Extra Low, Gemini 3.1 Pro Low/High, Claude Sonnet 4.6 Thinking, Claude Opus 4.6 Thinking, and GPT-OSS 120B Medium, with Antigravity internal model IDs recorded in the route audit.
- Completed current checks: refreshed real Codex-owned tool loops. The basic tool loop passed in about 3.4 seconds, and the MCP `node_repl` tool loop passed in about 8.8 seconds, proving Anti-Codex can keep tool execution on the Codex side while Antigravity supplies the model reasoning.
- Completed current checks: fixed and redeployed compaction-resume guardrails after the installed verifier caught a real schedule-detour hallucination. The guard now reads next-line `Continuation Instruction` / `Next Steps` terms from context compaction summaries, rejects restored answers that keep the marker but translate/drop the exact next action, and replaces them with deterministic compacted context. Focused compaction tests passed, the installed translator was restarted, and installed compaction resume passed in about 28.4 seconds with `bom:false` report output.
- Completed current checks: after the translator restart, installed fast no-traffic overall passed again in about 19.2 seconds. The live embedded Manager still reports `native-panel-v53`, traffic `已就绪`, eight exact model labels, no ChatGPT login/reconnect text, local Skill 100 / MCP 3, and no fake callable remote connectors.
## 2026-06-19 JSON Evidence Encoding Closure
- Completed current checks: extended UTF-8-without-BOM coverage to installed tool-loop, MCP tool-loop, custom/parallel/native/web/cancellation verifiers, account-switch/proxy-drill reports, cold-relaunch progress, update-status, update-prompt, and install/sync manifests.
- Verification: focused launcher regression passed 74/74; installed tool loop and MCP tool loop both passed with freshly written `bom:false` reports; installed update check wrote `update-status.json` with `bom:false`; installed sync readiness passed against Codex package `26.616.4196.0`.
- Completed current checks: the installed fast no-traffic overall verifier now audits report encoding. Reports written during the current run must be parseable UTF-8 without BOM; older evidence is reported separately so legacy files cannot create false daily failures.
- Migration and verification: 439 legacy BOM reports were normalized without changing JSON content. The report directory now has 469 parseable JSON files, zero BOM files, and zero invalid files. Installed fast overall passed in about 20.8 seconds with `reportEncoding.ok:true`, no failures, and no legacy issues.

## 2026-06-19 Native Tool Default Closure
- Completed: moved automatic MCP permission handling from the continuation phase to the first structured waiting event. The native `tools/call` request is captured before Codex execution, and the continuation only completes that already-approved MCP call with the Codex result.
- Completed: native MCP is enabled by default in both source and the installed launcher. An explicit `ANTICODEX_NATIVE_TOOL_BRIDGE=0` opt-out remains available.
- Completed: native-protocol failures before any Codex-visible event fall back once to the prompt-mediated compatibility bridge. Account verification, quota, proxy, and network failures are not misclassified as native-protocol fallback.
- Source verification: full translator regression passed with 491 total tests, 457 passed, 34 skipped, and 0 failed. Changed PowerShell scripts parsed as UTF-8 and `git diff --check` passed.
- Installed verification: translator-only recovery passed without modifying the original Codex config; diagnostics reports eight models and the native default; the single native tool loop passed in 6.4 seconds; the serialized two-tool loop passed in 10.5 seconds; sync readiness and real UI state both passed with no ChatGPT login/reconnect text.
- Verification note: the monolithic no-traffic overall command exceeded the 30-second interactive limit and was stopped. Its constituent diagnostics, sync-readiness, UI-state, translator-recovery, and native live-tool checks were run separately and passed.

## 2026-06-19 Native Thinking Budget Closure
- Protocol evidence: the installed Antigravity language server exposes model metadata fields `supportsThinking`, `thinkingBudget`, and `minThinkingBudget`. `CascadePlannerConfig` does not expose a verified generic reasoning-level field, so Anti-Codex does not invent one.
- Completed: generated model-catalog entries retain native thinking support, budget, minimum budget, and a budget-backed reasoning description while preserving the exact account-visible model ID and display name.
- Completed: `/models` exposes `reasoning_level`, `supports_thinking`, `thinking_budget`, and `min_thinking_budget` as additional local metadata. Codex-compatible model identity fields remain unchanged.
- Completed: Manager `native-panel-v54` displays native thinking budgets for all eight visible models. Installed UI verification requires that budget text and still checks exact model labels, close-button behavior, no ChatGPT login, and no reconnect text.
- Installed evidence: Gemini 3.5 Flash Low/High/Extra Low report budgets 4000/10000/1000; Gemini 3.1 Pro Low/High report 1001/10001; Claude Sonnet/Opus Thinking report 1024; GPT-OSS Medium reports 8192. A live High request preserved `gemini-pro-agent` and routed to internal model `MODEL_PLACEHOLDER_M16`.
- Source verification after this batch: 492 translator tests total, 458 passed, 34 skipped, 0 failed. Installed translator recovery, model refresh, sync readiness, and UI state all passed.

## 2026-06-20 Native Thinking Budget Regression Gate
- Completed: added a dedicated no-traffic installed verifier for all eight exact Antigravity model IDs, display names, reasoning labels, thinking support flags, native thinking budgets, and Gemini minimum budgets.
- Completed: the fast installed overall gate now runs this verifier, so a future Codex host sync cannot silently drop or cross-wire model thinking metadata.
- Completed: sync readiness now requires the dedicated verifier to be present in the installed runtime, preventing an incomplete package from entering the guarded update flow.
- Verification: the dedicated installed check passed in about 0.2 seconds with eight exact models; the fast no-traffic overall check passed with `modelThinking.ok:true`; sync readiness passed with no update required; full source regression passed with 493 total tests, 459 passed, 34 skipped, and 0 failed.

## 2026-06-20 Account Traffic Notice Stability
- Completed: Manager `native-panel-v56` keeps the existing in-app quota/account/proxy alert during a transient `/health` read failure instead of treating missing health data as recovery.
- Completed: the alert now has an explicit close action. Dismissal is bound to the current traffic-state signature and failure timestamp, so the same failure does not reappear every 30 seconds while a later failure is still shown.
- Completed: confirmed healthy traffic clears the dismissal signature, allowing a future quota/account/proxy failure to notify again. The alert still links to embedded Manager and the account/proxy recheck action.
- Verification: focused test passed after a deliberate RED failure; full source regression remained 493 total, 459 passed, 34 skipped, 0 failed; installed UI reports `native-panel-v56` with eight models; sync readiness and fast no-traffic overall both passed with no failures.

## 2026-06-20 Guarded Sync Acceptance Gate
- Completed: a copied Codex host is no longer declared successful merely because its process and local gateway started. After startup, the sync transaction runs the installed fast no-traffic overall verifier with real UI coverage, exact models/thinking budgets, branding, auth isolation, native tool mode, Skill/MCP snapshots, diagnostics, and local plugin capability checks.
- Completed: account/proxy traffic probing is excluded from this acceptance gate, so a valid host update does not consume Antigravity model traffic or fail only because Google access is temporarily unavailable.
- Completed: a non-zero verifier result or 35-second timeout automatically invokes the existing rollback path. The host-sync mutex remains held through acceptance and rollback, preventing a second update transaction from interleaving.
- Fixed: Windows PowerShell can return a null child `ExitCode` unless the process handle is captured before exit. The acceptance runner now retains the handle before its bounded wait, preventing successful checks from being misclassified as failures.
- Verification: deliberate RED tests covered the missing acceptance gate, mutex lifetime, and process-handle regression; full source regression passed 493 total / 459 passed / 34 skipped / 0 failed. Installed sync readiness passed with no update required, and the exact post-sync child command completed within the bound with exit code 0 and no failures.
- Remaining live boundary: no new Codex host is currently available (`updateNeeded:false`), so candidate activation plus automatic rollback was not re-run against a different real Codex package in this batch. The next actual Codex update will exercise this gate automatically.

## 2026-06-20 Anti-Codex Manager Watcher Stability
- Completed: implemented explicit `--watch` parameter for manager watcher configuration to ensure reliable tracking.
- Completed: added reuse and de-duplication mechanisms to manage watcher instances.
- Completed: implemented bounded exit logic upon disconnection to avoid orphaned watchers.
- Completed: prevented one-shot actions from escalating into persistent resident watchers.
- Completed: updated the idle stability verifier to report manager watcher PIDs, require exactly one official `--watch` manager injector, and fail on legacy no-`--watch` manager injectors.
- Verification: the launcher regression first failed on the missing watcher checks, then passed after implementation; PowerShell parser validation passed for the updated idle stability verifier. The installed runtime copy hash matches source, and the live installed check reported one main process, one translator, one manager watcher, zero legacy watchers, eight models, and no login/reconnect text.

## 2026-06-20 Fast Sync Readiness Parameters
- Fixed: `test-anticodex-sync-readiness.ps1` now has strict PowerShell parameter binding. Unknown switches fail instead of being silently ignored and accidentally running a slow full check.
- Completed: added `-Fast`, `-SkipAccountProxyProbe`, and `-SkipIconPaletteProbe`. Fast mode skips expensive icon pixel scans and reads the cached Codex update status instead of forcing a fresh package fingerprint scan.
- Verification: focused launcher regression first failed on missing strict/fast parameters, then passed after implementation; parser validation passed. The installed runtime copy hash matches source, and installed fast sync readiness passed in about 1.9 seconds with `updateStatusSource:"fast_cached_update_status"`.
- Completed: wired the fast sync readiness path into the user-visible Manager action backend and Start Menu manager status check, so interactive install/sync checks no longer trigger the slow full readiness path by accident.
- Verification: live `/anticodex/manager/action` `syncReadiness` returned in about 3.0 seconds with underlying readiness `fast:true`, `skipAccountProxyProbe:true`, `skipIconPaletteProbe:true`, and cached update status. The real installed Manager button action also passed: it entered busy state, disabled all 14 action buttons, then completed with `安装/同步检查：通过`. The installed UI state verifier then passed with the embedded Manager showing eight exact model labels, no ChatGPT login/reconnect text, close-button hit testing green, plugin/MCP state visible, and no separate Manager page.

## 2026-06-20 UI State Model Evidence Gate
- Fixed: the UI state verifier was reading only the short main-page text for model evidence, so it could falsely fail even when the embedded Manager showed the full eight-model Antigravity catalog.
- Completed: model evidence now combines the visible main page, selected page context, and embedded Manager text before matching current Antigravity model labels/IDs.
- Verification: focused launcher regression first failed on the missing Manager text evidence and then passed 75/75 after the fix. The updated runtime verifier hash matches source, and the installed UI state check passed against the live Anti-Codex window.
- Additional live Manager checks: the installed `updateCheck` action entered busy state and refreshed `update-status.json` to `updateNeeded:false`; `mcpSkills` passed with MCP 3 / Skill 100; `pluginCapabilities` passed with installed plugins 183, connector directory 1494, and the explicit no-fake-callable result for unauthorized remote connectors.

## 2026-06-20 Embedded Manager Action Verification
- Fixed: Manager action verification now uses a real center-point hit test through `elementFromPoint` before dispatching the click. The verifier records `actionCenterHitsButton:true`, so a button cannot pass only because a script called the action function directly.
- Fixed: the UI-state verifier no longer fabricates Manager-overlay success from page text when it cannot open the real embedded panel. Missing close-hit, reopen, action-count, or result evidence now fails instead of being synthesized.
- Fixed: Manager `updateCheck` now uses the extended foreground UI timeout, so the embedded panel shows the final `Codex 更新检查：已是最新` / `发现新版` result instead of prematurely reporting a background submission for normal runs.
- Fixed: Manager and sync-readiness version checks are aligned on `native-panel-v59`; the installed fast sync readiness false-failure from stale `native-panel-v56/v57/v58` assertions is closed.
- Fixed: the Manager button verifier now bounds each CDP status poll by the remaining action deadline, preventing the verifier from silently exceeding the requested timeout by another long page-evaluation wait.
- Verification: source launcher regression passed 75/75; `test-anticodex-manager-button.mjs` syntax and self-test passed; the installed runtime hashes match source for the button verifier and sync readiness verifier. A live installed center-click run against `syncReadiness` completed in about 6.2 seconds with all 14 action buttons disabled while busy and final text `安装/同步检查：通过`.
- Fixed: Manager `native-panel-v59` preserves a timed-out/pending action across close/reopen and updates the currently visible panel when the late bridge result arrives. Internal `refreshStatus` calls no longer overwrite the user-visible late action result.
- Verification: installed UI state passed on `native-panel-v59`; installed pending/reopen simulation passed in about 4.8 seconds, proving center-click action start, pending record, close-button hit area, reopen persistence, single call, and final visible completion text.

## 2026-06-20 Local Snapshot Sync Consistency Hardening
- Completed: `sync-shared-codex-plugin-host.mjs` now tracks shared source content via `computeSnapshotManifest` and writes `.anticodex-source-manifest.json` to each synced directory after a successful transactional swap.
- Completed: `sync-shared-codex-sidecars.mjs` now has equivalent manifest tracking and stale-entry pruning per plugin directory.
- Completed: `pruneStaleManifestEntries` removes entries that were present in the previous source manifest but are no longer in the current source, while preserving local-only entries (not tracked by either manifest).
- Completed: the startup snapshot marker (`writeStartupSnapshotMarker`) now includes `sourceFingerprint` (SHA-256 over sorted source file paths + hashes, 32 hex chars) and `sourceMtimeMax` (ISO date of the newest source mtime), binding the marker to the exact source content for staleness detection.
- Verification: `sync-shared.plugin-host.test.mjs` passed 21/21, covering deleted-source pruning, marker hash/mtime fields, fingerprint stability, and local-only preservation. Updated `anticodex-launcher.test.mjs` with source-code assertions for the new functions.
- Verification: full launcher regression passed 75/75 and `git diff --check` passed for the current Manager/snapshot batch.

## 2026-06-20 Backend Manager Page Action Gate
- Completed: the existing Manager action verifier now checks the actual backend page structure in addition to the action endpoint: `zh-CN`, Chinese no-login/no-traffic notice, result area, all safe `data-action` buttons, click binding, busy disable/re-enable behavior, and absence of iframe/external-window navigation.
- Preserved safety: the verifier does not execute host sync or real-traffic post-verification actions. Its optional live action remains `refreshStatus`, which does not consume Antigravity model traffic.
- Verification: PowerShell parser passed; launcher regression passed 75/75; source and installed runtime hashes match; the installed page exposed 11 actions and passed token, same-origin, JSONP, button-binding, and safe-action checks with no failures.

## 2026-06-20 Manager Entry and Close Hitbox
- Completed: Manager `native-panel-v60` removes the redundant bottom-right floating Manager button. The installed Codex profile/settings menu patch remains the normal user entry and still calls the in-app Manager function.
- Fixed: the close control now uses a rectangular interactive button with a separate rounded visual layer. This preserves the pill appearance while preventing CSS rounded-corner hit clipping.
- Verification: the pre-fix nine-point test reproduced the missed corner; the installed v60 window passed all nine automated samples and all 25 extended live samples. A real upper-edge click closed the panel. Installed UI state and fast sync readiness passed, and the installed host still contains the settings-menu Manager entry.

## 2026-06-20 Native Bridge Restart Inheritance
- Root cause: the running desktop monitor was created while the native bridge default was temporarily `0`. Later translator-only watchdog restarts inherited that stale process value even after source and installed files were updated to default to `1`.
- Fixed: the normal Anti-Codex desktop launcher, Manager gateway-only recovery, and translator recovery verifier now explicitly set `ANTICODEX_NATIVE_TOOL_BRIDGE=1` before starting the translator.
- Regression: launcher coverage now requires all three formal entry paths to preserve the native bridge. The focused launcher suite passed 75/75.
- Installed verification: the old monitor was fully replaced. Diagnostics now reports `native-mcp-same-cascade`, native bridge enabled, native Antigravity tool events enabled, and eight models. UI state, tool-bridge mode, fast sync readiness, and fast installed overall all passed; the final fast overall completed in about 21.7 seconds with no failures.

## 2026-06-20 Manager Codex-Style Redesign
- Status: completed and deployed as `native-panel-v61`.
- Approved direction: replace the engineering-dashboard appearance with a restrained Codex-style embedded surface.
- Action policy: routine read/refresh/check/open actions belong to the neutral first group; restart, host sync, long-running checks, local snapshot writes, and real-traffic actions belong to a muted dark-red second group.
- Preserve the settings/profile entry, remove any floating Manager entry, retain exact action IDs, and keep the verified full close-button hit area.
- Verification: launcher regression passed 75/75; the live installed window exposed 9 daily actions and 5 high-impact actions, all high-impact buttons rendered `rgb(75, 34, 40)`, the close hit grid passed 9/9, the safe `refreshStatus` action returned 200, and fast installed overall passed in 21.35 seconds.

## 2026-06-20 Translator Recovery Verifier Timeout Fix
- Fixed: the translator recovery verifier no longer relies on Windows PowerShell 5.1 `WaitForExit(ms)` for bounded child waits. On this host that call did not return at the requested millisecond deadline, making a healthy recovery look frozen.
- Fixed: the verifier redirects translator-only launcher stdout/stderr to short temp logs and uses `HasExited` polling with a 12-second launcher cap plus a 25-second overall budget.
- Completed: the verifier now reports `totalElapsedMs` and per-phase timings (`launcherElapsedMs`, `healthElapsedMs`, `pluginsElapsedMs`, `whamAppsElapsedMs`) so future stalls show the exact phase.
- Installed verification: the deployed runtime recovery verifier passed in about 9.4 seconds with `accountReady:true`, `modelCount:8`, and `originalCodexConfigUnchanged:true`.
- Installed overall verification: fast no-traffic overall passed in about 24.1 seconds with Manager `native-panel-v63`, eight exact models, no ChatGPT login/reconnect text, and one Anti-Codex translator.

## 2026-06-20 Child Process Timeout Hardening
- Fixed: bounded child-process waits in `start-deepcodex.ps1`, `manage-anticodex.ps1`, `sync-anticodex.ps1`, and `test-anticodex-installed-overall.ps1` now use `HasExited` polling instead of Windows PowerShell 5.1 `WaitForExit(timeout)`.
- Fixed: `manage-anticodex.ps1` is stored as UTF-8 with BOM because it is executed directly by Windows PowerShell 5.1 and contains Chinese UI strings. This prevents the Start Menu manager from parsing mojibake as broken PowerShell syntax.
- Regression: launcher tests now reject the old timeout waits, require the helper polling functions, and require the manager script BOM.
- Verification: full launcher regression passed 75/75; parser checks passed for the updated scripts; installed fast no-traffic overall passed; installed `manage-anticodex.ps1 -Action Status` returned Chinese status with eight models.
- Audit note: Antigravity's narrow documentation task reported exit code 2 but still produced the expected single-file audit at `docs/audits/child-process-timeout-hardening-2026-06-20.md`; the file was reviewed and kept.

## 2026-06-20 Third-Party Upstream V1 Hardening
- Completed: Anti-Codex now supports an optional third-party upstream profile alongside the default Antigravity path. OpenAI-compatible and Anthropic profiles are normalized through `translator/upstream-provider.mjs`; API keys are stored separately through Windows DPAPI and are never written into the JSON profile.
- Completed: switching provider/model preserves the same Anti-Codex state root, CODEX_HOME, project list, and chat history. Provider changes restart only the local model gateway path and do not switch or clear the desktop/session data directory.
- Completed: the Manager's third-party API form invalidates any old connection test when protocol, URL, model, or API key changes. The Save button stays disabled until a fresh successful test.
- Hardened: connection tests now validate real chat response shape, parse model IDs, check streaming response evidence, and force/inspect tool-call responses. Basic chat failure blocks saving; streaming/tool-call gaps are warnings so compatible chat-only providers can still be saved with visible limitations.
- Hardened: saving a third-party profile no longer trusts client-supplied stage results. The server reruns the connection test before saving and stores sanitized connection-stage evidence in the profile capabilities.
- Completed: `/health` now exposes a redacted `upstreamProfile` summary for third-party mode, including protocol/model and saved connection capability evidence. The embedded Manager status card shows that evidence instead of only saying the API is configured.
- Verification: `node --check` passed for `translator/adaptive-server.mjs`, `translator/upstream-provider.mjs`, and `scripts/anticodex-manager-inject.js`; focused regression passed 146/146 across upstream provider, upstream integration, and launcher coverage; PowerShell upstream profile storage tests passed.
- Worker note: two Antigravity CLI attempts for the small Manager invalidation task failed or lost their job result. A later DeepSeek review job incorrectly edited the file despite a read-only task; its final file state was reviewed and covered by the 146-test regression. Future worker assignments for this area should use explicit edit/no-edit enforcement and review diffs before accepting any output.

## 2026-06-20 Local Skill/MCP/Plugin Truth In Prompt
- Completed: the model-facing system block now includes a short Anti-Codex local feature inventory: local Skill count, configured MCP server names, and connector/app snapshot counts.
- Preserved boundary: connector/app snapshots are explicitly described as metadata, not proof that remote app tools are callable. The existing rule remains: do not pretend unauthorized connectors are active tools.
- Verification: adaptive pseudo-tool and internal-tool regression passed 129/129; combined touched regression passed 275/275; upstream profile storage test passed.

## 2026-06-20 Third-Party Upstream Test Action Gate
- Fixed: `/anticodex/upstream-test` now requires the same embedded Manager action token as profile save/apply actions. A local page without the Manager token receives 403 and cannot trigger a saved-key provider probe.
- Fixed: the embedded Manager third-party API test button bootstraps and sends `x-anticodex-manager-token` before calling the test endpoint, so legitimate in-app testing still works.
- Fixed: `/anticodex/manager/bootstrap` and JSONP `/anticodex/manager/action-script` now reject untrusted browser origins/referrers before issuing or honoring Manager action credentials.
- Regression: the integration test first failed with unauthorized test returning 200, then passed after the server and UI fix. Launcher static coverage now rejects future upstream-test handlers or Manager test calls that omit the token.
- Verification: `node --check` passed for `translator/adaptive-server.mjs` and `scripts/anticodex-manager-inject.js`; focused upstream/launcher regression passed 79/79 after deliberate RED failures for unauthorized test/bootstrap/action-script access; combined touched regression passed 275/275.
- Full source verification: `node --test translator/tests/*.test.mjs` initially exposed one stale health-payload assertion; after updating it to verify the new `upstreamProfile` summary explicitly, the full source suite passed 570 total / 536 passed / 34 skipped / 0 failed.

## 2026-06-20 Embedded Third-Party Config UI Gate
- Fixed: the installed UI state verifier now opens the embedded Manager's `upstreamConfig` action and proves the third-party API configuration panel renders inside the same overlay rather than a separate page/iframe.
- Added checks: the panel must show the no-fallback/no-history-loss warning, OpenAI-compatible and Anthropic protocol choices, API key field, test/save/restore controls, and the Save button must remain disabled until a fresh successful connection test.
- Fixed: the UI verifier's expected high-impact action list now includes `upstreamConfig`, matching the Manager source grouping.
- Regression: launcher static coverage now requires the UI verifier to include the third-party config panel checks, not only the Manager shell checks.
- Verification: `node --check scripts/test-anticodex-ui-state.mjs` passed; `node --test translator/tests/anticodex-launcher.test.mjs` passed 77/77; combined local-access/upstream/launcher regression passed 117/117.
- Worker note: Antigravity job `ag-2c8b5848-e6db-43df-82a0-83fd748cb836` failed with exit code 2 and no logs or file changes. The main agent implemented and verified the isolated patch directly; future worker tasks in this area should be even smaller or assigned after source context is prepared.

## 2026-06-20 Plugin Callable Truth Gate
- Added: local projection tests prove `/backend-api/wham/apps` exposes no tools for inaccessible connectors and exposes only tools belonging to accessible connector IDs when the cache contains a mix.
- Added: the installed plugin capability verifier now fails if app tools appear while zero connectors are accessible. This closes the reverse fake-capability case, not only the missing-tools case.
- Preserved: plugin and connector directory metadata remains visible for Codex UI compatibility, but metadata and cache files are not treated as authorization or callable tools.
- Direction: prioritize local Skills, real MCP servers, and genuine authorization-state inheritance. A local allowlist must not synthesize remote connector authorization.
- Verification: focused local-access/launcher regression passed 117/117; PowerShell parser passed for `test-anticodex-plugin-capabilities.ps1`.

## 2026-06-20 Manager Capability Tier Display
- Completed: diagnostics now reports capability tiers for local Skills, MCP configuration, plugin metadata, connector authorization, and callable app tools.
- Performance boundary: plugin/connector projection is scanned only for diagnostics/Manager requests. The per-message system prompt keeps the lightweight local summary and does not rescan plugin caches.
- Fixed: Manager no longer says local plugins/MCP are automatically directly usable. It now says Skills are instructions, MCP callability follows the current session tool list, and plugin/connector metadata is not callable evidence.
- Completed: installed UI verification checks the MCP session-tool boundary and plugin metadata boundary.
- Version: embedded Manager source and open/readiness/UI gates moved from `native-panel-v63` to `native-panel-v65`.
- Verification: deliberate RED tests failed before `capabilityTiers` existed; focused regression passed 236/236 after implementation; full source regression passed 572 total / 538 passed / 34 skipped / 0 failed.

## 2026-06-20 Local Feature Snapshot Freshness
- Completed: diagnostics reads the existing `.anticodex-startup-snapshots-ready.json` contract and reports `fresh`, `stale`, `missing`, or `invalid` with age, maximum age, source mtime, and fingerprint presence.
- Preserved: the maximum age defaults to the same 24-hour contract used by the launcher and honors `ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS`.
- Completed: Manager v65 shows snapshot freshness and tells the user to use the existing `刷新本地功能` action when the marker is stale or missing. It does not auto-refresh or interrupt the current chat.
- Regression: a deterministic temp-home test proves a current marker is fresh and a 48-hour marker is stale.
- Verification: focused local-access/launcher regression passed 118/118; JavaScript syntax and PowerShell parser checks passed.

## 2026-06-20 Persistent Codex Sync State and Manager v66
- Completed: added a shared PowerShell status module with atomic UTF-8 writes, a local writer mutex, legacy-state fallback, operation IDs, timestamps, messages, failure codes, and rollback availability.
- Completed: Codex update checks preserve the newest operation under the writer lock instead of replacing running or terminal state with stale detection data.
- Completed: host sync records candidate build, validation, host stop, activation, feature refresh, restart, acceptance, success, failure, and automatic rollback. Manual rollback records its own validation, activation, restart, acceptance, success, and failure states.
- Completed: embedded Manager `native-panel-v66` displays the real task state, current stage, latest change, and result message. It refreshes the open panel every five seconds without consuming Antigravity model traffic.
- Preserved: no ChatGPT login path, no conversation/history migration, and no install/deploy during this development batch.
- Verification: update-state contracts passed 8/8; focused Manager/launcher/local-access regression passed 124/124; full source regression passed 581 total / 547 passed / 34 skipped / 0 failed. All affected JavaScript syntax and PowerShell parser checks passed.
- Worker process: root `MCP_WORKER_RULES.md` is now mandatory project memory. Every worker or command failure must be classified and recorded before a materially changed retry.

## 2026-06-20 Real MCP Smoke and Shortcut Hardening
- Completed: added a real stdio MCP client and `anticodex-real-mcp-smoke.mjs` so Anti-Codex can prove a configured MCP server actually initializes, lists tools, and executes a tool call.
- Completed: MCP/Skill checks now include a real local `node_repl` call; the MCP tool-loop verifier now feeds the real local MCP result back into the same conversation instead of a synthetic result.
- Completed: sync-readiness now checks Start Menu and desktop launch shortcut targets/arguments, not only icon presence.
- Current installed observation: the desktop shortcut path was correct and launching it brought Anti-Codex up with health `ok:true` and eight models. Remaining installed failures are version/sync drift and stale candidate state, deferred to the later deployment/test pass.
- Verification: focused real-MCP and launcher regression passed 80/80; sync-readiness source coverage passed 77/77; full source regression passed 584 total / 550 passed / 34 skipped / 0 failed. PowerShell parser checks passed for the touched MCP and shortcut-readiness scripts.

## 2026-06-20 Manager v68 Sync Failure Clarity
- Completed: embedded Manager and the fallback bridge now show sync-readiness failure details using the existing failure summary helper. A failed install/sync check now surfaces the first concrete failure items instead of just `安装/同步检查：需要处理`.
- Completed: Manager injection version, opener guard, readiness gate, UI-state verifier, and launcher coverage moved from `native-panel-v67` to `native-panel-v68` so stale windows are rejected.
- Verification: deliberate RED launcher test failed on the old summary contract; after implementation the focused launcher/Manager regression passed 78/78, full source regression passed 584 total / 550 passed / 34 skipped / 0 failed, and syntax/parser checks passed for the touched Manager and readiness files.

## 2026-06-21 Manager v69 Shortcut Repair
- Completed: added `repair-anticodex-shortcuts.ps1`, a local-only repair script that recreates the desktop Anti-Codex shortcut and Start Menu main/sync/rollback/manager shortcuts with the installed runtime scripts and verified Anti-Codex icon paths.
- Completed: added a safe daily Manager action `repairShortcuts` in the embedded Manager, fallback Manager bridge, and backend Manager action router. It does not sync the Codex host, delete recursively, or call Antigravity/model traffic.
- Completed: the fallback Manager page now renders `repairShortcuts` as a normal static daily action instead of inserting it after page load, so source checks and live button binding use the same formal action inventory.
- Completed: shortcut repair now writes `latest-shortcut-repair.json`; diagnostics, the Manager local-check card, and diagnostic bundles expose the latest repair status without touching chat history or consuming model traffic.
- Completed: missing shortcut targets now return and persist a structured failed repair report, so Manager can show the concrete missing files instead of a generic script error.
- Completed: shortcut repair now uses the same spec/evidence shape as sync-readiness: display name, expected script, expected icon, actual target, actual arguments, actual icon, and pass/fail booleans are written into `shortcutEvidence`.
- Completed: the embedded Manager close button is a real 88x48 clickable button body rather than a pseudo-element visual. The verifier checks center and four inner corner hit points, then proves the panel closes and reopens without opening a separate Manager page.
- Completed: the Start Menu manager entry remains bound to the embedded `native-panel-v69` injection path; stale v56/v68 manager references are rejected by launcher coverage.
- Completed: Manager injection version, opener guard, sync-readiness gate, UI-state verifier, and launcher tests moved to `native-panel-v69` so stale v68 panels are rejected.
- Verification: focused launcher regression passed 78/78 after shortcut evidence, close-hit-area, and manager-version hardening; `test-anticodex-manager-button.mjs --self-test` passed; PowerShell parser checks passed for touched Manager/shortcut scripts; full source regression passed 585 total / 551 passed / 34 skipped / 0 failed.
- Worker process: normal subagents successfully completed the shortcut-evidence and close-hit-area slices. DeepSeek docs-only review failed because the dirty worktree confused its policy gate; Antigravity timed out on earlier review tasks and later completed with empty parsed output. All failures are recorded in `MCP_WORKER_RULES.md`; worker-channel repair is separate from product work.

## 2026-06-21 Manager Upstream Config Consistency
- Completed: the fallback `/anticodex/manager` page now exposes `upstreamConfig` in the same high-impact action inventory as the embedded Manager. The fallback bridge no longer silently lacks the third-party API configuration entry.
- Completed: fallback `upstreamConfig` action text tells the user to use the embedded Manager configuration panel, and explicitly preserves the core guarantees: no ChatGPT login, no Antigravity traffic while third-party mode is active, and no chat-history clearing.
- Hardened: launcher coverage now compares embedded and fallback high-impact action inventories, so `upstreamConfig` cannot drift between the two Manager surfaces again.
- Completed: third-party profile save and Antigravity restore are covered as provider switches, not conversation switches. The response-history path, file content, state root, and `previous_response_id` continuity stay unchanged.
- Verification: focused launcher regression passed 78/78; focused upstream/history regression passed 81/81; full source regression passed 585 total / 551 passed / 34 skipped / 0 failed; scoped diff whitespace check passed for the touched files.

## 2026-06-21 Fast Parallel Development Mode
- Current mode: user approved aggressive parallel subagent use. Four independent subagents are running against disjoint areas: plugin/MCP capability truth, embedded Manager UX, shortcut/icon evidence, and update/sync UX.
- Guardrail: no two agents should write the same subsystem at the same time in the main worktree. Parallel work must either use forked workspaces or produce independent, reviewable file changes.
- Main-line status: source regression is green before integrating the next subagent batch. Installed deployment and real desktop regression remain intentionally deferred until the development batch is ready for a single test pass.

## 2026-06-21 Parallel Core Hardening Batch
- Completed: plugin/MCP/app projection now treats Anti-Codex local snapshots as the source of truth. Shared/native Codex caches are no longer read as a fallback when the local Anti-Codex snapshot is missing; missing snapshots degrade to empty/limited capability instead of pretending tools are callable.
- Completed: connector install URLs pointing at ChatGPT are stripped from local projection output. This keeps Anti-Codex away from ChatGPT login and app authorization surfaces.
- Completed: Manager UI hardening keeps the embedded Codex-style panel, follows the host light/dark theme, removes the floating duplicate Manager entry, separates routine actions from high-impact actions, and preserves close-button hit-area checks.
- Completed: shortcut/icon validation now parses the real `-File` launcher target behind the PowerShell shortcut, not just the PowerShell executable. Shortcut repair and sync-readiness reports include `expectedLauncherTarget`, `actualLauncherTarget`, and `launcherTargetMatches`.
- Completed: icon generation and readiness checks explicitly include the desktop icon asset and ICO frame strategy for desktop/taskbar/tray verification.
- Completed: update/sync UX reports version drift, current Anti-Codex source version, operation lifecycle, and brand/icon protection guardrails. Sync remains candidate-build-first and rollback-safe.
- Completed: the older broad projection test was updated to assert the new boundary: local Anti-Codex snapshots are read, shared-only Codex caches are ignored.
- Verification: focused integrated regression passed 133/133; local projection regression passed 161/161; full source regression passed 588 total / 554 passed / 34 skipped / 0 failed; scoped whitespace check passed for the touched files.
- Worker process: four ordinary forked subagents completed useful bounded tasks and were closed. Antigravity CLI artifact job `ag-fb3ddb6e-f1b9-44da-b0e7-7bd24d60e538` failed with exit code 2 and no output despite a concrete file-artifact task; the failure is recorded in `MCP_WORKER_RULES.md`.

## 2026-06-21 Fast Stability Guardrail Batch
- Completed: update checks no longer accept a cached "up to date" result as proof by itself. The active host must still pass manifest, source fingerprint, brand, icon, and file-hash guardrails; guardrail drift now marks updateNeeded instead of showing a false green state.
- Completed: rollback validation now matches the candidate-host safety level: active and rollback hosts must include Anti-Codex branding, FileDescription, OriginalFilename, tray/app/root icons, manifest schema, source hashes, file hashes, and the critical patch list before any swap is accepted.
- Completed: shortcut repair now scans desktop and Start Menu locations for stale Codex / Codex Desktop / DeepCodex shortcut residue, removes what is safe, reports what is not, and protects the official Anti-Codex launch/sync/rollback/manager entries.
- Verification: focused guardrail regression passed 15/15; full source regression passed 596 total / 562 passed / 34 skipped / 0 failed; parser checks passed for update, rollback, and shortcut repair scripts; scoped whitespace check passed.
- Worker process: three ordinary workers completed bounded disjoint tasks. A fourth review worker initially failed due to the agent thread limit until completed workers were closed; this lesson is recorded in `MCP_WORKER_RULES.md`.
- Still deferred: installed deployment, real desktop regression, and live Antigravity traffic checks remain intentionally deferred until the development batch is ready for one combined test pass.

## 2026-06-21 Final Guardrail Review Fixes
- Completed: fixed final review blockers after the first green run. Cached update status now fails if active manifest source fingerprints are missing, and installed-path checks include real Anti-Codex icon palette validation for host, tray, and app-root icons.
- Completed: rollback validation now checks actual `app.asar` patch markers such as Anti-Codex app identity, file-auth/no-login behavior, window icon routing, and local plugin catalog patches. A self-consistent manifest/hash is no longer enough.
- Completed: shortcut repair no longer deletes a user's normal desktop `Codex Desktop.lnk` by name alone. Desktop residual ownership is based on target, arguments, description, or launcher evidence; official Anti-Codex entries stay protected.
- Verification: focused guardrail regression passed 19/19; PowerShell parser checks passed for changed scripts; full source regression passed 600 total / 566 passed / 34 skipped / 0 failed; scoped whitespace check passed.
- Worker process: three blocker-fix workers were shut down after exceeding the 30-second progress rule; the main agent completed the fixes directly and recorded the lesson in `MCP_WORKER_RULES.md`.

## 2026-06-21 Fast Stability Closeout Batch

- Manager 高影响动作加二次确认：嵌入式 Manager 和 fallback Manager 都要求第一次点击只提示，第二次才执行；`upstreamConfig` 也不能第一次点击就打开配置面板。
- Manager 版本从 `native-panel-v69` 升到 `native-panel-v70`，同步 opener、readiness、Start Menu Manager 和 UI verifier，避免旧注入缓存继续工作。
- Manager 动作接口不再信任空 `Origin/Referer`；bootstrap/action/action-script 需要至少一个可信同源来源头，裸本地请求不能拿 token 后直接触发高影响动作。
- 第三方 API 模式下，旧 Antigravity 模型名如 `gemini-pro-agent` 会回落到当前第三方配置模型，避免切模型后续聊把 Gemini 名称发给第三方接口。
- local connector link/noauth/oauth 明确返回 metadata-only unsupported，不再表现成可连接成功。
- response history 被裁剪后，`previous_response_id` 会返回明确 expired/unavailable 错误，不再静默丢上下文继续请求。

## 2026-06-21 Startup Snapshot and Plugin Unlock Closeout
- Completed: startup snapshot readiness now compares the marker sourceFingerprint with the live shared Codex source fingerprint before skipping refresh. A fresh-but-stale marker can no longer hide changed skills, guidance files, or local app-tool caches.
- Completed: sync-shared-codex-plugin-host.mjs exposes --print-startup-source-fingerprint, so launcher readiness reuses the same Node fingerprint algorithm instead of maintaining a second PowerShell implementation.
- Completed: translator-only Antigravity recovery still skips the slow plugin marketplace/sidecar sync when DEEPCODEX_SKIP_PLUGIN_SYNC=1, but always runs the lightweight startup snapshot freshness check before starting the gateway.
- Completed: the old plugin UI unlock injection is now guarded behind ANTICODEX_UNSAFE_PLUGIN_UNLOCK=1; normal Anti-Codex startup and the helper script cannot silently spoof ChatGPT plugin UI state.

2026-06-21 Diagnostics source freshness closeout: diagnostics/localFeatures now recomputes the shared Codex startup source fingerprint and marks snapshotStatus stale with staleReason=source_changed when a fresh marker no longer matches source content. Embedded Manager shows a specific refresh hint for source_changed. Focused local-access/launcher tests and full source regression passed (606 total, 572 passed, 34 skipped, 0 failed). git diff --check still reports only CRLF/LF conversion warnings.

2026-06-21 Installed diagnostics source-freshness coverage: test-anticodex-diagnostics.ps1 now verifies localFeatures.snapshotStatus state/stale/sourceFingerprintComparable/sourceFingerprintMatches/staleReason, so installed no-traffic diagnostics will catch drift in the source-bound snapshot freshness contract. Focused diagnostics regression passed, then full source regression passed: 606 total, 572 passed, 34 skipped, 0 failed. git diff --check still only reports CRLF/LF conversion warnings.

## 2026-06-21 Manager Chinese/Mojibake Guardrail
- Completed: fallback `/anticodex/manager` static coverage now asserts readable Chinese title/actions and rejects common mojibake fragments, so a page that merely contains random CJK no longer passes.
- Completed: embedded Manager third-party API coverage now guards the exact safety wording: connection testing does not save config or switch the current session, saving preserves chat/project/workspace state, and failures do not silently fall back to Antigravity traffic.
- Hardened: third-party connection probes now receive an independent timeout budget per stage; the embedded Manager allows 60 seconds for the full probe and never retries state-changing requests across candidate addresses.
- Hardened: the embedded Manager serializes test/save/restore operations, binds a successful test to the exact current form values, and refuses to show an empty editable form when the saved profile cannot be read.
- Hardened: unreadable third-party profiles and encrypted keys now fail closed instead of silently selecting Antigravity. The launcher also verifies that a healthy translator matches the configured mode, protocol, URL, and model before reusing it.
- Hardened: stale `gemini-3-flash-agent` session model ids map to the configured third-party model, native streaming remembers completed responses, and provider error text is credential-redacted.
- Hardened: an unreadable third-party key still allows an explicit restore to Antigravity, while third-party startup remains fail-closed. Manager POST actions no longer retry across addresses or fall back to cached GET snapshots.
- Verification: third-party focused regression passes 152/152; profile storage tests pass; source preflight fast mode passes with JavaScript, PowerShell, UI-state, and whitespace checks green.
- Completed: UI state verification now rejects mojibake in the embedded Manager source, fallback Manager source, rendered in-app Manager text, and main page text.
- Completed: the visible-page selector in the UI verifier no longer relies on a legacy mojibake `管理` token.
- Verification: `test-anticodex-ui-state.mjs --self-test` passed; focused launcher regression passed 81/81; full source regression passed 606 total / 572 passed / 34 skipped / 0 failed. `git diff --check` still reports only CRLF/LF conversion warnings.

## 2026-06-21 Source Preflight and Capability Gate
- Completed: added a source-only preflight gate that checks JavaScript syntax across scripts and translator, PowerShell parser health, UI-state self-test, optional full translator regression, and git diff --check before install/sync.
- Completed: install-anticodex.ps1 and sync-anticodex.ps1 now run the source preflight before copying/building a host candidate, so broken source is stopped before it can enter the installed desktop path.
- Completed: Responses WebSocket fallback now covers /codex/responses as well as /responses and /v1/responses, and diagnostics records the WebSocket subprotocol without prompt data.
- Completed: app-tool projection and capability grading now require each exposed tool to have a connector_id that belongs to an accessible connector. Unattributed or unauthorized tools fail the capability check instead of being counted as callable.
- Verification: PowerShell parser checks passed for the touched scripts; source preflight passed in fast and full modes; full source regression passed 607 total / 573 passed / 34 skipped / 0 failed; git diff --check has only CRLF/LF conversion warnings.
- Still deferred: installed deployment, shortcut refresh, live desktop UI, and real Antigravity traffic checks remain queued for the combined test pass after development.

## 2026-06-21 Diagnostic Bundle Source-Preflight Evidence
- Completed: diagnostic bundles now include `latest-source-preflight.json` in `reports-summary.json`, so install/sync source-gate evidence travels with the normal privacy-safe bundle.
- Completed: static launcher coverage now asserts the collector keeps the source-preflight report in its latest-report list.
- Completed: source-preflight report summaries now preserve `reportName`, `skipFullRegression`, and the JavaScript/PowerShell/UI/regression/diff check booleans, and the diagnostic verifier fails if those fields are missing from a generated bundle.
- Verification: collector and diagnostics verifier PowerShell parser checks passed; focused launcher regression passed 82/82; full source regression passed 607 total / 573 passed / 34 skipped / 0 failed; source preflight fast mode passed; `git diff --check` reports only CRLF/LF conversion warnings.
- Still deferred: installed deployment, shortcut refresh, live desktop UI, and real Antigravity traffic checks remain queued for the combined test pass after development.

## 2026-06-21 Manager Source-Preflight Action
- Completed: embedded Manager and fallback Manager now expose a daily `sourcePreflight` action labeled "运行源码预检".
- Completed: the action runs `test-anticodex-source-preflight.ps1 -SkipFullRegression`, reports elapsed time, latest/history report evidence, and first failure items, without restarting Anti-Codex, switching accounts, or consuming Antigravity traffic.
- Completed: manager action verification and static launcher coverage now include `sourcePreflight` in the daily action inventory and assert the backend action uses the source-preflight script.
- Verification: adaptive server and embedded Manager JavaScript syntax checks passed; manager action PowerShell parser passed; focused launcher regression passed 82/82; full source regression passed 607 total / 573 passed / 34 skipped / 0 failed; source preflight fast mode passed; `git diff --check` reports only CRLF/LF conversion warnings.
- Superseded on 2026-06-23: standalone real Manager button coverage now exists for the non-disruptive MCP/Skill and plugin/application actions; installed deployment and broader live desktop acceptance still remain queued for the combined pass.

## 2026-06-21 Source-Preflight Diagnostics Evidence Tightening
- Completed: diagnostics verification now requires `skipFullRegression` in both the diagnostic bundle `latest-source-preflight.json` summary and the live `/anticodex/diagnostics` source-preflight status.
- Completed: the live diagnostics verifier now also requires `uiStateSelfTestOk`, matching the collector and Manager source-preflight evidence contract.
- Completed: a short audit note was added at `docs/audits/source-preflight-diagnostics-audit.md` so the field contract is easy to re-check later.
- Verification: PowerShell parser check passed; focused launcher regression passed 82/82; full source regression passed 607 total / 573 passed / 34 skipped / 0 failed; source preflight fast mode passed in 18.9s; `git diff --check` reports only CRLF/LF conversion warnings.
- Worker process: DeepSeek found the `skipFullRegression` verifier gap and completed with parser validation; Antigravity Manager audit job failed with exit code 2 and empty output, and the retry rule was recorded in `MCP_WORKER_RULES.md`.

## 2026-06-21 Installed Manager Source-Preflight Coverage
- Completed: the full installed overall verifier now clicks the embedded Manager `sourcePreflight` button and requires its action-specific result, alongside the existing MCP/Skill and plugin/application button checks.
- Completed: fast verification remains fast; it records the Manager button click as intentionally deferred because the source preflight gate already runs separately.
- Completed: skip-UI verification records the source-preflight button check as skipped instead of silently omitting it.
- Verification: installed-overall PowerShell parser passed; focused launcher regression passed 82/82; full source regression passed 607 total / 573 passed / 34 skipped / 0 failed; source preflight fast mode passed in 18.0s; `git diff --check` reports only CRLF/LF conversion warnings.
- Superseded on 2026-06-23: standalone real Manager button coverage now exists for the non-disruptive MCP/Skill and plugin/application actions; broader installed desktop acceptance remains queued for the combined pass.

## 2026-06-21 Third-Party Provider Model Routing Closeout
- Completed: third-party API mode now records provider model-route evidence for local upstream calls: transport, provider, provider protocol, requested model, resolved model, and status. Prompt text and API keys are not stored in the route audit.
- Completed: installed overall no longer skips model-routing verification just because the active upstream is third-party. The no-traffic routing verifier now checks provider mode, protocol, model, bridge mode, and `/models` consistency while keeping Antigravity-only thinking/account checks separate.
- Completed: full traffic model-routing keeps the Antigravity internal-model/cascade checks for Antigravity mode, but uses provider transport/protocol evidence for third-party mode.
- Verification: model-route audit test passed; third-party upstream integration passed 2/2; launcher contracts passed 82/82; model-routing PowerShell parser check passed. Full source preflight before the final report-field tweak passed 608 total / 574 passed / 34 skipped / 0 failed.
- Superseded on 2026-06-23: standalone real Manager button coverage now exists for the non-disruptive MCP/Skill and plugin/application actions; installed deployment, broader live desktop UI, and live Antigravity traffic checks remain queued for the combined installed desktop acceptance pass.

## 2026-06-21 Provider-Neutral Route Audit Identity
- Completed: model-route audit snapshots now identify as `anticodex.model_route_audit` instead of the older Antigravity-only object name.
- Completed: the old `antigravity.model_route_audit` value is preserved as `legacyObject`, so existing diagnostics or reports can remain backward-compatible while new UI/reporting treats the audit as Anti-Codex-owned provider routing.
- Verification: model-route audit test passed; local-access diagnostics regression passed 47/47; launcher contracts passed 82/82; JavaScript syntax check passed for the route audit module.
- Superseded on 2026-06-23: standalone real Manager button coverage now exists for the non-disruptive MCP/Skill and plugin/application actions; installed deployment, broader live desktop UI, and live Antigravity traffic checks remain queued for the combined installed desktop acceptance pass.

## 2026-06-21 Provider Route UI and Refresh Behavior
- Completed: fallback Manager route display now uses a provider-neutral route summary and shows transport, provider, protocol, requested model, resolved model, internal model, and status.
- Completed: UI-state verification now rejects Manager route summaries that omit third-party provider/protocol/transport evidence.
- Completed: `/anticodex/models/refresh` is now mode-aware. Antigravity mode still refreshes the signed-in desktop model catalog; third-party mode returns the configured provider model and explicitly skips Antigravity refresh/traffic.
- Completed: the standalone model-refresh script logs when a provider model is preserved and Antigravity refresh is skipped, instead of forcing a restart fallback or leaving a misleading generic success line.
- Completed: embedded Manager now has the same provider-neutral "recent route" card as the fallback Manager, so the normal in-app panel shows transport/provider/protocol evidence without opening a separate page.
- Verification: local-access regression passed 48/48; launcher contracts passed 82/82; UI-state self-test passed; PowerShell parser check passed for the refresh script; fast source preflight passed.
- Superseded on 2026-06-23: standalone real Manager button coverage now exists for the non-disruptive MCP/Skill and plugin/application actions; installed deployment, broader live desktop UI, and live Antigravity traffic checks remain queued for the combined installed desktop acceptance pass.

## 2026-06-21 Third-Party API URL Tolerance
- Completed: OpenAI-compatible providers now accept either a base URL such as `/v1` or a full `/chat/completions` endpoint without double-appending the path.
- Completed: Anthropic providers now accept host-only, `/v1`, or full `/v1/messages` URLs without generating `/v1/v1/messages`.
- Completed: connection-test model probing uses the same normalized OpenAI-compatible base as real chat calls, so a pasted full endpoint does not fail before the chat probe.
- Completed: the embedded Manager third-party API form now explicitly tells the user that the API URL can be either a base URL or a full endpoint.
- Verification: upstream provider regression passed 70/70; upstream integration passed 2/2; full source preflight passed with 611 total / 577 passed / 34 skipped / 0 failed.
- Superseded on 2026-06-23: standalone real Manager button coverage now exists for the non-disruptive MCP/Skill and plugin/application actions; installed deployment, broader live desktop UI, and live Antigravity traffic checks remain queued for the combined installed desktop acceptance pass.

## 2026-06-21 Installed Manager Route Evidence Coverage
- Completed: installed Manager action verification now checks that the fallback `/anticodex/manager` page includes provider-neutral route evidence: `/anticodex/model-routes`, route summary function, transport, Provider, and provider protocol fields.
- Completed: the Manager action report now exposes `page.hasRouteProviderFields` so diagnostic output can show whether the fallback page still proves third-party routing.
- Verification: Manager action PowerShell parser passed; launcher contracts passed 82/82; UI-state self-test passed; fast source preflight passed.
- Superseded on 2026-06-23: standalone real Manager button coverage now exists for the non-disruptive MCP/Skill and plugin/application actions; installed deployment, broader live desktop UI, and live Antigravity traffic checks remain queued for the combined installed desktop acceptance pass.

## 2026-06-21 Manager Route Empty-State Hardening
- Completed: fallback Manager route display now keeps the same provider-neutral fields even when no recent route exists, instead of collapsing to a single "no route" line.
- Completed: embedded in-app Manager route card now also keeps requested model, resolved model, display name, transport, Provider, protocol, internal model, and status visible in the empty state.
- Completed: UI-state self-test now rejects regressions that collapse either Manager route empty state back to a single status line.
- Completed: worker/tooling failures from the interrupted turn were recorded in `MCP_WORKER_RULES.md`, including noisy Antigravity health output and brittle nested PowerShell line-range commands.
- Verification: adaptive server syntax passed; embedded Manager syntax passed; UI-state self-test passed; launcher contracts passed 82/82; fast source preflight passed.
- Later completed: installed deployment, live desktop UI, Manager button checks, real Antigravity traffic gates, shortcut/icon verification, and guarded update/sync evidence were covered by later installed desktop acceptance passes.

## 2026-06-21 Anti-Codex Chat Tool-Loop Root Cause
- Completed: the final Responses formatter now trusts translator-owned current-turn internal tool evidence. A completion summary after a real internal tool loop is no longer replaced by the false "no actual tool call" guard.
- Completed: user-visible guard/empty-response messages now brand themselves as Anti-Codex instead of leaking the old DeepCodex name.
- Completed: explicit web/search intent now prefers internal `web_search`/`web_fetch` before generic tools, then releases `tool_choice` back to auto after the internal web tool has executed so the model can answer or continue normally.
- Verification: adaptive server syntax passed; focused pseudo/internal-tool regression passed 120/120 with new coverage for current-turn tool evidence, Anti-Codex guard branding, Chinese "网上搜索" intent, URL fetch preference, and forced-tool release. Fast source preflight also passed after rerunning with report-directory access.
- Completed: the installed runtime now has the full updated `translator` directory, not only `adaptive-server.mjs`, preventing missing sibling-module startup failures.
- Installed verification: `/health` is ready on 8484 with Antigravity Desktop and 8 models; real `web_fetch` verification passed; `/codex/responses` SSE marker verification passed; Codex tool-loop verification passed; a Chinese minimal request returned `中文链路正常`.
- Later completed: full installed overall, embedded UI no-login/no-reconnect checks, and stability verification were covered by later installed acceptance passes.

## 2026-06-22 MCP/Skill Parity Guardrail
- Completed: the installed MCP/skills verifier now compares every shared skill directory from `C:\Users\XD\.codex\skills` against the Anti-Codex local skills copy and fails if any shared skill is missing.
- Completed: the same verifier compares shared and local `[mcp_servers.*]` names from `config.toml`, excluding `.env` and `.tools.` subtables, and fails if Anti-Codex is missing any shared MCP server.
- Completed: MCP server parsing is anchored to real TOML section lines, so commented examples such as `# [mcp_servers.foo]` are not counted as missing shared MCP servers. A behavior test now runs the verifier against temporary shared/local homes and proves missing shared entries fail while comments and `.env`/`.tools.` subtables are ignored.
- Completed: diagnostics MCP counting now reports only real MCP server sections instead of counting tool subtables.
- Current machine evidence: shared/local MCP names are 3/3 (`antigravity-code-worker`, `deepseek-code-worker`, `node_repl`), shared/local skills are 100/100, and missing shared lists are empty.
- Scope note: config sync still preserves Anti-Codex safety flags and Windows command normalization; the product guarantee is capability/name parity from shared Codex into Anti-Codex, not unsafe byte-for-byte overwrite.

## 2026-06-22 Third-Party Provider Switch Continuity
- Completed: the third-party provider verifier now runs a nine-turn local provider scenario. Provider A completes six turns across stale Antigravity model names, profile save, and translator restart; Provider B is saved and turn 7 continues from Provider A's last `previous_response_id`; Provider C switches protocol to Anthropic and turn 8 continues from Provider B's last `previous_response_id`; Provider D switches back to OpenAI-compatible and turn 9 continues from Provider C's last `previous_response_id`.
- Completed: the Provider B turn proves the request reaches the second OpenAI-compatible provider, uses the second provider model/key, and still includes Provider A's earlier user and assistant history.
- Completed: the Provider C turn proves OpenAI-compatible to Anthropic cross-protocol continuation: the Anthropic `/v1/messages` request uses the Anthropic key/model and still contains the earlier Provider A/B user and assistant history.
- Completed: the Provider D turn proves Anthropic to OpenAI-compatible reverse continuation: the OpenAI-compatible `/v1/chat/completions` request uses the new key/model and still contains the earlier Anthropic assistant history.
- Completed: the verifier now rejects leaks of the second provider key in saved profile responses, public profile output, route audit output, and report files.
- Verification: `test-anticodex-third-party-provider.mjs` passed from both source and installed runtime roots with 9 turns, `switchedProviderWithoutHistoryLoss:true`, `crossProtocolWithoutHistoryLoss:true`, and `reverseCrossProtocolWithoutHistoryLoss:true`; focused launcher/upstream regression passed 162/162; source preflight fast mode passed; runtime sync passed.
- Still deferred: none for local cross-protocol provider continuity; both protocol directions are now covered locally without real provider traffic.

## 2026-06-22 Manager Real Safe Button Coverage
- Completed: installed overall now clicks real embedded Manager buttons for `updateCheck`, `sourcePreflight`, and `syncReadiness`, instead of relying only on `ui-only` Manager smoke for those safe actions.
- Completed: installed overall now also clicks the real embedded Manager `viewLatestReports` button as a separate report-action batch. The verifier accepts the normal empty-report state (`还没有可显示的验收报告`) as a completed real action.
- Hardened: non-`ui-only` Manager button verification now rejects stale `ui-only manager button smoke` text, preventing old fake-bridge output from being counted as a real click.
- Completed: the Manager button verifier restores the real action bridge after earlier `ui-only` smoke runs, so later real clicks cannot accidentally reuse the fake bridge.
- Completed: batch button verification now accepts explicit action result text even when the embedded Manager surface does not write a `lastAction` record.
- Verification: real three-button batch passed against the installed UI with `lastUiOnly:false`; launcher contract tests, manager-button self-test, source preflight fast mode, runtime sync, and installed no-traffic overall all passed. The installed report recorded `managerButtonSafeActions.ok:true` for `updateCheck`, `sourcePreflight`, and `syncReadiness`, with all three `lastUiOnly:false`; it also recorded `managerButtonReportActions.ok:true` for `viewLatestReports`, with `lastUiOnly:false`.
- Superseded on 2026-06-23: `mcpSkills` and `pluginCapabilities` now have standalone real embedded Manager coverage with stale-text rejection. `diagnosticsBundle` remains an opt-in slower real button action, and account/proxy/config/post-verification/sync-host actions stay excluded from ordinary no-traffic checks.

## 2026-06-22 Manager Diagnostics Bundle Button Coverage
- Completed: the real embedded Manager `diagnosticsBundle` button now displays `诊断包：已生成` plus visible `ZIP` and `目录` lines, unwrapping nested script results when needed.
- Completed: the Manager bridge fetches its bootstrap token with trusted local `Origin` and `Referer`, matching the protected action call without weakening source validation.
- Completed: embedded Manager status refresh suppresses `refreshStatus` as a last-action result, so a status-card refresh no longer overwrites the just-finished diagnostics summary.
- Completed: the Manager button verifier rebuilds a real queue bridge after any earlier `ui-only` run, clears stale fake results before real clicks, treats `已生成` as a finished state, and requires ZIP/目录 evidence for diagnostics.
- Completed: full installed overall now includes `managerButtonDiagnosticsBundle`; fast mode skips this slow real click.
- Verification: `node --check` passed for the changed Manager scripts; manager-button self-test passed; the installed real diagnostics button passed with `lastUiOnly:false` and ZIP/目录 evidence. Rerun full installed overall after the connector parity work lands.
- Superseded on 2026-06-23: real `mcpSkills` and `pluginCapabilities` button clicks now pass through the standalone gate with current-action matching and stale `ui-only` text rejection.

## 2026-06-22 Connector/App-Tool Parity Guardrail
- Completed: plugin capability verification now compares shared Codex connector cache IDs against Anti-Codex local connector cache IDs and fails on any `missingShared` entry.
- Completed: the same verifier reports app-tool cache parity using connector/tool keys, while still refusing to treat local allowlists as real authorization.
- Completed: the verifier avoids PowerShell 5.1 `ConvertFrom-Json` on huge connector catalog files and extracts parity keys with bounded text scans instead.
- Current machine evidence after refresh: connector parity is `sharedCount:5781`, `localCount:5781`, `missingShared:[]`; app-tool cache parity is `sharedCount:52`, `localCount:52`, `missingShared:[]`. Runtime callable app tools remain `0` because no connectors are currently accessible/authorized.
- Completed: `refresh-anticodex-local-features.ps1` refreshed local skills, global MD guidance, connector cache, plugin cache, app-tool cache, and sidecars from `C:\Users\XD\.codex` into Anti-Codex.
- Verification: plugin-capability parser passed; launcher contract tests passed 89/89; plugin capability verification passed after the refresh.

## 2026-06-22 Installed Overall Stability Boundary
- Supersedes the earlier Manager real-safe/report/diagnostics full-overall plan: the combined installed overall no longer real-clicks Manager actions that start background update/source/sync/report/bundle work.
- Those Manager buttons stay covered by standalone button/action verifiers. The combined overall keeps non-disruptive UI, parity, provider, idle, diagnostics, and runtime checks green without leaving the embedded Manager busy or restarting the gateway mid-suite.
- Latest installed no-traffic overall passed with `ok:true`, 8 models, UI idle stable, MCP/skill parity green, connector/app-tool parity green, and original Codex left running.

## 2026-06-22 Manager Standalone Verifier Hardening
- Completed: `test-anticodex-manager-action.ps1` now writes its final JSON directly to process stdout and uses raw .NET HTTP for the JSONP action-script probe. This avoids the Windows PowerShell `Invoke-WebRequest` success-path hang/host-exit behavior seen against `application/javascript` responses.
- Completed: JSONP action-script checks now URL-encode the live Manager token and unwrap inner HTTP exceptions, so 403/400 error responses are read as status evidence instead of collapsing to `0`.
- Completed: embedded Manager result preservation now refuses to carry `uiOnly:true` or `ui-only manager button smoke` summaries into a reopened panel.
- Completed: the Manager button verifier restores the real action bridge after ui-only smoke, clears stale ui-only results, records `lastOk`, rejects visible `需要处理` text in real mode, and refuses `lastOk:false` even if the text looks action-specific.
- Refreshed: `refresh-anticodex-local-features.ps1` was rerun after shared Codex connector cache drift. Current evidence is MCP 3/3, skills 100/100, connector parity `sharedCount:5777`, `localCount:5777`, `missingShared:[]`, app-tool parity `52/52`, and callable app tools still `0` because no connector is authorized.
- Verification: standalone Manager action verifier passed on `http://127.0.0.1:8484` with safe `refreshStatus`, token/source-header checks, JSONP 403/400/200 evidence, and no stdout loss. Plugin `ui-only -> real` button sequence passed with real result `lastUiOnly:false`, 183 plugins, 1494 connectors, and no fake callable app tools. Runtime sync passed; source preflight fast passed; launcher regression passed 89/89; installed no-traffic overall passed with `ok:true` in about 110s.
- Lesson: do not run Manager button/UI-state verifiers in parallel. They share `%TEMP%\anticodex-manager-button.lock`; running plugin button verification concurrently with installed overall caused a false UI-state lock timeout before the serial rerun passed.

## 2026-06-22 Manager Latest Reports and v84 Runtime
- Completed: Manager latest reports now include MCP/Skill, plugin/application capability, local feature refresh, stability soak, diagnostics, source preflight, installed overall, model routing, tool bridge, UI idle, sync readiness, compaction, and post-verification report summaries.
- Completed: the latest-report summary shows empty state guidance, missing reports, stale reports, report age, first failure, and omits file paths for reports that do not exist. `viewLatestReports` is covered by a real embedded Manager button click.
- Completed: `mcpSkills`, `pluginCapabilities`, and `refreshFeatures` scripts now write `latest-*.json` plus history reports with UTF-8 no BOM, so Manager and diagnostic bundles have durable evidence instead of only inline button text.
- Completed: `stabilitySoak` is now a high-impact Manager action backed by `test-anticodex-stability-soak.ps1` and guarded as a background singleton instead of being only a report name.
- Completed: Manager button verification now fetches bootstrap tokens with trusted local source headers, drains the real Manager action queue, clears stale promise queues before each run, and rejects stale `ui-only` summaries in real mode.
- Verification: `test-anticodex-installed-overall.ps1 -EnsureRunning -NoTraffic -SkipAccountProxyProbe` passed with `ok:true` in about 166 seconds on `native-panel-v84`; standalone real Manager button checks passed for `viewLatestReports` and `refreshStatus`; `test-anticodex-plugin-capabilities.ps1` passed with connector parity `5777/5777`, app-tool parity `52/52`, and callable app tools `0`; `test-anticodex-local-connectors.mjs` passed; `test-anticodex-third-party-provider.mjs` passed with nine turns and both cross-protocol directions.
- Completed: latest-report parsing now distinguishes missing files from corrupt JSON. A file that exists but cannot parse is surfaced as `invalid_report`, counted in `invalidCount`, and displayed as a damaged report instead of being hidden as "not generated". Missing reports are separately counted in `missingCount`.
- Completed: diagnostic bundle creation now returns top-level `ok:false` with `damagedReports` if report summaries include parse/read errors, while still producing the ZIP for support. Installed overall report encoding now treats any existing unparseable latest report as a failure, even when the file predates the current run.
- Verification: adaptive server syntax, Manager bridge syntax, Manager button self-test, and launcher contracts 89/89 passed with invalid-report contract assertions.
- Superseded on 2026-06-22: SHA256 sidecar hash integrity is implemented for current reports, Manager summaries, diagnostic bundles, and installed overall. True cryptographic report signing remains a future hardening option if tamper-evident hashes are not enough.

## 2026-06-22 Atomic Report Writes
- Completed: shared PowerShell report writes now go through `anticodex-report-io.ps1`, which writes UTF-8 without BOM to a same-directory temp file, validates JSON before publish, and atomically replaces existing latest/history reports.
- Completed: core report-producing verifiers now use the shared atomic helper instead of direct latest-report writes, including MCP/skills, plugin/connectors, installed overall, source preflight, sync readiness, UI idle, model routing, tool loops, cancellation, stability, proxy drill, shortcut repair, account switch, and web/native/real-work verifiers.
- Completed: account/proxy readiness now writes `latest-account-proxy-readiness.json` plus history output, matching the Manager latest-report inventory instead of leaving a listed report unwritten.
- Completed: Node local connector and third-party provider verifiers now publish reports through temp-file JSON validation and rename instead of direct latest writes.
- Verification: PowerShell parse check passed for 66 scripts; Node syntax passed for local connector and third-party provider verifiers; launcher contracts passed 89/89; source preflight fast mode passed; direct helper smoke passed for relative paths, overwrite, and bad JSON rejection.

## 2026-06-22 Report Hash Integrity
- Completed: PowerShell report writes now publish a `.sha256` sidecar for both latest and history reports after JSON validation and atomic replacement.
- Completed: Node local connector and third-party provider verifiers now publish matching `.sha256` sidecars when an explicit report root is used by installed overall or direct verifier runs.
- Completed: Manager latest-report payload verifies signed reports and surfaces hash mismatches as `invalid_report_integrity` with `integrity_hash` evidence instead of treating a parseable but tampered report as healthy.
- Completed: diagnostic bundles include per-report integrity summaries and include hash mismatch reports in `damagedReports`; old unsigned reports remain legacy/unsigned instead of being misclassified as damaged.
- Completed: installed overall requires fresh reports to have valid SHA256 sidecars, while old unsigned reports are reported as legacy issues. Any signed hash mismatch fails regardless of age.
- Verification: launcher contracts passed 89/89; source preflight fast passed; PowerShell helper sidecar smoke passed; Node local connector and third-party provider sidecar smokes passed with explicit report roots; runtime sync restarted Anti-Codex; installed no-traffic fast overall passed after cleanup.

## 2026-06-22 Remaining Manager Real Button Coverage
- Completed: standalone real embedded Manager `mcpSkills` button verification passed with `lastUiOnly:false`, MCP 3, Skill 100, real `node_repl` smoke passed, and Skill file readable.
- Completed: standalone real embedded Manager `pluginCapabilities` button verification passed with `lastUiOnly:false`, 183 installed plugins, 1494 connectors, cache readable, and callable app tools correctly reported as unavailable because no connector is authorized.
- Verification: both real button checks ran serially against port 58318 after report hash hardening and runtime sync; no stale `ui-only` summary was accepted.

## 2026-06-22 Full Installed Overall Acceptance
- Completed: full installed no-traffic overall exposed a verifier mismatch where UI-state treated the host as light from background color while the injected Manager correctly followed the explicit `electron-dark` host class.
- Fixed: `test-anticodex-ui-state.mjs` now uses the same explicit host theme priority as the Manager injection: `electron light/dark` class tokens and data theme attributes win before color-scheme/background fallback.
- Verification: focused UI-state passed after runtime script sync; full installed no-traffic overall passed with `ok:true`, UI state green, UI idle green, diagnostics green, local connector green, third-party provider green, report encoding/hash green, one translator process, and 8 Antigravity models.

## 2026-06-22 Third-Party Provider Tool History Continuity
- Completed: `test-anticodex-third-party-provider.mjs` now inserts a real OpenAI-compatible `tool_calls` response and a paired `function_call_output` into the existing provider history chain before profile save/restart/provider switches.
- Completed: the verifier now checks structured tool-history preservation, not only text markers: OpenAI-compatible requests must contain `assistant.tool_calls` plus the matching `role:"tool"` result, and Anthropic requests must contain `tool_use` plus matching `tool_result`.
- Completed: the local report now records `multiTurnHistory.toolHistory`, including restart, provider-switch, protocol-switch, and reverse-protocol-switch preservation booleans.
- Verification: direct local verifier passed with 9 normal turns plus 2 tool-history turns; `providerSwitchPreservesOpenAiToolPair:true`, `protocolSwitchPreservesAnthropicToolPair:true`, and `reverseProtocolSwitchPreservesOpenAiToolPair:true`. Launcher contracts passed 89/89, and source preflight fast mode passed.
- Verification: runtime sync restarted the installed translator; installed verifier passed from the runtime copy; installed no-traffic overall passed with `ok:true`, third-party provider green, local connector green, UI state green, diagnostics green, and one translator process.

## 2026-06-22 Agents Skill Root Parity
- Completed: local feature snapshot sync now overlays `%USERPROFILE%\.agents\skills` into the Anti-Codex-owned local `skills` copy in addition to `%USERPROFILE%\.codex\skills`.
- Completed: startup snapshot fingerprints and source manifests include the extra skill root, so changed Lark/agent skills trigger refresh and stale removed skills are pruned through the same manifest flow.
- Completed: `refresh-anticodex-local-features.ps1` and `test-anticodex-mcp-skills.ps1` now report and enforce `agentsCount`, `expectedSharedCount`, and missing combined skill names.
- Verification: refresh reported `.codex` skills `100`, `.agents` skills `26`, and no missing expected skills; MCP/skills verifier passed with `expectedSharedCount:126`, `missingShared:[]`, real `node_repl` call passed, and DeepSeek/Antigravity worker MCP `tools/list` passed.
- Verification: after runtime sync/restart, installed diagnostics reports `snapshotStatus.state:fresh`, `sourceFingerprintMatches:true`, and `skills.count:126`; full installed no-traffic overall passed with `ok:true`.

## 2026-06-22 Local Connector Gate Hardening
- Completed: `test-anticodex-local-connectors.mjs` now seeds blocked connector install URLs in its isolated cache and proves the local HTTP projection scrubs them while preserving ordinary non-ChatGPT install URLs.
- Completed: the same verifier now explicitly proves allowlisted, hidden, and orphan cached tools do not appear in `/backend-api/wham/apps`, and link/noauth/oauth metadata-only endpoints do not return URL or redirect fields.
- Completed: `test-anticodex-plugin-capabilities.ps1` now checks both GET and POST `/backend-api/wham/apps` and fails if their exposed tool key sets differ.
- Completed: installed overall report integrity now includes `latest-local-connectors.json`, so the local connector gate report gets the same SHA256 sidecar check as other release evidence.
- Completed: websocket fallback verifier now retries each upgrade path briefly, avoiding false installed-overall failures from a local socket close while still requiring 501 `unsupported_websocket`.
- Verification: direct local connector verifier passed with `chatgptInstallUrlsScrubbed:true`; plugin capability verifier passed with `appToolGetPostParity` empty; launcher contracts passed 89/89; local-access regression passed 51/51; source preflight fast passed; after runtime sync/restart, full installed no-traffic overall passed with `ok:true` and `latest-local-connectors.json` hash-valid in report integrity.

## 2026-06-23 Manager Real MCP/Plugin Gate
- Completed: added `test-anticodex-manager-real-buttons.ps1` as a standalone slow gate for real embedded Manager button clicks. Default coverage is now limited to `mcpSkills` and `pluginCapabilities`; `viewLatestReports` and `diagnosticsBundle` remain supported opt-in actions so routine runs do not create long report/bundle work by default.
- Completed: the installed overall no-traffic verifier now real-clicks only the non-disruptive MCP/Skill and plugin/application Manager buttons, with per-action outer timeouts and stale lock cleanup. Background report, diagnostics bundle, and update/sync style Manager actions remain standalone coverage.
- Completed: `test-anticodex-manager-button.mjs` now requires the page-side `lastAction` to match the current real action before accepting success. It no longer treats stale visible text from a previous Manager action as a green result.
- Completed: `sync-anticodex-runtime.ps1` now treats translator restart success as "health returned" rather than requiring the launcher process to exit, which avoids false restart timeouts when the launcher stays alive while the gateway is already healthy.
- Completed: `latest-manager-real-buttons.json` is now included in Manager latest-report inventory, diagnostic bundle report summaries, and installed overall report-integrity checks, so the real-button evidence is visible and hash-checked like the other core reports.
- Latest evidence: after refreshing local features, plugin capability verification passed with connector parity `sharedCount:5866`, `localCount:5866`, `missingShared:[]`; app-tool parity `58/58`; callable app tools still `0` because no connector is authorized.
- Latest evidence: MCP/skills verification passed with MCP `3/3`, skills expected union `126`, missing shared `[]`, real `node_repl` smoke passed, and DeepSeek/Antigravity worker MCP tool lists visible.
- Latest evidence: standalone real Manager button gate passed for `mcpSkills` and `pluginCapabilities` against port `58318`, with `lastUiOnly:false`, no new page, and "未授权连接器，不伪装可调用" shown as normal.
- Verification: focused syntax/contract checks passed: `node --check translator/adaptive-server.mjs`, PowerShell parser checks for diagnostics and installed overall, and launcher contracts `90/90`.
- Deferred: full source preflight and installed overall were not rerun after the final small default-action change to avoid another long command; focused parser/self/contract checks should be used before the next checkpoint, and the full gates can be reserved for final release acceptance.

## 2026-06-23 Windows Launcher Branding Residue
- Completed: Windows native launcher error dialogs now use `Anti-Codex` as the message-box title instead of the legacy `DeepCodex` title. Internal compatibility names such as the C# class name and `start-deepcodex.ps1` path remain unchanged.
- Completed: launcher contract coverage now reads `src/deepcodex-launcher-win.cs`, asserts `MessageBox.Show(..., "Anti-Codex", ...)`, and rejects `MessageBox.Show(..., "DeepCodex", ...)` for user-visible error dialogs.
- Verification: launcher test syntax check passed; focused launcher contract suite passed 90/90. The first run exposed an unrelated brittle stdout-only assertion in the MCP/skills temporary verifier test; the test now accepts JSON from stdout or stderr and reports a clear no-output failure.

## 2026-06-23 Real Usage Coverage Audit Refresh
- Completed: rewrote `docs/audits/real-usage-test-coverage.md` from stale/garbled 0% coverage claims into a current audit of Chinese response checks, real-tool coverage, final completion checks, and legacy `DeepCodex` residue rejection.
- Completed: the audit now distinguishes routine bounded verifier evidence from remaining combined installed desktop and live Antigravity traffic gates.
- Verification: stale-audit search no longer finds the old "0%" / "no assertions" claims; documentation whitespace check passed.

## 2026-06-23 User-Visible Legacy Brand Sweep
- Completed: replaced remaining user-visible legacy `DeepCodex` wording in `translator/server.mjs`, `scripts/start-deepcodex.sh`, `scripts/apply-deepcodex-brand.ps1`, and `scripts/deepcodex-plugin-unlock-inject.js` with Anti-Codex wording while leaving internal compatibility names intact.
- Completed: launcher contract coverage now asserts those macOS launcher, debug plugin unlock, legacy translator, and brand-patch surfaces are Anti-Codex-branded and rejects the old user-visible phrases.
- Verification: JS syntax checks passed for the changed JS files; `apply-deepcodex-brand.ps1` parsed through a no-`$` scriptblock check; focused launcher contract suite passed 90/90; source-only legacy phrase search returned no matches.

## 2026-06-23 Marketing Copy Refresh
- Completed: rewrote `docs/marketing/launch-post.md` and `docs/marketing/wechat-article.md` from garbled DeepCodex/DeepSeek-only copy into current Anti-Codex messaging.
- Completed: the refreshed copy states the current provider shape: default Antigravity Desktop, optional third-party API, no ChatGPT login path, no original Codex mutation, and no fake connector/app-tool authorization.
- Verification: marketing-doc search finds no `DeepCodex` / `deepcodex` residues; documentation whitespace check passed.

## 2026-06-23 Provider Stack Doc Refresh
- Completed: rewrote `docs/ADAPTIVE_ONE_API_STACK.md` from the old DeepCodex one-api bootstrap path into the current Anti-Codex provider stack: local translator, default Antigravity Desktop upstream, optional explicit third-party provider profile, and no ChatGPT login route.
- Completed: the doc now states the provider-switch continuity contract and the local MCP/skill/plugin/connector metadata parity boundary, including that metadata sync does not grant connector authorization.
- Verification: focused stale-stack search and documentation whitespace checks passed.

## 2026-06-23 Video Script Refresh
- Completed: moved the old DeepCodex/DeepSeek video script into `docs/marketing/legacy/deepcodex-video-script.md` instead of overwriting the historical material.
- Completed: added a current `docs/marketing/video-script.md` for Anti-Codex: separate runtime, original Codex untouched, Antigravity Desktop default, explicit third-party API profiles, MCP/skill metadata parity, and no fake connector authorization.
- Verification: current marketing-doc search finds no `DeepCodex` / `deepcodex` / `DeepSeek-only` residues outside the legacy folder; documentation whitespace check passed.

## 2026-06-23 Chat/Responses Compatibility Doc Refresh
- Completed: rewrote `docs/chat-to-responses-compat.md` from a legacy DeepCodex-to-DeepSeek note into the current Anti-Codex provider compatibility contract.
- Completed: the doc now covers Antigravity default, OpenAI-compatible and Anthropic-compatible provider shapes, structured tool-history preservation across provider switches, and the boundary between metadata parity and connector authorization.
- Completed: the legacy `deepcodex.reasoning.hex.v1:` replay prefix is documented as an internal compatibility token, not user-facing branding.

## 2026-06-23 DeepSeek Failure Notes Legacy Marker
- Completed: marked `docs/DEEPSEEK_RUNTIME_FAILURE_NOTES.md` as legacy route notes so it is not mistaken for the current Anti-Codex default provider description.
- Completed: the marker states the current default: local Antigravity Desktop provider, explicit third-party profiles, and no mutation of the original Codex installation.

## 2026-06-23 Windows Doc Compatibility Clarification
- Completed: clarified that the `codex-home-deepseek-app` runtime path segment is legacy compatibility state and does not imply the current default provider.
- Completed: clarified that Anti-Codex does not fake connector authorization; connector-backed app tools remain unavailable until the real connector is authorized.

## 2026-06-23 Public Documentation Contract Test
- Completed: launcher contract coverage now includes current public docs: `README.md`, `docs/ADAPTIVE_ONE_API_STACK.md`, `docs/chat-to-responses-compat.md`, and the current marketing entry points.
- Completed: the new test explicitly avoids recursive scans of audits, legacy marketing, prompt samples, and historical specs while requiring current docs to preserve Anti-Codex branding, Antigravity default provider language, explicit third-party provider language, and connector/app-tool authorization boundaries.
- Verification: `node --check translator/tests/anticodex-launcher.test.mjs` passed; focused launcher contract suite passed `91/91`.

## 2026-06-23 README Provider Boundary Refresh
- Completed: README now explicitly documents that Antigravity Desktop remains the default route, third-party API profiles must be configured/tested/applied through Anti-Codex Manager, and unreadable profiles must not cause a silent wrong-upstream fallback.
- Completed: README now states that MCP/skills/plugin/connector metadata sync does not grant connector-backed app-tool authorization.

## 2026-06-23 Fast Source Preflight Public Docs Gate
- Completed: `test-anticodex-source-preflight.ps1` now runs a lightweight public-documentation contract check even when `-SkipFullRegression` is used.
- Completed: the fast check uses an explicit current-doc whitelist instead of recursive `docs/**` scans, so historical audits, legacy marketing, and prompt samples can keep old evidence without breaking the gate.
- Verification: PowerShell parser check passed; launcher contract suite passed `91/91`; fast source preflight passed with `publicDocumentation.ok:true` and translator regression skipped by design.

## 2026-06-23 Public Docs Gate Diagnostics Surfacing
- Completed: source-preflight summaries now expose `publicDocumentationOk` through the translator diagnostics payload and diagnostic bundle report summaries.
- Completed: diagnostics verification and launcher contract coverage now require the new public-documentation summary field so the fast docs gate is visible outside the raw source-preflight report.

## 2026-06-23 README Upstream Profile Wording
- Completed: corrected README third-party API wording to match the implementation: the formal entry is Anti-Codex Manager, which tests, saves, and applies an `upstream profile`; lower-level scripts are controlled write/restart helpers, not the user-facing setup route.
- Verification: adaptive-server syntax check passed; diagnostics PowerShell parser checks passed; launcher contract suite passed `91/91`.

## 2026-06-23 Installed Overall Public Docs Signal
- Completed: installed overall now directly checks `/anticodex/diagnostics` for `sourcePreflight.publicDocumentationOk`, including fast mode where the standalone diagnostics verifier is skipped.
- Completed: launcher contract coverage now requires the installed overall public-doc signal so the fast source-preflight docs gate remains visible in combined acceptance reports.

## 2026-06-23 Manager Latest Reports Public Docs Signal
- Completed: Manager latest report payload now carries `publicDocumentationOk` and `publicDocumentationFailureCount` for `latest-source-preflight.json`.
- Completed: embedded Manager, external Manager injection, and Manager bridge summaries now show the public-documentation status line for source-preflight reports.

## 2026-06-23 Manager Latest Reports Short Gate
- Completed: `anticodex-manager-bridge.mjs --self-test` now proves `viewLatestReports` summaries preserve the source-preflight public-documentation field for both pass and failure states.
- Completed: the source preflight fast gate now runs the Manager bridge self-test, so report-summary regressions are caught without opening the desktop UI or running installed overall.
- Completed: the Manager button verifier self-test now rejects source-preflight latest-report text that omits the `公开文档` field-level result.
- Completed: `README_EN.md` now carries the same default-provider, third-party upstream profile, and connector authorization boundaries as the main README and is included in public documentation checks.
- Verification: Manager button self-test passed; Manager bridge self-test passed; launcher contract suite passed `91/91`; source preflight fast mode passed with `managerBridgeSelfTest.ok:true` and `publicDocumentation.ok:true`.

## 2026-06-23 Legacy Marketing Boundary Marker
- Completed: the historical DeepCodex / DeepSeek video script under `docs/marketing/legacy` now has an explicit archive marker saying it is not a current Anti-Codex launch asset.
- Completed: public-documentation preflight and launcher contracts now require that marker, while current marketing entry points continue to reject legacy DeepCodex / DeepSeek-only claims.

## 2026-06-23 Manager Real Buttons Diagnostic Summary
- Completed: diagnostic bundle report summaries now preserve `actions`, `managerButtonOk`, and per-action `managerButtonResults` for `latest-manager-real-buttons.json`.
- Completed: the diagnostics verifier now requires `latest-manager-real-buttons.json` to be present, named `manager-real-buttons`, green, failure-free, and to include real `mcpSkills` plus `pluginCapabilities` button evidence without `lastUiOnly:true`.
- Completed: diagnostic bundle summary parsing now uses `scripts/summarize-anticodex-report.mjs` instead of Windows PowerShell 5.1 parsing full large report JSON, avoiding false damaged-report failures on valid connector/app-tool-heavy reports.
- Verification: PowerShell parser check passed; `node scripts/summarize-anticodex-report.mjs` extracted real Manager button evidence; launcher contract suite passed `91/91`; runtime sync restarted Anti-Codex successfully; installed `test-anticodex-diagnostics.ps1 -VerifyBundle -TimeoutSec 20` passed with bundle `20260623-014140.zip`.

## 2026-06-23 Provider Continuity Diagnostic Evidence
- Completed: third-party provider verification now asserts structured tool-history ordering and protocol shape, proving OpenAI-compatible `assistant.tool_calls`/`role:"tool"` pairs and Anthropic `tool_use`/`tool_result` pairs stay matched without protocol cross-contamination.
- Completed: diagnostic bundle summaries now include `latest-third-party-provider.json` continuity evidence: 9 turns, save/restart/provider-switch continuity, OpenAI->Anthropic and Anthropic->OpenAI switches, clean structured tool-pair evidence, and secret redaction.
- Completed: installed overall report-integrity checks now include `latest-third-party-provider.json`.
- Completed: Manager `fastOverallNoTraffic` now keeps UI-state coverage while using a bounded short-check budget: `-SubcheckTimeoutSec 30` and `-FastMaxElapsedMs 90000`.
- Completed: installed overall skipped subchecks now carry `behaviorCovered:false` and `coverageKind:"skipped"` so fast reports cannot be mistaken for behavior-complete coverage.
- Completed: third-party provider verification now requires all prior history markers at provider switch turn 7, OpenAI-compatible to Anthropic turn 8, and Anthropic back to OpenAI-compatible turn 9. The latest local fake-provider proof checked 16, 18, and 20 markers respectively.
- Verification: JS checks passed for provider and summarizer scripts; PowerShell parser checks passed for diagnostics/installed-overall scripts; launcher contract suite passed `91/91`; local fake-provider verifier passed in about 6s and refreshed the installed latest report; runtime sync restarted Anti-Codex successfully; installed diagnostics bundle verification passed with provider continuity evidence in `20260623-014948.zip`.

## 2026-06-23 Passive Release Gate Summary
- Completed: added `scripts/test-anticodex-release-gates.mjs`, a read-only latest-report summarizer that writes `latest-release-gates.json` without running any long verifier, model traffic, Manager click, soak, or cold relaunch.
- Completed: release gates are grouped as `short`, `no-traffic`, `real-traffic`, `manager`, `soak`, and `cold`, with hash/fresh/ok checks plus semantic checks for `fast+noTraffic`, `skipRequests`, `usedRealTraffic`, and real Manager button evidence.
- Completed: Manager latest reports and diagnostic bundles now include `latest-release-gates.json`; diagnostics exposes `shortReady`, `releaseReady`, `missingRequired`, and `damagedReports`.
- Verification: release gate script passed syntax and generated `shortReady:true`, `releaseReady:false` with missing long-gate evidence listed; launcher contract suite passed `92/92`; runtime sync restarted Anti-Codex successfully; installed diagnostics bundle verification passed with release-gate summary in `20260623-020134.zip`.

## 2026-06-23 Cold Relaunch Latest Report Surface
- Completed: `test-anticodex-cold-relaunch.ps1` now writes signed latest/history JSON reports as `latest-cold-relaunch.json` plus `.sha256` through the shared atomic report writer.
- Completed: Manager latest reports, diagnostic bundles, installed overall report-integrity checks, and passive release gates now surface the cold relaunch report when it exists.
- Completed: cold relaunch remains optional for passive release readiness because it is an isolated restart verifier, not a read-only latest-report check.

## 2026-06-23 MCP Path Drift and No-Traffic Overall
- Completed: `sync-shared-codex-config.mjs` now repairs missing absolute MCP command paths by finding an existing sibling executable under the same Codex `bin` root, fixing stale `node_repl.exe` version directories after native Codex updates.
- Completed: refreshed Anti-Codex local features so MCP/skills now point at the existing `node_repl.exe`; standalone MCP/Skill, plugin/app-tool, and Manager real-button checks pass without granting connector authorization.
- Completed: installed no-traffic overall is green again; passive release gates no longer list `installedOverallNoTraffic` as missing.
- Completed: existing fresh green real-traffic reports were given `.sha256` sidecars without modifying report JSON; passive release gates now report `shortReady:true`, `releaseReady:true`, no missing required gates, and no damaged reports.
- Completed: added `sign-anticodex-reports.mjs` so legacy green reports can be signed reproducibly; it defaults to dry-run and writes sidecars only with `--write` for parseable `ok:true` reports.
- Completed: passive release gates now enforce field-level local connector and plugin capability semantics, including ChatGPT install URL scrubbing, metadata-only connector link endpoints, zero local-endpoint upstream traffic, no native Codex writeback, no unauthorized app tools, and shared/local connector plus app-tool parity.
- Completed: diagnostic bundle summaries and Manager latest-report summaries now surface the same connector/app-tool field evidence, including local endpoint upstream request count, allowlist-not-authorization state, hidden/tool names, unauthorized and unattributed app-tool counts, native Codex writeback, and parity cleanliness.
- Verification: release gate script syntax passed; launcher contract suite passed `92/92`; `test-anticodex-release-gates.mjs --strict` stayed green with `shortReady:true`, `releaseReady:true`, and empty `missingRequired` / `damagedReports`.

## 2026-06-23 Optional Real Provider and Antigravity Return Verification
- Completed: added `test-anticodex-real-third-party-provider.mjs`, an explicit opt-in real provider smoke verifier that uses an isolated temporary state/profile/translator and never modifies the installed Anti-Codex profile or original Codex.
- Completed: real provider credentials are accepted only through a named environment variable. Command-line API keys, ChatGPT login hosts, credential-bearing URLs, query parameters, fragments, and non-HTTPS remote URLs are rejected before traffic.
- Completed: the real provider verifier checks two-turn `previous_response_id` continuity, writes signed reports, marks skipped runs as behavior not covered, and scans the report for the actual API key before publishing.
- Completed: added `test-anticodex-provider-antigravity-return.ps1`. It keeps the existing nine local provider turns, restores Antigravity in the same temporary state, restarts the isolated translator, and can send one explicit real turn 10 using turn 9's response ID.
- Hardened: turn 10 asks for semantic positions from prior history without including the expected marker values in the current prompt, preventing a false pass from simple prompt echo.
- Verification: launcher contracts passed `94/94`; local nine-turn provider regression passed in about 6 seconds; both new real-traffic paths defaulted to signed `ok:true, skipped:true, behaviorCovered:false` reports; negative key/URL tests failed before traffic and did not leak the test key.
- Deferred by design: no paid third-party request and no real Antigravity turn 10 were run in this change. Both require explicit real-traffic opt-in.
- Completed follow-up: Manager latest reports and diagnostic bundle collection now include `latest-real-third-party-provider.json` and `latest-provider-antigravity-return.json` when present. They remain optional and were not added to release-required gates.
- Completed follow-up: fast source preflight now executes `test-anticodex-upstream-profile.ps1` as `checks.upstreamProfileStorage`. This makes corrupt profile/key fail-closed behavior, explicit Antigravity recovery, history preservation, and original APPDATA isolation part of the routine short gate.
- Verification: the named launcher contract passed; the profile storage test passed directly; fast source preflight passed in 21.7 seconds with `upstreamProfileStorage.ok:true`, exit code 0, no timeout, and zero failures.
- Fixed follow-up: `/v1/responses` now preserves `response_history_missing` as the outer error type for missing/pruned `previous_response_id` instead of collapsing it to `gateway_error` in third-party mode.
- Added integration proof: HTTP 410, `retryable:false`, original `previous_response_id`, recovery guidance, and zero upstream requests are asserted together.

## 2026-06-23 Installed Missing-History Recovery Gate
- Completed: added `test-anticodex-missing-history.mjs`, an installed no-traffic verifier for pruned or unavailable `previous_response_id` state.
- Completed: the verifier requires HTTP 410, outer `response_history_missing`, `retryable:false`, the original response ID, recovery guidance, and an unchanged model-route fingerprint before/after the probe.
- Completed: signed `latest-missing-history.json` evidence is included in installed overall, diagnostics collection, Manager latest reports, and required short/release passive gates.
- Verification: source and installed probes passed with `usedRealTraffic:false`; launcher contracts passed `96/96`; installed strict passive gates reported `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, and `damagedReports:[]`.
- Completed: refreshed the native Manager panel to `native-panel-v85`, added a latest-report summary refresh stamp, and relaxed the real-button acceptance around the current missing-history evidence instead of stale public-doc text.
- Completed: passive release gates now validate missing-history semantics directly: HTTP 410, `response_history_missing`, `retryable:false`, original response ID match, recovery guidance, unchanged route fingerprint, no real traffic, and `coverageKind:"installed-no-traffic"`.
- Verification: source and installed `viewLatestReports` button checks passed, installed fast UI state passed, release-gate strict mode passed with `shortReady:true`, `releaseReady:true`, no missing required gates, and no damaged reports.

## 2026-06-23 Release Gate Negative Self-Tests
- Completed: `test-anticodex-release-gates.mjs --self-test` now rejects forged signed `ok:true` reports for no-traffic gates, missing-history recovery, local connector allowlists, and plugin/app-tool capabilities.
- Completed: no-traffic release gates now reject explicit contradictory evidence: `usedRealTraffic:true`, `behaviorCovered:false`, or `coverageKind:"real-traffic"` while leaving older reports without those fields compatible.
- Verification: release-gate syntax passed; release-gate self-test reports expected semantic failures for all four forged report classes; focused launcher contract passed; strict passive gates remain green with `shortReady:true`, `releaseReady:true`, no missing required gates, and no damaged reports.

## 2026-06-23 Custom Agents Skill Root Sync
- Completed: `refresh-anticodex-local-features.ps1` now passes its `-AgentsSkillsPath` value into `sync-shared-codex-plugin-host.mjs` through `ANTICODEX_EXTRA_SKILLS_ROOTS` for the local snapshot copy step, then restores the prior environment value.
- Completed: this keeps custom `.agents\skills` roots consistent between copy and verification while preserving Anti-Codex-local extra skills instead of forcing strict equality.
- Verification: PowerShell parser check passed and the focused MCP/skills launcher contract passed.

## 2026-06-23 Third-Party Provider Release Semantics
- Completed: passive release gates now validate `latest-third-party-provider.json` field-level continuity evidence instead of trusting only signed `ok:true`.
- Completed: the gate requires nine fake-provider turns, save/restart/provider-switch/protocol-switch/reverse-switch history preservation, stale Antigravity model rejection, structured OpenAI and Anthropic tool-pair evidence, late-turn marker coverage, and secret redaction.
- Verification: release-gate syntax passed; self-test rejects a forged bad third-party provider report; focused launcher contract passed; strict passive gates remain green with `shortReady:true`, `releaseReady:true`, no missing required gates, and no damaged reports.

## 2026-06-23 Provider Marker Coverage Visibility
- Completed: `summarize-anticodex-report.mjs` now exposes third-party provider late-turn all-history marker coverage booleans and counts for turns 7, 8, and 9.
- Completed: diagnostic bundle verification now requires those marker coverage fields to be visible and at least `16/18/20`, matching the release-gate semantic contract.
- Verification: summarizer syntax passed, latest third-party provider summary shows marker counts `16/18/20`, diagnostics PowerShell parser check passed, and focused diagnostics launcher contracts passed.

## 2026-06-23 Manager Release/Provider Visibility
- Completed: Manager latest reports now includes `latest-third-party-provider.json`, not only optional real-provider reports.
- Completed: Manager latest-report payload/text now surfaces release gate readiness, missing short/release gates, semantic failure details, and third-party provider continuity marker/tool-pair evidence.
- Completed: diagnostic collection and verification now preserve `missingShort` plus concise release-gate semantic failure details.
- Verification: adaptive-server and report-summarizer syntax passed; diagnostics parser passed; full launcher contract suite passed `96/96`; `git diff --check` passed.

## 2026-06-23 Optional Real-Traffic Report Semantics
- Completed: optional real third-party provider and provider-to-Antigravity reports now distinguish default no-traffic skip (`ok:true`, `requestedRealTraffic:false`) from an explicitly requested real-traffic run that did not execute (`ok:false`, `requestedRealTraffic:true`).
- Completed: skipped optional reports carry `behaviorCovered:false`, `coverageKind:"skipped"`, `usedRealTraffic:false`, and stable `failures` arrays so dashboards and scripts cannot treat a requested-but-uncovered run as proof.
- Completed: passive release gates include optional real-traffic report semantics without making those reports release-required; forged `ok:true` requested-but-skipped reports are rejected by `--self-test`.
- Verification: JS syntax checks passed; PowerShell scriptblock parser checks passed; release-gate `--self-test` passed; strict passive gate summary stayed `shortReady:true`, `releaseReady:true`; focused launcher contracts passed; default skip and opt-in-missing-argument behavior checks passed.

## 2026-06-23 Connector Cache Drift Refresh
- Observed: plugin capability verification failed because shared connector cache had advanced while the Anti-Codex local connector snapshot was stale.
- Completed: `refresh-anticodex-local-features.ps1` refreshed skills, guidance, MCP metadata, connector cache, plugin cache, and app-tool cache without granting connector authorization.
- Verification: plugin capability verification passed after refresh with connector parity `5765/5765`, app-tool parity `58/58`, accessible connectors `0`, unauthorized app tools `0`, and callable app tools `0`; MCP/Skill verification also passed.

## 2026-06-23 MCP/Skill and Optional Real-Traffic Evidence Surface
- Completed: report summaries, diagnostic bundles, and Manager latest-report payload/text now surface MCP/Skill evidence: MCP shared counts, missing/extra local counts, node_repl presence, MCP smoke/real-call status, shared skill counts, `.agents` skill counts, missing shared skills, and skill smoke readability.
- Completed: passive release gates now validate MCP/Skill field-level semantics instead of trusting signed `ok:true`: shared MCP and skills must be present, `.agents` skills must be counted, missing shared entries must be empty, node_repl must exist, MCP smoke plus real node_repl call must pass, and skill smoke must be readable.
- Completed: passive release gates now validate source-preflight field-level semantics: JavaScript syntax, PowerShell syntax, UI state self-test, upstream profile storage, public documentation, translator regression status, and git diff whitespace evidence must all be present and green.
- Completed: source-preflight summaries, diagnostics, and Manager latest reports now surface `upstreamProfileStorageOk` so profile storage fail-closed coverage is visible outside raw JSON.
- Completed: Manager latest reports now also includes `latest-sync-readiness.json` and `latest-model-routing.json`, making those no-traffic release gates visible without opening raw report files.
- Completed: optional real third-party provider summaries now surface first/second marker observation, history continuation, redaction, and turn count.
- Completed: optional provider-to-Antigravity return summaries now surface real Antigravity turn use, history return, previous response ID match, marker counts, missing marker count, route transport, and resolved model.
- Completed: plugin capability summaries and Manager latest reports now include parity drift counts and sample IDs for connector parity, app-tool parity, and GET/POST app-tool mismatches.
- Completed: diagnostics verification now actively requires MCP/Skill evidence and plugin parity drift sample fields. Optional real-provider and Antigravity-return continuity evidence is required whenever those optional reports are present and not skipped.
- Completed: passive release-gate self-test now rejects forged optional real-provider and Antigravity-return reports with bad marker/history/route evidence, not only requested-but-skipped reports.
- Verification: syntax/parser checks passed; release-gate `--self-test` passed with source-preflight, MCP/Skill, optional real-provider, and optional Antigravity-return semantic classes; refreshed source-preflight passed with `upstreamProfileStorage.ok:true`; strict passive gates stayed `shortReady:true`, `releaseReady:true`; focused launcher contracts and dynamic summarizer fixture tests passed; diagnostic bundle verification passed with bundle `20260623-063025.zip` and MCP/Skill evidence in the compact result.

## 2026-06-23 Model-Routing No-Traffic Evidence Surface
- Completed: model-routing report summaries, diagnostic bundles, and Manager latest-report payload/text now surface route mode, provider protocol/model, tool-bridge mode, per-model result count, skipped-request count, failed-result count, and result-error count.
- Completed: passive release gates now validate model-routing no-traffic semantics directly: `skipRequests:true`, non-empty model catalog, mode present, per-model results present, every result skipped, no failed result, and no result error.
- Verification: JavaScript syntax checks passed; PowerShell parser checks passed; release-gate `--self-test` rejects forged bad model-routing reports; strict passive gates remain `shortReady:true`, `releaseReady:true` with no model failures; focused launcher/summarizer tests passed; source diagnostics verifier passed.

## 2026-06-23 Tool-Bridge No-Traffic Evidence Surface
- Completed: tool-bridge report summaries, diagnostic bundles, and Manager latest-report payload/text now surface native bridge mode, transport, local adapter, native event/discovery/default flags, compatibility bridge, automatic permission mode, same-Cascade resume proof, owned-tool disablement, permission-prompt disablement, disabled-tool count, and Codex bridge adapter.
- Completed: passive release gates now validate tool-bridge semantics directly instead of accepting any signed `ok:true` report.
- Verification: JavaScript syntax checks passed; PowerShell parser checks passed; release-gate `--self-test` rejects forged bad tool-bridge reports; strict passive gates remain `shortReady:true`, `releaseReady:true` with no tool-bridge failures; focused launcher/summarizer tests passed.

## 2026-06-23 Model-Thinking No-Traffic Evidence Surface
- Completed: model-thinking report summaries, diagnostic bundles, and Manager latest-report payload/text now surface expected/actual model counts, thinking-capable count, missing-budget count, missing-reasoning-level count, and reasoning-level set.
- Completed: passive release gates now validate model-thinking semantics directly: expected/actual counts, model entry count, unique IDs, display names, reasoning levels, thinking support, and thinking budget >= minimum budget.
- Verification: JavaScript syntax checks passed; PowerShell parser checks passed; release-gate `--self-test` rejects forged bad model-thinking reports; strict passive gates remain `shortReady:true`, `releaseReady:true` with no model-thinking failures; focused launcher/summarizer tests passed; source diagnostics verifier passed; latest summary shows `8/8` thinking models, `0` missing budgets, and reasoning levels `high/low/medium/xhigh`.

## 2026-06-23 UI-Idle No-Traffic Evidence Surface
- Completed: UI-idle report summaries, diagnostic bundles, and Manager latest-report payload/text now surface duration, interval, sample count, healthy sample count, reconnect-text count, login-text count, and missing-model-text count.
- Completed: passive release gates now validate UI-idle semantics directly: minimum duration, sample presence, all samples healthy/account-ready/UI-ok, model count present, no reconnect/login text, and matched model text present.
- Verification: JavaScript syntax checks passed; PowerShell parser checks passed; release-gate `--self-test` rejects forged bad UI-idle reports; strict passive gates remain `shortReady:true`, `releaseReady:true` with no UI-idle failures; focused launcher/summarizer tests passed; source diagnostics verifier passed; latest summary shows `10s`, healthy `1/1`, reconnect/login text `0/0`, and missing model text `0`.

## 2026-06-23 Sync-Readiness No-Traffic Evidence Surface
- Completed: sync-readiness reports now self-attest `reportName:"sync-readiness"`, `noTraffic:true`, `usedRealTraffic:false`, `behaviorCovered:true`, and `coverageKind:"installed-no-traffic"` in full mode.
- Completed: report summaries, diagnostic bundles, and Manager latest-report payload/text now surface active host, brand, icons, scripts, update/guardrail state, shortcut counts, Manager bridge state, and clean sync/rollback state.
- Completed: passive release gates now validate sync-readiness semantics directly, including full-mode no-traffic attestation, active/source hash match, operation success, rollback host/brand/icon proof, shortcut inventory, Manager bridge base URL, and no stale swap/candidate state.
- Verification: syntax/parser checks passed; release-gate `--self-test` rejects forged bad sync-readiness reports; full sync-readiness verifier refreshed the report; strict passive gates remain `shortReady:true`, `releaseReady:true` with no sync failures; focused launcher/summarizer tests and source diagnostics verifier passed.

## 2026-06-23 Installed Overall No-Traffic Evidence Surface
- Completed: installed-overall reports now self-attest `usedRealTraffic:false`, `behaviorCovered:true`, and `coverageKind:"installed-no-traffic"` or `"installed-fast-no-traffic"` so passive gates can distinguish no-traffic coverage from optional real-traffic checks.
- Completed: report summaries, diagnostic bundles, and Manager latest-report payload/text now surface installed-overall report name, fast/no-traffic flags, coverage kind, check counts, skipped checks, missing skip metadata, and real-traffic checks intentionally skipped.
- Completed: passive release gates now validate installed-overall semantics directly and reject forged `ok:true` reports with missing attestation, failed checks, missing skip metadata, unexpected full-mode skips, or missing `realMiniTool`/`realWork` skip evidence.
- Completed: full installed overall no longer performs the long plugin/application Manager click inline; standalone plugin capability verification remains the authority, preventing Manager bridge stalls from poisoning later UI-idle samples.
- Verification: syntax/parser checks passed; release-gate `--self-test` rejects forged bad installed-overall reports; focused launcher/summarizer/diagnostics tests passed; source diagnostics verifier passed; refreshed full installed-overall passed with `usedRealTraffic:false`, `coverageKind:"installed-no-traffic"`, and strict passive gates report `shortReady:true`, `releaseReady:true`, no missing required gates, and no damaged reports.

## 2026-06-23 Provider Continuity Gate Hardening
- Completed: passive release gates now require third-party provider save/restart structure, not only boolean history flags: save and restart OpenAI-compatible tool evidence, restart tool-pair preservation, save/restart `previous_response_id`, and marker preservation after save/restart.
- Completed: optional real-provider and provider-to-Antigravity scripts now write explicit default skip reports with `reportName`, `requestedRealTraffic:false`, `usedRealTraffic:false`, `behaviorCovered:false`, and `coverageKind:"skipped"` so dashboards show "not run" instead of silence.
- Boundary: optional real-provider remains a two-turn real-traffic sanity check; the full nine-turn save/restart/provider-switch/protocol-switch matrix remains the local fake-provider release gate unless the user explicitly opts into real external traffic.
- Verification: release-gate syntax passed; release-gate `--self-test` rejects forged missing save/restart structure; focused launcher tests passed; default optional real-provider and provider-to-Antigravity skip reports were generated; strict passive gates report `shortReady:true`, `releaseReady:true`, no missing required gates, and no optional semantic failures.

## 2026-06-23 Optional Real Provider Route Evidence
- Completed: optional real third-party provider verification now records route evidence from `/anticodex/model-routes` after the real two-turn check: transport, provider protocol, requested model, resolved model, and status.
- Completed: passive release gates now reject a real-provider optional report unless it proves `transport:"upstream-provider"`, provider protocol present, requested/resolved model agreement, and `status:"success"`.
- Completed: report summaries, diagnostic verification, and Manager latest-report text now surface the optional real-provider route evidence when a non-skipped real-provider report exists.
- Verification: syntax/parser checks passed; release-gate `--self-test` rejects forged real-provider route evidence; focused summarizer/release-gate/verifier tests passed; strict passive gates remain `shortReady:true`, `releaseReady:true`; default skip report remains green and uses no real traffic.

## 2026-06-23 Cold Relaunch Optional Evidence Semantics
- Completed: passive release gates now validate `latest-cold-relaunch.json` semantically when the optional report exists: report name, empty failures, health/provider readiness, Antigravity or third-party mode readiness, process counts, required stages, and original Codex isolation proof.
- Completed: cold relaunch reports now carry explicit `originalCodex.unchanged`, `beforePids`, and `afterPids` fields instead of relying only on absence of an error string.
- Completed: report summaries, diagnostic verification, and Manager latest-report text now surface cold relaunch health, readiness, mode, process counts, failed stages, and original Codex isolation.
- Verification: no cold relaunch was run in this batch; syntax/parser checks passed; release-gate `--self-test` rejects forged cold reports; focused cold/summarizer/diagnostics/release-gate tests passed; strict passive gates remain `shortReady:true`, `releaseReady:true` with cold report absent and optional.

## 2026-06-23 Stability Soak Optional Evidence Semantics
- Completed: passive release gates now validate `latest-stability-soak.json` semantically when the optional report exists: report name, empty failures, provider/start/end readiness, stable translator PID, at least one health check, elapsed duration, successful turn list, and mode-specific model evidence.
- Completed: report summaries, diagnostic verification, and Manager latest-report text now surface stability-soak readiness, mode/model, PID stability, health-check count, turn count, failed-turn count, and elapsed time.
- Verification: no real stability soak was run in this batch; syntax/parser checks passed; release-gate `--self-test` rejects forged soak evidence; focused stability-soak summarizer/diagnostics/release-gate tests passed.

## 2026-06-23 Release Report List Parity
- Completed: release-gate group summaries now distinguish required and optional evidence counts, so optional cold/soak state cannot be confused with required release failure.
- Completed: `latest-model-thinking.json` is now included in diagnostic bundle collection, Manager latest reports, and installed-overall report-integrity checks. `latest-source-preflight.json` is also included in installed-overall report-integrity checks.
- Verification: JavaScript syntax checks passed; PowerShell parser checks passed for diagnostics and installed overall; release-gate `--self-test` passed; focused diagnostic/latest-report/installed-overall/model-thinking tests passed.

## 2026-06-23 Optional Real-Traffic Skip Semantics
- Completed: optional real-traffic skipped reports must explicitly state `requestedRealTraffic:false`, `usedRealTraffic:false`, `behaviorCovered:false`, and `coverageKind:"skipped"` before a skipped `ok:true` report can satisfy optional semantics.
- Verification: release-gate `--self-test` rejects forged skipped optional reports where real traffic was requested or not explicitly marked unrequested.

## 2026-06-23 External Manager Bridge Evidence Parity
- Completed: `anticodex-manager-bridge.mjs` latest-report summaries now surface release-gate group counts, source-preflight evidence, model-thinking evidence, MCP/Skill evidence, optional real-provider route/history evidence, provider-to-Antigravity return evidence, cold relaunch evidence, and stability-soak evidence.
- Verification: bridge syntax check passed; bridge `--self-test` passed with field-level latest-report fixtures; focused launcher Manager contract passed.

## 2026-06-23 Release Report Inventory Drift Guard
- Completed: diagnostic bundle collection, Manager latest reports, installed-overall report-integrity checks, and launcher contract tests now include every `requiredForRelease:true` latest report from the passive release gate, including real-traffic reports such as cancellation, web tools, native multi-tool, custom tool, real mini-tool, and real work.
- Completed: `anticodex-manager-inject.js` now mirrors the external bridge latest-report field evidence so the injected panel and bridge path do not diverge.
- Completed: added a dynamic launcher contract that parses release-gate required reports and fails if any are missing from diagnostics, Manager, installed-overall integrity checks, or launcher contract coverage.
- Verification: JS syntax checks passed for bridge, inject, and adaptive server; PowerShell parser checks passed for diagnostics and installed overall; bridge `--self-test` passed; focused report-inventory/Manager/diagnostics/overall tests passed.

## 2026-06-23 Manager Report Failure Detail Parity
- Completed: in-app, external bridge, and injected Manager latest-report summaries now surface release failure detail consistently: `missingShort`, `damagedReports`, release-gate semantic failures, source-preflight UI/regression/diff/skip evidence, and model-thinking reasoning levels.
- Completed: standalone injected Manager summary now also shows missing/invalid report totals, treats unparseable latest reports as damaged, and surfaces native Codex writeback evidence for plugin capability reports.
- Completed: optional and special latest reports now have a separate visibility guard. Optional gate reports stay non-required for release readiness but must remain visible in diagnostics, Manager latest reports, and installed-overall report-integrity checks.
- Verification: bridge/inject/adaptive syntax passed; bridge `--self-test` passed with failure-detail fixtures; focused Manager and release-report inventory contracts passed.

## 2026-06-23 Manager MCP/Skill and App-Tool Drift Detail Parity
- Completed: external bridge and injected Manager latest-report summaries now mirror the in-app summary for MCP/Skill operational evidence: `.agents` skill count, MCP smoke, real node_repl call smoke, and skill readability.
- Completed: external bridge and injected Manager summaries now show connector/app-tool parity drift counts and short samples when plugin capability parity is dirty, matching the in-app Manager summary.
- Completed: local feature refresh now parses MCP server names with the same anchored TOML section rule as the MCP/Skill verifier, so `[mcp_servers.x.tools.y]` subtables are not counted as standalone MCP servers.
- Completed: MCP/Skill verifier now requires the DeepSeek and Antigravity worker MCP servers to expose their expected implementation/status tools, not just any non-empty tools/list response.
- Completed: MCP/Skill verifier now hashes global guidance files (`AGENTS.md`, `DEFAULT_SKILL_ALLOWLIST.md`, `RTK.md`, `MCP_WORKER_USAGE_GUIDE.md`) and fails if Anti-Codex local copies drift from the shared originals.
- Completed: plugin capability parity now detects same-ID connector/app-tool content drift via per-record hashes. Changed shared records are included in summaries, Manager latest-report drift lines, and passive release-gate semantics.
- Completed: local skill snapshot sync now detects duplicate top-level skill names across shared `.codex\skills` and extra `.agents\skills` roots; same-name skills with different content fail the copy instead of silently letting one root override the other.
- Completed: MCP/Skill verifier now also reports duplicate skill names and conflicting duplicate names across shared `.codex\skills` and `.agents\skills`, so runtime verification catches same-name content drift rather than only missing directories.
- Completed: MCP/Skill verifier now compares same-name shared/local MCP `command`, `args`, and `env` config fields and reports `changedShared` drift instead of accepting matching server names alone.
- Completed: release-gate report consumption now has an `effectiveOk` guard. A non-strict `latest-release-gates.json` with `ok:true` but `releaseReady:false` is shown as needing action in summaries/Manager, and diagnostics rejects it as not release-ready.
- Completed: launcher contracts now execute `test-anticodex-release-gates.mjs --self-test` instead of only matching self-test strings, so forged-report semantic guards are exercised in routine focused tests.
- Completed: third-party provider verifier now adds ordered role/history checks for provider switch turn 7, OpenAI-compatible to Anthropic turn 8, and Anthropic back to OpenAI-compatible turn 9. Summaries, diagnostics, and release-gate semantics now require that ordered evidence, not only full-text marker presence.
- Completed: startup snapshot refresh now keeps an existing local snapshot only when its stored source manifest fingerprint matches the current shared source. If shared skill content changes, `--startup-snapshots` refreshes the local copy instead of marking stale content fresh.
- Completed: duplicate skill detection now treats symlink/junction entries that resolve to directories as skill directories, so linked `.agents\skills` entries cannot bypass conflict detection.
- Completed: local feature refresh now hash-checks connector directory and app-tool cache content against the shared source after refresh. If the shared cache exists but the local snapshot is missing or differs, refresh reports a failure instead of only returning counts.
- Completed: MCP `changedShared` drift and conflicting duplicate skill names are now consumed by summaries, diagnostics, Manager bridge/injected panels, and passive release-gate semantics instead of living only in raw reports.
- Completed: refresh-feature connector/app-tool cache parity now surfaces as `refreshFeatureEvidence` in summaries, diagnostics, Manager bridge/injected panels, and release-gate self-tests.
- Completed: script-level local connector/app-tool verifier reports now carry `reportName`, no-real-traffic coverage semantics, linked/allowlisted/hidden connector evidence, GET/POST tool parity, and upstream-request absence; diagnostics and passive release gates reject forged reports that omit or contradict those fields.
- Completed: third-party provider restart continuity now has direct turn-6 evidence. The fake-provider verifier records ordered role history and full marker coverage immediately after translator restart, and summaries, diagnostics, Manager latest reports, and passive release gates consume those fields instead of relying on turn-7 provider-switch evidence as an indirect proxy.
- Completed: source preflight now runs the script-level local connector/app-tool verifier and writes its report into the same report root, so short/release preflight refreshes the local no-real-traffic connector evidence instead of only trusting an older latest report.
- Completed: optional real-provider and provider-to-Antigravity return reports now have report-name semantics in passive release gates and diagnostics, so a wrong report payload cannot satisfy the optional real-traffic evidence slot just by carrying marker/route fields.
- Completed: `latest-refresh-features.json` is now release-required instead of optional, so passive release readiness fails when current shared-to-local feature synchronization evidence is missing, stale, unsigned, or semantically dirty.
- Current release-gate status after the refresh-features hardening: the first strict check correctly exposed stale short evidence for `sourcePreflight`, `mcpSkills`, `localConnectors`, and `thirdPartyProvider`. Bounded reruns refreshed source preflight/local connector evidence in about 21 seconds, MCP/Skill evidence in about 5 seconds, and the local fake third-party provider matrix in about 6 seconds; strict passive release gates are back to `shortReady:true` / `releaseReady:true` with `missingRequired:[]` and `damagedReports:[]`.
- Completed: passive release gates now support `--strict-optional-real-traffic`. Default `--strict` remains release-required/no-traffic stable, while the explicit optional flag also requires optional real-provider and provider-to-Antigravity reports to be real-traffic, behavior-covered, signed, fresh, and semantically clean. Summaries, diagnostics, and Manager latest reports surface `strictOptionalRealTraffic`, `optionalRealTrafficReady`, and `optionalRealTrafficFailures`.
- Earlier verification before the latest release-required refresh-features hardening: bridge/inject/adaptive/summarizer syntax passed; refresh-feature, MCP/Skill, and plugin-capability PowerShell parser checks passed; bridge `--self-test` passed; release-gate `--self-test` and strict passive release gates passed; focused Manager/MCP/Skill/plugin contracts passed. The first stricter plugin run caught stale connector cache drift, `refresh-anticodex-local-features.ps1` refreshed local snapshots, and the rerun passed with connector parity `5760/5760`, app-tool parity `58/58`, `missingShared:[]`, `extraLocal:[]`, `changedShared:[]`.

## 2026-06-23 Source Snapshot Release Evidence
- Completed: refresh-feature, MCP/Skill, and plugin-capability reports now carry the same `sourceSnapshot` evidence: source fingerprint, max source mtime, file count, and covered source groups for shared config, skills, `.agents` skills, connector cache, app-tool cache, and global guidance files.
- Completed: passive release gates now reject missing source snapshots and mismatched source fingerprints across `latest-refresh-features.json`, `latest-mcp-skills.json`, and `latest-plugin-capabilities.json`, so feature-sync, skill, and connector evidence must come from the same inherited Codex surface.
- Completed: summaries, diagnostics, adaptive Manager latest reports, and launcher contracts surface or require source snapshot evidence. `refresh-anticodex-local-features.ps1 -VerifyOnly` can produce evidence without copying when no parity drift needs repair.
- Verification: PowerShell parser checks passed for the new helper plus refresh/MCP/plugin/diagnostics scripts; JS syntax checks passed for release gates, summarizer, and adaptive server; release-gate `--self-test` passed; focused launcher contracts passed `11/11`; full refresh repaired stale connector snapshot parity and then passed; MCP/Skill and plugin-capability reports both carried fingerprint `7255ed564418...`; strict passive release gates are `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, and all three source fingerprints match.
- Operational note: a full local feature refresh can take about 72 seconds on the current machine because it copies/verifies roughly 15.6k inherited files plus connector/app-tool caches. Prefer narrow verifier reruns or `-VerifyOnly` for routine checks, and run the full refresh only when parity drift is detected.
- Completed follow-up: external Manager bridge and injected Manager summaries now also display `sourceSnapshotEvidence` as file count plus fingerprint prefix, matching the in-app Manager latest-report surface.
- Verification follow-up: bridge/inject syntax checks passed; Manager bridge `--self-test` now asserts the rendered source snapshot line; focused launcher Manager/MCP/plugin contracts passed `4/4`.

## 2026-06-23 Provider Continuity Visibility and ID Hardening
- Completed: passive release gates now require provider-switch, protocol-switch, and reverse-protocol-switch `previous_response_id` continuation evidence, in addition to save/restart continuation evidence.
- Completed: report summaries and diagnostics now expose and verify `previousResponseContinuity` for save, restart, provider switch, protocol switch, and reverse protocol switch, including nested switch-field consistency.
- Completed: in-app, external bridge, and injected Manager summaries now show provider continuity tool-pair status with restart evidence, marker thresholds, ordered-history counts, and source snapshot parity where applicable. Diagnostic bundle collection now also preserves source snapshot and refresh-feature evidence in report summaries.
- Verification: JS syntax checks passed for release gates, summarizer, adaptive server, bridge, and injected panel; PowerShell parser checks passed for diagnostics and diagnostic collection; release-gate `--self-test` passed with new continuation failures; focused launcher contracts passed `13/13`; strict passive release gates remain `shortReady:true`, `releaseReady:true`, and the third-party provider gate has no semantic failures.

## 2026-06-23 Optional Real-Traffic Visibility and Skip Semantics
- Completed: in-app Manager, external Manager bridge, and injected Manager summaries now show optional real-provider requested/resolved route models, redaction evidence, provider-to-Antigravity return route, and provider continuity previous-ID status.
- Completed: diagnostic verification now checks skipped optional real-provider and provider-to-Antigravity reports for `requestedRealTraffic:false`, `usedRealTraffic:false`, `behaviorCovered:false`, `coverageKind:"skipped"`, plus skip reason and `coveredBy`.
- Completed: passive release-gate self-test now includes a separate forged skipped provider-to-Antigravity return report, so both optional real-traffic report classes have skipped-report negative coverage.
- Completed follow-up: passive release gates now require skipped optional real-traffic reports to carry skip metadata (`reason` and `coveredBy`), matching diagnostic bundle verification.
- Verification: JS syntax checks passed; diagnostics parser checks passed; Manager bridge self-test passed; release-gate `--self-test` passed with `optionalAntigravitySkipped` and `optional_skipped_metadata_missing` failures; focused launcher contracts passed; strict passive gates remain `shortReady:true`, `releaseReady:true`, while `optionalRealTrafficReady:false` correctly reflects that real optional traffic was not requested.

## 2026-06-23 Optional Release Gap Visibility Follow-Up
- Completed: passive release-gate payloads and summaries now surface non-blocking optional gaps as `missingOptional`, so `releaseReady:true` no longer hides an absent optional report such as cold relaunch.
- Completed: diagnostic collection and verification preserve `missingOptional`, and Manager summary paths already display it beside `missingRequired`, `missingShort`, and damaged reports.
- Completed: added a static Manager source guard for known mojibake tokens after cleaning the post-verification action text path.
- Verification: JS syntax checks passed; diagnostics parser checks passed; Manager bridge `--self-test` passed; release-gate `--self-test` passed; focused launcher contracts passed `21/21`; strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`, and `damagedReports:[]`.

## 2026-06-23 Local Feature VerifyOnly and Extra Drift
- Completed: `refresh-anticodex-local-features.ps1 -VerifyOnly` no longer rewrites local config feature flags; verify-only mode now stays a read-only evidence path.
- Completed: plugin capability parity now treats extra local connector/app-tool cache records as drift, not just missing or changed shared records. Summaries, Manager evidence, and passive release gates include `extraLocal` in clean/dirty decisions.
- Verification: JS syntax checks passed for summarizer, release gates, and adaptive server; PowerShell parser checks passed for refresh/plugin scripts; release-gate `--self-test` passed with new extra-local failures; focused launcher contracts passed; strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`.

## 2026-06-23 Skill Content Inheritance
- Completed: source snapshots now content-hash shared `.codex\skills` and extra `.agents\skills`, so preserved mtimes cannot hide skill content drift.
- Completed: MCP/Skill verification now compares every inherited local skill directory against its shared or `.agents` source fingerprint, reports `skills.changedShared`, and surfaces changed-skill samples through summaries, diagnostics, Manager, and passive release gates.
- Completed: replaced hot `Get-FileHash` loops with .NET SHA256 streaming in the skill-heavy paths; the MCP/Skill verifier dropped from timing out after 74 seconds to passing in about 37 seconds on the current inherited surface.
- Runtime repair: targeted local Anti-Codex skill refresh copied `.system`, `_repos`, and `keep-codex-fast` from shared Codex into `codex-home-deepseek-app\skills`; native Codex was not modified.
- Verification: parser checks passed; focused launcher contracts passed; Manager bridge self-test passed; release-gate `--self-test` passed with `mcp_skills_changed_shared_skills`; MCP/Skill, refresh verify-only, and plugin capability reports were refreshed; strict passive gates are back to `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`, `damagedReports:[]`.

## 2026-06-23 Startup Snapshot Agents Root Pinning
- Completed: startup snapshot markers now store `extraSkillsRoots` and `agentsSkillsPath`, preserving the exact `.agents` skill root used during startup snapshot creation.
- Completed: diagnostics/source-freshness recomputation now prefers marker roots over current environment/default roots, and exposes root source/path in `localFeatures.snapshotStatus`.
- Completed: Manager actions for MCP/Skill, plugin capabilities, and refresh local features now pass the marker agents path through `-AgentsSkillsPath`, so follow-up checks use the same inherited surface.
- Verification: adaptive/sync syntax checks passed; focused startup marker, diagnostics snapshot freshness, and MCP/Skill launcher contracts passed.

## 2026-06-23 Cold Relaunch Manager Entry
- Completed: cold relaunch is now exposed as a high-impact Manager action in the in-app page, injected panel, external bridge, UI-state verifier, and standalone Manager button verifier. It runs in the background with singleton protection and requires the existing high-impact confirmation; this change does not auto-run the restart verifier.
- Completed: cold relaunch report summaries now show `mode`, `launcher`, and `failedStages` consistently across adaptive, bridge, and injected Manager summaries. Bridge/inject latest-report status now uses `effectiveOk` before `ok`, matching the in-app release-gate behavior.
- Verification: JS syntax checks passed for adaptive, bridge, inject, and UI-state scripts; PowerShell parser check passed for the Manager action verifier; Manager bridge `--self-test` passed; focused Manager/release/cold-launcher tests passed; release-gate `--self-test` and strict passive gates passed. Strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`.

## 2026-06-23 Optional Real-Traffic Requested Flag Hardening
- Completed: optional real-provider and provider-to-Antigravity success reports now must prove `requestedRealTraffic:true`, not only `usedRealTraffic:true`, before passive release gates accept them as real optional evidence.
- Completed: the real third-party provider verifier now writes `requestedRealTraffic:true` on successful opt-in real traffic, and strict optional readiness also filters out optional reports that are real-traffic-shaped but missing the requested flag.
- Completed: release-gate self-test and launcher contracts now require the new `optional_real_traffic_not_requested` failure for forged successful optional reports.
- Verification: real-provider and release-gate syntax passed; release-gate `--self-test` passed; focused optional-real/release tests passed, including the forged success-without-requested fixture; strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`.

## 2026-06-23 Optional Real-Traffic Evidence Label Boundary
- Completed: Manager latest-report summaries now label the two optional real-traffic proofs as `realProviderSmoke` and `fakeProviderToAntigravityReturn` instead of wording that could imply one continuous real third-party-to-Antigravity chain.
- Verification: adaptive/bridge/injected Manager syntax passed; Manager bridge `--self-test` passed; focused Manager/optional-real tests passed; strict passive gates remain green with only optional cold relaunch missing.

## 2026-06-23 Optional Same-Chain Real Provider to Antigravity Return
- Completed: the real third-party provider verifier now has a default-off `--allow-real-antigravity-return` branch. When explicitly requested, it keeps the same isolated state root, runs two real provider turns, restarts the isolated translator in Antigravity mode, and sends a third turn with `previous_response_id` chained to the second real-provider response.
- Completed: same-chain return evidence is reported as `realProviderToAntigravityReturnEvidence` with request/usage/history/previous-ID/marker/route/model fields. Summaries, passive release gates, the in-app Manager, the external bridge, and the injected Manager panel all surface the evidence separately from the existing fake-provider return report.
- Verification: no real traffic or cold relaunch was run in this batch. JS syntax checks passed; release-gate `--self-test` passed; Manager bridge `--self-test` passed; focused launcher tests passed `8/8`; strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`.

## 2026-06-23 Diagnostics Long-Task Log Freshness
- Completed: diagnostics `longTasks.items` now include `latestLogLine`, `logUpdatedAt`, and `logAgeMs` for sync-host and post-verification background work, using existing update-status/post-verification state rather than tailing raw logs.
- Completed: diagnostic verification now requires those fields for both long-task entries, and local-access plus launcher contracts cover the new shape.
- Verification: JS syntax checks passed; diagnostics PowerShell parser check passed; focused local diagnostics payload test passed; focused launcher diagnostics contract passed.

## 2026-06-23 Native Continuation Cleanup and Resume Hardening
- Completed: native MCP bridge calls now have a pending-call timeout that rejects abandoned `tools/call` requests and removes queued stale calls, instead of retaining them until bridge close.
- Completed: `NATIVE_CONTINUATIONS` can be registered with a bounded TTL for tests and now has direct no-real-traffic coverage proving abandoned continuations expire, close their bridge, and cannot be resumed later.
- Completed: same-Cascade resume now retries transient pre-event failures without cancelling the Cascade between attempts; final/non-retry failures still cancel best-effort. AgentAPI and upstream tests cover the `cancelOnError:false` retry path.
- Verification: JS syntax checks passed; native bridge tests passed `4/4`; focused native upstream/agentapi/bridge tests passed `37/37`.

## 2026-06-23 Manager Long-Task Freshness Visibility
- Completed: in-app Manager and injected Manager background-task cards now display the latest structured task status line plus status age from diagnostics.
- Completed: the in-app Manager key/value renderer now escapes HTML before insertion, so structured status text remains text.
- Verification: adaptive/injected Manager syntax checks passed; diff whitespace check passed; focused Manager launcher contracts passed `8/8`.

## 2026-06-23 Third-Party API Manager Error Summaries
- Completed: third-party connection tests now return a stable `summary` with human-readable title, suggested action, retryability, failed stage, and machine type.
- Completed: Manager connection-test output displays the summary before stage details, covering auth, quota/billing, model-not-found, rate-limit, network, timeout, URL, TLS, not-found, and protocol mismatch failures.
- Verification: syntax checks passed; focused upstream classification tests passed `12/12`; focused Manager third-party contract passed; local fake third-party provider verifier passed with `usedRealTraffic:false`.

## 2026-06-23 Passive Release Gate Refresh
- Completed: strict passive release gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `damagedReports:[]` after the Manager long-task and third-party error-summary changes.
- Completed: release-gate `--self-test` still passes with expected forged-report semantic failures.
- Note: `missingOptional:["coldRelaunch"]` remains non-blocking and should only be closed by an operator-approved cold relaunch check.

## 2026-06-23 Manager Result Copy Control
- Completed: in-app Manager and fallback Manager now provide a copy-result button for the current action result, including latest-report paths and diagnostics summaries.
- Completed: the control copies only currently visible result text and does not open external paths, read raw reports, or consume traffic.
- Verification: adaptive/injected Manager syntax checks passed; diff whitespace check passed; focused Manager launcher contracts passed `8/8`.

## 2026-06-23 Manager Snapshot Drift Warning
- Completed: fallback Manager now matches the injected panel by reading `localFeatures.snapshotStatus`, showing snapshot freshness/refresh guidance, and displaying a warning when snapshots are stale, missing, invalid, or `source_changed`.
- Completed: this remains a display-only prompt to run the existing refresh action; it does not auto-repair, rewrite native Codex, or fake connector/app-tool authorization.
- Verification: adaptive/injected Manager syntax checks passed; focused Manager/local-feature launcher contracts passed `9/9`.

## 2026-06-23 Installed Overall Third-Party Verifier Timeout Alignment
- Completed: installed overall now gives the local fake third-party provider verifier a process timeout derived from its `--timeout-ms` value, avoiding a 90s inner verifier being killed by the default 60s subcheck budget.
- Completed: launcher contracts now require the explicit timeout variable and outer-process margin.
- Verification: installed overall PowerShell parser check passed; focused installed overall/third-party/Manager launcher contracts passed `14/14`; diff whitespace check passed.

## 2026-06-23 Diagnostics PowerShell Array Serialization Guard
- Completed: diagnostic bundle collection now materializes model-routing `failures` and `models` into explicit arrays before `ConvertTo-Json`, avoiding Windows PowerShell 5.1 inline-array serialization drift.
- Completed: launcher contracts reject the unsafe inline `failures = if (...)` shape for this collector path and require `@($resultFailures)` / `@($resultModels)`.
- Verification: diagnostics collector PowerShell parser check passed; focused diagnostics/report-summary launcher contracts passed `19/19`; diff whitespace check passed.

## 2026-06-23 Local Feature Refresh Content Parity
- Completed: refresh-features reports now fail when inherited skill directory content or shared guidance files differ from the Anti-Codex local copy, not only when entries are missing.
- Completed: summaries and passive release gates expose the new `changedExpectedSkills` and guidance drift evidence, and UI-state verifier coverage was brought back in line with recent Manager result-copy/snapshot-warning fields.
- Verification: refresh PowerShell parser check passed; release-gate `--self-test` passed; UI verifier self-test passed; focused launcher contracts passed `122/122`.

## 2026-06-23 Refresh Result Snapshot Evidence
- Completed: Manager refresh-features result formatting now shows `sourceSnapshot: files=... / fingerprint=...` when a completed refresh report is returned, across the external bridge, injected panel, and fallback Manager page.
- Completed: background refresh start messages remain honest and do not invent a new fingerprint before the report exists.
- Verification: adaptive/bridge/inject/button syntax checks passed; Manager bridge `--self-test` passed; Manager button `refreshFeatures` self-test passed; focused launcher contracts passed `122/122`.

## 2026-06-23 Refresh Drift Manager Visibility
- Completed: refresh-features latest-report items now carry inherited skill content drift and guidance-file drift (`changedExpectedSkills`, `changedExpectedSkillDetails`, `guidanceChanged`) into the Manager evidence model.
- Completed: fallback Manager, injected Manager, and external bridge summaries now show `refresh drift: skills=... / guidance=...` when a completed refresh report detects stale inherited skills or shared guidance files.
- Completed: diagnostic bundle verification now fails a supposedly clean refresh summary if skill content drift or guidance drift is still present.
- Verification: adaptive/bridge/inject syntax checks passed; diagnostics PowerShell parser check passed; Manager bridge `--self-test` passed; focused launcher contracts passed `122/122`.

## 2026-06-23 Provider/Protocol-Neutral History Unit Contract
- Completed: `response-history` now has a lightweight unit test proving hydration preserves the previous conversation when a later request changes provider, protocol, and model metadata from OpenAI-compatible to Anthropic and back.
- Completed: the Windows linked-skill fixture now skips only when the environment cannot create linked directories, avoiding false red runs while preserving coverage where links are available.
- Verification: `response-history` tests passed `14/14`; focused launcher contracts passed `122/122`.

## 2026-06-23 Source Snapshot Mismatch Self-Test
- Completed: passive release-gate self-test now forges semantically clean refresh/MCP/plugin reports with divergent `sourceSnapshot.fingerprint` values and proves MCP/Skill plus plugin-capability gates receive mismatch failures.
- Completed: launcher contract coverage now asserts the dynamic self-test output includes both `mcp_skills_source_snapshot_mismatch` and `plugin_capabilities_source_snapshot_mismatch`.
- Verification: release-gate syntax passed; release-gate `--self-test` passed; focused launcher self-test contract passed `122/122`.

## 2026-06-23 Real Provider Unsafe URL Negative Test
- Completed: launcher regression coverage now executes the real third-party provider verifier with an unsafe non-HTTPS non-loopback URL and a fake API-key environment variable, proving it fails before traffic and writes `usedRealTraffic:false` without leaking the key.
- Completed: duplicate-skill fixture expectations now follow the structured report contract (`ok:false`) rather than stale exit-code assumptions.
- Verification: real-provider verifier syntax passed; focused launcher verifier contract passed `123/123`.

## 2026-06-23 Runtime logs_2.sqlite TRACE Guard
- Completed: inspected the isolated Anti-Codex `logs_2.sqlite` under `C:\Users\XD\AppData\Roaming\anticodex\codex-home-deepseek-app`; it contained historical TRACE rows and a 4,169,472-byte WAL, but the first 8-second sample showed no active growth.
- Completed: backed up `logs_2.sqlite`, `logs_2.sqlite-wal`, and `logs_2.sqlite-shm` to `logs_2-backup-20260623-155617`, installed trigger `anticodex_drop_trace_logs` to ignore future TRACE inserts, and ran `PRAGMA wal_checkpoint(TRUNCATE)`.
- Verification: WAL was truncated to 0 bytes; a 10-second post-fix sample showed `deltaId:0`, `deltaCount:0`, `deltaTrace:0`, and `deltaWal:0`. Original Codex was not touched.

## 2026-06-23 Product logs_2.sqlite TRACE Guard
- Completed: added `scripts/protect-anticodex-log-db.mjs`, an idempotent Anti-Codex-only guard that installs `anticodex_drop_trace_logs`, checkpoints/truncates WAL, and rejects non-Anti-Codex homes unless a self-test flag explicitly allows a temp home.
- Completed: `start-deepcodex.ps1` now sets a non-TRACE Rust log default for Anti-Codex, lowers `codex_app_server_transport::transport::remote_control::websocket` to `warn`, and applies the database guard before the desktop process starts.
- Completed: runtime sync now requires/copies the guard script so installed Anti-Codex receives the fix, and launcher contracts cover the startup hook.
- Verification: guard self-test passed; PowerShell parser checks passed; focused launcher contracts passed `124/124`; real Anti-Codex DB guard run was idempotent with `MAX(id)=356586`, `count=35829`, `traceCount=5878`, and `walBytes=0` before/after.

## 2026-06-23 Log DB Guard Evidence Chain
- Completed: `protect-anticodex-log-db.mjs --status` now writes signed no-traffic evidence (`latest-log-db-guard.json` plus timestamped history) proving the Anti-Codex log database exists, has a `logs` table and `level` column, carries trigger `anticodex_drop_trace_logs`, and has a bounded WAL size.
- Completed: `/anticodex/diagnostics`, diagnostic bundles, Manager latest-report visibility, installed-overall report integrity checks, and passive release gates now consume the log-guard report so a missing trigger or unprotected database cannot be hidden behind `ok:true`.
- Verification: JS syntax checks passed for the guard, release gates, and adaptive server; PowerShell parser checks passed for diagnostics/installed-overall scripts; guard self-test passed; release-gate self-test passed; launcher contracts passed `124/124`; strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `damagedReports:[]`.

## 2026-06-23 Manager Background Task Visibility
- Completed: Manager background actions now register in a server-side background-action map when spawned and clear the same map on exit, error, timeout, or failed launch, so duplicate clicks can return the existing PID/start time instead of looking like a fresh command.
- Completed: `/anticodex/diagnostics.longTasks.items` now includes currently running Manager background actions, and the embedded Manager background-task card shows other running background actions instead of relying only on sync-host/post-verification reports.
- Verification: adaptive server syntax passed; focused launcher contracts passed `124/124`.

## 2026-06-23 Fast Installed Overall Budget Guard
- Completed: fast installed-overall now caches the `/anticodex/diagnostics` snapshot for source-preflight and tool-bridge checks, avoiding repeated local diagnostic calls in the same short run.
- Completed: fast installed-overall now checks remaining fast-budget before lower-priority late subchecks (`missingHistory`, `mcpSkills`, and `pluginCapabilities`); if the budget is nearly exhausted it records an explicit skipped result with remaining/minimum milliseconds instead of waiting until the final elapsed-time failure.
- Verification: PowerShell parser check passed; focused launcher contracts passed `124/124`; `git diff --check` passed.

## 2026-06-23 Manager Foreground Action Singleflight
- Completed: long-running foreground Manager actions (`accountProxy`, `sourcePreflight`, `mcpSkills`, `pluginCapabilities`, `fastOverallNoTraffic`, `overallNoTraffic`, and `diagnosticsBundle`) now use a server-side singleflight registry.
- Completed: duplicate foreground clicks return `alreadyRunning`, `foreground:true`, and the original `foregroundStartedAt` instead of launching parallel checks.
- Verification: adaptive server syntax passed; focused launcher contracts passed `124/124`.

## 2026-06-23 Manager Foreground Task Visibility
- Completed: active foreground Manager singleflight entries now appear in `/anticodex/diagnostics.longTasks.items` with `stage:"manager_foreground"`, elapsed time, log age, and a user-visible running hint.
- Completed: the embedded Manager long-task card now shows foreground and background non-core running actions together as "other running" tasks, while diagnostics verification remains compatible with extra `longTasks.items` entries.
- Verification: adaptive server syntax passed; focused launcher/diagnostics contracts passed `124/124`; `git diff --check` passed.

## 2026-06-23 Manager Foreground Duplicate Result Copy
- Completed: duplicate foreground Manager checks now render a direct user-facing result instead of falling through to raw JSON or action-specific generic copy; the result shows the running check label, original start time, and wait/refresh guidance.
- Completed: the injected Manager panel now mirrors the fallback Manager long-task card by listing non-core running foreground/background tasks as "other running" work, including `manager_foreground` items from diagnostics.
- Verification: adaptive server and injected Manager syntax checks passed; focused Start Menu Manager launcher contracts passed `124/124`.

## 2026-06-23 Diagnostic Bundle Long-Task Summary
- Completed: diagnostic bundle collection now writes `diagnostics-summary.json` from the live `/anticodex/diagnostics` snapshot, carrying `longTasks` counts plus sync/post states and up to five non-core running foreground/background tasks.
- Completed: the bundle result now includes `diagnosticsSummary`, so support tooling can see foreground Manager work without opening the full raw diagnostics payload.
- Verification: collector PowerShell parser check passed; focused diagnostic bundle launcher contracts passed `124/124`.

## 2026-06-23 Diagnostic Bundle Long-Task Verification
- Completed: read-only diagnostics verification now requires `diagnostics-summary.json` in collected bundles and checks the `longTasks` summary shape, including `runningCount`, `attentionCount`, and `otherRunningItems`.
- Completed: optional `manager_foreground` summary items are validated for an id or label when present, without requiring a foreground task to be active during routine checks.
- Verification: diagnostics verifier PowerShell parser check passed; focused diagnostics launcher contracts passed `124/124`.

## 2026-06-23 Diagnostic Bundle Manager Result Summary
- Completed: Manager diagnostic-bundle action results now surface the collected long-task summary directly, showing running count, attention count, and other-running count next to the ZIP and bundle directory.
- Completed: the Manager contract now requires diagnostic bundle result copy to read `diagnosticsSummary.longTasks`, keeping the UI result in parity with the bundle payload.
- Verification: adaptive server syntax passed; focused Start Menu Manager launcher contracts passed `124/124`; `git diff --check` passed.

## 2026-06-23 Diagnostic Bundle Renderer Parity
- Completed: injected Manager and external Manager bridge diagnostic-bundle result renderers now mirror the fallback Manager by showing the collected `diagnosticsSummary.longTasks` running/attention/other-running counts.
- Completed: launcher contracts now require all three renderer surfaces (`adaptive-server`, injected panel, and bridge) to consume the same long-task summary evidence.
- Verification: injected Manager and bridge syntax checks passed; focused Start Menu Manager launcher contracts passed `124/124`; `git diff --check` passed.

## 2026-06-23 Diagnostic Bundle UI-State Coverage
- Completed: read-only UI-state verifier now treats the diagnostic-bundle long-task result summary as a Manager page contract, checking both fallback Manager HTML and injected Manager source.
- Completed: launcher coverage now requires `hasDiagnosticsBundleLongTaskResultSummary`, `diagnosticsSummary`, and the explicit failure text so future Manager result fields do not bypass UI verification.
- Verification: UI-state verifier syntax passed; UI-state `--self-test` passed; focused launcher UI-state contracts passed `124/124`.

## 2026-06-23 MCP/Skill Parity and Provider Continuity Gate Hardening
- Completed: passive release gates now reject extra Anti-Codex-local skills through `mcp_skills_extra_local_skills`, matching the existing extra-local MCP and connector/app-tool parity boundaries.
- Completed: diagnostics verification now fails when MCP/Skill report summaries expose extra local MCP entries or extra local skills, so support bundles cannot hide inherited-surface drift.
- Completed: the MCP/Skill dynamic fixture now covers global guidance content drift by forcing a stale local `RTK.md` and requiring the verifier to report the mismatch.
- Completed: third-party provider verifier reports `previousResponseContinuity` matched booleans for save, restart, provider switch, protocol switch, and reverse protocol switch. Release gates now require the third-party report name and all five previous-response matches, while Manager summaries show both previous-ID presence and match status.
- Verification: JS syntax checks passed for changed verifier/summarizer/Manager files; diagnostics PowerShell parser check passed; release-gate `--self-test` passed; launcher contracts passed `124/124` after a sequential rerun.

## 2026-06-23 Log DB Guard Evidence Visibility
- Completed: report summaries now preserve `logDbGuardEvidence` for `latest-log-db-guard.json`, including no-traffic, used-real-traffic, trigger, protected, and WAL-size fields.
- Completed: adaptive Manager latest reports plus injected/bridge renderers now show `logDbGuard: protected=... / trigger=... / noTraffic=... / wal=...`, so operators can see the TRACE-write guard proof instead of only a pass/fail status.
- Completed: diagnostics bundle verification now fails if `reports-summary.json` omits the log DB guard row or loses the protected/trigger/no-traffic/WAL evidence.
- Verification: JS syntax checks passed for summarizer, adaptive server, bridge, and injected Manager; diagnostics PowerShell parser check passed; release-gate `--self-test` passed; Manager bridge `--self-test` passed; full launcher contracts passed `124/124`.

## 2026-06-23 Diagnostic Summary Redaction and Provider Report Refresh
- Completed: diagnostic bundle collection now allows already-sanitized `reports-summary.json` fields through the JSON writer instead of redacting the entire summary when report text contains transcript-like keywords.
- Completed: diagnostic summaries now copy `logDbGuardEvidence` from the report summarizer, and the diagnostics verifier selects the first long-task object before checking `latestLogLine`, `logUpdatedAt`, and `logAgeMs`.
- Completed: third-party provider verifier reports now include top-level `reportName` on success and failure paths, so strict passive release gates can identify refreshed provider-continuity evidence.
- Verification: PowerShell parser checks passed; third-party provider script syntax passed; strict passive release gate passed; installed Anti-Codex sync passed; live diagnostics passed; latest diagnostic bundle has `reports-summary` count `33`, `redacted:false`, log-guard row present, and guard evidence present; full launcher contracts passed `124/124`; `git diff --check` passed.

## 2026-06-23 Provider Tool History and Cache Byte Parity Evidence
- Completed: response-history unit coverage now proves a three-turn OpenAI-compatible -> Anthropic -> OpenAI-compatible chain preserves `previous_response_id`, `function_call`, and next-request `function_call_output` ordering.
- Completed: shared sync coverage now uses nonempty connector and app-tool cache fixtures, checks selected files byte-for-byte, and compares whole-directory content fingerprints while excluding the local source manifest.
- Verification: focused provider-history test passed; focused full-sync cache test passed; full `response-history.test.mjs` passed `15/15`; full `sync-shared.plugin-host.test.mjs` passed `23/23`; `git diff --check` passed.

## 2026-06-23 App-Tool Sync Fingerprint Output
- Completed: `sync-deepcodex-app-tools.mjs` now writes `shared_tools_fingerprint`, `local_tools_fingerprint`, shared/local file counts, and `content_matches` into `deepcodex_app_connectors.json`.
- Completed: added a focused app-tools sync test with nonempty nested cache files and plugin app metadata, proving the registry reports matching shared/local fingerprints after sync.
- Verification: new app-tools sync test passed; script syntax check passed; focused shared-sync cache test passed; installed Anti-Codex runtime sync passed; strict passive release gate passed with `releaseReady:true`; `git diff --check` passed.

## 2026-06-23 MCP/Skill App-Tool Registry Fingerprint Gate
- Completed: `test-anticodex-mcp-skills.ps1` now reads `cache\deepcodex_app_connectors.json` whenever the local app-tool cache exists and fails if the registry is missing, lacks shared/local fingerprints, reports `content_matches:false`, or has mismatched fingerprints.
- Completed: the MCP/Skill report now exposes `appTools.registry` with path, existence, file counts, content-match status, and shared/local fingerprints so diagnostics can consume app-tool migration proof without opening raw cache files.
- Verification: focused launcher MCP/Skill contract passed; PowerShell parser check passed; `git diff --check` passed; installed registry was refreshed with `sync-deepcodex-app-tools.mjs` and now reports `contentMatches:true`, `sharedCount:36`, `localCount:36`, matching fingerprints, and `connectors:155`.

## 2026-06-23 App-Tool Registry Summary and Diagnostics Evidence
- Completed: report summarization now lifts `appTools.registry` into `mcpSkillEvidence`, including registry existence, content-match state, fingerprint-match state, and shared/local file counts.
- Completed: diagnostics bundle verification now rejects MCP/Skill summaries whose app-tool registry exists but has content mismatch, fingerprint mismatch, or differing file counts; the dynamic MCP/Skill verifier fixture now proves bad registries fail.
- Verification: focused summarizer, MCP/Skill verifier, dynamic bad-registry fixture, and diagnostics contracts passed; PowerShell parser checks passed for MCP/Skill and diagnostics verifiers; summarizer syntax check passed; `git diff --check` passed.

## 2026-06-23 Skill Snapshot Fingerprint Parity
- Completed: refresh-feature and MCP/Skill inherited-skill fingerprints now ignore `.git` directories, matching the local snapshot copier that intentionally skips embedded repositories.
- Completed: this removes false skill drift for repository-backed skills such as `_repos` and `keep-codex-fast` without weakening `SKILL.md` or usable asset parity.
- Verification: focused launcher MCP/Skill contract passed `124/124`; PowerShell parser checks passed for refresh-feature and MCP/Skill verifiers; refresh-feature report passed; MCP/Skill verifier passed; strict passive release gate passed with `releaseReady:true` and `shortReady:true`.

## 2026-06-24 MCP/Skill Short-Budget Regression Fix
- Completed: removed the stale `shortBudgetMode` branch that marked real MCP stdio smoke/list as skipped. The short verifier now always attempts the real `node_repl` smoke and Antigravity/DeepSeek `tools/list` checks, while still preserving short-budget source snapshot reuse.
- Completed: launcher static contracts now reject the old short-budget skip messages so the regression cannot be reintroduced as expected behavior.
- Verification: PowerShell parser check passed; focused MCP/Skill launcher contracts passed; `test-anticodex-mcp-skills.ps1 -TimeoutSec 5` returned `ok:true` in about 5.8 seconds with `shortBudgetMode:true`, `mcp.smokePassed:true`, `realCallPassed:true`, and `realListCount:2`; strict passive release gate stayed `releaseReady:true` and `shortReady:true`.

## 2026-06-24 Anthropic Thinking Continuity
- Completed: Anthropic upstream request conversion now preserves explicit thinking configuration. Anthropic-native `thinking` objects pass through, and `thinking:"enabled"` plus `thinking_budget` maps to Anthropic `budget_tokens`.
- Completed: provider protocol tests now cover Anthropic-assigned `tool_use.id` round-tripping into later Anthropic `tool_result.tool_use_id`, proving tool result continuity is not dependent on a fixed synthetic OpenAI call ID.
- Verification: focused upstream-provider tests passed, including the new thinking-preservation case and Anthropic tool_use ID round-trip; full upstream-provider suite passed `74/74`.

## 2026-06-24 Provider Continuity Support Visibility
- Completed: provider-continuity summaries now expose `previousResponseIdChain` with save/restart/provider/protocol/reverse IDs plus nested switch IDs, so support bundles and Manager summaries show the actual chain instead of only booleans.
- Completed: external Manager bridge, injected Manager, and fallback Manager render `previousChain` and `nestedMatches` lines for third-party provider continuity.
- Verification: JS syntax checks passed for adaptive server, report summarizer, Manager bridge, and injected Manager; focused launcher report/diagnostics contracts passed `18/18`; real diagnostics verifier passed and accepted the strengthened previous_response_id chain checks.

## 2026-06-23 Log DB Guard Fail-Closed Checks
- Completed: Anti-Codex startup now fails closed when the log database guard cannot be applied, instead of logging the failure and continuing toward a possible TRACE write loop.
- Completed: source preflight now runs `protect-anticodex-log-db.mjs --self-test`, so install/sync gates prove the trigger, backup, TRACE-drop, and WAL truncation behavior at source level.
- Completed: installed overall now checks `diagnostics.logDbGuard` directly, requiring protected, trigger-present, no-real-traffic, and WAL evidence even in fast mode.
- Verification: focused launcher contracts passed `124/124`; PowerShell parser checks passed for the changed scripts; `protect-anticodex-log-db.mjs --self-test` passed; `test-anticodex-source-preflight.ps1 -SkipFullRegression` passed and recorded `logDbGuardSelfTest`.

## 2026-06-23 Installed Fast Verifier Stabilization
- Completed: installed startup verification now invokes `start-anticodex.ps1 -SkipUpdateCheck` and waits up to 60 seconds for desktop/health readiness, avoiding accidental update/sync branches during verifier auto-start.
- Completed: installed runtime sync and installer now copy the public README/docs/marketing files needed by source preflight, so installed source gates no longer lose public documentation evidence.
- Completed: local connector verifier now isolates `CODEX_HOME`, UI-state verification accepts escaped long-task summary source text, and MCP/Skill verification compares `node_repl` env keys while allowing Anti-Codex-owned isolated path values.
- Completed: passive release gates now compare MCP/Skill and plugin-capability inherited-source fingerprints to each other instead of requiring them to match the older refresh-feature report fingerprint; refresh-feature remains its own release-required semantic gate.
- Verification: local connector verifier passed with no upstream calls; source preflight passed; runtime sync passed; installed source preflight passed; UI-state and MCP/Skill focused checks passed; installed fast overall passed with `ok:true`, `elapsedMs:153673`, `failures:0`; release-gate self-test passed; launcher contracts passed `124/124`; strict passive release gate passed with `releaseReady:true`, `shortReady:true`, and `missingRequired:[]`.

## 2026-06-23 Refresh Feature VerifyOnly Speedup
- Completed: `refresh-anticodex-local-features.ps1` now uses the same .NET streaming SHA256 helper for directory fingerprints that the MCP/Skill verifier uses, replacing slow per-file `Get-FileHash` calls.
- Completed: refresh-feature reports now include `startedAt` and `elapsedMs`, so future Manager/report summaries can show whether inherited-surface verification is getting expensive again.
- Verification: PowerShell parser check passed; refresh-feature `-VerifyOnly` completed successfully instead of timing out, writing `ok:true` with MCP/Skill/plugin/refresh source fingerprint `49eb51da...`; installed runtime sync passed; strict passive release gate passed with `releaseReady:true`, `shortReady:true`, and `missingRequired:[]`.

## 2026-06-23 Refresh Feature Timing Visibility
- Completed: refresh-feature report summaries now lift `verifyOnly` and `elapsedMs` into `refreshFeatureEvidence`, diagnostics verification requires the timing field, and Manager/bridge/injected report renderers show refresh timing evidence next to parity status.
- Completed: the refresh SHA256 helper now disposes the hash object even when file open fails, tightening the small resource-cleanup gap found during read-only review.
- Verification: JS syntax checks passed for summarizer, Manager bridge/inject, and adaptive server; diagnostics PowerShell parser check passed; launcher contracts passed `124/124`; refresh-feature `-VerifyOnly` wrote `elapsedMs:70192`; summary extraction returned `verifyOnly:true`; installed runtime sync passed; strict passive release gate passed with `releaseReady:true` and `missingRequired:[]`.

## 2026-06-24 Release Readiness Recheck
- Completed: strict passive release gates were rechecked after fast verifier hardening; latest evidence remains `releaseReady:true`, `shortReady:true`, `missingRequired:[]`, and `missingShort:[]`.
- Completed: cold relaunch code paths were rechecked non-disruptively through focused launcher contracts and release-gate self-test. The real cold relaunch report is still optional because generating it stops and restarts Anti-Codex.
- Verification: focused cold/release launcher contracts passed `9/9`; release-gate `--self-test` passed; current worktree was clean at the start of the recheck.

## 2026-06-24 Cold Relaunch Explicit Confirmation
- Completed: `test-anticodex-cold-relaunch.ps1` now refuses to stop/restart Anti-Codex unless `-ConfirmRelaunch` is provided, returning structured JSON without writing a latest cold-relaunch report.
- Completed: the Manager `coldRelaunch` background action and installed-overall `-IncludeColdRelaunch` path now pass `-ConfirmRelaunch`, preserving the intentional operator-approved path.
- Verification: cold-relaunch and installed-overall parser checks passed; adaptive server syntax passed; focused launcher contracts passed including the no-confirm refusal test; runtime sync completed without restart; strict passive release gates remained `releaseReady:true`, `shortReady:true`, and `missingRequired:[]`.

## 2026-06-24 Cold Relaunch Gate Hardening
- Completed: passive release gates now explicitly reject cold-relaunch reports with `skipped:true` or `requiresConfirmation:true`, even if a malformed report claims `ok:true`.
- Completed: release-gate self-test now includes the skipped/confirmation cold-relaunch failure markers, so the optional cold gate cannot silently accept a no-confirm refusal artifact as real restart evidence.
- Verification: `test-anticodex-release-gates.mjs --self-test` passed after adding the new cold-relaunch semantic failure checks.

## 2026-06-24 Local Connector Support-Path Hardening
- Completed: local connector report summarizer coverage now asserts ChatGPT install URL scrubbing, metadata-only link endpoint evidence, connector/app-tool parity cleanliness, and GET/POST app-tool parity drift samples.
- Completed: diagnostics verification now requires the local connector summary to carry connector parity, app-tool parity, and GET/POST app-tool parity proof, so the support path cannot hide local cache drift.
- Verification: diagnostics parser check passed; focused launcher contracts for local connector summary and diagnostics passed; real diagnostics verifier passed; standalone local connector verifier passed with no real traffic and clean connector/app-tool parity.

## 2026-06-24 Provider Continuity Nested Evidence
- Completed: passive release gates now require nested provider/protocol switch `continuationPreviousResponseId` evidence, not just top-level previous-response continuity booleans.
- Completed: launcher contracts now pin the nested previous-response failure codes for provider switch, protocol switch, and reverse protocol switch.
- Verification: release-gate syntax, self-test, strict gate, and focused launcher contracts passed; standalone third-party provider verifier passed with 9 turns, clean previous-response matches, and OpenAI/Anthropic/OpenAI tool-history structural evidence.
