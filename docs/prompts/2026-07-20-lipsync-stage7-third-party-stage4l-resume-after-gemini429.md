# Stage 4L resume: third-party executes embedded-audio calibration after Gemini 429

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` in the same visible frontend. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Gemini was genuinely selected and attempted in this same task, but its latest request and a visible native `/compact` attempt both ended with 429. The task already has a real native compaction record, so do not compact again. The prior third-party turn created `tools/musetalk/eval_stage4l.py` but hit 429 before running it. Resume from that exact file and completed Stage 4K evidence; do not redo earlier stages.

Do not create another task/window, modify Anti-Codex product source, call the nine development MCP workers, download anything, or perform hidden product work. Before every command group, explain briefly in Chinese what you are checking or changing. If this provider returns 429 before tools, report it and stop without retry loops or fabricated files.

Audit and repair the unexecuted evaluator before running it:

1. Use `..\..\cache\venv\Scripts\python.exe` from `tools\musetalk`, never system Python 3.12.
2. Prove waveform-correlation direction with synthetic `+0.12 s` and `-0.12 s` delays. The current function is known to return a delayed embedded signal with the opposite sign from its label. Fix implementation, sign wording and assertions, and save the test evidence.
3. Use the official repository input contract: `decord.AudioReader(video_path, sample_rate=16000)`, `melspectrogram`, and `int(80 * start_frame / fps)`. An ffmpeg PCM extraction may be retained only for source-WAV correlation; it cannot replace the embedded-MP4 mel path unless parity is measured and saved.
4. Read accepted boxes from `stage4k-third-party-lightweight-syncnet/face-evidence.json`. When Haar misses, use a nearest/interpolated accepted Stage 4K box with explicit provenance, not an arbitrary ROI. Save annotated evidence for all three shots and every evaluated time region.
5. Define the SyncNet offset sign separately: state exactly what positive offset means for audio versus picture, prove it with a synthetic shifted-window test, and state the correction operation. Do not shift media based on an undocumented sign.
6. Write only to `stage4l-third-party-embedded-audio-calibration/`. Preserve all prior directories and save each score atomically so a provider stop cannot erase completed work.

Run one complete real window through all 11 offsets `-0.50..+0.50` as a smoke. If it yields finite, nonconstant scores, continue to at least five spread-out valid windows per shot: three shots x five windows x 11 offsets, at least 165 real scores. Report waveform lag/correlation, per-window scores, aggregate best offsets and confidence margins.

Only if the calibrated embedded-audio measurements show a consistent material lag may you create non-destructive corrected shots and rerun the same evaluation. Otherwise do not move picture or audio merely to force zero. Rebuild a corrected final master only when real measurements require it, preserving dialogue, music, effects, subtitles and all prior live-action requirements.

Create truthful stream/correlation evidence, synthetic tests, raw measurements, face/crop evidence, any correction provenance, before/after comparison, at least 30 checks, verdict JSON, build log and ZIP. Restore Stage 4G acceptance only if calibrated results plus prior media checks justify it; otherwise keep Stage 4G rejected and record the exact blocker. Leave no evaluator or helper process running.

Write this marker as UTF-8 without BOM or newline:

`stage4l-third-party-embedded-audio-calibration/phase4l-third-party-embedded-audio-calibration.done`

The final line of your response must be exactly:

`STAGE7_THIRD_PARTY_STAGE4L_EMBEDDED_AUDIO_CALIBRATION_COMPLETE_20260720`
