import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravitySessionLock } from "../antigravity-session-lock.mjs";

test("Antigravity session lock lets the same tool continuation pass while blocking new sessions", async () => {
  const lock = createAntigravitySessionLock();
  const first = await lock.acquire();
  first.continueWith("resp_tool_1");

  let secondStarted = false;
  const second = lock.acquire().then((lease) => {
    secondStarted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);

  const continuation = await lock.acquire({ previousResponseId: "resp_tool_1" });
  continuation.continueWith("resp_tool_2");

  await Promise.resolve();
  assert.equal(secondStarted, false);

  const final = await lock.acquire({ previousResponseId: "resp_tool_2" });
  final.release();

  const secondLease = await second;
  assert.equal(secondStarted, true);
  secondLease.release();
});

test("Antigravity session lock lets tool output continue by call id when previous response id is missing", async () => {
  const lock = createAntigravitySessionLock();
  const first = await lock.acquire();
  first.continueWith("resp_tool_1", ["call_write_project"]);

  let secondStarted = false;
  const second = lock.acquire().then((lease) => {
    secondStarted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);

  const continuation = await lock.acquire({ continuationCallIds: ["call_write_project"] });
  continuation.release();

  const secondLease = await second;
  assert.equal(secondStarted, true);
  secondLease.release();
});


test("Antigravity session lock releases queued sessions when a tool continuation expires", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 1000 });
  const first = await lock.acquire();
  first.continueWith("resp_waiting");

  const second = lock.acquire();
  assert.equal(lock.snapshot().queued, 1);

  const secondLease = await second;
  assert.equal(lock.snapshot().expired, 1);
  secondLease.release();
});

test("Antigravity session lock releases a stale tool continuation by response id", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 5000 });
  const first = await lock.acquire();
  first.continueWith("resp_waiting");

  let secondStarted = false;
  const second = lock.acquire().then((lease) => {
    secondStarted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);
  assert.equal(lock.snapshot().queued, 1);

  const release = lock.releaseResponseId("resp_waiting", { reason: "test_cancel" });
  assert.equal(release.ok, true);
  assert.equal(release.released, true);
  assert.equal(release.reason, "test_cancel");
  assert.equal(release.responseId, "resp_waiting");

  const secondLease = await second;
  assert.equal(secondStarted, true);
  assert.equal(lock.snapshot().responseCancelled, 1);
  secondLease.release();
});

test("Antigravity session lock ignores response-id release misses", async () => {
  const lock = createAntigravitySessionLock();
  const first = await lock.acquire();
  first.continueWith("resp_waiting");

  const release = lock.releaseResponseId("resp_missing");
  assert.equal(release.ok, true);
  assert.equal(release.released, false);
  assert.equal(lock.snapshot().active, true);
  assert.equal(lock.snapshot().responseCancelled, 0);

  first.release();
});

test("Antigravity session lock can release an idle tool continuation early", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 5000 });
  const first = await lock.acquire();
  first.continueWith("resp_waiting");

  const early = lock.releaseIdleContinuation({ maxIdleMs: 1000, reason: "test_idle" });
  assert.equal(early.released, false);
  assert.equal(lock.snapshot().active, true);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const released = lock.releaseIdleContinuation({ maxIdleMs: 1, reason: "test_idle" });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.reason, "test_idle");
  assert.equal(lock.snapshot().active, false);
  assert.equal(lock.snapshot().idleReleased, 1);
});

test("Antigravity session lock can release stale response ids by idle age", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 5000 });
  const first = await lock.acquire();
  first.continueWith("resp_stale");
  const queued = lock.acquire();

  const early = lock.releaseIdleContinuation({ maxIdleMs: 1000, reason: "test_stale_response" });
  assert.equal(early.released, false);
  assert.equal(lock.snapshot().active, true);
  assert.equal(lock.snapshot().queued, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const released = lock.releaseIdleContinuation({ maxIdleMs: 1, reason: "test_stale_response" });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.reason, "test_stale_response");
  assert.equal(lock.snapshot().active, true);
  assert.equal(lock.snapshot().queued, 0);
  assert.equal(lock.snapshot().idleReleased, 1);

  const secondLease = await queued;
  secondLease.release();
});

test("Antigravity session lock can release an idle active session without continuation ids", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 5000 });
  await lock.acquire();
  const queued = lock.acquire();

  const early = lock.releaseIdleActive({ maxIdleMs: 1000, reason: "test_idle_active" });
  assert.equal(early.released, false);
  assert.equal(lock.snapshot().active, true);
  assert.equal(lock.snapshot().queued, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const released = lock.releaseIdleActive({ maxIdleMs: 1, reason: "test_idle_active" });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.reason, "test_idle_active");
  assert.equal(lock.snapshot().active, true);
  assert.equal(lock.snapshot().queued, 0);
  assert.equal(lock.snapshot().idleReleased, 1);

  const secondLease = await queued;
  secondLease.release();
});

test("Antigravity idle active release can cancel stale queued sessions", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 5000 });
  await lock.acquire();
  const queued = lock.acquire();
  const queuedRejected = assert.rejects(queued, /idle session release cancelled queued requests/);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const released = lock.releaseIdleActive({
    maxIdleMs: 1,
    reason: "test_idle_active_cancel_queue",
    cancelQueued: true,
  });

  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.queuedCancelled, 1);
  assert.equal(lock.snapshot().active, false);
  assert.equal(lock.snapshot().queued, 0);
  await queuedRejected;
});

test("Antigravity session lock rejects overflow without releasing the active session", async () => {
  const lock = createAntigravitySessionLock({ maxQueued: 1 });
  const first = await lock.acquire();
  const second = lock.acquire();

  await assert.rejects(
    lock.acquire(),
    (error) => {
      assert.equal(error.name, "AntigravitySessionBusyError");
      assert.equal(error.statusCode, 429);
      assert.equal(error.type, "antigravity_session_busy");
      return true;
    },
  );

  first.release();
  const secondLease = await second;
  secondLease.release();
});

test("Antigravity session lock releases runaway continuations at the configured limit", async () => {
  const lock = createAntigravitySessionLock({ maxContinuations: 2 });
  const first = await lock.acquire();
  first.continueWith("resp_tool_1");

  const second = await lock.acquire({ previousResponseId: "resp_tool_1" });
  second.continueWith("resp_tool_2");

  const third = await lock.acquire({ previousResponseId: "resp_tool_2" });
  third.continueWith("resp_tool_3");

  await assert.rejects(
    lock.acquire({ previousResponseId: "resp_tool_3" }),
    (error) => {
      assert.equal(error.name, "AntigravitySessionContinuationLimitError");
      assert.equal(error.statusCode, 409);
      assert.equal(error.type, "antigravity_session_continuation_limit");
      assert.equal(error.retryable, false);
      return true;
    },
  );

  const snap = lock.snapshot();
  assert.equal(snap.active, false);
  assert.equal(snap.continuationLimitReleased, 1);
  assert.equal(snap.maxContinuations, 2);
});

test("Antigravity session lock auto-releases an idle continued session after TTL expires (no queued requests)", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 1000 });
  const first = await lock.acquire();
  first.continueWith("resp_tool_call");
  assert.equal(lock.snapshot().active, true);
  assert.equal(lock.snapshot().queued, 0);

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const snap = lock.snapshot();
  assert.equal(snap.active, false, "expected session lock to auto-release after TTL");
  assert.equal(snap.queued, 0, "no queued sessions");
  assert.equal(snap.expired, 1, "expected expired counter to be incremented");
});

test("Antigravity session lock reset releases active and rejects queued sessions", async () => {
  const lock = createAntigravitySessionLock();
  await lock.acquire();
  const queued = lock.acquire();

  assert.equal(lock.snapshot().active, true);
  assert.equal(lock.snapshot().queued, 1);

  const reset = lock.reset({ reason: "test_reset" });
  assert.equal(reset.ok, true);
  assert.equal(reset.reason, "test_reset");
  assert.equal(reset.activeReleased, true);
  assert.equal(reset.queuedCancelled, 1);
  assert.equal(lock.snapshot().active, false);
  assert.equal(lock.snapshot().queued, 0);

  await assert.rejects(queued, (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });

  const next = await lock.acquire();
  next.release();
});
