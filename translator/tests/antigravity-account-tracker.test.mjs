import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityAccountTracker } from "../antigravity-account-tracker.mjs";

function account(fingerprint) {
  return {
    identityAvailable: Boolean(fingerprint),
    fingerprint,
  };
}

test("account tracker establishes a baseline without refreshing", async () => {
  const changes = [];
  const tracker = createAntigravityAccountTracker({
    onChange: async (change) => changes.push(change),
  });

  const result = await tracker.observe(account("sha256:first"), { modelsPayload: { id: 1 } });

  assert.equal(result.observed, true);
  assert.equal(result.changed, false);
  assert.equal(tracker.getSnapshot().fingerprint, "sha256:first");
  assert.deepEqual(changes, []);
});

test("account tracker refreshes exactly once when identity changes", async () => {
  const changes = [];
  const tracker = createAntigravityAccountTracker({
    onChange: async (change) => changes.push(change),
  });

  await tracker.observe(account("sha256:first"));
  const changed = await tracker.observe(account("sha256:second"), {
    modelsPayload: { generation: 2 },
  });
  const repeated = await tracker.observe(account("sha256:second"), {
    modelsPayload: { generation: 3 },
  });

  assert.equal(changed.changed, true);
  assert.equal(changed.previousFingerprint, "sha256:first");
  assert.equal(changed.fingerprint, "sha256:second");
  assert.equal(repeated.changed, false);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].modelsPayload, { generation: 2 });
});

test("account tracker retries a failed hot refresh on the next observation", async () => {
  let attempts = 0;
  const tracker = createAntigravityAccountTracker({
    onChange: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("refresh failed");
    },
  });

  await tracker.observe(account("sha256:first"));
  await assert.rejects(
    tracker.observe(account("sha256:second")),
    /refresh failed/,
  );
  assert.equal(tracker.getSnapshot().fingerprint, "sha256:first");

  const retried = await tracker.observe(account("sha256:second"));
  assert.equal(retried.changed, true);
  assert.equal(attempts, 2);
  assert.equal(tracker.getSnapshot().fingerprint, "sha256:second");
});

test("account tracker ignores snapshots without identity proof", async () => {
  let changes = 0;
  const tracker = createAntigravityAccountTracker({
    onChange: async () => { changes += 1; },
  });

  const result = await tracker.observe(account(""));
  assert.equal(result.observed, false);
  assert.equal(result.changed, false);
  assert.equal(changes, 0);
});

test("account tracker can require repeated identity observations before refreshing", async () => {
  const changes = [];
  const tracker = createAntigravityAccountTracker({
    confirmationObservations: 2,
    onChange: async (change) => changes.push(change),
  });

  await tracker.observe(account("sha256:first"));
  const pending = await tracker.observe(account("sha256:second"));
  assert.equal(pending.changed, false);
  assert.equal(pending.pendingFingerprint, "sha256:second");
  assert.equal(pending.pendingObservations, 1);
  assert.equal(tracker.getSnapshot().fingerprint, "sha256:first");

  const changed = await tracker.observe(account("sha256:second"));
  assert.equal(changed.changed, true);
  assert.equal(changes.length, 1);
  assert.equal(tracker.getSnapshot().fingerprint, "sha256:second");
  assert.equal(tracker.getSnapshot().pendingFingerprint, "");
});

test("account tracker clears a pending identity when the current account returns", async () => {
  let changes = 0;
  const tracker = createAntigravityAccountTracker({
    confirmationObservations: 2,
    onChange: async () => { changes += 1; },
  });

  await tracker.observe(account("sha256:first"));
  await tracker.observe(account("sha256:transient"));
  const recovered = await tracker.observe(account("sha256:first"));

  assert.equal(recovered.changed, false);
  assert.equal(changes, 0);
  assert.equal(tracker.getSnapshot().pendingFingerprint, "");
  assert.equal(tracker.getSnapshot().pendingObservations, 0);
});

test("account tracker falls back to one confirmation for invalid configuration", async () => {
  let changes = 0;
  const tracker = createAntigravityAccountTracker({
    confirmationObservations: "not-a-number",
    onChange: async () => { changes += 1; },
  });

  await tracker.observe(account("sha256:first"));
  const changed = await tracker.observe(account("sha256:second"));
  assert.equal(changed.changed, true);
  assert.equal(changes, 1);
  assert.equal(tracker.getSnapshot().requiredObservations, 1);
});
