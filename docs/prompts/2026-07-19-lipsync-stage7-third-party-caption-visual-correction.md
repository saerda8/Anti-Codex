# Stage 7: host visual correction for clipped captions

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create a task/window, restart Anti-Codex, switch providers, rerun MuseTalk, redownload anything, modify product source, or call any of the nine development MCP workers.

The host independently inspected `qa/stage2a-contact-sheet.png`. The media metrics pass, but the visual acceptance does not: multiple Chinese captions are much too large and visibly clipped at the left, right, or top. Therefore the existing Phase 2A marker is not authoritative until this correction passes. Do not merely edit the report to say it passed.

Make only the affected caption/render/QA changes:

1. Preserve all three lip-sync MP4 files and their hashes exactly.
2. Replace the implicit SRT/libass sizing with a deterministic subtitle canvas. Prefer generating `captions-stage2a.ass` with `PlayResX: 1080`, `PlayResY: 1920`, Microsoft YaHei, approximately 54-64 px text, 80-100 px horizontal margins, 150-220 px bottom margin, outline for readability, and explicit line breaks. Keep `captions.srt` as the release subtitle source.
3. Split long Chinese captions into at most two balanced lines, normally no more than 13 Chinese characters per line. Every visible glyph must remain within the 1080x1920 frame and vertical safe area; captions must not cover eyes or mouths during the three speaking windows.
4. Update `build-stage2a.mjs` to burn the deterministic ASS subtitle and rebuild only `stage2a-third-party-cut.mp4`. Keep the already-correct audio mix and expected 52.304-second timeline.
5. Regenerate `qa/stage2a-contact-sheet.png` and `qa/stage2a-motion-strip.png` from the corrected final cut. Inspect all sampled segments. If any line is cropped, too close to an edge, or covers a speaker's face, fix and rebuild again.
6. Rerun full decode and media checks to confirm the prior 1080x1920, H.264/yuv420p, AAC 48 kHz, duration, -18 to -14 LUFS, <= -1 dBTP, no black frames, and no over-limit silence requirements still pass.
7. Update `stage2a-media-qa.json`, `stage2a-visual-qa.md`, `third-party-lipsync-production.json`, `provider-ledger.json`, and the final hash using actual post-fix results. Record this host-found caption regression and the correction honestly.
8. Rewrite `phase2a-third-party-production.done` only after the corrected contact sheet visibly proves all captions fit. Its exact content remains `STAGE7_THIRD_PARTY_PRODUCTION_BRIDGE_OK_20260719` with no BOM or newline.

Final response: give the corrected video hash, subtitle canvas/font/margins, media QA, and visual QA. Final line only the marker.
