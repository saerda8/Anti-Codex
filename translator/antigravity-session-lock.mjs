function abortReason(signal) {
  return signal?.reason ?? new DOMException("Anti-Codex Antigravity session was cancelled.", "AbortError");
}

export function createAntigravitySessionLock(options = {}) {
  const configuredMaxQueued = Number(options.maxQueued ?? 32);
  const maxQueued = Number.isFinite(configuredMaxQueued)
    ? Math.max(1, Math.floor(configuredMaxQueued))
    : 32;
  const ttlMs = Math.max(1_000, Number(options.ttlMs ?? 10 * 60 * 1000) || 10 * 60 * 1000);
  const queue = [];
  let active = null;
  let accepted = 0;
  let rejected = 0;
  let continued = 0;
  let expired = 0;

  function acquire({ previousResponseId = "", signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const previousId = String(previousResponseId || "");
    if (active && previousId && active.responseIds.has(previousId)) {
      continued += 1;
      return Promise.resolve(createLease(active));
    }
    if (!active) {
      active = createEntry();
      accepted += 1;
      return Promise.resolve(createLease(active));
    }
    if (queue.length >= maxQueued) {
      rejected += 1;
      const error = new Error(`Antigravity session lock is busy (${queue.length} queued session(s)); retry shortly.`);
      error.name = "AntigravitySessionBusyError";
      error.statusCode = 429;
      error.type = "antigravity_session_busy";
      error.retryable = true;
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, cleanup: null };
      queue.push(entry);
      if (signal) {
        const onAbort = () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          entry.cleanup?.();
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
    });
  }

  function createEntry() {
    return {
      id: cryptoRandomId(),
      responseIds: new Set(),
      timer: null,
      createdAt: Date.now(),
      continuedAt: null,
    };
  }

  function createLease(entry) {
    let released = false;
    return {
      id: entry.id,
      continueWith(responseId) {
        if (!responseId || active !== entry) return false;
        entry.responseIds.add(String(responseId));
        entry.continuedAt = Date.now();
        refreshExpiry(entry);
        return true;
      },
      release() {
        if (released) return;
        released = true;
        releaseEntry(entry);
      },
    };
  }

  function refreshExpiry(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (active !== entry) return;
      expired += 1;
      releaseEntry(entry);
    }, ttlMs);
    entry.timer.unref?.();
  }

  function releaseEntry(entry) {
    if (active !== entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    active = null;
    processNext();
  }

  function processNext() {
    while (!active && queue.length > 0) {
      const next = queue.shift();
      next.cleanup?.();
      if (next.signal?.aborted) {
        next.reject(abortReason(next.signal));
        continue;
      }
      active = createEntry();
      accepted += 1;
      next.resolve(createLease(active));
      return;
    }
  }

  function snapshot() {
    return {
      active: Boolean(active),
      activeResponseIds: active ? [...active.responseIds] : [],
      queued: queue.length,
      maxQueued,
      accepted,
      rejected,
      continued,
      expired,
    };
  }

  function cancelAll() {
    if (active?.timer) clearTimeout(active.timer);
    const hadActive = Boolean(active);
    active = null;
    const queued = queue.splice(0, queue.length);
    const reason = new DOMException("Anti-Codex Antigravity session lock is shutting down.", "AbortError");
    for (const entry of queued) {
      entry.cleanup?.();
      entry.reject(reason);
    }
    return { activeCancelled: hadActive, queuedCancelled: queued.length };
  }

  function reset({ reason = "manual_reset" } = {}) {
    if (active?.timer) clearTimeout(active.timer);
    const hadActive = Boolean(active);
    active = null;
    const queued = queue.splice(0, queue.length);
    const error = new DOMException("Anti-Codex Antigravity session lock was reset locally.", "AbortError");
    for (const entry of queued) {
      entry.cleanup?.();
      entry.reject(error);
    }
    processNext();
    return {
      ok: true,
      reason,
      activeReleased: hadActive,
      queuedCancelled: queued.length,
      snapshot: snapshot(),
    };
  }

  return { acquire, snapshot, cancelAll, reset };
}

function cryptoRandomId() {
  return `ag_session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
