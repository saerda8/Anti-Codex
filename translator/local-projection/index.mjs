import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EMPTY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6w7YwAAAABJRU5ErkJggg==";
const LOCAL_USER_ID = "deepcodex-local-user";
const LOCAL_ACCOUNT_ID = "deepcodex-local-account";
const LOCAL_DISPLAY_NAME = process.env.DEEPCODEX_ACCOUNT_DISPLAY_NAME || "娄老师说的对";
const LOCAL_EMAIL = process.env.DEEPCODEX_ACCOUNT_EMAIL || "deepcodex@local";
const ANTI_CODEX_EXCLUDED_PLUGIN_NAMES = new Set([
    "codex-app-tools",
    "code-review",
    "unified-computer-use",
]);

function codexHomes() {
    const homes = [];
    const current = process.env.CODEX_HOME || process.env.CODEX_HOME_DIR || "";
    const shared = process.env.DEEPCODEX_SHARED_CODEX_HOME || process.env.GLOBAL_CODEX_HOME || "";
    if (current && shared && samePath(current, shared)) return homes;
    for (const home of [current]) {
        if (home && !homes.includes(home)) homes.push(home);
    }
    return homes;
}

function samePath(left, right) {
    try {
        return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    } catch {
        return String(left || "").toLowerCase() === String(right || "").toLowerCase();
    }
}

function firstHomeWithRelativePath(relPath) {
    for (const home of codexHomes()) {
        if (listJsonFiles(path.join(home, relPath)).length > 0) return home;
    }
    return null;
}

function safeReadJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function listJsonFiles(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => path.join(dir, name))
            .sort();
    } catch {
        return [];
    }
}

function readConnectorDirectory() {
    const home = firstHomeWithRelativePath(path.join("cache", "codex_app_directory"));
    const locallyAuthorized = readLocalAuthorizedConnectorIds();
    if (home) {
        const dir = path.join(home, "cache", "codex_app_directory");
        for (const file of listJsonFiles(dir)) {
            const data = safeReadJson(file);
            if (Array.isArray(data?.connectors)) {
                return {
                    schema_version: data.schema_version || 1,
                    connectors: data.connectors.map((connector) => normalizeConnector(connector, { locallyAuthorized })),
                };
            }
        }
    }
    return { schema_version: 1, connectors: [] };
}

function readLocalAuthorizedConnectorIds() {
    const ids = new Set();
    const envList = String(process.env.ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS || "")
        .split(/[,\r\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    for (const id of envList) ids.add(id);

    for (const home of codexHomes()) {
        const configPath = path.join(home, "config.toml");
        let text = "";
        try { text = fs.readFileSync(configPath, "utf8"); } catch { continue; }
        let inSection = false;
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.replace(/#.*/, "").trim();
            if (!line) continue;
            const section = line.match(/^\[([^\]]+)\]$/);
            if (section) {
                inSection = section[1] === "local_authorized_connectors" || section[1] === "anticodex.local_authorized_connectors";
                continue;
            }
            if (!inSection) continue;
            const array = line.match(/^connectors\s*=\s*\[(.*)\]\s*$/);
            if (array) {
                for (const match of array[1].matchAll(/"([^"]+)"/g)) ids.add(match[1]);
                continue;
            }
            const enabled = line.match(/^("?)([^"=]+)\1\s*=\s*true\s*$/i);
            if (enabled) ids.add(enabled[2].trim());
        }
    }
    return ids;
}

function readAppTools(options = {}) {
    const accessibleConnectorIds = options.accessibleConnectorIds instanceof Set ? options.accessibleConnectorIds : null;
    const tools = [];
    const seen = new Set();
    const home = firstHomeWithRelativePath(path.join("cache", "codex_apps_tools"));
    if (home) {
        const dir = path.join(home, "cache", "codex_apps_tools");
        for (const file of listJsonFiles(dir)) {
            const data = safeReadJson(file);
            if (!Array.isArray(data?.tools)) continue;
            for (const tool of data.tools) {
                if (accessibleConnectorIds) {
                    const connectorId = String(tool?.connector_id || "");
                    if (!connectorId || !accessibleConnectorIds.has(connectorId)) continue;
                }
                const key = `${tool.server_name || ""}\u0000${tool.tool_namespace || ""}\u0000${tool.tool_name || ""}\u0000${tool.connector_id || ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                tools.push(tool);
            }
        }
    }
    return { schema_version: 2, tools };
}

function normalizeConnector(connector, options = {}) {
    const id = connector?.id || connector?.connector_id || "";
    const locallyAuthorized = options.locallyAuthorized instanceof Set && options.locallyAuthorized.has(id);
    const normalized = {
        ...connector,
        id,
        name: connector?.name || connector?.displayName || connector?.id || "App",
        description: connector?.description || "",
        logoUrl: connector?.logoUrl ?? null,
        logoUrlDark: connector?.logoUrlDark ?? null,
        distributionChannel: connector?.distributionChannel || "LOCAL_CACHE",
        appMetadata: connector?.appMetadata || {},
        labels: connector?.labels || {},
        installUrl: localInstallUrl(connector?.installUrl),
        isAccessible: connector?.isAccessible === true,
        locallyAllowlisted: locallyAuthorized,
        isEnabled: connector?.isEnabled !== false,
        pluginDisplayNames: Array.isArray(connector?.pluginDisplayNames) ? connector.pluginDisplayNames : [],
    };
    if (locallyAuthorized) normalized.localAuthorization = "anticodex-local-allowlist";
    if (!Array.isArray(normalized.supported_auth)) {
        normalized.supported_auth = [{ type: "UNSUPPORTED" }];
    }
    if (!normalized.link_params_schema) normalized.link_params_schema = { type: "object", properties: {} };
    return normalized;
}

function localInstallUrl(installUrl) {
    if (!installUrl || typeof installUrl !== "string") return null;
    try {
        const url = new URL(installUrl);
        const host = url.hostname.toLowerCase();
        if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
            return null;
        }
    } catch {
        return installUrl;
    }
    return installUrl;
}

function findConnector(connectorId) {
    const directory = readConnectorDirectory();
    return directory.connectors.find((connector) => connector.id === connectorId) || null;
}

function readPluginRegistrations() {
    const plugins = [];
    const seen = new Set();
    for (const home of codexHomes()) {
        collectPluginDirs(path.join(home, ".tmp", "plugins", "plugins"), "local", plugins, seen);
        collectPluginCache(path.join(home, "plugins", "cache"), plugins, seen);
    }
    const enabledOverrides = readPluginEnabledOverrides();
    for (const plugin of plugins) {
        const key = `${plugin?.plugin?.id || ""}@${plugin?.marketplaceName || ""}`;
        if (enabledOverrides.has(key)) plugin.plugin.enabled = enabledOverrides.get(key);
    }
    plugins.sort((a, b) => a.plugin.id.localeCompare(b.plugin.id));
    return plugins;
}

function readPluginEnabledOverrides() {
    const overrides = new Map();
    for (const home of codexHomes()) {
        const configPath = path.join(home, "config.toml");
        let text = "";
        try { text = fs.readFileSync(configPath, "utf8"); } catch { continue; }
        let currentPluginKey = "";
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            const section = line.match(/^\[plugins\."([^"]+)"\]$/);
            if (section) {
                currentPluginKey = section[1];
                continue;
            }
            if (/^\[/.test(line)) {
                currentPluginKey = "";
                continue;
            }
            if (!currentPluginKey) continue;
            const enabled = line.match(/^enabled\s*=\s*(true|false)\b/i);
            if (enabled) overrides.set(currentPluginKey, enabled[1].toLowerCase() === "true");
        }
    }
    return overrides;
}

function collectPluginCache(cacheRoot, plugins, seen) {
    let marketplaces = [];
    try {
        marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return;
    }
    for (const marketplace of marketplaces) {
        const marketplaceRoot = path.join(cacheRoot, marketplace);
        let pluginNames = [];
        try {
            pluginNames = fs.readdirSync(marketplaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch {
            continue;
        }
        for (const pluginName of pluginNames) {
            const pluginRoot = path.join(marketplaceRoot, pluginName);
            let versions = [];
            try {
                versions = fs.readdirSync(pluginRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
            } catch {
                continue;
            }
            const versionDir = versions.length ? path.join(pluginRoot, versions[versions.length - 1]) : pluginRoot;
            collectPluginDir(versionDir, marketplace, plugins, seen);
        }
    }
}

function collectPluginDirs(root, marketplaceName, plugins, seen) {
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return;
    }
    for (const name of entries) collectPluginDir(path.join(root, name), marketplaceName, plugins, seen);
}

function collectPluginDir(pluginDir, marketplaceName, plugins, seen) {
    const metadata = safeReadJson(path.join(pluginDir, ".codex-plugin", "plugin.json"));
    if (!metadata?.name) return;
    if (ANTI_CODEX_EXCLUDED_PLUGIN_NAMES.has(metadata.name)) return;
    const key = `${metadata.name}@${marketplaceName}`;
    const record = {
        marketplaceName,
        summary: metadata,
        plugin: {
            id: metadata.name,
            installed: true,
            enabled: true,
            name: metadata.name,
            version: metadata.version || "",
            description: metadata.description || "",
            interface: metadata.interface || {},
            authPolicy: "NONE",
            apps: pluginApps(pluginDir),
        },
    };
    if (seen.has(key)) {
        const index = plugins.findIndex((plugin) => `${plugin?.summary?.name || plugin?.plugin?.id || ""}@${plugin?.marketplaceName || ""}` === key);
        if (index >= 0 && pluginMetadataScore(record) > pluginMetadataScore(plugins[index])) plugins[index] = record;
        return;
    }
    seen.add(key);
    plugins.push(record);
}

function pluginMetadataScore(plugin) {
    const summary = plugin?.summary || {};
    const appCount = Array.isArray(plugin?.plugin?.apps) ? plugin.plugin.apps.length : 0;
    return Number(Boolean(summary.skills)) * 10
        + Number(Boolean(summary.mcpServers)) * 5
        + appCount
        + Object.keys(summary.interface || {}).length;
}

function pluginApps(pluginDir) {
    const appData = safeReadJson(path.join(pluginDir, ".app.json"));
    if (!appData?.apps || typeof appData.apps !== "object") return [];
    return Object.entries(appData.apps).flatMap(([name, app]) => {
        if (!app || typeof app !== "object" || !app.id) return [];
        const normalized = normalizeConnector({ ...app, id: app.id, name });
        // The local projection has connector metadata, but no OAuth/session
        // authority.  Keep the plugin's local skills visible while hiding
        // connector apps until the connector is genuinely accessible.
        if (normalized.isAccessible !== true) return [];
        return [{ ...normalized, name }];
    });
}

function pluginsPayload() {
    const plugins = readPluginRegistrations();
    return {
        featuredPluginIds: [],
        marketplaceLoadErrors: [],
        marketplaces: [],
        plugins,
        items: plugins,
        data: plugins,
        installed: plugins.filter((plugin) => plugin.plugin.installed),
    };
}

function installedPluginsPayload() {
    return readPluginRegistrations()
        .filter((plugin) => plugin.plugin.installed)
        .map((plugin) => ({
            ...plugin.plugin,
            marketplaceName: plugin.marketplaceName,
            enabled: plugin.plugin.enabled !== false,
            installed: true,
        }));
}

function connectorDirectoryPayload() {
    const directory = readConnectorDirectory();
    return {
        ...directory,
        items: directory.connectors,
        data: directory.connectors,
    };
}

function whamAppsPayload() {
    const directory = readConnectorDirectory();
    const accessibleConnectorIds = new Set(directory.connectors
        .filter((connector) => connector.isAccessible === true)
        .map((connector) => connector.id)
        .filter(Boolean));
    const tools = readAppTools({ accessibleConnectorIds });
    return {
        apps: directory.connectors,
        connectors: directory.connectors,
        tools: tools.tools,
    };
}

function localUserPayload() {
    return {
        object: "user",
        id: LOCAL_USER_ID,
        name: LOCAL_DISPLAY_NAME,
        email: LOCAL_EMAIL,
        image: null,
        picture: null,
        groups: [],
        accounts: [localAccountPayload()],
    };
}

function localAccountPayload() {
    return {
        id: LOCAL_ACCOUNT_ID,
        object: "account",
        type: "chatgpt",
        account_id: LOCAL_ACCOUNT_ID,
        user_id: LOCAL_USER_ID,
        name: LOCAL_DISPLAY_NAME,
        email: LOCAL_EMAIL,
        role: "owner",
        is_default: true,
        is_deactivated: false,
        supports_websockets: false,
        websocket_url: null,
        plan_type: "prolite",
        account_plan: {
            type: "prolite",
            has_paid_subscription: true,
        },
    };
}

function accountsPayload() {
    const account = localAccountPayload();
    return {
        accounts: [account],
        items: [account],
        data: [account],
        default_account_id: LOCAL_ACCOUNT_ID,
        current_account_id: LOCAL_ACCOUNT_ID,
    };
}

function accountCheckPayload() {
    return {
        user: localUserPayload(),
        account: localAccountPayload(),
        accounts: [localAccountPayload()],
        default_account_id: LOCAL_ACCOUNT_ID,
        current_account_id: LOCAL_ACCOUNT_ID,
        is_authenticated: true,
        requires_login: false,
    };
}

function userSettingsPayload() {
    return {
        object: "user_settings",
        user: localUserPayload(),
        settings: {},
        data: {},
    };
}

function connectorIdFromPath(pathname, suffix = "") {
    const match = pathname.match(/^\/backend-api\/aip\/connectors\/([^/]+)(?:\/.*)?$/);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    if (suffix && !pathname.endsWith(suffix)) return null;
    return id;
}

function connectorDetailPayload(connectorId) {
    return findConnector(connectorId) || normalizeConnector({ id: connectorId, name: connectorId, isAccessible: false, isEnabled: false });
}

function connectorLogoPayload() {
    return { contentType: "image/png", base64: EMPTY_PNG_BASE64 };
}

function localBackendApiResponse(method, pathname) {
    if (method === "GET" && (pathname === "/backend-api/me" || pathname === "/me")) {
        return localUserPayload();
    }
    if (method === "GET" && pathname === "/backend-api/accounts/check/v4-2023-04-27") {
        return accountCheckPayload();
    }
    if (method === "GET" && pathname === "/backend-api/settings/user") {
        return userSettingsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/accounts") {
        return accountsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/accounts/current") {
        return localAccountPayload();
    }
    if (method === "POST" && pathname === "/backend-api/codex/analytics-events/events") {
        return { ok: true };
    }
    if ((method === "GET" || method === "POST") && pathname === "/backend-api/wham/apps") {
        return whamAppsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/plugins/featured") {
        return [];
    }
    if (method === "GET" && pathname === "/backend-api/plugins/list") {
        return pluginsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/ps/plugins/installed") {
        return installedPluginsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/ps/plugins/list") {
        return pluginsPayload();
    }
    if (method === "GET" && pathname === "/backend-api/connectors/directory/list") {
        return connectorDirectoryPayload();
    }
    if (method === "GET" && pathname === "/backend-api/aip/connectors") {
        return connectorDirectoryPayload();
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+\/logo$/)) {
        return connectorLogoPayload();
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+\/link$/)) {
        return { ok: false, object: "connector_link_status", status: "unsupported", error: "Connector link is not available in local metadata-only projection." };
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+\/tos$/)) {
        return { blurbs: [], personalization_toggles: [] };
    }
    if (method === "GET" && pathname.match(/^\/backend-api\/aip\/connectors\/[^/]+$/)) {
        return connectorDetailPayload(connectorIdFromPath(pathname));
    }
    if (method === "POST" && pathname === "/backend-api/aip/connectors/links/noauth") {
        return { ok: false, object: "connector_link_status", status: "unsupported", error: "Connector noauth link is not available in local metadata-only projection." };
    }
    if (method === "POST" && pathname === "/backend-api/aip/connectors/links/oauth") {
        return { ok: false, object: "connector_link_status", status: "unsupported", error: "Connector oauth link is not available in local metadata-only projection." };
    }
    return null;
}

export {
    accountCheckPayload,
    accountsPayload,
    connectorDirectoryPayload,
    localAccountPayload,
    localBackendApiResponse,
    installedPluginsPayload,
    localUserPayload,
    pluginsPayload,
    readAppTools,
    readConnectorDirectory,
    readPluginRegistrations,
};
