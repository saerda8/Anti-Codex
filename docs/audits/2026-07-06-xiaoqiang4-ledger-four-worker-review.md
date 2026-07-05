# Xiaoqiang4 Ledger Four-Worker Review

Date: 2026-07-06

Marker: `XQ4_LEDGER_FOUR_WORKER_REVIEW_20260706`

## Scope

Reviewed the no-traffic Xiaoqiang usage ledger verifier against the newer four-worker project proof.

Inputs checked:

- `scripts/test-anticodex-xiaoqiang-usage-ledger.mjs`
- recent Xiaoqiang entries in `task_plan.md`
- `docs/audits/2026-07-06-ui-model-request-proof.md`

## Finding

The previous `xiaoqiang-usage-ledger` verifier was still biased toward the older xiaoqiang1/2/3 forced-usage documentation set. Its required document list contained only xq1, xq2, and xq3 audit docs, and its required successful job ids came from those three records. It did not validate xiaoqiang4.

The newer four-Xiaoqiang project proof is present in `task_plan.md`: xq1 `xqw_mr827db3_uu3kmt`, xq2 `xqw_mr818o4v_nc4767`, xq3 `xqw_mr81ur4n_0asegt`, and xq4 `xqw_mr821q8h_uhxspf` passed 4/4 for `xiaoqiang-project`. Each worker created the Node word-tally project, passed `node:test`, printed CLI JSON `red=2, blue=1`, and wrote the expected marker.

The usage ledger should remain a no-traffic accounting check. It should verify that the existing four-worker project proof is present and complete, but it should not claim external quota decrement or fresh route proof.

## Recommendation

Keep the existing 1/2/3 checks as historical forced-usage evidence, and add a separate four-worker no-traffic section that requires:

- all four worker ids: `xiaoqiang1`, `xiaoqiang2`, `xiaoqiang3`, and `xiaoqiang4`
- the four successful `xiaoqiang-project` job ids from `task_plan.md`
- the shared project proof shape: terminal completion, marker presence, workspace verification, `node:test` pass, CLI pass, and CLI JSON `red=2, blue=1`
- an explicit no-traffic ledger classification for the ledger itself

This lets the ledger cover both the older xq1/2/3 documentation audit and the current four-worker project proof without overstating quota evidence.
