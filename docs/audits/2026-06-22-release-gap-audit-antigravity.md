# Anti-Codex Release Gate Audit (Antigravity) -- 2026-06-22

This audit records practical release evidence after the runtime recovery and
custom-tool streaming fix. It is ASCII-only by design so worker output can be
validated reliably on Windows.

## Green Evidence

- Real Antigravity work passed on 2026-06-22 08:06 local time.
  - The model called `create_probe_file`.
  - A real `.mjs` artifact was written and executed.
  - `node_repl` MCP returned the expected marker.
  - The model continued in Chinese with the tool result.
- Stability soak passed after the latest runtime recovery.
  - Duration: about 283 seconds.
  - Health checks: 19.
  - Translator PID stayed stable.
  - Chinese replies, long context, tool loop, streaming, cancellation, and loop
    health all passed.
- Installed fast no-traffic overall passed after the soak.
  - One Anti-Codex main process.
  - One translator process.
  - No ChatGPT login text.
  - No reconnect text.
  - Eight visible Antigravity models.
  - MCP 3 / Skill 100.
  - Plugin and connector snapshots readable.
- Runtime sync guard now checks `translator/adaptive-server.mjs` syntax before
  and after copying into the installed runtime.

## Current Release Gaps

- Run one non-fast installed overall before a release cut.
  - Purpose: include the slower Manager action security probe and full checks.
- Run one installed sync-readiness after any host/icon/shortcut change.
  - Purpose: prove desktop/start-menu shortcuts, rollback host, and active host
    still match.
- Keep real traffic probes explicit.
  - `real-work` and `real-mini-tool` must stay opt-in with `-AllowRealTraffic`.
- Keep worker isolation strict.
  - Do not let workers edit core files while the main agent edits the same area.
  - Prefer docs-only workers or separate worktrees for audits.

## Watch Items

- The stability soak can exceed the outer shell timeout even when the inner
  script eventually passes. Watch the process and read the latest report before
  classifying it as failed.
- PowerShell console text can display mojibake even when the JSON evidence is
  valid UTF-8. Prefer JSON fields and ASCII markers for release evidence.
- Plugin/connectors are metadata-visible but app tools remain unavailable unless
  connectors are accessible. Do not present unauthorized connectors as callable.

## Suggested Next Gate

Run the non-fast installed overall check once after the current development
batch is frozen. If it passes, the remaining work is packaging/commit hygiene
rather than core runtime repair.
