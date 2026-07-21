# Stage 7: third-party Stage 4H adversarial repair of false acceptance

Continue the same native Anti-Codex task `019f7379-c051-7de1-b2eb-cd2e333bf8f9`. Work only in:

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

Do not create another task or Anti-Codex window. Do not modify Anti-Codex product source. Do not call the nine development MCP workers. Before every command group, briefly explain in Chinese what you are checking and why. Use real Codex tools visible in this task; prose-only output does not count.

The preceding Antigravity Stage 4G report is not accepted. Treat it as a failed audit that must be corrected, not as trusted input.

## Confirmed defects to repair

1. `stage4g-antigravity-acceptance/acceptance.json` names `Antigravity-gemini-3.1-pro-low`, but the real native route was `gemini-3.5-flash-extra-low`.
2. `run-acceptance.mjs` hard-codes every `measuredOffset` and `overallOffsetSeconds` to `0.0`; it never measures mouth motion or audio alignment.
3. The code claims dialogue and background music are both present from generic loudness/astats output, which cannot distinguish them.
4. Subtitle checks only validate ranges and overlaps; they do not establish agreement with the authored dialogue/audio windows.
5. The success marker and provider-ledger entry therefore overstate the evidence.

Immediately remove `stage4g-antigravity-acceptance/phase4g-antigravity-final-acceptance.done` before any other write. Preserve the original reports as evidence but clearly mark them superseded.

## Required repair

Create `stage4h-third-party-adversarial-audit/` and build a reproducible audit:

1. Use the real MuseTalk/LatentSync assets already present under `tools/musetalk/`, including `models/syncnet/latentsync_syncnet.pt`, when locally runnable. Evaluate the three protected lip-sync source shots. Compare the aligned audio score against multiple deliberately shifted offsets, record every score, best offset and confidence margin. Do not replace a failed evaluator with hard-coded zeros.
2. Prove how the three protected speaking shots map into all Stage 4E cuts. Verify that each mapped segment preserves source audio/video timing without independent stretch, delay or remux drift.
3. Verify dialogue plus background music using both build-graph provenance and measured final-audio evidence. Clearly separate what is directly measured from what is proven by deterministic source/mix provenance.
4. Cross-check SRT text and timing against `dialogue-map.json`, authored dialogue WAV hashes/durations and the actual cut mapping. Report mismatches; do not claim speech recognition if none was run.
5. Inspect real frame/contact-sheet evidence and retain the existing truthful limitation: frame strips prove real humans and visible mouth movement, but alone do not prove fine phoneme alignment.
6. Replace or correct the Stage 4G scripts/reports so every claim is generated from evidence. Correct the actual Antigravity model name. Rebuild the Stage 4G ZIP and ledger entry.
7. Add at least 20 meaningful automated checks covering anti-hardcode guards, real score provenance, shifted-offset controls, mapping integrity, audio/music provenance, subtitle/dialogue mapping, hashes, ZIP safety and exact markers.
8. Produce `stage4h-verdict.json`, `adversarial-report.md`, `syncnet-results.json`, `mapping-audit.json`, `audio-provenance.json`, `subtitle-dialogue-audit.json`, `test-log.txt`, `build-log.md` and `stage4h-third-party-adversarial-audit.zip`.

If fine lip-sync cannot be measured with the available local environment, state that precisely in `stage4h-verdict.json`, keep the Stage 4G acceptance marker absent, and do not claim final acceptance. A truthful blocker is better than a fabricated pass.

Only after this adversarial audit itself is complete, create:

`stage4h-third-party-adversarial-audit/phase4h-third-party-adversarial-audit.done`

with exactly:

`STAGE7_THIRD_PARTY_STAGE4H_ADVERSARIAL_AUDIT_COMPLETE_20260720`

Write UTF-8 without BOM, CR or LF. Leave no evaluator, media player, server or test process running. In the final response list the actual model, automated test count, whether SyncNet ran, measured best offsets/confidence, whether Stage 4G remains accepted, ZIP entries and SHA-256. The final line must be only the Stage 4H marker.
