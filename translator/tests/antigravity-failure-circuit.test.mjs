import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityFailureCircuit } from "../antigravity-failure-circuit.mjs";

test("Antigravity failure circuit opens after repeated transient failures", () => {
  let now = 1_000;
  const circuit = createAntigravityFailureCircuit({
    threshold: 2,
    cooldownMs: 5_000,
    now: () => now,
  });

  circuit.beforeRequest();
  circuit.recordFailure(new Error("proxy error: Failed to generate plan"));
  assert.equal(circuit.snapshot().state, "closed");
  assert.equal(circuit.snapshot().consecutiveFailures, 1);

  circuit.recordFailure(new Error("DEADLINE_EXCEEDED"));
  const open = circuit.snapshot();
  assert.equal(open.state, "open");
  assert.equal(open.consecutiveFailures, 2);
  assert.equal(open.retryAfterMs, 5_000);

  assert.throws(
    () => circuit.beforeRequest(),
    (error) => {
      assert.equal(error.name, "AntigravityCircuitOpenError");
      assert.equal(error.type, "antigravity_temporarily_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /cooling down/i);
      return true;
    },
  );

  now += 5_001;
  assert.doesNotThrow(() => circuit.beforeRequest());
  assert.equal(circuit.snapshot().state, "closed");
});

test("Antigravity failure circuit resets after success", () => {
  const circuit = createAntigravityFailureCircuit({
    threshold: 2,
    cooldownMs: 1_000,
    now: () => 10_000,
  });

  circuit.recordFailure(new Error("ECONNRESET"));
  assert.equal(circuit.snapshot().consecutiveFailures, 1);

  circuit.recordSuccess();
  assert.deepEqual(circuit.snapshot(), {
    state: "closed",
    consecutiveFailures: 0,
    openedUntil: null,
    retryAfterMs: 0,
    lastFailureMessage: "",
  });

  circuit.beforeRequest();
});

test("Antigravity failure circuit ignores non-transient failures", () => {
  const circuit = createAntigravityFailureCircuit({
    threshold: 1,
    cooldownMs: 1_000,
    now: () => 20_000,
  });

  circuit.recordFailure(new Error("Model not found"));

  assert.equal(circuit.snapshot().state, "closed");
  assert.equal(circuit.snapshot().consecutiveFailures, 0);
  assert.doesNotThrow(() => circuit.beforeRequest());
});

test("proxy recovery blocks during cooldown then automatically accepts the next request", async () => {
  let now = 100_000;
  const circuit = createAntigravityFailureCircuit({
    threshold: 1, // open on the first exhaustive failure
    cooldownMs: 5_000,
    now: () => now,
  });

  // Simulates the exact pattern from callQueuedAntigravityUpstream.
  // The upstream fn throws transient errors (simulating retry exhaustion)
  // or returns successfully (simulating proxy recovery).
  let upstreamCallCount = 0;
  let upstreamSucceeds = false;

  async function upstream() {
    upstreamCallCount++;
    if (!upstreamSucceeds) throw new Error("ECONNREFUSED");
    return { text: "recovered response" };
  }

  // Helper exactly matching callQueuedAntigravityUpstream's logic
  async function makeRequest() {
    circuit.beforeRequest();
    try {
      const result = await upstream();
      circuit.recordSuccess();
      return result;
    } catch (error) {
      if (error?.name !== "AbortError" && error?.name !== "AntigravityCircuitOpenError") {
        circuit.recordFailure(error);
      }
      throw error;
    }
  }

  // Proxy fails and the circuit opens.
  await assert.rejects(makeRequest, /ECONNREFUSED/);
  assert.equal(upstreamCallCount, 1);
  assert.equal(circuit.snapshot().state, "open", "circuit opens after exhaustive failure");

  // Circuit blocks without calling upstream.
  await assert.rejects(makeRequest, { name: "AntigravityCircuitOpenError" });
  assert.equal(
    upstreamCallCount, 1,
    "upstream must not be called when circuit is open",
  );

  // Proxy recovers, but the circuit is still in cooldown.
  upstreamSucceeds = true; // proxy is back, but circuit hasn't recovered yet
  now += 2_000; // mid-cooldown
  await assert.rejects(makeRequest, { name: "AntigravityCircuitOpenError" });
  assert.equal(
    upstreamCallCount, 1,
    "upstream still not called while the circuit is cooling down",
  );

  // Cooldown expires and the next request succeeds without a manual reset.
  now += 3_001; // total 5.001s past open time
  const result = await makeRequest();
  assert.deepEqual(result, { text: "recovered response" });
  assert.equal(upstreamCallCount, 2, "upstream called once after recovery");
  assert.deepEqual(
    circuit.snapshot(),
    {
      state: "closed",
      consecutiveFailures: 0,
      openedUntil: null,
      retryAfterMs: 0,
      lastFailureMessage: "",
    },
    "circuit fully clean after recovery and success",
  );
});
