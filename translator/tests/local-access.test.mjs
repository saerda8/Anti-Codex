import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const {
  HOST,
  LISTEN_HOST,
  antigravityAccountFallbackSnapshot,
  antigravityTrafficSnapshot,
  antigravityFailureDetails,
  applyAntigravityTrafficFailure,
  applyAntigravityTrafficSuccess,
  buildAntigravityModelRefresh,
  providerModelRefreshSnapshot,
  antigravityReadinessFailure,
  antigravityVisibleModelIds,
  diagnosticsPayload,
  isLocalTranslatorAddress,
  isResponsesWebSocketPath,
  translatorHealthPayload,
  unsupportedResponsesWebSocketHttpResponse,
  unsupportedResponsesWebSocketResponse,
  visibleModelPayload,
  recordResponsesWebSocketAttempt,
  responsesWebSocketAuditSnapshot,
  shouldRecordAntigravityTrafficFailure,
} = await import("../adaptive-server.mjs");
const {
  localBackendApiResponse,
  readConnectorDirectory,
  readAppTools,
  readPluginRegistrations,
} = await import("../local-projection/index.mjs");

test("local translator access accepts only loopback or the bound local address", () => {
  assert.equal(isLocalTranslatorAddress("127.0.0.1", "192.168.1.2"), true);
  assert.equal(isLocalTranslatorAddress("::ffff:127.0.0.1", "192.168.1.2"), true);
  assert.equal(isLocalTranslatorAddress("192.168.1.2", "192.168.1.2"), true);
  assert.equal(isLocalTranslatorAddress("192.168.1.50", "192.168.1.2"), false);
});

test("unsupported websocket prewarm returns an explicit non-404 response", () => {
  assert.deepEqual(unsupportedResponsesWebSocketResponse(), {
    status: 501,
    body: {
      error: {
        message: "Responses websocket is not supported by this local translator; use HTTP fallback.",
        type: "unsupported_websocket",
      },
    },
  });
});

test("responses websocket fallback only targets Responses websocket paths", () => {
  assert.equal(isResponsesWebSocketPath("/responses"), true);
  assert.equal(isResponsesWebSocketPath("/v1/responses"), true);
  assert.equal(isResponsesWebSocketPath("/codex/responses"), true);
  assert.equal(isResponsesWebSocketPath("/responses/compact"), false);
  assert.equal(isResponsesWebSocketPath("/chat/completions"), false);
});

test("responses websocket upgrade fallback returns explicit non-101 HTTP response", () => {
  const response = unsupportedResponsesWebSocketHttpResponse();
  const [, body] = response.split("\r\n\r\n");

  assert.match(response, /^HTTP\/1\.1 501 Not Implemented\r\n/);
  assert.match(response, /content-type: application\/json; charset=utf-8/i);
  assert.match(response, /connection: close/i);
  assert.match(response, /content-length: \d+/i);
  assert.equal(JSON.parse(body).error.type, "unsupported_websocket");
  assert.equal(response.includes("101 Switching Protocols"), false);
});

test("responses websocket attempts are audited without prompt data", () => {
  const before = responsesWebSocketAuditSnapshot().attempts;
  const req = {
    method: "GET",
    url: "/v1/responses?model=hidden",
    headers: {
      host: "127.0.0.1:8282",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "codex.responses.v1",
      "user-agent": "Codex-Test",
    },
    socket: { remoteAddress: "127.0.0.1" },
  };

  const attempt = recordResponsesWebSocketAttempt(req, {
    kind: "upgrade",
    status: 501,
    responseType: "unsupported_websocket",
    pathname: "/v1/responses",
  });
  const audit = responsesWebSocketAuditSnapshot();

  assert.equal(audit.supported, false);
  assert.equal(audit.fallbackStatus, 501);
  assert.equal(audit.fallbackType, "unsupported_websocket");
  assert.equal(audit.attempts, before + 1);
  assert.equal(audit.lastUpgrade.path, "/v1/responses");
  assert.equal(audit.lastUpgrade.query, true);
  assert.equal(audit.lastUpgrade.status, 501);
  assert.equal(audit.lastUpgrade.responseType, "unsupported_websocket");
  assert.equal(audit.lastUpgrade.secWebSocketProtocol, "codex.responses.v1");
  assert.equal(audit.lastUpgrade.userAgent, "Codex-Test");
  assert.deepEqual(attempt, audit.lastUpgrade);
  assert.equal(JSON.stringify(audit).includes("hidden"), false);
});

test("translator health separates process health from Antigravity account readiness", () => {
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    readiness: {
      ready: false,
      state: "account_unavailable",
      modelCount: 0,
      message: "Sign in to Antigravity.",
      lastCheckedAt: "2026-06-13T00:00:00.000Z",
      lastReadyAt: null,
      consecutiveFailures: 2,
    },
  });
  assert.deepEqual({
    ...payload,
    upstreamProfile: undefined,
  }, {
    ok: true,
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    upstreamProfile: undefined,
    accountReady: false,
    accountState: "account_unavailable",
    modelCount: 0,
    accountMessage: "Sign in to Antigravity.",
    accountTrafficReady: null,
    accountTrafficState: "not_checked",
    accountTrafficType: null,
    accountTrafficDiagnosis: null,
    accountTrafficStatus: null,
    accountTrafficRetryable: null,
    accountTrafficMessage: "",
    accountTrafficSuggestedAction: "",
    accountTrafficLastFailureAt: null,
    accountTrafficLastSuccessAt: null,
    accountLastCheckedAt: "2026-06-13T00:00:00.000Z",
    accountLastReadyAt: null,
    accountConsecutiveFailures: 2,
  });
  assert.equal(payload.upstreamProfile.capabilitySummary.present, false);
  assert.equal(payload.upstreamProfile.capabilitySummary.failCount, 0);
});

test("translator health keeps cached Antigravity models when account detail probe is empty", () => {
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    cachedModelCount: 8,
    readiness: {
      ready: false,
      state: "account_unavailable",
      modelCount: 0,
      message: "Antigravity account is available but returned no models",
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastReadyAt: null,
      consecutiveFailures: 1,
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.accountReady, true);
  assert.equal(payload.accountState, "model_catalog_ready");
  assert.equal(payload.modelCount, 8);
  assert.match(payload.accountMessage, /cached model catalog/);
  assert.equal(payload.accountTrafficReady, null);
  assert.equal(payload.accountTrafficState, "not_checked");
});

test("translator health keeps cached Antigravity models during transient readiness errors", () => {
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    cachedModelCount: 8,
    readiness: {
      ready: false,
      state: "transient_error",
      modelCount: 0,
      message: "Antigravity probe error: This operation was aborted",
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastReadyAt: null,
      consecutiveFailures: 3,
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.accountReady, true);
  assert.equal(payload.accountState, "model_catalog_ready");
  assert.equal(payload.modelCount, 8);
  assert.match(payload.accountMessage, /cached model catalog/);
  assert.equal(payload.accountTrafficReady, null);
  assert.equal(payload.accountTrafficState, "not_checked");
});

test("translator health separates cached model readiness from blocked Antigravity traffic", () => {
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    cachedModelCount: 8,
    readiness: {
      ready: true,
      state: "ready",
      modelCount: 8,
      message: "ready",
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastReadyAt: "2026-06-15T00:00:00.000Z",
      consecutiveFailures: 0,
    },
    traffic: {
      state: "account_verification_required",
      type: "antigravity_account_unavailable",
      diagnosis: "account_verification_required",
      status: 403,
      retryable: false,
      message: "PERMISSION_DENIED (code 403): Verify your account to continue.",
      lastFailureAt: "2026-06-15T00:01:00.000Z",
      lastSuccessAt: null,
    },
  });

  assert.equal(payload.accountReady, true);
  assert.equal(payload.accountState, "ready");
  assert.equal(payload.modelCount, 8);
  assert.equal(payload.accountTrafficReady, false);
  assert.equal(payload.accountTrafficState, "account_verification_required");
  assert.equal(payload.accountTrafficType, "antigravity_account_unavailable");
  assert.equal(payload.accountTrafficDiagnosis, "account_verification_required");
  assert.equal(payload.accountTrafficStatus, 403);
  assert.equal(payload.accountTrafficRetryable, false);
  assert.match(payload.accountTrafficMessage, /Verify your account/);
});

test("Antigravity aborted upstream failures are exposed as retryable transient traffic", () => {
  const failure = antigravityFailureDetails(new Error("This operation was aborted"));
  assert.equal(failure.status, 503);
  assert.equal(failure.type, "antigravity_temporarily_unavailable");
  assert.equal(failure.retryable, true);

  const status = {
    state: "not_checked",
    type: null,
    diagnosis: null,
    status: null,
    retryable: null,
    message: "",
    lastFailureAt: null,
    lastFailureAtMs: 0,
  };
  applyAntigravityTrafficFailure(status, new Error("This operation was aborted"), {
    occurredAtMs: Date.parse("2026-06-15T00:02:00.000Z"),
  });
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    cachedModelCount: 8,
    readiness: {
      ready: false,
      state: "transient_error",
      modelCount: 0,
      message: "Antigravity probe error: This operation was aborted",
      lastCheckedAt: "2026-06-15T00:02:00.000Z",
      lastReadyAt: null,
      consecutiveFailures: 1,
    },
    traffic: status,
  });

  assert.equal(payload.accountReady, true);
  assert.equal(payload.accountState, "model_catalog_ready");
  assert.equal(payload.accountTrafficReady, false);
  assert.equal(payload.accountTrafficState, "antigravity_temporarily_unavailable");
  assert.equal(payload.accountTrafficType, "antigravity_temporarily_unavailable");
  assert.equal(payload.accountTrafficRetryable, true);
  assert.match(payload.accountTrafficMessage, /aborted/);
});

test("Antigravity quota and usage limit failures are exposed as account limit traffic", () => {
  const quotaError = Object.assign(new Error("Antigravity model quota exceeded for this account."), {
    statusCode: 429,
  });
  const failure = antigravityFailureDetails(quotaError);

  assert.deepEqual(failure, {
    status: 429,
    type: "antigravity_quota_exceeded",
    retryable: false,
    diagnosis: "quota_or_limit_reached",
    message: "Antigravity model quota exceeded for this account.",
    suggestedAction: "切换 Antigravity 账号，或等待额度/限额恢复后重试。",
  });
  assert.equal(shouldRecordAntigravityTrafficFailure(quotaError), true);

  const status = {
    state: "ready",
    type: null,
    diagnosis: null,
    status: 200,
    retryable: false,
    message: "",
    suggestedAction: "",
    lastFailureAt: null,
    lastFailureAtMs: 0,
  };
  applyAntigravityTrafficFailure(status, quotaError, {
    occurredAtMs: Date.parse("2026-06-15T00:03:00.000Z"),
  });
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    cachedModelCount: 8,
    readiness: {
      ready: true,
      state: "ready",
      modelCount: 8,
      message: "ready",
      lastCheckedAt: "2026-06-15T00:03:00.000Z",
      lastReadyAt: "2026-06-15T00:03:00.000Z",
      consecutiveFailures: 0,
    },
    traffic: status,
  });

  assert.equal(payload.accountReady, true);
  assert.equal(payload.accountTrafficReady, false);
  assert.equal(payload.accountTrafficState, "quota_or_limit_reached");
  assert.equal(payload.accountTrafficType, "antigravity_quota_exceeded");
  assert.equal(payload.accountTrafficDiagnosis, "quota_or_limit_reached");
  assert.equal(payload.accountTrafficStatus, 429);
  assert.equal(payload.accountTrafficRetryable, false);
  assert.match(payload.accountTrafficMessage, /quota exceeded/);
  assert.equal(payload.accountTrafficSuggestedAction, "切换 Antigravity 账号，或等待额度/限额恢复后重试。");
});

test("Antigravity traffic status is not cleared by an older queued success", () => {
  const status = {
    state: "not_checked",
    type: null,
    diagnosis: null,
    status: null,
    retryable: null,
    message: "",
    lastFailureAt: null,
    lastSuccessAt: null,
    lastFailureAtMs: 0,
    lastSuccessAtMs: 0,
  };
  const failure = Object.assign(new Error("PERMISSION_DENIED (code 403): Verify your account to continue."), {
    type: "antigravity_account_unavailable",
    statusCode: 403,
  });

  applyAntigravityTrafficFailure(status, failure, { occurredAtMs: 2000 });
  const accepted = applyAntigravityTrafficSuccess(status, { startedAtMs: 1000, completedAtMs: 3000 });
  const snapshot = antigravityTrafficSnapshot(status);

  assert.equal(accepted, false);
  assert.equal(snapshot.accountTrafficReady, false);
  assert.equal(snapshot.accountTrafficState, "account_verification_required");
  assert.equal(snapshot.accountTrafficStatus, 403);
  assert.equal(snapshot.accountTrafficLastSuccessAt, null);
});

test("Antigravity traffic status clears when a newer request succeeds", () => {
  const status = {
    state: "account_verification_required",
    type: "antigravity_account_unavailable",
    diagnosis: "account_verification_required",
    status: 403,
    retryable: false,
    message: "PERMISSION_DENIED (code 403): Verify your account to continue.",
    lastFailureAt: "1970-01-01T00:00:02.000Z",
    lastSuccessAt: null,
    lastFailureAtMs: 2000,
    lastSuccessAtMs: 0,
  };

  const accepted = applyAntigravityTrafficSuccess(status, { startedAtMs: 2500, completedAtMs: 3000 });
  const snapshot = antigravityTrafficSnapshot(status);

  assert.equal(accepted, true);
  assert.equal(snapshot.accountTrafficReady, true);
  assert.equal(snapshot.accountTrafficState, "ready");
  assert.equal(snapshot.accountTrafficStatus, 200);
  assert.equal(snapshot.accountTrafficLastSuccessAt, "1970-01-01T00:00:03.000Z");
});

test("only Antigravity-origin failures update Antigravity traffic status", () => {
  assert.equal(shouldRecordAntigravityTrafficFailure(new Error("Invalid JSON")), false);
  assert.equal(shouldRecordAntigravityTrafficFailure(Object.assign(
    new Error("GetAvailableModels failed: ETIMEDOUT"),
    { type: "antigravity_temporarily_unavailable" },
  )), true);
  assert.equal(shouldRecordAntigravityTrafficFailure(Object.assign(
    new Error("PERMISSION_DENIED (code 403): Verify your account to continue."),
    { type: "antigravity_account_unavailable", statusCode: 403 },
  )), true);
});

test("Antigravity account fallback reports cached models instead of failing health UI", () => {
  const snapshot = antigravityAccountFallbackSnapshot(
    new Error('GetUserStatus failed (500): {"message":"GetCascadeModelConfigData() is nil"}'),
    { models: [{ slug: "gemini-3.5-flash-low", display_name: "Gemini 3.5 Flash" }] },
  );

  assert.equal(snapshot.object, "antigravity.account");
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.status, "detail_unavailable");
  assert.equal(snapshot.models.count, 1);
  assert.deepEqual(snapshot.models.ids, ["gemini-3.5-flash-low"]);
});

test("translator health serializes monitor timestamps as ISO strings", () => {
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    readiness: {
      ready: true,
      state: "ready",
      modelCount: 8,
      message: "ready",
      lastCheckedAt: 1781308800000,
      lastReadyAt: 1781308799000,
      consecutiveFailures: 0,
    },
  });

  assert.equal(payload.accountLastCheckedAt, "2026-06-13T00:00:00.000Z");
  assert.equal(payload.accountLastReadyAt, "2026-06-12T23:59:59.000Z");
});

test("translator health exposes Antigravity circuit state without marking the process unhealthy", () => {
  const payload = translatorHealthPayload({
    upstream: "antigravity-desktop",
    profile: "antigravity",
    internalTools: [],
    readiness: {
      ready: false,
      state: "transient_error",
      modelCount: 0,
      message: "Antigravity probe error: proxy error",
      lastCheckedAt: 1781308799000,
      lastReadyAt: 1781308700000,
      consecutiveFailures: 2,
    },
    circuit: {
      state: "open",
      retryAfterMs: 12000,
      consecutiveFailures: 3,
      lastFailureMessage: "Failed to generate plan",
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.accountState, "transient_error");
  assert.equal(payload.antigravityCircuitState, "open");
  assert.equal(payload.antigravityCircuitRetryAfterMs, 12000);
  assert.equal(payload.antigravityCircuitConsecutiveFailures, 3);
  assert.equal(payload.antigravityCircuitLastFailure, "Failed to generate plan");
});

test("diagnostics payload summarizes state without prompt text", () => {
  const payload = diagnosticsPayload({
    health: translatorHealthPayload({
      upstream: "antigravity-desktop",
      profile: "antigravity",
      internalTools: [],
      readiness: {
        ready: true,
        state: "ready",
        modelCount: 2,
        message: "ready",
        lastCheckedAt: "2026-06-14T00:00:00.000Z",
        lastReadyAt: "2026-06-14T00:00:00.000Z",
        consecutiveFailures: 0,
      },
      circuit: {
        state: "closed",
        retryAfterMs: 0,
        consecutiveFailures: 0,
        lastFailureMessage: "",
      },
    }),
    catalog: {
      models: [
        { slug: "gemini-3.5-flash-low", display_name: "Gemini 3.5 Flash (Medium)" },
        { slug: "gemini-3.1-pro-low", display_name: "Gemini 3.1 Pro (Low)" },
      ],
    },
    routeAudit: {
      count: 1,
      latest: {
        requestId: "chatcmpl_x",
        requestedModel: "gemini-3.5-flash-low",
        resolvedModel: "gemini-3.5-flash-low",
        displayName: "Gemini 3.5 Flash (Medium)",
        internalModel: "MODEL_PLACEHOLDER_M20",
        cascadeId: "cascade_x",
        status: "success",
      },
      entries: [{
        requestId: "chatcmpl_x",
        requestedModel: "gemini-3.5-flash-low",
        resolvedModel: "gemini-3.5-flash-low",
        displayName: "Gemini 3.5 Flash (Medium)",
        internalModel: "MODEL_PLACEHOLDER_M20",
        cascadeId: "cascade_x",
        status: "success",
      }],
    },
    updateStatus: {
      ok: true,
      updateNeeded: false,
      reason: "up_to_date",
      sync: { available: true, prompted: false, launched: false },
    },
    postVerification: {
      present: true,
      ok: false,
      state: "waiting_for_account",
      usedRealTraffic: true,
      latestDiagnosis: "account_verification_required",
      latestDiagnosisDetail: "antigravity_oauth_network_failure",
      latestSuggestedAction: "Open Antigravity",
      attempts: 3,
      elapsedMs: 1200,
      openedAntigravity: true,
      failureCount: 1,
      overallOk: null,
      latestAttemptAt: "2026-06-14T00:00:00.000Z",
    },
  });

  assert.equal(payload.object, "anticodex.diagnostics");
  assert.equal(payload.health.accountReady, true);
  assert.equal(payload.models.count, 2);
  assert.deepEqual(payload.models.ids, ["gemini-3.5-flash-low", "gemini-3.1-pro-low"]);
  assert.equal(Object.hasOwn(payload.paths, "codexHome"), true);
  assert.equal(Object.hasOwn(payload.paths, "sharedCodexHome"), true);
  assert.equal(payload.modelRoutes.latest.internalModel, "MODEL_PLACEHOLDER_M20");
  assert.equal(payload.toolBridge.mode, "native-mcp-same-cascade");
  assert.equal(payload.nativeToolCapability.transport, "desktop-cascade");
  assert.equal(payload.nativeToolCapability.acceptsExternalToolDefinitions, true);
  assert.equal(payload.nativeToolCapability.externalToolDefinitionsUsable, true);
  assert.equal(payload.nativeToolCapability.nativeBridgeDefaultEnabled, true);
  assert.equal(payload.nativeToolCapability.nativeAntigravityToolEvents, true);
  assert.equal(payload.responsesWebSocket.supported, false);
  assert.equal(payload.responsesWebSocket.fallbackType, "unsupported_websocket");
  assert.equal(payload.updateStatus.updateNeeded, false);
  assert.equal(payload.updateStatus.sync.available, true);
  assert.equal(payload.postVerification.present, true);
  assert.equal(payload.postVerification.state, "waiting_for_account");
  assert.equal(payload.postVerification.usedRealTraffic, true);
  assert.equal(payload.postVerification.latestDiagnosis, "account_verification_required");
  assert.equal(payload.postVerification.latestDiagnosisDetail, "antigravity_oauth_network_failure");
  assert.equal(payload.postVerification.attempts, 3);
  assert.equal(payload.postVerification.failureCount, 1);
  assert.equal(typeof payload.localFeatures.capabilityTiers.skills.inventoryCount, "number");
  assert.equal(typeof payload.localFeatures.capabilityTiers.skills.readableCount, "number");
  assert.equal(payload.localFeatures.capabilityTiers.skills.mode, "instruction");
  assert.equal(typeof payload.localFeatures.capabilityTiers.mcp.configuredCount, "number");
  assert.equal(payload.localFeatures.capabilityTiers.mcp.callableCount, null);
  assert.equal(payload.localFeatures.capabilityTiers.mcp.mode, "current-session-tool-list");
  assert.equal(typeof payload.localFeatures.capabilityTiers.plugins.inventoryCount, "number");
  assert.equal(payload.localFeatures.capabilityTiers.plugins.callableCount, 0);
  assert.equal(typeof payload.localFeatures.capabilityTiers.connectors.inventoryCount, "number");
  assert.equal(typeof payload.localFeatures.capabilityTiers.connectors.authorizedCount, "number");
  assert.equal(typeof payload.localFeatures.capabilityTiers.connectors.remoteAuthorizedCount, "number");
  assert.equal(typeof payload.localFeatures.capabilityTiers.connectors.localAllowlistedCount, "number");
  assert.equal(typeof payload.localFeatures.capabilityTiers.connectors.callableToolCount, "number");
  assert.equal(["metadata-only", "real-authorized"].includes(payload.localFeatures.capabilityTiers.connectors.mode), true);
  assert.equal(typeof payload.localFeatures.snapshotStatus.present, "boolean");
  assert.equal(typeof payload.localFeatures.snapshotStatus.stale, "boolean");
  assert.equal(typeof payload.localFeatures.snapshotStatus.maxAgeHours, "number");
  assert.equal(["fresh", "stale", "missing", "invalid"].includes(payload.localFeatures.snapshotStatus.state), true);
  assert.equal(typeof payload.antigravityRetries.count, "number");
  assert.equal(payload.antigravityRetries.latest, null);
  assert.equal(payload.toolBridge.transport, "desktop-cascade");
  assert.equal(payload.toolBridge.localAdapter, "native-mcp-same-cascade-with-prompt-fallback");
  assert.equal(payload.toolBridge.nativeAntigravityToolEvents, true);
  assert.equal(payload.toolBridge.acceptsExternalToolDefinitions, true);
  assert.equal(payload.toolBridge.verifier, "test-anticodex-native-tool-loop.ps1");
  assert.equal(payload.toolBridge.nativeVerifier, "test-anticodex-native-tool-loop.ps1");
  assert.equal(JSON.stringify(payload).includes("Return exactly this"), false);
  assert.equal(JSON.stringify(payload).includes("tool output"), false);
});

test("diagnostics exposes the native default and automatic permission handling clearly", () => {
  const payload = diagnosticsPayload({
    health: translatorHealthPayload({
      upstream: "antigravity-desktop",
      profile: "antigravity",
      internalTools: ["web_search", "web_fetch"],
      readiness: {
        ready: true, state: "ready", modelCount: 2, message: "ready",
        lastCheckedAt: "2026-06-14T00:00:00.000Z", lastReadyAt: "2026-06-14T00:00:00.000Z",
        consecutiveFailures: 0,
      },
      circuit: {
        state: "closed", retryAfterMs: 0, consecutiveFailures: 0, lastFailureMessage: "",
      },
    }),
    catalog: { models: [{ slug: "gemini-3.5-flash-low", display_name: "Gemini 3.5 Flash" }] },
    routeAudit: { count: 0, latest: null, entries: [] },
  });

  assert.equal(payload.toolBridge.mode, "native-mcp-same-cascade");
  assert.equal(payload.toolBridge.transport, "desktop-cascade");
  assert.equal(payload.nativeToolCapability.codexToolBridge, "native-mcp-same-cascade-with-prompt-fallback");
  assert.equal(payload.nativeToolCapability.permissionPromptsDisabled, true);
  assert.equal(payload.nativeToolCapability.nativeMcpPermissionMode, "automatic-before-codex-execution");
  assert.equal(payload.nativeToolCapability.schemaLikeRequestAcceptance, "verified-native-mcp-initialize-and-tools-list");
  assert.equal(payload.toolBridge.localAdapter, "native-mcp-same-cascade-with-prompt-fallback");
  assert.equal(payload.toolBridge.nativeBridgeDefaultEnabled, true);
  assert.equal(payload.toolBridge.nativeAntigravityToolEvents, true);
  assert.equal(payload.toolBridge.acceptsExternalToolDefinitions, true);
  assert.equal(payload.tools.bridge, "native_mcp_same_cascade");
  assert.equal(payload.tools.antigravityMode, true);
  assert.equal(payload.tools.injectInternalTools, true);
  assert.equal(payload.tools.nativeAntigravityToolEvents, true);
  assert.equal(payload.tools.acceptsExternalToolDefinitions, true);
  assert.match(payload.tools.description, /automatically approved/i);
  assert.match(payload.tools.description, /prompt bridge/i);
});

test("diagnostics marks local feature snapshots fresh or stale using the startup age contract", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-snapshot-status-"));
  const markerPath = path.join(root, ".anticodex-startup-snapshots-ready.json");
  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousSharedHome = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousMaxAge = process.env.ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS;
  try {
    process.env.CODEX_HOME = root;
    process.env.CODEX_HOME_DIR = root;
    process.env.ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS = "24";
    writeFileSync(markerPath, JSON.stringify({
      schema: "anticodex-startup-snapshots-ready-v1",
      updatedAt: new Date().toISOString(),
      sourceFingerprint: "0123456789abcdef0123456789abcdef",
      sourceMtimeMax: new Date().toISOString(),
    }));

    const fresh = diagnosticsPayload({ health: { upstream: "antigravity-desktop" } });
    assert.equal(fresh.localFeatures.snapshotStatus.state, "fresh");
    assert.equal(fresh.localFeatures.snapshotStatus.stale, false);
    assert.equal(fresh.localFeatures.snapshotStatus.sourceFingerprintPresent, true);

    writeFileSync(markerPath, JSON.stringify({
      schema: "anticodex-startup-snapshots-ready-v1",
      updatedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      sourceFingerprint: "0123456789abcdef0123456789abcdef",
      sourceMtimeMax: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    }));
    const stale = diagnosticsPayload({ health: { upstream: "antigravity-desktop" } });
    assert.equal(stale.localFeatures.snapshotStatus.state, "stale");
    assert.equal(stale.localFeatures.snapshotStatus.stale, true);
    assert.ok(stale.localFeatures.snapshotStatus.ageHours >= 47);

    const shared = path.join(root, "shared");
    mkdirSync(path.join(shared, "skills", "demo"), { recursive: true });
    writeFileSync(path.join(shared, "skills", "demo", "SKILL.md"), "v2");
    mkdirSync(path.join(shared, "cache", "codex_app_directory"), { recursive: true });
    writeFileSync(path.join(shared, "cache", "codex_app_directory", "apps.json"), "{}");
    mkdirSync(path.join(shared, "cache", "codex_apps_tools"), { recursive: true });
    writeFileSync(path.join(shared, "cache", "codex_apps_tools", "tools.json"), "{}");
    for (const name of ["AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md"]) {
      writeFileSync(path.join(shared, name), name);
    }
    process.env.DEEPCODEX_SHARED_CODEX_HOME = shared;
    writeFileSync(markerPath, JSON.stringify({
      schema: "anticodex-startup-snapshots-ready-v1",
      updatedAt: new Date().toISOString(),
      sharedCodexHome: shared,
      sourceFingerprint: "00000000000000000000000000000000",
      sourceMtimeMax: new Date().toISOString(),
    }));
    const sourceChanged = diagnosticsPayload({ health: { upstream: "antigravity-desktop" } });
    assert.equal(sourceChanged.localFeatures.snapshotStatus.state, "stale");
    assert.equal(sourceChanged.localFeatures.snapshotStatus.staleReason, "source_changed");
    assert.equal(sourceChanged.localFeatures.snapshotStatus.sourceFingerprintComparable, true);
    assert.equal(sourceChanged.localFeatures.snapshotStatus.sourceFingerprintMatches, false);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousSharedHome === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousSharedHome;
    if (previousMaxAge === undefined) delete process.env.ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS;
    else process.env.ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS = previousMaxAge;
    rmSync(root, { recursive: true, force: true });
  }
});

test("visible model payload exposes Antigravity native thinking budgets without changing model identity", () => {
  const payload = visibleModelPayload({
    models: [{
      slug: "gemini-3.5-flash-low",
      display_name: "Gemini 3.5 Flash (Low)",
      default_reasoning_level: "low",
      antigravity_supports_thinking: true,
      antigravity_thinking_budget: 4000,
      antigravity_min_thinking_budget: 32,
    }],
  }, { models: ["gemini-3.5-flash-low"] });

  assert.deepEqual(payload.data, [{
    id: "gemini-3.5-flash-low",
    object: "model",
    created: 1770000000,
    owned_by: "codex-adaptive",
    display_name: "Gemini 3.5 Flash (Low)",
    reasoning_level: "low",
    supports_thinking: true,
    thinking_budget: 4000,
    min_thinking_budget: 32,
  }]);
});

test("local projection prefers Anti-Codex home before shared Codex home", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-local-projection-"));
  const currentHome = path.join(root, "current");
  const sharedHome = path.join(root, "shared");
  const currentCache = path.join(currentHome, "cache", "codex_app_directory");
  const sharedCache = path.join(sharedHome, "cache", "codex_app_directory");
  mkdirSync(currentCache, { recursive: true });
  mkdirSync(sharedCache, { recursive: true });
  writeFileSync(path.join(currentCache, "directory.json"), JSON.stringify({
    connectors: [{ id: "current-only", name: "Current Only", isAccessible: false }],
  }));
  writeFileSync(path.join(sharedCache, "directory.json"), JSON.stringify({
    connectors: [{ id: "shared-only", name: "Shared Only", isAccessible: false }],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = sharedHome;
    delete process.env.GLOBAL_CODEX_HOME;

    const directory = readConnectorDirectory();
    assert.deepEqual(directory.connectors.map((connector) => connector.id), ["current-only"]);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection refuses shared Codex home when CODEX_HOME is misconfigured to it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-shared-home-misconfig-"));
  const sharedHome = path.join(root, "shared");
  const sharedCache = path.join(sharedHome, "cache", "codex_app_directory");
  mkdirSync(sharedCache, { recursive: true });
  writeFileSync(path.join(sharedCache, "directory.json"), JSON.stringify({
    connectors: [{ id: "shared-misconfig", name: "Shared Misconfig", isAccessible: true }],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = sharedHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = sharedHome;
    delete process.env.GLOBAL_CODEX_HOME;

    const directory = readConnectorDirectory();
    assert.deepEqual(directory.connectors, []);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection degrades connector directory instead of reading shared Codex when local snapshot is missing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-local-projection-fallback-"));
  const currentHome = path.join(root, "current");
  const sharedHome = path.join(root, "shared");
  const sharedCache = path.join(sharedHome, "cache", "codex_app_directory");
  mkdirSync(sharedCache, { recursive: true });
  writeFileSync(path.join(sharedCache, "directory.json"), JSON.stringify({
    connectors: [{ id: "shared-fallback", name: "Shared Fallback", isAccessible: false }],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = sharedHome;
    delete process.env.GLOBAL_CODEX_HOME;

    const directory = readConnectorDirectory();
    assert.deepEqual(directory.connectors, []);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection degrades app tools instead of reading shared Codex when local snapshot is missing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-app-tools-fallback-"));
  const currentHome = path.join(root, "current");
  const sharedHome = path.join(root, "shared");
  const sharedCache = path.join(sharedHome, "cache", "codex_apps_tools");
  mkdirSync(sharedCache, { recursive: true });
  writeFileSync(path.join(sharedCache, "tools.json"), JSON.stringify({
    tools: [{ server_name: "shared", tool_namespace: "shared", tool_name: "shared_tool", connector_id: "shared-connector" }],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = sharedHome;
    delete process.env.GLOBAL_CODEX_HOME;

    const tools = readAppTools();
    assert.deepEqual(tools.tools, []);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection does not mix shared app tools when local snapshot exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-app-tools-projection-"));
  const currentHome = path.join(root, "current");
  const sharedHome = path.join(root, "shared");
  const currentCache = path.join(currentHome, "cache", "codex_apps_tools");
  const sharedCache = path.join(sharedHome, "cache", "codex_apps_tools");
  mkdirSync(currentCache, { recursive: true });
  mkdirSync(sharedCache, { recursive: true });
  writeFileSync(path.join(currentCache, "tools.json"), JSON.stringify({
    tools: [{ server_name: "local", tool_namespace: "local", tool_name: "local_tool", connector_id: "local-connector" }],
  }));
  writeFileSync(path.join(sharedCache, "tools.json"), JSON.stringify({
    tools: [{ server_name: "shared", tool_namespace: "shared", tool_name: "shared_tool", connector_id: "shared-connector" }],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = sharedHome;
    delete process.env.GLOBAL_CODEX_HOME;

    const tools = readAppTools();
    assert.deepEqual(tools.tools.map((tool) => tool.tool_name), ["local_tool"]);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection never exposes app tools for inaccessible connectors", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-inaccessible-app-tools-"));
  const currentHome = path.join(root, "current");
  const connectorCache = path.join(currentHome, "cache", "codex_app_directory");
  const toolCache = path.join(currentHome, "cache", "codex_apps_tools");
  mkdirSync(connectorCache, { recursive: true });
  mkdirSync(toolCache, { recursive: true });
  writeFileSync(path.join(connectorCache, "directory.json"), JSON.stringify({
    connectors: [{ id: "not-linked", name: "Not Linked", isAccessible: false }],
  }));
  writeFileSync(path.join(toolCache, "tools.json"), JSON.stringify({
    tools: [
      { server_name: "apps", tool_namespace: "demo", tool_name: "hidden_tool", connector_id: "not-linked" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "unattributed_tool" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "empty_connector_tool", connector_id: "" },
    ],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = path.join(root, "missing-shared");
    delete process.env.GLOBAL_CODEX_HOME;

    const payload = localBackendApiResponse("POST", "/backend-api/wham/apps");
    assert.deepEqual(payload.tools, []);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection exposes only app tools belonging to accessible connectors", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-accessible-app-tools-"));
  const currentHome = path.join(root, "current");
  const connectorCache = path.join(currentHome, "cache", "codex_app_directory");
  const toolCache = path.join(currentHome, "cache", "codex_apps_tools");
  mkdirSync(connectorCache, { recursive: true });
  mkdirSync(toolCache, { recursive: true });
  writeFileSync(path.join(connectorCache, "directory.json"), JSON.stringify({
    connectors: [
      { id: "linked", name: "Linked", isAccessible: true },
      { id: "not-linked", name: "Not Linked", isAccessible: false },
    ],
  }));
  writeFileSync(path.join(toolCache, "tools.json"), JSON.stringify({
    tools: [
      { server_name: "apps", tool_namespace: "demo", tool_name: "allowed_tool", connector_id: "linked" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "hidden_tool", connector_id: "not-linked" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "unattributed_tool" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "empty_connector_tool", connector_id: "" },
    ],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = path.join(root, "missing-shared");
    delete process.env.GLOBAL_CODEX_HOME;

    const payload = localBackendApiResponse("POST", "/backend-api/wham/apps");
    assert.deepEqual(payload.tools.map((tool) => tool.tool_name), ["allowed_tool"]);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection keeps Anti-Codex local connector allowlist separate from remote authorization", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-local-connector-allowlist-"));
  const currentHome = path.join(root, "current");
  const connectorCache = path.join(currentHome, "cache", "codex_app_directory");
  const toolCache = path.join(currentHome, "cache", "codex_apps_tools");
  mkdirSync(connectorCache, { recursive: true });
  mkdirSync(toolCache, { recursive: true });
  writeFileSync(path.join(currentHome, "config.toml"), [
    "[local_authorized_connectors]",
    '"local-demo" = true',
    'connectors = ["array-demo"]',
    "",
  ].join("\n"));
  writeFileSync(path.join(connectorCache, "directory.json"), JSON.stringify({
    connectors: [
      { id: "local-demo", name: "Local Demo", isAccessible: false },
      { id: "array-demo", name: "Array Demo", isAccessible: false },
      { id: "still-hidden", name: "Still Hidden", isAccessible: false },
    ],
  }));
  writeFileSync(path.join(toolCache, "tools.json"), JSON.stringify({
    tools: [
      { server_name: "apps", tool_namespace: "demo", tool_name: "local_demo_tool", connector_id: "local-demo" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "array_demo_tool", connector_id: "array-demo" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "hidden_tool", connector_id: "still-hidden" },
    ],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  const previousAllowlist = process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = path.join(root, "missing-shared");
    delete process.env.GLOBAL_CODEX_HOME;
    delete process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS;

    const directory = readConnectorDirectory();
    assert.deepEqual(directory.connectors
      .filter((connector) => connector.locallyAllowlisted)
      .map((connector) => [connector.id, connector.isAccessible, connector.localAuthorization]), [
        ["local-demo", false, "anticodex-local-allowlist"],
        ["array-demo", false, "anticodex-local-allowlist"],
      ]);
    const payload = localBackendApiResponse("POST", "/backend-api/wham/apps");
    assert.deepEqual(payload.tools, []);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    if (previousAllowlist === undefined) delete process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS;
    else process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS = previousAllowlist;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection connector allowlist can come from the environment", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-env-connector-allowlist-"));
  const currentHome = path.join(root, "current");
  const connectorCache = path.join(currentHome, "cache", "codex_app_directory");
  const toolCache = path.join(currentHome, "cache", "codex_apps_tools");
  mkdirSync(connectorCache, { recursive: true });
  mkdirSync(toolCache, { recursive: true });
  writeFileSync(path.join(connectorCache, "directory.json"), JSON.stringify({
    connectors: [{ id: "env-demo", name: "Env Demo", isAccessible: false }],
  }));
  writeFileSync(path.join(toolCache, "tools.json"), JSON.stringify({
    tools: [{ server_name: "apps", tool_namespace: "demo", tool_name: "env_demo_tool", connector_id: "env-demo" }],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  const previousAllowlist = process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = path.join(root, "missing-shared");
    delete process.env.GLOBAL_CODEX_HOME;
    process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS = "env-demo";

    const directory = readConnectorDirectory();
    assert.equal(directory.connectors[0].locallyAllowlisted, true);
    assert.equal(directory.connectors[0].isAccessible, false);
    assert.equal(directory.connectors[0].localAuthorization, "anticodex-local-allowlist");
    const payload = localBackendApiResponse("POST", "/backend-api/wham/apps");
    assert.deepEqual(payload.tools, []);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    if (previousAllowlist === undefined) delete process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS;
    else process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS = previousAllowlist;
    rmSync(root, { recursive: true, force: true });
  }
});

test("connector GET link endpoint returns unsupported response for local metadata-only projection", () => {
  const response = localBackendApiResponse("GET", "/backend-api/aip/connectors/test-app/link");
  assert.equal(response.ok, false);
  assert.equal(response.status, "unsupported");
  assert.equal(response.object, "connector_link_status");
  assert.match(response.error, /metadata-only/);
  assert.equal(response.ok, false, "must not return false success");
});

test("connector POST links/noauth endpoint returns unsupported response for local metadata-only projection", () => {
  const response = localBackendApiResponse("POST", "/backend-api/aip/connectors/links/noauth");
  assert.equal(response.ok, false);
  assert.equal(response.status, "unsupported");
  assert.equal(response.object, "connector_link_status");
  assert.match(response.error, /metadata-only/);
  assert.equal(response.ok, false, "must not return ok: true");
});

test("connector POST links/oauth endpoint returns unsupported response for local metadata-only projection", () => {
  const response = localBackendApiResponse("POST", "/backend-api/aip/connectors/links/oauth");
  assert.equal(response.ok, false);
  assert.equal(response.status, "unsupported");
  assert.equal(response.object, "connector_link_status");
  assert.match(response.error, /metadata-only/);
  assert.equal(response.ok, false, "must not return redirect_url without error");
});

test("local projection keeps local plugin snapshot metadata instead of reading richer shared Codex duplicates", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-plugin-projection-"));
  const currentHome = path.join(root, "current");
  const sharedHome = path.join(root, "shared");
  const currentPlugin = path.join(currentHome, ".tmp", "plugins", "plugins", "demo", ".codex-plugin");
  const sharedPlugin = path.join(sharedHome, ".tmp", "plugins", "plugins", "demo", ".codex-plugin");
  mkdirSync(currentPlugin, { recursive: true });
  mkdirSync(sharedPlugin, { recursive: true });
  writeFileSync(path.join(currentPlugin, "plugin.json"), JSON.stringify({
    name: "demo",
    version: "1.0.0",
    description: "stale local metadata",
  }));
  writeFileSync(path.join(sharedPlugin, "plugin.json"), JSON.stringify({
    name: "demo",
    version: "1.0.1",
    description: "richer shared metadata",
    skills: [{ name: "demo-skill" }],
  }));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = sharedHome;
    delete process.env.GLOBAL_CODEX_HOME;

    const plugins = readPluginRegistrations();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].summary.description, "stale local metadata");
    assert.equal(plugins[0].summary.skills, undefined);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local projection honors disabled plugin entries from Anti-Codex config", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "anticodex-disabled-plugin-"));
  const currentHome = path.join(root, "current");
  const pluginDir = path.join(currentHome, ".tmp", "plugins", "plugins", "demo", ".codex-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
    name: "demo",
    version: "1.0.0",
    description: "local disabled plugin",
  }));
  writeFileSync(path.join(currentHome, "config.toml"), [
    '[plugins."demo@local"]',
    "enabled = false",
    "",
  ].join("\n"));

  const previousCodeHome = process.env.CODEX_HOME;
  const previousCodeHomeDir = process.env.CODEX_HOME_DIR;
  const previousShared = process.env.DEEPCODEX_SHARED_CODEX_HOME;
  const previousGlobal = process.env.GLOBAL_CODEX_HOME;
  try {
    process.env.CODEX_HOME = currentHome;
    delete process.env.CODEX_HOME_DIR;
    process.env.DEEPCODEX_SHARED_CODEX_HOME = path.join(root, "missing-shared");
    delete process.env.GLOBAL_CODEX_HOME;

    const plugins = localBackendApiResponse("GET", "/backend-api/plugins/list");
    assert.equal(plugins.plugins.length, 1);
    assert.equal(plugins.plugins[0].plugin.enabled, false);

    const installed = localBackendApiResponse("GET", "/backend-api/ps/plugins/installed");
    assert.equal(installed.length, 1);
    assert.equal(installed[0].enabled, false);
  } finally {
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousCodeHomeDir === undefined) delete process.env.CODEX_HOME_DIR;
    else process.env.CODEX_HOME_DIR = previousCodeHomeDir;
    if (previousShared === undefined) delete process.env.DEEPCODEX_SHARED_CODEX_HOME;
    else process.env.DEEPCODEX_SHARED_CODEX_HOME = previousShared;
    if (previousGlobal === undefined) delete process.env.GLOBAL_CODEX_HOME;
    else process.env.GLOBAL_CODEX_HOME = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("readiness counts only models exposed by the Antigravity desktop menu", () => {
  const payload = {
    response: {
      models: {
        "visible-a": { displayName: "Visible A" },
        "visible-b": { displayName: "Visible B" },
        "internal-only": { displayName: "Internal Only" },
      },
      agentModelSorts: [{
        groups: [{ modelIds: ["visible-b", "visible-a"] }],
      }],
    },
  };

  assert.deepEqual(antigravityVisibleModelIds(payload), ["visible-b", "visible-a"]);
});

test("Antigravity model refresh rebuilds a live profile from the desktop payload", () => {
  const refresh = buildAntigravityModelRefresh({
    response: {
      models: {
        "gemini-3.5-flash-low": {
          displayName: "Gemini 3.5 Flash (Medium)",
          model: "MODEL_PLACEHOLDER_M20",
          supportsImages: true,
        },
        "gemini-pro-agent": {
          displayName: "Gemini 3.1 Pro (High)",
          model: "MODEL_PLACEHOLDER_M16",
        },
        "internal-only": {
          displayName: "Internal Only",
          model: "MODEL_INTERNAL",
        },
      },
      agentModelSorts: [{
        groups: [{ modelIds: ["gemini-3.5-flash-low", "gemini-pro-agent"] }],
      }],
    },
  }, {
    models: [{
      slug: "template-model",
      context_window: 999,
      shell_type: "shell_command",
    }],
  });

  assert.deepEqual(refresh.models, ["gemini-3.5-flash-low", "gemini-pro-agent"]);
  assert.equal(refresh.profile.provider, "antigravity");
  assert.equal(refresh.profile.defaultModel, "gemini-pro-agent");
  assert.equal(refresh.profile.fastModel, "gemini-3.5-flash-low");
  assert.equal(refresh.catalog.models.length, 2);
  assert.equal(refresh.catalog.models[0].slug, "gemini-3.5-flash-low");
  assert.equal(refresh.catalog.models[0].shell_type, "shell_command");
});

test("third-party model refresh reports configured provider model without Antigravity traffic", () => {
  const refresh = providerModelRefreshSnapshot({
    provider: "anthropic",
    protocol: "anthropic",
    model: "claude-3.5-sonnet",
  });

  assert.deepEqual(refresh, {
    ok: true,
    object: "anticodex.provider_model_refresh",
    skipped: true,
    mode: "third-party",
    provider: "anthropic",
    protocol: "anthropic",
    modelCount: 1,
    models: ["claude-3.5-sonnet"],
    defaultModel: "claude-3.5-sonnet",
    fastModel: "claude-3.5-sonnet",
    message: "Third-party mode uses the configured provider model; no Antigravity model refresh was attempted.",
  });
});

test("third-party model refresh preserves provider model lists from connection evidence", () => {
  const refresh = providerModelRefreshSnapshot({
    provider: "openai-compatible",
    protocol: "openai-compatible",
    model: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "o3"],
  });

  assert.equal(refresh.modelCount, 3);
  assert.deepEqual(refresh.models, ["gpt-4o", "gpt-4o-mini", "o3"]);
  assert.equal(refresh.defaultModel, "gpt-4o");
  assert.equal(refresh.fastModel, "gpt-4o-mini");
});

test("Antigravity model refresh rejects empty desktop model lists", () => {
  assert.throws(
    () => buildAntigravityModelRefresh({ response: { models: {}, agentModelSorts: [] } }, { models: [] }),
    /empty model list/,
  );
});

test("Antigravity model refresh rejects visible models without a routable internal enum", () => {
  assert.throws(
    () => buildAntigravityModelRefresh({
      response: {
        models: {
          "visible-but-unroutable": { displayName: "Visible But Unroutable" },
        },
        agentModelSorts: [{ groups: [{ modelIds: ["visible-but-unroutable"] }] }],
      },
    }, { models: [{}] }),
    /does not expose an internal model enum/,
  );
});

test("Antigravity account failures are stable non-retryable 503 errors", () => {
  assert.deepEqual(
    antigravityFailureDetails(new Error(
      "Antigravity has no available models. Open Antigravity, sign in, and confirm its proxy connection, then retry.",
    )),
    {
      status: 503,
      type: "antigravity_account_unavailable",
      retryable: false,
      message: "Antigravity has no available models. Open Antigravity, sign in, and confirm its proxy connection, then retry.",
    },
  );
});

test("Antigravity transient failures are retryable 503 errors", () => {
  assert.deepEqual(
    antigravityFailureDetails(new Error("GetAvailableModels failed: ETIMEDOUT")),
    {
      status: 503,
      type: "antigravity_temporarily_unavailable",
      retryable: true,
      message: "GetAvailableModels failed: ETIMEDOUT",
    },
  );
});

test("Antigravity circuit-open errors keep retry metadata", () => {
  const error = new Error("Antigravity temporarily unavailable: recent proxy/network failures are cooling down for 12000ms.");
  error.name = "AntigravityCircuitOpenError";
  error.statusCode = 503;
  error.type = "antigravity_temporarily_unavailable";
  error.retryable = true;
  error.retryAfterMs = 12000;

  assert.deepEqual(
    antigravityFailureDetails(error),
    {
      status: 503,
      type: "antigravity_temporarily_unavailable",
      retryable: true,
      message: "Antigravity temporarily unavailable: recent proxy/network failures are cooling down for 12000ms.",
      retryAfterMs: 12000,
    },
  );
});

test("Antigravity quota exceeded failures are non-retryable with Chinese actionable suggestion", () => {
  const error = Object.assign(new Error("Quota exceeded: daily Antigravity cloudcode compute limit reached."), {
    type: "antigravity_quota_exceeded",
    statusCode: 429,
  });
  const details = antigravityFailureDetails(error);
  assert.equal(details.retryable, false);
  assert.equal(details.status, 429);
  assert.match(details.type, /quota|limit/, "quota error must have quota/limit type, not generic antigravity_error");
  assert.ok(details.suggestedAction, "quota failure must expose suggestedAction field with Chinese actionable text");
  assert.match(details.suggestedAction, /[一-鿿]/, "suggestedAction must contain Chinese characters");
  assert.match(details.suggestedAction, /额度|限额|充值|用量|重试/, "suggestedAction should mention quota-related resolution");
});

test("Antigravity rate limit failures are non-retryable with Chinese actionable suggestion", () => {
  const error = Object.assign(new Error("Rate limit exceeded: too many requests to Antigravity API."), {
    type: "antigravity_rate_limited",
    statusCode: 429,
  });
  const details = antigravityFailureDetails(error);
  assert.equal(details.retryable, false);
  assert.equal(details.status, 429);
  assert.match(details.type, /rate|quota|limit/, "rate limit error must have rate/limit type");
  assert.ok(details.suggestedAction, "rate limit failure must expose suggestedAction field");
  assert.match(details.suggestedAction, /[一-鿿]/, "suggestedAction must contain Chinese characters");
  assert.match(details.suggestedAction, /频率|限额|等待|重试|请稍后/, "suggestedAction should mention rate-related resolution");
});

test("Antigravity usage limit failures are non-retryable with Chinese actionable suggestion", () => {
  const error = Object.assign(new Error("Usage limit reached: monthly Antigravity cloudcode tokens exhausted."), {
    type: "antigravity_usage_limit_exceeded",
    statusCode: 429,
  });
  const details = antigravityFailureDetails(error);
  assert.equal(details.retryable, false);
  assert.equal(details.status, 429);
  assert.match(details.type, /usage|quota|limit/, "usage limit error must have usage/limit type");
  assert.ok(details.suggestedAction, "usage limit failure must expose suggestedAction field");
  assert.match(details.suggestedAction, /[一-鿿]/, "suggestedAction must contain Chinese characters");
  assert.match(details.suggestedAction, /用量|限额|上限|查看|桌面端/, "suggestedAction should mention usage-related resolution");
});

test("applyAntigravityTrafficFailure propagates Antigravity quota error as non-retryable traffic state with Chinese diagnosis", () => {
  const status = {
    state: "not_checked",
    type: null,
    diagnosis: null,
    status: null,
    retryable: null,
    message: "",
    lastFailureAt: null,
    lastFailureAtMs: 0,
  };
  const error = Object.assign(new Error("Antigravity daily quota exceeded for cloudcode compute."), {
    type: "antigravity_quota_exceeded",
    statusCode: 429,
  });
  const failure = applyAntigravityTrafficFailure(status, error, { occurredAtMs: 1000 });

  assert.equal(status.retryable, false);
  assert.match(status.type, /quota|limit/, "traffic status type must reflect quota/limit");
  assert.match(status.state, /quota|limit/, "traffic state must reflect quota/limit");
  assert.ok(failure.suggestedAction, "failure details from antigravityFailureDetails must expose suggestedAction");
  assert.match(failure.suggestedAction, /[一-鿿]/, "suggestedAction must contain Chinese characters");
});

test("only a confirmed unavailable account blocks a request before streaming starts", () => {
  assert.equal(antigravityReadinessFailure({ state: "unknown", ready: false }), null);
  assert.equal(antigravityReadinessFailure({ state: "transient_error", ready: false }), null);
  assert.deepEqual(
    antigravityReadinessFailure({
      state: "account_unavailable",
      ready: false,
      message: "Sign in to Antigravity.",
    }),
    {
      status: 503,
      type: "antigravity_account_unavailable",
      retryable: false,
      message: "Sign in to Antigravity.",
    },
  );
});

test("LISTEN_HOST defaults to HOST when TRANSLATOR_LISTEN_HOST is not set", () => {
  assert.equal(typeof LISTEN_HOST, "string");
  assert.equal(LISTEN_HOST, HOST);
  // In the test environment both resolve to the default "127.0.0.1"
  assert.equal(HOST, "127.0.0.1");
});

test("isLocalTranslatorAddress still works correctly with LISTEN_HOST support", () => {
  // Existing behavior: loopback is always local
  assert.equal(isLocalTranslatorAddress("127.0.0.1", "192.168.1.2"), true);
  assert.equal(isLocalTranslatorAddress("::ffff:127.0.0.1", "192.168.1.2"), true);
  assert.equal(isLocalTranslatorAddress("::1", "192.168.1.2"), true);
  // The server's own HOST address is local
  assert.equal(isLocalTranslatorAddress("192.168.1.2", "192.168.1.2"), true);
  // A different LAN address is not local
  assert.equal(isLocalTranslatorAddress("192.168.1.50", "192.168.1.2"), false);
  // 0.0.0.0 bind allows 127.0.0.1 and HOST, but not other LAN addresses
  assert.equal(isLocalTranslatorAddress("127.0.0.1", "10.0.0.5"), true);
  assert.equal(isLocalTranslatorAddress("10.0.0.5", "10.0.0.5"), true);
  assert.equal(isLocalTranslatorAddress("10.0.0.99", "10.0.0.5"), false);
});
