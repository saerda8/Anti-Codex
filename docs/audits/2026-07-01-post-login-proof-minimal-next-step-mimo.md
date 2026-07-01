# Post-Login Proof: Minimal Next Step (MiMo)

Date: 2026-07-01
Scope: Read-only review of 6 scripts. No runtime state, no real traffic, no file modifications beyond this audit.

## Current Chain Status

| Layer | Script | Post-login proof field | Status |
|---|---|---|---|
| Plan definition | `test-anticodex-antigravity-account-isolation-status.ps1` L133-149 | `postLoginProofPlan` with command template | defined, placeholders only |
| Plan passthrough | `start-anticodex-second-antigravity-account-login.ps1` L57-84 | `postLoginProofCommandTemplate`, `canRunPostLoginProof` | passed through |
| Gate testing | `test-anticodex-second-account-login-entrypoint.ps1` L157-160 | `postLoginProofPlan`, `canRunPostLoginProof` | field presence checked |
| Readiness summary | `test-anticodex-second-account-readiness-summary.ps1` L221-222 | `postLoginProofCommandTemplate` | aggregated |
| Real-smoke execution | `test-anticodex-antigravity-cli-real-smoke.ps1` L289-306 | `-AllowSeparateAccountProof` path | executor exists |
| Goal readiness | `test-anticodex-goal-readiness.mjs` L424-427, L480, L492 | requires `releaseAcceptableAccountProof` | gate defined |
| Release gates | `test-anticodex-release-gates.mjs` L2015-2033 | validates all proof plan fields | enforced |
| Launcher tests | `translator/tests/anticodex-launcher.test.mjs` L12904-12909, L15029-15033 | asserts fields present | static coverage |

**Account isolation is NOT completed.** All entrypoint reports hardcode `separateAccountVerified = false`, `loginVerified = false`, `releaseAcceptableAccountProof = false`.

## The Gap: No Post-Login Proof Orchestrator

After the operator completes `.\AntiCodexModel` interactive login, the chain has:
- A plan (`postLoginProofPlan`) pointing to `test-anticodex-antigravity-cli-real-smoke.ps1`
- A command template with placeholders `<target-windows-user>`, `<isolated-antigravity-cli-profile>`, `<anticodex-account-id-or-fingerprint>`, `<mcp-account-id-or-fingerprint>`, `<explicit-user-approval-id>`
- A real-smoke script ready to execute with `-AllowRealTraffic -AllowSeparateAccountProof`
- Missing: one script that bridges login completion to parameter resolution, proof execution, and result collection.

The operator must manually compose and run the real-smoke command. No existing script resolves the placeholders, invokes the proof, or records the outcome.

## Minimum Next Step

**New script: `scripts/test-anticodex-second-account-post-login-proof.ps1`**

Purpose: Orchestrate the post-login proof run after the operator confirms `.\AntiCodexModel` login is complete.

### Required Parameters

| Parameter | Source | Notes |
|---|---|---|
| `-WindowsUser` | Operator input, default `.\AntiCodexModel` | Already used by all existing scripts |
| `-ProfileRoot` | Saved upstream profile or argument | Must resolve to an isolated path, not a default Antigravity location |
| `-AntiCodexAccountId` | Anti-Codex lane account fingerprint | New field; must be captured before proof run |
| `-McpAccountId` | MCP lane account fingerprint after login | New field; must be captured after login completes |
| `-SeparateAccountProofApprovalId` | Explicit operator approval token | Reuses existing approval pattern from entrypoint |
| `-ReportRoot` | Standard report path | Reuses existing convention |

### Fields to Produce

The script must emit a report with at minimum:
- `loginVerified = true` (marker-match from real-smoke)
- `separateAccountVerified = true` (account identity comparison passed)
- `releaseAcceptableAccountProof = true` (all proof conditions met)
- `accountIdentityComparison` (the `New-AccountIdentityComparison` result)
- `accountIsolationBoundary = "separate-windows-user"`

### Internal Flow

1. Read `postLoginProofPlan` from latest account-isolation-status report
2. Resolve placeholders with actual parameter values
3. Invoke `test-anticodex-antigravity-cli-real-smoke.ps1` with resolved parameters
4. Parse the real-smoke report for `loginVerified`, `separateAccountVerified`
5. Emit the post-login proof report to `$ReportRoot`

### Reuse

- `anticodex-report-io.ps1` for report writing (already shared by all scripts)
- `test-anticodex-antigravity-cli-real-smoke.ps1` as the proof executor (already handles `-AllowRealTraffic`, `-AllowSeparateAccountProof`)
- `New-AccountIdentityComparison` pattern from the real-smoke script (L150-167)

## No-Traffic Verification

This script must be testable without real traffic:
1. **Dry-run mode** (default, no `-AllowRealTraffic`): validates parameter resolution, command composition, report field structure
2. **Launcher test coverage**: the new script's report fields should be asserted in `translator/tests/anticodex-launcher.test.mjs` (pattern: `assert.match(report, /postLoginProofCommandTemplate/)`)
3. **Release gate validation**: the report fields must satisfy `test-anticodex-release-gates.mjs` checks for `releaseAcceptableAccountProof`
4. **Goal completion**: the report enables `antigravityAccountIsolation.releaseAcceptableAccountProof` in `test-anticodex-goal-readiness.mjs` L492

No Antigravity CLI traffic is generated in dry-run mode. The script delegates traffic generation to `test-anticodex-antigravity-cli-real-smoke.ps1` only when `-AllowRealTraffic` is explicitly passed.

## Non-Goals

- No scripts were modified.
- No runtime state was read or written.
- No real traffic was generated.
- This audit does not claim account isolation is completed.
