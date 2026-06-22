import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityRequestQueue } from "../antigravity-request-queue.mjs";

test("Antigravity request queue runs tasks one at a time in arrival order", async () => {
  const queue = createAntigravityRequestQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run(async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    return "one";
  });
  const second = queue.run(async () => {
    order.push("second:start");
    return "two";
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);

  releaseFirst();
  assert.equal(await first, "one");
  assert.equal(await second, "two");
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("Antigravity request queue rejects a queued task cancelled before it starts", async () => {
  const queue = createAntigravityRequestQueue();
  const controller = new AbortController();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;

  const first = queue.run(async () => {
    await firstGate;
    return "first";
  });
  const second = queue.run(async () => {
    secondStarted = true;
    return "second";
  }, { signal: controller.signal });

  const reason = new DOMException("queued request cancelled", "AbortError");
  controller.abort(reason);
  releaseFirst();

  await first;
  await assert.rejects(second, (error) => {
    assert.equal(error, reason);
    return true;
  });
  assert.equal(secondStarted, false);
});

test("Antigravity request queue releases the next task after a failure", async () => {
  const queue = createAntigravityRequestQueue();
  const order = [];

  const first = queue.run(async () => {
    order.push("first");
    throw new Error("boom");
  });
  const second = queue.run(async () => {
    order.push("second");
    return "ok";
  });

  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
  assert.deepEqual(order, ["first", "second"]);
});

test("Antigravity request queue rejects overflow without disturbing accepted work", async () => {
  const queue = createAntigravityRequestQueue({ maxQueued: 1 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run(async () => {
    await firstGate;
    return "first";
  });
  const second = queue.run(async () => "second");

  await assert.rejects(
    queue.run(async () => "overflow"),
    (error) => {
      assert.equal(error.name, "AntigravityQueueFullError");
      assert.equal(error.statusCode, 429);
      assert.equal(error.type, "antigravity_queue_full");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.deepEqual(queue.snapshot(), {
    running: true,
    queued: 1,
    maxQueued: 1,
    accepted: 2,
    rejected: 1,
  });

  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(queue.snapshot().queued, 0);
});

test("Antigravity request queue keeps a bounded default for invalid configuration", () => {
  const queue = createAntigravityRequestQueue({ maxQueued: "not-a-number" });
  assert.equal(queue.snapshot().maxQueued, 32);
});

test("Antigravity request queue cancels active and queued work during shutdown", async () => {
  const queue = createAntigravityRequestQueue();
  let activeSignal;
  const active = queue.run(async ({ signal }) => {
    activeSignal = signal;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const queued = queue.run(async () => "must not start");

  await Promise.resolve();
  const result = queue.cancelAll();
  assert.deepEqual(result, { activeCancelled: true, queuedCancelled: 1 });
  await assert.rejects(active, /shutting down/);
  await assert.rejects(queued, /shutting down/);
  assert.equal(activeSignal.aborted, true);
  assert.equal(queue.snapshot().queued, 0);
});
