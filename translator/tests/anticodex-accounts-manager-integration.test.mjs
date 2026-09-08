import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createAntiCodexManagerService } from "../../scripts/anticodex-manager-service.mjs";

  test("account quota puts five hours before seven days without changing source data", () => {
    const ui = fs.readFileSync(new URL("../../scripts/anticodex-manager-inject.js", import.meta.url), "utf8");
    assert.ok(ui.includes("function accountQuotaBuckets("), "Quota display must explicitly order provider windows");
    const source = ui.slice(ui.indexOf("function accountQuotaBuckets("), ui.indexOf("function drawAccountSettings("));
    const group = { buckets: [{ window: "7d", remaining_fraction: 0 }, { window: "5h", remaining_fraction: 0.7 }, { window: "weekly", remaining_fraction: 0.9 }, { window: "daily" }] };
    const ordered = vm.runInNewContext(`${source}; accountQuotaBuckets(group)`, { group });
    assert.deepEqual(Array.from(ordered, (bucket) => bucket.window), ["5h", "7d", "daily"]);
    assert.equal(ordered[1].window, "7d");
    assert.deepEqual(group.buckets.map((bucket) => bucket.window), ["7d", "5h", "weekly", "daily"]);
    assert.ok(/\.anticodex-quota-track\{[^}]*max-width:[1-4]\dpx/.test(ui), "Quota tracks must stay compact, including narrow layouts");
});

test("account manager endpoints protect account data and serialize background changes", async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-account-http-"));
  const calls = [];
  let finishActivation;
  const accountManager = {
    async list() { return { activeId: "a", accounts: [{ id: "a", label: "Personal", maskedEmail: "te***@example.test", quota: null }] }; },
    async activate(value) {
      const { onProgress, ...args } = value;
      calls.push(args);
      assert.equal(typeof onProgress, "function");
      onProgress("正在打开 Antigravity...");
      await new Promise((resolve) => { finishActivation = resolve; });
    },
  };
  const service = createAntiCodexManagerService({ port: 0, stateRoot, accountManager });
  const server = await service.listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    finishActivation?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  const bootstrap = await fetch(`${baseUrl}/anticodex/manager/bootstrap`, { headers: { origin: baseUrl } }).then((r) => r.json());
  const headers = { origin: baseUrl, "content-type": "application/json", "x-anticodex-manager-token": bootstrap.token };
  assert.equal((await fetch(`${baseUrl}/anticodex/accounts`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/anticodex/accounts`, { headers: { origin: "https://untrusted.example" } })).status, 403);
  const initial = await fetch(`${baseUrl}/anticodex/accounts`, { headers }).then((r) => r.json());
  assert.equal(initial.ok, true);
  assert.equal(initial.accounts[0].maskedEmail, "te***@example.test");
  const post = (body, override = headers) => fetch(`${baseUrl}/anticodex/accounts/action`, { method: "POST", headers: override, body: JSON.stringify(body) });
  assert.equal((await post({ action: "activate", id: "b" }, { ...headers, "x-anticodex-manager-token": "invalid" })).status, 403);
  assert.equal((await post({ action: "restore", sealed: "forbidden-import" })).status, 400);
  const accepted = await post({ action: "activate", id: "b", acknowledgeRestart: true, sealed: "ignored", command: "ignored" });
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.job.status, "running");
  const progress = await fetch(`${baseUrl}/anticodex/accounts`, { headers }).then((r) => r.json());
  assert.equal(progress.job.message, "正在打开 Antigravity...");
  assert.deepEqual(calls, [{ id: "b", acknowledgeRestart: true }]);
  assert.equal((await post({ action: "activate", id: "c", acknowledgeRestart: true })).status, 409);
  finishActivation();
  let completed;
  for (let n = 0; n < 20; n++) {
    completed = await fetch(`${baseUrl}/anticodex/accounts`, { headers }).then((r) => r.json());
    if (completed.job.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(completed.job.id, acceptedBody.job.id);
  assert.equal(completed.job.status, "completed");
  assert.doesNotMatch(JSON.stringify(completed), /sealed|credentialHash|access_token|refresh_token/);
});

test("account polling updates progress without rebuilding rows before completion", async () => {
  const ui = fs.readFileSync(new URL("../../scripts/anticodex-manager-inject.js", import.meta.url), "utf8");
  const source = ui.slice(ui.indexOf("async function waitAccountJob("), ui.indexOf("function accountOperation("));
  let reads = 0;
  const draws = [];
  const messages = [];
  const context = vm.createContext({
    root: { isConnected: true }, managerView: "accounts",
    result: { classList: { toggle() {} } },
    managerGetLiveJson: async () => ({ job: { id: "job", status: ++reads < 3 ? "running" : "completed", message: `stage ${reads}` } }),
    drawAccountSettings: (payload) => draws.push(payload.job.status),
    setAccountFeedback: (message) => messages.push(message),
    setAccountBusy() {}, setTimeout: (callback) => callback(),
  });
  await vm.runInContext(`${source}; waitAccountJob({id:"job"})`, context);
  assert.deepEqual(draws, ["completed"]);
  assert.deepEqual(messages, ["stage 1", "stage 2", "stage 3"]);
});

test("manager reserves its action lock before waiting for initial loading", async () => {
  const ui = fs.readFileSync(new URL("../../scripts/anticodex-manager-inject.js", import.meta.url), "utf8");
  const source = ui.slice(ui.indexOf("async function runManagerExclusive("), ui.indexOf("const resultCard ="));
  let releaseInitial;
  let runs = 0;
  const context = vm.createContext({
    managerInitialLoadPromise: new Promise((resolve) => { releaseInitial = resolve; }),
    root: { isConnected: true, setAttribute() {} }, window: {},
    managerOperationInFlight: false, actionInFlight: false, managerOperationGeneration: 0,
    managerSnapshotRunningActionIds: () => new Set(), actionStillPending: () => false,
    result: { classList: { remove() {} } },
    setManagerOperationBusy: (busy) => { context.managerOperationInFlight = busy; },
    operation: () => { runs++; },
  });
  vm.runInContext(source, context);
  const first = vm.runInContext("runManagerExclusive(operation)", context);
  assert.equal(context.managerOperationInFlight, true);
  assert.equal(await vm.runInContext("runManagerExclusive(operation)", context), false);
  releaseInitial();
  await first;
  assert.equal(runs, 1);
  assert.equal(context.managerOperationInFlight, false);
});

test("native account tab and bridge expose only the scoped account workflow", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const ui = fs.readFileSync(path.join(root, "scripts/anticodex-manager-inject.js"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "scripts/anticodex-manager-bridge.mjs"), "utf8");
  for (const pattern of [/data-anticodex-account-settings/, /async function showAccountSettings\(/, /managerGetLiveJson\("\/anticodex\/accounts"/, /managerPostJson\("\/anticodex\/accounts\/action"/, /remaining_fraction/, /reset_time/, /fetchedAt/]) {
    assert.ok(pattern.test(ui), `Account UI contract missing: ${pattern}`);
  }
  assert.doesNotMatch(ui, /dpapi:v1:|gemini:antigravity|CredReadW|CredWriteW/);
  assert.match(bridge, /\["\/anticodex\/accounts", new Set\(\["GET"\]\)\]/);
  assert.match(bridge, /\["\/anticodex\/accounts\/action", new Set\(\["POST"\]\)\]/);
});

test("account confirmations and renaming stay inside the embedded page", () => {
  const ui = fs.readFileSync(new URL("../../scripts/anticodex-manager-inject.js", import.meta.url), "utf8");
  const accountUi = ui.slice(ui.indexOf("function drawAccountSettings"), ui.indexOf("async function showPromptSettings"));
  assert.ok(!/window\.(confirm|prompt)\(/.test(accountUi), "Account actions must not block the embedded browser with native dialogs");
  assert.ok(/accountConfirmation/.test(accountUi), "High-impact account actions need page-owned confirmation");
  assert.ok(/确认移除/.test(accountUi));
  assert.ok(/保存备注/.test(accountUi));
});

test("one activation click shows feedback before dispatch and does not require a second click", async () => {
  const ui = fs.readFileSync(new URL("../../scripts/anticodex-manager-inject.js", import.meta.url), "utf8");
  const source = ui.slice(ui.indexOf("function accountOperation("), ui.indexOf("async function showAccountSettings("));
  const events = [];
  let operation;
  const context = vm.createContext({
    managerOperationInFlight: false, actionInFlight: false, accountConfirmation: null,
    setAccountBusy: (busy, id) => events.push(["busy", busy, id]),
    setAccountFeedback: (message) => events.push(["feedback", message]),
    runManagerExclusive: (callback) => { operation = callback; events.push(["dispatch"]); return Promise.resolve(); },
    managerPostJson: async (_path, value) => { events.push(["post", value.action, value.acknowledgeRestart]); return { job: { id: "job" } }; },
    waitAccountJob: async () => {},
  });
  vm.runInContext(`${source}; accountOperation("activate",{id:"b"},true)`, context);
  assert.deepEqual(events.slice(0, 3), [["busy", true, "b"], ["feedback", "正在启用并打开 Antigravity..."], ["dispatch"]]);
  await operation();
  assert.ok(events.some(([kind, action, ack]) => kind === "post" && action === "activate" && ack === true));
});
