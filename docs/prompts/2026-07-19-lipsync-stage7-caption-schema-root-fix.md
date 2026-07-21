# Stage 7: fix the ASS event schema and refresh the accepted cut

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` and the same project directory:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create another task or window, switch providers, restart either Codex client, regenerate MuseTalk shots, redownload assets, modify Anti-Codex product source, or call any of the nine development MCP workers.

The host found one precise subtitle-source defect after visually inspecting the rebuilt contact sheet. In `captions-stage2a.ass`, the event declaration currently omits `MarginV`:

`Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text`

The dialogue rows already use the standard ten-field shape, for example `Default,,0,0,0,,...`. Because the declaration has only nine fields, libass treats the extra delimiter as the first visible text character. Fix the declaration to exactly:

`Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

Keep every subtitle text, time, line break and style unchanged. Do not remove the legitimate empty `Effect` field delimiter.

Then complete only this bounded recovery:

1. Run the existing Stage 2A build exactly once and wait for it to finish.
2. Run the existing Stage 2A checker and require a complete decode, 52.304-second timeline, 1080x1920 H.264/yuv420p video, AAC 48 kHz audio, accepted loudness/peak, no black frames and no over-limit silence.
3. Regenerate the Stage 2A contact sheet and motion strip from the corrected MP4. Inspect every sampled subtitle and confirm there is no leading comma, clipping or face occlusion.
4. Update only the Stage 2A QA/production/ledger records that need the new command results, output hash and host-found schema correction. Do not claim Antigravity contribution yet.
5. Write exact UTF-8 content `STAGE7_THIRD_PARTY_CAPTION_SCHEMA_FIXED_20260719` with no BOM and no trailing newline to `phase2a-caption-schema-fixed.done` only after all checks pass.

Do not stop at a prose report. The corrected MP4, refreshed visual evidence, updated real measurements and exact marker are required. End the final response with `STAGE7_THIRD_PARTY_CAPTION_SCHEMA_FIXED_20260719`.
