import { spawn, spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ANTIGRAVITY_MODEL_SLOT,
  THIRD_PARTY_MODEL_PREFIX,
  THIRD_PARTY_MODEL_SLOT,
} from "./lib/anticodex-fixed-route.mjs";

const TASK_LAUNCHER_SCHEMA = "anticodex-task-launcher-v1";
export const ROUTE_RESTART_REQUEST_SCHEMA = "anticodex-route-restart-request-v1";
const ROUTE_RESTART_REQUEST_MAX_AGE_MS = 120_000;
const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3-flash-agent";
const FIXED_ROUTE_HEALTH_URL = "http://127.0.0.1:18487/anticodex/fixed-route/health";
export const FIXED_ROUTE_PORTS = Object.freeze([8484, 18318, 18484, 18485, 18486, 18487, 18488, 18489]);
export const ANTIGRAVITY_START_TIMEOUT_MS = 90_000;
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const HOST_SYNC_MUTEX_NAMES = Object.freeze([
  "Global\\AntiCodexHostSync",
  "Local\\AntiCodexHostSync",
]);

export function hideTaskConsole(env = process.env) {
  if (process.platform !== "win32") return { ok: true, skipped: true };
  const windowsRoot = text(env.SystemRoot) ?? text(env.WINDIR) ?? "C:\\Windows";
  const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const hideScript = join(scriptRoot, "hide-anticodex-console.ps1");
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", hideScript,
    "-TargetProcessId", String(process.pid),
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  return {
    ok: !result.error && result.status === 0,
    skipped: false,
    status: result.status,
    error: result.error ? String(result.error.message ?? result.error) : "",
  };
}

function requiredEnv(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export async function acquireHostSyncBarrier(options = {}) {
  if (typeof options.factory === "function") {
    return options.factory(options);
  }
  if ((options.platform ?? process.platform) !== "win32") {
    const release = async () => {};
    release.assertHeld = () => {};
    return release;
  }

  const env = options.env ?? process.env;
  const windowsRoot = text(env.SystemRoot) ?? text(env.WINDIR) ?? "C:\\Windows";
  const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const timeoutMs = Number(options.timeoutMs ?? 180_000);
  const helperScript = `
$ErrorActionPreference = "Stop"
$names = @("Global\\AntiCodexHostSync", "Local\\AntiCodexHostSync")
$mutexes = [System.Collections.Generic.List[System.Threading.Mutex]]::new()
$held = [System.Collections.Generic.List[System.Threading.Mutex]]::new()
try {
  foreach ($name in $names) {
    $mutex = [System.Threading.Mutex]::new($false, $name)
    $mutexes.Add($mutex)
    try {
      $acquired = $mutex.WaitOne(${Math.max(1, Math.trunc(timeoutMs))})
    } catch [System.Threading.AbandonedMutexException] {
      $acquired = $true
    }
    if (-not $acquired) {
      throw "Timed out waiting for Anti-Codex host sync publication barrier: $name"
    }
    $held.Add($mutex)
  }
  [Console]::Out.WriteLine("ANTICODEX_HOST_SYNC_BARRIER_READY")
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  for ($index = $held.Count - 1; $index -ge 0; $index--) {
    try { $held[$index].ReleaseMutex() } catch {}
  }
  foreach ($mutex in $mutexes) {
    try { $mutex.Dispose() } catch {}
  }
}
`;
  const helper = spawn(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-EncodedCommand", Buffer.from(helperScript, "utf16le").toString("base64"),
  ], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let held = false;
  let released = false;
  let stderr = "";
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      finish(new Error("Timed out acquiring the Anti-Codex host sync publication barrier."));
    }, timeoutMs + 5_000);
    const finish = (error) => {
      clearTimeout(timer);
      helper.stdout.removeListener("data", onStdout);
      helper.stderr.removeListener("data", onStderr);
      helper.removeListener("error", onError);
      helper.removeListener("exit", onExit);
      if (error) {
        try { helper.stdin.end(); } catch {}
        rejectReady(error);
      } else {
        held = true;
        resolveReady();
      }
    };
    const onStdout = (chunk) => {
      if (String(chunk).includes("ANTICODEX_HOST_SYNC_BARRIER_READY")) finish();
    };
    const onStderr = (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(
      `Anti-Codex host sync barrier helper exited before acquisition (code ${code ?? "signal"}): ${stderr.trim()}`,
    ));
    helper.stdout.on("data", onStdout);
    helper.stderr.on("data", onStderr);
    helper.once("error", onError);
    helper.once("exit", onExit);
  });

  const release = async () => {
    if (released) return;
    released = true;
    held = false;
    await new Promise((resolveExit) => {
      if (helper.exitCode !== null || helper.signalCode !== null) {
        resolveExit();
        return;
      }
      const timer = setTimeout(() => {
        try { helper.kill(); } catch {}
        resolveExit();
      }, 5_000);
      helper.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
      try { helper.stdin.end("\n"); } catch {
        clearTimeout(timer);
        resolveExit();
      }
    });
  };
  release.assertHeld = () => {
    if (!held || released) {
      throw new Error("Anti-Codex host sync publication barrier was released before runtime startup.");
    }
  };
  return release;
}

function normalizeProfile(profile = {}) {
  const mode = String(profile.mode ?? "antigravity").trim().toLowerCase();
  if (!["antigravity", "third-party"].includes(mode)) {
    throw new Error(`Unsupported Anti-Codex profile mode: ${mode}`);
  }
  const protocol = String(profile.protocol ?? "").trim().toLowerCase();
  const baseUrl = text(profile.baseUrl) ?? "";
  const model = text(profile.model) ?? "";
  const hasThirdPartyProfile = Boolean(protocol || baseUrl || model);
  if (hasThirdPartyProfile && !["openai-compatible", "responses"].includes(protocol)) {
    throw new Error(`Unsupported third-party protocol: ${protocol || "missing"}`);
  }
  const contextWindow = Number(profile.contextWindow ?? 72_000);
  if ((mode === "third-party" || hasThirdPartyProfile) && (!baseUrl || !model)) {
    throw new Error("Saved third-party profile is incomplete.");
  }
  if (hasThirdPartyProfile && (!Number.isInteger(contextWindow) || contextWindow < 16_000 || contextWindow > 4_000_000)) {
    throw new Error("Saved third-party context window is invalid.");
  }
  return {
    mode,
    antigravityModel: text(profile.antigravityModel) ?? DEFAULT_ANTIGRAVITY_MODEL,
    protocol,
    baseUrl,
    model,
    contextWindow: Number.isInteger(contextWindow) ? contextWindow : 72_000,
    capabilities: profile.capabilities && typeof profile.capabilities === "object"
      ? structuredClone(profile.capabilities)
      : {},
  };
}

export function readSavedProfile(stateRoot) {
  const profilePath = join(stateRoot, "upstream-profile.json");
  if (!existsSync(profilePath)) return normalizeProfile();
  return normalizeProfile(JSON.parse(readFileSync(profilePath, "utf8")));
}

function readNativeSelection(codexHome) {
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) return null;
  for (const line of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*model\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/);
    if (match) return { model: match[2].trim() };
  }
  return { model: "" };
}

function resolveLaunchSelection(profile, nativeSelection) {
  if (nativeSelection === null) {
    return profile.mode === "third-party"
      ? { provider: "third-party", model: profile.model }
      : { provider: "antigravity", model: profile.antigravityModel };
  }

  const selectedModel = text(nativeSelection.model) ?? "";
  if (selectedModel === THIRD_PARTY_MODEL_SLOT || selectedModel.startsWith(THIRD_PARTY_MODEL_PREFIX)) {
    return {
      provider: "third-party",
      model: text(selectedModel.slice(THIRD_PARTY_MODEL_PREFIX.length)) ?? profile.model,
    };
  }
  if (selectedModel === ANTIGRAVITY_MODEL_SLOT || !selectedModel) {
    return { provider: "antigravity", model: profile.antigravityModel };
  }
  return { provider: "antigravity", model: selectedModel };
}

export function consumeRouteRestartRequest(stateRoot, expectedSupervisorPid, now = Date.now()) {
  const requestPath = join(stateRoot, "route-restart-request.json");
  if (!existsSync(requestPath)) return null;

  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch {
    request = null;
  }
  rmSync(requestPath, { force: true });

  const requestedAt = Date.parse(String(request?.requestedAt ?? ""));
  const ageMs = now - requestedAt;
  const valid = request?.schema === ROUTE_RESTART_REQUEST_SCHEMA
    && String(request?.requestId ?? "").trim().length > 0
    && Number(request?.expectedSupervisorPid) === Number(expectedSupervisorPid)
    && Number.isFinite(requestedAt)
    && ageMs >= -5_000
    && ageMs <= ROUTE_RESTART_REQUEST_MAX_AGE_MS;
  return valid ? request : null;
}

function tcpPortIsOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function waitForFixedRoutePortsReleased(options = {}) {
  const ports = options.ports ?? FIXED_ROUTE_PORTS;
  const timeoutMs = Number(options.timeoutMs ?? 30_000);
  const stableMs = Number(options.stableMs ?? 1_000);
  const intervalMs = Number(options.intervalMs ?? 100);
  const now = options.now ?? Date.now;
  const sleepFn = options.sleepFn ?? sleep;
  const isPortOpen = options.isPortOpen ?? tcpPortIsOpen;
  const deadline = now() + timeoutMs;
  let releasedSince = 0;
  while (now() < deadline) {
    const openStates = await Promise.all(ports.map((port) => isPortOpen(port)));
    if (openStates.every((open) => open === false)) {
      if (!releasedSince) releasedSince = now();
      if (now() - releasedSince >= stableMs) return true;
    } else {
      releasedSince = 0;
    }
    await sleepFn(intervalMs);
  }
  return false;
}

export function buildTaskLaunchPlan(options = {}) {
  const env = options.env ?? process.env;
  const installRoot = resolve(join(requiredEnv(env, "LOCALAPPDATA"), "Anti-Codex"));
  const stateRoot = resolve(join(requiredEnv(env, "APPDATA"), "anticodex"));
  const userProfile = resolve(requiredEnv(env, "USERPROFILE"));
  const profile = normalizeProfile(options.profile ?? readSavedProfile(stateRoot));
  const supervisorScript = resolve(join(scriptRoot, "start-anticodex-fixed-route.mjs"));
  const codexHome = join(stateRoot, "codex-home-deepseek-app");
  const { provider, model } = resolveLaunchSelection(profile, readNativeSelection(codexHome));
  const disableGpu = truthy(env.ANTICODEX_DISABLE_GPU ?? env.DEEPCODEX_DISABLE_GPU);
  const supervisorArgs = [
    supervisorScript,
    "--install-root", installRoot,
    "--state-root", stateRoot,
    "--provider", provider,
    "--model", model,
    "--manager-base-url", "http://127.0.0.1:8484",
  ];
  if (disableGpu) supervisorArgs.push("--disable-gpu");
  if (provider === "third-party") {
    supervisorArgs.push("--context-window", String(profile.contextWindow));
  }

  return {
    schema: TASK_LAUNCHER_SCHEMA,
    installRoot,
    stateRoot,
    userProfile,
    codexHome,
    provider,
    model,
    disableGpu,
    profile,
    supervisorScript,
    supervisorArgs,
    launcherStatePath: join(stateRoot, "launcher-state.json"),
    stdoutPath: join(stateRoot, "anticodex-fixed-route.out.log"),
    stderrPath: join(stateRoot, "anticodex-fixed-route.err.log"),
    publicProfile: provider === "third-party"
      ? {
          mode: profile.mode,
          protocol: profile.protocol,
          baseUrl: profile.baseUrl,
          model: profile.model,
          contextWindow: profile.contextWindow,
          apiKeyConfigured: false,
        }
      : {
          mode: profile.mode,
          antigravityModel: profile.antigravityModel,
          apiKeyConfigured: false,
        },
  };
}

export function buildTaskLauncherEnvironment(plan, baseEnv = process.env, runtimeProfile = plan.profile) {
  const env = { ...baseEnv };
  for (const key of [
    "UPSTREAM_PROTOCOL",
    "UPSTREAM_URL",
    "UPSTREAM_MODEL",
    "UPSTREAM_API_KEY",
    "UPSTREAM_CONTEXT_WINDOW",
    "DEEPCODEX_DISABLE_GPU",
    "ANTICODEX_DISABLE_GPU",
  ]) delete env[key];

  Object.assign(env, {
    DEEPCODEX_STATE_ROOT: plan.stateRoot,
    CODEX_HOME_DIR: plan.codexHome,
    CODEX_HOME: plan.codexHome,
    GLOBAL_CODEX_HOME: join(plan.userProfile, ".codex"),
    DEEPCODEX_SHARED_CODEX_HOME: join(plan.userProfile, ".codex"),
    DEEPCODEX_CDP_PORT: "18318",
    DEEPCODEX_DISPLAY_NAME: "Anti-Codex",
    DEEPCODEX_SKIP_PLUGIN_SYNC: "1",
    ANTICODEX_MANAGER_API: "http://127.0.0.1:8484",
    DEEPCODEX_PROJECTS_ROOT: join(plan.userProfile, "Documents", "anticodex"),
    ANTICODEX_PROVIDER: plan.provider,
    ANTICODEX_MODEL: plan.model,
  });
  if (plan.disableGpu) {
    env.DEEPCODEX_DISABLE_GPU = "1";
    env.ANTICODEX_DISABLE_GPU = "1";
  }

  const thirdPartyConfigured = Boolean(
    text(runtimeProfile.protocol)
      && text(runtimeProfile.baseUrl)
      && text(runtimeProfile.model),
  );
  const apiKey = text(runtimeProfile.apiKey);
  if (plan.provider === "third-party" && (!thirdPartyConfigured || !apiKey)) {
    throw new Error("Saved third-party API key is unavailable.");
  }
  if (thirdPartyConfigured && apiKey) {
    Object.assign(env, {
      UPSTREAM_PROTOCOL: runtimeProfile.protocol,
      UPSTREAM_URL: runtimeProfile.baseUrl,
      UPSTREAM_MODEL: plan.provider === "third-party" ? plan.model : runtimeProfile.model,
      UPSTREAM_API_KEY: apiKey,
      UPSTREAM_CONTEXT_WINDOW: String(runtimeProfile.contextWindow),
    });
  }
  return env;
}

function readThirdPartyRuntimeProfile(plan, env) {
  const windowsRoot = text(env.SystemRoot) ?? text(env.WINDIR) ?? "C:\\Windows";
  const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const profileScript = join(scriptRoot, "anticodex-upstream-profile.ps1");
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", profileScript,
    "-Action", "GetRuntime",
    "-StateRoot", plan.stateRoot,
  ], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Third-party profile helper exited with code ${result.status}.`);
  }
  return { ...plan.profile, ...JSON.parse(String(result.stdout ?? "").trim()) };
}

function tasklistContains(executableName, env) {
  const windowsRoot = text(env.SystemRoot) ?? text(env.WINDIR) ?? "C:\\Windows";
  const tasklist = join(windowsRoot, "System32", "tasklist.exe");
  const result = spawnSync(tasklist, ["/FI", `IMAGENAME eq ${executableName}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  return result.status === 0 && String(result.stdout ?? "").toLowerCase().includes(`"${executableName.toLowerCase()}"`);
}

async function ensureAntigravityDesktop(plan, env) {
  if (tasklistContains("Antigravity.exe", env) || tasklistContains("Antigravity IDE.exe", env)) {
    return text(env.ANTIGRAVITY_DESKTOP_PATH);
  }
  const candidates = [
    text(env.ANTIGRAVITY_DESKTOP_PATH),
    join(requiredEnv(env, "LOCALAPPDATA"), "Programs", "antigravity", "Antigravity.exe"),
    join(requiredEnv(env, "LOCALAPPDATA"), "Programs", "Antigravity", "Antigravity.exe"),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Antigravity Desktop is not running and no installed executable was found.");

  const stdout = openSync(join(plan.stateRoot, "antigravity-desktop.out.log"), "a");
  const stderr = openSync(join(plan.stateRoot, "antigravity-desktop.err.log"), "a");
  try {
    const child = spawn(executable, [], {
      detached: true,
      env,
      stdio: ["ignore", stdout, stderr],
      windowsHide: false,
    });
    child.unref();
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }

  let stableSince = 0;
  const deadline = Date.now() + ANTIGRAVITY_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = tasklistContains("Antigravity.exe", env) || tasklistContains("Antigravity IDE.exe", env);
    if (running) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 8_000) return executable;
    } else {
      stableSince = 0;
    }
    await sleep(500);
  }
  throw new Error("Antigravity Desktop did not remain running long enough for Anti-Codex.");
}

function runLogDatabaseGuard(plan, env) {
  const guardScript = join(scriptRoot, "protect-anticodex-log-db.mjs");
  const result = spawnSync(process.execPath, [guardScript, "--codex-home", plan.codexHome, "--backup"], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Anti-Codex log database guard exited with code ${result.status}.`);
  const status = JSON.parse(String(result.stdout ?? "{}").trim());
  if (!status.ok) throw new Error(String(status.error ?? "Anti-Codex log database guard failed."));
}

async function fixedRouteReady() {
  try {
    const response = await fetch(FIXED_ROUTE_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.state === "ready";
  } catch {
    return false;
  }
}

function writeLauncherState(plan, startedAt, stage, status = "running", message = "") {
  mkdirSync(plan.stateRoot, { recursive: true });
  const payload = {
    schema: "anticodex-launcher-state-v1",
    launcher: TASK_LAUNCHER_SCHEMA,
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    stage,
    status,
    message,
    provider: plan.provider,
    model: plan.model,
  };
  const temporary = `${plan.launcherStatePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, plan.launcherStatePath);
}

function publicError(error) {
  return String(error?.message ?? error ?? "unknown launch failure")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 1_000);
}

export function attachForwardedSignalHandlers(child, signalTarget = process) {
  const forwardSigint = () => {
    try { child.kill("SIGINT"); } catch {}
  };
  const forwardSigterm = () => {
    try { child.kill("SIGTERM"); } catch {}
  };
  signalTarget.once("SIGINT", forwardSigint);
  signalTarget.once("SIGTERM", forwardSigterm);
  return () => {
    signalTarget.removeListener("SIGINT", forwardSigint);
    signalTarget.removeListener("SIGTERM", forwardSigterm);
  };
}

export async function runTaskLauncher(options = {}) {
  const env = options.env ?? process.env;
  const plan = buildTaskLaunchPlan({ env, profile: options.profile });
  if (options.planOnly) return plan;

  const releaseHostSyncBarrier = await acquireHostSyncBarrier({
    env,
    factory: options.acquireHostSyncBarrier,
  });
  try {
    const startedAt = new Date().toISOString();
    writeLauncherState(plan, startedAt, "initializing");
    if (await fixedRouteReady()) {
      writeLauncherState(plan, startedAt, "ready", "ready", "existing fixed route");
      return { ok: true, reused: true };
    }

    const runtimeProfile = readThirdPartyRuntimeProfile(plan, env);
    const childEnv = buildTaskLauncherEnvironment(plan, env, runtimeProfile);
    mkdirSync(plan.stateRoot, { recursive: true });
    if (plan.provider === "antigravity") {
      const desktopPath = await ensureAntigravityDesktop(plan, childEnv);
      if (desktopPath) childEnv.ANTIGRAVITY_DESKTOP_PATH = desktopPath;
    }
    runLogDatabaseGuard(plan, childEnv);

    rmSync(plan.stdoutPath, { force: true });
    rmSync(plan.stderrPath, { force: true });
    const stdout = openSync(plan.stdoutPath, "a");
    const stderr = openSync(plan.stderrPath, "a");
    writeLauncherState(plan, startedAt, "supervising-fixed-route");
    const child = spawn(process.execPath, plan.supervisorArgs, {
      env: childEnv,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
    const detachForwardedSignals = attachForwardedSignalHandlers(child);
    const childExit = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    releaseHostSyncBarrier.assertHeld();
    await releaseHostSyncBarrier();

    const result = await childExit.finally(() => {
      detachForwardedSignals();
      closeSync(stdout);
      closeSync(stderr);
    });
    const restartRequest = consumeRouteRestartRequest(plan.stateRoot, child.pid);
    if (restartRequest) {
      writeLauncherState(
        plan,
        startedAt,
        "route-restart-requested",
        "running",
        String(restartRequest.requestId),
      );
      if (!await waitForFixedRoutePortsReleased()) {
        throw new Error("Previous Anti-Codex route ports did not release before the controlled restart.");
      }
      return runTaskLauncher({ env, acquireHostSyncBarrier: options.acquireHostSyncBarrier });
    }
    if (result.code !== 0) {
      throw new Error(`Anti-Codex fixed-route supervisor exited with code ${result.code ?? "signal"}.`);
    }
    writeLauncherState(plan, startedAt, "closed", "stopped");
    return { ok: true, reused: false };
  } finally {
    await releaseHostSyncBarrier();
  }
}

async function main() {
  const planOnly = process.argv.includes("--plan-json");
  if (process.argv.includes("--hide-console")) hideTaskConsole();
  try {
    const result = await runTaskLauncher({ planOnly });
    if (planOnly) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        planOnly: true,
        schema: result.schema,
        installRoot: result.installRoot,
        stateRoot: result.stateRoot,
        provider: result.provider,
        model: result.model,
        publicProfile: result.publicProfile,
        supervisorScript: result.supervisorScript,
      })}\n`);
    }
  } catch (error) {
    const fallbackPlan = (() => {
      try { return buildTaskLaunchPlan(); } catch { return null; }
    })();
    if (fallbackPlan) {
      try {
        writeLauncherState(fallbackPlan, new Date().toISOString(), "failed", "error", publicError(error));
      } catch {}
    }
    process.stderr.write(`${publicError(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();
