# UI Model Request Proof Review

Date: 2026-07-06

Marker: `UI_MODEL_REQUEST_PROOF_20260706`

## Conclusion

The quota concern was valid. Before this pass, several desktop UI reports could prove that Anti-Codex clicked, answered, and produced artifacts, but they did not clearly separate "a model request payload was sent" from "the `/anticodex/model-routes` ledger gained a new route".

The verifier now records both fields:

- `modelRequestPayloadObserved`: the desktop UI path emitted a Responses websocket payload or an equivalent per-turn real-submit proof.
- `modelRouteObserved`: `/anticodex/model-routes` gained a new route during the test window.

For current UI desktop tasks, `modelRequestPayloadObserved:true` is required. `modelRouteObserved:true` is stronger evidence, but it is not required for every UI path because some visible desktop UI tasks send websocket payloads without updating `/anticodex/model-routes`.

## Current Evidence

- Direct real mini-tool traffic remains the strongest route-ledger proof. It produced fresh `chatcmpl_*` route ids with `transport:"desktop-cascade"` and `status:"success"`.
- Fresh desktop UI suite passed 7 tasks with real traffic: exact marker chat, web search, local project, coding project, repo file edit, repo multi-file edit, and report site.
- Fresh targeted rerun passed multi-turn project and repo multi-file edit after the verifier started writing the new request-proof fields.
- Multi-turn project produced both `modelRequestPayloadObserved:true` and `modelRouteObserved:true`.
- Repo multi-file edit produced `modelRequestPayloadObserved:true` with `modelRouteObserved:false`, proving the UI request path can be real even when the route ledger does not increment.

## Worker Notes

- xiaoqiang1 and xiaoqiang2 returned partial advisory diffs that pointed at the same UI proof gap.
- xiaoqiang3 returned no valid changes.
- xiaoqiang4 produced the clearest independent review: artifact completion is not enough to prove current quota traffic, and route-ledger proof must be separated from UI payload proof.

## Guardrail

Do not use artifact creation alone as quota proof. For desktop UI gates, require `modelRequestPayloadObserved:true` or a new route. For hard billing/route proof, prefer fresh `/anticodex/model-routes` ids from a direct real-traffic verifier.
