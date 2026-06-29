# Anti-Codex Handoff For Next Channel

Date: 2026-06-23, current-status refreshed 2026-06-29
Branch: main

## Current State

- Anti-Codex is an isolated Codex desktop/runtime copy with an Antigravity entitlement model adapter. Antigravity Desktop/CLI may supply model text, but Antigravity coworker/tool execution is not the default product path.
- Direction lock: Anti-Codex should remain a guarded Codex client copy plus isolation, branding, and model-adapter changes. Do not reimplement Codex client/tool features one by one through Antigravity Desktop/coworker; use host sync and parity validation when Codex changes.
- Client sync contract: native Codex updates must be handled as guarded host/client sync plus Anti-Codex patch reapplication. Missing native Codex behavior in Anti-Codex is a sync/parity bug by default, not a prompt to manually rebuild that behavior.
- Antigravity account mode is back to a two-account/profile split because Gemini CLI is not usable for the MCP-side account lane. Anti-Codex should keep its own isolated Antigravity CLI profile/account for model text while MCP can use a different Antigravity account. Do not run real account/traffic proof without explicit approval.
- Anti-Codex-side account lane evidence is explicit in no-traffic profile-prepare/source-preflight/diagnostics reports: `accountLaneRole:"anticodex-model-text"`, `mcpAccountLaneManagedByAntiCodex:false`, and `mcpAccountLaneOwner:"external-antigravity-account-not-managed-here"`. MCP-side setup is external to this channel.
- Installed runtime on `http://127.0.0.1:8484` was healthy during the latest no-traffic checks: upstream `antigravity-desktop`, CLI model-text transport, account ready, 8 models, session lock idle.
- Manager source/readiness contracts now target `native-panel-v99`.
- Standalone real Manager MCP/Skill and plugin/application button gates pass after local feature refresh. The default standalone real-button script now runs only those two non-disruptive actions; report viewing and diagnostics bundle remain opt-in.
- `latest-manager-real-buttons.json` is now indexed by Manager latest reports, diagnostic bundle report summaries, and installed overall report-integrity checks.
- Latest feature parity evidence after refresh: connectors `5866/5866`, app tools `58/58`, missing shared `[]`, callable app tools `0` because no connector is authorized.
- Latest MCP/Skill evidence: MCP `3/3` with `node_repl`, DeepSeek worker, and Antigravity worker visible; expected shared skill union `126`, missing shared `[]`.
- Fast UI smoke, full no-traffic UI smoke, and installed no-traffic overall passed. Short non-fast UI smoke now uses explicit timeout budgets and records `dynamicProbeUnavailable` instead of hanging when the embedded dynamic probe times out.
- Real Antigravity work verifier passed: model `gemini-3.5-flash-low` created a file, executed local `node_repl` MCP, matched the marker, and returned Chinese final text.
- Source preflight fast gate passed after the latest model-text boundary cleanup.
- Current passive release gate reports `shortReady:true`, `releaseReady:false`, `releaseBlockedOnlyByRequiredRealTraffic:true`, `missingShort:[]`, `missingRequired:[postVerification,accountProxyReadiness]`, and `damagedReports:[]`. Older ready-state notes below are historical snapshots; do not run the required real-traffic gates without explicit user approval.

## Important Recent Checks

- `node --check scripts/test-anticodex-ui-state.mjs`
- PowerShell parser check for `scripts/test-anticodex-ui-state.ps1`
- `node --test translator/tests/anticodex-launcher.test.mjs`
- `powershell.exe -File scripts/sync-anticodex-runtime.ps1 -NoRestart -TimeoutSec 45`
- `powershell.exe -File scripts/test-anticodex-ui-state.ps1 -BaseUrl http://127.0.0.1:8484 -TimeoutSec 8 -Fast -SkipManagerActionProbe`
- `powershell.exe -File scripts/test-anticodex-ui-state.ps1 -BaseUrl http://127.0.0.1:8484 -TimeoutSec 8 -ManagerProbeTimeoutSec 8 -SkipManagerActionProbe`
- `powershell.exe -File scripts/test-anticodex-source-preflight.ps1 -SkipFullRegression`
- `powershell.exe -File scripts/test-anticodex-real-work.ps1 -BaseUrl http://127.0.0.1:8484 -TimeoutSec 90 -AllowRealTraffic`
- `powershell.exe -File scripts/test-anticodex-installed-overall.ps1 -EnsureRunning -NoTraffic -SkipAccountProxyProbe`
- `node scripts/test-anticodex-local-connectors.mjs`
- `powershell.exe -File scripts/test-anticodex-plugin-capabilities.ps1 -TimeoutSec 20`
- `node scripts/test-anticodex-third-party-provider.mjs`
- `node scripts/test-anticodex-manager-button.mjs --port 58318 --action viewLatestReports --timeout-ms 30000 --compact 1`
- `powershell.exe -File scripts/refresh-anticodex-local-features.ps1`
- `powershell.exe -File scripts/test-anticodex-plugin-capabilities.ps1`
- `powershell.exe -File scripts/test-anticodex-mcp-skills.ps1`
- `powershell.exe -File scripts/test-anticodex-manager-real-buttons.ps1 -Actions mcpSkills,pluginCapabilities -TimeoutSec 150 -MaxAttempts 2`

## Next Work

1. Keep stability and identity invariants.
   - No ChatGPT login path in Anti-Codex.
   - No fake connector/app-tool callability.
   - Original Codex remains untouched.
   - Anti-Codex branding and icon must survive host sync.

2. Next useful hardening.
   - Keep Manager button verification serial; do not run Manager/UI verifiers in parallel with installed overall.
   - Prefer short parser/self/contract checks while the user is waiting; reserve full source preflight and installed overall for checkpoint or release acceptance.
   - Re-run runtime sync with translator restart when adaptive-server action inventory changes.

## Completed In This Channel

- Script-level local connector/app-tool verifier exists and passes: `test-anticodex-local-connectors.mjs` proves local endpoint behavior without claiming remote OAuth or real connector authorization.
- Full connector/app-tool cache parity exists and passes in `test-anticodex-plugin-capabilities.ps1`: current evidence is connector parity `5866/5866`, app-tool parity `58/58`, `missingShared:[]`, and callable app tools `0` because no connector is actually authorized.
- Standalone real Manager button gate exists and passes for `mcpSkills` and `pluginCapabilities`, with `lastUiOnly:false` and no fake callable connector/app-tool access.
- Third-party provider history-switch verifier now covers nine turns across provider save, translator restart, OpenAI-compatible provider switch, OpenAI-compatible to Anthropic switch, and Anthropic back to OpenAI-compatible switch.
- Manager latest reports now include MCP/Skill, plugin capabilities, refresh-features, and stability-soak reports; `viewLatestReports` was verified by a real embedded Manager button click.

## Completed On 2026-06-23 Follow-Up

> Historical snapshot disclaimer: the dated sections below are older evidence records. Any ready-state references in them are snapshots from the time they were written and do not reflect the current passive release gate, which is `releaseReady:false` / `releaseBlockedOnlyByRequiredRealTraffic:true` (see Current State at the top of this file).

- (historical) `e554b40` refreshed `docs/ADAPTIVE_ONE_API_STACK.md` into the current Anti-Codex provider stack: local translator, Antigravity Desktop default, explicit third-party profiles, no ChatGPT login route, no original Codex mutation, and no fake connector authorization. The current wording now says Antigravity entitlement supplies model text, not that Antigravity Desktop is the default provider.
- `a462ce5` moved the old DeepCodex/DeepSeek video script into `docs/marketing/legacy/deepcodex-video-script.md` and created a current Anti-Codex `docs/marketing/video-script.md`.
- `1ea453d` refreshed `docs/chat-to-responses-compat.md` into the current provider compatibility contract, including OpenAI-compatible and Anthropic-compatible structured tool-history preservation. The `deepcodex.reasoning.hex.v1:` prefix remains documented only as an internal compatibility token.
- (historical) `9077d81` marked `docs/DEEPSEEK_RUNTIME_FAILURE_NOTES.md` as legacy DeepSeek-route notes so the file is not mistaken for the current default provider path. The current path is entitlement-based model text, not a provider default.
- `a546ef3` clarified Windows setup docs: `codex-home-deepseek-app` is legacy compatibility state, and connector-backed app tools stay unavailable until real authorization exists.
- Short verification only was run for this follow-up: focused `rg` contract checks and `git diff --check`. Full source preflight and installed overall remain reserved for the next release-acceptance pass.
- `24b9d17` added launcher contract coverage for current public docs, using a whitelist of README, provider-stack, compatibility, and current marketing entry points instead of recursive historical scans.
- (historical) `579f802` refreshed README provider boundaries: Antigravity Desktop default, explicit third-party provider profiles through Manager, no silent wrong-upstream fallback, and no connector-backed app-tool authorization from metadata. The current wording now says Antigravity entitlement supplies model text, not that Antigravity Desktop is the default provider.
- `9e05b0b` added a fast source-preflight `publicDocumentation` gate so public-doc regressions are caught even when translator regression is skipped.
- `3ee8585` surfaced the fast public-doc gate as `publicDocumentationOk` in translator diagnostics and diagnostic bundle summaries, and corrected README wording to `upstream profile` / Manager as the formal user entry.
- `6041556` made installed overall check `sourcePreflight.publicDocumentationOk` directly through diagnostics, including fast mode where the standalone diagnostics verifier is skipped.
- `b9b3efe` added field-level public-doc status to Manager latest-report payload and summaries for `latest-source-preflight.json`.
- `b9b1702` strengthened short gates: Manager bridge and Manager button self-tests now require latest-report public-doc field evidence, source preflight fast runs the bridge self-test, and `README_EN.md` is now part of the public-doc boundary check.
- `3e5e070` marked the legacy DeepCodex / DeepSeek marketing script as archived and enforced that marker through public-doc gates.
- `febc870` preserved Manager real-button evidence in diagnostic report summaries and made diagnostics verification require real `mcpSkills` / `pluginCapabilities` button evidence.
- Current follow-up fixes diagnostic bundle summary parsing: `collect-anticodex-diagnostics.ps1` now delegates report summarization to `summarize-anticodex-report.mjs`, avoiding Windows PowerShell 5.1 false damaged-report failures on large valid reports.
- Verification for the current follow-up: parser check passed, report summarizer extracted real Manager button evidence, launcher contract suite passed `91/91`, runtime sync restarted Anti-Codex successfully, and installed diagnostics bundle verification passed with `20260623-014140.zip`.
- Current follow-up also strengthened third-party provider continuity evidence: `test-anticodex-third-party-provider.mjs` now proves ordered same-id tool pairs and rejects protocol cross-contamination, while diagnostic bundle summaries surface the 9-turn provider-switch, OpenAI->Anthropic, and Anthropic->OpenAI continuity evidence.
- Manager `fastOverallNoTraffic` now keeps UI-state coverage and carries explicit short budgets: `-SubcheckTimeoutSec 30` and `-FastMaxElapsedMs 90000`.
- Installed overall skipped checks now include `behaviorCovered:false` and `coverageKind:"skipped"` so fast reports do not overstate behavior coverage.
- Latest verification: local fake-provider verifier refreshed `latest-third-party-provider.json`; launcher contract suite passed `91/91`; runtime sync restarted Anti-Codex successfully; installed diagnostics bundle verification passed with provider continuity evidence in `20260623-014948.zip`.
- Added passive release gate summary: `test-anticodex-release-gates.mjs` reads latest reports only and writes `latest-release-gates.json`, grouping evidence into `short`, `no-traffic`, `real-traffic`, `manager`, `soak`, and `cold`.
- Historical release-gate evidence from this earlier step was `shortReady:true`, `releaseReady:false`; later sidecar backfill and semantic hardening moved the installed passive release gate to `releaseReady:true` at that time. Manager latest reports and diagnostic bundles include the release-gate summary.
- Added cold relaunch latest-report surface: the cold relaunch verifier now writes `latest-cold-relaunch.json` and a signed history report; Manager latest reports, diagnostics bundles, installed overall report-integrity checks, and passive release gates can now display it. It remains optional in passive release readiness because generating it restarts the isolated Anti-Codex runtime.
- Fixed MCP path drift after native Codex bin updates: config sync now repairs missing absolute MCP command paths such as stale `node_repl.exe` version directories. After refreshing local features, MCP/Skill, plugin/app-tool, Manager real buttons, and installed no-traffic overall are green; passive release gates no longer require `installedOverallNoTraffic`.
- Release gate status after sidecar backfill: `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `damagedReports:[]`. Required real-traffic reports were already fresh and `ok:true`; only legacy `.sha256` sidecars were missing.
- Added reproducible sidecar backfill helper: `sign-anticodex-reports.mjs` defaults to dry-run and only writes `.sha256` with `--write` for parseable `ok:true` reports. It does not edit report JSON.
- Passive release gates now check local connector/plugin capability semantics instead of trusting only `ok:true`: ChatGPT install URLs must be scrubbed, connector link endpoints must stay metadata-only, local endpoint checks must not call upstream, native Codex writeback must stay false, unauthorized app tools must stay zero, and connector/app-tool parity must have no missing shared entries.
- Diagnostic bundles and Manager latest reports now expose local connector/plugin capability field evidence directly, so operators can see no-fake-authorization proof without reading raw JSON.
- Third-party provider continuity is now stricter: the local fake-provider verifier asserts all prior history markers at provider switch turn 7, OpenAI-compatible to Anthropic turn 8, and Anthropic back to OpenAI-compatible turn 9, with latest proof counts `16/18/20`.
- Added an optional real third-party provider smoke verifier. It uses temporary state, accepts the API key only through a named environment variable, rejects ChatGPT login/credential-bearing/unsafe URLs, and defaults to a no-traffic skipped report.
- Added an optional provider-to-Antigravity return verifier. It reuses the isolated nine-turn history and can perform exactly one real Antigravity turn 10 after restart, without changing the installed profile or original Codex.
- Current evidence remains no-traffic for both new optional paths: static contracts, negative safety checks, default skip reports, and the existing local nine-turn provider scenario pass. Real third-party traffic and real Antigravity turn 10 have not been run.
- Manager latest reports and diagnostic bundle collection now surface both optional report files when generated; neither was added to passive release-required gates.
- Fast source preflight now runs the isolated upstream profile storage suite as `upstreamProfileStorage`, covering corrupt/unreadable third-party key fail-closed behavior, explicit Antigravity recovery, history preservation, and no real APPDATA profile mutation.
- Responses missing-history handling now preserves HTTP 410 `response_history_missing` instead of generic `gateway_error`; integration coverage proves non-retryable guidance, original response ID, and no upstream request.

## Fresh Lessons For Next Channel

- If plugin capability parity reports `missingShared`, run `refresh-anticodex-local-features.ps1`; do not weaken the no-fake-authorization gate.
- Do not trust stale visible Manager result text. Real button success must match the current `lastAction` and clear pending/queued action state.
- Avoid complex nested PowerShell through `rtk proxy`; use short commands, `curl.exe`, `rg`, or a small script file for probes that need `$null`, `$_`, arrays, or regexes.
- Avoid inline multi-line Node through PowerShell arguments; use a checked-in `.mjs` helper for JSON parsing or summarization.
- For provider-history checks, require structured tool pair evidence and protocol-shape cleanliness instead of relying only on text markers.
- Late provider-switch turns should assert all prior markers, not only first and nearby turns; otherwise a middle-history truncation can slip through.
- For connector/app-tool readiness, require field-level report semantics in the release gate; a signed `ok:true` report alone is too weak for no-fake-authorization guarantees.
- Field-level connector/app-tool proof should be visible in Manager and diagnostic summaries, not buried only in raw reports or release-gate internals.
- A continuity prompt must not include the expected historical values; otherwise current-prompt echo can masquerade as history recall.
- Real provider verifiers should accept only an environment-variable name for the key and reject unsafe URLs before starting the isolated translator.
- Use passive release-gate summaries before running long acceptance. They are cheap, show exactly which latest reports are missing/stale/damaged, and keep real traffic / soak / cold relaunch as explicit later gates.
- Current docs can mention old compatibility names, but they must say why. Historical DeepCodex/DeepSeek launch material should move under `legacy` or carry a clear legacy marker.

## Worker Note

- Older worker outputs were advisory only. The accepted evidence is the current source tests and installed no-traffic overall listed above.

## Files To Read First In New Channel

- `AGENTS.md` or the injected project instructions.
- `C:\Users\XD\.codex\RTK.md`
- `MCP_WORKER_RULES.md`
- `task_plan.md`
- `findings.md`
- `docs/audits/2026-06-22-handoff-next-channel.md`
- `docs/audits/2026-06-22-ui-timeout-hardening-status.md`
- `docs/audits/2026-06-22-local-connector-allowlist-status.md`

## 2026-06-23 Release-Gate Self-Test Follow-Up

- Passive release-gate `--self-test` now forges bad no-traffic, missing-history, local-connector, and plugin-capability reports and verifies each is rejected despite signed `ok:true`.
- No-traffic gates reject explicit contradictory evidence (`usedRealTraffic:true`, `behaviorCovered:false`, or `coverageKind:"real-traffic"`) while preserving compatibility for older reports that omit those fields.
- Fresh evidence: release-gate syntax passed, self-test produced the expected semantic failures for all forged report classes, focused launcher contract passed, and strict passive gates remain `shortReady:true`, `releaseReady:true`, with no missing required or damaged reports.

## 2026-06-23 MCP/Skill Sync Follow-Up

- Current parity evidence is no-missing inherited surface: `.codex\skills` plus `.agents\skills` are included, with Anti-Codex-local extra skills allowed.
- `refresh-anticodex-local-features.ps1` now passes custom `-AgentsSkillsPath` into the Node snapshot copier via `ANTICODEX_EXTRA_SKILLS_ROOTS`, then restores the old environment value, keeping copy and verification aligned.
- Fresh evidence: PowerShell parser check passed and the focused MCP/skills launcher contract passed.

## 2026-06-23 Third-Party Provider Release-Gate Follow-Up

- Passive release gates now require field-level third-party provider continuity evidence: nine fake-provider turns, save/restart/provider/protocol/reverse-protocol history preservation, stale-model rejection, structured OpenAI and Anthropic tool-pair evidence, late-turn marker coverage, and secret redaction.
- `--self-test` for release gates now also forges a bad third-party provider report and verifies it is rejected despite signed `ok:true`.
- Fresh evidence: release-gate syntax passed, self-test produced the expected third-party provider semantic failures, focused launcher contract passed, and strict passive gates remain `shortReady:true`, `releaseReady:true`, with no missing required or damaged reports.

## 2026-06-23 Provider Marker Visibility Follow-Up

- Report summaries and diagnostic verification now expose late-turn provider marker coverage for turns 7, 8, and 9, including the `16/18/20` marker-count evidence required by release gates.
- Fresh evidence: summarizer syntax passed, latest third-party provider summary shows marker counts `16/18/20`, diagnostics parser check passed, and focused diagnostics launcher contracts passed.

## 2026-06-23 Manager Release/Provider Visibility Follow-Up

- Manager latest reports now includes the local fake-provider continuity report `latest-third-party-provider.json`.
- Manager and diagnostic summaries now show release gate readiness, missing short/release gates, required semantic failure details, and provider continuity marker/tool-pair evidence. Optional cold-relaunch absence is not shown as a release failure when `releaseReady:true`.
- Fresh evidence: adaptive-server and report-summarizer syntax passed, diagnostics parser passed, full launcher contract suite passed `96/96`, and `git diff --check` passed.

## 2026-06-23 Optional Real-Traffic Semantics Follow-Up

- Optional real-provider and provider-to-Antigravity reports now separate no-traffic default skips from requested-but-uncovered real-traffic attempts.
- Passive release gates validate optional real-traffic report semantics when those reports exist, but they remain outside release-required readiness.
- Fresh evidence: syntax/parser checks passed, release-gate self-test rejects forged requested-but-skipped optional reports, strict passive gates remain `shortReady:true` / `releaseReady:true`, and focused launcher plus skip-behavior checks passed.

## 2026-06-23 Connector Cache Refresh Follow-Up

- Shared connector cache drifted ahead of the Anti-Codex local snapshot during the session, causing plugin capability verification to fail with missing shared connector IDs.
- `refresh-anticodex-local-features.ps1` refreshed the Anti-Codex local snapshots without granting connector authorization.
- Fresh evidence: plugin capability verification passed with connector parity `5765/5765`, app-tool parity `58/58`, accessible connectors `0`, unauthorized app tools `0`, callable app tools `0`; MCP/Skill verification passed.

## 2026-06-23 MCP/Skill and Optional Real-Traffic Surface Follow-Up

- MCP/Skill reports now surface concrete parity and smoke evidence in report summaries, diagnostic bundles, and Manager latest-report text instead of only saying the report passed.
- Passive release gates now validate MCP/Skill semantics directly: no missing shared MCP/skills, `.agents` included in expected skills, node_repl present, MCP smoke and real node_repl call passed, and skill smoke readable.
- Passive release gates now validate source-preflight semantics directly, including upstream profile storage. The latest source-preflight report was refreshed and now carries `upstreamProfileStorage.ok:true`.
- Manager latest reports now includes sync-readiness and model-routing latest reports, so required no-traffic release gates are visible from the UI.
- Optional real-provider reports now surface marker/history/redaction evidence; optional provider-to-Antigravity return reports now surface turn-10 history, previous response ID, marker counts, route transport, and resolved model.
- Plugin capability summaries and Manager latest reports now show parity drift counts plus sample IDs for connector, app-tool, and GET/POST app-tool mismatches.
- Diagnostic bundle verification now requires MCP/Skill evidence and plugin parity drift sample fields. Optional real-provider and Antigravity-return details are required whenever their optional reports are present and not skipped.
- Passive release-gate self-test rejects forged optional real-provider and Antigravity-return reports with bad semantic evidence.
- Fresh evidence: syntax/parser checks passed, dynamic summarizer fixture tests passed, release-gate self-test passed with source-preflight, MCP/Skill, and optional semantic classes, refreshed source-preflight passed, strict passive gates remain `shortReady:true` / `releaseReady:true`, and diagnostic bundle verification passed with `20260623-063025.zip`.

## 2026-06-23 Model-Routing No-Traffic Follow-Up

- Model-routing latest-report evidence now surfaces mode, provider protocol/model, tool-bridge mode, result count, skipped-result count, failed-result count, and result-error count in summaries, diagnostic bundles, and Manager latest-report text.
- Passive release gates now reject forged `ok:true` model-routing reports unless they prove `skipRequests:true`, non-empty model catalog, mode present, per-model results present, all results skipped, no failed result, and no result error.
- Fresh evidence: JS syntax checks passed, PowerShell parser checks passed, release-gate self-test passed with model-routing semantic failures, strict passive gates remain `shortReady:true` / `releaseReady:true`, focused launcher/summarizer tests passed, and source diagnostics verification passed.

## 2026-06-23 Tool-Bridge No-Traffic Follow-Up

- Tool-bridge latest-report evidence now surfaces native bridge mode, desktop transport, prompt fallback adapter, native event/discovery/default flags, compatibility bridge, automatic permission mode, same-Cascade resume proof, owned-tool disablement, permission-prompt disablement, disabled-tool count, and Codex bridge adapter.
- Passive release gates now reject forged `ok:true` tool-bridge reports unless they prove the native MCP same-Cascade contract.
- Fresh evidence: JS syntax checks passed, PowerShell parser checks passed, release-gate self-test passed with tool-bridge semantic failures, strict passive gates remain `shortReady:true` / `releaseReady:true`, and focused launcher/summarizer tests passed.

## 2026-06-23 Model-Thinking No-Traffic Follow-Up

- Model-thinking latest-report evidence now surfaces expected/actual model counts, thinking-capable count, missing-budget count, missing-reasoning-level count, and reasoning-level set.
- Passive release gates now reject forged `ok:true` model-thinking reports unless they prove count consistency, unique IDs, display names, reasoning levels, thinking support, and valid thinking budgets.
- Fresh evidence: JS syntax checks passed, PowerShell parser checks passed, release-gate self-test passed with model-thinking semantic failures, strict passive gates remain `shortReady:true` / `releaseReady:true`, focused launcher/summarizer tests passed, source diagnostics verification passed, and latest summary shows `8/8` thinking models with no missing budgets.

## 2026-06-23 UI-Idle No-Traffic Follow-Up

- UI-idle latest-report evidence now surfaces duration, interval, sample count, healthy sample count, reconnect-text count, login-text count, and missing-model-text count.
- Passive release gates now reject forged `ok:true` UI-idle reports unless they prove healthy account/UI samples, model count, visible model text, and no reconnect/login text.
- Fresh evidence: JS syntax checks passed, PowerShell parser checks passed, release-gate self-test passed with UI-idle semantic failures, strict passive gates remain `shortReady:true` / `releaseReady:true`, focused launcher/summarizer tests passed, source diagnostics verification passed, and latest summary shows healthy `1/1` samples with no reconnect/login text.

## 2026-06-23 Sync-Readiness No-Traffic Follow-Up

- Sync-readiness reports now self-attest full no-traffic coverage with `reportName:"sync-readiness"`, `noTraffic:true`, `usedRealTraffic:false`, `behaviorCovered:true`, and `coverageKind:"installed-no-traffic"`.
- Latest-report evidence now surfaces active host, brand, icons, scripts, update/guardrail state, shortcut counts, Manager bridge state, and clean sync/rollback state.
- Passive release gates now reject forged `ok:true` sync-readiness reports unless they prove full mode, active/source hash match, operation success, rollback host/brand/icon readiness, shortcut inventory, Manager bridge base URL, and no stale swap/candidate state.
- Fresh evidence: sync-readiness verifier refreshed the report, strict passive gates remain `shortReady:true` / `releaseReady:true`, focused launcher/summarizer tests passed, and source diagnostics verification passed.

## 2026-06-23 Installed Overall No-Traffic Follow-Up

- Installed-overall reports now self-attest no-traffic coverage with `usedRealTraffic:false`, `behaviorCovered:true`, and `coverageKind:"installed-no-traffic"` or `"installed-fast-no-traffic"`.
- Latest-report evidence now surfaces fast/no-traffic flags, coverage kind, check counts, skipped checks, missing skip metadata, and explicit `realMiniTool` / `realWork` skips.
- Passive release gates now reject forged `ok:true` installed-overall reports unless all checks are green, skips are documented, full-mode skips are expected, and real-traffic-only checks are visibly skipped.
- Full installed-overall now treats the long plugin/application Manager click as covered by the standalone plugin capability report, avoiding local bridge stalls and later UI-idle false failures without granting connector authorization.
- Fresh evidence: full installed-overall passed with `usedRealTraffic:false` and `coverageKind:"installed-no-traffic"`; source diagnostics passed; focused launcher/summarizer/diagnostics tests passed; strict passive gates report `shortReady:true` / `releaseReady:true`, no missing required gates, and no damaged reports.

## 2026-06-23 Provider Continuity Gate Follow-Up

- Third-party provider passive gates now require structured save/restart continuity evidence: save and restart OpenAI-compatible tool evidence, restart tool-pair preservation, save/restart `previous_response_id`, and marker preservation after save/restart.
- Optional real-provider and provider-to-Antigravity scripts now generate explicit default skip reports when real traffic is not requested. These reports state `requestedRealTraffic:false`, `usedRealTraffic:false`, `behaviorCovered:false`, and `coverageKind:"skipped"`.
- Boundary to preserve: optional real-provider is still a two-turn real-traffic sanity check. The full nine-turn provider switch/protocol switch/restart matrix remains the local fake-provider release gate unless real external traffic is explicitly requested and separately expanded.
- Fresh evidence: release-gate `--self-test` rejects forged provider reports missing save/restart structure; focused launcher tests passed; default optional skip reports exist for real-provider and provider-to-Antigravity; strict passive gates report `shortReady:true` / `releaseReady:true`, no missing required gates, and no optional semantic failures.

## 2026-06-23 Optional Real Provider Route Follow-Up

- Optional real third-party provider reports now include route evidence from `/anticodex/model-routes` after the real two-turn check.
- Passive release gates require real-provider optional reports to prove upstream-provider transport, provider protocol, requested/resolved model agreement, and successful route status.
- Summaries, diagnostics, and Manager latest-report text now surface the optional real-provider route fields when the report is not skipped.
- Fresh evidence: release-gate `--self-test` rejects forged route evidence; focused summarizer/release-gate/verifier tests passed; strict passive gates remain `shortReady:true` / `releaseReady:true`; default skip report still uses no real traffic.

## 2026-06-23 Cold Relaunch Optional Evidence Follow-Up

- Cold relaunch reports now include explicit original Codex isolation evidence: `originalCodex.unchanged`, `beforePids`, and `afterPids`.
- Passive release gates validate cold reports when present, requiring health/provider readiness, mode-specific readiness, one main process, translator presence, at most one launcher, required successful stages, and original Codex isolation.
- Summaries, diagnostics, and Manager latest-report text surface cold relaunch health/readiness/mode/process/stage/original-Codex evidence. The report remains optional because producing it restarts the isolated Anti-Codex runtime.
- Fresh evidence: no cold relaunch was run in this batch; release-gate `--self-test` rejects forged cold reports; focused cold/summarizer/diagnostics tests passed; strict passive gates remain `shortReady:true` / `releaseReady:true` with cold absent and optional.

## 2026-06-23 Stability Soak Optional Evidence Follow-Up

- Stability-soak reports remain optional in passive release readiness because producing them can be long and may touch real upstream traffic.
- Passive release gates now validate soak reports when present, requiring readiness before/after, stable translator PID, health checks, successful turns, zero failures, elapsed duration, and mode/model evidence.
- Summaries, diagnostics, and Manager latest-report text surface stability-soak readiness, mode/model, PID stability, health-check count, turn count, failed-turn count, and elapsed time.
- Fresh evidence: no real soak was run in this batch; syntax/parser checks passed; release-gate `--self-test` rejects forged soak evidence; focused stability-soak summarizer/diagnostics/release-gate tests passed.

## 2026-06-23 Release Report List Parity Follow-Up

- Release-gate group summaries now expose required and optional counts separately, so optional cold/soak evidence is not shown like a required release blocker.
- `latest-model-thinking.json` is now included in diagnostic bundle collection, Manager latest reports, and installed-overall report-integrity checks. `latest-source-preflight.json` is also included in installed-overall report-integrity checks.
- Fresh evidence: JS syntax checks passed; diagnostics and installed-overall PowerShell parser checks passed; release-gate `--self-test` passed; focused diagnostic/latest-report/installed-overall/model-thinking tests passed.

## 2026-06-23 Optional Real-Traffic Skip Follow-Up

- Optional real-traffic skipped reports now need explicit no-traffic skip evidence: `requestedRealTraffic:false`, `usedRealTraffic:false`, `behaviorCovered:false`, and `coverageKind:"skipped"`.
- Fresh evidence: release-gate `--self-test` rejects forged skipped optional reports where traffic was requested or not explicitly marked unrequested.

## 2026-06-23 External Manager Bridge Evidence Follow-Up

- The external Manager bridge latest-report summary now matches the in-app server summary for release groups, source-preflight, model-thinking, MCP/Skill, optional real-provider, provider-to-Antigravity return, cold relaunch, and stability-soak evidence.
- The injected Manager panel now mirrors the same latest-report field evidence, and Manager/latest-report inventory now includes every `requiredForRelease:true` passive gate report.
- Fresh evidence: bridge/inject/adaptive syntax passed; diagnostics and installed-overall parser checks passed; bridge `--self-test` passed; focused report-inventory/Manager/diagnostics/overall tests passed.

## 2026-06-23 Release Report Inventory Drift Follow-Up

- Added a dynamic launcher contract that parses release-gate required report files and checks they are present in diagnostic bundle collection, Manager latest reports, installed-overall report-integrity checks, and launcher contract coverage.
- Fixed missing inventory entries for release-required reports including cancellation, custom tool loop, native multi-tool loop, web tools, real mini-tool, real work, account/proxy readiness, post-verification, tool-bridge mode, and UI idle stability.

## 2026-06-23 Manager Report Failure Detail Follow-Up

- In-app, external bridge, and injected Manager latest-report summaries now all show `missingShort`, `damagedReports`, release-gate semantic failures, source-preflight UI/regression/diff/skip evidence, and model-thinking reasoning levels.
- The standalone injected Manager summary also shows missing/invalid report totals, damaged report status, and native Codex writeback evidence for plugin capability reports.
- Optional gate reports remain non-release-required but now have a separate visibility guard across diagnostics, Manager latest reports, and installed-overall report-integrity checks. This also covers the optional real-provider and provider-to-Antigravity return reports.
- Fresh evidence: bridge/inject/adaptive syntax passed; bridge `--self-test` passed; focused Manager and release-report inventory contracts passed. The installed runtime was then synced and restarted successfully on `http://127.0.0.1:8484` with Antigravity upstream, 8 models, and account ready; installed strict passive release gates and diagnostics both passed.

## 2026-06-23 Manager MCP/Skill and App-Tool Drift Detail Follow-Up

- External bridge and injected Manager latest-report summaries now mirror the in-app Manager for MCP/Skill operational evidence: `.agents` skill count, MCP smoke, real node_repl call smoke, and skill readability.
- Connector/app-tool parity drift counts and samples are now visible in bridge/inject summaries when plugin capability parity is dirty.
- Local feature refresh now parses MCP server names with the same anchored TOML section rule as the MCP/Skill verifier, so nested `[mcp_servers.x.tools.y]` sections are not counted as standalone servers.
- MCP/Skill verification now requires expected DeepSeek and Antigravity worker MCP tool names, not just a non-empty `tools/list` response.
- MCP/Skill verification now hash-compares global guidance files against the shared originals, covering `AGENTS.md`, `DEFAULT_SKILL_ALLOWLIST.md`, `RTK.md`, and `MCP_WORKER_USAGE_GUIDE.md`.
- Plugin capability parity now compares per-record hashes, so same-ID connector/app-tool content drift is reported as `changedShared` and is covered by Manager summaries and passive release-gate semantics.
- Local skill snapshot sync now refuses conflicting duplicate skill names across `.codex\skills` and `.agents\skills`; identical names with different content are reported as copy failures instead of silent overlay overrides.
- MCP/Skill verification now reports duplicate and conflicting duplicate skill names too, so a stale same-name skill can fail the runtime verifier even when directory names still match.
- MCP/Skill verification now reports same-name MCP config drift as `changedShared` when shared/local `command`, `args`, or `env` differ.
- Release-gate summaries now expose `effectiveOk`, and Manager/diagnostics treat `ok:true` plus `releaseReady:false` as needing action rather than passing.
- Focused launcher tests now run the passive release-gate `--self-test` for real, proving forged-report semantic checks still execute.
- Third-party provider continuity evidence now includes ordered role/history checks for turns 7/8/9. Release gates and diagnostics require this ordered evidence in addition to marker coverage and protocol-specific tool-pair shape.
- Startup snapshot refresh now compares manifest fingerprints before keeping an existing local snapshot, so changed shared skill content refreshes instead of being marked fresh.
- Duplicate skill detection now includes linked skill directories, including Windows junction entries, before deciding whether `.codex\skills` and `.agents\skills` conflict.
- Local feature refresh now records connector/app-tool cache parity fingerprints and fails if local copied caches differ from shared source after refresh.
- MCP `changedShared` drift and conflicting duplicate skill names are now consumed by summaries, diagnostics, Manager bridge/injected panels, and passive release-gate semantics, not only stored in raw verifier output.
- Refresh-feature connector/app-tool cache parity now surfaces as `refreshFeatureEvidence` in summaries, diagnostics, Manager bridge/injected panels, and release-gate self-tests.
- Script-level local connector/app-tool verifier reports now include `reportName`, no-real-traffic coverage semantics, linked/allowlisted/hidden connector evidence, GET/POST tool parity, and upstream-request absence; diagnostics and passive release gates reject forged local connector reports that contradict those fields.
- Third-party provider restart continuity now has direct turn-6 evidence: ordered role history and full marker coverage immediately after translator restart are recorded by the fake-provider verifier and consumed by summaries, diagnostics, Manager latest reports, and passive release gates.
- Source preflight now invokes the script-level local connector/app-tool verifier with the same report root, so short/release preflight refreshes `latest-local-connectors.json` with current no-real-traffic evidence instead of only trusting stale latest-report state.
- Optional real-provider and provider-to-Antigravity return reports now require the expected `reportName` in passive release gates and diagnostics, preventing wrong report payloads from satisfying optional real-traffic slots by shape alone.
- `latest-refresh-features.json` is now release-required. Passive release readiness now depends on current shared-to-local feature synchronization evidence instead of treating refresh-feature parity as an optional Manager artifact.
- Historical passive release-gate check after that hardening: the new `refreshFeatures` required gate was satisfied. A first strict check exposed stale short evidence for `sourcePreflight`, `mcpSkills`, `localConnectors`, and `thirdPartyProvider`; bounded reruns refreshed those reports, and strict passive gates at that point were `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, and `damagedReports:[]`.
- Optional real-traffic now has an explicit hard mode: `--strict-optional-real-traffic`. Default `--strict` remains unchanged, but the explicit flag reports optional readiness/failures and treats skipped optional real-provider or provider-to-Antigravity reports as not ready.
- Earlier evidence before the latest release-required refresh-features hardening: bridge/inject/adaptive/summarizer syntax passed; refresh-feature, MCP/Skill, and plugin-capability parser checks passed; bridge `--self-test` passed; release-gate `--self-test` and strict passive release gates passed; focused Manager/MCP/Skill/plugin contracts passed. The stricter plugin verifier first caught stale connector cache drift, then `refresh-anticodex-local-features.ps1` refreshed snapshots and the rerun passed with connector parity `5760/5760`, app-tool parity `58/58`, and no missing/extra/changed shared entries.

## 2026-06-23 Source Snapshot Release Evidence Follow-Up

- Refresh-feature, MCP/Skill, and plugin-capability reports now carry source snapshot evidence and must agree on the same source fingerprint before passive release readiness can pass.
- The source snapshot covers shared config, shared `.codex\skills`, extra `.agents\skills`, connector cache, app-tool cache, and global guidance files. It uses content hashing for compact/high-risk sources and metadata signatures for huge inherited skill trees.
- Summaries, diagnostics, adaptive Manager latest reports, and launcher contracts now surface or require source snapshot evidence.
- Fresh evidence: parser checks passed for the new helper plus refresh/MCP/plugin/diagnostics scripts; JS syntax checks passed; release-gate `--self-test` passed; focused launcher contracts passed `11/11`; full refresh repaired stale connector snapshot parity and then passed in about 72 seconds; MCP/Skill and plugin-capability reports both used source fingerprint `7255ed564418...`; strict passive gates are `shortReady:true`, `releaseReady:true`, with no missing required reports and matching source fingerprints.
- Next-channel note: use narrow verifier reruns or `refresh-anticodex-local-features.ps1 -VerifyOnly` for routine evidence refresh. Run full local feature refresh only when connector/app-tool/skill parity drift is detected, because the current inherited surface is roughly 15.6k files.
- Follow-up: external Manager bridge and injected Manager summaries now display the same source snapshot line as the in-app Manager. Bridge/inject syntax checks passed, bridge `--self-test` asserts the rendered line, and focused launcher Manager/MCP/plugin contracts passed `4/4`.

## 2026-06-23 Provider Continuity Visibility and ID Follow-Up

- Passive release gates now require all five local fake-provider `previous_response_id` continuity segments: save, restart, provider switch, OpenAI-to-Anthropic protocol switch, and Anthropic-to-OpenAI reverse switch.
- Summaries and diagnostics now expose/verify `previousResponseContinuity`, including nested switch-field consistency. Manager summaries now show restart tool-pair evidence and marker threshold status alongside provider/protocol switch evidence.
- Fresh evidence: syntax/parser checks passed; release-gate `--self-test` passed with the new continuation failures; focused launcher contracts passed `13/13`; strict passive release gates remain `shortReady:true`, `releaseReady:true`, and the third-party provider gate reports no semantic failures.

## 2026-06-23 Optional Real-Traffic Visibility Follow-Up

- Manager latest-report summaries now expose optional real-provider requested/resolved model route evidence, redaction status, provider-to-Antigravity native route evidence, and provider continuity previous-ID status.
- Diagnostics now validate skipped optional real-provider and provider-to-Antigravity reports as explicit no-traffic skip evidence instead of ignoring skipped reports.
- Passive release gates now require skipped optional real-traffic reports to carry `reason` and `coveredBy`, and the self-test has separate skipped-report negative coverage for provider-to-Antigravity return.
- Fresh evidence: syntax checks passed, diagnostics parser checks passed, Manager bridge self-test passed, release-gate `--self-test` passed with skipped metadata failures, focused launcher contracts passed, and strict passive gates remain `shortReady:true` / `releaseReady:true`; optional real-traffic readiness remains false because real external traffic has not been requested.

## 2026-06-23 Optional Release Gap Visibility Follow-Up

- Release-gate output now includes `missingOptional` at the top level and in group summaries; diagnostics and Manager summaries preserve it so optional cold/soak/real-traffic gaps are visible without becoming blockers.
- Added diagnostics verification for `missingOptional` and a Manager source regression guard against known mojibake tokens.
- Fresh evidence: JS syntax checks passed, diagnostics parser checks passed, Manager bridge `--self-test` passed, release-gate `--self-test` passed, focused launcher contracts passed `21/21`, and strict passive release gates are `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`, `damagedReports:[]`.

## 2026-06-23 Local Feature VerifyOnly and Extra Drift Follow-Up

- `refresh-anticodex-local-features.ps1 -VerifyOnly` is now read-only and no longer restores feature flags while gathering evidence.
- Plugin capability parity now treats extra local connector/app-tool cache records as drift. Summaries, Manager evidence, and passive release gates include `extraLocal` in clean/dirty decisions.
- Fresh evidence: JS syntax checks passed, refresh/plugin PowerShell parser checks passed, release-gate `--self-test` passed with new extra-local negative coverage, focused launcher contracts passed, and strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`.

## 2026-06-23 Skill Content Inheritance Follow-Up

- Source snapshots now content-hash shared `.codex\skills` and `.agents\skills`.
- MCP/Skill verification now reports inherited skill content drift as `skills.changedShared`, and diagnostics, Manager summaries, report summaries, and passive release gates consume it.
- Targeted runtime repair refreshed `.system`, `_repos`, and `keep-codex-fast` in Anti-Codex local skills from shared Codex; native Codex was not changed.
- Fresh evidence: parser checks passed, focused launcher contracts passed, Manager bridge self-test passed, release-gate `--self-test` passed, refreshed MCP/Skill + refresh verify-only + plugin capability reports agree on source fingerprint `ebc8ecb9d202...`, and strict passive gates are `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`, `damagedReports:[]`.

## 2026-06-23 Startup Snapshot Agents Root Pinning Follow-Up

- Startup snapshot markers now store `extraSkillsRoots` and `agentsSkillsPath`.
- Diagnostics recompute source freshness with marker roots first, then environment/default roots, and expose the selected root source/path in `localFeatures.snapshotStatus`.
- Manager MCP/Skill, plugin capability, and refresh-local-features actions now pass the marker agents path with `-AgentsSkillsPath`.
- Fresh evidence: sync/adaptive syntax checks passed, and focused startup marker + diagnostics snapshot freshness + MCP/Skill launcher contracts passed.

## 2026-06-23 Cold Relaunch Manager Entry Follow-Up

- Added `coldRelaunch` as a high-impact Manager action across the fallback Manager page, injected Manager panel, external Manager bridge, UI-state verifier, and standalone Manager button verifier.
- The action is background/singleton guarded and requires high-impact confirmation; it does not run automatically and the real restart verifier still only runs when the operator clicks it.
- Cold relaunch summaries now include mode, launcher count, original Codex preservation, and failed-stage count consistently across adaptive, bridge, and injected summaries.
- Bridge/inject latest-report status now follows `effectiveOk` like the adaptive Manager, preventing `ok:true` plus `releaseReady:false` from being displayed as passing.
- Fresh evidence at that point: syntax checks passed for adaptive/bridge/inject/UI-state; Manager action PowerShell parser passed; bridge `--self-test` passed; focused Manager/release/cold tests passed; release-gate `--self-test` and strict passive gates passed. That historical strict gate was `releaseReady:true`, `shortReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`.

## 2026-06-23 Optional Real-Traffic Requested Flag Follow-Up

- Optional real-provider and provider-to-Antigravity success reports now require `requestedRealTraffic:true` as well as `usedRealTraffic:true` before strict optional readiness can treat them as real optional evidence.
- The real third-party provider verifier writes `requestedRealTraffic:true` on successful opt-in real traffic, while skipped/not-configured reports keep explicit no-real-traffic skip semantics.
- Release-gate self-test and launcher contracts now include a forged success-without-requested fixture and expect `optional_real_traffic_not_requested`.
- Fresh evidence: real-provider and release-gate syntax passed; release-gate `--self-test` passed; focused optional-real/release tests passed; strict passive gates remain `releaseReady:true`, `shortReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`.

## 2026-06-23 Optional Real-Traffic Evidence Label Follow-Up

- Manager latest-report summaries now label the separate optional proofs as `realProviderSmoke` and `fakeProviderToAntigravityReturn`.
- This is a display boundary only: the existing evidence remains two optional reports, not one continuous real third-party provider to Antigravity chain.
- Fresh evidence: adaptive/bridge/injected Manager syntax passed; Manager bridge `--self-test` passed; focused Manager/optional-real tests passed; strict passive gates remain green with only optional cold relaunch missing.

## 2026-06-23 Installed Missing-History Follow-Up

Update: installed `native-panel-v85` `viewLatestReports` now passes, installed fast UI state is green, and release gates validate the missing-history 410/no-traffic/no-route-change semantics directly.

- Added a signed installed no-traffic verifier for missing/pruned response history. It proves HTTP 410 `response_history_missing`, non-retryable recovery guidance, original ID preservation, and no model-route change.
- The report is now collected by installed overall and diagnostics, shown by Manager latest reports, and required by short/release passive gates.
- Fresh evidence: launcher contracts `96/96`; installed probe green; strict passive gates `shortReady:true`, `releaseReady:true`, no missing required or damaged reports; runtime healthy on Antigravity with 8 models and account ready.
- A real Manager latest-report click now passes on installed `native-panel-v85` and displays `历史过期恢复：通过`; installed fast UI state is green, and release gates validate the missing-history 410/no-traffic/no-route-change semantics directly.

## 2026-06-23 Optional Same-Chain Real Provider Return Follow-Up

- Added a default-off same-chain branch to the real third-party provider verifier: explicit real provider turns 1-2 can now be followed by a real Antigravity return turn in the same isolated response-history chain.
- The branch requires `--allow-real-antigravity-return` and `--antigravity-model` in addition to the existing real-provider opt-in. It does not run during routine no-real-traffic checks.
- New evidence field: `realProviderToAntigravityReturnEvidence`. It records requested/used/history/previous-ID marker and route/model proof, and is surfaced through summaries, passive release gates, the in-app Manager, external bridge, and injected Manager panel.
- Fresh evidence: syntax checks passed; release-gate `--self-test` passed; Manager bridge `--self-test` passed; focused optional-real/Manager/release tests passed `8/8`; strict passive gates remain `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, `missingOptional:["coldRelaunch"]`.

## 2026-06-23 Diagnostics Long-Task Log Freshness Follow-Up

- Diagnostics now expose structured long-task freshness for sync-host and post-verification background work: `latestLogLine`, `logUpdatedAt`, and `logAgeMs`.
- The implementation uses existing status/report fields instead of raw log tailing, so diagnostics show whether slow work is progressing without leaking transcript-like content.
- Fresh evidence: adaptive/local-access/launcher syntax checks passed; diagnostics PowerShell parser check passed; focused diagnostics payload and launcher contract tests passed.

## 2026-06-23 Native Continuation Cleanup Follow-Up

- Native MCP bridge pending calls now time out and evict queued stale calls if Codex never supplies a result.
- Retained native continuations now have direct short-test coverage for TTL expiry and failed-resume clearing at the `NATIVE_CONTINUATIONS` layer.
- Same-Cascade resume now retries a transient failure that happens before any Codex-visible event without cancelling the Cascade between attempts; final failures still cancel best-effort.
- Fresh evidence: native bridge tests passed `4/4`; focused native agentapi/upstream/bridge tests passed `37/37`; no real traffic, cold relaunch, or installed runtime sync was run.

## 2026-06-23 Manager Long-Task Freshness Follow-Up

- Manager background-task cards now surface diagnostics long-task freshness in both the in-app page and injected panel: latest structured status line plus age/update timestamp.
- This remains a no-raw-log path; it uses diagnostics `latestLogLine`, `logAgeMs`, and `logUpdatedAt`, not transcript or log tail content.
- Fresh evidence: adaptive/injected Manager syntax checks passed; diff whitespace check passed; focused Manager launcher contracts passed `8/8`.

## 2026-06-23 Third-Party API Manager Error Summary Follow-Up

- `/anticodex/upstream-test` now returns a structured `summary` beside stage details, and the injected Manager panel shows the summary first.
- Summary categories include auth, quota/billing, model-not-found, rate-limit, network, timeout, invalid URL, TLS, not-found, protocol mismatch, and ready.
- Fresh evidence: syntax checks passed; focused upstream classification tests passed `12/12`; focused Manager third-party contract passed; local fake third-party provider verifier passed with no real traffic.

## 2026-06-23 Passive Release Gate Refresh

- Strict passive release gates still report `shortReady:true`, `releaseReady:true`, `missingRequired:[]`, and `damagedReports:[]`.
- Release-gate `--self-test` still passes.
- The only current optional miss is `coldRelaunch`; it remains non-blocking and should not be run without operator approval because it restarts Anti-Codex.

## 2026-06-23 Manager Result Copy Follow-Up

- The Manager action result area now has a copy-result control in both the injected panel and fallback page.
- It copies only the visible result text, so latest-report paths are easier to share without adding external folder-opening behavior.
- Fresh evidence: adaptive/injected Manager syntax checks passed; diff whitespace check passed; focused Manager launcher contracts passed `8/8`.

## 2026-06-23 Manager Snapshot Drift Warning Follow-Up

- Fallback Manager now shows the same local-feature snapshot freshness guidance as the injected panel, including a visible warning for stale/missing/invalid/source-changed snapshots.
- This is display-only and points operators to the existing refresh-local-features action; it does not mutate shared/native Codex state.
- Fresh evidence: adaptive/injected Manager syntax checks passed; focused Manager/local-feature launcher contracts passed `9/9`.

## 2026-06-23 Installed Overall Third-Party Timeout Follow-Up

- Installed overall now sets the third-party local verifier process timeout from its 90s `--timeout-ms` plus margin, instead of relying on the default 60s subcheck timeout.
- This avoids false timeout failures in no-traffic fake-provider verification without running real traffic.
- Fresh evidence: PowerShell parser check passed; focused installed overall/third-party/Manager launcher contracts passed `14/14`; diff whitespace check passed.

## 2026-06-23 Diagnostics Array Serialization Follow-Up

- Diagnostic bundle collection now stores model-routing `failures` and `models` in explicit arrays before emitting JSON.
- This closes the known Windows PowerShell 5.1 risk where inline conditional empty arrays can serialize as `{}`.
- Fresh evidence: diagnostics collector parser check passed; focused diagnostics/report-summary launcher contracts passed `19/19`; diff whitespace check passed.
