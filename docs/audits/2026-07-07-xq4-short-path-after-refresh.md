# XQ4 Short Path After Refresh

Date: 2026-07-08

Command:

```text
node scripts/test-anticodex-release-gates.mjs --summary
```

Result:

- Status: ran non-interactively and completed successfully. No optional real traffic was run.
- Exit status: 0.
- ok: true.
- releaseReady: false.
- shortReady: false.
- releaseBlockedOnlyByRequiredRealTraffic: false.
- requiredRealTrafficBlockedGates: none.
- strict: false.
- strictOptionalRealTraffic: false.
- optionalRealTrafficReady: false.
- optionalRealTrafficFailures: realThirdPartyProviderOptional, providerAntigravityReturnOptional, antigravityCliRealSmokeOptional.
- reportName: release-gates.
- elapsedMs: 112.
- reportRoot: `C:\Users\XD\AppData\Roaming\anticodex\reports`.
- maxAgeHours: 48.
- damagedReports: none.
- Latest report path: `C:\Users\XD\AppData\Roaming\anticodex\reports\latest-release-gates.json`.
- Latest report mtime: 2026-07-07T16:09:46.545Z.

Missing gates:

- missingRequired: mcpSkills, pluginCapabilities, managerRealButtons, realApprovalPlan, goalReadiness, goalUnblockPackage, goalRealRunReadiness, approvedRealRunSequence.
- missingShort: mcpSkills, pluginCapabilities, managerRealButtons.
- missingOptional: realThirdPartyProviderOptional, providerAntigravityReturnOptional, antigravityCliRealSmokeOptional, nativeToolLoop, nativeMultiToolLoop, stabilitySoak, coldRelaunch.

Group summary:

| Group | Total | Satisfied | Required | Required satisfied | Optional | Optional satisfied | Missing required | Missing optional |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| short | 8 | 6 | 8 | 6 | 0 | 0 | mcpSkills, pluginCapabilities | none |
| manager | 2 | 1 | 2 | 1 | 0 | 0 | managerRealButtons | none |
| optional-real-traffic | 3 | 0 | 0 | 0 | 3 | 0 | none | realThirdPartyProviderOptional, providerAntigravityReturnOptional, antigravityCliRealSmokeOptional |
| no-traffic | 29 | 24 | 29 | 24 | 0 | 0 | realApprovalPlan, goalReadiness, goalUnblockPackage, goalRealRunReadiness, approvedRealRunSequence | none |
| real-traffic | 24 | 22 | 22 | 22 | 2 | 0 | none | nativeToolLoop, nativeMultiToolLoop |
| soak | 1 | 0 | 0 | 0 | 1 | 0 | none | stabilitySoak |
| cold | 1 | 0 | 0 | 0 | 1 | 0 | none | coldRelaunch |

Release gate failures:

| Gate | Group | Reason | Selected report | Selected mtime | Semantic failures |
| --- | --- | --- | --- | --- | --- |
| mcpSkills | short | ok_false | latest-mcp-skills.json | 2026-07-07T15:57:53.341Z | mcp_skills_missing_shared_mcp, mcp_skills_changed_shared_mcp |
| pluginCapabilities | short | ok_false | latest-plugin-capabilities.json | 2026-07-07T15:54:43.367Z | plugin_capabilities_degraded, plugin_capabilities_local_connector_parity_missing_shared, plugin_capabilities_local_connector_parity_changed_shared |
| managerRealButtons | manager | ok_false | latest-manager-real-buttons.json | 2026-07-07T15:58:07.556Z | manager_action_not_ok:mcpSkills, manager_action_not_ok:pluginCapabilities |
| realThirdPartyProviderOptional | optional-real-traffic | semantic_failures | latest-real-third-party-provider.json | 2026-07-07T15:52:52.744Z | optional_real_traffic_not_requested |
| providerAntigravityReturnOptional | optional-real-traffic | semantic_failures | latest-provider-antigravity-return.json | 2026-07-07T15:52:53.718Z | optional_real_traffic_not_requested |
| realApprovalPlan | no-traffic | semantic_failures | latest-real-approval-plan.json | 2026-07-07T16:04:13.229Z | real_approval_plan_release_not_blocked_only_by_real_traffic, real_approval_plan_required_release_actions_missing |
| goalReadiness | no-traffic | ok_false | latest-goal-readiness.json | 2026-07-07T16:04:07.461Z | goal_readiness_goal_not_complete_for_current_scope, goal_readiness_current_usability_not_ready, goal_readiness_current_usability_release, goal_readiness_current_usability_model_text, goal_readiness_operator_action_card_status, goal_readiness_operator_action_card_does_not_claim_current_goal, goal_readiness_operator_action_card_release_state, goal_readiness_operator_action_card_unattended_progress, goal_readiness_operator_action_card_unattended_action:refresh_real_task_evidence, goal_readiness_operator_action_card_fresh_channel_action, goal_readiness_operator_action_card_user_presence_action, goal_readiness_operator_action_card_missing_requirement, goal_readiness_operator_action_card_next_actions, goal_readiness_objective_requirement_complete_count, goal_readiness_objective_requirement_incomplete_count, goal_readiness_objective_requirement_does_not_claim_goal, goal_readiness_objective_requirement_unexpected_incomplete, goal_readiness_full_objective_requirement_complete_count, goal_readiness_full_objective_requirement_incomplete_count, goal_readiness_releaseShortPath_not_proven, goal_readiness_short_not_ready, goal_readiness_accountProxyReadiness_blocked_gate_missing, goal_readiness_accountProxyReadiness_blocker_missing, goal_readiness_postVerification_blocked_gate_missing, goal_readiness_postVerification_blocker_missing, goal_readiness_release_not_blocked_only_by_real_traffic |
| goalUnblockPackage | no-traffic | ok_false | latest-goal-unblock-package.json | 2026-07-07T16:04:17.209Z | goal_unblock_package_goal_not_complete, goal_unblock_package_does_not_claim_current_goal, goal_unblock_package_release_not_ready, goal_unblock_package_current_remaining_not_empty, goal_unblock_package_current_blockers_not_empty, goal_unblock_package_failures |
| goalRealRunReadiness | no-traffic | ok_false | latest-goal-real-run-readiness.json | 2026-07-07T16:04:19.508Z | goal_real_run_readiness_accountProxyReadiness_blocked_gate_missing, goal_real_run_readiness_postVerification_blocked_gate_missing, goal_real_run_readiness_short_not_ready, goal_real_run_readiness_release_not_ready_or_blocked_only_by_real_traffic, goal_real_run_readiness_release_gates_require_explicit_real_traffic_missing, goal_real_run_readiness_failures |
| approvedRealRunSequence | no-traffic | ok_false | latest-approved-real-run-sequence.json | 2026-07-07T16:04:21.996Z | approved_real_run_sequence_accountProxyReadiness_blocked_gate_missing, approved_real_run_sequence_postVerification_blocked_gate_missing, approved_real_run_sequence_short_not_ready, approved_real_run_sequence_failures |

Next action:

- Refresh the required short-path blockers first: run the mcpSkills verifier, start or restore the local Anti-Codex gateway before rerunning pluginCapabilities and managerRealButtons, then rerun `node scripts/test-anticodex-release-gates.mjs --summary`.
- After the short path is clean, rerun the required no-traffic goal and approval gates: realApprovalPlan, goalReadiness, goalUnblockPackage, goalRealRunReadiness, and approvedRealRunSequence.
- Do not run optional real-traffic or high-impact actions without explicit user approval.
