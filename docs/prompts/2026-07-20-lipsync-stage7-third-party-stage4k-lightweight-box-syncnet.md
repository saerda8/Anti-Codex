# Stage 4K: bypass S3FD and obtain real SyncNet scores

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9` in the same visible frontend. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Antigravity Gemini was genuinely attempted immediately before Stage 4J and returned `429 Too Many Requests` before any tool call, so continue with the configured third-party model for this recovery. Do not create another task/window, modify Anti-Codex product source, call the nine development MCP workers, download anything, or use a hidden product path. Explain each command group briefly in Chinese and keep all task work visible in this frontend turn.

Stage 4J proved that FaceAlignment/S3FD itself stalls for more than 260 seconds on one 16-frame window at 100% GPU and about 7.8 GiB VRAM. It never reached SyncNet scoring. Do not invoke FaceAlignment or S3FD again.

Obtain real scores using a lightweight local face-box path:

1. Inspect Stage 4J evidence and the three actual shot dimensions/representative frames. Use a local no-download detector such as OpenCV's bundled Haar cascade, or a clearly documented fixed/tracked ROI verified against representative frames from each shot. The crop must contain the correct visible face and mouth for W01, W02, and W03. Save representative frame plus drawn-box evidence for every shot.
2. Build a bounded smoke probe that loads SyncNet but never imports or initializes FaceAlignment/S3FD. Use one W01 window, the verified box path, the repository's exact 256x256 then lower-half visual preprocessing, and one zero-offset mel window. Persist stage timings before and after model load, crop, visual embedding, audio embedding, and cosine scoring. It must produce one finite real score before continuing.
3. Build an optimized resumable evaluator. Select at least three spread-out valid 16-frame windows per shot. Compute each visual embedding once, batch or reuse it across audio offsets, and score all five offsets `-0.40,-0.20,0,+0.20,+0.40`. Atomically update a progress JSON after every completed window or offset so interruption cannot erase completed work. Never substitute zero, constants, or expected values for a missing score.
4. Run the evaluator in this same visible turn with bounded polling and Chinese progress updates. Do not detach an unobserved process and do not finish while any evaluator is running.
5. Validate 3 shots x at least 3 windows x 5 offsets, finite score variation, per-shot face evidence, actual best offsets and confidence margins. Report the observed answer even if zero offset does not win. Keep Stage 4G rejected unless the real scores and all prior media/audio/subtitle checks support acceptance.
6. Create `stage4k-third-party-lightweight-syncnet/` with smoke timings, detector/crop evidence, progress/resume evidence, raw scores, aggregate scores, at least 28 truthful checks, verdict JSON, build log, and ZIP. Restore the Stage 4G final acceptance marker only when justified; otherwise leave it absent with the exact measured blocker.
7. Leave no evaluator, helper server, or test process running. Write this marker as UTF-8 without BOM or newline:

`stage4k-third-party-lightweight-syncnet/phase4k-third-party-lightweight-syncnet.done`

The final line of your response must be exactly:

`STAGE7_THIRD_PARTY_STAGE4K_LIGHTWEIGHT_SYNCNET_COMPLETE_20260720`
