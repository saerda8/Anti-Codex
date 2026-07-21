# Stage 7: Antigravity Stage 4G final live-action acceptance

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9`. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create another task or Anti-Codex window. Do not modify Anti-Codex product source. Do not call the nine development MCP workers. Before every command group, briefly explain in Chinese what you are checking and why. Use the real Codex tools visible in this task; prose-only output does not count.

This is the Antigravity review stage after the third-party Stage 4F review console. Independently inspect the actual deliverables, not only prior reports:

- `stage4e-publish-suite/stage4e-platform-master.mp4`
- `stage4e-publish-suite/stage4e-feed-cut-30s.mp4`
- `stage4e-publish-suite/stage4e-hook-cut-15s.mp4`
- Stage 4E subtitles, cover, contact sheets, motion strips, QA data and manifest
- `stage4f-review-console/` and its test, QA, ZIP and marker evidence

## Acceptance work

Create `stage4g-antigravity-acceptance/` and perform a fresh, evidence-based final review:

1. Verify that all three videos show real human actors in real-world scenes. Reject animation, illustration, 3D characters, slide-show narration, static-image-only output and synthetic UI-only footage. Save a new evenly sampled contact sheet for each cut and a combined identity/scene continuity sheet.
2. Verify video and audio streams directly: duration, dimensions, frame rate, codec, pixel format, sample rate, channels, integrated loudness, true peak and silence ratio. Record commands and machine-readable results.
3. Verify that intelligible spoken dialogue and background music are both present. Distinguish them with reproducible audio evidence; do not infer this only from filenames or previous prose.
4. Recheck subtitle timing and text against the actual audio timeline. Report every out-of-range, overlap, empty cue or timing gap that affects spoken dialogue.
5. Recheck lip synchronization using the strongest reproducible evidence available locally. At minimum compare speech-energy windows with visible mouth-motion windows for every speaking segment and report offset/error statistics. Do not claim lip-sync success from a single frame or from metadata alone.
6. Check that Stage 4F uses safe relative paths to the real Stage 4E media and that its tests, range requests, singleton behavior, deterministic export and ZIP inventory remain valid.
7. Produce `acceptance-report.md`, `acceptance.json`, `media-probe.json`, `subtitle-audit.json`, `lipsync-audit.json`, `test-log.txt`, `build-log.md`, and `stage4g-antigravity-acceptance.zip`. The ZIP must contain only Stage 4G reports and visual evidence, never duplicate the videos.
8. Append exactly one accurate Antigravity Stage 4G record to the root `provider-ledger.json`.

If any hard criterion is not proven, write an explicit blocker report and do not create the completion marker. Do not repair or replace the source videos in this review turn.

Only when every hard criterion is proven, create:

`stage4g-antigravity-acceptance/phase4g-antigravity-final-acceptance.done`

with exactly:

`STAGE7_ANTIGRAVITY_STAGE4G_FINAL_ACCEPTANCE_OK_20260720`

Write UTF-8 without BOM, CR or LF. Leave no server, media player or test process running. In the final response list the Antigravity model, test count, real-human evidence, audio/music evidence, lip-sync statistics, ZIP entry count and SHA-256. The final line must be only the marker.
