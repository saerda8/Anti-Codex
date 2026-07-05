# Xiaoqiang2 Heavy Plugin/MCP Audit

Marker: XIAOQIANG2_HEAVY_PLUGIN_MCP_AUDIT_20260705

## Plugin Evidence

- Source read: `scripts/test-anticodex-plugin-capabilities.ps1`.
- The plugin verifier writes `latest-plugin-capabilities.json` and a timestamped `*-plugin-capabilities.json` history file via `New-ReportPaths "plugin-capabilities"`.
- Primary output fields include `reportName`, `failures`, `baseUrl`, `sourceSnapshot`, `health`, and nested `capabilities`.
- The endpoint evidence covers `/health`, `/backend-api/ps/plugins/installed`, `/backend-api/plugins/list`, `/backend-api/aip/connectors`, and `/backend-api/wham/apps`.
- Capability fields cross-checked in the script include `installedPluginCount`, `pluginListCount`, `pluginsWithSkills`, `pluginsWithApps`, and `pluginsWithMcpServers`.
- Connector projection evidence is captured as `connectorCount`, `enabledConnectorCount`, `accessibleConnectorCount`, and `connectorParity`.
- App-tool projection evidence is captured as `appToolCount`, `appToolGetCount`, `appToolGetPostParity`, and `appToolParity`.
- Fake callable capability is guarded by `unattributedAppToolCount` and `unauthorizedAppToolCount`.
- The callable classification is explicit through `capabilityState`, `degraded`, `appToolsNote`, and `smoke.callableState`.
- Local snapshot integrity depends on `cache\codex_app_directory` and `cache\codex_apps_tools` under `CodexHome` compared with shared Codex cache roots.
- `connectorCache.sampleReadable` and `appToolsCache.sampleReadable` are important because endpoints with entries but unreadable local cache samples are treated as failures.
- `appToolGetPostParity.contentMatches` prevents POST-only or GET-only tool projection drift on `/backend-api/wham/apps`.
- Short-budget mode intentionally returns `capabilityState = degraded_short_budget`, `shortBudgetMode = true`, and unchecked parity fields.
- Timeout-budget degradation returns `capabilityState = degraded_timeout_budget` if the verifier reaches the local parity scan with less than 2000 ms remaining.
- This audit treats `metadata_only_no_accessible_connectors` as acceptable evidence of plugin metadata only, not as proof of callable tools.
- This audit treats `callable_tools_available` as the only plugin state that proves accessible connector-backed app tools.

## MCP Evidence

- Source read: `scripts/test-anticodex-mcp-skills.ps1`.
- The MCP/skills verifier writes `latest-mcp-skills.json` and timestamped `*-mcp-skills.json` history files.
- Primary output fields include `reportName`, `shortBudgetMode`, `snapshotSource`, `sourceSnapshot`, `hashCache`, `nativeCodexWriteback`, `capabilityState`, and `degraded`.
- `paths.configToml`, `paths.sharedConfigToml`, `paths.skills`, `paths.sharedSkills`, `paths.connectorDirectory`, and `paths.appToolsCache` bind the report to concrete local-copy locations.
- Config evidence checks `[mcp_servers]`, `[mcp_servers.node_repl]`, and rejects `chatgpt.com/auth` or `chatgpt.com/login` route residue.
- Static MCP command evidence is stored in `mcp.smoke.checks` with `name`, `command`, `commandResolvable`, `firstArg`, and `firstArgExists`.
- `mcp.smoke.realCall` performs the `node_repl` marker call and records `server`, `tool`, `markerObserved`, `toolCount`, `elapsedMs`, and `timedOut`.
- `mcp.smoke.realList` performs tools/list checks for non-`node_repl` servers and records `server`, `toolNames`, `expectedToolNames`, `missingExpectedTools`, and `error`.
- The worker MCP expected tool map covers `antigravity-code-worker`, `deepseek-code-worker`, `deveco-code-worker`, `kilo-worker`, `mimo-claude-coworker`, `mimocode-worker`, and `opencode-worker`.
- Xiaoqiang coverage is explicit for `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3`, each expecting `xiaoqiang_cancel_job`, `xiaoqiang_get_job`, `xiaoqiang_implement_in_workspace`, `xiaoqiang_start_implementation`, `xiaoqiang_tail_job`, and `xiaoqiang_wait_for_job`.
- `mcp.xiaoqiang.expectedServers`, `mcp.xiaoqiang.missingServers`, and `mcp.xiaoqiang.checks` make Xiaoqiang drift reviewable without reading logs.
- The report-level pass condition requires command checks, `node_repl` real call if checked, and every real tools/list check to pass.
- `capabilityState = ready` is only possible after skills exist, MCP config exists, stdio call checks pass, and list checks do not fail.
- The script writes a console summary with `mcp.smokePassed`, `mcp.realCallPassed`, `mcp.realListCount`, `mcp.xiaoqiangPassed`, and `mcp.xiaoqiangMissingServers`.
- Source read: `scripts/test-anticodex-ecosystem-surfaces.mjs`.
- The ecosystem rollup validates `latest-mcp-skills.json`, `latest-xiaoqiang-mcp.json`, `latest-plugin-capabilities.json`, `latest-worker-mcp-source-hygiene.json`, `latest-worker-mcp-server-probe.json`, `latest-worker-mcp-status-probe.json`, and `latest-xiaoqiang-worker-mcp-project-smoke.json`.
- Its own output file is `latest-ecosystem-surfaces.json`, with `coverageKind = ecosystem-report-rollup-no-traffic`, `noTraffic = true`, and `usedRealTraffic = false`.
- Rollup freshness uses `checkedAt` or `startedAt` before file mtime, then compares `ageHours` to `maxAgeHours`.
- Rollup surface accounting uses `coveredSurfaces`, `requiredSurfaceCount`, `passedReportCount`, and `totalReportCount`.

## Skill Snapshot Risks

- Source read: `scripts/refresh-anticodex-local-features.ps1`.
- The refresh verifier writes `latest-refresh-features.json` and timestamped `*-refresh-features.json` history files.
- In `-VerifyOnly`, the report carries `verifyOnly = true`, making it suitable for no-refresh audit evidence.
- Snapshot evidence includes `snapshots`, `sidecars`, `sourceSnapshot`, `hashCache`, `mcp`, `skills`, `guidance`, `connectors`, `appTools`, `connectorParity`, and `appToolParity`.
- Skill inventory fields include `skills.exists`, `skills.count`, `skills.linkType`, `skills.target`, `skills.sharedCount`, `skills.agentsCount`, and `skills.expectedCount`.
- Skill drift fields include `missingExpected`, `changedExpected`, and `changedExpectedDetails`.
- A local skills path with `linkType` is a risk because the scripts expect an Anti-Codex local copy, not a live link to shared Codex.
- Duplicate skill content between shared Codex and `.agents\skills` is a risk in `test-anticodex-mcp-skills.ps1` because conflicting fingerprints generate `conflictingDuplicateNames` and failures.
- Deep skill fingerprinting can be skipped in short-budget mode, leaving `fingerprintSkipped = true`; this is a review warning even if a previous `sourceSnapshot` was reused.
- `hashCache.path`, `hashCache.fallbackPath`, `hashCache.hitCount`, `hashCache.fallbackHitCount`, `hashCache.missCount`, and `hashCache.entryCount` should be reviewed for stale snapshot reuse.
- Guidance files are also part of the snapshot boundary: `AGENTS.md`, `DEFAULT_SKILL_ALLOWLIST.md`, `RTK.md`, and `MCP_WORKER_USAGE_GUIDE.md`.
- The `headroom` skill smoke only proves `headroom/SKILL.md` is readable and longer than a tiny threshold; it does not prove every skill executes.
- `sourceSnapshot.reusedFromPreviousReportPath` is useful evidence but also a risk indicator when the current run could not afford a fresh source snapshot.

## Timeout/Budget Risks

- Source read: `MCP_WORKER_RULES.md`.
- Dispatch rule 2 prefers one new file or one existing file; this audit follows that constraint by adding only this markdown file.
- Dispatch rule 10 says a worker report is untrusted until `git status`, changed-file scope, diff, syntax, and tests are reviewed.
- Time rule 4 requires explicit timeouts for ordinary test child processes; the requested checks use `-TimeoutSec 90` and `-TimeoutSec 120`.
- Time rule 1 says to check status after about 30 seconds without a file change, which is relevant because MCP tools/list checks can spend time in child processes.
- The plugin verifier has `shortBudgetMode` below 5 seconds; this can produce `degraded_short_budget` and skip live connector/app-tool endpoints.
- The plugin verifier also fails into `degraded_timeout_budget` if the remaining verifier budget is under 2000 ms before parity scanning.
- The MCP verifier has `shortBudgetMode` below 8 seconds; this can skip health and reuse a previous source snapshot.
- `Get-McpSmokeTimeoutMs` allocates roughly one third of `TimeoutSec` and clamps real MCP subprocess timeout between 3000 ms and 20000 ms.
- `Invoke-NodeJsonWithProcessTimeout` kills timed-out MCP subprocesses and records `timedOut` in `realCall` or `realList` evidence.
- The ecosystem rollup is no-traffic but can still fail on stale prior reports through `ageHours > maxAgeHours`.
- The `xiaoqiangWorkerProjectSmoke` rollup item intentionally requires `requestedRealTraffic = true` and `usedRealTraffic = true`; this audit did not run that real worker traffic.
- No real traffic was initiated while producing this audit file.
- Check command status is recorded below.

## Next Xiaoqiang Tasks

- Keep `latest-xiaoqiang-mcp.json` fresh with `noTraffic = true` and `usedRealTraffic = false` before relying on Xiaoqiang MCP inventory.
- Confirm `latest-mcp-skills.json` shows `mcp.xiaoqiang.passed = true` and no `mcp.xiaoqiang.missingServers`.
- Confirm each Xiaoqiang server exposes all six expected `xiaoqiang_*` tools in `mcp.smoke.realList`.
- Confirm `latest-plugin-capabilities.json` has `capabilities.connectorParity.checked = true` and `capabilities.appToolParity.checked = true`.
- Confirm `capabilities.unauthorizedAppToolCount = 0` and `capabilities.unattributedAppToolCount = 0` before calling any app tool callable.
- Confirm `latest-refresh-features.json` has `verifyOnly = true`, `connectorParity.contentMatches = true`, and `appToolParity.contentMatches = true` for a no-write snapshot audit.
- Review `latest-ecosystem-surfaces.json` only as a rollup of prior evidence; do not treat it as a substitute for fresh plugin/MCP source reports.
- If `mcp.realCallPassed` is false for `node_repl`, classify it separately from Xiaoqiang worker server availability.
- If a Xiaoqiang tools/list check times out, first compare `elapsedMs`, `timedOut`, and `error` before rerunning all worker smokes.
- If report freshness fails, refresh the smallest no-traffic report first instead of rerunning a real worker project smoke.
- If same-channel worker tools are transport-closed, follow `MCP_WORKER_RULES.md` and require a fresh/reloaded channel read-only status/get/wait success before implementation dispatch.
- Preserve this audit as a reviewable file and do not edit other workspace paths for this task.

## Command Results

- Worker job `xqw_mr7mw41i_xgpk90` accepted this audit file but failed its wrapper contract because `powershell -ExecutionPolicy Bypass -File scripts\test-anticodex-mcp-skills.ps1 -TimeoutSec 120` timed out.
- Worker follow-up job `xqw_mr7n9e6q_snjbjp` updated this audit file, but its wrapper check with `-TimeoutSec 240` returned exit code 1 after five MCP initialize timeouts.
- The five timed out real tools/list targets were `deveco-code-worker`, `mimo-claude-coworker`, `mimocode-worker`, `opencode-worker`, and `xiaoqiang2`.
- Worker follow-up job `xqw_mr7nkqes_zfteml` added the host rerun result and completed with accepted file changes.

## Follow-up Validation

- Host reran the same MCP skills verifier from `G:\Trae-Project\Anti-Codex\deepcodex` with `TimeoutSec 360`.
- Host rerun returned `ok:true`, `failureCount:0`, `capabilityState:ready`, `xiaoqiangPassed:true`, and `realListCount:10`.
- Conclusion: the xq2 worktree check failure is transient/check-context evidence, not proof of global Anti-Codex MCP degradation.
- The main verified surface remains green after the transient xq2 worktree failure.
