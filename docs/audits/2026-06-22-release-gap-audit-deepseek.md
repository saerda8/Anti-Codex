# Anti-Codex Practical Release Checklist (DeepSeek) -- 2026-06-22

This file keeps the worker audit grounded in evidence already collected by the
main agent. It intentionally avoids speculative requirements such as external
packet captures or multi-hour soak gates unless the user asks for release QA.

## Passed In This Batch

- `/health` is green on `http://127.0.0.1:8484`.
- Antigravity Desktop is the upstream.
- Account readiness is green.
- Traffic readiness is green after the real-work and soak runs.
- Model catalog contains eight entries:
  - `gemini-3.5-flash-low`
  - `gemini-3-flash-agent`
  - `gemini-3.5-flash-extra-low`
  - `gemini-3.1-pro-low`
  - `gemini-pro-agent`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6-thinking`
  - `gpt-oss-120b-medium`
- Real-work verifier passed with:
  - real tool call
  - real file write
  - real script execution
  - real `node_repl` MCP marker
  - Chinese continuation response
- Stability soak passed with stable translator PID.
- Installed fast overall passed after the soak.
- Source syntax/preflight checks passed after the runtime repair.

## Must Stay True

- Anti-Codex must never ask for ChatGPT login in normal Antigravity mode.
- Anti-Codex and original Codex must remain separate installed apps/processes.
- Switching model must not erase the conversation or project state.
- Third-party API mode must not silently fall back to Antigravity traffic after
  a failed provider save/test.
- Antigravity mode must expose the signed-in account model catalog, including
  exact model numbers.
- MCP/skills must come from the isolated Anti-Codex home unless explicitly
  refreshed from shared Codex snapshots.
- Sync must not install a JavaScript-broken translator into the runtime path.

## Remaining Before A Release Commit

- Run non-fast installed overall once, because fast mode skips some slow probes.
- Run sync-readiness after any icon, shortcut, host, or rollback-host change.
- Inspect `git diff --check` before commit.
- Review untracked files and decide whether each is product code, evidence, or
  temporary output.
- Avoid further icon design work until the user provides a final replacement.

## Worker Lesson

Docs-only workers are useful for independent checklist writing. They must still
be reviewed, because they may invent broad QA requirements or wrong product
terms. Source edits should not run in the same worktree while scoped workers are
active unless the worker has an isolated workspace.
