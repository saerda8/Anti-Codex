# 2026-07-08 Xiaoqiang Direct Complex Smoke

## Result
- Status: passed.
- Beijing time: 2026-07-08 00:58:43.
- Runner: direct worker MCP task smoke, not current-channel Xiaoqiang tool calls.
- Scenario: `complex-project`.
- Workers: `xiaoqiang1`, `xiaoqiang2`, `xiaoqiang3`, `xiaoqiang4`.
- Worker count: 4.
- Passed worker count: 4.
- `requestedRealTraffic`: true.
- `usedRealTraffic`: true.
- `externalQuotaDecrementProven`: false.

## Command
`node scripts/test-anticodex-worker-mcp-task-smoke.mjs --scenario complex-project --workers xiaoqiang1,xiaoqiang2,xiaoqiang3,xiaoqiang4 --worker-checks --clean-workspace-root --timeout-ms 360000`

## Evidence
- Latest report: `C:\Users\XD\AppData\Roaming\anticodex\reports\latest-worker-mcp-complex-project-smoke.json`.
- History report: `C:\Users\XD\AppData\Roaming\anticodex\reports\20260707-165843-worker-mcp-complex-project-smoke.json`.
- Checked at UTC: 2026-07-07T16:58:43.145Z.

## Jobs
- `xiaoqiang1`: `xqw_mravzz4e_mwpfyi`, completed, elapsed 86186 ms.
- `xiaoqiang2`: `xqw_mraw1q22_ud6ppo`, completed, elapsed 87558 ms.
- `xiaoqiang3`: `xqw_mraw3jd5_rgudan`, completed, elapsed 102782 ms.
- `xiaoqiang4`: `xqw_mraw5qxy_11uo0z`, completed, elapsed 113266 ms.

## Host Verification
- Missing files: none.
- Extra files: none.
- `done.txt` marker: matched.
- Source validation: passed.
- Test exit code: 0 for all four workers.
- CLI exit code: 0 for all four workers.
- CLI JSON: `{"sourceCount":3,"codexMentionCount":9}` for all four workers.
- Report validation: passed.
- HTML validation: passed.

## Notes
- Current-channel `mcp__xiaoqiang*.xiaoqiang_start_implementation` remains unusable in this channel because it returns `Transport closed` before job creation.
- Direct MCP dispatch remains usable and produced fresh four-worker traffic.
- This proves local worker task execution and real worker traffic, but it does not prove provider-side quota decrement.
