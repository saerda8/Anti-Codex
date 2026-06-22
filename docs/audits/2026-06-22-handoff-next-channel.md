# Anti-Codex Handoff For Next Channel

Date: 2026-06-22
Branch: main

## Current State

- Anti-Codex is an isolated desktop/runtime fork using Antigravity Desktop as the default model provider.
- Installed runtime on `http://127.0.0.1:8484` was healthy during the last checks: upstream `antigravity-desktop`, account ready, 8 models.
- Manager is at `native-panel-v83`.
- Fast UI smoke passed. Short non-fast UI smoke now uses explicit timeout budgets and records `dynamicProbeUnavailable` instead of hanging when the embedded dynamic probe times out.
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

## Next Work

1. Add a script-level local connector/app-tool verifier.
   - Existing unit proof: `translator/tests/local-access.test.mjs` already proves `[local_authorized_connectors]` can expose only allowlisted cached app tools.
   - Missing gate: a repeatable script under `scripts/` that uses a temporary isolated Codex home, simulates connector/app-tool cache, verifies `/backend-api/aip/connectors` and `/backend-api/wham/apps`, and proves unallowlisted tools are not exposed.
   - Do not claim remote connector authorization. This is a local developer allowlist only.

2. Add longer third-party provider history-switch verification.
   - Existing verifier: `scripts/test-anticodex-third-party-provider.mjs`.
   - Current gap: longer Antigravity -> third-party -> Antigravity style continuity with multiple `previous_response_id` turns.
   - Preserve `response-history.json` and project state across provider switching.

3. Keep stability and identity invariants.
   - No ChatGPT login path in Anti-Codex.
   - No fake connector/app-tool callability.
   - Original Codex remains untouched.
   - Anti-Codex branding and icon must survive host sync.

## Worker Note

- Antigravity worker job `ag-dcc4d310-69dd-472a-85de-bd2a134ac317` was started for an ASCII connector verifier gap audit but did not produce the expected report before handoff.
- Treat that worker result as not accepted unless the output file appears and is manually inspected.

## Files To Read First In New Channel

- `AGENTS.md` or the injected project instructions.
- `C:\Users\XD\.codex\RTK.md`
- `MCP_WORKER_RULES.md`
- `task_plan.md`
- `findings.md`
- `docs/audits/2026-06-22-handoff-next-channel.md`
- `docs/audits/2026-06-22-ui-timeout-hardening-status.md`
- `docs/audits/2026-06-22-local-connector-allowlist-status.md`
