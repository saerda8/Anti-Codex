/**
 * Antigravity Readiness Monitor
 *
 * A pure-JS health/readiness monitor for the Antigravity account / model
 * status.  Never equates process health with account health.
 *
 * Usage:
 *   const m = createAntigravityReadinessMonitor({ probe: myProbe });
 *   await m.check();
 *   m.start();   // periodic polling
 *   m.stop();
 *   m.getSnapshot();   // { ready, state, modelCount, message, … }
 *
 * The injected `probe` must return { models: string[] } on success.
 *   - Non-empty models → state "ready", ready true
 *   - Empty models    → state "account_unavailable", ready false
 *   - Thrown error    → state "transient_error", ready false
 *
 * Abort/cancellation errors (AbortError / "The operation was aborted") never
 * overwrite a previously-known healthy state.  After an abort the snapshot
 * preserves the last known `ready`, `state`, `lastReadyAt`, and does NOT
 * increment `consecutiveFailures`.  The `lastProbeAborted` flag is set instead.
 */

/**
 * Returns true when the error is a cancellation (AbortError) that does NOT
 * reflect upstream health — the probe was externally cancelled or timed out.
 */
function isCancellationError(error) {
  if (!error) return false;
  // Standard DOMException / AbortError
  if (error.name === "AbortError") return true;
  // Fallback: message pattern for non-standard abort-like errors
  const message = String(error.message ?? "");
  return /The operation was aborted/i.test(message);
}

export function createAntigravityReadinessMonitor(options = {}) {
  const {
    probe,
    intervalMs = 30_000,
    now = () => Date.now(),
    setIntervalImpl = typeof setInterval !== "undefined" ? setInterval : undefined,
    clearIntervalImpl = typeof clearInterval !== "undefined" ? clearInterval : undefined,
  } = options;

  if (typeof probe !== "function") {
    throw new TypeError(
      "createAntigravityReadinessMonitor: probe function is required",
    );
  }

  // ── internal state ─────────────────────────────────────────────────────

  let snapshot = {
    ready: false,
    state: "unknown",
    modelCount: 0,
    message: "Antigravity readiness not yet checked",
    lastCheckedAt: null,
    lastReadyAt: null,
    consecutiveFailures: 0,
    lastProbeAborted: false,
  };

  /** In-flight check promise (dedup guard) */
  let runningProbe = null;

  /** Timer returned by setIntervalImpl */
  let intervalTimer = null;

  // ── check ──────────────────────────────────────────────────────────────

  /**
   * Run one probe and update the snapshot.
   * Concurrent calls share the same in-flight probe.
   * @returns {Promise<Readonly<Snapshot>>}
   */
  async function check() {
    if (runningProbe) return runningProbe;

    const checkedAt = now();

    runningProbe = (async () => {
      let newSnapshot;

      try {
        const result = await probe();
        const models = Array.isArray(result?.models) ? result.models : [];

        if (models.length === 0) {
          newSnapshot = {
            ready: false,
            state: "account_unavailable",
            modelCount: 0,
            message: "Antigravity account is available but returned no models",
            lastCheckedAt: checkedAt,
            lastReadyAt: snapshot.lastReadyAt,
            consecutiveFailures: snapshot.consecutiveFailures + 1,
            lastProbeAborted: false,
          };
        } else {
          newSnapshot = {
            ready: true,
            state: "ready",
            modelCount: models.length,
            message: `Antigravity ready with ${models.length} model(s)`,
            lastCheckedAt: checkedAt,
            lastReadyAt: checkedAt,
            consecutiveFailures: 0,
            lastProbeAborted: false,
          };
        }
      } catch (error) {
        if (isCancellationError(error)) {
          // Abort/cancellation does NOT reflect service health.
          // Preserve the last known state, only update the message and time.
          newSnapshot = {
            ...snapshot,
            message: `Antigravity probe aborted: ${error?.message ?? error}`,
            lastCheckedAt: checkedAt,
            // lastReadyAt, ready, state, modelCount all preserved from before
            consecutiveFailures: snapshot.consecutiveFailures,
            lastProbeAborted: true,
          };
        } else {
          newSnapshot = {
            ready: false,
            state: "transient_error",
            modelCount: 0,
            message: `Antigravity probe error: ${error?.message ?? error}`,
            lastCheckedAt: checkedAt,
            lastReadyAt: snapshot.lastReadyAt,
            consecutiveFailures: snapshot.consecutiveFailures + 1,
            lastProbeAborted: false,
          };
        }
      }

      snapshot = newSnapshot;
      return snapshot;
    })();

    try {
      return await runningProbe;
    } finally {
      runningProbe = null;
    }
  }

  // ── getSnapshot ────────────────────────────────────────────────────────

  /** Return a shallow copy of the current snapshot. */
  function getSnapshot() {
    return { ...snapshot };
  }

  // ── start / stop ───────────────────────────────────────────────────────

  /**
   * Start periodic polling.  Idempotent — multiple calls only register one
   * interval.  The timer is unref'd when possible so it doesn't keep the
   * process alive.
   */
  function start() {
    if (intervalTimer) return;

    if (typeof setIntervalImpl !== "function") {
      throw new Error("createAntigravityReadinessMonitor: setInterval is not available");
    }

    intervalTimer = setIntervalImpl(() => {
      // eslint-disable-next-line no-void
      void check();
    }, intervalMs);

    // Unref when available so the monitor never keeps the process alive
    if (intervalTimer && typeof intervalTimer.unref === "function") {
      intervalTimer.unref();
    }
  }

  /** Stop periodic polling.  Safe to call when already stopped. */
  function stop() {
    if (!intervalTimer) return;

    if (typeof clearIntervalImpl === "function") {
      clearIntervalImpl(intervalTimer);
    }
    intervalTimer = null;
  }

  // ── public API ─────────────────────────────────────────────────────────

  return { start, stop, check, getSnapshot };
}
