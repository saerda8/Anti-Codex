# Approved Real-Run Sequence Review

Date: 2026-06-30

Scope: no-traffic review of the next real task run. This file does not authorize login, account proof, or model traffic.

## Contract

- Anti-Codex must not start login or real traffic before the separate Windows-user account lane is ready.
- The first concrete real refresh after approval must include `web-search` and `free-chat`, because those are the remaining stale/failed broad-task modes.
- Required release gates stay separate from optional provider/soak checks. The release-required real-traffic gates are `accountProxyReadiness` and `postVerification`.
- Every login or real-traffic stage must require an explicit user approval marker.

## Current Status

`latest-approved-real-run-sequence.json` is a report-only gate. It can prove the next sequence is ordered and guarded, but it cannot prove model quality until the user approves the real run after account isolation is ready.

Current blocker: `.\\AntiCodexModel` is missing, so the correct next operator action remains separate Windows-user setup before any second-account login.
