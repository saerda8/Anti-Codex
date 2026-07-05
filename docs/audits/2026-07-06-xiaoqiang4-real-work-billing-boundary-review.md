# Xiaoqiang4 Real Work Billing Boundary Review

Marker: XQ4_REAL_WORK_BILLING_BOUNDARY_REVIEW_20260706

## Scope

This review defines the billing/quota evidence boundary for the Anti-Codex real-work and real-small-project scenarios. Local success evidence can prove the local workflow succeeded, but it must not be promoted into a provider-side billing or quota-decrement claim without provider quota evidence.

The review covers these evidence surfaces:

- local route/request evidence from Anti-Codex request and route ledgers;
- artifact success evidence from generated probe/project outputs and saved reports;
- test success evidence from the real-work and real-small-project verifiers;
- provider quota dashboard or provider quota API evidence.

## Evidence Boundary Matrix

| Evidence class | What it can prove | What it cannot prove |
| --- | --- | --- |
| Local route/request evidence | Anti-Codex selected a local route, built or forwarded a request, recorded request metadata, received local HTTP/application success, and attached timestamps, model labels, route ids, worker identity, or retry counts to the run. | It cannot by itself prove that the external provider accepted the request as billable inference, charged the account, decremented quota, or attributed the run to a specific provider quota bucket. Local route success is not external quota decrement. |
| Artifact success evidence | The verifier or workflow produced durable local outputs such as probe files, small-project files, markers, summaries, or report JSON entries. It can prove that the local task reached the expected artifact state and that saved files match the verifier contract. | It cannot prove provider billing, provider acceptance, or quota decrement unless the artifact embeds independently captured provider usage data. Artifact success is not external quota decrement. |
| Test success evidence | The real-work or real-small-project test passed its local assertions: expected request shape, model/tool continuation behavior, marker presence, local artifact creation, local report fields, and bounded completion semantics. | It cannot prove that provider-side accounting changed. A green test means the local verifier contract passed; it is not a billing receipt, invoice event, or provider quota decrement record. Test success is not external quota decrement. |
| Provider quota dashboard/API evidence | A provider dashboard screenshot/export or provider quota API read can show provider-reported usage, remaining quota, spend, or quota bucket state at a captured time, subject to account, filter, and freshness constraints. | It cannot safely attribute a delta to one local run unless the capture window, account/filter context, model/quota bucket, local request ids, and concurrent activity are controlled and documented. Dashboards may lag, round, aggregate, or bucket usage differently from local ledgers. |

## Boundary Statement

For real-work and real-small-project, local route/request success, artifact success, and test success are evidence of Anti-Codex local execution. They are not external billing proof.

Specifically:

- local route success is not an external quota decrement;
- local request success is not an external quota decrement;
- artifact success is not an external quota decrement;
- test success is not an external quota decrement.

A billing/quota conclusion is defensible only when local evidence is joined with provider-side quota evidence captured before and after the relevant run and correlated tightly enough to exclude other explanations.

## Required Evidence To Prove Quota Decrement

To claim that real-work or real-small-project decremented provider quota, collect all of the following:

1. Before-run provider dashboard or quota API capture, including account identity or account hash, provider, model family, quota bucket/filter, capture timestamp, timezone, units, and capture method.
2. After-run provider dashboard or quota API capture using the same account, provider, model family, quota bucket/filter, units, and capture method, taken after any known dashboard/API freshness delay.
3. Local run window with start/end timestamps, worker id, route id or request id, model label, provider target, local status, retry count, and report/artifact references.
4. Artifact references for the real-work probe output or real-small-project output, including markers and paths sufficient to tie the artifact to the local run window.
5. Test result references showing which verifier passed and which bounded assertions were satisfied.
6. Concurrency statement explaining whether any other provider-using jobs, UI tasks, retries, background agents, or manual requests could have affected the same provider account and quota bucket during the before/after window.
7. Attribution rationale mapping the observed provider quota delta to the local request ids and explaining dashboard lag, rounding, aggregation, or bucket mismatch risks.

Without before/after provider dashboard or quota API capture and a concurrency statement, the correct billing status is `externalQuotaDecrementObserved:unknown`, even if local route/request, artifact, and test evidence are all green.

## Recommended Summary Fields

Future real-work and real-small-project summaries should preserve the boundary explicitly:

- `localRouteSuccessIsBillingProof:false`
- `artifactSuccessIsBillingProof:false`
- `testSuccessIsBillingProof:false`
- `externalQuotaDecrementObserved:true | false | unknown`
- `externalQuotaBefore`, `externalQuotaAfter`, and `externalQuotaDelta` with units
- `quotaDashboardOrApiCaptureIds`
- `quotaDashboardFreshnessSeconds`
- `providerAccountIdHash`
- `providerQuotaBucket`
- `localRequestIds` or `localRouteIds`
- `realWorkArtifactIds` or `realSmallProjectArtifactIds`
- `testReportIds`
- `concurrentProviderActivity:none | possible | observed | unknown`
- `billingAttributionConfidence:none | low | medium | high`

## Conclusion

The real-work and real-small-project evidence chain can prove bounded local execution: route/request handling, artifact creation, and verifier success. It does not, by itself, prove external provider billing or quota decrement. Provider before/after dashboard or quota API evidence, plus a clear concurrency note, is required before making a quota-decrement claim.
