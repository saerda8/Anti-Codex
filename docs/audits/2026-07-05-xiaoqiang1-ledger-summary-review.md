# Xiaoqiang usage ledger summary review

- Recommendation: `latest-xiaoqiang-usage-ledger.json` should be supported by `scripts/summarize-anticodex-report.mjs`.
- Reason: `collect-anticodex-diagnostics.ps1` promises report files are summarized instead of copied raw, but the ledger is a compact, no-traffic proof report that can be safely summarized.
- The summary should include `reportName`, `ok`, `noTraffic`, `usedRealTraffic`, `behaviorCovered`, and `coverageKind`.
- It should include `checkedAt`, `elapsedMs`, and summarized `checkedStatusFiles` with only `path`, `exists`, and `bytes`.
- It should include `requiredFailedJobIds` as job ids plus `presentInStatus`, because they prove the forced failed xiaoqiang attempts were recorded.
- It should include `requiredSuccessJobIds` as job ids plus `presentInStatus`, because they tie the successful delegated workers back to the status source.
- It should include `auditDocs` entries with `id`, `path`, `exists`, `marker`, `markerPresent`, `statusJobId`, `keywordPresent`, `matchedKeyword`, and `bytes`.
- It should include `failureCount` or the existing generic `failures` count, and may expose failure codes/messages when present.
- It should not include raw document text from the audited Markdown files.
- It should not include full `repoRoot` as a release requirement; at most summarize that it was present.
- It should not turn xiaoqiang-specific job ids into permanent release-required gates.
- It should not require `latest-xiaoqiang-usage-ledger.json` for every release-gates run, because the report documents an audit episode rather than a universal product invariant.
- It should not make `checkedStatusFiles` existence a new release requirement outside this ledger test.
- It should not require future audit docs to reuse these exact markers or domain keywords unless a matching xiaoqiang audit is explicitly requested.
- `collect-anticodex-diagnostics.ps1` currently lists many latest reports but not `latest-xiaoqiang-usage-ledger.json`, so diagnostics would not pick it up without an explicit addition.
- `summarize-anticodex-report.mjs` currently has xiaoqiang project-smoke handling but no dedicated usage-ledger evidence block.
- Recommended evidence field name: `xiaoqiangUsageLedgerEvidence`.
- Recommended diagnostic behavior: include the latest ledger only as safe optional evidence, preserving the no-traffic distinction.
- Check run after this review: `node scripts/test-anticodex-xiaoqiang-usage-ledger.mjs --no-write-report`.
- Review conclusion: add summarizer support when touching diagnostics/report summaries next, but do not promote the ledger into release-required coverage.
XQ1_LEDGER_SUMMARY_REVIEW_DONE
