# Anti-Codex Manager Long Task UI Review

Date: 2026-06-22

## Confirmed

- Long-running actions are already grouped under high-impact operations.
- Embedded Manager has running text and duplicate-click protection.
- Fallback Manager can read diagnostics and show local status cards.

## Gaps

- Status was split across sync and post-verification cards.
- Fallback Manager did not show a dedicated background-task summary.
- Worker-generated Chinese audit files were not reliable because mojibake appeared again.

## Suggested UI

- Add a "background tasks" card that shows running count, attention count, sync stage, post-verification stage, and latest report path.
- Keep the card read-only and refresh-driven.
- Add static and installed UI verification so the card cannot disappear silently.
