# Stage 7: third-party Stage 4E publish-ready live-action suite

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9`. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create another task or Anti-Codex window. Do not modify Anti-Codex product source. Do not call the nine development MCP workers. Before each command group, briefly explain in Chinese what you are about to do. You must use real Codex tools and create verified media files; prose-only work does not count.

## Immutable accepted baseline

- `stage4b-third-party-directors-cut.mp4` is the accepted 50.342-second live-action master. Its SHA-256 is `2c59b39cc3004468d1b7c28e76a5e27bc3c640721d7f702066511e47f5363f0f`.
- `stage4d-third-party-provisional-package.zip` and every Stage 4A/4B/4D source, QA file, package and marker are read-only. Do not overwrite, rename or delete them.
- Antigravity Gemini Stage 4C is externally blocked by `unsupported_location`; do not create or claim its marker.

## Required real deliverables

Create a new directory `stage4e-publish-suite/` and perform a material re-edit from the accepted real-person footage. Do not merely copy Stage 4B under new names.

1. Inspect the Stage 4B contact sheet, motion/lipsync strips and sampled frames from the actual video. Record at least three concrete editing decisions tied to visible evidence.
2. Create a reproducible `build-stage4e-publish-suite.mjs` plus subtitle/edit-decision sources.
3. Produce `stage4e-platform-master.mp4`: 45-55 seconds, 1080x1920, H.264/yuv420p, AAC 48 kHz, at least 14 meaningful edit segments, a real-person spoken hook within the first 2 seconds, at least three visible speaking windows totaling at least 10 seconds, and a complete problem-demo-answer-result-CTA story.
4. Produce two independently authored derivatives from the same real footage and edit sources:
   - `stage4e-feed-cut-30s.mp4`, 27-32 seconds, with a complete product/demo/CTA arc.
   - `stage4e-hook-cut-15s.mp4`, 13-17 seconds, with a visible speaking hook and readable CTA.
5. Keep dialogue intelligible and include at least music, environment, and action/transition sound layers. For all three videos require integrated loudness from -18 to -14 LUFS, true peak no higher than -1 dBTP, no black-frame event of 0.1 seconds or longer, and no non-story silence of 1.5 seconds or longer.
6. Produce Chinese SRT captions for all three videos and a 1080x1920 PNG cover derived from a real video frame. Captions must stay inside a mobile-safe area and may not cover faces or the demonstrated eye area.
7. Generate contact sheets and motion strips from each final video itself. At minimum create six QA images under `stage4e-publish-suite/qa/`.
8. Create and run `check-stage4e-publish-suite.mjs`. It must fully decode all three videos, inspect streams/durations, black frames, silence, loudness, true peak, subtitle bounds, frame continuity, file hashes and package entries. Repair failures and rerun until green.
9. Create machine-readable and human-readable evidence:
   - `stage4e-media-qa.json`
   - `stage4e-visual-qa.md`
   - `stage4e-edit-decisions.md`
   - `stage4e-build-log.md`
   - `stage4e-delivery-manifest.json`
   - `stage4e-third-party-result.json`
10. Package only the final videos, captions, cover, build/check sources, QA evidence and manifest as `stage4e-publish-suite.zip`. Verify every ZIP entry is non-empty, readable, relative-path safe and hash-matched to the manifest.
11. Append exactly one accurate third-party Stage 4E entry to the root `provider-ledger.json`; do not rewrite or duplicate older entries.

## Completion marker

Only after every check passes, create `stage4e-publish-suite/phase4e-third-party-publish-suite.done` with exactly:

`STAGE7_THIRD_PARTY_STAGE4E_PUBLISH_SUITE_OK_20260720`

Write UTF-8 without BOM, CR or LF. In the final response list the actual model, three output durations, speaking-window totals, QA results, ZIP entry count, and SHA-256 values. The final line must be only the marker.
