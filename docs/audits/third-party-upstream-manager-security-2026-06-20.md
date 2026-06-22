# Anti-Codex Third-Party Upstream Manager Security Audit

Date: 2026-06-20

Checked files:
- `translator/adaptive-server.mjs`
- `translator/upstream-provider.mjs`
- `scripts/anticodex-manager-inject.js`
- `translator/tests/upstream-integration.test.mjs`
- `translator/tests/anticodex-launcher.test.mjs`

## Authenticated Surfaces

- `POST /anticodex/upstream-test` requires the Manager action token.
- `POST /anticodex/upstream-profile` requires the Manager action token.
- `POST /anticodex/upstream-apply` requires the Manager action token.
- `POST /anticodex/manager/action` requires the Manager action token.
- `GET /anticodex/manager/action-script` requires the query token and a valid JSONP callback name.
- `GET /anticodex/upstream-profile` is intentionally public, but returns only redacted public profile data.

## Origin/Referrer Boundary

- Manager action validation checks `Origin` and `Referer` through the trusted local-origin helper.
- `GET /anticodex/manager/bootstrap` rejects explicitly untrusted browser origins before returning the token.
- `GET /anticodex/manager/action-script` rejects explicitly untrusted browser origins/referrers before running an action.
- Empty origin/referrer and `app:` origins remain allowed for local scripts and the Electron embedded surface. This is a compatibility boundary, not proof of remote trust.

## API Key Handling

- Third-party API keys are not sent on the command line.
- The profile script stores the key separately through Windows DPAPI CurrentUser protection.
- Public profile responses and connection-stage details are sanitized.
- Saving a third-party profile reruns the server-side connection test; client-provided stages are display evidence only.
- If the Manager form leaves the key field blank, the server may reuse the saved key after the request is authenticated.

## Regression Gates

- Unauthorized `/anticodex/upstream-test` returns 403 before reaching the upstream provider.
- Cross-origin `/anticodex/manager/bootstrap` returns 403.
- Cross-origin `/anticodex/manager/action-script` returns 403.
- Authorized connection tests still pass with the Manager token.
- Forged client stages cannot save a profile when the server-side provider test fails.
- Disk profile JSON must not contain the raw API key.
- Public profile JSON must not contain the raw API key.
- Static launcher coverage must keep the token header on the Manager test request and keep origin checks on bootstrap/action-script.

## Residual Risks

- Any local process running as the same Windows user can still talk to the loopback gateway. Anti-Codex treats this as a local trust boundary.
- `Origin: null` is allowed for compatibility with embedded/local surfaces; tightening it needs live Electron validation first.
- API keys are decryptable by the same Windows user because DPAPI uses `CurrentUser`.
- The JSONP action-script fallback exists for compatibility. It should stay covered by callback-name, token, and origin/referrer tests.
