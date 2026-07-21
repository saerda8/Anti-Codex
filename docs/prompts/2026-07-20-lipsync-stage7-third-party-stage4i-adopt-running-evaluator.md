# Stage 4I continuation: visibly adopt the running evaluator and finish

Continue the same native Anti-Codex task. The preceding Gemini turn ended with visible `429 Too Many Requests` while its real offline evaluator kept running as a child of the Anti-Codex app-server. Do not restart or duplicate that expensive evaluator.

Known process chain at handoff:

- `pwsh.exe` PID 55140
- venv launcher PID 23000
- real Python evaluator PID 27632
- script: `G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7\tools\musetalk\eval_stage4i.py`
- expected raw outputs at the Stage 7 root: `stage4i-syncnet-raw-results.json` and `stage4i-face-boxes.json`

Work only in `G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`. Do not create another task/window, modify Anti-Codex source, call the nine development MCP workers, download anything or run another evaluator concurrently.

Use real Codex tools now. Before each command group, explain briefly in Chinese.

1. Check whether PID 27632 is alive and record CPU/runtime/memory. If alive, visibly monitor it with bounded waits and report progress in this frontend turn. Do not launch a second copy.
2. When it exits, verify both raw JSON outputs exist, are parseable and contain real per-window scores for all three shots and all five offsets. Check that scores vary and are not constants or copied expected values.
3. Inspect `eval_stage4i.py` for model argument order, mel/frame alignment, face-box handling, invalid-window accounting and output-path correctness. Correct and rerun only if a concrete defect makes the produced scores invalid.
4. Finish all remaining Stage 4I requirements from the preceding prompts: face evidence, mapping recheck, corrected Stage 4G reports, 24+ checks, truthful verdict, ZIP and ledger.
5. Restore the Stage 4G acceptance marker only if real measurements and shifted controls support it. Otherwise keep it absent and state the exact measured blocker.
6. Create the Stage 4I completion marker exactly and leave no evaluator/server/test process running.

The final line must be exactly:

`STAGE7_ANTIGRAVITY_STAGE4I_SYNCNET_RECOVERY_COMPLETE_20260720`
