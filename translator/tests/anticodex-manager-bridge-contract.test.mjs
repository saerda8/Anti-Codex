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
const managerActionTest = readFileSync(resolve(root, "scripts", "test-anticodex-manager-action.ps1"), "utf8");
const managerRealMouseAction = readFileSync(resolve(root, "scripts", "run-anticodex-manager-action-real-mouse.mjs"), "utf8");
const uiChatSmokeTest = readFileSync(resolve(root, "scripts", "test-anticodex-ui-chat-smoke.mjs"), "utf8");
const realSmallProjectTest = readFileSync(resolve(root, "scripts", "test-anticodex-real-small-project.ps1"), "utf8");
const accountProxyTest = readFileSync(resolve(root, "scripts", "test-anticodex-account-proxy-readiness.ps1"), "utf8");
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
  const paramsStart = sourceText.indexOf("(", start);
  const params = extractBalanced(sourceText, paramsStart, "(", ")");
  const bodyStart = sourceText.indexOf("{", paramsStart + params.length);
  const body = extractBalanced(sourceText, bodyStart, "{", "}");
  return sourceText.slice(start, bodyStart) + body;
}

function quotedStrings(sourceText) {
  return [...sourceText.matchAll(/"([^"]+)"|'([^']+)'/g)].map((entry) => entry[1] ?? entry[2]);
}

test("Manager update summaries unwrap results and show advisory CodexPlusPlus releases", () => {
  const managerActionResult = vm.runInNewContext(`(${extractNamedFunction(managerInject, "managerActionResult")})`);
  for (const [sourceText, functionName] of [
    [source, "managerSummary"],
    [managerInject, "summaryText"],
    [managerButtonTest, "managerSummaryFromActionPayload"],
  ]) {
    const summarize = vm.runInNewContext(`(${extractNamedFunction(sourceText, functionName)})`, { managerActionResult });
    for (const scenario of [
      { resultOk: true, updateNeeded: true, components: { remoteState: "not_checked" }, status: /\u9700\u8981\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1a\u672a\u68c0\u67e5/ },
      { resultOk: false, updateNeeded: true, components: { remoteState: "not_checked" }, status: /\u9700\u8981\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1a\u672a\u68c0\u67e5/ },
      { updateNeeded: false, components: { remoteState: "current", remoteTag: "v1.2.43" }, status: /\u65e0\u9700\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1av1\.2\.43\uff08\u9879\u76ee\u5df2\u8ddf\u8fdb\uff09/ },
      { updateNeeded: false, components: { remoteState: "newer_available", remoteTag: "v1.2.44", remoteNewerThanProject: true }, status: /\u65e0\u9700\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1av1\.2\.44\uff08\u5f85\u72ec\u7acb\u5019\u9009\u9a8c\u8bc1\uff1b\u540c\u6b65\u53ea\u5b89\u88c5\u9879\u76ee\u5df2\u63a5\u53d7\u7248\u672c\uff09/ },
      { updateNeeded: false, components: { remoteState: "failed" }, status: /\u65e0\u9700\u540c\u6b65/, remote: /\u8fdc\u7aef\u4e0a\u6e38\uff1a\u68c0\u67e5\u5931\u8d25/ },
    ]) {
      const payload = {
        ok: true,
        result: {
          result: {
            ok: scenario.resultOk ?? true,
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

test("Manager keeps the original update failure visible after rollback", () => {
  const format = vm.runInNewContext(`(${extractNamedFunction(managerInject, "updateOriginalFailureText")})`, {
    updateOperationStageText: ({ stage }) => stage,
  });
  assert.equal(
    format({ originalFailure: { stage: "activation", message: "candidate failed", error: "sync_failed", at: "2026-08-01T00:00:00.000Z" } }),
    "activation / candidate failed / \u9519\u8bef\uff1async_failed / 2026-08-01T00:00:00.000Z",
  );
  assert.match(managerInject, /\\u539f\\u59cb\\u5931\\u8d25|原始失败/);
  assert.match(managerService, /originalFailure\.message \|\| originalFailure\.error/);
});

test("Manager keeps current update drift separate from update history and unwraps sync receipts", () => {
  const unwrap = vm.runInNewContext(`(${extractNamedFunction(managerInject, "managerActionResult")})`);
  const updateStatus = vm.runInNewContext(`(${extractNamedFunction(managerInject, "updateStatusText")})`, {
    updateOperationStageText: () => "stage",
  });
  const summarize = vm.runInNewContext(`(${extractNamedFunction(managerInject, "summaryText")})`, {
    managerActionResult: unwrap,
  });
  const continuesInBackground = vm.runInNewContext(`(${extractNamedFunction(managerInject, "managerActionContinuesInBackground")})`, {
    MANAGER_BACKGROUND_START_ACTION_IDS: new Set(["syncHost"]),
    managerActionResult: unwrap,
  });

  assert.equal(updateStatus({
    ok: true,
    updateNeeded: true,
    operation: { state: "rolled_back", stage: "complete" },
  }), "\u9700\u8981\u540c\u6b65");

  const running = {
    ok: true,
    result: {
      ok: true,
      result: {
        ok: true,
        background: true,
        alreadyRunning: true,
        operationId: "op-existing",
        stage: "updater_handoff",
        message: "existing updater owns the operation",
      },
    },
  };
  assert.equal(continuesInBackground("syncHost", running), true);
  assert.match(summarize("syncHost", running), /\u540c\u6b65\u5df2\u5728\u540e\u53f0\u8fd0\u884c/);
  assert.match(summarize("syncHost", running), /op-existing/);
  assert.match(summarize("syncHost", running), /updater_handoff/);

  const failed = {
    ok: false,
    result: {
      ok: false,
      background: false,
      stage: "updater_handoff_failed",
      error: "updater handoff failed",
    },
  };
  assert.equal(continuesInBackground("syncHost", failed), false);
  assert.match(summarize("syncHost", failed), /\u540c\u6b65\u542f\u52a8\u5931\u8d25/);
  assert.match(summarize("syncHost", failed), /updater handoff failed/);
});

test("Manager names the CodexPlusPlus preflight before update construction", () => {
  const stageText = vm.runInNewContext(`(${extractNamedFunction(managerInject, "updateOperationStageText")})`);
  const progressStage = vm.runInNewContext(`(${extractNamedFunction(managerInject, "actionProgressStage")})`);
  const runningText = vm.runInNewContext(`(${extractNamedFunction(managerInject, "runningText")})`, {
    actionProgressStage: progressStage,
  });

  assert.equal(stageText({ stage: "component_preflight" }), "\u6821\u9a8c CodexPlusPlus \u5019\u9009\u7ec4\u4ef6");
  assert.match(progressStage("syncHost", 0), /\u6821\u9a8c CodexPlusPlus \u5019\u9009\u7ec4\u4ef6/);
  assert.doesNotMatch(progressStage("syncHost", 0), /\u6784\u5efa/);
  assert.match(runningText("syncHost", "\u4e00\u952e\u66f4\u65b0", 0), /\u5148\u6821\u9a8c CodexPlusPlus \u5019\u9009\u7ec4\u4ef6\uff0c\u901a\u8fc7\u540e\u624d\u6784\u5efa/);
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

test("Manager reuses one successful upstream test for save and invalidates it after edits", () => {
  const start = managerInject.indexOf("async function showUpstreamConfig()");
  const end = managerInject.indexOf("function installActions()", start);
  const block = managerInject.slice(start, end);
  const testStart = block.indexOf("testButton.onclick");
  const saveStart = block.indexOf("saveButton.onclick", testStart);
  const saveEnd = block.indexOf("\n      refreshUpstreamConfigControls();", saveStart);
  const testHandler = block.slice(testStart, saveStart);
  const saveHandler = block.slice(saveStart, saveEnd);

  assert.match(testHandler, /managerPostJson\("\/anticodex\/upstream-test"/);
  assert.match(testHandler, /testedFingerprint = payload\.ok === true \? requestFingerprint : ""/);
  assert.match(saveHandler, /testedFingerprint !== upstreamConfigFingerprint\(\)/);
  assert.match(saveHandler, /managerPostJson\("\/anticodex\/upstream-profile"/);
  assert.doesNotMatch(saveHandler, /\/anticodex\/upstream-test/);

  const controlsStart = block.indexOf("const refreshUpstreamConfigControls");
  const controlsEnd = block.indexOf("const setUpstreamConfigBusy", controlsStart);
  const controlsBlock = block.slice(controlsStart, controlsEnd);
  assert.match(controlsBlock, /saveButton\.disabled = upstreamConfigOperationInFlight[\s\S]*?\|\| !testedFingerprint[\s\S]*?\|\| testedFingerprint !== upstreamConfigFingerprint\(\)/);

  const invalidateStart = block.indexOf("const invalidateConnectionTest");
  const invalidateEnd = block.indexOf("const upstreamConnectionSummaryText", invalidateStart);
  const invalidateBlock = block.slice(invalidateStart, invalidateEnd);
  assert.match(invalidateBlock, /testedFingerprint = ""/);
  assert.match(invalidateBlock, /refreshUpstreamConfigControls\(\)/);
  assert.match(invalidateBlock, /field\.addEventListener\("input", invalidateConnectionTest\)/);
  assert.match(invalidateBlock, /field\.addEventListener\("change", invalidateConnectionTest\)/);
});

test("Manager account and proxy check is no-traffic and returns a readable result", () => {
  assert.match(managerService, /accountProxy:\s*\{[\s\S]*?args:\s*\[[^\]]*"-NoRealRequest"[^\]]*\]/);
  assert.match(accountProxyTest, /\[switch\]\$NoRealRequest/);
  assert.match(accountProxyTest, /if \(-not \$NoRealRequest[\s\S]*?Invoke-LocalJsonSafe "real-response"/);

  const managerActionResult = vm.runInNewContext(`(${extractNamedFunction(managerInject, "managerActionResult")})`);
  const summarize = vm.runInNewContext(`(${extractNamedFunction(managerInject, "summaryText")})`, { managerActionResult });
  const summary = summarize("accountProxy", {
    ok: true,
    result: {
      diagnosis: "ready",
      diagnosisDetail: "ready",
      suggestedAction: "",
      account: { signedIn: true, planName: "Pro" },
      models: { count: 3 },
      realRequest: { attempted: false },
      report: { latest: "C:\\reports\\latest-account-proxy-readiness.json" },
    },
  });
  assert.match(summary, /账号\/代理检查：可用/);
  assert.match(summary, /已登录/);
  assert.match(summary, /模型数：3/);
  assert.doesNotMatch(summary, /^\{/);
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
  assert.match(managerService, /第三方 API 配置仅在客户端内的“管理”页面提供/);
  assert.doesNotMatch(managerService, /<input[^>]+(?:apiKey|type="password")/i);
});

test("embedded and fallback Manager use the same labels for shared actions", () => {
  const actionsStart = managerInject.indexOf("[", managerInject.indexOf("const ACTIONS ="));
  const embeddedActions = new Map(vm.runInNewContext(extractBalanced(managerInject, actionsStart, "[", "]")));
  const serviceStart = managerService.indexOf("{", managerService.indexOf("const MANAGER_ACTIONS ="));
  const serviceActions = vm.runInNewContext(`(${extractBalanced(managerService, serviceStart, "{", "}")})`);

  for (const [action, definition] of Object.entries(serviceActions)) {
    assert.equal(embeddedActions.get(action), definition.label, `${action} label differs between Manager pages`);
  }
});

test("fallback Manager waits for the same background action's fresh report and survives a short service restart", () => {
  const reportBlock = extractNamedFunction(managerService, "fallbackBackgroundReport");
  const reportFor = vm.runInNewContext(`(${reportBlock})`);
  const startedAt = Date.parse("2026-08-01T01:00:00.000Z");
  const snapshot = (reportedAt, ok = true) => ({
    result: {
      diagnostics: {
        managerActionResults: {
          stabilitySoak: {
            exists: true,
            ok,
            effectiveOk: ok,
            reportedAt,
            latestPath: "C:\\reports\\latest-stability-soak.json",
          },
        },
      },
    },
  });

  assert.equal(reportFor(snapshot("2026-08-01T00:59:59.000Z"), "stabilitySoak", startedAt), null);
  assert.equal(reportFor(snapshot("2026-08-01T01:00:01.000Z"), "postVerificationFull", startedAt), null);
  assert.equal(reportFor(snapshot("2026-08-01T01:00:01.000Z"), "stabilitySoak", startedAt).ok, true);
  assert.equal(reportFor(snapshot("2026-08-01T01:00:01.000Z", false), "stabilitySoak", startedAt).ok, false);

  const waitBlock = extractNamedFunction(managerService, "waitForFallbackBackgroundAction");
  const runBlock = extractNamedFunction(managerService, "runFallbackManagerAction");
  assert.match(waitBlock, /postFallbackManagerAction\("refreshStatus"\)/);
  assert.doesNotMatch(waitBlock, /postFallbackManagerAction\(action\)/);
  assert.match(waitBlock, /catch \(error\)[\s\S]*?managerActionToken = ""[\s\S]*?bootstrap\(\)/);
  assert.match(waitBlock, /FALLBACK_BACKGROUND_POLL_TIMEOUT_MS/);
  assert.match(runBlock, /const actionStartedAt = Date\.now\(\)/);
  assert.match(runBlock, /payload\?\.background === true \|\| payload\?\.result\?\.background === true/);
  assert.doesNotMatch(runBlock, /managerActions\[action\]\?\.background === true/);
  assert.match(runBlock, /waitForFallbackBackgroundAction\(action, actionStartedAt, result\)/);
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

test("startup Manager injection refreshes its CDP target after building the local snapshot", () => {
  const injectOnce = extractNamedFunction(cdpInject, "injectOnce");
  const snapshotEnd = injectOnce.indexOf("const newDocumentSource");
  const targetLookup = injectOnce.indexOf("const targets = await json");
  const socketOpen = injectOnce.indexOf("const ws = new LocalWebSocket", targetLookup);

  assert.ok(snapshotEnd >= 0 && targetLookup > snapshotEnd && socketOpen > targetLookup);
});

test("startup Manager watcher defers the full snapshot until its bridge is available", () => {
  const injectOnce = extractNamedFunction(cdpInject, "injectOnce");
  assert.match(
    injectOnce,
    /const snapshotPaths = managerWatchMode\s*\?\s*completeSnapshotPaths\.slice\(0,\s*2\)\s*:\s*completeSnapshotPaths/,
  );
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
  assert.equal((deliverBlock.match(/runAction\(action,/g) || []).length, 1);
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

test("Manager abandons a timed-out leased action without stranding later queue state", async () => {
  const renderer = {};
  renderer.globalThis = renderer;
  vm.runInNewContext(managerBridge.createManagerBridgeSource(), renderer);

  const timedOut = renderer.__ANTICODEX_RUN_MANAGER_ACTION__("mcpSkills", "timed-out-token");
  const [leased] = vm.runInNewContext(managerBridge.createManagerQueuePollSource(), renderer);
  assert.ok(leased?.id);
  assert.equal(leased.leaseCount, 1);
  assert.equal(typeof renderer.__ANTICODEX_ABANDON_MANAGER_ACTION__, "function");

  const timeoutPayload = {
    ok: false,
    action: "mcpSkills",
    actionToken: "timed-out-token",
    abandoned: true,
    message: "Anti-Codex manager bridge timed out.",
  };
  assert.equal(renderer.__ANTICODEX_ABANDON_MANAGER_ACTION__(leased.id, timeoutPayload), true);
  assert.deepEqual(await timedOut, timeoutPayload);
  assert.equal(renderer.__ANTICODEX_MANAGER_ACTION_QUEUE__.length, 0);
  assert.equal(Object.keys(renderer.__ANTICODEX_MANAGER_ACTION_PROMISES__).length, 0);

  const next = renderer.__ANTICODEX_RUN_MANAGER_ACTION__("refreshStatus", "next-token");
  const [nextLease] = vm.runInNewContext(managerBridge.createManagerQueuePollSource(), renderer);
  renderer.__ANTICODEX_ACK_MANAGER_ACTION__(nextLease.id, { ok: true, action: "refreshStatus" });
  assert.deepEqual(await next, { ok: true, action: "refreshStatus" });
  assert.equal(renderer.__ANTICODEX_MANAGER_ACTION_QUEUE__.length, 0);
  assert.equal(Object.keys(renderer.__ANTICODEX_MANAGER_ACTION_PROMISES__).length, 0);

  const bridgeActionBlock = extractNamedFunction(managerInject, "runActionViaBridge");
  assert.match(bridgeActionBlock, /__ANTICODEX_ABANDON_MANAGER_ACTION__/);
  assert.match(bridgeActionBlock, /bridgeRequestId/);
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

test("a queued silent refresh stays silent when its late result is delivered", () => {
  const deliverStart = source.indexOf("async function deliver(request, session)");
  const deliverEnd = source.indexOf("controller = new ManagerBridgeRecoveryController", deliverStart);
  const deliverBlock = source.slice(deliverStart, deliverEnd);
  const deliveryExpressionBlock = deliverBlock.slice(deliverBlock.indexOf("const deliveryExpression"));

  assert.match(deliverBlock, /const silent = request\.silent === true/);
  assert.match(deliveryExpressionBlock, /JSON\.stringify\(silent\)/);
  assert.doesNotMatch(deliveryExpressionBlock, /__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__/);
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
  const block = extractNamedFunction(source, "managerSnapshot");
  assert.match(block, /const trustedHeaders\s*=\s*\{/);
  assert.match(block, /origin:\s*baseUrl/);
  assert.match(block, /referer:\s*`\$\{baseUrl\}\/anticodex\/manager`/);
  assert.match(block, /headers:\s*trustedHeaders/);
});

test("Manager bridge and startup injector both build complete read snapshots", () => {
  const bridgeBlock = extractNamedFunction(source, "managerSnapshot");
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

test("Manager abandons an unleased stale bridge request before the long action timeout", async () => {
  const staleErrorSource = extractNamedFunction(managerInject, "managerBridgeStaleError");
  const invokeSource = extractNamedFunction(managerInject, "invokeManagerBridgeWithPickup");
  const context = {
    Date,
    Error,
    Promise,
    Set,
    MANAGER_BRIDGE_PICKUP_TIMEOUT_MS: 30,
    MANAGER_BRIDGE_BACKLOG_GRACE_MS: 100,
    MANAGER_BRIDGE_PICKUP_POLL_MS: 2,
    wait: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    window: {
      __ANTICODEX_MANAGER_ACTION_QUEUE__: [],
      __ANTICODEX_MANAGER_ACTION_PROMISES__: {},
    },
  };
  vm.runInNewContext(
    `${staleErrorSource}\n${invokeSource}\nthis.invokeManagerBridgeWithPickup = invokeManagerBridgeWithPickup;`,
    context,
  );

  const bridgePromise = () => new Promise((resolvePromise) => {
    const id = "stale-request";
    context.window.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve: resolvePromise };
    context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__.push({ id, action: "syncHost", leaseCount: 0 });
  });
  const startedAt = Date.now();
  await assert.rejects(
    context.invokeManagerBridgeWithPickup(bridgePromise),
    (error) => error?.code === "ANTICODEX_MANAGER_BRIDGE_STALE",
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__.length, 0);
  assert.equal(context.window.__ANTICODEX_MANAGER_ACTION_PROMISES__["stale-request"], undefined);
});

test("Manager preserves a new action while the bridge drains an already leased backlog", async () => {
  const staleErrorSource = extractNamedFunction(managerInject, "managerBridgeStaleError");
  const invokeSource = extractNamedFunction(managerInject, "invokeManagerBridgeWithPickup");
  const context = {
    Date,
    Error,
    Promise,
    Set,
    MANAGER_BRIDGE_PICKUP_TIMEOUT_MS: 30,
    MANAGER_BRIDGE_BACKLOG_GRACE_MS: 100,
    MANAGER_BRIDGE_PICKUP_POLL_MS: 2,
    wait: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    window: {
      __ANTICODEX_MANAGER_ACTION_QUEUE__: [],
      __ANTICODEX_MANAGER_ACTION_PROMISES__: {},
    },
  };
  vm.runInNewContext(
    `${staleErrorSource}\n${invokeSource}\nthis.invokeManagerBridgeWithPickup = invokeManagerBridgeWithPickup;`,
    context,
  );

  context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__.push(
    { id: "existing-read", kind: "manager-request", path: "/health", leaseCount: 1 },
  );
  const payload = await context.invokeManagerBridgeWithPickup(() => new Promise((resolvePromise) => {
    const request = { id: "new-action", action: "syncHost", leaseCount: 0 };
    context.window.__ANTICODEX_MANAGER_ACTION_PROMISES__[request.id] = { resolve: resolvePromise };
    context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__.push(request);
    setTimeout(() => {
      context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__ = [request];
      setTimeout(() => {
        request.leaseCount = 1;
        context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__ = [];
        delete context.window.__ANTICODEX_MANAGER_ACTION_PROMISES__[request.id];
        resolvePromise({ ok: true, action: "syncHost", transport: "bridge" });
      }, 5);
    }, 35);
  }));

  assert.equal(payload.transport, "bridge");
});

test("Manager uses the bridge only after pickup and safely falls back when app bridge is stale", () => {
  const requestBlock = extractNamedFunction(managerInject, "managerRequestViaBridge");
  const actionBlock = extractNamedFunction(managerInject, "runActionViaBridge");
  const snapshotBlock = extractNamedFunction(managerInject, "refreshManagerSnapshot");
  const liveJsonBlock = extractNamedFunction(managerInject, "managerGetLiveJson");
  const postJsonBlock = extractNamedFunction(managerInject, "managerPostJson");

  assert.match(requestBlock, /invokeManagerBridgeWithPickup/);
  assert.match(actionBlock, /invokeManagerBridgeWithPickup/);
  assert.match(snapshotBlock, /runActionViaBridge\("refreshStatus", actionToken\)/);
  assert.match(actionBlock, /isManagerBridgeStaleError\(error\)[\s\S]*?runActionViaScript\(action, actionToken\)/);
  assert.match(liveJsonBlock, /location\.protocol === "app:" && !isManagerBridgeStaleError\(error\)/);
  assert.match(postJsonBlock, /location\.protocol === "app:" && !isManagerBridgeStaleError\(error\)/);
});

test("Manager app-page stale action falls back once, while a leased action is never replayed", async () => {
  const staleErrorSource = extractNamedFunction(managerInject, "managerBridgeStaleError");
  const isStaleSource = extractNamedFunction(managerInject, "isManagerBridgeStaleError");
  const invokeSource = extractNamedFunction(managerInject, "invokeManagerBridgeWithPickup");
  const actionSource = extractNamedFunction(managerInject, "runActionViaBridge");
  let fallbackCalls = 0;
  const context = {
    Date,
    Error,
    Number,
    Promise,
    Set,
    MANAGER_BRIDGE_PICKUP_TIMEOUT_MS: 30,
    MANAGER_BRIDGE_BACKLOG_GRACE_MS: 100,
    MANAGER_BRIDGE_PICKUP_POLL_MS: 2,
    actionTransportTimeoutMs: () => 500,
    browserReachableApiBase: (value) => value,
    reconcileManagerPendingActions: () => {},
    runActionViaScript: async (action) => {
      fallbackCalls += 1;
      return { ok: true, action, transport: "script" };
    },
    setTimeout,
    wait: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    location: { protocol: "app:" },
    window: {
      __ANTICODEX_MANAGER_ACTION_QUEUE__: [],
      __ANTICODEX_MANAGER_ACTION_PROMISES__: {},
    },
  };
  vm.runInNewContext(
    `var activeApi = "http://127.0.0.1:8484";
${staleErrorSource}
${isStaleSource}
${invokeSource}
async ${actionSource}
this.runActionViaBridge = runActionViaBridge;`,
    context,
  );

  context.window.__ANTICODEX_RUN_MANAGER_ACTION__ = (action) => new Promise((resolvePromise) => {
    const id = "stale-action";
    context.window.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve: resolvePromise };
    context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__.push({ id, action, leaseCount: 0 });
  });
  const fallback = await context.runActionViaBridge("syncHost");
  assert.equal(fallback.transport, "script");
  assert.equal(fallbackCalls, 1);

  context.window.__ANTICODEX_RUN_MANAGER_ACTION__ = (action) => new Promise((resolvePromise) => {
    const id = "leased-action";
    const request = { id, action, leaseCount: 0 };
    context.window.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve: resolvePromise };
    context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__.push(request);
    setTimeout(() => {
      request.leaseCount = 1;
      setTimeout(() => {
        context.window.__ANTICODEX_MANAGER_ACTION_QUEUE__ = [];
        delete context.window.__ANTICODEX_MANAGER_ACTION_PROMISES__[id];
        resolvePromise({ ok: true, action, transport: "bridge" });
      }, 10);
    }, 2);
  });
  const leased = await context.runActionViaBridge("syncHost");
  assert.equal(leased.transport, "bridge");
  assert.equal(fallbackCalls, 1);
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
  assert.match(uiStateTest, /actionLayoutFailures\(managerPageActionLayout,\s*"manager page",\s*EXPECTED_FALLBACK_ACTION_GROUPS\)/);
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
  assert.match(managerButtonTest, /if \(uiOnlyBatchMode\) \{[\s\S]*?function managerActionContinuesInBackground\(\) \{[\s\S]*?return false/);
  assert.match(managerButtonTest, /MANAGER_ALL_ACTION_IDS\.filter\(\(actionName\) => actionName !== "upstreamConfig"\)/);
  assert.match(managerButtonTest, /Object\.entries\(MANAGER_ACTION_GROUPS\)/);
  assert.match(managerButtonTest, /function managerActionLayoutFailures\(layout\)/);
  assert.match(managerButtonTest, /const groups = Array\.from\(overlay\?\.querySelectorAll\("\[data-action-group\]"\)/);
  assert.match(managerButtonTest, /const actionLayout = await readManagerActionLayout\(\)/);
  assert.match(managerButtonTest, /actionLayoutFailures\.length === 0/);
  assert.match(uiStateTest, /function actionLayoutFailures\(layout, label, expectedGroups = EXPECTED_ACTION_GROUPS\)/);
  assert.match(uiStateTest, /const actionGroups = Array\.from\(reopenedOverlay\?\.querySelectorAll\("\[data-action-group\]"\)/);
  assert.doesNotMatch(uiStateTest, /const actionGroups = Object\.fromEntries/);
  assert.match(managerButtonTest, /output\.mode = "ui-only-matrix"/);
  assert.match(managerRealButtonsTest, /\$processTimeoutSec = if \(\$RunUiOnlyMatrix\) \{ \[Math\]::Max\(360,/);
  assert.match(managerRealButtonsTest, /\[string\[\]\]\$Actions\s*=\s*@\([^)]*"updateCheck"[^)]*"repairShortcuts"[^)]*\)/);
  assert.match(managerRealButtonsTest, /\$allowedActions\s*=\s*@\([^)]*"updateCheck"[^)]*"repairShortcuts"[^)]*\)/);
  assert.doesNotMatch(
    managerRealButtonsTest.match(/\$allowedActions\s*=\s*@\([^)]*\)/)?.[0] ?? "",
    /syncHost|coldRelaunch|stabilitySoak|postVerificationFull/,
  );
  assert.match(managerButtonTest, /function uiOnlyBatchBridgeSource\(enabled = uiOnlyBatchMode\)/);
  assert.match(managerButtonTest, /const staleState = window\.__ANTICODEX_MANAGER_BUTTON_UI_ONLY_BATCH_STATE__/);
  assert.match(managerButtonTest, /localStorage\.removeItem\("anticodex\.manager\.pending-actions\.v1"\)/);
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
  assert.doesNotMatch(managerRealButtonsTest, /actionGroups\.daily|actionGroups\.highImpact/);
  assert.match(managerRealButtonsTest, /\$expectedGroupNames = @\("status", "modelSources", "updates", "troubleshooting", "advanced"/);
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

test("connector allowlist save receives its status and reload dependencies", async () => {
  const classList = () => ({ add() {}, remove() {}, toggle() {} });
  const elStub = (tag, attrs = {}, children = []) => ({
    tag,
    ...attrs,
    children,
    classList: classList(),
  });
  let postCalls = 0;
  let reloadCalls = 0;
  let exclusiveCalls = 0;
  const context = {
    Array,
    Boolean,
    String,
    el: elStub,
    managerPostJson: async (path, body) => {
      postCalls += 1;
      assert.equal(path, "/anticodex/local-connectors/allowlist");
      assert.deepEqual(Array.from(body.connectorIds), ["alpha", "beta"]);
      return { counts: { localAllowlisted: 2, appTools: 1 } };
    },
    window: {},
  };
  const editor = vm.runInNewContext(`(${extractNamedFunction(managerInject, "connectorAllowlistEditor")})`, context);
  const result = { textContent: "", classList: classList() };
  const reload = async (options) => {
    reloadCalls += 1;
    assert.equal(options.updateResult, false);
  };
  const runExclusive = async (operation) => {
    exclusiveCalls += 1;
    await operation();
    return true;
  };
  const node = editor({ persisted: [], env: [], counts: {} }, result, reload, runExclusive);
  node.children[1].value = "alpha\nbeta";

  await node.children[2].onclick();

  assert.equal(postCalls, 1);
  assert.equal(reloadCalls, 1);
  assert.equal(exclusiveCalls, 1);
  assert.match(result.textContent, /allowlist.*已保存/);
});

test("Manager high-impact real-mouse helper requires dispatch evidence instead of disabled UI", () => {
  assert.match(managerRealMouseAction, /const inspectOnly =/);
  assert.match(managerRealMouseAction, /const timeoutMs = Number\(args\.get\("--timeout-ms"\) \|\| 35_000\)/);
  assert.match(managerRealMouseAction, /const dispatchBaseline = await evaluate/);
  assert.match(managerRealMouseAction, /tokenChanged && \(leased \|\| completed\)/);
  assert.match(managerRealMouseAction, /entry\?\.actionToken === currentActionToken/);
  assert.match(managerRealMouseAction, /last\?\.actionToken === currentActionToken/);
  assert.doesNotMatch(managerRealMouseAction, /accepted:\s*tokenChanged && \([^\n]*(?:queued|running)/);
  assert.doesNotMatch(managerRealMouseAction, /connectionClosedAfterDispatch:\s*true/);
  assert.doesNotMatch(managerRealMouseAction, /accepted:[^\n]*button\?\.disabled/);
  assert.doesNotMatch(managerRealMouseAction, /accepted:[^\n]*data-anticodex-busy/);
});

test("Manager real-button harness keeps silent snapshot refresh from replacing the action result", () => {
  const bridge = extractNamedFunction(managerButtonTest, "realBridgeSource");
  const drain = extractNamedFunction(managerButtonTest, "drainManagerActionQueue");
  assert.match(bridge, /const testActionBridge = \(requestedAction, actionToken = ""\)/);
  assert.match(bridge, /const silent = requestedAction === "refreshStatus"\s*&&\s*window\.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ === true/);
  assert.match(bridge, /actionToken/);
  assert.match(drain, /const silent = item\.silent === true/);
  assert.match(drain, /if \(!silent\) drainedPayloads\[item\.action\] = payload/);
  assert.match(drain, /if \(!silent\) \{[\s\S]*?__ANTICODEX_MANAGER_LAST_ACTION_RESULT__/);
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
  assert.doesNotMatch(
    managerButtonTest.match(/function isUiOnlyActionFinished\(actionName, state\) \{[\s\S]*?\n\}/)?.[0] || "",
    /isActionFailureText/,
  );
  assert.match(managerButtonTest, /actionName === "accountSwitch"/);
});

test("Manager ui-only matrix isolates background handling by function boundary", () => {
  const start = managerButtonTest.indexOf("if (uiOnlyBatchMode) {");
  const end = managerButtonTest.indexOf("if (uiOnlyMode && !uiOnlyBatchMode)", start);
  const setup = managerButtonTest.slice(start, end);
  assert.match(setup, /indexOf\("  function managerActionContinuesInBackground\("\)/);
  assert.match(setup, /indexOf\("  function wait\(", backgroundActionStart\)/);
  assert.doesNotMatch(setup, /payload\\\?\\\.background/);
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
  const block = extractNamedFunction(source, "runAction");
  assert.doesNotMatch(block, /action === "refreshModels"[\s\S]*?`\$\{baseUrl\}\/models`/);
  assert.match(block, /postManagerJsonWithToken\([\s\S]*?"\/anticodex\/manager\/action"/);
});

test("only an explicit refresh status action performs the slow snapshot source verification", () => {
  const bridgeSourceBlock = source.match(/export function createManagerBridgeSource\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const snapshotStart = source.indexOf("async function managerSnapshot");
  const snapshotEnd = source.indexOf("async function bootstrapManagerActionToken", snapshotStart);
  const snapshotBlock = source.slice(snapshotStart, snapshotEnd);
  const runActionBlock = source.match(/async function runAction\(action[\s\S]*?\n\}/)?.[0] ?? "";
  const deliveryStart = source.indexOf("async function deliver(request, session)");
  const deliveryEnd = source.indexOf("async function pollOnce()", deliveryStart);
  const deliveryBlock = source.slice(deliveryStart, deliveryEnd);
  const actionUiTimeoutBlock = extractNamedFunction(managerInject, "actionUiTimeoutMs");

  assert.match(bridgeSourceBlock, /silent:\s*action === "refreshStatus"/);
  assert.match(snapshotBlock, /verifySnapshotFreshness = false/);
  assert.match(snapshotBlock, /snapshotFreshness=refresh/);
  assert.match(runActionBlock, /managerSnapshot\(\{ verifySnapshotFreshness \}\)/);
  assert.match(deliveryBlock, /request\.silent !== true/);
  const completedActionStart = deliveryBlock.indexOf("completedPayload = await runAction(action");
  const completedActionEnd = deliveryBlock.indexOf("completedPayload.managerSummary = managerSummary", completedActionStart);
  assert.doesNotMatch(deliveryBlock.slice(completedActionStart, completedActionEnd), /await managerSnapshot\(/);
  assert.doesNotMatch(deliveryBlock, /snapshot: await managerSnapshot\(\)\.catch/);
  assert.match(managerInject, /snapshotStatus\?\.state === "unverified"/);
  assert.match(managerInject, /snapshotStatus\?\.state === "check_failed"/);
  assert.match(actionUiTimeoutBlock, /return actionTransportTimeoutMs\(action\) \+ 1000/);
  assert.match(managerButtonTest, /replace\("return actionTransportTimeoutMs\(action\) \+ 1000;", "return 120;"\)/);
});

test("Manager long actions enter pending UI without losing their late bridge result", () => {
  const bridgeActionBlock = extractNamedFunction(managerInject, "runActionViaBridge");
  const scriptActionBlock = extractNamedFunction(managerInject, "runActionViaScript");
  const installActionsStart = managerInject.indexOf("function installActions()");
  const installActionsEnd = managerInject.indexOf("installActions();", installActionsStart);
  const installActionsBlock = managerInject.slice(installActionsStart, installActionsEnd);
  const bridgeRunActionBlock = extractNamedFunction(source, "runAction");
  const actionUiTimeoutBlock = extractNamedFunction(managerInject, "actionUiTimeoutMs");
  const uiTransportMs = Number(managerInject.match(/const MANAGER_ACTION_TRANSPORT_TIMEOUT_MS = (\d+);/)?.[1]);
  const bridgeTransportMs = Number(source.match(/const MANAGER_ACTION_HTTP_TIMEOUT_MS = (\d+);/)?.[1]);
  const longestForegroundMs = Number(
    managerService.match(/overallNoTraffic:\s*\{[\s\S]*?timeoutMs:\s*(\d+),/)?.[1],
  );
  const refreshFeaturesMs = Number(
    managerService.match(/refreshFeatures:\s*\{[\s\S]*?timeoutMs:\s*(\d+),/)?.[1],
  );

  assert.match(bridgeActionBlock, /actionTransportTimeoutMs\(action\)/);
  assert.doesNotMatch(bridgeActionBlock, /actionUiTimeoutMs\(action\)\s*\+\s*1000/);
  assert.match(scriptActionBlock, /actionTransportTimeoutMs\(action\)/);
  assert.doesNotMatch(scriptActionBlock, /actionUiTimeoutMs\(action\)\s*\+\s*1000/);
  assert.match(installActionsBlock, /setTimeout\(\(\) => resolve\(\{ type: "timeout" \}\), actionUiTimeoutMs\(action\)\)/);
  assert.match(installActionsBlock, /actionPromise\.then\(async \(lateOutcome\) =>/);
  assert.match(installActionsBlock, /lateOutcome\.type === "error"[\s\S]*?result\.textContent = "\\u8fd0\\u884c\\u5931\\u8d25/);
  assert.match(bridgeRunActionBlock, /managerActionHttpTimeoutMs\(action\)/);
  assert.match(actionUiTimeoutBlock, /return actionTransportTimeoutMs\(action\) \+ 1000/);
  assert.equal(longestForegroundMs, 240000);
  assert.equal(refreshFeaturesMs, 300000);
  assert.ok(bridgeTransportMs > longestForegroundMs);
  assert.ok(bridgeTransportMs > refreshFeaturesMs);
  assert.ok(uiTransportMs > bridgeTransportMs);
});

test("Manager update checks wait past the service budget and never fabricate background success", () => {
  const timeoutBlock = extractNamedFunction(managerInject, "timeoutText");
  const timeoutMsBlock = extractNamedFunction(managerInject, "actionUiTimeoutMs");
  const installActionsStart = managerInject.indexOf("function installActions()");
  const installActionsEnd = managerInject.indexOf("installActions();", installActionsStart);
  const installActionsBlock = managerInject.slice(installActionsStart, installActionsEnd);
  const timeoutBranch = installActionsBlock.slice(
    installActionsBlock.indexOf('} else if (outcome.type === "timeout")'),
    installActionsBlock.indexOf("} else {", installActionsBlock.indexOf('} else if (outcome.type === "timeout")')),
  );
  const serviceBudgetMs = Number(
    managerService.match(/updateCheck:\s*\{[\s\S]*?timeoutMs:\s*(\d+),/)?.[1],
  );
  const actionUiTimeout = vm.runInNewContext(`(${timeoutMsBlock})`, {
    actionTransportTimeoutMs: () => 340000,
  });

  assert.equal(serviceBudgetMs, 30000);
  assert.equal(actionUiTimeout("updateCheck"), 341000);
  assert.match(timeoutMsBlock, /return actionTransportTimeoutMs\(action\) \+ 1000/);
  assert.match(timeoutBlock, /action === "updateCheck"[\s\S]*?\\u7ed3\\u679c\\u672a\\u77e5/);
  assert.match(timeoutBlock, /action === "updateCheck"[\s\S]*?\\u4ecd\\u7b49\\u5f85\\u672c\\u5730\\u68c0\\u67e5/);
  assert.doesNotMatch(timeoutBlock, /action === "updateCheck"[^\n]*\\u540e\\u53f0/);
  const timeoutText = vm.runInNewContext(`(${timeoutBlock})`);
  const positiveBackground = /已提交后台|已开始后台|已在后台/;
  for (const action of ["refreshModels", "refreshFeatures", "syncHost", "stabilitySoak", "coldRelaunch", "postVerificationFull"]) {
    const text = timeoutText(action, action);
    assert.doesNotMatch(text, positiveBackground, action);
    assert.match(text, /结果未返回|结果未知|仍在等待/, action);
  }
  assert.match(timeoutBranch, /const pendingStartedAt = actionStartedAt/);
  assert.match(timeoutBranch, /ok:\s*null/);
  assert.doesNotMatch(timeoutBranch, /ok:\s*true/);
  assert.match(timeoutBranch, /__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken/);
});

test("Manager summaries require an explicit background receipt", () => {
  const summarize = vm.runInNewContext(`(${extractNamedFunction(managerInject, "summaryText")})`, {
    managerActionResult: (payload) => {
      let result = payload && typeof payload === "object" ? payload : {};
      while (result?.result && typeof result.result === "object" && result.result !== result) result = result.result;
      return result;
    },
    sourceSnapshotLine: () => "",
    failureSummaryLine: () => "",
  });
  const bridgeSummarize = vm.runInNewContext(`(${extractNamedFunction(source, "managerSummary")})`, {
    sourceSnapshotLine: () => "",
    failureSummaryLine: () => "",
  });
  const positiveBackground = /已提交后台|已开始后台|已在后台/;
  const noReceipt = { ok: true, result: { result: { ok: true, background: false } } };
  const receipt = { ok: true, result: { result: { ok: true, background: true } } };
  for (const action of ["syncHost", "refreshFeatures", "stabilitySoak", "coldRelaunch", "postVerificationFull"]) {
    assert.doesNotMatch(summarize(action, noReceipt), positiveBackground, action);
    assert.doesNotMatch(bridgeSummarize(action, noReceipt), positiveBackground, `bridge ${action}`);
    assert.match(summarize(action, receipt), /后台/, `${action} receipt`);
    assert.match(bridgeSummarize(action, receipt), /后台/, `bridge ${action} receipt`);
  }
});

test("Manager keeps structured verifier failures available for readable UI summaries", () => {
  const bridgeActionBlock = extractNamedFunction(managerInject, "runActionViaBridge");
  assert.match(bridgeActionBlock, /payload\?\.ok !== false \|\| \(payload\?\.result && typeof payload\.result === "object"\)/);
});

test("Manager MCP summaries read the compact console evidence without false warnings", () => {
  const payload = {
    ok: true,
    result: {
      ok: true,
      mcp: { count: 1, realCallPassed: true, realListCount: 0 },
      skills: { count: 128, smokeReadable: true },
    },
  };
  const summary = vm.runInNewContext(`(${extractNamedFunction(managerInject, "summaryText")})`, {
    managerActionResult: (value) => value?.result || value || {},
  })("mcpSkills", payload);
  const bridgeSummary = vm.runInNewContext(`(${extractNamedFunction(source, "managerSummary")})`, {})("mcpSkills", payload);

  for (const text of [summary, bridgeSummary]) {
    assert.match(text, /node_repl 通过/);
    assert.match(text, /worker list 未执行（开发 worker 不注入）/);
    assert.match(text, /Skill 文件 可读/);
    assert.doesNotMatch(text, /需要处理|未知/);
  }
});

test("Manager script fallback rejects failed receipts unless they include structured verifier output", () => {
  const scriptActionBlock = extractNamedFunction(managerInject, "runActionViaScript");
  assert.match(scriptActionBlock, /payload\?\.ok !== false \|\| \(payload\?\.result && typeof payload\.result === "object"\)/);
  assert.match(scriptActionBlock, /throw new Error\(payload\.message \|\| "Anti-Codex manager action failed\."\)/);
});

test("Manager late action delivery is gated by the exact action generation token", () => {
  const bridgeSourceBlock = source.match(/export function createManagerBridgeSource\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const bridgeActionBlock = extractNamedFunction(managerInject, "runActionViaBridge");
  const snapshotRefreshBlock = extractNamedFunction(managerInject, "refreshManagerSnapshot");
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
  assert.match(deliveryBlock, /payload\.actionToken = actionToken/);
  assert.match(deliveryBlock, /if \(!isManagerRequest && isCurrentAction && !suppressRefreshStatusResult\) globalThis\.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = payload/);
  assert.doesNotMatch(deliveryBlock, /const isCurrentAction = !runningAction \|\| runningAction === deliveredAction/);
  assert.match(bridgeActionBlock, /if \(actionToken && window\.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken\) \{[\s\S]*?__ANTICODEX_MANAGER_SNAPSHOT__/);
  assert.match(snapshotRefreshBlock, /__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__/);
  assert.doesNotMatch(snapshotRefreshBlock, /__ANTICODEX_MANAGER_PENDING_ACTIONS__/);
  assert.match(snapshotRefreshBlock, /reconcileManagerPendingActions\(payload\.snapshot\)/);
  assert.match(snapshotRefreshBlock, /runActionViaBridge\("refreshStatus", actionToken\)/);
  assert.match(snapshotRefreshBlock, /__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken/);
  assert.match(removeManagerBlock, /invalidateManagerActionToken\("closed"\)/);
  assert.match(managerInject.slice(0, managerInject.indexOf("const DEFAULT_API")), /invalidateManagerActionToken\("reinject"\)/);
  const invalidateBlock = extractNamedFunction(managerInject, "invalidateManagerActionToken");
  assert.doesNotMatch(invalidateBlock, /delete window\.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__/);
  const immediateOutcomeBlock = installActionsBlock.slice(
    installActionsBlock.indexOf('if (outcome.type === "payload")'),
    installActionsBlock.indexOf('} else if (outcome.type === "timeout")'),
  );
  assert.ok(
    immediateOutcomeBlock.indexOf("const continuesInBackground = managerActionContinuesInBackground")
      < immediateOutcomeBlock.indexOf("if (window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;"),
    "a background-start receipt must preserve its pending lock before a closed or reinjected panel rejects stale UI delivery",
  );
  assert.ok(
    immediateOutcomeBlock.indexOf("if (window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;")
      < immediateOutcomeBlock.indexOf("window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ ="),
    "a closed or reinjected panel must reject a normal action result before preserving it",
  );
  const lateOutcomeBlock = installActionsBlock.slice(installActionsBlock.indexOf("actionPromise.then(async (lateOutcome) =>"));
  assert.ok(
    lateOutcomeBlock.indexOf("if (!isCurrentActionToken) return;")
      < lateOutcomeBlock.indexOf("window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ ="),
    "a stale late action must be rejected before it becomes the preserved Manager result",
  );
  assert.ok(
    installActionsBlock.lastIndexOf("delete window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__")
      < installActionsBlock.lastIndexOf('if (action !== "refreshStatus") void refreshManagerSnapshot()'),
    "the silent post-action snapshot must start only after the action in-flight token is cleared",
  );
});

test("Manager repeated full verification and quota retry failures have truthful visible feedback", () => {
  const injectSummary = managerInject.match(/function summaryText\(action, payload\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  const bridgeSummary = source.match(/function managerSummary\(action, payload\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const noticeStart = managerInject.indexOf("async function runNoticeAction");
  const noticeEnd = managerInject.indexOf("notice.addEventListener", noticeStart);
  const noticeBlock = managerInject.slice(noticeStart, noticeEnd);

  assert.match(injectSummary, /action === "postVerificationFull"[\s\S]*?unwrapped\?\.background !== true[\s\S]*?unwrapped\?\.alreadyRunning/);
  assert.match(bridgeSummary, /action === "postVerificationFull"[\s\S]*?unwrappedResult\?\.background !== true[\s\S]*?unwrappedResult\?\.alreadyRunning/);
  for (const summary of [injectSummary, bridgeSummary]) assert.match(summary, /\\u5b8c\\u6574\\u9a8c\\u8bc1\\u5df2\\u5728\\u540e\\u53f0\\u8fd0\\u884c/);
  assert.match(noticeBlock, /catch \(error\)/);
  assert.match(noticeBlock, /\\u91cd\\u65b0\\u68c0\\u67e5\\u5931\\u8d25/);
  assert.match(noticeBlock, /runActionViaBridge\("accountProxy", actionToken\)/);
  assert.match(noticeBlock, /__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken/);
  assert.match(noticeBlock, /catch \(error\) \{\s*if \(actionToken && window\.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken\) return;/);
  assert.ok(
    noticeBlock.indexOf("const managerBusy =")
      < noticeBlock.indexOf("window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ = actionToken"),
    "quota retry must reject an existing Manager action before replacing its token",
  );
});

test("Manager blocks every new action while any prior action is still running or pending", () => {
  const pendingMaxBlock = extractNamedFunction(managerInject, "pendingActionMaxMs");
  const pendingMax = vm.runInNewContext(`(${pendingMaxBlock})`, {
    actionUiTimeoutMs: () => 5000,
    actionTransportTimeoutMs: () => 310000,
    MANAGER_PENDING_TRANSPORT_GRACE_MS: 120000,
  });
  const refreshSnapshotBlock = extractNamedFunction(managerInject, "refreshManagerSnapshot");
  const reconcileBlock = extractNamedFunction(managerInject, "reconcileManagerPendingActions");
  const backgroundBlock = extractNamedFunction(managerInject, "managerActionContinuesInBackground");
  const installActionsStart = managerInject.indexOf("function installActions()");
  const installActionsEnd = managerInject.indexOf("installActions();", installActionsStart);
  const installActionsBlock = managerInject.slice(installActionsStart, installActionsEnd);
  const clickBlock = installActionsBlock.slice(
    installActionsBlock.indexOf('button.addEventListener("click"'),
    installActionsBlock.indexOf("if (requireHighImpactConfirmation"),
  );
  const immediateOutcomeBlock = installActionsBlock.slice(
    installActionsBlock.indexOf('if (outcome.type === "payload")'),
    installActionsBlock.indexOf('} else if (outcome.type === "timeout")'),
  );
  const lateOutcomeBlock = installActionsBlock.slice(
    installActionsBlock.indexOf("actionPromise.then(async (lateOutcome) =>"),
    installActionsBlock.indexOf("} else {", installActionsBlock.indexOf("actionPromise.then(async (lateOutcome) =>")),
  );

  assert.match(pendingMaxBlock, /actionTransportTimeoutMs\(action\) \+ MANAGER_PENDING_TRANSPORT_GRACE_MS/);
  assert.ok(pendingMax("fastOverallNoTraffic") >= 430000);
  assert.ok(pendingMax("overallNoTraffic") >= 430000);
  assert.doesNotMatch(refreshSnapshotBlock, /__ANTICODEX_MANAGER_PENDING_ACTIONS__/);
  assert.match(refreshSnapshotBlock, /reconcileManagerPendingActions\(payload\.snapshot\)/);
  assert.match(reconcileBlock, /managerSnapshotRunningActionIds\(snapshot\)/);
  assert.match(backgroundBlock, /MANAGER_BACKGROUND_START_ACTION_IDS\.has\(action\)/);
  assert.match(backgroundBlock, /managerActionResult\(payload\)/);
  assert.match(backgroundBlock, /result\?\.background === true/);
  const scriptFallbackBlock = extractNamedFunction(managerInject, "runActionViaScript");
  assert.match(scriptFallbackBlock, /actionToken/);
  assert.match(scriptFallbackBlock, /__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken/);
  assert.match(clickBlock, /Object\.keys\(window\.__ANTICODEX_MANAGER_PENDING_ACTIONS__ \|\| \{\}\)\.find\(actionStillPending\)/);
  assert.match(clickBlock, /managerSnapshotRunningActionIds\(window\.__ANTICODEX_MANAGER_SNAPSHOT__\)/);
  assert.match(clickBlock, /action === "refreshStatus"[\s\S]*?refreshManagerSnapshot\(\)/);
  assert.match(clickBlock, /actionInFlight \|\| window\.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ \|\| pendingAction \|\| reportedAction/);
  assert.doesNotMatch(clickBlock, /action !== "upstreamConfig"/);
  assert.match(immediateOutcomeBlock, /managerActionContinuesInBackground\(action, outcome\.payload\)/);
  assert.match(immediateOutcomeBlock, /pendingActions\[action\] = actionStartedAt/);
  assert.match(immediateOutcomeBlock, /pending: stillPending/);
  assert.match(lateOutcomeBlock, /managerActionContinuesInBackground\(action, lateOutcome\.payload\)/);
  assert.match(lateOutcomeBlock, /pending: stillPending/);
});

test("Manager correlates fresh background reports and keeps their final result visible", () => {
  const lookupBlock = extractNamedFunction(managerInject, "managerSnapshotActionResult");
  const summaryBlock = extractNamedFunction(managerInject, "managerActionResultSummary");
  const reconcileBlock = extractNamedFunction(managerInject, "reconcileManagerPendingActions");
  const lookup = vm.runInNewContext(`(${lookupBlock})`);
  const summarize = vm.runInNewContext(`(${summaryBlock})`, {
    ACTIONS: [["postVerificationFull", "验证后完整检查"]],
  });
  const completedAt = "2026-07-30T02:00:00.000Z";
  const snapshot = {
    responses: {
      "/anticodex/diagnostics": {
        managerActionResults: {
          postVerificationFull: {
            exists: true,
            ok: false,
            effectiveOk: false,
            reportedAt: completedAt,
            firstFailure: "visible acceptance failed",
            latestPath: "C:\\reports\\latest-post-verification.json",
          },
        },
      },
    },
  };

  assert.equal(lookup(snapshot, "postVerificationFull", Date.parse(completedAt) + 1), null);
  const fresh = lookup(snapshot, "postVerificationFull", Date.parse(completedAt) - 1);
  assert.equal(fresh.firstFailure, "visible acceptance failed");
  assert.match(summarize("postVerificationFull", fresh), /未通过/);
  assert.match(summarize("postVerificationFull", fresh), /visible acceptance failed/);
  assert.match(summarize("postVerificationFull", null), /没有发现本次新报告/);

  assert.match(reconcileBlock, /managerSnapshotActionResult\(snapshot,\s*action,\s*startedAt\)/);
  assert.match(reconcileBlock, /managerActionResultSummary\(action,\s*actionResult\)/);
  assert.match(reconcileBlock, /__ANTICODEX_MANAGER_LAST_ACTION_RESULT__/);
  assert.match(reconcileBlock, /liveResult\.textContent = managerSummary/);

  const pendingActions = { postVerificationFull: 1 };
  const classToggles = [];
  const liveResult = {
    classList: { toggle: (...args) => classToggles.push(args) },
    removeAttribute() {},
    textContent: "",
  };
  const context = {
    managerPendingActions: () => pendingActions,
    managerSnapshotRunningActionIds: () => new Set(),
    MANAGER_PENDING_REPORT_GRACE_MS: 0,
    managerSnapshotActionResult: () => null,
    managerActionResultSummary: () => "结果未知：没有发现本次新报告。",
    window: {},
    document: { querySelector: () => liveResult },
    MANAGER_ID: "anticodex-manager",
    persistManagerPendingActions() {},
  };
  vm.runInNewContext(`(${reconcileBlock})`, context)({});
  assert.equal(context.window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__.ok, null);
  assert.deepEqual(classToggles, [["anticodex-error", false]]);
  assert.equal(liveResult.textContent, "结果未知：没有发现本次新报告。");

  const openManagerBlock = extractNamedFunction(managerInject, "openManager");
  const preserveBlock = openManagerBlock.slice(
    openManagerBlock.indexOf("const preserveLastActionResult"),
    openManagerBlock.indexOf("const copyResultButton"),
  );
  assert.doesNotMatch(preserveBlock, /lastActionResult\.ok !== false/);
  assert.doesNotMatch(preserveBlock, /includes\("\\u8fd0\\u884c\\u5931\\u8d25"\)/);

  const installActionsStart = managerInject.indexOf("function installActions()");
  const installActionsEnd = managerInject.indexOf("installActions();", installActionsStart);
  const installActionsBlock = managerInject.slice(installActionsStart, installActionsEnd);
  const refreshBranch = installActionsBlock.slice(
    installActionsBlock.indexOf('if (action === "refreshStatus"'),
    installActionsBlock.indexOf("return;", installActionsBlock.indexOf('if (action === "refreshStatus"')) + 7,
  );
  assert.match(refreshBranch, /__ANTICODEX_MANAGER_LAST_ACTION_RESULT__\?\.managerSummary/);

  const pendingStoreBlock = extractNamedFunction(managerInject, "managerPendingActions");
  const pendingPersistBlock = extractNamedFunction(managerInject, "persistManagerPendingActions");
  assert.match(pendingStoreBlock, /localStorage\.getItem\(MANAGER_PENDING_STORAGE_KEY\)/);
  assert.match(pendingPersistBlock, /localStorage\.setItem\(MANAGER_PENDING_STORAGE_KEY/);
  assert.match(managerInject, /}\s*managerPendingActions\(\);\s*function reconcileManagerPendingActions/);
  assert.match(reconcileBlock, /persistManagerPendingActions\(\)/);
  assert.match(installActionsBlock, /pendingActions\[action\] = actionStartedAt;\s*persistManagerPendingActions\(\)/);
});

test("current Manager UI exposes no legacy session-controller action", () => {
  assert.match(managerInject, /const VERSION = "native-panel-v115"/);
  assert.match(managerOpenInject, /__ANTICODEX_MANAGER_VERSION__ === "native-panel-v115"/);
  assert.match(managerInject, /\.anticodex-head\{[^}]*position:sticky;top:0;z-index:3;background:var\(--ac-bg\)/);
  for (const [name, text] of Object.entries({
    source,
    managerInject,
    managerService,
    managerActionTest,
    uiChatSmokeTest,
    realSmallProjectTest,
  })) {
    assert.doesNotMatch(text, /resetAntigravitySessionLock/, `${name} still exposes the removed session reset`);
  }
});

test("Manager exposes prompt layers without weakening required compatibility prompts", () => {
  const refreshManagerStatusBlock = extractNamedFunction(managerInject, "refreshManagerStatus");
  assert.match(managerService, /"\/anticodex\/prompt-policy"/);
  assert.match(managerInject, /data-anticodex-prompt-settings/);
  assert.match(managerInject, /data-anticodex-manager-view/);
  assert.match(refreshManagerStatusBlock, /if \(promptEditorOpen\) return;/);
  assert.ok(
    refreshManagerStatusBlock.indexOf("if (promptEditorOpen) return;")
      < refreshManagerStatusBlock.indexOf('safeJson("/health")'),
    "prompt editor must suspend the status request before it can occupy the Manager bridge",
  );
  assert.match(refreshManagerStatusBlock, /data-anticodex-busy/);
  assert.ok(
    refreshManagerStatusBlock.indexOf("data-anticodex-busy")
      < refreshManagerStatusBlock.indexOf('safeJson("/health")'),
    "a Manager-wide busy state must stop status polling before it occupies the bridge",
  );
  const openManagerBlock = extractNamedFunction(managerInject, "openManager");
  assert.match(openManagerBlock, /function runManagerExclusive/);
  assert.match(openManagerBlock, /connectorAllowlistEditor\(allowlist, result, load, runManagerExclusive\)/);
  assert.ok((openManagerBlock.match(/runManagerExclusive\(/g) || []).length >= 5);
  assert.match(openManagerBlock, /action === "refreshStatus" && !managerOperationInFlight/);
  assert.match(managerInject, /\u6a21\u578b\u63d0\u4f9b\u65b9\u9690\u85cf\u63d0\u793a\u8bcd|模型提供方隐藏提示词/);
  assert.match(managerInject, /Codex \u539f\u751f\u81ea\u5b9a\u4e49\u6307\u4ee4 \(AGENTS\.md\)|Codex 原生自定义指令 \(AGENTS\.md\)/);
  const promptSettingsBlock = extractNamedFunction(managerInject, "showPromptSettings");
  assert.match(promptSettingsBlock, /Gemini.*Claude.*\u7b2c\u4e09\u65b9|Gemini.*Claude.*第三方/);
  assert.doesNotMatch(promptSettingsBlock, /\u4ec5 Antigravity|仅 Antigravity/);
  assert.doesNotMatch(promptSettingsBlock, /\u7b2c\u4e09\u65b9\u7ebf\u8def\u4e0d\u7ecf\u8fc7|第三方线路不经过/);
  assert.match(promptSettingsBlock, /nativePromptSnapshot/);
  assert.match(promptSettingsBlock, /只采集 system\/developer 层|只采集 system\/developer 层/);
  assert.match(managerInject, /\u7559\u7a7a\u5373\u5173\u95ed|留空即关闭/);
  assert.match(promptSettingsBlock, /Codex.*\u5b8c\u6574\u5408\u5e76\u63d0\u793a\u8bcd|Codex.*完整合并提示词/);
  assert.match(promptSettingsBlock, /const developer = editor\("codexDeveloper", "Codex 开发者提示词"\)/);
  assert.match(promptSettingsBlock, /codexDeveloper: developer\.value\(\)/);
  assert.match(promptSettingsBlock, /上方完整合并提示词.*沿用当前运行时内容.*此层才单独生效/);
  assert.match(managerInject, /\u6062\u590d\u9ed8\u8ba4|恢复默认/);
  assert.match(managerInject, /snapshotLayers\.filter\(\(layer\) => layer\.required\)/);
  assert.match(managerRealMouseAction, /promptSettingsSaveRestore/);
  assert.match(managerRealMouseAction, /promptClosePosition/);
  assert.match(managerRealMouseAction, /textareaCount === 4/);
  assert.match(managerRealMouseAction, /\["top", "middle", "bottom"\]/);
  assert.match(managerRealMouseAction, /await sleep\(3_000\)/);
});

test("Manager prompt editor bypasses a stale snapshot after saving", () => {
  const promptSettingsBlock = extractNamedFunction(managerInject, "showPromptSettings");
  assert.match(
    promptSettingsBlock,
    /safeJson\("\/anticodex\/prompt-policy", \{ allowSnapshotFallback: false \}\)/,
  );
  const refreshIndex = promptSettingsBlock.indexOf("await refreshManagerSnapshot()");
  const staleFallbackIndex = promptSettingsBlock.indexOf('snapshotResponse("/anticodex/prompt-policy")');
  assert.ok(refreshIndex >= 0, "a failed live read must refresh the Manager snapshot");
  assert.ok(staleFallbackIndex >= 0, "prompt reads must retain a last-resort snapshot fallback");
  assert.ok(
    refreshIndex < staleFallbackIndex,
    "a failed live read must refresh before accepting an older prompt snapshot",
  );
});

test("physical prompt restore waits for the prompt view to unlock", () => {
  assert.match(managerRealMouseAction, /const promptReadyAfterReload = await waitFor/);
  assert.match(managerRealMouseAction, /getAttribute\('data-anticodex-busy'\)/);
});

test("native compatibility style makes closed Radix menu wrappers mouse transparent", () => {
  assert.match(managerInject, /anticodex-native-compat-style/);
  assert.match(
    managerInject,
    /\[data-radix-popper-content-wrapper\]:has\(> \[data-radix-menu-content\]\[data-state="closed"\]\)\{pointer-events:none!important\}/,
  );
});
