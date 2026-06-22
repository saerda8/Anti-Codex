import { shouldRetryAntigravityFailure } from "./antigravity-upstream.mjs";

function circuitOpenError(snapshot) {
  const retryAfterMs = Math.max(0, Number(snapshot.retryAfterMs) || 0);
  const error = new Error(
    `Antigravity temporarily unavailable: recent proxy/network failures are cooling down for ${retryAfterMs}ms.`,
  );
  error.name = "AntigravityCircuitOpenError";
  error.statusCode = 503;
  error.type = "antigravity_temporarily_unavailable";
  error.retryable = true;
  error.retryAfterMs = retryAfterMs;
  return error;
}

export function createAntigravityFailureCircuit(options = {}) {
  const threshold = Math.max(1, Number(options.threshold ?? 3));
  const cooldownMs = Math.max(1, Number(options.cooldownMs ?? 15_000));
  const now = options.now ?? Date.now;
  let consecutiveFailures = 0;
  let openedUntil = null;
  let lastFailureMessage = "";

  function snapshot() {
    const currentTime = now();
    const open = openedUntil !== null && openedUntil > currentTime;
    const expired = openedUntil !== null && openedUntil <= currentTime;
    return {
      state: open ? "open" : "closed",
      consecutiveFailures: expired ? 0 : consecutiveFailures,
      openedUntil: open ? openedUntil : null,
      retryAfterMs: open ? Math.max(0, openedUntil - currentTime) : 0,
      lastFailureMessage: open ? lastFailureMessage : "",
    };
  }

  function beforeRequest() {
    const current = snapshot();
    if (current.state === "open") throw circuitOpenError(current);
    if (openedUntil !== null && openedUntil <= now()) reset();
  }

  function recordSuccess() {
    reset();
  }

  function recordFailure(error) {
    if (!shouldRetryAntigravityFailure(error)) return;
    consecutiveFailures += 1;
    lastFailureMessage = String(error?.message ?? error ?? "");
    if (consecutiveFailures >= threshold) {
      openedUntil = now() + cooldownMs;
    }
  }

  function reset() {
    consecutiveFailures = 0;
    openedUntil = null;
    lastFailureMessage = "";
  }

  return { beforeRequest, recordSuccess, recordFailure, snapshot };
}
