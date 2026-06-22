# Anti-Codex Account Switch And Recovery Audit

## Verified Result

- The normal account-switch workflow refreshes the live model catalog, then runs real model and installed checks.
- A non-interactive account refresh completed with the account fingerprint still comparable, eight visible models, a real marker response, and no ChatGPT login path.
- Account/proxy readiness differentiates account unavailable, transient proxy/network failure, and circuit-open states.
- Anti-Codex local requests bypass the proxy; Antigravity Desktop remains responsible for its Google-facing proxy connection.

## Fixed Gap

The restart fallback previously allowed startup to reuse the previous account's cached model catalog after hot refresh failed. The fallback now launches Anti-Codex with `ANTICODEX_FORCE_STARTUP_MODEL_REFRESH=1`.

The installed fallback verifier forced that path and proved:

- the Antigravity model catalog was regenerated;
- the gateway recovered account-ready with eight models;
- the original Codex main process set was unchanged.

## Residual Risks

- Account readiness is sampled, so a logout can remain stale until the next readiness probe or real request fails.
- In-flight requests cannot survive a deliberate cold restart fallback.
