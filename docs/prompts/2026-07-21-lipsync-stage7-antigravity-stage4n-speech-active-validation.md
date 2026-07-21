# Stage 4N: repair the lip-sync acceptance test and finish the real-person master

Continue in this exact visible Anti-Codex task. Use the currently selected Antigravity Gemini model. Do not use the localhost third-party provider because its quota is unavailable. Do not create another task, window, background agent, or MCP worker. Before every real tool call, write one short Chinese sentence explaining the next action so the user can follow the work in the frontend.

Work only under:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Stage 4M already completed official MuseTalk 1.5 inference. Preserve its three regenerated real-person shots and the exact saved coordinate files. Do not rerun MuseTalk unless later evidence proves a regenerated shot itself is necessary:

- `stage4m-antigravity-official-coordinate-master/shots/lipsync-female-hook.mp4`
- `stage4m-antigravity-official-coordinate-master/shots/lipsync-male-eye-area.mp4`
- `stage4m-antigravity-official-coordinate-master/shots/lipsync-female-wrap.mp4`
- `stage4m-antigravity-official-coordinate-master/42323.pkl`
- `stage4m-antigravity-official-coordinate-master/41290.pkl`

The Stage 4M SyncNet verdict is blocked, but its five-window selection is not a valid spoken-window acceptance test. It selected fixed timeline positions without checking speech activity. Independent host evidence found these embedded-audio silence intervals at `-35 dB`, minimum `0.20 s`:

- W01: `2.293-3.170`, `3.580-3.981`, `5.477-5.916`, `8.081-8.832 s`
- W02: `1.840-2.285`, `3.882-4.347`, `6.898-7.680 s`
- W03: `2.042-2.438`, `3.811-4.618`, `6.018-6.400`, `8.073-8.832 s`

Several Stage 4M fixed 16-frame windows overlap those pauses or trailing silence, so their random maxima must not be used to shift media or reject the shots.

## Required work

1. Create a non-destructive Stage 4N directory named `stage4n-antigravity-speech-active-master`. Reuse the Stage 4M shots and exact coordinate pickles; record their SHA-256 hashes before any work.
2. Repair or replace the evaluator so it selects exactly five spread-out **speech-active** 16-frame windows per shot from the embedded MP4 audio. Search candidates across the timeline, divide the usable spoken duration into temporal regions, and select strong non-overlapping candidates. Each selected window must save its start/end time, RMS dBFS, speech-active sample/frame ratio, selection region, and objective eligibility decision. Reject windows dominated by silence; do not cherry-pick by SyncNet score.
3. Keep the official Stage 4M coordinate-cycle crop mapping and embedded-audio path. Score every selected window over offsets `-0.50..+0.50 s` in `0.10 s` steps. Save all finite raw scores, annotated crops, per-window maxima, aggregate scores, confidence margins, and speech-activity evidence atomically.
4. Add deterministic synthetic tests proving speech-window selection rejects known silent windows, remains spread across the spoken timeline, and does not inspect SyncNet scores while selecting windows. Retain the corrected full-lag waveform-correlation controls for `+0.12 s`, `-0.12 s`, and `0.0 s`.
5. Acceptance remains strict: for every shot, at least 4/5 eligible speech windows must choose an offset in `[-0.10,+0.10 s]`; aggregate best must be in that range and beat both `-0.30` and `+0.30` controls. Report all three conditions separately.
6. If an eligible-window shot still fails, do not blindly use its aggregate. Only apply one non-destructive audio timing correction when at least 4/5 high-confidence speech windows agree on the same correction within `0.10 s` and the aggregate confidence margin supports it. Preserve the original shot, document the sign convention with a synthetic control, correct the embedded dialogue timing, and rerun the same evaluator. If offsets remain inconsistent, keep acceptance blocked and report the exact evidence; never force a pass.
7. If all three shots pass, rebuild the final 1080x1920 real-person narrative short-video master using the corrected shots, Chinese dialogue, readable subtitles, and background music that does not mask speech. It must look like a live-action short drama/product video, not slides or animation. Reuse the established Stage 2/Stage 3 composition assets and preserve originals.
8. On a passing master, run full decode plus duration, resolution, H.264/yuv420p, AAC 48 kHz, loudness, true peak, black-frame, freeze-frame, silence, subtitle-boundary, visual contact-sheet, exact artifact-hash, ZIP-entry/hash, and at least 40 truthful automated checks. Inspect representative full-size frames and mouth crops. Do not treat metadata-only checks as visual acceptance.
9. Restore the Stage 4G acceptance marker only if the speech-active SyncNet criteria, final media QA, visual QA, and package integrity all pass. Otherwise leave it absent. The Stage 4N report must state `PASS` or `BLOCKED` plainly.
10. Leave no inference, evaluator, ffmpeg, helper, or server process running when finished. Append the actual Antigravity/Gemini run and outcome to `provider-ledger.json` without deleting history.

Write a Stage 4N completion marker at:

`stage4n-antigravity-speech-active-master/phase4n-antigravity-speech-active-audit.done`

Its exact UTF-8 content and your final response's last line must be:

`STAGE7_ANTIGRAVITY_STAGE4N_SPEECH_ACTIVE_AUDIT_FINISHED_20260721`

That marker means the Stage 4N attempt finished, not that product acceptance passed. Product acceptance is determined only by the explicit verdict and Stage 4G acceptance marker.
