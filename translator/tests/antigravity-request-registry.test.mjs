import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityRequestRegistry } from "../antigravity-request-registry.mjs";

test("registry cancels an attached cascade exactly once", async () => {
  const cancelled = [];
  const registry = createAntigravityRequestRegistry({
    cancelCascade: async (connection, cascadeId) => {
      cancelled.push({ connection, cascadeId });
    },
  });
  const controller = new AbortController();

  registry.register("resp_1", { controller });
  await registry.attachCascade("resp_1", {
    connection: { lsAddress: "127.0.0.1:1" },
    cascadeId: "cascade_1",
  });

  const first = await registry.cancel("resp_1");
  const second = await registry.cancel("resp_1");

  assert.equal(first.found, true);
  assert.equal(first.cancelled, true);
  assert.equal(second.alreadyCancelled, true);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(cancelled, [{
    connection: { lsAddress: "127.0.0.1:1" },
    cascadeId: "cascade_1",
  }]);
});

test("registry cancels a cascade attached after cancellation began", async () => {
  const cancelled = [];
  const registry = createAntigravityRequestRegistry({
    cancelCascade: async (_connection, cascadeId) => {
      cancelled.push(cascadeId);
    },
  });
  const controller = new AbortController();

  registry.register("resp_2", { controller });
  const result = await registry.cancel("resp_2");
  await registry.attachCascade("resp_2", {
    connection: {},
    cascadeId: "cascade_late",
  });

  assert.equal(result.cancelled, true);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(cancelled, ["cascade_late"]);
});

test("completed requests are removed and cannot be cancelled", async () => {
  const registry = createAntigravityRequestRegistry({
    cancelCascade: async () => assert.fail("completed request must not cancel"),
  });

  registry.register("resp_3");
  assert.equal(registry.finish("resp_3"), true);
  assert.deepEqual(await registry.cancel("resp_3"), { found: false, cancelled: false });
});

test("registry cancels and removes every active request during shutdown", async () => {
  const cancelled = [];
  const registry = createAntigravityRequestRegistry({
    cancelCascade: async (_connection, cascadeId) => { cancelled.push(cascadeId); },
  });

  registry.register("resp_4");
  registry.register("resp_5");
  await registry.attachCascade("resp_4", { connection: {}, cascadeId: "cascade_4" });
  await registry.attachCascade("resp_5", { connection: {}, cascadeId: "cascade_5" });
  assert.deepEqual(registry.snapshot(), { active: 2, statuses: { active: 2 } });

  const result = await registry.cancelAll();
  assert.deepEqual(result, { requested: 2, cancelled: 2, failed: 0 });
  assert.deepEqual(cancelled.sort(), ["cascade_4", "cascade_5"]);
  assert.deepEqual(registry.snapshot(), { active: 0, statuses: {} });
});

test("registry cancelAll releases local requests even when cascade cancellation stalls", async () => {
  const registry = createAntigravityRequestRegistry({
    cascadeCancelTimeoutMs: 10,
    cancelCascade: async () => new Promise(() => {}),
  });

  registry.register("resp_stalled");
  await registry.attachCascade("resp_stalled", { connection: {}, cascadeId: "cascade_stalled" });

  const startedAt = Date.now();
  const result = await registry.cancelAll();

  assert.equal(result.requested, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.failed, 0);
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(registry.snapshot(), { active: 0, statuses: {} });
});

test("registry can include active request fingerprints for reset replay blocking", () => {
  const registry = createAntigravityRequestRegistry();

  registry.register("resp_fingerprint", { fingerprint: "fp_123" });

  assert.deepEqual(registry.snapshot({ includeEntries: true }), {
    active: 1,
    statuses: { active: 1 },
    entries: [{ responseId: "resp_fingerprint", status: "active", fingerprint: "fp_123" }],
  });
});
