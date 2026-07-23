import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRouteAuditUnchanged,
  fetchModelCatalog,
  observeChild,
  startLoopbackRequestAudit,
  waitForCondition,
} from "../../scripts/lib/anticodex-gate4-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runnerSource = readFileSync(
  resolve(repoRoot, "scripts", "test-codexplusplus-antigravity-route-switch.mjs"),
  "utf8",
);
const runtimeSyncSource = readFileSync(
  resolve(repoRoot, "scripts", "sync-anticodex-runtime.ps1"),
  "utf8",
);
const installerSource = readFileSync(
  resolve(repoRoot, "scripts", "install-anticodex.ps1"),
  "utf8",
);

test("Gate 4 child exit fails promptly with captured stdout, stderr, and exit code", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('GATE4_STDOUT'); process.stderr.write('GATE4_STDERR'); process.exit(23);",
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observation = observeChild(child);
  const startedAt = Date.now();

  await assert.rejects(
    waitForCondition(() => {
      observation.throwIfTerminated("Gate 4 fixture");
      return false;
    }, {
      timeout: 5_000,
      interval: 10,
      description: "fixture that already exited",
    }),
    (error) => {
      assert.equal(error.terminal, true);
      assert.equal(error.evidence.exitCode, 23);
      assert.match(error.evidence.stdoutTail, /GATE4_STDOUT/);
      assert.match(error.evidence.stderrTail, /GATE4_STDERR/);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 1_500, "terminal child failure must not wait for the outer timeout");
});

test("Gate 4 loopback route audit starts at zero and records exact requests", async (t) => {
  const audit = await startLoopbackRequestAudit();
  t.after(() => audit.close());

  assert.deepEqual(audit.snapshot(), { count: 0, requests: [] });
  const response = await fetch(`${audit.url}/chat/completions`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 418);
  assert.deepEqual(audit.snapshot(), {
    count: 1,
    requests: [{ method: "POST", path: "/v1/chat/completions" }],
  });
});

test("Gate 4 model probe fails closed on a wrong token and any HTTP non-success", async (t) => {
  const unauthorized = await statusServer((request) => (
    request.headers.authorization === "Bearer wanted" ? 200 : 401
  ));
  const unavailable = await statusServer(() => 503);
  t.after(() => Promise.all([unauthorized.close(), unavailable.close()]));

  await assert.rejects(
    fetchModelCatalog({
      url: unauthorized.url,
      token: "wrong",
      model: "fixture",
    }),
    (error) => {
      assert.equal(error.terminal, true);
      assert.equal(error.evidence.statusCode, 401);
      return true;
    },
  );
  await assert.rejects(
    fetchModelCatalog({
      url: unavailable.url,
      token: "wanted",
      model: "fixture",
    }),
    (error) => {
      assert.equal(error.terminal, true);
      assert.equal(error.evidence.statusCode, 503);
      return true;
    },
  );
});

test("Gate 4 occupied helper port becomes a prompt captured child failure", async (t) => {
  const holder = createNetServer();
  await new Promise((resolveListen, reject) => {
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => new Promise((resolveClose) => holder.close(resolveClose)));
  const port = holder.address().port;
  const child = spawn(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${port}, "127.0.0.1")`,
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observation = observeChild(child);
  const startedAt = Date.now();

  await assert.rejects(
    waitForCondition(() => {
      observation.throwIfTerminated("occupied-port fixture");
      return false;
    }, {
      timeout: 5_000,
      interval: 10,
      description: "occupied-port fixture",
    }),
    (error) => {
      assert.equal(error.terminal, true);
      assert.notEqual(error.evidence.exitCode, 0);
      assert.match(error.evidence.stderrTail, /EADDRINUSE/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 1_500);
});

test("Gate 4 rejects a forbidden inactive-route hit before model traffic", async (t) => {
  const audit = await startLoopbackRequestAudit();
  t.after(() => audit.close());
  const before = audit.snapshot();
  await fetch(`${audit.url}/chat/completions`, { method: "POST", body: "{}" });
  const after = audit.snapshot();

  assert.throws(
    () => assertRouteAuditUnchanged(before, after, "inactive route"),
    (error) => {
      assert.equal(error.terminal, true);
      assert.equal(error.evidence.after.count, 1);
      return true;
    },
  );
});

test("Gate 4 owns its forbidden-route baseline and captures launcher termination evidence", () => {
  assert.doesNotMatch(runnerSource, /127\.0\.0\.1:8484/);
  assert.match(runnerSource, /startLoopbackRequestAudit/);
  assert.match(runnerSource, /gate4-forbidden-old-route/);
  assert.match(runnerSource, /observeChild\(launcherProcess/);
  assert.match(runnerSource, /launcherEvidence/);
  assert.match(runnerSource, /authContents:\s*`\$\{JSON\.stringify\(\{\s*OPENAI_API_KEY:\s*provider\.authToken/);
  assert.match(runnerSource, /writeFileSync\(join\(layout\.codexHome,\s*"auth\.json"\)[\s\S]*?gate4-local-key/);
  assert.match(runtimeSyncSource, /scripts\\lib\\anticodex-gate4-runtime\.mjs/);
  assert.match(installerSource, /scripts\\lib\\anticodex-gate4-runtime\.mjs/);
  assert.match(installerSource, /scripts\\test-codexplusplus-antigravity-route-switch\.mjs/);
});

async function statusServer(statusForRequest) {
  const server = createHttpServer((request, response) => {
    const status = statusForRequest(request);
    const body = status === 200
      ? JSON.stringify({ object: "list", data: [{ id: "fixture" }] })
      : JSON.stringify({ error: `status_${status}` });
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1/models`,
    close() {
      server.closeAllConnections?.();
      return new Promise((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}
