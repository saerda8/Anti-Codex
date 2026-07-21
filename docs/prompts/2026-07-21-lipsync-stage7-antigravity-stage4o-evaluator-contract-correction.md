# Stage 4O: correct the speech-window evaluator contract before judging lip sync

Continue in this exact visible Anti-Codex task with the selected Antigravity Gemini model. The localhost third-party provider has no quota, so do not use it. Do not create another task, window, background agent, MCP worker, browser, or webpage. Before every tool call, write one short Chinese action explanation in the visible frontend.

Work only under:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Preserve the Stage 4M shots and coordinate pickles. Do not rerun MuseTalk. Stage 4N correctly began selecting speech-active windows, but independent host review found three acceptance-contract defects that invalidate its aggregate verdict:

1. W02 selected `2.377-3.045 s` and `2.920-3.587 s`, which overlap.
2. W03 selected `4.630-5.297 s` and `4.671-5.339 s`, which are nearly the same window.
3. W01 selected `0.125-0.792 s`; offsets `-0.50..-0.20 s` were unavailable there. Aggregate offsets therefore used different window counts, and the reported aggregate best `-0.50 s` was not comparable to the other offsets.

## Required correction

1. Create a non-destructive directory `stage4o-antigravity-evaluator-contract-master`. Reuse the exact Stage 4M MP4 and PKL files by hash; preserve Stage 4N evidence unchanged.
2. Refactor the speech-window selector into testable pure logic. Generate the complete candidate pool before any SyncNet inference. A candidate is eligible only when:
   - its 16 video frames are inside the shot;
   - its audio is objectively speech-active using the saved RMS/activity rules;
   - it is not dominated by any known silence interval;
   - every one of the 11 offsets from `-0.50` through `+0.50 s` has a complete 52-column mel window.
3. Select exactly five eligible windows deterministically, independent of SyncNet scores. They must be ordered, pairwise non-overlapping (`next.startFrame >= previous.endFrame`), and spread across the usable speech-active timeline. Use a deterministic coverage-plus-energy selection or dynamic program. Never fall back to an ineligible window. If fewer than five exist, report insufficient evidence and remain blocked.
4. Save the full candidate pool and the exact rejection reasons for every rejected candidate. For every selected window save start/end frame and time, RMS dBFS, activity ratio, silence overlap, full-grid-valid flag, region/coverage evidence, and selection rank.
5. Add deterministic tests that call the real selector, use a fixed seed where samples are generated, and prove all of these properties: silent candidates rejected; boundary candidates lacking the full grid rejected; selected windows are five, eligible, ordered, pairwise non-overlapping and spread; selection output is unchanged when fake SyncNet scores are permuted or absent; no fallback can return an ineligible window.
6. Rerun the exact-coordinate embedded-audio SyncNet evaluator on the unchanged Stage 4M shots. Assert every selected window has exactly 11 finite scores. Assert every aggregate offset averages exactly the same five windows. Abort the verdict if either invariant fails.
7. Keep acceptance unchanged: each shot needs at least 4/5 window maxima within `[-0.10,+0.10 s]`, aggregate best inside that range, and aggregate best above both `-0.30` and `+0.30` controls. Save all raw scores and confidence margins.
8. Do not apply a timing shift unless at least 4/5 valid non-overlapping windows agree within `0.10 s`, with a meaningful aggregate margin and a proven sign convention. If this condition is absent, remain blocked without altering media.
9. If all three shots genuinely pass, continue to the previously specified final 1080x1920 live-action narrative master, subtitles, background music, full decode, visual QA, 40+ checks, hashes, and ZIP validation. Restore Stage 4G acceptance only after all of those pass. Otherwise leave Stage 4G absent and state `BLOCKED` plainly.
10. Append the actual Gemini run to `provider-ledger.json`. Leave no evaluator, ffmpeg, helper, inference, or server process running at completion.

Write a completion marker at:

`stage4o-antigravity-evaluator-contract-master/phase4o-antigravity-evaluator-contract-audit.done`

Its exact UTF-8 content and the final response's last line must be:

`STAGE7_ANTIGRAVITY_STAGE4O_EVALUATOR_CONTRACT_AUDIT_FINISHED_20260721`

This marker records only that Stage 4O finished. It does not itself mean product acceptance passed.
