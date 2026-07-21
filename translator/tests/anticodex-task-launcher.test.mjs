import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTIGRAVITY_START_TIMEOUT_MS,
  FIXED_ROUTE_PORTS,
  ROUTE_RESTART_REQUEST_SCHEMA,
  buildTaskLaunchPlan,
  buildTaskLauncherEnvironment,
  consumeRouteRestartRequest,
  waitForFixedRoutePortsReleased,
} from "../../scripts/start-anticodex-task.mjs";

const baseEnv = {
  LOCALAPPDATA: "C:\\Users\\XD\\AppData\\Local",
  APPDATA: "C:\\Users\\XD\\AppData\\Roaming",
  USERPROFILE: "C:\\Users\\XD",
  PATH: "C:\\Program Files\\nodejs",
};

test("task launcher allows a real Antigravity cold start without accepting a transient process", () => {
  assert.equal(ANTIGRAVITY_START_TIMEOUT_MS, 90_000);
});

test("task launcher keeps Antigravity on the existing thin fixed route", () => {
  const plan = buildTaskLaunchPlan({
    env: baseEnv,
    profile: {
      mode: "antigravity",
      antigravityModel: "gemini-3-flash-agent",
    },
  });

  assert.equal(plan.provider, "antigravity");
  assert.equal(plan.model, "gemini-3-flash-agent");
  assert.match(plan.supervisorScript, /start-anticodex-fixed-route\.mjs$/);
  assert.deepEqual(plan.supervisorArgs.slice(0, 3), [plan.supervisorScript, "--install-root", plan.installRoot]);
  assert.ok(plan.supervisorArgs.includes("--disable-gpu"));
  assert.equal(plan.publicProfile.apiKeyConfigured, false);

  const childEnv = buildTaskLauncherEnvironment(plan, baseEnv);
  assert.equal(childEnv.ANTICODEX_PROVIDER, "antigravity");
  assert.equal(childEnv.ANTICODEX_MODEL, "gemini-3-flash-agent");
  assert.equal(childEnv.CODEX_HOME, plan.codexHome);
  assert.equal(childEnv.GLOBAL_CODEX_HOME, "C:\\Users\\XD\\.codex");
  assert.equal(childEnv.UPSTREAM_API_KEY, undefined);
});

test("task launcher preserves third-party CodexPlusPlus routing without exposing the key in its plan", () => {
  const plan = buildTaskLaunchPlan({
    env: baseEnv,
    profile: {
      mode: "third-party",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "gpt-5.6-terra",
      contextWindow: 1000000,
    },
  });

  assert.equal(plan.provider, "third-party");
  assert.equal(plan.model, "gpt-5.6-terra");
  assert.equal(plan.publicProfile.baseUrl, "http://127.0.0.1:8080");
  assert.equal("apiKey" in plan.publicProfile, false);

  const childEnv = buildTaskLauncherEnvironment(plan, {
    ...baseEnv,
    UPSTREAM_API_KEY: "must-be-removed",
  }, {
    ...plan.profile,
    apiKey: "runtime-secret",
  });
  assert.equal(childEnv.UPSTREAM_PROTOCOL, "openai-compatible");
  assert.equal(childEnv.UPSTREAM_URL, "http://127.0.0.1:8080");
  assert.equal(childEnv.UPSTREAM_MODEL, "gpt-5.6-terra");
  assert.equal(childEnv.UPSTREAM_API_KEY, "runtime-secret");
});

test("task launcher consumes a fresh matching route restart request exactly once", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "anticodex-task-restart-"));
  try {
    writeFileSync(join(stateRoot, "route-restart-request.json"), JSON.stringify({
      schema: ROUTE_RESTART_REQUEST_SCHEMA,
      requestId: "route-switch-1",
      requestedAt: new Date().toISOString(),
      expectedSupervisorPid: 4242,
    }));

    const request = consumeRouteRestartRequest(stateRoot, 4242);
    assert.equal(request.requestId, "route-switch-1");
    assert.equal(consumeRouteRestartRequest(stateRoot, 4242), null);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("task launcher rejects stale or mismatched route restart requests", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "anticodex-task-restart-"));
  try {
    const requestPath = join(stateRoot, "route-restart-request.json");
    writeFileSync(requestPath, JSON.stringify({
      schema: ROUTE_RESTART_REQUEST_SCHEMA,
      requestId: "wrong-owner",
      requestedAt: new Date().toISOString(),
      expectedSupervisorPid: 9999,
    }));
    assert.equal(consumeRouteRestartRequest(stateRoot, 4242), null);

    writeFileSync(requestPath, JSON.stringify({
      schema: ROUTE_RESTART_REQUEST_SCHEMA,
      requestId: "stale-request",
      requestedAt: new Date(Date.now() - 180_000).toISOString(),
      expectedSupervisorPid: 4242,
    }));
    assert.equal(consumeRouteRestartRequest(stateRoot, 4242), null);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("task launcher waits for every owned route port to remain released before restart", async () => {
  assert.ok(FIXED_ROUTE_PORTS.includes(8484));
  assert.ok(FIXED_ROUTE_PORTS.includes(18318));
  assert.ok(FIXED_ROUTE_PORTS.includes(18487));

  let clock = 0;
  let probeRound = 0;
  const result = await waitForFixedRoutePortsReleased({
    ports: [8484, 18487],
    timeoutMs: 5_000,
    stableMs: 300,
    intervalMs: 100,
    now: () => clock,
    sleepFn: async (delay) => { clock += delay; probeRound += 1; },
    isPortOpen: async (port) => probeRound < 2 && port === 8484,
  });

  assert.equal(result, true);
  assert.ok(clock >= 400, `expected a stable closed-port window, got ${clock} ms`);
});

test("task launcher fails closed when an owned route port never releases", async () => {
  let clock = 0;
  const result = await waitForFixedRoutePortsReleased({
    ports: [8484],
    timeoutMs: 500,
    stableMs: 100,
    intervalMs: 100,
    now: () => clock,
    sleepFn: async (delay) => { clock += delay; },
    isPortOpen: async () => true,
  });

  assert.equal(result, false);
});
