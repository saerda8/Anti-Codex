# Responses history implementation plan

Design: [approved contract](../specs/2026-10-14-response-history-design.md).

1. Core worker owns the AGPL source cache: add the bounded persistent store, then connect request reconstruction and successful completion capture in the existing proxy/launcher. Begin with targeted failing Rust tests. No changes to native task control.
2. Verification worker owns the two existing history verification files and an external black-box harness. Check response identity, real request counts, both history modes and honest negative evidence. Use only synthetic local upstreams until a candidate is available.
3. Main agent records the approved architecture exception, reviews necessary changes once, exports patch 0013, records hashes and obtains an independently replayed candidate through the managed build path. Never reset the source cache while a worker is editing it.
4. Run focused Rust and black-box checks, then a guarded runtime synchronization with rollback. Verify installed hashes and real continuation behavior. Reuse earlier unrelated passing evidence.

Build resource rule: check memory and existing heavy processes first; no full build below 8 GiB free physical memory or alongside another heavy task. Maximum two build/test workers; use one for focused checks if resources are constrained.

Only source, tests, patch metadata and required project documents are in scope. No push, remote deployment, original Codex change, account change or desktop-automation workaround.

## Source ready; build deferred by the user

On 2026-10-14 the user asked to finish available work first and build together once memory is available. Do not start a heavy build merely to close this plan.

- The pending descriptor is `third_party/codexplusplus/response-history.pending.json`. The accepted `upstream.json` remains byte-for-byte unchanged.
- Patch 0013 replayed cleanly on accepted patched source `37d6bac1d68567edfdcaa387c460adcbedb8d275`, producing commit `b56571e97321f7e1c72cb8e09933e815afb18e9e` and tree `b0a03562209c481d9f1c42a5289beba35d27cd72`. All five changed Rust files pass formatting/parsing checks; Rust execution and the Windows build remain unverified.
- The independent clean source is in the content-addressed `component-sources/codexplusplus/pending/response-history` cache. Its exact location and replay receipt are in repository-external `.validation/20261014-response-history/source-replay.json`. The accepted source cache was restored to its clean original commit after replay verification.
- Both old-binary black-box failures are established: Chat ID-only continuation loses history after helper restart; native Responses forwards the parent ID without local hydration. Their scripts and fixtures remain in `.validation/20261014-response-history` for the new-binary pass.

## Resume the single build and acceptance pass

1. Check at least 8 GiB free physical memory and no competing heavy task. Verify the pending descriptor's accepted-metadata digest, patch digest and replayed source tree before using them.
2. Use the managed runner on the clean pending AGPL source for the `response_history` integration test and the core library filters `response_history` and `proxy_stream_tests`, with one compilation job. These filters include the new native-stream boundaries; a formatting pass is not a substitute.
3. Preserve the accepted manifest bytes. Temporarily append the pending patch descriptor to the build input manifest and run the existing candidate preparer for `v1.7.1`. Restore the accepted manifest bytes in a `finally` block, including on a failed build. Do not install from this temporary build input. The resulting candidate must match the pending commit/tree.
4. Run the Chat and native black-box scripts against the new candidate. Require both to pass, including cross-model/full-history behavior, helper restart, `store:false`, missing-history failures, tool order and native stream completion.
5. Only after those checks pass, promote the candidate's generated metadata, record a local implementation commit and use guarded runtime sync. Check installed bytes/health and fresh real same-model/cross-model ID continuation. On any failure preserve the accepted runtime and rollback evidence; do not claim the interface is fixed from source checks alone.
