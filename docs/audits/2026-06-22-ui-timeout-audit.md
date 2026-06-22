# Anti-Codex UI State Verifier Timeout Design Audit

Date: 2026-06-22
Status: Completed

## Overview
This audit assesses the timeout configurations and progress feedback design of the Anti-Codex UI state verifier and related verification scripts. The primary goal is to determine if any execution path can block for more than 30 seconds without feedback.

The audit confirms that **multiple paths exceed 30 seconds of complete silence**, and several **critical timeout mismatches** exist between the verifier scripts and their calling wrappers, leading to premature process termination and lost diagnostics.

---

## 1. Silent Timeout Hotspots

The following locations in the codebase contain configurations or logic that wait silently for more than 30 seconds:

### A. Inner DOM Checking Loop in Browser Evaluation
* **File Reference**: [test-anticodex-ui-state.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-ui-state.mjs#L947-L961)
* **Code Location**: Lines 947-961
* **Timeout Limit**: 35,000 ms (35 seconds)
* **Behavior**: Inside the CDP browser context, the injected script evaluates the state of the Manager panel and loops up to 35 seconds waiting for elements (like models list or remote connector directories) to load.
* **Risk**: During this 35-second period, the Node script blocks on `await ws.call(...)` and prints absolutely nothing. There is no progress feedback.

### B. High WebSocket CDP Evaluate Timeout
* **File Reference**: [test-anticodex-ui-state.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-ui-state.mjs#L1153)
* **Code Location**: Line 1153
* **Timeout Limit**: `Math.max(timeoutMs, 120000)` (At least 120 seconds / 2 minutes)
* **Behavior**: The WebSocket protocol call `ws.call` wrapping the manager overlay check has a hardcoded timeout override of 120 seconds.
* **Risk**: If the Chromium instance is frozen or unresponsive, the verifier script blocks silently for up to 120 seconds before throwing a timeout error.

### C. Injection and State Probe CDP Timeouts
* **File Reference**: [test-anticodex-ui-state.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-ui-state.mjs#L762) & [L802](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-ui-state.mjs#L802)
* **Code Location**: Lines 762 and 802
* **Timeout Limit**: `Math.max(timeoutMs, 40000)` (At least 40 seconds)
* **Behavior**: Evaluates `managerInjectSource` and `pageStateProbeExpression` via CDP with a minimum timeout of 40 seconds.
* **Risk**: Any browser rendering hang or script injection blockade will result in 40 seconds of silent hanging.

---

## 2. Integration and Caller Mismatches (Critical Risks)

There are mismatches between the inner script timeouts and the outer wrapper timeout limits:

### A. manage-anticodex.ps1 premature process termination
* **File Reference**: [manage-anticodex.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/manage-anticodex.ps1#L367)
* **Code Location**: Line 367
* **Command**: `Invoke-ManagerScriptJson "test-anticodex-ui-state.ps1" -TimeoutMs 30000`
* **Mismatch**: The outer caller kills the script process after **30 seconds** (`-TimeoutMs 30000`). However, as shown in Section 1, the inner verifier script `test-anticodex-ui-state.mjs` has hardcoded internal wait loops up to **35 seconds**, and evaluate limits of **40 seconds** or **120 seconds**.
* **Consequence**: If the Manager UI is slow but would have succeeded at 31-35 seconds, `manage-anticodex.ps1` kills it at 30 seconds. The verifier never gets to output its JSON response, resulting in a false-failure with zero details (e.g. `"test-anticodex-ui-state.ps1 超时未返回。"`).

### B. test-anticodex-third-party-provider.mjs timeout mismatch
* **File Reference**: [test-anticodex-installed-overall.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-installed-overall.ps1#L1001-L1006)
* **Code Location**: Lines 1001-1006
* **Mismatch**: The overall test script invokes the third-party E2E provider test with `--timeout-ms 90000` (90 seconds). However, the calling helper `Invoke-NodeJsonScript` runs the process with a wait limit of `$SubcheckTimeoutSec`, which defaults to **60 seconds** when real traffic is disabled.
* **Consequence**: If the third-party provider test takes between 60 and 90 seconds, the PowerShell process kills it at 60 seconds, ignoring the script's internal 90-second allowance.

---

## 3. Lack of Real-Time Output Streaming

* **File Reference**: [test-anticodex-ui-state.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-ui-state.ps1#L65) and [test-anticodex-installed-overall.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-installed-overall.ps1#L175)
* **Behavior**: `test-anticodex-ui-state.ps1` runs node synchronously and assigns all output to `$output`. Similarly, `test-anticodex-installed-overall.ps1` redirects stdout/stderr of subchecks to temporary files (`$stdoutPath`, `$stderrPath`) and reads them only *after* the process exits.
* **Risk**: This design prevents any progressive/real-time console logging. If a subcheck or Node script hangs for 40-120 seconds, the user or host orchestrator receives absolutely no feedback during the entire period.

---

## 4. Recommendations for the Main Agent

To resolve these timeout design issues, the following improvements are recommended:

1. **Add Real-Time Progress Output**:
   Instead of buffering all console logs until final execution, `test-anticodex-ui-state.mjs` should print progressive status lines (e.g. `[INFO] Waiting for manager panel...`) to stderr or stdout, and the PowerShell wrappers should stream standard output progressively (or at least provide heartbeat messages) rather than using silent redirected files.

2. **Align Script and Process Timeouts**:
   * Increase the process timeout in [manage-anticodex.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/manage-anticodex.ps1#L367) from `30000` to at least `60000` (60 seconds) to accommodate the 35s browser wait and 40s evaluate limits.
   * Adjust the inner browser-level deadline from `35000` to a value scaled with the user-defined `timeoutMs`, avoiding arbitrary long hardcoded durations.
   * Ensure that when invoking Node scripts with a customized `--timeout-ms`, the wrapper's process timeout ($SubcheckTimeoutSec / $TimeoutMs) is dynamically scaled to be larger than the inner timeout (e.g. `inner timeout + 10 seconds`) to avoid premature process kills.
