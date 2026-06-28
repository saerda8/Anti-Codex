export function createAntigravityRequestRegistry(options = {}) {
  const cancelCascade = options.cancelCascade ?? (async () => {});
  const cascadeCancelTimeoutMs = Number(options.cascadeCancelTimeoutMs ?? 1500);
  const requests = new Map();

  function register(responseId, request = {}) {
    if (!responseId) throw new Error("Antigravity response id is required.");
    if (requests.has(responseId)) throw new Error(`Antigravity response is already active: ${responseId}`);
    const entry = {
      controller: request.controller ?? new AbortController(),
      status: "active",
      cascade: null,
      cascadeCancelPromise: null,
      fingerprint: typeof request.fingerprint === "string" ? request.fingerprint : "",
    };
    requests.set(responseId, entry);
    return entry;
  }

  async function attachCascade(responseId, cascade) {
    const entry = requests.get(responseId);
    if (!entry) return false;
    entry.cascade = cascade;
    if (entry.status === "cancelling" || entry.status === "cancelled") {
      await waitForCascadeCancel(entry);
    }
    return true;
  }

  async function cancel(responseId) {
    const entry = requests.get(responseId);
    if (!entry) return { found: false, cancelled: false };
    if (entry.status === "cancelling" || entry.status === "cancelled") {
      const cascade = await waitForCascadeCancel(entry);
      return { found: true, cancelled: true, alreadyCancelled: true, cascade };
    }

    entry.status = "cancelling";
    entry.controller.abort(new DOMException("Anti-Codex response was cancelled.", "AbortError"));
    const cascade = await waitForCascadeCancel(entry);
    entry.status = "cancelled";
    return { found: true, cancelled: true, cascade };
  }

  function finish(responseId) {
    return requests.delete(responseId);
  }

  function get(responseId) {
    return requests.get(responseId) ?? null;
  }

  async function cancelAll() {
    const responseIds = [...requests.keys()];
    const results = await Promise.allSettled(responseIds.map((responseId) => cancel(responseId)));
    for (const responseId of responseIds) finish(responseId);
    return {
      requested: responseIds.length,
      cancelled: results.filter((result) => result.status === "fulfilled" && result.value?.cancelled).length,
      failed: results.filter((result) => result.status === "rejected").length,
    };
  }

  function snapshot(options = {}) {
    const statuses = {};
    for (const entry of requests.values()) {
      statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
    }
    const result = {
      active: requests.size,
      statuses,
    };
    if (options.includeEntries) {
      result.entries = [...requests.entries()].map(([responseId, entry]) => ({
        responseId,
        status: entry.status,
        fingerprint: entry.fingerprint || "",
      }));
    }
    return result;
  }

  function ensureCascadeCancel(entry) {
    if (!entry.cascade) return;
    if (!entry.cascadeCancelPromise) {
      entry.cascadeCancelPromise = Promise.resolve(cancelCascade(
        entry.cascade.connection,
        entry.cascade.cascadeId,
      )).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error?.message || error) }),
      );
    }
    return entry.cascadeCancelPromise;
  }

  async function waitForCascadeCancel(entry) {
    const promise = ensureCascadeCancel(entry);
    if (!promise) return { ok: true, skipped: true };
    const timeoutMs = Number.isFinite(cascadeCancelTimeoutMs) ? Math.max(0, cascadeCancelTimeoutMs) : 1500;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true, timeoutMs }), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { register, attachCascade, cancel, cancelAll, finish, get, snapshot };
}
