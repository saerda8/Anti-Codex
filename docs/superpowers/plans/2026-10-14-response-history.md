# Responses history implementation plan

Design: [approved contract](../specs/2026-10-14-response-history-design.md).

1. Core worker owns the AGPL source cache: add the bounded persistent store, then connect request reconstruction and successful completion capture in the existing proxy/launcher. Begin with targeted failing Rust tests. No changes to native task control.
2. Verification worker owns the two existing history verification files and an external black-box harness. Check response identity, real request counts, both history modes and honest negative evidence. Use only synthetic local upstreams until a candidate is available.
3. Main agent records the approved architecture exception, reviews necessary changes once, exports patch 0013, records hashes and obtains an independently replayed candidate through the managed build path. Never reset the source cache while a worker is editing it.
4. Run focused Rust and black-box checks, then a guarded runtime synchronization with rollback. Verify installed hashes and real continuation behavior. Reuse earlier unrelated passing evidence.

Build resource rule: check memory and existing heavy processes first. The user explicitly waived the 8 GiB threshold for this build on 2026-10-14 after closing other applications. Use one compilation job and keep full builds/tests sequential.

Only source, tests, patch metadata and required project documents are in scope. No push, remote deployment, original Codex change, account change or desktop-automation workaround.

## Windows persistence defect fixed; final candidate pending

- The pending descriptor is `third_party/codexplusplus/response-history.pending.json`. The accepted `upstream.json` remains byte-for-byte unchanged; no history-enabled candidate is installed.
- Candidate `33d77182ddf7faeaadafab9e46d07747a2ccfe2f` passed 186 full-component Rust tests, the Manager Windows check, launcher release build and process creation. Its first Chat black-box request exposed a real Windows persistence defect: a 264-character history path failed in `MoveFileExW` despite successful upstream completion. That candidate must not be promoted.
- The shared Windows atomic-write helper now converts absolute paths to extended-length form, preserving existing prefixes, UNC paths, replacement flags and failure handling. Actual Windows tests demonstrate 0/2 failures before the fix, then 2/2 long-path checks, 7/7 storage tests and 1/1 path-semantics test after it. Evidence is `.validation/20261014-response-history/store-isolated-check/windows-fix-result.json`; this is not a full-component Windows acceptance.
- Final patch 0013 has SHA-256 `c6ebb2d49370c349029f6b7f2d2730c34556192c180020ee6f68eb68e649dc25`, replayed commit `8eb0adba4d09000b4974a8ab940fb732cd8de875` and tree `ea5ef1b7d1800ff6716ee30eb41951109935096e`. All six Rust files pass formatting and independent replay checks. The previous pending source was restored clean after byte comparison with the new immutable source.
- The independent source location is in `.validation/20261014-response-history/source-replay.json`. Chat and native black boxes and the native installed image/command smoke remain prepared in that external validation directory.

## Resume the single build and acceptance pass

1. Verify no competing heavy task, then verify the pending descriptor's accepted-metadata digest, patch digest and replayed source tree. The user-authorized resource exception above remains valid for this build.
2. Run the required project regression/source preflight on the clean local implementation commit. The candidate preparer includes `response_history` integration, the library filters `response_history` and `proxy_stream_tests`, and the existing protocol/watcher checks in one managed build lifecycle; do not run a duplicate full Rust build first.
3. Preserve the accepted manifest bytes. Temporarily append the pending patch descriptor to the build input manifest and run the existing candidate preparer for `v1.7.1`. Restore the accepted manifest bytes in a `finally` block, including on a failed build. Do not install from this temporary build input. The resulting candidate must match the pending commit/tree.
4. Run the Chat and native black-box scripts against the new candidate. Require both to pass, including cross-model/full-history behavior, helper restart, `store:false`, missing-history failures, tool order and native stream completion.
5. Only after those checks pass, promote the candidate's generated metadata, record a local implementation commit and use guarded runtime sync. Check installed bytes/health and fresh real same-model/cross-model ID continuation. On any failure preserve the accepted runtime and rollback evidence; do not claim the interface is fixed from source checks alone.
