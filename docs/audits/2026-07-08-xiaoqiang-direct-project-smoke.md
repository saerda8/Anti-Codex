# 2026-07-08 Xiaoqiang Direct Project Smoke

## Result
- Status: passed.
- Beijing time: 2026-07-08 00:50:05.
- Runner: direct worker MCP task smoke, not current-channel Xiaoqiang tool calls.
- Scenario: `xiaoqiang-project`.
- Workers: `xiaoqiang1`, `xiaoqiang2`, `xiaoqiang3`, `xiaoqiang4`.
- Worker count: 4.
- Passed worker count: 4.
- `requestedRealTraffic`: true.
- `usedRealTraffic`: true.
- `externalQuotaDecrementProven`: false.

## Command
`node scripts/test-anticodex-worker-mcp-task-smoke.mjs --scenario xiaoqiang-project --workers xiaoqiang1,xiaoqiang2,xiaoqiang3,xiaoqiang4 --worker-checks --clean-workspace-root --timeout-ms 300000`

## Evidence
- Latest report: `C:\Users\XD\AppData\Roaming\anticodex\reports\latest-xiaoqiang-worker-mcp-project-smoke.json`.
- History report: `C:\Users\XD\AppData\Roaming\anticodex\reports\20260707-165005-xiaoqiang-worker-mcp-project-smoke.json`.
- Latest report UTC mtime: 2026-07-07 16:50:05.

## Jobs
- `xiaoqiang1`: `xqw_mravspkh_u9l58h`, completed, worker-side checks passed, host verification passed, CLI JSON `{"red":2,"blue":1}`.
- `xiaoqiang2`: `xqw_mravttuh_6tn5cg`, completed, worker-side checks passed, host verification passed, CLI JSON `{"red":2,"blue":1}`.
- `xiaoqiang3`: `xqw_mravuv6i_din8ve`, completed, worker-side checks passed, host verification passed, CLI JSON `{"red":2,"blue":1}`.
- `xiaoqiang4`: `xqw_mravw66z_rmm54i`, completed, worker-side checks passed, host verification passed, CLI JSON `{"red":2,"blue":1}`.

## Notes
- Current-channel `mcp__xiaoqiang*.xiaoqiang_start_implementation` calls returned `Transport closed` before job creation.
- This run used the direct worker MCP task-smoke path to dispatch the four Xiaoqiang workers.
- This proves fresh local worker task execution and real worker traffic, but it does not prove provider-side quota decrement.
