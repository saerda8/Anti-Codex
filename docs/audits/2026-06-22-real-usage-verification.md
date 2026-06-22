# Anti-Codex Real Usage Verification

Date: 2026-06-22

## Result

- Installed fast overall: passed in 30.1 seconds.
- Real Chinese response: passed in 12.2 seconds with `gemini-3.5-flash-low`.
- Real CLI tool task: passed in 26.7 seconds; file created, executed, and marker verified.
- Real probe-file task: passed in 23.9 seconds; file created, executed, and marker verified.
- Final source preflight: passed in 18.4 seconds.

## Fixes

- The fast tool-bridge check now uses a dedicated 20-second diagnostics timeout.
- Chinese prompts must receive Chinese final responses.
- Real response verifiers reject the legacy `DeepCodex` brand.
- UI verification accepts the Manager's valid `source_changed` snapshot-refresh guidance.
