# Anti-Codex Shared MCP Design

## Goal

Give Anti-Codex its own authenticated loopback MCP sharing layer so one local Worker process can serve multiple Anti-Codex tasks without touching official Codex or injecting host development Workers into the product.

## Current facts

- The active Anti-Codex config contains only `node_repl`; the current product Worker set is empty.
- `deepseek-external` is not in the Anti-Codex product config.
- Official Codex already has a separate shared proxy. Anti-Codex must not reuse its port, token, mutex, state, logs, config, process, or virtual environment.
- The installed Anti-Codex leak guard currently limits copies owned by a live core. The required safe behavior is narrower: remember exact Anti-owned identities while the core is alive and only act after that exact Anti root has gone.

## Design

### Automatic discovery

Read Anti-Codex's effective `config.toml`; never use a fixed list of Worker names. A server is shareable only when all of these are true:

1. it is enabled;
2. it is local stdio (`command` and string `args`, no `url`);
3. it is not the built-in `node_repl`;
4. its enabled tool permissions contain the Worker lifecycle contract: one `*_start_implementation`, plus `*_get_job`, `*_wait_for_job`, and `*_cancel_job` tool.

This rule excludes remote MCPs, built-ins, ordinary local MCPs, and disabled Workers. `deepseek-external` is only a compatibility sample because its tool contract matches; its name is never special-cased. Adding or removing any same-contract Worker changes the discovered set on the next normal Anti-Codex start without proxy source edits.

### Runtime and configuration

The preparer keeps an Anti-only manifest containing the original stdio definitions and exact generated config hash. It rewrites only discovered Worker transport blocks to authenticated loopback URLs and preserves unrelated settings and tool permissions. Previously generated Workers are retained from the manifest, while deletion or `enabled = false` removes them from the next runtime set. Every config write is atomic and preceded by a private backup; rollback refuses to overwrite a config changed after generation.

The proxy binds only `127.0.0.1`, uses a random private bearer token, a dedicated port, and `Local\\AntiCodexSharedMcpProxyV1`. Runtime files and logs live below Anti-Codex's own state root. The pinned proxy dependencies install into an Anti-only virtual environment. Repeated starts exit successfully when the mutex is already held. Each Worker is independently supervised by the proxy library, so one failed Worker does not terminate unrelated services.

### Startup boundary

The normal Anti-Codex launcher prepares and starts the shared layer only after proving no Anti-Codex client is already running and before starting the copied client. No file watcher restarts a live client. A config change therefore takes effect on the next normal start.

### Orphan guard

The guard never selects a process merely because several identical commands exist. It records exact PID, creation time, command signature, and exact Anti app/core ownership while that root is alive. A process is eligible only after the recorded Anti app/core identity has disappeared, it survives two scans, and all identities are revalidated immediately before termination. Official Codex paths and roots can never enter this tracked set.

## Acceptance

- Unit tests cover dynamic discovery, remote/built-in/non-Worker exclusion, new Worker addition, deletion/disable, config preservation, auth, and rollback safety.
- An isolated integration test connects four simulated channels to every discovered dummy Worker, proves one process per service, HTTP 401 without the Anti token, idempotent duplicate start, and healthy-worker isolation from a failed Worker.
- A read-only compatibility check classifies the real `deepseek-external` definition without invoking a model.
- Guard tests prove live-core duplicates are never selected and only previously observed Anti-owned orphans can be confirmed; official samples remain excluded.
- Source tests and a no-restart runtime sync may run. Starting or restarting Anti-Codex remains a separate activation step.
