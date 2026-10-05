import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const pending = new Map();
const SESSION_VERSION = 1;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function statePath(stateRoot) {
    return path.join(stateRoot, "connector-auth-state.json");
}

function connectorMcpPath(codexHome) {
    return path.join(codexHome, "connector-mcp.toml");
}

function readState(stateRoot) {
    const value = readJson(statePath(stateRoot));
    return value && value.version === SESSION_VERSION && value.sessions && typeof value.sessions === "object"
        ? value
        : { version: SESSION_VERSION, sessions: {} };
}

function writeState(stateRoot, value) {
    fs.mkdirSync(stateRoot, { recursive: true });
    const target = statePath(stateRoot);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temp, target);
}

function randomUrlSafe(bytes = 32) {
    return crypto.randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value) {
    return crypto.createHash("sha256").update(value).digest("base64url");
}

function isPlaceholder(value) {
    return !value || /^<[^>]+>$/.test(String(value));
}

function scanPluginRoots({ codexHome, sharedCodexHome }) {
    return [...new Set([
        path.join(codexHome, ".tmp", "plugins", "plugins"),
        path.join(sharedCodexHome, ".tmp", "plugins", "plugins"),
    ])].filter((root) => fs.existsSync(root));
}

function connectorManifests(options) {
    const rows = [];
    for (const root of scanPluginRoots(options)) {
        let pluginNames = [];
        try { pluginNames = fs.readdirSync(root); } catch { continue; }
        for (const pluginName of pluginNames) {
            const pluginRoot = path.join(root, pluginName);
            const appData = readJson(path.join(pluginRoot, ".app.json"));
            const mcpData = readJson(path.join(pluginRoot, ".mcp.json"));
            if (!appData?.apps || !mcpData?.mcpServers) continue;
            for (const [appName, app] of Object.entries(appData.apps)) {
                const id = String(app?.id || "");
                if (!id) continue;
                for (const [serverName, server] of Object.entries(mcpData.mcpServers)) {
                    const url = typeof server?.url === "string" ? server.url : "";
                    if (!url || !/^https?:\/\//i.test(url)) continue;
                    rows.push({
                        connectorId: id,
                        connectorName: appName,
                        pluginName,
                        serverName,
                        url,
                        config: server,
                    });
                }
            }
        }
    }
    const seen = new Set();
    return rows.filter((row) => {
        const key = `${row.connectorId}\u0000${row.serverName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, { redirect: "manual", ...options });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return body || {};
}

async function probeProtectedResource(url) {
    const response = await fetch(url, { redirect: "manual" });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (response.ok) return { body: body || {}, resourceMetadata: "" };
    const header = response.headers.get("www-authenticate") || "";
    const match = header.match(/resource_metadata="([^"]+)"/i);
    return { body: null, resourceMetadata: match?.[1] || "" };
}

async function discoverOAuth(entry) {
    const resource = entry.config.oauth_resource || entry.url;
    let protectedResource = null;
    let discoveredResourceMetadata = "";
    for (const candidate of [
        `${resource.replace(/\/$/, "")}/.well-known/oauth-protected-resource`,
        `${new URL(resource).origin}/.well-known/oauth-protected-resource`,
        resource,
    ]) {
        try {
            const result = await probeProtectedResource(candidate);
            if (result.body) { protectedResource = result.body; break; }
            if (result.resourceMetadata) {
                discoveredResourceMetadata = result.resourceMetadata;
                try {
                    protectedResource = await fetchJson(result.resourceMetadata);
                    if (protectedResource) break;
                } catch {}
            }
        } catch {}
    }
    if (!protectedResource && discoveredResourceMetadata) {
        try { protectedResource = await fetchJson(discoveredResourceMetadata); } catch {}
    }
    const authorizationServer = protectedResource?.authorization_servers?.[0] || new URL(resource).origin;
    let metadata = null;
    for (const candidate of [
        `${String(authorizationServer).replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
        `${String(authorizationServer).replace(/\/$/, "")}/.well-known/openid-configuration`,
    ]) {
        try { metadata = await fetchJson(candidate); break; } catch {}
    }
    if (!metadata && /github\.com\/login\/oauth$/i.test(String(authorizationServer))) {
        const base = String(authorizationServer).replace(/\/$/, "");
        metadata = {
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/access_token`,
        };
    }
    if (!metadata?.authorization_endpoint || !metadata?.token_endpoint) {
        throw new Error("OAuth discovery did not return authorization and token endpoints.");
    }
    return { resource, authorizationServer, metadata };
}

function publicSession(session) {
    if (!session) return { status: "not_connected" };
    return {
        status: session.accessToken ? "connected" : "pending",
        connectorId: session.connectorId,
        connectorName: session.connectorName,
        pluginName: session.pluginName,
        serverName: session.serverName,
        expiresAt: session.expiresAt || null,
        hasRefreshToken: Boolean(session.refreshToken),
        lastError: session.lastError || null,
    };
}

function tomlString(value) {
    return JSON.stringify(String(value));
}

function writeConnectorMcpConfig(codexHome, sessions) {
    const blocks = [];
    for (const session of Object.values(sessions)) {
        if (!session.accessToken || !session.url) continue;
        const safeName = `connector-${session.connectorId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        blocks.push([
            `[mcp_servers."${safeName}"]`,
            `url = ${tomlString(session.url)}`,
            `http_headers = { Authorization = ${tomlString(`Bearer ${session.accessToken}`)} }`,
            "startup_timeout_sec = 30",
            "enabled = true",
        ].join("\n"));
    }
    const target = connectorMcpPath(codexHome);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, blocks.length ? `${blocks.join("\n\n")}\n` : "", "utf8");
    const configPath = path.join(codexHome, "config.toml");
    if (fs.existsSync(configPath)) {
        const existing = fs.readFileSync(configPath, "utf8")
            .replace(/(?:^|\r?\n)\[mcp_servers\."connector-[^"]+"\]\s*[\s\S]*?(?=\r?\n\[|\s*$)/g, "")
            .replace(/\s+$/g, "");
        const connectorText = blocks.length ? `\n\n${blocks.join("\n\n")}\n` : "\n";
        fs.writeFileSync(configPath, `${existing}${connectorText}`, "utf8");
    }
    return target;
}

function listConnectorAuth(options) {
    const state = readState(options.stateRoot);
    const sessions = state.sessions;
    return connectorManifests(options).map((entry) => ({
        connectorId: entry.connectorId,
        connectorName: entry.connectorName,
        pluginName: entry.pluginName,
        serverName: entry.serverName,
        url: entry.url,
        oauthConfigured: Boolean(entry.config.oauth || entry.config.oauth_resource),
        session: publicSession(sessions[entry.connectorId]),
    }));
}

async function startConnectorAuth(options, connectorId, redirectUri) {
    const entry = connectorManifests(options).find((item) => item.connectorId === connectorId);
    if (!entry) throw new Error("No OAuth-capable MCP manifest was found for this connector.");
    const discovery = await discoverOAuth(entry);
    const verifier = randomUrlSafe(48);
    const state = randomUrlSafe(24);
    const clientId = isPlaceholder(entry.config.oauth?.client_id) ? "" : String(entry.config.oauth.client_id);
    if (!clientId && !discovery.metadata.registration_endpoint) {
        throw new Error("This connector has no usable client id or dynamic registration endpoint.");
    }
    let effectiveClientId = clientId;
    let clientSecret = isPlaceholder(entry.config.oauth?.client_secret) ? "" : String(entry.config.oauth.client_secret || "");
    if (!effectiveClientId) {
        const registered = await fetchJson(discovery.metadata.registration_endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                client_name: "Anti-Codex",
                redirect_uris: [redirectUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
            }),
        });
        effectiveClientId = registered.client_id;
        clientSecret = registered.client_secret || "";
    }
    pending.set(state, { ...entry, ...discovery, verifier, clientId: effectiveClientId, clientSecret, redirectUri });
    const query = new URLSearchParams({
        response_type: "code",
        client_id: effectiveClientId,
        redirect_uri: redirectUri,
        code_challenge: sha256Base64Url(verifier),
        code_challenge_method: "S256",
        state,
        ...(entry.config.scopes ? { scope: Array.isArray(entry.config.scopes) ? entry.config.scopes.join(" ") : String(entry.config.scopes) } : {}),
        resource: discovery.resource,
    });
    return { connectorId, authorizationUrl: `${discovery.metadata.authorization_endpoint}?${query}`, state };
}

async function finishConnectorAuth(options, params) {
    const context = pending.get(String(params.state || ""));
    if (!context) throw new Error("OAuth state is missing or expired.");
    pending.delete(String(params.state));
    if (params.error) throw new Error(String(params.error_description || params.error));
    const token = await fetchJson(context.metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: String(params.code || ""),
            redirect_uri: context.redirectUri,
            client_id: context.clientId,
            code_verifier: context.verifier,
            ...(context.clientSecret ? { client_secret: context.clientSecret } : {}),
        }),
    });
    if (!token.access_token) throw new Error("OAuth token response did not include an access token.");
    const state = readState(options.stateRoot);
    state.sessions[context.connectorId] = {
        connectorId: context.connectorId,
        connectorName: context.connectorName,
        pluginName: context.pluginName,
        serverName: context.serverName,
        url: context.url,
        accessToken: token.access_token,
        refreshToken: token.refresh_token || "",
        expiresAt: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
        tokenType: token.token_type || "Bearer",
    };
    writeState(options.stateRoot, state);
    const configPath = writeConnectorMcpConfig(options.codexHome, state.sessions);
    return { connectorId: context.connectorId, session: publicSession(state.sessions[context.connectorId]), configPath };
}

export {
    finishConnectorAuth,
    listConnectorAuth,
    startConnectorAuth,
};
