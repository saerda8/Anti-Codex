# Second Antigravity Account Proof Gap

Date: 2026-07-01
Scope: Factual summary from existing repo docs only. No runtime state, no real traffic.

## Status

Current release gates can be green while the broader goal remains incomplete.
No-traffic preparation is covered, but real proof of a distinct second
Antigravity account identity has not been demonstrated with actual traffic.

## What Release Gates Prove Today

- `source-preflight` mandates `credentialBoundary:"separate-windows-user"`,
  target-user readiness, and default-child rejection in a signed
  `latest-source-preflight.json` block (see `2026-06-30-real-task-coverage-next.md`).
- SID identity boundary evidence must keep the target Windows user distinct from
  the current Windows user before interactive login is allowed.
- Four no-traffic preflight reports exist: `windows-user-setup-guidance`,
  `windows-user-account-prepare`, `antigravity-cli-windows-user-readiness`,
  `antigravity-account-isolation-status`.

## What Is Not Yet Proved

1. **Real traffic from a distinct account.** The preflight gates verify
   structural fields (SID mismatch, credential boundary, dry-run readiness).
   They cannot prove that an interactive login on a separate Windows user
   actually reaches a different Antigravity account with real model traffic.

2. **Distinct account identity comparison.** No structured
   `accountIdentityComparison` block with `AntiCodexAccountId` vs.
   `McpAccountId` and a signed approval token has been produced with real traffic.

3. **`.\AntiCodexModel` target user.** The approved real-run sequence
   (`2026-06-30-approved-real-run-sequence-review.md`) states the correct
   next operator action is separate Windows-user setup before any second-account
   login. The target path `.\AntiCodexModel` is the planned separate Windows
   user lane; readiness reports must block if that user is absent or equals the
   current Windows user.

## Lane Boundaries

- **Model-text account lane:** Owned by Anti-Codex. Proved via real Antigravity
  CLI traffic (see `2026-06-22-release-gap-audit-antigravity.md`,
  `2026-06-22-real-usage-verification.md`).
- **MCP account lane:** External to Anti-Codex. The MCP tool bridge is
  disabled by default (`isAntigravityNativeToolBridgeEnabled` defaults to false).
  Real MCP tool-loop proof requires explicit user approval and a separate
  real-traffic gate (`2026-06-22-mcp-plugin-real-use-gap.md`).

## Same-User Isolation Is Not Sufficient

Existing docs confirm that same-Windows-user file/AppData isolation is
insufficient. An isolated profile/AppData login still showed the already
signed-in account (`2026-06-30-real-task-coverage-next.md`, section 2).
Real proof needs either:

- A separate Windows user, OR
- An official independent credential store

...with explicit user-approved interactive login, explicit approved real
traffic, and a structured distinct-account-id comparison.

## Next Proof Steps

1. Create or verify the `.\AntiCodexModel` Windows user.
2. Run `test-anticodex-windows-user-setup-guidance.ps1` and
   `test-anticodex-windows-user-account-prepare.ps1` against the target user.
3. Run `test-anticodex-antigravity-cli-windows-user-readiness.ps1` and verify
   the target user is present and distinct from the current Windows user.
4. Perform interactive Antigravity CLI login from the new user with explicit
   approval.
5. Run real model traffic (model-text lane) and capture
   `AntiCodexAccountId`.
6. Run real MCP traffic (MCP lane) with explicit approval and capture
   `McpAccountId`.
7. Produce a signed `accountIdentityComparison` block showing distinct IDs,
   approval metadata, and capture timestamp.
8. Re-run release gates to verify `accountProxyReadiness` and
   `postVerification` with real traffic.

## Non-Goals

- Modifying scripts, translator, or runtime code from this audit.
- Running real traffic or launching Antigravity.
- Simulating or faking login results in no-traffic reports.
- Collapsing the second-account proof boundary.
- Reimplementing Codex client/tool features.
