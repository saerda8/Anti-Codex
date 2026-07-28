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
const uiStateTest = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.mjs"), "utf8");
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

const EXPECTED_ACTION_GROUPS = Object.freeze({
  status: Object.freeze(["refreshStatus"]),
  modelSources: Object.freeze(["refreshModels", "accountSwitch", "upstreamConfig"]),
  updates: Object.freeze(["updateCheck", "syncHost"]),
  troubleshooting: Object.freeze(["repairShortcuts", "diagnosticsBundle", "viewLatestReports"]),
  advanced: Object.freeze([
    "accountProxy", "syncReadiness", "sourcePreflight", "mcpSkills",
    "pluginCapabilities", "refreshFeatures", "fastOverallNoTraffic",
    "overallNoTraffic", "stabilitySoak", "coldRelaunch", "postVerificationFull",
  ]),
});
const EXPECTED_ACTION_IDS = Object.freeze(Object.values(EXPECTED_ACTION_GROUPS).flat());

function parseFrozenActionGroups(sourceText, name) {
  const declaration = sourceText.search(new RegExp(`const\\s+${name}\\s*=`));
  assert.ok(declaration >= 0, `${name} must be declared once as the shared frozen group shape`);
  const objectStart = sourceText.indexOf("{", declaration);
  const object = extractBalanced(sourceText, objectStart, "{", "}");
  return Object.fromEntries([...object.matchAll(/(\w+)\s*:\s*Object\.freeze\(\s*\[/g)].map((entry) => [
    entry[1],
    quotedStrings(extractBalanced(object, object.indexOf("[", entry.index), "[", "]")),
  ]));
}

function extractBalanced(sourceText, start, open, close) {
  assert.equal(sourceText[start], open, `missing ${open} at ${start}`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === open) {
      depth += 1;
    } else if (character === close && --depth === 0) {
      return sourceText.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated ${open}${close} block`);
}

function extractNamedFunction(sourceText, name) {
  const start = sourceText.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = sourceText.indexOf("{", start);
  const body = extractBalanced(sourceText, bodyStart, "{", "}");
  return sourceText.slice(start, bodyStart) + body;
}

function quotedStrings(sourceText) {
  return [...sourceText.matchAll(/"([^"]+)"|'([^']+)'/g)].map((entry) => entry[1] ?? entry[2]);
}

test("Manager update summaries unwrap results and show advisory CodexPlusPlus releases", () => {
  for (const [sourceText, functionName] of [[source, "managerSummary"], [managerInject, "summaryText"]]) {
    const summarize = vm.runInNewContext(`(${extractNamedFunction(sourceText, functionName)})`);
    for (const scenario of [
      { updateNeeded: true, components: { remoteState: "not_checked" }, status: /\u9700\u8981\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1a\u672a\u68c0\u67e5/ },
      { updateNeeded: false, components: { remoteState: "current", remoteTag: "v1.2.43" }, status: /\u65e0\u9700\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1av1\.2\.43\uff08\u9879\u76ee\u5df2\u8ddf\u8fdb\uff09/ },
      { updateNeeded: false, components: { remoteState: "newer_available", remoteTag: "v1.2.44", remoteNewerThanProject: true }, status: /\u65e0\u9700\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1av1\.2\.44\uff08\u5f85\u9002\u914d\u9a8c\u8bc1\uff09/ },
      { updateNeeded: false, components: { remoteState: "failed" }, status: /\u65e0\u9700\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1a\u68c0\u67e5\u5931\u8d25/ },
    ]) {
      const payload = {
        ok: true,
        result: {
          result: {
            ok: true,
            updateNeeded: scenario.updateNeeded,
            source: { packageVersion: "26.source" },
            active: { packageVersion: "26.active" },
            components: { sourceVersion: "1.2.43", activeVersion: "1.2.43", ...scenario.components },
          },
        },
      };
      const summary = summarize("updateCheck", payload);
      assert.match(summary, scenario.status);
      assert.match(summary, /Codex\uff1a\u672c\u673a\u5b98\u65b9 26\.source \/ Anti-Codex 26\.active/);
      assert.match(summary, /CodexPlusPlus\uff1a\u9879\u76ee\u56fa\u5b9a 1\.2\.43 \/ \u5df2\u5b89\u88c5 1\.2\.43/);
      assert.match(summary, scenario.remote);
      if (scenario.components.remoteState === "newer_available") assert.doesNotMatch(summary, /\u9700\u8981\u540c\u6b65/);
    }
  }
});

function parseNamedStringList(sourceText, name) {
  const declaration = sourceText.search(new RegExp(`const\\s+${name}\\s*=`));
  assert.ok(declaration >= 0, `missing action list ${name}`);
  const arrayStart = sourceText.indexOf("[", declaration);
  return quotedStrings(extractBalanced(sourceText, arrayStart, "[", "]"));
}

function parseInjectedActionGroups(sourceText) {
  const memberships = parseFrozenActionGroups(sourceText, "MANAGER_ACTION_GROUPS");
  const setup = extractNamedFunction(sourceText, "installActions").split("for (const [action, label] of ACTIONS)")[0];
  const groupIds = [...setup.matchAll(/\bid:\s*(["'])([^"']+)\1/g)].map((entry) => entry[2]);
  for (const entry of setup.matchAll(/["']data-action-group["']\s*:\s*(["'])([^"']+)\1/g)) {
    if (!groupIds.includes(entry[2])) groupIds.push(entry[2]);
  }
  return groupIds.map((id) => ({ id, actionIds: memberships[id] || [] }));
}

function parseFallbackActionGroups(sourceText) {
  const groups = [];
  for (const start of sourceText.matchAll(/<(section|details)\b([^>]*)data-action-group="([^"]+)"([^>]*)>/g)) {
    const openingTag = start[0];
    const contentStart = start.index + openingTag.length;
    const contentEnd = sourceText.indexOf(`</${start[1]}>`, contentStart);
    const content = sourceText.slice(contentStart, contentEnd < 0 ? contentStart : contentEnd);
    const actionIds = [...content.matchAll(/data-manager-action="([^"]+)"/g)].map((entry) => entry[1]);
    for (const list of content.matchAll(/\$\{\s*([A-Z][A-Z0-9_]*)(?:\.(\w+))?\.map\(/g)) {
      actionIds.push(...(list[2]
        ? (parseFrozenActionGroups(sourceText, list[1])[list[2]] || [])
        : parseNamedStringList(sourceText, list[1])));
    }
    groups.push({ id: start[3], tag: start[1], openingTag, content, actionIds });
  }
  return groups;
}

function assertExactActionGroups(groups, label, expectedGroups = EXPECTED_ACTION_GROUPS) {
  const expectedActionIds = Object.values(expectedGroups).flat();
  assert.deepEqual(groups.map((group) => group.id), Object.keys(expectedGroups), `${label} group names/order differ`);
  for (const group of groups) {
    assert.deepEqual(group.actionIds, expectedGroups[group.id], `${label} ${group.id} membership differs`);
  }
  const actionIds = groups.flatMap((group) => group.actionIds);
  assert.equal(new Set(actionIds).size, actionIds.length, `${label} contains duplicate actions`);
  assert.deepEqual(actionIds, expectedActionIds, `${label} all-action order differs`);
}

test("Manager third-party form saves configuration without switching the active model", () => {
  const start = managerInject.indexOf("async function showUpstreamConfig()");
  const end = managerInject.indexOf("function installActions()", start);
  const block = managerInject.slice(start, end);

  assert.ok(/text:\s*"保存配置"/.test(block), "third-party form is missing 保存配置");
  assert.ok(block.includes("配置已保存，可在聊天输入框的模型菜单选择第三方模型。"), "third-party form is missing saved guidance");
  for (const [label, forbidden] of [
    ["保存并切换", /保存并切换/],
    ["恢复 Antigravity", /恢复 Antigravity/],
    ["Antigravity 模型", /Antigravity 模型/],
    ["reloadNativeCodexConfig", /reloadNativeCodexConfig/],
    ["selectNativeModelByLabels", /selectNativeModelByLabels/],
    ['mode: "antigravity"', /mode:\s*"antigravity"/],
  ]) {
    assert.equal(forbidden.test(block), false, `third-party form still exposes ${label}`);
  }
});

test("Manager injected UI owns third-party setup while the fallback page omits the unsupported fake action", () => {
  const injectedGroups = parseInjectedActionGroups(managerInject);
  const fallbackGroups = parseFallbackActionGroups(managerService);
  const installActions = extractNamedFunction(managerInject, "installActions");
  const fallbackExpectedGroups = {
    ...EXPECTED_ACTION_GROUPS,
    modelSources: EXPECTED_ACTION_GROUPS.modelSources.filter((action) => action !== "upstreamConfig"),
  };

  assert.doesNotMatch(installActions.slice(0, installActions.indexOf("for (const [action, label] of ACTIONS)")), /\bids\s*:/);
  assertExactActionGroups(injectedGroups, "injected Manager");
  assertExactActionGroups(fallbackGroups, "fallback Manager", fallbackExpectedGroups);
  assert.doesNotMatch(managerService, /if \(actionName === "upstreamConfig"\)/);
});

test("Manager advanced diagnostics are collapsed details with a visible label", () => {
  const advancedMarker = managerInject.search(/["']data-action-group["']\s*:\s*["']advanced["']/);
  const detailsCalls = [...managerInject.matchAll(/el\(\s*["']details["']/g)].filter((match) => match.index < advancedMarker);
  const injectedCallStart = detailsCalls.at(-1)?.index ?? -1;
  assert.ok(advancedMarker >= 0 && injectedCallStart >= 0, "injected Manager is missing advanced details");
  const injectedAdvanced = extractBalanced(managerInject, managerInject.indexOf("(", injectedCallStart), "(", ")");
  const injectedAttrs = extractBalanced(injectedAdvanced, injectedAdvanced.indexOf("{"), "{", "}");
  assert.match(injectedAttrs, /["']data-action-group["']\s*:\s*["']advanced["']/);
  assert.match(injectedAdvanced, /el\(\s*["']summary["'][\s\S]*?高级诊断/);
  assert.doesNotMatch(injectedAttrs, /["']?open["']?\s*:/);

  const fallbackGroups = parseFallbackActionGroups(managerService);
  const fallbackAdvanced = fallbackGroups.find((group) => group.id === "advanced");
  assert.equal(fallbackAdvanced?.tag, "details", "fallback advanced group must be details");
  assert.doesNotMatch(fallbackAdvanced?.openingTag || "", /\sopen(?:\s|=|>)/);
  assert.match(fallbackAdvanced?.content || "", /<summary[^>]*>\s*高级诊断\s*<\/summary>/);
});

test("Manager rendered-layout verifiers reject duplicate, unexpected, group-less, and misplaced controls", () => {
  const validLayout = {
    groups: Object.entries(EXPECTED_ACTION_GROUPS).map(([id, actionIds]) => ({ id, actionIds: [...actionIds] })),
    buttons: Object.entries(EXPECTED_ACTION_GROUPS).flatMap(([groupId, actionIds]) => actionIds.map((action) => ({ action, groupId }))),
  };
  const validators = [
    {
      name: "ui-state",
      validate: vm.runInNewContext(`(${extractNamedFunction(uiStateTest, "actionLayoutFailures")})`, {
        EXPECTED_ACTION_GROUPS,
        EXPECTED_ACTION_IDS,
      }),
      run(layout) { return this.validate(layout, this.name); },
    },
    {
      name: "button-matrix",
      validate: vm.runInNewContext(`(${extractNamedFunction(managerButtonTest, "managerActionLayoutFailures")})`, {
        MANAGER_ACTION_GROUPS: EXPECTED_ACTION_GROUPS,
        MANAGER_ALL_ACTION_IDS: EXPECTED_ACTION_IDS,
      }),
      run(layout) { return this.validate(layout); },
    },
  ];
  const invalidLayouts = [
    (layout) => layout.groups.push({ ...layout.groups[0], actionIds: [...layout.groups[0].actionIds] }),
    (layout) => layout.groups.push({ id: "unexpected", actionIds: [] }),
    (layout) => layout.buttons.push({ ...layout.buttons[0] }),
    (layout) => layout.buttons.push({ action: "unexpected", groupId: "" }),
    (layout) => { layout.buttons[0].groupId = ""; },
    (layout) => { layout.buttons[0].groupId = "advanced"; },
    (layout) => {
      layout.groups[0].actionIds = [];
      layout.groups[1].actionIds.unshift("refreshStatus");
    },
  ];

  for (const validator of validators) {
    assert.deepEqual([...validator.run(structuredClone(validLayout))], [], `${validator.name} rejects the valid layout`);
    for (const mutate of invalidLayouts) {
      const layout = structuredClone(validLayout);
      mutate(layout);
      assert.ok(validator.run(layout).length > 0, `${validator.name} accepted an invalid layout`);
    }
  }
});

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

test("all Manager CDP selectors skip an avatar overlay listed before the primary page", () => {
  for (const [name, scriptSource] of Object.entries({
    managerBridge: source,
    startupInjector: cdpInject,
    uiStateVerifier: uiStateTest,
    mouseVerifier: managerButtonTest,
  })) {
    const selectorSource = scriptSource.match(
      /function isAvatarOverlayTarget\(target\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction pickTarget\(targets\) \{[\s\S]*?\r?\n\}/,
    )?.[0];
    assert.ok(selectorSource, `${name} does not expose the shared target-selection contract`);
    const pickTarget = vm.runInNewContext(`(() => { ${selectorSource}; return pickTarget; })()`);
    const overlay = {
      id: "overlay",
      type: "page",
      title: "Anti-Codex",
      url: "app://-/index.html?initialRoute=%2Favatar-overlay",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/overlay",
    };
    const primary = {
      id: "primary",
      type: "page",
      title: "Anti-Codex",
      url: "app://-/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/primary",
    };
    const fallback = {
      id: "fallback",
      type: "page",
      title: "Other",
      url: "app://-/other.html",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/fallback",
    };

    assert.equal(pickTarget([overlay, primary])?.id, "primary", `${name} selected the avatar overlay`);
    assert.equal(pickTarget([overlay, fallback])?.id, "fallback", `${name} lost its non-overlay fallback`);
    assert.equal(pickTarget([overlay]), null, `${name} must fail closed when only the avatar overlay exists`);
  }
});

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

test("silent Manager snapshot refresh never reopens a panel the user closed", () => {
  const deliverStart = source.indexOf("async function deliver(request, session)");
  const deliverEnd = source.indexOf("controller = new ManagerBridgeRecoveryController", deliverStart);
  const deliverBlock = source.slice(deliverStart, deliverEnd);

  assert.match(
    deliverBlock,
    /if \(!isManagerRequest && isCurrentAction && !suppressRefreshStatusResult && !result && typeof globalThis\.__ANTICODEX_OPEN_MANAGER__ === "function"\)/,
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
  assert.match(block, /requiredConfirmation:\s*false/);
  assert.match(block, /expectedClickCount:\s*1/);
  assert.match(block, /form\.hasImpactWarning === false/);
  assert.doesNotMatch(block, /confirmationDeadline|secondClick/);
});

test("Manager action verifier uses native CDP mouse events instead of synthetic clicks", () => {
  assert.match(managerButtonTest, /async function dispatchManagerActionActualMouse/);
  assert.match(managerButtonTest, /Input\.dispatchMouseEvent/);
  assert.doesNotMatch(managerButtonTest, /actionCenterTarget\.dispatchEvent\(new MouseEvent\("click"/);
});

test("Manager zero-side-effect matrix covers every action in the five-group contract", () => {
  const parseStringList = (sourceText, name, terminator) => {
    const match = sourceText.match(new RegExp(`const ${name} = ${terminator}\\(\\[([\\s\\S]*?)\\]\\);`));
    assert.ok(match, `${name} must be declared as a literal action list`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  };
  const injectedHighImpact = parseStringList(managerInject, "HIGH_IMPACT_ACTION_IDS", "new Set");
  const fallbackHighImpact = parseStringList(managerService, "HIGH_IMPACT_MANAGER_ACTION_IDS", "Object\\.freeze");
  const verifierHighImpact = parseStringList(managerButtonTest, "MANAGER_HIGH_IMPACT_ACTION_IDS", "Object\\.freeze");
  const uiStateHighImpact = parseStringList(uiStateTest, "EXPECTED_HIGH_IMPACT_ACTION_IDS", "Object\\.freeze");
  const verifierGroups = parseFrozenActionGroups(managerButtonTest, "MANAGER_ACTION_GROUPS");
  const uiStateGroups = parseFrozenActionGroups(uiStateTest, "EXPECTED_ACTION_GROUPS");
  const verifierActions = Object.values(verifierGroups).flat();
  const actionsBlock = managerInject.match(/const ACTIONS = \[([\s\S]*?)\n  \];/)?.[1] ?? "";
  const injectedActions = [...actionsBlock.matchAll(/\["([^"]+)",/g)].map((entry) => entry[1]);
  const parsePowerShellList = (name) => {
    const block = managerRealButtonsTest.match(new RegExp(`\\$${name} = @\\(([\\s\\S]*?)\\n    \\)`))?.[1] ?? "";
    return [...block.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  };

  assert.deepEqual(verifierGroups, EXPECTED_ACTION_GROUPS);
  assert.deepEqual(uiStateGroups, EXPECTED_ACTION_GROUPS);
  assert.deepEqual(verifierActions, EXPECTED_ACTION_IDS);
  assert.equal(new Set(verifierActions).size, verifierActions.length, "each Manager action must belong to exactly one UI group");
  assert.equal(injectedHighImpact.includes("upstreamConfig"), false, "third-party setup must be an ordinary action");
  assert.deepEqual(fallbackHighImpact, injectedHighImpact);
  assert.deepEqual(verifierHighImpact, injectedHighImpact);
  assert.deepEqual(uiStateHighImpact, injectedHighImpact);
  assert.deepEqual([...injectedActions].sort(), [...EXPECTED_ACTION_IDS].sort());
  assert.deepEqual(
    [...parsePowerShellList("dailyActions"), ...parsePowerShellList("highImpactActions")].sort(),
    [...EXPECTED_ACTION_IDS].sort(),
  );
  assert.deepEqual(parsePowerShellList("highImpactActions"), injectedHighImpact);
  const mouseDispatchStart = managerButtonTest.indexOf("async function dispatchManagerActionActualMouse");
  const mouseDispatchEnd = managerButtonTest.indexOf("async function verifyUpstreamConfigActualMouseClick", mouseDispatchStart);
  const mouseDispatchBlock = managerButtonTest.slice(mouseDispatchStart, mouseDispatchEnd);
  assert.match(mouseDispatchBlock, /const requiredConfirmation = MANAGER_HIGH_IMPACT_ACTION_SET\.has\(actionName\)/);
  assert.doesNotMatch(mouseDispatchBlock, /MANAGER_ACTION_GROUPS/);
  assert.match(managerButtonTest, /const uiOnlyMatrix = flagEnabled\("--ui-only-matrix"\)/);
  assert.match(managerButtonTest, /const uiOnlyBatchMode = uiOnlyMatrix \|\| flagEnabled\("--ui-only-batch"\)/);
  assert.match(managerButtonTest, /const uiOnlyMode = verificationMode === "ui-only" \|\| uiOnlyBatchMode/);
  assert.match(managerButtonTest, /MANAGER_ALL_ACTION_IDS\.filter\(\(actionName\) => actionName !== "upstreamConfig"\)/);
  assert.match(managerButtonTest, /Object\.entries\(MANAGER_ACTION_GROUPS\)/);
  assert.match(managerButtonTest, /function managerActionLayoutFailures\(layout\)/);
  assert.match(managerButtonTest, /const groups = Array\.from\(overlay\?\.querySelectorAll\("\[data-action-group\]"\)/);
  assert.match(managerButtonTest, /const actionLayout = await readManagerActionLayout\(\)/);
  assert.match(managerButtonTest, /actionLayoutFailures\.length === 0/);
  assert.match(uiStateTest, /function actionLayoutFailures\(layout, label\)/);
  assert.match(uiStateTest, /const actionGroups = Array\.from\(reopenedOverlay\?\.querySelectorAll\("\[data-action-group\]"\)/);
  assert.doesNotMatch(uiStateTest, /const actionGroups = Object\.fromEntries/);
  assert.match(managerButtonTest, /output\.mode = "ui-only-matrix"/);
  assert.match(managerButtonTest, /function uiOnlyBatchBridgeSource\(enabled = uiOnlyBatchMode\)/);
  assert.match(managerButtonTest, /__ANTICODEX_RUN_MANAGER_REQUEST__/);
  assert.match(managerButtonTest, /managerActionDelta === 0/);
  assert.match(managerButtonTest, /managerNonHealthRequestDelta === 0/);
  assert.match(managerButtonTest, /nonHealthRequestReceivedCount/);
  assert.match(managerButtonTest, /nativeRequestDelta === 0/);
  assert.doesNotMatch(managerButtonTest, /output\.zeroSideEffects = true/);
  assert.doesNotMatch(managerButtonTest, /output\.usedRealTraffic = false/);
  assert.match(managerRealButtonsTest, /managerBridgeLog\.actionReceivedDelta/);
  assert.match(managerRealButtonsTest, /managerBridgeLog\.nonHealthRequestReceivedDelta/);
  assert.match(managerRealButtonsTest, /traffic\.requestDelta/);
});

test("Manager log counter excludes only the exact /health path", () => {
  const functionSource = managerButtonTest.match(
    /function managerBridgeLogCounts\(source\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(functionSource);
  const managerBridgeLogCounts = vm.runInNewContext(`(${functionSource})`);
  const counts = managerBridgeLogCounts([
    '{"event":"manager-action-received","action":"refreshStatus"}',
    '{"event":"manager-request-received","path":"/health"}',
    '{"event":"manager-request-received","path":"/healthcheck"}',
    '{"event":"manager-request-received","path":"/health?probe=1"}',
  ].join("\n"));

  assert.equal(counts.actionReceivedCount, 1);
  assert.equal(counts.requestReceivedCount, 3);
  assert.equal(counts.nonHealthRequestReceivedCount, 2);
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

test("Manager long actions enter pending UI without losing their late bridge result", () => {
  const bridgeActionBlock = managerInject.match(/async function runActionViaBridge\(action, actionToken = ""\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  const scriptActionBlock = managerInject.match(/async function runActionViaScript\(action\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  const installActionsStart = managerInject.indexOf("function installActions()");
  const installActionsEnd = managerInject.indexOf("installActions();", installActionsStart);
  const installActionsBlock = managerInject.slice(installActionsStart, installActionsEnd);
  const bridgeRunActionBlock = source.match(/async function runAction\(action\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const uiTransportMs = Number(managerInject.match(/const MANAGER_ACTION_TRANSPORT_TIMEOUT_MS = (\d+);/)?.[1]);
  const bridgeTransportMs = Number(source.match(/const MANAGER_ACTION_HTTP_TIMEOUT_MS = (\d+);/)?.[1]);
  const longestForegroundMs = Number(
    managerService.match(/overallNoTraffic:\s*\{[\s\S]*?timeoutMs:\s*(\d+),/)?.[1],
  );

  assert.match(bridgeActionBlock, /actionTransportTimeoutMs\(action\)/);
  assert.doesNotMatch(bridgeActionBlock, /actionUiTimeoutMs\(action\)\s*\+\s*1000/);
  assert.match(scriptActionBlock, /actionTransportTimeoutMs\(action\)/);
  assert.doesNotMatch(scriptActionBlock, /actionUiTimeoutMs\(action\)\s*\+\s*1000/);
  assert.match(installActionsBlock, /setTimeout\(\(\) => resolve\(\{ type: "timeout" \}\), actionUiTimeoutMs\(action\)\)/);
  assert.match(installActionsBlock, /actionPromise\.then\(async \(lateOutcome\) =>/);
  assert.match(installActionsBlock, /lateOutcome\.type === "error"[\s\S]*?result\.textContent = "\\u8fd0\\u884c\\u5931\\u8d25/);
  assert.match(bridgeRunActionBlock, /managerActionHttpTimeoutMs\(action\)/);
  assert.equal(longestForegroundMs, 240000);
  assert.ok(bridgeTransportMs > longestForegroundMs);
  assert.ok(uiTransportMs > bridgeTransportMs);
});

test("Manager late action delivery is gated by the exact action generation token", () => {
  const bridgeSourceBlock = source.match(/export function createManagerBridgeSource\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const bridgeActionBlock = extractNamedFunction(managerInject, "runActionViaBridge");
  const removeManagerBlock = extractNamedFunction(managerInject, "removeManager");
  const installActionsStart = managerInject.indexOf("function installActions()");
  const installActionsEnd = managerInject.indexOf("installActions();", installActionsStart);
  const installActionsBlock = managerInject.slice(installActionsStart, installActionsEnd);
  const deliveryStart = source.indexOf("async function deliver(request, session)");
  const deliveryEnd = source.indexOf("async function pollOnce()", deliveryStart);
  const deliveryBlock = source.slice(deliveryStart, deliveryEnd);

  assert.match(bridgeSourceBlock, /__ANTICODEX_RUN_MANAGER_ACTION__ = \(action, actionToken = ""\)/);
  assert.match(bridgeSourceBlock, /actionToken/);
  assert.match(installActionsBlock, /__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__/);
  assert.match(installActionsBlock, /runActionViaBridge\(action, actionToken\)/);
  assert.match(deliveryBlock, /request\.actionToken/);
  assert.match(deliveryBlock, /__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken/);
  assert.match(deliveryBlock, /if \(!isManagerRequest && isCurrentAction && !suppressRefreshStatusResult\) globalThis\.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = payload/);
  assert.doesNotMatch(deliveryBlock, /const isCurrentAction = !runningAction \|\| runningAction === deliveredAction/);
  assert.match(bridgeActionBlock, /if \(!actionToken \|\| window\.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken\) \{[\s\S]*?__ANTICODEX_MANAGER_SNAPSHOT__/);
  assert.match(removeManagerBlock, /invalidateManagerActionToken\("closed"\)/);
  assert.match(managerInject.slice(0, managerInject.indexOf("const DEFAULT_API")), /invalidateManagerActionToken\("reinject"\)/);
  const lateOutcomeBlock = installActionsBlock.slice(installActionsBlock.indexOf("actionPromise.then(async (lateOutcome) =>"));
  assert.ok(
    lateOutcomeBlock.indexOf("if (!isCurrentActionToken) return;")
      < lateOutcomeBlock.indexOf("window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ ="),
    "a stale late action must be rejected before it becomes the preserved Manager result",
  );
});

test("Manager repeated full verification and quota retry failures have truthful visible feedback", () => {
  const injectSummary = managerInject.match(/function summaryText\(action, payload\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  const bridgeSummary = source.match(/function managerSummary\(action, payload\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const noticeStart = managerInject.indexOf("async function runNoticeAction");
  const noticeEnd = managerInject.indexOf("notice.addEventListener", noticeStart);
  const noticeBlock = managerInject.slice(noticeStart, noticeEnd);

  for (const summary of [injectSummary, bridgeSummary]) {
    assert.match(summary, /action === "postVerificationFull"[\s\S]*?payload\?\.alreadyRunning/);
    assert.match(summary, /\\u5b8c\\u6574\\u9a8c\\u8bc1\\u5df2\\u5728\\u540e\\u53f0\\u8fd0\\u884c/);
  }
  assert.match(noticeBlock, /catch \(error\)/);
  assert.match(noticeBlock, /\\u91cd\\u65b0\\u68c0\\u67e5\\u5931\\u8d25/);
});

test("current Manager UI exposes no legacy session-controller action", () => {
  assert.match(managerInject, /const VERSION = "native-panel-v108"/);
  assert.match(managerOpenInject, /__ANTICODEX_MANAGER_VERSION__ === "native-panel-v108"/);
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
