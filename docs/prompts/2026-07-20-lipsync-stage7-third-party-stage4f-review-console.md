# Stage 7: third-party Stage 4F local review console

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9`. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create another task or Anti-Codex window. Do not modify Anti-Codex product source. Do not call the nine development MCP workers. Before each command group, briefly explain in Chinese what you are doing. Use real Codex tools and create a working local project; prose-only output does not count.

## Accepted read-only media

- `stage4e-publish-suite/stage4e-platform-master.mp4`
- `stage4e-publish-suite/stage4e-feed-cut-30s.mp4`
- `stage4e-publish-suite/stage4e-hook-cut-15s.mp4`
- Stage 4E subtitles, cover, QA images, manifest, ZIP and marker

Do not overwrite, rename, delete or duplicate these large media files. The new tool must reference them by safe relative paths.

## Build a real review project

Create `stage4f-review-console/` as an offline local video review application with no external network dependency.

1. Provide a compact Node server with no third-party package install, plus `start-review.bat` that starts exactly one server, opens the review URL once and exits without `pause` or restart loops. A second launch must reuse the existing healthy server or fail clearly; it must never spawn repeated browsers or Node windows.
2. Build a polished responsive Chinese interface that works at 1440x900 and 390x844. It must use the actual Stage 4E videos and QA images, not placeholders.
3. Include three clearly labeled cuts with a native video player, play/pause, mute, volume, current/total time, seek bar, previous/next frame controls, playback-rate menu and keyboard support.
4. Load the three real SRT files, render synchronized Chinese captions, and provide a searchable transcript. Clicking a caption must seek the active video.
5. Show real media facts from the Stage 4E QA/manifest: duration, dimensions, codec, loudness, peak, speaking seconds and SHA-256. Do not hard-code values that disagree with the files.
6. Provide side-by-side A/B mode between any two cuts with linked play/pause and linked seek positions by normalized progress.
7. Provide an approval checklist for picture, lipsync, captions, audio and CTA. Store draft review state locally, allow timestamped comments, and export a deterministic UTF-8 JSON review file from the browser.
8. Include a QA gallery using all six Stage 4E contact/motion images and the real cover, with keyboard-accessible modal viewing.
9. Add clear empty/error states for unavailable media, malformed subtitle data, invalid saved state and server port conflict. Do not silently claim success.
10. Add automated tests for SRT parsing, timestamp conversion, normalized A/B seek, review-state validation, deterministic export, path allowlisting, HTTP content types, range requests, singleton behavior and all required assets. Run at least 18 meaningful tests.
11. Add `README.md`, `review-data.json`, `qa-report.json`, `build-log.md`, and `stage4f-review-console.zip`. The ZIP must contain only the app, tests and documentation, not duplicate the Stage 4E videos; verify every entry is non-empty, readable and path-safe.
12. Append exactly one accurate Stage 4F third-party entry to the root `provider-ledger.json`.

## Completion marker

Only after tests, HTTP smoke, range request, singleton launch/stop cleanup and ZIP verification all pass, create:

`stage4f-review-console/phase4f-third-party-review-console.done`

with exactly:

`STAGE7_THIRD_PARTY_STAGE4F_REVIEW_CONSOLE_OK_20260720`

Write UTF-8 without BOM, CR or LF. Leave no review server or test process running. In the final response list the model, test count, HTTP/range/singleton results, ZIP entries and SHA-256. The final line must be only the marker.
