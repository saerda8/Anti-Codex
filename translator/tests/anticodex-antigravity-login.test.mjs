import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { discoverAntigravityDesktopConnection } from "../provider/antigravity-cascade-client.mjs";

const moduleUrl = new URL("../../scripts/anticodex-antigravity-login.mjs", import.meta.url);

test("login connection discovery uses the current process instead of old addresses", (t) => {
  const stub = t.mock.method(childProcess, "execFileSync", (file) => {
    if (String(file).endsWith("powershell.exe")) return JSON.stringify([{ processId: 54321, commandLine: "language_server.exe --app_data_dir antigravity --csrf_token synthetic-current" }]);
    if (String(file).endsWith("netstat.exe")) return "TCP 127.0.0.1:49152 0.0.0.0:0 LISTENING 54321\n";
    if (String(file).endsWith("curl.exe")) return "200";
    throw new Error("Unexpected discovery command");
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
  const connection = discoverAntigravityDesktopConnection({ ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:9999", ANTIGRAVITY_CSRF_TOKEN: "synthetic-old" }, { processOnly: true });
  assert.equal(connection.lsAddress, "127.0.0.1:49152");
  assert.equal(connection.csrfToken, "synthetic-current");
});

test("successful official login keeps Desktop open until the caller finishes", async () => {
  assert.ok(fs.existsSync(moduleUrl), "Official Antigravity login adapter is missing");
  const { createAntigravityOfficialLogin } = await import(moduleUrl);
  const events = [];
  const login = createAntigravityOfficialLogin({
    launchDesktop: async () => events.push("launch"),
    stopDesktop: async () => events.push("stop"),
    findConnection: () => ({ lsAddress: "127.0.0.1:49152", csrfToken: "synthetic-csrf" }),
    fetchImpl: async (url, options) => {
      events.push("login");
      assert.equal(url, "http://127.0.0.1:49152/exa.language_server_pb.LanguageServerService/Login");
      assert.equal(options.headers["x-codeium-csrf-token"], "synthetic-csrf");
      assert.deepEqual(JSON.parse(options.body), { isGcpTos: false });
      return { ok: true, json: async () => ({ authResult: { hasValidAuth: true } }) };
    },
  });
  await assert.rejects(login.login({}), /确认/);
  assert.deepEqual(events, []);
  await login.login({ acknowledgeRestart: true });
  assert.deepEqual(events, ["launch", "login"]);
  await login.cancelLogin();
  assert.deepEqual(events, ["launch", "login", "stop"]);
});

test("failed login is cleaned up and never forwards raw transport data", async () => {
  assert.ok(fs.existsSync(moduleUrl), "Official Antigravity login adapter is missing");
  const { createAntigravityOfficialLogin } = await import(moduleUrl);
  let stops = 0;
  const login = createAntigravityOfficialLogin({
    launchDesktop: async () => {},
    stopDesktop: async () => { stops += 1; },
    findConnection: () => ({ lsAddress: "127.0.0.1:49152", csrfToken: "synthetic-csrf" }),
    fetchImpl: async () => { throw new Error("synthetic-private-transport-data"); },
  });
  await assert.rejects(login.login({ acknowledgeRestart: true }), (error) => {
    assert.doesNotMatch(error.message, /synthetic-private/);
    return true;
  });
  assert.equal(stops, 1);
});

test("native login rejects a non-loopback connection before sending authentication traffic", async () => {
  assert.ok(fs.existsSync(moduleUrl), "Official Antigravity login adapter is missing");
  const { createAntigravityOfficialLogin } = await import(moduleUrl);
  let requests = 0;
  const login = createAntigravityOfficialLogin({
    launchDesktop: async () => {}, stopDesktop: async () => {},
    findConnection: () => ({ lsAddress: "outside.example:8080", csrfToken: "synthetic-csrf" }),
    fetchImpl: async () => { requests += 1; },
  });
  await assert.rejects(login.login({ acknowledgeRestart: true }));
  assert.equal(requests, 0);
});

test("login cleanup failure marks credential restoration unsafe", async () => {
  const { createAntigravityOfficialLogin } = await import(moduleUrl);
  const login = createAntigravityOfficialLogin({
    launchDesktop: async () => {},
    stopDesktop: async () => { throw new Error("synthetic-stop-failure"); },
    findConnection: () => ({ lsAddress: "127.0.0.1:49152", csrfToken: "synthetic-csrf" }),
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  await assert.rejects(login.login({ acknowledgeRestart: true }), (error) => {
    assert.equal(error.credentialRestoreUnsafe, true);
    return true;
  });
});
