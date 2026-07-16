import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  codexPlusPlusLauncherArgs,
  runProcess,
  summarizeCodexRun,
} from "./codexplusplus-antigravity-harness.mjs";
import {
  buildCodexPlusPlusSettings,
  generateRouteConfig,
} from "./anticodex-fixed-route.mjs";

const RUN_PREFIX = "AntiCodex-Gate8-Rehearsal-";

export async function createCodexPlusPlusScriptedChatHarness(options = {}) {
  const localAppData = process.env.LOCALAPPDATA || "";
  const launcherPath = resolve(options.launcherPath
    ?? join(localAppData, "Anti-Codex", "components", "codexplusplus", "codex-plus-plus.exe"));
  const appDir = resolve(options.appDir
    ?? join(localAppData, "Anti-Codex", "codex-patched-app"));
  const appExecutable = join(appDir, "Anti-Codex.exe");
  const candidateCli = join(appDir, "resources", "codex.exe");
  const fixturePath = resolve(options.fixturePath
    ?? join(import.meta.dirname, "..", "fixtures", "codexplusplus-gate2", "fake-chat-server.mjs"));
  const model = String(options.model ?? "gate2-chat-model");
  const timeoutMs = positiveInteger(options.timeoutMs, 180_000);
  const runRoot = resolve(options.runRoot ?? join(
    os.tmpdir(),
    `${RUN_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`,
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
    fakeReady: join(runRoot, "fake-ready.json"),
    fakeLog: join(runRoot, "fake-chat.jsonl"),
  };
  const children = new Set();
  let fakeServer = null;
  let launcher = null;
  let closed = false;

  async function close({ removeRoot = true } = {}) {
    if (closed) return;
    closed = true;
    for (const child of [...children]) await stopChild(child).catch(() => {});
    await stopChild(launcher).catch(() => {});
    await stopChild(fakeServer).catch(() => {});
    if (removeRoot && existsSync(runRoot)) removeIsolatedRoot(runRoot);
  }

  try {
    for (const [name, path] of Object.entries({ launcherPath, appExecutable, candidateCli, fixturePath })) {
      if (!existsSync(path)) throw new Error(`Missing ${name}: ${path}`);
    }
    for (const path of Object.values(paths)) {
      if (!path.endsWith(".json") && !path.endsWith(".jsonl")) mkdirSync(path, { recursive: true });
    }

    fakeServer = spawn(process.execPath, [
      fixturePath,
      "--host", "127.0.0.1",
      "--port", "0",
      "--ready", paths.fakeReady,
      "--log", paths.fakeLog,
    ], {
      cwd: dirname(fixturePath),
      windowsHide: true,
      stdio: "ignore",
    });
    let fakeError = null;
    fakeServer.once("error", (error) => { fakeError = error; });
    const ready = await waitFor(() => {
      if (fakeError) throw fakeError;
      if (fakeServer.exitCode !== null) throw new Error(`Fake Chat server exited: ${fakeServer.exitCode}`);
      if (!existsSync(paths.fakeReady)) return null;
      try { return JSON.parse(readFileSync(paths.fakeReady, "utf8")); } catch { return null; }
    }, { timeout: 15_000, description: "scripted Chat provider" });
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(ready.baseUrl ?? ""))) {
      throw new Error("Scripted Chat provider did not bind to loopback.");
    }

    const [protocolProxyPort, launcherGuardPort, managerGuardPort] = await uniquePorts(3);
    const route = generateRouteConfig({
      provider: "third-party",
      proxyPort: protocolProxyPort,
      model,
      localProxyKey: "gate8-local-proxy-key",
      thirdPartyConfig: {
        baseUrl: `${ready.baseUrl}/v1`,
        apiKey: "gate2-test-key",
        protocol: "chatCompletions",
        model,
      },
    });
    route.config = `${route.config.trimEnd()}\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
    writeFileSync(join(paths.codexHome, "config.toml"), route.config, "utf8");
    writeFileSync(join(paths.codexHome, "auth.json"), route.authContents, "utf8");
    writeFileSync(join(paths.codexHome, "AGENTS.md"), [
      "# Deterministic Anti-Codex Rehearsal",
      "",
      "- Work only in the current working directory.",
      "- Use the tools supplied by the model response; do not invent extra work.",
      "- Before every command, show the supplied Chinese progress sentence.",
      "- Do not launch desktop applications or inspect parent directories.",
      "",
    ].join("\n"), "utf8");
    const settings = buildCodexPlusPlusSettings({
      route,
      userDataDir: paths.userData,
    });
    writeFileSync(join(paths.state, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const environment = {
      ...process.env,
      CODEX_PLUS_STATE_DIR: paths.state,
      CODEX_PLUS_APP_EXECUTABLE: appExecutable,
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
      NO_PROXY: appendNoProxy(process.env.NO_PROXY),
      no_proxy: appendNoProxy(process.env.no_proxy),
    };

    let launcherError = null;
    launcher = spawn(launcherPath, codexPlusPlusLauncherArgs({
      launchDesktop: false,
      protocolProxyPort,
    }), {
      cwd: appDir,
      env: environment,
      windowsHide: true,
      stdio: "ignore",
    });
    launcher.once("error", (error) => { launcherError = error; });
    const proxyBase = `http://127.0.0.1:${protocolProxyPort}/v1`;
    const models = await waitFor(async () => {
      if (launcherError) throw launcherError;
      if (launcher.exitCode !== null) throw new Error(`CodexPlusPlus helper exited: ${launcher.exitCode}`);
      const response = await fetch(`${proxyBase}/models`, {
        headers: { Authorization: "Bearer gate8-local-proxy-key" },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body.data?.some((entry) => entry.id === model) ? body : null;
    }, { timeout: 60_000, description: "CodexPlusPlus scripted Chat route" });

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

    async function compactThread(threadId, compactOptions = {}) {
      if (!String(threadId ?? "").trim()) throw new Error("threadId is required for compaction.");
      const appServer = spawn(candidateCli, ["app-server", "--stdio"], {
        cwd: paths.workspace,
        env: environment,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(appServer);
      const client = createAppServerClient(appServer, {
        requestTimeoutMs: positiveInteger(compactOptions.requestTimeoutMs, 60_000),
      });
      try {
        const initialize = await client.request("initialize", {
          clientInfo: {
            name: "anticodex-deterministic-compaction",
            version: "1.0.0",
          },
          capabilities: { experimentalApi: true },
        });
        const resumed = await client.request("thread/resume", { threadId: String(threadId) });
        const before = summarizeAppServerThread(await client.request("thread/read", {
          threadId: String(threadId),
          includeTurns: true,
        }));
        const compactResponse = await client.request("thread/compact/start", {
          threadId: String(threadId),
        });
        const compactionItemEvent = await waitFor(
          () => client.notifications.find((message) => message.method === "item/completed"
            && message.params?.threadId === String(threadId)
            && message.params?.item?.type === "contextCompaction"),
          {
            timeout: positiveInteger(compactOptions.timeoutMs, 90_000),
            description: "native Codex context compaction item",
          },
        );
        const compactionTurnEvent = await waitFor(
          () => client.notifications.find((message) => message.method === "turn/completed"
            && message.params?.threadId === String(threadId)
            && message.params?.turn?.id === compactionItemEvent.params?.turnId),
          {
            timeout: positiveInteger(compactOptions.timeoutMs, 90_000),
            description: "native Codex context compaction turn",
          },
        );
        const after = summarizeAppServerThread(await client.request("thread/read", {
          threadId: String(threadId),
          includeTurns: true,
        }));
        return {
          initialize,
          resumed: summarizeAppServerThread(resumed),
          before,
          compactResponse,
          compaction: {
            threadId: compactionItemEvent.params?.threadId ?? null,
            turnId: compactionItemEvent.params?.turnId ?? null,
            item: compactionItemEvent.params?.item ?? null,
            turn: compactionTurnEvent.params?.turn ?? null,
          },
          after,
          notificationMethods: client.notifications.map((message) => message.method).filter(Boolean),
          warnings: client.notifications
            .filter((message) => message.method === "warning")
            .map((message) => message.params ?? null),
          malformedOutput: [...client.malformedOutput],
          stderrTail: client.stderr.slice(-5_000),
        };
      } finally {
        await client.close().catch(() => {});
        children.delete(appServer);
      }
    }

    async function runCodex(args, runOptions) {
      const result = await runProcess(candidateCli, args, {
        cwd: paths.workspace,
        env: environment,
        timeoutMs: positiveInteger(runOptions?.timeoutMs, timeoutMs),
        killTreeOnTimeout: runOptions?.killTreeOnTimeout,
        onChild(child) { children.add(child); },
      });
      children.delete(result.child);
      return summarizeCodexRun(result);
    }

    return {
      paths,
      model,
      launcherPath,
      appDir,
      candidateCli,
      providerUrl: `${ready.baseUrl}/v1`,
      proxyBase,
      proxiedModelCount: models.data.length,
      environment,
      runInitial,
      runResume,
      compactThread,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

function createAppServerClient(child, options = {}) {
  let buffer = "";
  let nextId = 1;
  let stderr = "";
  const pending = new Map();
  const notifications = [];
  const malformedOutput = [];

  function rejectPending(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        malformedOutput.push(line);
        continue;
      }
      const response = message?.id != null
        && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
      if (!response) {
        notifications.push(message);
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", (error) => rejectPending(error));
  child.once("close", (code, signal) => {
    if (pending.size > 0) {
      rejectPending(new Error(`Codex app-server closed before replying: code=${code}, signal=${signal}`));
    }
  });

  function request(method, params) {
    return new Promise((resolveRequest, rejectRequest) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for Codex app-server ${method}`));
      }, positiveInteger(options.requestTimeoutMs, 60_000));
      const settle = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };
      pending.set(id, {
        resolve: settle(resolveRequest),
        reject: settle(rejectRequest),
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(error);
      });
    });
  }

  async function close() {
    if (child.exitCode !== null) return;
    if (!child.stdin.destroyed) child.stdin.end();
    await Promise.race([
      once(child, "close").catch(() => {}),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (child.exitCode === null) await stopChild(child);
  }

  return {
    request,
    close,
    notifications,
    malformedOutput,
    get stderr() { return stderr; },
  };
}

function summarizeAppServerThread(result) {
  const thread = result?.thread ?? result ?? {};
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const itemTypes = turns.flatMap((turn) => Array.isArray(turn.items)
    ? turn.items.map((item) => item?.type).filter(Boolean)
    : []);
  return {
    threadId: thread.id ?? null,
    status: thread.status ?? null,
    turnCount: turns.length,
    itemTypes,
    contextCompactionCount: itemTypes.filter((type) => type === "contextCompaction").length,
  };
}

function appendNoProxy(value) {
  const entries = String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const host of ["127.0.0.1", "localhost"]) {
    if (!entries.includes(host)) entries.push(host);
  }
  return entries.join(",");
}

async function uniquePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const server = createServer();
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const port = server.address().port;
    await new Promise((resolveClose) => server.close(resolveClose));
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

async function waitFor(probe, options = {}) {
  const deadline = Date.now() + positiveInteger(options.timeout, 30_000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for ${options.description ?? "condition"}${lastError ? `: ${lastError.message}` : ""}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return;
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 10_000,
  });
  if (child.exitCode !== null) return;
  await Promise.race([
    once(child, "close").catch(() => {}),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

function removeIsolatedRoot(root) {
  const resolved = resolve(root);
  const tempRoot = resolve(os.tmpdir());
  const rel = relative(tempRoot, resolved);
  if (!rel || rel.startsWith("..") || basename(resolved).startsWith(RUN_PREFIX) !== true) {
    throw new Error(`Refusing to remove non-rehearsal root: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
