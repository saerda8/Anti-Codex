import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import * as managerBridge from "../../scripts/anticodex-manager-bridge.mjs";
import {
  deliverManagerPayloadWithReconnect,
  ManagerBridgeRecoveryController,
} from "../../scripts/anticodex-manager-bridge.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const source = readFileSync(resolve(root, "scripts", "anticodex-manager-bridge.mjs"), "utf8");
const managerInject = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
const managerOpenInject = readFileSync(resolve(root, "scripts", "anticodex-manager-open-inject.js"), "utf8");
const managerService = readFileSync(resolve(root, "scripts", "anticodex-manager-service.mjs"), "utf8");
const cdpInject = readFileSync(resolve(root, "scripts", "deepcodex-cdp-inject.mjs"), "utf8");
const managerButtonTest = readFileSync(resolve(root, "scripts", "test-anticodex-manager-button.mjs"), "utf8");
const managerRealButtonsTest = readFileSync(resolve(root, "scripts", "test-anticodex-manager-real-buttons.ps1"), "utf8");
const syncReadiness = readFileSync(resolve(root, "scripts", "test-anticodex-sync-readiness.ps1"), "utf8");

const completeSnapshotPaths = [
  "/anticodex/manager/bootstrap",
  "/health",
  "/models",
  "/anticodex/diagnostics",
  "/anticodex/upstream-profile",
  "/anticodex/model-routes",
  "/anticodex/local-connectors/allowlist",
  "/backend-api/ps/plugins/installed",
  "/backend-api/aip/connectors",
  "/backend-api/plugins/list",
  "/backend-api/wham/apps",
];

function fakeBridgeSession(name) {
  return {
    name,
    closed: false,
    failureHandler: null,
    setFailureHandler(handler) {
      this.failureHandler = handler;
    },
    close() {
      this.closed = true;
    },
  };
}

test("Manager bridge coalesces Target crashed recovery and never overlaps polls", async () => {
  const sessions = [fakeBridgeSession("old"), fakeBridgeSession("current")];
  let openCount = 0;
  let activePolls = 0;
  let maxActivePolls = 0;
  const controller = new ManagerBridgeRecoveryController({
    openSession: async () => sessions[openCount++],
    pollSession: async (session) => {
      activePolls += 1;
      maxActivePolls = Math.max(maxActivePolls, activePolls);
      await Promise.resolve();
      activePolls -= 1;
      if (session.name === "old") throw new Error("Target crashed");
      return [];
    },
    sleep: async () => {},
    isOwnerAlive: () => true,
  });

  await controller.start();
  await Promise.all([controller.pollOnce(), controller.pollOnce(), controller.pollOnce()]);
  assert.equal(openCount, 2);
  assert.equal(maxActivePolls, 1);
  assert.equal(sessions[0].closed, true);
  assert.deepEqual(controller.status(), {
    connected: true,
    consecutivePollFailures: 0,
    polling: false,
    reconnecting: false,
  });
  controller.stop();
});

test("Manager bridge reconnects once after bounded consecutive timeouts and clears the counter", async () => {
  const sessions = [fakeBridgeSession("old"), fakeBridgeSession("current")];
  let openCount = 0;
  const controller = new ManagerBridgeRecoveryController({
    openSession: async () => sessions[openCount++],
    pollSession: async (session) => {
      if (session.name === "old") throw new Error("Timed out waiting for Runtime.evaluate");
      return [];
    },
    sleep: async () => {},
    isOwnerAlive: () => true,
    maxConsecutivePollFailures: 3,
  });

  await controller.start();
  await controller.pollOnce();
  assert.equal(openCount, 1);
  assert.equal(controller.status().consecutivePollFailures, 1);
  await controller.pollOnce();
  assert.equal(openCount, 1);
  assert.equal(controller.status().consecutivePollFailures, 2);
  await controller.pollOnce();
  assert.equal(openCount, 2);
  assert.equal(controller.status().consecutivePollFailures, 0);
  await controller.pollOnce();
  assert.equal(controller.status().consecutivePollFailures, 0);
  controller.stop();
});

test("Manager bridge coalesces repeated socket-close notifications into one reconnect", async () => {
  const sessions = [fakeBridgeSession("old"), fakeBridgeSession("current")];
  let openCount = 0;
  const controller = new ManagerBridgeRecoveryController({
    openSession: async () => sessions[openCount++],
    pollSession: async () => [],
    sleep: async () => {},
    isOwnerAlive: () => true,
  });

  await controller.start();
  await Promise.all([
    controller.notifySessionFailure(sessions[0], new Error("WebSocket closed")),
    controller.notifySessionFailure(sessions[0], new Error("socket closed")),
  ]);
  assert.equal(openCount, 2);
  assert.equal(controller.status().connected, true);
  controller.stop();
});

test("Manager bridge backs off while rediscovering the current page target", async () => {
  const delays = [];
  let openCount = 0;
  const controller = new ManagerBridgeRecoveryController({
    openSession: async () => {
      openCount += 1;
      if (openCount < 3) throw new Error("No Anti-Codex page target found.");
      return fakeBridgeSession("current");
    },
    pollSession: async () => [],
    sleep: async (delay) => delays.push(delay),
    isOwnerAlive: () => true,
    backoffMs: [250, 500, 1_000],
  });

  await controller.start();
  assert.equal(openCount, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.equal(controller.status().connected, true);
  controller.stop();
});

test("Manager bridge redelivers a completed payload after reconnect without rerunning the action", async () => {
  const evaluatedBy = [];
  const sessions = [
    {
      ...fakeBridgeSession("old"),
      async evaluate() {
        evaluatedBy.push("old");
        throw new Error("WebSocket closed during Runtime.evaluate");
      },
    },
    {
      ...fakeBridgeSession("current"),
      async evaluate(expression) {
        evaluatedBy.push("current");
        assert.match(expression, /completed-request-1/);
      },
    },
  ];
  let openCount = 0;
  let actionExecutions = 0;
  const logs = [];
  const controller = new ManagerBridgeRecoveryController({
    openSession: async () => sessions[openCount++],
    pollSession: async () => [],
    sleep: async () => {},
    isOwnerAlive: () => true,
    logger: {
      log: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });

  await controller.start();
  actionExecutions += 1;
  await deliverManagerPayloadWithReconnect(
    controller,
    sessions[0],
    "resolveCompletedPayload('completed-request-1')",
    { maxAttempts: 2 },
  );

  assert.equal(actionExecutions, 1);
  assert.equal(openCount, 2);
  assert.deepEqual(evaluatedBy, ["old", "current"]);
  assert.ok(logs.some((message) => message.includes('"event":"manager-delivery-retry"')));
  assert.ok(logs.some((message) => message.includes('"event":"manager-delivery-recovered"')));
  const deliverStart = source.indexOf("async function deliver(request, session)");
  const deliverEnd = source.indexOf("controller = new ManagerBridgeRecoveryController", deliverStart);
  const deliverBlock = source.slice(deliverStart, deliverEnd);
  assert.equal((deliverBlock.match(/runAction\(action\)/g) || []).length, 1);
  assert.match(deliverBlock, /const deliveryExpression =/);
  assert.match(deliverBlock, /await deliverManagerPayloadWithReconnect\(controller, session, deliveryExpression\)/);
  controller.stop();
});

test("Manager renderer lease survives a lost dequeue response until explicit acknowledgement", async () => {
  assert.equal(typeof managerBridge.createManagerBridgeSource, "function");
  assert.equal(typeof managerBridge.createManagerQueuePollSource, "function");
  const renderer = {};
  renderer.globalThis = renderer;
  vm.runInNewContext(managerBridge.createManagerBridgeSource(), renderer);

  const pending = renderer.__ANTICODEX_RUN_MANAGER_ACTION__("refreshStatus");
  const firstLease = vm.runInNewContext(managerBridge.createManagerQueuePollSource(), renderer);
  assert.equal(firstLease.length, 1);
  const requestId = firstLease[0].id;

  // Simulate Runtime.evaluate applying the dequeue but losing its CDP response.
  const redeliveredLease = vm.runInNewContext(managerBridge.createManagerQueuePollSource(), renderer);
  assert.equal(redeliveredLease.length, 1);
  assert.equal(redeliveredLease[0].id, requestId);

  renderer.__ANTICODEX_ACK_MANAGER_ACTION__(requestId, { ok: true, action: "refreshStatus" });
  assert.deepEqual(await pending, { ok: true, action: "refreshStatus" });
  assert.deepEqual(
    Array.from(vm.runInNewContext(managerBridge.createManagerQueuePollSource(), renderer)),
    [],
  );
});

test("installed readiness requires lease and acknowledgement instead of destructive dequeue", () => {
  assert.match(syncReadiness, /manager bridge missing explicit action acknowledgement/);
  assert.match(syncReadiness, /manager bridge missing action queue leasing/);
  assert.match(syncReadiness, /manager bridge still destructively drains actions before acknowledgement/);
  assert.doesNotMatch(syncReadiness, /manager bridge missing action queue drain/);
});

test("Manager host ledger executes a redelivered requestId at most once before ack", async () => {
  assert.equal(typeof managerBridge.ManagerActionExecutionLedger, "function");
  const ledger = new managerBridge.ManagerActionExecutionLedger();
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return { ok: true, execution: executions };
  };

  const first = await ledger.runOnce("lost-response-request", execute);
  const redelivered = await ledger.runOnce("lost-response-request", execute);
  assert.deepEqual(first, { ok: true, execution: 1 });
  assert.deepEqual(redelivered, first);
  assert.equal(executions, 1);
  assert.equal(ledger.has("lost-response-request"), true);

  ledger.acknowledge("lost-response-request");
  assert.equal(ledger.has("lost-response-request"), false);
});

test("Manager bridge bounds payload delivery retries and reports exhaustion", async () => {
  const sessions = ["old", "current"].map((name) => ({
    ...fakeBridgeSession(name),
    async evaluate() {
      throw new Error(`WebSocket closed on ${name}`);
    },
  }));
  let openCount = 0;
  const logs = [];
  const controller = new ManagerBridgeRecoveryController({
    openSession: async () => sessions[openCount++],
    pollSession: async () => [],
    sleep: async () => {},
    isOwnerAlive: () => true,
    logger: {
      log: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });

  await controller.start();
  await assert.rejects(
    deliverManagerPayloadWithReconnect(
      controller,
      sessions[0],
      "resolveCompletedPayload('completed-request-2')",
      { maxAttempts: 2 },
    ),
    /delivery failed after 2 attempts/i,
  );

  assert.equal(openCount, 2);
  assert.equal(logs.filter((message) => message.includes('"event":"manager-delivery-retry"')).length, 1);
  assert.ok(logs.some((message) => message.includes('"event":"manager-delivery-exhausted"')));
  controller.stop();
});

test("Manager bridge owns reconnects without exiting or launching another client", () => {
  const mainBlock = source.slice(source.indexOf("async function main()"));
  assert.match(mainBlock, /new ManagerBridgeRecoveryController/);
  assert.match(mainBlock, /await controller\.run\(\{ intervalMs: 250 \}\)/);
  assert.doesNotMatch(mainBlock, /ws\.onClose\s*=\s*\(\)\s*=>\s*process\.exit/);
  assert.doesNotMatch(mainBlock, /setInterval\(async/);
  assert.doesNotMatch(mainBlock, /spawn|Start-Process|Anti-Codex\.exe/);
  assert.match(source, /pathToFileURL\(resolve\(process\.argv\[1\]\)\)\.href === import\.meta\.url/);
});

test("Manager bridge snapshots identify themselves to the launcher-owned service", () => {
  const start = source.indexOf("async function managerSnapshot()");
  const end = source.indexOf("async function runManagerRequest", start);
  const block = source.slice(start, end);
  assert.match(block, /const trustedHeaders\s*=\s*\{/);
  assert.match(block, /origin:\s*baseUrl/);
  assert.match(block, /referer:\s*`\$\{baseUrl\}\/anticodex\/manager`/);
  assert.match(block, /headers:\s*trustedHeaders/);
});

test("Manager bridge and startup injector both build complete read snapshots", () => {
  const snapshotStart = source.indexOf("async function managerSnapshot()");
  const snapshotEnd = source.indexOf("async function runManagerRequest", snapshotStart);
  const bridgeBlock = source.slice(snapshotStart, snapshotEnd);
  const injectorBlock = cdpInject.match(/const snapshot = \{[\s\S]*?source = \[/)?.[0] ?? "";
  for (const path of completeSnapshotPaths) {
    assert.match(bridgeBlock, new RegExp(path.replaceAll("/", "\\/")), `bridge snapshot is missing ${path}`);
    assert.match(injectorBlock, new RegExp(path.replaceAll("/", "\\/")), `startup snapshot is missing ${path}`);
  }
  assert.match(injectorBlock, /origin:\s*baseUrl/);
  assert.match(injectorBlock, /referer:\s*`\$\{baseUrl\}\/anticodex\/manager`/);
});

test("Manager bridge reinstalls its renderer runtime after reload", () => {
  assert.match(source, /function createManagerQueuePollSource\([\s\S]*?\$\{bridgeSource\}[\s\S]*?__ANTICODEX_MANAGER_ACTION_QUEUE__/);
  assert.match(source, /const managerQueuePollSource = createManagerQueuePollSource\(bridgeSource\)/);
  assert.match(source, /evaluate\(managerQueuePollSource/);
  assert.match(source, /typeof globalThis\.__ANTICODEX_RUN_MANAGER_ACTION__ !== "function"/);
  assert.match(source, /typeof globalThis\.__ANTICODEX_RUN_MANAGER_REQUEST__ !== "function"/);
  assert.match(source, /typeof globalThis\.__ANTICODEX_ACK_MANAGER_ACTION__ !== "function"/);
});

test("third-party profile reads and writes use a bounded renderer-to-Manager request bridge", () => {
  const allowedRequestBlock = source.match(/const ALLOWED_MANAGER_BRIDGE_REQUESTS = new Map\([\s\S]*?\n\]\);/)?.[0] ?? "";
  for (const path of [...completeSnapshotPaths, "/anticodex/account", "/anticodex/upstream-test"]) {
    assert.match(allowedRequestBlock, new RegExp(path.replaceAll("/", "\\/")), `request bridge is missing ${path}`);
  }
  for (const path of [
    "/anticodex/upstream-test",
    "/anticodex/local-connectors/allowlist",
  ]) {
    assert.match(allowedRequestBlock, new RegExp(path.replaceAll("/", "\\/")), `request bridge is missing ${path}`);
  }
  assert.match(source, /request\.kind === "manager-request"/);
  assert.match(source, /runManagerRequest\(request\.path, request\.options\)/);
  assert.match(source, /path === "\/backend-api\/wham\/apps" && method === "GET"\s*\? "POST"/);
  assert.match(managerInject, /__ANTICODEX_RUN_MANAGER_REQUEST__/);
  assert.match(managerInject, /managerRequestViaBridge/);
  assert.match(managerInject, /managerGetLiveJson/);
  const getJsonBlock = managerInject.match(/async function getJson\(path, options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(getJsonBlock, /managerRequestViaBridge\(path[\s\S]*?apiCandidates\(\)/);
});

test("Manager initial render consumes its complete snapshot without serial bridge fan-out", () => {
  const getJsonBlock = managerInject.match(/async function getJson\(path, options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(getJsonBlock, /options\.preferSnapshot === true[\s\S]*?return snapshotFallback/);
  const loadBlock = managerInject.match(/async function load\(options = \{\}\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(loadBlock, /const snapshotReadOptions = \{ preferSnapshot: true \}/);
  assert.match(loadBlock, /safeJson\("\/health", snapshotReadOptions\)/);
  assert.match(loadBlock, /safeJson\("\/anticodex\/diagnostics", \{ \.\.\.snapshotReadOptions, timeoutMs: DIAGNOSTICS_FETCH_TIMEOUT_MS \}\)/);
  assert.match(loadBlock, /safeJson\("\/anticodex\/upstream-profile", snapshotReadOptions\)/);
  const upstreamConfigStart = managerInject.indexOf("async function showUpstreamConfig()");
  const upstreamConfigEnd = managerInject.indexOf("function installActions()", upstreamConfigStart);
  const upstreamConfigBlock = managerInject.slice(upstreamConfigStart, upstreamConfigEnd);
  assert.match(upstreamConfigBlock, /safeJson\("\/anticodex\/upstream-profile", \{ preferSnapshot: true \}\)/);
});

test("Manager theme sync does not observe every renderer subtree mutation", () => {
  const start = managerInject.indexOf("function installManagerThemeSync(root)");
  const end = managerInject.indexOf("function apiCandidates()", start);
  const block = managerInject.slice(start, end);
  assert.match(block, /const hostThemeNodes = \[/);
  assert.match(block, /for \(const node of new Set\(hostThemeNodes\.filter\(Boolean\)\)\)/);
  assert.doesNotMatch(block, /subtree:\s*true/);
  assert.match(managerInject, /__ANTICODEX_MANAGER_THEME_OBSERVER__\?\.disconnect/);
  assert.match(block, /__ANTICODEX_MANAGER_THEME_OBSERVER__ = managerThemeObserver/);
});

test("high-impact confirmation resolves the live result node inside its own scope", () => {
  const block = managerInject.match(/function requireHighImpactConfirmation\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(block, /const result = document\.querySelector\(`#\$\{MANAGER_ID\} \[data-anticodex-result="action"\]`\)/);
  assert.match(block, /if \(!result\)[\s\S]*?return true/);
});

test("Manager verifier has a no-traffic actual-mouse third-party form mode", () => {
  assert.match(managerButtonTest, /const upstreamConfigOnly = args\.has\("--upstream-config-only"\)/);
  assert.match(managerButtonTest, /async function verifyUpstreamConfigActualMouseClick\(\)/);
  assert.match(managerButtonTest, /data-action="upstreamConfig"/);
  assert.match(managerButtonTest, /profileUnchanged/);
  assert.match(managerButtonTest, /usedRealTraffic: false/);
  assert.match(managerButtonTest, /if \(upstreamConfigOnly\)/);
  const start = managerButtonTest.indexOf("async function verifyUpstreamConfigActualMouseClick()");
  const end = managerButtonTest.indexOf("async function drainManagerActionQueue()", start);
  const block = managerButtonTest.slice(start, end);
  assert.match(block, /const protocolLabel = Array\.from\(result\?\.querySelectorAll\('label'\)/);
  assert.match(block, /protocolLabel\?\.querySelector\('select'\)/);
  assert.doesNotMatch(block, /const select = result\?\.querySelector\('select'\)/);
  assert.match(block, /protocolInteraction/);
  assert.match(block, /Input\.dispatchKeyEvent/);
  assert.match(block, /protocolInteraction\.selectedAlternate === true/);
  assert.match(block, /protocolInteraction\.restoredOriginal === true/);
});

test("Manager action verifier uses native CDP mouse events instead of synthetic clicks", () => {
  assert.match(managerButtonTest, /async function dispatchManagerActionActualMouse/);
  assert.match(managerButtonTest, /Input\.dispatchMouseEvent/);
  assert.doesNotMatch(managerButtonTest, /actionCenterTarget\.dispatchEvent\(new MouseEvent\("click"/);
});

test("Manager zero-side-effect matrix covers every current daily and high-impact action", () => {
  const parseStringList = (sourceText, name, terminator) => {
    const match = sourceText.match(new RegExp(`const ${name} = ${terminator}\\(\\[([\\s\\S]*?)\\]\\);`));
    assert.ok(match, `${name} must be declared as a literal action list`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  };
  const injectedDaily = parseStringList(managerInject, "DAILY_ACTION_IDS", "new Set");
  const injectedHighImpact = parseStringList(managerInject, "HIGH_IMPACT_ACTION_IDS", "new Set");
  const verifierDaily = parseStringList(managerButtonTest, "MANAGER_DAILY_ACTION_IDS", "Object\\.freeze");
  const verifierHighImpact = parseStringList(managerButtonTest, "MANAGER_HIGH_IMPACT_ACTION_IDS", "Object\\.freeze");
  const actionsBlock = managerInject.match(/const ACTIONS = \[([\s\S]*?)\n  \];/)?.[1] ?? "";
  const injectedActions = [...actionsBlock.matchAll(/\["([^"]+)",/g)].map((entry) => entry[1]);
  const parsePowerShellList = (name) => {
    const block = managerRealButtonsTest.match(new RegExp(`\\$${name} = @\\(([\\s\\S]*?)\\n    \\)`))?.[1] ?? "";
    return [...block.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  };

  assert.deepEqual(verifierDaily, injectedDaily);
  assert.deepEqual(verifierHighImpact, injectedHighImpact);
  assert.deepEqual([...new Set([...injectedDaily, ...injectedHighImpact])].sort(), [...new Set(injectedActions)].sort());
  assert.deepEqual(parsePowerShellList("dailyActions"), injectedDaily);
  assert.deepEqual(parsePowerShellList("highImpactActions"), injectedHighImpact);
  assert.equal(new Set([...verifierDaily, ...verifierHighImpact]).size, 20);
  assert.match(managerButtonTest, /const uiOnlyMatrix = flagEnabled\("--ui-only-matrix"\)/);
  assert.match(managerButtonTest, /const uiOnlyBatchMode = uiOnlyMatrix \|\| flagEnabled\("--ui-only-batch"\)/);
  assert.match(managerButtonTest, /const uiOnlyMode = verificationMode === "ui-only" \|\| uiOnlyBatchMode/);
  assert.match(managerButtonTest, /MANAGER_ALL_ACTION_IDS\.filter\(\(actionName\) => actionName !== "upstreamConfig"\)/);
  assert.match(managerButtonTest, /output\.mode = "ui-only-matrix"/);
  assert.match(managerButtonTest, /function uiOnlyBatchBridgeSource\(enabled = uiOnlyBatchMode\)/);
  assert.match(managerButtonTest, /__ANTICODEX_RUN_MANAGER_REQUEST__/);
  assert.match(managerButtonTest, /managerActionDelta === 0/);
  assert.match(managerButtonTest, /managerRequestDelta === 0/);
  assert.match(managerButtonTest, /nativeRequestDelta === 0/);
  assert.doesNotMatch(managerButtonTest, /output\.zeroSideEffects = true/);
  assert.doesNotMatch(managerButtonTest, /output\.usedRealTraffic = false/);
  assert.match(managerRealButtonsTest, /managerBridgeLog\.actionReceivedDelta/);
  assert.match(managerRealButtonsTest, /managerBridgeLog\.requestReceivedDelta/);
  assert.match(managerRealButtonsTest, /traffic\.requestDelta/);
});

test("Manager native mouse verifier recomputes live hit coordinates and proves double confirmation", () => {
  const start = managerButtonTest.indexOf("async function dispatchManagerActionActualMouse");
  const end = managerButtonTest.indexOf("async function verifyUpstreamConfigActualMouseClick", start);
  const block = managerButtonTest.slice(start, end);
  assert.match(block, /async function dispatchManagerActionActualMouse\(actionName\)/);
  assert.match(block, /const firstPoint = await readManagerActionClickPoint\(actionName\)/);
  assert.match(block, /const secondPoint = await readManagerActionClickPoint\(actionName\)/);
  assert.match(block, /Input\.dispatchMouseEvent/);
  assert.match(block, /requiredConfirmation/);
  assert.match(block, /confirmationArmed/);
  assert.match(block, /confirmationCleared/);
  assert.match(block, /expectedClickCount/);
  assert.match(block, /\bpoints,\s*\n/);
  assert.doesNotMatch(block, /dispatchManagerActionActualMouse\(actionName, point\)/);
  const batchStart = managerButtonTest.indexOf("async function runManagerActionBatch");
  const batchEnd = managerButtonTest.indexOf("if (uiOnlyMatrix)", batchStart);
  const batchBlock = managerButtonTest.slice(batchStart, batchEnd);
  assert.match(batchBlock, /let drainedPayloads = uiOnlyMode \? \{\} : await drainManagerActionQueue\(\)/);
  assert.match(batchBlock, /if \(!uiOnlyMode\) drainedPayloads =/);
  assert.equal((batchBlock.match(/verifyCloseButtonActualMouseClick\(\)/g) || []).length, 1);
  assert.ok(batchBlock.indexOf("const batchCloseActualMouse") < batchBlock.indexOf("for (const actionName of actions)"));
  const idleStart = managerButtonTest.indexOf("async function waitForUiOnlyBatchIdle");
  const idleEnd = managerButtonTest.indexOf("async function cleanupInjectedBridges", idleStart);
  const idleBlock = managerButtonTest.slice(idleStart, idleEnd);
  assert.match(idleBlock, /const queueStable =/);
  assert.doesNotMatch(idleBlock, /if \(latest\.overlayPresent &&/);
  assert.match(idleBlock, /!latest\.running && queueStable/);
});

test("Manager ui-only matrix shortens account observation without editing product constants", () => {
  const setup = managerButtonTest.slice(0, managerButtonTest.indexOf("async function acquireManagerButtonLock"));
  assert.match(setup, /if \(uiOnlyMode\) \{/);
  assert.match(setup, /replace\("const ACCOUNT_SWITCH_POLL_INTERVAL_MS = 3000;", "const ACCOUNT_SWITCH_POLL_INTERVAL_MS = 25;"\)/);
  assert.match(setup, /replace\("const ACCOUNT_SWITCH_TIMEOUT_MS = 120000;", "const ACCOUNT_SWITCH_TIMEOUT_MS = 150;"\)/);
  assert.match(setup, /accountSwitchCapturePatchCount/);
  assert.match(setup, /ui-only-account-fingerprint/);
  assert.match(setup, /ui-only-model-fingerprint/);
  assert.match(setup, /failed to isolate account-switch state capture/i);
  assert.match(managerButtonTest, /function isUiOnlyActionFinished\(actionName, state\)/);
  assert.match(managerButtonTest, /actionName === "accountSwitch"/);
});

test("Manager ui-only bridge remains fail-closed until an active action settles", () => {
  const start = managerButtonTest.indexOf("function uiOnlyBridgeSource");
  const end = managerButtonTest.indexOf("function realBridgeSource", start);
  const bridgeBlock = managerButtonTest.slice(start, end);
  assert.match(bridgeBlock, /__ANTICODEX_MANAGER_BUTTON_UI_ONLY_CALLS__/);
  assert.match(bridgeBlock, /__ANTICODEX_MANAGER_BUTTON_UI_ONLY_RESTORE_TIMER__/);

  const cleanupStart = managerButtonTest.indexOf("function cleanupUiOnlyBridgeSource");
  const cleanupEnd = managerButtonTest.indexOf("function managerSummaryFromActionPayload", cleanupStart);
  const cleanupBlock = managerButtonTest.slice(cleanupStart, cleanupEnd);
  assert.match(cleanupBlock, /function managerActionStillActive/);
  assert.match(cleanupBlock, /data-anticodex-busy/);
  assert.match(cleanupBlock, /button\[data-action\]:disabled/);
  assert.match(cleanupBlock, /setInterval/);
  assert.match(cleanupBlock, /restoreUiOnlyBridge/);
  assert.ok(cleanupBlock.indexOf("managerActionStillActive()") < cleanupBlock.indexOf("restoreUiOnlyBridge();"));
});

test("Manager real-buttons wrapper exposes a dedicated safe UI-only matrix entry", () => {
  const normalizedWrapper = managerRealButtonsTest.replaceAll("\r\n", "\n");
  assert.ok(normalizedWrapper.includes([
    '$managerButtonScript = Join-Path $PSScriptRoot "test-anticodex-manager-button.mjs"',
    'if (-not (Test-Path -LiteralPath $managerButtonScript -PathType Leaf)) {',
    '    $managerButtonScript = Join-Path $runtimeRootFull "scripts\\test-anticodex-manager-button.mjs"',
    '}',
  ].join("\n")));
  const sourceVerifier = managerRealButtonsTest.indexOf(
    '$managerButtonScript = Join-Path $PSScriptRoot "test-anticodex-manager-button.mjs"',
  );
  const installedVerifierFallback = managerRealButtonsTest.indexOf(
    '$managerButtonScript = Join-Path $runtimeRootFull "scripts\\test-anticodex-manager-button.mjs"',
  );
  assert.ok(sourceVerifier >= 0);
  assert.ok(installedVerifierFallback > sourceVerifier);
  assert.match(managerRealButtonsTest, /\[switch\]\$UiOnlyMatrix/);
  assert.match(managerRealButtonsTest, /"--ui-only-matrix", "1"/);
  assert.match(managerRealButtonsTest, /"--verification-mode", "ui-only"/);
  assert.match(managerRealButtonsTest, /manager-ui-only-button-matrix/);
  assert.match(managerRealButtonsTest, /usedRealTraffic -ne \$false/);
  assert.match(managerRealButtonsTest, /zeroSideEffects -ne \$true/);
  assert.match(managerRealButtonsTest, /actionActualMouseExpectedClickCount/);
  assert.match(managerRealButtonsTest, /actionActualMouseConfirmationCleared/);
});

test("profile-entry verifier closes an existing Manager overlay before opening settings", () => {
  const start = managerButtonTest.indexOf("async function verifyProfileManagerEntryActualMouseWithFreshCdp()");
  const end = managerButtonTest.indexOf("async function verifyCloseButtonActualMouseClick()", start);
  const block = managerButtonTest.slice(start, end);
  const closeIndex = block.indexOf("existingManagerOverlay");
  const triggerIndex = block.indexOf("const trigger =");

  assert.ok(closeIndex >= 0 && triggerIndex > closeIndex);
  assert.match(block, /data-anticodex-close="true"/);
  assert.match(block, /existing Manager overlay did not close/);
});

test("Manager close verifier waits for the renderer to remove the overlay after actual mouse input", () => {
  const start = managerButtonTest.indexOf("async function verifyCloseButtonActualMouseClick()");
  const end = managerButtonTest.indexOf("async function readManagerActionClickPoint", start);
  const block = managerButtonTest.slice(start, end);
  assert.match(block, /const closeDeadline = Date\.now\(\) \+ 3000/);
  assert.match(block, /while \(closed\.closed !== true && Date\.now\(\) < closeDeadline\)/);
  assert.doesNotMatch(block, /await sleep\(150\);\s*const closed/);
});

test("Manager verifier restores any action bridge that it replaces", () => {
  assert.match(managerButtonTest, /__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__ = window\.__ANTICODEX_RUN_MANAGER_ACTION__/);
  assert.match(managerButtonTest, /function cleanupRealBridgeSource/);
  assert.match(managerButtonTest, /window\.__ANTICODEX_RUN_MANAGER_ACTION__ = window\.__ANTICODEX_MANAGER_BUTTON_ORIGINAL_ACTION_BRIDGE__/);
  assert.match(managerButtonTest, /realBridgeSource\(!uiOnlyMode && !upstreamConfigOnly && !closeOnly\)/);
  const finalCleanup = managerButtonTest.lastIndexOf("cleanupRealBridgeSource()");
  const finalClose = managerButtonTest.lastIndexOf("ws.close()");
  assert.ok(finalCleanup >= 0 && finalCleanup < finalClose, "single-action cleanup must run before the CDP socket closes");
});

test("Manager bridge invokes the real model refresh action", () => {
  const block = source.match(/async function runAction\(action\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(block, /action === "refreshModels"[\s\S]*?`\$\{baseUrl\}\/models`/);
  assert.match(block, /postManagerJsonWithToken\([\s\S]*?"\/anticodex\/manager\/action"/);
});

test("current Manager UI exposes no legacy session-controller action", () => {
  assert.match(managerInject, /const VERSION = "native-panel-v107"/);
  assert.match(managerOpenInject, /__ANTICODEX_MANAGER_VERSION__ === "native-panel-v107"/);
  for (const [name, text] of Object.entries({ source, managerInject, managerService })) {
    assert.doesNotMatch(text, /resetAntigravitySessionLock/, `${name} still exposes the removed session reset`);
  }
});

test("native compatibility style makes closed Radix menu wrappers mouse transparent", () => {
  assert.match(managerInject, /anticodex-native-compat-style/);
  assert.match(
    managerInject,
    /\[data-radix-popper-content-wrapper\]:has\(> \[data-radix-menu-content\]\[data-state="closed"\]\)\{pointer-events:none!important\}/,
  );
});
