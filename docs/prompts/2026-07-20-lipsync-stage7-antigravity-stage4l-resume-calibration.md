# Stage 4L resume: Gemini 3.1 Low runs and audits embedded-audio calibration

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` in the same visible frontend. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

The prior third-party turn created `tools/musetalk/eval_stage4l.py` but hit 429 before running it. Continue from that exact file; do not redo completed Stage 4K work. Do not create another task/window, modify Anti-Codex product source, call the nine development MCP workers, download anything, or perform hidden product work. Explain every command group briefly in Chinese.

Before running, audit and repair the unexecuted script:

1. Use the established environment `..\..\cache\venv\Scripts\python.exe` from `tools\musetalk`, not system Python 3.12.
2. Verify the waveform cross-correlation lag sign with synthetic known `+0.12 s` and `-0.12 s` shifts. The current code is known to report a delayed embedded signal with the opposite sign from its label, so fix both implementation and documented sign convention before interpreting real media. Save the synthetic inputs, expected values and assertions as evidence.
3. Ensure output goes to `stage4l-antigravity-embedded-audio-calibration/`, never overwriting Stage 4K or the prior incomplete third-party directory.
4. Ensure every shot has at least five valid spread-out windows and all 11 offsets `-0.50..+0.50`. Read the accepted boxes from `stage4k-third-party-lightweight-syncnet/face-evidence.json`; when local Haar misses a frame, use the nearest/interpolated accepted Stage 4K box with explicit provenance instead of an arbitrary new ROI. Save representative annotated frames for every shot and window region.
5. Evaluate SyncNet against each MP4's embedded audio using the repository's official `decord.AudioReader(video_path, sample_rate=16000)` plus `melspectrogram` path and its `int(80 * start_frame / fps)` timing. If an ffmpeg-extracted PCM path is retained for diagnostics, prove mel parity against the official path and never substitute separate source-WAV scores as final acceptance evidence.
6. Define the SyncNet offset direction independently from waveform correlation: state exactly what a positive score-grid offset means for picture versus audio, prove it with a synthetic shifted-window test, and state the corresponding correction operation. Do not infer media correction from an undocumented sign.

Then run one complete real window as a smoke before the full calibration, still in this visible turn. Compare embedded PCM with source WAV by real waveform correlation, report actual lag/correlation for W01/W02/W03, and obtain real fine-grid SyncNet scores. If a consistent material lag is measured, create non-destructive corrected shot files and rerun; otherwise do not shift media merely to force zero. Rebuild a corrected final master only when the measurements require it.

Create the Stage 4L directory with stream/correlation evidence, synthetic sign test, raw fine-grid measurements, face/crop evidence, any corrected-shot provenance, before/after comparison, at least 30 truthful checks, verdict JSON, build log, and ZIP. Restore Stage 4G acceptance only if real calibrated measurements plus all prior media/audio/subtitle checks justify it. Otherwise keep it rejected with the exact blocker.

Leave no evaluator, helper server, or test process running. Write this marker as UTF-8 without BOM or newline:

`stage4l-antigravity-embedded-audio-calibration/phase4l-antigravity-embedded-audio-calibration.done`

The final line of your response must be exactly:

`STAGE7_ANTIGRAVITY_STAGE4L_EMBEDDED_AUDIO_CALIBRATION_COMPLETE_20260720`
