# Anti-Codex Local Connector Allowlist Status

Date: 2026-06-22

## Implemented

- Added local connector allowlist read/write endpoints:
  - `GET /anticodex/local-connectors/allowlist`
  - `POST /anticodex/local-connectors/allowlist`
- Persisted allowlist to the isolated Anti-Codex `config.toml` under `[local_authorized_connectors]`.
- Kept environment allowlist support through `ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS`.
- Added embedded Manager UI editor for connector IDs.
- Added fallback Manager page editor for the same endpoint.
- Bumped embedded Manager version to `native-panel-v83`.
- Updated UI/static/source tests so future Codex syncs do not regress this feature.

## Validation

- Source syntax checks passed for `translator/adaptive-server.mjs`, Manager inject scripts, and UI verifier.
- `node --test translator/tests/local-access.test.mjs` passed.
- `node --test translator/tests/anticodex-launcher.test.mjs` passed.
- `scripts/test-anticodex-source-preflight.ps1 -SkipFullRegression` passed.
- Runtime sync passed.
- Installed gateway `http://127.0.0.1:8484/anticodex/local-connectors/allowlist` returned 200 with connector inventory and isolated config path.
- Installed plugin capability check passed: 183 plugins, 1494 connectors, 0 accessible connectors, 0 exposed app tools.
- Installed fast UI check passed with Manager `native-panel-v83` and local connector allowlist card present.
- Installed real mini-tool check passed with real Antigravity traffic: the model created a script, ran it, matched the marker, and returned normal Chinese text in the UTF-8 report.

## Remaining

- Short UI smoke now passes without hanging. The dynamic in-app Manager overlay probe may still record `dynamicProbeUnavailable` under short budgets, so full close-button/action QA should be run separately when specifically validating embedded Manager interactions.
- This allowlist only enables cached local connector/app-tool exposure when a connector has cached tools. It does not bypass real remote OAuth or external account authorization.
