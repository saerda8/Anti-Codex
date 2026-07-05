# Xiaoqiang4 Real Mini Billing Boundary Review

Marker: XQ4_REAL_MINI_BILLING_BOUNDARY_REVIEW_20260706

## Scope

This review defines what each existing Anti-Codex evidence class can and cannot prove about billing/quota behavior for the Xiaoqiang4 real mini run. It is a boundary review, not a claim that local success automatically equals provider-side billing or quota decrement.

## Evidence Boundary Matrix

| Evidence class | What it can prove | What it cannot prove |
| --- | --- | --- |
| Local route/request evidence | Anti-Codex selected the expected local route, constructed a request, attempted provider-facing traffic, and received local success or recorded local request metadata. It can support claims about request shape, routing path, timestamps, model labels, worker identity, and local HTTP/application status. | It cannot by itself prove that the external provider accepted the request for billable inference, charged the account, decremented quota, or attributed usage to a specific provider dashboard bucket. Local route success is not external quota decrement. |
| UI payload evidence | The UI exposed or captured expected payload/model/provider fields and can show that the operator-facing workflow requested the intended model/configuration. | It cannot prove that the displayed payload was the final payload sent over the wire, that the provider processed it, or that billing/quota changed externally. UI state can corroborate intent, not provider accounting. |
| Artifact evidence | Generated outputs, logs, summaries, and saved artifacts can prove that the local workflow produced durable files with expected content, markers, worker references, and timestamps. | Artifacts cannot prove provider-side billing/quota decrement unless they embed independently verified provider usage data. Output existence is not equivalent to paid external inference. |
| Provider quota dashboard evidence | Dashboard screenshots, exports, or API reads can prove provider-reported quota, usage, or remaining balance at captured times, subject to dashboard freshness and account/filter correctness. | A dashboard alone may not attribute a decrement to one local request without correlation keys, time-window control, and exclusion of concurrent activity. It may also lag, round, aggregate, or bucket usage differently from local evidence. |

## Boundary Statement

Anti-Codex local evidence is strong for proving local routing, request construction, local success status, payload intent, and artifact creation. It is not sufficient on its own to prove external provider billing or quota decrement.

Defensible billing/quota conclusions require joining local evidence with provider-side quota evidence captured before and after the relevant run, with enough timing and identity metadata to distinguish the run from other activity.

## Correlation Requirements

- Pre-run provider quota/usage snapshot with account, provider, model family or quota bucket, capture timestamp, and capture method.
- Post-run provider quota/usage snapshot with the same account/filter context and a timestamp after dashboard/API freshness delay.
- Local request ledger entries with worker id, request id, route, model label, provider target, start/end timestamps, local status, and retry count.
- UI payload capture showing intended provider/model/payload fields for the same run window.
- Artifact references tying the run marker, worker ids, and output files to the local request ledger.
- Concurrency note describing whether other provider-using tasks could have affected the same quota bucket during the window.

## Follow-up Summary Fields

Future summaries should preserve this boundary instead of collapsing local success into billing proof:

- `localRouteSuccessIsBillingProof:false`
- `externalQuotaDecrementObserved:true | false | unknown`, based only on provider-side evidence.
- `externalQuotaBefore`, `externalQuotaAfter`, and `externalQuotaDelta` with units.
- `quotaDashboardCaptureIds` and `quotaDashboardFreshnessSeconds`.
- `providerAccountIdHash` and `providerQuotaBucket`.
- `localRequestIds`, `uiPayloadEvidenceIds`, and `artifactEvidenceIds`.
- `concurrentProviderActivity:none | possible | observed | unknown`.
- `billingAttributionConfidence:none | low | medium | high`.

## Conclusion

Local route/request, UI payload, and artifact evidence can establish that Anti-Codex performed the intended local workflow and produced durable outputs. Provider quota dashboard evidence is required to support external quota decrement.
