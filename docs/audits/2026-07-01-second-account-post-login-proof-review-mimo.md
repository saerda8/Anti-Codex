# Second Account Post-Login Proof Chain Review (MiMo)

Date: 2026-07-01
Scope: Read-only audit of the existing operator login flow and post-login proof gap after `.\\AntiCodexModel` is created and the interactive login completes. No runtime state, no real traffic, no script changes.
Main-agent note: worker audit only; treat as a follow-up checklist until the main path verifies each field against current scripts.

## Conclusion

**After the user creates `.\\AntiCodexModel` and completes interactive Antigravity CLI login, the existing scripts still cannot produce release-acceptable second-account proof.** There are 4 concrete field/script gaps that block the chain from login completion to `separateAccountVerified: true` / `releaseAcceptableAccountProof: true`.

---

## Gap 1: `completionState` never leaves `blocked_before_interactive_login`

**Script:** `test-anticodex-antigravity-account-isolation-status.ps1` (consumed by `start-anticodex-second-antigravity-account-login.ps1` line 54)

**Field:** `completionState`

The account-isolation status script resolves `$completionState` at lines 113-118 of `test-anticodex-antigravity-account-isolation-status.ps1`. When the target user is not the current user, the value is always `"blocked_before_interactive_login"` — even after the user has completed interactive login via `runas`. No branch in that script transitions `completionState` to a logged-in or proof-ready state. The entrypoint verifier (`test-anticodex-second-account-login-entrypoint.ps1` line 85, 161) propagates this value into its report, so downstream consumers (goal-readiness, release gates) always see the blocked state.

**Impact:** Every downstream gate that checks `completionState` for a ready/post-login value will remain blocked.

---

## Gap 2: No script captures `AntiCodexAccountId` / `McpAccountId` after login

**Script:** `test-anticodex-antigravity-cli-real-smoke.ps1` (params at lines 11-12)

**Fields:** `-AntiCodexAccountId`, `-McpAccountId`

The real-smoke script requires `-AntiCodexAccountId` and `-McpAccountId` string parameters (lines 11-12) and fails the separate-account proof if either is empty (line 290-291). However, the post-login proof plan emitted by `test-anticodex-antigravity-account-isolation-status.ps1` (line 135) uses placeholder tokens `<anticodex-account-id-or-fingerprint>` and `<mcp-account-id-or-fingerprint>`. No existing script queries the newly logged-in Antigravity CLI session to capture the actual account identifiers and fill these placeholders.

**Impact:** Even with a successful interactive login, the operator has no automated way to obtain the two account IDs required by `-AllowSeparateAccountProof`.

---

## Gap 3: `separateAccountVerified` / `loginVerified` hardcoded to `$false` in entrypoint

**Script:** `start-anticodex-second-antigravity-account-login.ps1` (lines 91-93) and `test-anticodex-second-account-login-entrypoint.ps1` (lines 165-167)

**Fields:** `separateAccountVerified`, `loginVerified`

Both the login entrypoint script and its verifier hardcode `separateAccountVerified = $false`, `loginVerified = $false`, and `releaseAcceptableAccountProof = $false`. The entrypoint script delegates to `start-anticodex-antigravity-cli-login-windows-user.ps1` (line 126-128) which returns `started: true` for the `runas` launch, but no post-launch verification step checks whether the login session actually authenticated to a distinct Antigravity account. The verifier (`test-anticodex-second-account-login-entrypoint.ps1` lines 118-120) explicitly asserts these fields must be `$false` and fails the report if they are not.

**Impact:** The entrypoint evidence never claims login completion or account verification, so goal-readiness (`latest-goal-readiness.json`) cannot treat the login as proven.

---

## Gap 4: `postLoginProofPlan.commandTemplate` is unpopulated placeholders only

**Script:** `test-anticodex-antigravity-account-isolation-status.ps1` (line 135) consumed by `start-anticodex-second-antigravity-account-login.ps1` (line 57-59)

**Field:** `postLoginProofPlan.commandTemplate`

The `postLoginProofPlan.commandTemplate` emitted by the status script contains literal placeholders: `<target-windows-user>`, `<isolated-antigravity-cli-profile>`, `<anticodex-account-id-or-fingerprint>`, `<mcp-account-id-or-fingerprint>`, `<explicit-user-approval-id>`. The entrypoint verifier (`test-anticodex-second-account-login-entrypoint.ps1` lines 82-84) checks that the template *contains* `-WindowsUser` and reports `canRunPostLoginProof` from the status script, but never substitutes the placeholders with actual values from a post-login session. No script in the chain performs placeholder resolution.

**Impact:** The operator must manually compose the real-smoke command with actual values; there is no automated path from login completion to a runnable proof command.

---

## What These Gaps Mean Together

| Chain step | Script | Status after login |
|---|---|---|
| Create `.\AntiCodexModel` user | External (operator) | ✅ operator action |
| Run account-isolation status | `test-anticodex-antigravity-account-isolation-status.ps1` | ⚠️ `completionState` stays `blocked_before_interactive_login` |
| Start interactive login | `start-anticodex-second-antigravity-account-login.ps1` | ✅ `runas` launched, `startedLogin: true` |
| Verify login completed | (no script exists) | ❌ no verifier |
| Capture account IDs | (no script exists) | ❌ `AntiCodexAccountId` / `McpAccountId` unpopulated |
| Run post-login proof | `test-anticodex-antigravity-cli-real-smoke.ps1` | ⚠️ requires filled-in parameters; template is placeholders only |
| Record `separateAccountVerified` | `start-anticodex-second-antigravity-account-login.ps1` | ❌ hardcoded `$false` |
| Release gate acceptance | `releaseAcceptableAccountProof` field | ❌ hardcoded `$false` in all entrypoint reports |

## Non-Goals

- No scripts were modified.
- No runtime state was read or written.
- No real traffic was generated.
- No recommendation to modify MCP configuration.
- No recommendation to use Antigravity Desktop/coworker.
