export function createAntigravityAccountTracker(options = {}) {
  const onChange = options.onChange;
  const configuredConfirmationObservations = Number(options.confirmationObservations ?? 1);
  const confirmationObservations = Number.isFinite(configuredConfirmationObservations)
    ? Math.max(1, Math.floor(configuredConfirmationObservations))
    : 1;
  if (typeof onChange !== "function") {
    throw new TypeError("createAntigravityAccountTracker: onChange function is required");
  }

  let fingerprint = "";
  let pendingFingerprint = "";
  let pendingObservations = 0;

  async function observe(account, context = {}) {
    const next = account?.identityAvailable
      ? String(account.fingerprint ?? "")
      : "";
    if (!next) {
      return { observed: false, changed: false, fingerprint };
    }
    if (!fingerprint) {
      fingerprint = next;
      pendingFingerprint = "";
      pendingObservations = 0;
      return { observed: true, changed: false, fingerprint };
    }
    if (next === fingerprint) {
      pendingFingerprint = "";
      pendingObservations = 0;
      return { observed: true, changed: false, fingerprint };
    }

    if (pendingFingerprint !== next) {
      pendingFingerprint = next;
      pendingObservations = 1;
    } else {
      pendingObservations += 1;
    }
    if (pendingObservations < confirmationObservations) {
      return {
        observed: true,
        changed: false,
        fingerprint,
        pendingFingerprint,
        pendingObservations,
        requiredObservations: confirmationObservations,
      };
    }

    const previousFingerprint = fingerprint;
    await onChange({
      previousFingerprint,
      fingerprint: next,
      account,
      ...context,
    });
    fingerprint = next;
    pendingFingerprint = "";
    pendingObservations = 0;
    return {
      observed: true,
      changed: true,
      previousFingerprint,
      fingerprint,
    };
  }

  function getSnapshot() {
    return {
      identityAvailable: Boolean(fingerprint),
      fingerprint,
      pendingFingerprint,
      pendingObservations,
      requiredObservations: confirmationObservations,
    };
  }

  return { observe, getSnapshot };
}
