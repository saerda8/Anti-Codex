# CodexPlusPlus Component Boundary

This directory pins the separately licensed CodexPlusPlus component and carries the Anti-Codex isolation patch plus one narrowly scoped loopback-cancellation transport patch. It does not vendor CodexPlusPlus source, binaries, provider credentials or user state.

## Upstream

- Repository: `https://github.com/BigPizzaV3/CodexPlusPlus`
- Version: `v1.2.36`
- Commit: `91a83acd8bdf79a388a106c7c1ea76f9df6bcea9`
- License: `AGPL-3.0-only`

The cloned/built component and this derived patch remain under the upstream AGPL license. Anti-Codex keeps this component at a separate source/build boundary.

## Allowed Patch Scope

The patch may change only isolation behavior:

- explicit absolute `CODEX_PLUS_STATE_DIR` for CodexPlusPlus settings, logs and locks;
- configurable `CODEX_PLUS_PROTOCOL_PROXY_PORT`;
- explicit `CODEX_PLUS_APP_EXECUTABLE` selection restricted to an existing `.exe` in the copied app directory, with invalid configuration failing closed;
- copied-app-path-scoped process discovery, activation, waiting and restart;
- fail-closed launch/restart when isolated mode has no absolute copied app path;
- exact-path manager activation;
- refusal to install or remove the shared current-user logon watcher in isolated mode.

The second patch changes only cancelled plain-HTTP loopback model streams: it uses an abortive close so cancellation reaches the controlled local Antigravity adapter before or after response headers. HTTPS and non-loopback providers retain the upstream request path.

Neither patch may change provider payloads, Responses/Chat conversion, model semantics, retries, history or task control.

## Replay

Apply the patch to the pinned upstream commit:

```powershell
git clone https://github.com/BigPizzaV3/CodexPlusPlus.git
git -C CodexPlusPlus checkout 91a83acd8bdf79a388a106c7c1ea76f9df6bcea9
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0001-isolation-scope-Anti-Codex-companion-runtime.patch
git -C CodexPlusPlus am <path-to-deepcodex>\third_party\codexplusplus\patches\0002-abort-cancelled-loopback-model-streams.patch
```

`upstream.json` records the patch hash and verification state.

## Current Verification Boundary

- Both patches replay on the pinned commit and produce tree `fad5e31d2c4460d86408dc86276bdad85a33475f`.
- Repository isolation audit: 9/9 checks passed.
- Audit regression tests: 7/7 passed.
- `cargo fmt --all -- --check`: passed.
- Pinned `messense/cargo-xwin:0.23.0` Windows cross-check: core and Manager passed.
- Windows-native tests: 124 core tests and 20 watcher tests passed, including fail-closed branded executable selection and exact process scope.
- Release launcher build: passed; SHA-256 `aae5e052a03b82b0c0b1f4aa0dff175de2aa51f5a2572c4c757fec9cfcf1b02b`.
- Runtime isolation proof: 20/20 checks passed against copied Codex `26.707.9981.0`; invalid executable selection failed closed, original Codex and the active Anti-Codex stayed unchanged, and all test processes were removed.

The isolation component is runtime-ready for Gate 2. The isolated launcher must always receive explicit copied-client paths and child-only state environment variables; provider and long-task readiness remain separate later gates.
