# Anti-Codex Local Connector Allowlist Manager Audit

Date: 2026-06-22
Objective: Design review and read-only audit for integrating a local connector and app-tool allowlist management interface within the Anti-Codex Manager UI.
Scope: translator/adaptive-server.mjs, translator/local-projection/index.mjs, scripts/test-anticodex-ui-state.mjs, translator/tests/anticodex-launcher.test.mjs.
Format: ASCII-only Markdown.

## 1. Background and Context

The local projection layer (defined in translator/local-projection/index.mjs) filters available app-tools based on an allowlist of connector IDs.
- Current allowlist source: readLocalAuthorizedConnectorIds() parses the environment variable ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS and the [local_authorized_connectors] or [anticodex.local_authorized_connectors] sections of config.toml.
- Current behavior: Connectors whose IDs match the allowlist have isAccessible set to true and localAuthorization set to "anticodex-local-allowlist". Only accessible connectors expose their app-tools to the gateway.
- Current gap: Enabling or disabling specific connectors requires manual updates to config.toml or shell environment variables. There is no user-friendly UI toggle in the Anti-Codex Manager.

## 2. Existing Manager Entry Points

The Anti-Codex Manager UI and bridge actions are served by the following endpoints in translator/adaptive-server.mjs:
- GET /anticodex/manager - Serves the HTML console page rendered by anticodexManagerHtml().
- GET /anticodex/manager/inject.js - Serves the client injection script (scripts/anticodex-manager-inject.js).
- GET /anticodex/manager/bootstrap - Returns configuration metadata, session token (MANAGER_ACTION_TOKEN), and the action registry. Enforces validateManagerSourceRequest().
- POST /anticodex/manager/action - Handles execution of registered maintenance actions. Enforces validateManagerActionRequest() (requiring x-anticodex-manager-token header).
- GET /anticodex/manager/action-script - JSONP version of the action bridge endpoint.
- GET /anticodex/diagnostics - Returns system diagnostics, including localFeatures (skills, mcp, snapshot configuration).

## 3. Recommended Endpoints

To support allowlist editing from the UI, two new HTTP endpoints should be added to the server:

### GET /anticodex/manager/allowlist
- Purpose: Retrieve the allowlist state and the set of available/accessible local connectors.
- Request Headers:
  - Origin / Referer (must match trusted local origin)
- Response Payload:
  ```json
  {
    "ok": true,
    "allowlist": ["connector-id-1", "connector-id-2"],
    "availableConnectors": [
      {
        "id": "connector-id-1",
        "name": "Local Filesystem App",
        "description": "Exposes local filesystem tools",
        "isAccessible": true
      },
      {
        "id": "connector-id-3",
        "name": "Database App",
        "description": "Exposes database connectors",
        "isAccessible": false
      }
    ]
  }
  ```

### POST /anticodex/manager/allowlist
- Purpose: Add or remove a connector ID from the allowlist in config.toml.
- Request Headers:
  - x-anticodex-manager-token: [MANAGER_ACTION_TOKEN]
  - Origin / Referer (validated source)
- Request Payload:
  ```json
  {
    "action": "add" | "remove",
    "connectorId": "some-connector-id"
  }
  ```
- Implementation Pattern: Following the existing configuration update pattern in Anti-Codex, this POST endpoint should spawn a helper PowerShell script (e.g., scripts/manage-anticodex-allowlist.ps1) using execFileAsync.
  - Command invocation args: -Action [Add|Remove] -ConnectorId [ID]
  - The script will safely parse, update, and write back the [local_authorized_connectors] section of config.toml.
- Response Payload:
  ```json
  {
    "ok": true,
    "message": "Successfully updated local allowlist"
  }
  ```

## 4. Security Guards

Since allowlist modification allows exposing new local capabilities (tools) to the gateway, the endpoints must be fully secured using the project's existing verification layers:
1. Socket Address Boundary:
   - Enforce isLocalTranslatorAddress(req.socket.remoteAddress). If it evaluates to false, immediately reject with a 403 status code.
2. Cross-Origin (CSRF) Guard:
   - For the GET endpoint, execute validateManagerSourceRequest(req, "allowlist query").
   - For the POST endpoint, execute validateManagerActionRequest(req).
   - This prevents cross-origin requests, DNS rebinding, and untrusted client context exploits.
3. Action Token Validation:
   - For the POST endpoint, the request header x-anticodex-manager-token must match the cryptographically generated MANAGER_ACTION_TOKEN.

## 5. Test Coverage and Integration Strategy

### Unit and Integration Tests (translator/tests/anticodex-launcher.test.mjs)
1. Route Validation Test:
   - Assert that the routing block in adaptive-server.mjs correctly defines paths for /anticodex/manager/allowlist.
   - Assert that validateManagerSourceRequest and validateManagerActionRequest are correctly integrated.
2. Endpoint Execution Mock:
   - Simulate a valid allowlist GET request and verify it returns a 200 status code with a correct list of connectors.
   - Simulate allowlist POST add/remove actions, assert correct parameters are passed to the PowerShell script, and verify correct return format.
3. Propagation Check:
   - Verify that adding a connector ID to the allowlist updates the returned output of localBackendApiResponse("GET", "/backend-api/aip/connectors") and localBackendApiResponse("GET", "/backend-api/wham/apps") instantly.

### UI State Tests (scripts/test-anticodex-ui-state.mjs)
1. Rendering Verification:
   - Assert that the Manager UI page contains a list of available connectors with checkboxes or toggle switches.
   - Verify that toggles are labeled with the correct connector names and current authorization status.
2. Action Execution:
   - Simulate a click event on the toggle, and verify that the CDP evaluation triggers a fetch() POST to /anticodex/manager/allowlist.
   - Verify that the headers include x-anticodex-manager-token.
3. Visual Verification:
   - Verify that the count of "Authorized Connectors" shown in the "Plugins and Apps" UI card dynamically updates without page reload.
   - Ensure no layout break or floating overlay residue is introduced.

## 6. UI Implementation Pitfalls

1. Encoding and Mojibake:
   - Any Chinese labels (such as "\u63d2\u4ef6\u4e0e\u5e94\u7528" or similar) used in the UI, templates, or scripts must be stored with clean UTF-8 or escaped to avoid mojibake patterns checked by test-anticodex-ui-state.mjs.
2. Target Size Rule:
   - Toggle elements and checkboxes must have sufficient spacing and hit targets (minimum 44px height/padding) to satisfy in-app usability constraints and passing state verifiers.
3. No-Traffic Isolation:
   - Accessing, rendering, or modifying the local allowlist must not make external calls or trigger upstream traffic. Toggling allowlist options should only read/write local configurations.
4. Restart Avoidance:
   - Allowlist changes can be loaded dynamically by local-projection read helpers on each request. The UI should dynamically reload the projection state via AJAX fetch instead of triggering a server restart (which interrupts active sessions).
5. Legacy Button Exclusion:
   - The UI should not reference or instantiate the legacy floating manager button (#anticodex-manager-button) or outdated routes like /anticodex/manager/open.
6. CSS and Color Tokens:
   - Use existing HSL tail-ored variable colors (such as --raised, --surface, --ok-bg, --ok-text, and --muted) to handle both dark and light modes cleanly and preserve the system visual design.
