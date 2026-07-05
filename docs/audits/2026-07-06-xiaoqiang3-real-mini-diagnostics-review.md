# Xiaoqiang3 Real Mini Diagnostics Review - 2026-07-06

Marker: `XQ3_REAL_MINI_DIAGNOSTICS_REVIEW_20260706`

## Scope

This review covers the diagnostic/summary path for `latest-real-mini-tool.json` and the reporting question of whether the summary should explicitly expose `first_response_id` and quota-boundary evidence.

## Current Handling

- `latest-real-mini-tool.json` is a local diagnostic artifact. It records the real mini-tool verifier result and may include route identifiers, timestamps, transport/status details, and model/tool response data captured during the run.
- Collection should preserve enough structured evidence for local debugging and freshness checks, including whether a local route was observed and the first upstream response id when present.
- Summarization should convert the diagnostic artifact into a bounded user-facing status summary. It should not dump raw JSON and should not promote local diagnostic evidence into external billing proof.

## Diagnostic Evidence Boundary

A diagnostic collection report is not external billing or quota proof. A fresh `chatcmpl_*` `first_response_id` and matching local route entries can prove local Anti-Codex real-model traffic through the configured path, but they do not prove that an external provider dashboard decremented, that a billing ledger accepted the request, or that account quota accounting changed.

The summary may therefore say that local route evidence was observed, but it must keep the quota boundary explicit: local diagnostics are request/route evidence only, not an external billing statement.

## Recommended Summary Fields

- `status` or `passed`: whether the verifier completed successfully.
- `updatedAt` or run timestamp: freshness signal for the diagnostic artifact.
- `first_response_id`: first local upstream response id, bounded for display if needed.
- `route_observed` or `modelRouteObserved`: whether a new local route entry was observed during the run.
- `transport` and `route_status`: normalized route metadata such as `desktop-cascade` and `success`.
- `quota_boundary`: fixed wording that the report is local diagnostic evidence, not external billing/quota-dashboard proof.

## Redaction Requirements

The summary must avoid leaking transient implementation details: temporary absolute paths, complete raw model text, full prompt/completion bodies, raw tool arguments that embed filesystem paths, or unbounded report JSON.

## Recommendation

Expose `first_response_id` and quota-boundary status as sanitized structured fields. This gives reviewers clear local route evidence while preventing the summary from overstating billing evidence or leaking temporary paths and full model text.
