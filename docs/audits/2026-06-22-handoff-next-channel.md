# Anti-Codex Handoff For Next Channel

Date: 2026-06-22
Branch: main

## Current State

- Anti-Codex is an isolated desktop/runtime fork using Antigravity Desktop as the default model provider.
- Installed runtime on `http://127.0.0.1:8484` was healthy during the last checks: upstream `antigravity-desktop`, account ready, 8 models.
- Manager is at `native-panel-v84`.
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

## Next Work

1. Keep stability and identity invariants.
   - No ChatGPT login path in Anti-Codex.
   - No fake connector/app-tool callability.
   - Original Codex remains untouched.
   - Anti-Codex branding and icon must survive host sync.

2. Next useful hardening.
   - Add report integrity/signature or invalid-report surfacing so corrupted latest JSON is shown as invalid, not merely absent.
   - Keep Manager button verification serial; do not run Manager/UI verifiers in parallel with installed overall.
   - Re-run runtime sync with translator restart when adaptive-server action inventory changes.

## Completed In This Channel

- Script-level local connector/app-tool verifier exists and passes: `test-anticodex-local-connectors.mjs` proves local endpoint behavior without claiming remote OAuth or real connector authorization.
- Full connector/app-tool cache parity exists and passes in `test-anticodex-plugin-capabilities.ps1`: current evidence is connector parity `5777/5777`, app-tool parity `52/52`, `missingShared:[]`, and callable app tools `0` because no connector is actually authorized.
- Third-party provider history-switch verifier now covers nine turns across provider save, translator restart, OpenAI-compatible provider switch, OpenAI-compatible to Anthropic switch, and Anthropic back to OpenAI-compatible switch.
- Manager latest reports now include MCP/Skill, plugin capabilities, refresh-features, and stability-soak reports; `viewLatestReports` was verified by a real embedded Manager button click.

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
