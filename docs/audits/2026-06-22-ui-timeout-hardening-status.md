# Anti-Codex UI Timeout Hardening Status

Date: 2026-06-22
Status: Implemented and synced to installed runtime

## Result

- Source UI verifier now follows the requested timeout budget for manager probe calls instead of keeping hidden 20s/35s/40s waits.
- PowerShell wrapper now uses the main `TimeoutSec` as the default manager probe budget unless an explicit `ManagerProbeTimeoutSec` is provided.
- Short smoke checks can degrade a Manager overlay dynamic timeout into `dynamicProbeUnavailable` when `SkipManagerActionProbe` is set and static/context evidence is valid.
- Full dynamic UI QA still has to run without the skip path when validating close-button hit areas and action behavior.

## Verified

- `node --check scripts/test-anticodex-ui-state.mjs`
- PowerShell parser check for `scripts/test-anticodex-ui-state.ps1`
- `node --test translator/tests/anticodex-launcher.test.mjs`
- `powershell.exe -File scripts/sync-anticodex-runtime.ps1 -NoRestart -TimeoutSec 45`
- Installed fast UI smoke: passed in about 1.5 seconds.
- Installed short non-fast UI smoke: passed in about 9.5 seconds with `dynamicProbeUnavailable` recorded.
- `powershell.exe -File scripts/test-anticodex-source-preflight.ps1 -SkipFullRegression`

## Notes

- Installed health was ready after sync: upstream `antigravity-desktop`, account ready, model count `8`.
- The model catalog exposed the expected Antigravity model labels including Gemini 3.5 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6, Claude Opus 4.6, and GPT-OSS 120B variants.
