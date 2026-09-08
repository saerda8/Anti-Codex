import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAntigravityAccountManager,
  normalizeAccountQuota,
} from "../../scripts/anticodex-antigravity-accounts.mjs";
import { createAntigravityAccountDriver } from "../../scripts/anticodex-antigravity-accounts-driver.mjs";

const SCHEMA = "anticodex-antigravity-accounts-v1";

function account(email, suffix = "one") {
  const normalized = email.toLowerCase();
  return {
    id: `sha256:${createHash("sha256").update(normalized).digest("hex")}`,
    maskedEmail: `${normalized.slice(0, 2)}${"*".repeat(Math.max(1, normalized.indexOf("@") - 2))}${normalized.slice(normalized.indexOf("@"))}`,
    sealed: `dpapi:v1:${Buffer.from(`sealed-${suffix}`).toString("base64")}`,
    credentialHash: createHash("sha256").update(`credential-${suffix}`).digest("hex"),
  };
}

function rawQuota(group = "Gemini", remaining = 0.75) {
  return {
    status: "SUCCESS",
    num_turns: 0,
    command: {
      name: "usage",
      data: {
        groups: [{
          name: group,
          family_label: `${group} family`,
          buckets: [
            { window: "weekly", remaining_fraction: remaining, reset_time: "2026-09-15T00:00:00Z" },
            { window: "5h", remaining_fraction: 0, reset_time: null },
          ],
        }],
      },
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function makeDriver(entries, currentId) {
  const records = new Map(entries.map((entry) => [entry.capture.id, entry]));
  const sealedIds = new Map(entries.map((entry) => [entry.capture.sealed, entry.capture.id]));
  const calls = [];
  const driver = {
    currentId,
    desktopRunning: true,
    calls,
    async quota() {
      calls.push(`quota:${this.currentId}`);
      const record = records.get(this.currentId);
      if (record?.quotaError) throw record.quotaError;
      return clone(record.quota);
    },
    async capture() {
      calls.push(`capture:${this.currentId}`);
      const record = records.get(this.currentId);
      return clone(record.captureOverride || record.capture);
    },
    async restore(sealed) {
      const id = sealedIds.get(sealed);
      calls.push(`restore:${id || "unknown"}`);
      if (!id) throw new Error("unknown sealed credential");
      this.currentId = id;
    },
    async beginChange(options) {
      calls.push(`begin:${options?.acknowledgeRestart === true}`);
      return { wasRunning: true };
    },
    async endChange(context) {
      calls.push(`end:${context?.wasRunning === true}`);
    },
    async openDesktop() {
      calls.push("open");
      this.desktopRunning = true;
    },
    async hasDesktop() {
      calls.push(`hasDesktop:${this.desktopRunning}`);
      return this.desktopRunning;
    },
    async desktopIdentity() {
      calls.push(`desktop:${this.currentId}`);
      return this.currentId;
    },
  };
  return driver;
}

async function fixture(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), "anticodex-antigravity-accounts-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  return stateRoot;
}

async function seedState(stateRoot, accounts, activeId) {
  await writeFile(join(stateRoot, "antigravity-accounts.json"), `${JSON.stringify({
    schema: SCHEMA,
    activeId,
    accounts: accounts.map((value) => ({ ...value.capture, label: value.label, quota: normalizeAccountQuota(value.quota) })),
  }, null, 2)}\n`, { mode: 0o600 });
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /dpapi:v1:|credentialHash|access_token|refresh_token|auth_method/i);
}

test("normalizes quota without guessing group labels or unknown percentages", () => {
  const quota = normalizeAccountQuota({
    status: "SUCCESS",
    num_turns: 0,
    command: { name: "usage", data: { groups: [
      {
        name: "Claude and GPT",
        family_label: "原始 Claude/GPT 标签",
        buckets: [
          { window: "weekly", remaining_fraction: 0, reset_time: "2026-09-15T00:00:00Z" },
          { window: "5h", remaining_fraction: null, reset_time: null },
          { window: "future", remaining_fraction: 2, reset_time: "not-a-date" },
          { remaining_fraction: -1 },
        ],
      },
      { display_name: "Gemini 原始标签", buckets: [{ window: "weekly" }] },
    ] } },
  });

  assert.equal(quota.status, "SUCCESS");
  assert.equal(quota.num_turns, 0);
  assert.equal(quota.groups[0].name, "Claude and GPT");
  assert.equal(quota.groups[0].family_label, "原始 Claude/GPT 标签");
  assert.deepEqual(quota.groups[0].buckets.map((bucket) => bucket.remaining_fraction), [0, null, null, null]);
  assert.deepEqual(quota.groups[0].buckets.map((bucket) => bucket.reset_time), ["2026-09-15T00:00:00Z", null, null, null]);
  assert.equal(quota.groups[0].buckets[3].window, null);
  assert.equal(quota.groups[1].display_name, "Gemini 原始标签");
  assert.equal(quota.groups[1].buckets[0].remaining_fraction, null);
});

test("captureCurrent refreshes quota first, deduplicates, and records the actual active identity", async (t) => {
  const stateRoot = await fixture(t);
  const old = { capture: account("old@example.com", "old"), quota: rawQuota("Old"), label: "Old" };
  const fresh = { capture: account("fresh@example.com", "fresh"), quota: rawQuota("Gemini", 0), label: "Fresh" };
  await seedState(stateRoot, [old], old.capture.id);
  const driver = makeDriver([old, fresh], fresh.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.captureCurrent({ label: "Fresh login" });
  const listed = await manager.list();

  assert.deepEqual(driver.calls.slice(0, 2), [`quota:${fresh.capture.id}`, `capture:${fresh.capture.id}`]);
  assert.equal(result.id, fresh.capture.id);
  assert.equal(listed.activeId, fresh.capture.id);
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts.find((value) => value.id === fresh.capture.id).quota.groups[0].buckets[1].remaining_fraction, 0);
  assert.match(listed.accounts.find((value) => value.id === fresh.capture.id).quota.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assertNoSecrets(result);
  assertNoSecrets(listed);
  const saved = JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8"));
  assert.equal(saved.accounts.find((value) => value.id === fresh.capture.id).sealed, fresh.capture.sealed);
  if (process.platform !== "win32") assert.equal((await stat(join(stateRoot, "antigravity-accounts.json"))).mode & 0o777, 0o600);
});

test("captureCurrent refuses a missing official credential before quota or capture", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("missing@example.com", "missing"), quota: rawQuota(), label: "Missing" };
  const driver = makeDriver([current], current.capture.id);
  driver.hasCredential = async () => {
    driver.calls.push("hasCredential:false");
    return false;
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.captureCurrent(), /official Antigravity.*login|先.*官方.*登录/i);

  assert.deepEqual(driver.calls, ["hasCredential:false"]);
});

test("successful login keeps the new account active and opens Desktop", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota("Previous"), label: "Previous" };
  const added = { capture: account("added@example.com", "added"), quota: rawQuota("Added", 0.6), label: "Added" };
  await seedState(stateRoot, [previous], previous.capture.id);
  const driver = makeDriver([previous, added], previous.capture.id);
  driver.login = async () => {
    driver.calls.push("login");
    driver.currentId = added.capture.id;
  };
  driver.hasCredential = async () => true;
  const manager = createAntigravityAccountManager({ stateRoot, driver });
  const progress = [];

  const result = await manager.login({ label: "New account", acknowledgeRestart: true, onProgress: (message) => progress.push(message) });

  assert.equal(result.activeId, added.capture.id);
  assert.equal(driver.currentId, added.capture.id);
  assert.equal(result.accounts.find((value) => value.id === added.capture.id).label, "New account");
  assert.deepEqual(driver.calls, [
    "begin:true",
    `quota:${previous.capture.id}`,
    `capture:${previous.capture.id}`,
    "login",
    `quota:${added.capture.id}`,
    `capture:${added.capture.id}`,
    "open",
    `desktop:${added.capture.id}`,
  ]);
  assert.equal(progress.at(-1), "账号已启用，Antigravity 已打开并完成登录核验。");
  assertNoSecrets(result);
});

test("same-identity re-login keeps and persists the newly authorized sealed credential", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("same@example.com", "old-token"), quota: rawQuota("Previous"), label: "Previous" };
  const reauthorized = { ...previous, capture: account("same@example.com", "new-token"), quota: rawQuota("Reauthorized", 0.9) };
  await seedState(stateRoot, [previous], previous.capture.id);
  const driver = makeDriver([previous], previous.capture.id);
  let loginComplete = false;
  let restoredSealed = "";
  driver.hasCredential = async () => true;
  driver.login = async () => { loginComplete = true; };
  driver.quota = async () => clone(loginComplete ? reauthorized.quota : previous.quota);
  driver.capture = async () => clone(loginComplete ? reauthorized.capture : previous.capture);
  driver.restore = async (sealed) => { restoredSealed = sealed; };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.login({ label: "Reauthorized", acknowledgeRestart: true });

  assert.equal(restoredSealed, "");
  assert.equal(result.activeId, previous.capture.id);
  assert.equal(result.accounts.length, 1);
  const saved = JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8"));
  assert.equal(saved.accounts[0].sealed, reauthorized.capture.sealed);
  assert.equal(saved.accounts[0].credentialHash, reauthorized.capture.credentialHash);
});

test("failed login is cancelled before restoring the previous credential", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota("Previous"), label: "Previous" };
  const added = { capture: account("added@example.com", "added"), quota: rawQuota("Added"), label: "Added" };
  await seedState(stateRoot, [previous], previous.capture.id);
  const driver = makeDriver([previous, added], previous.capture.id);
  driver.login = async () => {
    driver.calls.push("login:failed");
    driver.currentId = added.capture.id;
    throw new Error("login failed");
  };
  driver.cancelLogin = async () => { driver.calls.push("cancel"); };
  driver.hasCredential = async () => true;
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.login({ label: "Added", acknowledgeRestart: true }), /login failed/i);

  assert.equal(driver.currentId, previous.capture.id);
  assert.ok(driver.calls.indexOf("cancel") < driver.calls.indexOf(`restore:${previous.capture.id}`));
  assert.equal(JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8")).activeId, previous.capture.id);
});

test("unsafe login failure before new identity capture clears activeId without restoring credentials", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota("Previous"), label: "Previous" };
  const unknown = { capture: account("unknown@example.com", "unknown"), quota: rawQuota("Unknown"), label: "Unknown" };
  await seedState(stateRoot, [previous], previous.capture.id);
  const driver = makeDriver([previous, unknown], previous.capture.id);
  driver.hasCredential = async () => true;
  driver.login = async () => {
    driver.calls.push("login:unsafe");
    driver.currentId = unknown.capture.id;
    const error = new Error("desktop may still be running synthetic-secret");
    error.credentialRestoreUnsafe = true;
    throw error;
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.login({ label: "Unknown", acknowledgeRestart: true }), /当前账号未知|account.*unknown/i);

  assert.equal(driver.calls.filter((call) => call.startsWith("restore:")).length, 0);
  assert.equal(driver.calls.filter((call) => call.startsWith("end:")).length, 0);
  const saved = JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8"));
  assert.equal(saved.activeId, null);
  assert.equal(saved.accounts[0].sealed, previous.capture.sealed);
  const listed = await manager.list();
  assert.equal(listed.activeId, null);
  assertNoSecrets(listed);
});

test("list reads the last committed snapshot while a mutation is pending", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("busy@example.com", "busy"), quota: rawQuota(), label: "Busy" };
  await seedState(stateRoot, [current], current.capture.id);
  let release;
  const driver = makeDriver([current], current.capture.id);
  driver.quota = async () => new Promise((resolve) => { release = () => resolve(current.quota); });
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const first = manager.captureCurrent();
  await new Promise((resolve) => setImmediate(resolve));
  const pendingSnapshot = await manager.list();
  assert.equal(pendingSnapshot.activeId, current.capture.id);
  assert.equal(pendingSnapshot.accounts[0].label, "Busy");
  await assert.rejects(manager.rename({ id: current.capture.id, label: "Blocked" }), /operation.*progress/i);
  release();
  await first;
});

test("login records a prior credential from an empty vault but keeps the new account active", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("outside@example.com", "outside"), quota: rawQuota("Outside"), label: "Outside" };
  const added = { capture: account("added@example.com", "added"), quota: rawQuota("Added"), label: "Added" };
  const driver = makeDriver([previous, added], previous.capture.id);
  driver.hasCredential = async () => true;
  driver.login = async () => { driver.currentId = added.capture.id; };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.login({ label: "Added", acknowledgeRestart: true });

  assert.equal(driver.currentId, added.capture.id);
  assert.equal(result.activeId, added.capture.id);
  assert.deepEqual(new Set(result.accounts.map((value) => value.id)), new Set([previous.capture.id, added.capture.id]));
});

test("login saves an unmanaged prior identity but keeps the new account active", async (t) => {
  const stateRoot = await fixture(t);
  const managed = { capture: account("managed@example.com", "managed"), quota: rawQuota("Managed"), label: "Managed" };
  const outside = { capture: account("outside@example.com", "outside"), quota: rawQuota("Outside"), label: "Outside" };
  const added = { capture: account("added@example.com", "added"), quota: rawQuota("Added"), label: "Added" };
  await seedState(stateRoot, [managed], managed.capture.id);
  const driver = makeDriver([managed, outside, added], outside.capture.id);
  driver.hasCredential = async () => true;
  driver.login = async () => { driver.currentId = added.capture.id; };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.login({ label: "Added", acknowledgeRestart: true });

  assert.equal(result.activeId, added.capture.id);
  assert.equal(result.accounts.find((value) => value.id === outside.capture.id).label, outside.capture.maskedEmail);
  assert.equal(driver.currentId, added.capture.id);
});

test("first login stays active when the fixed credential did not previously exist", async (t) => {
  const stateRoot = await fixture(t);
  const added = { capture: account("first@example.com", "first"), quota: rawQuota("First"), label: "First" };
  const driver = makeDriver([added], added.capture.id);
  driver.hasCredential = async () => false;
  driver.login = async () => {};
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.login({ label: "First", acknowledgeRestart: true });

  assert.equal(result.activeId, added.capture.id);
  assert.equal(driver.currentId, added.capture.id);
});

test("list re-sanitizes persisted quota and preserves only a valid fetchedAt", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("dirty@example.com", "dirty"), quota: rawQuota("Dirty"), label: "Dirty" };
  const fetchedAt = "2026-09-08T12:34:56.000Z";
  await writeFile(join(stateRoot, "antigravity-accounts.json"), `${JSON.stringify({
    schema: SCHEMA,
    activeId: current.capture.id,
    accounts: [{
      ...current.capture,
      label: current.label,
      quota: {
        status: "SUCCESS",
        num_turns: 0,
        fetchedAt,
        access_token: "root-secret",
        groups: [{
          name: "Gemini",
          refresh_token: "group-secret",
          buckets: [{
            window: "5h",
            remaining_fraction: 0.5,
            reset_time: "2026-09-08T17:00:00Z",
            credentialHash: "bucket-secret",
          }],
        }],
      },
    }],
  })}\n`, { mode: 0o600 });
  const manager = createAntigravityAccountManager({ stateRoot, driver: makeDriver([current], current.capture.id) });

  const result = await manager.list();

  assert.equal(result.accounts[0].quota.fetchedAt, fetchedAt);
  assert.equal(result.accounts[0].quota.groups[0].buckets[0].remaining_fraction, 0.5);
  assertNoSecrets(result);
});

test("invalid activation performs no driver writes", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("current@example.com", "current"), quota: rawQuota(), label: "Current" };
  await seedState(stateRoot, [current], current.capture.id);
  const driver = makeDriver([current], current.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.activate({ id: `sha256:${"f".repeat(64)}`, acknowledgeRestart: true }), /does not exist/i);
  assert.deepEqual(driver.calls, []);
});

test("same-account activation confirms the real identity without restarting", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("same@example.com", "same"), quota: rawQuota(), label: "Same" };
  await seedState(stateRoot, [current], current.capture.id);
  const driver = makeDriver([current], current.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.activate({ id: current.capture.id, acknowledgeRestart: false });

  assert.equal(result.activeId, current.capture.id);
  assert.deepEqual(driver.calls, ["hasDesktop:true", "open", `desktop:${current.capture.id}`]);
});

test("different-account activation falls back to quota when current credential capture is expired", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("expired@example.com", "expired"), quota: rawQuota("Current", 0.5), label: "Current" };
  const target = { capture: account("target@example.com", "target"), quota: rawQuota("Target", 0.4), label: "Target" };
  await seedState(stateRoot, [current, target], current.capture.id);
  let refreshed = false;
  let captureAttempts = 0;
  const driver = makeDriver([current, target], current.capture.id);
  driver.quota = async () => {
    driver.calls.push(`quota:${driver.currentId}`);
    if (driver.currentId === current.capture.id) refreshed = true;
    return clone(driver.currentId === current.capture.id ? current.quota : target.quota);
  };
  driver.capture = async () => {
    driver.calls.push(`capture:${driver.currentId}`);
    captureAttempts += 1;
    if (driver.currentId === current.capture.id && !refreshed) throw new Error("expired access token");
    return clone(driver.currentId === current.capture.id ? current.capture : target.capture);
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await manager.activate({ id: target.capture.id, acknowledgeRestart: true });

  assert.ok(captureAttempts >= 4);
  assert.deepEqual(driver.calls.slice(0, 6), [
    "hasDesktop:true",
    "open",
    `desktop:${current.capture.id}`,
    `capture:${current.capture.id}`,
    `quota:${current.capture.id}`,
    `capture:${current.capture.id}`,
  ]);
});

test("activation saves the latest previous credential and commits the target identity last", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "old-copy"), quota: rawQuota("Previous"), label: "Previous" };
  const latestPrevious = { ...previous, capture: account("previous@example.com", "latest-copy") };
  const target = { capture: account("target@example.com", "target"), quota: rawQuota("Target"), label: "Target" };
  await seedState(stateRoot, [previous, target], previous.capture.id);
  const driver = makeDriver([latestPrevious, target], latestPrevious.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.activate({ id: target.capture.id, acknowledgeRestart: true });

  assert.equal(result.activeId, target.capture.id);
  assert.deepEqual(driver.calls, [
    "hasDesktop:true",
    "open",
    `desktop:${previous.capture.id}`,
    `capture:${previous.capture.id}`,
    "begin:true",
    `capture:${previous.capture.id}`,
    `restore:${target.capture.id}`,
    `quota:${target.capture.id}`,
    `capture:${target.capture.id}`,
    "open",
    `desktop:${target.capture.id}`,
  ]);
  const saved = JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8"));
  assert.equal(saved.accounts.find((value) => value.id === previous.capture.id).sealed, latestPrevious.capture.sealed);
  assert.equal(saved.activeId, target.capture.id);
  assertNoSecrets(result);
});

test("activation restores the previous credential and active id on identity mismatch", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota("Previous"), label: "Previous" };
  const target = { capture: account("target@example.com", "target"), quota: rawQuota("Target"), label: "Target" };
  const wrong = account("wrong@example.com", "wrong");
  target.captureOverride = wrong;
  await seedState(stateRoot, [previous, target], previous.capture.id);
  const before = await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8");
  const driver = makeDriver([previous, target], previous.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.activate({ id: target.capture.id, acknowledgeRestart: true }), /identity.*mismatch/i);

  assert.equal(driver.currentId, previous.capture.id);
  assert.match(driver.calls.join("\n"), new RegExp(`restore:${previous.capture.id}`));
  assert.equal(JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8")).activeId, previous.capture.id);
  assert.equal(JSON.parse(before).accounts.find((value) => value.id === target.capture.id).quota.groups[0].name, "Target");
});

test("activation rolls back credentials when the final state write fails", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota("Previous"), label: "Previous" };
  const target = { capture: account("target@example.com", "target"), quota: rawQuota("Target"), label: "Target" };
  await seedState(stateRoot, [previous, target], previous.capture.id);
  const driver = makeDriver([previous, target], previous.capture.id);
  let failed = false;
  const manager = createAntigravityAccountManager({
    stateRoot,
    driver,
    async writeState(path, state, writeDefault) {
      if (!failed && state.activeId === target.capture.id) {
        failed = true;
        throw new Error("injected state write failure");
      }
      return writeDefault(path, state);
    },
  });

  await assert.rejects(manager.activate({ id: target.capture.id, acknowledgeRestart: true }), /injected state write failure/i);
  assert.equal(driver.currentId, previous.capture.id);
  assert.equal(JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8")).activeId, previous.capture.id);
});

test("cleanup failures are reported while rolling back a failed activation", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota(), label: "Previous" };
  const target = { capture: account("target@example.com", "target"), quota: rawQuota(), label: "Target" };
  target.captureOverride = account("wrong@example.com", "wrong");
  await seedState(stateRoot, [previous, target], previous.capture.id);
  const driver = makeDriver([previous, target], previous.capture.id);
  driver.endChange = async () => {
    driver.calls.push("end:failed");
    throw new Error("resume failed");
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.activate({ id: target.capture.id, acknowledgeRestart: true }), /resume failed/i);
  assert.equal(driver.currentId, previous.capture.id);
  assert.equal(JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8")).activeId, previous.capture.id);
});

test("unsafe post-open failure keeps a committed target and never restores the previous credential", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota(), label: "Previous" };
  const target = { capture: account("target@example.com", "target"), quota: rawQuota(), label: "Target" };
  await seedState(stateRoot, [previous, target], previous.capture.id);
  const driver = makeDriver([previous, target], previous.capture.id);
  let opens = 0;
  driver.openDesktop = async () => {
    opens += 1;
    driver.calls.push("open");
    if (driver.currentId === target.capture.id) {
      const error = new Error("resume ownership uncertain");
      error.credentialRestoreUnsafe = true;
      throw error;
    }
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(
    manager.activate({ id: target.capture.id, acknowledgeRestart: true }),
    /状态已保存.*启动未确认|state was saved.*startup was not confirmed/i,
  );

  assert.equal(driver.currentId, target.capture.id);
  assert.equal(driver.calls.filter((call) => call === `restore:${previous.capture.id}`).length, 0);
  assert.equal(JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8")).activeId, target.capture.id);
});

test("unsafe login post-open failure preserves the newly active account without restoring the old credential", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota(), label: "Previous" };
  const added = { capture: account("added@example.com", "added"), quota: rawQuota(), label: "Added" };
  await seedState(stateRoot, [previous], previous.capture.id);
  const driver = makeDriver([previous, added], previous.capture.id);
  driver.hasCredential = async () => true;
  driver.login = async () => { driver.currentId = added.capture.id; };
  driver.openDesktop = async () => {
    const error = new Error("resume ownership uncertain");
    error.credentialRestoreUnsafe = true;
    throw error;
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.login({ label: "Added", acknowledgeRestart: true }), /启动未确认|startup was not confirmed/i);

  assert.equal(driver.currentId, added.capture.id);
  assert.equal(driver.calls.filter((call) => call.startsWith("restore:")).length, 0);
  const saved = JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8"));
  assert.equal(saved.activeId, added.capture.id);
  assert.ok(saved.accounts.some((accountValue) => accountValue.id === added.capture.id));
});

test("successful activation opens Desktop even when it was originally closed", async (t) => {
  const stateRoot = await fixture(t);
  const previous = { capture: account("previous@example.com", "previous"), quota: rawQuota(), label: "Previous" };
  const target = { capture: account("target@example.com", "target"), quota: rawQuota(), label: "Target" };
  await seedState(stateRoot, [previous, target], previous.capture.id);
  const driver = makeDriver([previous, target], previous.capture.id);
  driver.desktopRunning = false;
  driver.beginChange = async () => {
    driver.calls.push("begin:false");
    return { wasRunning: false };
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await manager.activate({ id: target.capture.id, acknowledgeRestart: true });

  assert.equal(driver.calls[0], "hasDesktop:false");
  assert.equal(driver.calls.filter((call) => call === "open").length, 1);
  assert.ok(driver.calls.indexOf("open") > driver.calls.indexOf(`restore:${target.capture.id}`));
  assert.equal(driver.calls.at(-2), "open");
  assert.equal(driver.calls.at(-1), `desktop:${target.capture.id}`);
});

test("activation reports only fixed safe progress messages", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("progress@example.com", "progress"), quota: rawQuota(), label: "Progress" };
  await seedState(stateRoot, [current], current.capture.id);
  const driver = makeDriver([current], current.capture.id);
  const messages = [];
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await manager.activate({ id: current.capture.id, onProgress: (message) => messages.push(message) });

  assert.deepEqual(messages, ["正在打开 Antigravity。", "正在核对当前账号。", "账号已启用，Antigravity 已打开并完成登录核验。"]);
  assert.doesNotMatch(messages.join("\n"), /progress@example|sha256|dpapi/i);
});

test("refreshing an inactive account uses one restart boundary and restores the latest active credential", async (t) => {
  const stateRoot = await fixture(t);
  const activeStored = { capture: account("active@example.com", "active-old"), quota: rawQuota("Active", 0.4), label: "Active" };
  const activeLatest = { ...activeStored, capture: account("active@example.com", "active-latest"), quota: rawQuota("Active", 0.3) };
  const inactive = { capture: account("inactive@example.com", "inactive"), quota: rawQuota("Claude and GPT", 0.2), label: "Inactive" };
  await seedState(stateRoot, [activeStored, inactive], activeStored.capture.id);
  const driver = makeDriver([activeLatest, inactive], activeLatest.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const result = await manager.refresh({ id: inactive.capture.id, acknowledgeRestart: true });

  assert.equal(result.activeId, activeStored.capture.id);
  assert.equal(driver.currentId, activeStored.capture.id);
  assert.equal(driver.calls.filter((call) => call.startsWith("begin:")).length, 1);
  assert.equal(driver.calls.filter((call) => call.startsWith("end:")).length, 1);
  assert.equal(result.accounts.find((value) => value.id === inactive.capture.id).quota.groups[0].name, "Claude and GPT");
  const saved = JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8"));
  assert.equal(saved.accounts.find((value) => value.id === activeStored.capture.id).sealed, activeLatest.capture.sealed);
  assertNoSecrets(result);
});

test("failed inactive refresh restores the active credential and preserves prior snapshots", async (t) => {
  const stateRoot = await fixture(t);
  const active = { capture: account("active@example.com", "active"), quota: rawQuota("Active", 0.4), label: "Active" };
  const inactive = { capture: account("inactive@example.com", "inactive"), quota: rawQuota("Inactive", 0.2), label: "Inactive", quotaError: new Error("quota failed") };
  await seedState(stateRoot, [active, inactive], active.capture.id);
  const before = await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8");
  const driver = makeDriver([active, inactive], active.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.refresh({ id: inactive.capture.id, acknowledgeRestart: true }), /quota failed/i);

  assert.equal(driver.currentId, active.capture.id);
  assert.equal(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8"), before);
});

test("unsafe refresh resume failure keeps the committed snapshots without rewriting credentials", async (t) => {
  const stateRoot = await fixture(t);
  const active = { capture: account("active@example.com", "active"), quota: rawQuota("Active", 0.4), label: "Active" };
  const inactive = { capture: account("inactive@example.com", "inactive"), quota: rawQuota("Inactive", 0.2), label: "Inactive" };
  await seedState(stateRoot, [active, inactive], active.capture.id);
  const driver = makeDriver([active, inactive], active.capture.id);
  driver.endChange = async () => {
    const error = new Error("resume ownership uncertain");
    error.credentialRestoreUnsafe = true;
    throw error;
  };
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  await assert.rejects(manager.refresh({ id: inactive.capture.id, acknowledgeRestart: true }), /启动未确认|startup was not confirmed/i);

  assert.equal(driver.currentId, active.capture.id);
  assert.equal(driver.calls.filter((call) => call === `restore:${active.capture.id}`).length, 1);
  assert.match(JSON.parse(await readFile(join(stateRoot, "antigravity-accounts.json"), "utf8")).accounts[1].quota.fetchedAt, /^\d{4}-/);
});

test("malformed vault errors never echo credential-bearing file content", async (t) => {
  const stateRoot = await fixture(t);
  await writeFile(join(stateRoot, "antigravity-accounts.json"), '{"synthetic-secret":"must-not-echo",');
  const current = { capture: account("safe@example.com", "safe"), quota: rawQuota(), label: "Safe" };
  const manager = createAntigravityAccountManager({ stateRoot, driver: makeDriver([current], current.capture.id) });

  await assert.rejects(manager.list(), (error) => {
    assert.match(error.message, /account store is invalid/i);
    assert.doesNotMatch(error.message, /must-not-echo|synthetic-secret/i);
    return true;
  });
});

test("rename and remove never expose or modify the live credential", async (t) => {
  const stateRoot = await fixture(t);
  const current = { capture: account("remove@example.com", "remove"), quota: rawQuota(), label: "Old" };
  await seedState(stateRoot, [current], current.capture.id);
  const driver = makeDriver([current], current.capture.id);
  const manager = createAntigravityAccountManager({ stateRoot, driver });

  const renamed = await manager.rename({ id: current.capture.id, label: "Renamed" });
  const removed = await manager.remove({ id: current.capture.id });

  assert.equal(renamed.accounts[0].label, "Renamed");
  assert.equal(removed.activeId, null);
  assert.deepEqual(removed.accounts, []);
  assert.deepEqual(driver.calls, []);
  assertNoSecrets(renamed);
  assertNoSecrets(removed);
});

test("Windows driver keeps sealed credentials on stdin and exposes only allowlisted capture fields", async () => {
  const captured = account("driver@example.com", "driver");
  const calls = [];
  const runner = async (request) => {
    calls.push(clone(request));
    if (request.kind === "powershell" && request.action === "Capture") {
      return JSON.stringify({ ...captured, access_token: "must-not-return", extra: "drop" });
    }
    if (request.kind === "powershell" && request.action === "Restore") return JSON.stringify({ ok: true });
    throw new Error("unexpected request");
  };
  const driver = createAntigravityAccountDriver({ scriptsRoot: "C:\\fixed-scripts", runner, env: { LOCALAPPDATA: "C:\\local" } });

  assert.deepEqual(await driver.capture(), captured);
  await driver.restore(captured.sealed);

  assert.deepEqual(calls[0], {
    kind: "powershell",
    action: "Capture",
    script: "C:\\fixed-scripts\\anticodex-antigravity-credentials.ps1",
    input: {},
  });
  assert.equal(calls[1].action, "Restore");
  assert.deepEqual(calls[1].input, { sealed: captured.sealed });
  assert.doesNotMatch(JSON.stringify(calls[1]), /access_token|refresh_token/);
});

test("Windows driver rejects invalid sealed credentials before invoking a process", async () => {
  let called = false;
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\local" },
    runner: async () => { called = true; },
  });

  await assert.rejects(driver.restore("plain-token"), /sealed credential is invalid/i);
  assert.equal(called, false);
});

test("Windows driver runs only the fixed official usage command and strips unrelated output", async () => {
  const calls = [];
  const payload = rawQuota("Claude and GPT", 0.25);
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
    runner: async (request) => {
      calls.push(clone(request));
      return JSON.stringify({ ...payload, unrelated: { access_token: "drop" } });
    },
  });

  const result = await driver.quota();

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.num_turns, 0);
  assert.equal(result.command.name, "usage");
  assert.equal(result.command.data.groups[0].name, "Claude and GPT");
  assert.deepEqual(calls, [{
    kind: "usage",
    file: "C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe",
    args: ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"],
    input: "",
  }]);
  assertNoSecrets(result);
});

test("Windows driver validates restart acknowledgement and resume context", async () => {
  const calls = [];
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\local" },
    runner: async (request) => {
      calls.push(clone(request));
      return JSON.stringify(request.action === "PauseDesktop" ? { wasRunning: true, exePath: "drop" } : { ok: true });
    },
  });

  await assert.rejects(driver.beginChange({ acknowledgeRestart: false }), /acknowledgement/i);
  const context = await driver.beginChange({ acknowledgeRestart: true });
  assert.deepEqual(context, { wasRunning: true });
  await assert.rejects(driver.endChange({ wasRunning: true, exePath: "C:\\evil.exe" }), /context is invalid/i);
  await driver.endChange(context);

  assert.deepEqual(calls.map((call) => [call.action, call.input]), [
    ["PauseDesktop", { acknowledgeRestart: true }],
    ["ResumeDesktop", { wasRunning: true }],
  ]);
});

test("Windows driver opens or focuses Desktop through the fixed account-switch script", async () => {
  const calls = [];
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\local" },
    runner: async (request) => {
      calls.push(clone(request));
      return JSON.stringify({ ok: true, launched: false, reused: true, focused: true });
    },
  });

  await driver.openDesktop();

  assert.deepEqual(calls, [{
    kind: "open",
    script: "C:\\fixed-scripts\\open-antigravity-account-switch.ps1",
    input: "",
  }]);
});

test("Windows driver checks Desktop state without opening it", async () => {
  const calls = [];
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\local" },
    runner: async (request) => {
      calls.push(clone(request));
      return JSON.stringify({ running: false });
    },
  });

  assert.equal(await driver.hasDesktop(), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "HasDesktop");
});

test("Windows driver verifies the opened Desktop account through native GetUserStatus", async () => {
  const email = "native@example.com";
  const expected = account(email, "native").id;
  let requested = false;
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\local" },
    runner: async () => "{}",
    findDesktopConnection: () => ({ lsAddress: "127.0.0.1:49152", csrfToken: "synthetic-csrf" }),
    fetchImpl: async (url, options) => {
      requested = true;
      assert.equal(url, "http://127.0.0.1:49152/exa.language_server_pb.LanguageServerService/GetUserStatus");
      assert.equal(options.headers["x-codeium-csrf-token"], "synthetic-csrf");
      assert.deepEqual(JSON.parse(options.body), {});
      return { ok: true, text: async () => JSON.stringify({ userStatus: { email } }) };
    },
  });

  assert.equal(await driver.desktopIdentity(), expected);
  assert.equal(requested, true);
});

test("Windows driver keeps runner failures free of secret stderr text", async () => {
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\local" },
    runner: async () => { throw new Error("stderr access_token=super-secret"); },
  });

  await assert.rejects(driver.capture(), (error) => {
    assert.equal(error.message, "Antigravity credential capture failed.");
    assert.doesNotMatch(error.message, /super-secret|access_token/);
    return true;
  });
});

test("Windows driver delegates official login to an injected lifecycle callback", async () => {
  const calls = [];
  const driver = createAntigravityAccountDriver({
    scriptsRoot: "C:\\fixed-scripts",
    env: { LOCALAPPDATA: "C:\\local" },
    runner: async () => "{}",
    login: async (options) => { calls.push(options); },
    cancelLogin: async () => { calls.push("cancel"); },
  });

  await driver.login({ acknowledgeRestart: true });
  await driver.cancelLogin();
  assert.deepEqual(calls, [{ acknowledgeRestart: true }, "cancel"]);
});

test("PowerShell credential helper is fixed-target, DPAPI protected, and never deletes credentials", async () => {
  const source = await readFile(new URL("../../scripts/anticodex-antigravity-credentials.ps1", import.meta.url), "utf8");
  assert.match(source, /gemini:antigravity/);
  assert.match(source, /CredReadW/);
  assert.match(source, /CredWriteW/);
  assert.doesNotMatch(source, /CredEnumerate|CredDelete/);
  assert.match(source, /ProtectedData.*Protect/s);
  assert.match(source, /ProtectedData.*Unprotect/s);
  assert.match(source, /anticodex-antigravity-accounts-v1/);
  assert.match(source, /Console\]::In\.ReadToEnd/);
  assert.match(source, /Array\]::Clear/);
  assert.match(source, /openidconnect\.googleapis\.com\/v1\/userinfo/);
});
