# Stage 4M: Gemini regenerates and proves the final real-person lip-sync master

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` in this same visible frontend. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

This is a production correction, not another prose audit. The last completed turn was actually routed through `gemini-3.1-pro-low` and used 48 real tool calls, although it resumed a legacy Stage 4L directory and marker named `third-party`. Preserve that directory as immutable historical evidence; do not rename or overwrite it.

Independent host review found two invalid Stage 4L conclusions:

- waveform correlation stored `lagSeconds: 1.0` because its center-crop/lag indexing was wrong, then the report asserted `0.0` without a corrected measurement;
- per-window SyncNet maxima were inconsistent, not one stable shot offset: W01 `+0.2,+0.5,-0.3,-0.1,+0.4`; W02 `+0.4,-0.5,+0.1,-0.1,+0.2`; W03 `+0.3,+0.5,-0.4,+0.3,+0.2`. The evaluator reused sparse nearest Stage 4K boxes, so aggregate offsets cannot justify shifting media.

Do not solve this by moving each whole audio track. Rebuild and verify the mouth animation using the existing official MuseTalk 1.5 checkout, installed virtual environment, local model weights, original real-person sources and exact Chinese dialogue WAV files. Do not download anything, call the nine development MCP workers, create another native task/window, modify Anti-Codex product source, or perform hidden product work. Before every command group, explain in Chinese what you are about to do. Start each expensive command once and wait for that exact process; never relaunch it because output is temporarily quiet.

Write all new artifacts under:

`stage4m-antigravity-official-coordinate-master/`

## Required execution

1. Inspect `third-party-lipsync-production.json`, `run-musetalk-stage2a.ps1`, `tools/musetalk/scripts/inference.py`, the Stage 4L results, source videos `42323.mp4` and `41290.mp4`, and the three exact dialogue WAV files. Record hashes before changing anything.
2. Repair waveform correlation with a standard full-lag implementation such as `scipy.signal.correlate` plus `correlation_lags`. Prove `+0.12 s`, `-0.12 s`, and zero-lag synthetic cases, then measure embedded AAC versus source WAV. Save the actual lag index, seconds, peak and sign convention; no narrative override of a broken numeric result is allowed.
3. Create a non-destructive Stage 4M MuseTalk config and runner. Run the official inference with coordinate preservation enabled so the exact per-frame face boxes used to generate the mouth region survive. Do not reuse Stage 4K Haar/nearest boxes. Generate new W01/W02/W03 shots from the two original real-person videos and exact Chinese WAV files into the Stage 4M directory. Preserve originals.
4. First run one bounded shot end to end as a smoke. Confirm real frames, audio stream, output duration and saved coordinates before starting the remaining two shots. If the smoke fails, diagnose that exact failure instead of repeatedly launching inference.
5. Build an evaluator that follows the official embedded-MP4 audio path and uses the exact MuseTalk coordinate cycle corresponding to each generated output frame. Score at least five spread-out windows per shot over offsets `-0.50..+0.50` in `0.10 s` steps, saving every finite score atomically. Save annotated crop frames and per-window maxima.
6. Acceptance must be per-window, not aggregate-only: at least four of five windows in each shot must select an offset within `-0.10..+0.10 s`; each shot aggregate best must also be within that range and beat both `-0.30 s` and `+0.30 s` controls. If this fails, keep Stage 4G rejected and report the exact shot/window evidence. Do not force a pass.
7. If all three regenerated shots pass, rebuild a new final vertical master from the established Stage 4B/4E edit contract using only the regenerated speaking shots. Preserve real-person action footage, intelligible dialogue, background music, sound effects, subtitles and story/offer continuity. Do not overwrite earlier masters.
8. Independently verify full decode, duration 45-90 seconds, 1080x1920 H.264/yuv420p, AAC audio, dialogue audibility, music presence, subtitle timing/safe area, no black intervals, no long silence, reasonable loudness/true peak, continuous real-person motion and at least two visibly real speakers. Produce a contact sheet plus consecutive speaking-frame strips for every dialogue window.
9. Create source/config/runner, fixed evaluator, synthetic tests, raw score grid, coordinate provenance, correlation evidence, regenerated shots, final master, subtitles, media report, at least 40 truthful checks, build log, hashes and a release ZIP. The package must be readable and its manifest hashes must match.
10. Restore the existing Stage 4G acceptance marker only if every requirement above passes. Otherwise leave it absent and make the Stage 4M verdict blocked with precise evidence. Leave no inference/evaluator/helper process running.

Write this marker as UTF-8 without BOM or newline:

`stage4m-antigravity-official-coordinate-master/phase4m-antigravity-official-coordinate-master.done`

The final line of your response must be exactly:

`STAGE7_ANTIGRAVITY_STAGE4M_REAL_LIPSYNC_MASTER_COMPLETE_20260721`
