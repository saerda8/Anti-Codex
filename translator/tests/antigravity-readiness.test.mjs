import test from "node:test";
import assert from "node:assert/strict";
import { createAntigravityReadinessMonitor } from "../antigravity-readiness.mjs";

// ─────────────────────────────────────── helpers ────────────────────────────

function successfulProbe(models = ["model-a", "model-b"]) {
  return async () => ({ models });
}

function failingProbe(error) {
  return async () => {
    throw error;
  };
}

// ─────────────────────────────────────── shape ──────────────────────────────

test("createAntigravityReadinessMonitor returns required methods", () => {
  const monitor = createAntigravityReadinessMonitor({ probe: successfulProbe() });
  assert.equal(typeof monitor.start, "function");
  assert.equal(typeof monitor.stop, "function");
  assert.equal(typeof monitor.check, "function");
  assert.equal(typeof monitor.getSnapshot, "function");
});

test("createAntigravityReadinessMonitor throws if probe is missing", () => {
  assert.throws(
    () => createAntigravityReadinessMonitor({}),
    /probe function is required/,
  );
});

// ─────────────────────────────────────── initial snapshot ───────────────────

test("initial snapshot has state unknown and ready false", () => {
  const monitor = createAntigravityReadinessMonitor({ probe: successfulProbe() });
  const s = monitor.getSnapshot();

  assert.equal(s.state, "unknown");
  assert.equal(s.ready, false);
  assert.equal(s.modelCount, 0);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastCheckedAt, null);
  assert.equal(s.lastReadyAt, null);
  assert.equal(typeof s.message, "string");
});

// ─────────────────────────────────────── check: success ─────────────────────

test("check returns ready state after successful probe", async () => {
  const monitor = createAntigravityReadinessMonitor({
    probe: successfulProbe(["foo", "bar"]),
  });
  const r = await monitor.check();

  assert.equal(r.ready, true);
  assert.equal(r.state, "ready");
  assert.equal(r.modelCount, 2);
  assert.equal(r.consecutiveFailures, 0);
  assert.ok(typeof r.lastCheckedAt === "number");
  assert.ok(typeof r.lastReadyAt === "number");
});

test("check updates snapshot (getSnapshot reflects latest check)", async () => {
  const monitor = createAntigravityReadinessMonitor({
    probe: successfulProbe(["x"]),
  });
  await monitor.check();
  const s = monitor.getSnapshot();

  assert.equal(s.state, "ready");
  assert.equal(s.ready, true);
  assert.equal(s.modelCount, 1);
});

// ─────────────────────────────────────── check: empty models ────────────────

test("check returns account_unavailable when probe returns empty models", async () => {
  const monitor = createAntigravityReadinessMonitor({
    probe: successfulProbe([]),
  });
  const r = await monitor.check();

  assert.equal(r.ready, false);
  assert.equal(r.state, "account_unavailable");
  assert.equal(r.modelCount, 0);
  assert.equal(r.lastReadyAt, null);
  assert.equal(r.consecutiveFailures, 1);
  assert.ok(typeof r.lastCheckedAt === "number");
});

// ─────────────────────────────────────── check: error ───────────────────────

test("check returns transient_error when probe throws", async () => {
  const monitor = createAntigravityReadinessMonitor({
    probe: failingProbe(new Error("ECONNREFUSED 127.0.0.1:8080")),
  });
  const r = await monitor.check();

  assert.equal(r.ready, false);
  assert.equal(r.state, "transient_error");
  assert.ok(r.message.includes("ECONNREFUSED"));
  assert.equal(r.lastReadyAt, null);
  assert.equal(r.consecutiveFailures, 1);
  assert.ok(typeof r.lastCheckedAt === "number");
});

test("check maps network timeout to transient_error", async () => {
  const err = new Error("fetch failed");
  err.name = "TypeError";
  const monitor = createAntigravityReadinessMonitor({
    probe: failingProbe(err),
  });
  const r = await monitor.check();

  assert.equal(r.state, "transient_error");
  assert.equal(r.ready, false);
});

// ─────────────────────────────────────── dedup ──────────────────────────────

test("concurrent check calls only run one probe at a time", async () => {
  let probeCallCount = 0;
  const probe = async () => {
    probeCallCount++;
    await new Promise((r) => setTimeout(r, 30));
    return { models: ["a"] };
  };
  const monitor = createAntigravityReadinessMonitor({ probe });

  const [r1, r2] = await Promise.all([monitor.check(), monitor.check()]);

  assert.equal(probeCallCount, 1);
  assert.equal(r1.ready, true);
  assert.equal(r2.ready, true);
});

// ─────────────────────────────────────── recovery ───────────────────────────

test("failure then recovery resets consecutive failures and updates lastReadyAt", async () => {
  let callCount = 0;
  const probe = async () => {
    callCount++;
    if (callCount <= 2) throw new Error("ECONNRESET");
    return { models: ["a"] };
  };
  const monitor = createAntigravityReadinessMonitor({ probe });

  const fail1 = await monitor.check();
  assert.equal(fail1.state, "transient_error");
  assert.equal(fail1.consecutiveFailures, 1);
  assert.equal(fail1.lastReadyAt, null);

  const fail2 = await monitor.check();
  assert.equal(fail2.state, "transient_error");
  assert.equal(fail2.consecutiveFailures, 2);
  assert.equal(fail2.lastReadyAt, null);

  const success = await monitor.check();
  assert.equal(success.state, "ready");
  assert.equal(success.consecutiveFailures, 0);
  assert.ok(success.lastReadyAt > 0);
  assert.ok(success.lastReadyAt >= fail2.lastCheckedAt);
});

// ─────────────────────────────────────── start / stop ───────────────────────

test("start registers an interval that triggers check", async () => {
  let registeredFn = null;
  const setIntervalImpl = (fn, _ms) => {
    registeredFn = fn;
    return { unref: () => {} };
  };
  let clearCalled = false;
  const clearIntervalImpl = () => {
    clearCalled = true;
  };

  const probe = async () => ({ models: ["m"] });
  const monitor = createAntigravityReadinessMonitor({
    probe,
    intervalMs: 1000,
    setIntervalImpl,
    clearIntervalImpl,
  });

  monitor.start();
  assert.equal(typeof registeredFn, "function");

  // Manually trigger the interval callback
  registeredFn();
  // Let microtask settle
  await new Promise((r) => setTimeout(r, 10));
  const s = monitor.getSnapshot();
  assert.equal(s.state, "ready");

  monitor.stop();
  assert.equal(clearCalled, true);
});

test("start is idempotent (only one interval created)", () => {
  let createCount = 0;
  const setIntervalImpl = () => {
    createCount++;
    return { unref: () => {} };
  };
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => ({ models: ["m"] }),
    intervalMs: 1000,
    setIntervalImpl,
    clearIntervalImpl: () => {},
  });

  monitor.start();
  monitor.start();
  monitor.start();

  assert.equal(createCount, 1);
  monitor.stop();
});

test("stop without start is a no-op", () => {
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => ({ models: ["m"] }),
  });
  // Should not throw
  monitor.stop();
});

// ─────────────────────────────────────── unref ──────────────────────────────

test("unref is called on interval timer when available", () => {
  let unrefCalled = false;
  const fakeTimer = {
    unref: () => {
      unrefCalled = true;
    },
  };
  const setIntervalImpl = () => fakeTimer;
  const clearIntervalImpl = () => {};

  const monitor = createAntigravityReadinessMonitor({
    probe: async () => ({ models: ["m"] }),
    intervalMs: 1000,
    setIntervalImpl,
    clearIntervalImpl,
  });

  monitor.start();
  assert.equal(unrefCalled, true);
  monitor.stop();
});

// ─────────────────────────────────────── now injection ──────────────────────

test("check uses injected now function", async () => {
  const fixedTime = 1234567890;
  const monitor = createAntigravityReadinessMonitor({
    probe: successfulProbe(["a"]),
    now: () => fixedTime,
  });
  const r = await monitor.check();

  assert.equal(r.lastCheckedAt, fixedTime);
  assert.equal(r.lastReadyAt, fixedTime);
});

// ─────────────────────────────────────── modelCount ─────────────────────────

test("modelCount reflects number of models from probe", async () => {
  const models = ["m1", "m2", "m3"];
  const monitor = createAntigravityReadinessMonitor({
    probe: successfulProbe(models),
  });
  const r = await monitor.check();

  assert.equal(r.modelCount, 3);
});

// ─────────────────────────────────────── message ────────────────────────────

test("message contains state-specific info", async () => {
  const monitor = createAntigravityReadinessMonitor({
    probe: successfulProbe(["m"]),
  });

  const unknown = monitor.getSnapshot();
  assert.equal(unknown.state, "unknown");
  assert.ok(unknown.message.includes("not yet checked"));

  await monitor.check();
  const ready = monitor.getSnapshot();
  assert.ok(ready.message.includes("ready"));

  const emptyMonitor = createAntigravityReadinessMonitor({
    probe: successfulProbe([]),
  });
  await emptyMonitor.check();
  const empty = emptyMonitor.getSnapshot();
  assert.ok(empty.message.toLowerCase().includes("no model"));

  const errorMonitor = createAntigravityReadinessMonitor({
    probe: failingProbe(new Error("BOOM")),
  });
  await errorMonitor.check();
  const error = errorMonitor.getSnapshot();
  assert.ok(error.message.includes("BOOM"));
});

// ───────────────────────── abort/cancellation error ──────────────────────────

test("abort error preserves the previous ready state (ready → abort → still ready)", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) return { models: ["m1", "m2"] };
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });

  // Phase 1: ready
  const ready = await monitor.check();
  assert.equal(ready.state, "ready");
  assert.equal(ready.ready, true);
  assert.equal(ready.modelCount, 2);
  assert.equal(ready.consecutiveFailures, 0);
  assert.equal(ready.lastProbeAborted, false);
  const readyTimestamp = ready.lastReadyAt;
  assert.ok(readyTimestamp > 0);

  // Phase 2: abort error — state must stay "ready"
  const abort = await monitor.check();
  assert.equal(abort.state, "ready", "state must survive abort");
  assert.equal(abort.ready, true, "ready must survive abort");
  assert.equal(abort.modelCount, 2, "modelCount must survive abort");
  assert.equal(
    abort.consecutiveFailures,
    0,
    "abort must NOT increment consecutiveFailures",
  );
  assert.equal(abort.lastProbeAborted, true, "lastProbeAborted must be set");
  assert.equal(
    abort.lastReadyAt,
    readyTimestamp,
    "lastReadyAt must be preserved across abort",
  );
  assert.ok(
    abort.lastCheckedAt >= ready.lastCheckedAt,
    "lastCheckedAt must advance on abort",
  );
  assert.ok(abort.message.includes("aborted"));
});

test("abort error on unknown state stays unknown (never ready from the start)", async () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => { throw err; },
  });

  const abort = await monitor.check();
  assert.equal(abort.state, "unknown", "abort on unknown must stay unknown");
  assert.equal(abort.ready, false);
  assert.equal(abort.modelCount, 0);
  assert.equal(abort.consecutiveFailures, 0, "abort must not increment failures");
  assert.equal(abort.lastReadyAt, null);
  assert.equal(abort.lastProbeAborted, true);
  assert.ok(abort.lastCheckedAt > 0);
});

test("abort error preserves account_unavailable state", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) return { models: [] };  // account_unavailable
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });

  // Phase 1: account_unavailable
  const unavailable = await monitor.check();
  assert.equal(unavailable.state, "account_unavailable");
  assert.equal(unavailable.consecutiveFailures, 1);

  // Phase 2: abort
  const abort = await monitor.check();
  assert.equal(
    abort.state,
    "account_unavailable",
    "abort must preserve account_unavailable",
  );
  assert.equal(abort.ready, false);
  assert.equal(
    abort.consecutiveFailures,
    1,
    "abort must not increment failures on account_unavailable",
  );
  assert.equal(abort.lastProbeAborted, true);
});

test("abort error preserves transient_error state", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) throw new Error("ECONNREFUSED");
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  });

  // Phase 1: transient_error
  const transient = await monitor.check();
  assert.equal(transient.state, "transient_error");
  assert.equal(transient.consecutiveFailures, 1);

  // Phase 2: abort — must preserve the transient_error state
  const abort = await monitor.check();
  assert.equal(
    abort.state,
    "transient_error",
    "abort must preserve transient_error state",
  );
  assert.equal(abort.ready, false);
  assert.equal(
    abort.consecutiveFailures,
    1,
    "abort must not increment consecutiveFailures",
  );
  assert.equal(abort.lastProbeAborted, true);
});

test("normal error after abort resets lastProbeAborted and increments failures", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) return { models: ["a"] };
      if (callCount === 2) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      throw new Error("ECONNRESET");
    },
  });

  // Phase 1: ready
  const ready = await monitor.check();
  assert.equal(ready.state, "ready");

  // Phase 2: abort — preserves ready
  const abort = await monitor.check();
  assert.equal(abort.lastProbeAborted, true);

  // Phase 3: real error — must overwrite to transient_error
  const error = await monitor.check();
  assert.equal(error.state, "transient_error");
  assert.equal(error.ready, false);
  assert.equal(error.lastProbeAborted, false, "lastProbeAborted must reset on real error");
  assert.equal(error.consecutiveFailures, 1, "real error must increment failures");
});

test("DOMException AbortError is detected as cancellation", async () => {
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      // Simulate a DOMException-style abort (as Node.js fetch throws)
      const err = new DOMException("This operation was aborted", "AbortError");
      throw err;
    },
  });

  const abort = await monitor.check();
  assert.equal(abort.lastProbeAborted, true);
  assert.equal(abort.state, "unknown");
  assert.equal(abort.consecutiveFailures, 0);
});

test("successful check after abort resets lastProbeAborted and restores normal state", async () => {
  let callCount = 0;
  const monitor = createAntigravityReadinessMonitor({
    probe: async () => {
      callCount++;
      if (callCount === 1) return { models: ["a"] };
      if (callCount === 2) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return { models: ["b", "c"] };
    },
  });

  // Phase 1: ready
  const ready = await monitor.check();
  assert.equal(ready.state, "ready");

  // Phase 2: abort
  const abort = await monitor.check();
  assert.equal(abort.lastProbeAborted, true);

  // Phase 3: successful check
  const recovered = await monitor.check();
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.lastProbeAborted, false, "lastProbeAborted must reset after success");
  assert.equal(recovered.consecutiveFailures, 0);
  assert.ok(recovered.lastReadyAt >= abort.lastCheckedAt);
});
