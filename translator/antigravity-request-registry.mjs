export function createAntigravityRequestRegistry(options = {}) {
  const cancelCascade = options.cancelCascade ?? (async () => {});
  const requests = new Map();

  function register(responseId, request = {}) {
    if (!responseId) throw new Error("Antigravity response id is required.");
    if (requests.has(responseId)) throw new Error(`Antigravity response is already active: ${responseId}`);
    const entry = {
      controller: request.controller ?? new AbortController(),
      status: "active",
      cascade: null,
      cascadeCancelPromise: null,
    };
    requests.set(responseId, entry);
    return entry;
  }

  async function attachCascade(responseId, cascade) {
    const entry = requests.get(responseId);
    if (!entry) return false;
    entry.cascade = cascade;
    if (entry.status === "cancelling" || entry.status === "cancelled") {
      await cancelAttachedCascade(entry);
    }
    return true;
  }

  async function cancel(responseId) {
    const entry = requests.get(responseId);
    if (!entry) return { found: false, cancelled: false };
    if (entry.status === "cancelling" || entry.status === "cancelled") {
      await entry.cascadeCancelPromise;
      return { found: true, cancelled: true, alreadyCancelled: true };
    }

    entry.status = "cancelling";
    entry.controller.abort(new DOMException("Anti-Codex response was cancelled.", "AbortError"));
    await cancelAttachedCascade(entry);
    entry.status = "cancelled";
    return { found: true, cancelled: true };
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

  function snapshot() {
    const statuses = {};
    for (const entry of requests.values()) {
      statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
    }
    return {
      active: requests.size,
      statuses,
    };
  }

  async function cancelAttachedCascade(entry) {
    if (!entry.cascade) return;
    if (!entry.cascadeCancelPromise) {
      entry.cascadeCancelPromise = Promise.resolve(cancelCascade(
        entry.cascade.connection,
        entry.cascade.cascadeId,
      ));
    }
    await entry.cascadeCancelPromise;
  }

  return { register, attachCascade, cancel, cancelAll, finish, get, snapshot };
}
