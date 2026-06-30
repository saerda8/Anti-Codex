# Real Task Coverage Matrix -- Next No-Traffic Preparation

Date: 2026-06-30
Branch: main
Scope: docs/audits only. No runtime state, no real traffic, no environment changes.

## Conclusion

Current agentic delivery proof is complete for five desktop task shapes.
The remaining blockers are by-design real-traffic gates: second-account
Antigravity identity, account/proxy readiness, and post-verification.
Everything else can stay prepared as no-traffic machine-reviewed report
structure until explicit user approval.

## 1) Already Proved Five Agentic Real Tasks

Source of truth: `test-anticodex-desktop-task-suite.mjs`, agentic profile.

| Task mode | Latest signed report | Status |
|-----------|---------------------|--------|
| coding-project | `ui-coding-project-smoke.json` | real-traffic ok, final |
| multi-turn-project | `ui-multi-turn-project-smoke.json` | real-traffic ok, final |
| report-site | `ui-report-site-smoke.json` | real-traffic ok, final |
| complex-project | `ui-complex-project-smoke.json` | real-traffic ok, final |
| repo-multi-file-edit | `ui-repo-multi-file-edit-smoke.json` | real-traffic ok, final |

The repeatable runner supports `--suite-profile agentic`, signs
`latest-desktop-task-suite.json` + `.sha256`, and already proves in dry-run
mode: per-task freshness (`realTaskEvidenceFresh`), all five selected, zero
hard failures, and `realTaskEvidenceRefreshPlan.needed == false`.

Release gates / diagnostics / Manager now require this signed summary
directly, so the concrete-task matrix is machine-checked.

## 2) Still Cannot Be Automatically Proved Without User Approval

These gates require explicit real traffic or real login. No-traffic
preparation can harden the approval path, but it cannot produce a
`true` proof itself.

- Second Antigravity account real identity isolation.
  Same-Windows-user file/AppData isolation is insufficient; an isolated
  profile/AppData login still showed the already signed-in account. Real
  proof needs a separate Windows user or an official independent credential
  store, explicit user-approved interactive login, explicit approved real
  traffic, and a structured distinct-account-id comparison (`-AllowSeparateAccountProof`
  + AntiCodexAccountId/McpAccountId + `-SeparateAccountProofApprovalId`).

- Account/proxy readiness (`postVerification`, `accountProxyReadiness`).
  These are release-required gates that consume real Antigravity/model
  traffic and are blocked by design without explicit user approval.

- Live account-model refresh / tool-loop re-proof after a new source sync.
  Best practice is re-run `--allow-real-traffic` agentic suite or targeted
  real-work/mini-tool probes under explicit approval before claiming
  refreshed proof.

## 3) Next No-Traffic Machine-Report / Gate Preparation Items

All stay dry-run-only; none start Antigravity worker, run real model
traffic, or modify runtime state.

A. Strengthen no-traffic account-lane release gate
   - Ensure `source-preflight` mandates the separate-Windows-user dry-run
     `credentialBoundary:"separate-windows-user"`, target-user readiness,
     and default-child rejection in one signed `latest-source-preflight.json`
     block that release gates can reject field-by-field.
   - Current blocker to resolve first in operator flow:
     `target_windows_user_missing`, next step
     `open_elevated_windows_user_settings_then_rerun_prepare`.

B. Keep dry-run task-suite freshness mandatory for release
   - Continue to require `realTaskEvidenceFresh:true` plus zero
     `realTaskEvidenceHardFailures` before release.
   - Continue to require `realTaskEvidenceRefreshPlan.needed:false` for
     the agentic profile as a release stringency gate.
   - Add a lightweight verifier that confirms the field set exists in the
     signed summary, so a future report drift cannot silently drop the
     agentic block.

C. Surface the setup plan in the same machine-visible path
   - `latest-windows-user-setup-guidance.json`
   - `latest-windows-user-account-prepare.json`
   - `latest-antigravity-cli-windows-user-readiness.json`
   - `latest-antigravity-account-isolation-status.json`
   Keep release gates requiring their signed semantic fields inside diagnostics /
   release-gate JSON; keep them no-login / no-password-capture /
   no-Desktop / no-real-traffic.

D. Add a no-traffic once-per-session dry-run sanity probe
   - A single command that runs
     `test-anticodex-desktop-task-suite.mjs --suite-profile agentic`,
     asserts `usedRealTraffic:false` / `realTaskEvidenceComplete:true` /
     `realTaskEvidenceFresh:true`, and exits non-zero if freshness is lost.
   - This gives the operator a cheap daily gate between real-traffic
     acceptance gates, without consuming tokens.

E. Do not collapse the second-account proof boundary in preparing reports
   - Reject any future report that sets `separateAccountVerified:true`
     without a structured `accountIdentityComparison`, distinct IDs,
     approval metadata, and a valid capture timestamp.
   - No-traffic logs may declare that the real proof *would* require the
     separate-windows-user lane and the explicit approval token; they must
     not simulate a login result.

## Verified No-Traffic Sources

- `scripts/test-anticodex-desktop-task-suite.mjs` supports
  `--suite-profile agentic` and writes signed
  `latest-desktop-task-suite.json`.
- `scripts/test-anticodex-antigravity-cli-windows-user-readiness.ps1`
- `scripts/test-anticodex-windows-user-account-prepare.ps1`
- `scripts/test-anticodex-windows-user-setup-guidance.ps1`
- `scripts/test-anticodex-antigravity-account-isolation-status.ps1`
- `scripts/test-anticodex-source-preflight.ps1` validates lane / owner /
  default-child rejection / structured proof fields.
- No real traffic, no logins, no desktop launches, no `.env` reads.
