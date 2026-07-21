# Stage 7: Antigravity Stage 4I offline SyncNet recovery

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9`. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create another task or Anti-Codex window. Do not modify Anti-Codex product source. Do not call the nine development MCP workers. Before every command group, briefly explain in Chinese what you are checking and why. Use real Codex tools visible in this task; prose-only output does not count.

Stage 4H truthfully rejected the earlier false Stage 4G acceptance because S3FD was missing. The official file already exists locally and must be used without network access:

- source: `C:\Users\XD\.cache\torch\hub\checkpoints\s3fd-619a316812.pth`
- bytes: `89843225`
- SHA-256: `619a31681264d3f7f7fc7a16a42cbbe8b23f31a256f75a366e5a1bcd59b33543`
- destination expected by MuseTalk: `tools\musetalk\musetalk\utils\face_detection\detection\sfd\s3fd.pth`

First verify the source size and full hash. Only then copy it to the exact destination. Do not download anything and do not alter the source cache file.

## Required recovery

Create `stage4i-antigravity-syncnet-recovery/` and perform a real offline measurement:

1. Run face preprocessing from the correct `tools/musetalk` working directory and prove S3FD uses the local file without network access.
2. Load `models/syncnet/latentsync_syncnet.pt` with the repository's real SyncNet implementation. Build a reproducible evaluator for the three protected lip-sync shots and authored WAVs.
3. Evaluate aligned audio and deliberate offsets at least `-0.40`, `-0.20`, `0.00`, `+0.20`, `+0.40` seconds across multiple valid 16-frame windows per shot. Record raw per-window scores, aggregate score for each offset, best offset, second-best score and confidence margin. No constant scores, copied expected values or hard-coded pass flags.
4. Save face boxes/crop evidence and prove every scored window contains a visible real face and mouth region. Record skipped/invalid windows rather than silently dropping them.
5. Verify that Stage 4E preserves each scored source shot's audio/video timing in the platform, feed and hook cuts without stretch or relative delay.
6. Re-run the Stage 4H mapping, audio/music provenance, subtitle/dialogue mapping, media hash and ZIP safety checks. Keep direct measurements separate from provenance claims.
7. Correct Stage 4G reports and scripts to use the actual Antigravity model `gemini-3.5-flash-extra-low` and real measured SyncNet results. Do not retain the fabricated zero-offset claims.
8. Add at least 24 meaningful checks including local weight hash, no-network guard, real face-box count, score variance, shifted controls, best-offset derivation, mapping, provenance, subtitles, hashes, exact marker bytes and ZIP inventory.
9. Produce `stage4i-verdict.json`, `syncnet-measurements.json`, `face-boxes.json`, `mapping-recheck.json`, `test-log.txt`, `build-log.md`, `recovery-report.md` and `stage4i-antigravity-syncnet-recovery.zip`.
10. Append exactly one accurate Stage 4I Antigravity entry to `provider-ledger.json` and update Stage 4G/4H status truthfully.

If SyncNet still cannot produce real nonconstant scores, or if the shifted controls do not distinguish alignment, keep the Stage 4G success marker absent and report the exact blocker. Only restore:

`stage4g-antigravity-acceptance/phase4g-antigravity-final-acceptance.done`

with exact text `STAGE7_ANTIGRAVITY_STAGE4G_FINAL_ACCEPTANCE_OK_20260720` when the measured evidence supports final acceptance.

After the recovery attempt itself is fully audited, create:

`stage4i-antigravity-syncnet-recovery/phase4i-antigravity-syncnet-recovery.done`

with exactly:

`STAGE7_ANTIGRAVITY_STAGE4I_SYNCNET_RECOVERY_COMPLETE_20260720`

Write both markers as UTF-8 without BOM, CR or LF. Leave no evaluator, media player, server or test process running. In the final response list the actual model, scored-window count, all aggregate offset scores, best offsets/confidence margins, whether Stage 4G is accepted, automated test count, ZIP entries and SHA-256. The final line must be only the Stage 4I marker.
