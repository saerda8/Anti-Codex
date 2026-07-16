import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertNoExistingClientProcesses,
  assertProductionRoots,
  buildFixedRoutePlan,
  buildSupervisorChildEnvironment,
  liveOwnedClientPids,
  proxyModelCatalogReady,
} from "../../scripts/start-anticodex-fixed-route.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const supervisorPath = resolve(root, "scripts", "start-anticodex-fixed-route.mjs");
const injectorPath = resolve(root, "scripts", "deepcodex-cdp-inject.mjs");
const managerScriptPath = resolve(root, "scripts", "anticodex-manager-inject.js");
const managerBridgePath = resolve(root, "scripts", "anticodex-manager-bridge.mjs");

test("fixed-route supervisor has one CodexPlusPlus-owned product path", () => {
  const source = readFileSync(supervisorPath, "utf8");
  assert.match(source, /startAntigravityChatProvider/);
  assert.match(source, /createAntiCodexManagerService/);
  assert.match(source, /await managerService\.listen\(\)/);
  assert.match(source, /managerService:\s*process\.pid/);
  assert.match(source, /buildAntigravityModelCatalog/);
  assert.match(source, /buildCodexPlusPlusSettings/);
  assert.match(source, /mergeCodexRouteConfig/);
  assert.match(source, /getLauncherArgs/);
  assert.match(source, /CODEX_PLUS_STATE_DIR/);
  assert.match(source, /CODEX_PLUS_APP_EXECUTABLE/);
  assert.match(source, /CODEX_PLUS_PROTOCOL_PROXY_PORT/);
  assert.match(source, /codexplusplus-component-manifest-v1/);
  assert.match(source, /assertNoExistingClient/);
  assert.match(source, /Fixed-route Manager support is incomplete/);
  assert.doesNotMatch(source, /every\(existsSync\)\) return \{ watcher: null, bridge: null \}/);
  assert.doesNotMatch(source, /adaptive-server\.mjs|codex-native-protocol\.mjs|codex-native-sse\.mjs/);
  assert.doesNotMatch(source, /TRANSLATOR_URL|TRANSLATOR_PORT/);
  assert.doesNotMatch(source, /["']--help["']/);
  assert.doesNotMatch(source, /taskkill[^\n]+\/IM/i);
});

test("Manager support children exit when their owning supervisor no longer exists", () => {
  const environment = {
    ...process.env,
    ANTICODEX_SUPERVISOR_PID: "2147483000",
    DEEPCODEX_CDP_MANAGER_WATCH: "1",
    DEEPCODEX_CDP_DELAY_MS: "50",
  };
  const watcher = spawnSync(process.execPath, [injectorPath, "9", managerScriptPath, "--watch"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout: 5_000,
    windowsHide: true,
  });
  const bridge = spawnSync(process.execPath, [managerBridgePath, "--port", "9", "--base-url", "http://127.0.0.1:9"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout: 5_000,
    windowsHide: true,
  });

  assert.equal(watcher.error?.code, undefined);
  assert.equal(bridge.error?.code, undefined);
  assert.equal(watcher.status, 0);
  assert.equal(bridge.status, 0);
});

test("ready-state supervision uses owned PIDs and never repeats PowerShell process scans", () => {
  const source = readFileSync(supervisorPath, "utf8");
  assert.deepEqual(liveOwnedClientPids([101, 202, 303], (pid) => pid !== 202), [101, 303]);
  assert.match(source, /liveOwnedClientPids\(ownedClients\)/);
  assert.equal((source.match(/getCopiedClientProcesses\(plan\.paths\.appDir\)/g) || []).length, 1);
});

test("plan-json proves third-party bypass without starting processes or exposing keys", () => {
  const apiKey = "SUPERVISOR_TEST_SECRET";
  const output = execFileSync(process.execPath, [
    supervisorPath,
    "--plan-json",
    "--install-root", "G:\\AntiCodex-Test-Install",
    "--state-root", "G:\\AntiCodex-Test-State",
    "--provider", "third-party",
    "--proxy-port", "41002",
    "--adapter-port", "41003",
    "--cdp-port", "41004",
    "--health-port", "41005",
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      UPSTREAM_PROTOCOL: "openai-compatible",
      UPSTREAM_URL: "https://api.example.test/v1",
      UPSTREAM_MODEL: "example-model",
      UPSTREAM_API_KEY: apiKey,
    },
  });
  const plan = JSON.parse(output);
  assert.equal(plan.ok, true);
  assert.equal(plan.planOnly, true);
  assert.equal(plan.route.provider, "third-party");
  assert.equal(plan.route.adapterEnabled, false);
  assert.equal(plan.route.codexPlusPlusUpstreamUrl, "https://api.example.test/v1");
  assert.equal(plan.route.codexBaseUrl, "http://127.0.0.1:41002/v1");
  assert.equal(plan.launcherArgs[0], "--app-path");
  assert.equal(output.includes(apiKey), false);
  assert.equal(output.toLowerCase().includes("antigravity-chat"), false);
  assert.deepEqual(plan.lifecycle, {
    launchesVisibleClientOnce: true,
    automaticallyRelaunchesClient: false,
    ownsTaskControl: false,
    cleansOnlyOwnedChildren: true,
  });
});

test("plan-json keeps Antigravity behind the thin adapter", () => {
  const output = execFileSync(process.execPath, [
    supervisorPath,
    "--plan-json",
    "--install-root", "G:\\AntiCodex-Test-Install",
    "--state-root", "G:\\AntiCodex-Test-State",
    "--provider", "antigravity",
    "--model", "gemini-3.5-flash-low",
    "--proxy-port", "42002",
    "--adapter-port", "42003",
    "--cdp-port", "42004",
    "--health-port", "42005",
  ], { encoding: "utf8", windowsHide: true });
  const plan = JSON.parse(output);
  assert.equal(plan.route.adapterEnabled, true);
  assert.equal(plan.route.codexPlusPlusUpstreamUrl, "http://127.0.0.1:42003/v1");
  assert.equal(plan.route.codexBaseUrl, "http://127.0.0.1:42002/v1");
  assert.deepEqual(plan.launcherArgs.filter((value) => value.startsWith("--")), [
    "--app-path",
    "--debug-port",
    "--helper-port",
  ]);
});

test("plan-json creates no install/state paths and unsupported protocols fail before writes", () => {
  const token = randomUUID();
  const installRoot = join(tmpdir(), `AntiCodex-Plan-Install-${token}`);
  const stateRoot = join(tmpdir(), `AntiCodex-Plan-State-${token}`);
  assert.equal(existsSync(installRoot), false);
  assert.equal(existsSync(stateRoot), false);

  const commonArgs = [
    supervisorPath,
    "--plan-json",
    "--install-root", installRoot,
    "--state-root", stateRoot,
    "--provider", "third-party",
  ];
  const success = spawnSync(process.execPath, commonArgs, {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      UPSTREAM_PROTOCOL: "responses",
      UPSTREAM_URL: "https://api.example.test/v1",
      UPSTREAM_MODEL: "response-model",
      UPSTREAM_API_KEY: "NO_WRITE_SECRET",
    },
  });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).route.relayProtocol, "responses");
  assert.equal(existsSync(installRoot), false);
  assert.equal(existsSync(stateRoot), false);

  const rejected = spawnSync(process.execPath, commonArgs, {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      UPSTREAM_PROTOCOL: "anthropic",
      UPSTREAM_URL: "https://api.example.test/v1",
      UPSTREAM_MODEL: "unsupported-model",
      UPSTREAM_API_KEY: "NO_WRITE_SECRET",
    },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unsupported CodexPlusPlus third-party protocol/);
  assert.equal(existsSync(installRoot), false);
  assert.equal(existsSync(stateRoot), false);
});

test("second visible copied client is rejected before launch", () => {
  assert.throws(
    () => assertNoExistingClientProcesses([{ processId: 40148 }]),
    /already running.*40148.*second visible launch/i,
  );
  assert.equal(assertNoExistingClientProcesses([]), true);
});

test("production mode rejects any install or state root outside Anti-Codex-owned defaults", () => {
  const env = {
    ...process.env,
    LOCALAPPDATA: "C:\\Users\\XD\\AppData\\Local",
    APPDATA: "C:\\Users\\XD\\AppData\\Roaming",
  };
  const plan = buildFixedRoutePlan([
    "--provider", "antigravity",
    "--model", "gemini-3.5-flash-low",
  ], env);
  assert.doesNotThrow(() => assertProductionRoots(plan, env));

  const unsafe = structuredClone(plan);
  unsafe.paths.stateRoot = "C:\\Users\\XD\\.codex";
  assert.throws(() => assertProductionRoots(unsafe, env), /state root must be/i);
});

test("production default ports stay below the Windows dynamic client range", () => {
  const plan = buildFixedRoutePlan([
    "--provider", "antigravity",
    "--model", "gemini-3.5-flash-low",
  ], {
    ...process.env,
    LOCALAPPDATA: "C:\\Users\\XD\\AppData\\Local",
    APPDATA: "C:\\Users\\XD\\AppData\\Roaming",
  });
  assert.deepEqual(plan.ports, {
    cdp: 18318,
    proxy: 18484,
    launcherGuard: 18485,
    managerGuard: 18486,
    health: 18487,
    adapter: 18488,
    helper: 18489,
  });
  assert.equal(new Set(Object.values(plan.ports)).size, Object.values(plan.ports).length);
  assert.equal(Object.values(plan.ports).every((port) => port < 49152), true);
});

test("Antigravity readiness verifies the selected model through the CodexPlusPlus proxy", async () => {
  const calls = [];
  const ready = await proxyModelCatalogReady(58484, "LOCAL_PROXY_SECRET", "gemini-3.5-flash-low", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: [{ id: "gemini-3.5-flash-low" }] }), { status: 200 });
  });
  assert.equal(ready, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:58484/models");
  assert.equal(calls[0].init.headers.authorization, "Bearer LOCAL_PROXY_SECRET");
});

test("copied client environment removes original Codex pointers and provider secrets", () => {
  const plan = buildFixedRoutePlan([
    "--install-root", "G:\\AntiCodex-Test-Install",
    "--state-root", "G:\\AntiCodex-Test-State",
    "--provider", "third-party",
  ], {
    ...process.env,
    LOCALAPPDATA: "C:\\Users\\XD\\AppData\\Local",
    APPDATA: "C:\\Users\\XD\\AppData\\Roaming",
    UPSTREAM_PROTOCOL: "responses",
    UPSTREAM_URL: "https://api.example.test/v1",
    UPSTREAM_MODEL: "response-model",
    UPSTREAM_API_KEY: "THIRD_PARTY_SECRET",
  });
  const child = buildSupervisorChildEnvironment(plan, {
    GLOBAL_CODEX_HOME: "C:\\Users\\XD\\.codex",
    DEEPCODEX_SHARED_CODEX_HOME: "C:\\Users\\XD\\.codex",
    RUST_LOG: "info",
    OPENAI_API_KEY: "OPENAI_SECRET",
    ANTHROPIC_API_KEY: "ANTHROPIC_SECRET",
    UPSTREAM_API_KEY: "THIRD_PARTY_SECRET",
  });
  assert.equal(child.CODEX_HOME, plan.paths.codexHome);
  assert.equal(child.RUST_LOG, "info");
  assert.equal(child.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1");
  for (const name of ["GLOBAL_CODEX_HOME", "DEEPCODEX_SHARED_CODEX_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "UPSTREAM_API_KEY"]) {
    assert.equal(Object.hasOwn(child, name), false, `${name} leaked into copied client environment`);
  }
});
