function abortReason(signal) {
  return signal?.reason ?? new DOMException("Anti-Codex request was cancelled.", "AbortError");
}

function queueFullError(maxQueued) {
  const error = new Error(`Antigravity request queue is full (${maxQueued} queued request(s)); retry shortly.`);
  error.name = "AntigravityQueueFullError";
  error.statusCode = 429;
  error.type = "antigravity_queue_full";
  error.retryable = true;
  return error;
}

export function createAntigravityRequestQueue(options = {}) {
  const configuredMaxQueued = Number(options.maxQueued ?? 32);
  const maxQueued = Number.isFinite(configuredMaxQueued)
    ? Math.max(1, Math.floor(configuredMaxQueued))
    : 32;
  const queue = [];
  let running = false;
  let activeEntry = null;
  let accepted = 0;
  let rejected = 0;

  async function run(task, { signal } = {}) {
    if (signal?.aborted) throw abortReason(signal);
    if (queue.length >= maxQueued) {
      rejected += 1;
      throw queueFullError(maxQueued);
    }

    return new Promise((resolve, reject) => {
      const entry = {
        task,
        signal: signal ?? null,
        controller: new AbortController(),
        resolve,
        reject,
        cleanup: null,
      };
      queue.push(entry);
      accepted += 1;

      if (signal) {
        const onAbort = () => {
          if (!entry.controller.signal.aborted) entry.controller.abort(abortReason(signal));
          const index = queue.indexOf(entry);
          if (index === -1) return;
          queue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      if (!running) void processNext();
    });
  }

  async function processNext() {
    running = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift();
        activeEntry = entry;
        if (entry.controller.signal.aborted || entry.signal?.aborted) {
          entry.cleanup?.();
          entry.reject(entry.controller.signal.reason ?? abortReason(entry.signal));
          activeEntry = null;
          continue;
        }
        try {
          entry.resolve(await entry.task({ signal: entry.controller.signal }));
        } catch (error) {
          entry.reject(error);
        } finally {
          entry.cleanup?.();
          activeEntry = null;
        }
      }
    } finally {
      running = false;
      if (queue.length > 0) void processNext();
    }
  }

  function cancelAll(reason = new DOMException("Anti-Codex request queue is shutting down.", "AbortError")) {
    if (activeEntry && !activeEntry.controller.signal.aborted) activeEntry.controller.abort(reason);
    const queued = queue.splice(0, queue.length);
    for (const entry of queued) {
      entry.cleanup?.();
      if (!entry.controller.signal.aborted) entry.controller.abort(reason);
      entry.reject(reason);
    }
    return {
      activeCancelled: Boolean(activeEntry),
      queuedCancelled: queued.length,
    };
  }

  function snapshot() {
    return {
      running,
      queued: queue.length,
      maxQueued,
      accepted,
      rejected,
    };
  }

  return { run, cancelAll, snapshot };
}
