#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createAntigravityCascadeClient } from "../translator/provider/antigravity-cascade-client.mjs";
import { startAntigravityChatProvider } from "../translator/provider/start-antigravity-chat-provider.mjs";
import { buildAntigravityModelCatalog } from "../translator/antigravity-model-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parsedArgs = parseArgs(process.argv.slice(2));
const launcherPath = parsedArgs.get("--launcher") ? resolve(parsedArgs.get("--launcher")) : "";
const candidateRoot = resolve(
  parsedArgs.get("--candidate-root")
    ?? join(process.env.LOCALAPPDATA ?? "", "Anti-Codex", "update-candidate"),
);
const model = parsedArgs.get("--model") ?? "gemini-3.5-flash-low";
const timeoutMs = positiveInteger(parsedArgs.get("--timeout-ms"), 240_000);
const reportPath = resolve(
  parsedArgs.get("--report")
    ?? join(repoRoot, "docs", "audits", "2026-07-14-gate4-isolated-route-switch.json"),
);

const candidateAppDir = resolve(candidateRoot, "codex-patched-app");
const candidateExe = resolve(candidateAppDir, "Anti-Codex.exe");
const candidateCli = resolve(candidateAppDir, "resources", "codex.exe");
const oldTranslatorRoutesUrl = "http://127.0.0.1:8484/anticodex/model-routes";
const startedAt = new Date();
const marker = `GATE4_ROUTE_SWITCH_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

const checks = [];
const counters = { start: 0, resume: 0, cancel: 0 };
const providerObserved = { startCalls: [], resumeCalls: [] };
let failure = null;
let layout = null;
let provider = null;
let launcherProcess = null;
let cliProcess = null;
let baselineProcesses = null;
let routeBefore = null;
let routeAfter = null;
let cliEvidence = null;

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function addCheck(id, ok, evidence = null) {
  checks.push({ id, ok: Boolean(ok), evidence });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPathUnderRoot(path, root) {
  if (!path || !root) return false;
  const child = resolve(path).toLowerCase();
  const parent = resolve(root).toLowerCase();
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function getProcesses() {
  const command = [
    "$rows = Get-CimInstance Win32_Process | ForEach-Object {",
    "  [pscustomobject]@{",
    "    processId = [int]$_.ProcessId",
    "    parentProcessId = [int]$_.ParentProcessId",
    "    name = [string]$_.Name",
    "    executablePath = [string]$_.ExecutablePath",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Compress",
  ].join("\n");
  const stdout = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  const parsed = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function compactProcess(row) {
  return {
    processId: Number(row.processId),
    parentProcessId: Number(row.parentProcessId),
    name: String(row.name ?? ""),
    executablePath: String(row.executablePath ?? ""),
  };
}

function getProcessSnapshot() {
  const rows = getProcesses().map(compactProcess);
  const originalCodex = rows.filter((row) => {
    const path = row.executablePath.toLowerCase();
    const name = row.name.toLowerCase();
    return ["chatgpt.exe", "codex.exe"].includes(name)
      && path.includes("\\windowsapps\\openai.codex_");
  });
  const antiCodexRows = rows.filter((row) => (
    row.name.toLowerCase() === "anti-codex.exe"
    && !isPathUnderRoot(row.executablePath, candidateAppDir)
  ));
  const antiCodexIds = new Set(antiCodexRows.map((row) => row.processId));
  const antiCodexRoots = antiCodexRows.filter((row) => !antiCodexIds.has(row.parentProcessId));
  const candidateProcesses = rows.filter((row) => isPathUnderRoot(row.executablePath, candidateAppDir));
  const sortRows = (values) => values.sort((a, b) => a.processId - b.processId);
  return {
    originalCodex: sortRows(originalCodex),
    antiCodexRoots: sortRows(antiCodexRoots),
    candidateProcesses: sortRows(candidateProcesses),
  };
}

function sameProcessRows(left = [], right = []) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function getFreePort() {
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

async function getUniquePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await getFreePort());
  return [...ports];
}

async function fetchRouteFingerprint() {
  const response = await fetch(oldTranslatorRoutesUrl, {
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Old translator route audit returned HTTP ${response.status}.`);
  const body = JSON.parse(text);
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const normalizedEntries = entries.map((entry) => ({
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
    entriesSha256: sha256(JSON.stringify(normalizedEntries)),
  };
}

function sameRouteFingerprint(left, right) {
  return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
}

async function waitFor(check, { timeout = timeoutMs, interval = 200, description = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, interval));
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
  } else {
    child.kill("SIGKILL");
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  killProcessTree(child);
  await Promise.race([
    exited,
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
}

async function runChild(file, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cliProcess = child;
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeout ?? timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, spawnError, timedOut, pid: child.pid });
    });
  });
}

function listWorkspaceFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...listWorkspaceFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

function parseCliEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

function tail(value, maximum) {
  const text = String(value ?? "");
  return text.length > maximum ? text.slice(-maximum) : text;
}

function safeRemoveRunRoot(root) {
  if (!root || !isPathUnderRoot(root, os.tmpdir()) || !resolve(root).startsWith(resolve(os.tmpdir(), "AntiCodex-Gate4-"))) {
    throw new Error(`Refusing to remove unexpected run root: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
}

async function main() {
  try {
    const pathChecks = [
      ["launcher_exists", launcherPath && existsSync(launcherPath), launcherPath],
      ["candidate_executable_exists", existsSync(candidateExe), candidateExe],
      ["candidate_cli_exists", existsSync(candidateCli), candidateCli],
    ];
    for (const [id, ok, path] of pathChecks) addCheck(id, ok, { path });
    if (pathChecks.some(([, ok]) => !ok)) throw new Error("Gate 4 preflight paths are incomplete.");

    baselineProcesses = getProcessSnapshot();
    addCheck("candidate_not_already_running", baselineProcesses.candidateProcesses.length === 0, {
      candidateProcesses: baselineProcesses.candidateProcesses,
    });
    if (baselineProcesses.candidateProcesses.length) {
      throw new Error("A copied candidate process was already running before Gate 4.");
    }

    routeBefore = await fetchRouteFingerprint();
    addCheck("old_route_baseline_captured", true, routeBefore);

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const root = resolve(os.tmpdir(), `AntiCodex-Gate4-${runId}`);
    layout = {
      root,
      state: join(root, "codex-plus-state"),
      codexHome: join(root, "codex-home"),
      appData: join(root, "appdata"),
      localAppData: join(root, "localappdata"),
      userData: join(root, "electron-user-data"),
      temp: join(root, "temp"),
      antiCodexState: join(root, "anticodex-state"),
      workspace: join(root, "workspace"),
    };
    for (const path of Object.values(layout)) mkdirSync(path, { recursive: true });

    const [cdpPort, protocolProxyPort, launcherGuardPort, managerGuardPort] = await getUniquePorts(4);
    const rawClient = createAntigravityCascadeClient();
    const client = {
      listModels: (...args) => rawClient.listModels(...args),
      getReadiness: (...args) => rawClient.getReadiness(...args),
      start(request) {
        counters.start += 1;
        providerObserved.startCalls.push({
          toolNames: (request?.tools ?? []).map((tool) => tool.name ?? tool.function?.name).filter(Boolean),
        });
        return rawClient.start(request);
      },
      resume(continuation, results, request) {
        counters.resume += 1;
        providerObserved.resumeCalls.push({
          toolNames: (request?.tools ?? []).map((tool) => tool.name ?? tool.function?.name).filter(Boolean),
        });
        return rawClient.resume(continuation, results, request);
      },
      async cancel(...args) {
        counters.cancel += 1;
        return rawClient.cancel(...args);
      },
    };
    const readiness = await client.getReadiness();
    addCheck("antigravity_desktop_ready", readiness?.signedIn === true, {
      signedIn: readiness?.signedIn === true,
      identityAvailable: readiness?.identityAvailable === true,
      planName: readiness?.planName ?? null,
    });
    if (readiness?.signedIn !== true) throw new Error("Antigravity Desktop is not ready.");

    const availableModels = await client.listModels();
    const bundledCatalog = JSON.parse(execFileSync(candidateCli, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }));
    const catalogTemplate = bundledCatalog.models.find((entry) => entry.slug === "gpt-5.4")
      ?? bundledCatalog.models[0];
    const modelCatalog = buildAntigravityModelCatalog(
      { ...bundledCatalog, models: [catalogTemplate] },
      availableModels.map((entry) => ({
        id: entry.id,
        model: entry.internalModel,
        displayName: entry.displayName,
      })),
    );
    const catalogPath = join(layout.codexHome, "antigravity-model-catalog.json");
    writeFileSync(catalogPath, `${JSON.stringify(modelCatalog, null, 2)}\n`, "utf8");
    const selectedCatalogModel = modelCatalog.models.find((entry) => entry.slug === model);
    addCheck("custom_model_catalog_contains_selected_model", Boolean(selectedCatalogModel), {
      model,
      modelCount: modelCatalog.models.length,
      applyPatchToolType: selectedCatalogModel?.apply_patch_tool_type ?? null,
      shellType: selectedCatalogModel?.shell_type ?? null,
    });
    if (!selectedCatalogModel) throw new Error(`Selected model is missing from the generated model catalog: ${model}`);

    provider = await startAntigravityChatProvider({ client, host: "127.0.0.1", port: 0 });
    const proxyBase = `http://127.0.0.1:${protocolProxyPort}/v1`;
    const config = [
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
      "experimental_bearer_token = \"gate4-local-key\"",
      "",
      "[features]",
      "plugins = false",
      "plugin_sharing = false",
      "remote_plugin = false",
      "",
    ].join("\n");
    writeFileSync(join(layout.codexHome, "config.toml"), config, "utf8");
    writeFileSync(join(layout.codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: "gate4-local-key" }, null, 2)}\n`, "utf8");
    const settings = {
      codexExtraArgs: [`--user-data-dir=${layout.userData}`, "--no-first-run"],
      enhancementsEnabled: false,
      providerSyncEnabled: false,
      relayProfilesEnabled: true,
      computerUseGuardEnabled: false,
      codexAppPluginMarketplaceUnlock: false,
      codexAppNativeMenuLocalization: false,
      codexAppFastStartup: false,
      relayProfiles: [{
        id: "gate4-antigravity",
        name: "Gate 4 Antigravity",
        upstreamBaseUrl: provider.url,
        protocol: "chatCompletions",
        relayMode: "pureApi",
        testModel: model,
        configContents: config,
        authContents: `${JSON.stringify({ OPENAI_API_KEY: "gate4-local-key" }, null, 2)}\n`,
        useCommonConfig: false,
        modelList: model,
      }],
      activeRelayId: "gate4-antigravity",
      relayTestModel: model,
    };
    writeFileSync(join(layout.state, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const childEnvironment = {
      ...process.env,
      CODEX_PLUS_STATE_DIR: layout.state,
      CODEX_PLUS_APP_EXECUTABLE: candidateExe,
      CODEX_PLUS_PROTOCOL_PROXY_PORT: String(protocolProxyPort),
      CODEX_PLUS_LAUNCHER_GUARD_PORT: String(launcherGuardPort),
      CODEX_PLUS_MANAGER_GUARD_PORT: String(managerGuardPort),
      CODEX_HOME: layout.codexHome,
      CODEX_HOME_DIR: layout.codexHome,
      APPDATA: layout.appData,
      LOCALAPPDATA: layout.localAppData,
      TEMP: layout.temp,
      TMP: layout.temp,
      DEEPCODEX_STATE_ROOT: layout.antiCodexState,
      DEEPCODEX_CDP_PORT: String(cdpPort),
    };

    const catalogPreflight = spawnSync(candidateCli, [
      "debug", "prompt-input", "GATE4_MODEL_CATALOG_PREFLIGHT",
    ], {
      cwd: layout.workspace,
      env: childEnvironment,
      windowsHide: true,
      encoding: "utf8",
      timeout: 30_000,
    });
    const fallbackMetadataWarning = /Model metadata for .* not found/i.test(catalogPreflight.stderr ?? "");
    addCheck("custom_model_metadata_loaded_by_codex", catalogPreflight.status === 0 && !fallbackMetadataWarning, {
      exitCode: catalogPreflight.status,
      fallbackMetadataWarning,
      stderrTail: tail(catalogPreflight.stderr, 2_000),
    });
    if (catalogPreflight.status !== 0 || fallbackMetadataWarning) {
      throw new Error("Codex did not load the generated Antigravity model metadata.");
    }

    let launcherError = null;
    launcherProcess = spawn(launcherPath, ["--helper-only", "--helper-port", String(protocolProxyPort)], {
      cwd: candidateAppDir,
      env: childEnvironment,
      windowsHide: true,
      stdio: "ignore",
    });
    launcherProcess.once("error", (error) => { launcherError = error; });
    const models = await waitFor(async () => {
      if (launcherError) throw launcherError;
      if (launcherProcess.exitCode !== null) {
        throw new Error(`CodexPlusPlus helper exited with code ${launcherProcess.exitCode}.`);
      }
      const response = await fetch(`${proxyBase}/models`, {
        headers: { Authorization: "Bearer gate4-local-key" },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body.data?.some((entry) => entry.id === model) ? body : null;
    }, { description: "CodexPlusPlus Antigravity model proxy" });
    addCheck("protocol_proxy_model_ready", models.data.some((entry) => entry.id === model), {
      model,
      providerUrl: provider.url,
      protocolProxyPort,
    });

    const prompt = [
      "This is a bounded route verification.",
      "Call the apply_patch_add_file tool exactly once.",
      `Use path proof.txt and content ${marker}.`,
      "Do not call the shell, inspect the workspace, or call any second tool.",
      "After the file tool completes, reply briefly.",
    ].join(" ");
    const cliResult = await runChild(candidateCli, [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-C", layout.workspace,
      "--sandbox", "danger-full-access",
      "--color", "never",
      "--json",
      prompt,
    ], { cwd: layout.workspace, env: childEnvironment, timeout: timeoutMs });
    const cliEvents = parseCliEvents(cliResult.stdout);
    const commandStarted = cliEvents.filter((event) => (
      event.type === "item.started" && event.item?.type === "command_execution"
    ));
    const commandCompleted = cliEvents.filter((event) => (
      event.type === "item.completed" && event.item?.type === "command_execution"
    ));
    const fileChangeEvents = cliEvents.filter((event) => (
      event.type === "item.completed" && event.item?.type === "file_change"
    ));
    const conflictObserved = /409\s+Conflict|stale Anti-Codex request/i.test(`${cliResult.stdout}\n${cliResult.stderr}`);
    cliEvidence = {
      exitCode: cliResult.code,
      signal: cliResult.signal,
      timedOut: cliResult.timedOut,
      spawnError: cliResult.spawnError?.message ?? null,
      commandStarted,
      commandCompleted,
      fileChangeEventCount: fileChangeEvents.length,
      stdoutTail: tail(cliResult.stdout, 6_000),
      stderrTail: tail(cliResult.stderr, 4_000),
    };
    addCheck("native_codex_cli_exit", cliResult.code === 0 && !cliResult.timedOut && !cliResult.spawnError, cliEvidence);
    const startToolNames = [...new Set(providerObserved.startCalls.flatMap((call) => call.toolNames))];
    addCheck("codexplusplus_apply_patch_proxy_exposed", startToolNames.includes("apply_patch_add_file"), {
      startCalls: providerObserved.startCalls,
    });
    addCheck("exactly_one_completed_file_tool", (
      commandStarted.length === 0
      && commandCompleted.length === 0
      && fileChangeEvents.length === 1
      && fileChangeEvents[0].item.status === "completed"
    ), {
      commandStarted,
      commandCompleted,
      fileChangeEvents,
    });
    addCheck("no_stale_request_conflict", !conflictObserved, { conflictObserved });

    const proofPath = join(layout.workspace, "proof.txt");
    const proofContent = existsSync(proofPath) ? readFileSync(proofPath, "utf8") : null;
    const workspaceFiles = listWorkspaceFiles(layout.workspace);
    const proofContentAccepted = proofContent === marker || proofContent === `${marker}\n`;
    addCheck("exact_proof_artifact", proofContentAccepted, {
      path: proofPath,
      expectedSha256: sha256(marker),
      actualSha256: proofContent === null ? null : sha256(proofContent),
    });
    addCheck("workspace_has_only_proof_artifact", JSON.stringify(workspaceFiles) === JSON.stringify(["proof.txt"]), {
      files: workspaceFiles,
    });
    addCheck("provider_exact_single_tool_continuation", (
      counters.start === 1 && counters.resume === 1 && counters.cancel === 0
    ), { ...counters });

    routeAfter = await fetchRouteFingerprint();
    addCheck("old_mixed_route_received_zero_requests", sameRouteFingerprint(routeBefore, routeAfter), {
      before: routeBefore,
      after: routeAfter,
    });
    const processesAfter = getProcessSnapshot();
    addCheck("original_codex_processes_unchanged", sameProcessRows(
      baselineProcesses.originalCodex,
      processesAfter.originalCodex,
    ), { before: baselineProcesses.originalCodex, after: processesAfter.originalCodex });
    addCheck("active_anticodex_root_unchanged", sameProcessRows(
      baselineProcesses.antiCodexRoots,
      processesAfter.antiCodexRoots,
    ), { before: baselineProcesses.antiCodexRoots, after: processesAfter.antiCodexRoots });
  } catch (error) {
    failure = {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    };
  } finally {
    await stopChild(cliProcess).catch(() => {});
    await stopChild(launcherProcess).catch(() => {});
    await provider?.close?.().catch(() => {});

    if (baselineProcesses) {
      await waitFor(() => getProcessSnapshot().candidateProcesses.length === 0, {
        timeout: 10_000,
        description: "candidate process cleanup",
      }).catch(() => {});
      const cleanupSnapshot = getProcessSnapshot();
      addCheck("cleanup_candidate_processes", cleanupSnapshot.candidateProcesses.length === 0, {
        remaining: cleanupSnapshot.candidateProcesses,
      });
      addCheck("original_codex_processes_unchanged_after_cleanup", sameProcessRows(
        baselineProcesses.originalCodex,
        cleanupSnapshot.originalCodex,
      ), { before: baselineProcesses.originalCodex, after: cleanupSnapshot.originalCodex });
      addCheck("active_anticodex_root_unchanged_after_cleanup", sameProcessRows(
        baselineProcesses.antiCodexRoots,
        cleanupSnapshot.antiCodexRoots,
      ), { before: baselineProcesses.antiCodexRoots, after: cleanupSnapshot.antiCodexRoots });
    }

    if (routeBefore && !routeAfter) {
      try {
        routeAfter = await fetchRouteFingerprint();
        addCheck("old_mixed_route_received_zero_requests_after_failure", sameRouteFingerprint(routeBefore, routeAfter), {
          before: routeBefore,
          after: routeAfter,
        });
      } catch (error) {
        addCheck("old_route_after_failure_captured", false, { error: error.message });
      }
    }

    if (layout?.root) {
      try {
        safeRemoveRunRoot(layout.root);
        addCheck("temporary_artifacts_removed", !existsSync(layout.root), { root: layout.root });
      } catch (error) {
        addCheck("temporary_artifacts_removed", false, { root: layout.root, error: error.message });
      }
    }

    const report = {
      schemaVersion: 1,
      generatedAtUtc: new Date().toISOString(),
      startedAtUtc: startedAt.toISOString(),
      ok: failure === null && checks.every((check) => check.ok),
      gate: "Gate 4 isolated CodexPlusPlus to Antigravity route switch",
      launchMode: "headless-helper",
      modelTraffic: "one bounded real Antigravity tool task",
      launcherPath,
      candidateExecutable: candidateExe,
      candidateCli,
      model,
      marker,
      counters: { ...counters },
      providerObserved,
      oldRoute: { before: routeBefore, after: routeAfter },
      cli: cliEvidence,
      checks,
      failure,
    };
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (error) {
      process.stderr.write(`Failed to write Gate 4 report: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ok: report.ok,
      report: reportPath,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).map((check) => check.id),
      failure: failure?.message ?? null,
    })}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
}

await main();
