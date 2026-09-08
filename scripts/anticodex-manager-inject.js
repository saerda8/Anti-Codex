(() => {
  const VERSION = "native-panel-v118";
  const SUMMARY_VERSION = "latest-reports-evidence-v5";
  const MANAGER_ID = "anticodex-manager-overlay";
  const LEGACY_BUTTON_ID = "anticodex-manager-button";
  const TRAFFIC_NOTICE_ID = "anticodex-traffic-notice";
  const NATIVE_COMPAT_STYLE_ID = "anticodex-native-compat-style";
  const nativeCompatStyle = document.getElementById(NATIVE_COMPAT_STYLE_ID) || document.createElement("style");
  nativeCompatStyle.id = NATIVE_COMPAT_STYLE_ID;
  nativeCompatStyle.textContent = `[data-radix-popper-content-wrapper]:has(> [data-radix-menu-content][data-state="closed"]){pointer-events:none!important}`;
  if (!nativeCompatStyle.isConnected) (document.head || document.documentElement).append(nativeCompatStyle);
  if (
    window.__ANTICODEX_MANAGER_VERSION__ === VERSION &&
    window.__ANTICODEX_MANAGER_SUMMARY_VERSION__ === SUMMARY_VERSION &&
    typeof window.__ANTICODEX_OPEN_MANAGER__ === "function"
  ) return;
  invalidateManagerActionToken("reinject");
  window.__ANTICODEX_MANAGER_THEME_OBSERVER__?.disconnect?.();
  const previousThemeMedia = window.__ANTICODEX_MANAGER_THEME_MEDIA__;
  const previousThemeMediaListener = window.__ANTICODEX_MANAGER_THEME_MEDIA_LISTENER__;
  if (typeof previousThemeMedia?.removeEventListener === "function") previousThemeMedia.removeEventListener("change", previousThemeMediaListener);
  else previousThemeMedia?.removeListener?.(previousThemeMediaListener);
  delete window.__ANTICODEX_MANAGER_THEME_OBSERVER__;
  delete window.__ANTICODEX_MANAGER_THEME_MEDIA__;
  delete window.__ANTICODEX_MANAGER_THEME_MEDIA_LISTENER__;
  document.getElementById(MANAGER_ID)?.remove();
  document.getElementById(LEGACY_BUTTON_ID)?.remove();
  if (window.__ANTICODEX_MANAGER_BADGE_TIMER__) {
    clearInterval(window.__ANTICODEX_MANAGER_BADGE_TIMER__);
    delete window.__ANTICODEX_MANAGER_BADGE_TIMER__;
  }
  if (window.__ANTICODEX_MANAGER_STATUS_TIMER__) {
    clearInterval(window.__ANTICODEX_MANAGER_STATUS_TIMER__);
    delete window.__ANTICODEX_MANAGER_STATUS_TIMER__;
  }
  window.__ANTICODEX_MANAGER_VERSION__ = VERSION;
  window.__ANTICODEX_MANAGER_SUMMARY_VERSION__ = SUMMARY_VERSION;
  window.__ANTICODEX_MANAGER_INSTALLED__ = true;

  const DEFAULT_API = "http://127.0.0.1:8484";
  let activeApi = String(window.__ANTICODEX_MANAGER_API__ || DEFAULT_API).replace(/\/$/, "");
  let managerToken = "";
  const MANAGER_LABEL = "Anti-Codex \u7ba1\u7406";
  const CLOSE_TEXT = "\u5173\u95ed";
  const ACTIONS = [
    ["refreshStatus", "\u5237\u65b0\u72b6\u6001"],
    ["refreshModels", "\u5237\u65b0\u6a21\u578b"],
    ["accountSwitch", "\u5207\u6362 Antigravity \u8d26\u53f7"],
    ["upstreamConfig", "\u914d\u7f6e\u7b2c\u4e09\u65b9 API"],
    ["updateCheck", "\u68c0\u67e5\u5168\u90e8\u66f4\u65b0"],
    ["syncHost", "\u4e00\u952e\u66f4\u65b0"],
    ["repairShortcuts", "\u4fee\u590d\u5feb\u6377\u65b9\u5f0f"],
    ["diagnosticsBundle", "\u751f\u6210\u8bca\u65ad\u5305"],
    ["viewLatestReports", "\u67e5\u770b\u6700\u65b0\u62a5\u544a"],
    ["accountProxy", "\u8d26\u53f7/\u4ee3\u7406\u68c0\u67e5"],
    ["syncReadiness", "\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5"],
    ["sourcePreflight", "\u8fd0\u884c\u6e90\u7801\u9884\u68c0"],
    ["mcpSkills", "\u68c0\u67e5 MCP/Skill"],
    ["pluginCapabilities", "\u68c0\u67e5\u63d2\u4ef6/\u5e94\u7528"],
    ["refreshFeatures", "\u5237\u65b0\u672c\u5730\u529f\u80fd"],
    ["fastOverallNoTraffic", "\u5feb\u901f\u68c0\u67e5\uff08\u4e0d\u8017\u6d41\u91cf\uff09"],
    ["overallNoTraffic", "\u6574\u4f53\u68c0\u67e5\uff08\u4e0d\u8017\u6d41\u91cf\uff09"],
    ["stabilitySoak", "\u7a33\u5b9a\u6027\u5de1\u68c0\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09"],
    ["coldRelaunch", "\u51b7\u542f\u52a8\u9a8c\u8bc1\uff08\u91cd\u542f Anti-Codex\uff09"],
    ["postVerificationFull", "\u9a8c\u8bc1\u540e\u5b8c\u6574\u68c0\u67e5\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09"],
  ];
  const MANAGER_ACTION_GROUPS = Object.freeze({
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
  const HIGH_IMPACT_ACTION_IDS = new Set([
    "syncHost",
    "refreshFeatures",
    "stabilitySoak",
    "coldRelaunch",
    "fastOverallNoTraffic",
    "overallNoTraffic",
    "postVerificationFull",
  ]);
  const MANAGER_BACKGROUND_START_ACTION_IDS = new Set([
    "syncHost",
    "refreshFeatures",
    "stabilitySoak",
    "coldRelaunch",
    "postVerificationFull",
  ]);
  const BRIDGE_TIMEOUT_MS = 5000;
  const MANAGER_BRIDGE_PICKUP_TIMEOUT_MS = 2000;
  const MANAGER_BRIDGE_BACKLOG_GRACE_MS = 30000;
  const MANAGER_BRIDGE_PICKUP_POLL_MS = 50;
  const MANAGER_ACTION_TRANSPORT_TIMEOUT_MS = 340000;
  const MANAGER_PENDING_TRANSPORT_GRACE_MS = 120000;
  const MANAGER_PENDING_REPORT_GRACE_MS = 30000;
  const MANAGER_PENDING_STORAGE_KEY = "anticodex.manager.pending-actions.v1";
  const MCP_SKILLS_ACTION_UI_TIMEOUT_MS = 440000;
  const HIGH_IMPACT_CONFIRMATION_MS = 15000;
  const LOAD_FETCH_TIMEOUT_MS = 2500;
  const DIAGNOSTICS_FETCH_TIMEOUT_MS = 30000;
  const UPSTREAM_TEST_TIMEOUT_MS = 60000;
  const LOAD_SNAPSHOT_TIMEOUT_MS = 30000;
  const ACCOUNT_SWITCH_POLL_INTERVAL_MS = 3000;
  const ACCOUNT_SWITCH_TIMEOUT_MS = 120000;
  let accountSwitchObservationGeneration = 0;
  let accountSwitchObservationCancel = null;
  let managerThemeObserver = null;
  let managerThemeMedia = null;
  let managerThemeMediaListener = null;
  let managerThemeTimer = 0;
  let pendingHighImpactAction = "";
  let pendingHighImpactUntil = 0;
  let pendingHighImpactButton = null;

  function invalidateManagerActionToken(reason) {
    window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ = `invalidated:${reason}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  function cancelAccountSwitchObservation() {
    accountSwitchObservationGeneration += 1;
    const cancel = accountSwitchObservationCancel;
    accountSwitchObservationCancel = null;
    cancel?.();
  }

  function removeManager() {
    invalidateManagerActionToken("closed");
    cancelAccountSwitchObservation();
    managerThemeObserver?.disconnect();
    managerThemeObserver = null;
    if (managerThemeMedia && managerThemeMediaListener) {
      if (typeof managerThemeMedia.removeEventListener === "function") managerThemeMedia.removeEventListener("change", managerThemeMediaListener);
      else managerThemeMedia.removeListener?.(managerThemeMediaListener);
    }
    managerThemeMedia = null;
    managerThemeMediaListener = null;
    if (managerThemeTimer) clearTimeout(managerThemeTimer);
    managerThemeTimer = 0;
    if (window.__ANTICODEX_MANAGER_STATUS_TIMER__) {
      clearInterval(window.__ANTICODEX_MANAGER_STATUS_TIMER__);
      delete window.__ANTICODEX_MANAGER_STATUS_TIMER__;
    }
    if (window.__ANTICODEX_MANAGER_ACCOUNTS_TIMER__) {
      clearInterval(window.__ANTICODEX_MANAGER_ACCOUNTS_TIMER__);
      delete window.__ANTICODEX_MANAGER_ACCOUNTS_TIMER__;
    }
    document.getElementById(MANAGER_ID)?.remove();
  }

  function resetHighImpactConfirmation() {
    if (pendingHighImpactButton?.isConnected) {
      pendingHighImpactButton.textContent = pendingHighImpactButton.getAttribute("data-original-label") || pendingHighImpactButton.textContent;
      pendingHighImpactButton.removeAttribute("data-confirming-high-impact");
    }
    pendingHighImpactAction = "";
    pendingHighImpactUntil = 0;
    pendingHighImpactButton = null;
  }

  function requireHighImpactConfirmation(action, label, button) {
    if (!HIGH_IMPACT_ACTION_IDS.has(action)) {
      resetHighImpactConfirmation();
      return false;
    }
    const result = document.querySelector(`#${MANAGER_ID} [data-anticodex-result="action"]`);
    if (!result) {
      resetHighImpactConfirmation();
      return true;
    }
    const now = Date.now();
    if (pendingHighImpactAction === action && now <= pendingHighImpactUntil) {
      resetHighImpactConfirmation();
      return false;
    }
    resetHighImpactConfirmation();
    pendingHighImpactAction = action;
    pendingHighImpactUntil = now + HIGH_IMPACT_CONFIRMATION_MS;
    pendingHighImpactButton = button;
    button.setAttribute("data-original-label", label);
    button.setAttribute("data-confirming-high-impact", "true");
    button.textContent = "\u786e\u8ba4\uff1a" + label;
    result.classList.remove("anticodex-error");
    result.removeAttribute("data-anticodex-running");
    result.textContent = `${label}\uff1a\u8bf7\u518d\u70b9\u4e00\u6b21\u786e\u8ba4\u6267\u884c\u3002\n\u8fd9\u662f\u9ad8\u5f71\u54cd\u64cd\u4f5c\uff0c\u53ef\u80fd\u5199\u5165\u914d\u7f6e\u3001\u91cd\u542f\u6216\u8fd0\u884c\u8f83\u957f\u65f6\u95f4\u3002`;
    setTimeout(() => {
      if (pendingHighImpactAction === action && Date.now() > pendingHighImpactUntil) resetHighImpactConfirmation();
    }, HIGH_IMPACT_CONFIRMATION_MS + 250);
    return true;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "style") node.style.cssText = value;
      else if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "value") node.value = value ?? "";
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function closestEventElement(event, selector) {
    const target = event?.target;
    const direct = target?.closest?.(selector);
    if (direct) return direct;
    const parent = target?.parentElement || (target?.parentNode?.nodeType === 1 ? target.parentNode : null);
    const fromParent = parent?.closest?.(selector);
    if (fromParent) return fromParent;
    for (const item of event?.composedPath?.() || []) {
      if (item?.matches?.(selector)) return item;
      const found = item?.closest?.(selector);
      if (found) return found;
    }
    return null;
  }

  function eventPointInsideElement(event, element) {
    if (!event || !element?.getBoundingClientRect) return false;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function closestEventElementOrPoint(event, selector, scope = document) {
    const direct = closestEventElement(event, selector);
    if (direct) return direct;
    for (const item of scope?.querySelectorAll?.(selector) || []) {
      if (eventPointInsideElement(event, item)) return item;
    }
    return null;
  }

  function colorTheme(color) {
    const channels = String(color || "").match(/[\d.]+/g)?.map(Number) || [];
    if (channels.length < 3 || (channels.length >= 4 && channels[3] <= 0.05)) return "";
    const [red, green, blue] = channels;
    const luminance = ((red * 299) + (green * 587) + (blue * 114)) / 1000;
    return luminance >= 150 ? "light" : "dark";
  }

  function explicitTheme(node) {
    if (!node || node.closest?.(`#${MANAGER_ID}`)) return "";
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
  }

  function detectHostTheme() {
    const signalNodes = [
      document.documentElement,
      document.body,
      document.querySelector("#root, #__next, [data-reactroot]"),
      ...document.querySelectorAll('[data-theme],[data-color-theme],[data-mode],[data-color-mode]'),
    ];
    for (const node of signalNodes) {
      const theme = explicitTheme(node);
      if (theme) return theme;
    }
    for (const node of [document.documentElement, document.body, document.querySelector("#root, #__next, [data-reactroot]")]) {
      if (!node) continue;
      const scheme = String(getComputedStyle(node).colorScheme || "").toLowerCase();
      if (scheme === "light" || scheme === "dark") return scheme;
      const theme = colorTheme(getComputedStyle(node).backgroundColor);
      if (theme) return theme;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  }

  function syncManagerTheme(root = document.getElementById(MANAGER_ID)) {
    if (!root) return "";
    const theme = detectHostTheme();
    root.setAttribute("data-anticodex-theme", theme);
    return theme;
  }

  function installManagerThemeSync(root) {
    const schedule = () => {
      if (managerThemeTimer) return;
      managerThemeTimer = setTimeout(() => {
        managerThemeTimer = 0;
        syncManagerTheme(root);
      }, 0);
    };
    syncManagerTheme(root);
    managerThemeObserver?.disconnect();
    managerThemeObserver = new MutationObserver(() => schedule());
    const hostThemeNodes = [
      document.documentElement,
      document.body,
      document.querySelector("#root, #__next, [data-reactroot]"),
      document.querySelector('[data-theme],[data-color-theme],[data-mode],[data-color-mode]'),
    ];
    for (const node of new Set(hostThemeNodes.filter(Boolean))) {
      if (node.closest?.(`#${MANAGER_ID}`)) continue;
      managerThemeObserver.observe(node, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme", "data-color-theme", "data-mode", "data-color-mode"],
      });
    }
    managerThemeMedia = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
    managerThemeMediaListener = schedule;
    if (typeof managerThemeMedia?.addEventListener === "function") managerThemeMedia.addEventListener("change", schedule);
    else managerThemeMedia?.addListener?.(schedule);
    window.__ANTICODEX_MANAGER_THEME_OBSERVER__ = managerThemeObserver;
    window.__ANTICODEX_MANAGER_THEME_MEDIA__ = managerThemeMedia;
    window.__ANTICODEX_MANAGER_THEME_MEDIA_LISTENER__ = managerThemeMediaListener;
  }

  function apiCandidates() {
    const snapshotBaseUrl = window.__ANTICODEX_MANAGER_SNAPSHOT__?.baseUrl;
    return [...new Set([
      activeApi,
      window.__ANTICODEX_MANAGER_API__,
      ...(Array.isArray(window.__ANTICODEX_MANAGER_API_CANDIDATES__) ? window.__ANTICODEX_MANAGER_API_CANDIDATES__ : []),
      DEFAULT_API,
      snapshotBaseUrl,
    ].filter(Boolean).map((value) => String(value).replace(/\/$/, "")))];
  }

  function actionApiCandidates() {
    const snapshotBaseUrl = window.__ANTICODEX_MANAGER_SNAPSHOT__?.ok ? window.__ANTICODEX_MANAGER_SNAPSHOT__?.baseUrl : "";
    return [...new Set([
      activeApi,
      window.__ANTICODEX_MANAGER_API__,
      DEFAULT_API,
      snapshotBaseUrl,
    ].filter(Boolean).map((value) => String(value).replace(/\/$/, "")))];
  }

  function browserReachableApiBase(value, fallback = DEFAULT_API) {
    const candidate = String(value || "").replace(/\/$/, "");
    if (!candidate) return String(fallback || DEFAULT_API).replace(/\/$/, "");
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (host === "127.0.0.1" || host === "localhost" || host === "::1") return candidate;
    } catch {}
    return String(fallback || window.__ANTICODEX_MANAGER_API__ || DEFAULT_API).replace(/\/$/, "");
  }

  async function getJsonFrom(baseUrl, path, options = {}) {
    const {
      timeoutMs = LOAD_FETCH_TIMEOUT_MS,
      retryCandidates: _retryCandidates,
      ...fetchOptions
    } = options;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(baseUrl + path, { cache: "no-store", ...fetchOptions, signal: controller?.signal });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error = new Error(json?.error?.message || text || `HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return json;
  }

  function snapshotResponse(path) {
    return window.__ANTICODEX_MANAGER_SNAPSHOT__?.responses?.[path] || null;
  }

  function hasCompleteManagerSnapshot(snapshot = window.__ANTICODEX_MANAGER_SNAPSHOT__) {
    const responses = snapshot?.responses || {};
    const diagnostics = responses["/anticodex/diagnostics"] || {};
    const localFeatures = diagnostics.localFeatures || {};
    return Boolean(
      responses["/health"] && responses["/models"] && responses["/anticodex/diagnostics"]
      && responses["/anticodex/upstream-profile"]
      && responses["/anticodex/model-routes"]
      && responses["/anticodex/local-connectors/allowlist"]
      && responses["/backend-api/ps/plugins/installed"] && responses["/backend-api/aip/connectors"]
      && responses["/backend-api/plugins/list"] && responses["/backend-api/wham/apps"]
      && Number(localFeatures.mcp?.count) > 0
      && Number(localFeatures.skills?.count) > 0
    );
  }

  function managerBridgeStaleError() {
    const error = new Error("Anti-Codex manager bridge is not receiving requests.");
    error.code = "ANTICODEX_MANAGER_BRIDGE_STALE";
    return error;
  }

  function isManagerBridgeStaleError(error) {
    return error?.code === "ANTICODEX_MANAGER_BRIDGE_STALE";
  }

  function invokeManagerBridgeWithPickup(invoke, onQueued = null) {
    const queueBefore = Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__)
      ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__
      : [];
    const existingIds = new Set(queueBefore.map((request) => String(request?.id || "")).filter(Boolean));
    const payloadPromise = invoke();
    const queuedRequest = (Array.isArray(window.__ANTICODEX_MANAGER_ACTION_QUEUE__)
      ? window.__ANTICODEX_MANAGER_ACTION_QUEUE__
      : []).find((request) => request?.id && !existingIds.has(String(request.id)));
    if (!queuedRequest?.id) return payloadPromise;

    return (async () => {
      const requestId = String(queuedRequest.id);
      if (typeof onQueued === "function") onQueued(requestId);
      const startedAt = Date.now();
      const backlogDeadline = startedAt + MANAGER_BRIDGE_BACKLOG_GRACE_MS;
      let pickupDeadline = startedAt + MANAGER_BRIDGE_PICKUP_TIMEOUT_MS;
      let leasedBacklogActive = false;
      while (Date.now() < backlogDeadline) {
        const queue = window.__ANTICODEX_MANAGER_ACTION_QUEUE__ || [];
        const current = queue
          .find((request) => String(request?.id || "") === requestId);
        if (!current || Number(current.leaseCount || 0) > 0) return payloadPromise;
        const hasLeasedBacklog = queue.some(
          (request) => String(request?.id || "") !== requestId && Number(request?.leaseCount || 0) > 0,
        );
        if (hasLeasedBacklog) {
          leasedBacklogActive = true;
          pickupDeadline = backlogDeadline;
        } else if (leasedBacklogActive) {
          leasedBacklogActive = false;
          pickupDeadline = Math.min(backlogDeadline, Date.now() + MANAGER_BRIDGE_PICKUP_TIMEOUT_MS);
        }
        if (Date.now() >= pickupDeadline) break;
        await wait(MANAGER_BRIDGE_PICKUP_POLL_MS);
      }

      const current = (window.__ANTICODEX_MANAGER_ACTION_QUEUE__ || [])
        .find((request) => String(request?.id || "") === requestId);
      if (!current || Number(current.leaseCount || 0) > 0) return payloadPromise;
      window.__ANTICODEX_MANAGER_ACTION_QUEUE__ = (window.__ANTICODEX_MANAGER_ACTION_QUEUE__ || [])
        .filter((request) => String(request?.id || "") !== requestId);
      if (window.__ANTICODEX_MANAGER_ACTION_PROMISES__) {
        delete window.__ANTICODEX_MANAGER_ACTION_PROMISES__[requestId];
      }
      void Promise.resolve(payloadPromise).catch(() => {});
      throw managerBridgeStaleError();
    })();
  }

  async function getJson(path, options = {}) {
    const snapshotFallback = snapshotResponse(path);
    const allowSnapshotFallback = options.allowSnapshotFallback !== false
      && (!options.method || String(options.method).toUpperCase() === "GET");
    if (options.preferSnapshot === true && allowSnapshotFallback && snapshotFallback) return snapshotFallback;
    let lastError = null;
    const method = String(options.method || "GET").toUpperCase();
    if (location.protocol === "app:" && method === "GET" && typeof window.__ANTICODEX_RUN_MANAGER_REQUEST__ === "function") {
      try {
        const json = await managerRequestViaBridge(path, { method, timeoutMs: options.timeoutMs });
        activeApi = browserReachableApiBase(json?.baseUrl || activeApi, activeApi);
        return json;
      } catch (error) {
        lastError = error;
        if (allowSnapshotFallback && snapshotFallback) return snapshotFallback;
      }
    }
    const candidates = options.retryCandidates === false
      ? [activeApi || window.__ANTICODEX_MANAGER_API__ || DEFAULT_API]
      : apiCandidates();
    for (const baseUrl of candidates) {
      try {
        const json = await getJsonFrom(baseUrl, path, options);
        activeApi = browserReachableApiBase(json?.baseUrl || baseUrl, baseUrl);
        return json;
      } catch (error) {
        lastError = error;
      }
    }
    if (allowSnapshotFallback && snapshotFallback) return snapshotFallback;
    throw lastError || new Error("Anti-Codex local gateway is unavailable.");
  }

  async function managerRequestViaBridge(path, options = {}) {
    if (typeof window.__ANTICODEX_RUN_MANAGER_REQUEST__ !== "function") {
      throw new Error("Anti-Codex manager request bridge is unavailable.");
    }
    const timeoutMs = Math.min(181000, Math.max(1000, Number(options.timeoutMs) || LOAD_SNAPSHOT_TIMEOUT_MS));
    let timeout = null;
    let payload;
    try {
      payload = await Promise.race([
        invokeManagerBridgeWithPickup(() => window.__ANTICODEX_RUN_MANAGER_REQUEST__(path, {
          method: String(options.method || "GET").toUpperCase(),
          timeoutMs,
          ...(options.body === undefined ? {} : { body: options.body }),
        })),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve({ __timedOut: true }), timeoutMs + 1000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (payload?.__timedOut) throw new Error("Anti-Codex manager request bridge timed out.");
    if (payload?.kind !== "manager-request" || payload?.path !== path) {
      throw new Error("Anti-Codex manager request bridge returned a mismatched response.");
    }
    if (payload.ok === false) throw new Error(payload.message || "Anti-Codex manager request failed.");
    return payload.value;
  }

  async function managerGetLiveJson(path, options = {}) {
    if (typeof window.__ANTICODEX_RUN_MANAGER_REQUEST__ === "function") {
      try {
        return await managerRequestViaBridge(path, { ...options, method: "GET" });
      } catch (error) {
        if (location.protocol === "app:" && !isManagerBridgeStaleError(error)) throw error;
      }
    }
    return getJsonFrom(activeApi, path, options);
  }

  async function safeJson(path, options = {}) {
    try {
      return { ok: true, value: await getJson(path, options) };
    } catch (error) {
      return { ok: false, value: null, error };
    }
  }

  function safeValue(result, fallback = null) {
    return result?.ok ? result.value : fallback;
  }

  async function refreshManagerToken() {
    const bootstrap = await getJson("/anticodex/manager/bootstrap", { allowSnapshotFallback: false });
    managerToken = bootstrap?.token || "";
    if (!managerToken) throw new Error("Anti-Codex manager bootstrap did not return an action token.");
    return managerToken;
  }

  async function managerPostJson(path, body, options = {}) {
    if (typeof window.__ANTICODEX_RUN_MANAGER_REQUEST__ === "function") {
      try {
        return await managerRequestViaBridge(path, {
          method: "POST",
          timeoutMs: options.timeoutMs,
          body,
        });
      } catch (error) {
        if (location.protocol === "app:" && !isManagerBridgeStaleError(error)) throw error;
      }
    }
    if (!managerToken) await refreshManagerToken();
    const postOnce = () => getJson(path, {
      ...options,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
        "x-anticodex-manager-token": managerToken,
      },
      body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
      allowSnapshotFallback: false,
    });
    try {
      return await postOnce();
    } catch (error) {
      if (error?.statusCode !== 403) throw error;
      await refreshManagerToken();
      return await postOnce();
    }
  }

  function modelCatalogFingerprint(payload) {
    return (Array.isArray(payload?.data) ? payload.data : [])
      .map((model) => String(model?.id || "").trim())
      .filter(Boolean)
      .sort()
      .join("\n");
  }

  async function captureAccountSwitchState() {
    const [accountResult, modelsResult] = await Promise.all([
      safeJson("/anticodex/account"),
      safeJson("/models"),
    ]);
    const account = safeValue(accountResult, {});
    const models = safeValue(modelsResult, { data: [] });
    return {
      accountFingerprint: account?.identityAvailable ? String(account?.fingerprint || "") : "",
      modelFingerprint: modelCatalogFingerprint(models),
    };
  }

  function accountSwitchChanged(before, after) {
    if (before?.accountFingerprint && after?.accountFingerprint && before.accountFingerprint !== after.accountFingerprint) {
      return { changed: true, reason: "account_fingerprint" };
    }
    if (before?.modelFingerprint && after?.modelFingerprint && before.modelFingerprint !== after.modelFingerprint) {
      return { changed: true, reason: "model_catalog" };
    }
    return { changed: false, reason: "" };
  }

  async function waitForAccountSwitch(baseline) {
    cancelAccountSwitchObservation();
    const observationGeneration = accountSwitchObservationGeneration;
    let resolveCancellation;
    const cancellation = new Promise((resolve) => {
      resolveCancellation = () => resolve(true);
    });
    accountSwitchObservationCancel = resolveCancellation;
    const deadline = Date.now() + ACCOUNT_SWITCH_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const cancelled = await Promise.race([
          wait(ACCOUNT_SWITCH_POLL_INTERVAL_MS).then(() => false),
          cancellation,
        ]);
        if (cancelled || observationGeneration !== accountSwitchObservationGeneration) {
          return { changed: false, reason: "cancelled" };
        }
        const current = await captureAccountSwitchState();
        if (observationGeneration !== accountSwitchObservationGeneration) {
          return { changed: false, reason: "cancelled" };
        }
        const change = accountSwitchChanged(baseline, current);
        if (change.changed) return { ...change, current };
      }
      return { changed: false, reason: "timeout" };
    } finally {
      if (accountSwitchObservationCancel === resolveCancellation) {
        accountSwitchObservationCancel = null;
      }
    }
  }

  async function refreshManagerSnapshot() {
    if (typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ !== "function") return window.__ANTICODEX_MANAGER_SNAPSHOT__ || null;
    if (window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__) return window.__ANTICODEX_MANAGER_SNAPSHOT__ || null;
    if (window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__) {
      const deadline = Date.now() + LOAD_SNAPSHOT_TIMEOUT_MS;
      while (window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__ && Date.now() < deadline) {
        await wait(100);
      }
      return window.__ANTICODEX_MANAGER_SNAPSHOT__ || null;
    }
    window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__ = true;
    const actionToken = String(window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ || "");
    const previousSuppressRefreshStatus = window.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ === true;
    window.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ = true;
    try {
      const payload = await Promise.race([
        runActionViaBridge("refreshStatus", actionToken),
        new Promise((resolve) => setTimeout(() => resolve(null), LOAD_SNAPSHOT_TIMEOUT_MS)),
      ]);
      if (!payload && window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken) {
        invalidateManagerActionToken("snapshot-timeout");
      }
      if (
        payload?.snapshot
        && !window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__
        && window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken
      ) {
        window.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
        reconcileManagerPendingActions(payload.snapshot);
      }
      return window.__ANTICODEX_MANAGER_SNAPSHOT__ || null;
    } catch {
      return window.__ANTICODEX_MANAGER_SNAPSHOT__ || null;
    } finally {
      window.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ = previousSuppressRefreshStatus;
      window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__ = false;
    }
  }

  async function ensureSnapshotForLoad() {
    const snapshot = window.__ANTICODEX_MANAGER_SNAPSHOT__;
    if (hasCompleteManagerSnapshot(snapshot)) return;
    await refreshManagerSnapshot();
  }

  async function runActionViaBridge(action, actionToken = "") {
    if (typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ === "function") {
      try {
        let payload;
        let bridgeRequestId = "";
        const bridgeTimeoutMs = actionTransportTimeoutMs(action);
        const winner = await Promise.race([
          invokeManagerBridgeWithPickup(
            () => window.__ANTICODEX_RUN_MANAGER_ACTION__(action, actionToken),
            (requestId) => { bridgeRequestId = requestId; },
          ).then(p => { payload = p; return "bridge"; }),
          new Promise(resolve => setTimeout(() => resolve("timeout"), bridgeTimeoutMs)),
        ]);
        if (winner === "bridge") {
          if (payload?.action && payload.action !== action) throw new Error(`Manager bridge returned ${payload.action} for ${action}.`);
          if (actionToken && window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken) {
            activeApi = browserReachableApiBase(payload?.snapshot?.baseUrl || activeApi, activeApi);
            if (payload?.snapshot) {
              window.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
              reconcileManagerPendingActions(payload.snapshot);
            }
          }
          if (payload?.ok !== false || (payload?.result && typeof payload.result === "object")) return payload;
          throw new Error(payload.message || "Anti-Codex manager action failed.");
        }
        window.__ANTICODEX_ABANDON_MANAGER_ACTION__?.(bridgeRequestId, {
          ok: false,
          action,
          actionToken,
          abandoned: true,
          message: "Anti-Codex manager bridge timed out.",
        });
        if (location.protocol === "app:") throw new Error("Anti-Codex manager bridge timed out.");
      } catch (error) {
        if (isManagerBridgeStaleError(error)) return runActionViaScript(action, actionToken);
        if (location.protocol === "app:") throw error;
      }
    }
    return runActionViaScript(action, actionToken);
  }

  async function runActionViaScript(action, actionToken = "") {
    await refreshManagerToken();
    let lastError = null;
    for (const baseUrl of actionApiCandidates()) {
      try {
        const payload = await new Promise((resolve, reject) => {
          const callbackName = `__ANTICODEX_MANAGER_ACTION_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const script = document.createElement("script");
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Anti-Codex manager action timed out."));
          }, actionTransportTimeoutMs(action));
          function cleanup() {
            clearTimeout(timer);
            try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
            script.remove();
          }
          window[callbackName] = (payload) => {
            cleanup();
            resolve(payload);
          };
          script.onerror = () => {
            cleanup();
            reject(new Error(`Action script failed: ${baseUrl}`));
          };
          const params = new URLSearchParams({ action, token: managerToken, callback: callbackName });
          script.src = `${baseUrl}/anticodex/manager/action-script?${params.toString()}`;
          document.documentElement.append(script);
        });
        if (!actionToken || window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken) {
          activeApi = browserReachableApiBase(payload?.snapshot?.baseUrl || baseUrl, baseUrl);
          if (payload?.snapshot) {
            window.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
            reconcileManagerPendingActions(payload.snapshot);
          }
        }
        if (payload?.ok !== false || (payload?.result && typeof payload.result === "object")) return payload;
        throw new Error(payload.message || "Anti-Codex manager action failed.");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Anti-Codex manager action endpoint is unavailable.");
  }

  function kv(rows) {
    const box = el("div", { className: "anticodex-kv" });
    for (const [key, value] of rows) {
      box.append(
        el("div", { className: "anticodex-k" }, key),
        el("div", { className: "anticodex-v" }, value ?? "\u672a\u77e5"),
      );
    }
    return box;
  }

  function card(title, body) {
    return el("section", { className: "anticodex-card" }, [
      el("h2", { text: title }),
      body,
    ]);
  }

  async function copyTextToClipboard(text) {
    const value = String(text || "");
    if (!value.trim()) throw new Error("\u6ca1\u6709\u53ef\u590d\u5236\u7684\u5185\u5bb9");
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const textarea = el("textarea", { value, style: "position:fixed;left:-9999px;top:0" });
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    try {
      if (!document.execCommand("copy")) throw new Error("\u590d\u5236\u88ab\u6d4f\u89c8\u5668\u62d2\u7edd");
      return true;
    } finally {
      textarea.remove();
    }
  }

  function connectorAllowlistEditor(allowlist, result, reload, runExclusive) {
    const persisted = Array.isArray(allowlist?.persisted) ? allowlist.persisted : [];
    const env = Array.isArray(allowlist?.env) ? allowlist.env : [];
    const counts = allowlist?.counts || {};
    const textarea = el("textarea", {
      className: "anticodex-connector-allowlist-input",
      rows: "4",
      spellcheck: "false",
      "aria-label": "\u672c\u5730\u5141\u8bb8\u7684 connector id",
    });
    textarea.value = persisted.join("\n");
    const saveButton = el("button", { type: "button", text: "\u4fdd\u5b58\u672c\u5730\u5141\u8bb8\u5217\u8868" });
    const hint = el("div", { className: "anticodex-result", text: [
      `\u76ee\u5f55 ${counts.total ?? 0} / \u672c\u5730\u7f13\u5b58\u9884\u89c8 ${counts.localAllowlisted ?? counts.locallyAuthorized ?? 0} / \u771f\u5b9e\u53ef\u8c03\u7528\u5de5\u5177 ${counts.appTools ?? 0}`,
      env.length ? `\u73af\u5883\u53d8\u91cf\u989d\u5916\u5141\u8bb8\uff1a${env.join(", ")}` : "\u672a\u914d\u7f6e\u73af\u5883\u53d8\u91cf\u989d\u5916\u5141\u8bb8",
      "\u672c\u5730\u7f13\u5b58\u9884\u89c8\uff0c\u4e0d\u6388\u6743\uff0c\u4e0d\u4ee3\u8868\u53ef\u8c03\u7528\u3002",
      "\u6bcf\u884c\u4e00\u4e2a connector id\uff1b\u4ec5\u672c\u5730 Anti-Codex \u751f\u6548\uff0c\u4e0d\u5199\u56de\u539f\u751f Codex\u3002",
    ].join("\n") });
    saveButton.onclick = () => runExclusive(async () => {
      const connectorIds = textarea.value
        .split(/[\r\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      saveButton.disabled = true;
      result.classList.remove("anticodex-error");
      result.textContent = "\u6b63\u5728\u4fdd\u5b58\u672c\u5730\u8fde\u63a5\u5668 allowlist ...";
      try {
        const saved = await managerPostJson("/anticodex/local-connectors/allowlist", { connectorIds });
        window.__ANTICODEX_MANAGER_SNAPSHOT__ = null;
        result.textContent = `\u672c\u5730\u8fde\u63a5\u5668 allowlist \u5df2\u4fdd\u5b58\u3002\n\u672c\u5730\u7f13\u5b58\u9884\u89c8\uff1a${saved.counts?.localAllowlisted ?? saved.counts?.locallyAuthorized ?? connectorIds.length}\n\u771f\u5b9e\u53ef\u8c03\u7528\u5de5\u5177\uff1a${saved.counts?.appTools ?? 0}\n\u6ce8\u610f\uff1a\u4e0d\u6388\u6743\uff0c\u4e0d\u4ee3\u8868\u53ef\u8c03\u7528\u3002`;
        await reload({ updateResult: false });
      } catch (error) {
        result.classList.add("anticodex-error");
        result.textContent = "\u4fdd\u5b58\u672c\u5730\u8fde\u63a5\u5668 allowlist \u5931\u8d25\uff1a" + error.message;
      } finally {
        saveButton.disabled = false;
      }
    });
    return el("div", { style: "display:grid;gap:9px" }, [
      hint,
      textarea,
      saveButton,
    ]);
  }

  function routeSummaryRows(route) {
    return [
      ["\u8bf7\u6c42\u6a21\u578b", route?.requestedModel || ""],
      ["\u5b9e\u9645\u6a21\u578b", route?.resolvedModel || ""],
      ["\u663e\u793a\u540d", route?.displayName || ""],
      ["\u4f20\u8f93", route?.transport || ""],
      ["Provider", route?.provider || ""],
      ["\u534f\u8bae", route?.providerProtocol || ""],
      ["\u5185\u90e8\u6a21\u578b", route?.internalModel || ""],
      ["\u72b6\u6001", route?.status || "\u6682\u65e0\u8def\u7531\u8bb0\u5f55"],
    ];
  }

  function trafficDiagnosis(health) {
    return String(health?.accountTrafficDiagnosis || health?.accountTrafficState || health?.accountState || "");
  }

  function isQuotaLimitTraffic(health) {
    return trafficDiagnosis(health) === "quota_or_limit_reached"
      || String(health?.accountTrafficType || "") === "antigravity_quota_exceeded";
  }

  function trafficSuccessAfterFailure(health) {
    const successMs = Date.parse(String(health?.accountTrafficLastSuccessAt || ""));
    const failureMs = Date.parse(String(health?.accountTrafficLastFailureAt || ""));
    return Number.isFinite(successMs) && Number.isFinite(failureMs) && successMs > failureMs;
  }

  function trafficNoticeKey(health) {
    const diagnosis = trafficDiagnosis(health);
    if (isQuotaLimitTraffic(health)) return "quota_or_limit_reached";
    if (diagnosis === "account_verification_required" || diagnosis === "account_verification_with_missing_token") return diagnosis;
    if (diagnosis === "antigravity_account_unavailable") return diagnosis;
    if (health?.accountTrafficRetryable === true || diagnosis === "antigravity_temporarily_unavailable") {
      if (health?.accountTrafficReady === true || trafficSuccessAfterFailure(health)) return "";
      return "antigravity_temporarily_unavailable";
    }
    return "";
  }

  function trafficNoticeSignature(health) {
    const key = trafficNoticeKey(health);
    if (!key) return "";
    const failure = String(health?.accountTrafficLastFailureAt || health?.accountTrafficMessage || key);
    return `${key}:${failure}`;
  }

  function updateTrafficNotice(health) {
    const key = trafficNoticeKey(health);
    const signature = trafficNoticeSignature(health);
    const existing = document.getElementById(TRAFFIC_NOTICE_ID);
    if (!key) {
      document.getElementById(TRAFFIC_NOTICE_ID)?.remove();
      window.__ANTICODEX_DISMISSED_TRAFFIC_NOTICE__ = "";
      return;
    }
    if (window.__ANTICODEX_DISMISSED_TRAFFIC_NOTICE__ === signature) {
      existing?.remove();
      return;
    }
    if (existing?.getAttribute("data-anticodex-traffic-signature") === signature) return;
    existing?.remove();
    const quotaModel = String(health?.accountTrafficModel || "").trim();
    const copy = {
      quota_or_limit_reached: [quotaModel ? `${quotaModel} \u989d\u5ea6\u5df2\u5230` : "Antigravity \u6a21\u578b\u989d\u5ea6\u5df2\u5230", quotaModel ? "\u8bf7\u5207\u6362\u5230\u4ecd\u6709\u989d\u5ea6\u7684\u6a21\u578b\uff0c\u6216\u7b49\u5f85\u8be5\u6a21\u578b\u989d\u5ea6\u6062\u590d\u3002" : "\u8bf7\u5207\u6362\u5230\u4ecd\u6709\u989d\u5ea6\u7684\u6a21\u578b\uff0c\u6216\u7b49\u5f85\u989d\u5ea6\u6062\u590d\u540e\u91cd\u8bd5\u3002"],
      account_verification_required: ["Antigravity \u9700\u8981\u8d26\u53f7\u9a8c\u8bc1", "\u8bf7\u5728 Antigravity \u684c\u9762\u7aef\u5b8c\u6210\u9a8c\u8bc1\u3002"],
      account_verification_with_missing_token: ["Antigravity \u9a8c\u8bc1\u5c1a\u672a\u751f\u6548", "\u5b8c\u6210\u9a8c\u8bc1\u540e\uff0c\u8bf7\u7a0d\u7b49\u6216\u91cd\u65b0\u6253\u5f00 Antigravity\u3002"],
      antigravity_account_unavailable: ["Antigravity \u8d26\u53f7\u4e0d\u53ef\u7528", "\u8bf7\u68c0\u67e5 Antigravity \u662f\u5426\u5df2\u767b\u5f55\u3002"],
      antigravity_temporarily_unavailable: ["Antigravity \u6216\u4ee3\u7406\u6682\u65f6\u4e0d\u53ef\u7528", "\u7f51\u7edc\u6062\u590d\u540e Anti-Codex \u4f1a\u81ea\u52a8\u91cd\u8bd5\u3002"],
    }[key] || ["Antigravity \u9700\u8981\u5904\u7406", "\u70b9\u51fb\u67e5\u770b\u8be6\u60c5\u3002"];
    const notice = el("div", {
      id: TRAFFIC_NOTICE_ID,
      role: "alert",
      "data-anticodex-traffic-state": key,
      "data-anticodex-traffic-signature": signature,
      "aria-label": copy[0],
    }, [
      el("strong", { text: copy[0] }),
      el("span", { text: health?.accountTrafficSuggestedAction || copy[1] }),
      el("div", { className: "anticodex-notice-actions" }, [
        el("button", { type: "button", "data-anticodex-notice-action": "open", text: "\u6253\u5f00\u7ba1\u7406" }),
        el("button", { type: "button", "data-anticodex-notice-action": "retry", text: "\u91cd\u65b0\u68c0\u67e5" }),
        el("button", { type: "button", "data-anticodex-notice-action": "dismiss", text: "\u5173\u95ed", "aria-label": "\u5173\u95ed\u672c\u6b21\u63d0\u9192" }),
      ]),
    ]);
    notice.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:76px",
      "z-index:2147482999",
      "width:min(360px,calc(100vw - 36px))",
      "padding:14px 16px",
      "display:grid",
      "gap:5px",
      "border:1px solid rgba(255,255,255,.26)",
      "border-radius:16px",
      "background:linear-gradient(135deg,rgba(120,53,15,.98),rgba(159,18,57,.98))",
      "color:#fff",
      "font:13px Microsoft YaHei,Segoe UI,sans-serif",
      "text-align:left",
      "box-shadow:0 16px 42px rgba(0,0,0,.32)",
      "cursor:pointer",
    ].join(";");
    notice.querySelector("strong").style.fontSize = "14px";
    notice.querySelector("span").style.lineHeight = "1.45";
    notice.querySelector(".anticodex-notice-actions").style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:4px";
    notice.querySelectorAll(".anticodex-notice-actions button").forEach((button) => {
      button.style.cssText = "min-height:30px;padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.42);background:rgba(255,255,255,.16);color:#fff;cursor:pointer";
    });
    async function runNoticeAction(actionButton, event) {
      event.stopPropagation();
      event.preventDefault();
      const action = actionButton?.getAttribute("data-anticodex-notice-action") || "";
      if (action === "open") {
        openManager();
        return;
      }
      if (action === "dismiss") {
        window.__ANTICODEX_DISMISSED_TRAFFIC_NOTICE__ = signature;
        notice.remove();
        return;
      }
      if (action === "retry") {
        const previous = actionButton.textContent;
        let actionToken = "";
        actionButton.disabled = true;
        actionButton.textContent = "\u68c0\u67e5\u4e2d...";
        try {
          await openManager();
          const managerBusy = Boolean(window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__)
            || Object.keys(window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ || {}).some(actionStillPending);
          if (managerBusy) {
            const message = "\u5df2\u6709\u7ba1\u7406\u4efb\u52a1\u5728\u8fd0\u884c\uff0c\u8bf7\u5b8c\u6210\u540e\u518d\u91cd\u65b0\u68c0\u67e5\u3002";
            notice.querySelector("span").textContent = message;
            const liveResult = document.querySelector(`#${MANAGER_ID} [data-anticodex-result="action"]`);
            if (liveResult) liveResult.textContent = message;
            return;
          }
          actionToken = `notice:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ = actionToken;
          window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ = actionToken;
          await runActionViaBridge("accountProxy", actionToken);
          if (window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;
          await window.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
        } catch (error) {
          if (actionToken && window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;
          const message = "\u91cd\u65b0\u68c0\u67e5\u5931\u8d25\uff1a" + (error?.message || "\u672c\u5730\u68c0\u67e5\u4e0d\u53ef\u7528");
          notice.querySelector("span").textContent = message;
          const liveResult = document.querySelector(`#${MANAGER_ID} [data-anticodex-result="action"]`);
          if (liveResult) {
            liveResult.classList.add("anticodex-error");
            liveResult.textContent = message;
          }
        } finally {
          if (window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ === actionToken) {
            delete window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__;
          }
          actionButton.disabled = false;
          actionButton.textContent = previous || "\u91cd\u65b0\u68c0\u67e5";
        }
      }
    }
    notice.addEventListener("click", (event) => {
      const actionButton = closestEventElement(event, "[data-anticodex-notice-action]");
      if (actionButton) {
        void runNoticeAction(actionButton, event);
        return;
      }
      openManager();
    });
    document.body?.append(notice);
  }

  function quotaLimitNotice(health) {
    if (!isQuotaLimitTraffic(health)) return null;
    return card("\u8d26\u53f7\u9650\u989d\u63d0\u9192", el("div", { className: "anticodex-result anticodex-warn", text: [
      "Antigravity \u5f53\u524d\u8d26\u53f7\u53ef\u80fd\u5df2\u5230\u989d\u5ea6/\u9650\u989d\u3002",
      health?.accountTrafficSuggestedAction || "\u8bf7\u5207\u6362 Antigravity \u8d26\u53f7\uff0c\u6216\u7b49\u5f85\u989d\u5ea6\u6062\u590d\u540e\u91cd\u8bd5\u3002",
      "Anti-Codex \u4e0d\u4f1a\u5207\u5230 ChatGPT \u767b\u5f55\uff0c\u4e5f\u4e0d\u4f1a\u6539\u7528 GPT \u6a21\u578b\u3002",
    ].join("\n") }));
  }

  function snapshotStalenessNotice(snapshotStatus, refreshText) {
    const stale = snapshotStatus?.stale === true
      || snapshotStatus?.state === "stale"
      || snapshotStatus?.state === "invalid"
      || snapshotStatus?.state === "missing";
    if (!stale) return null;
    const reason = snapshotStatus?.staleReason === "source_changed"
      ? "\u539f\u751f Codex \u672c\u5730\u529f\u80fd\u5df2\u53d8\u5316"
      : (snapshotStatus?.state === "unverified"
          ? "\u5feb\u7167\u5c1a\u672a\u4e0e\u5f53\u524d\u539f\u751f Codex \u6838\u5bf9"
          : (snapshotStatus?.state === "check_failed"
              ? "\u5feb\u7167\u6838\u5bf9\u5931\u8d25"
              : (snapshotStatus?.state === "missing" ? "\u5feb\u7167\u7f3a\u5931" : "\u5feb\u7167\u5df2\u8fc7\u671f\u6216\u6807\u8bb0\u65e0\u6548")));
    return card("\u672c\u5730\u529f\u80fd\u5feb\u7167\u9700\u5237\u65b0", el("div", { className: "anticodex-result anticodex-warn", text: [
      reason,
      refreshText || "\u8bf7\u70b9\u201c\u5237\u65b0\u672c\u5730\u529f\u80fd\u201d\uff0c\u5b8c\u6210\u540e\u518d\u8fd0\u884c MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u68c0\u67e5\u3002",
    ].join("\n") }));
  }

  async function refreshManagerStatus() {
    const manager = document.getElementById(MANAGER_ID);
    const promptEditorOpen = manager?.getAttribute("data-anticodex-manager-view") === "prompts";
    const busy = manager?.getAttribute("data-anticodex-busy") === "true"
      || manager?.querySelector(".anticodex-actions")?.getAttribute("data-anticodex-busy") === "true";
    if (promptEditorOpen) return;
    if (busy) return;
    try {
      const healthResult = await safeJson("/health");
      const health = safeValue(healthResult, {});
      if (healthResult.ok) updateTrafficNotice(health);
      if (manager && !busy) {
        if (Object.keys(window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ || {}).some(actionStillPending)) {
          await refreshManagerSnapshot();
        }
        await window.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
      }
    } catch {}
  }

  function reportSummaryLines(result) {
    const r = result || {};
    const report = r.report || {};
    return [
      r.reportName ? `\u8bc1\u636e\uff1a${r.reportName}` : "",
      report.latest ? `\u6700\u65b0\u62a5\u544a\uff1a${report.latest}` : "",
      report.history ? `\u5386\u53f2\u62a5\u544a\uff1a${report.history}` : "",
    ].filter(Boolean);
  }

  function failureSummaryLine(result) {
    const failures = Array.isArray(result?.failures) ? result.failures.filter(Boolean) : [];
    if (!failures.length) return "";
    return `\u5931\u8d25\u9879\uff1a${failures.length}\n${failures.slice(0, 3).join("\n")}`;
  }

  function localGatewayGuidanceLine(result) {
    const failures = Array.isArray(result?.failures) ? result.failures.filter(Boolean) : [];
    const text = failures.join("\n").toLowerCase();
    if (!text.includes("/health") && !text.includes("endpoint failed") && !text.includes("gateway offline") && !text.includes("failed to fetch") && !text.includes("timeout") && !text.includes("connection refused") && !text.includes("econnrefused") && !text.includes("无法连接")) return "";
    return "guidance: local Anti-Codex gateway is offline; start or restore the local gateway, then rerun plugin/app capability check.";
  }

  function triStateText(value) {
    if (value === true) return "true";
    if (value === false) return "false";
    return "unknown";
  }

  function syncReadinessEvidenceFromResult(result) {
    const r = result || {};
    const sync = r.sync || {};
    const activeHost = r.activeHost || {};
    const updateStatus = sync.updateStatus || r.updateStatus || {};
    const drift = updateStatus.drift || {};
    const managerBridge = sync.managerBridge || {};
    const clientSyncContract = r.clientSyncContract || {};
    return {
      codexVersion: activeHost.codexVersion || updateStatus.source?.codexVersion || "",
      clientSyncMode: clientSyncContract.mode || "",
      clientSyncMaintenancePath: clientSyncContract.maintenancePath || "",
      nativeClientBehaviorCarriedByHostSync: typeof clientSyncContract.nativeClientBehaviorCarriedByHostSync === "boolean" ? clientSyncContract.nativeClientBehaviorCarriedByHostSync : null,
      forbidsFeatureByFeatureReimplementation: typeof clientSyncContract.forbidsFeatureByFeatureReimplementation === "boolean" ? clientSyncContract.forbidsFeatureByFeatureReimplementation : null,
      sourcePackageName: clientSyncContract.sourcePackageName || updateStatus.source?.packageName || "",
      activeSourcePackageName: clientSyncContract.activeSourcePackageName || activeHost.sourcePackageName || "",
      clientSyncHostHashMatches: typeof clientSyncContract.sourceHostHashMatches === "boolean" ? clientSyncContract.sourceHostHashMatches : null,
      clientSyncCliHashMatches: typeof clientSyncContract.sourceCliHashMatches === "boolean" ? clientSyncContract.sourceCliHashMatches : null,
      antiCodexPatchScope: Array.isArray(clientSyncContract.antiCodexPatchScope) ? clientSyncContract.antiCodexPatchScope.filter(Boolean) : [],
      sourcePackageVersion: clientSyncContract.sourcePackageVersion || updateStatus.source?.packageVersion || activeHost.sourcePackageVersion || "",
      activeSourcePackageVersion: clientSyncContract.activeSourcePackageVersion || updateStatus.active?.packageVersion || "",
      clientSyncVersionMatches: clientSyncContract.sourcePackageVersion && clientSyncContract.activeSourcePackageVersion
        ? String(clientSyncContract.sourcePackageVersion) === String(clientSyncContract.activeSourcePackageVersion)
        : null,
      activePackageVersion: drift.activePackageVersion || updateStatus.active?.packageVersion || "",
      updateStatusSource: sync.updateStatusSource || updateStatus.sourceType || "",
      updateStatusReason: updateStatus.reason || "",
      updateDriftState: drift.state || updateStatus.reason || "",
      updateDriftHostChanged: typeof drift.hostChanged === "boolean" ? drift.hostChanged : null,
      updateDriftCliChanged: typeof drift.cliChanged === "boolean" ? drift.cliChanged : null,
      sourceHostHash: updateStatus.source?.hostHash || "",
      activeHostHash: updateStatus.active?.hostHash || "",
      sourceCliHash: updateStatus.source?.cliHash || "",
      activeCliHash: updateStatus.active?.cliHash || "",
      hostHashMatches: updateStatus.source?.hostHash && updateStatus.active?.hostHash ? updateStatus.source.hostHash === updateStatus.active.hostHash : null,
      cliHashMatches: updateStatus.source?.cliHash && updateStatus.active?.cliHash ? updateStatus.source.cliHash === updateStatus.active.cliHash : null,
      managerBridgeProcessCount: Number.isFinite(Number(managerBridge.processCount)) ? Number(managerBridge.processCount) : null,
      managerBridgeStaleProcessCount: Number.isFinite(Number(managerBridge.staleProcessCount)) ? Number(managerBridge.staleProcessCount) : null,
    };
  }

  function syncReadinessEvidenceLines(evidence) {
    const e = evidence || {};
    return [
      `sync contract: mode=${e.clientSyncMode || "unknown"} / path=${e.clientSyncMaintenancePath || "unknown"} / nativeHostSync=${triStateText(e.nativeClientBehaviorCarriedByHostSync)} / noFeatureRebuild=${triStateText(e.forbidsFeatureByFeatureReimplementation)} / patches=${Array.isArray(e.antiCodexPatchScope) && e.antiCodexPatchScope.length ? e.antiCodexPatchScope.join(",") : "unknown"}`,
      `\u7248\u672c\uff1aCodex ${e.codexVersion || "\u672a\u77e5"} / source ${e.sourcePackageVersion || "\u672a\u77e5"} / active ${e.activePackageVersion || "\u672a\u77e5"} / activeSource ${e.activeSourcePackageVersion || "\u672a\u77e5"} / versionMatch ${triStateText(e.clientSyncVersionMatches)}`,
      `\u6f02\u79fb\uff1astate=${e.updateDriftState || "unknown"} / reason=${e.updateStatusReason || "unknown"} / source=${e.updateStatusSource || "unknown"} / hostChanged=${triStateText(e.updateDriftHostChanged)} / cliChanged=${triStateText(e.updateDriftCliChanged)}`,
      `hash\uff1ahost=${String(e.activeHostHash || "").slice(0, 8) || "unknown"}/${String(e.sourceHostHash || "").slice(0, 8) || "unknown"} match=${triStateText(e.hostHashMatches)} / cli=${String(e.activeCliHash || "").slice(0, 8) || "unknown"}/${String(e.sourceCliHash || "").slice(0, 8) || "unknown"} match=${triStateText(e.cliHashMatches)}`,
      e.managerBridgeProcessCount !== null || e.managerBridgeStaleProcessCount !== null
        ? `Manager bridge\uff1aprocesses=${e.managerBridgeProcessCount ?? "?"} / stale=${e.managerBridgeStaleProcessCount ?? "?"}`
        : "",
    ].filter(Boolean);
  }

  function sourceSnapshotLine(result) {
    const evidence = result?.sourceSnapshot && typeof result.sourceSnapshot === "object" ? result.sourceSnapshot : null;
    if (!evidence) return "";
    const fileCount = evidence.fileCount ?? "\u672a\u77e5";
    const fingerprint = evidence.fingerprint ? String(evidence.fingerprint).slice(0, 12) : "\u7f3a\u5931";
    const cache = evidence.cacheHitCount != null || evidence.cacheMissCount != null ? ` / cache=${evidence.cacheHitCount ?? "\u672a\u77e5"}/${evidence.cacheMissCount ?? "\u672a\u77e5"}` : "";
    const reused = evidence.reusedFromPreviousReport === true ? " / reused=true" : "";
    const skipped = evidence.refreshSkippedReason ? ` / reason=${evidence.refreshSkippedReason}` : "";
    return `sourceSnapshot: files=${fileCount} / fingerprint=${fingerprint}${cache}${reused}${skipped}`;
  }

  function formatReportAge(ageMs) {
    if (!Number.isFinite(Number(ageMs))) return "";
    const seconds = Math.max(0, Math.round(Number(ageMs) / 1000));
    if (seconds < 60) return `${seconds} \u79d2\u524d`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} \u5206\u949f\u524d`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} \u5c0f\u65f6\u524d`;
    return `${Math.round(hours / 24)} \u5929\u524d`;
  }

  function latestReportsSummary(result) {
    const reports = Array.isArray(result?.reports) ? result.reports : [];
    if (!reports.length) return "\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u62a5\u544a\u3002";

    const lines = [
      `\u62a5\u544a\u76ee\u5f55\uff1a${result.reportRoot || "\u672a\u77e5"}`,
      `\u5df2\u627e\u5230\uff1a${result.existingCount ?? reports.filter((item) => item.exists).length} \u4efd / \u7f3a\u5931\uff1a${result.missingCount ?? reports.filter((item) => !item.exists && item.deferred !== true).length} \u4efd / \u635f\u574f\uff1a${result.invalidCount ?? 0} \u4efd`,
    ];

    for (const item of reports) {
      const passed = item.effectiveOk ?? item.ok;
      const status = !item.exists
        ? (item.deferred ? "\u53ef\u9009\u672a\u8fd0\u884c" : "\u672a\u751f\u6210")
        : (item.invalid
          ? "\u62a5\u544a\u635f\u574f"
          : (item.stale && !item.deferred
            ? "\u9700\u91cd\u8dd1"
            : (passed ? "\u901a\u8fc7" : (item.deferred ? "\u53ef\u9009\u672a\u901a\u8fc7" : "\u9700\u5904\u7406"))));
      const age = formatReportAge(item.ageMs);
      lines.push("");
      lines.push(`${item.label || item.fileName || "\u672a\u547d\u540d"}\uff1a${status}${age ? ` / ${age}` : ""}`);

      if (item.fileName === "latest-release-gates.json" && item.exists && !item.invalid) {
        lines.push(`  \u8fdb\u5ea6\uff1a\u58f3 ${item.shellProgress ?? "?"}% / CodexPlusPlus ${item.codexPlusPlusProgress ?? "?"}% / Antigravity \u8584\u9002\u914d ${item.antigravityAdapterProgress ?? "?"}% / \u6574\u4f53 ${item.overallProgress ?? "?"}%`);
        lines.push(`  \u95e8\u7981\uff1a\u5df2\u5b8c\u6210 ${Array.isArray(item.completedGates) && item.completedGates.length ? item.completedGates.join(", ") : "\u65e0"} / \u5f53\u524d ${item.currentGate || "\u672a\u77e5"}`);
        if (Array.isArray(item.missingRequired) && item.missingRequired.length) {
          lines.push(`  \u5f85\u5b8c\u6210\uff1a${item.missingRequired.join(", ")}`);
        }
      }

      if (item.fileName === "latest-source-preflight.json" && typeof item.publicDocumentationOk === "boolean") {
        lines.push(`  \u516c\u5f00\u6587\u6863\uff1a${item.publicDocumentationOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
      }
      if (item.firstFailure) lines.push(`  \u9996\u4e2a\u95ee\u9898\uff1a${item.firstFailure}`);
      else if (item.reason) lines.push(`  \u8bf4\u660e\uff1a${item.reason}`);
      if (item.exists && item.latestPath) lines.push(`  \u6587\u4ef6\uff1a${item.latestPath}`);
    }
    return lines.join("\n");
  }


  function ensureLatestReportsEvidenceLines(summary, payload) {
    const text = String(summary || "");
    if (!text) return text;
    const candidates = [payload?.result, payload?.result?.result, payload].filter(Boolean);
    const reportPayload = candidates.find((item) => Array.isArray(item?.reports)) || {};
    let output = text;
    const modelAvailability = reportPayload.reports?.find((item) => item?.fileName === "latest-model-availability.json");
    const availabilityEvidence = modelAvailability?.modelRoutingEvidence || null;
    if (availabilityEvidence && !output.includes("modelRouting availability:")
      && ((Array.isArray(availabilityEvidence.requestAvailableModels) && availabilityEvidence.requestAvailableModels.length)
        || (Array.isArray(availabilityEvidence.availabilityUnavailableModels) && availabilityEvidence.availabilityUnavailableModels.length)
        || Number(availabilityEvidence.availabilityUnavailableCount) > 0)) {
      const available = Array.isArray(availabilityEvidence.requestAvailableModels) && availabilityEvidence.requestAvailableModels.length ? availabilityEvidence.requestAvailableModels.join(", ") : "none";
      const unavailable = Array.isArray(availabilityEvidence.availabilityUnavailableModels) && availabilityEvidence.availabilityUnavailableModels.length ? availabilityEvidence.availabilityUnavailableModels.join(", ") : "none";
      output += `\n  modelRouting availability: available=${available} / unavailable=${unavailable}`;
    }
    if (output.includes("\u516c\u5f00\u6587\u6863\uff1a")) return output;
    const sourcePreflight = reportPayload.reports?.find((item) => item?.fileName === "latest-source-preflight.json");
    const publicDocumentationOk = sourcePreflight?.publicDocumentationOk;
    const inferredOk = publicDocumentationOk === null || publicDocumentationOk === undefined
      ? (output.includes("\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7") ? true : null)
      : publicDocumentationOk === true;
    if (inferredOk === null) return output;
    const publicDocumentationLine = `  \u516c\u5f00\u6587\u6863\uff1a${inferredOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`;
    if (sourcePreflight?.latestPath) {
      const fileLine = `  \u6587\u4ef6\uff1a${sourcePreflight.latestPath}`;
      if (output.includes(fileLine)) return output.replace(fileLine, `${publicDocumentationLine}\n${fileLine}`);
    }
    return `${output}\n${publicDocumentationLine}`;
  }

  function upstreamCapabilitySummary(upstreamProfile, health) {
    const savedStages = upstreamProfile?.saved?.capabilities?.connectionStages;
    const healthStages = health?.upstreamProfile?.capabilitySummary?.stages;
    const stages = Array.isArray(savedStages) && savedStages.length
      ? savedStages
      : (Array.isArray(healthStages) ? healthStages : []);
    if (!stages.length) return "\u672a\u4fdd\u5b58\u80fd\u529b\u6d4b\u8bd5\u8bc1\u636e";
    const failCount = stages.filter((stage) => stage?.status === "fail").length;
    const warnCount = stages.filter((stage) => stage?.status === "warn").length;
    const toolStage = stages.find((stage) => String(stage?.stage || "").includes("\u5de5\u5177"));
    const streamStage = stages.find((stage) => String(stage?.stage || "").includes("\u6d41\u5f0f"));
    if (failCount > 0) return `\u57fa\u7840\u80fd\u529b\u672a\u901a\u8fc7\uff1a${failCount} \u9879\u5931\u8d25`;
    if (warnCount > 0) return `\u57fa\u7840\u804a\u5929\u53ef\u7528\uff0c${warnCount} \u9879\u8b66\u544a\uff08\u6d41\u5f0f ${streamStage?.status || "\u672a\u77e5"} / \u5de5\u5177 ${toolStage?.status || "\u672a\u77e5"}\uff09`;
    return "\u57fa\u7840\u804a\u5929\u3001\u6d41\u5f0f\u548c\u5de5\u5177\u8c03\u7528\u5df2\u9a8c\u8bc1";
  }

  function managerActionResult(payload) {
    let result = payload && typeof payload === "object" ? payload : {};
    while (result?.result && typeof result.result === "object" && result.result !== result) result = result.result;
    return result;
  }

  function summaryText(action, payload) {
    const r = payload?.result || payload || {};
    const unwrapped = managerActionResult(payload);
    if (action === "refreshStatus") return `\u72b6\u6001\u5237\u65b0\uff1a${r.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`;
    if (action === "refreshModels") return `\u6a21\u578b\u5237\u65b0\uff1a${r.ok ? "\u5b8c\u6210" : "\u5931\u8d25"}\n\u6a21\u578b\u6570\uff1a${r.modelCount ?? r.models?.length ?? "\u672a\u77e5"}`;
    if (action === "accountSwitch") return [
      "\u5df2\u6253\u5f00 Antigravity \u684c\u9762\u7aef\u3002",
      "\u8bf7\u5728 Antigravity \u4e2d\u5207\u6362\u8d26\u53f7\uff0c\u5b8c\u6210\u540e\u56de\u5230 Anti-Codex \u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002",
      r.nextAction === "refreshModels" ? "\u4e0b\u4e00\u6b65\uff1a\u5237\u65b0\u6a21\u578b" : "",
    ].filter(Boolean).join("\n");
    if (action === "accountProxy") {
      const ready = payload?.ok === true && unwrapped.ok === true && unwrapped.diagnosis === "ready";
      return [
        `\u8d26\u53f7/\u4ee3\u7406\u68c0\u67e5\uff1a${ready ? "\u53ef\u7528" : "\u9700\u8981\u5904\u7406"}`,
        `\u8d26\u53f7\uff1a${unwrapped.account?.signedIn ? "\u5df2\u767b\u5f55" : "\u672a\u786e\u8ba4"}${unwrapped.account?.planName ? ` / ${unwrapped.account.planName}` : ""}`,
        `\u6a21\u578b\u6570\uff1a${unwrapped.models?.count ?? "\u672a\u77e5"}`,
        `\u8bca\u65ad\uff1a${unwrapped.diagnosisDetail || unwrapped.diagnosis || "\u672a\u77e5"}`,
        unwrapped.suggestedAction ? `\u5efa\u8bae\uff1a${unwrapped.suggestedAction}` : "",
        unwrapped.realRequest?.attempted ? "\u771f\u5b9e\u8bf7\u6c42\uff1a\u5df2\u6267\u884c" : "\u771f\u5b9e\u8bf7\u6c42\uff1a\u672a\u6267\u884c\uff08\u4e0d\u8017\u6a21\u578b\u989d\u5ea6\uff09",
        unwrapped.report?.latest ? `\u62a5\u544a\uff1a${unwrapped.report.latest}` : "",
      ].filter(Boolean).join("\n");
    }
    if (action === "updateCheck") {
      const remoteState = unwrapped.components?.remoteState || "not_checked";
      const remoteTag = unwrapped.components?.remoteTag || "\u672a\u77e5";
      const remoteLine = remoteState === "current"
        ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u9879\u76ee\u5df2\u8ddf\u8fdb\uff09`
        : remoteState === "newer_available"
          ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u5f85\u72ec\u7acb\u5019\u9009\u9a8c\u8bc1\uff1b\u540c\u6b65\u53ea\u5b89\u88c5\u9879\u76ee\u5df2\u63a5\u53d7\u7248\u672c\uff09`
          : remoteState === "project_ahead"
            ? `\u8fdc\u7aef\u4e0a\u6e38\uff1a${remoteTag}\uff08\u9879\u76ee\u7248\u672c\u9886\u5148\uff09`
            : remoteState === "failed" ? "\u8fdc\u7aef\u4e0a\u6e38\uff1a\u68c0\u67e5\u5931\u8d25" : "\u8fdc\u7aef\u4e0a\u6e38\uff1a\u672a\u68c0\u67e5";
      return [
        `\u66f4\u65b0\u68c0\u67e5\uff1a${unwrapped.updateNeeded ? "\u9700\u8981\u540c\u6b65" : (unwrapped.ok !== true ? "\u68c0\u67e5\u4e0d\u53ef\u7528" : "\u65e0\u9700\u540c\u6b65")}`,
        `Codex\uff1a\u672c\u673a\u5b98\u65b9 ${unwrapped.source?.packageVersion || "\u672a\u68c0\u67e5"} / Anti-Codex ${unwrapped.active?.packageVersion || "\u672a\u5b89\u88c5"}`,
        `CodexPlusPlus\uff1a\u9879\u76ee\u56fa\u5b9a ${unwrapped.components?.sourceVersion || "\u672a\u68c0\u67e5"} / \u5df2\u5b89\u88c5 ${unwrapped.components?.activeVersion || "\u672a\u5b89\u88c5"}`,
        remoteLine,
      ].join("\n");
    }
    if (action === "sourcePreflight") return [
      `\u6e90\u7801\u9884\u68c0\uff1a${r.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      `\u8017\u65f6\uff1a${r.elapsedMs ?? "\u672a\u77e5"} ms`,
      ...reportSummaryLines(r),
      failureSummaryLine(r),
    ].filter(Boolean).join("\n");
    if (action === "syncReadiness") return [
      `\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5\uff1a${r.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      ...syncReadinessEvidenceLines(syncReadinessEvidenceFromResult(r)),
      failureSummaryLine(r),
    ].filter(Boolean).join("\n");
    if (action === "repairShortcuts") return [
      `\u5feb\u6377\u65b9\u5f0f\u4fee\u590d\uff1a${r.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`,
      `\u5df2\u4fee\u590d\uff1a${r.repairedCount ?? r.shortcuts?.length ?? "\u672a\u77e5"}`,
      failureSummaryLine(r),
    ].filter(Boolean).join("\n");
    if (action === "mcpSkills") {
      const realList = Array.isArray(r.mcp?.smoke?.realList) ? r.mcp.smoke.realList : null;
      const realListCount = Number(r.mcp?.realListCount);
      const workerListSummary = realList
        ? `${realList.filter((entry) => entry && entry.passed === true).length}/${realList.length}`
        : (realListCount === 0 ? "\u672a\u6267\u884c\uff08\u5f00\u53d1 worker \u4e0d\u6ce8\u5165\uff09" : (Number.isFinite(realListCount) ? `\u5df2\u68c0\u67e5 ${realListCount}` : "\u672a\u68c0\u67e5"));
      const realCallPassed = r.mcp?.smoke?.realCall?.passed === true || r.mcp?.realCallPassed === true;
      const skillReadable = r.skills?.smoke?.readable === true || r.skills?.smokeReadable === true;
      return [
        `MCP/Skill \u6e05\u5355\u53ef\u89c1\uff1a${r.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
        `MCP ${r.mcp?.count ?? "\u672a\u77e5"} / Skill ${r.skills?.count ?? "\u672a\u77e5"}`,
        `\u771f\u5b9e\u5de5\u5177\u8c03\u7528\uff1anode_repl ${realCallPassed ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}\uff0cworker list ${workerListSummary}\uff0cSkill \u6587\u4ef6 ${skillReadable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
      ].join("\n");
    }
    if (action === "pluginCapabilities") {
      const c = r.capabilities || {};
      const appTools = c.appToolCount ?? 0;
      const accessibleConnectors = c.accessibleConnectorCount ?? 0;
      const callableState = c.smoke?.callableState || c.callableState || "";
      const smokeChecked = c.smoke?.checked === true;
      const capabilityState = c.capabilityState || "";
      const callableSummary = appTools > 0
        ? `\u5e94\u7528\u5de5\u5177 ${appTools} / callable=${smokeChecked && callableState ? callableState : "unknown"}`
        : accessibleConnectors > 0
          ? `\u5df2\u6388\u6743\u8fde\u63a5\u5668 ${accessibleConnectors} \u4f46\u672a\u53d1\u73b0\u53ef\u8c03\u7528\u5e94\u7528\u5de5\u5177 / callable=${callableState || "unknown"}`
          : `\u65e0\u6388\u6743\u8fde\u63a5\u5668\uff0cmetadata-only \u4e0d\u4f2a\u88c5\u53ef\u8c03\u7528 / state=${capabilityState || "unknown"} / callable=${callableState || "unknown"}`;
      return [
        `\u63d2\u4ef6/\u5e94\u7528\u6e05\u5355\u53ef\u89c1\uff1a${r.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
        `\u5df2\u5b89\u88c5\u63d2\u4ef6 ${c.installedPluginCount ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668 ${c.connectorCount ?? "\u672a\u77e5"}`,
        `\u77ed\u9884\u7b97\uff1a${r.shortBudgetMode ? "\u662f" : "\u5426"} / state=${capabilityState || "unknown"}`,
        sourceSnapshotLine(r),
        `\u6295\u5f71 smoke\uff1a${c.smoke?.endpointProjectionReadable ? "\u7aef\u70b9\u53ef\u8bfb" : "\u7aef\u70b9\u672a\u8bfb\u5230"}\uff0c\u7f13\u5b58 ${c.smoke?.connectorCache?.sampleReadable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
        `\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a${callableSummary}`,
        c.appToolsNote ? `\u8bf4\u660e\uff1a${c.appToolsNote}` : "",
        localGatewayGuidanceLine(r),
        failureSummaryLine(r),
      ].filter(Boolean).join("\n");
    }
    if (action === "refreshFeatures" && unwrapped?.background) return unwrapped?.alreadyRunning ? "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u8bf7\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u6216 MCP/Skill\u3001\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002" : "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5f00\u59cb\u540e\u53f0\u6267\u884c\u3002\n\u754c\u9762\u4e0d\u4f1a\u7b49\u5f85\u957f\u65f6\u590d\u5236\uff1b\u5b8c\u6210\u540e\u7528 MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002";
    const recoveryActionIds = Array.isArray(r.recoveryActions) ? r.recoveryActions.map((action) => action?.id).filter(Boolean).slice(0, 3) : [];
    if (action === "refreshFeatures") return [
      `\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a${r.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`,
      `Skill ${r.skills?.count ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668\u7f13\u5b58 ${r.connectors?.count ?? "\u672a\u77e5"}`,
      sourceSnapshotLine(r),
      recoveryActionIds.length ? `recoveryActions: ${recoveryActionIds.join(", ")}` : "",
      "\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a\u5237\u65b0\u540e\u4ecd\u9700\u5355\u72ec smoke \u9a8c\u8bc1",
    ].filter(Boolean).join("\n");
    if (action === "stabilitySoak") {
      if (unwrapped?.background !== true) return "\u7a33\u5b9a\u6027\u5de1\u68c0\uff1a\u672a\u6536\u5230\u540e\u53f0\u542f\u52a8\u56de\u6267\u3002";
      if (unwrapped.alreadyRunning) return "\u7a33\u5b9a\u6027\u5de1\u68c0\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
      return `${unwrapped.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u7a33\u5b9a\u6027\u5de1\u68c0\u3002" : "\u542f\u52a8\u7a33\u5b9a\u6027\u5de1\u68c0\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-stability-soak.json\u3002`;
    }
    if (action === "coldRelaunch") {
      if (unwrapped?.background !== true) return "\u51b7\u542f\u52a8\u9a8c\u8bc1\uff1a\u672a\u6536\u5230\u540e\u53f0\u542f\u52a8\u56de\u6267\u3002";
      if (unwrapped.alreadyRunning) return "\u51b7\u542f\u52a8\u9a8c\u8bc1\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u91cd\u542f Anti-Codex\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
      return `${unwrapped.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u51b7\u542f\u52a8\u9a8c\u8bc1\u3002" : "\u542f\u52a8\u51b7\u542f\u52a8\u9a8c\u8bc1\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u91cd\u542f Anti-Codex\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-cold-relaunch.json\u3002`;
    }
    if (action === "syncHost") {
      const failed = payload?.ok === false || r?.ok === false || unwrapped?.ok === false;
      const background = unwrapped?.background === true;
      const detail = unwrapped?.error || unwrapped?.message || r?.error || r?.message || payload?.error || payload?.message || "";
      return [
        failed ? "\u540c\u6b65\u542f\u52a8\u5931\u8d25" : (!background ? "\u540c\u6b65\u542f\u52a8\u7ed3\u679c\u672a\u786e\u8ba4" : (unwrapped?.alreadyRunning ? "\u540c\u6b65\u5df2\u5728\u540e\u53f0\u8fd0\u884c" : "\u5df2\u5f00\u59cb\u540e\u53f0\u540c\u6b65 Codex \u66f4\u65b0")),
        unwrapped?.operationId ? `\u4efb\u52a1\uff1a${unwrapped.operationId}` : "",
        unwrapped?.stage ? `\u9636\u6bb5\uff1a${unwrapped.stage}` : "",
        detail ? `\u8bf4\u660e\uff1a${detail}` : "",
      ].filter(Boolean).join("\n");
    }
    if (action === "diagnosticsBundle") {
      const longTasks = unwrapped.diagnosticsSummary?.longTasks;
      const otherRunningCount = longTasks?.otherRunningItems?.length;
      return [
        `\u8bca\u65ad\u5305\uff1a${unwrapped.ok ?? r.ok ? "\u5df2\u751f\u6210" : "\u5931\u8d25"}`,
        unwrapped.zipPath ? `ZIP\uff1a${unwrapped.zipPath}` : "",
        unwrapped.bundleRoot ? `\u76ee\u5f55\uff1a${unwrapped.bundleRoot}` : "",
        longTasks ? `\u957f\u4efb\u52a1\uff1a\u8fd0\u884c ${longTasks.runningCount ?? 0} / \u9700\u5904\u7406 ${longTasks.attentionCount ?? 0} / \u5176\u4ed6\u8fd0\u884c ${otherRunningCount ?? 0}` : "",
        failureSummaryLine(unwrapped),
        (!unwrapped.zipPath && !unwrapped.bundleRoot && !unwrapped.failures?.length) ? (payload?.message || r.message || "") : "",
      ].filter(Boolean).join("\n");
    }
    if (action === "viewLatestReports") return ensureLatestReportsEvidenceLines(latestReportsSummary(r), payload);
    if (action === "fastOverallNoTraffic") return [
      `\u5feb\u901f\u68c0\u67e5\uff1a${r.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      `\u8017\u65f6\uff1a${r.elapsedMs ?? "\u672a\u77e5"} ms`,
      ...reportSummaryLines(r),
      failureSummaryLine(r),
    ].filter(Boolean).join("\n");
    if (action === "overallNoTraffic") return [
      `\u6574\u4f53\u68c0\u67e5\uff1a${r.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      `\u8017\u65f6\uff1a${r.elapsedMs ?? "\u672a\u77e5"} ms`,
      ...reportSummaryLines(r),
      failureSummaryLine(r),
    ].filter(Boolean).join("\n");
    if (action === "postVerificationFull") return unwrapped?.background !== true
      ? "\u5b8c\u6574\u9a8c\u8bc1\uff1a\u672a\u6536\u5230\u540e\u53f0\u542f\u52a8\u56de\u6267"
      : (unwrapped?.alreadyRunning ? "\u5b8c\u6574\u9a8c\u8bc1\u5df2\u5728\u540e\u53f0\u8fd0\u884c" : "\u5df2\u5f00\u59cb\u540e\u53f0\u5b8c\u6574\u9a8c\u8bc1");
    return JSON.stringify(r, null, 2);
  }

  function timeoutText(action, label) {
    if (action === "accountSwitch") return "\u6253\u5f00 Antigravity \u8d85\u65f6\u3002\n\u8bf7\u624b\u52a8\u6253\u5f00 Antigravity\uff0c\u5207\u6362\u8d26\u53f7\u540e\u56de\u5230 Anti-Codex \u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002";
    if (action === "updateCheck") return "\u68c0\u67e5\u5168\u90e8\u66f4\u65b0\uff1a\u7ed3\u679c\u672a\u77e5\uff0c\u4ecd\u7b49\u5f85\u672c\u5730\u68c0\u67e5\u8fd4\u56de\uff1b\u8bf7\u52ff\u91cd\u590d\u70b9\u51fb\uff0c\u5b8c\u6210\u540e\u9762\u677f\u4f1a\u81ea\u52a8\u66f4\u65b0\u3002";
    return `${label}\uff1a\u7ed3\u679c\u672a\u8fd4\u56de\uff0c\u4ecd\u5728\u7b49\u5f85\u672c\u5730\u64cd\u4f5c\uff1b\u8bf7\u52ff\u91cd\u590d\u70b9\u51fb\uff0c\u5b8c\u6210\u540e\u9762\u677f\u4f1a\u81ea\u52a8\u66f4\u65b0\u3002`;
  }

  function actionUiTimeoutMs(action) {
    return actionTransportTimeoutMs(action) + 1000;
  }

  function actionTransportTimeoutMs(action) {
    if (action === "mcpSkills") return MCP_SKILLS_ACTION_UI_TIMEOUT_MS;
    return Math.max(BRIDGE_TIMEOUT_MS, MANAGER_ACTION_TRANSPORT_TIMEOUT_MS);
  }

  function pendingActionMaxMs(action) {
    let declaredMaxMs = Math.max(60 * 1000, actionUiTimeoutMs(action) * 3);
    if (action === "syncHost") declaredMaxMs = 30 * 60 * 1000;
    else if (action === "stabilitySoak") declaredMaxMs = 20 * 60 * 1000;
    else if (action === "coldRelaunch" || action === "refreshFeatures") declaredMaxMs = 10 * 60 * 1000;
    else if (action === "postVerificationFull") declaredMaxMs = 20 * 60 * 1000;
    else if (action === "overallNoTraffic") declaredMaxMs = 5 * 60 * 1000;
    else if (action === "fastOverallNoTraffic") declaredMaxMs = 2 * 60 * 1000;
    return Math.max(declaredMaxMs, actionTransportTimeoutMs(action) + MANAGER_PENDING_TRANSPORT_GRACE_MS);
  }

  function actionStillPending(action) {
    const pendingActions = managerPendingActions();
    const startedAt = Number(pendingActions[action] || 0);
    if (!startedAt) return false;
    if (Date.now() - startedAt > pendingActionMaxMs(action)) {
      delete pendingActions[action];
      persistManagerPendingActions();
      return false;
    }
    return true;
  }

  function managerSnapshotRunningActionIds(snapshot) {
    const diagnostics = snapshot?.responses?.["/anticodex/diagnostics"] || {};
    const running = new Set();
    for (const item of diagnostics?.longTasks?.items || []) {
      if (item?.state === "running" || item?.rawState === "running" || item?.stage === "manager_background" || item?.stage === "manager_foreground") {
        if (item?.id) running.add(String(item.id));
      }
    }
    const operation = diagnostics?.updateStatus?.operation || {};
    const operationAt = Date.parse(String(operation.updatedAt || operation.startedAt || ""));
    if (
      String(operation.state || "").toLowerCase() === "running"
      && Number.isFinite(operationAt)
      && Date.now() - operationAt <= pendingActionMaxMs("syncHost")
    ) running.add("syncHost");
    return running;
  }

  function managerSnapshotActionResult(snapshot, action, startedAtValue) {
    const actionResult = snapshot?.responses?.["/anticodex/diagnostics"]?.managerActionResults?.[action];
    const reportedAt = Date.parse(String(actionResult?.reportedAt || ""));
    const startedAt = Number(startedAtValue || 0);
    if (!actionResult || actionResult.exists === false || !Number.isFinite(reportedAt)) return null;
    if (startedAt && reportedAt < startedAt) return null;
    return actionResult;
  }

  function managerActionResultSummary(action, actionResult) {
    const label = ACTIONS.find(([id]) => id === action)?.[1] || action;
    if (!actionResult) return `${label}\uff1a\u7ed3\u679c\u672a\u77e5\uff1b\u540e\u53f0\u8fdb\u7a0b\u5df2\u7ed3\u675f\uff0c\u4f46\u6ca1\u6709\u53d1\u73b0\u672c\u6b21\u65b0\u62a5\u544a\u3002`;
    const ok = actionResult.effectiveOk === true || actionResult.ok === true;
    const detail = actionResult.firstFailure || actionResult.reason || "";
    return [
      `${label}\uff1a${ok ? "\u5df2\u5b8c\u6210\u5e76\u901a\u8fc7" : "\u5df2\u5b8c\u6210\u4f46\u672a\u901a\u8fc7"}`,
      detail ? `\u8bf4\u660e\uff1a${detail}` : "",
      actionResult.latestPath ? `\u62a5\u544a\uff1a${actionResult.latestPath}` : "",
    ].filter(Boolean).join("\n");
  }

  function managerPendingActions() {
    if (window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ && typeof window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ === "object") {
      return window.__ANTICODEX_MANAGER_PENDING_ACTIONS__;
    }
    let pending = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(MANAGER_PENDING_STORAGE_KEY) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pending = parsed;
    } catch {}
    window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ = pending;
    return pending;
  }

  function persistManagerPendingActions() {
    try {
      localStorage.setItem(MANAGER_PENDING_STORAGE_KEY, JSON.stringify(managerPendingActions()));
    } catch {}
  }

  managerPendingActions();

  function reconcileManagerPendingActions(snapshot) {
    const pendingActions = managerPendingActions();
    const running = managerSnapshotRunningActionIds(snapshot);
    const now = Date.now();
    for (const [action, startedAtValue] of Object.entries(pendingActions)) {
      const startedAt = Number(startedAtValue || 0);
      if (running.has(action) || (startedAt && now - startedAt <= MANAGER_PENDING_REPORT_GRACE_MS)) continue;
      const actionResult = managerSnapshotActionResult(snapshot, action, startedAt);
      const managerSummary = managerActionResultSummary(action, actionResult);
      const ok = !actionResult || (actionResult.effectiveOk == null && actionResult.ok == null)
        ? null
        : actionResult.effectiveOk === true || actionResult.ok === true;
      window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
        ...(actionResult || {}),
        ok,
        action,
        managerSummary,
        pending: false,
      };
      const liveResult = document.querySelector(`#${MANAGER_ID} [data-anticodex-result="action"]`);
      if (liveResult) {
        liveResult.classList.toggle("anticodex-error", ok === false);
        liveResult.removeAttribute("data-anticodex-running");
        liveResult.textContent = managerSummary;
      }
      delete pendingActions[action];
      persistManagerPendingActions();
    }
    return running;
  }

  function managerActionContinuesInBackground(action, payload) {
    const result = managerActionResult(payload);
    return MANAGER_BACKGROUND_START_ACTION_IDS.has(action)
      && result?.background === true;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function actionProgressStage(action, elapsedMs) {
    const seconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    if (action === "fastOverallNoTraffic") {
      if (seconds < 5) return "\u9636\u6bb5\uff1a\u542f\u52a8\u672c\u5730\u5feb\u68c0";
      if (seconds < 18) return "\u9636\u6bb5\uff1a\u68c0\u67e5 UI\u3001\u6a21\u578b\u548c\u672c\u5730\u7f51\u5173";
      return "\u9636\u6bb5\uff1a\u7b49\u5f85\u5feb\u68c0\u6536\u5c3e";
    }
    if (action === "overallNoTraffic") {
      if (seconds < 10) return "\u9636\u6bb5\uff1a\u542f\u52a8\u5b8c\u6574\u65e0\u6d41\u91cf\u68c0\u67e5";
      if (seconds < 35) return "\u9636\u6bb5\uff1a\u68c0\u67e5 Manager\u3001MCP/Skill \u548c\u63d2\u4ef6";
      if (seconds < 70) return "\u9636\u6bb5\uff1a\u68c0\u67e5\u540c\u6b65\u3001\u56de\u6eda\u548c\u56fe\u6807\u8d44\u6e90";
      return "\u9636\u6bb5\uff1a\u5b8c\u6574\u68c0\u67e5\u4ecd\u5728\u8fd0\u884c\uff0c\u8bf7\u7ee7\u7eed\u7b49\u5f85";
    }
    if (action === "syncReadiness") {
      if (seconds < 8) return "\u9636\u6bb5\uff1a\u8bfb\u53d6\u5b89\u88c5\u548c\u540c\u6b65\u6807\u8bb0";
      if (seconds < 20) return "\u9636\u6bb5\uff1a\u6821\u9a8c\u56fe\u6807\u3001\u56de\u6eda\u548c\u5feb\u6377\u65b9\u5f0f";
      return "\u9636\u6bb5\uff1a\u540c\u6b65\u5c31\u7eea\u68c0\u67e5\u6536\u5c3e";
    }
    if (action === "syncHost") {
      if (seconds < 8) return "\u9636\u6bb5\uff1a\u6821\u9a8c CodexPlusPlus \u5019\u9009\u7ec4\u4ef6";
      if (seconds < 25) return "\u9636\u6bb5\uff1a\u6821\u9a8c\u54c1\u724c\u3001\u56fe\u6807\u548c\u5b89\u5168\u6807\u8bb0";
      return "\u9636\u6bb5\uff1a\u7b49\u5f85\u540e\u53f0\u540c\u6b65\u7ed3\u679c\uff0c\u8bf7\u4e0d\u8981\u91cd\u590d\u70b9\u51fb";
    }
    if (action === "postVerificationFull") {
      if (seconds < 10) return "\u9636\u6bb5\uff1a\u51c6\u5907\u771f\u5b9e\u6d41\u91cf\u9a8c\u8bc1";
      if (seconds < 60) return "\u9636\u6bb5\uff1a\u6b63\u5728\u8dd1\u6a21\u578b\u3001\u5de5\u5177\u548c\u7a33\u5b9a\u6027\u68c0\u67e5";
      return "\u9636\u6bb5\uff1a\u5b8c\u6574\u9a8c\u8bc1\u4ecd\u5728\u8fd0\u884c\uff0c\u53ef\u7a0d\u540e\u5237\u65b0\u72b6\u6001";
    }
    if (action === "stabilitySoak") {
      if (seconds < 10) return "\u9636\u6bb5\uff1a\u51c6\u5907\u7a33\u5b9a\u6027\u5de1\u68c0";
      if (seconds < 60) return "\u9636\u6bb5\uff1a\u6b63\u5728\u6267\u884c\u771f\u5b9e Antigravity \u6d41\u91cf\u5de1\u68c0";
      return "\u9636\u6bb5\uff1a\u5de1\u68c0\u4ecd\u5728\u540e\u53f0\u8fd0\u884c\uff0c\u53ef\u7a0d\u540e\u67e5\u770b\u6700\u65b0\u62a5\u544a";
    }
    if (action === "coldRelaunch") {
      if (seconds < 10) return "\u9636\u6bb5\uff1a\u51c6\u5907\u51b7\u542f\u52a8\u9a8c\u8bc1";
      if (seconds < 60) return "\u9636\u6bb5\uff1a\u91cd\u542f Anti-Codex \u5e76\u68c0\u67e5\u672c\u5730\u8fde\u63a5";
      return "\u9636\u6bb5\uff1a\u51b7\u542f\u52a8\u9a8c\u8bc1\u4ecd\u5728\u540e\u53f0\u8fd0\u884c\uff0c\u53ef\u7a0d\u540e\u67e5\u770b\u6700\u65b0\u62a5\u544a";
    }
    if (action === "accountProxy") return seconds < 8 ? "\u9636\u6bb5\uff1a\u68c0\u67e5 Antigravity \u8d26\u53f7\u548c\u4ee3\u7406" : "\u9636\u6bb5\uff1a\u7b49\u5f85\u8d26\u53f7/\u4ee3\u7406\u8bca\u65ad\u7ed3\u679c";
    if (seconds < 5) return "\u9636\u6bb5\uff1a\u63d0\u4ea4\u672c\u5730\u68c0\u67e5\u8bf7\u6c42";
    if (seconds < 15) return "\u9636\u6bb5\uff1a\u7b49\u5f85\u672c\u5730\u811a\u672c\u8fd4\u56de";
    return "\u9636\u6bb5\uff1a\u4ecd\u5728\u8fd0\u884c\uff0c\u5b8c\u6210\u540e\u4f1a\u81ea\u52a8\u66f4\u65b0";
  }

  function runningText(action, label, elapsedMs = 0) {
    const seconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    const prefix = `\u6b63\u5728\u8fd0\u884c\uff1a${label} ...`;
    const progress = `\u5df2\u7528\u65f6\uff1a${seconds} \u79d2\n${actionProgressStage(action, elapsedMs)}`;
    if (action === "accountSwitch") return `${prefix}\n${progress}\n\u53ea\u4f1a\u6253\u5f00\u6216\u805a\u7126 Antigravity \u684c\u9762\u7aef\uff0c\u4e0d\u4f1a\u8fdb\u5165 ChatGPT \u767b\u5f55\u3002`;
    if (action === "fastOverallNoTraffic") return `${prefix}\n${progress}\n\u9884\u8ba1 40-90 \u79d2\uff0c\u4e0d\u6d88\u8017 Antigravity \u6d41\u91cf\uff0c\u7528\u4e8e\u65e5\u5e38\u5feb\u901f\u6392\u67e5\u3002`;
    if (action === "overallNoTraffic") return `${prefix}\n${progress}\n\u9884\u8ba1 1 \u5206\u949f\u5de6\u53f3\uff0c\u4e0d\u6d88\u8017 Antigravity \u6d41\u91cf\u3002\u8fd0\u884c\u671f\u95f4\u4f1a\u6682\u65f6\u7981\u7528\u5176\u4ed6\u6309\u94ae\uff0c\u9632\u6b62\u91cd\u590d\u542f\u52a8\u3002`;
    if (action === "syncHost") return `${prefix}\n${progress}\n\u8fd9\u662f\u540e\u53f0\u540c\u6b65\u4efb\u52a1\uff1a\u5148\u6821\u9a8c CodexPlusPlus \u5019\u9009\u7ec4\u4ef6\uff0c\u901a\u8fc7\u540e\u624d\u6784\u5efa\u5ba2\u6237\u7aef\u5019\u9009\u7248\uff0c\u9a8c\u8bc1\u901a\u8fc7\u624d\u66ff\u6362\u5f53\u524d Anti-Codex\u3002`;
    if (action === "postVerificationFull") return `${prefix}\n${progress}\n\u8fd9\u4e2a\u4efb\u52a1\u4f1a\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff0c\u8bf7\u4e0d\u8981\u91cd\u590d\u70b9\u51fb\u3002`;
    if (action === "stabilitySoak") return `${prefix}\n${progress}\n\u8fd9\u4e2a\u4efb\u52a1\u4f1a\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff0c\u5b8c\u6210\u540e\u8bf7\u67e5\u770b\u6700\u65b0\u62a5\u544a\u3002`;
    if (action === "coldRelaunch") return `${prefix}\n${progress}\n\u8fd9\u4e2a\u4efb\u52a1\u4f1a\u91cd\u542f Anti-Codex\uff0c\u5b8c\u6210\u540e\u8bf7\u67e5\u770b latest-cold-relaunch.json\u3002`;
    return `${prefix}\n${progress}`;
  }

  function modelLabelFromId(id) {
    const text = String(id || "");
    if (!text) return "";
    const effort = text.match(/(?:^|-)(extra-low|low|medium|high|thinking|agent)$/i)?.[1] || "";
    const effortLabel = effort
      ? ` (${effort.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")})`
      : "";
    const base = text
      .replace(/-(extra-low|low|medium|high|thinking|agent)$/i, "")
      .split("-")
      .filter(Boolean)
      .map((part) => {
        if (/^gpt$/i.test(part)) return "GPT";
        if (/^oss$/i.test(part)) return "OSS";
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
    return `${base}${effortLabel}`.trim();
  }

  function collectionCount(payload, keys = []) {
    if (Array.isArray(payload)) return payload.length;
    for (const key of keys) {
      if (Array.isArray(payload?.[key])) return payload[key].length;
    }
    if (Number.isFinite(payload?.Count)) return payload.Count;
    if (Number.isFinite(payload?.count)) return payload.count;
    return "\u672a\u77e5";
  }

  function collectionItems(payload, keys = []) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    return [];
  }

  function authorizedConnectorCount(payload) {
    return collectionItems(payload, ["connectors", "data", "items"]).filter((item) => item?.isAccessible === true).length;
  }

  function installedCheckState(item) {
    if (!item?.present) return "\u6682\u65e0\u8bb0\u5f55";
    const status = item.ok ? "\u901a\u8fc7" : "\u5931\u8d25";
    const elapsed = Number.isFinite(Number(item.elapsedMs)) ? `${Number(item.elapsedMs)} ms` : "\u8017\u65f6\u672a\u77e5";
    return `${status} / ${elapsed}`;
  }

  function updateOperationStateText(operation) {
    return ({
      idle: "\u7a7a\u95f2",
      running: "\u6b63\u5728\u8fdb\u884c",
      succeeded: "\u540c\u6b65\u6210\u529f",
      failed: "\u64cd\u4f5c\u5931\u8d25",
      rolled_back: "\u5df2\u56de\u6eda",
    })[operation?.state] || "\u672a\u77e5";
  }

  function updateOperationStageText(operation) {
    return ({
      none: "\u65e0",
      updater_queued: "\u5df2\u6392\u961f\uff0c\u7b49\u5f85\u66f4\u65b0\u4efb\u52a1",
      updater_handoff: "\u66f4\u65b0\u4efb\u52a1\u5df2\u63a5\u7ba1",
      updater_handoff_failed: "\u66f4\u65b0\u4efb\u52a1\u4ea4\u63a5\u5931\u8d25",
      component_preflight: "\u6821\u9a8c CodexPlusPlus \u5019\u9009\u7ec4\u4ef6",
      component_candidate: "\u51c6\u5907 CodexPlusPlus \u5019\u9009\u7ec4\u4ef6",
      candidate_build: "\u6784\u5efa\u5019\u9009\u7248",
      candidate_validation: "\u6821\u9a8c\u5019\u9009\u7248",
      stopping_host: "\u505c\u6b62\u5f53\u524d\u5ba2\u6237\u7aef",
      activation: "\u5207\u6362\u5ba2\u6237\u7aef\u4e3b\u4f53",
      feature_refresh: "\u5237\u65b0\u672c\u5730\u529f\u80fd",
      restart: "\u91cd\u542f Anti-Codex",
      acceptance: "\u9a8c\u6536\u65b0\u7248\u672c",
      rollback_validation: "\u6821\u9a8c\u56de\u6eda\u7248\u672c",
      rollback_stopping_host: "\u505c\u6b62\u5f53\u524d\u5ba2\u6237\u7aef",
      rollback_activation: "\u5207\u56de\u4e0a\u4e00\u7248\u672c",
      rollback_restart: "\u91cd\u542f\u56de\u6eda\u7248\u672c",
      rollback_acceptance: "\u9a8c\u6536\u56de\u6eda\u7ed3\u679c",
      complete: "\u5df2\u5b8c\u6210",
    })[operation?.stage] || operation?.stage || "\u672a\u77e5";
  }

  function updateStatusText(updateStatus) {
    const operation = updateStatus?.operation;
    if (operation?.state === "running") return `\u6b63\u5728${updateOperationStageText(operation)}`;
    if (updateStatus?.ok !== true) return "\u66f4\u65b0\u68c0\u67e5\u4e0d\u53ef\u7528";
    return updateStatus?.updateNeeded === true ? "\u9700\u8981\u540c\u6b65" : "\u5df2\u662f\u6700\u65b0";
  }

  function updateOperationMessage(updateStatus) {
    return updateStatus?.operation?.message || (updateStatus?.ok === true ? "\u6682\u65e0" : (updateStatus?.reason || "\u672a\u68c0\u67e5"));
  }

  function updateOriginalFailureText(operation) {
    const failure = operation?.originalFailure;
    if (!failure || typeof failure !== "object") return "";
    return [
      updateOperationStageText({ stage: failure.stage }),
      failure.message,
      failure.error ? `\u9519\u8bef\uff1a${failure.error}` : "",
      failure.at,
    ].filter(Boolean).join(" / ");
  }

  function longTaskStatusText(item) {
    return ({
      running: "\u6b63\u5728\u8fd0\u884c",
      attention: "\u9700\u8981\u5904\u7406",
      completed: "\u5df2\u5b8c\u6210",
      idle: "\u7a7a\u95f2",
      not_checked: "\u6682\u65e0\u8bb0\u5f55",
    })[item?.state] || item?.rawState || "\u672a\u77e5";
  }

  function longTaskRows(longTasks) {
    const items = Array.isArray(longTasks?.items) ? longTasks.items : [];
    const sync = items.find((item) => item?.id === "syncHost") || {};
    const post = items.find((item) => item?.id === "postVerificationFull") || {};
    const otherRunningItems = items.filter((item) => item?.id !== "syncHost" && item?.id !== "postVerificationFull" && (item?.state === "running" || item?.rawState === "running" || item?.stage === "manager_foreground"));
    const otherRunningText = otherRunningItems.length
      ? otherRunningItems.slice(0, 3).map((item) => item?.label || item?.id || item?.stage || "\u6b63\u5728\u8fd0\u884c").join(", ")
      : "\u6682\u65e0";
    const latest = [post, sync].find((item) => item?.latestLogLine) || {};
    const latestAge = formatReportAge(latest.logAgeMs);
    return [
      ["\u6b63\u5728\u8fd0\u884c", longTasks?.runningCount ?? 0],
      ["\u9700\u5904\u7406", longTasks?.attentionCount ?? 0],
      ["Codex \u540c\u6b65", longTaskStatusText(sync)],
      ["\u540c\u6b65\u9636\u6bb5", sync.stage || "\u6682\u65e0"],
      ["\u5b8c\u6574\u9a8c\u8bc1", longTaskStatusText(post)],
      ["\u9a8c\u8bc1\u9636\u6bb5", post.stage || "\u6682\u65e0"],
      ["\u5176\u4ed6\u8fd0\u884c", otherRunningText],
      ["\u6700\u65b0\u72b6\u6001", latest.latestLogLine || "\u6682\u65e0"],
      ["\u72b6\u6001\u66f4\u65b0", latestAge || latest.logUpdatedAt || "\u6682\u65e0"],
      ["\u6700\u8fd1\u62a5\u544a", post.reportPath || sync.reportPath || "\u6682\u65e0"],
      ["\u8bf4\u660e", (post.hint || sync.hint || "\u957f\u4efb\u52a1\u72b6\u6001\u6765\u81ea\u672c\u5730\u62a5\u544a\uff0c\u5237\u65b0\u72b6\u6001\u5373\u53ef\u67e5\u770b")],
    ];
  }

  async function openManager() {
    document.getElementById(LEGACY_BUTTON_ID)?.remove();
    const existing = document.getElementById(MANAGER_ID);
    if (existing) {
      existing.setAttribute("data-anticodex-open-refresh", String(Date.now()));
      await window.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
      return;
    }
    if (window.__ANTICODEX_MANAGER_STATUS_TIMER__) {
      clearInterval(window.__ANTICODEX_MANAGER_STATUS_TIMER__);
      delete window.__ANTICODEX_MANAGER_STATUS_TIMER__;
    }
    resetHighImpactConfirmation();

    const style = el("style", { text: `
      #${MANAGER_ID}{color-scheme:dark;--ac-bg:#171717;--ac-surface:#1d1d1d;--ac-raised:#232323;--ac-hover:#2b2b2b;--ac-input-bg:#181818;--ac-line:rgba(255,255,255,.09);--ac-line-strong:rgba(255,255,255,.14);--ac-text:#f3f3f3;--ac-muted:#9b9b9b;--ac-value:#e8e8e8;--ac-result:#dedede;--ac-error:#ffb4bc;--ac-warn:#e8c98a;--ac-focus:#8c8c8c;--ac-backdrop:rgba(0,0,0,.68);--ac-shadow:rgba(0,0,0,.56);--ac-close-active:#303030;--ac-button-hover-line:rgba(255,255,255,.2);--ac-danger:#4b2228;--ac-danger-hover:#5b2830;--ac-danger-active:#682e37;--ac-danger-line:#783740;--ac-danger-hover-line:#914650;--ac-danger-text:#ffd8dd;--ac-danger-section:#21191b;--ac-danger-section-line:rgba(120,55,64,.52);position:fixed;inset:0;z-index:2147483647;background:var(--ac-backdrop);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:28px;font-family:"Segoe UI",Microsoft YaHei,sans-serif;color:var(--ac-text);-webkit-app-region:no-drag}
      #${MANAGER_ID}[data-anticodex-theme="light"]{color-scheme:light;--ac-bg:#f7f7f7;--ac-surface:#fff;--ac-raised:#f1f1f1;--ac-hover:#e7e7e7;--ac-input-bg:#fff;--ac-line:rgba(0,0,0,.08);--ac-line-strong:rgba(0,0,0,.14);--ac-text:#1f1f1f;--ac-muted:#666;--ac-value:#292929;--ac-result:#333;--ac-error:#a52a3a;--ac-warn:#805d14;--ac-focus:#555;--ac-backdrop:rgba(20,20,20,.24);--ac-shadow:rgba(0,0,0,.22);--ac-close-active:#ddd;--ac-button-hover-line:rgba(0,0,0,.2);--ac-danger:#6e2832;--ac-danger-hover:#7a303b;--ac-danger-active:#842f3c;--ac-danger-line:#8e3d49;--ac-danger-hover-line:#9d4a56;--ac-danger-text:#fff4f5;--ac-danger-section:#fbf1f2;--ac-danger-section-line:rgba(122,48,59,.25)}
      #${MANAGER_ID}[data-anticodex-theme="dark"]{color-scheme:dark}
      #${MANAGER_ID} *{box-sizing:border-box}
      .anticodex-panel{width:min(1080px,96vw);height:min(840px,92vh);overflow:auto;border-radius:14px;background:var(--ac-bg);border:1px solid var(--ac-line-strong);box-shadow:0 28px 90px var(--ac-shadow);padding:0 20px 20px}
      .anticodex-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px;padding:22px 2px 0;position:sticky;top:0;z-index:3;background:var(--ac-bg)}
      .anticodex-head h1{font-size:20px;line-height:1.3;letter-spacing:-.2px;margin:0 0 5px;font-weight:650}.anticodex-head p{margin:0;color:var(--ac-muted);font-size:12px}.anticodex-head-tools{display:flex;gap:8px;align-items:center}
      .anticodex-prompt-settings{border:1px solid var(--ac-line);border-radius:9px;min-height:44px;padding:0 14px;background:var(--ac-raised);color:var(--ac-text);cursor:pointer;font:600 13px "Segoe UI",Microsoft YaHei,sans-serif;white-space:nowrap}.anticodex-prompt-settings:hover{background:var(--ac-hover);border-color:var(--ac-line-strong)}
      .anticodex-close{appearance:none;border:1px solid var(--ac-line);border-radius:9px;min-width:88px;width:88px;min-height:44px;height:48px;margin:0;padding:0;display:inline-flex;align-items:center;justify-content:center;line-height:1;background:var(--ac-raised);color:transparent;cursor:pointer;touch-action:manipulation;position:relative;z-index:2;pointer-events:auto;font:600 13px "Segoe UI",Microsoft YaHei,sans-serif;user-select:none;flex:0 0 auto;overflow:hidden;-webkit-app-region:no-drag}
      .anticodex-close::after{content:attr(aria-label);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--ac-text);pointer-events:none}
      .anticodex-close:hover{background:var(--ac-hover);border-color:var(--ac-line-strong)}.anticodex-close:active{background:var(--ac-close-active)}.anticodex-close:focus-visible{outline:2px solid var(--ac-focus);outline-offset:2px}
      .anticodex-actions{display:grid;gap:10px;margin:0 0 14px}
      .anticodex-action-section{border:1px solid var(--ac-line);border-radius:12px;background:var(--ac-surface);padding:13px 14px 14px}
      .anticodex-action-section>summary{color:var(--ac-text);font-size:13px;font-weight:650;cursor:pointer}.anticodex-action-section[open]>summary{margin-bottom:10px}
      .anticodex-action-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:10px}
      .anticodex-action-section h2{margin:0;color:var(--ac-text);font-size:13px;font-weight:650}.anticodex-action-section p{margin:0;color:var(--ac-muted);font-size:11px;text-align:right}
      .anticodex-action-list{display:flex;flex-wrap:wrap;gap:7px}
      .anticodex-actions button{border:1px solid var(--ac-line-strong);border-radius:8px;min-height:40px;padding:0 13px;display:inline-flex;align-items:center;justify-content:center;line-height:1.15;background:var(--ac-raised);color:var(--ac-text);cursor:pointer;font:600 12px "Segoe UI",Microsoft YaHei,sans-serif;touch-action:manipulation;transition:background .12s ease,border-color .12s ease,transform .12s ease}
      .anticodex-actions button:hover{background:var(--ac-hover);border-color:var(--ac-button-hover-line)}.anticodex-actions button:active{transform:translateY(1px)}.anticodex-actions button:focus-visible{outline:2px solid var(--ac-focus);outline-offset:2px}.anticodex-actions button:disabled{opacity:.55;cursor:wait;transform:none}
      .anticodex-actions button.anticodex-action-danger{background:var(--ac-danger);border-color:var(--ac-danger-line);color:var(--ac-danger-text)}.anticodex-actions button.anticodex-action-danger:hover{background:var(--ac-danger-hover);border-color:var(--ac-danger-hover-line)}.anticodex-actions button.anticodex-action-danger:active{background:var(--ac-danger-active)}
      .anticodex-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.anticodex-card{border:1px solid var(--ac-line);background:var(--ac-surface);border-radius:12px;padding:14px;min-height:112px}
      .anticodex-card h2{font-size:13px;font-weight:650;margin:0 0 10px;color:var(--ac-text)}.anticodex-kv{display:grid;grid-template-columns:130px 1fr;gap:7px 10px;font-size:12px}.anticodex-k{color:var(--ac-muted)}.anticodex-v{color:var(--ac-value);word-break:break-word}
      .anticodex-result{white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--ac-result)}.anticodex-wide{grid-column:1/-1}.anticodex-error{color:var(--ac-error)}.anticodex-loading{color:var(--ac-muted)}.anticodex-warn{color:var(--ac-warn)}
      .anticodex-result-card{scroll-margin-top:78px}
      .anticodex-form-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .anticodex-form-actions button{border:1px solid var(--ac-line-strong);border-radius:8px;min-height:40px;padding:0 14px;background:var(--ac-raised);color:var(--ac-text);font:600 12px "Segoe UI",Microsoft YaHei,sans-serif;cursor:pointer}
      .anticodex-form-actions button:hover:not(:disabled){background:var(--ac-hover);border-color:var(--ac-button-hover-line)}.anticodex-form-actions button:disabled{opacity:.55;cursor:not-allowed}
      .anticodex-form-hint{font-size:12px;line-height:1.5;color:var(--ac-muted)}
      .anticodex-result-tools{display:flex;justify-content:flex-end;margin-top:10px}.anticodex-copy-result{border:1px solid var(--ac-line-strong);border-radius:8px;min-height:34px;padding:0 12px;background:var(--ac-raised);color:var(--ac-text);font:600 12px "Segoe UI",Microsoft YaHei,sans-serif;cursor:pointer}.anticodex-copy-result:hover{background:var(--ac-hover);border-color:var(--ac-button-hover-line)}
      .anticodex-connector-allowlist-input{width:100%;min-height:86px;resize:vertical;border:1px solid var(--ac-line);border-radius:10px;background:var(--ac-input-bg);color:var(--ac-text);padding:10px 11px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
      .anticodex-connector-allowlist-input:focus{outline:2px solid var(--ac-focus);outline-offset:2px}
      @media(max-width:820px){#${MANAGER_ID}{padding:12px}.anticodex-grid{grid-template-columns:1fr}.anticodex-panel{padding:0 15px 15px}.anticodex-head{padding-top:17px;gap:10px}.anticodex-prompt-settings{padding:0 10px}.anticodex-close{min-width:72px;width:72px}.anticodex-kv{grid-template-columns:1fr}.anticodex-action-section-head{display:block}.anticodex-action-section p{text-align:left;margin-top:3px}}
    ` });
    const root = el("div", { id: MANAGER_ID, role: "dialog", "aria-label": MANAGER_LABEL, "data-anticodex-manager-version": VERSION, "data-anticodex-manager-view": "status", "data-anticodex-busy": "false" });
    const panel = el("div", { className: "anticodex-panel" });
    const title = el("div", {}, [
      el("h1", { text: MANAGER_LABEL }),
      el("p", { text: "\u5185\u7f6e\u9762\u677f\uff1a\u4e0d\u8d70 ChatGPT \u767b\u5f55\uff0c\u4e0d\u6d88\u8017\u6a21\u578b\u6d41\u91cf\u3002" }),
    ]);
    const close = el("button", { className: "anticodex-close", type: "button", "data-anticodex-close": "true", "aria-label": CLOSE_TEXT });
    const closeManagerFromEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeManager();
    };
    close.onclick = closeManagerFromEvent;
    const statusTabButton = el("button", { className: "anticodex-prompt-settings", type: "button", role: "tab", "aria-selected": "true", text: "状态" });
    const accountSettingsButton = el("button", { className: "anticodex-prompt-settings", type: "button", role: "tab", "aria-selected": "false", "data-anticodex-account-settings": "true", text: "账号管理" });
    const promptSettingsButton = el("button", { className: "anticodex-prompt-settings", type: "button", role: "tab", "aria-selected": "false", "data-anticodex-prompt-settings": "true", text: "提示词" });
    const tabs = el("div", { role: "tablist", "aria-label": "管理页面", style: "display:flex;gap:6px;flex-wrap:wrap" }, [statusTabButton, accountSettingsButton, promptSettingsButton]);
    const head = el("div", { className: "anticodex-head" }, [title, el("div", { className: "anticodex-head-tools" }, [tabs, close])]);
    style.textContent += `
      [data-anticodex-manager-view=accounts] .anticodex-panel{width:min(1500px,98vw);height:min(1040px,97vh);display:flex;flex-direction:column;overflow:hidden;padding:0 8px 6px}
      [data-anticodex-manager-view=accounts] .anticodex-head{padding:14px 0 12px;margin:0;flex-shrink:0}
      [data-anticodex-manager-view=accounts] .anticodex-grid{display:block;overflow:auto;min-height:0;flex:1}
      [data-anticodex-manager-view=accounts] .anticodex-result-card{display:none}
      .anticodex-account-list{grid-column:1/-1;display:grid;gap:0}
      .anticodex-account-list h2{font-size:13px;margin:0 0 4px}
      .anticodex-account-toolbar{display:flex;gap:1px;flex-wrap:wrap;align-items:center;margin-bottom:1px}
      .anticodex-account-toolbar button{min-height:21px;padding:1px 3px;font-size:9px}
      .anticodex-account-row{display:grid;grid-template-columns:minmax(86px,.61fr) minmax(104px,1fr) minmax(104px,1fr) 104px;gap:4px;padding:3px 3px;border-top:1px solid var(--ac-line);align-items:start}
      .anticodex-account-row[data-active=true]{background:color-mix(in srgb,#71c59a 7%,transparent)}
      .anticodex-account-row[data-pending=true]{background:var(--ac-raised)}
      .anticodex-account-identity{overflow-wrap:anywhere;font-size:11px}.anticodex-account-identity strong{display:block;margin-bottom:2px}
      .anticodex-account-meta{font-size:8.4px;color:var(--ac-muted);line-height:1.14;overflow-wrap:anywhere}
      .anticodex-account-badge{display:inline-block;border:1px solid #71c59a;color:#71c59a;padding:0 4px;border-radius:4px;margin:1px 0 0;font-size:8.6px}
      .anticodex-account-group{display:grid;gap:2px;align-content:start}.anticodex-account-group h3{font-size:11px;margin:0}
      .anticodex-quota-title{display:flex;justify-content:space-between;gap:8px;font-size:12px;max-width:120px}
      .anticodex-quota-bucket{display:grid;grid-template-columns:minmax(0,58px) auto;column-gap:10px;align-items:center}
      .anticodex-quota-bucket .anticodex-quota-track{grid-row:2;grid-column:1}
      .anticodex-quota-bucket .anticodex-account-meta{grid-row:1;grid-column:2;font-size:10px;white-space:nowrap}
      .anticodex-quota-track{height:4px;width:100%;max-width:52px;border-radius:3px;background:var(--ac-line);overflow:hidden;margin:3px 0}
      .anticodex-quota-fill{height:100%;background:#71c59a}.anticodex-quota-low{background:#e98773}
      .anticodex-account-controls{display:grid;grid-template-columns:1fr 1fr;gap:2px;align-content:start}.anticodex-account-controls button{min-height:21px;padding:1px 3px;font-size:8.5px}
      .anticodex-account-feedback{position:sticky;top:0;z-index:2;background:var(--ac-bg);padding:3px 4px;font-size:9.2px;min-height:21px;line-height:1.14;border-bottom:1px solid var(--ac-line)}
      .anticodex-account-inline-status{grid-column:1/-1;font-size:8.8px;line-height:1.18;color:var(--ac-muted)}
      .anticodex-account-feedback[aria-busy=true]::before{content:'◌';display:inline-block;margin-right:6px;animation:anticodex-account-spin 1s linear infinite}
      @keyframes anticodex-account-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){.anticodex-account-feedback[aria-busy=true]::before{animation:none}}
      .anticodex-head [role=tab][aria-selected=true]{border-color:#71c59a;color:#71c59a}
      @media(max-width:1000px){.anticodex-account-row{gap:5px;grid-template-columns:minmax(86px,.62fr) minmax(108px,1fr) minmax(108px,1fr) 104px;padding:4px 3px}}
      @media(max-width:1000px){.anticodex-quota-bucket{display:block}}
      @media(max-width:680px){.anticodex-account-row{grid-template-columns:1fr 1fr}.anticodex-account-identity,.anticodex-account-controls{grid-column:1/-1}.anticodex-account-controls{display:flex;flex-wrap:wrap}}
    `;
    const actions = el("div", { className: "anticodex-actions" });
    const grid = el("div", { className: "anticodex-grid" });
    grid.replaceChildren(card("\u6b63\u5728\u8bfb\u53d6", el("div", { className: "anticodex-result anticodex-loading", text: "\u6b63\u5728\u8bfb\u53d6\u672c\u5730\u72b6\u6001\uff0c\u9762\u677f\u4e0d\u4f1a\u6253\u5f00 ChatGPT \u767b\u5f55\u3002" })));
    const result = el("div", { className: "anticodex-result", "data-anticodex-result": "action", text: "\u6b63\u5728\u8bfb\u53d6\u72b6\u6001 ..." });
    const lastActionResult = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    const lastActionSummary = String(lastActionResult?.managerSummary || "");
    const preserveLastActionResult = Boolean(
      lastActionSummary &&
      lastActionResult.uiOnly !== true &&
      !lastActionSummary.includes("ui-only manager button smoke")
    );
    if (preserveLastActionResult) {
      result.textContent = lastActionSummary;
      result.classList.toggle("anticodex-error", lastActionResult.ok === false);
    }
    const copyResultButton = el("button", { type: "button", className: "anticodex-copy-result", text: "\u590d\u5236\u7ed3\u679c" });
    copyResultButton.onclick = async () => {
      try {
        await copyTextToClipboard(result.textContent || "");
        copyResultButton.textContent = "\u5df2\u590d\u5236";
      } catch (error) {
        copyResultButton.textContent = "\u590d\u5236\u5931\u8d25";
      } finally {
        setTimeout(() => { copyResultButton.textContent = "\u590d\u5236\u7ed3\u679c"; }, 1600);
      }
    };
    const resultBody = el("div", {}, [
      result,
      el("div", { className: "anticodex-result-tools" }, [copyResultButton]),
    ]);
    let actionGeneration = 0;
    let actionInFlight = false;
    let managerOperationInFlight = false;
    let managerOperationGeneration = 0;
    let managerView = "status";
    let managerInitialLoadPromise = null;
    let accountConfirmation = null;
    function updateManagerTabs(view) {
      for (const [name, button] of [["status", statusTabButton], ["accounts", accountSettingsButton], ["prompts", promptSettingsButton]]) {
        button.setAttribute("aria-selected", name === view ? "true" : "false");
      }
    }

    function setManagerOperationBusy(busy) {
      managerOperationInFlight = Boolean(busy);
      root.setAttribute("data-anticodex-busy", managerOperationInFlight ? "true" : "false");
      for (const tab of [statusTabButton, accountSettingsButton, promptSettingsButton]) tab.disabled = managerOperationInFlight;
    }

    async function runManagerExclusive(operation, { waitForInitial = true } = {}) {
      if (!root.isConnected) return false;
      const pendingAction = Object.keys(window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ || {}).find(actionStillPending);
      const reportedAction = managerSnapshotRunningActionIds(window.__ANTICODEX_MANAGER_SNAPSHOT__).values().next().value || "";
      if (managerOperationInFlight || actionInFlight || window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ || pendingAction || reportedAction) {
        result.classList.remove("anticodex-error");
        result.textContent = "已有管理操作正在运行，请等待完成。";
        return false;
      }
      managerOperationGeneration += 1;
      root.setAttribute("data-anticodex-operation-generation", String(managerOperationGeneration));
      setManagerOperationBusy(true);
      try {
        if (waitForInitial && managerInitialLoadPromise) await managerInitialLoadPromise;
        if (!root.isConnected) return false;
        await operation();
        return true;
      } finally {
        setManagerOperationBusy(false);
      }
    }

    const resultCard = card("\u68c0\u67e5\u7ed3\u679c", resultBody);
    resultCard.classList.add("anticodex-result-card");
    const resultCardTitle = resultCard.querySelector("h2");
    function setResultCardMode(mode) {
      resultCard.setAttribute("data-anticodex-result-mode", mode);
      if (resultCardTitle) resultCardTitle.textContent = mode === "upstream-config" ? "\u7b2c\u4e09\u65b9 API \u914d\u7f6e" : "\u68c0\u67e5\u7ed3\u679c";
    }
    panel.append(style, head, actions, grid, resultCard);
    root.append(panel);
    const closeFromRootHit = (event) => {
      if (closestEventElementOrPoint(event, "[data-anticodex-close]", root)) {
        closeManagerFromEvent(event);
        return true;
      }
      return false;
    };
    root.addEventListener("pointerup", (event) => {
      if (event.button === 0) closeFromRootHit(event);
    }, true);
    root.addEventListener("click", (event) => {
      if (closeFromRootHit(event)) return;
      if (event.target === root) removeManager();
    }, true);
    document.body.append(root);
    installManagerThemeSync(root);
    refreshManagerStatus();

    function setActionButtonsDisabled(disabled) {
      for (const item of actions.querySelectorAll("button[data-action]")) item.disabled = !!disabled;
      actions.setAttribute("data-anticodex-busy", disabled ? "true" : "false");
    }

    async function load(options = {}) {
      if (managerView !== "status") return;
      setResultCardMode("status");
      const updateResult = options.updateResult !== false;
      const loadGeneration = actionGeneration;
      try {
        await ensureSnapshotForLoad();
        reconcileManagerPendingActions(window.__ANTICODEX_MANAGER_SNAPSHOT__);
        const snapshotReadOptions = { preferSnapshot: true };
        const [bootstrapResult, healthResult, modelsResult, diagnosticsResult, pluginsResult, connectorsResult, appToolsResult, allowlistResult, upstreamResult, routesResult] = await Promise.all([
          safeJson("/anticodex/manager/bootstrap", snapshotReadOptions),
          safeJson("/health", snapshotReadOptions),
          safeJson("/models", snapshotReadOptions),
          safeJson("/anticodex/diagnostics", { ...snapshotReadOptions, timeoutMs: DIAGNOSTICS_FETCH_TIMEOUT_MS }),
          safeJson("/backend-api/ps/plugins/installed", snapshotReadOptions),
          safeJson("/backend-api/aip/connectors", snapshotReadOptions),
          safeJson("/backend-api/wham/apps", snapshotReadOptions),
          safeJson("/anticodex/local-connectors/allowlist", snapshotReadOptions),
          safeJson("/anticodex/upstream-profile", snapshotReadOptions),
          safeJson("/anticodex/model-routes", snapshotReadOptions),
        ]);
        const bootstrap = safeValue(bootstrapResult, {});
        if (managerView !== "status" || !root.isConnected) return;
        const health = safeValue(healthResult, {});
        const models = safeValue(modelsResult, { data: [] });
        const diagnostics = safeValue(diagnosticsResult, {});
        const plugins = safeValue(pluginsResult, { plugins: [] });
        const connectors = safeValue(connectorsResult, { connectors: [] });
        const appTools = safeValue(appToolsResult, { tools: [] });
        const allowlist = safeValue(allowlistResult, { persisted: [], env: [], counts: {} });
        const upstreamProfile = safeValue(upstreamResult, {});
        const routes = safeValue(routesResult, {});
        const usingThirdParty = upstreamProfile.active === "third-party";
        const accessibleConnectors = authorizedConnectorCount(connectors);
        const loadErrors = [
          [healthResult, "\u8fd0\u884c\u72b6\u6001"],
          [modelsResult, "\u6a21\u578b"],
          [diagnosticsResult, "\u8bca\u65ad"],
          [pluginsResult, "\u63d2\u4ef6"],
          [connectorsResult, "\u8fde\u63a5\u5668"],
          [allowlistResult, "\u672c\u5730\u8fde\u63a5\u5668\u5de5\u5177"],
          [upstreamResult, "\u6a21\u578b\u901a\u9053"],
          [routesResult, "\u6700\u8fd1\u8def\u7531"],
        ].filter(([item]) => !item.ok).map(([item, label]) => {
          const rawMsg = item.error?.message || "";
          if (/Failed to fetch|fetch.*failed|networkerror|econnrefused|timed?\s*out|abort/i.test(rawMsg)) {
            return `${label}\uff1a\u672c\u5730\u72b6\u6001\u672a\u5c31\u7eea\uff08\u6682\u65e0\u672c\u5730\u7f13\u5b58\uff0c\u8bf7\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u91cd\u8bd5\uff09`;
          }
          return `${label}\uff1a${rawMsg || "\u8bfb\u53d6\u5931\u8d25"}`;
        });
        const optionalLoadErrors = [];
        if (!appToolsResult.ok && accessibleConnectors > 0) {
          optionalLoadErrors.push("\u5e94\u7528\u5de5\u5177\u6682\u4e0d\u53ef\u8bfb\uff0c\u5df2\u6309\u672a\u6388\u6743\u5904\u7406");
        }
        managerToken = bootstrap?.token || managerToken;
        const localFeatures = diagnostics?.localFeatures || {};
        const capabilityTiers = localFeatures.capabilityTiers || {};
        const skillTier = capabilityTiers.skills || {};
        const mcpTier = capabilityTiers.mcp || {};
        const pluginInventoryCount = collectionCount(plugins, ["plugins", "value", "data", "items"]);
        const connectorInventoryCount = collectionCount(connectors, ["connectors", "data", "items"]);
        const callableAppToolCount = collectionCount(appTools, ["tools", "data", "items"]);
        const snapshotStatus = localFeatures.snapshotStatus || {};
        const snapshotStateText = ({
          fresh: "\u65b0\u9c9c",
          stale: "\u5df2\u8fc7\u671f",
          invalid: "\u6807\u8bb0\u65e0\u6548",
          missing: "\u6807\u8bb0\u7f3a\u5931",
          unverified: "\u5c1a\u672a\u6838\u5bf9",
          check_failed: "\u6838\u5bf9\u5931\u8d25",
        })[snapshotStatus.state] || "\u672a\u77e5";
        const snapshotAgeText = Number.isFinite(Number(snapshotStatus.ageHours))
          ? `${Number(snapshotStatus.ageHours).toFixed(1)} \u5c0f\u65f6`
          : "\u672a\u77e5";
        const snapshotRefreshText = snapshotStatus.staleReason === "source_changed"
          ? "\u539f\u751f Codex \u672c\u5730\u529f\u80fd\u5df2\u53d8\u5316\uff0c\u8bf7\u70b9\u201c\u5237\u65b0\u672c\u5730\u529f\u80fd\u201d"
          : (snapshotStatus.state === "unverified" || snapshotStatus.state === "check_failed"
              ? "\u8bf7\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u6838\u5bf9\u5f53\u524d\u539f\u751f Codex"
              : (snapshotStatus.stale ? "\u5feb\u7167\u5df2\u8fc7\u671f\u6216\u7f3a\u5931\uff0c\u8bf7\u70b9\u201c\u5237\u65b0\u672c\u5730\u529f\u80fd\u201d" : "\u5f53\u524d\u65e0\u9700\u5237\u65b0"));
        const modelList = Array.isArray(models?.data) ? models.data : [];
        const modelText = modelList.map((model) => {
          const id = String(model?.id || "");
          const label = String(model?.display_name || model?.name || modelLabelFromId(id)).trim();
          const budget = Number(model?.thinking_budget);
          const minimum = Number(model?.min_thinking_budget);
          const budgetText = model?.supports_thinking === true
            ? `\n\u539f\u751f\u601d\u8003\u9884\u7b97\uff1a${Number.isFinite(budget) ? (budget < 0 ? "\u52a8\u6001" : budget) : "\u5df2\u652f\u6301"}${Number.isFinite(minimum) ? ` / \u6700\u4f4e ${minimum}` : ""}`
            : "";
          const identity = label && label !== id ? `${label}\n${id}` : id;
          return `${identity}${budgetText}`;
        }).filter(Boolean).join("\n\n");
        const quotaNotice = usingThirdParty ? null : quotaLimitNotice(health);
        const updateStatus = diagnostics?.updateStatus || {};
        const syncEvidence = diagnostics?.syncReadinessEvidence || syncReadinessEvidenceFromResult({ updateStatus });
        const updateOperation = updateStatus.operation || {};
        const cards = [
          quotaNotice,
          snapshotStalenessNotice(snapshotStatus, snapshotRefreshText),
          card("\u8fd0\u884c\u72b6\u6001", kv([
            ["\u4e0a\u6e38", health?.upstream],
            ["\u6a21\u578b\u901a\u9053", usingThirdParty ? ((upstreamProfile.runtime?.protocol || "third-party") + " / " + (upstreamProfile.runtime?.model || "\u672a\u77e5")) : "Antigravity"],
            [usingThirdParty ? "\u63a5\u53e3\u72b6\u6001" : "Antigravity", usingThirdParty ? "\u5df2\u914d\u7f6e" : (health?.accountReady ? "\u5df2\u5c31\u7eea" : health?.accountState)],
            ...(usingThirdParty ? [["\u80fd\u529b\u8bc1\u636e", upstreamCapabilitySummary(upstreamProfile, health)]] : []),
            ["\u6d41\u91cf", usingThirdParty ? "\u7b2c\u4e09\u65b9 API" : (health?.accountTrafficReady === true ? "\u5df2\u5c31\u7eea" : (health?.accountTrafficReady === false ? trafficDiagnosis(health) : "\u672a\u68c0\u67e5"))],
            ...(usingThirdParty ? [] : [["\u53d7\u9650\u6a21\u578b", health?.accountTrafficModel || "\u65e0"]]),
            ["\u5efa\u8bae", usingThirdParty ? "\u63a5\u53e3\u5931\u8d25\u65f6\u4e0d\u4f1a\u81ea\u52a8\u5207\u56de Antigravity" : (health?.accountTrafficSuggestedAction || "\u6682\u65e0")],
            ["\u6a21\u578b\u6570", modelList.length],
            ["\u91cd\u8fde", "\u672a\u68c0\u51fa"],
          ])),
          card("\u6a21\u578b", el("div", { className: "anticodex-result", text: modelText || "\u672a\u8bfb\u5230" })),
          card("\u6700\u8fd1\u8def\u7531", kv(routeSummaryRows(routes?.latest))),
          card("\u540c\u6b65\u72b6\u6001", kv([
            ["\u539f\u751f Codex \u7248\u672c", updateStatus?.source?.packageVersion],
            ["Anti-Codex \u7248\u672c", syncEvidence.activePackageVersion || (updateStatus?.active?.root ? "\u5df2\u5b89\u88c5" : "\u672a\u77e5")],
            ["\u66f4\u65b0\u72b6\u6001", updateStatusText(updateStatus)],
            ["\u6f02\u79fb\u72b6\u6001", syncEvidence.updateDriftState || "\u672a\u77e5"],
            ["\u6f02\u79fb\u6765\u6e90", syncEvidence.updateStatusSource || "\u672a\u77e5"],
            ["hostChanged", triStateText(syncEvidence.updateDriftHostChanged)],
            ["cliChanged", triStateText(syncEvidence.updateDriftCliChanged)],
            ["Manager bridge", `processes=${syncEvidence.managerBridgeProcessCount ?? "?"} / stale=${syncEvidence.managerBridgeStaleProcessCount ?? "?"}`],
            ["\u4efb\u52a1\u72b6\u6001", updateOperationStateText(updateOperation)],
            ["\u5f53\u524d\u9636\u6bb5", updateOperationStageText(updateOperation)],
            ["\u6700\u8fd1\u53d8\u5316", updateOperation.updatedAt || updateOperation.completedAt || updateStatus.checkedAt || "\u672a\u77e5"],
            ["\u7ed3\u679c\u8bf4\u660e", updateOperationMessage(updateStatus)],
            ...(updateOriginalFailureText(updateOperation) ? [["\u539f\u59cb\u5931\u8d25", updateOriginalFailureText(updateOperation)]] : []),
            ["\u56de\u6eda", updateOperation.rollbackAvailable === true ? "\u5df2\u4fdd\u7559\u53ef\u7528\u7248\u672c" : "\u672a\u786e\u8ba4"],
          ])),
          card("\u540e\u53f0\u4efb\u52a1", kv(longTaskRows(diagnostics?.longTasks))),
          card("\u672c\u5730\u68c0\u67e5", kv([
            ["\u4e0a\u6b21\u5feb\u68c0", installedCheckState(diagnostics?.installedChecks?.fast)],
            ["\u4e0a\u6b21\u5b8c\u6574\u65e0\u6d41\u91cf", installedCheckState(diagnostics?.installedChecks?.full)],
            ["\u5feb\u68c0\u8bc1\u636e", diagnostics?.installedChecks?.fast?.reportName || "installed-overall-fast"],
            ["\u5b8c\u6574\u8bc1\u636e", diagnostics?.installedChecks?.full?.reportName || "installed-overall"],
            ["\u8bf4\u660e", "\u5feb\u68c0\u4e0d\u4f1a\u8986\u76d6\u5b8c\u6574\u603b\u68c0\u62a5\u544a"],
          ])),
          card("\u63d2\u4ef6\u4e0e\u5e94\u7528", kv([
            ["Skill \u6307\u4ee4", `\u76ee\u5f55 ${skillTier.inventoryCount ?? localFeatures.skills?.count ?? "\u672a\u77e5"} / \u53ef\u8bfb ${skillTier.readableCount ?? "\u672a\u77e5"} / \u53ef\u6309\u9700\u4f7f\u7528 ${skillTier.usableCount ?? "\u672a\u77e5"}`],
            ["MCP \u914d\u7f6e", `${mcpTier.configuredCount ?? localFeatures.mcp?.count ?? "\u672a\u77e5"} / \u5f53\u524d\u53ef\u8c03\u7528\u4ee5\u672c\u4f1a\u8bdd\u5de5\u5177\u5217\u8868\u4e3a\u51c6`],
            ["\u672c\u5730\u63d2\u4ef6\u76ee\u5f55", `${pluginInventoryCount} / \u5143\u6570\u636e\u53ef\u89c1 / \u4e0d\u7b49\u4e8e\u53ef\u8c03\u7528`],
            ["\u8fdc\u7a0b\u8fde\u63a5\u5668\u4ec5\u76ee\u5f55", connectorInventoryCount],
            ["\u8fdc\u7a0b\u5df2\u6388\u6743", accessibleConnectors],
            ["\u672c\u5730\u7f13\u5b58\u9884\u89c8", allowlist?.counts?.localAllowlisted ?? allowlist?.counts?.locallyAuthorized ?? 0],
            ["\u771f\u5b9e\u53ef\u8c03\u7528\u5e94\u7528\u5de5\u5177", callableAppToolCount],
            ["\u5feb\u7167", `\u8fde\u63a5\u5668 ${localFeatures.snapshots?.connectorDirectoryFiles ?? "\u672a\u77e5"} / \u5e94\u7528\u5de5\u5177 ${localFeatures.snapshots?.appToolsCacheFiles ?? "\u672a\u77e5"}`],
            ["\u5feb\u7167\u65b0\u9c9c\u5ea6", `${snapshotStateText} / \u5df2\u7528 ${snapshotAgeText} / \u4e0a\u9650 ${snapshotStatus.maxAgeHours ?? 24} \u5c0f\u65f6`],
            ["\u5237\u65b0\u65b9\u5f0f", snapshotRefreshText],
            ["\u53ef\u8c03\u7528\u72b6\u6001", accessibleConnectors > 0 ? "\u4ec5\u663e\u793a\u771f\u5b9e\u6388\u6743\u540e\u53ef\u8c03\u7528\u7684\u5e94\u7528\u5de5\u5177" : "\u672a\u6388\u6743\u8fde\u63a5\u5668\u4e0d\u4f2a\u88c5\u6210\u53ef\u8c03\u7528\u5de5\u5177"],
            ["\u8bf4\u660e", "Skill \u662f\u672c\u5730\u6307\u4ee4\uff1bMCP \u5fc5\u987b\u7531\u5f53\u524d\u4f1a\u8bdd\u771f\u5b9e\u66b4\u9732\u5de5\u5177\uff1b\u63d2\u4ef6/\u8fde\u63a5\u5668\u76ee\u5f55\u4e0d\u4ee3\u8868\u53ef\u8c03\u7528\uff1b\u672c\u5730\u7f13\u5b58\u9884\u89c8\u4e0d\u6388\u6743\u3002"],
            ["\u7ee7\u627f\u72b6\u6001", localFeatures.skills?.requiredPresent?.length ? `\u5df2\u7ee7\u627f ${localFeatures.skills.requiredPresent.join(", ")}` : "\u53ef\u901a\u8fc7\u6309\u94ae\u68c0\u67e5\u548c\u5237\u65b0"],
            optionalLoadErrors.length ? ["\u8865\u5145\u63d0\u793a", optionalLoadErrors.join("\n")] : null,
          ].filter(Boolean))),
          card("\u672c\u5730\u8fde\u63a5\u5668\u5de5\u5177", connectorAllowlistEditor(allowlist, result, load, runManagerExclusive)),
        ].filter(Boolean);
        grid.replaceChildren(...cards);
        result.classList.toggle("anticodex-error", loadErrors.length > 0);
        if (managerView === "status" && updateResult && !actionInFlight && loadGeneration === actionGeneration) {
          result.textContent = loadErrors.length
            ? `\u72b6\u6001\u5df2\u90e8\u5206\u5237\u65b0\uff0c\u4ee5\u4e0b\u9879\u9700\u590d\u6838\uff1a\n${loadErrors.join("\n")}`
            : "\u72b6\u6001\u5df2\u5237\u65b0\u3002";
        }
      } catch (error) {
        if (managerView === "status" && updateResult && !actionInFlight && loadGeneration === actionGeneration) {
          result.classList.add("anticodex-error");
          result.textContent = "\u8bfb\u53d6\u5931\u8d25\uff1a" + error.message;
        }
      }
    }

    window.__ANTICODEX_REFRESH_MANAGER_PANEL__ = () => load({ updateResult: false });

    function accountResetText(value) {
      const reset = Date.parse(value || "");
      if (!Number.isFinite(reset)) return "恢复时间未知";
      const minutes = Math.ceil((reset - Date.now()) / 60000);
      if (minutes <= 0) return "已到恢复时间，请刷新确认";
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      return `${days ? days + "天 " : ""}${hours}小时 ${minutes % 60}分后恢复`;
    }

    function setAccountFeedback(message, failed = false) {
      result.textContent = message;
      result.classList.toggle("anticodex-error", failed);
      const feedback = root.querySelector("[data-account-feedback]");
      if (feedback) { feedback.textContent = message; feedback.classList.toggle("anticodex-error", failed); }
      const inline = root.querySelector("[data-pending=true] .anticodex-account-inline-status");
      if (inline) inline.textContent = message;
    }

    function setAccountBusy(busy, id = "") {
      for (const item of grid.querySelectorAll("button,input")) item.disabled = busy;
      root.querySelector("[data-account-feedback]")?.setAttribute("aria-busy", String(busy));
      for (const row of grid.querySelectorAll("[data-account-id]")) {
        row.setAttribute("data-pending", String(busy && row.getAttribute("data-account-id") === id));
        if (!busy) row.querySelector(".anticodex-account-inline-status").textContent = "";
      }
    }

    function accountQuotaBuckets(group) {
      const order = { "5h": 0, weekly: 1, "7d": 2, daily: 3 };
      return [...(group.buckets || [])].sort((a, b) => {
        const normalizeWindow = (value) => {
          const normalized = String(value || "").trim().toLowerCase();
          if (normalized === "7d" || normalized === "weekly") return normalized;
          if (normalized === "5h") return "5h";
          if (normalized === "daily") return "daily";
          return normalized;
        };
        return (order[normalizeWindow(a.window)] ?? 99) - (order[normalizeWindow(b.window)] ?? 99);
      });
    }

    function drawAccountSettings(payload) {
      if (managerView !== "accounts" || !root.isConnected) return;
      const busy = payload.job?.status === "running";
      const button = (text, handler) => {
        const item = el("button", { type: "button", className: "anticodex-prompt-settings", text });
        item.disabled = busy;
        item.onclick = handler;
        return item;
      };
      const label = el("input", { type: "text", maxlength: "80", placeholder: "账号备注（可选）", "aria-label": "账号备注", style: "width:160px;padding:6px 8px;border:1px solid var(--ac-line);border-radius:5px;background:var(--ac-raised);color:var(--ac-text);font-size:12px" });
      const toolbar = el("div", { className: "anticodex-account-toolbar" }, [
        label,
        button("添加 / 登录账号", (event) => accountOperation("login", { label: label.value }, true, event.currentTarget)),
        button("保存当前登录", () => accountOperation("capture", { label: label.value })),
        button("刷新全部额度", (event) => accountOperation("refresh", { all: true }, true, event.currentTarget)),
        button("重新读取列表", () => { void runManagerExclusive(showAccountSettings); }),
      ]);
      const list = el("div", { className: "anticodex-account-list", "data-anticodex-account-list": "true" }, [
        el("h2", { text: `账号管理（${payload.accounts?.length || 0}）` }), toolbar,
        el("div", { className: "anticodex-account-meta", text: "新登录账号直接启用；切换后自动打开 Antigravity。操作会重启 Antigravity，请先结束其中的任务。登录信息仅加密保存在本机。" }),
        el("div", { className: "anticodex-account-meta", text: "额度为最近快照，到期请刷新确认；悬停恢复时间查看日期。官方登录不代表 Google 保证账号不会被停用。" }),
        el("div", { className: "anticodex-account-feedback", "data-account-feedback": "true", role: "status", "aria-live": "polite", "aria-busy": String(busy), text: payload.job?.message || "选择账号，点击“启用并打开”。" }),
      ]);
      for (const account of payload.accounts || []) {
        const identity = el("div", { className: "anticodex-account-identity" }, [
          el("strong", { text: account.label || account.maskedEmail || "未命名账号" }),
          el("div", { className: "anticodex-account-meta", text: account.maskedEmail || "邮箱未提供" }),
          account.id === payload.activeId ? el("span", { className: "anticodex-account-badge", text: "已启用" }) : null,
          el("div", { className: "anticodex-account-meta", title: account.quota?.fetchedAt ? new Date(account.quota.fetchedAt).toLocaleString() : "", text: account.quota?.fetchedAt ? `更新 ${new Date(account.quota.fetchedAt).toLocaleTimeString()}` : "额度尚未读取" }),
        ]);
        const groups = account.quota?.groups?.length ? account.quota.groups : [
          { name: "Gemini", buckets: [{ window: "5h" }, { window: "weekly" }] },
          { name: "Claude / GPT", buckets: [{ window: "5h" }, { window: "weekly" }] },
        ];
        const groupNodes = groups.map((group, index) => {
          const groupName = group.label || group.display_name || group.displayName || group.name || group.id || `模型组 ${index + 1}`;
          const node = el("div", { className: "anticodex-account-group" }, [el("h3", { text: String(groupName) })]);
          for (const bucket of accountQuotaBuckets(group)) {
            const fraction = bucket.remaining_fraction;
            const known = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
            const percent = known ? Math.round(fraction * 10000) / 100 : null;
            const windowLabel = bucket.window === "5h"
              ? "5 小时"
              : bucket.window === "weekly" || bucket.window === "7d"
              ? "7 天"
              : bucket.window || "未标明周期";
            const track = el("div", { className: "anticodex-quota-track", role: "progressbar", "aria-label": `${groupName} ${windowLabel}剩余额度`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuetext": known ? `${percent}%` : "未知" });
            if (known) {
              track.setAttribute("aria-valuenow", String(percent));
              track.append(el("div", { className: `anticodex-quota-fill${percent <= 10 ? " anticodex-quota-low" : ""}`, style: `width:${percent}%` }));
            }
            node.append(el("div", { className: "anticodex-quota-bucket" }, [
              el("div", { className: "anticodex-quota-title" }, [el("span", { text: windowLabel }), el("span", { text: known ? `${percent}% 剩余` : "未知" })]),
              track,
              el("div", { className: "anticodex-account-meta", "data-account-reset": bucket.reset_time || "", title: bucket.reset_time ? new Date(bucket.reset_time).toLocaleString() : "恢复时间未知", text: accountResetText(bucket.reset_time) }),
            ]));
          }
          return node;
        });
        let renameField = null;
        const controls = el("div", { className: "anticodex-account-controls" }, [
          button(account.id === payload.activeId ? "打开" : "启用并打开", (event) => accountOperation("activate", { id: account.id }, true, event.currentTarget)),
          button("刷新额度", (event) => accountOperation("refresh", { id: account.id }, account.id !== payload.activeId, event.currentTarget)),
          button("修改备注", (event) => {
            if (renameField) { accountOperation("rename", { id: account.id, label: renameField.value }); return; }
            const editButton = event.currentTarget;
            renameField = el("input", { type: "text", maxlength: "80", value: account.label || "", "aria-label": `修改 ${account.maskedEmail} 的备注`, style: "box-sizing:border-box;width:100%;margin-top:8px;padding:8px;background:var(--ac-raised);color:var(--ac-text);border:1px solid var(--ac-line);border-radius:5px" });
            identity.append(renameField);
            editButton.textContent = "保存备注";
            renameField.onkeydown = (keyEvent) => {
              if (keyEvent.key === "Enter") { keyEvent.preventDefault(); accountOperation("rename", { id: account.id, label: renameField.value }); }
              if (keyEvent.key === "Escape") { keyEvent.stopPropagation(); renameField.remove(); renameField = null; editButton.textContent = "修改备注"; }
            };
            renameField.focus();
          }),
          button("移除", (event) => accountOperation("remove", { id: account.id }, false, event.currentTarget)),
          el("span", { className: "anticodex-account-inline-status", role: "status" }),
        ]);
        list.append(el("div", { className: "anticodex-account-row", "data-account-id": account.id, "data-active": String(account.id === payload.activeId) }, [identity, ...groupNodes, controls]));
      }
      if (!payload.accounts?.length) list.append(el("div", { className: "anticodex-result", text: "还没有保存的账号。已在 Antigravity 登录的账号可直接点“保存当前登录”，其他账号点“添加 / 登录账号”。" }));
      grid.replaceChildren(list);
    }

    async function waitAccountJob(job) {
      const deadline = Date.now() + 10 * 60 * 1000;
      while (root.isConnected && managerView === "accounts") {
        const payload = await managerGetLiveJson("/anticodex/accounts", { timeoutMs: 15000 });
        if (payload.job?.id !== job.id) throw new Error("账号任务已变化，请重新读取列表确认结果。");
        if (payload.job.status !== "running") drawAccountSettings(payload);
        setAccountFeedback(payload.job.message || "正在处理账号操作...", payload.job.status === "failed");
        if (payload.job.status !== "running") return;
        if (Date.now() >= deadline) throw new Error("操作仍在后台进行，请稍后重新读取列表；不要重复提交。");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    function accountOperation(action, values = {}, needsRestart = false, button = null) {
      if (managerOperationInFlight || actionInFlight) return;
      const signature = JSON.stringify([action, values.id || "", values.all === true]);
      if ((needsRestart && action === "refresh") || action === "remove") {
        const confirmed = accountConfirmation?.signature === signature && accountConfirmation.button === button && button?.isConnected && Date.now() < accountConfirmation.until;
        if (!confirmed) {
          if (accountConfirmation?.button?.isConnected) accountConfirmation.button.textContent = accountConfirmation.label;
          accountConfirmation = { signature, button, label: button?.textContent || "确认操作", until: Date.now() + 30000 };
          if (button) button.textContent = action === "remove" ? "确认移除" : "确认执行";
          setAccountBusy(false);
          button?.closest("[data-account-id]")?.setAttribute("data-pending", "true");
          setAccountFeedback(action === "remove"
            ? "只移除此账号的本机保存记录，不会退出官方当前账号。请再点一次“确认移除”。"
            : "查询其他账号会暂时重启 Antigravity，结束后恢复当前账号。请先结束其中的任务，再点一次“确认执行”。");
          return;
        }
      }
      if (accountConfirmation?.button?.isConnected) accountConfirmation.button.textContent = accountConfirmation.label;
      accountConfirmation = null;
      setAccountBusy(true, values.id);
      setAccountFeedback(action === "activate" ? "正在启用并打开 Antigravity..." : action === "login" ? "正在准备官方登录页面..." : "正在提交账号操作...");
      void runManagerExclusive(async () => {
        try {
          const accepted = await managerPostJson("/anticodex/accounts/action", { action, ...values, acknowledgeRestart: needsRestart }, { retryCandidates: false, timeoutMs: 15000 });
          await waitAccountJob(accepted.job);
        } catch (error) {
          setAccountFeedback(error.message, true);
        }
      }, { waitForInitial: false }).finally(() => setAccountBusy(false));
    }

    async function showAccountSettings() {
      managerView = "accounts";
      updateManagerTabs("accounts");
      root.setAttribute("data-anticodex-manager-view", "accounts");
      actions.style.display = "none";
      setResultCardMode("status");
      if (!root.querySelector("[data-account-feedback]")) grid.replaceChildren(el("div", { className: "anticodex-account-feedback", "data-account-feedback": "true", role: "status", "aria-live": "polite" }));
      setAccountFeedback("正在读取本机保存的账号...");
      try {
        const payload = await managerGetLiveJson("/anticodex/accounts", { timeoutMs: 15000 });
        drawAccountSettings(payload);
        setAccountFeedback(payload.job?.message || "账号登录状态仅保存在本机后台；额度查询不产生模型回合。", payload.job?.status === "failed");
        if (!window.__ANTICODEX_MANAGER_ACCOUNTS_TIMER__) window.__ANTICODEX_MANAGER_ACCOUNTS_TIMER__ = setInterval(() => {
          if (!root.isConnected || managerView !== "accounts") return;
          root.querySelectorAll("[data-account-reset]").forEach((node) => { node.textContent = accountResetText(node.getAttribute("data-account-reset")); });
        }, 30000);
        if (payload.job?.status === "running") await waitAccountJob(payload.job);
      } catch (error) {
        setAccountFeedback("账号列表读取失败：" + error.message, true);
      }
    }

    accountSettingsButton.onclick = () => { void runManagerExclusive(showAccountSettings, { waitForInitial: false }); };
    statusTabButton.onclick = () => { void runManagerExclusive(async () => {
      managerView = "status";
      updateManagerTabs("status");
      root.setAttribute("data-anticodex-manager-view", "status");
      actions.style.display = "";
      await load();
    }); };

    async function showPromptSettings() {
      updateManagerTabs("prompts");
      setResultCardMode("status");
      const promptGeneration = Number(root.getAttribute("data-anticodex-prompt-generation") || 0) + 1;
      root.setAttribute("data-anticodex-prompt-generation", String(promptGeneration));
      managerView = "prompts";
      root.setAttribute("data-anticodex-manager-view", "prompts");
      actions.style.display = "none";
      result.classList.remove("anticodex-error");
      result.textContent = "正在读取提示词设置...";
      const promptResult = await safeJson("/anticodex/prompt-policy", { allowSnapshotFallback: false });
      if (!promptResult.ok) {
        result.classList.add("anticodex-error");
        result.textContent = "读取提示词设置失败：" + (promptResult.error?.message || "本地管理通道不可用");
        return;
      }

      const payload = promptResult.value || {};
      const policy = structuredClone(payload.policy || payload.defaults || {});
      const defaults = structuredClone(payload.defaults || {});
      const snapshotLayers = Array.isArray(payload.snapshot?.layers) ? payload.snapshot.layers : [];
      const requiredLocalLayers = Array.isArray(payload.requiredLocalLayers) ? payload.requiredLocalLayers : [];
      const layerById = new Map(snapshotLayers.map((layer) => [String(layer.id || ""), layer]));
      const nativePromptSnapshot = payload.nativePromptSnapshot || null;
      const fieldStyle = "width:100%;min-height:150px;resize:vertical;border:1px solid var(--ac-line);border-radius:10px;background:var(--ac-input-bg);color:var(--ac-text);padding:10px 11px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace";
      const editor = (id, title, observedOverride = null) => {
        const current = policy[id] || defaults[id];
        const observed = observedOverride || layerById.get(id);
        const enabled = el("input", { type: "checkbox" });
        enabled.checked = current?.enabled !== false;
        const useDefault = el("input", { type: "checkbox" });
        useDefault.checked = current?.content === null;
        const textarea = el("textarea", { style: fieldStyle, value: current?.content ?? observed?.defaultContent ?? "", placeholder: "当前运行时尚未观察到这一层。" });
        const refresh = () => { textarea.disabled = !enabled.checked || useDefault.checked; };
        enabled.onchange = refresh;
        useDefault.onchange = refresh;
        refresh();
        return {
          node: card(title, el("div", { style: "display:grid;gap:9px" }, [
            el("label", { style: "display:flex;gap:7px;align-items:center", text: "" }, [enabled, el("span", { text: "启用" })]),
            el("label", { style: "display:flex;gap:7px;align-items:center", text: "" }, [useDefault, el("span", { text: "沿用当前运行时内容" })]),
            textarea,
            el("div", { className: "anticodex-result", text: observed
              ? `最近观察：默认 ${(observed.defaultSha256 || observed.sha256 || "").slice(0, 12) || "无哈希"} / 生效 ${(observed.effectiveSha256 || observed.sha256 || "").slice(0, 12) || "无哈希"}${observed.relayId ? ` / ${observed.relayId}` : ""}`
              : "当前运行时尚未捕获该层；首次模型请求后会显示。" }),
          ])),
          value: () => ({ enabled: enabled.checked, content: useDefault.checked ? null : textarea.value }),
        };
      };
      const system = editor("codexSystem", "Codex 完整合并提示词（Gemini / Claude / 第三方）", nativePromptSnapshot ? {
        ...nativePromptSnapshot,
        defaultContent: nativePromptSnapshot.defaultContent,
        effectiveContent: nativePromptSnapshot.effectiveContent,
      } : null);
      const developer = editor("codexDeveloper", "Codex 开发者提示词");
      developer.node.append(el("div", { className: "anticodex-result anticodex-warn", text: "只有上方完整合并提示词沿用当前运行时内容时，此层才单独生效；若上方整体被替换或关闭，系统、开发者及环境说明都按整体设置处理。AGENTS.md 请用下方独立项控制，真实用户消息不会被此页编辑。" }));
      const nativeInstructions = payload.nativeCustomInstructions || { content: "", defaultContent: "" };
      const nativeInstructionsText = el("textarea", {
        style: fieldStyle,
        value: nativeInstructions.content || "",
        placeholder: "留空即关闭；内容只保存在 Anti-Codex 隔离目录。",
      });
      const userEnabled = el("input", { type: "checkbox" });
      userEnabled.checked = policy.user?.enabled === true;
      const userText = el("textarea", { style: fieldStyle, value: policy.user?.content || "", placeholder: "这里的内容只注入 Anti-Codex，不修改原生 Codex。" });
      const refreshUser = () => { userText.disabled = !userEnabled.checked; };
      userEnabled.onchange = refreshUser;
      refreshUser();
      const saveButton = el("button", { type: "button", className: "anticodex-prompt-settings", text: "保存" });
      const restoreButton = el("button", { type: "button", className: "anticodex-prompt-settings", text: "恢复默认" });
      const backButton = el("button", { type: "button", className: "anticodex-prompt-settings", text: "返回状态" });
      const save = (nextPolicy) => runManagerExclusive(async () => {
        for (const button of [saveButton, restoreButton, backButton]) button.disabled = true;
        result.textContent = "正在保存提示词设置...";
        try {
          const saved = await managerPostJson("/anticodex/prompt-policy", nextPolicy, { retryCandidates: false });
          result.classList.remove("anticodex-error");
          result.textContent = saved.message || "提示词设置已保存。";
          window.__ANTICODEX_MANAGER_SNAPSHOT__ = null;
        } catch (error) {
          result.classList.add("anticodex-error");
          result.textContent = "保存失败：" + error.message;
        } finally {
          for (const button of [saveButton, restoreButton, backButton]) button.disabled = false;
        }
      });
      saveButton.onclick = () => save({
        schema: payload.schema,
        codexSystem: system.value(),
        codexDeveloper: developer.value(),
        user: { enabled: userEnabled.checked, content: userText.value },
        nativeCustomInstructions: { content: nativeInstructionsText.value },
      });
      restoreButton.onclick = () => save({
        ...defaults,
        nativeCustomInstructions: { content: nativeInstructions.defaultContent || "" },
      });
      backButton.onclick = () => { void runManagerExclusive(async () => {
        managerView = "status";
        updateManagerTabs("status");
        root.setAttribute("data-anticodex-manager-view", "status");
        actions.style.display = "";
        await load();
      }); };
      const required = snapshotLayers.filter((layer) => layer.required).map((layer) => card(layer.title || "必需兼容层", el("pre", { className: "anticodex-result", text: layer.effectiveContent || "" })));
      const requiredLocal = requiredLocalLayers.map((layer) => card(`只读本地兼容提示词：${layer.title || "必需兼容层"}`, el("div", { style: "display:grid;gap:9px" }, [
        el("pre", { className: "anticodex-result", text: layer.content || "" }),
        el("div", { className: "anticodex-result anticodex-warn", text: `适用线路：${(layer.routes || []).join(" / ") || "未声明"}；生效条件：${layer.activeWhen || "始终"}。此层只保证工具协议兼容，不会恢复已被关闭或替换的 Codex 官方规则。` }),
      ])));
      grid.replaceChildren(
        system.node,
        card("本地快照说明", el("div", { className: "anticodex-result anticodex-warn", text: "完整提示词快照只保存在 Anti-Codex 隔离目录；只采集 system/developer 层，不采集 user 消息、AGENTS.md、工具参数或请求密钥。内容可能包含你的个性化和项目规则。" })),
        developer.node,
        card("Codex 原生自定义指令 (AGENTS.md)", el("div", { style: "display:grid;gap:9px" }, [
          nativeInstructionsText,
          el("div", { className: "anticodex-result", text: "Gemini、Claude 和第三方模型都沿用这一份隔离配置；留空即关闭。" }),
        ])),
        card("Anti-Codex 附加提示词（Gemini / Claude / 第三方）", el("div", { style: "display:grid;gap:9px" }, [
          el("label", { style: "display:flex;gap:7px;align-items:center" }, [userEnabled, el("span", { text: "启用" })]),
          userText,
        ])),
        card("适用范围", el("div", { className: "anticodex-result anticodex-warn", text: "合并提示词、Anti-Codex 附加提示词和原生 AGENTS.md 均适用于 Gemini、Claude 和第三方线路；下一次新模型请求读取，正在进行的流不会中途改写。恢复默认会继续跟随当前 Codex；旧任务若已固化旧版本提示，需要重启后新建任务才会取得新版本默认。" })),
        card("模型提供方隐藏提示词", el("div", { className: "anticodex-result anticodex-warn", text: payload.providerBase?.message || "提供方未暴露。" })),
        ...requiredLocal,
        ...required,
        card("操作", el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [saveButton, restoreButton, backButton])),
      );
      result.textContent = nativePromptSnapshot ? "已读取最近一次修改前与生效后的完整提示词。" : "设置可用；当前尚无完整运行时提示词快照。";
    }

    promptSettingsButton.onclick = () => { void runManagerExclusive(showPromptSettings); };

    async function showUpstreamConfig() {
      setResultCardMode("upstream-config");
      await ensureSnapshotForLoad();
      let profileResult = await safeJson("/anticodex/upstream-profile", { preferSnapshot: true });
      if (!profileResult.ok) {
        const snapshot = snapshotResponse("/anticodex/upstream-profile")
          || (await refreshManagerSnapshot())?.responses?.["/anticodex/upstream-profile"];
        if (snapshot) profileResult = { ok: true, value: snapshot };
      }
      if (!profileResult.ok) {
        const retryButton = el("button", { type: "button", text: "重新读取" });
        retryButton.onclick = () => showUpstreamConfig();
        result.classList.add("anticodex-error");
        result.replaceChildren(el("div", { style: "display:grid;gap:10px" }, [
          el("div", { className: "anticodex-warn", text: "读取第三方 API 配置失败。为避免覆盖已有配置，当前不会显示空白表单。" }),
          el("pre", { className: "anticodex-result anticodex-error", text: String(profileResult.error?.message || "本地模型通道不可用") }),
          el("div", { style: "display:flex;gap:8px" }, [retryButton]),
        ]));
        resultCard.scrollIntoView({ block: "start", inline: "nearest" });
        return;
      }
      const profilePayload = profileResult.value || {};
      const saved = profilePayload.saved || {};
      let lastStages = [];
      let testedFingerprint = "";
      let upstreamConfigOperationInFlight = false;
      const fieldStyle = "width:100%;min-height:34px;border:1px solid var(--ac-line);border-radius:8px;background:var(--ac-raised);color:var(--ac-text);padding:7px 9px;font:12px/1.4 'Segoe UI','Microsoft YaHei',sans-serif";
      const row = (label, node) => el("label", { style: "display:grid;gap:5px;color:var(--ac-muted);font-size:12px" }, [
        el("span", { text: label }),
        node,
      ]);
      const protocol = el("select", { style: fieldStyle }, [
        el("option", { value: "openai-compatible", text: "Chat Completions" }),
        el("option", { value: "responses", text: "Responses" }),
      ]);
      protocol.value = saved.protocol || "openai-compatible";
      const baseUrl = el("input", { style: fieldStyle, value: saved.baseUrl || "", placeholder: "https://api.example.com/v1 或完整 /v1/chat/completions / /v1/responses 地址" });
      const providerModelListId = `anticodex-provider-models-${Date.now()}`;
      const model = el("input", { style: fieldStyle, value: saved.model || "", list: providerModelListId, placeholder: "模型名，例如 gpt-4o-mini" });
      const providerModelList = el("datalist", { id: providerModelListId });
      const updateProviderModelList = (values = []) => {
        const models = [];
        const seen = new Set();
        for (const value of values) {
          const id = String(value || "").trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          models.push(id);
        }
        providerModelList.replaceChildren(...models.map((id) => el("option", { value: id })));
      };
      updateProviderModelList(saved.capabilities?.providerModels || []);
      const contextWindow = el("input", { style: fieldStyle, type: "number", min: "16000", max: "4000000", step: "1000", value: String(saved.contextWindow || 272000), placeholder: "272000" });
      const apiKey = el("input", { style: fieldStyle, type: "password", placeholder: saved.keyConfigured ? `已保存 · ${saved.keyHint}，留空沿用旧 key` : "请输入 API key" });
      const stageBox = el("pre", { className: "anticodex-result", "aria-live": "polite", text: "“测试连通”会发送一次最小真实请求；测试成功后，“保存配置”复用这次结果，不会再次请求，也不会切换当前会话。" });
      const saveHint = el("div", { className: "anticodex-form-hint", text: "先测试连通；成功后可保存。" });
      const testButton = el("button", { type: "button", text: "测试连通" });
      const saveButton = el("button", { type: "button", text: "保存配置" });
      saveButton.disabled = true;
      const upstreamConfigFields = [protocol, baseUrl, model, contextWindow, apiKey];
      function upstreamConfigFingerprint() {
        return JSON.stringify([
          protocol.value,
          baseUrl.value.trim(),
          model.value.trim(),
          contextWindow.value,
          apiKey.value,
        ]);
      }
      const refreshUpstreamConfigControls = () => {
        for (const field of upstreamConfigFields) field.disabled = upstreamConfigOperationInFlight;
        testButton.disabled = upstreamConfigOperationInFlight;
        const fingerprintMatches = Boolean(testedFingerprint) && testedFingerprint === upstreamConfigFingerprint();
        saveButton.disabled = upstreamConfigOperationInFlight || !fingerprintMatches;
        saveHint.textContent = upstreamConfigOperationInFlight
          ? "正在处理，请稍候…"
          : (fingerprintMatches ? "连接已通过，现在可保存。" : "先测试连通；成功后可保存。");
        saveButton.title = fingerprintMatches ? "保存当前配置" : "请先点击“测试连通”";
      };
      const setUpstreamConfigBusy = (busy) => {
        upstreamConfigOperationInFlight = Boolean(busy);
        refreshUpstreamConfigControls();
      };
      const fillDefault = () => {
        if (!baseUrl.value.trim()) baseUrl.value = "https://api.openai.com/v1";
      };
      const invalidateConnectionTest = () => {
        lastStages = [];
        testedFingerprint = "";
        stageBox.classList.remove("anticodex-error");
        stageBox.textContent = "配置已修改，请重新测试；测试会发送一次最小真实请求。";
        refreshUpstreamConfigControls();
      };
      protocol.onchange = () => {
        fillDefault();
        invalidateConnectionTest();
      };
      fillDefault();
      for (const field of [baseUrl, model, contextWindow, apiKey]) {
        field.addEventListener("input", invalidateConnectionTest);
        field.addEventListener("change", invalidateConnectionTest);
      }
      const upstreamConnectionSummaryText = (payload) => {
        const summary = payload?.summary;
        if (!summary?.title && !summary?.suggestedAction) return "";
        return [
          `结论：${summary.title || (payload?.ok ? "连接可用" : "连接测试失败")}`,
          summary.failedStage ? `阶段：${summary.failedStage}` : "",
          `建议：${summary.suggestedAction || "检查 provider 地址、key、模型名和协议后重新测试。"}`,
          summary.retryable ? "可重试：是" : "可重试：否",
          summary.type ? `分类：${summary.type}` : "",
        ].filter(Boolean).join("\n");
      };
      const stageText = (payload) => [
        upstreamConnectionSummaryText(payload),
        (payload.stages || []).map((item) => String(item.stage || "") + "：" + String(item.status || "") + "\n" + String(item.detail || "")).join("\n\n"),
      ].filter(Boolean).join("\n\n") || "没有返回测试结果";
      testButton.onclick = () => runManagerExclusive(async () => {
        if (upstreamConfigOperationInFlight) return;
        const requestFingerprint = upstreamConfigFingerprint();
        setUpstreamConfigBusy(true);
        stageBox.textContent = "正在测试连通...";
        try {
          const payload = await managerPostJson("/anticodex/upstream-test", { protocol: protocol.value, baseUrl: baseUrl.value.trim(), model: model.value.trim(), contextWindow: Number(contextWindow.value), apiKey: apiKey.value }, {
            timeoutMs: UPSTREAM_TEST_TIMEOUT_MS,
            retryCandidates: false,
          });
          if (requestFingerprint !== upstreamConfigFingerprint()) {
            lastStages = [];
            testedFingerprint = "";
            stageBox.classList.add("anticodex-error");
            stageBox.textContent = "测试完成，但配置内容已经变化。请重新测试后再保存。";
          } else {
            lastStages = payload.stages || [];
            testedFingerprint = payload.ok === true ? requestFingerprint : "";
            updateProviderModelList(lastStages.flatMap((stage) => Array.isArray(stage.models) ? stage.models : []));
            stageBox.textContent = stageText(payload);
            stageBox.classList.toggle("anticodex-error", payload.ok === false);
          }
        } catch (error) {
          lastStages = [];
          testedFingerprint = "";
          stageBox.classList.add("anticodex-error");
          stageBox.textContent = "测试失败：" + error.message;
        } finally {
          setUpstreamConfigBusy(false);
        }
      });
      saveButton.onclick = () => runManagerExclusive(async () => {
        if (upstreamConfigOperationInFlight || testedFingerprint !== upstreamConfigFingerprint()) {
          invalidateConnectionTest();
          return;
        }
        setUpstreamConfigBusy(true);
        stageBox.textContent = "正在保存配置...";
        try {
          const payload = await managerPostJson("/anticodex/upstream-profile", { protocol: protocol.value, baseUrl: baseUrl.value.trim(), model: model.value.trim(), contextWindow: Number(contextWindow.value), apiKey: apiKey.value }, {
            timeoutMs: UPSTREAM_TEST_TIMEOUT_MS,
            retryCandidates: false,
          });
          stageBox.classList.remove("anticodex-error");
          stageBox.textContent = payload.message || "配置已保存，可在聊天输入框的模型菜单选择第三方模型。";
          window.__ANTICODEX_MANAGER_SNAPSHOT__ = null;
        } catch (error) {
          stageBox.classList.add("anticodex-error");
          stageBox.textContent = "保存失败：" + error.message;
        } finally {
          setUpstreamConfigBusy(false);
        }
      });
      refreshUpstreamConfigControls();
      result.classList.remove("anticodex-error");
      result.replaceChildren(el("div", { style: "display:grid;gap:10px" }, [
        row("协议", protocol),
        row("接口地址（可填 base URL 或完整接口）", baseUrl),
        row("模型名", model),
        providerModelList,
        row("上下文窗口（token）", contextWindow),
        row("API key", apiKey),
        el("div", { className: "anticodex-form-actions" }, [testButton, saveButton]),
        saveHint,
        stageBox,
      ]));
      resultCard.scrollIntoView({ block: "start", inline: "nearest" });
    }

    function installActions() {
      actions.replaceChildren();
      const actionLists = new Map();
      for (const group of [
        { id: "status", title: "\u5f53\u524d\u72b6\u6001" },
        { id: "modelSources", title: "\u8d26\u53f7\u4e0e\u6a21\u578b\u6765\u6e90" },
        { id: "updates", title: "Codex \u66f4\u65b0" },
        { id: "troubleshooting", title: "\u6545\u969c\u6392\u67e5" },
      ]) {
        const list = el("div", { className: "anticodex-action-list" });
        const section = el("section", {
          className: "anticodex-action-section",
          "data-action-group": group.id,
        }, [
          el("div", { className: "anticodex-action-section-head" }, [
            el("h2", { text: group.title }),
          ]),
          list,
        ]);
        actionLists.set(group.id, list);
        actions.append(section);
      }
      const advancedList = el("div", { className: "anticodex-action-list" });
      const advancedSection = el("details", {
        className: "anticodex-action-section",
        "data-action-group": "advanced",
      }, [
        el("summary", { text: "高级诊断" }),
        advancedList,
      ]);
      actionLists.set("advanced", advancedList);
      actions.append(advancedSection);
      for (const [action, label] of ACTIONS) {
        const highImpact = HIGH_IMPACT_ACTION_IDS.has(action);
        const button = el("button", {
          className: highImpact ? "anticodex-action-danger" : "anticodex-action-neutral",
          "data-action": action,
          text: label,
        });
        button.addEventListener("click", async () => {
          if (managerInitialLoadPromise) await managerInitialLoadPromise;
          if (!root.isConnected) return;
          const pendingAction = Object.keys(window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ || {}).find(actionStillPending);
          const reportedAction = managerSnapshotRunningActionIds(window.__ANTICODEX_MANAGER_SNAPSHOT__).values().next().value || "";
          if (managerOperationInFlight || actionInFlight || window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ || pendingAction || reportedAction) {
            resetHighImpactConfirmation();
            if (action === "refreshStatus" && !managerOperationInFlight && !actionInFlight && !window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__) {
              result.classList.remove("anticodex-error");
              result.textContent = "\u6b63\u5728\u5237\u65b0\u540e\u53f0\u4efb\u52a1\u72b6\u6001\u2026";
              await refreshManagerSnapshot();
              await load({ updateResult: false });
              const remainingPending = Object.keys(window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ || {}).find(actionStillPending);
              const remainingReported = managerSnapshotRunningActionIds(window.__ANTICODEX_MANAGER_SNAPSHOT__).values().next().value || "";
              const remainingAction = remainingPending || remainingReported;
              const remainingLabel = ACTIONS.find(([id]) => id === remainingAction)?.[1] || remainingAction;
              const settledSummary = String(window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__?.managerSummary || "");
              result.classList.toggle("anticodex-error", !remainingAction && window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__?.ok === false);
              result.textContent = remainingAction
                ? `\u72b6\u6001\u5df2\u5237\u65b0\uff1a${remainingLabel}\u4ecd\u5728\u540e\u53f0\u8fd0\u884c\u3002`
                : (settledSummary || "\u72b6\u6001\u5df2\u5237\u65b0\uff1a\u540e\u53f0\u4efb\u52a1\u5df2\u7ed3\u675f\uff0c\u53ef\u4ee5\u7ee7\u7eed\u64cd\u4f5c\u3002");
              return;
            }
            result.textContent = "\u5df2\u6709\u7ba1\u7406\u4efb\u52a1\u5728\u8fd0\u884c\u3002\u5b8c\u6210\u540e\u672c\u9875\u4f1a\u81ea\u52a8\u663e\u793a\u7ed3\u679c\uff1b\u671f\u95f4\u4e0d\u4f1a\u91cd\u590d\u542f\u52a8\u5176\u4ed6\u68c0\u67e5\u3001\u540c\u6b65\u6216\u91cd\u542f\u4efb\u52a1\u3002";
            return;
          }
          if (requireHighImpactConfirmation(action, label, button)) {
            return;
          }
          if (action === "upstreamConfig") {
            await showUpstreamConfig();
            return;
          }
          setResultCardMode("status");
          actionGeneration += 1;
          const currentActionGeneration = actionGeneration;
          const actionToken = `${currentActionGeneration}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ = actionToken;
          window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ = actionToken;
          actionInFlight = true;
          setManagerOperationBusy(true);
          const actionStartedAt = Date.now();
          setActionButtonsDisabled(true);
          result.classList.remove("anticodex-error");
          result.setAttribute("data-anticodex-running", action);
          result.textContent = runningText(action, label, 0);
          let progressActive = true;
          const progressTimer = setInterval(() => {
            if (!progressActive) return;
            if (!actionInFlight || result.getAttribute("data-anticodex-running") !== action) return;
            result.textContent = runningText(action, label, Date.now() - actionStartedAt);
          }, 1000);
          try {
            const accountSwitchBaseline = action === "accountSwitch"
              ? await captureAccountSwitchState()
              : null;
            const actionPromise = runActionViaBridge(action, actionToken)
              .then((payload) => ({ type: "payload", payload }))
              .catch((error) => ({ type: "error", error }));
            const outcome = await Promise.race([
              actionPromise,
              new Promise((resolve) => setTimeout(() => resolve({ type: "timeout" }), actionUiTimeoutMs(action))),
            ]);
            if (outcome.type === "payload") {
              progressActive = false;
              const continuesInBackground = managerActionContinuesInBackground(action, outcome.payload);
              if (continuesInBackground) {
                const pendingActions = managerPendingActions();
                pendingActions[action] = actionStartedAt;
                persistManagerPendingActions();
                reconcileManagerPendingActions(outcome.payload?.snapshot);
              }
              if (window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;
              if (action === "accountSwitch") {
                result.textContent = "Antigravity \u5df2\u6253\u5f00\uff0c\u6b63\u5728\u81ea\u52a8\u68c0\u6d4b\u8d26\u53f7\u6216\u6a21\u578b\u53d8\u5316\u2026";
                const change = await waitForAccountSwitch(accountSwitchBaseline);
                if (window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;
                if (change.reason === "cancelled") {
                  return;
                } else if (change.changed) {
                  result.textContent = "\u5df2\u68c0\u6d4b\u5230\u5207\u6362\uff0c\u6b63\u5728\u81ea\u52a8\u5237\u65b0 Anti-Codex \u6a21\u578b\u2026";
                  const refreshPayload = await runActionViaBridge("refreshModels", actionToken);
                  if (window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;
                  result.textContent = "\u8d26\u53f7\u6216\u6a21\u578b\u53d8\u5316\u5df2\u786e\u8ba4\u3002\n" + summaryText("refreshModels", refreshPayload);
                } else {
                  result.textContent = "\u672a\u68c0\u6d4b\u5230\u53ef\u8bc1\u660e\u7684\u8d26\u53f7\u6216\u6a21\u578b\u53d8\u5316\u3002\n\u5982\u679c\u4f60\u5df2\u5b8c\u6210\u5207\u6362\uff0c\u8bf7\u624b\u52a8\u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002";
                }
              } else {
                const managerSummary = summaryText(action, outcome.payload);
                const stillPending = continuesInBackground && actionStillPending(action);
                window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
                  ...(outcome.payload || {}),
                  action,
                  managerSummary,
                  pending: stillPending,
                };
                result.textContent = managerSummary;
              }
              if (window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ !== actionToken) return;
              await load({ updateResult: false });
            } else if (outcome.type === "timeout") {
              progressActive = false;
              const managerSummary = timeoutText(action, label);
              const pendingStartedAt = actionStartedAt;
              const pendingActions = managerPendingActions();
              pendingActions[action] = pendingStartedAt;
              persistManagerPendingActions();
              window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
                ok: null,
                action,
                managerSummary,
                pending: true,
              };
              result.textContent = managerSummary;
              actionPromise.then(async (lateOutcome) => {
                const continuesInBackground = lateOutcome.type === "payload"
                  && managerActionContinuesInBackground(action, lateOutcome.payload);
                if (continuesInBackground) {
                  pendingActions[action] = pendingActions[action] || pendingStartedAt;
                  persistManagerPendingActions();
                  reconcileManagerPendingActions(lateOutcome.payload?.snapshot);
                } else if (pendingActions[action] === pendingStartedAt) {
                  delete pendingActions[action];
                  persistManagerPendingActions();
                }
                const isCurrentActionToken = window.__ANTICODEX_MANAGER_CURRENT_ACTION_TOKEN__ === actionToken;
                if (!isCurrentActionToken) return;
                if (lateOutcome.type === "payload") {
                  const lateSummary = summaryText(action, lateOutcome.payload);
                  const stillPending = continuesInBackground && actionStillPending(action);
                  window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
                    ...(lateOutcome.payload || {}),
                    action,
                    managerSummary: lateSummary,
                    pending: stillPending,
                  };
                  const liveResult = document.querySelector(`#${MANAGER_ID} [data-anticodex-result="action"]`);
                  const liveRunning = liveResult?.getAttribute("data-anticodex-running") || "";
                  if (currentActionGeneration === actionGeneration && !actionInFlight && result.isConnected) {
                    result.textContent = lateSummary;
                    await load({ updateResult: false });
                  } else if (liveResult && (!liveRunning || liveRunning === action)) {
                    liveResult.classList.remove("anticodex-error");
                    liveResult.removeAttribute("data-anticodex-running");
                    liveResult.textContent = lateSummary;
                    window.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ = true;
                    try {
                      await window.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
                    } finally {
                      window.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ = false;
                    }
                  }
                } else if (lateOutcome.type === "error"
                  && currentActionGeneration === actionGeneration
                  && !actionInFlight) {
                  result.classList.add("anticodex-error");
                  result.textContent = "\u8fd0\u884c\u5931\u8d25\uff1a" + (lateOutcome.error?.message || lateOutcome.error || "\u672a\u77e5\u9519\u8bef");
                }
              });
            } else {
              throw outcome.error;
            }
          } catch (error) {
            result.classList.add("anticodex-error");
            result.textContent = "\u8fd0\u884c\u5931\u8d25\uff1a" + error.message;
          } finally {
            progressActive = false;
            clearInterval(progressTimer);
            const remainingBusyMs = 300 - (Date.now() - actionStartedAt);
            if (remainingBusyMs > 0) await wait(remainingBusyMs);
            actionInFlight = false;
            setManagerOperationBusy(false);
            if (window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__ === actionToken) {
              delete window.__ANTICODEX_MANAGER_ACTION_IN_FLIGHT_TOKEN__;
            }
            result.removeAttribute("data-anticodex-running");
            setActionButtonsDisabled(false);
            if (action !== "refreshStatus") void refreshManagerSnapshot().then(() => load({ updateResult: false }));
            if ((window.__ANTICODEX_MANAGER_ACTION_QUEUE__?.length || 0) === 0) {
              window.__ANTICODEX_MANAGER_ACTION_PROMISES__ = {};
            }
          }
        });
        const groupId = Object.keys(MANAGER_ACTION_GROUPS).find((id) => MANAGER_ACTION_GROUPS[id].includes(action));
        actionLists.get(groupId)?.append(button);
      }
    }

    installActions();
    managerInitialLoadPromise = load({ updateResult: !preserveLastActionResult })
      .catch((error) => {
        result.classList.add("anticodex-error");
        result.textContent = "读取失败：" + (error?.message || "本地状态暂不可用");
      })
      .finally(() => { managerInitialLoadPromise = null; });
  }

  function installManagerRuntime() {
    if (!document.body) return;
    document.getElementById(LEGACY_BUTTON_ID)?.remove();
    refreshManagerStatus();
    if (!window.__ANTICODEX_MANAGER_STATUS_TIMER__) {
      window.__ANTICODEX_MANAGER_STATUS_TIMER__ = setInterval(refreshManagerStatus, 5000);
    }
  }

  window.__ANTICODEX_OPEN_MANAGER__ = openManager;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installManagerRuntime, { once: true });
  } else {
    installManagerRuntime();
  }
})();
