# Goal-Level Real Run Readiness Review

Date: 2026-06-30
Scope: docs/audits only. No runtime state, no real traffic, no environment changes.

## Current State

`real-approval-plan` and `required-real-traffic-sequence` exist as no-traffic
machine-reviewed reports. They correctly identify `postVerification` and
`accountProxyReadiness` as required release gates currently blocked by design
until explicit user approval.

Status: `shortReady:true`, `releaseReady:false`,
`releaseBlockedOnlyByRequiredRealTraffic:true`.

## Gaps Identified

1. **No structured goal-level real-run preflight checklist.**
   Existing reports focus on no-traffic preparation. There is no single
   artifact that answers: "Given we want to run real traffic, what are the
   preconditions for each task shape (second account, web-search/free-chat
   refresh, postVerification/accountProxyReadiness), and are they met?"

2. **Second account setup proof remains underdefined.**
   The approval plan requires a separate Windows user path, but the
   preflight conditions for entering that path (isolation boundary proof,
   approval token, distinct account IDs) are scattered across multiple
   reports. A consolidated preflight gate would reduce operator confusion.

3. **web-search/free-chat refresh and release gates are conflated in the
   approval plan.** The plan lists them in sequence, but does not
   explicitly mark which are optional (provider/soak) vs. required
   (release-blocking). This is partially addressed in the sequence
   verifier, but a goal-level preflight report would make the dependency
   explicit.

## Recommendations (Max 3)

1. **Add `latest-goal-real-run-readiness.json` as a release-gate sibling.**
   It consumes `latest-real-approval-plan.json` and emits, per required
   real-traffic action: precondition fields, current status, and a
   boolean `readyToRun`. Release gates would reject if any required
   action has `readyToRun:false`.

2. **Consolidate second-account preflight into the same artifact.**
   Instead of four separate reports (`windows-user-setup-guidance`,
   `windows-user-account-prepare`, `antigravity-cli-windows-user-readiness`,
   `antigravity-account-isolation-status`), roll their semantic fields
   into a single `secondAccountPreflight` block inside the preflight
   report. This keeps the surface area small for release-gate consumers.

3. **Tag optional vs. required in the preflight report explicitly.**
   The sequence verifier already separates them; the preflight report
   should inherit that classification so that a single glance at
   `missingRequired` vs. `optionalPending` tells the operator exactly
   what blocks release.

## Not In Scope

- Running real traffic or launching Antigravity.
- Reading `.env` or environment state.
- Modifying scripts, translator, task_plan, or findings files.

## Conclusion

A goal-level real-run preflight report would close the gap between
"no-traffic preparation is complete" and "we know exactly what real-traffic
steps are required and whether their preconditions are met." The three
recommendations above give a minimal, machine-checkable surface for that.
