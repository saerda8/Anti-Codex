import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const FIXED_ROUTE_SCHEMA = "anticodex-fixed-route-v1";
const CODEX_THREAD_PROVIDER_NAME = "anticodex_antigravity";
export const ANTIGRAVITY_RELAY_ID = "anticodex-antigravity";
export const THIRD_PARTY_RELAY_ID = "anticodex-third-party";
export const ANTIGRAVITY_MODEL_SLOT = "anticodex/antigravity";
export const THIRD_PARTY_MODEL_SLOT = "anticodex/third-party";
export const THIRD_PARTY_MODEL_PREFIX = `${THIRD_PARTY_MODEL_SLOT}/`;
const DEFAULT_THIRD_PARTY_CONTEXT_WINDOW = 272_000;
const THIRD_PARTY_AUTO_COMPACT_PERCENT = 90;

export function thirdPartyNativeModel(model) {
  const value = String(model ?? "").trim();
  if (!value) throw new Error("third-party model is required");
  return `${THIRD_PARTY_MODEL_PREFIX}${value}`;
}

export function resolveProductPaths(installRoot, stateRoot) {
  const install = requireAbsoluteRoot(installRoot, "installRoot");
  const state = requireAbsoluteRoot(stateRoot, "stateRoot");
  const appDir = join(install, "codex-patched-app");
  const codexHome = join(state, "codex-home-deepseek-app");
  return {
    installRoot: install,
    appDir,
    appExecutable: join(appDir, "Anti-Codex.exe"),
    codexCli: join(appDir, "resources", "codex.exe"),
    codexPlusPlusBinary: join(install, "components", "codexplusplus", "codex-plus-plus.exe"),
    stateRoot: state,
    codexPlusPlusState: join(state, "codexplusplus"),
    codexHome,
    electronUserData: join(codexHome, "electron-user-data-adaptive"),
    isolatedAppData: join(state, "windows-appdata"),
    isolatedLocalAppData: join(state, "windows-localappdata"),
    temp: join(state, "temp", "fixed-route"),
    logs: join(state, "fixed-route-logs"),
    statusFile: join(state, "fixed-route-status.json"),
  };
}

export function generateRouteConfig(options = {}) {
  const provider = String(options.provider ?? "").trim().toLowerCase();
  const proxyPort = requirePort(options.proxyPort, "proxyPort");
  const codexBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;
  const model = String(
    options.model
      ?? options.thirdPartyConfig?.model
      ?? "gemini-3-flash-agent",
  ).trim();
  if (!model) throw new Error("model is required");
  const clientModel = String(options.clientModel ?? model).trim();
  if (!clientModel) throw new Error("clientModel is required");
  const relayModelList = [...new Set((Array.isArray(options.relayModelList)
    ? options.relayModelList
    : [clientModel]).map((value) => String(value ?? "").trim()).filter(Boolean))];

  const localProxyKey = String(options.localProxyKey ?? "anticodex-local-proxy-key");
  let adapterEnabled;
  let relayProtocol;
  let codexPlusPlusUpstreamUrl;
  let profileId;
  let profileName;
  let upstreamApiKey = "";
  let modelContextWindow = null;
  let modelAutoCompactTokenLimit = null;

  if (provider === "antigravity") {
    const adapterPort = requirePort(options.adapterPort, "adapterPort");
    adapterEnabled = true;
    relayProtocol = "chatCompletions";
    codexPlusPlusUpstreamUrl = `http://127.0.0.1:${adapterPort}/v1`;
    profileId = ANTIGRAVITY_RELAY_ID;
    profileName = "Anti-Codex Antigravity";
  } else if (provider === "third-party") {
    const thirdParty = options.thirdPartyConfig ?? {};
    adapterEnabled = false;
    relayProtocol = normalizeThirdPartyProtocol(thirdParty.protocol);
    codexPlusPlusUpstreamUrl = normalizeUpstreamBaseUrl(thirdParty.baseUrl);
    upstreamApiKey = String(thirdParty.apiKey ?? "");
    if (!upstreamApiKey) throw new Error("thirdPartyConfig.apiKey is required");
    modelContextWindow = requireContextWindow(
      options.contextWindow ?? thirdParty.contextWindow ?? DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
    );
    modelAutoCompactTokenLimit = Math.floor(
      modelContextWindow * THIRD_PARTY_AUTO_COMPACT_PERCENT / 100,
    );
    profileId = THIRD_PARTY_RELAY_ID;
    profileName = "Anti-Codex third-party API";
  } else {
    throw new Error("provider must be antigravity or third-party");
  }

  // Codex persists this id in thread metadata, so upstream switches must not change it.
  const providerName = CODEX_THREAD_PROVIDER_NAME;
  const catalogLine = options.catalogPath
    ? `model_catalog_json = ${tomlString(resolve(String(options.catalogPath)))}`
    : "";
  const config = [
    `model = ${tomlString(clientModel)}`,
    catalogLine,
    modelContextWindow ? `model_context_window = ${modelContextWindow}` : "",
    modelAutoCompactTokenLimit ? `model_auto_compact_token_limit = ${modelAutoCompactTokenLimit}` : "",
    modelAutoCompactTokenLimit ? 'model_auto_compact_token_limit_scope = "total"' : "",
    `model_provider = ${tomlString(providerName)}`,
    "approval_policy = \"never\"",
    "sandbox_mode = \"danger-full-access\"",
    "allow_login_shell = false",
    "",
    `[model_providers.${providerName}]`,
    `name = ${tomlString(profileName)}`,
    "wire_api = \"responses\"",
    "requires_openai_auth = true",
    `base_url = ${tomlString(codexBaseUrl)}`,
    `experimental_bearer_token = ${tomlString(localProxyKey)}`,
    "",
  ].join("\n");
  const authContents = `${JSON.stringify({ OPENAI_API_KEY: localProxyKey }, null, 2)}\n`;

  return {
    schema: FIXED_ROUTE_SCHEMA,
    provider,
    model,
    clientModel,
    relayModelList,
    adapterEnabled,
    relayProtocol,
    codexBaseUrl,
    codexPlusPlusUpstreamUrl,
    profileId,
    profileName,
    modelContextWindow,
    modelAutoCompactTokenLimit,
    localProxyKey,
    upstreamApiKey,
    config,
    authContents,
  };
}

export function getLauncherArgs(options = {}) {
  const helperPort = requirePort(options.helperPort, "helperPort");
  if (options.launchDesktop !== true) {
    return ["--helper-only", "--helper-port", String(helperPort)];
  }
  const appPath = String(options.appPath ?? "").trim();
  if (!appPath || !isAbsolute(appPath)) {
    throw new Error("appPath must be an absolute path");
  }
  return [
    "--app-path", resolve(appPath),
    "--debug-port", String(requirePort(options.debugPort, "debugPort")),
    "--helper-port", String(helperPort),
  ];
}

export function getCopiedClientArgs(options = {}) {
  const debugPort = requirePort(options.debugPort, "debugPort");
  const codexExtraArgs = Array.isArray(options.codexExtraArgs)
    ? options.codexExtraArgs.map((value) => String(value))
    : [];
  return [
    `--remote-debugging-port=${debugPort}`,
    `--remote-allow-origins=http://127.0.0.1:${debugPort}`,
    ...codexExtraArgs,
  ];
}

export function buildCodexPlusPlusSettings(options = {}) {
  const route = options.route;
  if (!route || route.schema !== FIXED_ROUTE_SCHEMA) throw new Error("route is required");
  const relayRoutes = Array.isArray(options.relayRoutes) && options.relayRoutes.length > 0
    ? options.relayRoutes
    : [route];
  for (const relayRoute of relayRoutes) {
    if (!relayRoute || relayRoute.schema !== FIXED_ROUTE_SCHEMA) {
      throw new Error("relayRoutes must contain fixed-route entries");
    }
  }
  if (!relayRoutes.some((relayRoute) => relayRoute.profileId === route.profileId)) {
    throw new Error("active route must be included in relayRoutes");
  }
  const userDataDir = String(options.userDataDir ?? "").trim();
  if (!userDataDir || !isAbsolute(userDataDir)) throw new Error("userDataDir must be absolute");
  const codexExtraArgs = [
    `--user-data-dir=${resolve(userDataDir)}`,
    "--no-first-run",
    "--no-sandbox",
    "--lang=zh-CN",
  ];
  if (options.disableGpu === true) {
    codexExtraArgs.push(
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu-sandbox",
      "--in-process-gpu",
    );
  }
  return {
    codexExtraArgs,
    enhancementsEnabled: false,
    providerSyncEnabled: false,
    relayProfilesEnabled: true,
    computerUseGuardEnabled: false,
    codexAppPluginMarketplaceUnlock: false,
    codexAppNativeMenuLocalization: false,
    codexAppFastStartup: false,
    relayProfiles: relayRoutes.map((relayRoute) => ({
      id: relayRoute.profileId,
      name: relayRoute.profileName,
      upstreamBaseUrl: relayRoute.codexPlusPlusUpstreamUrl,
      apiKey: relayRoute.upstreamApiKey,
      protocol: relayRoute.relayProtocol,
      relayMode: "pureApi",
      testModel: relayRoute.model,
      configContents: relayRoute.config,
      authContents: relayRoute.upstreamApiKey
        ? `${JSON.stringify({ OPENAI_API_KEY: relayRoute.upstreamApiKey }, null, 2)}\n`
        : relayRoute.authContents,
      useCommonConfig: false,
      contextWindow: relayRoute.modelContextWindow ? String(relayRoute.modelContextWindow) : "",
      autoCompactLimit: relayRoute.modelAutoCompactTokenLimit
        ? String(relayRoute.modelAutoCompactTokenLimit)
        : "",
      modelList: (relayRoute.relayModelList?.length
        ? relayRoute.relayModelList
        : [relayRoute.clientModel ?? relayRoute.model]).join("\n"),
    })),
    activeRelayId: route.profileId,
    relayTestModel: route.model,
  };
}

export function mergeCodexRouteConfig(existingConfig, route) {
  if (!route || route.schema !== FIXED_ROUTE_SCHEMA) throw new Error("route is required");
  const source = String(existingConfig ?? "").replaceAll("\r\n", "\n");
  const lines = removeManagedProviderSection(source.split("\n"));
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  const rootEnd = firstSection < 0 ? lines.length : firstSection;
  const rootLines = lines.slice(0, rootEnd);
  const sectionLines = lines.slice(rootEnd);
  const managedKeys = new Set([
    "model",
    "model_catalog_json",
    "model_context_window",
    "model_auto_compact_token_limit",
    "model_auto_compact_token_limit_scope",
    "model_provider",
    "chatgpt_base_url",
    "openai_base_url",
    "approval_policy",
    "sandbox_mode",
    "allow_login_shell",
  ]);
  const preservedRoot = rootLines.filter((line) => {
    const match = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    return !match || !managedKeys.has(match[1]);
  });
  const routeLines = route.config.split("\n");
  const providerSectionIndex = routeLines.findIndex((line) => /^\[model_providers\./.test(line));
  const managedRoot = routeLines.slice(0, providerSectionIndex).filter(Boolean);
  const managedSection = trimBoundaryBlankLines(routeLines.slice(providerSectionIndex));
  return [
    ...managedRoot,
    ...trimBoundaryBlankLines(preservedRoot),
    "",
    ...trimBoundaryBlankLines(sectionLines),
    "",
    ...managedSection,
    "",
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function isPathInsideRoot(candidate, root) {
  const absoluteCandidate = resolve(String(candidate));
  const absoluteRoot = resolve(String(root));
  const rel = relative(absoluteRoot, absoluteCandidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function removeManagedProviderSection(lines) {
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1] ?? "";
    if (section) {
      skipping = section === "model_providers.anticodex_antigravity"
        || section === "model_providers.anticodex_third_party";
    }
    if (!skipping) output.push(line);
  }
  return output;
}

function trimBoundaryBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !String(lines[start]).trim()) start += 1;
  while (end > start && !String(lines[end - 1]).trim()) end -= 1;
  return lines.slice(start, end);
}

function normalizeThirdPartyProtocol(value) {
  const protocol = String(value ?? "chat").trim().toLowerCase();
  if (["chat", "chatcompletions", "chat-completions", "openai-compatible"].includes(protocol)) {
    return "chatCompletions";
  }
  if (["responses", "openai-responses"].includes(protocol)) return "responses";
  throw new Error(`Unsupported CodexPlusPlus third-party protocol: ${value}`);
}

function normalizeUpstreamBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) throw new Error("thirdPartyConfig.baseUrl must be HTTP(S)");
  const url = new URL(text);
  if (url.username || url.password) throw new Error("thirdPartyConfig.baseUrl must not contain credentials");
  return text.replace(/\/$/, "");
}

function requireAbsoluteRoot(value, name) {
  const text = String(value ?? "").trim();
  if (!text || !isAbsolute(text)) throw new Error(`${name} must be an absolute path`);
  return normalize(resolve(text));
}

function requirePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

function requireContextWindow(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 16_000 || parsed > 4_000_000) {
    throw new Error("contextWindow must be an integer between 16000 and 4000000");
  }
  return parsed;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}
