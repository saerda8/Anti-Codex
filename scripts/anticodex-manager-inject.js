(() => {
  const VERSION = "native-panel-v94";
  const SUMMARY_VERSION = "latest-reports-evidence-v1";
  const MANAGER_ID = "anticodex-manager-overlay";
  const LEGACY_BUTTON_ID = "anticodex-manager-button";
  const TRAFFIC_NOTICE_ID = "anticodex-traffic-notice";
  if (
    window.__ANTICODEX_MANAGER_VERSION__ === VERSION &&
    window.__ANTICODEX_MANAGER_SUMMARY_VERSION__ === SUMMARY_VERSION &&
    typeof window.__ANTICODEX_OPEN_MANAGER__ === "function"
  ) return;
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
    ["accountProxy", "\u68c0\u67e5\u8d26\u53f7/\u4ee3\u7406"],
    ["syncReadiness", "\u68c0\u67e5\u5b89\u88c5/\u540c\u6b65"],
    ["repairShortcuts", "\u4fee\u590d\u5feb\u6377\u65b9\u5f0f"],
    ["updateCheck", "\u68c0\u67e5\u66f4\u65b0"],
    ["sourcePreflight", "\u8fd0\u884c\u6e90\u7801\u9884\u68c0"],
    ["upstreamConfig", "\u914d\u7f6e\u7b2c\u4e09\u65b9 API"],
    ["resetAntigravitySessionLock", "\u91cd\u7f6e Antigravity \u4f1a\u8bdd\u9501"],
    ["syncHost", "\u540c\u6b65 Codex \u66f4\u65b0"],
    ["mcpSkills", "\u68c0\u67e5 MCP/Skill"],
    ["pluginCapabilities", "\u68c0\u67e5\u63d2\u4ef6/\u5e94\u7528"],
    ["refreshFeatures", "\u5237\u65b0\u672c\u5730\u529f\u80fd"],
    ["stabilitySoak", "\u7a33\u5b9a\u6027\u5de1\u68c0\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09"],
    ["coldRelaunch", "\u51b7\u542f\u52a8\u9a8c\u8bc1\uff08\u91cd\u542f Anti-Codex\uff09"],
    ["fastOverallNoTraffic", "\u5feb\u901f\u68c0\u67e5\uff08\u4e0d\u8017\u6d41\u91cf\uff09"],
    ["overallNoTraffic", "\u6574\u4f53\u68c0\u67e5\uff08\u4e0d\u8017\u6d41\u91cf\uff09"],
    ["diagnosticsBundle", "\u751f\u6210\u8bca\u65ad\u5305"],
    ["viewLatestReports", "\u67e5\u770b\u6700\u65b0\u62a5\u544a"],
    ["postVerificationFull", "\u9a8c\u8bc1\u540e\u5b8c\u6574\u68c0\u67e5\uff08\u8017\u771f\u5b9e\u6d41\u91cf\uff09"],
  ];
  const DAILY_ACTION_IDS = new Set([
    "refreshStatus",
    "refreshModels",
    "accountSwitch",
    "accountProxy",
    "syncReadiness",
    "repairShortcuts",
    "updateCheck",
    "sourcePreflight",
    "mcpSkills",
    "pluginCapabilities",
    "diagnosticsBundle",
    "viewLatestReports",
  ]);
  const HIGH_IMPACT_ACTION_IDS = new Set([
    "syncHost",
    "upstreamConfig",
    "resetAntigravitySessionLock",
    "refreshFeatures",
    "stabilitySoak",
    "coldRelaunch",
    "fastOverallNoTraffic",
    "overallNoTraffic",
    "postVerificationFull",
  ]);
  const BRIDGE_TIMEOUT_MS = 5000;
  const ACTION_UI_TIMEOUT_MS = 5000;
  const EXTENDED_ACTION_UI_TIMEOUT_MS = 28000;
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

  function cancelAccountSwitchObservation() {
    accountSwitchObservationGeneration += 1;
    const cancel = accountSwitchObservationCancel;
    accountSwitchObservationCancel = null;
    cancel?.();
  }

  function removeManager() {
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
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
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
    managerThemeObserver = new MutationObserver((records) => {
      if (records.every((record) => record.target?.closest?.(`#${MANAGER_ID}`))) return;
      schedule();
    });
    managerThemeObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-theme", "data-mode", "data-color-mode"],
    });
    managerThemeMedia = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
    managerThemeMediaListener = schedule;
    if (typeof managerThemeMedia?.addEventListener === "function") managerThemeMedia.addEventListener("change", schedule);
    else managerThemeMedia?.addListener?.(schedule);
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
      && responses["/anticodex/local-connectors/allowlist"]
      && responses["/backend-api/ps/plugins/installed"] && responses["/backend-api/aip/connectors"]
      && responses["/backend-api/plugins/list"] && responses["/backend-api/wham/apps"]
      && Number(localFeatures.mcp?.count) > 0
      && Number(localFeatures.skills?.count) > 0
    );
  }

  async function getJson(path, options = {}) {
    const snapshotFallback = snapshotResponse(path);
    const allowSnapshotFallback = options.allowSnapshotFallback !== false
      && (!options.method || String(options.method).toUpperCase() === "GET");
    let lastError = null;
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
    if (window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__) {
      const deadline = Date.now() + LOAD_SNAPSHOT_TIMEOUT_MS;
      while (window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__ && Date.now() < deadline) {
        await wait(100);
      }
      return window.__ANTICODEX_MANAGER_SNAPSHOT__ || null;
    }
    window.__ANTICODEX_MANAGER_SNAPSHOT_IN_FLIGHT__ = true;
    const previousSuppressRefreshStatus = window.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ === true;
    window.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ = true;
    try {
      const payload = await Promise.race([
        window.__ANTICODEX_RUN_MANAGER_ACTION__("refreshStatus"),
        new Promise((resolve) => setTimeout(() => resolve(null), LOAD_SNAPSHOT_TIMEOUT_MS)),
      ]);
      if (payload?.snapshot) window.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
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

  async function runActionViaBridge(action) {
    if (typeof window.__ANTICODEX_RUN_MANAGER_ACTION__ === "function") {
      try {
        let payload;
        const bridgeTimeoutMs = Math.max(BRIDGE_TIMEOUT_MS, actionUiTimeoutMs(action) + 1000);
        const winner = await Promise.race([
          window.__ANTICODEX_RUN_MANAGER_ACTION__(action).then(p => { payload = p; return "bridge"; }),
          new Promise(resolve => setTimeout(() => resolve("timeout"), bridgeTimeoutMs)),
        ]);
        if (winner === "bridge") {
          activeApi = browserReachableApiBase(payload?.snapshot?.baseUrl || activeApi, activeApi);
          if (payload?.snapshot) window.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
          if (payload?.action && payload.action !== action) throw new Error(`Manager bridge returned ${payload.action} for ${action}.`);
          if (payload?.ok !== false) return payload;
          throw new Error(payload.message || "Anti-Codex manager action failed.");
        }
        if (location.protocol === "app:") throw new Error("Anti-Codex manager bridge timed out.");
      } catch (error) {
        if (location.protocol === "app:") throw error;
      }
    }
    return runActionViaScript(action);
  }

  async function runActionViaScript(action) {
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
          }, actionUiTimeoutMs(action) + 1000);
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
        activeApi = browserReachableApiBase(payload?.snapshot?.baseUrl || baseUrl, baseUrl);
        if (payload?.snapshot) window.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
        return payload;
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

  function connectorAllowlistEditor(allowlist) {
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
    saveButton.onclick = async () => {
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
        await load({ updateResult: false });
      } catch (error) {
        result.classList.add("anticodex-error");
        result.textContent = "\u4fdd\u5b58\u672c\u5730\u8fde\u63a5\u5668 allowlist \u5931\u8d25\uff1a" + error.message;
      } finally {
        saveButton.disabled = false;
      }
    };
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

  function trafficNoticeKey(health) {
    const diagnosis = trafficDiagnosis(health);
    if (isQuotaLimitTraffic(health)) return "quota_or_limit_reached";
    if (diagnosis === "account_verification_required" || diagnosis === "account_verification_with_missing_token") return diagnosis;
    if (diagnosis === "antigravity_account_unavailable") return diagnosis;
    if (health?.accountTrafficRetryable === true || diagnosis === "antigravity_temporarily_unavailable") return "antigravity_temporarily_unavailable";
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
    const copy = {
      quota_or_limit_reached: ["Antigravity \u8d26\u53f7\u989d\u5ea6\u5df2\u5230", "\u5207\u6362\u8d26\u53f7\uff0c\u6216\u7b49\u5f85\u989d\u5ea6\u6062\u590d\u540e\u91cd\u8bd5\u3002"],
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
    notice.addEventListener("click", (event) => {
      if (event.target?.closest?.("button")) return;
      openManager();
    });
    notice.querySelector('[data-anticodex-notice-action="open"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      openManager();
    });
    notice.querySelector('[data-anticodex-notice-action="retry"]')?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      const previous = button.textContent;
      button.disabled = true;
      button.textContent = "\u68c0\u67e5\u4e2d...";
      try {
        await openManager();
        await runActionViaBridge("accountProxy");
        await load({ updateResult: false });
      } finally {
        button.disabled = false;
        button.textContent = previous || "\u91cd\u65b0\u68c0\u67e5";
      }
    });
    notice.querySelector('[data-anticodex-notice-action="dismiss"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      window.__ANTICODEX_DISMISSED_TRAFFIC_NOTICE__ = signature;
      notice.remove();
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
      : (snapshotStatus?.state === "missing" ? "\u5feb\u7167\u7f3a\u5931" : "\u5feb\u7167\u5df2\u8fc7\u671f\u6216\u6807\u8bb0\u65e0\u6548");
    return card("\u672c\u5730\u529f\u80fd\u5feb\u7167\u9700\u5237\u65b0", el("div", { className: "anticodex-result anticodex-warn", text: [
      reason,
      refreshText || "\u8bf7\u70b9\u201c\u5237\u65b0\u672c\u5730\u529f\u80fd\u201d\uff0c\u5b8c\u6210\u540e\u518d\u8fd0\u884c MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u68c0\u67e5\u3002",
    ].join("\n") }));
  }

  async function refreshManagerStatus() {
    try {
      const healthResult = await safeJson("/health");
      const health = safeValue(healthResult, {});
      if (healthResult.ok) updateTrafficNotice(health);
      const manager = document.getElementById(MANAGER_ID);
      const busy = manager?.querySelector(".anticodex-actions")?.getAttribute("data-anticodex-busy") === "true";
      if (manager && !busy) await window.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
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
    return {
      codexVersion: activeHost.codexVersion || updateStatus.source?.codexVersion || "",
      sourcePackageVersion: activeHost.sourcePackageVersion || updateStatus.source?.packageVersion || "",
      activePackageVersion: drift.activePackageVersion || updateStatus.active?.packageVersion || "",
      updateStatusSource: sync.updateStatusSource || updateStatus.sourceType || "",
      updateDriftState: drift.state || updateStatus.reason || "",
      updateDriftHostChanged: typeof drift.hostChanged === "boolean" ? drift.hostChanged : null,
      updateDriftCliChanged: typeof drift.cliChanged === "boolean" ? drift.cliChanged : null,
      managerBridgeProcessCount: Number.isFinite(Number(managerBridge.processCount)) ? Number(managerBridge.processCount) : null,
      managerBridgeStaleProcessCount: Number.isFinite(Number(managerBridge.staleProcessCount)) ? Number(managerBridge.staleProcessCount) : null,
    };
  }

  function syncReadinessEvidenceLines(evidence) {
    const e = evidence || {};
    return [
      `\u7248\u672c\uff1aCodex ${e.codexVersion || "\u672a\u77e5"} / source ${e.sourcePackageVersion || "\u672a\u77e5"} / active ${e.activePackageVersion || "\u672a\u77e5"}`,
      `\u6f02\u79fb\uff1astate=${e.updateDriftState || "unknown"} / source=${e.updateStatusSource || "unknown"} / hostChanged=${triStateText(e.updateDriftHostChanged)} / cliChanged=${triStateText(e.updateDriftCliChanged)}`,
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
    if (!reports.length) return "\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u9a8c\u6536\u62a5\u544a\u3002\n\u53ef\u5148\u8fd0\u884c\u201c\u5feb\u901f\u603b\u68c0\u201d\u6216\u201c\u7a33\u5b9a\u6027\u5de1\u68c0\u201d\u751f\u6210\u62a5\u544a\u3002";
    const lines = [
      `\u62a5\u544a\u76ee\u5f55\uff1a${result.reportRoot || "\u672a\u77e5"}`,
      `\u5df2\u627e\u5230\uff1a${result.existingCount ?? reports.filter((item) => item.exists).length} \u4efd`,
    ];
    if (result.staleCount) {
      lines.push(`\u9700\u91cd\u8dd1\uff1a${result.staleCount} \u4efd\u62a5\u544a\u5df2\u8fc7\u671f`);
    }
    if (result.missingCount) {
      lines.push(`\u672a\u751f\u6210\uff1a${result.missingCount} \u4efd`);
    }
    if (result.invalidCount) {
      lines.push(`\u635f\u574f\u62a5\u544a\uff1a${result.invalidCount} \u4efd\u65e0\u6cd5\u8bfb\u53d6`);
    }
    if (!(result.existingCount ?? reports.filter((item) => item.exists).length)) {
      lines.push("\u63d0\u793a\uff1a\u8bf7\u5148\u8fd0\u884c\u5feb\u901f\u603b\u68c0\u3001\u5b8c\u6574\u603b\u68c0\u6216\u7a33\u5b9a\u6027\u5de1\u68c0\u3002");
    }
    for (const item of reports) {
      const passed = item.effectiveOk !== null && item.effectiveOk !== undefined ? item.effectiveOk : item.ok;
      const status = item.exists ? ((item.parseable === false || item.invalid) ? "\u62a5\u544a\u635f\u574f" : (item.stale ? "\u9700\u91cd\u8dd1" : (passed ? "\u901a\u8fc7" : "\u9700\u5904\u7406"))) : "\u672a\u751f\u6210";
      const elapsed = item.elapsedMs != null ? ` / ${item.elapsedMs} ms` : "";
      lines.push(`${item.label}\uff1a${status}${elapsed}`);
      const age = formatReportAge(item.ageMs);
      if (item.exists && age) lines.push(`  \u66f4\u65b0\uff1a${age}`);
      if (item.firstFailure) lines.push(`  \u9996\u4e2a\u5931\u8d25\uff1a${item.firstFailure}`);
      if (item.publicDocumentationOk !== null && item.publicDocumentationOk !== undefined) lines.push(`  \u516c\u5f00\u6587\u6863\uff1a${item.publicDocumentationOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
      if (item.releaseReady !== null && item.releaseReady !== undefined) {
        lines.push(`  Release Gate: short=${item.shortReady ? "true" : "false"} / release=${item.releaseReady ? "true" : "false"}`);
        if (item.strictOptionalRealTraffic !== null && item.strictOptionalRealTraffic !== undefined) lines.push(`  optionalRealTraffic: strict=${item.strictOptionalRealTraffic ? "true" : "false"} / ready=${item.optionalRealTrafficReady ? "true" : "false"}`);
        if (Array.isArray(item.optionalRealTrafficFailures) && item.optionalRealTrafficFailures.length) lines.push(`  optionalRealTrafficFailures: ${item.optionalRealTrafficFailures.slice(0, 6).join(", ")}`);
        if (Array.isArray(item.missingRequired) && item.missingRequired.length) lines.push(`  missingRequired: ${item.missingRequired.slice(0, 6).join(", ")}`);
        if (Array.isArray(item.missingShort) && item.missingShort.length) lines.push(`  missingShort: ${item.missingShort.slice(0, 6).join(", ")}`);
        if (Array.isArray(item.missingOptional) && item.missingOptional.length) lines.push(`  missingOptional: ${item.missingOptional.slice(0, 6).join(", ")}`);
        if (Array.isArray(item.damagedReports) && item.damagedReports.length) lines.push(`  damagedReports: ${item.damagedReports.slice(0, 6).join(", ")}`);
        if (Array.isArray(item.releaseGateFailureReasons) && item.releaseGateFailureReasons.length) {
          const failureReasons = item.releaseGateFailureReasons.slice(0, 6).map((gate) => `${gate.id}:${gate.failureReason || (Array.isArray(gate.failureReasons) ? gate.failureReasons[0] : "unsatisfied")}`).join(", ");
          lines.push(`  failureReasons: ${failureReasons}`);
          const reportFailureDetails = item.releaseGateFailureReasons
            .filter((gate) => gate?.selectedFile || (Array.isArray(gate?.reportFailureSamples) && gate.reportFailureSamples.length))
            .slice(0, 4)
            .map((gate) => {
              const sample = Array.isArray(gate.reportFailureSamples) && gate.reportFailureSamples.length ? ` / sample ${gate.reportFailureSamples.slice(0, 2).join(" | ")}` : "";
              return `${gate.id}:${gate.selectedFile || "no-file"}${gate.selectedMtime ? ` @ ${gate.selectedMtime}` : ""}${sample}`;
            });
          if (reportFailureDetails.length) lines.push(`  reportFailures: ${reportFailureDetails.join("; ")}`);
          const realTrafficEvidenceGates = item.releaseGateFailureReasons
            .filter((gate) => gate?.group === "real-traffic" && (["stale_report", "missing_report"].includes(gate.failureReason) || (Array.isArray(gate.failureReasons) && gate.failureReasons.some((reason) => ["stale_report", "missing_report"].includes(reason)))))
            .map((gate) => gate.id)
            .filter(Boolean);
          if (realTrafficEvidenceGates.length) {
            lines.push(`  真实流量验收证据需更新/未生成：这不是普通功能缺失；请显式运行耗真实流量的验证后再做完整检查（${realTrafficEvidenceGates.slice(0, 6).join(", ")}）`);
          }
        }
        if (Array.isArray(item.releaseGateSelectedReports) && item.releaseGateSelectedReports.length) {
          const selectedReports = item.releaseGateSelectedReports.slice(0, 6).map((entry) => `${entry.id}:${entry.selectedFile}`).join(", ");
          lines.push(`  selectedHistory: ${selectedReports}`);
        }
        if (Array.isArray(item.releaseGateGroups) && item.releaseGateGroups.length) {
          const groupSummary = item.releaseGateGroups.slice(0, 8).map((group) => `${group.group} req ${group.requiredSatisfied ?? 0}/${group.required ?? 0} opt ${group.optionalSatisfied ?? 0}/${group.optional ?? 0}`).join(" | ");
          lines.push(`  Release groups: ${groupSummary}`);
        }
        if (item.installedRuntimeEvidence) {
        const evidence = item.installedRuntimeEvidence;
        const fingerprintMatch = evidence.sourceFingerprint && evidence.installedRuntimeFingerprint && evidence.sourceFingerprint === evidence.installedRuntimeFingerprint;
        lines.push(`  installedRuntime: files=${evidence.sourceFileCount ?? "unknown"}/${evidence.installedRuntimeFileCount ?? "unknown"} / fingerprint=${fingerprintMatch ? "match" : "mismatch"} / mismatches=${Array.isArray(evidence.mismatchedRuntimeFiles) ? evidence.mismatchedRuntimeFiles.length : 0}`);
        const runtimeSamples = [
          ...(Array.isArray(evidence.missingSourceFiles) ? evidence.missingSourceFiles.map((item) => `missingSource:${item}`) : []),
          ...(Array.isArray(evidence.missingInstalledRuntimeFiles) ? evidence.missingInstalledRuntimeFiles.map((item) => `missingInstalled:${item}`) : []),
          ...(Array.isArray(evidence.mismatchedRuntimeFiles) ? evidence.mismatchedRuntimeFiles.map((item) => `mismatch:${item}`) : []),
        ].slice(0, 3);
        if (runtimeSamples.length) lines.push(`  installedRuntime drift: ${runtimeSamples.join(", ")}`);
      }
      }
      if (Array.isArray(item.releaseGateFailures) && item.releaseGateFailures.length) {
        const gateFailures = item.releaseGateFailures.slice(0, 4).map((gate) => {
          const details = Array.isArray(gate.semanticFailures) && gate.semanticFailures.length ? gate.semanticFailures.slice(0, 4).join(", ") : (gate.error || "unsatisfied");
          return `${gate.id}:${details}`;
        });
        lines.push(`  semanticFailures: ${gateFailures.join(" | ")}`);
        const sourceSnapshotMismatchGates = item.releaseGateFailures
          .filter((gate) => Array.isArray(gate.semanticFailures) && gate.semanticFailures.some((failure) => /_source_snapshot_mismatch$/.test(String(failure))))
          .map((gate) => gate.id)
          .filter(Boolean);
        if (sourceSnapshotMismatchGates.length) {
          lines.push(`  source snapshot mismatch: stale reports for ${sourceSnapshotMismatchGates.join(", ")}; refresh MCP/Skill and plugin capability reports`);
          lines.push("  source snapshot refresh: refresh local features first, then run normal MCP/Skill and plugin capability verifiers; do not edit latest report JSON by hand");
        }
      }
      if (item.sourceSnapshotEvidence) {
        const evidence = item.sourceSnapshotEvidence;
        const cache = evidence.cacheHitCount != null || evidence.cacheMissCount != null ? ` / cache=${evidence.cacheHitCount ?? "\u672a\u77e5"}/${evidence.cacheMissCount ?? "\u672a\u77e5"}` : "";
        const reused = evidence.reusedFromPreviousReport === true ? " / reused=true" : "";
        const skipped = evidence.refreshSkippedReason ? ` / reason=${evidence.refreshSkippedReason}` : "";
        lines.push(`  sourceSnapshot: files=${evidence.fileCount ?? "\u672a\u77e5"} / fingerprint=${evidence.fingerprint ? String(evidence.fingerprint).slice(0, 12) : "\u7f3a\u5931"}${cache}${reused}${skipped}`);
      }
      if (item.sourcePreflightEvidence) {
        const evidence = item.sourcePreflightEvidence;
        lines.push(`  sourcePreflight: js=${evidence.javascriptSyntaxOk ? "true" : "false"} / ps=${evidence.powershellSyntaxOk ? "true" : "false"} / profile=${evidence.upstreamProfileStorageOk ? "true" : "false"} / localConnector=${evidence.localConnectorVerifierOk ? "true" : "false"} / docs=${evidence.publicDocumentationOk ? "true" : "false"}`);
        lines.push(`  sourcePreflight: ui=${evidence.uiStateSelfTestOk ? "true" : "false"} / regression=${evidence.translatorRegressionOk ? "true" : "false"} / diff=${evidence.diffWhitespaceOk ? "true" : "false"} / skipFull=${evidence.skipFullRegression ? "true" : "false"}`);
      }
      if (item.logDbGuardEvidence) {
        const evidence = item.logDbGuardEvidence;
        lines.push(`  logDbGuard: protected=${evidence.protected ? "true" : "false"} / trigger=${evidence.triggerPresent ? "true" : "false"} / noTraffic=${evidence.noTraffic ? "true" : "false"} / wal=${evidence.walBytes ?? "unknown"}`);
      }
      if (item.missingHistoryEvidence) {
        const evidence = item.missingHistoryEvidence;
        lines.push(`  missingHistory: status=${evidence.status ?? "unknown"} / type=${evidence.errorType || "unknown"} / retryable=${evidence.retryable === false ? "false" : "true"} / previousId=${evidence.previousResponseIdMatched ? "true" : "false"} / routeStable=${evidence.noRouteChange ? "true" : "false"} / noTraffic=${evidence.usedRealTraffic === false ? "true" : "false"}`);
      }
      if (item.accountProxyEvidence) {
        const evidence = item.accountProxyEvidence;
        const phase = evidence.phaseSummary || {};
        const signals = evidence.antigravityLogSignals || {};
        lines.push(`  accountProxy: detail=${evidence.diagnosisDetail || "unknown"} / action=${evidence.suggestedAction || "none"} / localProxyBypassed=${evidence.localProxyBypassed ? "true" : "false"}`);
        lines.push(`  accountProxy phase: account=${phase.accountOk ? "ok" : "check"} / refresh=${phase.refreshOk ? "ok" : "check"} / models=${phase.modelCount ?? "unknown"} / real=${phase.realRequestAttempted ? (phase.realRequestOk ? "ok" : "check") : "not-attempted"}`);
        lines.push(`  accountProxy logs: source=${signals.sourcePresent ? "present" : "missing"} / fresh=${signals.sourceFresh ? "true" : "false"} / scanned=${signals.tailLinesScanned ?? "unknown"} / verify=${signals.verificationRequiredCount ?? 0} / network=${signals.generalNetworkFailureCount ?? 0}`);
      }
      if (Array.isArray(item.managerButtonResults) && item.managerButtonResults.length) {
        const actions = item.managerButtonResults.slice(0, 4).map((entry) => `${entry.action || "unknown"}:${entry.ok ? "ok" : "fail"}/bridge=${entry.bridgeReady ? "true" : "false"}/overlay=${entry.overlayPresent ? "true" : "false"}/hit=${entry.actionCenterHitsButton ? "true" : "false"}/close=${entry.closeHitAreaOk ? "true" : "false"}/newPage=${entry.managerOpenedNewPage ? "true" : "false"}/targets=${entry.pageTargetCountBeforeManagerOpen ?? "?"}->${entry.pageTargetCountAfterManagerOpen ?? "?"}`);
        lines.push(`  managerButtons: ${actions.join(" | ")}`);
      }
      if (item.skipped === true) {
        lines.push(`  skipped: ${item.reason || "no reason"} / requestedRealTraffic=${item.requestedRealTraffic ? "true" : "false"} / coverage=${item.coverageKind || "unknown"}`);
      }
      if (item.modelRoutingEvidence) {
        const evidence = item.modelRoutingEvidence;
        lines.push(`  modelRouting: mode=${evidence.mode || "unknown"} / skipRequests=${item.skipRequests ? "true" : "false"} / results=${evidence.skippedRequestCount ?? 0}/${evidence.resultCount ?? 0} / failed=${evidence.failedResultCount ?? 0}`);
        if (evidence.providerProtocol || evidence.providerModel || evidence.toolBridgeMode) lines.push(`  modelRouting route: protocol=${evidence.providerProtocol || "native"} / providerModel=${evidence.providerModel || "none"} / toolBridge=${evidence.toolBridgeMode || "unknown"}`);
      }
      if (item.modelThinkingEvidence) {
        const evidence = item.modelThinkingEvidence;
        lines.push(`  modelThinking: models=${evidence.actualModelCount ?? "\u672a\u77e5"}/${evidence.expectedModelCount ?? "\u672a\u77e5"} / thinking=${evidence.supportsThinkingCount ?? 0}/${evidence.modelCount ?? 0} / budgetMissing=${evidence.missingBudgetCount ?? 0}`);
        if (Array.isArray(evidence.reasoningLevels) && evidence.reasoningLevels.length) lines.push(`  modelThinking levels: ${evidence.reasoningLevels.join(", ")}`);
      }
      if (item.uiIdleEvidence) {
        const evidence = item.uiIdleEvidence;
        lines.push(`  uiIdle: samples=${evidence.healthySampleCount ?? 0}/${evidence.sampleCount ?? 0} / duration=${evidence.durationSec ?? "unknown"}s / reconnectText=${evidence.reconnectTextCount ?? 0} / loginText=${evidence.loginTextCount ?? 0}`);
      }
      if (item.syncReadinessEvidence) {
        const evidence = item.syncReadinessEvidence;
        lines.push(`  syncReadiness: noTraffic=${evidence.noTrafficReady ? "true" : "check"} / full=${evidence.fullMode ? "true" : "check"} / host=${evidence.activeHostReady && evidence.brandReady ? "ok" : "check"} / icons=${evidence.iconReady ? "ok" : "check"} / update=${evidence.updateReady ? "synced" : "check"} / guardrails=${evidence.guardrailsReady ? "ok" : "check"}`);
        lines.push(`  syncReadiness versions: codex=${evidence.codexVersion || "unknown"} / source=${evidence.sourcePackageVersion || "unknown"} / active=${evidence.activePackageVersion || "unknown"} / drift=${evidence.updateDriftState || "unknown"} / updateSource=${evidence.updateStatusSource || "unknown"} / hostChanged=${triStateText(evidence.updateDriftHostChanged)} / cliChanged=${triStateText(evidence.updateDriftCliChanged)}`);
        lines.push(`  syncReadiness shortcuts: ${evidence.shortcutReadyCount ?? 0}/${evidence.shortcutCount ?? 0} / managerBridge=${evidence.managerBridgeReady ? "ok" : "check"} / processes=${evidence.managerBridgeProcessCount ?? "?"} / stale=${evidence.managerBridgeStaleProcessCount ?? "?"} / clean=${evidence.cleanSyncState ? "true" : "false"}`);
      }
      if (item.installedOverallEvidence) {
        const evidence = item.installedOverallEvidence;
        lines.push(`  installedOverall: noTraffic=${evidence.noTraffic ? "true" : "false"} / coverage=${evidence.coverageKind || "unknown"} / usedRealTraffic=${evidence.usedRealTraffic ? "true" : "false"} / behaviorCovered=${evidence.behaviorCovered ? "true" : "false"}`);
        lines.push(`  installedOverall checks: ok=${evidence.okCheckCount ?? 0}/${evidence.checkCount ?? 0} / skipped=${evidence.skippedCheckCount ?? 0} / realSkipped=${Array.isArray(evidence.realTrafficSkippedChecks) ? evidence.realTrafficSkippedChecks.join(",") : ""}`);
      }
      if (item.toolBridgeEvidence) {
        const evidence = item.toolBridgeEvidence;
        lines.push(`  toolBridge: mode=${evidence.mode || "unknown"} / transport=${evidence.transport || "unknown"} / adapter=${evidence.localAdapter || "unknown"}`);
        lines.push(`  toolBridge native: events=${evidence.nativeAntigravityToolEvents ? "true" : "false"} / discovery=${evidence.nativeMcpDiscoveryVerified ? "true" : "false"} / approval=${evidence.nativeMcpApprovalProtocolVerified ? "true" : "false"} / resume=${evidence.sameCascadeResumeProbeVerified ? "true" : "false"}`);
        lines.push(`  toolBridge nativeMcp: envelope=${evidence.requestEnvelope || "unknown"} / field=${evidence.externalToolDefinitionsField || "unknown"} / usable=${evidence.externalToolDefinitionsUsable ? "true" : "false"} / schema=${evidence.schemaLikeRequestAcceptance || "unknown"} / call=${evidence.nativeMcpToolCallStatus || "unknown"}`);
      }
      if (item.mcpSkillEvidence) {
        const evidence = item.mcpSkillEvidence;
        const realListClean = evidence.mcpRealListCount == null || (evidence.mcpRealListCount >= 2 && evidence.mcpRealListPassed === evidence.mcpRealListCount);
        const clean = evidence.mcpMissingSharedCount === 0 && evidence.mcpExtraLocalCount === 0 && evidence.mcpChangedSharedCount === 0 && evidence.missingSharedSkillCount === 0 && (evidence.changedSharedSkillCount ?? 0) === 0 && evidence.conflictingDuplicateSkillCount === 0 && evidence.hasNodeRepl === true && evidence.skillSmokeReadable === true && realListClean;
        const hashCache = evidence.hashCacheHitCount != null || evidence.hashCacheMissCount != null ? ` / hashCache=${evidence.hashCacheHitCount ?? "\u672a\u77e5"}/${evidence.hashCacheMissCount ?? "\u672a\u77e5"}` : "";
        const realList = evidence.mcpRealListCount != null || evidence.mcpRealListPassed != null ? ` / list ${evidence.mcpRealListPassed ?? "\u672a\u77e5"}/${evidence.mcpRealListCount ?? "\u672a\u77e5"} tools=${evidence.mcpRealListToolCount ?? "\u672a\u77e5"}` : "";
        lines.push(`  MCP/Skill \u8bc1\u636e\uff1aMCP ${evidence.mcpCount ?? "\u672a\u77e5"}/${evidence.mcpSharedCount ?? "\u672a\u77e5"} / skills ${evidence.skillCount ?? "\u672a\u77e5"}/${evidence.expectedSharedSkillCount ?? "\u672a\u77e5"} / agents ${evidence.agentsSkillCount ?? "\u672a\u77e5"}${hashCache}`);
        lines.push(`  MCP/Skill parity: ${clean ? "\u5e72\u51c0" : "\u9700\u5904\u7406"} / smoke ${evidence.mcpSmokePassed ? "MCP ok" : "MCP ?"} / real ${evidence.mcpRealCallPassed ? "ok" : "?"}${realList} / skill ${evidence.skillSmokeReadable ? "ok" : "?"}`);
        if (evidence.appToolRegistryExists !== null && evidence.appToolRegistryExists !== undefined) {
          const registryClean = evidence.appToolRegistryExists === true && evidence.appToolRegistryContentMatches === true && evidence.appToolRegistryFingerprintMatches === true && evidence.appToolRegistrySharedFileCount != null && evidence.appToolRegistryLocalFileCount != null && evidence.appToolRegistrySharedFileCount === evidence.appToolRegistryLocalFileCount;
          lines.push(`  app-tool registry: ${registryClean ? "ok" : "\u9700\u5904\u7406"} / files=${evidence.appToolRegistrySharedFileCount ?? "\u672a\u77e5"}/${evidence.appToolRegistryLocalFileCount ?? "\u672a\u77e5"} / content=${evidence.appToolRegistryContentMatches ? "match" : "mismatch"} / fingerprint=${evidence.appToolRegistryFingerprintMatches ? "match" : "mismatch"}`);
        }
        if (Array.isArray(evidence.mcpMissingSharedSample) && evidence.mcpMissingSharedSample.length) lines.push(`  MCP missing: ${evidence.mcpMissingSharedSample.join(", ")}`);
        if (Array.isArray(evidence.mcpExtraLocalSample) && evidence.mcpExtraLocalSample.length) lines.push(`  MCP extra: ${evidence.mcpExtraLocalSample.join(", ")}`);
        if (Array.isArray(evidence.mcpChangedSharedSample) && evidence.mcpChangedSharedSample.length) lines.push(`  MCP changed: ${evidence.mcpChangedSharedSample.join(", ")}`);
        if (Array.isArray(evidence.missingSharedSkillSample) && evidence.missingSharedSkillSample.length) lines.push(`  skill missing: ${evidence.missingSharedSkillSample.join(", ")}`);
        if (Array.isArray(evidence.extraLocalSkillSample) && evidence.extraLocalSkillSample.length) lines.push(`  skill extra: ${evidence.extraLocalSkillSample.join(", ")}`);
        if (Array.isArray(evidence.changedSharedSkillSample) && evidence.changedSharedSkillSample.length) lines.push(`  skill changed: ${evidence.changedSharedSkillSample.join(", ")}`);
        if (Array.isArray(evidence.conflictingDuplicateSkillSample) && evidence.conflictingDuplicateSkillSample.length) lines.push(`  skill duplicate conflicts: ${evidence.conflictingDuplicateSkillSample.join(", ")}`);
      }
      if (item.refreshFeatureEvidence) {
        const evidence = item.refreshFeatureEvidence;
        const connectorOk = evidence.connectorSharedExists !== true || evidence.connectorContentMatches === true;
        const appToolOk = evidence.appToolSharedExists !== true || evidence.appToolContentMatches === true;
        const skillChanged = Array.isArray(evidence.changedExpectedSkills) ? evidence.changedExpectedSkills : [];
        const guidanceChanged = Array.isArray(evidence.guidanceChanged) ? evidence.guidanceChanged : [];
        const elapsed = evidence.elapsedMs != null ? ` / elapsed=${evidence.elapsedMs} ms` : "";
        const mode = evidence.verifyOnly === true ? " / verifyOnly=true" : "";
        const hashCache = evidence.hashCacheHitCount != null || evidence.hashCacheMissCount != null ? ` / hashCache=${evidence.hashCacheHitCount ?? "\u672a\u77e5"}/${evidence.hashCacheMissCount ?? "\u672a\u77e5"}` : "";
        const refreshSamples = [
          ...(evidence.connectorMissingSharedSample || []),
          ...(evidence.connectorExtraLocalSample || []),
          ...(evidence.connectorChangedSharedSample || []),
          ...(evidence.appToolMissingSharedSample || []),
          ...(evidence.appToolExtraLocalSample || []),
          ...(evidence.appToolChangedSharedSample || []),
        ].slice(0, 5);
        const refreshDrift = ` / connectorDrift=${evidence.connectorMissingSharedCount ?? 0}/${evidence.connectorExtraLocalCount ?? 0}/${evidence.connectorChangedSharedCount ?? 0} / appToolDrift=${evidence.appToolMissingSharedCount ?? 0}/${evidence.appToolExtraLocalCount ?? 0}/${evidence.appToolChangedSharedCount ?? 0}${refreshSamples.length ? ` / sample ${refreshSamples.join(", ")}` : ""}`;
        lines.push(`  refresh parity: connector=${connectorOk ? "ok" : "\u9700\u5904\u7406"} / appTool=${appToolOk ? "ok" : "\u9700\u5904\u7406"}${refreshDrift}${mode}${elapsed}${hashCache}`);
        if (skillChanged.length || guidanceChanged.length) lines.push(`  refresh drift: skills=${skillChanged.length ? skillChanged.slice(0, 5).join(", ") : "ok"} / guidance=${guidanceChanged.length ? guidanceChanged.slice(0, 5).join(", ") : "ok"}`);
      }
      if (item.localConnectorEvidence) {
        const evidence = item.localConnectorEvidence;
        lines.push(`  \u8fde\u63a5\u5668\u8bc1\u636e\uff1aChatGPT URL ${evidence.chatgptInstallUrlsScrubbed ? "\u5df2\u6e05\u7406" : "\u9700\u5904\u7406"} / \u4e0a\u6e38\u8bf7\u6c42 ${evidence.upstreamRequestsDuringLocalEndpoints ?? "\u672a\u77e5"} / allowlist ${evidence.allowlistedConnectorAccessible ? "\u88ab\u5f53\u6210\u6388\u6743" : "\u4e0d\u7b49\u4e8e\u6388\u6743"}`);
        const getPostMissing = Array.isArray(evidence.appToolGetPostMissingFromGet) ? evidence.appToolGetPostMissingFromGet : [];
        const getPostExtra = Array.isArray(evidence.appToolGetPostExtraFromGet) ? evidence.appToolGetPostExtraFromGet : [];
        const getPostSamples = [...getPostMissing, ...getPostExtra].slice(0, 5);
        lines.push(`  local connector upstream: before=${evidence.upstreamRequestsBeforeLocalEndpoints ?? "\u672a\u77e5"} / after=${evidence.upstreamRequestsAfterLocalEndpoints ?? "\u672a\u77e5"} / delta=${evidence.upstreamRequestsDuringLocalEndpoints ?? "\u672a\u77e5"}`);
        lines.push(`  local connector isolation: sharedHomeUsed=${evidence.tempSharedHomeUsed ? "true" : "false"} / codexHomeUnderState=${evidence.tempCodexHomeUnderStateRoot ? "true" : "false"} / sharedUnderState=${evidence.tempSharedCodexHomeUnderStateRoot ? "true" : "false"} / distinct=${evidence.tempCodexHomeDistinctFromShared ? "true" : "false"}`);
        lines.push(`  local connector parity: connector=${evidence.connectorParityClean ? "ok" : "\u9700\u5904\u7406"} / appTool=${evidence.appToolParityClean ? "ok" : "\u9700\u5904\u7406"} / getPost=${evidence.appToolGetPostParityClean ? "ok" : "\u9700\u5904\u7406"} / getPostMissing=${getPostMissing.length} / getPostExtra=${getPostExtra.length}${getPostSamples.length ? ` / sample ${getPostSamples.join(", ")}` : ""}`);
        lines.push(`  local cache fingerprints: connector=${evidence.connectorFingerprintMatches ? "match" : "\u672a\u77e5"} / appTool=${evidence.appToolFingerprintMatches ? "match" : "\u672a\u77e5"} / connectorFiles=${evidence.connectorSharedExists && evidence.connectorLocalExists ? "present" : "\u9700\u5904\u7406"} / appToolFiles=${evidence.appToolSharedExists && evidence.appToolLocalExists ? "present" : "\u9700\u5904\u7406"}`);
      }
      if (item.pluginCapabilityEvidence) {
        const evidence = item.pluginCapabilityEvidence;
        const parityClean = evidence.connectorParityClean === true && evidence.appToolParityClean === true && evidence.appToolGetPostParityClean === true;
        lines.push(`  \u5e94\u7528\u5de5\u5177\u8bc1\u636e\uff1a\u672a\u6388\u6743\u5de5\u5177 ${evidence.unauthorizedAppToolCount ?? "\u672a\u77e5"} / \u65e0 connector_id ${evidence.unattributedAppToolCount ?? "\u672a\u77e5"} / parity ${parityClean ? "\u5e72\u51c0" : "\u9700\u5904\u7406"}`);
        lines.push(`  app capability: state=${evidence.capabilityState || "unknown"} / degraded=${evidence.degraded ? "true" : "false"} / smokeChecked=${evidence.smokeChecked ? "true" : "false"} / endpointReadable=${evidence.endpointProjectionReadable ? "true" : "false"} / connectors=${evidence.accessibleConnectorCount ?? "\u672a\u77e5"}/${evidence.enabledConnectorCount ?? "\u672a\u77e5"}/${evidence.connectorCount ?? "\u672a\u77e5"} / tools=${evidence.appToolCount ?? "\u672a\u77e5"}/${evidence.appToolGetCount ?? "\u672a\u77e5"} / callable=${evidence.callableState || "unknown"} / nativeWriteback=${evidence.nativeCodexWriteback ? "true" : "false"}`);
        lines.push(`  app cache smoke: connector=${evidence.connectorCacheChecked ? "checked" : "\u672a\u77e5"}/${evidence.connectorCacheSampleReadable ? "readable" : "\u672a\u77e5"}/${evidence.connectorCacheFileCount ?? "\u672a\u77e5"} / appTools=${evidence.appToolsCacheChecked ? "checked" : "\u672a\u77e5"}/${evidence.appToolsCacheSampleReadable ? "readable" : "\u672a\u77e5"}/${evidence.appToolsCacheFileCount ?? "\u672a\u77e5"} / connectorChecked=${evidence.connectorParityChecked ? "true" : "false"} / appToolChecked=${evidence.appToolParityChecked ? "true" : "false"} / getPostChecked=${evidence.appToolGetPostParityChecked ? "true" : "false"}`);
        if (evidence.appToolsNote) lines.push(`  app capability note: ${evidence.appToolsNote}`);
        if (!parityClean) {
          const samples = [...(evidence.connectorParityMissingSharedSample || []), ...(evidence.connectorParityExtraLocalSample || []), ...(evidence.connectorParityChangedSharedSample || []), ...(evidence.appToolParityMissingSharedSample || []), ...(evidence.appToolParityExtraLocalSample || []), ...(evidence.appToolParityChangedSharedSample || []), ...(evidence.appToolGetPostMissingFromGetSample || []), ...(evidence.appToolGetPostExtraFromGetSample || [])].slice(0, 5);
          lines.push(`  parity drift: connectorMissing=${evidence.connectorParityMissingSharedCount ?? "\u672a\u77e5"} / connectorExtra=${evidence.connectorParityExtraLocalCount ?? "\u672a\u77e5"} / connectorChanged=${evidence.connectorParityChangedSharedCount ?? "\u672a\u77e5"} / appToolMissing=${evidence.appToolParityMissingSharedCount ?? "\u672a\u77e5"} / appToolExtra=${evidence.appToolParityExtraLocalCount ?? "\u672a\u77e5"} / appToolChanged=${evidence.appToolParityChangedSharedCount ?? "\u672a\u77e5"} / getPostMissing=${evidence.appToolGetPostMissingFromGetCount ?? "\u672a\u77e5"} / getPostExtra=${evidence.appToolGetPostExtraFromGetCount ?? "\u672a\u77e5"}${samples.length ? ` / sample ${samples.join(", ")}` : ""}`);
        }
        lines.push(`  \u539f\u751f Codex \u5199\u56de\uff1a${evidence.nativeCodexWriteback ? "\u9700\u5904\u7406" : "\u65e0"}`);
      }
      if (item.providerContinuity) {
        const continuity = item.providerContinuity;
        const markerCounts = [continuity.sixthMarkerCount, continuity.seventhMarkerCount, continuity.eighthMarkerCount, continuity.ninthMarkerCount].filter((value) => value !== null && value !== undefined).join("/");
        lines.push(`  providerContinuity: turns=${continuity.turns ?? "unknown"} / markers=${markerCounts || "unknown"}`);
        lines.push(`  toolPairs: restart=${continuity.restartPreservesOpenAiToolPair ? "true" : "false"} / openai=${continuity.providerSwitchPreservesOpenAiToolPair ? "true" : "false"} / anthropic=${continuity.protocolSwitchPreservesAnthropicToolPair ? "true" : "false"} / reverse=${continuity.reverseProtocolSwitchPreservesOpenAiToolPair ? "true" : "false"} / markerThresholds=${continuity.markerThresholdsOk ? "true" : "false"}`);
        lines.push(`  providerRoutes: provider=${continuity.providerSwitch?.from || "unknown"}->${continuity.providerSwitch?.to || "unknown"} reached=${continuity.providerSwitch?.requestReachedSecondProvider ? "true" : "false"} / protocol=${continuity.protocolSwitch?.from || "unknown"}->${continuity.protocolSwitch?.to || "unknown"} ${continuity.protocolSwitch?.provider || "unknown"}/${continuity.protocolSwitch?.model || "unknown"} reached=${continuity.protocolSwitch?.requestReachedAnthropicProvider ? "true" : "false"} / reverse=${continuity.reverseProtocolSwitch?.from || "unknown"}->${continuity.reverseProtocolSwitch?.to || "unknown"} ${continuity.reverseProtocolSwitch?.provider || "unknown"}/${continuity.reverseProtocolSwitch?.model || "unknown"} reached=${continuity.reverseProtocolSwitch?.requestReachedOpenAiCompatibleProvider ? "true" : "false"} / structural=${continuity.structuralEvidenceClean ? "true" : "false"} / toolTurns=${continuity.toolHistoryTurns ?? "unknown"}`);
      if (continuity.previousResponseContinuity) {
        const ids = continuity.previousResponseContinuity;
        lines.push(`  previousIds: save=${ids.savePresent ? "true" : "false"} / restart=${ids.restartPresent ? "true" : "false"} / provider=${ids.providerSwitchPresent ? "true" : "false"} / protocol=${ids.protocolSwitchPresent ? "true" : "false"} / reverse=${ids.reverseProtocolSwitchPresent ? "true" : "false"}`);
        lines.push(`  previousMatches: save=${ids.saveMatched ? "true" : "false"} / restart=${ids.restartMatched ? "true" : "false"} / provider=${ids.providerSwitchMatched ? "true" : "false"} / protocol=${ids.protocolSwitchMatched ? "true" : "false"} / reverse=${ids.reverseProtocolSwitchMatched ? "true" : "false"}`);
        lines.push(`  nestedMatches: provider=${ids.providerSwitchMatchesNested ? "true" : "false"} / protocol=${ids.protocolSwitchMatchesNested ? "true" : "false"} / reverse=${ids.reverseProtocolSwitchMatchesNested ? "true" : "false"}`);
      }
      if (continuity.previousResponseIdChain) {
        const chain = continuity.previousResponseIdChain;
        lines.push(`  previousChain: save=${chain.save || "missing"} / restart=${chain.restart || "missing"} / provider=${chain.providerSwitch || "missing"} / protocol=${chain.protocolSwitch || "missing"} / reverse=${chain.reverseProtocolSwitch || "missing"}`);
      }
        lines.push(`  orderedHistory: clean=${continuity.orderedHistoryClean ? "true" : "false"} / counts=${[continuity.sixthOrderedHistoryCount, continuity.seventhOrderedHistoryCount, continuity.eighthOrderedHistoryCount, continuity.ninthOrderedHistoryCount].filter((value) => value !== null && value !== undefined).join("/") || "unknown"}`);
      }
      if (item.optionalRealProviderEvidence) {
        const evidence = item.optionalRealProviderEvidence;
        lines.push(`  realProviderSmoke: first=${evidence.firstMarkerObserved ? "true" : "false"} / second=${evidence.secondMarkerObserved ? "true" : "false"} / history=${evidence.historyContinuationObserved ? "true" : "false"} / turns=${evidence.turns ?? "\u672a\u77e5"}`);
        lines.push(`  realProviderSmoke route: ${evidence.routeTransport || "\u672a\u77e5"} / ${evidence.routeProviderProtocol || "\u672a\u77e5"} / requested=${evidence.routeRequestedModel || "\u672a\u77e5"} / resolved=${evidence.routeResolvedModel || "\u672a\u77e5"} / status=${evidence.routeStatus || "\u672a\u77e5"} / redaction=${evidence.secretsRedacted ? "true" : "false"}`);
      }
      if (item.realProviderToAntigravityReturnEvidence) {
        const evidence = item.realProviderToAntigravityReturnEvidence;
        lines.push(`  realProviderToAntigravityReturn: requested=${evidence.requested ? "true" : "false"} / used=${evidence.realAntigravityTurnUsed ? "true" : "false"} / history=${evidence.returnedToAntigravityWithHistory ? "true" : "false"} / previousId=${evidence.previousResponseIdMatched ? "true" : "false"} / markers=${evidence.markerCount ?? "\u672a\u77e5"} missing=${evidence.missingMarkerCount ?? "\u672a\u77e5"}`);
        lines.push(`  realProviderToAntigravityRoute: ${evidence.returnUpstream || "\u672a\u77e5"} / ${evidence.routeTransport || "\u672a\u77e5"} / requested=${evidence.requestedModel || "\u672a\u77e5"} / resolved=${evidence.resolvedModel || "\u672a\u77e5"}`);
      }
      if (item.antigravityReturnEvidence) {
        const evidence = item.antigravityReturnEvidence;
        lines.push(`  fakeProviderToAntigravityReturn: history=${evidence.returnedToAntigravityWithHistory ? "true" : "false"} / previousId=${evidence.previousResponseIdMatched ? "true" : "false"} / markers=${evidence.markerCount ?? "\u672a\u77e5"} missing=${evidence.missingMarkerCount ?? "\u672a\u77e5"}`);
        lines.push(`  fakeProviderToAntigravityRoute: ${evidence.routeTransport || "\u672a\u77e5"} / ${evidence.resolvedModel || "\u672a\u77e5"}`);
      }
      if (item.coldRelaunchEvidence) {
        const evidence = item.coldRelaunchEvidence;
        lines.push(`  coldRelaunch: health=${evidence.healthOk ? "true" : "false"} / ready=${evidence.providerReady ? "true" : "false"} / mode=${evidence.mode || "unknown"} / main=${evidence.mainCount ?? "?"} / translator=${evidence.translatorCount ?? "?"} / launcher=${evidence.launcherCount ?? "?"} / originalCodex=${evidence.originalCodexUnchanged ? "unchanged" : "unknown"} / failedStages=${evidence.failedStageCount ?? "?"}`);
      }
      if (item.stabilitySoakEvidence) {
        const evidence = item.stabilitySoakEvidence;
        lines.push(`  stabilitySoak: ready=${evidence.providerReady && evidence.startReady && evidence.endReady ? "true" : "false"} / model=${evidence.model || "\u672a\u77e5"} / pidStable=${evidence.pidStable ? "true" : "false"} / healthChecks=${evidence.healthChecks ?? "?"} / turns=${evidence.turnCount ?? "?"} failed=${evidence.failedTurnCount ?? "?"}`);
      }
      if (item.exists && item.latestPath) lines.push(`  \u6587\u4ef6\uff1a${item.latestPath}`);
    }
    return lines.join("\n");
  }

  function ensureLatestReportsEvidenceLines(summary, payload) {
    const text = String(summary || "");
    if (!text || text.includes("\u516c\u5f00\u6587\u6863\uff1a")) return text;
    const candidates = [payload?.result, payload?.result?.result, payload].filter(Boolean);
    const reportPayload = candidates.find((item) => Array.isArray(item?.reports)) || {};
    const sourcePreflight = reportPayload.reports?.find((item) => item?.fileName === "latest-source-preflight.json");
    const publicDocumentationOk = sourcePreflight?.publicDocumentationOk;
    const inferredOk = publicDocumentationOk === null || publicDocumentationOk === undefined
      ? (text.includes("\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7") ? true : null)
      : publicDocumentationOk === true;
    if (inferredOk === null) return text;
    const publicDocumentationLine = `  \u516c\u5f00\u6587\u6863\uff1a${inferredOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`;
    if (sourcePreflight?.latestPath) {
      const fileLine = `  \u6587\u4ef6\uff1a${sourcePreflight.latestPath}`;
      if (text.includes(fileLine)) return text.replace(fileLine, `${publicDocumentationLine}\n${fileLine}`);
    }
    return `${text}\n${publicDocumentationLine}`;
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

  function summaryText(action, payload) {
    const r = payload?.result || payload || {};
    const unwrapped = r?.result && typeof r.result === "object" ? r.result : r;
    if (action === "refreshStatus") return `\u72b6\u6001\u5237\u65b0\uff1a${r.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`;
    if (action === "refreshModels") return `\u6a21\u578b\u5237\u65b0\uff1a${r.ok ? "\u5b8c\u6210" : "\u5931\u8d25"}\n\u6a21\u578b\u6570\uff1a${r.modelCount ?? r.models?.length ?? "\u672a\u77e5"}`;
    if (action === "resetAntigravitySessionLock") {
      const reset = r.result || r;
      return [
      "Antigravity \u4f1a\u8bdd\u9501\u5df2\u91cd\u7f6e\u3002",
      `\u5df2\u91ca\u653e\u6b63\u5728\u8fd0\u884c\u7684\u4f1a\u8bdd\uff1a${reset.activeReleased ? "\u662f" : "\u5426"}`,
      `\u5df2\u53d6\u6d88\u6392\u961f\u4f1a\u8bdd\uff1a${reset.queuedCancelled ?? 0}`,
    ].join("\n");
    }
    if (action === "accountSwitch") return [
      "\u5df2\u6253\u5f00 Antigravity \u684c\u9762\u7aef\u3002",
      "\u8bf7\u5728 Antigravity \u4e2d\u5207\u6362\u8d26\u53f7\uff0c\u5b8c\u6210\u540e\u56de\u5230 Anti-Codex \u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002",
      r.nextAction === "refreshModels" ? "\u4e0b\u4e00\u6b65\uff1a\u5237\u65b0\u6a21\u578b" : "",
    ].filter(Boolean).join("\n");
    if (action === "updateCheck") return `Codex \u66f4\u65b0\u68c0\u67e5\uff1a${updateStatusText(r)}`;
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
    if (action === "mcpSkills") return [
      `MCP/Skill \u6e05\u5355\u53ef\u89c1\uff1a${r.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      `MCP ${r.mcp?.count ?? "\u672a\u77e5"} / Skill ${r.skills?.count ?? "\u672a\u77e5"}`,
      `\u771f\u5b9e\u5de5\u5177\u8c03\u7528\uff1anode_repl ${r.mcp?.smoke?.realCall?.passed ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}\uff0cworker list ${Array.isArray(r.mcp?.smoke?.realList) ? r.mcp.smoke.realList.filter((entry) => entry && entry.passed === true).length : "\u672a\u77e5"}/${Array.isArray(r.mcp?.smoke?.realList) ? r.mcp.smoke.realList.length : "\u672a\u77e5"}\uff0cSkill \u6587\u4ef6 ${r.skills?.smoke?.readable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
    ].join("\n");
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
      ].filter(Boolean).join("\n");
    }
    if (action === "refreshFeatures" && payload?.background) return payload?.alreadyRunning ? "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u8bf7\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u6216 MCP/Skill\u3001\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002" : "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5f00\u59cb\u540e\u53f0\u6267\u884c\u3002\n\u754c\u9762\u4e0d\u4f1a\u7b49\u5f85\u957f\u65f6\u590d\u5236\uff1b\u5b8c\u6210\u540e\u7528 MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002";
    if (action === "refreshFeatures") return [
      `\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a${r.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`,
      `Skill ${r.skills?.count ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668\u7f13\u5b58 ${r.connectors?.count ?? "\u672a\u77e5"}`,
      sourceSnapshotLine(r),
      "\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a\u5237\u65b0\u540e\u4ecd\u9700\u5355\u72ec smoke \u9a8c\u8bc1",
    ].filter(Boolean).join("\n");
    if (action === "stabilitySoak") {
      if (payload.alreadyRunning) return "\u7a33\u5b9a\u6027\u5de1\u68c0\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
      return `${payload.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u7a33\u5b9a\u6027\u5de1\u68c0\u3002" : "\u542f\u52a8\u7a33\u5b9a\u6027\u5de1\u68c0\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-stability-soak.json\u3002`;
    }
    if (action === "coldRelaunch") {
      if (payload.alreadyRunning) return "\u51b7\u542f\u52a8\u9a8c\u8bc1\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u91cd\u542f Anti-Codex\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
      return `${payload.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u51b7\u542f\u52a8\u9a8c\u8bc1\u3002" : "\u542f\u52a8\u51b7\u542f\u52a8\u9a8c\u8bc1\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u91cd\u542f Anti-Codex\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-cold-relaunch.json\u3002`;
    }
    if (action === "syncHost") return payload?.alreadyRunning ? "\u540c\u6b65\u5df2\u5728\u540e\u53f0\u8fd0\u884c" : "\u5df2\u5f00\u59cb\u540e\u53f0\u540c\u6b65 Codex \u66f4\u65b0";
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
    if (action === "postVerificationFull") return "\u5df2\u5f00\u59cb\u540e\u53f0\u5b8c\u6574\u9a8c\u8bc1";
    return JSON.stringify(r, null, 2);
  }

  function timeoutText(action, label) {
    if (action === "accountSwitch") return "\u6253\u5f00 Antigravity \u8d85\u65f6\u3002\n\u8bf7\u624b\u52a8\u6253\u5f00 Antigravity\uff0c\u5207\u6362\u8d26\u53f7\u540e\u56de\u5230 Anti-Codex \u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002";
    if (action === "updateCheck") return "Codex \u66f4\u65b0\u68c0\u67e5\uff1a\u5df2\u63d0\u4ea4\u540e\u53f0\u6267\u884c\u3002";
    if (action === "refreshModels") return "\u6a21\u578b\u5237\u65b0\uff1a\u5df2\u63d0\u4ea4\u540e\u53f0\u6267\u884c\u3002";
    if (action === "refreshFeatures") return "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u63d0\u4ea4\u540e\u53f0\u6267\u884c\u3002\n\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a\u5237\u65b0\u540e\u7528 MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838";
    if (action === "syncHost" || action === "postVerificationFull" || action === "stabilitySoak" || action === "coldRelaunch") return `${label}\uff1a\u5df2\u63d0\u4ea4\u540e\u53f0\u6267\u884c\u3002\n\u8bf7\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u67e5\u770b\u6700\u65b0\u8fdb\u5ea6\uff0c\u4e0d\u8981\u91cd\u590d\u542f\u52a8\u540c\u4e00\u4e2a\u957f\u4efb\u52a1\u3002`;
    return `${label}\uff1a\u4ecd\u5728\u8fd0\u884c\u6216\u672c\u673a\u811a\u672c\u6b63\u5728\u6536\u5c3e\u3002\n\u5b8c\u6210\u540e\u9762\u677f\u4f1a\u81ea\u52a8\u66f4\u65b0\uff1b\u4e5f\u53ef\u4ee5\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u67e5\u770b\u6700\u65b0\u7ed3\u679c\u3002`;
  }

  function actionUiTimeoutMs(action) {
    if (action === "accountSwitch") return 65000;
    if (action === "fastOverallNoTraffic") return 90000;
    if (action === "updateCheck" || action === "sourcePreflight" || action === "mcpSkills" || action === "pluginCapabilities" || action === "syncReadiness" || action === "diagnosticsBundle") return EXTENDED_ACTION_UI_TIMEOUT_MS;
    return ACTION_UI_TIMEOUT_MS;
  }

  function pendingActionMaxMs(action) {
    if (action === "syncHost") return 30 * 60 * 1000;
    if (action === "stabilitySoak") return 20 * 60 * 1000;
    if (action === "coldRelaunch") return 10 * 60 * 1000;
    if (action === "postVerificationFull") return 20 * 60 * 1000;
    if (action === "overallNoTraffic") return 5 * 60 * 1000;
    if (action === "fastOverallNoTraffic") return 2 * 60 * 1000;
    return Math.max(60 * 1000, actionUiTimeoutMs(action) * 3);
  }

  function actionStillPending(action) {
    const pendingActions = window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ ||= {};
    const startedAt = Number(pendingActions[action] || 0);
    if (!startedAt) return false;
    if (Date.now() - startedAt > pendingActionMaxMs(action)) {
      delete pendingActions[action];
      return false;
    }
    return true;
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
      if (seconds < 8) return "\u9636\u6bb5\uff1a\u6784\u5efa Codex \u5019\u9009\u7248";
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
    if (action === "syncHost") return `${prefix}\n${progress}\n\u8fd9\u662f\u540e\u53f0\u540c\u6b65\u4efb\u52a1\uff1a\u5148\u6784\u5efa\u5019\u9009\u7248\uff0c\u9a8c\u8bc1\u901a\u8fc7\u624d\u66ff\u6362\u5f53\u524d Anti-Codex\u3002`;
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
    if (operation?.state === "succeeded") return "\u540c\u6b65\u6210\u529f";
    if (operation?.state === "failed") return "\u540c\u6b65\u5931\u8d25";
    if (operation?.state === "rolled_back") return "\u5df2\u56de\u6eda\u5230\u53ef\u7528\u7248\u672c";
    if (updateStatus?.ok !== true) return "\u66f4\u65b0\u68c0\u67e5\u4e0d\u53ef\u7528";
    return updateStatus?.updateNeeded === true ? "\u9700\u8981\u540c\u6b65" : "\u5df2\u662f\u6700\u65b0";
  }

  function updateOperationMessage(updateStatus) {
    return updateStatus?.operation?.message || (updateStatus?.ok === true ? "\u6682\u65e0" : (updateStatus?.reason || "\u672a\u68c0\u67e5"));
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
      #${MANAGER_ID}{color-scheme:dark;--ac-bg:#171717;--ac-surface:#1d1d1d;--ac-raised:#232323;--ac-hover:#2b2b2b;--ac-input-bg:#181818;--ac-line:rgba(255,255,255,.09);--ac-line-strong:rgba(255,255,255,.14);--ac-text:#f3f3f3;--ac-muted:#9b9b9b;--ac-value:#e8e8e8;--ac-result:#dedede;--ac-error:#ffb4bc;--ac-warn:#e8c98a;--ac-focus:#8c8c8c;--ac-backdrop:rgba(0,0,0,.68);--ac-shadow:rgba(0,0,0,.56);--ac-close-active:#303030;--ac-button-hover-line:rgba(255,255,255,.2);--ac-danger:#4b2228;--ac-danger-hover:#5b2830;--ac-danger-active:#682e37;--ac-danger-line:#783740;--ac-danger-hover-line:#914650;--ac-danger-text:#ffd8dd;--ac-danger-section:#21191b;--ac-danger-section-line:rgba(120,55,64,.52);position:fixed;inset:0;z-index:2147483647;background:var(--ac-backdrop);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:28px;font-family:"Segoe UI",Microsoft YaHei,sans-serif;color:var(--ac-text)}
      #${MANAGER_ID}[data-anticodex-theme="light"]{color-scheme:light;--ac-bg:#f7f7f7;--ac-surface:#fff;--ac-raised:#f1f1f1;--ac-hover:#e7e7e7;--ac-input-bg:#fff;--ac-line:rgba(0,0,0,.08);--ac-line-strong:rgba(0,0,0,.14);--ac-text:#1f1f1f;--ac-muted:#666;--ac-value:#292929;--ac-result:#333;--ac-error:#a52a3a;--ac-warn:#805d14;--ac-focus:#555;--ac-backdrop:rgba(20,20,20,.24);--ac-shadow:rgba(0,0,0,.22);--ac-close-active:#ddd;--ac-button-hover-line:rgba(0,0,0,.2);--ac-danger:#6e2832;--ac-danger-hover:#7a303b;--ac-danger-active:#842f3c;--ac-danger-line:#8e3d49;--ac-danger-hover-line:#9d4a56;--ac-danger-text:#fff4f5;--ac-danger-section:#fbf1f2;--ac-danger-section-line:rgba(122,48,59,.25)}
      #${MANAGER_ID}[data-anticodex-theme="dark"]{color-scheme:dark}
      #${MANAGER_ID} *{box-sizing:border-box}
      .anticodex-panel{width:min(1080px,96vw);height:min(840px,92vh);overflow:auto;border-radius:14px;background:var(--ac-bg);border:1px solid var(--ac-line-strong);box-shadow:0 28px 90px var(--ac-shadow);padding:20px}
      .anticodex-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px;padding:2px 2px 0}
      .anticodex-head h1{font-size:20px;line-height:1.3;letter-spacing:-.2px;margin:0 0 5px;font-weight:650}.anticodex-head p{margin:0;color:var(--ac-muted);font-size:12px}
      .anticodex-close{appearance:none;border:1px solid var(--ac-line);border-radius:9px;min-width:88px;width:88px;min-height:44px;height:48px;margin:0;padding:0;display:inline-flex;align-items:center;justify-content:center;line-height:1;background:var(--ac-raised);color:var(--ac-text);cursor:pointer;touch-action:manipulation;position:relative;z-index:2;pointer-events:auto;font:600 13px "Segoe UI",Microsoft YaHei,sans-serif;user-select:none;flex:0 0 auto;overflow:hidden}
      .anticodex-close>span{pointer-events:none}.anticodex-close:hover{background:var(--ac-hover);border-color:var(--ac-line-strong)}.anticodex-close:active{background:var(--ac-close-active)}.anticodex-close:focus-visible{outline:2px solid var(--ac-focus);outline-offset:2px}
      .anticodex-actions{display:grid;gap:10px;margin:0 0 14px}
      .anticodex-action-section{border:1px solid var(--ac-line);border-radius:12px;background:var(--ac-surface);padding:13px 14px 14px}
      .anticodex-action-section[data-tone="danger"]{background:var(--ac-danger-section);border-color:var(--ac-danger-section-line)}
      .anticodex-action-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:10px}
      .anticodex-action-section h2{margin:0;color:var(--ac-text);font-size:13px;font-weight:650}.anticodex-action-section p{margin:0;color:var(--ac-muted);font-size:11px;text-align:right}
      .anticodex-action-list{display:flex;flex-wrap:wrap;gap:7px}
      .anticodex-actions button{border:1px solid var(--ac-line-strong);border-radius:8px;min-height:40px;padding:0 13px;display:inline-flex;align-items:center;justify-content:center;line-height:1.15;background:var(--ac-raised);color:var(--ac-text);cursor:pointer;font:600 12px "Segoe UI",Microsoft YaHei,sans-serif;touch-action:manipulation;transition:background .12s ease,border-color .12s ease,transform .12s ease}
      .anticodex-actions button:hover{background:var(--ac-hover);border-color:var(--ac-button-hover-line)}.anticodex-actions button:active{transform:translateY(1px)}.anticodex-actions button:focus-visible{outline:2px solid var(--ac-focus);outline-offset:2px}.anticodex-actions button:disabled{opacity:.55;cursor:wait;transform:none}
      .anticodex-actions button.anticodex-action-danger{background:var(--ac-danger);border-color:var(--ac-danger-line);color:var(--ac-danger-text)}.anticodex-actions button.anticodex-action-danger:hover{background:var(--ac-danger-hover);border-color:var(--ac-danger-hover-line)}.anticodex-actions button.anticodex-action-danger:active{background:var(--ac-danger-active)}
      .anticodex-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.anticodex-card{border:1px solid var(--ac-line);background:var(--ac-surface);border-radius:12px;padding:14px;min-height:112px}
      .anticodex-card h2{font-size:13px;font-weight:650;margin:0 0 10px;color:var(--ac-text)}.anticodex-kv{display:grid;grid-template-columns:130px 1fr;gap:7px 10px;font-size:12px}.anticodex-k{color:var(--ac-muted)}.anticodex-v{color:var(--ac-value);word-break:break-word}
      .anticodex-result{white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--ac-result)}.anticodex-wide{grid-column:1/-1}.anticodex-error{color:var(--ac-error)}.anticodex-loading{color:var(--ac-muted)}.anticodex-warn{color:var(--ac-warn)}
      .anticodex-result-tools{display:flex;justify-content:flex-end;margin-top:10px}.anticodex-copy-result{border:1px solid var(--ac-line-strong);border-radius:8px;min-height:34px;padding:0 12px;background:var(--ac-raised);color:var(--ac-text);font:600 12px "Segoe UI",Microsoft YaHei,sans-serif;cursor:pointer}.anticodex-copy-result:hover{background:var(--ac-hover);border-color:var(--ac-button-hover-line)}
      .anticodex-connector-allowlist-input{width:100%;min-height:86px;resize:vertical;border:1px solid var(--ac-line);border-radius:10px;background:var(--ac-input-bg);color:var(--ac-text);padding:10px 11px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
      .anticodex-connector-allowlist-input:focus{outline:2px solid var(--ac-focus);outline-offset:2px}
      @media(max-width:820px){#${MANAGER_ID}{padding:12px}.anticodex-grid{grid-template-columns:1fr}.anticodex-panel{padding:15px}.anticodex-kv{grid-template-columns:1fr}.anticodex-action-section-head{display:block}.anticodex-action-section p{text-align:left;margin-top:3px}}
    ` });
    const root = el("div", { id: MANAGER_ID, role: "dialog", "aria-label": MANAGER_LABEL, "data-anticodex-manager-version": VERSION });
    const panel = el("div", { className: "anticodex-panel" });
    const title = el("div", {}, [
      el("h1", { text: MANAGER_LABEL }),
      el("p", { text: "\u5185\u7f6e\u9762\u677f\uff1a\u4e0d\u8d70 ChatGPT \u767b\u5f55\uff0c\u4e0d\u6d88\u8017\u6a21\u578b\u6d41\u91cf\u3002" }),
    ]);
    const close = el("button", { className: "anticodex-close", type: "button", "data-anticodex-close": "true" }, [
      el("span", { text: CLOSE_TEXT }),
    ]);
    close.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeManager();
    };
    const head = el("div", { className: "anticodex-head" }, [title, close]);
    const actions = el("div", { className: "anticodex-actions" });
    const grid = el("div", { className: "anticodex-grid" });
    grid.replaceChildren(card("\u6b63\u5728\u8bfb\u53d6", el("div", { className: "anticodex-result anticodex-loading", text: "\u6b63\u5728\u8bfb\u53d6\u672c\u5730\u72b6\u6001\uff0c\u9762\u677f\u4e0d\u4f1a\u6253\u5f00 ChatGPT \u767b\u5f55\u3002" })));
    const result = el("div", { className: "anticodex-result", "data-anticodex-result": "action", text: "\u6b63\u5728\u8bfb\u53d6\u72b6\u6001 ..." });
    const lastActionResult = window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__;
    const lastActionSummary = String(lastActionResult?.managerSummary || "");
    const preserveLastActionResult = Boolean(
      lastActionSummary &&
      lastActionResult.ok !== false &&
      lastActionResult.uiOnly !== true &&
      !lastActionSummary.includes("ui-only manager button smoke") &&
      !lastActionSummary.includes("\u8fd0\u884c\u5931\u8d25")
    );
    if (preserveLastActionResult) result.textContent = lastActionSummary;
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

    panel.append(style, head, actions, grid, card("\u68c0\u67e5\u7ed3\u679c", resultBody));
    root.append(panel);
    root.addEventListener("click", (event) => {
      if (event.target?.closest?.("[data-anticodex-close]")) {
        event.preventDefault();
        event.stopPropagation();
        removeManager();
        return;
      }
      if (event.target === root) removeManager();
    });
    document.body.append(root);
    installManagerThemeSync(root);
    refreshManagerStatus();

    function setActionButtonsDisabled(disabled) {
      for (const item of actions.querySelectorAll("button[data-action]")) item.disabled = !!disabled;
      actions.setAttribute("data-anticodex-busy", disabled ? "true" : "false");
    }

    async function load(options = {}) {
      const updateResult = options.updateResult !== false;
      const loadGeneration = actionGeneration;
      try {
        await ensureSnapshotForLoad();
        const [bootstrapResult, healthResult, modelsResult, diagnosticsResult, pluginsResult, connectorsResult, appToolsResult, allowlistResult, upstreamResult, routesResult] = await Promise.all([
          safeJson("/anticodex/manager/bootstrap"),
          safeJson("/health"),
          safeJson("/models"),
          safeJson("/anticodex/diagnostics", { timeoutMs: DIAGNOSTICS_FETCH_TIMEOUT_MS }),
          safeJson("/backend-api/ps/plugins/installed"),
          safeJson("/backend-api/aip/connectors"),
          safeJson("/backend-api/wham/apps"),
          safeJson("/anticodex/local-connectors/allowlist"),
          safeJson("/anticodex/upstream-profile"),
          safeJson("/anticodex/model-routes"),
        ]);
        const bootstrap = safeValue(bootstrapResult, {});
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
        const snapshotStateText = snapshotStatus.state === "fresh"
          ? "\u65b0\u9c9c"
          : (snapshotStatus.state === "stale"
            ? "\u5df2\u8fc7\u671f"
            : (snapshotStatus.state === "invalid" ? "\u6807\u8bb0\u65e0\u6548" : "\u6807\u8bb0\u7f3a\u5931"));
        const snapshotAgeText = Number.isFinite(Number(snapshotStatus.ageHours))
          ? `${Number(snapshotStatus.ageHours).toFixed(1)} \u5c0f\u65f6`
          : "\u672a\u77e5";
        const snapshotRefreshText = snapshotStatus.staleReason === "source_changed"
          ? "\u539f\u751f Codex \u672c\u5730\u529f\u80fd\u5df2\u53d8\u5316\uff0c\u8bf7\u70b9\u201c\u5237\u65b0\u672c\u5730\u529f\u80fd\u201d"
          : (snapshotStatus.stale ? "\u5feb\u7167\u5df2\u8fc7\u671f\u6216\u7f3a\u5931\uff0c\u8bf7\u70b9\u201c\u5237\u65b0\u672c\u5730\u529f\u80fd\u201d" : "\u5f53\u524d\u65e0\u9700\u5237\u65b0");
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
          card("\u672c\u5730\u8fde\u63a5\u5668\u5de5\u5177", connectorAllowlistEditor(allowlist)),
        ].filter(Boolean);
        grid.replaceChildren(...cards);
        result.classList.toggle("anticodex-error", loadErrors.length > 0);
        if (updateResult && !actionInFlight && loadGeneration === actionGeneration) {
          result.textContent = loadErrors.length
            ? `\u72b6\u6001\u5df2\u90e8\u5206\u5237\u65b0\uff0c\u4ee5\u4e0b\u9879\u9700\u590d\u6838\uff1a\n${loadErrors.join("\n")}`
            : "\u72b6\u6001\u5df2\u5237\u65b0\u3002";
        }
      } catch (error) {
        if (updateResult && !actionInFlight && loadGeneration === actionGeneration) {
          result.classList.add("anticodex-error");
          result.textContent = "\u8bfb\u53d6\u5931\u8d25\uff1a" + error.message;
        }
      }
    }

    window.__ANTICODEX_REFRESH_MANAGER_PANEL__ = () => load({ updateResult: false });

    async function showUpstreamConfig() {
      await ensureSnapshotForLoad();
      let profileResult = await safeJson("/anticodex/upstream-profile");
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
        el("option", { value: "openai-compatible", text: "OpenAI 兼容" }),
        el("option", { value: "anthropic", text: "Anthropic 原生" }),
      ]);
      protocol.value = saved.protocol || "openai-compatible";
      const baseUrl = el("input", { style: fieldStyle, value: saved.baseUrl || "", placeholder: "https://api.example.com/v1 或完整 /chat/completions / /v1/messages 地址" });
      const model = el("input", { style: fieldStyle, value: saved.model || "", placeholder: "模型名，例如 gpt-4o-mini / claude-3-5-sonnet" });
      const apiKey = el("input", { style: fieldStyle, type: "password", placeholder: saved.keyConfigured ? "已保存，可留空沿用旧 key" : "请输入 API key" });
      const stageBox = el("pre", { className: "anticodex-result", text: "先点“测试连通”。测试不会保存配置，也不会切换当前会话。" });
      const testButton = el("button", { type: "button", text: "测试连通" });
      const saveButton = el("button", { type: "button", className: "anticodex-action-danger", text: "保存并切换" });
      saveButton.disabled = true;
      const restoreButton = el("button", { type: "button", className: "anticodex-action-danger", text: "恢复 Antigravity" });
      const upstreamConfigFields = [protocol, baseUrl, model, apiKey];
      function upstreamConfigFingerprint() {
        return JSON.stringify([
          protocol.value,
          baseUrl.value.trim(),
          model.value.trim(),
          apiKey.value,
        ]);
      }
      const refreshUpstreamConfigControls = () => {
        for (const field of upstreamConfigFields) field.disabled = upstreamConfigOperationInFlight;
        testButton.disabled = upstreamConfigOperationInFlight;
        restoreButton.disabled = upstreamConfigOperationInFlight;
        saveButton.disabled = upstreamConfigOperationInFlight
          || !testedFingerprint
          || testedFingerprint !== upstreamConfigFingerprint();
      };
      const setUpstreamConfigBusy = (busy) => {
        upstreamConfigOperationInFlight = Boolean(busy);
        refreshUpstreamConfigControls();
      };
      const fillDefault = () => {
        if (!baseUrl.value.trim()) baseUrl.value = protocol.value === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
      };
      const invalidateConnectionTest = () => {
        lastStages = [];
        testedFingerprint = "";
        stageBox.classList.remove("anticodex-error");
        stageBox.textContent = "配置已修改，请重新测试。";
        refreshUpstreamConfigControls();
      };
      protocol.onchange = () => {
        fillDefault();
        invalidateConnectionTest();
      };
      fillDefault();
      for (const field of [baseUrl, model, apiKey]) {
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
      const applyAndWait = async (expectedMode) => {
        await managerPostJson("/anticodex/upstream-apply", {});
        stageBox.textContent = "配置已保存，正在重启本地模型通道；聊天记录和项目保持不变...";
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await wait(500);
          try {
            const current = await getJsonFrom(activeApi, "/anticodex/upstream-profile");
            if (current.active === expectedMode) {
              const bootstrap = await getJsonFrom(activeApi, "/anticodex/manager/bootstrap");
              managerToken = bootstrap?.token || managerToken;
              return true;
            }
          } catch {}
        }
        return false;
      };
      testButton.onclick = async () => {
        if (upstreamConfigOperationInFlight) return;
        const requestFingerprint = upstreamConfigFingerprint();
        setUpstreamConfigBusy(true);
        stageBox.textContent = "正在测试连通...";
        try {
          const payload = await managerPostJson("/anticodex/upstream-test", { protocol: protocol.value, baseUrl: baseUrl.value.trim(), model: model.value.trim(), apiKey: apiKey.value }, {
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
      };
      saveButton.onclick = async () => {
        if (upstreamConfigOperationInFlight || testedFingerprint !== upstreamConfigFingerprint()) {
          invalidateConnectionTest();
          return;
        }
        setUpstreamConfigBusy(true);
        stageBox.textContent = "正在保存配置...";
        try {
          const payload = await managerPostJson("/anticodex/upstream-profile", { mode: "third-party", protocol: protocol.value, baseUrl: baseUrl.value.trim(), model: model.value.trim(), apiKey: apiKey.value, stages: lastStages }, {
            timeoutMs: UPSTREAM_TEST_TIMEOUT_MS,
            retryCandidates: false,
          });
          stageBox.classList.remove("anticodex-error");
          if (payload.restartRequired) {
            const applied = await applyAndWait("third-party");
            stageBox.textContent = applied
              ? "已切换到第三方 API。聊天记录、项目和当前工作区保持不变。"
              : "配置已保存，但本地模型通道未在 30 秒内恢复。请关闭并重新打开 Anti-Codex；聊天记录不会丢失。";
            stageBox.classList.toggle("anticodex-error", !applied);
          } else {
            stageBox.textContent = "已保存。";
          }
        } catch (error) {
          stageBox.classList.add("anticodex-error");
          stageBox.textContent = "保存失败：" + error.message;
        } finally {
          setUpstreamConfigBusy(false);
        }
      };
      restoreButton.onclick = async () => {
        if (upstreamConfigOperationInFlight) return;
        setUpstreamConfigBusy(true);
        try {
          const payload = await managerPostJson("/anticodex/upstream-profile", { mode: "antigravity" }, {
            timeoutMs: UPSTREAM_TEST_TIMEOUT_MS,
            retryCandidates: false,
          });
          stageBox.classList.remove("anticodex-error");
          if (payload.restartRequired) {
            const applied = await applyAndWait("antigravity");
            stageBox.textContent = applied
              ? "已切回 Antigravity。第三方配置已保留，聊天记录不变。"
              : "已保存切回设置，但本地模型通道未在 30 秒内恢复。请关闭并重新打开 Anti-Codex；聊天记录不会丢失。";
            stageBox.classList.toggle("anticodex-error", !applied);
          } else {
            stageBox.textContent = "已切回 Antigravity。";
          }
        } catch (error) {
          stageBox.classList.add("anticodex-error");
          stageBox.textContent = "切回失败：" + error.message;
        } finally {
          setUpstreamConfigBusy(false);
        }
      };
      refreshUpstreamConfigControls();
      result.classList.remove("anticodex-error");
      result.replaceChildren(el("div", { style: "display:grid;gap:10px" }, [
        el("div", { className: "anticodex-warn", text: "第三方 API 失败时只会报错，不会自动消耗 Antigravity 流量。聊天记录、项目和当前工作区不会被清空。" }),
        row("协议", protocol),
        row("接口地址（可填 base URL 或完整接口）", baseUrl),
        row("模型名", model),
        row("API key", apiKey),
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [testButton, saveButton, restoreButton]),
        stageBox,
      ]));
    }

    function installActions() {
      actions.replaceChildren();
      const actionLists = new Map();
      for (const group of [
        { id: "daily", title: "\u65e5\u5e38\u64cd\u4f5c", description: "\u67e5\u770b\u3001\u5237\u65b0\u548c\u672c\u5730\u8bca\u65ad", ids: DAILY_ACTION_IDS, tone: "neutral" },
        { id: "high-impact", title: "\u7ef4\u62a4\u4e0e\u9ad8\u5f71\u54cd\u64cd\u4f5c", description: "\u53ef\u80fd\u91cd\u542f\u3001\u5199\u5165\u6216\u957f\u65f6\u95f4\u8fd0\u884c", ids: HIGH_IMPACT_ACTION_IDS, tone: "danger" },
      ]) {
        const list = el("div", { className: "anticodex-action-list" });
        const section = el("section", {
          className: "anticodex-action-section",
          "data-action-group": group.id,
          "data-tone": group.tone,
        }, [
          el("div", { className: "anticodex-action-section-head" }, [
            el("h2", { text: group.title }),
            el("p", { text: group.description }),
          ]),
          list,
        ]);
        actionLists.set(group.id, list);
        actions.append(section);
      }
      for (const [action, label] of ACTIONS) {
        const highImpact = HIGH_IMPACT_ACTION_IDS.has(action);
        const button = el("button", {
          className: highImpact ? "anticodex-action-danger" : "anticodex-action-neutral",
          "data-action": action,
          text: label,
        });
        button.addEventListener("click", async () => {
          if (action !== "upstreamConfig") {
            if (actionInFlight) {
              resetHighImpactConfirmation();
              result.textContent = "\u5df2\u6709\u4efb\u52a1\u5728\u8fd0\u884c\uff1a\u8bf7\u7b49\u5b83\u5b8c\u6210\uff0c\u6216\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u67e5\u770b\u8fdb\u5ea6\u3002";
              return;
            }
            if (action !== "refreshStatus" && actionStillPending(action)) {
              resetHighImpactConfirmation();
              result.textContent = `${label}\uff1a\u5df2\u63d0\u4ea4\u540e\u53f0\u6267\u884c\uff0c\u8bf7\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u67e5\u770b\u6700\u65b0\u8fdb\u5ea6\uff0c\u4e0d\u8981\u91cd\u590d\u542f\u52a8\u540c\u4e00\u4e2a\u4efb\u52a1\u3002`;
              return;
            }
          }
          if (requireHighImpactConfirmation(action, label, button)) {
            return;
          }
          if (action === "upstreamConfig") {
            await showUpstreamConfig();
            return;
          }
          actionGeneration += 1;
          const currentActionGeneration = actionGeneration;
          actionInFlight = true;
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
            const actionPromise = runActionViaBridge(action)
              .then((payload) => ({ type: "payload", payload }))
              .catch((error) => ({ type: "error", error }));
            const outcome = await Promise.race([
              actionPromise,
              new Promise((resolve) => setTimeout(() => resolve({ type: "timeout" }), actionUiTimeoutMs(action))),
            ]);
            if (outcome.type === "payload") {
              progressActive = false;
              if (action === "accountSwitch") {
                result.textContent = "Antigravity \u5df2\u6253\u5f00\uff0c\u6b63\u5728\u81ea\u52a8\u68c0\u6d4b\u8d26\u53f7\u6216\u6a21\u578b\u53d8\u5316\u2026";
                const change = await waitForAccountSwitch(accountSwitchBaseline);
                if (change.reason === "cancelled") {
                  return;
                } else if (change.changed) {
                  result.textContent = "\u5df2\u68c0\u6d4b\u5230\u5207\u6362\uff0c\u6b63\u5728\u81ea\u52a8\u5237\u65b0 Anti-Codex \u6a21\u578b\u2026";
                  const refreshPayload = await runActionViaBridge("refreshModels");
                  result.textContent = "\u8d26\u53f7\u6216\u6a21\u578b\u53d8\u5316\u5df2\u786e\u8ba4\u3002\n" + summaryText("refreshModels", refreshPayload);
                } else {
                  result.textContent = "\u672a\u68c0\u6d4b\u5230\u53ef\u8bc1\u660e\u7684\u8d26\u53f7\u6216\u6a21\u578b\u53d8\u5316\u3002\n\u5982\u679c\u4f60\u5df2\u5b8c\u6210\u5207\u6362\uff0c\u8bf7\u624b\u52a8\u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002";
                }
              } else {
                const managerSummary = summaryText(action, outcome.payload);
                window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
                  ...(outcome.payload || {}),
                  action,
                  managerSummary,
                  pending: false,
                };
                result.textContent = managerSummary;
              }
              await load({ updateResult: false });
            } else if (outcome.type === "timeout") {
              progressActive = false;
              const managerSummary = timeoutText(action, label);
              const pendingStartedAt = Date.now();
              const pendingActions = window.__ANTICODEX_MANAGER_PENDING_ACTIONS__ ||= {};
              pendingActions[action] = pendingStartedAt;
              window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
                ok: true,
                action,
                managerSummary,
                pending: true,
              };
              result.textContent = managerSummary;
              actionPromise.then(async (lateOutcome) => {
                if (pendingActions[action] === pendingStartedAt) delete pendingActions[action];
                if (lateOutcome.type === "payload") {
                  const lateSummary = summaryText(action, lateOutcome.payload);
                  window.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = {
                    ...(lateOutcome.payload || {}),
                    action,
                    managerSummary: lateSummary,
                    pending: false,
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
                } else if (lateOutcome.type === "error" && currentActionGeneration === actionGeneration && !actionInFlight) {
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
            result.removeAttribute("data-anticodex-running");
            setActionButtonsDisabled(false);
            if ((window.__ANTICODEX_MANAGER_ACTION_QUEUE__?.length || 0) === 0) {
              window.__ANTICODEX_MANAGER_ACTION_PROMISES__ = {};
            }
          }
        });
        actionLists.get(highImpact ? "high-impact" : "daily")?.append(button);
      }
    }

    installActions();
    load({ updateResult: !preserveLastActionResult }).catch((error) => {
      result.classList.add("anticodex-error");
      result.textContent = "读取失败：" + (error?.message || "本地状态暂不可用");
    });
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
