# MCP Worker Rules

This file is mandatory project memory for DeepSeek and Antigravity worker dispatch.
Read it before every worker task. Update it after every worker failure before retrying.

## Dispatch Rules

1. One dispatch has one observable output and one behavior goal.
2. Prefer one new file or one existing file. More than two writable files requires a written reason.
3. Use at most three acceptance checks per dispatch. Split additional behavior into later dispatches.
4. Give the worker the smallest practical writable directory, not a brittle file-by-file sandbox.
5. Use `permission_mode=acceptEdits` and `safety_mode=permissive` for isolated project tasks.
6. Do not forbid paths the worker must read, import, or execute for validation.
7. RED-test tasks run syntax checks only. Do not require the intentionally failing behavior test to pass.
8. The main agent and other workers must not write the same worktree while a worker is running.
9. Parallel workers require separate worktrees. Otherwise dispatch workers serially.
10. A worker report is untrusted until `git status`, changed-file scope, diff, syntax, and tests are reviewed.
11. For injected UI version changes, review persistent `window.__ANTICODEX_*` timers, observers, promises, and caches. A new version must explicitly dispose incompatible globals left by the previous version.

## Time Rules

1. Check status after about 30 seconds without a file change.
2. Active streaming or tool input is progress; do not cancel only because no file exists yet.
3. No logs, no stream activity, and no diff after a second check means the task must be classified and redesigned.
4. Ordinary test child processes need explicit timeouts. A small contract test should not wait indefinitely.
5. When the active shell is already PowerShell, run parser/check expressions directly in that shell. Do not wrap them in `powershell.exe -Command`; native argument parsing can strip nested quotes even when the outer command appears single-quoted. Use a temporary `.ps1` file only when a separate process is required.
6. Do not pipe `rtk rg` into an early-closing output limiter such as `Select-Object -First`; it can return a failure code after producing useful output. Use the search tool's own match limit or accept the complete small result.
7. Before a batched file read, confirm every inferred filename with `rtk rg --files` or an exact directory listing. One guessed missing path can fail the whole read and hide valid sibling results.
8. On Windows, do not pass wildcard filenames such as `scripts/test-*.ps1` as `rg` path arguments. Search the directory and use `-g "test-*.ps1"` so PowerShell and Win32 path parsing cannot reject the command.
9. If a worker-created file displays mojibake or uncertain Unicode, do not use the garbled text as an `apply_patch` context anchor. Inspect the exact UTF-8 text and patch around stable ASCII code lines, or replace the small new file as a whole.
10. Runtime sync can update translator files but cannot hot-update the already-running Anti-Codex launcher/watchdog. Any change to `scripts/start-deepcodex.ps1` must be validated after restarting the Anti-Codex shell process, not only after restarting the translator.
11. Busy marker files used by watchdogs must be atomic writes. If the marker file is fresh but temporarily unparsable, treat it as busy instead of restarting the worker process.

## Failure Protocol

After every failure, before another dispatch:

1. Record worker, job ID, task, terminal state, logs, and changed files.
2. Classify the cause: scope too broad, permissions too narrow, wrong worker type, shared-worktree pollution, unclear output, or external CLI/account failure.
3. Change at least one concrete cause before retrying. Rewording the same task is not a retry strategy.
4. Prefer this retry order:
   - reduce to one behavior;
   - reduce to one output file;
   - loosen the writable boundary to the target directory;
   - switch worker only when the task better matches the other worker;
   - use an isolated worktree when concurrent writes are necessary.
5. Do not silently let the main agent take over after the first failure. Re-dispatch a materially smaller task first.
6. If Antigravity passes CLI doctor but two materially small jobs both exit code 2 with no stdout, stderr, or file changes, classify the execution channel as unhealthy. Do not spend more tokens rewording the same job; switch the coding task to another worker and diagnose Antigravity separately.

## Incident Log

### 2026-06-20 - Antigravity empty failure

- Job: `ag-66bdafcf-2ffc-41f9-b638-902f5f2c6469`
- Task: create one update-status contract test covering seven behaviors.
- Result: exit code 2 after about 85 seconds; no stdout, stderr, or file changes.
- Cause classification: task was nominally one file but behavior scope was still too broad for the worker.
- Rule change: one worker dispatch now has one behavior and at most three acceptance checks.

### 2026-06-20 - DeepSeek narrowed retry succeeded

- Job: `dsw_mqm8vmyi_5rko2t`
- Task: create one RED test for only the empty-state `idle/none` behavior.
- Permissions: writable `translator/tests` directory, key source paths forbidden, permissive isolated edit mode.
- Result: completed in about 72 seconds; exactly one file changed; policy and syntax check passed.
- Evidence: narrowing behavior scope and giving directory-level write permission resolved the previous failure.

### 2026-06-20 - PowerShell parser check quoting failure

- Task: parse-check the new update-status module after the focused test passed.
- Result: the product test passed, but the parser command failed before parsing the file.
- Cause classification: command construction failure; the parent PowerShell expanded `$tokens` and `$errors` inside a nested double-quoted command.
- Rule change: nested PowerShell checks with variables must use a single-quoted command block or a temporary script file before retrying.

### 2026-06-20 - Antigravity tiny-task silent failure

- Job: `ag-c9fbbd1b-1dc7-48c1-b32e-59eceb2ca4e5`
- Task: append one legacy-status fallback RED test to one existing test file.
- Result: exit code 2 after 21 seconds; CLI doctor was ready, but the job produced no stdout, stderr, or file changes.
- Cause classification: Antigravity CLI execution-channel failure, not task breadth. The task already had one behavior, one file, and one syntax check.
- Rule change: after two silent exit-code-2 jobs with a healthy doctor, stop prompt-only retries, switch the coding task to another worker, and isolate Antigravity diagnosis from product work.

### 2026-06-20 - Repeated nested PowerShell quoting failure

- Task: parse-check two update-state PowerShell files after all four behavior tests passed.
- Result: the behavior tests passed; the nested parser command lost quotes around its file list and failed before reading either file.
- Cause classification: repeated command-construction failure. A single-quoted `-Command` argument was still altered by native Windows argument parsing.
- Rule change: PowerShell parser checks must run directly in the active PowerShell shell; nested `powershell.exe -Command` is prohibited for this case.

### 2026-06-20 - Search pipeline false failure

- Task: list the first few Node test names before running a focused Manager test.
- Result: names were printed, but piping `rtk rg` into `Select-Object -First` closed the stream early and returned exit code 1.
- Cause classification: command-construction failure, not a repository or test failure.
- Rule change: limit search output at the search command itself; do not truncate `rtk rg` through an early-closing pipeline.

### 2026-06-20 - Guessed verifier filename broke batched read

- Task: inspect the existing MCP tool-loop and native MCP verification scripts together.
- Result: the real `test-anticodex-mcp-tool-loop.ps1` was read, but the guessed `test-anticodex-native-mcp-tool-loop.ps1` path did not exist and made the batched command fail.
- Cause classification: file-discovery failure; a capability name was converted into an unverified filename.
- Rule change: confirm exact filenames before batched reads, then read only paths returned by the repository file list.

### 2026-06-20 - Windows wildcard path search failure

- Task: find Codex executable and app-server usage across Anti-Codex verifier scripts.
- Result: `rg` received `scripts/test-anticodex-*.ps1` as a literal Windows path and exited with OS error 123.
- Cause classification: command-construction failure; wildcard filtering was placed in the path argument.
- Rule change: use a real directory path plus `-g` for wildcard file filtering on Windows.

### 2026-06-20 - Mojibake patch context mismatch

- Task: clean worker comments and add the stdio MCP implementation in one patch.
- Result: `apply_patch` could not find the displayed mojibake comment because the console rendering did not match the file's exact UTF-8 characters.
- Cause classification: patch-context failure caused by encoding-unstable text.
- Rule change: patch encoding-damaged files only through stable ASCII anchors or replace a small new file wholesale after exact inspection.

### 2026-06-20 - Nested PowerShell null-variable expansion

- Task: parse-check `test-anticodex-mcp-skills.ps1` after wiring real MCP smoke.
- Result: the parser returned `syntax ok`, but the parent shell expanded `$null` inside the nested `powershell.exe -Command` string and emitted a bogus `=` command error.
- Cause classification: repeated command-construction failure.
- Rule change: do not wrap parser checks in nested `powershell.exe -Command` when the active shell is already PowerShell; run `[scriptblock]::Create(...)` directly or escape `$` variables explicitly.

### 2026-06-21 - Parser check variable expansion repeated

- Task: parse-check `test-anticodex-model-routing.ps1` after adding third-party provider route validation.
- Result: the focused launcher contract test passed, but the parser command expanded `$null` and `$errs` before PowerShell parsed the check.
- Cause classification: repeated command-construction failure.
- Rule change: parser checks in this repo must use a single-quoted command string or escaped `$` variables; do not put `$null`, `$errs`, `$tokens`, or `$errors` inside an outer double-quoted shell command.

### 2026-06-21 - Complex rg alternation split by PowerShell again

- Task: search remaining third-party skip conditions with quoted alternation patterns.
- Result: a simple literal skip search succeeded, but the complex `rg` pattern with embedded quoted strings was split into invalid Windows paths.
- Cause classification: repeated command-construction failure.
- Rule change: split quoted/alternation searches into separate simple literal `rg` calls. Do not combine `"third-party"` quoted fragments, `|`, and multiple variable names in one Windows PowerShell search command.

### 2026-06-21 - Expected RED worker reported as failed

- Worker: DeepSeek `dsw_mqmvsmk6_4ec95p`.
- Task: add only the provider-neutral model-route audit object-name assertions.
- Result: the worker correctly edited only the allowed test file, but the job was reported failed because the new RED test was included as a required passing check.
- Cause classification: dispatch contract mismatch, not bad code.
- Rule change: when assigning a RED-only test task to a worker, run syntax checks only or explicitly omit behavior checks that are expected to fail until the main agent implements the production change.

### 2026-06-20 - PowerShell pipeline after foreach block failed

- Task: inspect the desktop Anti-Codex shortcut target and arguments.
- Result: the first one-liner ended a `foreach` block and then piped with an empty pipeline element, causing `An empty pipe element is not allowed`.
- Cause classification: command-construction failure.
- Rule change: when collecting objects from nested loops, assign to an array first and pipe the final array after the loop statement is closed.

## Current Default Templates

### Test-only worker

- Writable scope: the target test directory.
- Output: one new test file.
- Checks: syntax only for RED; focused test for GREEN.
- Runtime writes: temporary directory only, cleaned in `finally`.

### Production worker

- Writable scope: one implementation directory or one to two named files.
- Output: one behavior change.
- Checks: one focused test plus one syntax/parser check.
- Main agent performs integration and full regression after review.
### 2026-06-20 - Do not wrap PowerShell builtins with rtk
- Task: inspect project notes and manager source snippets before the next UI hardening pass.
- Result: `rtk Get-Content` and `rtk Select-String` failed because PowerShell builtins are not PATH executables.
- Cause classification: command-runner mismatch; `rtk` is useful for normal external commands but should not wrap shell-native cmdlets.
- Rule change: for PowerShell builtins such as `Get-Content` and `Select-String`, run them directly with tight path and line limits. Keep `rtk` for external commands such as `rg`, `git`, `node`, and script invocations.

### 2026-06-20 - Do not mix escaped regex fragments into PowerShell double quotes
- Task: search version and sync-readiness summary patterns before bumping Manager v68.
- Result: PowerShell parsed an escaped quote inside the regex as the end of the command string and failed before running `rg`.
- Cause classification: command-construction failure.
- Rule change: split complex searches into simple literal patterns, or wrap regex arguments in single quotes in PowerShell. Do not put `\"`, `\)`, or similar escaped fragments inside a double-quoted shell command.

### 2026-06-20 - Scope wording assertions to the changed action
- Task: reject stale MCP Manager wording after changing the MCP/Skill summary to real `node_repl` evidence.
- Result: the first assertion banned the generic phrase `可调用验证`, but that phrase is still legitimate for plugin and local-feature refresh contexts.
- Cause classification: test-contract failure; the assertion targeted a shared phrase instead of the MCP-specific stale wording.
- Rule change: when replacing wording for one action, assert the action-specific stale phrase or surrounding context. Do not ban a generic label used by other actions.

### 2026-06-20 - Do not patch large tests from memory
- Task: add launcher coverage for a new shortcut-repair Manager action.
- Result: the first patch failed because the expected nearby assertion text did not exactly match the current test file.
- Cause classification: patch-context failure.
- Rule change: before editing dense tests, inspect the exact 40-80 line window around each insertion point and patch in small hunks anchored on current text.

### 2026-06-20 - One insertion point per dense test patch
- Task: retry adding shortcut-repair launcher coverage after inspecting the exact windows.
- Result: the patch still failed because one mismatched later hunk invalidated the whole multi-hunk patch.
- Cause classification: patch batching failure.
- Rule change: for dense test files, apply one insertion point per patch. Do not combine unrelated insertions into one `apply_patch` call.

### 2026-06-20 - Use single-line anchors after repeated patch misses
- Task: insert one action-name assertion into the Manager HTML test.
- Result: a multi-line anchor that visually matched the file still failed to apply.
- Cause classification: brittle patch context in a dense, frequently edited test window.
- Rule change: after two misses in the same area, anchor on one stable adjacent line and insert one or two lines only.

### 2026-06-20 - Do not anchor patches on mojibake UI labels
- Task: add the shortcut-repair Manager action across server, injected Manager, and scripts.
- Result: the combined patch failed because `adaptive-server.mjs` contains legacy mojibake labels whose console rendering is not stable patch context.
- Cause classification: encoding-unstable patch context plus over-batched edit.
- Rule change: patch files with mojibake only through ASCII anchors such as action keys, script filenames, and function names. Split new files and each touched source file into separate patches.

### 2026-06-20 - Patch mojibake HTML through extracted ASCII tokens only
- Task: insert the fallback Manager page shortcut-repair button and result text.
- Result: the patch still used mojibake button text as surrounding context and failed.
- Cause classification: repeated encoding-unstable patch context.
- Rule change: for fallback HTML in `adaptive-server.mjs`, first inspect or replace using `data-action="..."` tokens only; never include the visible label in patch context.

### 2026-06-21 - Do not pass external paths in DeepSeek forbidden_paths
- Task: dispatch a docs-only DeepSeek audit for shortcut repair safety.
- Result: DeepSeek rejected the job because `forbidden_paths` included `C:\Users\XD\AppData\Local\Anti-Codex`, which escapes the current workspace.
- Cause classification: worker-dispatch parameter failure.

### 2026-06-22 - Do not pass DeepSeek sandbox keys to Antigravity

- Worker: Antigravity dispatch rejected before starting.
- Task: create one read-only Manager v79 audit report.
- Result: MCP validation failed because `allowed_dirs` and `forbidden_paths` are not accepted by `antigravity_start_implementation`.
- Cause classification: worker-dispatch parameter failure.
- Rule change: Antigravity writable limits must be stated in the task text. Only pass fields supported by its schema: `cwd`, `model`, `task`, `checks`, and `timeout_ms`.

### 2026-06-22 - Avoid byte-unsafe PowerShell rewrites

- Task: bump Manager injected-panel version after adding diagnostics timeout.
- Result: a bulk PowerShell rewrite corrupted UTF-8 JS/PS files and had to be recovered from the installed runtime copy.
- Cause classification: byte-unsafe edit method.
- Rule change: do not bulk replace UTF-8 source files with `Set-Content`. Use `apply_patch` for source edits, or a byte-safe purpose-built script only when mechanical rewriting is unavoidable.
- Rule change: DeepSeek `allowed_dirs` and `forbidden_paths` must be workspace-relative or inside `cwd`. Mention external runtime paths in the task text instead of passing them as forbidden paths.

### 2026-06-21 - Inspect exact escaped lines before patching mojibake HTML
- Task: insert fallback Manager HTML `repairShortcuts` button.
- Result: the patch using the visually copied mojibake line still failed because displayed characters did not match file bytes.
- Cause classification: encoding-unstable patch context.
- Rule change: for mojibake HTML lines, read exact JSON-escaped line content first, then patch around an ASCII-only neighboring token when possible.

### 2026-06-21 - Avoid inline Node quote soup in PowerShell
- Task: print JSON-escaped lines from `adaptive-server.mjs`.
- Result: nested PowerShell/Node quoting corrupted the string literals and Node failed before reading the file.
- Cause classification: command-construction failure.
- Rule change: use a short temporary script, Node REPL, or PowerShell-native selection for complex quoting. Do not put multiple nested quoted JavaScript string literals into `node -e` from PowerShell.

### 2026-06-21 - Docs-only DeepSeek review misreads dirty worktree
- Job: `dsw_mqmjuo6i_bvj1y6`
- Task: write one shortcut-repair safety audit under `docs/audits`.
- Result: failed policy because the worker evaluated the already-dirty workspace and reported existing `MCP_WORKER_RULES.md` and `translator/adaptive-server.mjs` changes as forbidden/docs-only violations.
- Cause classification: worker-dispatch strategy failure in a dirty repo, not a product failure.
- Rule change: do not run docs-only DeepSeek review jobs against the main dirty workspace unless using an isolated clean worktree or allowing the existing dirty paths explicitly. Prefer main-agent review or a worker that writes only into an isolated worktree.

### 2026-06-21 - Antigravity broad audit timed out
- Job: `ag-e31cf798-4238-4729-93db-e2d479c1bf9a`
- Task: inspect Manager repair-shortcuts UI coverage and write an audit document.
- Result: timed out at 120 seconds with no useful output.
- Cause classification: worker task still too broad for the current Antigravity channel.
- Rule change: retry Antigravity with a tiny output-only task or a single-file/single-question task. Do not ask it to inspect multiple large source files in one job.

### 2026-06-21 - Antigravity tiny doc task also timed out
- Job: `ag-9d205d5f-ff09-4e31-ab33-2653861f6035`
- Task: create exactly one tiny audit markdown file with three bullets, no source inspection.
- Result: timed out at 60 seconds with no useful output.
- Cause classification: Antigravity worker execution channel unhealthy for this session, not task breadth.
- Rule change: stop spending product-work time on Antigravity prompt retries in this dirty workspace. Continue mainline implementation and diagnose Antigravity separately when the user asks for worker-channel repair.

### 2026-06-21 - Run repository status from the real repo root
- Task: check current worktree status before continuing Manager v69 validation hardening.
- Result: `git status` was first run from `G:\Trae-Project\Anti-Codex`, which is only the container folder, not the actual repo.
- Cause classification: workspace-location failure.
- Rule change: for this project, run repo status and diffs from `G:\Trae-Project\Anti-Codex\deepcodex` unless a later handoff explicitly changes the repo root.

### 2026-06-21 - Do not use visible mojibake labels as patch anchors
- Task: move the fallback Manager `repairShortcuts` button from dynamic insertion into the static daily action list.
- Result: the patch failed because the displayed mojibake labels around `syncReadiness` and `updateCheck` did not match the file bytes.
- Cause classification: encoding-unstable patch context.
- Rule change: when editing fallback Manager HTML inside `translator/adaptive-server.mjs`, use action IDs and scripted byte-stable replacements only; do not include rendered Chinese/mojibake labels in patch anchors.

### 2026-06-21 - Node REPL may be unavailable under missing sandbox metadata
- Task: use Node REPL to apply an encoding-stable Manager HTML replacement.
- Result: the Node REPL tool failed before running code with `codex/sandbox-state-meta: missing field sandboxPolicy`.
- Cause classification: tool-runtime availability failure.
- Rule change: if Node REPL fails before user code starts, switch to a bounded local Node or PowerShell script and keep the replacement anchored on ASCII action IDs.

### 2026-06-21 - Never write JavaScript with PowerShell UTF8 BOM
- Task: mechanically rewrite `translator/adaptive-server.mjs` after mojibake-safe replacement.
- Result: `[Text.Encoding]::UTF8` wrote a BOM, and `node --check` failed on the first line with `Invalid or unexpected token`.
- Cause classification: encoding regression.
- Rule change: JavaScript and JSON source files must be written with UTF-8 without BOM, for example `New-Object System.Text.UTF8Encoding($false)`. Reserve UTF-8 with BOM only for direct Windows PowerShell 5.1 scripts that need non-ASCII UI text.

### 2026-06-21 - Re-run isolated PowerShell contract failures before changing code
- Task: run the full translator source test suite after Manager fallback cleanup.
- Result: the suite had one failure in `update-status-contract.test.mjs`; the child PowerShell process returned `code null` with no stdout or stderr after about seven seconds.
- Cause classification: likely test-process flake or host PowerShell startup failure, not a product assertion failure.
- Rule change: when a full suite failure reports `PowerShell exited code null` without stdout/stderr, first rerun the affected focused test before editing product code.

### 2026-06-21 - Escape PowerShell regex dollars in single quotes
- Task: search reporting helpers across PowerShell scripts before adding shortcut-repair report persistence.
- Result: a double-quoted `Select-String` regex containing `\$false` was interpolated by PowerShell into `\False`, making the regex invalid.
- Cause classification: command-construction failure.
- Rule change: put regex patterns that contain `$`, `\`, or alternation into single quotes, or split them into simple literal searches.

### 2026-06-21 - Reinspect exact function signatures before multi-hunk server patches
- Task: add shortcut-repair diagnostics status to `translator/adaptive-server.mjs`.
- Result: the first multi-hunk patch missed because the diagnostics function signature context did not exactly match the current file.
- Cause classification: stale patch-context failure.
- Rule change: for large server files, inspect the exact 30-line window around every insertion and apply one conceptual insertion per patch.

### 2026-06-21 - Antigravity read-only audit still timed out after health ready
- Job: `ag-2506d201-0618-4131-bc38-f71e86207f53`
- Task: read-only review of Manager v69 shortcut-repair visibility gaps, with no file edits.
- Result: Antigravity CLI health reported ready, but the job timed out after 120 seconds with no stdout, stderr, or parsed text.
- Cause classification: worker execution-channel failure after readiness, not task breadth.
- Rule change: do not use Antigravity worker for critical-path implementation in this session even when health is ready. If the user asks to repair worker usage, diagnose Antigravity CLI job execution separately from product development.

### 2026-06-21 - Scope whitespace checks in a long-lived dirty worktree
- Task: run `git diff --check` after shortcut-repair diagnostics work.
- Result: the check failed on broad pre-existing whitespace noise in `scripts/start-deepcodex.ps1`, producing thousands of unrelated lines.
- Cause classification: dirty-worktree validation scope failure.
- Rule change: in this project, use scoped `git diff --check -- <touched files>` for the current batch unless deliberately cleaning legacy whitespace in a separate task.

### 2026-06-21 - Quote PowerShell parser checks so `$null` survives
- Task: parse `scripts/repair-anticodex-shortcuts.ps1` after shortcut-spec hardening.
- Result: the parser-check command failed before product parsing because `$null` inside a double-quoted outer command was expanded away, leaving `[ref],[ref]` and a bare `>`.
- Cause classification: command-construction failure.
- Rule change: use single-quoted outer PowerShell commands, escaped backticks, or a simple `try { . <script> -? }`-free parser helper when passing `$null`, `[ref]`, or redirection through nested shells.

### 2026-06-21 - Do not send docs-only DeepSeek into the dirty main worktree
- Job: `dsw_mqmklgjq_7qu0pc`
- Task: create one tiny docs-only coverage review.
- Result: failed the worker success contract because it treated the existing dirty workspace changes as forbidden generated changes, including source files modified by the main agent and other workers.
- Cause classification: worker-dispatch strategy failure in a dirty repo.
- Rule change: docs-only DeepSeek jobs must run in a clean worktree or be skipped. In this project, use ordinary subagents or main-agent review for docs-only audits while the main worktree is intentionally dirty.

### 2026-06-21 - Antigravity may complete with empty parsed output
- Job: `ag-5c826783-48aa-4720-a04c-f362db8528ce`
- Task: tiny read-only CSS/event review.
- Result: completed successfully at the process level but returned empty parsed text, so it produced no usable engineering signal.
- Cause classification: worker-output contract failure.
- Rule change: Antigravity read-only jobs need an explicit artifact or machine-checkable output file when used for review. Empty stdout with success is not accepted as useful work.

### 2026-06-21 - Patch project memory by ASCII prefixes when old CJK is unstable
- Task: update `task_plan.md` current-status bullets after Manager v69 hardening.
- Result: `apply_patch` missed the Manager-direction bullets because old CJK/mojibake text in the file did not match the rendered context.
- Cause classification: encoding-unstable patch context.
- Rule change: for project memory files with older mojibake lines, replace whole bullets by stable ASCII prefixes such as `- Current Manager direction:` instead of matching the full rendered Chinese text.

### 2026-06-21 - Quote ripgrep patterns with embedded quotes safely
- Task: search Manager action inventory for `data-action="..."` and `upstreamConfig`.
- Result: the `rg` pattern was truncated by nested PowerShell/JSON quoting, producing an unclosed regex group.
- Cause classification: command-construction failure.
- Rule change: split complex `rg` searches into simple literal searches or put the pattern in single quotes inside the shell command; avoid mixing alternation and escaped quotes in one nested command.

### 2026-06-21 - Insert fallback Manager action text by action-id anchor
- Task: add `upstreamConfig` fallback Manager result text in `translator/adaptive-server.mjs`.
- Result: `apply_patch` missed because the nearby rendered Chinese/mojibake action text did not match the file bytes.
- Cause classification: encoding-unstable patch context.
- Rule change: for `actionText(payload)` branches in `adaptive-server.mjs`, insert using stable ASCII anchors such as `if(payload?.action==="syncHost"){` and write UTF-8 without BOM.

### 2026-06-21 - Full regression exposed stale shared-Codex projection expectation
- Task: run the full translator source suite after changing plugin/MCP projection to Anti-Codex-local snapshots only.
- Result: `adaptive-pseudo-tools.test.mjs` expected connector/app/plugin data from `DEEPCODEX_SHARED_CODEX_HOME`, while the new product rule intentionally degrades instead of reading shared Codex caches.
- Cause classification: stale test-contract failure after accepted product boundary change.
- Rule change: when a worker changes a core boundary such as "local snapshot only", run the full suite and update older broad tests to assert both sides of the contract: local snapshots are read, shared-only caches are ignored.

### 2026-06-21 - Antigravity artifact task failed despite explicit output file
- Job: `ag-fb3ddb6e-f1b9-44da-b0e7-7bd24d60e538`
- Task: create one audit markdown file for plugin/MCP/Manager risk.
- Result: Antigravity exited code 2 with no stdout, stderr, parsed text, or usable artifact.
- Cause classification: worker execution-channel failure after readiness, not missing task output.
- Rule change: do not put Antigravity CLI worker on the critical path in this session. Use ordinary forked subagents for parallel product work, and treat Antigravity CLI reliability as a separate repair task before relying on it again.

### 2026-06-21 - Ripgrep default regex does not support lookaround
- Task: scan scripts for unsafe process/destructive-command patterns with one combined negative-lookahead regex.
- Result: `rg` failed with `look-around is not supported` before scanning.
- Cause classification: command-construction failure.
- Rule change: either use simple literal searches in separate commands or explicitly use `rg --pcre2` for lookaround. Prefer simple literal scans for audit checks so failures are unambiguous.

### 2026-06-21 - Insert launcher tests by exact local context
- Task: add source coverage for the C# Anti-Codex native shortcut launcher timeout.
- Result: the first patch missed because the nearby `launch stage` assertion block had changed and the expected context was not exact.
- Cause classification: stale patch-context failure.
- Rule change: inspect the exact test boundary before inserting new tests; anchor new launcher-source tests after the nearest stable `});` or existing test name, not a loose assertion line.

### 2026-06-21 - Patch PowerShell probes in small hunks
- Task: add a Manager action probe for `Origin: null`.
- Result: a combined patch missed at the report-summary tail because the object fields had drifted from the expected context.
- Cause classification: stale patch-context failure.
- Rule change: for PowerShell probe scripts with long report objects, add the new request/probe first, then inspect the exact report tail before adding summary fields.

### 2026-06-21 - Do not read optional PowerShell JSON fields through dynamic strict properties
- Task: harden Anti-Codex update-check guardrails while running `update-status-contract.test.mjs`.
- Result: the drift test failed in strict mode when `$Manifest.files.$name` read a missing manifest hash such as `codexCli`.
- Cause classification: strict-mode optional-field access failure.
- Rule change: use a safe property helper for optional JSON fields before comparing manifest hashes; missing fields should become guardrail failures, not script crashes.

### 2026-06-21 - Keep PowerShell Select-String audits to simple patterns
- Task: inspect update-check guardrail edits after the focused test passed.
- Result: a combined `Select-String` regex ended with a stray escaped `$` fragment after JSON/PowerShell quoting and failed before inspection.
- Cause classification: command-construction failure.
- Rule change: for post-edit audits in PowerShell, run simple literal or short regex patterns separately instead of one long alternation with escaped variables.

### 2026-06-21 - Route PowerShell builtins through a real shell when using rtk
- Task: inspect repo state and skill files before adding Manager high-impact action confirmation.
- Result: `rtk proxy Get-Location`, `rtk proxy Get-ChildItem`, and `rtk proxy Get-Content` failed because PowerShell builtins are not standalone executables.
- Cause classification: command-runner mismatch.
- Rule change: use `rtk` for external executables such as `rg`, `git`, `node`, and `powershell`; for PowerShell builtins, either run them directly in the active shell or call `rtk proxy powershell -NoProfile -Command "<builtin>"`.
## 2026-06-21 - rollback guardrail patch stale context

- 现象：给 `scripts/rollback-anticodex.ps1` 增加 tray icon / FileDescription / OriginalFilename / criticalPatches 校验时，整块 `apply_patch` 没命中。
- 原因：该脚本在当前工作树已有并行修改或行尾/上下文差异，使用大块上下文不稳。
- 规则：对正在并行开发的 PowerShell 脚本只打 3-8 行小补丁；先用精确锚点读当前片段，再分段插入。

## 2026-06-21 - update guardrail patch stale source-hash context

- 现象：替换 `scripts/check-anticodex-update.ps1` 中 manifest source hash 读取逻辑时，补丁没命中。
- 原因：并行 worker 已经改过同一段，当前内容与主线记忆不一致。
- 规则：并行 worker 回来后，主 agent 必须先重读目标 20 行内当前片段，再打补丁；不要沿用几分钟前的代码片段。

## 2026-06-21 - update guardrail message patch stale context

- 现象：修改 `guardrails.message` 时再次使用旧片段，`apply_patch` 未命中。
- 原因：同一脚本已有 worker 的并行编辑，尾部对象字段顺序变了。
- 规则：一个文件出现两次 stale patch 后，停止按记忆补；用当前文件片段作为唯一依据，必要时先等 worker 完成。

## 2026-06-21 - subagent thread limit after parallel batch

- 现象：三组 worker 尚未关闭时再开最终审查 agent，返回 `agent thread limit reached`。
- 原因：完成的 agent 仍占并发槽位，主 agent 没有及时关闭。
- 规则：每轮并行 worker 完成并审查后，立刻 `close_agent` 释放槽位；最终审查要在关闭旧 worker 后再开。

## 2026-06-21 - PowerShell parser command used uninitialized ref vars

- 现象：语法检查命令打印 `parser-ok`，但同时输出 `[ref] cannot be applied to a variable that does not exist`。
- 原因：StrictMode 下 `$tokens` / `$errs` 未初始化就传 `[ref]`。
- 规则：调用 PowerShell parser 前先设置 `$tokens=$null; $errs=$null`，不要把有错误噪声的检查结果当作通过。

## 2026-06-21 - progress.md invalid UTF-8 blocked apply_patch

- 现象：同时追加 `task_plan.md`、`findings.md`、`progress.md` 时，`apply_patch` 因 `progress.md` 含 invalid UTF-8 中止，前两个文件也未落盘。
- 原因：旧进度文件混有非 UTF-8 字节，补丁工具按 UTF-8 读取失败。
- 规则：批量更新项目记忆时先分文件处理；对非 UTF-8 历史文件，使用保留原字节的追加方式，并避免整文件重写。

## 2026-06-21 - parallel blocker fix workers exceeded 30 seconds

- 现象：三个修阻断问题的 worker 超过 30 秒没有完成，继续等待会拖慢主线。
- 原因：任务虽然拆分了，但涉及 PowerShell 行为测试和现有并行脏工作树，worker 启动/定位成本超过预期。
- 规则：30 秒无实质结果时停止等待；关闭 worker，主 agent 直接基于当前文件小步补丁，并把下一轮 worker 改成只读审查或更小的单断言任务。

### 2026-06-21 - Do not call Unix-only helpers through rtk on Windows
- Task: load skill docs after switching to fast/subagent mode.
- Result: `rtk cat ...` failed because `cat` is not a standalone executable in this Windows shell.
- Cause classification: shell alias mismatch.
- Rule change: when reading files on Windows, use `Get-Content -Raw` directly, or run an actual executable through `rtk`; do not assume Unix aliases exist.

### 2026-06-21 - Antigravity empty exit needs narrower retry plus health check
- Task: read-only release-blocker review via Antigravity CLI worker.
- Result: job ag-27ffe4e5-78c5-407b-bff2-ebccb01f3954 failed with exit code 2 and empty stdout/stderr.
- Cause classification: worker launch/runtime failure with no diagnostic payload.
- Rule change: after an empty Antigravity failure, do not repeat the same broad task. Run a CLI health/tail check, then retry with a narrower read-only or single-file task; if it still fails, switch to ordinary subagents and keep moving.

### 2026-06-21 - Patch UI verifier in small anchors after worker edits
- Task: add high-impact Manager confirmation verifier assertions.
- Result: a combined patch failed because the failure-check block had shifted after worker edits.
- Cause classification: stale multi-hunk context.
- Rule change: after subagent edits the same file, re-read the exact nearby lines and patch one small anchor at a time.

### 2026-06-21 - Avoid translated text anchors in UI-state verifier patches
- Task: insert Manager high-impact confirmation failure checks.
- Result: second patch failed because nearby translated failure text did not match exactly.
- Cause classification: brittle localized-string anchor.
- Rule change: for UI verifier assertions, anchor on stable variable names or line numbers after re-reading, not on full localized failure strings.

### 2026-06-21 - Static tests must track security helper refactors
- Task: harden Manager bootstrap/action source validation.
- Result: launcher static test still expected direct `isTrustedManagerOriginValue(req.headers.origin, ...)` calls inside endpoint blocks and failed after moving checks into `validateManagerSourceRequest`.
- Cause classification: stale static contract after helper extraction.
- Rule change: when extracting a security helper, update static tests to assert the helper exists, denies empty source headers, and is called by each protected endpoint.

### 2026-06-21 - Do not nest PowerShell commands with unescaped `$null`
- Task: parse-check a PowerShell script from a PowerShell shell.
- Result: `powershell -Command "$null = ..."` was expanded by the outer shell, leaving a command starting with `=`.
- Cause classification: nested-shell variable expansion.
- Rule change: in PowerShell sessions, run parser snippets directly in the current shell or single-quote the nested command; do not put `$null` inside an outer expandable string.

### 2026-06-21 - Close completed subagents before spawning more
- Task: spawn another read-only review agent for response-history expiry.
- Result: `agent thread limit reached` because completed agents were still open.
- Cause classification: coordination/resource cleanup failure.
- Rule change: after consuming a subagent result, close it before spawning additional agents; if the limit is hit, close completed agents and continue without blocking.

### 2026-06-21 - Treat git diff --check line-ending warnings separately
- Task: run whitespace check after stability batch.
- Result: `git diff --check` exited nonzero with only CRLF/LF conversion warnings for existing touched files, no whitespace-error lines.
- Cause classification: Git line-ending warning, not a patch whitespace defect.
- Rule change: record the warning, then inspect output; only treat actual whitespace-error diagnostics as code failures.

### 2026-06-21 - Do not pass PowerShell builtins directly to rtk
- Task: resume the Anti-Codex stability batch and confirm the current directory.
- Result: `rtk Get-Location` failed because `Get-Location` is a PowerShell builtin, not a PATH executable.
- Cause classification: command-runner mismatch.
- Rule change: use rtk for real executables (`git`, `rg`, `node`, `powershell`) and run simple PowerShell builtins directly in the active shell.

### 2026-06-21 - Tighten DeepSeek allowed files after a scoped worker oversteps
- Task: ask DeepSeek to fix connector projection behavior in a narrow backend/test area.
- Result: the worker also touched `scripts/test-anticodex-ui-state.mjs`, outside the intended scope.
- Cause classification: worker scope overrun.
- Rule change: for DeepSeek scoped patches, pass exact `allowed_dirs` or exact files, include an explicit forbidden list for concurrently edited UI scripts, and review `git diff` before trusting any output.

### 2026-06-21 - Re-read live anchors before patching hot launcher scripts
- Task: guard unsafe plugin unlock injection in `scripts/start-deepcodex.ps1`.
- Result: the first patch failed because the remembered variable order differed from the live file.
- Cause classification: stale anchor context.
- Rule change: before editing heavily changed launcher scripts, re-read the exact 20-60 line anchor and patch one logical block at a time.

### 2026-06-21 - Do not pipe to Unix `head` in PowerShell
- Task: scan project plans/findings for remaining risks.
- Result: `... | head -n 200` failed because `head` is not available in this Windows PowerShell environment.
- Cause classification: shell portability mismatch.
- Rule change: truncate PowerShell pipeline output with `Select-Object -First N`, or use an actual executable through `rtk`.

### 2026-06-21 - Split complex rg regexes under PowerShell
- Task: audit plugin-unlock guard strings across launcher and tests.
- Result: one combined `rg` alternation with escaped quotes/backslashes was mangled by PowerShell quoting and failed with a regex parse error.
- Cause classification: shell quoting / regex construction failure.
- Rule change: for string-contract audits on Windows, prefer multiple simple `rg -n "literal"` calls over one dense alternation.

### 2026-06-21 - Do not pass Unix globs directly to rg on Windows
- Task: search all `translator/tests/*.test.mjs` files for diagnostics coverage.
- Result: `rg ... translator/tests/*.test.mjs` failed with Windows path syntax error instead of expanding the glob.
- Cause classification: shell glob portability mismatch.
- Rule change: search the directory (`translator/tests`) or enumerate exact files; do not rely on Unix glob expansion in PowerShell.

### 2026-06-21 - Avoid patching mojibake fallback-page lines by display text
- Task: add snapshot freshness wording to the fallback Manager page inside `translator/adaptive-server.mjs`.
- Result: patches anchored on mojibake Chinese UI text failed repeatedly.
- Cause classification: brittle encoded-text anchor.
- Rule change: for legacy mojibake page blocks, patch stable ASCII variable names or leave the page for a dedicated encoding cleanup instead of forcing display-text anchors.

### 2026-06-21 - Cancel slow review-only DeepSeek jobs after the 30-second rule
- Task: ask DeepSeek to review the diagnostics source-fingerprint patch without editing files.
- Result: job `dsw_mqmo9mig_np9cd5` spent over 30 seconds streaming thinking with no result and no changed files.
- Cause classification: review worker latency over task value.
- Rule change: for non-blocking review-only jobs, cancel after one 30-second wait if the main line already has focused tests passing; use a smaller single-question review next time.

### 2026-06-21 - Empty Antigravity completion is not useful review output
- Task: ask Antigravity to do a read-only third-party API configuration gap review.
- Result: job `ag-cc9a63a7-fa4c-4ca7-a782-bc109ef6b0e0` completed with exit code 0 but returned empty parsed text and empty logs.
- Cause classification: missing machine-checkable worker output contract.
- Rule change: read-only Antigravity review prompts must require a concrete artifact in the final message, such as a numbered finding list or exact file/line checklist. If the completed job returns empty output, treat it as no result and continue with main-line evidence.

### 2026-06-21 - Do not use Unix here-doc syntax in PowerShell commands
- Task: inspect JavaScript source text with `node - <<'NODE'`.
- Result: PowerShell parsed `<<` as redirection syntax and failed before Node ran.
- Cause classification: shell syntax portability mismatch.
- Rule change: in PowerShell sessions, use `node -e "..."`, a temporary checked-in script when appropriate, or native PowerShell string handling. Do not use Bash here-doc forms.

### 2026-06-21 - Reassign failed MCP workers with narrower contracts
- Task: ask Antigravity and DeepSeek to review the source preflight/install gate.
- Result: Antigravity job `ag-4c4ac141-e8f2-4acd-9f93-2fc0e3272e69` failed with exit code 2 and no output; DeepSeek job `dsw_mqmovg7g_6o99dt` changed files but failed the success contract, so its result could not be trusted as a review.
- Cause classification: worker output contract too broad / dirty-worktree confusion.
- Rule change: after an MCP worker fails, do not just let the main line absorb the task. Reassign a smaller single-file or single-question task with exact output requirements; accept only machine-checkable findings or changed-file lists after `git diff` review.

### 2026-06-21 - Avoid Windows-only .NET APIs in PowerShell 5.1 scripts
- Task: add `test-anticodex-source-preflight.ps1` for install/sync source gates.
- Result: `[IO.Path]::GetRelativePath` is unavailable in the Windows PowerShell 5.1 runtime used by the product scripts.
- Cause classification: runtime compatibility mismatch.
- Rule change: product PowerShell scripts must use Windows PowerShell 5.1-compatible APIs unless a script explicitly requires PowerShell 7+. For relative paths, use a small local helper based on normalized string prefixes.

### 2026-06-21 - Keep PowerShell object expressions simple inside report hashtables
- Task: build JSON report objects for the source preflight gate.
- Result: expressions such as `ok = @(...).Count -eq 0` and generic-list values caused `Argument types do not match` in Windows PowerShell.
- Cause classification: PowerShell 5.1 parser/object-construction edge case.
- Rule change: compute booleans and arrays in local variables before constructing `[pscustomobject]` reports, and convert generic lists with `.ToArray()` before serialization.

### 2026-06-21 - Do not use Unix line-number tools on Windows
- Task: inspect `test-anticodex-websocket-fallback.ps1` with line numbers.
- Result: `rtk nl -ba ...` failed because `nl` is not on PATH.
- Cause classification: shell portability mismatch.
- Rule change: use PowerShell line numbering (`Get-Content | ForEach-Object`) or editor-style file views in this Windows workspace.

### 2026-06-21 - Scoped DeepSeek tasks still need explicit allowed_dirs
- Task: ask DeepSeek to patch one static test file with `worker_profile=scoped_patch`.
- Result: the first job was rejected before start because `allowed_dirs` was missing.
- Cause classification: incomplete scoped-patch parameters.
- Rule change: every `scoped_patch` DeepSeek task must include a narrow `allowed_dirs` list and explicit `forbidden_paths`; do not rely on the natural-language file scope alone.

### 2026-06-21 - Tiny review tasks should not stream for a minute without edits
- Task: ask DeepSeek to add one collector-contract assertion.
- Result: job `dsw_mqmqdjje_am40me` was still streaming after 60 seconds with no changed files.
- Cause classification: review-sized task sent through a slow thinking path.
- Rule change: for single-assertion or single-file review tasks, use a smaller no-thinking/fast contract when available; if no file changes appear after one status check, switch to main-line patching or a concrete one-line patch task rather than waiting repeatedly.

### 2026-06-21 - Antigravity exit-code 2 with empty output is a no-result
- Task: ask Antigravity to patch the diagnostics collector with one report name.
- Result: job `ag-15fbd35e-593e-4e97-ba64-71deac394535` failed with exit code 2 and empty stdout/stderr.
- Cause classification: CLI worker failure without actionable diagnostics.
- Rule change: record the job id, keep the task narrow, and continue with a verified main-line patch; do not spend more retries on the identical Antigravity prompt until the next task changes the file scope or output contract.

### 2026-06-21 - Escape PowerShell variables before a literal colon
- Task: run a quick parser loop and print `"$path: $message"` on failure.
- Result: PowerShell parsed `$path:` as an invalid scoped variable reference before the parser check ran.
- Cause classification: PowerShell string interpolation syntax.
- Rule change: use `"${path}: ..."`, `('{0}: {1}' -f $path, $message)`, or separate arguments when a variable is immediately followed by a literal colon.

### 2026-06-21 - Antigravity repeated exit-code 2 on Manager action audit
- Task: review Manager sourcePreflight consistency across five files.
- Result: job ag-07d0badd-9b6f-4049-8692-b4d89a716aef failed with exit code 2 and empty stdout/stderr.
- Cause classification: CLI worker failure without actionable diagnostics, even with a narrow artifact contract.
- Rule change: do not retry identical Antigravity Manager-audit prompts. Next Antigravity task must be a single-file patch or a command-only check with an explicit changed-file target.

### 2026-06-21 - Use the repository's Node test runner directly
- Task: run focused third-party API regression.
- Result: `npm test` failed because this repository has no root `package.json`.
- Cause classification: test-entry assumption copied from a different project shape.
- Rule change: use `node --test` with the relevant files, or the repository source-preflight script; check for `package.json` before invoking npm scripts.

### 2026-06-21 - PowerShell 5.1 must read UTF-8 profile JSON explicitly
- Task: fail closed when an existing third-party provider profile is unreadable.
- Result: valid no-BOM UTF-8 JSON containing Chinese connection-stage text was decoded with the Windows legacy code page and rejected as corrupt.
- Cause classification: Windows PowerShell 5.1 default text-decoding mismatch.
- Rule change: every PowerShell 5.1 reader for project JSON written as UTF-8 without BOM must use `-Encoding UTF8` or a .NET UTF-8 reader explicitly; never hide the decode failure by silently returning defaults.

### 2026-06-21 - Ordinary subagents can fail on host Codex quota
- Task: parallel read-only audits for Skill/MCP and plugin/app capability gaps.
- Result: both ordinary subagents terminated with the host Codex usage-limit message before returning findings.
- Cause classification: host model quota exhaustion, not repository or worker-task scope.
- Rule change: when ordinary subagents fail for host quota, preserve the task split and reassign bounded slices to Antigravity CLI or DeepSeek workers; do not retry the same host-backed agents until quota recovers.

### 2026-06-21 - Do not call wait without a real exec cell id
- Task: wait for ordinary subagent notifications.
- Result: `functions.wait` was called with a placeholder id and failed immediately.
- Cause classification: wrong waiting primitive; ordinary subagents notify independently and are not exec cells.
- Rule change: use `wait` only for a cell id returned by `functions.exec`; for ordinary subagents, continue useful work and consume their notifications when delivered.

### 2026-06-21 - Antigravity cross-mode verifier patch returned no result
- Task: make the MCP/Skill verifier accept both Antigravity and third-party provider health contracts.
- Result: job `ag-ecee9fc4-96d5-4b8c-91f9-8c0e1dc175f3` failed after about 44 seconds with exit code 2 and no stdout/stderr.
- Cause classification: Antigravity CLI worker failure without actionable output on a two-file task.
- Rule change: reassign as a single-file patch with only parser verification; add static contract coverage separately after the worker result is reviewed.

### 2026-06-21 - PowerShell native wildcards are not portable rg path arguments
- Task: search all `test-anticodex-*.ps1` files for Antigravity-only health assumptions.
- Result: passing the wildcard as a literal path produced Windows error 123 and caused the parallel read batch to fail.
- Cause classification: Windows path wildcard mismatch.
- Rule change: search the directory and use `-g 'test-anticodex-*.ps1'`; do not pass a wildcard path to `rg` on Windows.

### 2026-06-21 - Antigravity single-file plugin verifier patch also returned no result
- Task: make `test-anticodex-plugin-capabilities.ps1` mode-aware without touching other files.
- Result: job `ag-d4bd5f08-fa87-4f5a-b557-6077c0fa1654` failed after about 16 seconds with exit code 2 and no stdout/stderr.
- Cause classification: repeated Antigravity CLI worker launch/runtime failure, now reproduced on a single-file task.
- Rule change: reassign the bounded patch to DeepSeek Flash or an ordinary worker. Do not retry Antigravity implementation jobs again in this development batch until its CLI runtime changes.

### 2026-06-21 - Close completed ordinary agents before spawning replacements
- Task: start two parallel read-only reviews for installed verification and diagnostics.
- Result: the first spawn attempt failed with `agent thread limit reached` because six completed agents were still open.
- Cause classification: agent lifecycle cleanup was omitted.
- Rule change: inspect and close completed ordinary agents before starting a new parallel batch; completed agents still consume the concurrency limit.

### 2026-06-21 - Do not let an expected rg no-match abort a parallel read batch
- Task: read several independent health-contract snippets in parallel.
- Result: one `rg` query returned exit code 1 for no match and rejected the whole orchestration call, hiding successful sibling reads.
- Cause classification: expected search miss was treated as a fatal batch error.
- Rule change: use `Promise.allSettled` for independent searches, or make optional `rg` probes tolerate exit code 1; reserve fail-fast parallel calls for commands that must all succeed.

### 2026-06-21 - Use PowerShell for tail output on this Windows host
- Task: inspect the end of `MCP_WORKER_RULES.md`.
- Result: `rtk tail` failed because the Unix `tail` binary is not installed.
- Cause classification: shell portability mismatch.
- Rule change: use `Get-Content | Select-Object -Last N` through `rtk powershell` for bounded tail reads on Windows.

### 2026-06-21 - Quote nested PowerShell commands as literals
- Task: run a PowerShell parser check through an outer PowerShell shell.
- Result: the outer shell expanded `$tokens`, `$errors`, and pipeline variables before the nested command ran, producing an empty-pipeline parser error.
- Cause classification: nested-shell interpolation.
- Rule change: pass nested `-Command` bodies in a single-quoted script block, or escape every dollar sign; use the already verified parser-check template instead of rebuilding it inline.

### 2026-06-21 - Avoid format strings in nested PowerShell line-range reads
- Task: print a bounded file range with line numbers through `rtk powershell`.
- Result: nested quoting removed the format-string quotes and PowerShell parsed the colon as syntax.
- Cause classification: nested-shell quoting drift.
- Rule change: prefer `rg -n -C` for bounded context; when exact ranges are required, use a saved script block or a quote-free output expression rather than nested `"{0}: {1}" -f ...`.

### 2026-06-21 - Repeated wildcard-path search failure requires a hard template
- Task: search test files for diagnostics contracts.
- Result: a command again passed `translator/tests/*.test.mjs` as a native Windows path and produced error 123, despite the earlier wildcard rule.
- Cause classification: repeated command-template regression.
- Rule change: all repository-wide `rg` searches must use a directory plus `-g '*.test.mjs'`; never include a wildcard in a Windows path argument. Copy the known-good template rather than typing a new variant.

### 2026-06-21 - Do not batch quoted file arrays through nested PowerShell
- Task: parse-check four changed PowerShell files in one nested command.
- Result: the nested shell stripped quoted array elements and failed with `Missing argument in parameter list` before source preflight started.
- Cause classification: nested-shell array quoting drift.
- Rule change: run the verified single-file parser template in parallel for each file, or invoke a checked-in helper script; do not construct quoted file arrays inside nested `-Command` strings.

### 2026-06-21 - Cross-mode regression must derive mode from the supplied health snapshot
- Task: make diagnostics report the active third-party model instead of the Antigravity catalog.
- Result: the first combined regression made an injected Antigravity diagnostics fixture inherit the process-global third-party mode, and one static launcher assertion still required the old single-mode branch.
- Cause classification: testable state was read from a global instead of the function input, plus stale contract coverage.
- Rule change: mode-aware diagnostic helpers must accept the resolved mode explicitly or derive it from the supplied health snapshot; after changing a branch shape, run the full owning test file to update stale positive contracts without weakening behavior assertions.

### 2026-06-21 - Do not patch a legacy non-UTF-8 progress file blindly
- Task: append the cross-mode closeout to `progress.md` together with the worker rules.
- Result: `apply_patch` rejected `progress.md` because the existing file contains an invalid UTF-8 byte sequence; the multi-file patch was not applied.
- Cause classification: legacy file encoding mismatch.
- Rule change: keep the valid rules file patch separate from legacy-encoded project notes. Do not rewrite or transcode the whole progress file without an explicit encoding audit; place new UTF-8-safe notes in a separate project memory file when needed.

### 2026-06-21 - Do not assign a worker the same write set as the main line
- Task: make the third-party UI verifier mode-aware while the main agent was already patching the same verifier files.
- Result: DeepSeek Flash produced policy-compliant edits in the same three files the main line had already changed; the job was cancelled after tests passed to prevent overwrite churn.
- Cause classification: overlapping write ownership, not model capability.
- Rule change: when the main line is actively implementing, delegate only disjoint files or read-only review. If a worker must patch the same files, wait for its result before touching them locally, then review and integrate once.

### 2026-06-21 - Avoid nested PowerShell format strings even in quick grep output
- Task: print `Select-String` results with `'{0}:{1}' -f $_.LineNumber,$_.Line` through an outer shell.
- Result: the outer command stripped `$_.` references and PowerShell failed before producing useful output.
- Cause classification: repeated nested-shell quoting drift.
- Rule change: use quote-free concatenation like `([string]$_.LineNumber) + ':' + $_.Line`, or prefer `rg -n` for line-numbered search output.

### 2026-06-21 - Do not regex-search literal JavaScript selectors through PowerShell
- Task: find the manager route text assignment with a pattern containing `$()` and quotes.
- Result: `rg` treated the pattern as an invalid regex or the outer PowerShell layer consumed pieces of the literal selector.
- Cause classification: regex plus shell quoting drift.
- Rule change: for JavaScript selector literals such as `$("route")`, use a tiny read-only Node scanner that prints `JSON.stringify(line)`, then patch the exact source line. Do not spend retries on increasingly escaped `rg` patterns.

### 2026-06-21 - Read-only DeepSeek review must use a clean/disjoint snapshot
- Task: ask DeepSeek to do a read-only review of third-party route UI and refresh behavior while the main line was editing the same Manager files.
- Result: job `dsw_mqmw8by5_ordeht` was reported as failed because it attributed current main-line file changes to the worker and violated the forbidden-path policy; no independent review finding was produced.
- Cause classification: overlapping dirty worktree plus impossible read-only/write policy contract.
- Rule change: do not run a read-only worker against files the main line is actively editing. Either wait for a green checkpoint, provide a clean fork/snapshot, or assign a disjoint single-file review artifact.

### 2026-06-21 - Antigravity health output is too noisy for this long thread
- Task: check Antigravity CLI worker readiness before delegating more implementation.
- Result: `antigravity_health` returned output larger than the remaining context and was truncated, so it produced no usable readiness signal.
- Cause classification: health probe output volume exceeded the thread budget.
- Rule change: in long Anti-Codex batches, do not spend context on raw Antigravity health output. Prefer a tiny, bounded Antigravity implementation/review task after a clean checkpoint, or skip the worker until a compact health probe is available.

### 2026-06-21 - Do not rebuild line-range PowerShell snippets by hand
- Task: print bounded source line ranges from nested PowerShell.
- Result: repeated attempts lost `$` variables or string quotes before PowerShell execution and failed with parser errors.
- Cause classification: repeated nested-shell quoting drift.
- Rule change: use `rg -n -C`, checked-in helper scripts, or a previously verified single-quoted template. If two attempts fail, stop trying shell line printers and patch against stable code context.

### 2026-06-21 - Keep broad `rg` probes out of long-thread debugging
- Task: search tool-routing and worker notes while debugging the Anti-Codex chat loop.
- Result: one broad multi-file `rg -C` probe produced thousands of lines and was truncated, hiding the relevant routing evidence.
- Cause classification: noisy search scope in a context-constrained thread.
- Rule change: for core-chain debugging, search one subsystem at a time and cap context tightly; if a probe exceeds useful output, immediately retry with exact function names or bounded `Get-Content` ranges and record the failed shape.

### 2026-06-21 - Tool-evidence bugs need a regression before prompt tweaks
- Task: diagnose why Anti-Codex showed "no actual tool call" after a real tool-heavy chat.
- Result: the root issue was not account/proxy/model reachability; the final formatter ignored translator-owned internal tool evidence and replaced a legitimate completion with a guard message.
- Cause classification: missing evidence propagation across the internal-tool-loop boundary.
- Rule change: before tuning prompts for fake-tool behavior, add a behavior test that proves the formatter distinguishes "no tool evidence" from "current-turn internal tool evidence".

### 2026-06-21 - Source preflight writes outside the workspace
- Task: run the source preflight after translator changes.
- Result: sandboxed execution passed the code checks far enough to reach report writing, then failed with access denied under `%APPDATA%\anticodex\reports`.
- Cause classification: verifier writes runtime evidence outside the editable workspace.
- Rule change: when source preflight must write its normal report files, run it through the already-approved elevated PowerShell path instead of treating the first access-denied result as a product failure.

### 2026-06-21 - Do not print full dirty diffs for heavily changed core files
- Task: inspect the focused diff for `translator/adaptive-server.mjs` in a dirty long-running branch.
- Result: `git diff` emitted thousands of unrelated historical lines because the file already had a large uncommitted delta from earlier work.
- Cause classification: diff scope was file-focused but not hunk-focused.
- Rule change: for large dirty core files, inspect with `git diff --stat`, `git diff -U2 -- <file>` plus exact `rg` anchors, or review just the current hunk by function name. Do not dump the whole file diff in a long thread.

### 2026-06-21 - Pass multiple `rg` alternatives as repeated `-e`
- Task: verify several Anti-Codex chat-loop anchors in one `rg` call.
- Result: a pipe-containing alternation pattern was split badly on Windows and `rg` treated fragments such as `internal` and `tool` as file paths.
- Cause classification: shell argument parsing around regex alternation.
- Rule change: when using `rtk proxy rg` on Windows, pass each alternative as its own `-e` argument or search exact anchors in separate commands. Do not rely on one quoted regex with `|` across this shell layer.

### 2026-06-21 - Translator deployment is directory-scoped, not file-scoped
- Task: hot-deploy the Anti-Codex chat-loop fix to the installed runtime.
- Result: copying only `adaptive-server.mjs` made the installed translator fail at startup because the updated file imported sibling modules such as `upstream-provider.mjs` that were not present in the older runtime.
- Cause classification: partial deployment missed module dependency closure.
- Rule change: deploy `translator` as a whole directory, then verify key imported files exist and run `/health` before touching UI-level tests. Never hot-copy only `adaptive-server.mjs` unless an import-diff check proves no new sibling dependencies.

### 2026-06-21 - ExecutionPolicy blocks direct PowerShell verifier calls
- Task: run `test-anticodex-web-tools.ps1` directly from the current shell.
- Result: Windows refused to load the script until it was invoked through `powershell -NoProfile -ExecutionPolicy Bypass -File`.
- Cause classification: host execution policy, not product failure.
- Rule change: run checked-in PowerShell verifiers with the Bypass template. Do not spend retries on direct `& script.ps1` when the first error is `PSSecurityException`.

### 2026-06-21 - DeepSeek forbidden_paths must stay inside the project
- Task: delegate a worker while trying to protect runtime files outside the working tree.
- Result: putting paths such as `C:\Users\XD\AppData` into DeepSeek `forbidden_paths` violated the worker path contract.
- Cause classification: invalid worker policy scope.
- Rule change: DeepSeek `forbidden_paths` only accepts project-internal paths. For cwd-external runtime folders, state the ban in the task text and verify with the main agent instead.

### 2026-06-21 - Installed runtime can lag behind source
- Task: validate UI/script behavior after source changes.
- Result: source looked correct, but installed UI/scripts could still be old.
- Cause classification: partial runtime sync before verification.
- Rule change: before installed-version validation, sync the full runtime set: `scripts`, `translator`, and injection scripts. Do not trust source-only inspection.

### 2026-06-21 - Quick overall checks must skip long management buttons
- Task: run a fast overall validation against the installed app.
- Result: clicking long-running management buttons turned a quick check into a slow or hanging workflow.
- Cause classification: verifier scope too broad for a quick smoke test.
- Rule change: quick overall checks should skip button clicks for long management actions and keep independent capability checks as separate probes.

### 2026-06-21 - Read large JSON reports with compact tooling
- Task: inspect a large JSON report from PowerShell.
- Result: `ConvertFrom-Json` failure risked dumping the full report and wasting context.
- Cause classification: noisy failure path for large structured output.
- Rule change: for large JSON reports, use Node or another compact field reader. Print only selected fields and never fall back to full raw JSON output.

## 2026-06-21 - 嵌套 PowerShell/rtk 时 $env/$var 被外层提前展开

- 现象：通过 rtk/外层 PowerShell 调用 `powershell -Command "..."` 时，内部的 `$env:USERPROFILE`、`$var` 等变量被外层 shell 展开，导致嵌套命令在运行前就已损坏。
- 失败次数：同一类问题先后出现多次，超过两次。
- 规则：Windows 嵌套 PowerShell 命令中若包含 `$env:*`、`$null`、`$tokens` 等变量，超过两次失败就不再递归修复引号；改为直接用当前 PowerShell 执行，或使用 `-EncodedCommand` 绕过外层展开。使用 `-EncodedCommand` 时用 `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))` 编码命令字符串。

## 2026-06-21 - UI 快检不应先触发高影响 syncHost

- 现象：在 UI 快速冒烟检查中先点击了 syncHost 等需要长时间同步的高影响管理按钮，导致快检变慢甚至卡死，配置面板的验证被延迟或失败。
- 规则：UI 快检必须先测配置面板（轻量、只读），确认面板正常后再跳过或单独测高影响管理动作。不要用同一个测试序列同时触发现实同步和 UI 存活性验证。

## 2026-06-21 - 修改注入逻辑必须 bump manager panel version

- 现象：修改了 manager panel 注入逻辑（如 anticodex-manager-inject.js）后，旧页面上已有 `window.__ANTICODEX_MANAGER_VERSION` 且低于新版本，页面不重新执行注入，导致新功能在已打开的页面上不可见。
- 规则：每次修改注入脚本内容后，必须同步递增 manager panel version 常量（如 `v71` → `v72`），并在注入入口检查旧版本时主动触发重新注入或引导刷新。审查时确认旧版 timer/observer 已被 dispose。

## 2026-06-21 - MCP config 解析需忽略 nested .tools. 子表

- 现象：在解析 MCP 配置文件（如 `claude_desktop_config.json`）时，某些工具配置内部可能嵌套 `.tools.` 子表（例如 `{"mcpServers": {"my-server": {"tools": [...]}}}`）。遍历时若未排除这些子 key，会误将内部 tools 列表当作独立 server 配置解析，导致配置结构错误。
- 规则：MCP config 解析器必须跳过 `tools`、`_tools` 等已知的嵌套子表 key，只处理顶层 `mcpServers` 或其标准别名。在遍历 server 条目时加白名单或排除列表，避免将子表当作 server 配置处理。

## 2026-06-21 - UI 快检不能执行或模拟高影响按钮的动态二次点击

- 现象：在 UI 快速冒烟检查中，快检脚本模拟点击了「同步」「刷新」「重置」等需要长时间后台操作的高影响按钮，且这些按钮会触发二次确认弹窗（二次点击）。快检原本只应验证布局和可见状态，结果因等待同步或弹窗失败而卡住。
- 规则：UI 快检只做布局/静态契约/可见状态验证，不能执行或模拟高影响按钮的动态二次点击。动态点击应当放在完整回归测试或单独的低风险 probe 中。

## 2026-06-21 - 嵌入 Runtime.evaluate 的模板字符串里要双重转义 \\n

- 现象：在 CDP 注入脚本中使用 `Runtime.evaluate` 执行包含模板字符串的 JavaScript 时，模板字符串内的 `\n` 在 JSON 序列化过程中被解释为换行符，导致生成的 JS 代码出现非法换行（如 `.map(item => \n  item.name)` 变成了跨行语法错误）。
- 规则：嵌入 `Runtime.evaluate` 的模板字符串或含特殊字符的 JS 片段，必须对 `\n`、`\t`、`\r` 等字符做双重转义（如 `\\\\n`），确保 JSON 序列化后 JS 引擎接收到的仍是合法字面量。传递前可用 `JSON.stringify()` 验证最终 JS 字符串的合法性。

## 2026-06-21 - UI 注入版本号未 bump 时已打开页面跳过重新注入

- 现象：修改了 `scripts/anticodex-manager-inject.js` 的行为（如新增功能、调整选择器、变更消息协议）但未同步递增 `native-panel-vXX` 版本号时，已打开页面的 `window.__ANTICODEX_MANAGER_VERSION` 检查发现版本号相同，跳过重新注入。测试和用户界面继续跑旧逻辑，新改动在已打开的页面上完全不可见。
- 失败次数：已出现多次（参见「修改注入逻辑必须 bump manager panel version」条目），但因缺少具体 check 机制，仍然反复遗漏。
- 规则：每次修改 `scripts/anticodex-manager-inject.js` 的行为（不限于界面布局，包括消息处理、协议字段、选择器、DOM 操作等任何可能影响运行时的改动）都必须同步递增 `native-panel-vXX` 版本号常量，并同步更新测试中的版本号期望。审查时确认：旧版 timer/observer/promise 已被 dispose；测试断言中的版本号已同步。如版本号未变但注入逻辑已改，视为阻断缺陷，不得合并。
## 2026-06-21 - Real Antigravity traffic must be session-locked

- Symptom: individual real-traffic verifiers passed, but running several of them concurrently closed local gateway connections and made Anti-Codex look like it was reconnecting.
- Cause: the old queue serialized single model turns, not the whole Codex-style tool session. A native tool call could return a continuation, release the queue slot, and let another Antigravity cascade start before the tool result came back.
- Rule: any real Antigravity verification must either use the shared real-traffic mutex or run through the server-side Antigravity session lock. Fast/no-traffic checks must not call `/v1/responses` unless an explicit real-traffic flag is present.

## 2026-06-21 - Worker/MCP failures should be narrowed and retried

- Symptom: delegated DeepSeek/Antigravity work repeatedly failed or produced unusable output when the task mixed broad inspection, editing, and validation.
- Cause: task scope was too broad and sometimes included fragile runtime/state assumptions.
- Rule: after a worker/MCP failure, do not silently take over and repeat the same pattern. Re-issue a smaller task with read-only or disjoint write scope, explicit forbidden files, and one observable output. Only the main agent integrates and validates.

## 2026-06-21 - Avoid nested PowerShell command quoting for dollar variables

- Symptom: parser checks using nested `powershell -Command "..."` lost `$tokens`, `$errors`, or `$lock` before the inner command ran.
- Cause: the outer PowerShell expanded variables inside the nested command string.
- Rule: when checking PowerShell files from an existing PowerShell shell, run the parser directly in the current shell or use encoded commands. Do not keep retrying nested quote fixes after the first dollar-variable expansion failure.

## 2026-06-21 - Codex subagent quota exhaustion requires a different worker pool

- Symptom: two fresh read-only subagents failed immediately with the same usage-limit message before doing any project work.
- Cause classification: external Codex subagent quota exhaustion, not task scope, permissions, or repository state.
- Rule change: do not repeatedly respawn Codex subagents after this exact quota failure. Move the same narrow task to the independent Antigravity CLI worker (after its health check), require one concrete file output, and keep the main agent on a disjoint file set.

## 2026-06-21 - Patch broad test files by stable local anchors

- Symptom: several combined patches failed because they assumed stale or incorrectly escaped context in a large, frequently edited test file.
- Cause classification: unstable contextual anchors plus lost backslash escaping.
- Rule change: first locate the exact nearby assertion, then use small raw-string patches anchored on stable lines. Do not bundle uncertain test-name context with unrelated replacements.

## 2026-06-21 - Static manager tests must follow helper extraction

- Symptom: the focused manager test failed while runtime behavior was intact because it expected direct snapshot property access after that access had moved into snapshotResponse(path).
- Cause classification: stale implementation-shape assertion after a behavior-preserving helper extraction.
- Rule change: keep the safety contract assertion (GET-only fallback after live attempts), but assert the current helper boundary instead of requiring an obsolete inline expression.

## 2026-06-21 - Do not rewrite mixed-encoding progress files

- Symptom: apply_patch refused to update progress.md because the existing file contains a non-UTF-8 byte far into the file.
- Cause classification: pre-existing mixed encoding in a long-running project log.
- Rule change: do not rewrite or re-encode the whole progress file during an unrelated feature pass. Keep the verified state in the active plan and a UTF-8 project record, then repair the legacy log in a dedicated encoding-cleanup task.

## 2026-06-21 - Diagnostics timeout must not degrade into null success

- Symptom: a combined final check printed a healthy result while the separate diagnostics request had timed out after five seconds, leaving null queue fields.
- Cause classification: PowerShell request error was non-terminating inside a combined evidence command.
- Rule change: use ErrorAction Stop or curl max-time for diagnostics, retry it separately once, and require concrete busy/session/queue fields before reporting stability. Never treat null diagnostics fields as a pass.

## 2026-06-21 - Empty search results must not abort a parallel audit

- Symptom: the first continuation audit returned exit code 1 after `rg` found no matching pending markers, which discarded otherwise useful parallel read results.
- Cause classification: expected empty search was treated as a command failure.
- Rule change: audit searches where zero matches are valid must normalize that case to success or run separately from required health/state reads.

## 2026-06-21 - Manager action verifier must track source and browser request contracts

- Symptom: the installed Manager verifier reported a stale high-impact inventory and rejected the valid JSONP bridge request with 403.
- Cause classification: the verifier omitted the new session-lock reset action and did not send the same-origin Origin/Referer evidence that a real in-app script request carries.
- Rule change: Manager action inventory changes must update the PowerShell verifier in the same batch. Valid JSONP probes must include trusted browser source headers; unauthenticated and hostile-source probes stay headerless or explicitly hostile.

## 2026-06-21 - Antigravity job state can disappear mid-task

- Symptom: Antigravity job `ag-ac254b61-f8ab-475c-bc7c-5a3f48290d57` was reported as running, then later `get_job` returned `Unknown job_id`; the target script had no requested changes.
- Cause classification: external worker job-state loss, not a repository patch failure.
- Rule change: when Antigravity loses a job id with no file changes, record it and reissue a materially smaller task with a simpler success contract. Do not wait indefinitely for the lost job and do not treat it as completed.

## 2026-06-21 - Installed overall subchecks must keep short foreground timeouts

- Symptom: launcher contract rejected an installed-overall call that passed `"-TimeoutSec", "90"` to a real mini-tool subcheck.
- Cause classification: a new real-traffic verifier reused a generous standalone timeout inside an aggregate smoke path.
- Rule change: aggregate installed-overall subchecks must keep short foreground budgets (about 30 seconds) and rely on separate explicit long probes for soak-style validation.

## 2026-06-21 - UI verifier contracts should assert probe fields, not duplicate Manager copy

- Symptom: full source preflight failed because the UI-state verifier test expected hardcoded third-party API Chinese copy inside the verifier script.
- Cause classification: stale implementation-shape assertion; current verifier proves the panel through probe fields while the actual Chinese copy is covered by Manager injection tests.
- Rule change: UI-state verifier tests should assert probe fields and failure messages. Product copy should be asserted against the Manager source that owns the copy, not duplicated in the verifier contract.

## 2026-06-21 - Runtime sync without restart can leave diagnostics on the old gateway

- Symptom: `sync-anticodex-runtime.ps1 -NoRestart` copied files and `/health` was OK, but `/anticodex/diagnostics` did not expose `antigravitySessionLock`, causing the sync result to fail.
- Cause classification: source/runtime files were updated while the live gateway process still served an older or inconsistent code path.
- Rule change: after syncing scripts or translator contracts that diagnostics depend on, prefer a translator restart. Use `-NoRestart` only for static asset copies that do not affect live gateway evidence.

## 2026-06-21 - Never send truncated polling scripts

- Symptom: a background installed-overall poll command was submitted with an unterminated JavaScript string, causing a local tool syntax error while the background verifier kept running.
- Cause classification: host-agent command composition mistake under a long-running poll loop.
- Rule change: keep polling commands short and complete. Prefer a reusable compact status reader instead of hand-typing long inline command strings during repeated polls.

## 2026-06-21 - Cancel workers that edit forbidden active files

- Symptom: DeepSeek job `dsw_mqnu84ls_5qstb1` was assigned only the model-thinking verifier, but it touched Manager button and installed-overall scripts that were explicitly forbidden and already under main-agent edit.
- Cause classification: worker scope breach plus overlapping active-file ownership.
- Rule change: if a worker reports forbidden file changes, cancel it immediately and inspect the touched files before continuing. For follow-up worker tasks, use disjoint files or read-only review, and never overlap a worker with files the main agent is actively patching.

## 2026-06-21 - Runtime sync timeout needs file evidence before retry

- Symptom: `sync-anticodex-runtime.ps1` exceeded the foreground timeout, but no sync process remained and `/health` was already OK.
- Cause classification: sync completed or reached health while the foreground command outlived the host timeout.
- Rule change: after a runtime sync timeout, do not blindly rerun it. First check for leftover sync processes, `/health`, and exact installed-file markers for the intended patch. Retry only when markers are missing or health is bad.

## 2026-06-21 - Host sync acceptance must be a lightweight gate

- Symptom: host sync successfully built, activated, and started the new Anti-Codex host, but the post-sync acceptance step launched the aggregate installed-overall regression and timed out after 35 seconds, causing an unnecessary automatic rollback.
- Cause classification: acceptance gate was too broad for an upgrade transaction; long UI/aggregate checks belong after activation, not inside the rollback decision.
- Rule change: post-sync acceptance must only verify the activated host marker, local gateway health, Antigravity upstream mode, and model catalog availability. Diagnostics, session-lock, and native tool bridge checks are post-activation regressions; they must not trigger rollback when the gateway is otherwise alive.

## 2026-06-21 - Fresh host diagnostics can lag behind health

- Symptom: after the acceptance gate was reduced, the newly activated host still rolled back because `/anticodex/diagnostics` timed out during the short startup window, even though the same diagnostics were healthy after the rollback restart.
- Cause classification: diagnostics endpoint can be slower than `/health` on a freshly replaced Electron host and is not a reliable rollback criterion.
- Rule change: rollback gates must use only startup-critical, fast endpoints. Move diagnostics and tool-bridge proof to the post-sync installed regression report.

## 2026-06-21 - Antigravity worker can fail before producing a patch

- Symptom: Antigravity worker `ag-75667109-73dd-4213-bf06-44fb7088682d` was assigned a narrow plugin-capability cache sample fix and exited with code 4294967295 without usable changes.
- Cause classification: external worker execution failure, not a task design or repository conflict.
- Rule change: when an Antigravity worker fails before a patch, immediately keep the task narrow and finish in the main line or reissue only after confirming no overlapping edits. Do not wait or broaden the task.

## 2026-06-21 - Runtime sync must wait for session-lock diagnostics

- Symptom: `sync-anticodex-runtime.ps1` copied files, restarted the translator, and `/health` was OK, but exited failed because the first `/anticodex/diagnostics` read did not yet include `antigravitySessionLock`.
- Cause classification: startup timing false negative; diagnostics can lag behind health for a few seconds after translator restart.
- Rule change: runtime sync must poll diagnostics for the session-lock field until the sync timeout before returning failure. Do not treat one early missing diagnostics field as proof that the installed runtime is bad.

## 2026-06-22 - DeepSeek forbidden paths cannot escape the project

- Symptom: DeepSeek rejected job setup before launch because `forbidden_paths` contained installed runtime paths outside the worker `cwd`.
- Cause classification: invalid worker policy parameters.
- Rule change: keep `allowed_dirs` and `forbidden_paths` inside the worker project. State external runtime bans in the task text and verify them from the main agent.

## 2026-06-22 - Tiny RED-test tasks must disable worker thinking

- Symptom: a one-file RED-test task streamed thinking for more than two minutes without editing any file.
- Cause classification: tiny mechanical work was sent through an unnecessarily expensive thinking path.
- Rule change: for a single assertion or similarly mechanical patch, use `thinking=disabled`, one exact file, one exact expected failure, and a short execution budget. If there is still no edit after the status check, cancel and reissue the smaller task.

## 2026-06-22 - Keep spaces between PowerShell commands and variables

- Symptom: compact polling commands failed because tokens such as `Join-Path$dir`, `-Id$s.pid`, and `Test-Path$s.out` were parsed as command or parameter names.
- Cause classification: over-compressed PowerShell syntax.
- Rule change: never remove the separating space between a cmdlet/parameter and a variable. Prefer readable polling commands over token-saving one-liners.
- Recurrence: the same mistake happened again in a later hash-verification command after this rule was written.
- Enforcement: multi-step PowerShell verification commands must use spaced assignments and named intermediate path variables; do not compress `Join-Path`, `Test-Path`, or `Get-FileHash` expressions inline.

## 2026-06-22 - Windows PowerShell scripts with literal Chinese need an encoding marker

- Symptom: two previously ASCII PowerShell scripts gained literal Chinese prompts, then Windows PowerShell 5.1 reported unrelated quote and hash-literal parse errors.
- Cause classification: UTF-8 without BOM was decoded as the legacy system code page.
- Rule change: when a Windows PowerShell 5.1 script contains literal non-ASCII text, save it as UTF-8 with BOM or keep the source ASCII-only and construct Unicode at runtime. Always run the Windows PowerShell parser after adding localized text.

## 2026-06-22 - Initialize PowerShell parser ref variables

- Symptom: a compact parser check printed per-file OK lines, then emitted `[ref] cannot be applied to a variable that does not exist` because `$errors` was referenced before initialization.
- Cause classification: invalid PowerShell parser harness, not a source parse failure.
- Rule change: before calling `[System.Management.Automation.Language.Parser]::ParseFile`, initialize both `$tokens = $null` and `$parseErrors = $null`, and pass `[ref]$tokens`, `[ref]$parseErrors`. Do not reuse `$errors` because it is easy to confuse with PowerShell's built-in error collection.

## 2026-06-22 - Parallel worker attribution can include another worker's untracked files

- Symptom: a DeepSeek one-file test task reported `docs/audits/2026-06-22-mcp-plugin-real-use-gap.md` in its changed file list while an Antigravity audit worker was concurrently assigned that exact docs output.
- Cause classification: shared-worktree attribution ambiguity with untracked files during parallel workers.
- Rule change: when workers run concurrently in the same checkout, treat `changed_files_so_far` as workspace state, not proof of authorship. Confirm intended output by task scope and file content before blaming or reverting; for strict ownership, avoid concurrent workers that may create untracked files under the same broad directory.

## 2026-06-22 - RTK proxy cannot wrap PowerShell cmdlets directly

- Symptom: `rtk proxy Get-Content ...` failed with `program not found` because `Get-Content` is a PowerShell cmdlet, not a PATH executable.
- Cause classification: command-wrapper mismatch, not a repository or script failure.
- Rule change: use `rtk` for native executables and noisy shell output. When a PowerShell built-in cmdlet is the simplest command and `rtk` cannot resolve it, switch immediately to direct PowerShell instead of retrying the wrapper.

## 2026-06-22 - Static tests should assert behavior, not one spelling

- Symptom: after replacing direct `Invoke-RestMethod -Proxy $null` calls with a retry helper using a splatted `Proxy = $null` argument, the launcher contract test failed even though the no-proxy behavior was preserved.
- Cause classification: brittle static assertion.
- Rule change: static tests may check required safety properties, but should allow equivalent syntax when behavior is the same. For PowerShell no-proxy checks, prefer `Proxy\s*=?\s*\$null`-style assertions over one exact call spelling.

## 2026-06-22 - Treat empty successful worker exits as failed deliverables

- Symptom: Antigravity job `ag-80bde7d1-1a58-4d74-94e4-11dddeaa09d9` exited with code 0 but returned no parsed text, no stdout, and no obvious changed file for its Manager UI audit task.
- Cause classification: task accepted by worker but no observable deliverable produced.
- Rule change: every worker task must name one concrete deliverable: a file path, a test assertion, or a patch. If a worker exits successfully with no deliverable, treat it as a failed dispatch and reissue a smaller task with an explicit required output path.

## 2026-06-22 - Long local feature refresh needs post-check evidence

- Symptom: installed `refresh-anticodex-local-features.ps1` exceeded the foreground 30 second command window, but the refresh process finished shortly after and the connector cache timestamp had already advanced.
- Cause classification: long local snapshot copy, not a failed gateway or broken plugin projection.
- Rule change: do not rerun a timed-out local feature refresh blindly. First check for remaining refresh processes, cache timestamps, and the plugin capability verifier. Future Manager refresh actions should run as background jobs with queryable status instead of blocking the UI.

## 2026-06-22 - External runtime bans belong in worker task text

- Symptom: DeepSeek job `dsw_mqo2iekj_sva61t` was rejected because `forbidden_paths` included `C:\Users\XD\AppData\Local\Anti-Codex`, which is outside the project `cwd`.
- Cause classification: invalid worker parameter schema; the intended safety rule was correct, but it was expressed in the wrong field.
- Rule change: keep worker path filters strictly inside `cwd`. For installed runtime, desktop app, account, network, and other external-state bans, write them in the task instructions and verify from the main agent after the worker returns.

## 2026-06-22 - Static source assertions must allow equivalent JS shapes

- Symptom: the third-party API model-evidence test still failed after implementation because the regex required `models:` to appear before `Array.isArray(stage?.models)`, while the code used a conditional object spread.
- Cause classification: brittle static assertion over code spelling, not missing behavior.
- Rule change: for JavaScript source contract tests, assert the presence of the safety decision and the resulting field, not their exact order in one expression. Use multi-line regexes that allow conditional spreads and helper extraction.

## 2026-06-22 - Audit workers can produce stale conclusions

- Symptom: a third-party API audit report claimed the Manager lacked a test-connection button and that save did not run `testUpstreamConnection`, but current `adaptive-server.mjs` already had `/anticodex/upstream-test` and save-before-test protection.
- Cause classification: worker reviewed an incomplete slice or stale mental model instead of reconciling all relevant current files.
- Rule change: worker audit files are advisory only. Before accepting them, the main agent must compare claims against current source and tests, then rewrite inaccurate reports instead of preserving misleading documentation.

## 2026-06-22 - Antigravity empty-output recurrence

- Symptom: Antigravity job `ag-656e24af-b60f-41af-b0a3-25e5dd94c800` exited successfully with no parsed text/stdout/stderr for a required audit task.
- Cause classification: same empty-deliverable failure mode as earlier; success exit code did not prove useful work.
- Rule change: for Antigravity report tasks, require a concrete output file and verify that file immediately. If parsed output is empty, do not count the job as successful even when a similarly named file exists from another worker or the main line.

## 2026-06-22 - Local verifier endpoints need retry, not instant blame

- Symptom: plugin capability, diagnostics, model routing, and tool-bridge checks sometimes failed on one local timeout or "connection closed" response while the installed Anti-Codex gateway was otherwise healthy.
- Cause classification: transient local endpoint race during Manager/UI/gateway refresh, not proof that the Antigravity chain was broken.
- Rule change: local HTTP verifiers must use a small retry window before failing. Overall checks must pass the longer diagnostics timeout down to diagnostics/tool-bridge subchecks instead of defining it and forgetting to use it.

## 2026-06-22 - Model names must come from the live model list first

- Symptom: model-routing verification could report empty display names when diagnostics was slow, even though `/models` already returned the exact eight Antigravity model names.
- Cause classification: verifier used a supplemental diagnostics map as if it were the primary source.
- Rule change: display-name assertions must treat `/models` as the source of truth and use diagnostics only as extra evidence. Never let a slow diagnostics call erase known model names.

## 2026-06-22 - Manager UI checks must handle instant success

- Symptom: Manager button checks failed when a UI-only action completed before the test observed the disabled/busy state.
- Cause classification: verifier assumed every valid action must expose an intermediate busy frame.
- Rule change: if the visible result already shows a completed success state, count that as action-started and successful. Busy/disabled observation is useful evidence, not a required frame for instant actions.

## 2026-06-22 - CDP Manager probes can stale the window

- Symptom: repeated long `Runtime.evaluate` Manager probes left the installed UI stale enough that UI-state checks failed until Anti-Codex was cold-relaunched.
- Cause classification: test harness side effect against the live desktop window, not necessarily a product failure.
- Rule change: avoid direct long-running page functions inside one browser evaluation unless the timeout/race is established first. After repeated UI probe timeouts, cold-relaunch before judging the product state.

## 2026-06-22 - Shared worktree worker scopes must avoid main-agent edits

- Symptom: DeepSeek job `dsw_mqo2x1p9_lz8865` failed policy because forbidden files overlapped with active main-agent edits in the same worktree; Antigravity job `ag-c8a4e91b-655f-4b6e-8495-c1620c4d6611` exited with no usable output.
- Cause classification: worker dispatch was still too broad for a dirty shared worktree, and empty Antigravity output recurred.
- Rule change: in a dirty shared checkout, give workers smaller read-only audit tasks or one-file patch tasks with explicit output paths. If a worker returns no parseable text and no verified file, immediately reissue a smaller task instead of treating it as progress.

## 2026-06-22 - Stream cancellation verifiers must not wait for natural EOF

- Symptom: `test-anticodex-stability-soak.ps1` kept running after the Antigravity queue and session lock were already idle because the PowerShell stream reader was still waiting for the remote response body to close.
- Cause classification: verifier hang in the SSE cancellation reader, not a product gateway deadlock.
- Rule change: after the local cancel endpoint accepts cancellation, record a cancellation event and break out of the stream read loop. When a long-running verifier exceeds its expected duration, check queue/session diagnostics before blaming the product chain.

## 2026-06-22 - Avoid piping directly after inline if/else objects in PowerShell

- Symptom: compact status and stop-process commands failed with `An empty pipe element is not allowed` when an inline `if { object } else { object } | ConvertTo-Json` expression was parsed incorrectly.
- Cause classification: over-compressed PowerShell syntax.
- Rule change: assign the object to `$result` inside the if/else block, then pipe `$result` on the next line. This is mandatory for status/cleanup commands used during long-running verifier control.

## 2026-06-22 - Killed UI verifiers must not leave a blocking lock

- Symptom: the installed UI state verifier exceeded the foreground timeout, then the next run waited on `anticodex-manager-button.lock` instead of testing the desktop window.
- Cause classification: verifier process was killed by the outer harness before its `finally` cleanup released the lock.
- Rule change: verifier locks that store a PID must remove themselves immediately when that PID is no longer alive. Do not wait for a long stale-age timeout after an outer timeout kills the owner.

## 2026-06-22 - Quote PowerShell variables when nesting `-Command`

- Symptom: a health probe written as `powershell -Command "$h=Invoke-RestMethod ..."` became `=Invoke-RestMethod` because the outer PowerShell expanded `$h` before the child process saw it.
- Cause classification: nested PowerShell quoting mistake, not a gateway failure.
- Rule change: when invoking a child PowerShell with variables in `-Command`, wrap the command body in single quotes or escape `$`. Prefer script files for multi-step probes.

## 2026-06-22 - Startup diagnostics need the same timeout budget as readiness

- Symptom: `sync-anticodex-runtime.ps1 -TimeoutSec 60` restarted the translator and health returned ready with 8 models, but the script failed because `/anticodex/diagnostics` was called with a fixed 5-second timeout and did not return the `antigravitySessionLock` snapshot before the request timed out.
- Cause classification: verifier timeout too short during startup, not a missing session-lock implementation or broken Antigravity chain.
- Rule change: diagnostics readiness probes must derive their per-request timeout from the overall readiness window. If health is ready but diagnostics is slow, widen the diagnostics request timeout and re-check before declaring sync failure.

## 2026-06-22 - PowerShell index ranges need expression form

- Symptom: `Select-Object -Index 990..1110` failed immediately with a parameter conversion error while reading a file snippet.
- Cause classification: PowerShell parsed the range as a string argument in this context.
- Rule change: for snippets, assign file content to `$lines` first and then use `$lines[990..1110]`, or wrap ranges as expressions when passing them to cmdlets. Do not retry the same malformed command.

## 2026-06-22 - Complex search patterns need fixed-string mode

- Symptom: an `rg` pattern combining escaped parentheses and quoted strings failed with an "unopened group" parse error.
- Cause classification: unnecessary regex complexity for a simple source-location query.
- Rule change: when searching for known identifiers such as action names or function names, use fixed-string search (`rg -F`) or separate small queries. Do not pack UI strings, regex groups, and escaped quotes into one large expression.

## 2026-06-22 - Antigravity review files must be encoding-checked

- Symptom: Antigravity job `ag-0ead1656-857f-4c99-a891-5247a3cb371b` exited 0 but produced an unreadable mojibake Markdown review.
- Cause classification: worker output encoding failure, not a usable product review.
- Rule change: for Antigravity doc/report tasks, require a concrete output file and immediately inspect the first lines for readability. If mojibake appears, rewrite or reissue the task with ASCII-only output before using the result.

## 2026-06-22 - Worker audit docs must be ASCII unless proven readable

- Symptom: DeepSeek/Antigravity long-task review docs were created with mojibake despite successful worker exits.
- Cause classification: worker output encoding cannot be trusted for Chinese Markdown in this workspace.
- Rule change: request ASCII-only audit docs from workers by default. After completion, inspect the first lines. If mojibake appears, replace the file before using it as evidence.

## 2026-06-22 - Manager API probes must include trusted local headers

- Symptom: a direct `/anticodex/manager/bootstrap` probe returned 403 before the new report action could be tested.
- Cause classification: security guard working as designed; the probe omitted trusted local `Origin` and `Referer` headers.
- Rule change: when testing Manager APIs directly, include `Origin: http://127.0.0.1:<port>` and `Referer: http://127.0.0.1:<port>/anticodex/manager` before judging the endpoint.

## 2026-06-22 - Do not wrap simple health probes in nested PowerShell

- Symptom: a health status probe failed with `The string is missing the terminator` because it wrapped a simple request in an extra `powershell -Command` string.
- Cause classification: avoidable quoting layer, same family as earlier nested PowerShell variable expansion mistakes.
- Rule change: when already running in PowerShell, call `Invoke-RestMethod` directly. Only spawn child PowerShell for scripts that genuinely need a separate process.

## 2026-06-22 - UI action inventory tests must update with new buttons

- Symptom: installed fast overall failed after adding `viewLatestReports` because `test-anticodex-ui-state.mjs` still expected the old daily Manager action list.
- Cause classification: verifier whitelist drift, not a product runtime failure.
- Rule change: every new Manager button/action must update the embedded UI, fallback Manager HTML, bridge summary, action inventory tests, and UI-state verifier expected action lists in the same change.

## 2026-06-22 - Empty worker output is not a valid review

- Symptom: Antigravity job `ag-6405243e-6069-444b-acde-0e3cd97262c5` exited 0 with empty parsed text, and DeepSeek job `dsw_mqoe38jg_3o4f4q` produced a mojibake audit file before timing out.
- Cause classification: worker completion status did not prove usable content.
- Rule change: a worker review task is accepted only when it produces either parseable text or a readable output file that the main agent inspects. Empty parsed text, mojibake Markdown, or timeout-after-partial-output must be treated as failed review evidence and reissued as a smaller ASCII-only task if the information is still needed.

## 2026-06-22 - Windows PowerShell scripts must avoid direct Chinese literals

- Symptom: `test-anticodex-installed-overall.ps1` failed to parse after adding direct Chinese guard-wording match strings; Windows PowerShell 5.1 decoded the UTF-8 source as the legacy code page and broke quoted strings.
- Cause classification: script encoding compatibility issue, not an Anti-Codex runtime failure.
- Rule change: PowerShell scripts that may run under Windows PowerShell 5.1 must avoid direct non-ASCII string literals. Build Chinese probe strings with `[char[]](0x....)` or keep checks ASCII-only, then run the script itself before syncing.

## 2026-06-22 - Retry-path tests should assert stable behavior, not exact prompt prose

- Symptom: the new Antigravity SSE fake-tool retry test failed because it expected a specific phrase inside the corrective prompt while the actual prompt used a different, still valid guard message.
- Cause classification: overly narrow test assertion, not product behavior failure.
- Rule change: retry-path tests should assert durable behavior: retry count, no leaked first fake text, final tool call emitted, and response completion. Prompt assertions should use stable anchors such as `This is not the final answer` or `CODEX_TOOLS`, not full corrective prose.

## 2026-06-22 - ASCII-only worker reports need real ASCII validation

- Symptom: worker audit reports requested as ASCII-only still contained mojibake-looking non-ASCII text, while a weak bad-encoding regex reported them as readable.
- Cause classification: validation was too permissive; readable UTF-8 is not the same as ASCII-only.
- Rule change: for ASCII-only worker reports, verify every character is <= 0x7F. If not, rewrite the report before treating it as evidence.
## 2026-06-22 - Manager fallback patches must use real UTF-8 or ASCII anchors

- Symptom: a fallback Manager patch failed because PowerShell displayed UTF-8 Chinese as mojibake, and the rendered mojibake text was used as an `apply_patch` anchor.
- Cause classification: display encoding mismatch, not source corruption.
- Rule change: before patching Manager HTML/script text that includes Chinese, inspect the exact bytes/text with Node or use ASCII structure anchors. Do not copy PowerShell-rendered mojibake into patch anchors.
- Result: the corrected patch used real UTF-8 text and added static tests for global button disabling, latest-report path hiding, and nested reset result display.

## 2026-06-22 - Empty Antigravity worker output is not accepted as evidence

- Symptom: an Antigravity CLI worker exited with code 0 but returned empty parsed text.
- Cause classification: worker success status did not imply useful review output.
- Rule change: when a worker returns empty text, treat it as failed evidence. Continue with main-agent verification or rerun a smaller task; do not cite the empty worker as confirmation.
- Result: DeepSeek's scoped ASCII audit was reviewed, stale claims were filtered, and only independently verified findings were implemented.

## 2026-06-22 - Concurrent worker policy can misattribute main-agent edits

- Symptom: a docs-only DeepSeek audit failed policy because the main agent changed source files in the same workspace while the worker was running.
- Cause classification: shared dirty worktree attribution problem, not necessarily worker source editing.
- Rule change: when running docs-only workers in parallel with main-agent source edits, expect policy checks to see the whole worktree. Use a separate worktree for strict policy isolation, or treat the worker result as advisory and review the actual diff manually.
- Result: the worker's report was kept only as a draft; source changes were accepted only after direct parser and regression tests passed.

## 2026-06-22 - Do not race scoped workers against main edits

- Symptom: DeepSeek job `dsw_mqofvhep_cw70t1` was scoped to tests only, but the main agent edited the paired source file while the worker was still running; the worker policy then reported forbidden source changes.
- Cause classification: orchestration error in a shared dirty worktree.
- Rule change: for scoped patch workers, either wait for the worker to finish before touching related files, or give the worker an isolated worktree. If the main agent must take over, cancel the worker before continuing.
- Result: the unsafe worker was cancelled; the source and tests were validated directly by the main agent.

## 2026-06-22 - Empty Antigravity implementation can still leave bad edits

- Symptom: Antigravity job `ag-f0b85e49-132e-4bec-9b4d-53b4ac2632a4` completed with empty parsed text while the workspace source was later found reverted/stale and the installed translator contained a duplicated `translatedToolParts` function header.
- Cause classification: worker output was unusable and concurrent workspace state could not be attributed safely.
- Rule change: after every Antigravity implementation job, even when stdout is empty, immediately run `git status`, syntax checks, and targeted duplicate-symbol searches for the edited file. Do not trust an exit code of 0 without diff inspection.
- Result: the duplicate function header was removed, the repaired installed translator was copied back to source, and source/installed checks passed again.

## 2026-06-22 - Installation recovery must check source and runtime hashes

- Symptom: source `translator/adaptive-server.mjs` and installed runtime `adaptive-server.mjs` diverged after a failed sync; source was shorter and runtime could not start.
- Cause classification: partial sync plus worker race left two different truths.
- Rule change: after runtime sync failure, compare source and installed hashes/line counts before retrying. If runtime has the newer product code, repair it, then copy it back to source and verify both hashes match.
- Result: source and runtime now share the same repaired file and both pass `node --check`.

## 2026-06-22 - Do not patch non-UTF-8 project logs directly

- Symptom: `apply_patch` could not update `progress.md` because the file contains invalid UTF-8 bytes.
- Cause classification: accumulated mojibake / mixed-encoding project notes.
- Rule change: before editing long-lived notes that have shown mojibake, verify they are valid UTF-8. If not, write the new status to an ASCII audit/status file and leave normalization as a separate explicit cleanup task.
- Result: runtime recovery status was recorded in `docs/audits/2026-06-22-runtime-recovery-status.md` instead of corrupting `progress.md` further.

## 2026-06-22 - Treat Node and Windows PowerShell encoding differently

- Symptom: a mechanical `v81` to `v82` replacement rewrote `.mjs` and `.ps1` files with the wrong encoding assumptions. Node files briefly gained BOM risk and a corrupted regex; Windows PowerShell 5.1 scripts without BOM decoded Chinese text through the legacy code page and failed parser checks.
- Cause classification: mixed runtime encoding requirements, not product behavior failure.
- Rule change: do not use Windows PowerShell `Set-Content -Encoding UTF8` for mixed `.mjs`/`.ps1` rewrites. Use `apply_patch` for logic changes. If a mechanical rewrite is unavoidable, verify `.mjs`/`.js` files are UTF-8 without BOM and `node --check` passes; verify `.ps1` files parse under Windows PowerShell 5.1, adding UTF-8 BOM only to PowerShell scripts when they contain non-ASCII literals.

## 2026-06-23 - Manager summary changes need their own refresh marker
- Symptom: a real `viewLatestReports` click displayed the new missing-history report, but the verifier kept failing because an already-open Manager panel retained older summary behavior under the same `native-panel-v85` version.
- Cause classification: same-version UI closure staleness plus over-specific verifier text expectations.
- Rule change: when changing Manager summary behavior, add a narrow refresh marker such as `__ANTICODEX_MANAGER_SUMMARY_VERSION__` or bump the panel version. Acceptance for a new report should assert that report's own visible/semantic evidence instead of unrelated stale summary text.

## 2026-06-23 - Release gates must validate missing-history semantics
- Symptom: a signed `ok:true` missing-history report would have been enough for passive release readiness even if it did not prove the 410 recovery contract.
- Cause classification: release gate checked report liveness more than behavior.
- Rule change: missing-history release evidence must include HTTP 410, `response_history_missing`, `retryable:false`, original previous response ID match, recovery guidance, unchanged route fingerprint, `usedRealTraffic:false`, and installed no-traffic coverage.
- Result: Manager `native-panel-v82` source checks, launcher tests, source preflight, and installed non-fast overall verification all passed.

## 2026-06-22 - Route audits must be tied to the current request window

- Symptom: installed real-traffic verification reported `first-turn model route mismatch: selected=gemini-3.5-flash-low resolved=gemini-3-flash-agent`, then later checks timed out or returned invalid JSON after the Antigravity session lock stayed active with queued work.
- Cause classification: verifier race plus stale local lock state. The tool-loop verifier read `/anticodex/model-routes.latest`, so a route from a different request/model could be treated as this turn's route. The Manager reset verifier only reset an idle lock, so it skipped the exact stale state that needed cleanup.
- Rule change: real-traffic route verifiers must prefer `entries.requestId == response.id`, then fall back only to matching `resolvedModel` entries from the current verification window. Never accept an unrelated global `latest` entry as evidence. Reset probes may clear a stale Antigravity session lock when diagnostics show zero active upstream requests, even if the local lock still says active/queued.
- Result: the installed tool loop, native multi-tool loop, web tools, MCP tool loop, custom tool loop, compaction resume, account/proxy readiness, real mini-tool, and real work verifiers all passed individually after the fix.

## 2026-06-22 - Full real-traffic suites need realistic subcheck timeouts

- Symptom: the full post-verification rerun advanced correctly but subchecks such as native multi-tool and compaction resume were launched with `-TimeoutSec 25`, while stable individual runs took about 33 and 48 seconds respectively.
- Cause classification: verifier timeout configuration was too aggressive for real Antigravity/Gemini latency, not a product tool-chain failure.
- Rule change: when `test-anticodex-installed-overall.ps1` runs with `-AllowRealTraffic`, raise child process wait to at least 120 seconds and pass at least 90 seconds to real-traffic subchecks. Keep fast/no-traffic paths short.
- Result: full installed post-verification completed with real traffic in about 419 seconds, `overall.ok=true`, zero failures, no stale session lock, and no Manager long-task attention.

## 2026-06-22 - Do not let docs-only workers share a live source-edit workspace

- Symptom: DeepSeek job `dsw_mqoixlah_2poy3t` was assigned a docs-only third-party API audit, but its policy review reported forbidden script/source changes because the main agent was simultaneously adding the third-party provider verifier and adaptive-server fixes in the same worktree.
- Cause classification: orchestration failure in a shared dirty workspace. The worker result may contain useful docs, but policy attribution cannot distinguish worker edits from concurrent main-agent edits.
- Rule change: for docs-only workers, either use an isolated worktree or wait until the main-agent source patch is complete before starting them. If a docs worker is already running and the main agent must patch source, treat the worker result as advisory only and manually review every file.
- Result: the mojibake third-party audit was replaced with an ASCII audit by the main agent; source changes were accepted only after direct syntax, integration, launcher, and local end-to-end checks passed.

## 2026-06-22 - Check script parameters before adding convenience flags

- Symptom: `test-anticodex-source-preflight.ps1 -SkipFullRegression -TimeoutSec 30` failed because the script has no `TimeoutSec` parameter.
- Cause classification: caller invented a convenience flag instead of checking the script signature.
- Rule change: before adding timeout or mode flags to project scripts, inspect the `param(...)` block or existing launcher usage. Keep the outer command timeout in the tool call when the script has no matching parameter.
- Result: rerunning `test-anticodex-source-preflight.ps1 -SkipFullRegression` passed in about 18.5 seconds.

## 2026-06-22 - Do not keep waiting on full UI probes after 30 seconds

- Symptom: installed `test-anticodex-ui-state.ps1 -TimeoutSec 20 -SkipManagerActionProbe` exceeded the host command timeout at about 34 seconds while the fast UI probe completed cleanly.
- Cause classification: the deep CDP/Manager overlay probe can stall longer than the normal feedback budget; continuing to wait gives little new evidence and violates the 30-second rule.
- Rule change: for post-sync smoke checks, run the fast UI probe first. If the deep probe is needed, run it as a separately budgeted long UI validation with a larger explicit timeout and a status check at 30 seconds.
- Result: switched to `-Fast -SkipManagerActionProbe`, which passed and confirmed Manager v83, no floating button, no login/reconnect text, and the local connector allowlist card on the Manager page.

## 2026-06-22 - UI dynamic overlay probes must degrade during short smoke checks

- Symptom: after bounding the UI verifier, installed non-fast checks with `-TimeoutSec 8 -ManagerProbeTimeoutSec 8 -SkipManagerActionProbe` failed on `Timed out waiting for Runtime.evaluate`, even though the app page, Manager static page, model catalog, and health checks were all valid.
- Cause classification: the dynamic in-app Manager overlay CDP evaluation can become the slowest browser execution point. It is useful for full UI QA, but it is too fragile as a required short smoke signal.
- Rule change: short smoke checks may treat Manager overlay dynamic timeout as a recorded degraded signal when `-SkipManagerActionProbe` is set and the context/static Manager evidence is valid. Full dynamic UI QA must still run without this skip when validating close-button hit areas or action behavior.
- Result: installed fast UI check passed in about 1.5s; installed short non-fast UI check passed in about 9.5s with `dynamicProbeUnavailable` and an explicit mode note instead of hanging or failing silently.

## 2026-06-22 - Do not put PowerShell `if` expressions inside hashtable values

- Symptom: a background real-work polling command failed with `if : The term 'if' is not recognized` because a hashtable field used `(if (Test-Path ...) { ... } else { ... })` as if PowerShell supported expression-style `if`.
- Cause classification: command construction failure during status polling, not an Anti-Codex runtime failure.
- Rule change: compute conditional values in separate variables before building a hashtable or JSON status object. Do not embed `if` directly inside hashtable property expressions.
- Result: the corrected polling command confirmed the real-work verifier finished successfully, with file creation, real MCP execution, marker match, and normal Chinese final text.

## 2026-06-22 - Cancel tiny worker jobs that stream too long without file changes

- Worker: DeepSeek `dsw_mqowbabb_g4mvb3`.
- Task: modify only `scripts/test-anticodex-third-party-provider.mjs` to add multi-turn provider history assertions.
- Symptom: the worker streamed for about 145 seconds with no changed files, no checks run, and no usable partial output.
- Cause classification: worker orchestration inefficiency on a small single-file patch, not a product failure.
- Rule change: for tiny scoped patches, if a worker has active stream output but still no file changes after three 30-second checks, cancel it and let the main agent apply the small patch directly. Record the cancellation and verify there were no worker edits before taking over.
- Result: the job was cancelled with zero file changes; the main agent implemented and verified the script update directly.

## 2026-06-22 - NoRestart sync cannot recover a stopped installed gateway

- Symptom: `sync-anticodex-runtime.ps1 -NoRestart -TimeoutSec 45` copied the runtime files but returned `ok:false` because `http://127.0.0.1:8484/health` was unreachable and the script was explicitly told not to restart.
- Cause classification: validation mode mismatch, not a copy failure or product regression.
- Rule change: if installed gateway health is unreachable before or after a `-NoRestart` sync, run the installed `start-deepcodex.ps1 -TranslatorOnly` recovery path, then re-check `/health` and the synced script evidence before declaring sync failed.
- Result: translator-only startup restored health on 8484 with eight cached Antigravity models, and both installed verifier scripts passed from the runtime path.

## 2026-06-22 - Propagate short-smoke UI skip flags through wrapper scripts

- Symptom: installed overall no-traffic verification failed only in the nested UI idle stability check because `-SkipManagerActionProbe` was accepted by the top-level command but not forwarded to `test-anticodex-ui-state.ps1`.
- Cause classification: wrapper parameter propagation bug. The Anti-Codex runtime, local connector verifier, and third-party provider verifier were healthy.
- Rule change: when adding a skip/degrade flag for short UI smoke checks, update every wrapper that invokes the affected verifier and add a static launcher regression for the propagation path.
- Result: `test-anticodex-ui-idle-stability.ps1` now forwards `-SkipManagerActionProbe`, the launcher regression covers it, and installed overall no-traffic passes with UI state and UI idle stability green.

## 2026-06-22 - Do not reuse UI short timeouts for diagnostics-heavy subchecks

- Symptom: installed overall no-traffic verification failed only in the nested model-routing check because `/anticodex/diagnostics` timed out after two 8-second attempts while the standalone diagnostics and model-routing probes passed with a normal diagnostics budget.
- Cause classification: wrapper timeout budget mismatch. `-TimeoutSec 8` is suitable for short UI smoke probes, but model-routing in no-traffic mode still depends on diagnostics payload collection.
- Rule change: wrapper scripts must pass the diagnostics timeout budget to diagnostics-heavy subchecks such as model routing, even when the top-level UI timeout is intentionally short. Add static regression coverage for the exact forwarded parameter.
- Result: installed overall now forwards `-DiagnosticsTimeoutSec` into no-traffic model routing, the launcher regression covers the call site, and installed overall no-traffic passes again.

## 2026-06-22 - Put safety wording in static Manager HTML, not only dynamic render code

- Symptom: after adding local connector non-authorization wording to the dynamic Manager renderer, installed UI-state still failed because the static `/anticodex/manager` HTML placeholder lacked `本地缓存预览，不授权，不代表可调用`.
- Cause classification: UI contract split between static fallback HTML and dynamic injected panel. The runtime behavior was safe, but the verifier reads static Manager HTML as durable evidence.
- Rule change: safety-critical wording must exist in both the initial static HTML and the dynamic render/update path. Update UI-state static checks whenever changing connector/app-tool authorization wording.
- Result: the static placeholder, dynamic injected Manager, and fallback Manager now carry the non-authorization warning; installed overall no-traffic passes.

## 2026-06-22 - Do not parallelize Manager button verifiers against installed overall

- Symptom: installed overall no-traffic failed only in UI-state with `Timed out waiting for Manager verifier lock` while a standalone `pluginCapabilities` button verifier was running at the same time.
- Cause classification: orchestration collision, not an Anti-Codex runtime failure. Both verifiers use the same `%TEMP%\anticodex-manager-button.lock`.
- Rule change: treat Manager button/UI-state checks as a serial critical section. Parallel agents may investigate code or run non-UI probes, but only one live Manager button/UI-state verifier should run at a time.
- Result: after the standalone plugin button check finished and released the lock, the serial installed overall rerun passed.

## 2026-06-22 - Avoid nested PowerShell command-string quoting for verifier probes

- Symptom: several diagnostic probes failed before running because `$LASTEXITCODE`, `$out`, or `&` were expanded or parsed by the outer PowerShell layer.
- Cause classification: command construction failure during debugging, not a product failure.
- Rule change: for nested PowerShell diagnostics, prefer direct `-File` execution, raw script files, or single-quoted `-Command` strings with escaped variables. Avoid putting complex `&` invocations and `$LASTEXITCODE` checks inside double-quoted outer command strings.
- Result: the Manager action issue was diagnosed with a trace file and then fixed in the script itself.

## 2026-06-22 - Run diagnostics collection from the installed runtime entry point

- Symptom: `test-anticodex-diagnostics.ps1 -NoPopup` failed because that script has no `NoPopup` parameter, then source-root `collect-anticodex-diagnostics.ps1 -NoPopup` failed because bundle collection expects the installed runtime layout.
- Cause classification: wrong verifier entry point, not an Anti-Codex diagnostics regression.
- Rule change: use `collect-anticodex-diagnostics.ps1 -NoPopup` from `%LOCALAPPDATA%\Anti-Codex\runtime\scripts` when generating a real support bundle. Use source diagnostic tests only for source contracts and inspect their `param(...)` block before passing flags.
- Result: the installed runtime collector succeeded and wrote a diagnostic ZIP under `%APPDATA%\anticodex\diagnostic-bundles`.

## 2026-06-22 - Restart translator after server-side Manager inventory changes

- Symptom: runtime files were synced with `-NoRestart`, but the live Manager action inventory could still reflect old in-memory `adaptive-server.mjs` behavior.
- Cause classification: deployment/reload mismatch, not a copy failure.
- Rule change: after changing Manager actions, latest-report payloads, or adaptive-server protected endpoints, run a sync that restarts the Anti-Codex translator before installed UI/action verification. `-NoRestart` is only enough for file-based script changes.
- Result: after restarting Anti-Codex translator, installed UI and Manager action checks saw `native-panel-v84` and the new action/report inventory.

## 2026-06-22 - Reset Manager real-button queues before every real click

- Symptom: a real Manager button verifier timed out because stale pending promises and queue entries survived from an earlier failed or ui-only run.
- Cause classification: verifier contamination in the shared embedded Manager page, not product action failure.
- Rule change: real Manager button verification must clear `__ANTICODEX_MANAGER_ACTION_PROMISES__`, reset `__ANTICODEX_MANAGER_ACTION_QUEUE__`, restore the real bridge after ui-only smoke, and drain queued actions through the protected local endpoint with fresh bootstrap token headers.
- Result: standalone real button checks for `viewLatestReports` and `refreshStatus` passed serially after the verifier reset and queue-drain fixes.

## 2026-06-22 - Keep skipped expensive probes from producing derived failures

- Symptom: fast sync-readiness skipped icon palette decoding but still checked palette-derived ICO frame sizes, causing a false missing-frame failure.
- Cause classification: skip-mode assertion bug, not an icon regression.
- Rule change: when a fast verifier intentionally skips an expensive probe, every assertion that depends on that probe must also be marked skipped or not applicable.
- Result: fast and full sync-readiness both passed after frame-size checks were gated on actual palette evidence.

## 2026-06-22 - Use `Get-Content -Tail`, not `Select-Object -Tail`, on Windows PowerShell 5.1

- Symptom: `Get-Content ... | Select-Object -Tail 100` failed because Windows PowerShell 5.1 `Select-Object` does not support a `-Tail` parameter.
- Cause classification: shell compatibility mistake during local inspection, not a product failure.
- Rule change: use `Get-Content -Tail N <path>` for tail reads, or `Select-Object -Last N` when a pipeline is required.
- Result: reran the inspection with `Get-Content -Tail 80` and continued without touching runtime state.

## 2026-06-22 - Keep heterogeneous report-writer rewrites in small batches

- Symptom: a large patch that tried to convert many report writers at once failed when one script had a slightly different signature/context.
- Cause classification: patch batching mistake, not a product failure.
- Rule change: when many scripts share a broad pattern but differ in parameters or output paths, inspect the outliers first or patch in smaller groups. Do not let one context mismatch hide which files were actually updated.
- Result: split the conversion into narrower patches, then verified the final report-writer set with parser checks, launcher contracts, source preflight, and report-helper smoke tests.

## 2026-06-22 - Prefer `rg` or single-quoted regex for complex PowerShell scans

- Symptom: a PowerShell `Select-String` scan failed before useful inspection because the regex/string escaping around `WriteAllText\(` was malformed.
- Cause classification: command construction failure during local inspection, not a product failure.
- Rule change: use `rg` for complex source scans when available. If `Select-String` is necessary, use single-quoted regex literals and test the pattern on one file before running a broad scan.
- Result: reran the direct-write scan with `rg` and confirmed no remaining PowerShell direct `latest-*.json` report writes.

## 2026-06-22 - Test atomic file helpers with overwrite and relative paths

- Symptom: the first atomic report helper passed syntax checks but failed at runtime when replacing existing files because `[System.IO.File]::Replace` rejected a null backup path. A follow-up helper smoke also showed raw .NET relative path resolution can ignore PowerShell `Push-Location`.
- Cause classification: missing runtime smoke for filesystem edge cases.
- Rule change: every new shared file-write helper must be smoke-tested for first write, overwrite, invalid payload rejection, same-directory cleanup, and relative path behavior from a changed PowerShell location.
- Result: the helper now uses PowerShell session path resolution, a same-directory backup path for replacement, and JSON validation before publish.

## 2026-06-22 - Treat empty worker completion as no evidence

- Worker: Antigravity `ag-08262927-fe75-40a3-878b-9daf5689bdb4`.
- Symptom: a read-only report-integrity audit completed with exit code 0 but returned empty stdout/stderr and no parsed text.
- Cause classification: worker output failure, not product evidence.
- Rule change: a worker completion without a concrete written artifact or textual findings is not usable review evidence. Continue with direct source/test evidence and record the empty result.
- Result: the report hash hardening proceeded from direct code inspection, launcher tests, helper smokes, source preflight, runtime sync, and installed overall verification.

## 2026-06-22 - Do not share a dirty main workspace with read-only DeepSeek reviews

- Worker: DeepSeek `dsw_mqp8tmlg_8gxedp`.
- Symptom: the worker was asked for read-only review, failed its success contract, and reported the main agent's concurrently edited files as changed files in its progress metadata even though its final git summary showed no actual worker diff.
- Cause classification: orchestration failure in a shared dirty workspace plus failed worker contract.
- Rule change: do not start read-only DeepSeek review jobs in the same dirty workspace while the main agent is actively editing. Use a clean checkpoint, isolated worktree, or treat the result as unusable if metadata attributes main-agent edits to the worker.
- Result: no worker diff was accepted; main-agent changes were reviewed through git status/diff and direct validation only.

## 2026-06-22 - Verify port ownership after runtime translator restart

- Symptom: after runtime sync restarted Anti-Codex, installed overall was green but showed two translator processes: the packaged `deepcodex-translator.exe` and an older `node.exe adaptive-server.mjs`.
- Cause classification: process cleanup residue after switching/restarting translator entry points, not a functional health failure.
- Rule change: when restart evidence shows duplicate translators, inspect port ownership before stopping anything. Only stop a stale Anti-Codex runtime node translator if the packaged translator owns the active localhost listener and health remains green.
- Result: stopped only the stale node process, confirmed port 8484 was owned by the packaged translator, and reran installed no-traffic fast overall successfully.

## 2026-06-22 - Do not wrap complex PowerShell variable expressions with `rtk`

- Symptom: `rtk powershell -Command ... -Proxy $null ... $_.State ...` stripped or mis-expanded PowerShell variables, producing false errors such as missing `-Proxy` argument and `.State` not recognized.
- Cause classification: command-wrapper quoting interference, not Anti-Codex runtime failure.
- Rule change: use `rtk` for simple shell commands, but run native PowerShell directly when the command depends on `$null`, `$_`, script blocks, or nested quoting. If `rtk` changes semantics, rerun natively and record the wrapper interference.
- Result: reran health and port ownership checks natively; Anti-Codex was healthy and had a single localhost listener.

## 2026-06-22 - Scope fake provider tool-call triggers to the current request

- Symptom: the third-party provider tool-history verifier initially failed because the fake provider matched `turn-tool-call` in hydrated prior history and emitted another tool call during the `function_call_output` turn. After that was fixed, the synthetic answer still scanned the full history and reused an older `turn-4` marker for the tool-output-only request.
- Cause classification: verifier construction bug, not a translator regression.
- Rule change: fake provider tests that hydrate prior Responses history must derive behavior from the latest current user request and, for tool-call triggers, also require current `tools` or `tool_choice` evidence. Do not match trigger phrases against the whole serialized history.
- Result: the verifier now emits one provider tool call, records its paired output, and then proves the structured pair survives restart, provider switch, OpenAI-compatible to Anthropic switch, and Anthropic back to OpenAI-compatible switch.

## 2026-06-22 - Re-run isolated third-party verifier after one-off fetch failures

- Symptom: installed overall failed once with `TypeError: fetch failed` from the third-party provider verifier, but the installed verifier passed immediately when run directly and the next installed overall run also passed.
- Cause classification: transient local process/port/fetch failure during a nested verifier, not verified product regression.
- Rule change: for a single generic `fetch failed` from a nested local-only verifier, first run that verifier directly from the installed runtime and inspect its fresh report. Only treat the overall failure as transient if the direct verifier and the serial overall rerun both pass.
- Result: the final installed no-traffic overall passed with the third-party provider report showing all tool-history preservation booleans true.

## 2026-06-22 - Avoid ad hoc regex alternation in Select-String probes

- Symptom: a quick `Select-String` search for several launcher-test anchors failed because a pattern ending in `\$` was parsed as an illegal trailing regex escape.
- Cause classification: command-construction failure during local inspection, not a product failure.
- Rule change: use `rg` with simple literal patterns for multi-anchor source searches, or quote and test each PowerShell regex separately before combining alternations.
- Result: reran the lookup with `rg` and continued without touching runtime state.

## 2026-06-22 - Keep snapshot writer and diagnostics fingerprint roots identical

- Symptom: after adding `.agents\skills` to local feature sync, the installed runtime had the new files but diagnostics still reported the startup snapshot as stale.
- Cause classification: contract drift. The sync script wrote a marker fingerprint over `.codex\skills` plus `.agents\skills`, while adaptive-server recomputed diagnostics freshness from `.codex\skills` only.
- Rule change: any new startup snapshot source root must be added to both the marker writer and the diagnostics reader, with a focused installed diagnostics check after restart.
- Result: after aligning both sides, diagnostics reported `snapshotStatus.state:fresh` and `sourceFingerprintMatches:true` for the 126-skill union.

## 2026-06-22 - Empty successful Antigravity review output is not evidence

- Symptom: Antigravity CLI review job `ag-7544e490-ff7f-44c2-945b-ec377829b8f0` completed with exit code 0 but returned empty parsed text and no stdout/stderr summary.
- Cause classification: worker evidence failure, not a product failure.
- Rule change: a completed worker with empty output cannot be cited as review evidence. Use other worker results or direct verification, and record the empty output.
- Result: local connector hardening used ordinary subagent findings plus direct script, regression, source-preflight, and installed checks instead.

## 2026-06-22 - Do not use start_implementation as a DeepSeek status probe

- Symptom: the main agent accidentally launched DeepSeek job `dsw_mqpb3fa4_j17rrv` while trying to check status for earlier review job `dsw_mqpaz0t5_e6r6c6`; the accidental job was immediately cancelled, and the original obsolete review job also returned failed/no usable result when cancelled.
- Cause classification: operator/tool-selection mistake.
- Rule change: if a DeepSeek status/get tool is not exposed in the current tool list, do not fake a status probe by starting another implementation job. Either wait for a notification, use available cancellation when obsolete, or continue with direct verification.
- Result: the accidental no-op job was cancelled and no output from it was used.

## 2026-06-22 - Websocket fallback verifier needs per-path retry

- Symptom: installed overall failed twice because `test-anticodex-websocket-fallback.ps1` received the correct 501 unsupported response for `/v1/responses`, then the local connection for `/codex/responses` was forcibly closed before a response body was read. Running the verifier directly could pass immediately.
- Cause classification: local socket race in the verifier, not a product websocket support regression.
- Rule change: websocket fallback verification should retry each upgrade path briefly before failing, while still requiring HTTP 501 and `unsupported_websocket` for every path.
- Result: the verifier now retries each path up to three times and keeps the same hard assertions.

## 2026-06-22 - Run Node verifier scripts with node, not powershell -File

- Symptom: the main agent attempted to run installed `test-anticodex-local-connectors.mjs` with `powershell -File`, which failed because `.mjs` is not a PowerShell script.
- Cause classification: command invocation mistake.
- Rule change: installed Node verifiers must be invoked with `node` or through an overall wrapper that dispatches Node scripts.
- Result: reran the same installed verifier with `node`; it passed with `chatgptInstallUrlsScrubbed:true`.

## 2026-06-23 - Split slow verification and prefer current-action evidence

- Symptom: the main agent started long full-source/installed checks during an interactive progress loop, making the session look stuck. The immediately useful evidence was already available from focused Manager, MCP/Skill, and plugin-capability checks.
- Cause classification: verification scheduling mistake, not a product hang.
- Rule change: when the user is waiting for progress, split verification into short parser/self-test/contract checks and focused installed gates. Run full source preflight or installed overall only before a checkpoint/release, and say explicitly when a command is expected to take minutes.
- Result: stopped treating long gates as the default progress loop and narrowed the standalone real Manager button default to MCP/Skill plus plugin/application only.

## 2026-06-23 - Do not accept stale Manager visible text for real button success

- Symptom: installed overall real-clicked `mcpSkills` / `pluginCapabilities`, but the embedded panel sometimes still showed an older `refreshStatus` or degraded plugin result while the requested action was queued or just completed.
- Cause classification: verifier false-positive/false-negative risk from stale UI state.
- Rule change: real Manager button success must require `lastAction` to equal the requested action, no pending action promises, no queued actions, non-ui-only result text, and no `lastOk:false`. Only ui-only smoke may use the ui-only shortcut path.
- Result: `test-anticodex-manager-button.mjs` now rejects stale visible text and the standalone real Manager gate passed after local feature refresh.

## 2026-06-23 - Refresh local feature snapshots on connector parity drift

- Symptom: plugin capability verification failed because shared Codex connector cache had 5866 connector IDs while Anti-Codex local cache still had 5841.
- Cause classification: shared metadata snapshot drift, not fake authorization and not a runtime bridge failure.
- Rule change: when plugin capability parity reports `missingShared`, run the installed `refresh-anticodex-local-features.ps1` before rerunning plugin/Manager checks. This copies metadata snapshots only, does not grant OAuth/connector access, and must keep callable app tools at 0 unless real accessible connectors exist.
- Result: refresh repaired connector parity to 5866/5866, app-tool parity stayed 58/58, and `pluginCapabilities` showed "未授权连接器，不伪装可调用" as the expected healthy state.

## 2026-06-23 - Avoid nested PowerShell through rtk for process probes

- Symptom: several quick process/health probes failed because nested `rtk proxy powershell -Command` stripped quotes or variables around `$null`, `$_`, array arguments, and regex strings.
- Cause classification: command construction/wrapper quoting failure.
- Rule change: for process probes and PowerShell expressions with variables or regexes, prefer a short script file, direct simple commands, `curl.exe`, `rg`, or a single-quoted outer `-Command '& { ... }'`. If the wrapper still changes semantics, report it as wrapper interference and do not infer product state from that failure.
- Result: health was confirmed with `curl.exe`, while the failed process probes were not used as Anti-Codex evidence.

## 2026-06-23 - Subagent usage limits are not task evidence

- Symptom: two read-only explorer subagents for next-task/report-coverage discovery errored with a Codex usage-limit message before returning findings.
- Cause classification: worker availability failure, not product evidence.
- Rule change: if ordinary subagents hit account/usage limits, record the failure, stop waiting on them, and continue with direct local inspection or available MCP workers. Do not cite missing subagent output as review evidence.
- Result: the Manager real-button report indexing patch proceeded from direct source inspection and focused local tests only.

## 2026-06-23 - Antigravity empty jobs are not review evidence

- Symptom: Antigravity read-only jobs `ag-e50d32c0-1849-4d90-aa2b-26fe22c862c9`, `ag-edd29ea8-8e9e-4e39-ae12-4a29b33c6de8`, and `ag-f793e016-0e29-4ad2-a6ed-78f25c805c09` returned no parsed text, stdout, or stderr; the second timed out after the explicit two-minute budget. Earlier job `ag-d711f5ec-20cb-4db3-8a82-39db5be986f7` still reported running with empty tails long after it was useful.
- Cause classification: worker evidence failure / stale worker state, not product evidence.
- Rule change: a completed Antigravity job with empty output, a timed-out empty job, or a long-running empty-tail read-only job cannot be cited as review evidence. Stop waiting after the bounded window, continue with direct inspection or a narrower worker, and record the job IDs.
- Result: stale Manager/report documentation and Windows launcher branding residue were handled through direct source inspection, focused contract tests, and committed checkpoints instead of relying on empty worker output.

## 2026-06-23 - DeepSeek read-only jobs need a compatible success contract

- Symptom: DeepSeek read-only review job `dsw_mqpg0m2k_38i57p` inspected a documentation-audit question but failed its worker success contract because no file changes were produced.
- Cause classification: worker dispatch contract mismatch, not product evidence.
- Rule change: do not use an implementation worker preset for pure read-only evidence unless the tool contract explicitly accepts no changes. If a read-only worker fails this way, use direct local inspection and record that no worker evidence was accepted.
- Result: `docs\audits\real-usage-test-coverage.md` was refreshed from direct source/test evidence instead of the failed worker.

## 2026-06-23 - PowerShell parser probes should avoid ref args through rtk

- Symptom: quick parser probes using `[ref]$null` or escaped quoted paths through `rtk proxy powershell -Command` failed before reaching the target script.
- Cause classification: command wrapper quoting failure, not script syntax failure.
- Rule change: for simple PowerShell syntax probes, prefer `[scriptblock]::Create([System.IO.File]::ReadAllText('path')) | Out-Null` because it avoids `$null`, `[ref]`, and nested quote interpolation.
- Result: `scripts\apply-deepcodex-brand.ps1` parsed successfully with the no-`$` scriptblock method.

## 2026-06-23 - Do not combine full-history forks with an explicit agent type

- Symptom: two read-only explorer dispatches were rejected before starting because they used both `fork_context:true` and `agent_type:"explorer"`.
- Cause classification: subagent dispatch parameter conflict, not a product or worker failure.
- Rule change: a full-history fork inherits the parent agent type. When a specialized explorer is needed, omit `fork_context` and provide a self-contained task prompt; when full history is needed, omit the explicit type.
- Result: both investigations started successfully after switching to fresh self-contained explorer prompts.

## 2026-06-23 - Recheck rtk compatibility before parallel shell batches

- Symptom: a parallel startup batch wrapped `Get-Content` with `rtk`; `rtk` could not resolve the PowerShell cmdlet and the intended document reads failed.
- Cause classification: repeated command-runner mismatch.
- Rule change: classify every batched command before dispatch. Use `rtk` for external executables such as `git`, `rg`, and `node`; run PowerShell-native cmdlets directly with bounded paths and output.
- Result: the reads were rerun directly and the repository state was confirmed without using the failed output as evidence.

## 2026-06-23 - Sync source scripts before installed diagnostics verification

- Symptom: installed diagnostics verification used the older installed summarizer after a source-only change and initially failed; direct collector execution from the development checkout also rejected the non-installed root.
- Cause classification: deployment/entry-point mismatch, not report corruption.
- Rule change: installed diagnostics intentionally resolves installed runtime scripts. Sync source changes before installed verification, and do not run the collector directly from a development checkout unless its install-root contract is intentionally changed.
- Result: runtime sync was performed and installed bundle verification passed.

## 2026-06-23 - Resolve PSScriptRoot defaults after the param block

- Symptom: the new provider-to-Antigravity wrapper failed before its default skip path because `Split-Path -Parent $PSScriptRoot` received an empty string while evaluating a parameter default.
- Cause classification: Windows PowerShell 5.1 script initialization ordering, not a runtime or provider failure.
- Rule change: do not derive parameter defaults from `$PSScriptRoot` inside `param(...)`. Use an empty/default parameter and resolve the script-relative path immediately after the parameter block.
- Result: the wrapper reaches its no-traffic skip path and writes the expected signed report.

## 2026-06-23 - Ordinary subagent security review hit usage limits

- Worker: ordinary explorer `019ef0d6-1d71-7893-9fc8-175cc2b3e8bb`.
- Task: read-only review of the real third-party and provider-to-Antigravity verifier changes.
- Result: the worker returned only a Codex usage-limit error, with no findings and no file changes.
- Cause classification: external worker availability failure, not product evidence.
- Rule change: close the unusable reviewer, record the failure, and replace it with direct diff review plus focused negative security tests. Do not cite the failed worker as review coverage.

## 2026-06-23 - Do not place expected history markers in the continuity prompt

- Symptom: the first provider-to-Antigravity turn-10 prompt included all six expected marker values.
- Cause classification: verifier false-positive design; the model could echo the current instruction without reading prior history.
- Rule change: continuity prompts may describe which historical positions to retrieve, but must not include the expected values. Compare the answer against values that appear only in earlier turns.
- Result: turn 10 now requests semantic history fields and the verifier checks them against the prior provider/tool markers.

## 2026-06-23 - Empty Antigravity completion still requires direct review

- Worker: Antigravity `ag-7c48d50d-f6c6-4a05-990b-5519210a5802`.
- Task: add two optional reports to Manager and diagnostic latest-report lists.
- Result: exit code 0 and the intended three-file diff were present, but parsed text/stdout/stderr were empty.
- Cause classification: worker summary/evidence failure, not implementation failure.
- Rule change: do not cite the empty worker response. Review the exact diff and rerun syntax plus focused contracts from the main agent.
- Result after review: only the three authorized files changed; syntax passed and focused launcher contracts passed 3/3.

## 2026-06-23 - DeepSeek RED-test dispatch failed on repeated 502s

- Worker: DeepSeek `dsw_mqpna7wl_sxri13`.
- Task: add one RED launcher contract for source-preflight upstream profile storage coverage.
- Result: timed out after about 130 seconds with eight `api_retry` events, all HTTP 502 `server_error`; zero tool calls, zero file changes, zero checks.
- Cause classification: external DeepSeek model service failure, not task breadth, permissions, or repository failure.
- Retry change: switch the already one-file/one-behavior RED task to the healthy Antigravity CLI worker. Keep the same no-runtime-write and syntax-only acceptance boundary.

## 2026-06-23 - Verify that Node test-name filters actually match

- Symptom: the first RED command used `--test-name-pattern "upstream profile storage"`, but the new test name used different words; Node reported the test file as passing without executing the intended test.
- Cause classification: verification selector mismatch, not a product result.
- Rule change: confirm the output prints the exact intended test name. A file-level pass with no matching named subtest is not RED/GREEN evidence.
- Result: reran with the exact test-name phrase, observed the expected missing-preflight-call failure, then implemented the source check and observed the named test pass.

## 2026-06-23 - Antigravity RED worker completed with an empty summary

- Worker: Antigravity `ag-94c92c3e-2e17-4028-98be-8f7e1c6ba700`.
- Task: add one RED launcher contract for upstream profile storage coverage.
- Result: the authorized test diff and exit code 0 were present, but parsed text/stdout/stderr were empty.
- Cause classification: worker summary failure, not implementation failure.
- Rule change: accept no narrative evidence from the worker; inspect the one-file diff, run syntax, and independently demonstrate the RED failure with the exact test selector.

## 2026-06-23 - Bounded ordinary review was stopped without evidence

- Worker: ordinary explorer `019ef101-0626-7db3-95c9-6762e613141f`.
- Task: read-only review of the 410 missing-history fix.
- Result: still running after about 40 seconds with no findings; stopped to avoid delaying the verified checkpoint.
- Cause classification: bounded review availability failure, not product evidence.
- Rule change: do not cite the stopped reviewer. Use direct diff inspection plus focused history/integration and launcher regressions as the accepted review evidence.

## 2026-06-23 - Keep PowerShell-heavy checks out of JavaScript orchestration strings

- Symptom: two parallel verification attempts failed with JavaScript `SyntaxError: Unexpected string` before any product command ran.
- Cause classification: host orchestration quoting failure, not Anti-Codex failure.
- Rule change: dispatch PowerShell-heavy checks as independent shell calls. Do not embed several quoted PowerShell commands in one JavaScript `Promise.all` body.
- Result: syntax, parser, diff, and launcher checks were rerun separately and produced usable evidence.

## 2026-06-23 - Use the actual Manager latest-report response shape

- Symptom: direct probes first looked for `payload.result.items`, then `payload.result.result`, and checked `file`; all missed valid entries.
- Cause classification: inspection schema mistake.
- Rule change: protected `viewLatestReports` returns entries at `payload.result.reports`, keyed by `fileName`. Inspect the live payload once before writing assertions.
- Result: the optional and missing-history report entries were confirmed without weakening Manager authorization.

## 2026-06-23 - Empty background sync output is not deployment evidence

- Symptom: a `Start-Process` sync attempt produced empty stdout/stderr files and no durable process to inspect.
- Cause classification: background-launch evidence failure, not runtime sync success or product failure.
- Rule change: for required syncs, use the direct script with bounded foreground yields and require its final JSON plus health result. Do not infer success from an empty detached launch.
- Result: direct runtime sync completed in 38.7 seconds with Antigravity healthy, 8 models, and account ready.

## 2026-06-23 - Bump the Manager panel version when renderer behavior changes

- Symptom: the backend latest-report payload included `publicDocumentationOk:true` and the new missing-history report, while the already-open `native-panel-v84` UI rendered the new report but omitted public-documentation evidence; the real button verifier therefore returned false despite `lastOk:true`.
- Cause classification: same-version frontend cache/reinjection drift.
- Rule change: any change to Manager renderer or acceptance-visible summary behavior must bump the native panel version consistently across injector, opener, UI-state checks, sync-readiness checks, and manager launcher comments/contracts.
- Result: a focused RED test now requires the next panel version before implementation.

## 2026-06-23 - Unusable ordinary explorer output is not evidence

- Worker: ordinary explorer `019ef103-73d5-7720-9b67-6190515f4865`.
- Task: inspect the Manager protected endpoint and response shape.
- Result: the worker declined to read the workspace and requested pasted code, producing no usable findings.
- Rule change: close the worker, record the failure, and use direct bounded source/runtime inspection. Do not cite the response as review coverage.

## 2026-06-23 - Antigravity scope violation after stop request

- Worker: Antigravity `ag-0fc71173-2f30-4fd6-a3b5-7871a7156dcd`.
- Task: add one diagnostics assertion and one launcher contract for local connector exposed tool names.
- Result: the worker touched `scripts/summarize-anticodex-report.mjs`, `scripts/test-anticodex-local-connectors.mjs`, and an unrelated MCP/Skill launcher assertion outside the authorized two-file scope. It remained running after two stop messages and produced no useful stdout/stderr.
- Cause classification: scope violation plus empty worker evidence, not accepted product evidence.
- Rule change: for tiny diagnostics/test edits, prefer direct main-agent patching unless the worker is given a single writable file. If Antigravity touches an unauthorized file, stop waiting after a bounded status check, discard the extra diff, and do not cite the worker as evidence.

## 2026-06-24 - Antigravity docs audit completed with empty summary

- Worker: Antigravity `ag-0f443319-ed07-4e86-a0b9-0ede7e7f1037`.
- Task: write one runtime-sync manifest audit under `docs/audits` in an isolated worktree.
- Result: exit code 0 and one docs file was created, but parsed text/stdout/stderr were empty.
- Cause classification: worker summary/evidence failure, not product evidence.
- Rule change: for Antigravity audit jobs, read and review the generated file directly; do not cite the empty worker response. If the generated file is mojibake or stale against main, extract only independently confirmed findings.

## 2026-06-24 - DeepSeek docs audit hit caller timeout after valid changes

- Worker: DeepSeek `dsw_mqr062a4_944szc`.
- Task: write one passive release-gate evidence audit under `docs/audits` in an isolated worktree.
- Result: caller timeout stopped the worker after it produced one policy-compliant docs file; the output was partial and required direct review.
- Cause classification: task was still too broad for the 180s audit budget, even with docs-only scope.
- Rule change: split future DeepSeek audit jobs by one subsystem and one question, or increase the timeout before asking for a long structured audit. Treat partial docs as suggestions only until the main agent verifies the source and tests.
