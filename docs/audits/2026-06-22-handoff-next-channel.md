# Anti-Codex Handoff For Next Channel

Date: 2026-06-23
Branch: main

## Current State

- Anti-Codex is an isolated desktop/runtime fork using Antigravity Desktop as the default model provider.
- Installed runtime on `http://127.0.0.1:8484` was healthy during the last checks: upstream `antigravity-desktop`, account ready, 8 models.
- Manager is at `native-panel-v85`.
- Standalone real Manager MCP/Skill and plugin/application button gates pass after local feature refresh. The default standalone real-button script now runs only those two non-disruptive actions; report viewing and diagnostics bundle remain opt-in.
- `latest-manager-real-buttons.json` is now indexed by Manager latest reports, diagnostic bundle report summaries, and installed overall report-integrity checks.
- Latest feature parity evidence after refresh: connectors `5866/5866`, app tools `58/58`, missing shared `[]`, callable app tools `0` because no connector is authorized.
- Latest MCP/Skill evidence: MCP `3/3` with `node_repl`, DeepSeek worker, and Antigravity worker visible; expected shared skill union `126`, missing shared `[]`.
- Fast UI smoke, full no-traffic UI smoke, and installed no-traffic overall passed. Short non-fast UI smoke now uses explicit timeout budgets and records `dynamicProbeUnavailable` instead of hanging when the embedded dynamic probe times out.
- Real Antigravity work verifier passed: model `gemini-3.5-flash-low` created a file, executed local `node_repl` MCP, matched the marker, and returned Chinese final text.
- Source preflight fast gate passed before this handoff.

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

- `e554b40` refreshed `docs/ADAPTIVE_ONE_API_STACK.md` into the current Anti-Codex provider stack: local translator, Antigravity Desktop default, explicit third-party profiles, no ChatGPT login route, no original Codex mutation, and no fake connector authorization.
- `a462ce5` moved the old DeepCodex/DeepSeek video script into `docs/marketing/legacy/deepcodex-video-script.md` and created a current Anti-Codex `docs/marketing/video-script.md`.
- `1ea453d` refreshed `docs/chat-to-responses-compat.md` into the current provider compatibility contract, including OpenAI-compatible and Anthropic-compatible structured tool-history preservation. The `deepcodex.reasoning.hex.v1:` prefix remains documented only as an internal compatibility token.
- `9077d81` marked `docs/DEEPSEEK_RUNTIME_FAILURE_NOTES.md` as legacy DeepSeek-route notes so the file is not mistaken for the current default provider path.
- `a546ef3` clarified Windows setup docs: `codex-home-deepseek-app` is legacy compatibility state, and connector-backed app tools stay unavailable until real authorization exists.
- Short verification only was run for this follow-up: focused `rg` contract checks and `git diff --check`. Full source preflight and installed overall remain reserved for the next release-acceptance pass.
- `24b9d17` added launcher contract coverage for current public docs, using a whitelist of README, provider-stack, compatibility, and current marketing entry points instead of recursive historical scans.
- `579f802` refreshed README provider boundaries: Antigravity Desktop default, explicit third-party provider profiles through Manager, no silent wrong-upstream fallback, and no connector-backed app-tool authorization from metadata.
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
- Latest release-gate evidence: `shortReady:true`, `releaseReady:false`; missing release items are explicitly listed instead of inferred from old conversation context. Manager latest reports and diagnostic bundles now include the release-gate summary. Installed diagnostics bundle verification passed with release-gate evidence in `20260623-020134.zip`.
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

## 2026-06-23 Installed Missing-History Follow-Up

Update: installed `native-panel-v85` `viewLatestReports` now passes, installed fast UI state is green, and release gates validate the missing-history 410/no-traffic/no-route-change semantics directly.

- Added a signed installed no-traffic verifier for missing/pruned response history. It proves HTTP 410 `response_history_missing`, non-retryable recovery guidance, original ID preservation, and no model-route change.
- The report is now collected by installed overall and diagnostics, shown by Manager latest reports, and required by short/release passive gates.
- Fresh evidence: launcher contracts `96/96`; installed probe green; strict passive gates `shortReady:true`, `releaseReady:true`, no missing required or damaged reports; runtime healthy on Antigravity with 8 models and account ready.
- A real Manager latest-report click now passes on installed `native-panel-v85` and displays `历史过期恢复：通过`; installed fast UI state is green, and release gates validate the missing-history 410/no-traffic/no-route-change semantics directly.
