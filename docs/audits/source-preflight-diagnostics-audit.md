# Source Preflight Diagnostics Audit

Date: 2026-06-21

Result: DONE. The diagnostics path now checks all source-preflight evidence fields that the collector and live `/anticodex/diagnostics` endpoint expose.

Checked fields:
- `latest-source-preflight.json`
- `reportName`
- `skipFullRegression`
- `javascriptSyntaxOk`
- `powershellSyntaxOk`
- `uiStateSelfTestOk`
- `translatorRegressionOk`
- `diffWhitespaceOk`

Fix kept: `test-anticodex-diagnostics.ps1` now fails if `skipFullRegression` is missing from either the diagnostic bundle summary or the live diagnostics source-preflight status. The earlier UI-state field check is also preserved.
