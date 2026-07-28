#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
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
const CLIENT_RECOVERY_BACKOFF_MS = 1_000;
const OWNED_PROCESS_STOP_WAIT_MS = 5_000;
const FATAL_CLIENT_HEADING_PATTERN = /^(?:ChatGPT\s*)?(?:已意外停止|unexpectedly\s+(?:stopped|quit|closed)|has\s+unexpectedly\s+(?:stopped|crashed)|(?:quit|stopped|closed)\s+unexpectedly)[.!。！]?$/i;
const FATAL_CLIENT_RECOVERY_BUTTON_PATTERN = /(?:重试|重新加载|重新启动|重启|再试一次|retry|reload|restart)/i;
const FATAL_CLIENT_MAX_TEXT_LENGTH = 1_600;
const WINDOWS_EXACT_PROCESS_TERMINATOR = String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace AntiCodex.Native
{
    public static class ExactProcessTermination
    {
        private const uint ProcessTerminate = 0x0001;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x00100000;
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitTimeout = 0x00000102;

        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime
        {
            public uint Low;
            public uint High;
            public long ToInt64()
            {
                return ((long)High << 32) | Low;
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr value);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(
            IntPtr process,
            out FileTime creation,
            out FileTime exit,
            out FileTime kernel,
            out FileTime user);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(
            IntPtr process,
            uint flags,
            StringBuilder executablePath,
            ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr value, uint milliseconds);

        public static int TerminateExact(
            int expectedProcessId,
            long expectedCreationFileTimeUtcTicks,
            string expectedExecutablePath,
            int timeoutMilliseconds)
        {
            IntPtr process = OpenProcess(
                ProcessTerminate | ProcessQueryLimitedInformation | Synchronize,
                false,
                expectedProcessId);
            if (process == IntPtr.Zero)
            {
                int openError = Marshal.GetLastWin32Error();
                if (openError == 87 || openError == 1168) return 3;
                throw new Win32Exception(openError, "Could not open the exact process.");
            }
            try
            {
                FileTime creation;
                FileTime exit;
                FileTime kernel;
                FileTime user;
                if (GetProcessId(process) != (uint)expectedProcessId)
                    return 42;
                if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query creation time through the bound handle.");
                StringBuilder executablePath = new StringBuilder(32768);
                int size = executablePath.Capacity;
                if (!QueryFullProcessImageName(process, 0, executablePath, ref size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query the executable through the bound handle.");
                if (creation.ToInt64() != expectedCreationFileTimeUtcTicks
                    || !String.Equals(executablePath.ToString(), expectedExecutablePath, StringComparison.OrdinalIgnoreCase))
                    return 42;
                if (WaitForSingleObject(process, 0) == WaitObject0)
                    return 3;
                if (!TerminateProcess(process, 1))
                {
                    if (WaitForSingleObject(process, 0) == WaitObject0)
                        return 3;
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not terminate the bound process.");
                }
                uint waitResult = WaitForSingleObject(process, checked((uint)timeoutMilliseconds));
                if (waitResult == WaitObject0)
                    return 0;
                if (waitResult == WaitTimeout)
                    throw new TimeoutException("The bound process did not exit before the timeout.");
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not wait on the bound process.");
            }
            finally
            {
                CloseHandle(process);
            }
        }
    }
}
'@
Add-Type -TypeDefinition $source
$result = [AntiCodex.Native.ExactProcessTermination]::TerminateExact(
    [int]$env:ANTICODEX_TERMINATE_PID,
    [long]$env:ANTICODEX_TERMINATE_CREATION_FILETIME,
    [string]$env:ANTICODEX_TERMINATE_EXECUTABLE,
    3000)
[Console]::Out.Write([string]$result)
`;
const WINDOWS_PROCESS_TABLE_SCANNER = String.raw`
$ErrorActionPreference = "Stop"
$assembly = [System.Diagnostics.Process].Assembly
$native = $assembly.GetType("Microsoft.Win32.NativeMethods")
$infoType = $assembly.GetType("Microsoft.Win32.NativeMethods+NtProcessBasicInfo")
$queryMethod = $native.GetMethod(
    "NtQueryInformationProcess",
    [Reflection.BindingFlags]"Public,NonPublic,Static")
$timesMethod = $native.GetMethod(
    "GetProcessTimes",
    [Reflection.BindingFlags]"Public,NonPublic,Static")
$parentField = $infoType.GetField(
    "InheritedFromUniqueProcessId",
    [Reflection.BindingFlags]"Public,Instance")
if (!$queryMethod -or !$timesMethod -or !$parentField) {
    throw "Native process inspection is unavailable."
}

$ownerProcessId = [int]$env:ANTICODEX_SCAN_OWNER_PID
$seedProcessIds = @()
if (![string]::IsNullOrWhiteSpace($env:ANTICODEX_SCAN_SEED_PIDS)) {
    $seedProcessIds = @(
        $env:ANTICODEX_SCAN_SEED_PIDS -split "," |
            ForEach-Object { [int]$_ } |
            Where-Object { $_ -gt 0 })
}
$queue = New-Object "System.Collections.Generic.Queue[int]"
$seen = New-Object "System.Collections.Generic.HashSet[int]"
$rows = New-Object "System.Collections.Generic.List[object]"
@(
    Get-Process -Name "Anti-Codex" -ErrorAction SilentlyContinue |
        ForEach-Object { [int]$_.Id }
    $seedProcessIds
) | ForEach-Object {
    if ([int]$_ -gt 0) {
        $queue.Enqueue([int]$_)
    }
}

while ($queue.Count -gt 0) {
    $currentId = [int]$queue.Dequeue()
    if (!$seen.Add($currentId)) {
        continue
    }
    $current = Get-Process -Id $currentId -ErrorAction SilentlyContinue
    if (!$current) {
        continue
    }
    try {
        $info = [Activator]::CreateInstance($infoType)
        $returnLength = [int[]]::new(1)
        $queryArguments = [object[]]::new(5)
        $queryArguments[0] = $current.SafeHandle
        $queryArguments[1] = [int]0
        $queryArguments[2] = $info
        $queryArguments[3] = [int][Runtime.InteropServices.Marshal]::SizeOf($info)
        $queryArguments[4] = $returnLength
        if ([int]$queryMethod.Invoke($null, $queryArguments) -ne 0) {
            throw "NtQueryInformationProcess failed for PID $currentId."
        }
        $parentProcessId = [int]$parentField.GetValue($info).ToInt64()

        $timeArguments = [object[]]@(
            $current.SafeHandle,
            [long]0,
            [long]0,
            [long]0,
            [long]0)
        if (![bool]$timesMethod.Invoke($null, $timeArguments)) {
            throw "GetProcessTimes failed for PID $currentId."
        }
        $creationFileTime = [long]$timeArguments[1]
        if ($creationFileTime -le 0) {
            throw "Invalid native creation time for PID $currentId."
        }
        $createdAtMs = ([DateTimeOffset](
            [DateTime]::FromFileTimeUtc($creationFileTime))).ToUnixTimeMilliseconds()
        [void]$rows.Add([pscustomobject]@{
            processId = $currentId
            parentProcessId = $parentProcessId
            executablePath = [string]$current.Path
            createdAtMs = [long]$createdAtMs
            creationFileTimeUtcTicks = [string]$creationFileTime
            name = [string]($current.ProcessName + ".exe")
        })

        if (
            $parentProcessId -gt 0 -and
            $parentProcessId -ne $ownerProcessId -and
            !$seen.Contains($parentProcessId)
        ) {
            $queue.Enqueue($parentProcessId)
        }
    } catch {
        $stillRunning = Get-Process -Id $currentId -ErrorAction SilentlyContinue
        if ($stillRunning) {
            $stillRunning.Dispose()
            throw
        }
    } finally {
        $current.Dispose()
    }
}

[Console]::Out.Write(
    [string](ConvertTo-Json -InputObject $rows.ToArray() -Compress -Depth 3))
`;
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
      automaticallyRelaunchesClient: !plan.headless,
      ordinaryMissingClientAction: plan.headless ? null : "shutdown",
      fatalRendererRecoveryLimit: plan.headless ? 0 : 1,
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
  let launcherIdentity = null;
  let copiedClientIdentity = null;
  let managerWatcherIdentity = null;
  let managerBridgeIdentity = null;
  let refreshModelsInFlight = null;
  let refreshModelsCallback = async () => {
    const error = new Error("Anti-Codex model refresh is not ready.");
    error.statusCode = 503;
    throw error;
  };
  const ownedClients = new Set();
  let clientOwnership = null;
  let clientRecoveryAttempted = false;
  let closing = false;
  let shutdownReason = "unknown";
  let launcherLog = null;
  let launcherErrorLog = null;

  const refreshOwnedClientIdentities = () => {
    const processScan = scanClientProcessTableSafely();
    if (!processScan.ok || !clientOwnership) {
      return { ...processScan, clients: [] };
    }
    const clients = selectVerifiedOwnedClientProcessRows(processScan.processes, {
      rootPid: clientOwnership.rootPid,
      rootStartedAtMs: clientOwnership.rootStartedAtMs,
      expectedExecutablePath: plan.paths.appExecutable,
      knownIdentities: clientOwnership.identities,
    });
    clientOwnership.identities = clients;
    ownedClients.clear();
    if (copiedClient && copiedClient.exitCode === null && copiedClient.signalCode === null) {
      ownedClients.add(copiedClient.pid);
    }
    for (const row of clients) ownedClients.add(row.processId);
    return { ...processScan, clients };
  };

  const stopOwnedClientSession = async () => {
    const beforeStop = refreshOwnedClientIdentities();
    const identities = [
      ...(beforeStop.ok && clientOwnership ? clientOwnership.identities : []),
      copiedClientIdentity,
    ].filter(Boolean);
    const verifiedPids = beforeStop.ok
      ? revalidatedOwnedClientPids(beforeStop.processes, identities, plan.paths.appExecutable)
      : [];
    const targets = [...new Set([copiedClient?.pid, ...verifiedPids]
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0))];

    const stopResults = [stopOwnedProcess(copiedClient, copiedClientIdentity)];
    for (const identity of identities) {
      if (
        identity.processId !== Number(copiedClient?.pid)
        && verifiedPids.includes(identity.processId)
      ) {
        stopResults.push(stopExactProcess(identity));
      }
    }
    await waitForOwnedProcessExit(targets);

    const afterStop = scanClientProcessTableSafely();
    const survivors = afterStop.ok
      ? revalidatedOwnedClientPids(afterStop.processes, identities, plan.paths.appExecutable)
      : targets.filter((pid) => ownerProcessIsAlive(pid));
    ownedClients.clear();
    for (const pid of survivors) ownedClients.add(pid);
    return {
      survivors,
      scanError: beforeStop.ok && afterStop.ok
        && stopResults.every((result) => result.stopped || result.reason === "already_exited")
        ? null
        : [
            beforeStop.error,
            afterStop.error,
            ...stopResults
              .filter((result) => !result.stopped && result.reason !== "already_exited")
              .map((result) => `${result.processId || "unknown PID"}: ${result.reason}`),
          ].filter(Boolean).join("; ") || "process termination could not be proven safe",
    };
  };

  const cleanup = async (reason, options = {}) => {
    if (closing) return;
    closing = true;
    shutdownReason = reason;
    const stoppedNormally = ["client_exited", "client_unhealthy", "control_shutdown", "signal_sigint", "signal_sigterm"].includes(reason);
    const shutdownPids = [...new Set([
      managerWatcher?.pid,
      managerBridge?.pid,
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
    stopOwnedProcess(managerWatcher, managerWatcherIdentity);
    stopOwnedProcess(managerBridge, managerBridgeIdentity);
    const clientStop = options.stopClient === true
      ? await stopOwnedClientSession()
      : { survivors: [], scanError: null };
    stopOwnedProcess(launcher, launcherIdentity);
    await managerService?.close?.().catch(() => {});
    const shutdownSurvivors = [...new Set([
      ...clientStop.survivors,
      ...await waitForOwnedProcessExit(shutdownPids),
    ])];
    if (launcherLog !== null) closeSync(launcherLog);
    if (launcherErrorLog !== null) closeSync(launcherErrorLog);
    const fullyStopped = shutdownSurvivors.length === 0 && !clientStop.scanError;
    status = {
      ...status,
      ok: stoppedNormally && fullyStopped,
      state: stoppedNormally && fullyStopped ? "stopped" : "error",
      stoppedAt: new Date().toISOString(),
      stopReason: reason,
      shutdownSurvivors,
      error: fullyStopped
        ? status.error
        : (clientStop.scanError || `Owned Anti-Codex processes did not stop: ${shutdownSurvivors.join(", ")}`),
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
      adapterAuthToken: plan.route.localProxyKey,
      refreshModels: () => refreshModelsCallback(),
    });
    await managerService.listen();
    status.processes.managerService = process.pid;
    writeStatus(plan.paths.statusFile, status);

    const bundledCatalog = readBundledCatalog(plan.paths.codexCli);
    const antigravityCatalogPath = join(plan.paths.codexHome, "antigravity-model-catalog.json");
    const unifiedCatalogPath = join(plan.paths.codexHome, "anticodex-model-catalog.json");
    const antigravityClient = createAntigravityCascadeClient();
    let antigravityReady = false;
    const previousAntigravityCatalog = readCatalogSafely(antigravityCatalogPath) ?? { ...bundledCatalog, models: [] };
    let antigravityCatalog = previousAntigravityCatalog;
    try {
      const readiness = await antigravityClient.getReadiness(
        plan.provider === "antigravity" ? { timeoutMs: 90_000 } : undefined,
      );
      antigravityReady = readiness?.signedIn === true;
      if (antigravityReady) {
        const availableModels = await antigravityClient.listModels();
        const currentAntigravityCatalog = buildRuntimeCatalogFromBundled(bundledCatalog, availableModels);
        antigravityCatalog = preserveHiddenCompatibilityModels(currentAntigravityCatalog, previousAntigravityCatalog);
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
      authToken: plan.route.localProxyKey,
    });

    const thirdPartyRoute = plan.relayRoutes.find((entry) => entry.profileId === THIRD_PARTY_RELAY_ID) ?? null;
    let catalog = buildUnifiedModelCatalog(bundledCatalog, {
      antigravityCatalog,
      thirdPartyModel: thirdPartyRoute?.model,
      thirdPartyModels: thirdPartyRoute?.model ? [thirdPartyRoute.model] : [],
      thirdPartyContextWindow: thirdPartyRoute?.modelContextWindow ?? DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
    });
    writeTextAtomic(unifiedCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    const runtimeRelayRoutesForCatalog = (runtimeCatalog) => {
      const antigravityModelIds = runtimeCatalog.models
        .map((entry) => String(entry?.slug ?? "").trim())
        .filter(Boolean);
      return plan.relayRoutes.map((entry) => {
        if (entry.profileId === ANTIGRAVITY_RELAY_ID) {
          return { ...entry, relayModelList: [ANTIGRAVITY_MODEL_SLOT, ...antigravityModelIds] };
        }
        return {
          ...entry,
          relayModelList: [THIRD_PARTY_MODEL_SLOT, thirdPartyNativeModel(entry.model)],
        };
      });
    };
    const runtimeRelayRoutes = runtimeRelayRoutesForCatalog(antigravityCatalog);
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

    refreshModelsCallback = async () => {
      if (refreshModelsInFlight) return refreshModelsInFlight;
      refreshModelsInFlight = (async () => {
        const readiness = await antigravityClient.getReadiness();
        if (readiness?.signedIn !== true) {
          const error = new Error("Antigravity Desktop is not signed in; the existing model catalog was preserved.");
          error.statusCode = 503;
          throw error;
        }
        const availableModels = await antigravityClient.listModels();
        if (!Array.isArray(availableModels) || availableModels.length === 0) {
          const error = new Error("Antigravity returned no models; the existing model catalog was preserved.");
          error.statusCode = 503;
          throw error;
        }
        const currentAntigravityCatalog = buildRuntimeCatalogFromBundled(bundledCatalog, availableModels);
        const refreshedAntigravityCatalog = preserveHiddenCompatibilityModels(
          currentAntigravityCatalog,
          antigravityCatalog,
        );
        const liveSettings = JSON.parse(readFileSync(join(plan.paths.codexPlusPlusState, "settings.json"), "utf8"));
        const thirdPartyCatalogOptions = thirdPartyCatalogOptionsFromSettings(liveSettings, thirdPartyRoute);
        const previousUnifiedCatalog = readCatalogSafely(unifiedCatalogPath) ?? catalog;
        const rebuiltCatalog = buildUnifiedModelCatalog(bundledCatalog, {
          antigravityCatalog: refreshedAntigravityCatalog,
          ...thirdPartyCatalogOptions,
        });
        const refreshedCatalog = preserveHiddenCompatibilityModels(rebuiltCatalog, previousUnifiedCatalog);
        const refreshedSettings = refreshAntigravityRelayModelList(liveSettings, refreshedAntigravityCatalog);

        writeTextAtomic(antigravityCatalogPath, `${JSON.stringify(refreshedAntigravityCatalog, null, 2)}\n`);
        writeTextAtomic(unifiedCatalogPath, `${JSON.stringify(refreshedCatalog, null, 2)}\n`);
        writeTextAtomic(join(plan.paths.codexPlusPlusState, "settings.json"), `${JSON.stringify(refreshedSettings, null, 2)}\n`);

        antigravityCatalog = refreshedAntigravityCatalog;
        catalog = refreshedCatalog;
        antigravityReady = true;
        status = {
          ...status,
          antigravityReady: true,
          catalogModelCount: refreshedCatalog.models.length,
          modelCatalogRefreshedAt: new Date().toISOString(),
        };
        writeStatus(plan.paths.statusFile, status);
        const models = refreshedAntigravityCatalog.models
          .filter((entry) => String(entry?.visibility || "").toLowerCase() !== "hide")
          .map((entry) => String(entry?.slug || "").trim())
          .filter(Boolean);
        return {
          ok: true,
          refreshed: true,
          source: "antigravity-cascade",
          modelCount: models.length,
          models,
        };
      })();
      try {
        return await refreshModelsInFlight;
      } finally {
        refreshModelsInFlight = null;
      }
    };

    const childEnvironment = buildSupervisorChildEnvironment(plan, process.env);
    const copiedClientEnvironment = buildCopiedClientEnvironment(plan, childEnvironment);
    const launcherLogPath = join(plan.paths.logs, "codexplusplus-launcher.log");
    const launcherErrorPath = join(plan.paths.logs, "codexplusplus-launcher.err.log");
    launcherLog = openSync(launcherLogPath, "a");
    launcherErrorLog = openSync(launcherErrorPath, "a");
    const launcherStartedAtMs = Date.now();
    launcher = spawn(plan.paths.codexPlusPlusBinary, plan.launcherArgs, {
      cwd: plan.paths.appDir,
      env: childEnvironment,
      windowsHide: true,
      stdio: ["ignore", launcherLog, launcherErrorLog],
    });
    launcherIdentity = await captureSpawnedProcessIdentity(launcher, {
      expectedExecutablePath: plan.paths.codexPlusPlusBinary,
      expectedParentProcessId: process.pid,
      startedAtMs: launcherStartedAtMs,
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

    const spawnCopiedClient = async () => {
      const rootStartedAtMs = Date.now();
      const child = spawn(plan.paths.appExecutable, plan.clientArgs, {
        cwd: plan.paths.appDir,
        env: copiedClientEnvironment,
        windowsHide: false,
        stdio: "ignore",
      });
      child.once("exit", (code, signal) => {
        status = recordClientExitSafely(
          status,
          {
            processId: child.pid,
            code: Number.isInteger(code) ? code : null,
            signal: signal || null,
            exitedAt: new Date().toISOString(),
          },
          (nextStatus) => writeStatus(plan.paths.statusFile, nextStatus),
        );
      });
      const rootIdentity = await captureSpawnedProcessIdentity(child, {
        expectedExecutablePath: plan.paths.appExecutable,
        expectedParentProcessId: process.pid,
        startedAtMs: rootStartedAtMs,
      });
      copiedClient = child;
      copiedClientIdentity = rootIdentity;
      clientOwnership = {
        rootPid: child.pid,
        rootStartedAtMs,
        identities: [rootIdentity],
      };
      ownedClients.clear();
      ownedClients.add(child.pid);
      status.processes.copiedClient = [child.pid];
      writeStatus(plan.paths.statusFile, status);
      return child;
    };

    const waitForCopiedClientReady = (child, description) => waitFor(async () => {
      const processScan = refreshOwnedClientIdentities();
      const clients = processScan.clients;
      if (launcher.exitCode !== null) {
        throw new Error(`CodexPlusPlus protocol proxy exited during client startup: ${launcher.exitCode}`);
      }
      if (child.exitCode !== null && processScan.ok && !clients.length) {
        throw new Error(`Anti-Codex exited before readiness: ${child.exitCode}`);
      }
      const cdpReady = await cdpPageReady(plan.ports.cdp);
      return cdpReady ? { clients, processScan } : null;
    }, { timeoutMs: 90_000, intervalMs: 1_000, description });

    const initialClient = await spawnCopiedClient();
    const ready = await waitForCopiedClientReady(initialClient, "fixed-route Anti-Codex");

    const management = startManagerSupport(plan, childEnvironment);
    managerWatcher = management.watcher;
    managerBridge = management.bridge;
    [managerWatcherIdentity, managerBridgeIdentity] = await Promise.all([
      captureSpawnedProcessIdentity(managerWatcher, {
        expectedExecutablePath: process.execPath,
        expectedParentProcessId: process.pid,
        startedAtMs: management.watcherStartedAtMs,
      }),
      captureSpawnedProcessIdentity(managerBridge, {
        expectedExecutablePath: process.execPath,
        expectedParentProcessId: process.pid,
        startedAtMs: management.bridgeStartedAtMs,
      }),
    ]);
    status = {
      ...status,
      ok: true,
      state: "ready",
      clientUiReady: true,
      readyAt: new Date().toISOString(),
      antigravityReady,
      catalogModelCount: catalog?.models?.length ?? null,
      processes: {
        managerService: process.pid,
        codexPlusPlus: launcher.pid,
        copiedClient: [...ownedClients],
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
        isCdpReady: () => cdpPageReady(plan.ports.cdp, { returnStatus: true }),
      });
      const exitGrace = updateClientExitGrace(
        clientMissingSince,
        !clientSessionRequiresShutdown(clientSession),
      );
      clientMissingSince = exitGrace.missingSince;
      if (
        !clientSession.ready
        && (status.state !== "degraded" || status.clientFailureReason !== clientSession.source)
      ) {
        status = {
          ...status,
          ok: false,
          state: "degraded",
          clientUiReady: false,
          clientFailureReason: clientSession.source,
          degradedAt: status.degradedAt || new Date().toISOString(),
        };
        writeStatus(plan.paths.statusFile, status);
      } else if (clientSession.ready && status.state === "degraded") {
        status = {
          ...status,
          ok: true,
          state: "ready",
          clientUiReady: true,
          clientFailureReason: null,
          recoveredAt: new Date().toISOString(),
        };
        writeStatus(plan.paths.statusFile, status);
      }
      if (clientSession.ownershipChanged) {
        status.processes.copiedClient = clientSession.livePids;
        writeStatus(plan.paths.statusFile, status);
      }
      if (exitGrace.expired) {
        if (clientSession.fatal) {
          status = {
            ...status,
            ok: false,
            state: "recovering",
            clientUiReady: false,
            clientFailureReason: "fatal_renderer",
            clientRecovery: {
              attempt: clientRecoveryAttempted ? 2 : 1,
              limit: 1,
              startedAt: new Date().toISOString(),
            },
          };
          writeStatus(plan.paths.statusFile, status);
          const recovery = await recoverCopiedClientOnce({
            alreadyAttempted: clientRecoveryAttempted,
            stopOwned: stopOwnedClientSession,
            assertLaunchSafe: async () => {
              const processScan = scanClientProcessTableSafely();
              if (!processScan.ok) return false;
              return recoveryLaunchIsSafe(processScan.processes, plan.paths.appExecutable);
            },
            spawnClient: async () => spawnCopiedClient(),
            waitUntilReady: (child) => waitForCopiedClientReady(child, "recovered fixed-route Anti-Codex"),
          });
          clientRecoveryAttempted = true;
          if (!recovery.ok) {
            status = {
              ...status,
              ok: false,
              state: "error",
              clientUiReady: false,
              clientFailureReason: "fatal_renderer",
              error: recovery.error || `Fatal renderer recovery failed: ${recovery.code}`,
              clientRecovery: {
                ...status.clientRecovery,
                ok: false,
                code: recovery.code,
                failedAt: new Date().toISOString(),
                survivors: recovery.survivors ?? [],
              },
            };
            writeStatus(plan.paths.statusFile, status);
            await cleanup(`client_${recovery.code}`, { stopClient: true });
            break;
          }
          clientMissingSince = null;
          status = {
            ...status,
            ok: true,
            state: "ready",
            clientUiReady: true,
            clientFailureReason: null,
            recoveredAt: new Date().toISOString(),
            processes: {
              ...status.processes,
              copiedClient: [...ownedClients],
            },
            clientRecovery: {
              ...status.clientRecovery,
              ok: true,
              code: recovery.code,
              recoveredAt: new Date().toISOString(),
            },
          };
          writeStatus(plan.paths.statusFile, status);
          continue;
        }
        await cleanup("client_unhealthy", { stopClient: true });
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
    const liveCatalog = readCatalogSafely(join(plan.paths.codexHome, "anticodex-model-catalog.json"));
    const catalogModelCount = liveCatalog?.models?.length ?? baseStatus.catalogModelCount;
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
    if (!profile || !model) return { ...baseStatus, catalogModelCount };
    return {
      ...baseStatus,
      catalogModelCount,
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
        adapterEnabled: provider === "antigravity",
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
    CODEX_SPARKLE_ENABLED: "false",
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
    CODEX_SPARKLE_ENABLED: "false",
    DEEPCODEX_STATE_ROOT: plan.paths.stateRoot,
    DEEPCODEX_CDP_PORT: String(plan.ports.cdp),
    ANTICODEX_MANAGER_API: plan.managerBaseUrl,
  };
  for (const name of [
    "GLOBAL_CODEX_HOME",
    "DEEPCODEX_SHARED_CODEX_HOME",
    "CODEX_ELECTRON_DEV_PARENT_PID",
    "CODEX_ELECTRON_DEV_WEBVIEW_PID",
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

export function buildCopiedClientEnvironment(plan, baseEnvironment = process.env) {
  const environment = buildSupervisorChildEnvironment(plan, baseEnvironment);
  for (const name of [
    "CODEX_PLUS_STATE_DIR",
    "CODEX_PLUS_APP_EXECUTABLE",
    "CODEX_PLUS_PROTOCOL_PROXY_PORT",
    "CODEX_PLUS_LAUNCHER_GUARD_PORT",
    "CODEX_PLUS_MANAGER_GUARD_PORT",
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
  const add = (entry, visibility = "list") => {
    const slug = String(entry?.slug ?? "").trim();
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    visibleModels.push({
      ...entry,
      slug,
      visibility,
      supported_in_api: true,
      upgrade: null,
      availability_nux: null,
      priority: visibleModels.length,
    });
  };
  for (const entry of antigravityModels) {
    add(entry, entry?.visibility === "hide" ? "hide" : "list");
  }
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

export function preserveHiddenCompatibilityModels(currentCatalog, previousCatalog) {
  const currentModels = Array.isArray(currentCatalog?.models) ? currentCatalog.models : [];
  const previousModels = Array.isArray(previousCatalog?.models) ? previousCatalog.models : [];
  const models = currentModels.map((entry) => ({ ...entry }));
  const seen = new Set(models.map((entry) => String(entry?.slug ?? "").trim()).filter(Boolean));
  for (const entry of previousModels) {
    const slug = String(entry?.slug ?? "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      ...entry,
      slug,
      visibility: "hide",
      supported_in_api: true,
      upgrade: null,
      availability_nux: null,
      priority: 10_000 + models.length,
    });
  }
  return { ...currentCatalog, models };
}

export function thirdPartyCatalogOptionsFromSettings(settings, fallbackRoute = null) {
  const profiles = Array.isArray(settings?.relayProfiles) ? settings.relayProfiles : [];
  const profile = profiles.find((entry) => String(entry?.id || "") === THIRD_PARTY_RELAY_ID) ?? null;
  const thirdPartyModel = String(profile?.testModel || fallbackRoute?.model || "").trim();
  return {
    thirdPartyModel,
    thirdPartyModels: thirdPartyModel ? [thirdPartyModel] : [],
    thirdPartyContextWindow: contextWindow(
      profile?.contextWindow ?? fallbackRoute?.modelContextWindow ?? DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
      DEFAULT_THIRD_PARTY_CONTEXT_WINDOW,
    ),
  };
}

export function refreshAntigravityRelayModelList(settings, antigravityCatalog) {
  const profiles = Array.isArray(settings?.relayProfiles) ? settings.relayProfiles : [];
  const modelIds = [];
  const seen = new Set();
  for (const value of [
    ANTIGRAVITY_MODEL_SLOT,
    ...(Array.isArray(antigravityCatalog?.models)
      ? antigravityCatalog.models.map((entry) => entry?.slug)
      : []),
  ]) {
    const modelId = String(value ?? "").trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  let updated = false;
  const relayProfiles = profiles.map((profile) => {
    if (String(profile?.id || "") !== ANTIGRAVITY_RELAY_ID) return { ...profile };
    updated = true;
    return { ...profile, modelList: modelIds.join("\n") };
  });
  if (!updated) {
    throw new Error("The live CodexPlusPlus Antigravity profile is unavailable; model refresh was not applied.");
  }
  return { ...settings, relayProfiles };
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
  const watcherStartedAtMs = Date.now();
  const watcher = spawn(process.execPath, [injector, String(plan.ports.cdp), managerScript, "--watch"], {
    cwd: root,
    env: managerEnvironment,
    windowsHide: true,
    stdio: ["ignore", watcherLog, watcherErrorLog],
  });
  const bridgeStartedAtMs = Date.now();
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
  return { watcher, bridge, watcherStartedAtMs, bridgeStartedAtMs };
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

function normalizedExecutablePath(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("/", "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

function normalizedProcessRow(row) {
  const processId = Number(row?.processId ?? row?.ProcessId);
  const parentProcessId = Number(row?.parentProcessId ?? row?.ParentProcessId);
  const executablePath = String(row?.executablePath ?? row?.ExecutablePath ?? "").trim();
  const name = String(row?.name ?? row?.Name ?? "").trim();
  const creationFileTimeUtcTicks = String(
    row?.creationFileTimeUtcTicks ?? row?.CreationFileTimeUtcTicks ?? "",
  ).trim();
  const createdAtValue = row?.createdAtMs ?? row?.CreatedAtMs ?? row?.creationDate ?? row?.CreationDate;
  const createdAtMs = Number.isFinite(Number(createdAtValue))
    ? Number(createdAtValue)
    : Date.parse(String(createdAtValue ?? ""));
  if (!Number.isInteger(processId) || processId <= 0) return null;
  if (!Number.isInteger(parentProcessId) || parentProcessId < 0) return null;
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
  if (creationFileTimeUtcTicks && !/^\d+$/.test(creationFileTimeUtcTicks)) return null;
  return {
    processId,
    parentProcessId,
    executablePath,
    createdAtMs,
    creationFileTimeUtcTicks,
    name,
  };
}

export function recoveryLaunchIsSafe(processRows = [], expectedExecutablePath = "") {
  const expectedPath = normalizedExecutablePath(expectedExecutablePath);
  if (!expectedPath) return false;
  for (const row of processRows) {
    const name = String(row?.name ?? row?.Name ?? "").trim().toLowerCase();
    const executablePath = normalizedExecutablePath(row?.executablePath ?? row?.ExecutablePath);
    if (
      name === "anti-codex.exe"
      || executablePath === expectedPath
      || executablePath.endsWith("\\anti-codex.exe")
    ) return false;
  }
  return true;
}

export function recordClientExitSafely(status, exit, persist) {
  const nextStatus = {
    ...status,
    lastClientExit: { ...exit },
  };
  try {
    persist(nextStatus);
    return nextStatus;
  } catch (error) {
    return {
      ...nextStatus,
      lastClientExit: {
        ...nextStatus.lastClientExit,
        statusWriteError: String(error?.message ?? error),
      },
    };
  }
}

function exactProcessIdentityMatches(row, identity, expectedExecutablePath = "") {
  const current = normalizedProcessRow(row);
  const expected = normalizedProcessRow({
    ...identity,
    parentProcessId: identity?.parentProcessId ?? row?.parentProcessId ?? row?.ParentProcessId ?? 0,
  });
  const expectedPath = normalizedExecutablePath(expectedExecutablePath || identity?.executablePath);
  return Boolean(current && expected
    && current.processId === expected.processId
    && current.parentProcessId === expected.parentProcessId
    && current.createdAtMs === expected.createdAtMs
    && (!expected.creationFileTimeUtcTicks
      || current.creationFileTimeUtcTicks === expected.creationFileTimeUtcTicks)
    && normalizedExecutablePath(current.executablePath) === expectedPath);
}

export function revalidatedOwnedClientPids(processRows = [], identities = [], expectedExecutablePath = "") {
  const rowsByPid = new Map(processRows
    .map(normalizedProcessRow)
    .filter(Boolean)
    .map((row) => [row.processId, row]));
  return [...new Set(identities
    .map((identity) => normalizedProcessRow({ ...identity, parentProcessId: identity?.parentProcessId ?? 0 }))
    .filter(Boolean)
    .filter((identity) => {
      const current = rowsByPid.get(identity.processId);
      return current && exactProcessIdentityMatches(current, identity, expectedExecutablePath);
    })
    .map((identity) => identity.processId))];
}

export function selectVerifiedOwnedClientProcessRows(processRows = [], options = {}) {
  const expectedExecutablePath = normalizedExecutablePath(options.expectedExecutablePath);
  const rootPid = Number(options.rootPid);
  const rootStartedAtMs = Number(options.rootStartedAtMs);
  const nowMs = Number(options.nowMs ?? Date.now());
  if (!expectedExecutablePath || !Number.isInteger(rootPid) || rootPid <= 0 || !Number.isFinite(rootStartedAtMs)) {
    return [];
  }

  const rows = processRows.map(normalizedProcessRow).filter(Boolean);
  const rowsByPid = new Map(rows.map((row) => [row.processId, row]));
  const knownIdentities = (Array.isArray(options.knownIdentities) ? options.knownIdentities : [])
    .map((identity) => normalizedProcessRow({
      ...identity,
      parentProcessId: identity?.parentProcessId ?? 0,
    }))
    .filter(Boolean);
  const selected = new Map();
  const root = rowsByPid.get(rootPid);
  const capturedRoot = knownIdentities.find((identity) => identity.processId === rootPid);
  if (root
    && normalizedExecutablePath(root.executablePath) === expectedExecutablePath
    && root.createdAtMs >= rootStartedAtMs - 2_000
    && root.createdAtMs <= nowMs + 2_000
    && (!capturedRoot || exactProcessIdentityMatches(root, capturedRoot, expectedExecutablePath))) {
    selected.set(root.processId, root);
  }

  for (const normalizedIdentity of knownIdentities) {
    const current = rowsByPid.get(normalizedIdentity.processId);
    if (current && exactProcessIdentityMatches(current, normalizedIdentity, expectedExecutablePath)) {
      selected.set(current.processId, current);
    }
  }

  const reachesVerifiedAncestor = (candidate) => {
    let child = candidate;
    const visited = new Set([candidate.processId]);
    for (let depth = 0; depth < 64; depth += 1) {
      const parentId = child.parentProcessId;
      if (!Number.isInteger(parentId) || parentId <= 0 || visited.has(parentId)) return false;
      const verifiedParent = selected.get(parentId);
      if (verifiedParent) return verifiedParent.createdAtMs <= child.createdAtMs;
      const parent = rowsByPid.get(parentId);
      if (!parent || parent.createdAtMs > child.createdAtMs) return false;
      visited.add(parentId);
      child = parent;
    }
    return false;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.processId)) continue;
      if (normalizedExecutablePath(row.executablePath) !== expectedExecutablePath) continue;
      if (row.createdAtMs < rootStartedAtMs - 2_000 || row.createdAtMs > nowMs + 2_000) continue;
      if (!reachesVerifiedAncestor(row)) continue;
      selected.set(row.processId, row);
      changed = true;
    }
  }

  return [...selected.values()].sort((left, right) => left.createdAtMs - right.createdAtMs || left.processId - right.processId);
}

export function scanClientProcessTableSafely(scan = getClientProcessTableRows) {
  try {
    return { ok: true, processes: scan(), error: null };
  } catch (error) {
    return { ok: false, processes: [], error: String(error?.message ?? error) };
  }
}

function getClientProcessTableRows(seedProcessIds = []) {
  if (process.platform !== "win32") return [];
  const normalizedSeeds = [...new Set(seedProcessIds
    .map(Number)
    .filter((processId) => Number.isInteger(processId) && processId > 0))];
  const output = execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_PROCESS_TABLE_SCANNER,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    env: {
      ...process.env,
      ANTICODEX_SCAN_OWNER_PID: String(process.pid),
      ANTICODEX_SCAN_SEED_PIDS: normalizedSeeds.join(","),
    },
  }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizedProcessRow).filter(Boolean);
}

export async function captureSpawnedProcessIdentity(child, options = {}) {
  const processId = Number(child?.pid);
  const expectedExecutablePath = normalizedExecutablePath(options.expectedExecutablePath);
  const expectedParentProcessId = Number(options.expectedParentProcessId ?? process.pid);
  const startedAtMs = Number(options.startedAtMs ?? Date.now());
  const scan = options.scan ?? (() => getClientProcessTableRows([processId]));
  if (!Number.isInteger(processId) || processId <= 0 || !expectedExecutablePath) {
    throw new TypeError("A spawned process PID and exact executable path are required.");
  }
  if (!Number.isInteger(expectedParentProcessId) || expectedParentProcessId <= 0) {
    throw new TypeError("A spawned process must have an exact owning parent PID.");
  }
  return waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Owned process ${processId} exited before its identity could be captured.`);
    }
    const rows = scan();
    const current = rows
      .map(normalizedProcessRow)
      .find((row) => row?.processId === processId);
    if (!current) return null;
    if (
      current.parentProcessId !== expectedParentProcessId
      || normalizedExecutablePath(current.executablePath) !== expectedExecutablePath
      || current.createdAtMs < startedAtMs - 2_000
      || current.createdAtMs > Date.now() + 2_000
      || !current.creationFileTimeUtcTicks
      || current.creationFileTimeUtcTicks === "0"
    ) {
      throw new Error(`Owned process ${processId} identity did not match its spawn.`);
    }
    return current;
  }, {
    timeoutMs: Math.max(100, Number(options.timeoutMs ?? 5_000)),
    intervalMs: Math.max(10, Number(options.intervalMs ?? 50)),
    description: `owned process ${processId} identity`,
  });
}

export async function recoverCopiedClientOnce(options = {}) {
  if (options.alreadyAttempted === true) {
    return { ok: false, attempted: false, code: "recovery_exhausted", error: "Fatal renderer recovery was already attempted." };
  }
  const stopOwned = options.stopOwned;
  const assertLaunchSafe = options.assertLaunchSafe;
  const spawnClient = options.spawnClient;
  const waitUntilReady = options.waitUntilReady;
  if (![stopOwned, assertLaunchSafe, spawnClient, waitUntilReady].every((value) => typeof value === "function")) {
    throw new TypeError("Fatal renderer recovery requires stopOwned, assertLaunchSafe, spawnClient, and waitUntilReady callbacks.");
  }
  let child = null;
  try {
    const stopped = await stopOwned();
    const survivors = Array.isArray(stopped?.survivors) ? stopped.survivors : [];
    if (survivors.length > 0) {
      return { ok: false, attempted: true, code: "owned_processes_survived", survivors };
    }
    const sleepFn = typeof options.sleep === "function" ? options.sleep : sleep;
    await sleepFn(Math.max(0, Number(options.backoffMs ?? CLIENT_RECOVERY_BACKOFF_MS)));
    if (await assertLaunchSafe() !== true) {
      return { ok: false, attempted: true, code: "launch_not_safe", error: "A single-window recovery launch could not be proven safe." };
    }
    child = await spawnClient();
    const ready = await waitUntilReady(child);
    if (!ready) {
      return { ok: false, attempted: true, code: "recovery_not_ready", child, error: "The recovered client did not become ready." };
    }
    return { ok: true, attempted: true, code: "recovered", child, ready };
  } catch (error) {
    return {
      ok: false,
      attempted: true,
      code: "recovery_failed",
      child,
      error: String(error?.message ?? error),
    };
  }
}

function getCopiedClientProcesses() {
  if (process.platform !== "win32") return [];
  return getClientProcessTableRows().filter((row) => {
    const name = String(row?.name ?? "").trim().toLowerCase();
    const executablePath = normalizedExecutablePath(row?.executablePath);
    return name === "anti-codex.exe" || executablePath.endsWith("\\anti-codex.exe");
  });
}

function assertNoExistingClient() {
  const scan = scanCopiedClientProcessesSafely();
  return assertSafeStartupClientScan(scan);
}

export function assertSafeStartupClientScan(scan) {
  if (scan?.ok !== true) {
    throw new Error(
      `Cannot prove that no Anti-Codex client is already running: ${scan?.error || "process scan failed"}`,
    );
  }
  assertNoExistingClientProcesses(scan.processes);
  return scan;
}

export function liveOwnedClientPids(processIds = [], isAlive = ownerProcessIsAlive) {
  return [...new Set([...processIds].map(Number))]
    .filter((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid));
}

function normalizeCdpProbeStatus(value) {
  if (value && typeof value === "object") {
    return {
      ready: value.ready === true,
      fatal: value.fatal === true,
    };
  }
  return { ready: value === true, fatal: false };
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
  const cdpStatus = normalizeCdpProbeStatus(await isCdpReady());
  return {
    ready: cdpStatus.ready,
    fatal: cdpStatus.fatal,
    livePids: liveOwned,
    ownershipChanged,
    source: cdpStatus.fatal
      ? "fatal_renderer"
      : cdpStatus.ready
      ? (liveOwned.length > 0 ? "owned+cdp" : "cdp")
      : (liveOwned.length > 0 ? "renderer" : "missing"),
  };
}

export function clientSessionRequiresShutdown(clientSession) {
  const livePids = Array.isArray(clientSession?.livePids) ? clientSession.livePids : [];
  return clientSession?.fatal === true || (livePids.length === 0 && clientSession?.ready !== true);
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

export function classifyCdpRendererSnapshot(snapshot) {
  const text = String(snapshot?.text ?? "").trim();
  const primaryHeading = String(snapshot?.primaryHeading ?? "").replace(/\s+/g, " ").trim();
  const buttonLabels = Array.isArray(snapshot?.buttonLabels)
    ? snapshot.buttonLabels.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const hasDocument = snapshot?.readyState !== "loading" && snapshot?.hasBody === true;
  const fatal = hasDocument
    && snapshot?.hasComposer === false
    && text.length > 0
    && text.length <= FATAL_CLIENT_MAX_TEXT_LENGTH
    && primaryHeading.length > 0
    && primaryHeading.length <= 160
    && FATAL_CLIENT_HEADING_PATTERN.test(primaryHeading)
    && buttonLabels.some((label) => FATAL_CLIENT_RECOVERY_BUTTON_PATTERN.test(label));
  return {
    ready: hasDocument && !fatal && text.length >= 8 && snapshot?.hasInteractive === true,
    fatal,
  };
}

export function isCdpRendererSnapshotReady(snapshot) {
  return classifyCdpRendererSnapshot(snapshot).ready;
}

async function cdpRendererReady(webSocketDebuggerUrl) {
  const socket = new CdpProbeSocket(webSocketDebuggerUrl);
  try {
    await socket.open();
    const result = await socket.call(1, "Runtime.evaluate", {
      expression: `(() => {
        const body = document.body;
        const text = String(body?.innerText || body?.textContent || "").trim().slice(0, 8000);
        const isVisible = (element) => {
          const rect = element?.getBoundingClientRect?.();
          const style = element ? getComputedStyle(element) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
        };
        const primaryHeadingElement = Array.from(body?.querySelectorAll('main h1, main h2, h1, h2, [role="heading"]') || [])
          .find(isVisible);
        return {
          readyState: document.readyState,
          hasBody: Boolean(body),
          text,
          hasInteractive: Boolean(body?.querySelector('textarea, [contenteditable="true"], button, a, [role="button"], [role="link"]')),
          hasComposer: Boolean(body?.querySelector('[data-codex-composer], .ProseMirror')),
          primaryHeading: String(primaryHeadingElement?.textContent || '').replace(/\\s+/g, ' ').trim(),
          buttonLabels: Array.from(body?.querySelectorAll('button, [role="button"]') || [])
            .filter(isVisible)
            .map((button) => String(button.textContent || button.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 40),
        };
      })()`,
      returnByValue: true,
    });
    return classifyCdpRendererSnapshot(result?.result?.result?.value);
  } catch {
    return { ready: false, fatal: false };
  } finally {
    socket.close();
  }
}

export async function cdpPageReady(cdpPort, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rendererProbe = options.rendererProbe ?? cdpRendererReady;
  const returnStatus = options.returnStatus === true;
  const finish = (status) => returnStatus ? status : status.ready;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return finish({ ready: false, fatal: false });
    const targets = await response.json();
    const pages = targets.filter((target) => target?.type === "page"
      && target?.webSocketDebuggerUrl
      && !String(target?.url || "").toLowerCase().includes("avatar-overlay"));
    let fatal = false;
    for (const page of pages) {
      const status = normalizeCdpProbeStatus(await rendererProbe(page.webSocketDebuggerUrl));
      if (status.ready) return finish({ ready: true, fatal: false });
      fatal ||= status.fatal;
    }
    return finish({ ready: false, fatal });
  } catch {
    return finish({ ready: false, fatal: false });
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

export function stopOwnedProcess(child, identity, options = {}) {
  const processId = Number(child?.pid);
  if (!child) return { stopped: false, processId: null, reason: "missing_process" };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { stopped: false, processId, reason: "already_exited" };
  }
  if (Number(identity?.processId ?? identity?.ProcessId) !== processId) {
    return { stopped: false, processId, reason: "missing_identity" };
  }
  return stopExactProcess(identity, options);
}

export function stopExactProcess(identity, options = {}) {
  const expected = normalizedProcessRow({
    ...identity,
    parentProcessId: identity?.parentProcessId ?? identity?.ParentProcessId,
  });
  if (
    !expected
    || !normalizedExecutablePath(expected.executablePath)
    || !expected.creationFileTimeUtcTicks
  ) {
    return {
      stopped: false,
      processId: Number(identity?.processId ?? identity?.ProcessId) || null,
      reason: "missing_identity",
    };
  }
  try {
    const terminate = options.terminate ?? terminateExactWindowsProcessWithHandle;
    const result = terminate(expected);
    if (result?.status === "terminated") {
      return { stopped: true, processId: expected.processId, reason: "killed" };
    }
    if (result?.status === "already_exited") {
      return { stopped: false, processId: expected.processId, reason: "already_exited" };
    }
    if (result?.status === "identity_changed") {
      return { stopped: false, processId: expected.processId, reason: "identity_changed" };
    }
    return {
      stopped: false,
      processId: expected.processId,
      reason: result?.status === "unsupported" ? "termination_unsupported" : "kill_failed",
      error: result?.error ?? "The exact process could not be terminated through a bound Windows handle.",
    };
  } catch (error) {
    return {
      stopped: false,
      processId: expected.processId,
      reason: "kill_failed",
      error: String(error?.message ?? error),
    };
  }
}

function terminateExactWindowsProcessWithHandle(identity) {
  if (process.platform !== "win32") {
    return {
      status: "unsupported",
      error: "Exact process termination requires a Windows process handle.",
    };
  }
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_EXACT_PROCESS_TERMINATOR],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          ANTICODEX_TERMINATE_PID: String(identity.processId),
          ANTICODEX_TERMINATE_CREATION_FILETIME: identity.creationFileTimeUtcTicks,
          ANTICODEX_TERMINATE_EXECUTABLE: identity.executablePath,
        },
      },
    ).trim();
    if (output === "0") return { status: "terminated" };
    if (output === "3") return { status: "already_exited" };
    if (output === "42") return { status: "identity_changed" };
    return {
      status: "termination_failed",
      error: `Unexpected exact-process helper result: ${output || "empty"}`,
    };
  } catch (error) {
    return {
      status: "termination_failed",
      error: String(error?.stderr || error?.message || error),
    };
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
