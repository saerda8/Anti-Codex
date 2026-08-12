#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  captureExactFileSnapshot,
  classifyNativeSettingsCrashSnapshot,
  classifyUnsupportedExternalSettingsTarget,
  compareNativeSettingsRuntimeContract,
  exactFileSnapshotMatches,
  promptSettingsStatesEqual,
  promptSettingsStatesSemanticallyEqual,
  readNativeSettingsContract,
  resolveNativeSettingsAsarPath,
  restoreExactFileSnapshot,
} from "./anticodex-native-settings-contract.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const next = process.argv[index + 1];
  args.set(key, next && !next.startsWith("--") ? process.argv[++index] : "true");
}

const port = Number(args.get("--port") || process.env.DEEPCODEX_CDP_PORT || 18318);
const action = String(args.get("--action") || "syncHost");
const confirmed = String(args.get("--confirm") || "false").toLowerCase() === "true";
const inspectOnly = String(args.get("--inspect-only") || "false").toLowerCase() === "true";
const nativeSettingsAcceptance = String(args.get("--native-settings") || "false").toLowerCase() === "true";
const promptSettingsSaveRestore = String(args.get("--prompt-settings-save-restore") || "false").toLowerCase() === "true";
const promptSettingsRestoreDefault = String(args.get("--prompt-settings-restore-default") || "false").toLowerCase() === "true";
const promptClosePosition = String(args.get("--prompt-close-position") || "").toLowerCase();
const promptSettingsUiOnly = Boolean(promptClosePosition) || promptSettingsSaveRestore || promptSettingsRestoreDefault
  || String(args.get("--prompt-settings-ui-only") || "false").toLowerCase() === "true";
const promptSettingsAcceptanceValue = "Anti-Codex 原生自定义指令实体按钮测试；本次立即恢复默认。";
const promptSettingsStateRoot = promptSettingsUiOnly && process.env.APPDATA
  ? resolve(String(process.env.APPDATA), "anticodex")
  : "";
const promptSettingsAgentsPath = promptSettingsStateRoot
  ? resolve(promptSettingsStateRoot, "codex-home-deepseek-app", "AGENTS.md")
  : "";
const promptSettingsPolicyPath = promptSettingsStateRoot
  ? resolve(promptSettingsStateRoot, "prompt-policy.json")
  : "";
const promptSettingsRecoveryFile = promptSettingsRestoreDefault
  ? promptSettingsAgentsPath
  : "";
const promptSettingsRecoveryFileValue = promptSettingsRecoveryFile && existsSync(promptSettingsRecoveryFile)
  ? readFileSync(promptSettingsRecoveryFile, "utf8")
  : "";
const timeoutMs = Number(args.get("--timeout-ms") || 35_000);
const nativeSettingsAsarPath = nativeSettingsAcceptance
  ? resolveNativeSettingsAsarPath({ explicitPath: args.get("--app-asar") || "", scriptDirectory: import.meta.dirname })
  : "";

if (promptClosePosition && !["top", "middle", "bottom"].includes(promptClosePosition)) throw new Error(`Invalid prompt close position: ${promptClosePosition}`);
if (action !== "syncHost" && !promptSettingsUiOnly && !nativeSettingsAcceptance) throw new Error(`Only the built-in syncHost action is allowed, received: ${action}`);
if (!confirmed && !inspectOnly && (!promptSettingsUiOnly || promptSettingsSaveRestore || promptSettingsRestoreDefault)) throw new Error("Refusing to arm a write-capable real-mouse action without --confirm true.");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid CDP port: ${port}`);
if (promptSettingsUiOnly && !process.env.APPDATA) throw new Error("Refusing prompt acceptance without the isolated Anti-Codex state root.");

const stateRoot = nativeSettingsAcceptance
  ? resolve(String(args.get("--state-root") || join(process.env.APPDATA || "", "anticodex")))
  : "";
const codexHome = nativeSettingsAcceptance
  ? resolve(String(args.get("--codex-home") || join(stateRoot, "codex-home-deepseek-app")))
  : "";
if (nativeSettingsAcceptance) {
  const codexHomeRelative = relative(stateRoot, codexHome);
  if (!process.env.APPDATA || !codexHomeRelative || codexHomeRelative.startsWith("..") || isAbsolute(codexHomeRelative)) {
    throw new Error("Refusing to inspect custom instructions outside the isolated Anti-Codex state root.");
  }
  if (!existsSync(nativeSettingsAsarPath)) throw new Error(`Native Settings registration source is missing: ${nativeSettingsAsarPath}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickPrimaryAppTarget(targets) {
  const pages = targets.filter((target) => target?.type === "page"
    && target.webSocketDebuggerUrl
    && !String(target.url || "").toLowerCase().includes("avatar-overlay"));
  return pages.find((target) => /^app:\/\/-\/index\.html(?:[?#]|$)/i.test(String(target.url || "")))
    || pages.find((target) => String(target.url || "").startsWith("app://"))
    || pages[0]
    || null;
}

function pickUniquePrimaryAppTarget(targets) {
  const pages = targets.filter((target) => target?.type === "page"
    && target.webSocketDebuggerUrl
    && /^app:\/\/-\/index\.html(?:[?#]|$)/i.test(String(target.url || ""))
    && !String(target.url || "").toLowerCase().includes("avatar-overlay"));
  if (pages.length !== 1) {
    throw new Error(`Expected exactly one visible Anti-Codex page target, found ${pages.length}.`);
  }
  return pages[0];
}

async function getTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Anti-Codex CDP target list returned HTTP ${response.status}`);
  return response.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Anti-Codex CDP.")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to Anti-Codex CDP."));
    }, { once: true });
  });
}

const targets = await getTargets();
if (nativeSettingsAcceptance) pickUniquePrimaryAppTarget(targets);
const target = pickPrimaryAppTarget(targets);
if (!target) throw new Error(`No Anti-Codex page target found on CDP port ${port}.`);

const socket = await connect(target.webSocketDebuggerUrl);
let nextId = 1;
let closed = false;
const pending = new Map();

socket.addEventListener("message", (event) => {
  let payload;
  try { payload = JSON.parse(String(event.data)); } catch { return; }
  if (!payload.id || !pending.has(payload.id)) return;
  const request = pending.get(payload.id);
  pending.delete(payload.id);
  clearTimeout(request.timer);
  if (payload.error) request.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
  else request.resolve(payload.result || {});
});
socket.addEventListener("close", () => {
  closed = true;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Anti-Codex CDP connection closed."));
  }
  pending.clear();
});

function call(method, params = {}, callTimeoutMs = 8_000) {
  if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Anti-Codex CDP connection is not open."));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out.`));
    }, callTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, callTimeoutMs = 8_000) {
  const response = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: true,
  }, callTimeoutMs);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Anti-Codex evaluation failed.");
  }
  return response.result?.value;
}

async function realMouseClick(point, label = "target") {
  for (const event of [
    { type: "mouseMoved", button: "none", buttons: 0 },
    { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
    { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
  ]) {
    try {
      await call("Input.dispatchMouseEvent", { ...event, x: point.x, y: point.y, pointerType: "mouse" }, 12_000);
    } catch (error) {
      throw new Error(`Real mouse click ${label} failed during ${event.type} at ${point.x},${point.y}: ${error?.message || error}`);
    }
  }
}

async function realMouseWheel(point, deltaY) {
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY,
    pointerType: "mouse",
  }, 12_000);
}

async function waitFor(probe, predicate, waitMs = timeoutMs) {
  const deadline = Date.now() + waitMs;
  let value;
  do {
    value = await evaluate(probe);
    if (predicate(value)) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for visible Anti-Codex state: ${JSON.stringify(value)}`);
}

const visiblePoint = (selectorExpression) => `(() => {
  const node = ${selectorExpression};
  const rect = node?.getBoundingClientRect?.();
  if (!node || !rect || rect.width <= 0 || rect.height <= 0) return { ok: false };
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {
    ok: hit === node || hit?.closest?.('button,[role="menuitem"],[data-radix-collection-item]') === node,
    x,
    y,
    text: String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim(),
    ariaLabel: String(node.getAttribute?.('aria-label') || ''),
    disabled: Boolean(node.disabled),
    ariaDisabled: node.getAttribute?.('aria-disabled') === 'true',
    tag: node.tagName || '',
  };
})()`;

const nativeSettingsNavExpression = `document.querySelector('nav[aria-label="Settings"], nav[aria-label="设置"]')`;
const nativeSettingsPanelExpression = `(() => {
  const nav = ${nativeSettingsNavExpression};
  const visible = (node) => {
    const rect = node?.getBoundingClientRect?.();
    return rect && rect.width > 0 && rect.height > 0 && !node.contains(nav);
  };
  const semantic = Array.from(document.querySelectorAll('main,[role="main"],.main-surface,[class*="main-surface"]')).filter(visible);
  if (semantic.length > 0) {
    return semantic.sort((left, right) => String(right.innerText || '').length - String(left.innerText || '').length)[0];
  }
  let ancestor = nav;
  while (ancestor?.parentElement && ancestor.parentElement !== document.body) {
    const siblings = Array.from(ancestor.parentElement.children || []).filter(visible);
    if (siblings.length > 0) {
      return siblings.sort((left, right) => String(right.innerText || '').length - String(left.innerText || '').length)[0];
    }
    ancestor = ancestor.parentElement;
  }
  return null;
})()`;
const nativeInstructionTextareaExpression = `(() => {
  const scope = ${nativeSettingsPanelExpression} || document.body;
  const labels = Array.from(scope.querySelectorAll('h1,h2,h3,label,span,div,p'));
  const label = labels.find((node) => /^(Custom instructions|自定义指令)$/.test(String(node.textContent || '').trim()));
  let container = label;
  while (container && container !== scope) {
    const textarea = container.querySelector?.('textarea');
    if (textarea) return textarea;
    container = container.parentElement;
  }
  const textareas = Array.from(scope.querySelectorAll('textarea'));
  return textareas.length === 1 ? textareas[0] : null;
})()`;
const nativeInstructionsSaveButtonExpression = `(() => {
  const textarea = ${nativeInstructionTextareaExpression};
  let container = textarea;
  while (container && container !== document.body) {
    const button = Array.from(container.querySelectorAll?.('button') || [])
      .find((node) => /^(Save|保存)$/.test(String(node.innerText || node.textContent || '').trim()));
    if (button) return button;
    container = container.parentElement;
  }
  return null;
})()`;

function readAgentsSnapshot() {
  const filePath = join(codexHome, "AGENTS.md");
  return {
    filePath,
    existed: existsSync(filePath),
    contents: existsSync(filePath) ? readFileSync(filePath, "utf8") : "",
  };
}

async function waitForLocal(probe, predicate, waitMs = timeoutMs) {
  const deadline = Date.now() + waitMs;
  let value;
  do {
    value = probe();
    if (predicate(value)) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the isolated Anti-Codex AGENTS.md state.");
}

async function openNativeSettingsSection(slug) {
  await evaluate(`(() => {
    const node = Array.from((${nativeSettingsNavExpression})?.querySelectorAll('button[data-settings-panel-slug]') || [])
      .find((entry) => entry.getAttribute('data-settings-panel-slug') === ${JSON.stringify(slug)});
    node?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(node);
  })()`);
  const point = await waitFor(
    visiblePoint(`Array.from((${nativeSettingsNavExpression})?.querySelectorAll('button[data-settings-panel-slug]') || [])
      .find((entry) => entry.getAttribute('data-settings-panel-slug') === ${JSON.stringify(slug)})`),
    (value) => value?.ok === true && value.disabled !== true && value.ariaDisabled !== true,
  );
  await realMouseClick(point);
  return waitFor(`(() => {
    const nav = ${nativeSettingsNavExpression};
    const active = Array.from(nav?.querySelectorAll('button[data-settings-panel-slug]') || [])
      .find((entry) => entry.getAttribute('data-settings-panel-slug') === ${JSON.stringify(slug)});
    const panel = ${nativeSettingsPanelExpression};
    const panelText = String(panel?.innerText || '').replace(/\\s+/g, ' ').trim();
    const bodyText = String(document.body?.innerText || '');
    const isVisible = (entry) => {
      const rect = entry?.getBoundingClientRect?.();
      const style = entry ? getComputedStyle(entry) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const headings = Array.from(document.querySelectorAll('main h1, main h2, h1, h2, [role="heading"]'))
      .filter(isVisible)
      .map((entry) => String(entry.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .map((entry) => String(entry.textContent || entry.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    const classifyNativeSettingsCrashSnapshot = ${classifyNativeSettingsCrashSnapshot.toString()};
    const crash = classifyNativeSettingsCrashSnapshot({
      headings,
      buttons,
      bodyText,
      hasComposer: Boolean(document.querySelector('[data-codex-composer], .ProseMirror')),
    });
    const loading = /^(Loading settings…?|正在加载设置…?)$/i.test(panelText);
    const selected = active?.getAttribute('aria-current') === 'page';
    const controlCount = panel?.querySelectorAll?.('button,input,textarea,select,a').length || 0;
    const classifyUnsupportedExternalSettingsTarget = ${classifyUnsupportedExternalSettingsTarget.toString()};
    const externalTargets = Array.from(panel?.querySelectorAll?.('a,button') || [])
      .filter((entry) => {
        const rect = entry.getBoundingClientRect?.();
        return rect && rect.width > 0 && rect.height > 0;
      })
      .map((entry) => classifyUnsupportedExternalSettingsTarget({
        href: String(entry.href || entry.querySelector?.('a')?.href || ''),
        label: String(entry.getAttribute?.('aria-label') || entry.textContent || ''),
      }))
      .filter(Boolean);
    return {
      ok: Boolean(nav && active && selected && panel && !crash && !loading && (panelText.length > 0 || controlCount > 0)),
      route: location.pathname,
      selected,
      panelTextLength: panelText.length,
      controlCount,
      externalTargets,
      crash,
      loading,
    };
  })()`, (value) => value?.ok === true);
}

async function replaceNativeInstructions(contents) {
  const point = await waitFor(visiblePoint(nativeInstructionTextareaExpression), (value) => value?.ok === true);
  await realMouseClick(point);
  for (const type of ["keyDown", "keyUp"]) {
    await call("Input.dispatchKeyEvent", {
      type,
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
  }
  await call("Input.insertText", { text: contents });
  await waitFor(
    `(() => ((${nativeInstructionTextareaExpression})?.value || '') === ${JSON.stringify(contents)})()`,
    (value) => value === true,
  );
}

async function saveNativeInstructions() {
  const point = await waitFor(
    visiblePoint(nativeInstructionsSaveButtonExpression),
    (value) => value?.ok === true && value.disabled !== true && value.ariaDisabled !== true,
  );
  await realMouseClick(point);
}

const promptSettingsStateExpression = `(() => {
  const root = document.querySelector('#anticodex-manager-overlay');
  const section = (title) => Array.from(root?.querySelectorAll('section') || [])
    .find((node) => String(node.querySelector('h2')?.textContent || '').trim() === title);
  const editor = (node) => {
    const inputs = Array.from(node?.querySelectorAll('input[type="checkbox"]') || []);
    return {
      enabled: inputs[0]?.checked === true,
      useDefault: inputs[1]?.checked === true,
      content: String(node?.querySelector('textarea')?.value || ''),
    };
  };
  const systemNode = section('Codex 完整合并提示词（Gemini / Claude / 第三方）');
  const developerNode = section('Codex 开发者提示词');
  const nativeNode = section('Codex 原生自定义指令 (AGENTS.md)');
  const userNode = section('Anti-Codex 附加提示词（Gemini / Claude / 第三方）');
  return {
    ok: Boolean(root && systemNode?.querySelectorAll('input[type="checkbox"]').length === 2
      && developerNode?.querySelectorAll('input[type="checkbox"]').length === 2
      && userNode?.querySelectorAll('input[type="checkbox"]').length === 1
      && systemNode?.querySelector('textarea') && developerNode?.querySelector('textarea')
      && userNode?.querySelector('textarea') && nativeNode?.querySelector('textarea')),
    codexSystem: editor(systemNode),
    codexDeveloper: editor(developerNode),
    user: {
      enabled: userNode?.querySelector('input[type="checkbox"]')?.checked === true,
      content: String(userNode?.querySelector('textarea')?.value || ''),
    },
    nativeCustomInstructions: { content: String(nativeNode?.querySelector('textarea')?.value || '') },
  };
})()`;

const promptViewStateExpression = `(() => {
  const root = document.querySelector('#anticodex-manager-overlay');
  const promptForm = Array.from(root?.querySelectorAll('section h2') || [])
    .some((node) => String(node.textContent || '').trim() === 'Codex 原生自定义指令 (AGENTS.md)');
  return {
    view: root?.getAttribute('data-anticodex-manager-view') || '',
    busy: root?.getAttribute('data-anticodex-busy') || '',
    generation: Number(root?.getAttribute('data-anticodex-prompt-generation') || 0),
    promptForm,
    statusButton: Boolean(root?.querySelector('button[data-action="syncHost"]')),
  };
})()`;

async function capturePromptSettingsState() {
  const state = await evaluate(promptSettingsStateExpression);
  if (!state?.ok) throw new Error("Prompt settings are incomplete; refusing a write-capable acceptance.");
  const existed = existsSync(promptSettingsAgentsPath);
  const contents = existed ? readFileSync(promptSettingsAgentsPath, "utf8") : "";
  if (state.nativeCustomInstructions.content !== contents) {
    throw new Error("Prompt UI and isolated AGENTS.md differ; refusing a write-capable acceptance.");
  }
  state.nativeCustomInstructions.existed = existed;
  return state;
}

async function applyPromptSettingsState(state) {
  const applied = await evaluate(`(() => {
    const desired = ${JSON.stringify(state)};
    const root = document.querySelector('#anticodex-manager-overlay');
    const section = (title) => Array.from(root?.querySelectorAll('section') || [])
      .find((node) => String(node.querySelector('h2')?.textContent || '').trim() === title);
    const setChecked = (node, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
      setter?.call(node, value === true);
      node?.dispatchEvent(new Event('input', { bubbles: true }));
      node?.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setText = (node, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(node, String(value || ''));
      node?.dispatchEvent(new Event('input', { bubbles: true }));
      node?.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setEditor = (title, value) => {
      const node = section(title);
      const inputs = Array.from(node?.querySelectorAll('input[type="checkbox"]') || []);
      setChecked(inputs[0], value.enabled);
      setChecked(inputs[1], value.useDefault);
      setText(node?.querySelector('textarea'), value.content);
    };
    setEditor('Codex 完整合并提示词（Gemini / Claude / 第三方）', desired.codexSystem);
    setEditor('Codex 开发者提示词', desired.codexDeveloper);
    const userNode = section('Anti-Codex 附加提示词（Gemini / Claude / 第三方）');
    setChecked(userNode?.querySelector('input[type="checkbox"]'), desired.user.enabled);
    setText(userNode?.querySelector('textarea'), desired.user.content);
    setText(section('Codex 原生自定义指令 (AGENTS.md)')?.querySelector('textarea'), desired.nativeCustomInstructions.content);
    return Boolean(root);
  })()`);
  if (!applied) throw new Error("Could not restore the complete prompt settings form.");
  const appliedState = await evaluate(promptSettingsStateExpression);
  if (!appliedState?.ok) throw new Error("Prompt settings form became incomplete while applying the transaction.");
  appliedState.nativeCustomInstructions.existed = state.nativeCustomInstructions.existed === true;
  if (!promptSettingsStatesEqual(state, appliedState)) {
    throw new Error("Prompt settings form did not accept the complete transactional state.");
  }
}

async function savePromptSettingsForm() {
  const previousOperationGeneration = Number(await evaluate(`document.querySelector('#anticodex-manager-overlay')?.getAttribute('data-anticodex-operation-generation') || 0`));
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('#anticodex-manager-overlay button')).find((node) => String(node.innerText || node.textContent || '').trim() === '保存');
    button?.scrollIntoView({ block: 'center' });
    return Boolean(button);
  })()`);
  await sleep(150);
  const savePoint = await waitFor(
    visiblePoint(`Array.from(document.querySelectorAll('#anticodex-manager-overlay button')).find((node) => String(node.innerText || node.textContent || '').trim() === '保存')`),
    (value) => value?.ok === true && value.disabled !== true && value.ariaDisabled !== true,
  );
  await realMouseClick(savePoint, "保存");
  await waitFor(`(() => ({
    busy: document.querySelector('#anticodex-manager-overlay')?.getAttribute('data-anticodex-busy') || '',
    generation: Number(document.querySelector('#anticodex-manager-overlay')?.getAttribute('data-anticodex-operation-generation') || 0),
    text: document.querySelector('#anticodex-manager-overlay [data-anticodex-result="action"]')?.textContent || '',
  }))()`, (value) => value?.generation > previousOperationGeneration
    && value?.busy === "false"
    && String(value?.text || "").includes("已保存"), 15_000);
}

async function ensurePromptSettingsView() {
  const current = await evaluate(promptViewStateExpression);
  if (current?.view === "prompts") {
    await waitFor(promptViewStateExpression, (value) => value?.view === "prompts" && value?.busy === "false" && value?.promptForm === true);
    return;
  }
  if (current?.view !== "status") throw new Error("Manager prompt view is unavailable for transactional restoration.");
  const previousGeneration = Number(current?.generation || 0);
  const point = await waitFor(
    visiblePoint(`document.querySelector('#anticodex-manager-overlay button[data-anticodex-prompt-settings="true"]')`),
    (value) => value?.ok === true && value.disabled !== true && value.ariaDisabled !== true,
  );
  await realMouseClick(point, "提示词");
  await waitFor(promptViewStateExpression, (value) => value?.view === "prompts"
    && value?.busy === "false"
    && value?.generation > previousGeneration
    && value?.promptForm === true);
  await waitFor(promptSettingsStateExpression, (value) => value?.ok === true);
}

async function reopenPromptSettingsView() {
  await ensurePromptSettingsView();
  const previousGeneration = Number((await evaluate(promptViewStateExpression))?.generation || 0);
  const backPoint = await waitFor(
    visiblePoint(`Array.from(document.querySelectorAll('#anticodex-manager-overlay button')).find((node) => String(node.innerText || node.textContent || '').trim() === '返回状态')`),
    (value) => value?.ok === true,
  );
  await realMouseClick(backPoint, "返回状态");
  await waitFor(promptViewStateExpression, (value) => value?.view === "status"
    && value?.busy === "false"
    && value?.promptForm === false
    && value?.statusButton === true);
  const promptPoint = await waitFor(
    visiblePoint(`document.querySelector('#anticodex-manager-overlay button[data-anticodex-prompt-settings="true"]')`),
    (value) => value?.ok === true && value.disabled !== true && value.ariaDisabled !== true,
  );
  await realMouseClick(promptPoint, "提示词");
  await waitFor(promptViewStateExpression, (value) => value?.view === "prompts"
    && value?.busy === "false"
    && value?.generation > previousGeneration
    && value?.promptForm === true);
  await waitFor(promptSettingsStateExpression, (value) => value?.ok === true);
}

async function restorePromptSettingsState(promptStateBefore) {
  await ensurePromptSettingsView();
  await applyPromptSettingsState(promptStateBefore);
  await savePromptSettingsForm();
  await reopenPromptSettingsView();
  const promptStateAfterRestore = await capturePromptSettingsState();
  if (!promptSettingsStatesSemanticallyEqual(promptStateBefore, promptStateAfterRestore)) {
    throw new Error("Prompt settings did not restore the original semantic values after physical acceptance.");
  }
  return promptStateAfterRestore;
}

async function restoreNativeInstructions(originalUiValue, originalFile) {
  await openNativeSettingsSection("personalization");
  await replaceNativeInstructions(originalUiValue);
  await saveNativeInstructions();
  await waitForLocal(readAgentsSnapshot, (snapshot) => originalFile.existed
    ? snapshot.existed && snapshot.contents === originalFile.contents
    : !snapshot.existed || snapshot.contents === "");
  return { restored: true, originalExisted: originalFile.existed, originalLength: originalUiValue.length };
}

async function auditNativeAgentSettings() {
  const snapshot = await waitFor(`(() => {
    const panel = ${nativeSettingsPanelExpression};
    if (!panel) return { ok: false, missingPanel: true };
    const text = String(panel.innerText || '').replace(/\\s+/g, ' ').trim();
    const findControl = (pattern) => {
      const label = Array.from(panel.querySelectorAll('label,h1,h2,h3,span,p,div'))
        .find((node) => pattern.test(String(node.textContent || '').trim()));
      let container = label;
      while (container && container !== panel) {
        const control = Array.from(container.querySelectorAll?.('button,select,input') || [])
          .find((node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
        if (control) return {
          found: true,
          disabled: Boolean(control.disabled) || control.getAttribute('aria-disabled') === 'true' || control.hasAttribute('data-disabled'),
        };
        container = container.parentElement;
      }
      return { found: Boolean(label), disabled: false };
    };
    const approval = findControl(/^(Approval policy|批准策略)$/i);
    const sandbox = findControl(/^(Sandbox settings|沙盒设置)$/i);
    const network = findControl(/^(Allow network access|允许网络访问)$/i);
    const fullAccess = /(Full access|完全访问)/i.test(text);
    const managed = /(restricted by this installation|managed by admin policy|受此次安装的限制|管理员策略管理)/i.test(text);
    return {
      ok: approval.found && approval.disabled && sandbox.found && sandbox.disabled && managed
        && !(fullAccess && network.found && !network.disabled),
      approval,
      sandbox,
      network,
      fullAccess,
      managed,
    };
  })()`, (value) => value?.ok === true);
  if (!snapshot?.ok) throw new Error(`Native Agent settings are not truthfully managed: ${JSON.stringify(snapshot)}`);
  return snapshot;
}

async function auditNativePersonalization({ allowWrite }) {
  const originalFile = readAgentsSnapshot();
  await waitFor(`(() => Boolean(${nativeInstructionTextareaExpression}))()`, (value) => value === true);
  const originalUiValue = await evaluate(`(() => (${nativeInstructionTextareaExpression})?.value || '')()`);
  if (originalUiValue !== originalFile.contents) {
    throw new Error("Native custom instructions do not resolve to the isolated Anti-Codex AGENTS.md.");
  }
  if (!allowWrite) {
    return { inspected: true, mutated: false, originalExisted: originalFile.existed, originalLength: originalUiValue.length };
  }

  const sentinel = `Anti-Codex native Settings acceptance ${randomUUID()}`;
  let restoreRequired = false;
  let failure = null;
  let saved = null;
  try {
    restoreRequired = true;
    await replaceNativeInstructions(sentinel);
    await saveNativeInstructions();
    saved = await waitForLocal(readAgentsSnapshot, (snapshot) => snapshot.existed && snapshot.contents === sentinel);
  } catch (error) {
    failure = error;
  } finally {
    if (restoreRequired) {
      try {
        await restoreNativeInstructions(originalUiValue, originalFile);
      } catch (restoreError) {
        failure = new AggregateError([failure, restoreError].filter(Boolean), "Native custom-instructions acceptance failed and restoration was incomplete.");
      }
    }
  }
  if (failure) throw failure;
  return {
    inspected: true,
    mutated: true,
    savedToIsolatedAgentsFile: saved?.filePath === originalFile.filePath,
    restored: true,
    originalExisted: originalFile.existed,
    originalLength: originalUiValue.length,
  };
}

async function runNativeSettingsAcceptance() {
  const nativeSettingsContract = readNativeSettingsContract(nativeSettingsAsarPath);
  const nav = await waitFor(`(() => {
    const node = ${nativeSettingsNavExpression};
    const rect = node?.getBoundingClientRect?.();
    const entries = Array.from(node?.querySelectorAll('button[data-settings-panel-slug]') || [])
      .filter((entry) => {
        const entryRect = entry.getBoundingClientRect();
        return entryRect.width > 0 && entryRect.height > 0 && !entry.disabled && entry.getAttribute('aria-disabled') !== 'true';
      })
      .map((entry) => ({ slug: entry.getAttribute('data-settings-panel-slug'), label: entry.getAttribute('aria-label') || String(entry.textContent || '').trim() }));
    const classifyUnsupportedExternalSettingsTarget = ${classifyUnsupportedExternalSettingsTarget.toString()};
    const externalTargets = Array.from(node?.querySelectorAll('a,button') || [])
      .filter((entry) => {
        if (entry.hasAttribute('data-settings-panel-slug')) return false;
        const rect = entry.getBoundingClientRect?.();
        return rect && rect.width > 0 && rect.height > 0;
      })
      .map((entry) => classifyUnsupportedExternalSettingsTarget({
        href: String(entry.href || entry.querySelector?.('a')?.href || ''),
        label: String(entry.getAttribute?.('aria-label') || entry.textContent || ''),
      }))
      .filter(Boolean);
    return { ok: Boolean(node && rect && rect.width > 0 && rect.height > 0 && entries.length > 0), entries, externalTargets };
  })()`, (value) => value?.ok === true);
  if (nav.externalTargets.length > 0) {
    throw new Error(`External ChatGPT/OpenAI account settings are still visible in native Settings navigation: ${JSON.stringify(nav.externalTargets)}`);
  }
  const slugComparison = compareNativeSettingsRuntimeContract(
    nativeSettingsContract,
    nav.entries.map((entry) => entry.slug),
  );
  if (!slugComparison.ok) {
    throw new Error(`Native Settings registration mismatch: ${JSON.stringify({
      knownSlugs: slugComparison.expected,
      visibleSlugs: slugComparison.visible,
      gatedSlugs: slugComparison.gated,
      missingWithoutGateEvidence: slugComparison.missingWithoutGateEvidence,
      duplicateSlugs: slugComparison.duplicates,
      unexpectedSlugs: slugComparison.unexpected,
    })}`);
  }

  const pages = [];
  let agent = null;
  let personalization = null;
  for (const entry of nav.entries) {
    const page = await openNativeSettingsSection(entry.slug);
    pages.push({ ...entry, ...page });
    if (entry.slug === "agent") agent = await auditNativeAgentSettings();
    if (entry.slug === "personalization") {
      personalization = await auditNativePersonalization({ allowWrite: !inspectOnly });
    }
  }
  const pageExternalTargets = pages.flatMap((page) => page.externalTargets.map((target) => ({
    slug: page.slug,
    page: page.label,
    ...target,
  })));
  if (pageExternalTargets.length > 0) {
    throw new Error(`External ChatGPT/OpenAI account settings are still visible in native Settings pages: ${JSON.stringify(pageExternalTargets)}`);
  }
  if (!agent) throw new Error("Native Settings did not expose the required Configuration page.");
  if (!personalization) throw new Error("Native Settings did not expose the required Personalization page.");
  const localSecurityLabels = nav.entries
    .filter((entry) => /Security|安全/i.test(entry.label))
    .map((entry) => entry.label);
  return {
    ok: pages.length === nav.entries.length && pages.every((page) => page.ok),
    inspectOnly,
    pages,
    knownSlugs: slugComparison.expected,
    visibleSlugs: slugComparison.visible,
    gatedSlugs: slugComparison.gated,
    missingWithoutGateEvidence: slugComparison.missingWithoutGateEvidence,
    duplicateSlugs: slugComparison.duplicates,
    unexpectedSlugs: slugComparison.unexpected,
    externalChatGptSettingsHidden: nav.externalTargets.length === 0 && pageExternalTargets.length === 0,
    pageExternalTargets,
    localSecurityLabels,
    agent,
    personalization,
  };
}

let result;
try {
  await call("Runtime.enable");
  if (inspectOnly && !nativeSettingsAcceptance) {
    result = await evaluate(`(() => ({
      ok: true,
      version: window.__ANTICODEX_MANAGER_VERSION__ || '',
      overlayOpen: Boolean(document.querySelector('#anticodex-manager-overlay')),
      currentActionToken: window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ || '',
      inFlightToken: window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ || '',
      pendingActions: window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ || {},
      queuedActions: (window.__ANTICODEX_MANAGER_ACTION_QUEUE__ || []).map((entry) => entry?.action || ''),
      lastAction: window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ || null,
    }))()`);
    console.log(JSON.stringify({ ...result, port, target: { id: target.id, title: target.title, url: target.url } }));
    process.exit(0);
  }
  await call("Page.enable");
  if (nativeSettingsAcceptance) {
    const identity = await evaluate(`(() => ({
      visible: document.visibilityState === 'visible',
      profileMenu: Boolean(Array.from(document.querySelectorAll('button')).find((node) => /打开个人资料菜单|Open profile menu/i.test(node.getAttribute('aria-label') || ''))),
      managerVersion: window.__ANTICODEX_MANAGER_VERSION__ || '',
    }))()`);
    if (!identity?.visible || !identity?.profileMenu || !identity?.managerVersion) {
      throw new Error(`Expected exactly one visible Anti-Codex page target with the native profile menu: ${JSON.stringify(identity)}`);
    }
  }
  await call("Page.bringToFront");
  await evaluate(`(() => { window.focus(); return { focused: document.hasFocus(), visibility: document.visibilityState }; })()`);

  const existingManagerClosePoint = await evaluate(
    visiblePoint(`document.querySelector('#anticodex-manager-overlay button.anticodex-close[aria-label="关闭"]')`),
  );
  if (existingManagerClosePoint?.ok === true) {
    await realMouseClick(existingManagerClosePoint);
    await waitFor(
      `(() => !document.querySelector('#anticodex-manager-overlay'))()`,
      (value) => value === true,
      5_000,
    );
  }

  for (const type of ["keyDown", "keyUp"]) {
    await call("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }

  const profilePoint = await waitFor(
    visiblePoint(`Array.from(document.querySelectorAll('button')).find((node) => /打开个人资料菜单|Open profile menu/i.test(node.getAttribute('aria-label') || ''))`),
    (value) => value?.ok === true,
  );
  await realMouseClick(profilePoint, "profile menu");

  if (nativeSettingsAcceptance) {
    const settingsEntryPoint = await waitFor(
      visiblePoint(`Array.from(document.querySelectorAll('[role="menuitem"],[data-radix-collection-item]')).find((node) => {
        const rect = node.getBoundingClientRect?.();
        const style = getComputedStyle(node);
        const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
        return /^(设置|Settings)(?:\\s|$)/i.test(text) && rect && rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden';
      })`),
      (value) => value?.ok === true,
    );
    await realMouseClick(settingsEntryPoint);
    result = {
      ...(await runNativeSettingsAcceptance()),
      port,
      target: { id: target.id, title: target.title, url: target.url },
      settingsEntry: settingsEntryPoint.text,
    };
  } else {
  const managerEntryExpression = `Array.from(document.querySelectorAll('[role="menuitem"],[data-radix-collection-item]')).find((node) => {
      const rect = node.getBoundingClientRect?.();
      const style = getComputedStyle(node);
      const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      return text === '管理' && rect && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })`;
  await waitFor(
    visiblePoint(managerEntryExpression),
    (value) => value?.ok === true && value.text === "管理",
  );
  await sleep(200);
  const settledManagerEntryPoint = await waitFor(
    visiblePoint(managerEntryExpression),
    (value) => value?.ok === true && value.text === "管理",
  );
  await realMouseClick(settledManagerEntryPoint, "管理");

  await waitFor(`(() => ({
    overlay: Boolean(document.querySelector('#anticodex-manager-overlay')),
    heading: String(document.querySelector('#anticodex-manager-overlay h2')?.textContent || ''),
    version: window.__ANTICODEX_MANAGER_VERSION__ || '',
  }))()`, (value) => value?.overlay === true, 5_000);

  if (promptSettingsUiOnly) {
    const promptButtonPoint = await waitFor(
      visiblePoint(`document.querySelector('#anticodex-manager-overlay button[data-anticodex-prompt-settings="true"]')`),
      (value) => value?.ok === true && value.text === "提示词",
    );
    await realMouseClick(promptButtonPoint, "提示词");
    const promptView = await waitFor(`(() => {
      const overlay = document.querySelector('#anticodex-manager-overlay');
      const text = String(overlay?.innerText || '').replace(/\\s+/g, ' ').trim();
      const buttons = Array.from(overlay?.querySelectorAll('button') || []).map((node) => String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim());
      return {
        text,
        buttons,
        textareaCount: overlay?.querySelectorAll('textarea').length || 0,
        version: window.__ANTICODEX_MANAGER_VERSION__ || '',
      };
    })()`, (value) => [
      "Codex 完整合并提示词（Gemini / Claude / 第三方）",
      "Codex 开发者提示词",
      "Codex 原生自定义指令 (AGENTS.md)",
      "Anti-Codex 附加提示词（Gemini / Claude / 第三方）",
      "模型提供方隐藏提示词",
    ].every((label) => value?.text?.includes(label))
      && ["保存", "恢复默认", "返回状态"].every((label) => value?.buttons?.includes(label))
      && value?.textareaCount === 4);

    const panelPoint = await evaluate(`(() => {
      const panel = document.querySelector('#anticodex-manager-overlay .anticodex-panel');
      const rect = panel?.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0
        ? { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { ok: false };
    })()`);
    if (!panelPoint?.ok) throw new Error("Manager prompt panel is not visible for physical scrolling.");
    if (promptSettingsRestoreDefault) {
      const promptStateBefore = await capturePromptSettingsState();
      const nativeCurrent = promptStateBefore.nativeCustomInstructions.content;
      if (promptSettingsRecoveryFileValue !== promptSettingsAcceptanceValue || nativeCurrent !== promptSettingsAcceptanceValue) {
        throw new Error("Refusing to restore unknown native custom instructions during recovery.");
      }
      const expectedRecoveredState = structuredClone(promptStateBefore);
      expectedRecoveredState.nativeCustomInstructions = { content: "", existed: false };
      await applyPromptSettingsState(expectedRecoveredState);
      await savePromptSettingsForm();
      await reopenPromptSettingsView();
      const promptStateAfterRestore = await capturePromptSettingsState();
      if (!promptSettingsStatesEqual(expectedRecoveredState, promptStateAfterRestore)) {
        throw new Error("Known prompt acceptance sentinel was not recovered without changing the other prompt layers.");
      }
      const closePoint = await waitFor(
        visiblePoint(`document.querySelector('#anticodex-manager-overlay button.anticodex-close[aria-label="关闭"]')`),
        (value) => value?.ok === true,
        5_000,
      );
      await realMouseClick(closePoint, "关闭");
      await waitFor(`(() => !document.querySelector('#anticodex-manager-overlay'))()`, (value) => value === true, 5_000);
      result = {
        ok: promptSettingsStatesEqual(expectedRecoveredState, promptStateAfterRestore),
        port,
        target: { id: target.id, title: target.title, url: target.url },
        profileEntry: settledManagerEntryPoint.text,
        promptButton: promptButtonPoint.text,
        recoveredKnownTestValue: true,
        promptStateBefore,
        promptStateAfterRestore,
        overlayClosed: true,
      };
    } else if (promptClosePosition) {
      await evaluate(`(() => {
        const panel = document.querySelector('#anticodex-manager-overlay .anticodex-panel');
        const maxScroll = Math.max(0, (panel?.scrollHeight || 0) - (panel?.clientHeight || 0));
        if (panel) panel.scrollTop = ${JSON.stringify(promptClosePosition)} === 'middle' ? Math.floor(maxScroll / 2) : (${JSON.stringify(promptClosePosition)} === 'bottom' ? maxScroll : 0);
        return panel?.scrollTop || 0;
      })()`);
      await sleep(150);
      const closeScroll = await evaluate(`(() => {
        const panel = document.querySelector('#anticodex-manager-overlay .anticodex-panel');
        return { scrollTop: panel?.scrollTop || 0, scrollHeight: panel?.scrollHeight || 0, clientHeight: panel?.clientHeight || 0 };
      })()`);
      const closePoint = await waitFor(
        visiblePoint(`document.querySelector('#anticodex-manager-overlay button.anticodex-close[aria-label="关闭"]')`),
        (value) => value?.ok === true,
      );
      await realMouseClick(closePoint);
      await waitFor(`(() => !document.querySelector('#anticodex-manager-overlay'))()`, (value) => value === true, 5_000);
      const maxScroll = Math.max(0, closeScroll.scrollHeight - closeScroll.clientHeight);
      const positionOk = promptClosePosition === "top"
        ? closeScroll.scrollTop === 0
        : promptClosePosition === "middle"
          ? closeScroll.scrollTop > 0 && closeScroll.scrollTop < maxScroll
          : closeScroll.scrollTop >= maxScroll;
      result = {
        ok: positionOk && promptView.version === "native-panel-v115" && promptView.textareaCount === 4,
        port,
        target: { id: target.id, title: target.title, url: target.url },
        profileEntry: settledManagerEntryPoint.text,
        promptButton: promptButtonPoint.text,
        promptClosePosition,
        closeScroll,
        closeLabel: closePoint.ariaLabel,
        overlayClosed: true,
      };
    } else {
    const initialScrollTop = await evaluate(`document.querySelector('#anticodex-manager-overlay .anticodex-panel')?.scrollTop || 0`);
    let middleScrollTop = initialScrollTop;
    let bottomState = await evaluate(`(() => {
      const panel = document.querySelector('#anticodex-manager-overlay .anticodex-panel');
      return { scrollTop: panel?.scrollTop || 0, scrollHeight: panel?.scrollHeight || 0, clientHeight: panel?.clientHeight || 0 };
    })()`);

    let saveRestore = null;
    if (!promptSettingsSaveRestore) {
      await realMouseWheel(panelPoint, 900);
      await sleep(150);
      middleScrollTop = await evaluate(`document.querySelector('#anticodex-manager-overlay .anticodex-panel')?.scrollTop || 0`);
      await realMouseWheel(panelPoint, 2400);
      await sleep(150);
      bottomState = await evaluate(`(() => {
        const panel = document.querySelector('#anticodex-manager-overlay .anticodex-panel');
        return { scrollTop: panel?.scrollTop || 0, scrollHeight: panel?.scrollHeight || 0, clientHeight: panel?.clientHeight || 0 };
      })()`);
    }
    if (promptSettingsSaveRestore) {
      const testValue = promptSettingsAcceptanceValue;
      const promptStateBefore = await capturePromptSettingsState();
      const promptFileSnapshots = [
        captureExactFileSnapshot(promptSettingsPolicyPath),
        captureExactFileSnapshot(promptSettingsAgentsPath),
      ];
      const expectedAfterSave = structuredClone(promptStateBefore);
      expectedAfterSave.nativeCustomInstructions = { content: testValue, existed: true };
      let promptStateAfterSave = null;
      let promptStateAfterRestore = null;
      let transactionFailure = null;
      try {
        await applyPromptSettingsState(expectedAfterSave);
        await savePromptSettingsForm();
        await reopenPromptSettingsView();
        promptStateAfterSave = await capturePromptSettingsState();
        if (!promptSettingsStatesEqual(expectedAfterSave, promptStateAfterSave)) {
          throw new Error("Prompt settings did not persist exactly during physical acceptance.");
        }
      } catch (error) {
        transactionFailure = error;
      } finally {
        try {
          const promptStateAfterUiRestore = await restorePromptSettingsState(promptStateBefore);
          if (!promptSettingsStatesSemanticallyEqual(promptStateBefore, promptStateAfterUiRestore)) {
            throw new Error("Prompt settings UI did not restore the original semantic values.");
          }
        } catch (restoreError) {
          transactionFailure = new AggregateError(
            [transactionFailure, restoreError].filter(Boolean),
            "Prompt settings acceptance failed and UI restoration was incomplete.",
          );
        }
        try {
          for (const snapshot of promptFileSnapshots) restoreExactFileSnapshot(snapshot);
          if (!promptFileSnapshots.every(exactFileSnapshotMatches)) throw new Error("Prompt settings files did not restore byte-for-byte.");
          await reopenPromptSettingsView();
          promptStateAfterRestore = await capturePromptSettingsState();
          if (!promptSettingsStatesEqual(promptStateBefore, promptStateAfterRestore)) {
            throw new Error("Prompt settings did not restore exactly after file transaction cleanup.");
          }
        } catch (restoreError) {
          transactionFailure = new AggregateError(
            [transactionFailure, restoreError].filter(Boolean),
            "Prompt settings acceptance failed and exact file restoration was incomplete.",
          );
        }
      }
      if (transactionFailure) throw transactionFailure;
      saveRestore = { testValue, promptStateBefore, promptStateAfterSave, promptStateAfterRestore };
    }

    const backPoint = await waitFor(
      visiblePoint(`Array.from(document.querySelectorAll('#anticodex-manager-overlay button')).find((node) => String(node.innerText || node.textContent || '').trim() === '返回状态')`),
      (value) => value?.ok === true,
    );
    await realMouseClick(backPoint);
    await waitFor(
      `(() => Boolean(document.querySelector('#anticodex-manager-overlay button[data-action="syncHost"]')))()`,
      (value) => value === true,
    );

    const closePoint = await waitFor(
      visiblePoint(`document.querySelector('#anticodex-manager-overlay button.anticodex-close[aria-label="关闭"]')`),
      (value) => value?.ok === true,
    );
    await realMouseClick(closePoint);
    await waitFor(`(() => !document.querySelector('#anticodex-manager-overlay'))()`, (value) => value === true, 5_000);
    result = {
      ok: (promptSettingsSaveRestore || (middleScrollTop > initialScrollTop
        && bottomState.scrollTop >= middleScrollTop
        )) && promptView.version === "native-panel-v115" && promptView.textareaCount === 4,
      port,
      target: { id: target.id, title: target.title, url: target.url },
      profileEntry: settledManagerEntryPoint.text,
      promptButton: promptButtonPoint.text,
      promptView,
      scroll: { initialScrollTop, middleScrollTop, bottomState },
      saveRestore,
      returnedToStatus: true,
      overlayClosed: true,
    };
    }
  } else {
  await evaluate(`(() => {
    const button = document.querySelector('#anticodex-manager-overlay button[data-action="syncHost"]');
    button?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(button);
  })()`);
  await sleep(150);

  const firstActionPoint = await waitFor(
    visiblePoint(`document.querySelector('#anticodex-manager-overlay button[data-action="syncHost"]')`),
    (value) => value?.ok === true && value.text === "一键更新",
  );
  await realMouseClick(firstActionPoint);

  const confirmation = await waitFor(`(() => {
    const button = document.querySelector('#anticodex-manager-overlay button[data-action="syncHost"]');
    return {
      armed: button?.getAttribute('data-confirming-high-impact') === 'true',
      text: String(button?.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
  })()`, (value) => value?.armed === true, 5_000);

  const secondActionPoint = await waitFor(
    visiblePoint(`document.querySelector('#anticodex-manager-overlay button[data-action="syncHost"]')`),
    (value) => value?.ok === true,
    5_000,
  );
  const dispatchBaseline = await evaluate(`(() => ({
    currentActionToken: window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ || '',
    lastAction: window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__?.action || '',
    queueLength: (window.__ANTICODEX_MANAGER_ACTION_QUEUE__ || []).length,
  }))()`);
  await realMouseClick(secondActionPoint);

  const accepted = await waitFor(`(() => {
      const overlay = document.querySelector('#anticodex-manager-overlay');
      const resultNode = overlay?.querySelector('[data-anticodex-result="action"]');
      const last = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ || null;
      const currentActionToken = window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ || '';
      const queueEntry = (window.__ANTICODEX_MANAGER_ACTION_QUEUE__ || []).find((entry) => entry?.action === 'syncHost' && entry?.actionToken === currentActionToken);
      const queued = Boolean(queueEntry);
      const leased = Number(queueEntry?.leaseCount || 0) > 0;
      const completed = last?.action === 'syncHost' && last?.actionToken === currentActionToken;
      const running = resultNode?.getAttribute('data-anticodex-running') || '';
      const tokenChanged = Boolean(currentActionToken) && currentActionToken !== ${JSON.stringify(dispatchBaseline.currentActionToken)};
      return {
        accepted: tokenChanged && (leased || completed),
        tokenChanged,
        queued,
        leased,
        completed,
        running,
        lastAction: last?.action || '',
        text: String(resultNode?.textContent || last?.managerSummary || '').replace(/\\s+/g, ' ').trim(),
      };
    })()`, (value) => value?.accepted === true, Math.min(timeoutMs, 35_000));

  result = {
    ok: accepted.accepted === true,
    port,
    target: { id: target.id, title: target.title, url: target.url },
    profileEntry: settledManagerEntryPoint.text,
    action,
    actionLabel: firstActionPoint.text,
    confirmation,
    dispatchBaseline,
    secondClickDispatched: true,
    accepted,
  };
  }
  }
} finally {
  if (!closed && promptSettingsUiOnly) {
    try {
      const cleanupPoint = await evaluate(visiblePoint(`document.querySelector('#anticodex-manager-overlay button.anticodex-close[aria-label="关闭"]')`));
      if (cleanupPoint?.ok) await realMouseClick(cleanupPoint);
    } catch {}
  }
  if (!closed && nativeSettingsAcceptance) {
    try {
      const cleanupPoint = await evaluate(visiblePoint(`(${nativeSettingsNavExpression})?.querySelector('[role="link"]')`));
      if (cleanupPoint?.ok) await realMouseClick(cleanupPoint);
    } catch {}
  }
  if (!closed) socket.close();
}

console.log(JSON.stringify(result));
if (!result?.ok) process.exitCode = 1;
