# Stage 7: third-party production resume after completed inference

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` and the same project directory:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create a new task, start a second Anti-Codex window, restart Anti-Codex, switch providers, modify Anti-Codex product source, or call any of the nine development MCP workers. Before each command group, state its purpose in one short Chinese sentence. On Windows, use native PowerShell, Node.js, Python, FFmpeg, and FFprobe directly. Do not use `rtk powershell`, `rtk ls`, `rtk tail`, patch heredocs, or `apply_patch.bat` wrappers.

## Authoritative checkpoint

The single MuseTalk inference process has finished and no Stage 7 inference Python process remains. Do not download dependencies or weights again and do not rerun all three inferences unless a specific output fails decode or visual QA.

The actual MuseTalk V1.5 outputs are:

- `cache/musetalk-results/v15/lipsync-female-hook.mp4`: 2,833,096 bytes, about 8.813 seconds.
- `cache/musetalk-results/v15/lipsync-male-eye-area.mp4`: 1,301,859 bytes, about 7.677 seconds.
- `cache/musetalk-results/v15/lipsync-female-wrap.mp4`: 2,824,144 bytes, about 8.814 seconds.

All three currently probe as H.264 720x1280 at 24000/1001 fps with AAC mono 48 kHz. Treat files and command output as authoritative. Recheck them before relying on these values. Keep `phase1-third-party.done` unchanged. Do not create `phase2-antigravity.done` in this provider phase.

## Required continuation

1. Fully decode all three MuseTalk outputs. Record duration, streams, frame rate, audio sample rate, and SHA-256. If one file alone is corrupt, repair only that file.
2. Copy or reference the verified outputs as three durable `shots/lipsync-*.mp4` artifacts. Preserve their input clip, source interval, WAV, Chinese line, generation command, duration, and hash in `third-party-lipsync-production.json`.
3. Extract at least 12 consecutive frames from each actual MuseTalk output into `qa/lipsync-*-strip.png`, plus a total lip-sync contact sheet. Visually inspect the real faces and mouth-shape changes. Do not extract QA frames from source clips. Record honest findings, including visible artifacts or uncertainty, in `stage2a-visual-qa.md`.
4. Build `stage2a-third-party-cut.mp4` from the verified lip-sync shots and the existing real live-action skincare footage. It must be 40-60 seconds, 1080x1920, H.264/yuv420p, AAC 48 kHz, and include Chinese dialogue, self-generated or legally usable BGM, captions, hook, problem, demonstration, result, and action prompt. It must remain real-world live-action, not animation, 3D, a slide show, or still-image motion.
5. Create `captions.srt`, `qa/stage2a-contact-sheet.png`, `qa/stage2a-motion-strip.png`, `stage2a-media-qa.json`, `stage2a-visual-qa.md`, and reproducible build/QA scripts. JSON values must come from real command results.
6. Verify full decode, 40-60 second duration, 1080x1920 frame, accepted frame rate, H.264/yuv420p, AAC 48 kHz, subtitle bounds/no overlaps, no non-narrative black frames, longest non-narrative silence below 1.5 seconds, integrated loudness between -18 and -14 LUFS, true peak no higher than -1 dBTP, at least three visible speaking windows, and at least 10 seconds total visible speaking time. Fix failed items and rerun only affected work.
7. Append the actual third-party production commands, files, hashes, repairs, and QA result to `provider-ledger.json`. Preserve the earlier Gemini location failure and Claude 429 entries. State explicitly that Antigravity has not yet contributed a tool call or file and Phase 2 is still pending.
8. Do not delete the project-local environment, model files, or current `R:` mapping yet; the next Antigravity and final-edit phases may still need them. Do not touch Docker.

Only after every required file and check above passes, create `phase2a-third-party-production.done` with the exact UTF-8 content below and no BOM, carriage return, or trailing newline:

`STAGE7_THIRD_PARTY_PRODUCTION_BRIDGE_OK_20260719`

In the final response, report the three lip-sync outputs, total visible speaking duration, cut path and duration, media/visual QA results, and key hashes. The final line must contain only the marker.
