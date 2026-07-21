#!/usr/bin/env node

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildAntigravityModelCatalog } from "../translator/antigravity-model-catalog.mjs";
import { createAntigravityCascadeClient } from "../translator/provider/antigravity-cascade-client.mjs";
import { startAntigravityChatProvider } from "../translator/provider/start-antigravity-chat-provider.mjs";
import { createAntiCodexManagerService } from "./anticodex-manager-service.mjs";
import { ownerProcessIsAlive } from "./lib/anticodex-owner-process.mjs";
import {
  ANTIGRAVITY_MODEL_SLOT,
  ANTIGRAVITY_RELAY_ID,
  THIRD_PARTY_MODEL_SLOT,
  THIRD_PARTY_RELAY_ID,
  buildCodexPlusPlusSettings,
  generateRouteConfig,
  getCopiedClientArgs,
  getLauncherArgs,
  isPathInsideRoot,
  mergeCodexRouteConfig,
  resolveProductPaths,
  thirdPartyNativeModel,
} from "./lib/anticodex-fixed-route.mjs";

const COMPONENT_SCHEMA = "codexplusplus-component-manifest-v1";
const STATUS_SCHEMA = "anticodex-fixed-route-status-v1";
const DEFAULT_THIRD_PARTY_CONTEXT_WINDOW = 272_000;
const CLIENT_EXIT_GRACE_MS = 10_000;
const OWNED_PROCESS_STOP_WAIT_MS = 5_000;
const DEFAULT_PORTS = Object.freeze({
  cdp: 18318,
  proxy: 18484,
  launcherGuard: 18485,
  managerGuard: 18486,
  health: 18487,
  adapter: 18488,
  helper: 18489,
});

export function buildFixedRoutePlan(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const installRoot = resolve(args.installRoot ?? join(requiredEnv(env, "LOCALAPPDATA"), "Anti-Codex"));
  const stateRoot = resolve(args.stateRoot ?? join(requiredEnv(env, "APPDATA"), "anticodex"));
  const paths = resolveProductPaths(installRoot, stateRoot);
  const provider = String(args.provider ?? env.ANTICODEX_PROVIDER ?? "antigravity").trim().toLowerCase();
  if (!["antigravity", "third-party"].includes(provider)) {
    throw new Error("provider must be antigravity or third-party");
  }
  const requestedModel = optionalText(args.model ?? env.ANTICODEX_MODEL);
  const antigravityModel = optionalText(
    env.ANTICODEX_ANTIGRAVITY_MODEL
      ?? (provider === "antigravity" ? requestedModel : undefined),
  ) ?? "gemini-3-flash-agent";
  const thirdPartyModel = optionalText(
    env.UPSTREAM_MODEL
      ?? (provider === "third-party" ? requestedModel : undefined),
  );
  const thirdPartyConfig = env.UPSTREAM_URL && thirdPartyModel && env.UPSTREAM_API_KEY
    ? {
        protocol: env.UPSTREAM_PROTOCOL ?? "chat",
        baseUrl: env.UPSTREAM_URL,
        model: thirdPartyModel,
        apiKey: env.UPSTREAM_API_KEY,
      }
    : null;
  if (provider === "third-party" && !thirdPartyConfig) {
    throw new Error("Saved third-party route is incomplete");
  }
  const model = provider === "third-party" ? thirdPartyModel : antigravityModel;
  const modelContextWindow = provider === "third-party"
    ? contextWindow(args.contextWindow ?? env.UPSTREAM_CONTEXT_WINDOW, DEFAULT_THIRD_PARTY_CONTEXT_WINDOW)
    : null;
  const headless = truthy(args.headless ?? env.ANTICODEX_HEADLESS);
  const ports = {
    cdp: port(args.cdpPort, DEFAULT_PORTS.cdp, "cdp-port"),
    proxy: port(args.proxyPort, DEFAULT_PORTS.proxy, "proxy-port"),
    launcherGuard: port(args.launcherGuardPort, DEFAULT_PORTS.launcherGuard, "launcher-guard-port"),
    managerGuard: port(args.managerGuardPort, DEFAULT_PORTS.managerGuard, "manager-guard-port"),
    health: port(args.healthPort, DEFAULT_PORTS.health, "health-port"),
    adapter: port(args.adapterPort, DEFAULT_PORTS.adapter, "adapter-port"),
    helper: port(args.helperPort, DEFAULT_PORTS.helper, "helper-port"),
  };
  ensureUniquePorts(ports);

  const catalogPath = join(paths.codexHome, "anticodex-model-catalog.json");
  const localProxyKey = randomBytes(24).toString("hex");
  const antigravityRoute = generateRouteConfig({
    provider: "antigravity",
    model: antigravityModel,
    clientModel: provider === "antigravity" ? antigravityModel : ANTIGRAVITY_MODEL_SLOT,
    proxyPort: ports.proxy,
    adapterPort: ports.adapter,
    catalogPath,
    localProxyKey,
    relayModelList: [ANTIGRAVITY_MODEL_SLOT, antigravityModel],
  });
  const thirdPartyRoute = thirdPartyConfig
    ? generateRouteConfig({
        provider: "third-party",
        model: thirdPartyModel,
        clientModel: provider === "third-party"
          ? thirdPartyNativeModel(thirdPartyModel)
          : THIRD_PARTY_MODEL_SLOT,
        contextWindow: contextWindow(
          env.UPSTREAM_CONTEXT_WINDOW,
          DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
        ),
        proxyPort: ports.proxy,
        catalogPath,
        localProxyKey,
        thirdPartyConfig,
        relayModelList: [THIRD_PARTY_MODEL_SLOT, thirdPartyNativeModel(thirdPartyModel)],
      })
    : null;
  const route = provider === "third-party" ? thirdPartyRoute : antigravityRoute;
  const relayRoutes = [antigravityRoute, thirdPartyRoute].filter(Boolean);
  const settings = buildCodexPlusPlusSettings({
    route,
    relayRoutes,
    userDataDir: paths.electronUserData,
    disableGpu: truthy(args.disableGpu ?? env.ANTICODEX_DISABLE_GPU),
  });
  const launcherArgs = getLauncherArgs({
    launchDesktop: false,
    helperPort: ports.proxy,
  });
  const clientArgs = headless ? [] : getCopiedClientArgs({
    debugPort: ports.cdp,
    codexExtraArgs: settings.codexExtraArgs,
  });
  const managerBaseUrl = normalizeLoopbackUrl(
    args.managerBaseUrl ?? env.ANTICODEX_MANAGER_API ?? "http://127.0.0.1:8484",
  );

  return {
    args,
    paths,
    provider,
    model: route.model,
    antigravityModel,
    thirdPartyConfig,
    modelContextWindow,
    headless,
    ports,
    route,
    relayRoutes,
    launcherArgs,
    clientArgs,
    settings,
    managerBaseUrl,
  };
}

export function sanitizeFixedRoutePlan(plan) {
  return {
    ok: true,
    planOnly: true,
    schema: STATUS_SCHEMA,
    paths: {
      installRoot: plan.paths.installRoot,
      appDir: plan.paths.appDir,
      appExecutable: plan.paths.appExecutable,
      codexCli: plan.paths.codexCli,
      codexPlusPlusBinary: plan.paths.codexPlusPlusBinary,
      stateRoot: plan.paths.stateRoot,
      codexPlusPlusState: plan.paths.codexPlusPlusState,
      codexHome: plan.paths.codexHome,
      electronUserData: plan.paths.electronUserData,
      statusFile: plan.paths.statusFile,
    },
    ports: plan.ports,
    modelContextWindow: plan.modelContextWindow,
    route: publicRoute(plan.route),
    launcherArgs: plan.launcherArgs,
    clientArgs: plan.clientArgs,
    childEnvironment: publicChildEnvironment(plan),
    lifecycle: {
      launchesVisibleClientOnce: !plan.headless,
      headlessProtocolProxy: true,
      codexPlusPlusOwnsClient: false,
      clientOwner: plan.headless ? null : "fixed-route-supervisor",
      automaticallyRelaunchesClient: false,
      ownsTaskControl: false,
      cleansOnlyOwnedChildren: true,
    },
  };
}

async function runSupervisor(plan) {
  assertProductionRoots(plan);
  const startupProcessScan = assertNoExistingClient();
  const component = validateInstalledComponent(plan.paths);
  ensureProductDirectories(plan.paths);

  let status = {
    ok: false,
    schema: STATUS_SCHEMA,
    state: "starting",
    pid: process.pid,
    provider: plan.provider,
    model: plan.model,
    modelContextWindow: plan.modelContextWindow,
    route: publicRoute(plan.route),
    ports: plan.ports,
    appExecutable: plan.paths.appExecutable,
    component: {
      schema: component.schema,
      version: component.version,
      patchCommit: component.patchCommit,
      binarySha256: component.binary.sha256,
    },
    startedAt: new Date().toISOString(),
    readyAt: null,
    stoppedAt: null,
    error: null,
    processes: {},
    startupProcessScan: {
      ok: startupProcessScan.ok,
      processCount: startupProcessScan.processes.length,
      error: startupProcessScan.error,
    },
  };
  let requestShutdown = null;
  const health = await startHealthServer(plan.ports.health, () => runtimeRouteStatus(status, plan), {
    shutdownToken: plan.route.localProxyKey,
    onShutdown: (reason) => requestShutdown?.(reason),
  });
  writeStatus(plan.paths.statusFile, status);

  let provider = null;
  let launcher = null;
  let copiedClient = null;
  let managerService = null;
  let managerWatcher = null;
  let managerBridge = null;
  const ownedClients = new Set();
  let closing = false;
  let shutdownReason = "unknown";
  let launcherLog = null;
  let launcherErrorLog = null;

  const cleanup = async (reason, options = {}) => {
    if (closing) return;
    closing = true;
    shutdownReason = reason;
    const stoppedNormally = ["client_exited", "control_shutdown", "signal_sigint", "signal_sigterm"].includes(reason);
    const shutdownPids = [...new Set([
      managerWatcher?.pid,
      managerBridge?.pid,
      ...(options.stopClient === true ? [copiedClient?.pid, ...ownedClients] : []),
      launcher?.pid,
    ].map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
    status = {
      ...status,
      ok: false,
      state: "stopping",
      stoppingAt: new Date().toISOString(),
      stopReason: reason,
    };
    writeStatus(plan.paths.statusFile, status);
    await provider?.close?.().catch(() => {});
    stopOwnedProcess(managerWatcher);
    stopOwnedProcess(managerBridge);
    if (options.stopClient === true) {
      stopOwnedProcess(copiedClient);
      for (const pid of ownedClients) stopProcessTree(pid);
    }
    stopOwnedProcess(launcher);
    await managerService?.close?.().catch(() => {});
    const shutdownSurvivors = await waitForOwnedProcessExit(shutdownPids);
    if (launcherLog !== null) closeSync(launcherLog);
    if (launcherErrorLog !== null) closeSync(launcherErrorLog);
    const fullyStopped = shutdownSurvivors.length === 0;
    status = {
      ...status,
      ok: stoppedNormally && fullyStopped,
      state: stoppedNormally && fullyStopped ? "stopped" : "error",
      stoppedAt: new Date().toISOString(),
      stopReason: reason,
      shutdownSurvivors,
      error: fullyStopped
        ? status.error
        : `Owned Anti-Codex processes did not stop: ${shutdownSurvivors.join(", ")}`,
    };
    writeStatus(plan.paths.statusFile, status);
    await health.close().catch(() => {});
    return { fullyStopped, shutdownSurvivors };
  };
  requestShutdown = (reason) => cleanup(reason, { stopClient: true });

  const signalHandler = (signal) => {
    void cleanup(`signal_${signal.toLowerCase()}`, { stopClient: true })
      .finally(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  try {
    const managerUrl = new URL(plan.managerBaseUrl);
    managerService = createAntiCodexManagerService({
      host: managerUrl.hostname,
      port: Number(managerUrl.port || 80),
      stateRoot: plan.paths.stateRoot,
      fixedHealthUrl: `http://127.0.0.1:${plan.ports.health}/anticodex/fixed-route/health`,
    });
    await managerService.listen();
    status.processes.managerService = process.pid;
    writeStatus(plan.paths.statusFile, status);

    const bundledCatalog = readBundledCatalog(plan.paths.codexCli);
    const antigravityCatalogPath = join(plan.paths.codexHome, "antigravity-model-catalog.json");
    const unifiedCatalogPath = join(plan.paths.codexHome, "anticodex-model-catalog.json");
    const antigravityClient = createAntigravityCascadeClient();
    let antigravityReady = false;
    let antigravityCatalog = readCatalogSafely(antigravityCatalogPath) ?? { ...bundledCatalog, models: [] };
    try {
      const readiness = await antigravityClient.getReadiness();
      antigravityReady = readiness?.signedIn === true;
      if (antigravityReady) {
        const availableModels = await antigravityClient.listModels();
        antigravityCatalog = buildRuntimeCatalogFromBundled(bundledCatalog, availableModels);
        writeTextAtomic(antigravityCatalogPath, `${JSON.stringify(antigravityCatalog, null, 2)}\n`);
      }
    } catch (error) {
      if (plan.provider === "antigravity") throw error;
    }
    if (plan.provider === "antigravity" && !antigravityReady) {
      throw new Error("Antigravity Desktop is not signed in.");
    }
    if (plan.provider === "antigravity"
        && !antigravityCatalog.models.some((entry) => entry.slug === plan.model)) {
      throw new Error(`Antigravity model is unavailable: ${plan.model}`);
    }
    provider = await startAntigravityChatProvider({
      client: antigravityClient,
      host: "127.0.0.1",
      port: plan.ports.adapter,
    });

    const thirdPartyRoute = plan.relayRoutes.find((entry) => entry.profileId === THIRD_PARTY_RELAY_ID) ?? null;
    const catalog = buildUnifiedModelCatalog(bundledCatalog, {
      antigravityCatalog,
      thirdPartyModel: thirdPartyRoute?.model,
      thirdPartyModels: thirdPartyRoute?.model ? [thirdPartyRoute.model] : [],
      thirdPartyContextWindow: thirdPartyRoute?.modelContextWindow ?? DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
    });
    writeTextAtomic(unifiedCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    const antigravityModelIds = antigravityCatalog.models
      .map((entry) => String(entry?.slug ?? "").trim())
      .filter(Boolean);
    const runtimeRelayRoutes = plan.relayRoutes.map((entry) => {
      if (entry.profileId === ANTIGRAVITY_RELAY_ID) {
        return { ...entry, relayModelList: [ANTIGRAVITY_MODEL_SLOT, ...antigravityModelIds] };
      }
      return {
        ...entry,
        relayModelList: [THIRD_PARTY_MODEL_SLOT, thirdPartyNativeModel(entry.model)],
      };
    });
    const runtimeRoute = runtimeRelayRoutes.find((entry) => entry.profileId === plan.route.profileId);

    const configPath = join(plan.paths.codexHome, "config.toml");
    const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const mergedConfig = mergeCodexRouteConfig(existingConfig, runtimeRoute);
    const settings = buildCodexPlusPlusSettings({
      route: { ...runtimeRoute, config: mergedConfig },
      relayRoutes: runtimeRelayRoutes.map((entry) => ({ ...entry, config: mergedConfig })),
      userDataDir: plan.paths.electronUserData,
      disableGpu: truthy(plan.args.disableGpu ?? process.env.ANTICODEX_DISABLE_GPU),
    });
    writeTextAtomic(configPath, mergedConfig);
    writeTextAtomic(join(plan.paths.codexHome, "auth.json"), runtimeRoute.authContents);
    writeTextAtomic(join(plan.paths.codexPlusPlusState, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

    const childEnvironment = buildSupervisorChildEnvironment(plan, process.env);
    const launcherLogPath = join(plan.paths.logs, "codexplusplus-launcher.log");
    const launcherErrorPath = join(plan.paths.logs, "codexplusplus-launcher.err.log");
    launcherLog = openSync(launcherLogPath, "a");
    launcherErrorLog = openSync(launcherErrorPath, "a");
    launcher = spawn(plan.paths.codexPlusPlusBinary, plan.launcherArgs, {
      cwd: plan.paths.appDir,
      env: childEnvironment,
      windowsHide: true,
      stdio: ["ignore", launcherLog, launcherErrorLog],
    });
    status.processes.codexPlusPlus = launcher.pid;
    writeStatus(plan.paths.statusFile, status);

    await waitFor(async () => {
      if (launcher.exitCode !== null) {
        throw new Error(`CodexPlusPlus protocol proxy exited before readiness: ${launcher.exitCode}`);
      }
      const [proxyReady, selectedModelReady] = await Promise.all([
        tcpReady(plan.ports.proxy),
        plan.provider === "antigravity"
          ? proxyModelCatalogReady(plan.ports.proxy, plan.route.localProxyKey, plan.model)
          : Promise.resolve(true),
      ]);
      return proxyReady && selectedModelReady ? true : null;
    }, { timeoutMs: 90_000, intervalMs: 1_000, description: "fixed-route protocol proxy" });

    if (plan.headless) {
      status = {
        ...status,
        ok: true,
        state: "ready",
        readyAt: new Date().toISOString(),
        headless: true,
        antigravityReady,
        catalogModelCount: catalog?.models?.length ?? null,
        processes: {
          managerService: process.pid,
          codexPlusPlus: launcher.pid,
          copiedClient: [],
          managerWatcher: null,
          managerBridge: null,
        },
      };
      writeStatus(plan.paths.statusFile, status);

      while (!closing) {
        if (launcher.exitCode !== null) {
          await cleanup("headless_proxy_exited");
          break;
        }
        await sleep(1_000);
      }
      return { shutdownReason };
    }

    copiedClient = spawn(plan.paths.appExecutable, plan.clientArgs, {
      cwd: plan.paths.appDir,
      env: childEnvironment,
      windowsHide: false,
      stdio: "ignore",
    });
    ownedClients.add(copiedClient.pid);
    status.processes.copiedClient = [copiedClient.pid];
    writeStatus(plan.paths.statusFile, status);

    const ready = await waitFor(async () => {
      const processScan = scanCopiedClientProcessesSafely();
      const clients = processScan.processes;
      if (launcher.exitCode !== null) {
        throw new Error(`CodexPlusPlus protocol proxy exited during client startup: ${launcher.exitCode}`);
      }
      if (copiedClient.exitCode !== null && processScan.ok && !clients.length) {
        throw new Error(`Anti-Codex exited before readiness: ${copiedClient.exitCode}`);
      }
      for (const row of clients) ownedClients.add(row.processId);
      const cdpReady = await cdpPageReady(plan.ports.cdp);
      return cdpReady ? { clients, processScan } : null;
    }, { timeoutMs: 90_000, intervalMs: 1_000, description: "fixed-route Anti-Codex" });

    const management = startManagerSupport(plan, childEnvironment);
    managerWatcher = management.watcher;
    managerBridge = management.bridge;
    status = {
      ...status,
      ok: true,
      state: "ready",
      readyAt: new Date().toISOString(),
      antigravityReady,
      catalogModelCount: catalog?.models?.length ?? null,
      processes: {
        managerService: process.pid,
        codexPlusPlus: launcher.pid,
        copiedClient: ready.clients.map((row) => row.processId),
        managerWatcher: managerWatcher?.pid ?? null,
        managerBridge: managerBridge?.pid ?? null,
      },
    };
    writeStatus(plan.paths.statusFile, status);

    let clientMissingSince = null;
    while (!closing) {
      if (launcher.exitCode !== null) {
        throw new Error(`CodexPlusPlus protocol proxy exited while Anti-Codex was running: ${launcher.exitCode}`);
      }
      const clientSession = await observeCopiedClientSession(ownedClients, {
        isCdpReady: () => cdpPageReady(plan.ports.cdp),
      });
      const exitGrace = updateClientExitGrace(clientMissingSince, clientSession.ready);
      clientMissingSince = exitGrace.missingSince;
      if (clientSession.ownershipChanged) {
        status.processes.copiedClient = clientSession.livePids;
        writeStatus(plan.paths.statusFile, status);
      }
      if (exitGrace.expired) {
        await cleanup("client_exited");
        break;
      }
      await sleep(1_000);
    }
  } catch (error) {
    status = {
      ...status,
      ok: false,
      state: "error",
      error: String(error?.message ?? error),
    };
    writeStatus(plan.paths.statusFile, status);
    await cleanup(status.readyAt ? "supervisor_failed" : "startup_failed", { stopClient: true });
    throw error;
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
  }

  return { shutdownReason };
}

function parseArgs(argv) {
  const aliases = new Map([
    ["--install-root", "installRoot"],
    ["--state-root", "stateRoot"],
    ["--provider", "provider"],
    ["--model", "model"],
    ["--context-window", "contextWindow"],
    ["--proxy-port", "proxyPort"],
    ["--adapter-port", "adapterPort"],
    ["--cdp-port", "cdpPort"],
    ["--health-port", "healthPort"],
    ["--helper-port", "helperPort"],
    ["--launcher-guard-port", "launcherGuardPort"],
    ["--manager-guard-port", "managerGuardPort"],
    ["--manager-base-url", "managerBaseUrl"],
  ]);
  const result = { planJson: false, disableGpu: false, headless: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--plan-json") {
      result.planJson = true;
      continue;
    }
    if (token === "--disable-gpu") {
      result.disableGpu = true;
      continue;
    }
    if (token === "--headless") {
      result.headless = true;
      continue;
    }
    const key = aliases.get(token);
    if (!key) throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function publicRoute(route) {
  return {
    schema: route.schema,
    provider: route.provider,
    model: route.model,
    adapterEnabled: route.adapterEnabled,
    relayProtocol: route.relayProtocol,
    codexBaseUrl: route.codexBaseUrl,
    codexPlusPlusUpstreamUrl: route.codexPlusPlusUpstreamUrl,
    profileId: route.profileId,
    profileName: route.profileName,
    modelContextWindow: route.modelContextWindow,
    modelAutoCompactTokenLimit: route.modelAutoCompactTokenLimit,
    requestModelOverride: null,
  };
}

function configuredNativeModel(configPath) {
  if (!existsSync(configPath)) return "";
  try {
    const source = readFileSync(configPath, "utf8").replaceAll("\r\n", "\n");
    const root = source.split(/^\s*\[[^\]]+\]\s*$/m, 1)[0];
    const match = /^\s*model\s*=\s*"([^"]+)"\s*(?:#.*)?$/m.exec(root);
    return String(match?.[1] ?? "").trim();
  } catch {
    return "";
  }
}

export function runtimeRouteStatus(baseStatus, plan) {
  if (!baseStatus || baseStatus.state !== "ready") return baseStatus;
  try {
    const settingsPath = join(plan.paths.codexPlusPlusState, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const profiles = Array.isArray(settings.relayProfiles) ? settings.relayProfiles : [];
    const antigravity = profiles.find((entry) => entry?.id === ANTIGRAVITY_RELAY_ID) ?? null;
    const thirdParty = profiles.find((entry) => entry?.id === THIRD_PARTY_RELAY_ID) ?? null;
    const nativeModel = configuredNativeModel(join(plan.paths.codexHome, "config.toml"));
    const antigravityModels = new Set(String(antigravity?.modelList ?? "")
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean));
    let provider;
    let model;
    let profile;
    if (nativeModel === THIRD_PARTY_MODEL_SLOT || nativeModel.startsWith(`${THIRD_PARTY_MODEL_SLOT}/`)) {
      provider = "third-party";
      model = nativeModel.startsWith(`${THIRD_PARTY_MODEL_SLOT}/`)
        ? nativeModel.slice(THIRD_PARTY_MODEL_SLOT.length + 1)
        : String(thirdParty?.testModel ?? "");
      profile = thirdParty;
    } else if (nativeModel === ANTIGRAVITY_MODEL_SLOT || antigravityModels.has(nativeModel)) {
      provider = "antigravity";
      model = nativeModel === ANTIGRAVITY_MODEL_SLOT
        ? String(antigravity?.testModel ?? "")
        : nativeModel;
      profile = antigravity;
    } else {
      provider = settings.activeRelayId === THIRD_PARTY_RELAY_ID ? "third-party" : "antigravity";
      profile = provider === "third-party" ? thirdParty : antigravity;
      model = String(profile?.testModel ?? baseStatus.model ?? "");
    }
    if (!profile || !model) return baseStatus;
    return {
      ...baseStatus,
      provider,
      model,
      modelContextWindow: provider === "third-party"
        ? Number(profile.contextWindow || baseStatus.modelContextWindow || DEFAULT_THIRD_PARTY_CONTEXT_WINDOW)
        : null,
      route: {
        ...baseStatus.route,
        provider,
        model,
        profileId: profile.id,
        profileName: profile.name,
        relayProtocol: profile.protocol,
        codexPlusPlusUpstreamUrl: profile.upstreamBaseUrl,
        adapterEnabled: true,
        requestModelOverride: null,
      },
    };
  } catch {
    return baseStatus;
  }
}

function publicChildEnvironment(plan) {
  return {
    CODEX_PLUS_STATE_DIR: plan.paths.codexPlusPlusState,
    CODEX_PLUS_APP_EXECUTABLE: plan.paths.appExecutable,
    CODEX_PLUS_PROTOCOL_PROXY_PORT: String(plan.ports.proxy),
    CODEX_PLUS_LAUNCHER_GUARD_PORT: String(plan.ports.launcherGuard),
    CODEX_PLUS_MANAGER_GUARD_PORT: String(plan.ports.managerGuard),
    CODEX_HOME: plan.paths.codexHome,
    CODEX_HOME_DIR: plan.paths.codexHome,
    APPDATA: plan.paths.isolatedAppData,
    LOCALAPPDATA: plan.paths.isolatedLocalAppData,
    TEMP: plan.paths.temp,
    TMP: plan.paths.temp,
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    DEEPCODEX_STATE_ROOT: plan.paths.stateRoot,
    DEEPCODEX_CDP_PORT: String(plan.ports.cdp),
  };
}

export function buildSupervisorChildEnvironment(plan, baseEnvironment = process.env) {
  const environment = {
    ...baseEnvironment,
    CODEX_PLUS_STATE_DIR: plan.paths.codexPlusPlusState,
    CODEX_PLUS_APP_EXECUTABLE: plan.paths.appExecutable,
    CODEX_PLUS_PROTOCOL_PROXY_PORT: String(plan.ports.proxy),
    CODEX_PLUS_LAUNCHER_GUARD_PORT: String(plan.ports.launcherGuard),
    CODEX_PLUS_MANAGER_GUARD_PORT: String(plan.ports.managerGuard),
    CODEX_HOME: plan.paths.codexHome,
    CODEX_HOME_DIR: plan.paths.codexHome,
    APPDATA: plan.paths.isolatedAppData,
    LOCALAPPDATA: plan.paths.isolatedLocalAppData,
    TEMP: plan.paths.temp,
    TMP: plan.paths.temp,
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    DEEPCODEX_STATE_ROOT: plan.paths.stateRoot,
    DEEPCODEX_CDP_PORT: String(plan.ports.cdp),
    ANTICODEX_MANAGER_API: plan.managerBaseUrl,
  };
  for (const name of [
    "GLOBAL_CODEX_HOME",
    "DEEPCODEX_SHARED_CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_API_BASE",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CODEX_API_KEY",
    "UPSTREAM_PROTOCOL",
    "UPSTREAM_URL",
    "UPSTREAM_MODEL",
    "UPSTREAM_API_KEY",
  ]) delete environment[name];
  return environment;
}

export function assertProductionRoots(plan, env = process.env) {
  const expectedInstall = resolve(join(requiredEnv(env, "LOCALAPPDATA"), "Anti-Codex"));
  const expectedState = resolve(join(requiredEnv(env, "APPDATA"), "anticodex"));
  if (resolve(plan.paths.installRoot).toLowerCase() !== expectedInstall.toLowerCase()) {
    throw new Error(`Production install root must be ${expectedInstall}`);
  }
  if (resolve(plan.paths.stateRoot).toLowerCase() !== expectedState.toLowerCase()) {
    throw new Error(`Production state root must be ${expectedState}`);
  }
  for (const value of Object.values(plan.paths)) {
    if (typeof value !== "string") continue;
    const root = value.startsWith(plan.paths.installRoot) ? plan.paths.installRoot : plan.paths.stateRoot;
    if (!isPathInsideRoot(value, root)) throw new Error(`Product path escaped its root: ${value}`);
  }
}

function validateInstalledComponent(paths) {
  const componentRoot = join(paths.installRoot, "components", "codexplusplus");
  const manifestPath = join(componentRoot, "component-manifest.json");
  const metadataPath = join(componentRoot, "upstream.json");
  if (!existsSync(manifestPath)) throw new Error(`CodexPlusPlus component manifest is missing: ${manifestPath}`);
  if (!existsSync(metadataPath)) throw new Error(`CodexPlusPlus upstream metadata is missing: ${metadataPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (manifest.schema !== COMPONENT_SCHEMA) throw new Error(`CodexPlusPlus component schema must be ${COMPONENT_SCHEMA}`);
  if (manifest.component !== "CodexPlusPlus" || manifest.license !== "AGPL-3.0-only") {
    throw new Error("CodexPlusPlus component identity or license metadata is invalid.");
  }
  if (!existsSync(paths.codexPlusPlusBinary)) throw new Error(`CodexPlusPlus binary is missing: ${paths.codexPlusPlusBinary}`);
  const expectedHash = String(manifest.binary?.sha256 ?? "").toLowerCase();
  const actualHash = sha256(readFileSync(paths.codexPlusPlusBinary));
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
    throw new Error("CodexPlusPlus component binary hash mismatch.");
  }
  const installedPatches = manifest.patches;
  const acceptedPatches = metadata.patches;
  if (!Array.isArray(installedPatches) || !Array.isArray(acceptedPatches)
      || acceptedPatches.length === 0 || installedPatches.length !== acceptedPatches.length) {
    throw new Error("CodexPlusPlus component patch set does not match the installed upstream metadata.");
  }
  for (let index = 0; index < acceptedPatches.length; index += 1) {
    const installedPatch = installedPatches[index];
    const acceptedPatch = acceptedPatches[index];
    if (String(installedPatch?.file ?? "") !== String(acceptedPatch?.file ?? "")
        || String(installedPatch?.sha256 ?? "").toLowerCase()
          !== String(acceptedPatch?.sha256 ?? "").toLowerCase()) {
      throw new Error("CodexPlusPlus component patch set does not match the installed upstream metadata.");
    }
  }
  if (String(manifest.patchCommit ?? "") !== String(metadata.patchCommit ?? "")) {
    throw new Error("CodexPlusPlus component patch commit does not match the installed upstream metadata.");
  }
  if (!existsSync(paths.appExecutable) || !existsSync(paths.codexCli)) {
    throw new Error("The copied Anti-Codex client or bundled Codex CLI is missing.");
  }
  return manifest;
}

function ensureProductDirectories(paths) {
  for (const path of [
    paths.stateRoot,
    paths.codexPlusPlusState,
    paths.codexHome,
    paths.electronUserData,
    paths.isolatedAppData,
    paths.isolatedLocalAppData,
    paths.temp,
    paths.logs,
  ]) mkdirSync(path, { recursive: true });
}

function readBundledCatalog(codexCli) {
  return JSON.parse(execFileSync(codexCli, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  }));
}

export function readCompatibilityModelAliases(catalogPaths) {
  const aliases = [];
  const seen = new Set();
  for (const catalogPath of Array.isArray(catalogPaths) ? catalogPaths : []) {
    if (!catalogPath || !existsSync(catalogPath)) continue;
    try {
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      for (const entry of Array.isArray(catalog?.models) ? catalog.models : []) {
        const modelId = String(entry?.slug ?? "").trim();
        if (!modelId || seen.has(modelId)) continue;
        seen.add(modelId);
        aliases.push(modelId);
      }
    } catch {
      // Compatibility state must never prevent the current provider from starting.
    }
  }
  return aliases;
}

export function buildThirdPartyModelCatalog(
  bundled,
  model,
  modelContextWindow = DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
  compatibilityModelAliases = [],
) {
  const modelId = String(model ?? "").trim();
  if (!modelId) throw new Error("Third-party model is required for the compatibility catalog.");
  const safeContextWindow = contextWindow(modelContextWindow, DEFAULT_THIRD_PARTY_CONTEXT_WINDOW);
  const template = selectNativeToolCatalogTemplate(bundled);
  if (!template) throw new Error("The copied Codex CLI returned no bundled model template.");
  const modelIds = [];
  const seen = new Set();
  for (const candidate of [modelId, ...(Array.isArray(compatibilityModelAliases) ? compatibilityModelAliases : [])]) {
    const candidateId = String(candidate ?? "").trim();
    if (!candidateId || seen.has(candidateId)) continue;
    seen.add(candidateId);
    modelIds.push(candidateId);
  }
  return {
    ...bundled,
    models: modelIds.map((candidateId, index) => ({
      ...template,
      slug: candidateId,
      display_name: candidateId,
      description: index === 0
        ? `Third-party API model ${modelId}`
        : `Historical model compatibility alias routed to ${modelId}`,
      priority: index === 0 ? 0 : 1_000 + index,
      visibility: index === 0 ? "list" : "hide",
      supported_in_api: true,
      upgrade: null,
      availability_nux: null,
      context_window: safeContextWindow,
      max_context_window: safeContextWindow,
      effective_context_window_percent: 90,
    })),
  };
}

export function buildUnifiedModelCatalog(bundled, options = {}) {
  const template = selectNativeToolCatalogTemplate(bundled);
  if (!template) throw new Error("The copied Codex CLI returned no bundled model template.");
  const antigravityCatalog = options.antigravityCatalog ?? { models: [] };
  const antigravityModels = Array.isArray(antigravityCatalog.models)
    ? antigravityCatalog.models
    : [];
  const thirdPartyContextWindow = contextWindow(
    options.thirdPartyContextWindow ?? DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
    DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
  );
  const thirdPartyModels = [];
  const thirdPartySeen = new Set();
  for (const value of [
    options.thirdPartyModel,
    ...(Array.isArray(options.thirdPartyModels) ? options.thirdPartyModels : []),
  ]) {
    const model = String(value ?? "").trim();
    if (!model || thirdPartySeen.has(model)) continue;
    thirdPartySeen.add(model);
    thirdPartyModels.push(model);
  }

  const visibleModels = [];
  const seenSlugs = new Set();
  const add = (entry) => {
    const slug = String(entry?.slug ?? "").trim();
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    visibleModels.push({
      ...entry,
      slug,
      visibility: "list",
      supported_in_api: true,
      upgrade: null,
      availability_nux: null,
      priority: visibleModels.length,
    });
  };
  for (const entry of antigravityModels) add(entry);
  for (const model of thirdPartyModels) {
    add({
      ...template,
      slug: thirdPartyNativeModel(model),
      display_name: `第三方 · ${model}`,
      description: `第三方 API 模型 ${model}`,
      context_window: thirdPartyContextWindow,
      max_context_window: thirdPartyContextWindow,
      effective_context_window_percent: 90,
    });
  }
  add({
    ...template,
    slug: ANTIGRAVITY_MODEL_SLOT,
    display_name: "Antigravity（当前模型）",
    description: "使用管理页当前保存的 Antigravity 模型",
  });
  add({
    ...template,
    slug: THIRD_PARTY_MODEL_SLOT,
    display_name: "第三方 API（当前模型）",
    description: "使用管理页当前保存的第三方 API 模型",
    context_window: thirdPartyContextWindow,
    max_context_window: thirdPartyContextWindow,
    effective_context_window_percent: 90,
  });
  return { ...bundled, models: visibleModels };
}

function readCatalogSafely(catalogPath) {
  if (!catalogPath || !existsSync(catalogPath)) return null;
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    return Array.isArray(catalog?.models) ? catalog : null;
  } catch {
    return null;
  }
}

function buildRuntimeCatalogFromBundled(bundled, availableModels) {
  const template = selectNativeToolCatalogTemplate(bundled);
  if (!template) throw new Error("The copied Codex CLI returned no bundled model template.");
  return buildAntigravityModelCatalog(
    { ...bundled, models: [template] },
    availableModels.map((entry) => ({
      id: entry.id,
      model: entry.internalModel,
      displayName: entry.displayName,
      description: entry.description,
      maxTokens: entry.maxTokens,
      supportsImages: entry.supportsImages,
      supportsThinking: entry.supportsThinking,
      thinkingBudget: entry.thinkingBudget,
      minThinkingBudget: entry.minThinkingBudget,
    })),
  );
}

function buildRuntimeCatalog(codexCli, availableModels) {
  return buildRuntimeCatalogFromBundled(readBundledCatalog(codexCli), availableModels);
}

function selectNativeToolCatalogTemplate(bundled) {
  const models = Array.isArray(bundled?.models) ? bundled.models : [];
  const template = models.find((entry) => entry?.visibility === "list"
      && entry?.supported_in_api !== false
      && entry?.shell_type === "shell_command"
      && entry?.apply_patch_tool_type === "freeform"
      && entry?.tool_mode !== "code_mode_only")
    ?? models.find((entry) => entry?.visibility === "list"
      && entry?.supported_in_api !== false
      && entry?.shell_type === "shell_command"
      && entry?.apply_patch_tool_type === "freeform")
    ?? models.find((entry) => entry?.visibility === "list" && entry?.supported_in_api !== false)
    ?? models[0];
  if (!template || template.tool_mode !== "code_mode_only") return template;
  const { tool_mode: _codeModeOnly, ...unrestrictedTemplate } = template;
  return unrestrictedTemplate;
}

function startManagerSupport(plan, childEnvironment) {
  const root = resolve(import.meta.dirname, "..");
  const injector = join(root, "scripts", "deepcodex-cdp-inject.mjs");
  const managerScript = join(root, "scripts", "anticodex-manager-inject.js");
  const bridgeScript = join(root, "scripts", "anticodex-manager-bridge.mjs");
  const missing = [injector, managerScript, bridgeScript].filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(`Fixed-route Manager support is incomplete: ${missing.join(", ")}`);
  }
  const watcherLog = openSync(join(plan.paths.logs, "manager-inject.log"), "a");
  const watcherErrorLog = openSync(join(plan.paths.logs, "manager-inject.err.log"), "a");
  const bridgeLog = openSync(join(plan.paths.logs, "manager-bridge.log"), "a");
  const bridgeErrorLog = openSync(join(plan.paths.logs, "manager-bridge.err.log"), "a");
  const managerEnvironment = {
    ...childEnvironment,
    DEEPCODEX_CDP_MANAGER_WATCH: "1",
    ANTICODEX_SUPERVISOR_PID: String(process.pid),
  };
  const watcher = spawn(process.execPath, [injector, String(plan.ports.cdp), managerScript, "--watch"], {
    cwd: root,
    env: managerEnvironment,
    windowsHide: true,
    stdio: ["ignore", watcherLog, watcherErrorLog],
  });
  const bridge = spawn(process.execPath, [
    bridgeScript,
    "--port", String(plan.ports.cdp),
    "--base-url", plan.managerBaseUrl,
  ], {
    cwd: root,
    env: managerEnvironment,
    windowsHide: true,
    stdio: ["ignore", bridgeLog, bridgeErrorLog],
  });
  watcher.once("close", () => { closeSync(watcherLog); closeSync(watcherErrorLog); });
  bridge.once("close", () => { closeSync(bridgeLog); closeSync(bridgeErrorLog); });
  return { watcher, bridge };
}

export function parseTasklistAntiCodexProcesses(output) {
  const rows = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = line.match(/^"Anti-Codex\.exe","(\d+)"(?:,|$)/i);
    if (!match) continue;
    const processId = Number(match[1]);
    if (Number.isInteger(processId) && processId > 0) rows.push({ processId });
  }
  return rows;
}

export function scanCopiedClientProcessesSafely(scan = getCopiedClientProcesses) {
  try {
    return { ok: true, processes: scan(), error: null };
  } catch (error) {
    return {
      ok: false,
      processes: [],
      error: String(error?.message ?? error),
    };
  }
}

function getCopiedClientProcesses() {
  if (process.platform !== "win32") return [];
  const output = execFileSync("tasklist.exe", [
    "/FI", "IMAGENAME eq Anti-Codex.exe",
    "/FO", "CSV",
    "/NH",
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  return parseTasklistAntiCodexProcesses(output);
}

function assertNoExistingClient() {
  const scan = scanCopiedClientProcessesSafely();
  if (scan.ok) assertNoExistingClientProcesses(scan.processes);
  return scan;
}

export function liveOwnedClientPids(processIds = [], isAlive = ownerProcessIsAlive) {
  return [...new Set([...processIds].map(Number))]
    .filter((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid));
}

export async function observeCopiedClientSession(ownedClients, options = {}) {
  if (!(ownedClients instanceof Set)) throw new TypeError("ownedClients must be a Set.");
  const isAlive = options.isAlive ?? ownerProcessIsAlive;
  const isCdpReady = options.isCdpReady ?? (() => Promise.resolve(false));

  const liveOwned = liveOwnedClientPids(ownedClients, isAlive);
  const ownershipChanged = liveOwned.length !== ownedClients.size;
  for (const pid of [...ownedClients]) {
    if (!liveOwned.includes(Number(pid))) ownedClients.delete(pid);
  }
  if (liveOwned.length > 0) {
    return { ready: true, livePids: liveOwned, ownershipChanged, source: "owned" };
  }

  const cdpReady = await isCdpReady();
  return {
    ready: cdpReady === true,
    livePids: [],
    ownershipChanged,
    source: cdpReady === true ? "cdp" : "missing",
  };
}

export function updateClientExitGrace(missingSince, clientReady, now = Date.now(), graceMs = CLIENT_EXIT_GRACE_MS) {
  if (clientReady) return { missingSince: null, expired: false };
  const startedAt = missingSince ?? now;
  return {
    missingSince: startedAt,
    expired: now - startedAt >= graceMs,
  };
}

export function assertNoExistingClientProcesses(existing = []) {
  if (existing.length) {
    throw new Error(`Anti-Codex is already running (PID ${existing.map((row) => row.processId).join(", ")}). Refusing a second visible launch.`);
  }
  return true;
}

export async function startHealthServer(healthPort, status, options = {}) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "POST" && path === "/anticodex/fixed-route/shutdown") {
      const expected = String(options.shutdownToken ?? "");
      const authorization = String(request.headers.authorization ?? "");
      if (!expected || authorization !== `Bearer ${expected}`) {
        sendJson(response, 403, { ok: false, error: "forbidden" });
        return;
      }
      sendJson(response, 202, { ok: true, state: "stopping" });
      setImmediate(() => {
        Promise.resolve(options.onShutdown?.("control_shutdown")).catch(() => {});
      });
      return;
    }
    if (request.method !== "GET" || !["/health", "/anticodex/fixed-route/health"].includes(path)) {
      sendJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    const body = status();
    sendJson(response, body.state === "ready" ? 200 : 503, body);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(healthPort, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : healthPort;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

class CdpProbeSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  async open(timeoutMs = 1_500) {
    if (this.url.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1"].includes(this.url.hostname)) {
      throw new Error("CDP renderer probe must use a loopback WebSocket.");
    }
    const key = randomBytes(16).toString("base64");
    this.socket = connect({ host: this.url.hostname, port: Number(this.url.port) });
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening the CDP renderer probe.")), timeoutMs);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.socket.once("error", fail);
      this.socket.once("connect", () => {
        this.socket.write([
          `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
          `Host: ${this.url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      const onHandshake = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const split = this.buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = this.buffer.slice(0, split).toString("utf8");
        this.buffer = this.buffer.slice(split + 4);
        this.socket.off("data", onHandshake);
        this.socket.off("error", fail);
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          reject(new Error(`CDP WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
          return;
        }
        this.socket.on("data", (data) => this.onData(data));
        this.parseFrames();
        resolveOpen();
      };
      this.socket.on("data", onHandshake);
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        if (high > 0x1fffff) throw new Error("CDP renderer response is too large.");
        length = high * 0x100000000 + low;
        offset += 8;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      let payload = this.buffer.slice(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = this.buffer.slice(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + maskLength + length);
      if ((first & 0x0f) !== 0x1) continue;
      const message = JSON.parse(payload.toString("utf8"));
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message);
    }
  }

  call(id, method, params, timeoutMs = 1_500) {
    const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
    const mask = randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      this.socket.write(Buffer.concat([header, mask, masked]));
    });
  }

  close() {
    this.socket?.destroy();
  }
}

async function cdpRendererReady(webSocketDebuggerUrl) {
  const socket = new CdpProbeSocket(webSocketDebuggerUrl);
  try {
    await socket.open();
    const result = await socket.call(1, "Runtime.evaluate", {
      expression: `(() => {
        if (document.readyState === "loading" || !document.body) return false;
        const text = String(document.body.innerText || document.body.textContent || "").trim();
        const interactive = document.body.querySelector('textarea, [contenteditable="true"], button, a, [role="button"], [role="link"]');
        return text.length >= 8 && Boolean(interactive);
      })()`,
      returnByValue: true,
    });
    return result?.result?.result?.value === true;
  } catch {
    return false;
  } finally {
    socket.close();
  }
}

export async function cdpPageReady(cdpPort, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rendererProbe = options.rendererProbe ?? cdpRendererReady;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const targets = await response.json();
    const pages = targets.filter((target) => target?.type === "page" && target?.webSocketDebuggerUrl);
    for (const page of pages) {
      if (await rendererProbe(page.webSocketDebuggerUrl)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function proxyModelCatalogReady(proxyPort, localProxyKey, model, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${proxyPort}/models`, {
      headers: { authorization: `Bearer ${localProxyKey}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Array.isArray(body?.data) && body.data.some((entry) => String(entry?.id ?? "") === String(model));
  } catch {
    return false;
  }
}

function tcpReady(targetPort) {
  return new Promise((resolveReady) => {
    const socket = connect({ host: "127.0.0.1", port: targetPort });
    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveReady(ready);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitFor(check, options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs ?? 60_000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
      break;
    }
    await sleep(Math.max(50, Number(options.intervalMs ?? 250)));
  }
  throw new Error(`Timed out waiting for ${options.description ?? "condition"}.${lastError ? ` ${lastError.message}` : ""}`);
}

function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  stopProcessTree(child.pid);
}

function stopProcessTree(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
      stdio: "ignore",
    });
    if (result.status !== 0) {
      try { process.kill(Number(pid), "SIGKILL"); } catch {}
    }
  } else {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }
}

export async function waitForOwnedProcessExit(processIds = [], options = {}) {
  const isAlive = options.isAlive ?? ownerProcessIsAlive;
  const sleepFn = options.sleep ?? sleep;
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? OWNED_PROCESS_STOP_WAIT_MS));
  const intervalMs = Math.max(10, Number(options.intervalMs ?? 100));
  const pids = [...new Set(processIds.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const deadline = Date.now() + timeoutMs;
  let survivors = pids.filter((pid) => isAlive(pid));
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleepFn(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    survivors = pids.filter((pid) => isAlive(pid));
  }
  return survivors;
}

function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  writeFileSync(pending, String(text), { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(pending, path);
  } catch (error) {
    if (!existsSync(path)) throw error;
    rmSync(path, { force: true });
    renameSync(pending, path);
  }
}

function writeStatus(path, status) {
  writeTextAtomic(path, `${JSON.stringify(status, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function port(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${name} must be a valid TCP port`);
  return number;
}

function contextWindow(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 16_000 || parsed > 4_000_000) {
    throw new Error("context-window must be an integer between 16000 and 4000000");
  }
  return parsed;
}

function ensureUniquePorts(ports) {
  const values = Object.values(ports);
  if (new Set(values).size !== values.length) throw new Error("Fixed-route ports must be unique.");
}

function normalizeLoopbackUrl(value) {
  const url = new URL(String(value));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Manager base URL must be HTTP(S).");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("Manager base URL must be loopback.");
  return url.href.replace(/\/$/, "");
}

function requiredEnv(env, name) {
  const value = optionalText(env[name]);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function truthy(value) {
  return value === true || /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main() {
  const plan = buildFixedRoutePlan();
  if (plan.args.planJson) {
    process.stdout.write(`${JSON.stringify(sanitizeFixedRoutePlan(plan))}\n`);
    return;
  }
  await runSupervisor(plan);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
