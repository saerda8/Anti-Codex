# Stage 4J: Gemini SyncNet diagnostic and resumable real scoring

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9`. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

This is an Antigravity Gemini turn. Do not create another task or window, do not modify Anti-Codex product source, do not call the nine development MCP workers, do not download anything, and do not use a different provider. Use real Codex tools from this visible frontend turn. Before every command group, briefly explain in Chinese what you are checking or changing.

Stage 4I truthfully ended blocked. Its real evaluator ran for about 2,260 seconds but produced zero completed score windows. Stage 4G remains rejected. Do not restore its success marker unless real measurements support it. Do not rerun the unchanged 38-minute evaluator.

Your job is to diagnose the concrete bottleneck and obtain real, nonconstant SyncNet measurements without fabricating any value:

1. Read `tools/musetalk/eval_stage4i.py`, the local `SyncNet.forward`, Stage 4I reports, and the three shot/audio inputs. Confirm argument/return order, tensor shapes, mel/frame alignment, face detection behavior, output paths, and the exact expensive stage.
2. First create and run a bounded one-shot, one-window, one-offset smoke probe. Reuse the verified local S3FD and SyncNet checkpoints. Print and persist timing for model load, face detection, preprocessing, visual inference, audio inference, and cosine scoring. The smoke probe must either produce one finite real score or capture the exact exception/timeout. Do not proceed to a long run until this probe succeeds.
3. After a successful smoke probe, replace the evaluator with a resumable implementation that:
   - detects only frames needed by selected score windows and caches boxes;
   - batches inference where safe;
   - writes progress and completed measurements atomically after every shot/offset;
   - can resume completed work without recomputing it;
   - records invalid windows honestly and never substitutes `0`, expected values, or constants for missing scores;
   - keeps enough spread-out valid windows for each of W01, W02, and W03 to make all five offsets `-0.40,-0.20,0,+0.20,+0.40` meaningful.
4. Run the optimized evaluator in this same visible turn with bounded polling. Keep the user informed in Chinese while it runs. Do not detach an unobserved background task and do not finish while a child evaluator is still running.
5. Verify all three shots and all five offsets have finite measured scores, scores vary, shifted controls are distinguishable, face boxes correspond to each shot, and output hashes/provenance are real. Review whether zero offset or another offset wins for each shot; do not force the expected answer.
6. Create `stage4j-antigravity-syncnet-diagnostic/` containing the smoke timings, progress/resume evidence, raw measurements, face evidence, test log with at least 24 truthful checks, verdict JSON, build log, and ZIP. Correct Stage 4G reports and restore its final acceptance marker only if real scoring plus all prior media/audio/subtitle checks support acceptance. Otherwise keep it absent and state the exact remaining blocker.
7. Leave no evaluator, helper server, or test process running. Write the Stage 4J completion marker as UTF-8 without BOM or newline:

`stage4j-antigravity-syncnet-diagnostic/phase4j-antigravity-syncnet-diagnostic.done`

The final line of your response must be exactly:

`STAGE7_ANTIGRAVITY_STAGE4J_SYNCNET_DIAGNOSTIC_COMPLETE_20260720`
