# Xiaoqiang4 Diagnostics Snapshot Review

Date: 2026-07-06

Marker: `XQ4_DIAGNOSTICS_SNAPSHOT_REVIEW_20260706`

## Review

`localFeatures.snapshotStatus` in diagnostics is a freshness signal, not a standalone success claim. The diagnostics verifier currently requires the field shape (`state`, `stale`, `sourceFingerprintComparable`, `sourceFingerprintMatches`, and `staleReason`) so consumers can see whether the local feature snapshot is comparable and current.

When diagnostics is otherwise green but `localFeatures.snapshotStatus.stale:true`, treat the run as healthy enough to expose drift, but not as proof that the local feature evidence is latest. The next step should be to refresh the relevant evidence/snapshot through the normal verifier or refresh flow, then re-read diagnostics. Do not describe the stale snapshot as current just because the diagnostics command passed.

This matches the UI model-request evidence boundary: local reports may prove their own scoped signal, but they must not be overclaimed as a stronger or newer proof than the recorded fields support. A stale snapshot is therefore a follow-up refresh trigger, not a release note saying the evidence is up to date.

## Operational Rule

- Diagnostics green + snapshot fresh: evidence can be cited with its recorded timestamp/fingerprint context.
- Diagnostics green + snapshot stale: cite diagnostics as green for schema/health only, then refresh evidence before making any "latest" claim.
- Diagnostics missing `snapshotStatus`: treat as a verifier/schema failure.

No runtime directories were written for this review.
