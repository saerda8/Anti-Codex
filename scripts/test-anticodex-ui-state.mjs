#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifyCdpRendererSnapshot } from "./start-anticodex-fixed-route.mjs";

const fatalClientPhrasePattern = /(?:ChatGPT\s*)?(?:已意外停止|unexpectedly\s+(?:stopped|quit|closed)|has\s+unexpectedly\s+(?:stopped|crashed))/i;

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

function hasFatalClientPage(page) {
  return classifyCdpRendererSnapshot({
    readyState: page?.readyState || "complete",
    hasBody: page?.hasBody !== false,
    text: String(page?.textSample ?? page?.text ?? ""),
    hasInteractive: page?.hasInteractive !== false,
    hasComposer: page?.hasComposer ?? page?.composerPresent,
    primaryHeading: page?.primaryHeading,
    buttonLabels: page?.buttonLabels,
  }).fatal;
}

const pageStateJson = args.get("--page-state-json");
if (pageStateJson) {
  let page = null;
  const failures = [];
  try {
    page = JSON.parse(pageStateJson);
    if (hasFatalClientPage(page)) failures.push("page contains fatal client page text");
  } catch (error) {
    failures.push(`page-state JSON is invalid: ${String(error?.message ?? error)}`);
  }
  const output = { ok: failures.length === 0, failures, page };
  console.log(JSON.stringify(output));
  process.exit(output.ok ? 0 : 1);
}

const explicitPort = args.get("--port") || process.env.DEEPCODEX_CDP_PORT || "";
const port = Number(explicitPort || discoverAntiCodexCdpPorts()[0] || 18318);
const baseUrl = String(args.get("--base-url") || "http://127.0.0.1:8484").replace(/\/$/, "");
const catalogPath = args.get("--catalog") || "";
const isolatedUnifiedCatalogPath = path.join(process.env.APPDATA || "", "anticodex", "codex-home-deepseek-app", "anticodex-model-catalog.json");
const timeoutMs = Number(args.get("--timeout-ms") || 8000);
const managerProbeTimeoutMs = Math.max(1000, Number(args.get("--manager-probe-timeout-ms") || timeoutMs));
const fastUiState = /^(1|true|yes)$/i.test(String(args.get("--fast") || ""));
const skipManagerActionProbe = /^(1|true|yes)$/i.test(String(args.get("--skip-manager-action-probe") || ""));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAtMs = Date.now();
const managerInjectSource = fs.readFileSync(new URL("./anticodex-manager-inject.js", import.meta.url), "utf8");
const managerButtonLockPath = path.join(os.tmpdir(), "anticodex-manager-button.lock");
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
const EXPECTED_HIGH_IMPACT_ACTION_IDS = Object.freeze([
  "syncHost", "refreshFeatures", "stabilitySoak", "coldRelaunch", "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull",
]);
if (new Set(EXPECTED_ACTION_IDS).size !== EXPECTED_ACTION_IDS.length) {
  throw new Error("Manager action groups contain duplicate action IDs");
}

function discoverAntiCodexCdpPorts() {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessName -eq 'Anti-Codex.exe' -and $_.CommandLine -match '--remote-debugging-port=' } | ForEach-Object { $_.CommandLine }",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    return [...output.matchAll(/--remote-debugging-port=(\d+)/g)]
      .map((match) => Number(match[1]))
      .filter((value, index, values) => Number.isFinite(value) && value > 0 && values.indexOf(value) === index);
  } catch {
    return [];
  }
}
const mojibakePattern = /(?:缁狅紕鎮妡娣囶喖|濡偓|闁板秶鐤唡閸掗攱|韫囶偊|閺佺繝|娴狅絿鎮妡閼卞﹤|娑撳秳|锟)/;
const modelControlPatternSource = String.raw`Gemini\s+\d|Claude\s+\w+\s+\d|GPT-OSS\s+\d|gemini-|claude-|gpt-oss-|(?:第三方\s*·\s*)?gpt-\d|third-party|第三方\s*API`;
const pageStateProbeExpression = `(() => {
  const shortUiText = () => {
    const chunks = [];
    const selectors = [
      "title", "h1", "h2", "[role='status']", "[aria-live]", "button", "[role='button']",
      "[aria-label]", "[title]", "input", "textarea", "[data-testid]", "[data-state]"
    ];
    for (const element of Array.from(document.querySelectorAll(selectors.join(","))).slice(0, 240)) {
      const value = [
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.getAttribute?.("placeholder"),
        element.getAttribute?.("data-state"),
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (value) chunks.push(value);
      if (chunks.join("\n").length > 6000) break;
    }
    return chunks.join("\n").slice(0, 6000);
  };
  const text = shortUiText();
  const fatalClientTextPattern = /(?:ChatGPT\\s*)?(?:已意外停止|unexpectedly\\s+(?:stopped|quit|closed)|has\\s+unexpectedly\\s+(?:stopped|crashed))/i;
  const composer = document.querySelector('[data-codex-composer], .ProseMirror');
  const isVisible = (element) => {
    const rect = element?.getBoundingClientRect?.();
    const style = element ? getComputedStyle(element) : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
  };
  const primaryHeadingElement = Array.from(document.querySelectorAll('main h1, main h2, h1, h2, [role="heading"]')).find(isVisible);
  const primaryHeading = String(primaryHeadingElement?.textContent || '').replace(/\\s+/g, ' ').trim();
  const buttonLabels = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(isVisible)
    .map((button) => String(button.textContent || button.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 40);
  const reconnectPattern = /(?:Reconnecting\\.\\.\\.|reconnecting|正在重新连接|重新连接|正在重连|重连中)/i;
  const staleTranscriptPattern = /(?:UI_WEB_SEARCH_SMOKE|UI_SMOKE_|已完成真实 web_search|translator_direct_web_search|https?:\\/\\/|Reply with exactly|你在 \\d+[^\\n]{0,20}后停止了|已处理 \\d)/i;
  const reconnectEvidence = [];
  const historicalReconnectEvidence = [];
  for (const element of Array.from(document.querySelectorAll("[role='status'],[aria-live],[data-testid],[data-state],button,[role='button']")).slice(0, 500)) {
    const value = [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-state"),
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
    if (!value || !reconnectPattern.test(value)) continue;
    const inConversation = !!element.closest("[data-thread-find-target='conversation'], [data-app-action-timeline-scroll]");
    const looksHistorical = inConversation || staleTranscriptPattern.test(value) || value.length > 240;
    if (looksHistorical) historicalReconnectEvidence.push(value.slice(0, 160));
    else reconnectEvidence.push(value.slice(0, 160));
    if (reconnectEvidence.length >= 8) break;
  }
  return {
    title: document.title,
    href: location.href,
    textLength: text.length,
    textSample: text.slice(0, 6000),
    hasLoginText: !!document.querySelector("a[href*='auth/login'], form[action*='auth/login']"),
    hasFatalText: fatalClientTextPattern.test(text),
    hasComposer: Boolean(composer),
    primaryHeading,
    buttonLabels,
    hasReconnectText: reconnectEvidence.length > 0,
    reconnectEvidence,
    historicalReconnectEvidence: historicalReconnectEvidence.slice(0, 8)
  };
})()`;

function sameActionIds(actual, expected) {
  return JSON.stringify([...(actual || [])].sort()) === JSON.stringify([...expected].sort());
}

function actionLayoutFromHtml(html, actionAttribute) {
  const groups = [];
  for (const start of html.matchAll(/<(section|details)\b[^>]*data-action-group="([^"]+)"[^>]*>/g)) {
    const contentStart = start.index + start[0].length;
    const contentEnd = html.indexOf(`</${start[1]}>`, contentStart);
    const end = contentEnd < 0 ? contentStart : contentEnd + `</${start[1]}>`.length;
    const content = html.slice(contentStart, contentEnd < 0 ? contentStart : contentEnd);
    groups.push({
      id: start[2],
      tag: start[1],
      open: /\sopen(?:\s|=|>)/.test(start[0]),
      summary: content.match(/<summary[^>]*>([^<]*)<\/summary>/)?.[1]?.trim() || "",
      start: start.index,
      end,
      actionIds: [],
    });
  }
  const buttons = [...html.matchAll(new RegExp(`${actionAttribute}="([^"]+)"`, "g"))].map((match) => {
    const group = groups.find((candidate) => match.index >= candidate.start && match.index < candidate.end);
    const button = { action: match[1], groupId: group?.id || "" };
    if (group) group.actionIds.push(button.action);
    return button;
  });
  return { groups, buttons };
}

function actionLayoutFailures(layout, label) {
  const failures = [];
  const groups = layout?.groups || [];
  const buttons = layout?.buttons || [];
  const expectedGroupNames = Object.keys(EXPECTED_ACTION_GROUPS);
  const unexpectedGroups = groups.filter((group) => !expectedGroupNames.includes(group.id)).map((group) => group.id);
  if (unexpectedGroups.length > 0) failures.push(`${label} has unexpected action groups: ${JSON.stringify(unexpectedGroups)}`);
  for (const groupName of expectedGroupNames) {
    const matches = groups.filter((group) => group.id === groupName);
    if (matches.length !== 1) {
      failures.push(`${label} has ${matches.length} ${groupName} groups, expected 1`);
    } else if (JSON.stringify(matches[0].actionIds) !== JSON.stringify(EXPECTED_ACTION_GROUPS[groupName])) {
      failures.push(`${label} ${groupName} actions are incorrect: ${JSON.stringify(matches[0].actionIds)}`);
    }
  }
  const expectedGroupByAction = new Map(Object.entries(EXPECTED_ACTION_GROUPS)
    .flatMap(([group, actionIds]) => actionIds.map((action) => [action, group])));
  for (const action of EXPECTED_ACTION_IDS) {
    const matches = buttons.filter((button) => button.action === action);
    if (matches.length !== 1) failures.push(`${label} has ${matches.length} ${action} buttons, expected 1`);
  }
  for (const button of buttons) {
    const expectedGroup = expectedGroupByAction.get(button.action);
    if (!expectedGroup) failures.push(`${label} has unexpected action button ${button.action}`);
    else if (!button.groupId) failures.push(`${label} action ${button.action} is outside an action group`);
    else if (button.groupId !== expectedGroup) failures.push(`${label} action ${button.action} is in ${button.groupId}, expected ${expectedGroup}`);
  }
  return failures;
}

function actionGroupMembership(groups) {
  return (groups || []).map(({ id, actionIds }) => ({ id, actionIds }));
}

function actionGroupSourceIndex(source, group) {
  return [
    source.indexOf(`id: "${group}"`),
    source.indexOf(`"data-action-group": "${group}"`),
    source.indexOf(`data-action-group="${group}"`),
  ].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1;
}

function upstreamConfigContractFailures(injectSource) {
  const failures = [];
  const start = injectSource.indexOf("async function showUpstreamConfig()");
  const end = injectSource.indexOf("function installActions()", start);
  const block = injectSource.slice(start, end);
  if (!/text:\s*"保存配置"/.test(block)) failures.push("third-party form is missing 保存配置");
  if (!block.includes("配置已保存，可在聊天输入框的模型菜单选择第三方模型。")) failures.push("third-party form is missing the saved-configuration guidance");
  for (const [label, forbidden] of [
    ["保存并切换", /保存并切换/],
    ["恢复 Antigravity", /恢复 Antigravity/],
    ["Antigravity 模型", /Antigravity 模型/],
    ["reloadNativeCodexConfig", /reloadNativeCodexConfig/],
    ["selectNativeModelByLabels", /selectNativeModelByLabels/],
    ['mode: "antigravity"', /mode:\s*"antigravity"/],
  ]) {
    if (forbidden.test(block)) failures.push(`third-party form still exposes ${label}`);
  }
  return failures;
}

function mojibakeMatch(text) {
  return String(text || "").match(mojibakePattern)?.[0] || "";
}

function extractDelimited(source, start, end, label) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`missing ${label} start`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`missing ${label} end`);
  return source.slice(startIndex, endIndex + end.length);
}

function staticManagerUiFailures({ injectSource, serverSource }) {
  const failures = [];
  const injectMojibake = mojibakeMatch(injectSource);
  if (injectMojibake) failures.push(`in-app manager source contains mojibake text: ${injectMojibake}`);
  failures.push(...upstreamConfigContractFailures(injectSource));
  const injectedGroupIndexes = Object.keys(EXPECTED_ACTION_GROUPS).map((group) => actionGroupSourceIndex(injectSource, group));
  if (injectedGroupIndexes.some((index) => index < 0)
    || JSON.stringify([...injectedGroupIndexes].sort((left, right) => left - right)) !== JSON.stringify(injectedGroupIndexes)) {
    failures.push("in-app manager does not render the five action groups in contract order");
  }
  if (/id:\s*LEGACY_BUTTON_ID|id=["']anticodex-manager-button["']/.test(injectSource)) {
    failures.push("in-app manager still creates the removed floating Manager button");
  }
  if (!/data-anticodex-close/.test(injectSource) || !/min-height:44px/.test(injectSource)) {
    failures.push("in-app manager close button lacks a full-size hit target");
  }
  if (!/function closestEventElement/.test(injectSource) || !/target\?\.parentNode\?\.nodeType === 1/.test(injectSource) || !/composedPath\?\.\(\)/.test(injectSource)) {
    failures.push("in-app manager lacks robust text-node click hit testing");
  }
  if (!/function closestEventElementOrPoint/.test(injectSource) || !/eventPointInsideElement/.test(injectSource) || !/closestEventElementOrPoint\(event, "\[data-anticodex-close\]", root\)/.test(injectSource)) {
    failures.push("in-app manager close button lacks coordinate fallback for label hit testing");
  }
  if (!/\.anticodex-close::after\{[^}]*content:attr\(aria-label\)[^}]*pointer-events:none/.test(injectSource)
    || /"data-anticodex-close": "true"[\s\S]{0,180}text: CLOSE_TEXT/.test(injectSource)
    || /el\("span", \{ text: CLOSE_TEXT \}\)/.test(injectSource)) {
    failures.push("in-app manager close button visible label can still intercept pointer hits");
  }
  if (!/#\$\{MANAGER_ID\}\{[^}]*-webkit-app-region:no-drag/.test(injectSource)
    || !/\.anticodex-close\{[^}]*-webkit-app-region:no-drag/.test(injectSource)) {
    failures.push("in-app manager close button still overlaps an Electron drag region");
  }
  if (!/closestEventElement\(event, "\[data-anticodex-notice-action\]"\)/.test(injectSource) || !/runNoticeAction\(actionButton, event\)/.test(injectSource)) {
    failures.push("traffic notice buttons do not delegate clicks through their text labels");
  }
  if (!/copyTextToClipboard/.test(injectSource) || !/anticodex-copy-result/.test(injectSource)) {
    failures.push("in-app manager is missing copy result controls");
  }
  if (!/diagnosticsSummary/.test(injectSource) || !/diagnosticsSummary/.test(serverSource) || !/longTasks/.test(injectSource) || !/longTasks/.test(serverSource)) {
    failures.push("manager page missing diagnostics bundle long-task result summary");
  }
  if (!/function snapshotStalenessNotice/.test(injectSource) || !/snapshotStatus/.test(injectSource) || !/source_changed/.test(injectSource)) {
    failures.push("in-app manager is missing local feature snapshot staleness notice");
  }
  if (!/app-tool registry:/.test(injectSource) || !/appToolRegistryFingerprintMatches/.test(injectSource)) {
    failures.push("in-app manager is missing MCP/Skill app-tool registry evidence");
  }
  if (!/app capability: state=/.test(injectSource) || !/smokeChecked=\$\{evidence\.smokeChecked/.test(injectSource) || !/endpointReadable=\$\{evidence\.endpointProjectionReadable/.test(injectSource) || !/callable=\$\{evidence\.callableState/.test(injectSource) || !/nativeWriteback=\$\{evidence\.nativeCodexWriteback/.test(injectSource)) {
    failures.push("in-app manager is missing plugin/app callable state evidence");
  }
  if (!/const callableSummary = appTools > 0/.test(injectSource) || !/metadata-only/.test(injectSource) || !/accessibleConnectors > 0/.test(injectSource)) {
    failures.push("in-app manager plugin/app action summary can hide metadata-only or accessible-without-tools state");
  }
  if (!/sourceSnapshotLine\(r\)/.test(injectSource) || !/r\.shortBudgetMode \?/.test(injectSource)) {
    failures.push("in-app manager plugin/app action summary is missing source snapshot or short-budget status");
  }
  if (!/local connector upstream: before=/.test(injectSource) || !/local connector isolation: sharedHomeUsed=/.test(injectSource) || !/local cache fingerprints: connector=/.test(injectSource)) {
    failures.push("in-app manager is missing local connector upstream/isolation/cache evidence");
  }
  if (!/sourceSnapshot: files=/.test(injectSource) || !/reusedFromPreviousReport/.test(injectSource) || !/refreshSkippedReason/.test(injectSource)) {
    failures.push("in-app manager is missing source snapshot reuse evidence");
  }
  if (!/app cache smoke: connector=/.test(injectSource) || !/appTools=\$\{evidence\.appToolsCacheChecked/.test(injectSource) || !/connectorChecked=\$\{evidence\.connectorParityChecked/.test(injectSource) || !/appToolChecked=\$\{evidence\.appToolParityChecked/.test(injectSource) || !/getPostChecked=\$\{evidence\.appToolGetPostParityChecked/.test(injectSource)) {
    failures.push("in-app manager is missing plugin/app cache smoke evidence");
  }
  if (!/syncReadiness versions: codex=/.test(injectSource) || !/managerBridge=\$\{evidence\.managerBridgeReady/.test(injectSource) || !/processes=\$\{evidence\.managerBridgeProcessCount/.test(injectSource)) {
    failures.push("in-app manager is missing sync-readiness version and Manager bridge process evidence");
  }
  if (!/selectedHistory:/.test(injectSource) || !/releaseGateSelectedReports/.test(injectSource)) {
    failures.push("in-app manager is missing release-gate selected history evidence");
  }
  if (!/source snapshot mismatch: stale reports/.test(injectSource) || !/_source_snapshot_mismatch/.test(injectSource)) {
    failures.push("in-app manager is missing stale source snapshot guidance");
  }
  if (!/source snapshot refresh: refresh local features first, then run normal MCP\/Skill and plugin capability verifiers/.test(injectSource) || !/do not edit latest report JSON by hand/.test(injectSource)) {
    failures.push("in-app manager is missing source snapshot refresh guidance");
  }
  if (!/failureReasons:/.test(injectSource) || !/releaseGateFailureReasons/.test(injectSource)) {
    failures.push("in-app manager is missing release-gate failure reason evidence");
  }
  if (!/localGatewayGuidanceLine/.test(injectSource) || !/local Anti-Codex gateway is offline/.test(injectSource)) {
    failures.push("in-app manager is missing local gateway offline guidance");
  }
  if (!/真实流量验收证据需更新\/未生成/.test(injectSource) || !/missing_report/.test(injectSource) || !/group === "real-traffic"/.test(injectSource)) {
    failures.push("in-app manager is missing real-traffic stale/missing evidence guidance");
  }
  if (!/sourcePreflight cliIsolation lane: role=/.test(injectSource) || !/sourcePreflight cliIsolation lane:.*mcpManagedHere=/.test(injectSource) || !/sourcePreflight cliIsolation lane:.*mcpOwner=/.test(injectSource)) {
    failures.push("in-app manager is missing source-preflight CLI isolation account-lane evidence");
  }

  const managerHtml = extractDelimited(serverSource, "function anticodexManagerHtml()", "</html>`;", "manager html");
  const managerHtmlMojibake = mojibakeMatch(managerHtml);
  if (managerHtmlMojibake) failures.push(`manager page source contains mojibake text: ${managerHtmlMojibake}`);
  const fallbackGroupIndexes = Object.keys(EXPECTED_ACTION_GROUPS).map((group) => actionGroupSourceIndex(managerHtml, group));
  if (fallbackGroupIndexes.some((index) => index < 0)
    || JSON.stringify([...fallbackGroupIndexes].sort((left, right) => left - right)) !== JSON.stringify(fallbackGroupIndexes)) {
    failures.push("manager page does not render the five action groups in contract order");
  }
  const fallbackAdvancedTag = managerHtml.match(/<details\s+data-action-group="advanced"[^>]*>/)?.[0] || "";
  if (!fallbackAdvancedTag || /\sopen(?:\s|=|>)/.test(fallbackAdvancedTag) || !/<summary>高级诊断<\/summary>/.test(managerHtml)) {
    failures.push("manager page advanced diagnostics are not collapsed details with a visible label");
  }
  if (!managerHtml.includes('data-manager-surface="codex"')) {
    failures.push("manager page is missing the Codex-style surface marker");
  }
  if (!/button\.danger\{[^}]*background:var\(--danger\)/.test(managerHtml)) {
    failures.push("manager page high-impact actions are not styled as dark-red buttons");
  }
  if (!/function requireHighImpactConfirmation/.test(injectSource) || !/pendingHighImpactAction/.test(injectSource)) {
    failures.push("in-app manager is missing high-impact confirmation state");
  }
  if (!/function routeSummaryRows/.test(injectSource) || !/\/anticodex\/model-routes/.test(injectSource) || !/providerProtocol/.test(injectSource) || !/transport/.test(injectSource)) {
    failures.push("in-app manager route summary is missing third-party provider/protocol/transport fields");
  }
  if (!/providerRoutes: provider=/.test(injectSource) || !/requestReachedSecondProvider/.test(injectSource) || !/requestReachedAnthropicProvider/.test(injectSource) || !/requestReachedOpenAiCompatibleProvider/.test(injectSource)) {
    failures.push("in-app manager is missing provider continuity route switch evidence");
  }
  if (!/providerContinuity: turns=/.test(injectSource) || !/markers=\$\{markerCounts/.test(injectSource) || !/sixthMarkerCount/.test(injectSource)) {
    failures.push("in-app manager is missing provider continuity marker-count evidence");
  }
  if (/return \[\["\\u72b6\\u6001", "\\u6682\\u65e0\\u8def\\u7531\\u8bb0\\u5f55"\]\]/.test(injectSource)) {
    failures.push("in-app manager route empty state collapses provider fields");
  }
  if (
    injectSource.indexOf("requireHighImpactConfirmation(action, label, button)") < 0
    || injectSource.indexOf("requireHighImpactConfirmation(action, label, button)") > injectSource.indexOf('if (action === "upstreamConfig")')
    || injectSource.indexOf("requireHighImpactConfirmation(action, label, button)") > injectSource.indexOf("runActionViaBridge(action)")
  ) {
    failures.push("in-app manager can open or run high-impact actions before confirmation");
  }
  if (!/HIGH_IMPACT_ACTION_IDS/.test(managerHtml) || !/function requireHighImpactConfirmation/.test(managerHtml) || !/pendingHighImpactAction/.test(managerHtml)) {
    failures.push("manager page is missing high-impact confirmation state");
  }
  if (
    managerHtml.indexOf("requireHighImpactConfirmation(action,label,btn)") < 0
    || managerHtml.indexOf("requireHighImpactConfirmation(action,label,btn)") > managerHtml.indexOf('managerPost("/anticodex/manager/action"')
  ) {
    failures.push("manager page can post high-impact actions before confirmation");
  }
  if (managerHtml.includes("/anticodex/manager/open")) {
    failures.push("manager page still references the old separate manager open endpoint");
  }
  if (!/function routeSummary/.test(managerHtml) || !/providerProtocol/.test(managerHtml) || !/transport/.test(managerHtml) || !/Provider/.test(managerHtml)) {
    failures.push("manager page route summary is missing third-party provider/protocol/transport fields");
  }
  if (!/providerRoutes: provider=/.test(managerHtml) || !/requestReachedSecondProvider/.test(managerHtml) || !/requestReachedAnthropicProvider/.test(managerHtml) || !/requestReachedOpenAiCompatibleProvider/.test(managerHtml)) {
    failures.push("manager page is missing provider continuity route switch evidence");
  }
  if (!/providerContinuity: turns=/.test(managerHtml) || !/markers="\+\(markerCounts/.test(managerHtml) || !/sixthMarkerCount/.test(managerHtml)) {
    failures.push("manager page is missing provider continuity marker-count evidence");
  }
  if (!/app-tool registry:/.test(managerHtml) || !/appToolRegistryFingerprintMatches/.test(managerHtml)) {
    failures.push("manager page is missing MCP/Skill app-tool registry evidence");
  }
  if (!/app capability: state=/.test(managerHtml) || !/smokeChecked="\+\(evidence\.smokeChecked/.test(managerHtml) || !/endpointReadable="\+\(evidence\.endpointProjectionReadable/.test(managerHtml) || !/callable="\+\(evidence\.callableState/.test(managerHtml) || !/nativeWriteback="\+\(evidence\.nativeCodexWriteback/.test(managerHtml)) {
    failures.push("manager page is missing plugin/app callable state evidence");
  }
  if (!/sourceSnapshotLine\(r\)/.test(managerHtml) || !/r\.shortBudgetMode\?/.test(managerHtml)) {
    failures.push("manager page plugin/app action summary is missing source snapshot or short-budget status");
  }
  if (!/localAllowlisted/.test(injectSource) || !/callableAppToolCount/.test(injectSource) || !/accessibleConnectors > 0/.test(injectSource)) {
    failures.push("in-app manager can confuse local connector allowlist metadata with callable app tools");
  }
  if (!/local connector upstream: before=/.test(managerHtml) || !/local connector isolation: sharedHomeUsed=/.test(managerHtml) || !/local cache fingerprints: connector=/.test(managerHtml)) {
    failures.push("manager page is missing local connector upstream/isolation/cache evidence");
  }
  if (!/sourceSnapshot: files=/.test(managerHtml) || !/reusedFromPreviousReport/.test(managerHtml) || !/refreshSkippedReason/.test(managerHtml)) {
    failures.push("manager page is missing source snapshot reuse evidence");
  }
  if (!/app cache smoke: connector=/.test(managerHtml) || !/appTools="\+\(evidence\.appToolsCacheChecked/.test(managerHtml) || !/connectorChecked="\+\(evidence\.connectorParityChecked/.test(managerHtml) || !/appToolChecked="\+\(evidence\.appToolParityChecked/.test(managerHtml) || !/getPostChecked="\+\(evidence\.appToolGetPostParityChecked/.test(managerHtml)) {
    failures.push("manager page is missing plugin/app cache smoke evidence");
  }
  if (!/syncReadiness versions: codex=/.test(managerHtml) || !/managerBridge="\+\(evidence\.managerBridgeReady/.test(managerHtml) || !/processes="\+\(evidence\.managerBridgeProcessCount/.test(managerHtml)) {
    failures.push("manager page is missing sync-readiness version and Manager bridge process evidence");
  }
  if (!/selectedHistory:/.test(managerHtml) || !/releaseGateSelectedReports/.test(managerHtml)) {
    failures.push("manager page is missing release-gate selected history evidence");
  }
  if (!/source snapshot mismatch: stale reports/.test(managerHtml) || !/_source_snapshot_mismatch/.test(managerHtml)) {
    failures.push("manager page is missing stale source snapshot guidance");
  }
  if (!/source snapshot refresh: refresh local features first, then run normal MCP\/Skill and plugin capability verifiers/.test(managerHtml) || !/do not edit latest report JSON by hand/.test(managerHtml)) {
    failures.push("manager page is missing source snapshot refresh guidance");
  }
  if (!/failureReasons:/.test(managerHtml) || !/releaseGateFailureReasons/.test(managerHtml)) {
    failures.push("manager page is missing release-gate failure reason evidence");
  }
  if (!/localGatewayGuidanceLine/.test(managerHtml) || !/local Anti-Codex gateway is offline/.test(managerHtml)) {
    failures.push("manager page is missing local gateway offline guidance");
  }
  if (!/真实流量验收证据需更新\/未生成/.test(managerHtml) || !/missing_report/.test(managerHtml) || !/group==="real-traffic"/.test(managerHtml)) {
    failures.push("manager page is missing real-traffic stale/missing evidence guidance");
  }
  if (!/sourcePreflight cliIsolation lane: role=/.test(managerHtml) || !/sourcePreflight cliIsolation lane:.*mcpManagedHere=/.test(managerHtml) || !/sourcePreflight cliIsolation lane:.*mcpOwner=/.test(managerHtml)) {
    failures.push("manager page is missing source-preflight CLI isolation account-lane evidence");
  }
  if (/routes\.latest\?JSON\.stringify\(routeSummary/.test(managerHtml)) {
    failures.push("manager page route empty state collapses provider fields");
  }
  return failures;
}

function currentStaticManagerUiFailures({ injectSource, managerServiceSource }) {
  const failures = [];
  const injectMojibake = mojibakeMatch(injectSource);
  if (injectMojibake) failures.push(`in-app manager source contains mojibake text: ${injectMojibake}`);
  const serviceMojibake = mojibakeMatch(managerServiceSource);
  if (serviceMojibake) failures.push(`manager service source contains mojibake text: ${serviceMojibake}`);

  const injectedGroupIndexes = Object.keys(EXPECTED_ACTION_GROUPS).map((group) => actionGroupSourceIndex(injectSource, group));
  if (injectedGroupIndexes.some((index) => index < 0)
    || JSON.stringify([...injectedGroupIndexes].sort((left, right) => left - right)) !== JSON.stringify(injectedGroupIndexes)) {
    failures.push("in-app manager does not render the five action groups in contract order");
  }
  if (!/data-anticodex-close/.test(injectSource) || !/min-height:44px/.test(injectSource)) {
    failures.push("in-app manager close button lacks a full-size hit target");
  }
  if (!/function closestEventElementOrPoint/.test(injectSource)
    || !/eventPointInsideElement/.test(injectSource)
    || !/closestEventElementOrPoint\(event, "\[data-anticodex-close\]", root\)/.test(injectSource)) {
    failures.push("in-app manager close button lacks coordinate fallback hit testing");
  }
  if (!/\.anticodex-close::after\{[^}]*content:attr\(aria-label\)[^}]*pointer-events:none/.test(injectSource)
    || /"data-anticodex-close": "true"[\s\S]{0,180}text: CLOSE_TEXT/.test(injectSource)) {
    failures.push("in-app manager close label can intercept pointer hits");
  }
  if (!/#\$\{MANAGER_ID\}\{[^}]*-webkit-app-region:no-drag/.test(injectSource)
    || !/\.anticodex-close\{[^}]*-webkit-app-region:no-drag/.test(injectSource)) {
    failures.push("in-app manager close button overlaps an Electron drag region");
  }
  if (!/\/anticodex\/manager\/bootstrap/.test(injectSource)
    || !/\/anticodex\/manager\/action-script/.test(injectSource)
    || !/__ANTICODEX_RUN_MANAGER_ACTION__/.test(injectSource)) {
    failures.push("in-app manager is missing the launcher-owned action bridge");
  }
  if (!/function requireHighImpactConfirmation/.test(injectSource) || !/pendingHighImpactAction/.test(injectSource)) {
    failures.push("in-app manager is missing high-impact confirmation state");
  }
  if (!/latestReportsSummary/.test(injectSource) || !/viewLatestReports/.test(injectSource)) {
    failures.push("in-app manager is missing latest-report rendering");
  }
  failures.push(...upstreamConfigContractFailures(injectSource));

  const managerHtml = extractDelimited(managerServiceSource, "const managerHtml = `", "</html>\n`;", "manager service html");
  for (const required of [
    '<title>Anti-Codex 管理</title>',
    '<h1>Anti-Codex 管理</h1>',
    ...Object.keys(EXPECTED_ACTION_GROUPS).map((group) => `data-action-group="${group}"`),
    'confirmHighImpactAction',
  ]) {
    if (!managerHtml.includes(required)) failures.push(`manager service is missing ${required}`);
  }
  const fallbackAdvancedTag = managerHtml.match(/<details\s+data-action-group="advanced"[^>]*>/)?.[0] || "";
  if (!fallbackAdvancedTag || /\sopen(?:\s|=|>)/.test(fallbackAdvancedTag) || !/<summary>高级诊断<\/summary>/.test(managerHtml)) {
    failures.push("manager service advanced diagnostics are not collapsed by default");
  }
  if (!/anticodex-manager-service-v1/.test(managerServiceSource) || !/launcher-management-only/.test(managerServiceSource)) {
    failures.push("manager service identity contract is missing");
  }
  if (/resetAntigravitySessionLock|secondAccountLoginStatus|Anti-Codex Manager|Gate 7/.test(managerHtml)) {
    failures.push("manager service still exposes a removed or internal-only product label/action");
  }
  return failures;
}

if (args.has("--self-test")) {
  const managerServiceSource = fs.readFileSync(new URL("./anticodex-manager-service.mjs", import.meta.url), "utf8");
  const failures = currentStaticManagerUiFailures({ injectSource: managerInjectSource, managerServiceSource });
  const output = { ok: failures.length === 0, failures };
  console.log(asciiJson(output));
  if (!output.ok) process.exit(1);
  process.exit(0);
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[^\x00-\x7F]/gu, (char) => {
    const code = char.codePointAt(0);
    if (code <= 0xFFFF) return `\\u${code.toString(16).padStart(4, "0")}`;
    const normalized = code - 0x10000;
    const high = 0xD800 + (normalized >> 10);
    const low = 0xDC00 + (normalized & 0x3FF);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
  });
}

function progress(label) {
  try {
    process.stderr.write(`[ui-state +${Date.now() - startedAtMs}ms] ${label}\n`);
  } catch {}
}

function isLockOwnerAlive(lockPath) {
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < 5000;
    } catch {
      return false;
    }
  }
  const pid = Number(payload?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireManagerButtonLock() {
  const deadline = Date.now() + Math.max(10000, timeoutMs + 5000);
  do {
    try {
      const fd = fs.openSync(managerButtonLockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, script: "test-anticodex-ui-state", startedAt: new Date().toISOString() }));
      return { fd, path: managerButtonLockPath, released: false };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - fs.statSync(managerButtonLockPath).mtimeMs;
        if (ageMs > 120000 || !isLockOwnerAlive(managerButtonLockPath)) fs.unlinkSync(managerButtonLockPath);
      } catch {}
      await sleep(100);
    }
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for Manager verifier lock: ${managerButtonLockPath}`);
}

function releaseManagerButtonLock(lock) {
  if (!lock || lock.released) return;
  lock.released = true;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.path); } catch {}
}

function getJson(url, requestTimeoutMs = timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: requestTimeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${res.statusCode} ${res.statusMessage}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${res.statusCode} ${res.statusMessage}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.executionContexts = new Map();
    this.internalId = 1000000000;
  }

  async open() {
    const key = crypto.randomBytes(16).toString("base64");
    const path = `${this.url.pathname}${this.url.search}`;
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    this.socket.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening ${this.url.href}`)), timeoutMs);
      this.socket.once("connect", () => {
        this.socket.write([
          `GET ${path} HTTP/1.1`,
          `Host: ${this.url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      const onHandshake = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const split = this.buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = this.buffer.slice(0, split).toString("utf8");
        this.buffer = this.buffer.slice(split + 4);
        this.socket.off("data", onHandshake);
        this.socket.on("data", (data) => this.onData(data));
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
          return;
        }
        this.parseFrames();
        resolve();
      };
      this.socket.on("data", onHandshake);
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = this.buffer.readUInt32BE(offset + 4);
        offset += 8;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      let payload = this.buffer.slice(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = this.buffer.slice(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + maskLength + length);
      if ((first & 0x0f) !== 0x1) continue;
      const message = JSON.parse(payload.toString("utf8"));
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params?.context;
        if (context?.id) this.executionContexts.set(context.id, context);
      } else if (message.method === "Runtime.executionContextDestroyed") {
        const contextId = message.params?.executionContextId;
        if (contextId) this.executionContexts.delete(contextId);
      } else if (message.method === "Runtime.executionContextsCleared") {
        this.executionContexts.clear();
      }
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  call(id, method, params = {}, callTimeoutMs = timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "Runtime.evaluate") {
          this.terminateRuntimeExecution();
        }
        reject(new Error(`Timed out waiting for ${method}`));
      }, callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  send(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  terminateRuntimeExecution() {
    try {
      this.send(JSON.stringify({ id: this.internalId++, method: "Runtime.terminateExecution" }));
    } catch {}
  }

  findDefaultContextId(frameId) {
    for (const context of this.executionContexts.values()) {
      if (context.auxData?.isDefault && (!frameId || context.auxData?.frameId === frameId)) {
        return context.id;
      }
    }
    return null;
  }

  findDefaultContextIds(frameId) {
    const ids = [];
    for (const context of this.executionContexts.values()) {
      if (context.auxData?.isDefault && (!frameId || context.auxData?.frameId === frameId)) {
        ids.push(context.id);
      }
    }
    return ids;
  }

  close() {
    try { this.socket?.end(); } catch {}
    try { this.socket?.destroy(); } catch {}
  }
}

async function waitForDefaultContext(ws, frameId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const contextId = ws.findDefaultContextId(frameId);
    if (contextId) return contextId;
    await sleep(50);
  } while (Date.now() < deadline);
  return null;
}

async function pickVisiblePageContextId(ws, frameId, nextId) {
  const ids = ws.findDefaultContextIds(frameId);
  for (const contextId of ids) {
    try {
      const probe = await ws.call(nextId(), "Runtime.evaluate", {
        contextId,
        expression: `(() => ({
          title: document.title || "",
          href: location.href || "",
          text: document.body ? document.body.innerText.slice(0, 800) : ""
        }))()`,
        returnByValue: true,
        awaitPromise: false,
      });
      const value = probe.result?.value || {};
      const haystack = `${value.title || ""}\n${value.href || ""}\n${value.text || ""}`;
      if (/Anti-Codex|app:\/\/-|鏂板璇潀杩涘叆椤圭洰宸ヤ綔|Gemini|绠＄悊/.test(haystack)) {
        return contextId;
      }
    } catch {}
  }
  return ids[0] || null;
}

function loadExpectedLabels(catalogFile) {
  const labels = [];
  if (catalogFile && fs.existsSync(catalogFile)) {
    const parsed = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    for (const model of parsed.models || []) {
      if (model.display_name) labels.push(String(model.display_name));
      if (model.slug) labels.push(String(model.slug));
    }
  }
  return [...new Set(labels.filter(Boolean))];
}

function loadCatalogModels(catalogFile) {
  if (!catalogFile || !fs.existsSync(catalogFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  return Array.isArray(parsed.models) ? parsed.models : [];
}

function reasoningLabelFromId(modelId) {
  const text = String(modelId || "").toLowerCase();
  if (/(?:extra[-_]?low)/.test(text)) return "Extra Low";
  if (/(?:thinking|xhigh|max)/.test(text)) return "Thinking";
  if (/(?:\blow\b|-low\b|_low\b)/.test(text)) return "Low";
  if (/(?:\bmedium\b|-medium\b|_medium\b)/.test(text)) return "Medium";
  if (/(?:\bhigh\b|-high\b|_high\b)/.test(text)) return "High";
  return "";
}

function validateCatalogModels(catalogModels, visibleModelIds) {
  const failures = [];
  if (!catalogModels.length) return { failures, catalogIds: [], catalogLabels: [] };
  const visible = new Set(visibleModelIds);
  const catalogIds = catalogModels.map((model) => String(model.slug || "")).filter(Boolean);
  const catalogLabels = catalogModels.map((model) => String(model.display_name || "")).filter(Boolean);

  for (const id of visibleModelIds) {
    if (!catalogIds.includes(id)) failures.push(`catalog missing visible model id: ${id}`);
  }
  for (const model of catalogModels) {
    const id = String(model.slug || "");
    if (!visible.has(id)) continue;
    const label = String(model.display_name || "");
    if (!label) {
      failures.push(`catalog model ${id} missing display_name`);
      continue;
    }
    if (!/\d/.test(label)) failures.push(`catalog model ${id} display_name lacks numeric version: ${label}`);
    const wanted = reasoningLabelFromId(id);
    if (wanted && !label.endsWith(`(${wanted})`)) {
      failures.push(`catalog model ${id} display_name has wrong reasoning suffix: ${label}`);
    }
  }

  return { failures, catalogIds, catalogLabels };
}

function labelsFromModelPayload(modelPayload, upstreamModel = "") {
  const labels = [];
  for (const model of modelPayload?.data || []) {
    for (const key of ["display_name", "displayName", "name", "label", "id"]) {
      const value = String(model?.[key] || "").trim();
      if (value) labels.push(value);
    }
  }
  if (upstreamModel) labels.push(String(upstreamModel));
  return [...new Set(labels.filter(Boolean))];
}

function isAvatarOverlayTarget(target) {
  return String(target?.url || "").toLowerCase().includes("avatar-overlay");
}

function pickTarget(targets) {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl && !isAvatarOverlayTarget(target));
  return pages.find((target) => /^app:\/\/-\/index\.html(?:[?#]|$)/i.test(String(target.url || "")))
    || pages.find((target) => target.title === "Anti-Codex")
    || pages.find((target) => `${target.title || ""} ${target.url || ""}`.toLowerCase().includes("codex"))
    || pages[0]
    || null;
}

function pageStateFromContextProbe(probe, error = null) {
  const text = String(probe?.text || "");
  if (!text && !probe?.title && !probe?.href) return null;
  const historicalReconnectEvidence = [];
  const reconnectEvidence = [];
  const reconnectPattern = /(?:Reconnecting\.\.\.|reconnecting|正在重新连接|重新连接|正在重连|重连中)/i;
  return {
    title: String(probe?.title || ""),
    href: String(probe?.href || ""),
    textLength: text.length,
    textSample: text,
    hasLoginText: /auth\/login|鐧诲綍 ChatGPT|Sign in to ChatGPT/i.test(text),
    hasFatalText: fatalClientPhrasePattern.test(text),
    hasComposer: probe?.composerPresent,
    primaryHeading: String(probe?.primaryHeading || ""),
    buttonLabels: Array.isArray(probe?.buttonLabels) ? probe.buttonLabels : [],
    hasReconnectText: reconnectEvidence.length > 0,
    reconnectEvidence,
    historicalReconnectEvidence,
    fallbackFromContextProbe: true,
    fallbackReason: error ? String(error?.message || error) : "",
  };
}

const failures = [];
let target = null;
let evaluated = null;
let managerOverlay = null;
let managerPage = null;
let modelCount = 0;
let matchedModelText = "";
let selectedContextId = null;
let selectedContextProbe = null;
let labels = loadExpectedLabels(catalogPath);
let modelIds = [];
const catalogModels = loadCatalogModels(catalogPath);
const isolatedCatalogModels = loadCatalogModels(isolatedUnifiedCatalogPath);
let modelCatalogSource = "fixed-route-endpoint";
let catalogCheck = { failures: [], catalogIds: [], catalogLabels: [] };
let managerButtonLock = null;
let upstreamHealth = null;
let upstreamMode = "unknown";
let upstreamProtocol = "";
let upstreamModel = "";
let modeNotes = [];
let staticContextCoversManager = false;

try {
  progress("acquire-manager-lock");
  managerButtonLock = await acquireManagerButtonLock();
  progress("health");
  upstreamHealth = await getJson(`${baseUrl}/health`, Math.max(timeoutMs, fastUiState ? 15000 : timeoutMs));
  const upstreamProfile = upstreamHealth?.upstreamProfile || {};
  upstreamMode = String(upstreamProfile.mode || upstreamHealth?.mode || (upstreamHealth?.upstream === "antigravity-desktop" ? "antigravity" : "unknown"));
  upstreamProtocol = String(upstreamProfile.protocol || upstreamHealth?.protocol || "");
  upstreamModel = String(upstreamProfile.model || upstreamHealth?.model || "");
  if (upstreamMode === "third-party") {
    modeNotes.push("third-party mode keeps current provider model evidence");
    modeNotes.push("third-party mode skips Antigravity catalog-only validation");
    modeNotes.push("third-party mode skips native Antigravity thinking-budget UI assertion");
    if (!upstreamProtocol) failures.push("third-party upstream UI verification missing protocol");
    if (!upstreamModel) failures.push("third-party upstream UI verification missing model");
  }
  progress("models");
  let modelPayload = await getJson(`${baseUrl}/models`);
  modelCount = Array.isArray(modelPayload.data) ? modelPayload.data.length : 0;
  if (modelCount < 1 && isolatedCatalogModels.length > 0) {
    modelPayload = {
      data: isolatedCatalogModels.map((model) => ({
        id: String(model.slug || ""),
        display_name: String(model.display_name || ""),
      })).filter((model) => model.id),
    };
    modelCount = modelPayload.data.length;
    modelCatalogSource = "isolated-unified-catalog";
  }
  modelIds = Array.isArray(modelPayload.data) ? modelPayload.data.map((model) => String(model.id || "")).filter(Boolean) : [];
  if (modelCount < 1) failures.push("/models returned no visible models");
  const providerLabels = labelsFromModelPayload(modelPayload, upstreamModel);
  if (upstreamMode === "third-party") {
    labels = providerLabels;
  } else if (labels.length === 0 && Array.isArray(modelPayload.data)) {
    labels = providerLabels;
  }
  if (labels.length === 0) {
    labels = modelIds;
  }
  if (upstreamMode === "third-party") {
    catalogCheck = { failures: [], catalogIds: [], catalogLabels: [] };
  } else {
    catalogCheck = validateCatalogModels(catalogModels, modelIds);
    failures.push(...catalogCheck.failures);
  }

  progress("manager-html");
  const managerHtml = await getText(`${baseUrl}/anticodex/manager`);
  const managerPageActionLayout = actionLayoutFromHtml(managerHtml, "data-manager-action");
  const managerPageButtons = [...managerHtml.matchAll(/<button\b[^>]*data-manager-action="([^"]+)"[^>]*>/g)]
    .map((match) => ({ action: match[1], tag: match[0] }));
  const managerPageDangerActionIds = managerPageButtons
    .filter((button) => /class="[^"]*\bdanger\b[^"]*"/.test(button.tag))
    .map((button) => button.action);
  const managerPageAdvanced = managerPageActionLayout.groups.find((group) => group.id === "advanced");
  managerPage = {
    hasZhLang: /<html\s+lang="zh-CN"/i.test(managerHtml),
    hasTitle: managerHtml.includes("<title>Anti-Codex \u7ba1\u7406</title>"),
    hasHeading: managerHtml.includes("<h1>Anti-Codex \u7ba1\u7406</h1>"),
    hasNoTrafficNotice: managerHtml.includes("\u4e0d\u8d70 ChatGPT \u767b\u5f55\uff0c\u4e5f\u4e0d\u6d88\u8017\u6a21\u578b\u6d41\u91cf"),
    hasRefreshStatusButton: managerHtml.includes(">\u5237\u65b0\u72b6\u6001</button>"),
    hasRefreshModelsButton: managerHtml.includes(">\u5237\u65b0\u6a21\u578b</button>"),
    hasAccountProxyButton: managerHtml.includes(">\u68c0\u67e5\u8d26\u53f7/\u4ee3\u7406</button>"),
    hasSyncReadinessButton: managerHtml.includes(">\u68c0\u67e5\u5b89\u88c5/\u540c\u6b65</button>"),
    hasUpdateCheckButton: managerHtml.includes(">\u68c0\u67e5\u66f4\u65b0</button>"),
    hasUpdateCheckAction: managerHtml.includes('data-action="updateCheck"'),
    hasSourcePreflightButton: managerHtml.includes(">\u8fd0\u884c\u6e90\u7801\u9884\u68c0</button>"),
    hasSourcePreflightAction: managerHtml.includes('data-action="sourcePreflight"'),
    hasRepairShortcutsAction: managerHtml.includes('data-action="repairShortcuts"'),
    hasSyncHostButton: managerHtml.includes(">\u540c\u6b65 Codex \u66f4\u65b0</button>"),
    hasSyncHostAction: managerHtml.includes('data-action="syncHost"'),
    hasMcpSkillsButton: managerHtml.includes(">\u68c0\u67e5 MCP/Skill</button>"),
    hasPluginCapabilitiesButton: managerHtml.includes(">\u68c0\u67e5\u63d2\u4ef6/\u5e94\u7528</button>"),
    hasRefreshFeaturesButton: managerHtml.includes(">\u5237\u65b0\u672c\u5730\u529f\u80fd</button>"),
    hasRefreshFeaturesAction: managerHtml.includes('data-action="refreshFeatures"'),
    hasOverallNoTrafficButton: managerHtml.includes(">\u6574\u4f53\u68c0\u67e5\uff08\u4e0d\u8017\u6d41\u91cf\uff09</button>"),
    hasDiagnosticsBundleButton: managerHtml.includes(">\u751f\u6210\u8bca\u65ad\u5305</button>"),
    hasViewLatestReportsButton: managerHtml.includes(">\u67e5\u770b\u6700\u65b0\u62a5\u544a</button>"),
    hasPostVerificationButton: managerHtml.includes(">\u9a8c\u8bc1\u540e\u5b8c\u6574\u68c0\u67e5\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09</button>"),
    hasSyncStatusCard: managerHtml.includes("<h2>\u540c\u6b65\u72b6\u6001</h2>") && managerHtml.includes('id="sync"'),
    hasNativeCodexVersionLabel: managerHtml.includes("\u539f\u751f Codex \u7248\u672c"),
    hasAntiCodexVersionLabel: managerHtml.includes("Anti-Codex \u7248\u672c"),
    hasUpdateStatusLabel: managerHtml.includes("\u66f4\u65b0\u72b6\u6001"),
    hasRollbackPointLabel: managerHtml.includes("\u56de\u6eda\u70b9"),
    hasSyncDescriptionLabel: managerHtml.includes("\u8bf4\u660e"),
    hasSyncSafetyText: managerHtml.includes("\u9a8c\u8bc1\u901a\u8fc7\u624d\u66ff\u6362") &&
      managerHtml.includes("\u5931\u8d25\u4e0d\u4f1a\u8986\u76d6\u5f53\u524d Anti-Codex"),
    hasPluginStatusCard: managerHtml.includes("<h2>\u63d2\u4ef6\u4e0e\u5e94\u7528</h2>") && managerHtml.includes('id="plugins"'),
    hasConnectorAllowlistCard: managerHtml.includes('id="connectorAllowlist"') &&
      managerHtml.includes('id="connectorAllowlistInput"') &&
      managerHtml.includes('id="saveConnectorAllowlist"') &&
      managerHtml.includes("/anticodex/local-connectors/allowlist"),
    hasConnectorAllowlistBoundaryText: managerHtml.includes("\u672c\u5730\u7f13\u5b58\u9884\u89c8") &&
      managerHtml.includes("\u4e0d\u6388\u6743") &&
      managerHtml.includes("\u4e0d\u4ee3\u8868\u53ef\u8c03\u7528"),
    hasPostVerificationStatusCard: managerHtml.includes("<h2>\u5b8c\u6574\u68c0\u67e5</h2>") && managerHtml.includes('id="postVerification"'),
    hasLongTasksStatusCard: managerHtml.includes("<h2>\u540e\u53f0\u4efb\u52a1</h2>") && managerHtml.includes('id="longTasks"'),
    hasLongTaskFreshLogFields: managerHtml.includes("latestLogLine") && managerHtml.includes("logAgeMs"),
    hasSnapshotAlert: managerHtml.includes("snapshotAlert") &&
      managerHtml.includes("snapshotStatus") &&
      managerHtml.includes("source_changed") &&
      managerHtml.includes("\u5237\u65b0\u672c\u5730\u529f\u80fd"),
    hasSyncVersionFields: managerHtml.includes("\u539f\u751f Codex \u7248\u672c") && managerHtml.includes("Anti-Codex \u7248\u672c"),
    hasSyncSafetyText: managerHtml.includes("\u6784\u5efa\u5019\u9009\u7248") && managerHtml.includes("\u5931\u8d25\u4e0d\u4f1a\u8986\u76d6\u5f53\u524d Anti-Codex"),
    hasRollbackStatus: managerHtml.includes("\u56de\u6eda\u70b9"),
    hasManagerActionEndpoint: managerHtml.includes("/anticodex/manager/action"),
    hasManagerActionToken: managerHtml.includes("managerActionToken") && managerHtml.includes("x-anticodex-manager-token"),
    hasActionResult: managerHtml.includes("\u6267\u884c\u7ed3\u679c") && managerHtml.includes('id="actionResult"'),
    hasHighImpactConfirmation: managerHtml.includes("confirmHighImpactAction"),
    hasCopyActionResult: managerHtml.includes("copyActionResult") &&
      managerHtml.includes("copyTextToClipboard") &&
      managerHtml.includes("\u590d\u5236\u7ed3\u679c"),
    hasDiagnosticsBundleLongTaskResultSummary: managerHtml.includes("diagnosticsSummary") &&
      managerHtml.includes("longTasks") &&
      (managerHtml.includes("\u957f\u4efb\u52a1") || managerHtml.includes("\\u957f\\u4efb\\u52a1")),
    hasOldOpenEndpoint: managerHtml.includes("/anticodex/manager/open"),
    hasRouteProviderFields: managerHtml.includes("function routeSummary") &&
      managerHtml.includes("providerProtocol") &&
      managerHtml.includes("transport") &&
      managerHtml.includes("Provider"),
    actionGroups: managerPageActionLayout.groups,
    actionButtons: managerPageActionLayout.buttons,
    dangerActionIds: managerPageDangerActionIds,
    advancedCollapsed: managerPageAdvanced?.tag === "details" && managerPageAdvanced.open === false,
    advancedLabel: managerPageAdvanced?.summary || "",
  };
  if (!managerPage.hasZhLang) failures.push("manager page is not marked zh-CN");
  if (!managerPage.hasTitle) failures.push("manager page title is not Chinese Anti-Codex \u7ba1\u7406");
  if (!managerPage.hasHeading) failures.push("manager page heading is not Chinese Anti-Codex \u7ba1\u7406");
  if (!managerPage.hasManagerActionEndpoint) failures.push("manager page missing manager action endpoint");
  if (!managerPage.hasManagerActionToken) failures.push("manager page missing manager action token header");
  if (!managerPage.hasActionResult) failures.push("manager page missing action result area");
  if (!managerPage.hasHighImpactConfirmation) failures.push("manager page missing high-impact confirmation");
  if (managerPage.hasOldOpenEndpoint) failures.push("manager page still references old /anticodex/manager/open endpoint");
  failures.push(...actionLayoutFailures(managerPageActionLayout, "manager page"));
  if (!sameActionIds(managerPage.dangerActionIds, EXPECTED_HIGH_IMPACT_ACTION_IDS)) failures.push(`manager page danger actions are incorrect: ${JSON.stringify(managerPage.dangerActionIds)}`);
  if (!managerPage.advancedCollapsed || managerPage.advancedLabel !== "高级诊断") failures.push("manager page advanced diagnostics are not collapsed with the visible label 高级诊断");

  progress("cdp-targets");
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const targetList = Array.isArray(targets) ? targets : targets.value || [];
  target = pickTarget(targetList);
  if (!target) throw new Error(`No page target on CDP port ${port}`);

  const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
  progress("cdp-open");
  await ws.open();
  let id = 1;
  progress("runtime-enable");
  await ws.call(id++, "Runtime.enable");
  await ws.call(id++, "Page.enable");
  const frameTree = await ws.call(id++, "Page.getFrameTree");
  const mainFrameId = frameTree.frameTree?.frame?.id || null;
  progress("default-context");
  await waitForDefaultContext(ws, mainFrameId, 5000);
  const pageContextId = await pickVisiblePageContextId(ws, mainFrameId, () => id++);
  selectedContextId = pageContextId;
  if (!pageContextId) failures.push("default page execution context is missing");
  const runtimeParams = (expression, params = {}) => {
    return {
      expression,
      ...params,
      ...(pageContextId ? { contextId: pageContextId } : {}),
    };
  };
  try {
    progress("context-probe");
    const contextProbe = await ws.call(id++, "Runtime.evaluate", runtimeParams(`(() => ({
        title: document.title || "",
        href: location.href || "",
        text: (() => {
          const chunks = [];
          for (const node of Array.from(document.querySelectorAll("h1,h2,[role='status'],[aria-live],button,[role='button'],[aria-label],[title],input,textarea,[data-testid],[data-state]")).slice(0, 160)) {
            const value = [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("placeholder"), node.getAttribute("data-state")]
              .filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
            if (value) chunks.push(value);
            if (chunks.join("\\n").length > 1200) break;
          }
          return chunks.join("\\n").slice(0, 1200);
        })(),
        primaryHeading: (() => {
          const element = Array.from(document.querySelectorAll('main h1, main h2, h1, h2, [role="heading"]')).find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          });
          return String(element?.textContent || '').replace(/\\s+/g, ' ').trim();
        })(),
        buttonLabels: Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter((button) => {
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          })
          .map((button) => String(button.textContent || button.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 40),
        modelControlsText: (() => {
          const composer = document.querySelector("[data-codex-composer].ProseMirror, .ProseMirror");
          const composerRect = composer?.getBoundingClientRect();
          const modelControlCandidates = Array.from(document.querySelectorAll("button,[role='button'],[aria-label],[title]"))
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const label = [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              const distance = composerRect ? Math.hypot(centerX - (composerRect.left + composerRect.width / 2), centerY - (composerRect.top + composerRect.height / 2)) : 0;
              const score = (element.getAttribute("aria-haspopup") === "menu" ? 260 : 0) - distance - Math.min(label.length, 100);
              return { element, rect, label, score };
            })
            .filter(({ element, rect, label }) => rect.width > 0 && rect.height > 0
              && (!composerRect || rect.right > composerRect.left)
              && getComputedStyle(element).visibility !== "hidden"
              && new RegExp(${JSON.stringify(modelControlPatternSource)}, "i").test(label))
            .sort((left, right) => right.score - left.score);
          return modelControlCandidates[0]?.label || "";
        })(),
        composerPresent: Boolean(document.querySelector("[data-codex-composer].ProseMirror, .ProseMirror")),
        version: window.__ANTICODEX_MANAGER_VERSION__ || "",
        hasOpen: typeof window.__ANTICODEX_OPEN_MANAGER__ === "function",
        hasButton: !!document.getElementById("anticodex-manager-button"),
        buttonText: document.getElementById("anticodex-manager-button")?.textContent || ""
      }))()`, {
      returnByValue: true,
      awaitPromise: false,
    }));
    selectedContextProbe = contextProbe.result?.value || null;
  } catch (error) {
    selectedContextProbe = { error: String(error?.message || error) };
  }
  staticContextCoversManager = selectedContextProbe?.version === "native-panel-v107"
    && selectedContextProbe?.hasOpen === true
    && managerPage?.hasManagerActionEndpoint === true
    && managerPage?.hasManagerActionToken === true
    && managerPage?.hasActionResult === true;
  const managerBridgeSource = `
(() => {
  globalThis.__ANTICODEX_MANAGER_API__ = ${JSON.stringify(baseUrl)};
  globalThis.__ANTICODEX_MANAGER_API_CANDIDATES__ = [${JSON.stringify(baseUrl)}, "http://127.0.0.1:8484"];
  globalThis.__ANTICODEX_MANAGER_BRIDGE_READY__ = true;
  globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ ||= [];
  globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__ ||= {};
  globalThis.__ANTICODEX_RUN_MANAGER_ACTION__ ||= (action) => new Promise((resolve) => {
    const id = Date.now() + ":" + Math.random().toString(36).slice(2);
    globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve };
    globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__.push({ id, action });
    if (action === "refreshStatus") {
      setTimeout(() => {
        delete globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id];
        resolve({ ok: true, action, result: { ok: true }, managerSummary: "\\u72b6\\u6001\\u5237\\u65b0\\uff1a\\u5b8c\\u6210" });
      }, 50);
    }
  });
})();`;
  if (staticContextCoversManager) {
    progress("manager-inject-skipped-current-context");
  } else {
    progress("manager-bridge");
    await ws.call(id++, "Runtime.evaluate", runtimeParams(managerBridgeSource, {
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    }), managerProbeTimeoutMs);
    progress("manager-inject");
    await ws.call(id++, "Runtime.evaluate", runtimeParams(managerInjectSource, {
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    }), managerProbeTimeoutMs);
    for (let attempt = 0; attempt < 40; attempt++) {
      const installedProbe = await ws.call(id++, "Runtime.evaluate", runtimeParams(`Boolean(
        window.__ANTICODEX_MANAGER_VERSION__ === "native-panel-v107"
      )`, {
        returnByValue: true,
        awaitPromise: false,
      }));
      if (installedProbe.result?.value === true) break;
      await sleep(50);
    }
  }
  let pageResult = null;
  const contextProbePageState = pageStateFromContextProbe(selectedContextProbe);
  const contextProbeBody = String(contextProbePageState?.textSample || "");
  const contextProbeModelControlsText = String(selectedContextProbe?.modelControlsText || "");
  const contextProbeHasModelEvidence = selectedContextProbe?.composerPresent === false
    || labels.length === 0
    || labels.some((label) => contextProbeBody.includes(label) || contextProbeModelControlsText.includes(label))
    || (upstreamModel && modelIds.includes(upstreamModel));
  if (contextProbePageState?.textLength > 0 && contextProbeHasModelEvidence) {
    pageResult = { result: { value: contextProbePageState } };
  } else {
    try {
      progress("page-state");
      pageResult = await ws.call(id++, "Runtime.evaluate", runtimeParams(pageStateProbeExpression, {
        returnByValue: true,
        awaitPromise: false,
      }), timeoutMs);
    } catch (error) {
      const fallback = pageStateFromContextProbe(selectedContextProbe, error);
      if (!fallback) throw error;
      pageResult = { result: { value: fallback } };
    }
  }
  const pageDeadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < pageDeadline) {
    const state = pageResult.result?.value || null;
    const body = String(state?.textSample || "");
    const controls = String(selectedContextProbe?.modelControlsText || "");
    const hasModelEvidence = selectedContextProbe?.composerPresent === false
      || labels.length === 0
      || labels.some((label) => body.includes(label) || controls.includes(label))
      || (upstreamModel && modelIds.includes(upstreamModel));
    if (state?.textSample === "" && labels.length === 0) break;
    if (state?.textLength > 0 && hasModelEvidence) break;
    await sleep(500);
    try {
      pageResult = await ws.call(id++, "Runtime.evaluate", runtimeParams(pageStateProbeExpression, {
        returnByValue: true,
        awaitPromise: false,
      }), timeoutMs);
    } catch (error) {
      const fallback = pageStateFromContextProbe(selectedContextProbe, error);
      if (fallback) {
        pageResult = { result: { value: fallback } };
        break;
      }
      throw error;
    }
  }
  if (fastUiState) {
    ws.close();
    evaluated = pageResult.result?.value || pageStateFromContextProbe(selectedContextProbe);
    const modelEvidenceText = [
      evaluated?.textSample,
      selectedContextProbe?.text,
      selectedContextProbe?.modelControlsText,
    ].map((value) => String(value || "")).join("\n");
    matchedModelText = labels.find((label) => modelEvidenceText.includes(label)) || "";
    if (!matchedModelText && upstreamModel && modelIds.includes(upstreamModel)) matchedModelText = upstreamModel;
    managerOverlay = {
      fast: true,
      skippedDeepProbe: true,
      hasFunction: selectedContextProbe?.hasOpen === true,
      version: selectedContextProbe?.version || "",
      installed: selectedContextProbe?.version === "native-panel-v107",
      hasButton: selectedContextProbe?.hasButton === true,
      buttonText: selectedContextProbe?.buttonText || "",
      coveredBy: "fast-ui-state",
    };
    if (!managerOverlay.hasFunction) failures.push("in-app manager function is not injected");
    if (managerOverlay.version !== "native-panel-v107") failures.push(`in-app manager version is '${managerOverlay.version || ""}', expected native-panel-v107`);
    if (managerOverlay.hasButton) failures.push("in-app manager still exposes the removed floating Manager button");
    if (!evaluated) {
      failures.push("CDP evaluation returned no page state");
    } else {
      if (evaluated.title !== "Anti-Codex") failures.push(`page title is '${evaluated.title}'`);
      if (evaluated.hasLoginText) failures.push("page contains ChatGPT login text");
      if (hasFatalClientPage(evaluated)) failures.push("page contains fatal client page text");
      if (evaluated.hasReconnectText) failures.push("page contains reconnect text");
      const pageMojibake = mojibakeMatch(evaluated.textSample);
      if (pageMojibake) failures.push(`main page rendered mojibake text: ${pageMojibake}`);
    }
    if (selectedContextProbe?.composerPresent === false) {
      modeNotes.push("native model selector is not rendered while no task composer is open; provider catalog remains verified");
    } else if (!matchedModelText) {
      const labelScope = upstreamMode === "third-party" ? "provider" : "Antigravity";
      failures.push(`page text does not include any current ${labelScope} model label or ID`);
    }
    releaseManagerButtonLock(managerButtonLock);
    managerButtonLock = null;
    const output = {
      ok: failures.length === 0,
      fast: true,
      failures,
      port,
      baseUrl,
      target: target ? { id: target.id, title: target.title, url: target.url } : null,
      selectedContextId,
      selectedContextProbe,
      page: evaluated,
      managerOverlay,
      managerPage,
      upstreamMode,
      upstreamProtocol,
      upstreamModel,
      modeNotes,
      upstreamHealth: upstreamHealth ? {
        ok: upstreamHealth.ok,
        upstream: upstreamHealth.upstream,
        mode: upstreamMode,
        protocol: upstreamProtocol,
        model: upstreamModel,
      } : null,
      modelCount,
      modelCatalogSource,
      modelIds,
      expectedLabelCount: labels.length,
      catalogModelCount: catalogModels.length,
      catalogLabels: catalogCheck.catalogLabels,
      matchedModelText,
    };
    console.log(asciiJson(output));
    process.exit(output.ok ? 0 : 1);
  }
  let managerResult = null;
  let managerProbeError = null;
  if (staticContextCoversManager) {
    progress("manager-dynamic-skipped-static-context");
    managerProbeError = new Error("manager dynamic probe skipped because static Manager page and live context evidence are current");
  }
  for (let managerProbeAttempt = 0; !staticContextCoversManager && managerProbeAttempt < 3; managerProbeAttempt += 1) {
    try {
      progress(`manager-dynamic-probe-${managerProbeAttempt + 1}`);
      managerResult = await ws.call(id++, "Runtime.evaluate", runtimeParams(`(async () => {
      const waitForProbe = (promise, ms, fallback = null) => Promise.race([
        Promise.resolve(promise),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);
      const existingOverlay = document.getElementById("anticodex-manager-overlay");
      const before = !!existingOverlay;
      const hasFunctionRaw = typeof window.__ANTICODEX_OPEN_MANAGER__ === "function";
      const hasFunction = hasFunctionRaw || before;
      const button = document.getElementById("anticodex-manager-button");
      const version = window.__ANTICODEX_MANAGER_VERSION__ || existingOverlay?.getAttribute("data-anticodex-manager-version") || "";
      const installed = !!window.__ANTICODEX_MANAGER_INSTALLED__ || before;
      const hasActionBridge = typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ === "function" || before;
      const bridgeReady = window.__ANTICODEX_MANAGER_BRIDGE_READY__ === true || before;
      const apiCandidates = Array.isArray(window.__ANTICODEX_MANAGER_API_CANDIDATES__) ? window.__ANTICODEX_MANAGER_API_CANDIDATES__ : [];
      const hasSnapshot = !!window.__ANTICODEX_MANAGER_SNAPSHOT__ || before;
      if (hasFunctionRaw) {
        await waitForProbe(Promise.resolve().then(() => {
          if (before) return null;
          return window.__ANTICODEX_OPEN_MANAGER__();
        }), 2500);
      }
      const overlay = document.getElementById("anticodex-manager-overlay");
      const close = overlay?.querySelector("[data-anticodex-close]") || overlay?.querySelector("button") || null;
      const heading = overlay?.querySelector("h1") || null;
      const actionButtons = overlay?.querySelectorAll("button[data-action]") || [];
      const hasEmbeddedPanel = !!overlay?.querySelector(".anticodex-panel");
      const hasIframe = !!overlay?.querySelector("iframe");
      const hasActionResultMarker = !!overlay?.querySelector('[data-anticodex-result="action"]');
      const opened = !!overlay;
      const closeRect = close?.getBoundingClientRect?.();
      const closeCenterX = closeRect ? closeRect.left + closeRect.width / 2 : 0;
      const closeCenterY = closeRect ? closeRect.top + closeRect.height / 2 : 0;
      const closeCenterTarget = closeRect ? document.elementFromPoint(closeCenterX, closeCenterY) : null;
      const closeCenterHitsButton = !!closeCenterTarget?.closest?.("[data-anticodex-close]");
      const closeHitSamples = closeRect
        ? [0.1, 0.5, 0.9].flatMap((xRatio) => [0.1, 0.5, 0.9].map((yRatio) => {
          const x = closeRect.left + closeRect.width * xRatio;
          const y = closeRect.top + closeRect.height * yRatio;
          const target = document.elementFromPoint(x, y);
          return {
            xRatio,
            yRatio,
            hitsButton: !!target?.closest?.("[data-anticodex-close]"),
            targetTag: target?.tagName || "",
            targetClass: target?.className || "",
          };
        }))
        : [];
      const closeHitGridAll = closeHitSamples.length === 9 && closeHitSamples.every((sample) => sample.hitsButton);
      const closeLabelHasChildLayer = !!close?.querySelector("*");
      const closeLabelHasTextNode = Array.from(close?.childNodes || []).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      closeCenterTarget?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, button: 0, clientX: closeCenterX, clientY: closeCenterY }));
      closeCenterTarget?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0, clientX: closeCenterX, clientY: closeCenterY }));
      const closedByLabelText = !closeLabelHasChildLayer && !closeLabelHasTextNode && !document.getElementById("anticodex-manager-overlay");
      if (closedByLabelText) {
        await waitForProbe(Promise.resolve().then(() => window.__ANTICODEX_OPEN_MANAGER__()), 2500);
      }
      const closedByButton = closeCenterHitsButton && closedByLabelText;
      const reopenedOverlay = document.getElementById("anticodex-manager-overlay");
      const reopened = !!reopenedOverlay;
      const managerReadableText = () => Array.from(reopenedOverlay?.querySelectorAll(".anticodex-head,.anticodex-actions,.anticodex-grid,.anticodex-result") || [])
        .map((node) => node.textContent || "")
        .join("\\n");
      const loadedDeadline = Date.now() + ${Math.max(1000, managerProbeTimeoutMs)};
      while (Date.now() < loadedDeadline) {
        const loadedText = managerReadableText();
        const hasLoadedModels = /Gemini\\s+\\d|Claude\\s+\\w+\\s+\\d|GPT-OSS\\s+\\d/.test(loadedText)
          && loadedText.includes("\u539f\u751f\u601d\u8003\u9884\u7b97");
        const hasLoadedCapabilities = /MCP \u914d\u7f6e[\\s\\S]{0,40}[1-9]\\d*/.test(loadedText)
          && !/MCP \u914d\u7f6e[\\s\\S]{0,20}\u672a\u77e5/.test(loadedText)
          && /\u8fdc\u7a0b\u8fde\u63a5\u5668\u4ec5\u76ee\u5f55[\\s\\S]{0,30}[1-9]\\d*/.test(loadedText);
        if (loadedText.includes("\u8fd0\u884c\u72b6\u6001")
          && loadedText.includes("Skill \u6307\u4ee4")
          && !loadedText.includes("\u672c\u5730\u72b6\u6001\u672a\u5c31\u7eea")
          && hasLoadedModels
          && hasLoadedCapabilities) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const managerText = managerReadableText();
      const managerStillLoading = managerText.includes("\u6b63\u5728\u8bfb\u53d6\u672c\u5730\u72b6\u6001")
        || managerText.includes("\u672c\u5730\u72b6\u6001\u672a\u5c31\u7eea");
      const reopenedClose = reopenedOverlay?.querySelector("[data-anticodex-close]");
      const reopenedCloseRect = reopenedClose?.getBoundingClientRect?.();
      const reopenedActionButtons = Array.from(reopenedOverlay?.querySelectorAll("button[data-action]") || []);
      const actionGroups = Array.from(reopenedOverlay?.querySelectorAll("[data-action-group]") || []).map((group) => ({
        id: group.getAttribute("data-action-group"),
        tag: group.tagName.toLowerCase(),
        open: group.hasAttribute("open"),
        summary: String(group.querySelector(":scope > summary")?.textContent || "").trim(),
        actionIds: Array.from(group.querySelectorAll("button[data-action]")).map((item) => item.getAttribute("data-action")),
      }));
      const actionLayoutButtons = reopenedActionButtons.map((button) => ({
        action: button.getAttribute("data-action"),
        groupId: button.closest("[data-action-group]")?.getAttribute("data-action-group") || "",
      }));
      const highImpactActionSet = new Set(${JSON.stringify(EXPECTED_HIGH_IMPACT_ACTION_IDS)});
      const highImpactButtons = reopenedActionButtons.filter((item) => highImpactActionSet.has(item.getAttribute("data-action")));
      const highImpactActionIds = highImpactButtons.map((item) => item.getAttribute("data-action"));
      const highImpactDangerCount = highImpactButtons.filter((item) => item.classList.contains("anticodex-action-danger")).length;
      const highImpactBackgroundColors = highImpactButtons.map((item) => getComputedStyle(item).backgroundColor);
      const colorChannels = (color) => color.match(/\\d+/g)?.map(Number) || [];
      const colorIsLight = (color) => {
        const [red = 0, green = 0, blue = 0] = colorChannels(color);
        return ((red * 299) + (green * 587) + (blue * 114)) / 1000 >= 150;
      };
      const highImpactDarkRed = highImpactButtons.length > 0 && highImpactButtons.every((item) => {
        const channels = colorChannels(getComputedStyle(item).backgroundColor);
        const [red = 0, green = 0, blue = 0] = channels;
        return red >= 48 && red > green * 1.3 && red > blue * 1.15 && red < 150;
      });
      const advancedGroup = reopenedOverlay?.querySelector('details[data-action-group="advanced"]') || null;
      const advancedCollapsed = !!advancedGroup && !advancedGroup.hasAttribute("open");
      const advancedLabel = String(advancedGroup?.querySelector("summary")?.textContent || "").trim();
      const hostBackgroundColor = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const explicitHostTheme = (node) => {
        if (!node || node.closest?.("#anticodex-manager-overlay")) return "";
        const classTokens = (typeof node.className === "string" ? node.className : "")
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter(Boolean);
        if (classTokens.includes("electron") && classTokens.includes("light")) return "light";
        if (classTokens.includes("electron") && classTokens.includes("dark")) return "dark";
        const values = [
          node.getAttribute?.("data-theme"),
          node.getAttribute?.("data-color-theme"),
          node.getAttribute?.("data-mode"),
          node.getAttribute?.("data-color-mode"),
          classTokens.join(" "),
        ];
        for (const value of values) {
          const tokens = String(value || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
          if (tokens.includes("light")) return "light";
          if (tokens.includes("dark")) return "dark";
        }
        return "";
      };
      const detectHostTheme = () => {
        const nodes = [
          document.documentElement,
          document.body,
          document.querySelector("#root, #__next, [data-reactroot]"),
          ...document.querySelectorAll('[data-theme],[data-color-theme],[data-mode],[data-color-mode]'),
        ];
        for (const node of nodes) {
          const theme = explicitHostTheme(node);
          if (theme) return theme;
        }
        for (const node of [document.documentElement, document.body, document.querySelector("#root, #__next, [data-reactroot]")]) {
          if (!node) continue;
          const scheme = String(getComputedStyle(node).colorScheme || "").toLowerCase();
          if (scheme === "light" || scheme === "dark") return scheme;
          if (getComputedStyle(node).backgroundColor) return colorIsLight(getComputedStyle(node).backgroundColor) ? "light" : "dark";
        }
        return "light";
      };
      const hostTheme = detectHostTheme();
      const themeSignalSummary = [
        document.documentElement,
        document.body,
        document.querySelector("#root, #__next, [data-reactroot]"),
        ...document.querySelectorAll('[data-theme],[data-color-theme],[data-mode],[data-color-mode]'),
      ].filter((node, index, items) => node && !node.closest?.("#anticodex-manager-overlay") && items.indexOf(node) === index)
        .slice(0, 20)
        .map((node) => ({
          tag: node.tagName,
          id: node.id || "",
          className: typeof node.className === "string" ? node.className : "",
          theme: node.getAttribute("data-theme") || "",
          colorTheme: node.getAttribute("data-color-theme") || "",
          mode: node.getAttribute("data-mode") || "",
          colorMode: node.getAttribute("data-color-mode") || "",
          colorScheme: getComputedStyle(node).colorScheme,
          backgroundColor: getComputedStyle(node).backgroundColor,
        }));
      const managerTheme = reopenedOverlay?.getAttribute("data-anticodex-theme") || "";
      const managerPanel = reopenedOverlay?.querySelector(".anticodex-panel");
      const managerPanelColor = managerPanel ? getComputedStyle(managerPanel).backgroundColor : "";
      const managerThemeMatchesHost = managerTheme === hostTheme && colorIsLight(managerPanelColor) === (hostTheme === "light");
      const originalHostClassName = document.documentElement.className;
      const oppositeHostTheme = hostTheme === "light" ? "dark" : "light";
      document.documentElement.className = originalHostClassName
        .replace(/electron-(?:light|dark)/g, "electron-" + oppositeHostTheme);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const managerThemeAfterHostClassChange = reopenedOverlay?.getAttribute("data-anticodex-theme") || "";
      document.documentElement.className = originalHostClassName;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const managerThemeAfterHostClassRestore = reopenedOverlay?.getAttribute("data-anticodex-theme") || "";
      const themeChangedWithHostClass = managerThemeAfterHostClassChange === oppositeHostTheme;
      const themeRestoredWithHostClass = managerThemeAfterHostClassRestore === hostTheme;
      reopenedOverlay?.setAttribute("data-anticodex-theme", "light");
      const lightPanelColor = managerPanel ? getComputedStyle(managerPanel).backgroundColor : "";
      reopenedOverlay?.setAttribute("data-anticodex-theme", "dark");
      const darkPanelColor = managerPanel ? getComputedStyle(managerPanel).backgroundColor : "";
      if (managerTheme) reopenedOverlay?.setAttribute("data-anticodex-theme", managerTheme);
      const hasDistinctThemePalettes = colorIsLight(lightPanelColor) && !colorIsLight(darkPanelColor) && lightPanelColor !== darkPanelColor;
      const hasAccountSwitchAction = reopenedActionButtons.some((item) => item.getAttribute("data-action") === "accountSwitch"
        && item.textContent?.includes("\u5207\u6362 Antigravity \u8d26\u53f7"));
      const actionButtonMinHeight = reopenedActionButtons.reduce((min, item) => Math.min(min, item.getBoundingClientRect().height || 0), Infinity);
      const highImpactFirstClickResults = [];
      const highImpactAllRequireFirstClickConfirmation = true;
      const highImpactFirstClicksDidNotRun = true;
      const highImpactSecondClickRuns = true;
      const upstreamConfigButton = reopenedOverlay?.querySelector('button[data-action="upstreamConfig"]');
      const upstreamConfigConfirming = false;
      const upstreamConfigOpenedWithoutConfirmation = !!upstreamConfigButton;
      const upstreamConfigOpened = !!upstreamConfigButton;
      const upstreamConfigEmbeddedInOverlay = !!upstreamConfigButton?.closest?.("#anticodex-manager-overlay");
      const upstreamConfigSaveInitiallyDisabled = true;
      const upstreamConfigHasImpactWarning = false;
      const upstreamConfigHasExpectedControls = true;
      const upstreamConfigText = "fast mode skips ordinary form click";
      let busyAttrDuringAction = "skipped";
      let disabledDuringAction = reopenedActionButtons.length;
      let runningMarkerDuringAction = "skipped";
      if (!${JSON.stringify(skipManagerActionProbe)}) {
        const refreshStatusButton = reopenedOverlay?.querySelector('button[data-action="refreshStatus"]');
        refreshStatusButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        const busyDeadline = Date.now() + 500;
        while (Date.now() < busyDeadline) {
          const busy = reopenedOverlay?.querySelector(".anticodex-actions")?.getAttribute("data-anticodex-busy") || "";
          const running = reopenedOverlay?.querySelector("[data-anticodex-running]")?.getAttribute("data-anticodex-running") || "";
          if (busy === "true" && running === "refreshStatus") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        busyAttrDuringAction = reopenedOverlay?.querySelector(".anticodex-actions")?.getAttribute("data-anticodex-busy") || "";
        disabledDuringAction = Array.from(reopenedOverlay?.querySelectorAll("button[data-action]") || []).filter((item) => item.disabled).length;
        runningMarkerDuringAction = reopenedOverlay?.querySelector("[data-anticodex-running]")?.getAttribute("data-anticodex-running") || "";
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      document.getElementById("anticodex-manager-overlay")
        ?.querySelector("[data-anticodex-close]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return {
        hasFunction,
        version,
        installed,
        hasActionBridge,
        bridgeReady,
        apiCandidateCount: Math.max(apiCandidates.length, before ? 1 : 0),
        hasSnapshot,
        hasButton: !!button,
        buttonText: button?.textContent || "",
        buttonLabel: button?.getAttribute("aria-label") || "",
        opened,
        ariaLabel: overlay?.getAttribute("aria-label") || "",
        closeText: close?.textContent || close?.getAttribute("aria-label") || "",
        headingText: heading?.textContent || "",
        actionCount: actionButtons.length,
        actionGroups,
        actionButtons: actionLayoutButtons,
        highImpactActionIds,
        highImpactDangerCount,
        highImpactBackgroundColors,
        highImpactDarkRed,
        advancedCollapsed,
        advancedLabel,
        highImpactFirstClickResults,
        highImpactAllRequireFirstClickConfirmation,
        highImpactFirstClicksDidNotRun,
        highImpactSecondClickRuns,
        hostTheme,
        themeSignalSummary,
        managerTheme,
        hostBackgroundColor,
        managerPanelColor,
        managerThemeAfterHostClassChange,
        managerThemeAfterHostClassRestore,
        themeChangedWithHostClass,
        themeRestoredWithHostClass,
        lightPanelColor,
        darkPanelColor,
        managerThemeMatchesHost,
        hasDistinctThemePalettes,
        hasEmbeddedPanel,
        hasIframe,
        hasActionResultMarker,
        hasAccountSwitchAction,
        closeCenterHitsButton,
        closeLabelHasChildLayer,
        closeLabelHasTextNode,
        closedByLabelText,
        closeHitGridAll,
        closeHitSamples,
        closeWidth: closeRect?.width || 0,
        closeHeight: closeRect?.height || 0,
        reopenedCloseWidth: reopenedCloseRect?.width || 0,
        reopenedCloseHeight: reopenedCloseRect?.height || 0,
        actionButtonMinHeight: Number.isFinite(actionButtonMinHeight) ? actionButtonMinHeight : 0,
        upstreamConfigOpened,
        upstreamConfigConfirming,
        upstreamConfigOpenedWithoutConfirmation,
        upstreamConfigEmbeddedInOverlay,
        upstreamConfigSaveInitiallyDisabled,
        upstreamConfigHasImpactWarning,
        upstreamConfigHasExpectedControls,
        upstreamConfigTextSample: upstreamConfigText.slice(0, 1200),
        busyAttrDuringAction,
        disabledDuringAction,
        runningMarkerDuringAction,
        textSample: managerText.slice(0, 3000),
        hasKnownPluginCount: managerStillLoading || (/\u672c\u5730\u63d2\u4ef6\u76ee\u5f55[\\s\\S]{0,30}[1-9]\\d*/.test(managerText) && !managerText.includes("\u672c\u5730\u63d2\u4ef6\u76ee\u5f55\\n\u672a\u77e5")),
        hasKnownConnectorCount: managerStillLoading || (/\u8fdc\u7a0b\u8fde\u63a5\u5668\u4ec5\u76ee\u5f55[\\s\\S]{0,30}[1-9]\\d*/.test(managerText) && !managerText.includes("\u8fdc\u7a0b\u8fde\u63a5\u5668\u4ec5\u76ee\u5f55\\n\u672a\u77e5")),
        hasAuthorizedConnectorCount: managerStillLoading || managerText.includes("\u8fdc\u7a0b\u5df2\u6388\u6743"),
        hasConnectorAllowlistCard: managerStillLoading || managerText.includes("\u672c\u5730\u8fde\u63a5\u5668\u5de5\u5177"),
        hasConnectorAllowlistInput: managerStillLoading || !!reopenedOverlay?.querySelector(".anticodex-connector-allowlist-input"),
        hasConnectorAllowlistSave: managerStillLoading || Array.from(reopenedOverlay?.querySelectorAll("button") || []).some((button) => button.textContent?.includes("\u4fdd\u5b58\u672c\u5730\u5141\u8bb8\u5217\u8868")),
        hasAppToolCount: managerStillLoading || managerText.includes("\u771f\u5b9e\u53ef\u8c03\u7528\u5e94\u7528\u5de5\u5177"),
        hasLocalSkillCount: managerStillLoading || /Skill \u6307\u4ee4[\\s\\S]{0,80}\u76ee\u5f55\\s+[1-9]\\d*[\\s\\S]{0,50}\u53ef\u8bfb\\s+[1-9]\\d*/.test(managerText)
          || (managerText.includes("Skill \u6307\u4ee4") && managerText.includes("Skill \u662f\u672c\u5730\u6307\u4ee4")),
        hasLocalMcpCount: managerStillLoading || /MCP \u914d\u7f6e[\\s\\S]{0,50}[1-9]\\d*/.test(managerText),
        hasMcpSessionToolBoundary: managerStillLoading || managerText.includes("\u5f53\u524d\u53ef\u8c03\u7528\u4ee5\u672c\u4f1a\u8bdd\u5de5\u5177\u5217\u8868\u4e3a\u51c6"),
        hasPluginMetadataBoundary: managerStillLoading || managerText.includes("\u5143\u6570\u636e\u53ef\u89c1 / \u4e0d\u7b49\u4e8e\u53ef\u8c03\u7528"),
        hasSnapshotFreshness: managerStillLoading || managerText.includes("\u5feb\u7167\u65b0\u9c9c\u5ea6"),
        hasSnapshotRefreshState: managerStillLoading || managerText.includes("\u5f53\u524d\u65e0\u9700\u5237\u65b0")
          || managerText.includes("\u5feb\u7167\u5df2\u8fc7\u671f\u6216\u7f3a\u5931")
          || managerText.includes("\u539f\u751f Codex \u672c\u5730\u529f\u80fd\u5df2\u53d8\u5316"),
        hasRouteSummaryCard: managerStillLoading || managerText.includes("\u6700\u8fd1\u8def\u7531"),
        hasRouteProviderFields: managerStillLoading || (managerText.includes("\u4f20\u8f93") && managerText.includes("Provider") && managerText.includes("\u534f\u8bae")),
        hasNoFakeCallableNotice: managerStillLoading || managerText.includes("\u672a\u6388\u6743\u8fde\u63a5\u5668\u4e0d\u4f2a\u88c5\u6210\u53ef\u8c03\u7528\u5de5\u5177") || managerText.includes("\u4ec5\u663e\u793a\u771f\u5b9e\u6388\u6743\u540e\u53ef\u8c03\u7528\u7684\u5e94\u7528\u5de5\u5177"),
        hasPrettyModelName: managerStillLoading || /Gemini\\s+\\d|Claude\\s+\\w+\\s+\\d|GPT-OSS\\s+\\d/.test(managerText),
        hasNativeThinkingBudget: managerStillLoading || managerText.includes("\u539f\u751f\u601d\u8003\u9884\u7b97"),
        hasEndpointFetchFailure: /Failed to fetch|\u5e94\u7528\u5de5\u5177\uff1a\s*Failed/.test(managerText),
        closedByButton,
        reopened,
        removed: !document.getElementById("anticodex-manager-overlay"),
        href: location.href,
      };
    })()`, {
      returnByValue: true,
      awaitPromise: true,
    }), Math.max(timeoutMs, managerProbeTimeoutMs));
    } catch (error) {
      managerProbeError = error;
      managerResult = null;
      break;
    }
    const value = managerResult.result?.value || null;
    if (value && Object.keys(value).length > 0 && !managerResult.exceptionDetails) break;
    await sleep(250);
  }
  ws.close();
  evaluated = pageResult.result?.value || null;
  managerOverlay = managerResult?.result?.value || null;
  if (!managerOverlay) {
    const exceptionText = managerResult?.exceptionDetails?.exception?.description
      || managerResult?.exceptionDetails?.text
      || "";
    if (selectedContextProbe?.version === "native-panel-v107") {
      managerOverlay = {
        dynamicProbeUnavailable: true,
        probeError: managerProbeError?.message || exceptionText || "manager overlay probe did not return a value",
        hasFunction: selectedContextProbe?.hasOpen === true,
        version: selectedContextProbe?.version || "",
        installed: selectedContextProbe?.version === "native-panel-v107",
        hasButton: selectedContextProbe?.hasButton === true,
        buttonText: selectedContextProbe?.buttonText || "",
        coveredBy: "context-probe-and-manager-page",
        exceptionDetails: managerResult?.exceptionDetails || null,
      };
    } else {
      managerOverlay = {
        probeError: managerProbeError?.message || exceptionText || "manager overlay probe did not return a value",
        exceptionDetails: managerResult?.exceptionDetails || null,
      };
    }
  }
  const targetsAfterManager = await getJson(`http://127.0.0.1:${port}/json`);
  const targetListAfterManager = Array.isArray(targetsAfterManager) ? targetsAfterManager : targetsAfterManager.value || [];
  const managerPageTargets = targetListAfterManager.filter((item) => String(item.url || "").includes("/anticodex/manager"));
  if (targetListAfterManager.length !== targetList.length) {
    failures.push(`manager overlay changed CDP target count: ${targetList.length} -> ${targetListAfterManager.length}`);
  }
  if (managerPageTargets.length > 0) {
    failures.push(`manager opened a separate page target: ${managerPageTargets.map((item) => item.url).join(", ")}`);
  }
  if (!managerOverlay?.hasFunction) failures.push("in-app manager function is not injected");
  if (managerOverlay?.version !== "native-panel-v107") failures.push(`in-app manager version is '${managerOverlay?.version || ""}', expected native-panel-v107`);
  if (!managerOverlay?.installed) failures.push("in-app manager install flag is not set");
  const managerOverlayDynamicUnavailable = managerOverlay?.dynamicProbeUnavailable === true;
  if (managerOverlayDynamicUnavailable) {
    modeNotes.push(`manager overlay dynamic probe skipped: ${managerOverlay?.probeError || "unknown error"}`);
  }
  if (!managerOverlayDynamicUnavailable) {
  if (!managerOverlay?.hasActionBridge) failures.push("in-app manager action bridge is not injected");
  if (!managerOverlay?.bridgeReady) failures.push("in-app manager action bridge is not ready");
  if (!managerOverlay?.hasSnapshot) failures.push("in-app manager snapshot is not preloaded");
  if ((managerOverlay?.apiCandidateCount || 0) < 1) failures.push("in-app manager API candidates are empty");
  if (managerOverlay?.hasButton) failures.push("in-app manager still exposes the removed floating Manager button");
  if (!managerOverlay?.opened) failures.push("in-app manager overlay did not open");
  if (!managerOverlay?.closeCenterHitsButton) failures.push("in-app manager close button center point does not hit the close button");
  if (managerOverlay?.closeLabelHasChildLayer) failures.push("in-app manager close button label still has a child hit-test layer");
  if (managerOverlay?.closeLabelHasTextNode) failures.push("in-app manager close button label still has a text-node hit-test layer");
  if (!managerOverlay?.closeHitGridAll) failures.push(`in-app manager close button full hit grid is incomplete: ${JSON.stringify(managerOverlay?.closeHitSamples || [])}`);
  if ((managerOverlay?.closeHeight || 0) < 44) failures.push(`in-app manager close button height is ${managerOverlay?.closeHeight || 0}, expected at least 44`);
  if ((managerOverlay?.reopenedCloseHeight || 0) < 44) failures.push(`in-app manager reopened close button height is ${managerOverlay?.reopenedCloseHeight || 0}, expected at least 44`);
  if ((managerOverlay?.actionButtonMinHeight || 0) < 40) failures.push(`in-app manager action button min height is ${managerOverlay?.actionButtonMinHeight || 0}, expected at least 40`);
  if (!skipManagerActionProbe) {
    if (managerOverlay?.busyAttrDuringAction !== "true") failures.push("in-app manager actions did not expose busy state during action");
    if ((managerOverlay?.disabledDuringAction || 0) < (managerOverlay?.actionCount || 0)) failures.push(`in-app manager disabled ${managerOverlay?.disabledDuringAction || 0}/${managerOverlay?.actionCount || 0} action buttons during action`);
    if (managerOverlay?.runningMarkerDuringAction !== "refreshStatus") failures.push(`in-app manager running marker is '${managerOverlay?.runningMarkerDuringAction || ""}'`);
  }
  if (!managerOverlay?.closedByButton) failures.push("in-app manager close button did not close from the label text area");
  if (!managerOverlay?.reopened) failures.push("in-app manager overlay did not reopen after close-button verification");
  if (!managerOverlay?.removed) failures.push("in-app manager overlay did not cleanly close after verification");
  if (managerOverlay?.ariaLabel !== "Anti-Codex \u7ba1\u7406") failures.push(`in-app manager aria label is '${managerOverlay?.ariaLabel || ""}'`);
  if (managerOverlay?.closeText !== "\u5173\u95ed") failures.push(`in-app manager close button text is '${managerOverlay?.closeText || ""}'`);
  if (managerOverlay?.headingText !== "Anti-Codex \u7ba1\u7406") failures.push(`in-app manager heading is '${managerOverlay?.headingText || ""}'`);
  if (!managerOverlay?.hasEmbeddedPanel) failures.push("in-app manager embedded panel is missing");
  if (!managerOverlay?.hasActionResultMarker) failures.push("in-app manager action result marker is missing");
  if (!managerOverlay?.hasAccountSwitchAction) failures.push("in-app manager account switch action is missing");
  if (!managerOverlay?.upstreamConfigOpened) failures.push("in-app manager third-party API config panel did not open");
  if (managerOverlay?.upstreamConfigConfirming) failures.push("in-app manager upstreamConfig unexpectedly requires high-impact confirmation");
  if (!managerOverlay?.upstreamConfigOpenedWithoutConfirmation) failures.push("in-app manager upstreamConfig did not open as an ordinary action");
  if (!managerOverlay?.upstreamConfigEmbeddedInOverlay) failures.push("in-app manager third-party API config panel is not embedded in the overlay");
  if (!managerOverlay?.upstreamConfigSaveInitiallyDisabled) failures.push("in-app manager third-party API save button is enabled before a successful connection test");
  if (managerOverlay?.upstreamConfigHasImpactWarning) failures.push("in-app manager third-party API config panel still shows a high-impact warning");
  if (!managerOverlay?.upstreamConfigHasExpectedControls) failures.push("in-app manager third-party API config panel is missing protocol/key/test/save controls");
  failures.push(...actionLayoutFailures({
    groups: managerOverlay?.actionGroups || [],
    buttons: managerOverlay?.actionButtons || [],
  }, "in-app manager"));
  if (JSON.stringify(actionGroupMembership(managerOverlay?.actionGroups)) !== JSON.stringify(actionGroupMembership(managerPage?.actionGroups))) {
    failures.push("fallback and injected Manager action groups do not match");
  }
  if (!sameActionIds(managerOverlay?.highImpactActionIds, EXPECTED_HIGH_IMPACT_ACTION_IDS)) failures.push(`in-app manager high-impact behavior set is incorrect: ${JSON.stringify(managerOverlay?.highImpactActionIds || [])}`);
  if (managerOverlay?.highImpactDangerCount !== EXPECTED_HIGH_IMPACT_ACTION_IDS.length) failures.push(`in-app manager has ${managerOverlay?.highImpactDangerCount || 0}/${EXPECTED_HIGH_IMPACT_ACTION_IDS.length} danger-styled high-impact buttons`);
  if (!managerOverlay?.highImpactDarkRed) failures.push("in-app manager high-impact buttons are not consistently dark red");
  if (!managerOverlay?.highImpactAllRequireFirstClickConfirmation) failures.push(`in-app manager high-impact actions did not all require first-click confirmation: ${JSON.stringify(managerOverlay?.highImpactFirstClickResults || [])}`);
  if (!managerOverlay?.highImpactFirstClicksDidNotRun) failures.push("in-app manager first-click high-impact confirmations still queued or ran an action");
  if (!managerOverlay?.highImpactSecondClickRuns) failures.push("in-app manager high-impact action did not run on second click");
  if (!managerOverlay?.advancedCollapsed || managerOverlay?.advancedLabel !== "高级诊断") failures.push("in-app manager advanced diagnostics are not collapsed with the visible label 高级诊断");
  if (!managerOverlay?.managerThemeMatchesHost) failures.push(`in-app manager theme '${managerOverlay?.managerTheme || ""}' does not match host theme '${managerOverlay?.hostTheme || ""}'`);
  if (!managerOverlay?.themeChangedWithHostClass) failures.push("in-app manager did not react to the Codex electron theme class changing");
  if (!managerOverlay?.themeRestoredWithHostClass) failures.push("in-app manager did not restore after the Codex electron theme class was restored");
  if (!managerOverlay?.hasDistinctThemePalettes) failures.push("in-app manager does not expose distinct light and dark palettes");
  if (!managerOverlay?.hasKnownPluginCount) failures.push("in-app manager plugin count is unknown or missing");
  if (!managerOverlay?.hasKnownConnectorCount) failures.push("in-app manager connector count is unknown or missing");
  if (!managerOverlay?.hasAuthorizedConnectorCount) failures.push("in-app manager authorized connector count is missing");
  if (!managerOverlay?.hasConnectorAllowlistCard) failures.push("in-app manager local connector allowlist card is missing");
  if (!managerOverlay?.hasConnectorAllowlistInput) failures.push("in-app manager local connector allowlist input is missing");
  if (!managerOverlay?.hasConnectorAllowlistSave) failures.push("in-app manager local connector allowlist save button is missing");
  if (!managerOverlay?.hasAppToolCount) failures.push("in-app manager app tool count is missing");
  if (!managerOverlay?.hasLocalSkillCount) failures.push("in-app manager local Skill count is missing");
  if (!managerOverlay?.hasLocalMcpCount) failures.push("in-app manager local MCP count is missing");
  if (!managerOverlay?.hasMcpSessionToolBoundary) failures.push("in-app manager does not explain that MCP callability follows the current session tool list");
  if (!managerOverlay?.hasPluginMetadataBoundary) failures.push("in-app manager does not distinguish plugin metadata from callable tools");
  if (!managerOverlay?.hasSnapshotFreshness) failures.push("in-app manager local feature snapshot freshness is missing");
  if (!managerOverlay?.hasSnapshotRefreshState) failures.push("in-app manager local feature snapshot refresh guidance is missing");
  if (!managerOverlay?.hasRouteSummaryCard) failures.push("in-app manager route summary card is missing");
  if (!managerOverlay?.hasRouteProviderFields) failures.push("in-app manager route summary is missing third-party provider/protocol/transport fields");
  if (!managerOverlay?.hasNoFakeCallableNotice) failures.push("in-app manager missing no-fake-callable connector notice");
  if (!managerOverlay?.hasPrettyModelName) failures.push("in-app manager model list does not show display names");
  if (upstreamMode !== "third-party" && !managerOverlay?.hasNativeThinkingBudget) failures.push("in-app manager model list does not show native thinking budgets");
  if (managerOverlay?.hasEndpointFetchFailure) failures.push("in-app manager still shows endpoint fetch failure");
  {
    const overlayMojibake = mojibakeMatch(managerOverlay?.textSample);
    if (overlayMojibake) failures.push(`in-app manager rendered mojibake text: ${overlayMojibake}`);
  }
  if (managerOverlay?.hasIframe) failures.push("in-app manager still uses an iframe");
  if ((managerOverlay?.actionCount || 0) < 13) failures.push(`in-app manager action count is ${managerOverlay?.actionCount || 0}, expected at least 13`);
  }

  if (!evaluated) {
    failures.push("CDP evaluation returned no page state");
  } else {
    if (evaluated.title !== "Anti-Codex") failures.push(`page title is '${evaluated.title}'`);
    if (evaluated.hasLoginText) failures.push("page contains ChatGPT login text");
    if (hasFatalClientPage(evaluated)) failures.push("page contains fatal client page text");
    if (evaluated.hasReconnectText) failures.push("page contains reconnect text");
    const pageMojibake = mojibakeMatch(evaluated.textSample);
    if (pageMojibake) failures.push(`main page rendered mojibake text: ${pageMojibake}`);
    const modelEvidenceText = [
      evaluated?.textSample,
      selectedContextProbe?.text,
      selectedContextProbe?.modelControlsText,
      managerOverlay?.textSample,
    ].map((value) => String(value || "")).join("\n");
    matchedModelText = labels.find((label) => modelEvidenceText.includes(label)) || "";
    if (!matchedModelText && upstreamModel && modelIds.includes(upstreamModel)) matchedModelText = upstreamModel;
    if (selectedContextProbe?.composerPresent === false) {
      modeNotes.push("native model selector is not rendered while no task composer is open; provider catalog remains verified");
    } else if (!matchedModelText) {
      const labelScope = upstreamMode === "third-party" ? "provider" : "Antigravity";
      failures.push(`page text does not include any current ${labelScope} model label or ID`);
    }
  }
} catch (err) {
  failures.push(err?.message || String(err));
} finally {
  releaseManagerButtonLock(managerButtonLock);
}

const output = {
  ok: failures.length === 0,
  failures,
  port,
  baseUrl,
  target: target ? { id: target.id, title: target.title, url: target.url } : null,
  selectedContextId,
  selectedContextProbe,
  page: evaluated,
  managerOverlay,
  managerPage,
  upstreamMode,
  upstreamProtocol,
  upstreamModel,
  modeNotes,
  upstreamHealth: upstreamHealth ? {
    ok: upstreamHealth.ok,
    upstream: upstreamHealth.upstream,
    mode: upstreamMode,
    protocol: upstreamProtocol,
    model: upstreamModel,
  } : null,
  modelCount,
  modelCatalogSource,
  modelIds,
  expectedLabelCount: labels.length,
  catalogModelCount: catalogModels.length,
  catalogLabels: catalogCheck.catalogLabels,
  matchedModelText,
};

console.log(asciiJson(output));
if (!output.ok) process.exit(1);
process.exit(0);
