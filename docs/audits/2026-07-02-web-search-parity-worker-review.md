# 2026-07-02 Web Search Parity Worker Review

## Result

The web-search parity fix is directionally correct and keeps the accepted architecture: Codex-owned tools remain in the client path, while Antigravity only supplies model text when model reasoning is actually needed.

## What Changed

- Plain web-search answers now return the already-fetched web evidence directly instead of asking the model to summarize it again.
- Local artifact tasks that need web evidence still continue into model-led Codex tool use.
- `report-site` tasks no longer fall through the generic deterministic artifact completion path unless they are part of the complex-project flow.
- Web evidence now prints source URLs with an ASCII `: ` separator, which keeps URL extraction stable.
- The local-artifact classifier no longer treats a plain request for "source URLs" as a file-writing task.

## Risk Review

- Low architecture risk: this is a routing correction inside the translator, not a new tool executor or external protocol.
- Main tradeoff: plain web-search can be more mechanical because it returns evidence directly. That is acceptable for verifier-style search prompts and avoids the internal tool loop that left the UI stuck.
- Model-led project tasks remain model-led; the change does not reintroduce hidden artifact guards for complex project proof.

## Required Main-Agent Verification

- Focused translator tests for internal web-search behavior.
- Real visible desktop `web-search` rerun with real Antigravity traffic.
- No-traffic rollups for real-task coverage, desktop task suite, long-task landing, agentic capability, and native Codex parity task matrix.
