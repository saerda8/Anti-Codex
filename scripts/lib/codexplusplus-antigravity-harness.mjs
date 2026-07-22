import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { buildAntigravityModelCatalog } from "../../translator/antigravity-model-catalog.mjs";
import { createAntigravityCascadeClient } from "../../translator/provider/antigravity-cascade-client.mjs";
import { startAntigravityChatProvider } from "../../translator/provider/start-antigravity-chat-provider.mjs";

const OLD_ROUTE_URL = "http://127.0.0.1:8484/anticodex/model-routes";

export async function createCodexPlusPlusAntigravityHarness(options) {
  const launcherPath = resolveRequired(options?.launcherPath, "launcherPath");
  const candidateRoot = resolveRequired(options?.candidateRoot, "candidateRoot");
  const candidateAppDir = join(candidateRoot, "codex-patched-app");
  const candidateExe = join(candidateAppDir, "Anti-Codex.exe");
  const candidateCli = join(candidateAppDir, "resources", "codex.exe");
  const model = String(options?.model ?? "gemini-3.5-flash-low");
  const launchDesktop = options?.launchDesktop === true;
  const timeoutMs = positiveInteger(options?.timeoutMs, 600_000);
  const runRoot = resolve(options?.runRoot ?? join(
    os.tmpdir(),
    `AntiCodex-Gate5-${Date.now()}-${randomUUID().slice(0, 8)}`,
  ));
  const paths = {
    root: runRoot,
    state: join(runRoot, "codex-plus-state"),
    codexHome: join(runRoot, "codex-home"),
    appData: join(runRoot, "appdata"),
    localAppData: join(runRoot, "localappdata"),
    userData: join(runRoot, "electron-user-data"),
    temp: join(runRoot, "temp"),
    antiCodexState: join(runRoot, "anticodex-state"),
    workspace: join(runRoot, "workspace"),
    acceptance: join(runRoot, "acceptance"),
  };
  const counters = { start: 0, resume: 0, cancel: 0 };
  const observed = { startCalls: [], resumeCalls: [] };
  const children = new Set();
  let provider = null;
  let launcher = null;
  let closed = false;

  async function close({ removeRoot = true } = {}) {
    if (closed) return;
    closed = true;
    for (const child of [...children]) await stopChild(child).catch(() => {});
    await stopChild(launcher).catch(() => {});
    await provider?.close?.().catch(() => {});
    await waitFor(() => candidateProcesses(candidateAppDir).length === 0, {
      timeout: 10_000,
      description: "candidate process cleanup",
    }).catch(() => {});
    if (removeRoot && existsSync(runRoot)) safeRemoveRunRoot(runRoot, "AntiCodex-Gate5-");
  }

  try {
    for (const [name, path] of Object.entries({ launcherPath, candidateExe, candidateCli })) {
      if (!existsSync(path)) throw new Error(`Missing ${name}: ${path}`);
    }
    const preexisting = candidateProcesses(candidateAppDir);
    if (preexisting.length) {
      throw new Error(`Copied candidate is already running: ${preexisting.map((row) => row.processId).join(", ")}`);
    }
    assertVisibleCandidateLaunch({
      launchDesktop,
      approved: options?.visibleLaunchApproved === true,
      activeAntiCodexRoots: launchDesktop ? getProcessSnapshot(candidateAppDir).antiCodexRoots : [],
    });
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });

    const [cdpPort, protocolProxyPort, launcherGuardPort, managerGuardPort] = await uniquePorts(4);
    const rawClient = createAntigravityCascadeClient();
    const client = {
      listModels: (...args) => rawClient.listModels(...args),
      getReadiness: (...args) => rawClient.getReadiness(...args),
      start(request) {
        counters.start += 1;
        observed.startCalls.push(toolObservation(request));
        return rawClient.start(request);
      },
      resume(continuation, results, request) {
        counters.resume += 1;
        observed.resumeCalls.push(toolObservation(request));
        return rawClient.resume(continuation, results, request);
      },
      async cancel(...args) {
        counters.cancel += 1;
        return rawClient.cancel(...args);
      },
    };
    const readiness = await client.getReadiness();
    if (readiness?.signedIn !== true) throw new Error("Antigravity Desktop is not signed in.");
    const availableModels = await client.listModels();
    const bundledCatalog = JSON.parse(execFileSync(candidateCli, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }));
    const template = bundledCatalog.models.find((entry) => entry.slug === "gpt-5.4")
      ?? bundledCatalog.models[0];
    const catalog = buildAntigravityModelCatalog(
      { ...bundledCatalog, models: [template] },
      availableModels.map((entry) => ({
        id: entry.id,
        model: entry.internalModel,
        displayName: entry.displayName,
      })),
    );
    const selectedModel = catalog.models.find((entry) => entry.slug === model);
    if (!selectedModel) throw new Error(`Antigravity model is unavailable: ${model}`);
    const catalogPath = join(paths.codexHome, "antigravity-model-catalog.json");
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    writeFileSync(join(paths.codexHome, "AGENTS.md"), [
      "# Anti-Codex Validation Rules",
      "",
      "- Work only inside the current working directory unless the user explicitly names another path.",
      "- Never inspect parent directories, private model/session history, .gemini/antigravity/brain, Anti-Codex runtime state, or validation reports.",
      "- Use the direct output of Codex tools. If output is insufficient, rerun an in-scope command instead of reading hidden runtime logs.",
      "- Never launch a desktop application during a headless coding task.",
      "- Before each tool call, briefly explain the next action in Chinese.",
      "",
    ].join("\n"), "utf8");

    provider = await startAntigravityChatProvider({ client, host: "127.0.0.1", port: 0 });
    const proxyBase = `http://127.0.0.1:${protocolProxyPort}/v1`;
    const config = renderConfig({ model, catalogPath, proxyBase });
    writeFileSync(join(paths.codexHome, "config.toml"), config, "utf8");
    writeFileSync(join(paths.codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: "gate5-local-key" }, null, 2)}\n`, "utf8");
    writeFileSync(join(paths.state, "settings.json"), `${JSON.stringify({
      codexExtraArgs: [`--user-data-dir=${paths.userData}`, "--no-first-run"],
      enhancementsEnabled: false,
      providerSyncEnabled: false,
      relayProfilesEnabled: true,
      computerUseGuardEnabled: false,
      codexAppPluginMarketplaceUnlock: false,
      codexAppNativeMenuLocalization: false,
      codexAppFastStartup: false,
      relayProfiles: [{
        id: "gate5-antigravity",
        name: "Gate 5 Antigravity",
        upstreamBaseUrl: provider.url,
        protocol: "chatCompletions",
        relayMode: "pureApi",
        testModel: model,
        configContents: config,
        authContents: `${JSON.stringify({ OPENAI_API_KEY: "gate5-local-key" }, null, 2)}\n`,
        useCommonConfig: false,
        modelList: model,
      }],
      activeRelayId: "gate5-antigravity",
      relayTestModel: model,
    }, null, 2)}\n`, "utf8");
    const environment = {
      ...process.env,
      CODEX_PLUS_STATE_DIR: paths.state,
      CODEX_PLUS_APP_EXECUTABLE: candidateExe,
      CODEX_PLUS_PROTOCOL_PROXY_PORT: String(protocolProxyPort),
      CODEX_PLUS_LAUNCHER_GUARD_PORT: String(launcherGuardPort),
      CODEX_PLUS_MANAGER_GUARD_PORT: String(managerGuardPort),
      CODEX_HOME: paths.codexHome,
      CODEX_HOME_DIR: paths.codexHome,
      APPDATA: paths.appData,
      LOCALAPPDATA: paths.localAppData,
      TEMP: paths.temp,
      TMP: paths.temp,
      DEEPCODEX_STATE_ROOT: paths.antiCodexState,
      DEEPCODEX_CDP_PORT: String(cdpPort),
    };
    const metadataCheck = spawnSync(candidateCli, ["debug", "prompt-input", "GATE5_METADATA_CHECK"], {
      cwd: paths.workspace,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (metadataCheck.status !== 0 || /Model metadata for .* not found/i.test(metadataCheck.stderr ?? "")) {
      throw new Error(`Codex model metadata preflight failed: ${tail(metadataCheck.stderr, 1_000)}`);
    }

    let launcherError = null;
    launcher = spawn(launcherPath, codexPlusPlusLauncherArgs({
      launchDesktop,
      candidateAppDir,
      cdpPort,
      protocolProxyPort,
    }), {
      cwd: candidateAppDir,
      env: environment,
      windowsHide: true,
      stdio: "ignore",
    });
    launcher.once("error", (error) => { launcherError = error; });
    const modelsResponse = await waitFor(async () => {
      if (launcherError) throw launcherError;
      if (launcher.exitCode !== null) throw new Error(`CodexPlusPlus helper exited: ${launcher.exitCode}`);
      const response = await fetch(`${proxyBase}/models`, {
        headers: { Authorization: "Bearer gate5-local-key" },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body.data?.some((entry) => entry.id === model) ? body : null;
    }, { timeout: 60_000, description: "CodexPlusPlus model proxy" });
    let desktopTarget = null;
    if (launchDesktop) {
      desktopTarget = await waitFor(async () => {
        if (launcherError) throw launcherError;
        if (launcher.exitCode !== null) throw new Error(`CodexPlusPlus launcher exited: ${launcher.exitCode}`);
        if (candidateProcesses(candidateAppDir).length === 0) return null;
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) return null;
        const targets = await response.json();
        return targets.find((entry) => String(entry?.url ?? "").startsWith("app://"))
          ?? targets.find((entry) => entry?.webSocketDebuggerUrl)
          ?? null;
      }, { timeout: 90_000, description: "visible copied Anti-Codex CDP target" });
    }

    async function runInitial(prompt, runOptions = {}) {
      return runCodex([
        "exec",
        "--skip-git-repo-check",
        "-C", paths.workspace,
        "--sandbox", "danger-full-access",
        "--color", "never",
        "--json",
        String(prompt),
      ], runOptions);
    }

    async function runResume(sessionId, prompt, runOptions = {}) {
      if (!String(sessionId ?? "").trim()) throw new Error("sessionId is required for resume.");
      return runCodex([
        "exec", "resume",
        "--skip-git-repo-check",
        "--json",
        String(sessionId),
        String(prompt),
      ], runOptions);
    }

    async function runCodex(args, runOptions) {
      const result = await runProcess(candidateCli, args, {
        cwd: paths.workspace,
        env: environment,
        timeoutMs: positiveInteger(runOptions?.timeoutMs, timeoutMs),
        onChild(child) { children.add(child); },
      });
      children.delete(result.child);
      return summarizeCodexRun(result);
    }

    return {
      paths,
      model,
      candidateAppDir,
      candidateCli,
      launchMode: launchDesktop ? "visible copied Anti-Codex desktop" : "headless copied native Codex",
      cdpPort,
      desktopTarget: desktopTarget ? {
        id: desktopTarget.id ?? null,
        title: desktopTarget.title ?? null,
        url: desktopTarget.url ?? null,
        webSocketDebuggerUrl: desktopTarget.webSocketDebuggerUrl ?? null,
      } : null,
      providerUrl: provider.url,
      proxyBase,
      counters,
      observed,
      readiness,
      availableModelCount: availableModels.length,
      selectedModel: {
        slug: selectedModel.slug,
        applyPatchToolType: selectedModel.apply_patch_tool_type ?? null,
        shellType: selectedModel.shell_type ?? null,
        contextWindow: selectedModel.context_window ?? null,
      },
      proxiedModelCount: modelsResponse.data.length,
      environment,
      runInitial,
      runResume,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export function codexPlusPlusLauncherArgs(options = {}) {
  if (options.launchDesktop === true) {
    return [
      "--app-path", String(options.candidateAppDir ?? ""),
      "--debug-port", String(options.cdpPort ?? ""),
      "--helper-port", String(options.protocolProxyPort ?? ""),
    ];
  }
  return ["--helper-only", "--helper-port", String(options.protocolProxyPort ?? "")];
}

export function assertVisibleCandidateLaunch(options = {}) {
  if (options.launchDesktop !== true) return;
  if (options.approved !== true) {
    throw new Error("Visible Anti-Codex candidate launch requires explicit approval.");
  }
  const activeRoots = Array.isArray(options.activeAntiCodexRoots) ? options.activeAntiCodexRoots : [];
  if (activeRoots.length) {
    throw new Error(`Close the active Anti-Codex before visible candidate validation (active PID: ${activeRoots.map((row) => row.processId).join(", ")}).`);
  }
}

export function summarizeCodexRun(result) {
  const events = parseJsonLines(result.stdout);
  const commands = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "command_execution")
    .map((event) => ({
      id: event.item.id,
      command: event.item.command,
      status: event.item.status,
      exitCode: event.item.exit_code,
      outputTail: tail(event.item.aggregated_output, 2_000),
    }));
  const fileChanges = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "file_change")
    .map((event) => ({
      id: event.item.id,
      status: event.item.status,
      changes: event.item.changes ?? [],
    }));
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => String(event.item.text ?? ""));
  return {
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError?.message ?? null,
    threadId: events.find((event) => event.type === "thread.started")?.thread_id ?? null,
    events,
    commands,
    fileChanges,
    messages,
    stdoutTail: tail(result.stdout, 8_000),
    stderrTail: tail(result.stderr, 5_000),
  };
}

export async function runProcess(file, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.onChild?.(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let forcedSettleTimer = null;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedSettleTimer) clearTimeout(forcedSettleTimer);
      resolveRun({ child, code, signal, timedOut, spawnError, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (options.killTreeOnTimeout === false) child.kill("SIGKILL");
      else killProcessTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      forcedSettleTimer = setTimeout(() => settle(child.exitCode, child.signalCode), 1_000);
    }, positiveInteger(options.timeoutMs, 600_000));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", settle);
  });
}

export function getProcessSnapshot(candidateAppDir = "") {
  const rows = getProcesses();
  const originalCodex = rows.filter((row) => (
    ["chatgpt.exe", "codex.exe"].includes(row.name.toLowerCase())
    && row.executablePath.toLowerCase().includes("\\windowsapps\\openai.codex_")
  ));
  const antiRows = rows.filter((row) => (
    row.name.toLowerCase() === "anti-codex.exe"
    && (!candidateAppDir || !isPathUnderRoot(row.executablePath, candidateAppDir))
  ));
  return {
    originalCodex: sortProcesses(originalCodex),
    antiCodexRoots: sortProcesses(antiRows),
    candidateProcesses: candidateAppDir ? sortProcesses(candidateProcesses(candidateAppDir)) : [],
  };
}

export function sameProcessRows(left = [], right = []) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function fetchOldRouteFingerprint() {
  const response = await fetch(OLD_ROUTE_URL, { signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Old route audit returned HTTP ${response.status}.`);
  const body = JSON.parse(text);
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const normalized = entries.map((entry) => ({
    at: String(entry?.at ?? ""),
    requestId: String(entry?.requestId ?? ""),
    transport: String(entry?.transport ?? ""),
    requestedModel: String(entry?.requestedModel ?? ""),
    resolvedModel: String(entry?.resolvedModel ?? ""),
    cascadeId: String(entry?.cascadeId ?? ""),
    status: String(entry?.status ?? ""),
  }));
  return {
    count: Number(body.count ?? entries.length),
    entryCount: entries.length,
    latestAt: String(body.latest?.at ?? ""),
    latestRequestId: String(body.latest?.requestId ?? ""),
    entriesSha256: sha256(JSON.stringify(normalized)),
  };
}

export function treeManifest(root) {
  if (!existsSync(root)) return [];
  const base = resolve(root);
  return collectTreeManifest(base, base)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function collectTreeManifest(current, base) {
  const rows = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) rows.push(...collectTreeManifest(path, base));
    else if (entry.isFile()) {
      rows.push({
        path: relative(base, path).replaceAll("\\", "/"),
        sha256: sha256(readFileSync(path)),
      });
    }
  }
  return rows;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function archiveDirectory(source, destination) {
  const root = resolve(source);
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  const executable = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(executable, ["-a", "-c", "-f", target, "-C", root, "."], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  const ok = result.status === 0 && existsSync(target) && readFileSync(target).length > 0;
  if (!ok) rmSync(target, { force: true });
  const bytes = ok ? readFileSync(target) : null;
  return {
    ok,
    path: target,
    bytes: bytes?.length || 0,
    sha256: bytes ? sha256(bytes) : null,
    exitCode: result.status,
    error: ok ? null : String(result.stderr || result.stdout || result.error?.message || "archive failed").slice(-2_000),
  };
}

function renderConfig({ model, catalogPath, proxyBase }) {
  return [
    `model = "${model}"`,
    `model_catalog_json = "${catalogPath.replaceAll("\\", "/")}"`,
    "model_provider = \"antigravity\"",
    "approval_policy = \"never\"",
    "sandbox_mode = \"danger-full-access\"",
    "",
    "[model_providers.antigravity]",
    "name = \"Antigravity through CodexPlusPlus\"",
    "wire_api = \"responses\"",
    "requires_openai_auth = true",
    `base_url = "${proxyBase}"`,
    "experimental_bearer_token = \"gate5-local-key\"",
    "",
    "[features]",
    "plugins = false",
    "plugin_sharing = false",
    "remote_plugin = false",
    "",
  ].join("\n");
}

function toolObservation(request) {
  return {
    toolNames: (request?.tools ?? [])
      .map((tool) => tool.name ?? tool.function?.name)
      .filter(Boolean),
  };
}

function getProcesses() {
  const script = [
    "$names = @('ChatGPT', 'Codex', 'Anti-Codex', 'codex-plus-plus')",
    "$rows = Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $path = ''",
    "  try { $path = [string]$_.Path } catch {}",
    "  [pscustomobject]@{",
    "    processId = [int]$_.Id",
    "    parentProcessId = 0",
    "    name = ([string]$_.ProcessName) + '.exe'",
    "    executablePath = $path",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Compress",
  ].join("\n");
  let output = "";
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 12_000,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  const parsed = JSON.parse(output.trim() || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    processId: Number(row.processId),
    parentProcessId: Number(row.parentProcessId),
    name: String(row.name ?? ""),
    executablePath: String(row.executablePath ?? ""),
  }));
}

function candidateProcesses(root) {
  return getProcesses().filter((row) => isPathUnderRoot(row.executablePath, root));
}

function sortProcesses(rows) {
  return [...rows].sort((a, b) => a.processId - b.processId);
}

function parseJsonLines(output) {
  const rows = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function isPathUnderRoot(path, root) {
  if (!path || !root) return false;
  const child = resolve(path).toLowerCase();
  const parent = resolve(root).toLowerCase();
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function safeRemoveRunRoot(root, prefix) {
  const expected = resolve(os.tmpdir(), prefix);
  if (!isPathUnderRoot(root, os.tmpdir()) || !resolve(root).startsWith(expected)) {
    throw new Error(`Refusing to remove unexpected run root: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
}

async function uniquePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitFor(check, options = {}) {
  const deadline = Date.now() + positiveInteger(options.timeout, 60_000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Timed out waiting for ${options.description ?? "condition"}.${lastError ? ` ${lastError.message}` : ""}`);
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 6_000,
      stdio: "ignore",
    });
    try { child.kill("SIGKILL"); } catch {}
  } else {
    child.kill("SIGKILL");
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  killProcessTree(child);
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
}

function resolveRequired(value, name) {
  if (!String(value ?? "").trim()) throw new Error(`${name} is required.`);
  return resolve(String(value));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tail(value, maximum) {
  const text = String(value ?? "");
  return text.length > maximum ? text.slice(-maximum) : text;
}
