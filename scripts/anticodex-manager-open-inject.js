(() => {
  const existingOverlay = document.getElementById("anticodex-manager-overlay");
  if (existingOverlay) {
    existingOverlay.setAttribute("data-anticodex-open-refresh", String(Date.now()));
    window.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
    return;
  }
  if (window.__ANTICODEX_MANAGER_VERSION__ === "native-panel-v92" && typeof window.__ANTICODEX_OPEN_MANAGER__ === "function") {
    window.__ANTICODEX_OPEN_MANAGER__();
  }
})();



