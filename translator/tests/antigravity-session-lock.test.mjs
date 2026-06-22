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

test("Antigravity session lock releases queued sessions when a tool continuation expires", async () => {
  const lock = createAntigravitySessionLock({ ttlMs: 20 });
  const first = await lock.acquire();
  first.continueWith("resp_waiting");

  const second = lock.acquire();
  assert.equal(lock.snapshot().queued, 1);

  const secondLease = await second;
  assert.equal(lock.snapshot().expired, 1);
  secondLease.release();
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
