# Stage 7: resume caption correction after client-owner interruption

Continue the same native task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` in the same project:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create another task/window, switch providers, restart Anti-Codex, rerun MuseTalk, redownload files, modify Anti-Codex product source, or call any of the nine development MCP workers.

The prior caption-correction turn successfully created `captions-stage2a.ass` and updated `build-stage2a.mjs` to use a 1080x1920 ASS canvas. It then started the corrected render, but the old Anti-Codex owner was terminated when native Codex restarted. The resulting `stage2a-third-party-cut.mp4` is incomplete: host FFmpeg reports `moov atom not found`. Its current 13,631,536-byte file and SHA-256 `DAE700A2EC936FFC3B23CBDC8B588ED350541B007525B329589546728242F915` are failure evidence, not a valid output. The old Phase 2A marker and old QA reports are stale and must not be treated as completion.

The Anti-Codex launcher is now running independently under Windows Task Scheduler. Resume only the interrupted work:

1. Verify the three `shots/lipsync-*.mp4` files still fully decode and preserve their hashes. Do not regenerate them.
2. Inspect `captions-stage2a.ass` and `build-stage2a.mjs`: require PlayResX 1080, PlayResY 1920, 60 px Microsoft YaHei, 90 px left/right margins, 190 px bottom margin, explicit balanced line breaks, and the already-correct 52.304-second audio mix.
3. Overwrite only the corrupt `stage2a-third-party-cut.mp4` by running the corrected build once. Wait for FFmpeg to exit successfully and verify the MP4 has a readable moov atom and fully decodes.
4. Regenerate `qa/stage2a-contact-sheet.png` and `qa/stage2a-motion-strip.png` from that corrected output. Inspect every sampled segment and confirm all Chinese glyphs stay inside the frame/safe area and do not cover a speaker's eyes or mouth. If this fails, adjust only subtitles and rebuild once more.
5. Rerun duration, dimensions, codecs, frame rate, 48 kHz audio, loudness, true peak, black-frame, silence, caption bounds, speaking-window, and hash checks.
6. Update `stage2a-media-qa.json`, `stage2a-visual-qa.md`, `third-party-lipsync-production.json`, `provider-ledger.json`, and the corrected final hash. Record the interrupted corrupt render and successful recovery.
7. Rewrite `phase2a-third-party-production.done` only after the corrected video, refreshed contact sheet, and all checks pass. Exact content: `STAGE7_THIRD_PARTY_PRODUCTION_BRIDGE_OK_20260719`, no BOM or newline.

Final response: corrected video hash, ASS canvas/style, media QA, visual QA, and confirmation that no MuseTalk inference was rerun. Final line only the marker.
