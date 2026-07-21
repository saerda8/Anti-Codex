# Stage 4L: calibrate against embedded shot audio and correct real timing

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` in the same visible frontend. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Antigravity Gemini was attempted earlier in this sequence and is currently quota-blocked with 429. Continue with the configured third-party model, but preserve all evidence for a later Gemini audit. Do not create another task/window, modify Anti-Codex product source, call the nine development MCP workers, download anything, or perform hidden product work. Explain every command group briefly in Chinese.

Stage 4K produced 45 real scores with visually verified face boxes, but it compared shot video frames against separate source WAV files. The repository training contract in `musetalk/data/dataset.py::get_syncnet_input(video_path)` instead derives the mel from the video's own embedded audio. The three shot MP4 files contain AAC audio and their stream durations differ from the source WAVs. Do not treat Stage 4K offsets as final timing corrections until this is calibrated.

1. Inspect the exact SyncNet training/evaluation contract, Stage 4K evaluator, each shot MP4's embedded audio, and each source WAV. Record stream start times, durations, sample rates, encoder delay/padding evidence, and hashes.
2. Extract each shot's embedded audio losslessly to temporary PCM. Compute a real normalized waveform cross-correlation against its corresponding source WAV over a useful speech region. Report lag, correlation peak, and sign convention for W01/W02/W03. Do not infer lag from duration alone.
3. Reuse the Stage 4K visually verified boxes and exact lower-half SyncNet crop. Evaluate at least five spread-out valid windows per shot against the embedded MP4 audio, following the repository's exact `crop_audio_window` timing. Use a finer offset grid from `-0.50` to `+0.50` seconds in `0.10` increments. Save every finite score incrementally and record actual best offsets and margins.
4. If the embedded-audio evaluation shows a consistent material nonzero lag, create new corrected shot files without overwriting the originals, shift/remux only by the measured amount, and rerun the same fine-grid evaluation. If it does not show a real lag, do not change the media merely to force zero to win.
5. If corrected shots are required, rebuild a new corrected final master from the existing Stage 4B edit contract with dialogue, background music, effects, captions, and all prior visual requirements preserved. Never replace prior files in place. Verify duration, streams, loudness, subtitles, and real-person visuals.
6. Create `stage4l-third-party-embedded-audio-calibration/` containing stream/correlation evidence, fine-grid raw measurements, face/crop evidence, any corrected-shot provenance, before/after comparison, at least 30 truthful checks, verdict JSON, build log, and ZIP. Restore the Stage 4G final acceptance marker only if calibrated real measurements and all prior media/audio/subtitle checks justify it. Otherwise keep it absent with the exact measured blocker.
7. Leave no evaluator, helper server, or test process running. Write this marker as UTF-8 without BOM or newline:

`stage4l-third-party-embedded-audio-calibration/phase4l-third-party-embedded-audio-calibration.done`

The final line of your response must be exactly:

`STAGE7_THIRD_PARTY_STAGE4L_EMBEDDED_AUDIO_CALIBRATION_COMPLETE_20260720`
