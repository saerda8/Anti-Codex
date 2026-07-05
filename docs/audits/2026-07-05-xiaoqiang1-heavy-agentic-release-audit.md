# Xiaoqiang1 Heavy Agentic Release Audit

Marker: XIAOQIANG1_HEAVY_AGENTIC_RELEASE_AUDIT_20260705

## Gate Contract

- Scope of this audit is the report-only agentic/release-gate chain for Xiaoqiang1-era release readiness.
- I inspected `scripts/test-anticodex-release-gates.mjs` and the three report-only rollup scripts named below.
- I also inspected `task_plan.md` to compare the machine gate contract against the current status narrative.
- The release gate defines `longTaskLandingMatrix`, `agenticCapabilityMatrix`, and `realTaskCoverageRoadmap` as required `no-traffic` gates.
- These map to `latest-long-task-landing-matrix.json`, `latest-agentic-capability-matrix.json`, and `latest-real-task-coverage-roadmap.json`.
- The release gate expects `reportName:"long-task-landing-matrix"` for the long-task report.
- The release gate expects `reportName:"agentic-capability-matrix"` for the agentic capability report.
- The release gate expects `reportName:"real-task-coverage-roadmap"` for the roadmap report.
- All three rollups assert `requestedRealTraffic:false` and `usedRealTraffic:false`, so they are aggregation gates, not traffic producers.
- `coverageKind` is part of the contract: `agentic-capability-matrix-report-only`, `long-task-landing-matrix-report-only`, and `real-task-coverage-roadmap-report-only`.
- `behaviorCovered:true` is required by release-gate semantics for each report-only rollup.
- `scripts/test-anticodex-release-gates.mjs` also preserves top-level readiness fields: `releaseReady`, `shortReady`, `missingRequired`, `missingShort`, `damagedReports`, and `releaseGateFailureReasons`.
- The required long-task modes are `coding-project`, `multi-turn-project`, `report-site`, `complex-project`, `autonomous-reasoning`, `agentic-step-flow`, and `repo-multi-file-edit`.
- The required agentic capabilities are `coding_project_files_tests_cli`, `multi_turn_continuation`, `research_report_with_sources`, `complex_research_code_site`, `autonomous_reasoning_project`, `repo_multi_file_edit`, and `visible_staged_tool_loop`.
- `task_plan.md` says the current accepted scope is green with `releaseReady:true`, `shortReady:true`, `goalComplete:true`, `usableNow:true`, `missingRequired:[]`, and `missingShort:[]`.
- `task_plan.md` also records Xiaoqiang MCP coverage for `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3`, with real project jobs completing outside this no-traffic audit.

## Freshness Chain

- The agentic capability script reads `latest-desktop-task-suite.json` plus individual UI smoke reports.
- Its default freshness window is `canonicalReleaseMaxAgeHours:24`.
- It writes canonical `latest-agentic-capability-matrix.json` unless a custom `--max-age-hours` is used.
- On custom freshness, it writes a separate `latest-agentic-capability-matrix-max-age-<label>.json` and preserves `canonicalLatest`.
- The roadmap script follows the same freshness split for `latest-real-task-coverage-roadmap.json` versus custom max-age latest files.
- That split is important because exploratory one-hour checks should not overwrite canonical release evidence.
- The long-task landing script reads both `latest-agentic-capability-matrix.json` and `latest-real-task-coverage-roadmap.json` before judging landed long tasks.
- It requires `agenticCapabilityMatrixPresent:true` and `agenticCapabilityMatrixComplete:true`.
- It requires `realTaskCoverageRoadmapPresent:true`.
- It copies `pendingRealTaskModes`, `pendingRealTaskScenarios`, `minimalRefreshCommand`, and `minimalRefreshCommandArgs` from the roadmap when broader refresh is still needed.
- The release gate checks report integrity via `.sha256` sidecars for selected reports.
- The release gate then summarizes `releaseGateSelectedReports`, including `selectedFile`, `selectedKind`, `selectedMtime`, and `historySourceMismatch`.
- The intended chain is: individual UI task reports -> `latest-desktop-task-suite.json` -> `latest-agentic-capability-matrix.json` -> `latest-real-task-coverage-roadmap.json` -> `latest-long-task-landing-matrix.json` -> `latest-release-gates.json`.
- `task_plan.md` confirms the expected terminal state is an empty required-missing set, not a deferred blocker masked as green.

## Failure Modes Found

- No code defect was patched here; this is an audit-only artifact as requested.
- The main failure mode is stale evidence: any report older than `maxAgeHours` produces `report_stale` or `latest_real_report_stale`.
- A stale `latest-desktop-task-suite.json` makes `desktopTaskSuiteFresh:false` and can cascade into `agentic_capability_matrix_desktop_suite_not_fresh`.
- A missing or damaged `.sha256` sidecar can make a release gate fail even when the JSON body parses.
- A custom freshness run can create misleading results if operators read `latest-*-max-age-1.json` as canonical release status.
- The scripts now mitigate that by exposing `canonicalLatest`, `customFreshnessReportOnly`, and `canonicalReleaseMaxAgeHours`.
- The long-task landing report can fail with `agentic_capability_missing_or_not_ok` when `capabilities[].ok` is false.
- It can fail with `roadmap_artifact_proof_missing` or `roadmap_result_proof_missing` when roadmap proof arrays are incomplete.
- Agentic task proof can fail on response-history shape even if artifacts exist: `assistantHasFinalMarker`, `markerToolOutputSeen`, `taskToolCallCount`, `taskToolOutputSeen`, `modelLedExecution`, and `codexLikeProcessProof` are all checked.
- The scripts deliberately reject first-person progress text via `firstPersonProgressCount`; this protects Codex-like visible progress quality.
- `report-site` has special fallback evidence fields such as `visibleFinalMarkerSeen`, `effectiveMarkerToolOutputSeen`, and `effectiveTaskToolOutputSeen`.
- `agentic-step-flow` requires staged proof fields including `assistantHasPhase1`, `assistantHasPhase2`, `phase1Count`, `phase2Count`, and `stagedToolLoopProof`.
- The roadmap can be `ok:true` while still requiring user-approved real refresh when `uniqueRefreshTasks` is nonempty.
- In that case `minimalRefreshCommandRequiresRealTraffic:true` and `refreshApprovalSummary.requiresExplicitUserApproval:true` are expected, not contradictions.
- The release gate distinguishes no-traffic gates from real-traffic gates, so running these rollups does not satisfy stale individual real task reports by itself.
- `task_plan.md` records prior false-red risks from report-site routing, connector drift, Manager report labels, and report self-cycles; the release chain now guards several of those as explicit report fields.

## Concrete Recommendations

- Keep `latest-agentic-capability-matrix.json`, `latest-real-task-coverage-roadmap.json`, and `latest-long-task-landing-matrix.json` refreshed as canonical 24-hour report-only artifacts before final release-gate reads.
- Do not use custom `--max-age-hours 1` report filenames as release-canonical evidence.
- When release gates fail, inspect `releaseGateFailureReasons[].failureReasons` before rerunning any real-traffic task.
- If `releaseBlockedOnlyByRequiredRealTraffic:true`, stop and request explicit approval rather than launching real traffic.
- For Xiaoqiang release evidence, keep the no-traffic matrix checks separate from the real Xiaoqiang worker jobs recorded in `task_plan.md`.
- Preserve `requestedRealTraffic:false` and `usedRealTraffic:false` in these three matrix scripts; changing either would blur the safety boundary.
- Keep `requiredLongTaskModes` aligned with `requiredAgenticDesktopTaskSuiteTasks` in the release gate.
- Keep `taskArtifactProofs` and `taskResultProofs` strict at task level, not only profile level.
- Retain `.sha256` sidecar writes for latest and history reports to prevent unsigned report drift.
- If `pendingRealTaskModes` is nonempty, publish the exact `minimalRefreshCommandArgs` and do not summarize it away.
- Continue exposing operator-ready fields such as `missingRequired`, `missingShort`, `damagedReports`, `optionalRealTrafficFailures`, and `approvalPlan`.
- Treat `task_plan.md` as narrative confirmation only; the machine gate source of truth remains the signed report chain.

## Worker Validation Note

- Worker job: `xqw_mr7mw38r_99cs3e`.
- Isolated worktree: `G:\Trae-Project\Anti-Codex\deepcodex-xq1`.
- Worker accepted exactly one changed file: this audit file.
- Wrapper checks passed after the worker edit: `node scripts\test-anticodex-agentic-capability-matrix.mjs` and `node scripts\test-anticodex-long-task-landing-matrix.mjs`.
- The worker's own transcript reported command permission blocks, but the host-side worker wrapper completed both requested checks with exit code 0.
