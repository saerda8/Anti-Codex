# Anti-Codex Runtime Recovery Status -- 2026-06-22

## Completed

- Recovered the installed translator after it failed to start.
  - Root cause: duplicated `translatedToolParts` function header in the
    installed runtime file.
  - Repair: removed the duplicate header and copied the repaired runtime file
    back to source so source and runtime hashes match.
- Hardened custom-tool streaming.
  - Custom tool calls are buffered until completion.
  - Valid custom calls emit matching `custom_tool_call` added/done events.
  - Invalid custom calls emit matching `message` added/done events.
- Hardened runtime sync.
  - `sync-anticodex-runtime.ps1` now checks `translator/adaptive-server.mjs`
    syntax before and after copying to the installed runtime.

## Evidence

- Source checks:
  - `node --check translator/adaptive-server.mjs`: pass.
  - `node --test translator/tests/adaptive-pseudo-tools.test.mjs`: 127 pass.
  - `node --test translator/tests/anticodex-launcher.test.mjs`: 85 pass.
  - Source preflight fast mode: pass.
- Installed checks:
  - Health: green on `http://127.0.0.1:8484`.
  - Upstream: Antigravity Desktop.
  - Account ready: true.
  - Traffic ready: true.
  - Model count: 8.
  - Circuit: closed.
  - Manager panel injection: `native-panel-v82`.
  - Manager actions: 12 daily actions, 7 high-impact actions, `viewLatestReports`
    included in the daily group.
  - Manager close button hit grid: pass.
  - Manager theme follow: light/dark host theme sync pass.
  - Manager no external page: pass.
  - Third-party API entry: embedded high-impact action present.
- Real-use checks:
  - Recovered from a failed full real-traffic verification caused by stale
    route-audit selection plus a stuck local Antigravity session lock.
  - `test-anticodex-tool-loop.ps1`: pass, about 19 seconds, current-window
    route evidence only.
  - `test-anticodex-native-multi-tool-loop.ps1`: pass, about 33 seconds.
  - `test-anticodex-web-tools.ps1`: pass, about 11 seconds.
  - `test-anticodex-mcp-tool-loop.ps1`: pass, about 23 seconds, observed a
    real node_repl MCP marker.
  - `test-anticodex-custom-tool-loop.ps1`: pass, about 19 seconds.
  - `test-anticodex-compaction-resume.ps1`: pass, about 48 seconds.
  - `test-anticodex-account-proxy-readiness.ps1`: pass, real request marker
    returned and local proxy bypass confirmed.
  - `test-anticodex-real-mini-tool.ps1 -AllowRealTraffic`: pass, created and
    ran a real temporary mini-tool.
  - `test-anticodex-real-work.ps1 -AllowRealTraffic`: pass, created a real
    probe file and observed node_repl MCP marker.
  - Full `test-anticodex-post-verification.ps1` with real traffic: pass, about
    419 seconds, `overall.ok=true`, zero failures.
  - Final diagnostics after the full run: health true, traffic ready,
    session lock inactive, queued 0, active requests 0, Manager long-task
    attention 0.
  - `test-anticodex-real-work.ps1 -AllowRealTraffic`: pass.
  - Post-v82 `test-anticodex-real-work.ps1 -AllowRealTraffic`: pass, about
    19 seconds, created a real probe file, observed node_repl MCP marker, and
    returned a Chinese completion.
  - `test-anticodex-stability-soak.ps1`: pass, about 283 seconds.
  - `test-anticodex-installed-overall.ps1 -Fast`: pass, about 21 seconds.
  - `test-anticodex-installed-overall.ps1 -EnsureRunning -NoTraffic
    -SkipAccountProxyProbe`: pass, about 138 seconds.

## Notes

- The long stability soak can outlive the outer shell timeout. When this
  happens, check the still-running process and then read
  `latest-stability-soak.json` before classifying the run.
- `progress.md` currently contains non-UTF-8 bytes, so future status updates
  should use ASCII audit/status files unless that file is normalized first.
- Do not resume icon design work until the user provides a final icon asset.
- Route-audit based real-traffic tests must not use global latest records as
  proof for the current request. Match by response id first, then by expected
  model inside the current verification window.
- A stale Antigravity session lock can be reset when diagnostics show zero
  active upstream requests, even if the local lock still reports active/queued.
- Real-traffic full suites should pass at least 90 seconds to model/tool
  subchecks and keep the parent subcheck wait at 120 seconds or higher. Stable
  Gemini tool tasks can legitimately take 30-50 seconds.
- For mixed script updates, remember the encoding split:
  - Node `.js` and `.mjs`: UTF-8 without BOM, then `node --check`.
  - Windows PowerShell `.ps1` with non-ASCII literals: parse under Windows
    PowerShell 5.1; UTF-8 BOM is acceptable and sometimes required.
