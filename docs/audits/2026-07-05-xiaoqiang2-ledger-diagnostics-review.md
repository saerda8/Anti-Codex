# Xiaoqiang2 Ledger Diagnostics Review

- Scope: review whether `latest-xiaoqiang-usage-ledger.json` belongs in diagnostics collection and validation.
- Source: `scripts/collect-anticodex-diagnostics.ps1` uses an explicit `$latestReports` allowlist for summarized report files.
- Current collector gap: the allowlist does not include `latest-xiaoqiang-usage-ledger.json`.
- Source: `scripts/test-anticodex-diagnostics.ps1` validates many report summaries, but not the usage-ledger report.
- Source: `scripts/test-anticodex-xiaoqiang-usage-ledger.mjs` writes the latest and history ledger reports plus `.sha256` sidecars.
- Recommendation: diagnostics should collect the ledger as a summarized safe report, not as raw transcript evidence.
- Required summary field: `ok`, to preserve pass/fail state without exposing prompts.
- Required summary field: `reportName`, expected to be `xiaoqiang-usage-ledger`.
- Required summary field: `noTraffic`, expected true for this documentation-ledger verifier.
- Required summary field: `usedRealTraffic`, expected false, so diagnostics do not imply live worker traffic.
- Required summary field: `behaviorCovered`, expected true when the doc-ledger evidence is complete.
- Required summary field: `coverageKind`, expected `xiaoqiang-forced-usage-doc-ledger-no-traffic`.
- Required summary field: `checkedStatusFiles`, with path/existence/byte metadata only.
- Required summary field: `requiredFailedJobIds`, with each job id and `presentInStatus` boolean.
- Required summary field: `requiredSuccessJobIds`, with each job id and `presentInStatus` boolean.
- Required summary field: `auditDocs`, with id, path, marker, markerPresent, keywordPresent, statusJobId, and bytes.
- Required summary field: `failures`, preserving failure codes/messages for missing docs, markers, job ids, or keywords.
- Required summary field: `elapsedMs` and report integrity fields from the existing diagnostics summary path.
- Diagnostics should verify the same high-level contract: ledger file present, hash sidecar valid, `ok:true`, and no missing markers/job ids.
- Diagnostics should not collect source document bodies, prompts, messages, tool output, or raw worker transcripts.
- Release recommendation: do not force release readiness solely from this ledger.
- Rationale: this ledger proves no-traffic documentation coverage of forced xiaoqiang usage reviews, not fresh release traffic.
- It may be a release-supporting visibility check, but it should not override current release-gate ownership.
- If added later, release enforcement should remain opt-in through existing release-gate or goal-readiness checks.
- Check run before edit: inspected the three requested scripts and confirmed the collector/test gap.
- Post-edit check: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-anticodex-diagnostics.ps1 -TimeoutSec 60`.
XQ2_LEDGER_DIAGNOSTICS_REVIEW_DONE
