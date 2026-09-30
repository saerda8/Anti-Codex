import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as fixedRoute from "../../scripts/start-anticodex-fixed-route.mjs";

import {
  assertNoExistingClientProcesses,
  assertProductionRoots,
  buildCopiedClientEnvironment,
  buildFixedRoutePlan,
  buildSupervisorChildEnvironment,
  clientSessionRequiresShutdown,
  liveOwnedClientPids,
  observeCopiedClientSession,
  ownedClientStopError,
  proxyModelCatalogReady,
  readCompatibilityModelAliases,
  refreshAntigravityRelayModelList,
  scanCopiedClientProcessesSafely,
  startHealthServer,
  updateClientExitGrace,
  waitForOwnedProcessExit,
} from "../../scripts/start-anticodex-fixed-route.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const supervisorPath = resolve(root, "scripts", "start-anticodex-fixed-route.mjs");
const injectorPath = resolve(root, "scripts", "deepcodex-cdp-inject.mjs");
const managerScriptPath = resolve(root, "scripts", "anticodex-manager-inject.js");
const managerBridgePath = resolve(root, "scripts", "anticodex-manager-bridge.mjs");

test("fixed-route supervisor keeps CodexPlusPlus as a helper-only proxy and owns the copied client", () => {
  const source = readFileSync(supervisorPath, "utf8");
  assert.match(source, /startAntigravityChatProvider/);
  assert.match(source, /nativeCustomInstructions/);
  assert.match(source, /readNativeCustomInstructions\(plan\.paths\.codexHome\)/);
  assert.match(source, /createAntiCodexManagerService/);
  assert.match(source, /await managerService\.listen\(\)/);
  assert.match(source, /refreshModels:\s*\(\)\s*=>\s*refreshModelsCallback\(\)/);
  assert.match(source, /source:\s*"antigravity-cascade"/);
  assert.match(source, /managerService:\s*process\.pid/);
  assert.match(source, /buildAntigravityModelCatalog/);
  assert.match(source, /readCompatibilityModelAliases/);
  assert.match(source, /buildCodexPlusPlusSettings/);
  assert.match(source, /mergeCodexRouteConfig/);
  assert.match(source, /getLauncherArgs/);
  assert.match(source, /getCopiedClientArgs/);
  assert.match(source, /spawn\(plan\.paths\.appExecutable, plan\.clientArgs/);
  assert.match(source, /spawn\(plan\.paths\.appExecutable,[\s\S]+?env:\s*copiedClientEnvironment/);
  assert.match(source, /child\.once\("exit",\s*\(code,\s*signal\)\s*=>/);
  assert.match(source, /lastClientExit:\s*\{/);
  assert.match(source, /processId:\s*child\.pid/);
  assert.match(source, /CODEX_PLUS_STATE_DIR/);
  assert.match(source, /CODEX_PLUS_APP_EXECUTABLE/);
  assert.match(source, /CODEX_PLUS_PROTOCOL_PROXY_PORT/);
  assert.match(source, /ANTICODEX_PROMPT_POLICY_PATH/);
  assert.match(source, /codexplusplus-component-manifest-v1/);
  assert.match(source, /assertNoExistingClient/);
  assert.match(source, /Fixed-route Manager support is incomplete/);
  assert.doesNotMatch(source, /every\(existsSync\)\) return \{ watcher: null, bridge: null \}/);
  assert.doesNotMatch(source, /adaptive-server\.mjs|codex-native-protocol\.mjs|codex-native-sse\.mjs/);
  assert.doesNotMatch(source, /TRANSLATOR_URL|TRANSLATOR_PORT/);
  assert.doesNotMatch(source, /["']--help["']/);
  assert.doesNotMatch(source, /taskkill[^\n]+\/IM/i);
});

test("shared MCP is an Anti-only owned child started before the copied client", () => {
  const source = readFileSync(supervisorPath, "utf8");
  const sharedStart = source.indexOf("const sharedMcpSupport = await startSharedMcp(plan)");
  const clientStart = source.indexOf("const initialClient = await spawnCopiedClient()");
  const cleanupStart = source.indexOf("const cleanup = async");
  const cleanupEnd = source.indexOf("requestShutdown =", cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd);

  assert.ok(sharedStart >= 0 && clientStart > sharedStart);
  assert.match(source, /Local\\AntiCodexSharedMcpProxyV1|anticodex_shared_mcp_proxy\.py/);
  assert.match(source, /join\(plan\.paths\.installRoot, "shared-mcp"/);
  assert.match(source, /join\(plan\.paths\.stateRoot, "shared-mcp"/);
  assert.match(source, /captureSpawnedProcessIdentity\(sharedMcp/);
  assert.match(cleanup, /sharedMcp\.forEach\([^\n]+stopOwnedProcess\(child,\s*sharedMcpIdentity\[index\]\)/);
  assert.doesNotMatch(source, /\.codex[\\/]mcp[\\/]shared-proxy/);
});

test("cold Antigravity startup gets the existing desktop warmup budget without delaying third-party startup", () => {
  const source = readFileSync(supervisorPath, "utf8");
  const start = source.indexOf("const antigravityClient = createAntigravityCascadeClient()");
  const end = source.indexOf("provider = await startAntigravityChatProvider", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);

  assert.match(block, /getReadiness\(\s*plan\.provider === "antigravity"\s*\? \{ timeoutMs: 90_000 \}\s*: undefined,?\s*\)/);
  assert.match(block, /listModels\(\)/);
  assert.doesNotMatch(block, /listModels\(\{ timeoutMs:/);
});

test("copied-client readiness allows the official client's existing cold-start budget", () => {
  const source = readFileSync(supervisorPath, "utf8");
  const start = source.indexOf("const waitForCopiedClientReady");
  const end = source.indexOf("const initialClient", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);

  assert.match(block, /timeoutMs:\s*120_000/);
  assert.doesNotMatch(block, /timeoutMs:\s*90_000/);
});

test("ready state waits for verified Manager injection", () => {
  const source = readFileSync(supervisorPath, "utf8");
  const callStart = source.indexOf("const initialClient = await spawnCopiedClient()");
  const readyStart = source.indexOf('state: "ready"', callStart);
  const startupBlock = source.slice(callStart, readyStart);
  assert.match(startupBlock, /const management = await startManagerSupport\(plan, childEnvironment\)/);

  const supportStart = source.indexOf("async function startManagerWatcher");
  const supportEnd = source.indexOf("\nexport function scanCopiedClientProcessesSafely", supportStart);
  assert.ok(supportStart >= 0 && supportEnd > supportStart);
  const supportBlock = source.slice(supportStart, supportEnd);
  const watcherStart = supportBlock.indexOf('"--watch"');
  const watcherReady = supportBlock.indexOf("await waitFor", watcherStart);
  const bridgeStart = supportBlock.indexOf("const bridge = spawn", watcherReady);
  assert.ok(watcherStart >= 0 && watcherReady > watcherStart && bridgeStart > watcherReady);
  assert.match(supportBlock, /"watching"\\s\*:\\s\*true/);
  assert.match(supportBlock, /throw new Error\(`Manager watcher exited before readiness:/);
  assert.match(supportBlock, /manager-bridge-connected/);
  assert.match(supportBlock, /description:\s*"fixed-route Manager bridge"/);
  assert.doesNotMatch(supportBlock, /const bootstrap = spawn/);
});

test("Manager watcher keeps retrying owner-alive CDP disconnects instead of exiting", () => {
  const source = readFileSync(injectorPath, "utf8");
  const catchStart = source.indexOf("} catch (err) {", source.indexOf("for (let i = 0; i < attempts; i++)"));
  const retryStart = source.indexOf("if (managerWatchMode) {", catchStart);
  const retryEnd = source.indexOf("await sleep(delayMs);", retryStart);
  assert.ok(catchStart >= 0 && retryStart > catchStart && retryEnd > retryStart);
  const retryBlock = source.slice(retryStart, retryEnd);

  assert.match(retryBlock, /manager watcher disconnected timeout/);
  assert.match(retryBlock, /managerDisconnectedSince = Date\.now\(\)/);
  assert.doesNotMatch(retryBlock, /process\.exit/);
});

test("steady-state Manager supervision restarts only the safe watcher and degrades on bridge exit", () => {
  assert.equal(typeof fixedRoute.inspectManagerSupportChildren, "function");
  const running = { exitCode: null, signalCode: null };
  assert.deepEqual(fixedRoute.inspectManagerSupportChildren(running, running), {
    ok: true,
    failure: null,
    restartWatcher: false,
    bridgeFallbackRequired: false,
  });
  assert.deepEqual(fixedRoute.inspectManagerSupportChildren({ exitCode: 1, signalCode: null }, running), {
    ok: false,
    failure: "manager_watcher_exited",
    restartWatcher: true,
    bridgeFallbackRequired: false,
  });
  assert.deepEqual(fixedRoute.inspectManagerSupportChildren(running, { exitCode: null, signalCode: "SIGTERM" }), {
    ok: false,
    failure: "manager_bridge_exited",
    restartWatcher: false,
    bridgeFallbackRequired: true,
  });

  const source = readFileSync(supervisorPath, "utf8");
  const steadyStart = source.indexOf("let clientMissingSince = null");
  const steadyEnd = source.indexOf("\n  } catch (error)", steadyStart);
  assert.ok(steadyStart >= 0 && steadyEnd > steadyStart);
  const steadyBlock = source.slice(steadyStart, steadyEnd);
  assert.match(steadyBlock, /inspectManagerSupportChildren\(managerWatcher, managerBridge\)/);
  assert.match(steadyBlock, /managerFailureReason/);
  assert.match(steadyBlock, /await startManagerWatcher\(plan, childEnvironment\)/);
  assert.doesNotMatch(steadyBlock, /startManagerBridge\(/);
});

test("model refresh preserves the live provider and updates only the Antigravity model list", () => {
  const liveSettings = {
    activeRelayId: "anticodex-third-party",
    relayTestModel: "gpt-5.6-sol",
    relayProfiles: [
      {
        id: "anticodex-antigravity",
        apiKey: "local-secret",
        testModel: "gemini-3.1-pro-low",
        modelList: "anticodex-antigravity\ngemini-3.1-pro-low",
      },
      {
        id: "anticodex-third-party",
        apiKey: "saved-third-party-secret",
        testModel: "gpt-5.6-sol",
        modelList: "anticodex-third-party\ngpt-5.6-sol",
      },
    ],
  };
  const refreshed = refreshAntigravityRelayModelList(liveSettings, {
    models: [
      { slug: "gemini-3.1-pro-low" },
      { slug: "claude-sonnet-4-6" },
    ],
  });

  assert.equal(refreshed.activeRelayId, "anticodex-third-party");
  assert.equal(refreshed.relayTestModel, "gpt-5.6-sol");
  assert.deepEqual(refreshed.relayProfiles[1], liveSettings.relayProfiles[1]);
  assert.equal(refreshed.relayProfiles[0].apiKey, "local-secret");
  assert.equal(refreshed.relayProfiles[0].testModel, "gemini-3.1-pro-low");
  assert.equal(
    refreshed.relayProfiles[0].modelList,
    "anticodex/antigravity\ngemini-3.1-pro-low\nclaude-sonnet-4-6",
  );
});

test("model refresh derives the third-party catalog from live hot-switch settings", () => {
  assert.equal(typeof fixedRoute.thirdPartyCatalogOptionsFromSettings, "function");
  const options = fixedRoute.thirdPartyCatalogOptionsFromSettings({
    relayProfiles: [{
      id: "anticodex-third-party",
      testModel: "gpt-5.6-terra",
      contextWindow: "128000",
      modelList: "anticodex/third-party\nanticodex/third-party/gpt-5.6-sol\nanticodex/third-party/gpt-5.6-terra",
    }],
  }, {
    model: "gpt-5.6-sol",
    modelContextWindow: 272000,
  });

  assert.deepEqual(options, {
    thirdPartyModel: "gpt-5.6-terra",
    thirdPartyModels: ["gpt-5.6-terra", "gpt-5.6-sol"],
    thirdPartyContextWindow: 128000,
  });
});

test("refresh callback rebuilds the unified catalog from live third-party settings", () => {
  const source = readFileSync(supervisorPath, "utf8");
  const route = source.indexOf("const thirdPartyRoute = plan.relayRoutes.find");
  const start = source.indexOf("refreshModelsCallback = async () =>", route);
  const end = source.indexOf("const childEnvironment", start);
  assert.ok(route >= 0 && start > route && end > start);
  const block = source.slice(start, end);

  assert.match(block, /const liveSettings = JSON\.parse\(readFileSync/);
  assert.match(block, /const thirdPartyCatalogOptions = thirdPartyCatalogOptionsFromSettings\(liveSettings, thirdPartyRoute\)/);
  assert.match(block, /const previousUnifiedCatalog = readCatalogSafely\(unifiedCatalogPath\) \?\? catalog/);
  assert.match(block, /const rebuiltCatalog = buildUnifiedModelCatalog\(bundledCatalog, \{\s*antigravityCatalog: refreshedAntigravityCatalog,\s*\.\.\.thirdPartyCatalogOptions,/);
  assert.match(block, /const refreshedCatalog = preserveHiddenCompatibilityModels\(rebuiltCatalog, previousUnifiedCatalog\)/);
});

test("runtime route status reports the live unified catalog size after a hot switch", () => {
  const stateRoot = join(tmpdir(), `anticodex-live-catalog-${randomUUID()}`);
  const codexHome = join(stateRoot, "codex-home");
  const codexPlusPlusState = join(stateRoot, "codexplusplus");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(codexPlusPlusState, { recursive: true });
  try {
    writeFileSync(join(codexPlusPlusState, "settings.json"), JSON.stringify({
      activeRelayId: "anticodex-third-party",
      relayProfiles: [{
        id: "anticodex-third-party",
        name: "Anti-Codex third-party API",
        testModel: "gpt-5.6-terra",
        contextWindow: "128000",
        protocol: "chatCompletions",
        upstreamBaseUrl: "http://localhost:8080",
      }],
    }));
    writeFileSync(join(codexHome, "config.toml"), 'model = "anticodex/third-party/gpt-5.6-terra"\n');
    writeFileSync(join(codexHome, "anticodex-model-catalog.json"), JSON.stringify({
      models: [{ slug: "a" }, { slug: "b" }, { slug: "c" }],
    }));

    const status = fixedRoute.runtimeRouteStatus({
      state: "ready",
      catalogModelCount: 2,
      route: {},
    }, {
      paths: { codexHome, codexPlusPlusState },
    });
    assert.equal(status.catalogModelCount, 3);
    assert.equal(status.model, "gpt-5.6-terra");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
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

test("ready-state supervision follows copied-client process handoffs through CDP without unverified monitor-loop scans", async () => {
  const source = readFileSync(supervisorPath, "utf8");
  assert.deepEqual(liveOwnedClientPids([101, 202, 303], (pid) => pid !== 202), [101, 303]);
  const ownedClients = new Set([101]);
  const observed = await observeCopiedClientSession(ownedClients, {
    isAlive: () => false,
    isCdpReady: async () => true,
  });
  assert.deepEqual(observed, {
    ready: true,
    fatal: false,
    livePids: [],
    ownershipChanged: true,
    source: "cdp",
  });
  assert.deepEqual([...ownedClients], []);
  assert.match(source, /observeCopiedClientSession\(ownedClients/);
  assert.doesNotMatch(source, /tasklist\.exe/);
  assert.match(source, /function getCopiedClientProcesses\(\)[\s\S]*?getClientProcessTableRows\(\)[\s\S]*?anti-codex\.exe/i);
  assert.match(source, /const startupProcessScan = assertNoExistingClient\(\)/);
  assert.match(source, /const processScan = refreshOwnedClientIdentities\(\)/);
  const readyLoop = source.slice(source.indexOf("let clientMissingSince = null"), source.indexOf("} catch (error)", source.indexOf("let clientMissingSince = null")));
  const steadyLoop = readyLoop.slice(0, readyLoop.indexOf("if (exitGrace.expired)"));
  assert.doesNotMatch(steadyLoop, /tasklist|powershell|Get-CimInstance|scanCopiedClientProcessesSafely|scanClientProcessTableSafely|getCopiedClientProcesses/);
  assert.match(readyLoop, /assertLaunchSafe:[\s\S]*scanClientProcessTableSafely\(\)/);
});

test("owned client discovery requires the spawned root identity and a verified path, parent chain, and creation order", () => {
  assert.equal(typeof fixedRoute.selectVerifiedOwnedClientProcessRows, "function");
  const expectedExecutablePath = "G:\\Install-A\\codex-patched-app\\Anti-Codex.exe";
  const rows = [
    { processId: 101, parentProcessId: 900, executablePath: expectedExecutablePath, createdAtMs: 1_000 },
    { processId: 102, parentProcessId: 101, executablePath: expectedExecutablePath, createdAtMs: 1_100 },
    { processId: 103, parentProcessId: 101, executablePath: "G:\\Install-A\\codex-patched-app\\crashpad.exe", createdAtMs: 1_150 },
    { processId: 104, parentProcessId: 103, executablePath: expectedExecutablePath, createdAtMs: 1_200 },
    { processId: 105, parentProcessId: 101, executablePath: expectedExecutablePath, createdAtMs: 900 },
    { processId: 201, parentProcessId: 777, executablePath: expectedExecutablePath, createdAtMs: 1_250 },
    { processId: 301, parentProcessId: 888, executablePath: "G:\\Install-B\\codex-patched-app\\Anti-Codex.exe", createdAtMs: 1_300 },
  ];

  const selected = fixedRoute.selectVerifiedOwnedClientProcessRows(rows, {
    rootPid: 101,
    expectedExecutablePath,
    rootStartedAtMs: 950,
    nowMs: 2_000,
  });
  assert.deepEqual(selected.map((row) => row.processId), [101, 102, 104]);
});

test("owned client revalidation rejects PID reuse and never expands to a concurrent or other-install process", () => {
  assert.equal(typeof fixedRoute.revalidatedOwnedClientPids, "function");
  const expectedExecutablePath = "G:\\Install-A\\codex-patched-app\\Anti-Codex.exe";
  const identities = [
    { processId: 101, parentProcessId: 900, executablePath: expectedExecutablePath, createdAtMs: 1_000 },
    { processId: 102, parentProcessId: 101, executablePath: expectedExecutablePath, createdAtMs: 1_100 },
  ];
  const currentRows = [
    { processId: 101, parentProcessId: 900, executablePath: expectedExecutablePath, createdAtMs: 1_000 },
    { processId: 102, parentProcessId: 555, executablePath: expectedExecutablePath, createdAtMs: 9_999 },
    { processId: 201, parentProcessId: 777, executablePath: expectedExecutablePath, createdAtMs: 1_250 },
    { processId: 301, parentProcessId: 888, executablePath: "G:\\Install-B\\codex-patched-app\\Anti-Codex.exe", createdAtMs: 1_300 },
  ];
  assert.deepEqual(
    fixedRoute.revalidatedOwnedClientPids(currentRows, identities, expectedExecutablePath),
    [101],
  );
});

test("owned client discovery never launders a reused root PID over its captured spawn identity", () => {
  const expectedExecutablePath = "G:\\Install-A\\codex-patched-app\\Anti-Codex.exe";
  const capturedRoot = {
    processId: 101,
    parentProcessId: 900,
    executablePath: expectedExecutablePath,
    createdAtMs: 1_000,
  };
  const reusedRows = [
    {
      ...capturedRoot,
      parentProcessId: 901,
      createdAtMs: 1_500,
    },
    {
      processId: 102,
      parentProcessId: 101,
      executablePath: expectedExecutablePath,
      createdAtMs: 1_600,
    },
  ];

  assert.deepEqual(fixedRoute.selectVerifiedOwnedClientProcessRows(reusedRows, {
    rootPid: capturedRoot.processId,
    expectedExecutablePath,
    rootStartedAtMs: 950,
    nowMs: 2_000,
    knownIdentities: [capturedRoot],
  }), []);
});

test("spawn identity capture rejects a zero native creation timestamp", async () => {
  const expectedExecutablePath = "G:\\Install-A\\codex-patched-app\\Anti-Codex.exe";
  await assert.rejects(
    fixedRoute.captureSpawnedProcessIdentity(
      { pid: 101, exitCode: null, signalCode: null },
      {
        expectedExecutablePath,
        expectedParentProcessId: 900,
        startedAtMs: 950,
        timeoutMs: 100,
        intervalMs: 10,
        scan: () => [{
          processId: 101,
          parentProcessId: 900,
          executablePath: expectedExecutablePath,
          createdAtMs: 1_000,
          creationFileTimeUtcTicks: "0",
          name: "Anti-Codex.exe",
        }],
      },
    ),
    /identity did not match its spawn/i,
  );
});

test("single-window recovery rejects every Anti-Codex process but ignores native Codex", () => {
  assert.equal(typeof fixedRoute.recoveryLaunchIsSafe, "function");
  const expectedExecutablePath = "G:\\Install-A\\codex-patched-app\\Anti-Codex.exe";
  assert.equal(fixedRoute.recoveryLaunchIsSafe([
    { name: "Anti-Codex.exe", executablePath: expectedExecutablePath },
  ], expectedExecutablePath), false);
  assert.equal(fixedRoute.recoveryLaunchIsSafe([
    { name: "Anti-Codex.exe", executablePath: "" },
  ], expectedExecutablePath), false);
  assert.equal(fixedRoute.recoveryLaunchIsSafe([
    { name: "Anti-Codex.exe", executablePath: "G:\\Install-B\\codex-patched-app\\Anti-Codex.exe" },
  ], expectedExecutablePath), false);
  assert.equal(fixedRoute.recoveryLaunchIsSafe([
    { name: "ChatGPT.exe", executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe" },
  ], expectedExecutablePath), true);
});

test("client exit status persistence failure is contained without losing the exit evidence", () => {
  const status = { state: "ready" };
  const exit = {
    processId: 101,
    code: 0,
    signal: null,
    exitedAt: "2026-07-23T00:00:00.000Z",
  };
  const recorded = fixedRoute.recordClientExitSafely(status, exit, () => {
    throw new Error("status path is temporarily unavailable");
  });

  assert.equal(recorded.state, "ready");
  assert.deepEqual(recorded.lastClientExit, {
    ...exit,
    statusWriteError: "status path is temporarily unavailable",
  });
});

test("client handoff uses CDP and requires a sustained exit", async () => {
  const observed = await observeCopiedClientSession(new Set([101]), {
    isAlive: () => false,
    isCdpReady: async () => true,
  });
  assert.equal(observed.ready, true);
  assert.equal(observed.source, "cdp");

  assert.deepEqual(updateClientExitGrace(null, false, 1_000, 10_000), {
    missingSince: 1_000,
    expired: false,
  });
  assert.deepEqual(updateClientExitGrace(1_000, false, 10_999, 10_000), {
    missingSince: 1_000,
    expired: false,
  });
  assert.deepEqual(updateClientExitGrace(1_000, false, 11_000, 10_000), {
    missingSince: 1_000,
    expired: true,
  });
  assert.deepEqual(updateClientExitGrace(1_000, true, 11_000, 10_000), {
    missingSince: null,
    expired: false,
  });
});

test("a live owned Electron PID does not mask a failed semantic renderer", async () => {
  let rendererProbeCount = 0;
  const observed = await observeCopiedClientSession(new Set([101]), {
    isAlive: () => true,
    isCdpReady: async () => {
      rendererProbeCount += 1;
      return false;
    },
  });

  assert.equal(rendererProbeCount, 1);
  assert.deepEqual(observed, {
    ready: false,
    fatal: false,
    livePids: [101],
    ownershipChanged: false,
    source: "renderer",
  });

  assert.equal(clientSessionRequiresShutdown(observed), false);
  assert.equal(clientSessionRequiresShutdown({ ...observed, fatal: true, source: "fatal_renderer" }), true);
  assert.equal(clientSessionRequiresShutdown({ ...observed, livePids: [], source: "missing" }), true);
  assert.equal(clientSessionRequiresShutdown({ ...observed, fatal: true, livePids: [], source: "fatal_renderer" }), true);
  assert.equal(clientSessionRequiresShutdown({ ...observed, ready: true, fatal: false, livePids: [], source: "cdp" }), false);

  const source = readFileSync(supervisorPath, "utf8");
  const readyLoop = source.slice(
    source.indexOf("let clientMissingSince = null"),
    source.indexOf("} catch (error)", source.indexOf("let clientMissingSince = null")),
  );
  assert.match(readyLoop, /state:\s*"degraded"/);
  assert.match(readyLoop, /clientSessionRequiresShutdown\(clientSession\)/);
  assert.match(readyLoop, /cleanup\("client_unhealthy",\s*\{\s*stopClient:\s*true\s*\}\)/);
});

test("an explicit fatal renderer schedules owned cleanup after the existing grace even with a live Electron PID", async () => {
  const observed = await observeCopiedClientSession(new Set([101]), {
    isAlive: () => true,
    isCdpReady: async () => ({ ready: false, fatal: true }),
  });
  assert.deepEqual(observed, {
    ready: false,
    fatal: true,
    livePids: [101],
    ownershipChanged: false,
    source: "fatal_renderer",
  });
  assert.equal(clientSessionRequiresShutdown(observed), true);
  const started = updateClientExitGrace(null, !clientSessionRequiresShutdown(observed), 1_000, 10_000);
  assert.deepEqual(started, { missingSince: 1_000, expired: false });
  assert.deepEqual(
    updateClientExitGrace(started.missingSince, !clientSessionRequiresShutdown(observed), 11_000, 10_000),
    { missingSince: 1_000, expired: true },
  );
});

test("fatal renderer recovery is controlled, launch-safe, and allowed at most once", async () => {
  assert.equal(typeof fixedRoute.recoverCopiedClientOnce, "function");
  const calls = [];
  const recovered = await fixedRoute.recoverCopiedClientOnce({
    alreadyAttempted: false,
    backoffMs: 25,
    stopOwned: async () => { calls.push("stop"); return { survivors: [] }; },
    sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    assertLaunchSafe: async () => { calls.push("guard"); return true; },
    spawnClient: async () => { calls.push("spawn"); return { pid: 202 }; },
    waitUntilReady: async (child) => { calls.push(`ready:${child.pid}`); return { clients: [202, 203] }; },
  });
  assert.deepEqual(calls, ["stop", "sleep:25", "guard", "spawn", "ready:202"]);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.attempted, true);
  assert.equal(recovered.child.pid, 202);

  calls.length = 0;
  const exhausted = await fixedRoute.recoverCopiedClientOnce({
    alreadyAttempted: true,
    stopOwned: async () => { calls.push("stop"); return { survivors: [] }; },
    assertLaunchSafe: async () => { calls.push("guard"); return true; },
    spawnClient: async () => { calls.push("spawn"); return { pid: 303 }; },
    waitUntilReady: async () => ({ clients: [303] }),
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, "recovery_exhausted");
  assert.deepEqual(calls, []);

  const unsafe = await fixedRoute.recoverCopiedClientOnce({
    alreadyAttempted: false,
    stopOwned: async () => ({ survivors: [] }),
    sleep: async () => {},
    assertLaunchSafe: async () => false,
    spawnClient: async () => { throw new Error("must not launch"); },
    waitUntilReady: async () => ({ clients: [] }),
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.code, "launch_not_safe");
});

test("cleanup persists its reason before terminating any owned process", () => {
  const source = readFileSync(supervisorPath, "utf8");
  const cleanupStart = source.indexOf("const cleanup = async");
  const cleanupEnd = source.indexOf("requestShutdown =", cleanupStart);
  const cleanup = cleanupStart >= 0 && cleanupEnd > cleanupStart
    ? source.slice(cleanupStart, cleanupEnd)
    : "";
  const stoppingState = source.indexOf('state: "stopping"', cleanupStart);
  const firstTermination = source.indexOf("stopOwnedProcess(", cleanupStart);
  assert.ok(cleanupStart >= 0 && stoppingState > cleanupStart);
  assert.ok(firstTermination > stoppingState);
  assert.match(cleanup, /await stopOwnedClientSession\(\)/);
  assert.match(cleanup, /stopOwnedProcess\(launcher,\s*launcherIdentity\)/);
  assert.doesNotMatch(cleanup, /tasklist|scanCopiedClientProcessesSafely|getCopiedClientProcesses/);
});

test("owned-process shutdown waits for every unique process and reports survivors", async () => {
  const alive = new Set([101]);
  const stopped = await waitForOwnedProcessExit([101, 101, 202], {
    isAlive: (pid) => alive.has(pid),
    timeoutMs: 50,
    intervalMs: 10,
    sleep: async () => alive.clear(),
  });
  assert.deepEqual(stopped, []);

  const survivors = await waitForOwnedProcessExit([303, 303], {
    isAlive: () => true,
    timeoutMs: 0,
  });
  assert.deepEqual(survivors, [303]);

  const source = readFileSync(supervisorPath, "utf8");
  assert.match(source, /\.\.\.await waitForOwnedProcessExit\(shutdownPids\)/);
  assert.match(source, /state: stoppedNormally && fullyStopped \? "stopped" : "error"/);
  assert.doesNotMatch(source, /process\.kill\(pid,\s*signal\)|child\.kill\(signal\)/);
  assert.match(source, /TerminateProcess\(process,\s*1\)/);
});

test("a transient termination failure is not a shutdown error after exact scans prove zero survivors", () => {
  const transientFailure = [{ stopped: false, processId: 17172, reason: "kill_failed" }];
  assert.equal(
    ownedClientStopError({ ok: true }, { ok: true }, transientFailure, []),
    null,
  );
  assert.match(
    ownedClientStopError({ ok: true }, { ok: true }, transientFailure, [17172]),
    /17172: kill_failed/,
  );
  assert.match(
    ownedClientStopError(
      { ok: true },
      { ok: true },
      [{ stopped: false, processId: 303, reason: "missing_identity" }],
      [],
    ),
    /303: missing_identity/,
  );
  assert.match(
    ownedClientStopError({ ok: false, error: "before scan failed" }, { ok: true }, [], []),
    /before scan failed/,
  );
  assert.equal(
    ownedClientStopError(
      { ok: true },
      { ok: true },
      [{ stopped: true, processId: 101, reason: "killed" }, { stopped: false, processId: 202, reason: "already_exited" }],
      [],
    ),
    null,
  );
});

test("a timed-out startup process scan fails closed before a second client can launch", () => {
  const result = scanCopiedClientProcessesSafely(() => {
    const error = new Error("tasklist timed out");
    error.code = "ETIMEDOUT";
    throw error;
  });
  assert.deepEqual(result, {
    ok: false,
    processes: [],
    error: "tasklist timed out",
  });
  assert.equal(typeof fixedRoute.assertSafeStartupClientScan, "function");
  assert.throws(
    () => fixedRoute.assertSafeStartupClientScan(result),
    /cannot prove that no anti-codex client is already running.*tasklist timed out/i,
  );
});

test("fixed-route force stops reject a PID reused after its owned identity snapshot", () => {
  assert.equal(typeof fixedRoute.stopExactProcess, "function");
  assert.equal(typeof fixedRoute.stopOwnedProcess, "function");
  const identity = {
    processId: 44001,
    parentProcessId: 33001,
    executablePath: "C:\\Anti-Codex\\Anti-Codex.exe",
    createdAtMs: 1_720_000_000_000,
    creationFileTimeUtcTicks: "133659776000000000",
    name: "Anti-Codex.exe",
  };
  const terminationAttempts = [];
  const exactResult = fixedRoute.stopExactProcess(identity, {
    terminate: (expected) => {
      terminationAttempts.push(expected);
      return { status: "identity_changed" };
    },
  });
  assert.equal(exactResult.stopped, false);
  assert.equal(exactResult.reason, "identity_changed");
  assert.equal(terminationAttempts.length, 1);
  assert.equal(terminationAttempts[0].creationFileTimeUtcTicks, identity.creationFileTimeUtcTicks);

  const childResult = fixedRoute.stopOwnedProcess({
    pid: identity.processId,
    exitCode: null,
    signalCode: null,
  }, identity, {
    terminate: () => ({ status: "identity_changed" }),
  });
  assert.equal(childResult.stopped, false);
  assert.equal(childResult.reason, "identity_changed");

  const safeResult = fixedRoute.stopExactProcess(identity, {
    terminate: () => ({ status: "terminated" }),
  });
  assert.deepEqual(safeResult, {
    stopped: true,
    processId: identity.processId,
    reason: "killed",
  });

  const exitedResult = fixedRoute.stopExactProcess(identity, {
    terminate: () => ({ status: "already_exited" }),
  });
  assert.deepEqual(exitedResult, {
    stopped: false,
    processId: identity.processId,
    reason: "already_exited",
  });
});

test("fixed-route shutdown is loopback-token protected and acknowledged before cleanup", async (t) => {
  const shutdownReasons = [];
  const health = await startHealthServer(0, () => ({ ok: true, state: "ready" }), {
    shutdownToken: "test-control-token",
    onShutdown: (reason) => shutdownReasons.push(reason),
  });
  t.after(() => health.close());

  const denied = await fetch(`${health.url}/anticodex/fixed-route/shutdown`, { method: "POST" });
  assert.equal(denied.status, 403);
  assert.deepEqual(shutdownReasons, []);

  const accepted = await fetch(`${health.url}/anticodex/fixed-route/shutdown`, {
    method: "POST",
    headers: { authorization: "Bearer test-control-token" },
  });
  assert.equal(accepted.status, 202);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(shutdownReasons, ["control_shutdown"]);
});

test("supervisor closes the Antigravity provider before terminating owned children", () => {
  const source = readFileSync(supervisorPath, "utf8");
  const cleanupStart = source.indexOf("const cleanup = async");
  const cleanupEnd = source.indexOf("requestShutdown =", cleanupStart);
  const cleanup = cleanupStart >= 0 && cleanupEnd > cleanupStart
    ? source.slice(cleanupStart, cleanupEnd)
    : "";
  const providerClose = cleanup.indexOf("await provider?.close?.()");
  const childStop = cleanup.indexOf("stopOwnedProcess(launcher, launcherIdentity)");
  assert.ok(providerClose >= 0, "cleanup must close the provider");
  assert.ok(childStop > providerClose, "provider close must precede child termination");
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
      UPSTREAM_CONTEXT_WINDOW: "128000",
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
  assert.equal(plan.modelContextWindow, 128000);
  assert.equal(plan.route.modelContextWindow, 128000);
  assert.equal(plan.route.modelAutoCompactTokenLimit, 115200);
  assert.deepEqual(plan.launcherArgs, ["--helper-only", "--helper-port", "41002"]);
  assert.equal(plan.clientArgs[0], "--remote-debugging-port=41004");
  assert.equal(output.includes(apiKey), false);
  assert.equal(output.toLowerCase().includes("antigravity-chat"), false);
  assert.deepEqual(plan.lifecycle, {
    launchesVisibleClientOnce: true,
    headlessProtocolProxy: true,
    codexPlusPlusOwnsClient: false,
    clientOwner: "fixed-route-supervisor",
    automaticallyRelaunchesClient: true,
    ordinaryMissingClientAction: "shutdown",
    fatalRendererRecoveryLimit: 1,
    ownsTaskControl: false,
    cleansOnlyOwnedChildren: true,
  });
});

test("third-party route points Codex at the stable unified model catalog", () => {
  const plan = buildFixedRoutePlan([
    "--install-root", "G:\\AntiCodex-Test-Install",
    "--state-root", "G:\\AntiCodex-Test-State",
    "--provider", "third-party",
    "--proxy-port", "41002",
    "--adapter-port", "41003",
    "--cdp-port", "41004",
    "--health-port", "41005",
  ], {
    ...process.env,
    UPSTREAM_PROTOCOL: "openai-compatible",
    UPSTREAM_URL: "https://api.example.test/v1",
    UPSTREAM_MODEL: "gpt-5.6-terra",
    UPSTREAM_API_KEY: "catalog-test-key",
  });

  assert.match(plan.route.config, /^model_catalog_json = ".*anticodex-model-catalog\.json"$/m);
  assert.match(plan.route.config, /^model = "anticodex\/third-party\/gpt-5\.6-terra"$/m);
});

test("third-party compatibility catalog clones native Codex tool capabilities", async () => {
  const supervisor = await import("../../scripts/start-anticodex-fixed-route.mjs");
  assert.equal(typeof supervisor.buildThirdPartyModelCatalog, "function");
  const catalog = supervisor.buildThirdPartyModelCatalog({
    models: [{
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      supports_parallel_tool_calls: true,
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
      context_window: 272000,
      max_context_window: 272000,
    }],
  }, "gpt-5.6-terra", 128000);

  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].slug, "gpt-5.6-terra");
  assert.equal(catalog.models[0].shell_type, "shell_command");
  assert.equal(catalog.models[0].apply_patch_tool_type, "freeform");
  assert.equal(catalog.models[0].supports_parallel_tool_calls, true);
  assert.equal(catalog.models[0].context_window, 128000);
  assert.equal(catalog.models[0].max_context_window, 128000);
  assert.equal(catalog.models[0].effective_context_window_percent, 90);
});

test("external model catalogs keep Codex tools available outside the new code-only mode", async () => {
  const supervisor = await import("../../scripts/start-anticodex-fixed-route.mjs");
  const bundled = { models: [
    {
      slug: "gpt-5.6-sol",
      visibility: "list",
      supported_in_api: true,
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      tool_mode: "code_mode_only",
      template_marker: "restricted",
    },
    {
      slug: "gpt-5.5",
      visibility: "list",
      supported_in_api: true,
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      template_marker: "unrestricted",
    },
  ] };

  const preferred = supervisor.buildThirdPartyModelCatalog(bundled, "external-model");
  assert.equal(preferred.models[0].template_marker, "unrestricted");
  assert.equal(preferred.models[0].tool_mode, undefined);

  const fallback = supervisor.buildThirdPartyModelCatalog({ models: [bundled.models[0]] }, "external-model");
  assert.equal(fallback.models[0].template_marker, "restricted");
  assert.equal(fallback.models[0].tool_mode, undefined);
});

test("normalizes the new unified_exec catalog enum to native Codex tool capabilities", async () => {
  const supervisor = await import("../../scripts/start-anticodex-fixed-route.mjs");
  const catalog = supervisor.buildThirdPartyModelCatalog({
    models: [{
      slug: "gpt-6-astra",
      visibility: "list",
      supported_in_api: true,
      shell_type: "unified_exec",
      apply_patch_tool_type: "freeform",
    }],
  }, "external-model");

  assert.equal(catalog.models[0].shell_type, "shell_command");
  assert.equal(catalog.models[0].apply_patch_tool_type, "freeform");
  assert.equal(catalog.models[0].use_responses_lite, false);
});

test("third-party compatibility catalog retains hidden historical model aliases", async () => {
  const supervisor = await import("../../scripts/start-anticodex-fixed-route.mjs");
  const catalog = supervisor.buildThirdPartyModelCatalog({
    models: [{
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      supports_parallel_tool_calls: true,
      context_window: 272000,
      max_context_window: 272000,
    }],
  }, "gpt-5.6-sol", 272000, [
    "claude-sonnet-4-6",
    "gpt-5.6-sol",
    "",
    "claude-sonnet-4-6",
    "gemini-3-flash-agent",
  ]);

  assert.deepEqual(catalog.models.map((entry) => entry.slug), [
    "gpt-5.6-sol",
    "claude-sonnet-4-6",
    "gemini-3-flash-agent",
  ]);
  assert.equal(catalog.models[0].visibility, "list");
  for (const alias of catalog.models.slice(1)) {
    assert.equal(alias.visibility, "hide");
    assert.equal(alias.shell_type, "shell_command");
    assert.equal(alias.apply_patch_tool_type, "freeform");
    assert.equal(alias.supports_parallel_tool_calls, true);
    assert.equal(alias.context_window, 272000);
    assert.equal(alias.max_context_window, 272000);
    assert.equal(alias.effective_context_window_percent, 90);
  }
});

test("compatibility aliases load from durable catalogs without trusting malformed state", () => {
  const fixture = join(tmpdir(), `anticodex-model-aliases-${randomUUID()}`);
  const currentCatalog = join(fixture, "current.json");
  const legacyCatalog = join(fixture, "legacy.json");
  const malformedCatalog = join(fixture, "malformed.json");
  mkdirSync(fixture, { recursive: true });
  try {
    writeFileSync(currentCatalog, JSON.stringify({ models: [
      { slug: "claude-sonnet-4-6" },
      { slug: "gemini-3-flash-agent" },
      { slug: "" },
    ] }));
    writeFileSync(legacyCatalog, JSON.stringify({ models: [
      { slug: "claude-sonnet-4-6" },
      { slug: "gpt-oss-120b-medium" },
    ] }));
    writeFileSync(malformedCatalog, "{not-json");

    assert.deepEqual(readCompatibilityModelAliases([
      currentCatalog,
      malformedCatalog,
      legacyCatalog,
      join(fixture, "missing.json"),
    ]), [
      "claude-sonnet-4-6",
      "gemini-3-flash-agent",
      "gpt-oss-120b-medium",
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("unified catalog keeps retired Antigravity models hidden but routable", async () => {
  const supervisor = await import("../../scripts/start-anticodex-fixed-route.mjs");
  const bundled = { models: [{
    slug: "gpt-5.5",
    visibility: "list",
    supported_in_api: true,
    shell_type: "shell_command",
    apply_patch_tool_type: "freeform",
  }] };
  const current = { ...bundled.models[0], slug: "gemini-3.1-pro-low", display_name: "Gemini 3.1 Pro" };
  const retired = { ...bundled.models[0], slug: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", visibility: "list" };
  const preserved = supervisor.preserveHiddenCompatibilityModels({ models: [current] }, { models: [retired, current] });
  const catalog = supervisor.buildUnifiedModelCatalog(bundled, {
    antigravityCatalog: preserved,
    thirdPartyModel: "gpt-5.6-sol",
  });

  assert.deepEqual(preserved.models.map((entry) => entry.slug), ["gemini-3.1-pro-low", "claude-sonnet-4-5"]);
  assert.equal(preserved.models[1].visibility, "hide");
  assert.equal(catalog.models.find((entry) => entry.slug === "claude-sonnet-4-5").visibility, "hide");
  assert.equal(catalog.models.find((entry) => entry.slug === "gemini-3.1-pro-low").visibility, "list");

  const source = readFileSync(supervisorPath, "utf8");
  assert.match(source, /preserveHiddenCompatibilityModels\(currentAntigravityCatalog,\s*previousAntigravityCatalog\)/);
  assert.match(source, /relayModelList:\s*\[ANTIGRAVITY_MODEL_SLOT,\s*\.\.\.antigravityModelIds\]/);
});

test("third-party context window rejects unsafe or malformed profile values", async () => {
  const supervisor = await import("../../scripts/start-anticodex-fixed-route.mjs");
  const bundled = { models: [{ slug: "gpt-5.4", context_window: 272000 }] };
  assert.throws(
    () => supervisor.buildThirdPartyModelCatalog(bundled, "example-model", 8000),
    /context-window must be an integer between 16000 and 4000000/,
  );
  assert.throws(
    () => supervisor.buildThirdPartyModelCatalog(bundled, "example-model", "not-a-number"),
    /context-window must be an integer between 16000 and 4000000/,
  );
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
    "--helper-only",
    "--helper-port",
  ]);
  assert.equal(plan.clientArgs[0], "--remote-debugging-port=42004");
  assert.equal(plan.clientArgs[1], "--remote-allow-origins=http://127.0.0.1:42004");
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
  const supervisorChild = buildSupervisorChildEnvironment(plan, {
    GLOBAL_CODEX_HOME: "C:\\Users\\XD\\.codex",
    DEEPCODEX_SHARED_CODEX_HOME: "C:\\Users\\XD\\.codex",
    RUST_LOG: "info",
    CODEX_ELECTRON_DEV_PARENT_PID: "1234",
    CODEX_ELECTRON_DEV_WEBVIEW_PID: "5678",
    OPENAI_API_KEY: "OPENAI_SECRET",
    ANTHROPIC_API_KEY: "ANTHROPIC_SECRET",
    UPSTREAM_API_KEY: "THIRD_PARTY_SECRET",
    Path: "C:\\Windows\\System32",
  });
  assert.equal(supervisorChild.CODEX_PLUS_STATE_DIR, plan.paths.codexPlusPlusState);
  assert.equal(
    supervisorChild.ANTICODEX_PROMPT_POLICY_PATH,
    join(plan.paths.stateRoot, "prompt-policy.json"),
  );
  const child = buildCopiedClientEnvironment(plan, supervisorChild);
  assert.equal(child.CODEX_HOME, plan.paths.codexHome);
  assert.equal(child.CODEX_ELECTRON_USER_DATA_PATH, plan.paths.electronUserData);
  assert.equal(child.CODEX_PLUS_FIXED_MODEL, undefined);
  assert.equal(child.RUST_LOG, "info");
  assert.equal(child.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1");
  assert.equal(child.CODEX_SPARKLE_ENABLED, "false");
  const sandboxHelperDirectory = join(plan.paths.codexHome, "plugins", ".plugin-appserver");
  assert.equal(child.Path.split(";")[0], sandboxHelperDirectory);
  assert.equal(child.Path.split(";").filter((entry) => entry === sandboxHelperDirectory).length, 1);
  for (const name of [
    "GLOBAL_CODEX_HOME",
    "DEEPCODEX_SHARED_CODEX_HOME",
    "CODEX_ELECTRON_DEV_PARENT_PID",
    "CODEX_ELECTRON_DEV_WEBVIEW_PID",
    "CODEX_PLUS_STATE_DIR",
    "CODEX_PLUS_APP_EXECUTABLE",
    "CODEX_PLUS_PROTOCOL_PROXY_PORT",
    "CODEX_PLUS_LAUNCHER_GUARD_PORT",
    "CODEX_PLUS_MANAGER_GUARD_PORT",
    "ANTICODEX_PROMPT_POLICY_PATH",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "UPSTREAM_API_KEY",
  ]) {
    assert.equal(Object.hasOwn(child, name), false, `${name} leaked into copied client environment`);
  }
});
