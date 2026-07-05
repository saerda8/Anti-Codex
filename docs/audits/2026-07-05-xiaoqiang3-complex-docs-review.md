# Xiaoqiang3 complex project documentation review

Marker: XIAOQIANG3_COMPLEX_DOCS_REVIEW_20260705

Scope: documentation review after making the Xiaoqiang `complex-project` smoke release-visible through ecosystem surfaces.

## Current documentation state

- `task_plan.md` records the Xiaoqiang real-task expansion with both task shapes:
  - `xiaoqiang-project`: jobs `xqw_mr7oc197_rovf4e`, `xqw_mr7ogyjm_jqd13r`, and `xqw_mr7oin36_mimu8j`.
  - `complex-project`: jobs `xqw_mr7oks5z_crpav9`, `xqw_mr7onpte_w0szsz`, and `xqw_mr7or1gx_7h505d`.
- `findings.md` records that the complex-project smoke passed 3/3 with sources/report/html/analyzer/test outputs.
- `docs/audits/2026-06-22-handoff-next-channel.md` records the same current state and the connector-cache recovery flow needed after shared cache drift.

## Documentation update needed

Release-facing summaries should explicitly say that the ecosystem-surface proof now includes the Xiaoqiang complex-project task shape, not only Xiaoqiang MCP presence and the smaller project smoke.

The complex-project contract should stay distinct from the project smoke:

- `xiaoqiang-project` proves a small Node word-tally project and CLI JSON `red=2, blue=1`.
- `complex-project` proves the richer analyzer/report/site task, including sources, report, HTML, tests, CLI, and `sourceCount:3`.

## Conclusion

The existing status documents already captured the raw Xiaoqiang complex-project pass. The remaining documentation change is precision: name `latest-worker-mcp-complex-project-smoke.json` as part of the ecosystem-surface proof.
