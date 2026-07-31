#!/usr/bin/env node

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
const timeoutMs = Number(args.get("--timeout-ms") || 15_000);

if (action !== "syncHost") throw new Error(`Only the built-in syncHost action is allowed, received: ${action}`);
if (!confirmed && !inspectOnly) throw new Error("Refusing to arm the high-impact Manager action without --confirm true.");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid CDP port: ${port}`);

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

async function realMouseClick(point) {
  for (const event of [
    { type: "mouseMoved", button: "none", buttons: 0 },
    { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
    { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
  ]) {
    await call("Input.dispatchMouseEvent", { ...event, x: point.x, y: point.y, pointerType: "mouse" }, 12_000);
  }
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
    tag: node.tagName || '',
  };
})()`;

let result;
try {
  await call("Runtime.enable");
  if (inspectOnly) {
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
    visiblePoint(`Array.from(document.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === '打开个人资料菜单')`),
    (value) => value?.ok === true,
  );
  await realMouseClick(profilePoint);

  const managerEntryPoint = await waitFor(
    visiblePoint(`Array.from(document.querySelectorAll('[role="menuitem"],[data-radix-collection-item]')).find((node) => {
      const rect = node.getBoundingClientRect?.();
      const style = getComputedStyle(node);
      const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      return text === '管理' && rect && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })`),
    (value) => value?.ok === true && value.text === "管理",
  );
  await realMouseClick(managerEntryPoint);

  await waitFor(`(() => ({
    overlay: Boolean(document.querySelector('#anticodex-manager-overlay')),
    heading: String(document.querySelector('#anticodex-manager-overlay h2')?.textContent || ''),
    version: window.__ANTICODEX_MANAGER_VERSION__ || '',
  }))()`, (value) => value?.overlay === true);

  await evaluate(`(() => {
    const button = document.querySelector('#anticodex-manager-overlay button[data-action="syncHost"]');
    button?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(button);
  })()`);
  await sleep(150);

  const firstActionPoint = await waitFor(
    visiblePoint(`document.querySelector('#anticodex-manager-overlay button[data-action="syncHost"]')`),
    (value) => value?.ok === true && value.text === "同步 Codex 更新",
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

  let accepted = { accepted: false };
  try {
    accepted = await waitFor(`(() => {
      const overlay = document.querySelector('#anticodex-manager-overlay');
      const resultNode = overlay?.querySelector('[data-anticodex-result="action"]');
      const last = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ || null;
      const currentActionToken = window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ || '';
      const queued = (window.__ANTICODEX_MANAGER_ACTION_QUEUE__ || []).some((entry) => entry?.action === 'syncHost');
      const running = resultNode?.getAttribute('data-anticodex-running') || '';
      const tokenChanged = Boolean(currentActionToken) && currentActionToken !== ${JSON.stringify(dispatchBaseline.currentActionToken)};
      return {
        accepted: tokenChanged && (queued || running === 'syncHost' || last?.action === 'syncHost'),
        tokenChanged,
        queued,
        running,
        lastAction: last?.action || '',
        text: String(resultNode?.textContent || last?.managerSummary || '').replace(/\\s+/g, ' ').trim(),
      };
    })()`, (value) => value?.accepted === true, 5_000);
  } catch (error) {
    if (!closed) throw error;
    accepted = { accepted: true, connectionClosedAfterDispatch: true };
  }

  result = {
    ok: accepted.accepted === true,
    port,
    target: { id: target.id, title: target.title, url: target.url },
    profileEntry: managerEntryPoint.text,
    action,
    actionLabel: firstActionPoint.text,
    confirmation,
    dispatchBaseline,
    secondClickDispatched: true,
    accepted,
  };
} finally {
  if (!closed) socket.close();
}

console.log(JSON.stringify(result));
if (!result?.ok) process.exitCode = 1;
