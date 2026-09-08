import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAntiCodexManagerService } from "../../scripts/anticodex-manager-service.mjs";

test("account manager endpoints protect account data and serialize background changes", async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anticodex-account-http-"));
  const calls = [];
  let finishActivation;
  const accountManager = {
    async list() { return { activeId: "a", accounts: [{ id: "a", label: "Personal", maskedEmail: "te***@example.test", quota: null }] }; },
    async activate(value) {
      calls.push(value);
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
