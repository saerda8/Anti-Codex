import test from "node:test";
import assert from "node:assert/strict";
import { createAntigravityReadinessMonitor } from "../antigravity-readiness.mjs";

// Dedup guard reset.

test("dedup guard resets after check completes so sequential calls run separate probes", async () => {
  let probeCallCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      probeCallCount++;
      return { models: ["a"] };
    },
  });

  const r1 = await monitor.check();
  assert.equal(probeCallCount, 1);
  assert.equal(r1.ready, true);

  // A later call must run a new probe rather than reuse the resolved promise.
  // resolved promise from the first call (regression: runningProbe was non-null)
  const r2 = await monitor.check();
  assert.equal(probeCallCount, 2, "must create a new probe after prior completes");
  assert.equal(r2.ready, true);
});

// Logout and re-login lifecycle.

test("logout preserves lastReadyAt and increments failures", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) return { models: ["m1", "m2"] };
      return { models: [] };
    },
  });

  // Phase 1: ready
  const ready = await monitor.check();
  assert.equal(ready.state, "ready");
  assert.equal(ready.ready, true);
  assert.equal(ready.modelCount, 2);
  assert.equal(ready.consecutiveFailures, 0);
  const readyTimestamp = ready.lastReadyAt;
  assert.ok(readyTimestamp > 0);

  // Phase 2: account_unavailable (simulates logout)
  const logout = await monitor.check();
  assert.equal(logout.state, "account_unavailable");
  assert.equal(logout.ready, false);
  assert.equal(logout.modelCount, 0);
  assert.equal(logout.consecutiveFailures, 1);
  // The process is still running and the account was healthy before logout.
  assert.equal(logout.lastReadyAt, readyTimestamp, "lastReadyAt must survive logout");
  // lastCheckedAt must advance even when account is unavailable
  assert.ok(logout.lastCheckedAt >= ready.lastCheckedAt);
});

test("re-login resets failures and updates lastReadyAt", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount <= 2) return { models: [] };   // logged out
      return { models: ["m1"] };                     // signed back in
    },
  });

  // Phase 1: account_unavailable (logged out)
  const out1 = await monitor.check();
  assert.equal(out1.state, "account_unavailable");
  assert.equal(out1.consecutiveFailures, 1);
  assert.equal(out1.lastReadyAt, null);

  const out2 = await monitor.check();
  assert.equal(out2.state, "account_unavailable");
  assert.equal(out2.consecutiveFailures, 2);
  assert.equal(out2.lastReadyAt, null);

  // Phase 2: re-login.
  const recovered = await monitor.check();
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.ready, true);
  assert.equal(recovered.modelCount, 1);
  assert.equal(recovered.consecutiveFailures, 0, "consecutiveFailures must reset on recovery");
  assert.ok(recovered.lastReadyAt > 0, "lastReadyAt must update after recovery");
  assert.ok(
    recovered.lastReadyAt >= out2.lastCheckedAt,
    "lastReadyAt must be at or after the last check during unavailable",
  );
});

test("full logout and recovery lifecycle does not lose or duplicate state", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) return { models: ["a", "b"] };  // ready
      if (callCount === 2) return { models: [] };           // logout
      return { models: ["c"] };                              // re-login
    },
  });

  // Ready.
  const p1 = await monitor.check();
  assert.equal(p1.state, "ready");
  assert.equal(p1.consecutiveFailures, 0);
  const p1Ready = p1.lastReadyAt;

  // Account unavailable.
  const p2 = await monitor.check();
  assert.equal(p2.state, "account_unavailable");
  assert.equal(p2.consecutiveFailures, 1);
  assert.equal(p2.lastReadyAt, p1Ready, "lastReadyAt preserved across logout");
  assert.ok(p2.lastCheckedAt >= p1.lastCheckedAt, "lastCheckedAt advances");

  // Ready again.
  const p3 = await monitor.check();
  assert.equal(p3.state, "ready");
  assert.equal(p3.consecutiveFailures, 0, "failures reset on re-login");
  assert.ok(
    p3.lastReadyAt >= p2.lastCheckedAt,
    "lastReadyAt is not older than the unavailable check",
  );
  assert.equal(p3.modelCount, 1);

  // getSnapshot returns a copy that reflects the latest check.
  const snap = monitor.getSnapshot();
  assert.equal(snap.state, "ready");
  assert.equal(snap.lastReadyAt, p3.lastReadyAt);
  assert.equal(snap.consecutiveFailures, 0);
});

// Abort (cancellation) in lifecycle.

test("abort error in the middle of a logout does not corrupt the account_unavailable count", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) return { models: ["a", "b"] };  // ready
      if (callCount === 2) return { models: [] };            // logout -> account_unavailable
      if (callCount === 3) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;                                           // abort — should preserve account_unavailable
      }
      return { models: ["c"] };                              // re-login
    },
  });

  const p1 = await monitor.check();
  assert.equal(p1.state, "ready");
  assert.equal(p1.consecutiveFailures, 0);

  const p2 = await monitor.check();
  assert.equal(p2.state, "account_unavailable");
  assert.equal(p2.consecutiveFailures, 1);

  const p3 = await monitor.check();
  assert.equal(p3.state, "account_unavailable", "abort must preserve state");
  assert.equal(p3.consecutiveFailures, 1, "abort must not inflate the failure count");
  assert.equal(p3.lastProbeAborted, true);

  const p4 = await monitor.check();
  assert.equal(p4.state, "ready");
  assert.equal(p4.ready, true);
  assert.equal(p4.consecutiveFailures, 0, "consecutiveFailures resets on re-login after abort");
  assert.equal(p4.lastProbeAborted, false);
  assert.ok(p4.lastReadyAt >= p3.lastCheckedAt);
});

test("ready state survives transient abort spikes", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount <= 2) return { models: ["m"] };
      // throw multiple consecutive aborts
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });

  const p1 = await monitor.check();
  assert.equal(p1.state, "ready");

  const p2 = await monitor.check();
  assert.equal(p2.state, "ready");

  // Three consecutive aborts must not flip state
  for (let i = 0; i < 3; i++) {
    const aborted = await monitor.check();
    assert.equal(aborted.state, "ready",
      `abort #${i + 1} must keep ready state`);
    assert.equal(aborted.consecutiveFailures, 0,
      `abort #${i + 1} must not increment failures`);
  }
});
