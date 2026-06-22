# Anti-Codex Handoff For Next Channel

Date: 2026-06-23
Branch: main

## Current State

- Anti-Codex is an isolated desktop/runtime fork using Antigravity Desktop as the default model provider.
- Installed runtime on `http://127.0.0.1:8484` was healthy during the last checks: upstream `antigravity-desktop`, account ready, 8 models.
- Manager is at `native-panel-v84`.
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
