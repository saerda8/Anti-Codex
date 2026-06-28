# Desktop Usability Smoke Evidence -- 2026-06-28

## Conclusion

All five desktop smoke tasks passed with no reconnect lock and no
login-wall observed. The UI state check confirmed no reconnect banner
and no login prompt. Evidence suggests the desktop coworker session
infrastructure (reconnect guard, lock-clear, tool bridge) is functional
for the core flows exercised. Risk remains around edge conditions not
covered by this smoke pass.

## Evidence

### 1. Chat smoke
- Source: latest-ui-chat-smoke.json
- Result: ok = true
- Elapsed: 52820 ms
- Reconnect lock: clear (no lock held during run)
- Verdict: pass

### 2. Web search smoke
- Source: latest-ui-web-search-smoke.json
- Result: ok = true
- Elapsed: 50030 ms
- Reconnect lock: clear
- Verdict: pass

### 3. Multi-turn project smoke
- Source: latest-ui-multi-turn-project-smoke.json
- Result: ok = true
- Elapsed: 113098 ms
- Reconnect lock: clear
- Artifacts produced: package/word-tally, test, done, followup, changelog
- Test/CLI: pass
- Verdict: pass

### 4. Repo file edit smoke
- Source: latest-ui-repo-file-edit-smoke.json
- Result: ok = true
- Elapsed: 73477 ms
- Reconnect lock: clear
- Artifacts produced: target/test (files exist)
- Test/CLI: pass
- Verdict: pass

### 5. Complex project smoke
- Source: latest-ui-complex-project-smoke.json
- Result: ok = true
- Elapsed: 57634 ms
- Reconnect lock: clear
- Artifacts produced: package/analyzer, test, sources, report, index, done
- Source count: 6
- Test/CLI: pass
- Verdict: pass

### UI State Check
- No reconnect text detected
- No login text detected
- Verdict: clean

## Remaining Risk

- Smoke duration covers only 5 scenarios; regressions in untested
  flows (e.g., branch switch, error recovery, file sync conflict)
  are not assessed.
- Multi-turn project was the longest run (113 s); no stress or
  soak test was performed.
- Desktop reconnect lock was clear at time of evidence collection,
  but lock-leak under concurrent or interrupted sessions was not
  tested.
- All runs executed against a single environment; cross-platform
  or cross-version coverage is zero.

## Next Recommended Verifier

- Run an adversarial reconnect test: force network disconnect
  mid-task, verify lock is released on reconnect.
- Add a soak smoke that cycles through chat + multi-turn project
  3x back-to-back to catch cumulative state leaks.
- Verify that the reconnect lock file on disk matches the expected
  schema and is cleaned up after each run.
