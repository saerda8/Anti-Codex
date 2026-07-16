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
  buildCodexPlusPlusSettings,
  generateRouteConfig,
  getLauncherArgs,
  isPathInsideRoot,
  mergeCodexRouteConfig,
  resolveProductPaths,
} from "./lib/anticodex-fixed-route.mjs";

const COMPONENT_SCHEMA = "codexplusplus-component-manifest-v1";
const STATUS_SCHEMA = "anticodex-fixed-route-status-v1";
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
  const model = optionalText(args.model ?? env.ANTICODEX_MODEL ?? env.UPSTREAM_MODEL);
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

  const catalogPath = provider === "antigravity"
    ? join(paths.codexHome, "antigravity-model-catalog.json")
    : provider === "third-party"
      ? join(paths.codexHome, "third-party-model-catalog.json")
      : undefined;
  const route = generateRouteConfig({
    provider,
    model,
    proxyPort: ports.proxy,
    adapterPort: ports.adapter,
    catalogPath,
    localProxyKey: randomBytes(24).toString("hex"),
    thirdPartyConfig: provider === "third-party" ? {
      protocol: env.UPSTREAM_PROTOCOL ?? "chat",
      baseUrl: env.UPSTREAM_URL,
      model: model ?? env.UPSTREAM_MODEL,
      apiKey: env.UPSTREAM_API_KEY,
    } : undefined,
  });
  const launcherArgs = getLauncherArgs({
    launchDesktop: true,
    appPath: paths.appDir,
    debugPort: ports.cdp,
    helperPort: ports.helper,
  });
  const settings = buildCodexPlusPlusSettings({
    route,
    userDataDir: paths.electronUserData,
    disableGpu: truthy(args.disableGpu ?? env.ANTICODEX_DISABLE_GPU),
  });
  const managerBaseUrl = normalizeLoopbackUrl(
    args.managerBaseUrl ?? env.ANTICODEX_MANAGER_API ?? "http://127.0.0.1:8484",
  );

  return {
    args,
    paths,
    provider,
    model: route.model,
    ports,
    route,
    launcherArgs,
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
    route: publicRoute(plan.route),
    launcherArgs: plan.launcherArgs,
    childEnvironment: publicChildEnvironment(plan),
    lifecycle: {
      launchesVisibleClientOnce: true,
      automaticallyRelaunchesClient: false,
      ownsTaskControl: false,
      cleansOnlyOwnedChildren: true,
    },
  };
}

async function runSupervisor(plan) {
  assertProductionRoots(plan);
  assertNoExistingClient(plan.paths.appDir);
  const component = validateInstalledComponent(plan.paths);
  ensureProductDirectories(plan.paths);

  let status = {
    ok: false,
    schema: STATUS_SCHEMA,
    state: "starting",
    pid: process.pid,
    provider: plan.provider,
    model: plan.model,
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
  };
  const health = await startHealthServer(plan.ports.health, () => status);
  writeStatus(plan.paths.statusFile, status);

  let provider = null;
  let launcher = null;
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
    stopOwnedProcess(managerWatcher);
    stopOwnedProcess(managerBridge);
    stopOwnedProcess(launcher);
    if (options.stopClient === true) {
      for (const pid of ownedClients) stopProcessTree(pid);
    }
    await provider?.close?.().catch(() => {});
    await managerService?.close?.().catch(() => {});
    if (launcherLog !== null) closeSync(launcherLog);
    if (launcherErrorLog !== null) closeSync(launcherErrorLog);
    status = {
      ...status,
      ok: reason === "client_exited",
      state: reason === "client_exited" ? "stopped" : "error",
      stoppedAt: new Date().toISOString(),
      stopReason: reason,
    };
    writeStatus(plan.paths.statusFile, status);
    await health.close().catch(() => {});
  };

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

    let catalog = null;
    if (plan.provider === "antigravity") {
      const client = createAntigravityCascadeClient();
      const readiness = await client.getReadiness();
      if (readiness?.signedIn !== true) throw new Error("Antigravity Desktop is not signed in.");
      const availableModels = await client.listModels();
      catalog = buildRuntimeCatalog(plan.paths.codexCli, availableModels);
      if (!catalog.models.some((entry) => entry.slug === plan.model)) {
        throw new Error(`Antigravity model is unavailable: ${plan.model}`);
      }
      writeTextAtomic(join(plan.paths.codexHome, "antigravity-model-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
      provider = await startAntigravityChatProvider({
        client,
        host: "127.0.0.1",
        port: plan.ports.adapter,
      });
    } else if (plan.provider === "third-party") {
      catalog = buildThirdPartyModelCatalog(readBundledCatalog(plan.paths.codexCli), plan.model);
      writeTextAtomic(
        join(plan.paths.codexHome, "third-party-model-catalog.json"),
        `${JSON.stringify(catalog, null, 2)}\n`,
      );
    }

    const configPath = join(plan.paths.codexHome, "config.toml");
    const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const mergedConfig = mergeCodexRouteConfig(existingConfig, plan.route);
    const settings = buildCodexPlusPlusSettings({
      route: { ...plan.route, config: mergedConfig },
      userDataDir: plan.paths.electronUserData,
      disableGpu: truthy(plan.args.disableGpu ?? process.env.ANTICODEX_DISABLE_GPU),
    });
    writeTextAtomic(configPath, mergedConfig);
    writeTextAtomic(join(plan.paths.codexHome, "auth.json"), plan.route.authContents);
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

    const ready = await waitFor(async () => {
      let clients;
      try {
        clients = getCopiedClientProcesses(plan.paths.appDir);
      } catch {
        return null;
      }
      if (launcher.exitCode !== null) {
        if (!clients.length) throw new Error(`CodexPlusPlus exited before launch: ${launcher.exitCode}`);
      }
      for (const row of clients) ownedClients.add(row.processId);
      if (!clients.length) return null;
      const [proxyReady, cdpReady, selectedModelReady] = await Promise.all([
        tcpReady(plan.ports.proxy),
        cdpPageReady(plan.ports.cdp),
        plan.provider === "antigravity"
          ? proxyModelCatalogReady(plan.ports.proxy, plan.route.localProxyKey, plan.model)
          : Promise.resolve(true),
      ]);
      return proxyReady && cdpReady && selectedModelReady ? clients : null;
    }, { timeoutMs: 90_000, intervalMs: 1_000, description: "fixed-route Anti-Codex" });

    const management = startManagerSupport(plan, childEnvironment);
    managerWatcher = management.watcher;
    managerBridge = management.bridge;
    status = {
      ...status,
      ok: true,
      state: "ready",
      readyAt: new Date().toISOString(),
      antigravityReady: plan.provider === "antigravity",
      catalogModelCount: catalog?.models?.length ?? null,
      processes: {
        managerService: process.pid,
        codexPlusPlus: launcher.pid,
        copiedClient: ready.map((row) => row.processId),
        managerWatcher: managerWatcher?.pid ?? null,
        managerBridge: managerBridge?.pid ?? null,
      },
    };
    writeStatus(plan.paths.statusFile, status);

    while (!closing) {
      const liveClients = liveOwnedClientPids(ownedClients);
      if (!liveClients.length) {
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
    ["--proxy-port", "proxyPort"],
    ["--adapter-port", "adapterPort"],
    ["--cdp-port", "cdpPort"],
    ["--health-port", "healthPort"],
    ["--helper-port", "helperPort"],
    ["--launcher-guard-port", "launcherGuardPort"],
    ["--manager-guard-port", "managerGuardPort"],
    ["--manager-base-url", "managerBaseUrl"],
  ]);
  const result = { planJson: false, disableGpu: false };
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
  };
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
  const manifestPath = join(paths.installRoot, "components", "codexplusplus", "component-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`CodexPlusPlus component manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
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
  if (!Array.isArray(manifest.patches) || manifest.patches.length !== 2) {
    throw new Error("CodexPlusPlus component must contain the two accepted patches.");
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

export function buildThirdPartyModelCatalog(bundled, model) {
  const modelId = String(model ?? "").trim();
  if (!modelId) throw new Error("Third-party model is required for the compatibility catalog.");
  const template = bundled.models?.find((entry) => entry.slug === "gpt-5.4") ?? bundled.models?.[0];
  if (!template) throw new Error("The copied Codex CLI returned no bundled model template.");
  return {
    ...bundled,
    models: [{
      ...template,
      slug: modelId,
      display_name: modelId,
      description: `Third-party API model ${modelId}`,
      priority: 0,
      visibility: "list",
      supported_in_api: true,
    }],
  };
}

function buildRuntimeCatalog(codexCli, availableModels) {
  const bundled = readBundledCatalog(codexCli);
  const template = bundled.models?.find((entry) => entry.slug === "gpt-5.4") ?? bundled.models?.[0];
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

function getCopiedClientProcesses(appDir) {
  if (process.platform !== "win32") return [];
  const escapedRoot = resolve(appDir).replaceAll("'", "''");
  const script = [
    `$root = '${escapedRoot}'`,
    "$rows = Get-CimInstance Win32_Process -Filter \"Name='Anti-Codex.exe'\" -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $path = [string]$_.ExecutablePath",
    "  $line = [string]$_.CommandLine",
    "  if ($path -and $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and $line -notmatch '(?i)(^|\\s)--type=') {",
    "    [pscustomobject]@{ processId = [int]$_.ProcessId; parentProcessId = [int]$_.ParentProcessId; executablePath = $path; commandLine = $line }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Compress",
  ].join("\n");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 12_000,
  });
  const parsed = JSON.parse(output.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertNoExistingClient(appDir) {
  const existing = getCopiedClientProcesses(appDir);
  return assertNoExistingClientProcesses(existing);
}

export function liveOwnedClientPids(processIds = [], isAlive = ownerProcessIsAlive) {
  return [...new Set([...processIds].map(Number))]
    .filter((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid));
}

export function assertNoExistingClientProcesses(existing = []) {
  if (existing.length) {
    throw new Error(`Anti-Codex is already running (PID ${existing.map((row) => row.processId).join(", ")}). Refusing a second visible launch.`);
  }
  return true;
}

async function startHealthServer(healthPort, status) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
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
  return {
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

async function cdpPageReady(cdpPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const targets = await response.json();
    return targets.some((target) => target?.type === "page" && target?.webSocketDebuggerUrl);
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
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
      stdio: "ignore",
    });
  } else {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }
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
