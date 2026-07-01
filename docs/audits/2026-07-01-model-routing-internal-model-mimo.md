# Model Routing internalModel Empty Failure Audit

Date: 2026-07-01
Scope: Analyze the case where `scripts/test-anticodex-model-routing.ps1` sent real requests to all 8 models, every model returned the expected marker, yet the test exited with failure because `internalModel` was empty in the route audit record.

## Symptom

All 8 models:

- Accepted the POST to `/v1/responses` and returned HTTP 200.
- Echoed the unique `MODEL_ROUTE_*` marker back in the response text.
- Produced a route audit entry via `/anticodex/model-routes` containing `requestedModel`, `resolvedModel`, `cascadeId`, `status: success`, and `displayName`.

Despite all of the above, every model row was flagged `ok = false` with the check string `missing internal model`.

## Root Cause in Script Logic

Lines 396-401 of `scripts/test-anticodex-model-routing.ps1` enforce, for the non-third-party path:

```powershell
if (-not [string]$route.internalModel) {
    $ok = $false
    $checks.Add("missing internal model") | Out-Null
}
```

When `internalModel` is an empty string or `$null`, `[string]$route.internalModel` evaluates to falsy.  The verifier then unconditionally marks the model row as failed regardless of every other evidence field being present and correct.

The same block also requires `cascadeId` (lines 402-404), but in this scenario `cascadeId` was populated; only `internalModel` was missing.

## Conclusion

1. **Request success does not equal verifier pass.**  A model returning a correct marker in the response body only proves that the upstream API handled the prompt.  The verifier additionally inspects the local route-audit record for structural fields; a missing field causes failure even when the end-to-end request succeeded.

2. **For CLI model-text transport, `internalModel` may not be required evidence.**  When `requestedModel`, `resolvedModel`, `cascadeId`, `status: success`, and a marker-matching response are all present, the routing path is functionally proven.  `internalModel` is an internal mapping hint; its absence does not indicate that the model was unresolved or that the wrong model was called.

3. **The main agent must check whether the release gate depends on `internalModel`.**  If the release-gate verifier reuses the same `missing internal model` check, the gate will remain red even though real traffic succeeds for every model.  Before relaxing the check the agent should confirm:
   - Whether `internalModel` is used downstream for billing, logging, or cascade decisions.
   - Whether the upstream server is expected to populate it for all model-text transports or only for certain providers.
   - Whether a fallback or default value is acceptable when the field is absent.

## Recommended Follow-Up

- Inspect the release-gate verifier source to confirm whether `internalModel` is a hard requirement or advisory metadata.
- If the upstream server intentionally omits `internalModel` for CLI model-text transport, either (a) relax the verifier check when all other evidence fields are present, or (b) have the server populate a sentinel value.
- Until the gate is adjusted, all 8-model routing runs will continue to exit with failure despite correct real traffic.
